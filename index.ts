#!/usr/bin/env node
import {
    Server
} from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
    StdioServerTransport
} from "@modelcontextprotocol/sdk/server/stdio.js";

import * as h3 from "h3-js";
import proj4 from "proj4";
import pkg from "./package.json" with { type: "json" };
import proj4defs from "./proj4defs.json" with { type: "json" };
import { wktToGeoJSON as parseWKT } from "@terraformer/wkt";
import {
    asyncBufferFromUrl,
    parquetMetadataAsync,
    parquetReadObjects,
    parquetSchema,
    type AsyncBuffer,
    type FileMetaData,
    type ParquetQueryFilter,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";

const SERVER_NAME = "bbox-mcp-server";
const SERVER_VERSION = pkg.version;

function parsePositiveIntEnv(envName: string, defaultValue: number): number {
    const raw = process.env[envName];
    if (!raw) return defaultValue;
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v) || v <= 0) {
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', server: 'bbox-mcp-server', message: `Invalid ${envName}="${raw}", using default ${defaultValue}` }));
        return defaultValue;
    }
    return v;
}

const MAX_H3_CELLS = parsePositiveIntEnv("MAX_H3_CELLS", 50000);
const MAX_OVERTURE_ROW_GROUPS = parsePositiveIntEnv("OVERTURE_MAX_ROW_GROUPS", 40);
const MAPBOX_ACCESS_TOKEN = process.env.MAPBOX_ACCESS_TOKEN;
const MAX_INPUT_LENGTH = 1_000_000; // 1 MB input size guard
const FETCH_TIMEOUT_MS = 10_000;    // 10 second timeout for external API calls

// ---------------------------------------------------------------------------
// Logging Utility
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        server: SERVER_NAME,
        message,
        ...data
    };
    // MCP servers use stdio for protocol messages — logs go to stderr
    console.error(JSON.stringify(entry));
}

const server = new Server(
    {
        name: SERVER_NAME,
        version: SERVER_VERSION,
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Initialize Proj4 Data once
function initProj4() {
    const defs = proj4defs as Record<string, string[]>;
    let count = 0;
    for (const [code, def] of Object.entries(defs)) {
        if (def.length >= 2 && def[1]) {
            proj4.defs(`EPSG:${code}`, def[1]);
            count++;
        }
    }
    log('info', `Loaded ${count} EPSG projection definitions from bundled proj4defs.json`);
}
initProj4();

interface BBox {
    lat1: number;
    lng1: number;
    lat2: number;
    lng2: number;
}

// ---------------------------------------------------------------------------
// Shared Utilities
// ---------------------------------------------------------------------------

/**
 * Recursively extracts [lng, lat] coordinate pairs from any nested structure
 * (GeoJSON, WKT parsed output, etc.). Used by both GeoJSON and WKT sniffers.
 */
function extractCoords(obj: any): number[][] {
    const result: number[][] = [];
    // Only follow GeoJSON-structural keys to avoid walking into properties
    // which may contain arbitrary numeric arrays.
    const GEO_KEYS = new Set(['coordinates', 'geometry', 'geometries', 'features']);
    const stack: any[] = [obj];

    while (stack.length > 0) {
        const current = stack.pop();
        if (Array.isArray(current)) {
            if (current.length >= 2 && typeof current[0] === 'number' && typeof current[1] === 'number') {
                result.push([current[0], current[1]]); // [lng, lat]
            } else {
                for (let i = current.length - 1; i >= 0; i--) {
                    stack.push(current[i]);
                }
            }
        } else if (current && typeof current === 'object') {
            for (const key of Object.keys(current)) {
                if (GEO_KEYS.has(key)) {
                    stack.push(current[key]);
                }
            }
        }
    }
    return result;
}

/**
 * Safe min/max over an array — avoids stack overflow from Function.apply
 * on large coordinate arrays (>65k elements).
 */
function safeMin(arr: number[]): number {
    let min = Infinity;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] < min) min = arr[i];
    }
    return min;
}

function safeMax(arr: number[]): number {
    let max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] > max) max = arr[i];
    }
    return max;
}

function setBoundedCache<K, V>(cache: Map<K, V>, maxEntries: number, key: K, value: V): void {
    if (cache.has(key)) {
        cache.delete(key);
    } else if (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(key, value);
}

// Strip ASCII control chars, bidi overrides, zero-width chars, and Unicode Tag block (U+E0000-U+E007F)
const UNSAFE_TEXT_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

function sanitizeExternalText(input: unknown, maxLength = 300): string {
    if (typeof input !== 'string') return '';
    const cleaned = input
        .replace(UNSAFE_TEXT_CHARS_RE, '')
        .replace(/[\r\n\t]+/g, ' ')
        .trim();
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.slice(0, maxLength - 1) + '…';
}

function sanitizeExternalTags(tags: unknown, maxKeys = 50, maxValueLength = 500): Record<string, string> {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return {};
    const out: Record<string, string> = {};
    let count = 0;
    for (const [rawKey, rawVal] of Object.entries(tags as Record<string, unknown>)) {
        if (count >= maxKeys) break;
        const key = sanitizeExternalText(rawKey, 100);
        if (!key) continue;
        const val = typeof rawVal === 'string'
            ? sanitizeExternalText(rawVal, maxValueLength)
            : sanitizeExternalText(String(rawVal ?? ''), maxValueLength);
        out[key] = val;
        count++;
    }
    return out;
}

function escapeMarkdownInline(text: string): string {
    return text.replace(/([[\]()\\`])/g, '\\$1');
}

function normalizeHttpUrlArray(val: unknown, maxItems = 20): string[] {
    if (!Array.isArray(val)) return [];
    const seen = new Set<string>();
    for (const item of val) {
        if (seen.size >= maxItems) break;
        if (typeof item !== 'string') continue;
        const cleaned = sanitizeExternalText(item, 500);
        if (!cleaned) continue;
        // Reject dangerous URI schemes (javascript:, data:, vbscript:, file:, etc.)
        const schemeMatch = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
        if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) continue;
        seen.add(cleaned);
    }
    return [...seen];
}

function assertSafeHttpUrl(rawUrl: string, baseUrl?: string): string {
    const parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported URL protocol '${parsed.protocol}' in external catalog link.`);
    }
    return parsed.href;
}

// ---------------------------------------------------------------------------
// Pure Functions Ported from bbox.js
// ---------------------------------------------------------------------------

const STRICT_NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function parseStrictNumber(raw: string): number {
    const trimmed = raw.trim();
    if (!STRICT_NUM_RE.test(trimmed)) return NaN;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
}

function validateBBox(lat1: number, lng1: number, lat2: number, lng2: number): boolean {
    if (isNaN(lat1) || isNaN(lng1) || isNaN(lat2) || isNaN(lng2)) return false;
    if (lat1 < -90 || lat1 > 90 || lat2 < -90 || lat2 > 90) return false;
    if (lng1 < -180 || lng1 > 180 || lng2 < -180 || lng2 > 180) return false;
    return true;
}

function hasAntimeridianJump(coordsLngLat: number[][]): boolean {
    for (let i = 1; i < coordsLngLat.length; i++) {
        if (Math.abs(coordsLngLat[i][0] - coordsLngLat[i - 1][0]) > 180) {
            return true;
        }
    }
    return false;
}

function parseBBox(input: string, warnings?: string[]): BBox {
    if (!input || typeof input !== 'string') {
        throw new Error(`Invalid bbox input.`);
    }

    // Input size guard — prevent blocking the event loop on huge payloads
    if (input.length > MAX_INPUT_LENGTH) {
        throw new Error(`Input too large (${(input.length / 1024).toFixed(0)} KB). Maximum allowed is ${(MAX_INPUT_LENGTH / 1024).toFixed(0)} KB.`);
    }

    // --- 0. Web Mercator Tile Sniffer (z/x/y) ---
    const tileMatch = input.trim().match(/^(\d{1,2})\s*\/\s*(\d+)\s*\/\s*(\d+)$/);
    if (tileMatch) {
        const z = parseInt(tileMatch[1], 10);
        const x = parseInt(tileMatch[2], 10);
        const y = parseInt(tileMatch[3], 10);
        const maxTile = Math.pow(2, z);
        if (z >= 0 && z <= 22 && x >= 0 && x < maxTile && y >= 0 && y < maxTile) {
            return tileToBBox(z, x, y);
        }
        throw new Error(`Invalid Web Mercator tile coordinates: ${input}`);
    }

    // --- 1. ogrinfo Extent Sniffer ---
    // Matches: "Extent: (-74.006000, 40.712800) - (-73.985500, 40.758000)"
    const ogrMatch = input.match(/Extent\:\s\((.*)\)/);
    if (ogrMatch && ogrMatch[1]) {
        const pairs = ogrMatch[1].split(") - (");
        if (pairs.length === 2) {
            const minCoords = pairs[0].replace('(', '').split(',').map(parseStrictNumber);
            const maxCoords = pairs[1].replace(')', '').split(',').map(parseStrictNumber);
            if (minCoords.length !== 2 || maxCoords.length !== 2 || minCoords.some(isNaN) || maxCoords.some(isNaN)) {
                throw new Error(`Invalid numeric values in ogrinfo extent: ${input}`);
            }
            if (minCoords[0] > maxCoords[0]) {
                throw new Error(`Antimeridian (date-line) crossing bounding box detected (west=${minCoords[0]} > east=${maxCoords[0]}). Split the region at ±180° longitude.`);
            }
            // Format: (minX, minY) - (maxX, maxY) where X=lng, Y=lat
            return ensureValidBBox(minCoords[1], minCoords[0], maxCoords[1], maxCoords[0]);
        }
    }

    // --- 2. GeoJSON Sniffer ---
    if (input.trim().startsWith('{')) {
        let json: any;
        try {
            json = JSON.parse(input);
        } catch (e: any) {
            throw new Error(`Invalid GeoJSON input: ${e?.message}`);
        }
        if (json.bbox && Array.isArray(json.bbox) && json.bbox.length === 4) {
            const [west, south, east, north] = json.bbox.map((v: any) => typeof v === 'number' ? v : parseStrictNumber(String(v)));
            if ([west, south, east, north].some(isNaN)) {
                throw new Error(`Invalid numeric values in GeoJSON bbox.`);
            }
            if (west > east) {
                throw new Error(`Antimeridian (date-line) crossing GeoJSON bbox detected (west=${west} > east=${east}). Split the bounding box at ±180° longitude.`);
            }
            if (south > north) {
                throw new Error(`Invalid GeoJSON bbox: south (${south}) > north (${north}).`);
            }
            return ensureValidBBox(south, west, north, east);
        }

        const allCoords = extractCoords(json);
        if (allCoords.length > 0) {
            if (hasAntimeridianJump(allCoords)) {
                throw new Error(`Antimeridian (date-line) crossing geometry detected (longitude jump > 180°). Split the geometry at ±180° longitude.`);
            }
            const lngs = allCoords.map(c => c[0]);
            const lats = allCoords.map(c => c[1]);
            return ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));
        }
        throw new Error(`GeoJSON input contains no valid coordinates or bbox.`);
    }

    // --- 3. WKT Sniffer ---
    if (/^\s*(MULTI)?(POLYGON|POINT|LINESTRING)|^\s*GEOMETRYCOLLECTION/i.test(input)) {
        let geojson: any;
        try {
            geojson = parseWKT(input) as any;
        } catch (e: any) {
            throw new Error(`Failed to parse WKT geometry: ${e?.message}`);
        }
        const allCoords = extractCoords(geojson?.coordinates ? geojson : { geometry: geojson });
        if (allCoords.length > 0) {
            if (hasAntimeridianJump(allCoords)) {
                throw new Error(`Antimeridian (date-line) crossing WKT geometry detected (longitude jump > 180°). Split the geometry at ±180° longitude.`);
            }
            const lngs = allCoords.map(c => c[0]);
            const lats = allCoords.map(c => c[1]);
            return ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));
        }
        throw new Error(`Failed to extract coordinates from WKT geometry.`);
    }

    // --- 4. Strict Coordinate Array Sniffer ---
    const trimmed = input.trim();
    // Reject strings containing unexpected characters outside brackets, parens, commas, whitespace, digits, signs, decimal point, exponent
    if (!/^[\[\(\s]*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:(?:\s*,\s*|\s+)[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)*[\]\)\s]*$/i.test(trimmed)) {
        throw new Error(`Failed to parse bounding box: contains invalid coordinate tokens. Input must be valid WKT, GeoJSON, ogrinfo extent, tile "z/x/y", point "lat,lng", or "lat1,lng1,lat2,lng2". Got: ${input.substring(0, 50)}`);
    }

    const cleanInput = trimmed.replace(/^[\[\(\s]+|[\]\)\s]+$/g, '');
    const rawTokens = cleanInput.split(/[\s,]+/).filter(Boolean);
    const parts = rawTokens.map(parseStrictNumber);

    if (parts.some(isNaN)) {
        throw new Error(`Failed to parse bounding box: invalid numeric token in "${input.substring(0, 50)}".`);
    }

    if (parts.length === 2) {
        const p0 = parts[0], p1 = parts[1];
        if (validateBBox(p0, p1, p0, p1)) {
            return ensureValidBBox(p0, p1, p0, p1);
        } else if (validateBBox(p1, p0, p1, p0)) {
            warnings?.push(`Detected single point in lng,lat order (${p0}, ${p1}); auto-converted to lat=${p1}, lng=${p0}.`);
            return ensureValidBBox(p1, p0, p1, p0);
        }
        throw new Error(`Invalid point coordinates: (${p0}, ${p1}). Latitude must be [-90, 90] and longitude [-180, 180].`);
    }

    if (parts.length === 4) {
        const asLatLng = validateBBox(parts[0], parts[1], parts[2], parts[3]);
        const asLngLat = validateBBox(parts[1], parts[0], parts[3], parts[2]);
        if (!asLatLng && asLngLat) {
            // Check antimeridian crossing in lng,lat,lng,lat order: parts[0] = west, parts[2] = east
            if (parts[0] > parts[2] && (parts[0] - parts[2]) > 180) {
                throw new Error(`Antimeridian (date-line) crossing bounding box detected (west=${parts[0]} > east=${parts[2]}). Split the bounding box at ±180° longitude.`);
            }
            warnings?.push(
                `Detected lng,lat,lng,lat coordinate order (${parts[0]}, ${parts[1]}, ${parts[2]}, ${parts[3]}) because longitude is outside [-90, 90]. Automatically transposed to lat,lng.`
            );
            return ensureValidBBox(parts[1], parts[0], parts[3], parts[2]);
        }
        if (asLatLng) {
            // Check antimeridian crossing in lat1,lng1,lat2,lng2 order: parts[1] = west, parts[3] = east
            if (parts[1] > parts[3] && (parts[1] - parts[3]) > 180) {
                throw new Error(`Antimeridian (date-line) crossing bounding box detected (west=${parts[1]} > east=${parts[3]}). Split the bounding box at ±180° longitude.`);
            }
            if (asLngLat && (parts[0] !== parts[1] || parts[2] !== parts[3])) {
                warnings?.push(
                    `Ambiguous coordinate order: interpreted as lat,lng,lat,lng → (${parts[0]}, ${parts[1]}, ${parts[2]}, ${parts[3]}). ` +
                    `If your source uses lng,lat order (GeoJSON, GDAL, most GIS tools), the bounding box may be transposed. ` +
                    `Use GeoJSON or WKT input to avoid ambiguity.`
                );
            }
            return ensureValidBBox(parts[0], parts[1], parts[2], parts[3]);
        }
        throw new Error(`Invalid coordinates or out of bounds: lat[-90, 90], lng[-180, 180]. Provided: ${parts.join(', ')}`);
    }

    throw new Error(`Failed to parse bounding box. Expected 2 (point) or 4 (bbox) numbers, WKT, GeoJSON, ogrinfo extent, or tile "z/x/y". Got ${parts.length} numbers in: ${input.substring(0, 50)}`);
}

function ensureValidBBox(lat1: number, lng1: number, lat2: number, lng2: number): BBox {
    if (!validateBBox(lat1, lng1, lat2, lng2)) {
        throw new Error(`Invalid coordinates or out of bounds: lat[-90, 90], lng[-180, 180]. Provided: ${lat1}, ${lng1}, ${lat2}, ${lng2}`);
    }
    // Ensure we sort so that lat1 < lat2 and lng1 < lng2
    return {
        lat1: Math.min(lat1, lat2),
        lng1: Math.min(lng1, lng2),
        lat2: Math.max(lat1, lat2),
        lng2: Math.max(lng1, lng2)
    };
}

function formatWarnings(warnings: string[]): string {
    return warnings.length > 0 ? '\n\n⚠️ ' + warnings.join('\n⚠️ ') : '';
}

function projectBounds(bbox: BBox, epsg: string): { xmin: number, ymin: number, xmax: number, ymax: number } {
    if (epsg === "4326") {
        return { xmin: bbox.lng1, ymin: bbox.lat1, xmax: bbox.lng2, ymax: bbox.lat2 };
    }

    const epsgKey = `EPSG:${epsg}`;
    if (!proj4.defs(epsgKey)) {
        throw new Error(`Unknown EPSG code: ${epsg}. Make sure it exists in proj4defs.`);
    }

    const transformer = proj4("EPSG:4326", epsgKey);
    const steps = epsg === "3857" ? 1 : 20;
    let xmin = Infinity;
    let ymin = Infinity;
    let xmax = -Infinity;
    let ymax = -Infinity;
    const extend = (lng: number, lat: number) => {
        const [x, y] = transformer.forward([lng, lat]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new RangeError("Bounds extend outside the projection domain.");
        }
        xmin = Math.min(xmin, x);
        ymin = Math.min(ymin, y);
        xmax = Math.max(xmax, x);
        ymax = Math.max(ymax, y);
    };
    for (let i = 0; i <= steps; i++) {
        const lng = bbox.lng1 + (bbox.lng2 - bbox.lng1) * i / steps;
        extend(lng, bbox.lat1);
        extend(lng, bbox.lat2);
    }
    for (let i = 1; i < steps; i++) {
        const lat = bbox.lat1 + (bbox.lat2 - bbox.lat1) * i / steps;
        extend(bbox.lng1, lat);
        extend(bbox.lng2, lat);
    }
    return { xmin, ymin, xmax, ymax };
}

/**
 * Attempts to dynamically fetch an EPSG projection definition from epsg.io
 * if it's not in the bundled proj4defs.json. Caches the result for future
 * calls within the same server session.
 */
const DYNAMIC_EPSG_CODES = new Set<string>();
const MAX_DYNAMIC_EPSG_CODES = 500;

async function ensureProjection(epsg: string): Promise<void> {
    if (!/^\d+$/.test(epsg)) {
        throw new Error(`Unknown EPSG code: ${epsg || '(empty)'}. EPSG code must be numeric.`);
    }
    const epsgKey = `EPSG:${epsg}`;
    if (proj4.defs(epsgKey)) {
        return; // Already loaded
    }

    log('info', `EPSG:${epsg} not in bundled defs, fetching from epsg.io`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(`https://epsg.io/${epsg}.proj4`, {
            headers: {
                'User-Agent': `${SERVER_NAME}/${SERVER_VERSION} (https://github.com/iamvibhorsingh/bbox-mcp-server)`
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`epsg.io returned status ${response.status}`);
        }

        const proj4String = (await response.text()).trim();

        if (!proj4String || proj4String.length > 2048 || proj4String.includes('<!DOCTYPE html>') || !proj4String.includes('+proj=')) {
            throw new Error(`Invalid proj4 string received for EPSG:${epsg}`);
        }

        if (DYNAMIC_EPSG_CODES.size >= MAX_DYNAMIC_EPSG_CODES) {
            const oldest = DYNAMIC_EPSG_CODES.values().next().value;
            if (oldest) {
                DYNAMIC_EPSG_CODES.delete(oldest);
            }
        }
        proj4.defs(epsgKey, proj4String);
        DYNAMIC_EPSG_CODES.add(epsgKey);
        log('info', `Successfully loaded EPSG:${epsg} from epsg.io`);
    } catch (err: any) {
        if (err.name === 'AbortError') {
            throw new Error(`Timeout fetching projection EPSG:${epsg} from epsg.io (${FETCH_TIMEOUT_MS / 1000}s). Try again or use a bundled EPSG code.`);
        }
        throw new Error(`Unknown EPSG code: ${epsg}. Not in bundled definitions and could not fetch from epsg.io: ${err.message}`);
    } finally {
        clearTimeout(timeout);
    }
}

function getFormattedBox(bbox: BBox, format: string, precision: number = 6, coordOrder: "lng,lat" | "lat,lng" = "lng,lat"): string {
    let xmin, ymin, xmax, ymax;

    if (coordOrder === "lat,lng") {
        // Swap X and Y coordinates
        xmin = bbox.lat1.toFixed(precision);
        ymin = bbox.lng1.toFixed(precision);
        xmax = bbox.lat2.toFixed(precision);
        ymax = bbox.lng2.toFixed(precision);
    } else {
        // Default lng,lat order
        xmin = bbox.lng1.toFixed(precision);
        ymin = bbox.lat1.toFixed(precision);
        xmax = bbox.lng2.toFixed(precision);
        ymax = bbox.lat2.toFixed(precision);
    }

    switch (format.toLowerCase()) {
        case 'wkt':
            return `POLYGON(( ${xmin} ${ymin}, ${xmax} ${ymin}, ${xmax} ${ymax}, ${xmin} ${ymax}, ${xmin} ${ymin} ))`;
        case 'geojson-bbox':
            return `[${xmin}, ${ymin}, ${xmax}, ${ymax}]`;
        case 'leaflet':
            return `[[${ymin}, ${xmin}], [${ymax}, ${xmax}]]`;
        case 'overpass':
            return `[bbox:${ymin},${xmin},${ymax},${xmax}]`;
        case 'ogc-bbox':
            return `BBOX=${xmin},${ymin},${xmax},${ymax},EPSG:4326`;
        case 'kml':
            return `<LatLonBox>\n  <north>${ymax}</north>\n  <south>${ymin}</south>\n  <east>${xmax}</east>\n  <west>${xmin}</west>\n</LatLonBox>`;
        case 'geojson-polygon':
            return JSON.stringify({
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[parseFloat(xmin), parseFloat(ymin)], [parseFloat(xmax), parseFloat(ymin)], [parseFloat(xmax), parseFloat(ymax)], [parseFloat(xmin), parseFloat(ymax)], [parseFloat(xmin), parseFloat(ymin)]]]
                },
                "bbox": [parseFloat(xmin), parseFloat(ymin), parseFloat(xmax), parseFloat(ymax)]
            }, null, 2);
        case 'csv':
            return `${xmin},${ymin},${xmax},${ymax}`;
        case 'stac-bbox':
            return `[${xmin}, ${ymin}, ${xmax}, ${ymax}]`;
        default:
            throw new Error(`Unknown format: ${format}. Supported formats: wkt, geojson-bbox, leaflet, overpass, ogc-bbox, kml, geojson-polygon, csv, stac-bbox.`);
    }
}

// ---------------------------------------------------------------------------
// Geographic Math Formulas, WGS84 Geodesics & 3D Camera Frustum Math
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

function roundTo(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}

function normalizeBearingDegrees(degrees: number): number {
    return ((degrees % 360) + 360) % 360;
}

function normalizeLongitudeDegrees(lng: number): number {
    return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function bearingToCardinal(degrees: number): string {
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return dirs[Math.round(normalizeBearingDegrees(degrees) / 22.5) % 16];
}

/**
 * Vincenty's inverse geodesic formula on the WGS84 ellipsoid.
 * Falls back cleanly to spherical Haversine/bearing for nearly antipodal points.
 */
function geodesicInverseWGS84(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number
): { distanceMeters: number; initialBearingDegrees: number; finalBearingDegrees: number } {
    if (Math.abs(lat1 - lat2) < 1e-12 && Math.abs(lng1 - lng2) < 1e-12) {
        return { distanceMeters: 0, initialBearingDegrees: 0, finalBearingDegrees: 0 };
    }

    const phi1 = lat1 * DEG_TO_RAD;
    const phi2 = lat2 * DEG_TO_RAD;
    const dLon = (lng2 - lng1) * DEG_TO_RAD;
    const L = Math.atan2(Math.sin(dLon), Math.cos(dLon));

    const U1 = Math.atan2((1 - WGS84_F) * Math.sin(phi1), Math.cos(phi1));
    const U2 = Math.atan2((1 - WGS84_F) * Math.sin(phi2), Math.cos(phi2));
    const sinU1 = Math.sin(U1);
    const cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2);
    const cosU2 = Math.cos(U2);

    let lambda = L;
    let sinSigma = 0;
    let cosSigma = 0;
    let sigma = 0;
    let sinAlpha = 0;
    let cosSqAlpha = 0;
    let cos2SigmaM = 0;
    let sinLambda = 0;
    let cosLambda = 0;
    let converged = false;

    for (let iter = 0; iter < 100; iter++) {
        sinLambda = Math.sin(lambda);
        cosLambda = Math.cos(lambda);
        sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
        if (sinSigma === 0) {
            return { distanceMeters: 0, initialBearingDegrees: 0, finalBearingDegrees: 0 };
        }
        cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
        sigma = Math.atan2(sinSigma, cosSigma);
        sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
        cosSqAlpha = 1 - sinAlpha * sinAlpha;
        cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;

        const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
        const lambdaPrev = lambda;
        lambda = L + (1 - C) * WGS84_F * sinAlpha * (
            sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM))
        );
        if (Math.abs(lambda - lambdaPrev) <= 1e-12) {
            converged = true;
            break;
        }
    }

    if (!converged) {
        const dist = calculateHaversineDistanceMeters(lat1, lng1, lat2, lng2);
        const initB = calculateBearingDegrees(lat1, lng1, lat2, lng2).degrees;
        const revB = calculateBearingDegrees(lat2, lng2, lat1, lng1).degrees;
        return {
            distanceMeters: dist,
            initialBearingDegrees: initB,
            finalBearingDegrees: normalizeBearingDegrees(revB + 180)
        };
    }

    const uSq = (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
    const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const deltaSigma = B * sinSigma * (
        cos2SigmaM + (B / 4) * (
            cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)
        )
    );

    const distanceMeters = WGS84_B * A * (sigma - deltaSigma);
    const alpha1 = Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * RAD_TO_DEG;
    const alpha2 = Math.atan2(cosU1 * sinLambda, -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda) * RAD_TO_DEG;

    return {
        distanceMeters,
        initialBearingDegrees: normalizeBearingDegrees(alpha1),
        finalBearingDegrees: normalizeBearingDegrees(alpha2)
    };
}

/**
 * Vincenty's direct geodesic formula on the WGS84 ellipsoid.
 */
function geodesicDirectWGS84(
    lat1: number,
    lng1: number,
    bearingDegrees: number,
    distanceMeters: number
): { lat: number; lng: number; finalBearingDegrees: number } {
    if (distanceMeters === 0) {
        return {
            lat: lat1,
            lng: normalizeLongitudeDegrees(lng1),
            finalBearingDegrees: normalizeBearingDegrees(bearingDegrees)
        };
    }

    const phi1 = lat1 * DEG_TO_RAD;
    const alpha1 = bearingDegrees * DEG_TO_RAD;
    const sinAlpha1 = Math.sin(alpha1);
    const cosAlpha1 = Math.cos(alpha1);

    const U1 = Math.atan2((1 - WGS84_F) * Math.sin(phi1), Math.cos(phi1));
    const sinU1 = Math.sin(U1);
    const cosU1 = Math.cos(U1);
    const sigma1 = Math.atan2(Math.tan(U1), cosAlpha1);
    const sinAlpha = cosU1 * sinAlpha1;
    const cosSqAlpha = 1 - sinAlpha * sinAlpha;
    const uSq = (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
    const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

    let sigma = distanceMeters / (WGS84_B * A);
    let cos2SigmaM = 0;
    let sinSigma = 0;
    let cosSigma = 0;

    for (let iter = 0; iter < 100; iter++) {
        cos2SigmaM = Math.cos(2 * sigma1 + sigma);
        sinSigma = Math.sin(sigma);
        cosSigma = Math.cos(sigma);
        const deltaSigma = B * sinSigma * (
            cos2SigmaM + (B / 4) * (
                cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
                (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)
            )
        );
        const sigmaPrev = sigma;
        sigma = distanceMeters / (WGS84_B * A) + deltaSigma;
        if (Math.abs(sigma - sigmaPrev) <= 1e-12) break;
    }

    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);

    const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
    const phi2 = Math.atan2(
        sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
        (1 - WGS84_F) * Math.hypot(sinAlpha, tmp)
    );
    const lambda = Math.atan2(
        sinSigma * sinAlpha1,
        cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1
    );
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    const L = lambda - (1 - C) * WGS84_F * sinAlpha * (
        sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM))
    );

    const lat2 = phi2 * RAD_TO_DEG;
    const lng2 = normalizeLongitudeDegrees(lng1 + L * RAD_TO_DEG);
    const alpha2 = normalizeBearingDegrees(Math.atan2(sinAlpha, -tmp) * RAD_TO_DEG);

    return { lat: lat2, lng: lng2, finalBearingDegrees: alpha2 };
}

function sampleGeodesicPoints(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
    sampleCount: number
): Array<{ lat: number; lng: number; distanceMeters: number; fraction: number }> {
    const inv = geodesicInverseWGS84(lat1, lng1, lat2, lng2);
    const points: Array<{ lat: number; lng: number; distanceMeters: number; fraction: number }> = [];
    for (let i = 0; i < sampleCount; i++) {
        const fraction = sampleCount > 1 ? i / (sampleCount - 1) : 0;
        const distanceMeters = inv.distanceMeters * fraction;
        if (i === 0) {
            points.push({ lat: lat1, lng: lng1, distanceMeters: 0, fraction: 0 });
        } else if (i === sampleCount - 1) {
            points.push({ lat: lat2, lng: lng2, distanceMeters: inv.distanceMeters, fraction: 1 });
        } else {
            const pt = geodesicDirectWGS84(lat1, lng1, inv.initialBearingDegrees, distanceMeters);
            points.push({ lat: pt.lat, lng: pt.lng, distanceMeters, fraction });
        }
    }
    return points;
}

function geodeticToEcef(lat: number, lng: number, heightMeters = 0): [number, number, number] {
    const phi = lat * DEG_TO_RAD;
    const lam = lng * DEG_TO_RAD;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
    return [
        (N + heightMeters) * cosPhi * Math.cos(lam),
        (N + heightMeters) * cosPhi * Math.sin(lam),
        (N * (1 - WGS84_E2) + heightMeters) * sinPhi
    ];
}

function ecefToGeodetic(x: number, y: number, z: number): { lat: number; lng: number; heightMeters: number } {
    const p = Math.hypot(x, y);
    const lng = Math.atan2(y, x) * RAD_TO_DEG;
    if (p < 1e-10) {
        return {
            lat: z >= 0 ? 90 : -90,
            lng: 0,
            heightMeters: Math.abs(z) - WGS84_B
        };
    }

    const ep2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
    const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const phi = Math.atan2(
        z + ep2 * WGS84_B * sinT * sinT * sinT,
        p - WGS84_E2 * WGS84_A * cosT * cosT * cosT
    );
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
    const heightMeters = Math.abs(cosPhi) > 1e-10
        ? p / cosPhi - N
        : Math.abs(z) / Math.abs(sinPhi) - N * (1 - WGS84_E2);

    return { lat: phi * RAD_TO_DEG, lng, heightMeters };
}

function computeEnuVectorMeters(
    lat1: number,
    lng1: number,
    alt1: number,
    lat2: number,
    lng2: number,
    alt2: number
): { east: number; north: number; up: number } {
    const [x1, y1, z1] = geodeticToEcef(lat1, lng1, alt1);
    const [x2, y2, z2] = geodeticToEcef(lat2, lng2, alt2);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;

    const sinLat = Math.sin(lat1 * DEG_TO_RAD);
    const cosLat = Math.cos(lat1 * DEG_TO_RAD);
    const sinLng = Math.sin(lng1 * DEG_TO_RAD);
    const cosLng = Math.cos(lng1 * DEG_TO_RAD);

    const east = -sinLng * dx + cosLng * dy;
    const north = -sinLat * cosLng * dx - sinLat * sinLng * dy + cosLat * dz;
    const up = cosLat * cosLng * dx + cosLat * sinLng * dy + sinLat * dz;

    return {
        east: roundTo(east, 2),
        north: roundTo(north, 2),
        up: roundTo(up, 2)
    };
}

function addVec3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleVec3(v: [number, number, number], s: number): [number, number, number] {
    return [v[0] * s, v[1] * s, v[2] * s];
}

function dotVec3(a: [number, number, number], b: [number, number, number]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalizeVec3(v: [number, number, number]): [number, number, number] {
    const len = Math.hypot(v[0], v[1], v[2]);
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}

interface CameraFootprintInput {
    lat: number;
    lng: number;
    altitudeMeters: number;
    pitchDegrees: number;
    headingDegrees: number;
    rollDegrees: number;
    fovDegrees: number;
    aspectRatio: number;
    maxRayDistanceMeters: number;
}

interface FootprintGroundPoint {
    lat: number;
    lng: number;
    slant_distance_meters: number;
    clamped_to_horizon: boolean;
}

function computeCameraFootprint(params: CameraFootprintInput) {
    const {
        lat,
        lng,
        altitudeMeters,
        pitchDegrees,
        headingDegrees,
        rollDegrees,
        fovDegrees,
        aspectRatio,
        maxRayDistanceMeters
    } = params;

    if (!Number.isFinite(altitudeMeters) || altitudeMeters <= 0 || altitudeMeters > 100000) {
        throw new Error(`Invalid 'altitude_meters': ${altitudeMeters}. Must be > 0 and <= 100000.`);
    }
    if (!Number.isFinite(pitchDegrees) || pitchDegrees < -90 || pitchDegrees >= -2) {
        throw new Error(`Invalid 'pitch_degrees': ${pitchDegrees}. Must be in [-90, -2) degrees (nadir is -90).`);
    }
    if (!Number.isFinite(headingDegrees)) {
        throw new Error(`Invalid 'heading_degrees': ${headingDegrees}.`);
    }
    if (!Number.isFinite(rollDegrees)) {
        throw new Error(`Invalid 'roll_degrees': ${rollDegrees}.`);
    }
    if (!Number.isFinite(fovDegrees) || fovDegrees < 5 || fovDegrees > 150) {
        throw new Error(`Invalid 'fov_degrees': ${fovDegrees}. Must be between 5 and 150 degrees.`);
    }
    if (!Number.isFinite(aspectRatio) || aspectRatio < 0.2 || aspectRatio > 5) {
        throw new Error(`Invalid 'aspect_ratio': ${aspectRatio}. Must be between 0.2 and 5.`);
    }
    if (!Number.isFinite(maxRayDistanceMeters) || maxRayDistanceMeters <= 0) {
        throw new Error(`Invalid 'max_ray_distance_meters': ${maxRayDistanceMeters}. Must be > 0.`);
    }

    const latRad = lat * DEG_TO_RAD;
    const lngRad = lng * DEG_TO_RAD;
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLng = Math.sin(lngRad);
    const cosLng = Math.cos(lngRad);

    // Local ENU orthonormal axes in ECEF
    const E: [number, number, number] = [-sinLng, cosLng, 0];
    const N: [number, number, number] = [-sinLat * cosLng, -sinLat * sinLng, cosLat];
    const U: [number, number, number] = [cosLat * cosLng, cosLat * sinLng, sinLat];

    const hdgRad = headingDegrees * DEG_TO_RAD;
    const sinH = Math.sin(hdgRad);
    const cosH = Math.cos(hdgRad);

    const H = addVec3(scaleVec3(E, sinH), scaleVec3(N, cosH));
    const R0 = addVec3(scaleVec3(E, cosH), scaleVec3(N, -sinH));

    const pitchRad = pitchDegrees * DEG_TO_RAD;
    const cosP = Math.cos(pitchRad);
    const sinP = Math.sin(pitchRad);

    const F = addVec3(scaleVec3(H, cosP), scaleVec3(U, sinP));
    const V0 = addVec3(scaleVec3(H, -sinP), scaleVec3(U, cosP));

    const rollRad = rollDegrees * DEG_TO_RAD;
    const cosR = Math.cos(rollRad);
    const sinR = Math.sin(rollRad);
    const R = addVec3(scaleVec3(R0, cosR), scaleVec3(V0, sinR));
    const V = addVec3(scaleVec3(R0, -sinR), scaleVec3(V0, cosR));

    const origin = geodeticToEcef(lat, lng, altitudeMeters);
    const invA2 = 1 / (WGS84_A * WGS84_A);
    const invB2 = 1 / (WGS84_B * WGS84_B);

    const intersectRay = (dir: [number, number, number]): FootprintGroundPoint => {
        const d = normalizeVec3(dir);
        const aq = (d[0] * d[0] + d[1] * d[1]) * invA2 + d[2] * d[2] * invB2;
        const bq = 2 * ((origin[0] * d[0] + origin[1] * d[1]) * invA2 + origin[2] * d[2] * invB2);
        const cq = (origin[0] * origin[0] + origin[1] * origin[1]) * invA2 + origin[2] * origin[2] * invB2 - 1;
        const disc = bq * bq - 4 * aq * cq;

        if (disc >= 0 && aq > 0) {
            const t = (-bq - Math.sqrt(disc)) / (2 * aq);
            if (t > 0 && t <= maxRayDistanceMeters) {
                const hit: [number, number, number] = [
                    origin[0] + t * d[0],
                    origin[1] + t * d[1],
                    origin[2] + t * d[2]
                ];
                const geo = ecefToGeodetic(hit[0], hit[1], hit[2]);
                return {
                    lat: roundTo(geo.lat, 6),
                    lng: roundTo(geo.lng, 6),
                    slant_distance_meters: roundTo(t, 1),
                    clamped_to_horizon: false
                };
            }
        }

        // Ray missed the ellipsoid or exceeded maxRayDistanceMeters — clamp along ray azimuth
        const dE = dotVec3(d, E);
        const dN = dotVec3(d, N);
        const rayAzimuth = (Math.abs(dE) > 1e-9 || Math.abs(dN) > 1e-9)
            ? normalizeBearingDegrees(Math.atan2(dE, dN) * RAD_TO_DEG)
            : normalizeBearingDegrees(headingDegrees);
        const clampedGeo = geodesicDirectWGS84(lat, lng, rayAzimuth, maxRayDistanceMeters);
        return {
            lat: roundTo(clampedGeo.lat, 6),
            lng: roundTo(clampedGeo.lng, 6),
            slant_distance_meters: roundTo(maxRayDistanceMeters, 1),
            clamped_to_horizon: true
        };
    };

    const tanHalfH = Math.tan((fovDegrees * 0.5) * DEG_TO_RAD);
    const tanHalfV = tanHalfH / aspectRatio;

    const centerHit = intersectRay(F);
    const centerGroundDist = geodesicInverseWGS84(lat, lng, centerHit.lat, centerHit.lng).distanceMeters;

    const cornerSpecs: Array<{ key: "bottom_left" | "bottom_right" | "top_right" | "top_left"; sx: number; sy: number }> = [
        { key: "bottom_left", sx: -1, sy: -1 },
        { key: "bottom_right", sx: 1, sy: -1 },
        { key: "top_right", sx: 1, sy: 1 },
        { key: "top_left", sx: -1, sy: 1 }
    ];

    const corners: Record<string, FootprintGroundPoint> = {};
    const orderedCorners: FootprintGroundPoint[] = [];

    for (const spec of cornerSpecs) {
        const rayDir = addVec3(F, addVec3(scaleVec3(R, spec.sx * tanHalfH), scaleVec3(V, spec.sy * tanHalfV)));
        const pt = intersectRay(rayDir);
        corners[spec.key] = pt;
        orderedCorners.push(pt);
    }

    const clampedToHorizon = centerHit.clamped_to_horizon || orderedCorners.some(c => c.clamped_to_horizon);

    // Local ENU shoelace area in square kilometers
    const enuPoly = orderedCorners.map(c => computeEnuVectorMeters(lat, lng, 0, c.lat, c.lng, 0));
    let shoelace2 = 0;
    for (let i = 0; i < enuPoly.length; i++) {
        const curr = enuPoly[i];
        const next = enuPoly[(i + 1) % enuPoly.length];
        shoelace2 += curr.east * next.north - next.east * curr.north;
    }
    const areaKm2 = roundTo((0.5 * Math.abs(shoelace2)) / 1_000_000, 6);

    const lats = orderedCorners.map(c => c.lat);
    const lngs = orderedCorners.map(c => c.lng);
    const bbox = ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));

    const ringLngLat = [...orderedCorners.map(c => [c.lng, c.lat]), [orderedCorners[0].lng, orderedCorners[0].lat]];
    const ringLatLng = [...orderedCorners.map(c => [c.lat, c.lng]), [orderedCorners[0].lat, orderedCorners[0].lng]];

    const footprintGeojson = {
        type: "Feature",
        properties: {
            camera_lat: lat,
            camera_lng: lng,
            altitude_meters: altitudeMeters,
            pitch_degrees: pitchDegrees,
            heading_degrees: headingDegrees,
            roll_degrees: rollDegrees,
            fov_degrees: fovDegrees,
            aspect_ratio: roundTo(aspectRatio, 4),
            area_km2: areaKm2
        },
        geometry: {
            type: "Polygon",
            coordinates: [ringLngLat]
        }
    };

    const footprintWkt = `POLYGON((${ringLngLat.map(([x, y]) => `${x} ${y}`).join(", ")}))`;
    const shareUrl = buildShareUrlPolygon(ringLatLng, [
        { coordinates: { lat, lon: lng }, name: `Camera (${altitudeMeters}m)` },
        { coordinates: { lat: centerHit.lat, lon: centerHit.lng }, name: "Look Target" }
    ]);

    return {
        centerTarget: {
            ...centerHit,
            ground_distance_meters: roundTo(centerGroundDist, 1)
        },
        corners: corners as {
            bottom_left: FootprintGroundPoint;
            bottom_right: FootprintGroundPoint;
            top_right: FootprintGroundPoint;
            top_left: FootprintGroundPoint;
        },
        footprintGeojson,
        footprintWkt,
        bbox,
        areaKm2,
        clampedToHorizon,
        shareUrl
    };
}

function calculateBboxDimensions(bbox: BBox): { widthKm: number, heightKm: number } {
    const midLat = (bbox.lat1 + bbox.lat2) / 2;
    const midLng = (bbox.lng1 + bbox.lng2) / 2;
    const lngSpan = Math.abs(bbox.lng2 - bbox.lng1);

    const widthKm = lngSpan <= 180
        ? geodesicInverseWGS84(midLat, bbox.lng1, midLat, bbox.lng2).distanceMeters / 1000
        : (geodesicInverseWGS84(midLat, bbox.lng1, midLat, midLng).distanceMeters +
           geodesicInverseWGS84(midLat, midLng, midLat, bbox.lng2).distanceMeters) / 1000;
    const heightKm = geodesicInverseWGS84(bbox.lat1, midLng, bbox.lat2, midLng).distanceMeters / 1000;

    return { widthKm, heightKm };
}

function calculateBboxArea(bbox: BBox): number {
    const { widthKm, heightKm } = calculateBboxDimensions(bbox);
    return widthKm * heightKm;
}

function latLngToTile(lat: number, lng: number, zoom: number): { z: number, x: number, y: number } {
    // Clamp to Web Mercator latitude limits to avoid Math.tan(±90°) → Infinity → NaN
    const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
    const n = Math.pow(2, zoom);
    const x = Math.floor((lng + 180) / 360 * n);
    const latRad = clampedLat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { z: zoom, x, y };
}

function tileToBBox(z: number, x: number, y: number): BBox {
    const n = Math.pow(2, z);
    const lng1 = (x / n) * 360 - 180;
    const lng2 = ((x + 1) / n) * 360 - 180;
    const latRad1 = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
    const latRad2 = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const lat1 = (latRad1 * 180) / Math.PI;
    const lat2 = (latRad2 * 180) / Math.PI;
    return ensureValidBBox(lat1, lng1, lat2, lng2);
}

function expandBBoxMeters(bbox: BBox, bufferMeters: number): BBox {
    if (!bufferMeters || bufferMeters === 0) return bbox;
    const midLat = ((bbox.lat1 + bbox.lat2) / 2) * (Math.PI / 180);
    const dLat = bufferMeters / 111320;
    const cosLat = Math.max(0.01, Math.cos(midLat));
    const dLng = bufferMeters / (111320 * cosLat);
    return ensureValidBBox(
        Math.max(-90, bbox.lat1 - dLat),
        Math.max(-180, bbox.lng1 - dLng),
        Math.min(90, bbox.lat2 + dLat),
        Math.min(180, bbox.lng2 + dLng)
    );
}

/**
 * Extracts polygons (with interior holes preserved) as arrays of [lat, lng] rings
 * for H3 polygonToCells and point-in-polygon checks.
 * Return shape: number[][][][] = Array of Polygons, where each Polygon is [outerRing, ...holeRings],
 * and each Ring is Array of [lat, lng].
 */
function extractPolygonsWithHolesLatLng(input: any): number[][][][] | null {
    try {
        let geom = input;
        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (trimmed.startsWith('{')) {
                geom = JSON.parse(trimmed);
            } else if (/^\s*(MULTI)?POLYGON/i.test(trimmed)) {
                geom = parseWKT(trimmed);
            } else {
                return null;
            }
        }
        if (!geom || typeof geom !== 'object') return null;
        if (geom.type === 'Feature') geom = geom.geometry;
        if (geom.type === 'FeatureCollection' && Array.isArray(geom.features) && geom.features.length > 0) {
            const polys: number[][][][] = [];
            for (const f of geom.features) {
                const sub = extractPolygonsWithHolesLatLng(f.geometry);
                if (sub) polys.push(...sub);
            }
            return polys.length > 0 ? polys : null;
        }
        if (!geom) return null;
        if (geom.type === 'Polygon' && Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
            // Preserve outer ring AND all interior hole rings, converting [lng, lat] -> [lat, lng]
            const ringsLatLng: number[][][] = geom.coordinates.map((ring: number[][]) =>
                ring.map((c: number[]) => [c[1], c[0]])
            );
            return [ringsLatLng];
        }
        if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
            return geom.coordinates.map((poly: number[][][]) =>
                poly.map((ring: number[][]) => ring.map((c: number[]) => [c[1], c[0]]))
            );
        }
    } catch {
        // Ignore and fall back to bounding box
    }
    return null;
}

function formatMarkerParts(
    elements: Array<{ coordinates: { lat: number; lon: number }; name: string }>
): string[] {
    const MAX_MARKERS = 30;
    return elements
        .filter(e => e.coordinates?.lat !== undefined && e.coordinates?.lon !== undefined)
        .slice(0, MAX_MARKERS)
        .map(e => {
            let name = e.name || 'Point';
            if (name.length > 30) name = name.slice(0, 27) + '...';
            return `${e.coordinates.lat.toFixed(6)},${e.coordinates.lon.toFixed(6)},${encodeURIComponent(name)}`;
        });
}

function buildShareUrl(bbox: BBox): string {
    const hash = `${bbox.lat1.toFixed(6)},${bbox.lng1.toFixed(6)},${bbox.lat2.toFixed(6)},${bbox.lng2.toFixed(6)}`;
    return `https://vibhorsingh.com/boundingbox/#${hash}`;
}

// The fragment is read by the static viewer. Older viewers ignore typed overlays.
function appendH3Preview(
    url: string,
    resolution: number,
    total: number,
    cells: string[],
    counts?: Record<string, number>
): string {
    let link = `${url}|H3:${resolution},${total}`;
    for (const cell of cells.slice(0, 64)) {
        const entry = counts ? `,${cell}.${counts[cell]}` : `,${cell}`;
        if (link.length + entry.length > 3800) break;
        link += entry;
    }
    return link;
}

function appendResultMetadata(
    url: string,
    metadata: { returned?: number; source: string; warnings: string[] }
): string {
    const encoded = Buffer.from(JSON.stringify({
        ...metadata,
        warnings: metadata.warnings.slice(0, 3).map(warning => warning.slice(0, 160))
    })).toString("base64url");
    return `${url}|MCP:${encoded}`;
}

function buildShareUrlWithMarkers(
    bbox: BBox,
    elements: Array<{ coordinates: { lat: number; lon: number }; name: string }>,
    extraParts?: string[]
): string {
    const bboxPart = `${bbox.lat1.toFixed(6)},${bbox.lng1.toFixed(6)},${bbox.lat2.toFixed(6)},${bbox.lng2.toFixed(6)}`;
    const markerParts = formatMarkerParts(elements);
    const hashParts = [bboxPart, ...(extraParts || []), ...markerParts];
    return `https://vibhorsingh.com/boundingbox/#${hashParts.join('|')}`;
}

/**
 * Builds a verification map URL without an active orange bounding-box rectangle (empty parts[0]).
 * The viewer renders any LB:/LBE: polylines, PB: polygons, and markers, and auto-fits the map bounds to them.
 */
function buildShareUrlMarkersOnly(
    elements: Array<{ coordinates: { lat: number; lon: number }; name: string }>,
    extraParts?: string[]
): string {
    const markerParts = formatMarkerParts(elements);
    const hashParts = ["", ...(extraParts || []), ...markerParts];
    return `https://vibhorsingh.com/boundingbox/#${hashParts.join('|')}`;
}

/**
 * Builds a verification map URL with a polygon boundary (P:lat,lng,...) in parts[0] instead of a rectangle.
 */
function buildShareUrlPolygon(
    outerRingLatLng: number[][],
    elements: Array<{ coordinates: { lat: number; lon: number }; name: string }> = []
): string {
    const MAX_RING_PTS = 60;
    let sampled = outerRingLatLng;
    if (outerRingLatLng.length > MAX_RING_PTS) {
        sampled = [];
        for (let i = 0; i < MAX_RING_PTS; i++) {
            const idx = Math.min(
                outerRingLatLng.length - 1,
                Math.round((i / (MAX_RING_PTS - 1)) * (outerRingLatLng.length - 1))
            );
            sampled.push(outerRingLatLng[idx]);
        }
    }
    const polyPart = `P:${sampled.map(([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(',')}`;
    const markerParts = formatMarkerParts(elements);
    return `https://vibhorsingh.com/boundingbox/#${[polyPart, ...markerParts].join('|')}`;
}

/**
 * Encodes an array of [lng, lat] pairs in Google's Encoded Polyline format (1e5 precision),
 * escaping `|` as `!` (unused by the 63..126 polyline alphabet) before percent-encoding
 * so hash delimiters (`|` / `%7C`) never split an LBE: layer.
 */
function encodeGooglePolyline(coordsLngLat: number[][]): string {
    let encoded = "";
    let prevLat = 0;
    let prevLng = 0;

    const writeSignedValue = (val: number) => {
        let sgn = val < 0 ? ~(val << 1) : (val << 1);
        while (sgn >= 0x20) {
            encoded += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
            sgn >>>= 5;
        }
        encoded += String.fromCharCode(sgn + 63);
    };

    for (const [lng, lat] of coordsLngLat) {
        const latE5 = Math.round(lat * 1e5);
        const lngE5 = Math.round(lng * 1e5);
        writeSignedValue(latE5 - prevLat);
        writeSignedValue(lngE5 - prevLng);
        prevLat = latE5;
        prevLng = lngE5;
    }

    return encodeURIComponent(encoded.replace(/\|/g, "!"));
}

/**
 * Encodes an open one-way route LineString ([lng, lat][]) onto the verification map URL alongside
 * origin/destination markers, WITHOUT mirroring back to start or drawing a bounding box rectangle.
 * Uses compact Google Encoded Polyline (`LBE:`) for longer routes (>15 points) and plain `LB:`
 * coordinates for short point-to-point/corridor lines.
 */
function buildShareUrlWithRoute(
    _bbox: BBox,
    routeCoordsLngLat: number[][],
    markers: Array<{ coordinates: { lat: number; lon: number }; name: string }>
): string {
    const MAX_PATH_PTS = 200;
    const LBE_MIN_POINTS = 15;
    let sampled = routeCoordsLngLat;
    if (routeCoordsLngLat.length > MAX_PATH_PTS) {
        sampled = [];
        for (let i = 0; i < MAX_PATH_PTS; i++) {
            const idx = Math.min(
                routeCoordsLngLat.length - 1,
                Math.round((i / (MAX_PATH_PTS - 1)) * (routeCoordsLngLat.length - 1))
            );
            sampled.push(routeCoordsLngLat[idx]);
        }
    }
    const extraParts: string[] = [];
    if (sampled.length >= 2) {
        if (sampled.length > LBE_MIN_POINTS) {
            extraParts.push(`LBE:${encodeGooglePolyline(sampled)}`);
        } else {
            const points = sampled.map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`);
            extraParts.push(`LB:${points.join(',')}`);
        }
    }
    return buildShareUrlMarkersOnly(markers, extraParts);
}

function getH3Cells(bbox: BBox, resolution: number, compact: boolean, customPolygons?: number[][][][] | null): string[] {
    if (resolution < 0 || resolution > 15 || !Number.isInteger(resolution)) {
        throw new Error(`Invalid H3 resolution: ${resolution}. Must be an integer between 0 and 15.`);
    }

    // Safety limit estimation (rough check)
    const avgHexArea = h3.getHexagonAreaAvg(resolution, h3.UNITS.km2);

    // Calculate approximate width and height using simple distance
    const dx = (bbox.lng2 - bbox.lng1) * 111.32 * Math.cos(((bbox.lat1 + bbox.lat2) / 2) * Math.PI / 180);
    const dy = (bbox.lat2 - bbox.lat1) * 111.32;
    const areaKm2 = dx * dy;

    const estimatedCount = areaKm2 / avgHexArea;
    if (estimatedCount > MAX_H3_CELLS * 2) {
        throw new Error(`Area too large for resolution ${resolution}. Estimated ${Math.floor(estimatedCount).toLocaleString()} cells. Maximum allowed is ${MAX_H3_CELLS.toLocaleString()}.`);
    }

    let cells: string[] = [];
    if (customPolygons && customPolygons.length > 0) {
        const cellSet = new Set<string>();
        for (const polyWithHoles of customPolygons) {
            if (polyWithHoles.length > 0 && polyWithHoles[0].length >= 3) {
                // Pass full [outerRing, ...holeRings] to h3.polygonToCells so holes are excluded
                for (const c of h3.polygonToCells(polyWithHoles, resolution)) {
                    cellSet.add(c);
                }
            }
        }
        cells = Array.from(cellSet);
    }

    if (cells.length === 0 && (!customPolygons || customPolygons.length === 0)) {
        // Fallback to rectangular bbox polygon: [ [lat, lng]... ]
        const polygon = [
            [bbox.lat1, bbox.lng1],
            [bbox.lat2, bbox.lng1],
            [bbox.lat2, bbox.lng2],
            [bbox.lat1, bbox.lng2],
            [bbox.lat1, bbox.lng1]
        ];
        cells = h3.polygonToCells(polygon, resolution);
    }

    if (cells.length > MAX_H3_CELLS) {
        throw new Error(`Too many cells generated (${cells.length.toLocaleString()}). Maximum allowed is ${MAX_H3_CELLS.toLocaleString()}. Try a lower resolution or smaller bounds.`);
    }

    if (compact) {
        cells = h3.compactCells(cells);
    }

    return cells;
}

/**
 * Converts H3 cell IDs to GeoJSON FeatureCollection with hex boundary polygons.
 */
function h3CellsToGeoJSON(cells: string[]): object {
    const features = cells.map(cellId => {
        const boundary = h3.cellToBoundary(cellId);
        // h3 returns [lat, lng] pairs — GeoJSON needs [lng, lat]
        const coordinates = boundary.map(([lat, lng]) => [lng, lat]);
        coordinates.push(coordinates[0]); // close the ring

        return {
            type: "Feature",
            properties: {
                h3_index: cellId,
                resolution: h3.getResolution(cellId)
            },
            geometry: {
                type: "Polygon",
                coordinates: [coordinates]
            }
        };
    });

    return {
        type: "FeatureCollection",
        features
    };
}

// ---------------------------------------------------------------------------
// Concurrency-Safe Rate Limiter, Provenance Metadata, and Caches
// ---------------------------------------------------------------------------

export interface ProvenanceMetadata {
    provider: string;
    attribution?: string;
    data_timestamp: string;
    cached: boolean;
    cache_age_ms: number;
    usage_policy?: string;
}

const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL - https://www.openstreetmap.org/copyright)";
const APP_USER_AGENT = process.env.OSM_USER_AGENT || `${SERVER_NAME}/${SERVER_VERSION} (https://github.com/iamvibhorsingh/bbox-mcp-server)`;

/**
 * Creates a concurrency-safe rate limiter using a serialized promise queue.
 * Concurrent callers are strictly spaced by at least `minIntervalMs`.
 */
function createRateLimiter(minIntervalMs: number): () => Promise<void> {
    let nextAllowedTime = 0;
    let queue: Promise<void> = Promise.resolve();
    return () => {
        const run = queue.then(async () => {
            const now = Date.now();
            const waitMs = Math.max(0, nextAllowedTime - now);
            nextAllowedTime = Math.max(now, nextAllowedTime) + minIntervalMs;
            if (waitMs > 0) {
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
        });
        queue = run.catch(() => {});
        return run;
    };
}

const nominatimRateLimit = createRateLimiter(1000);
const photonRateLimit = createRateLimiter(1000);
const routingRateLimit = createRateLimiter(1000);

const NOMINATIM_CACHE = new Map<string, { timestamp: number; data: any }>();
const NOMINATIM_CACHE_MAX = 500;
const NOMINATIM_TTL_MS = 60 * 60 * 1000; // 1 hour TTL
const NOMINATIM_BASE_URL = (process.env.NOMINATIM_API_URL || "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
const PHOTON_BASE_URL = (process.env.PHOTON_API_URL || "https://photon.komoot.io").replace(/\/+$/, "");

async function fetchNominatim(url: string): Promise<{ data: any; cached: boolean; cache_age_ms: number; timestamp: string }> {
    const cached = NOMINATIM_CACHE.get(url);
    if (cached && (Date.now() - cached.timestamp < NOMINATIM_TTL_MS)) {
        return {
            data: cached.data,
            cached: true,
            cache_age_ms: Date.now() - cached.timestamp,
            timestamp: new Date(cached.timestamp).toISOString()
        };
    }

    await nominatimRateLimit();

    // Check cache again after waiting in queue in case a concurrent caller populated the same URL
    const cachedAfterWait = NOMINATIM_CACHE.get(url);
    if (cachedAfterWait && (Date.now() - cachedAfterWait.timestamp < NOMINATIM_TTL_MS)) {
        return {
            data: cachedAfterWait.data,
            cached: true,
            cache_age_ms: Date.now() - cachedAfterWait.timestamp,
            timestamp: new Date(cachedAfterWait.timestamp).toISOString()
        };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': APP_USER_AGENT,
                'Accept': 'application/json'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Nominatim request failed with status: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const now = Date.now();
        setBoundedCache(NOMINATIM_CACHE, NOMINATIM_CACHE_MAX, url, { timestamp: now, data });
        return {
            data,
            cached: false,
            cache_age_ms: 0,
            timestamp: new Date(now).toISOString()
        };
    } catch (err: any) {
        if (err.name === 'AbortError') {
            throw new Error(`Nominatim request timed out after ${FETCH_TIMEOUT_MS / 1000}s from ${NOMINATIM_BASE_URL}`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

interface GeocodeResultItem {
    matched_place: string;
    bbox: BBox;
    center: { lat: number; lng: number };
    osm_area_id?: number;
    class?: string;
    type?: string;
    osm_type?: string;
    osm_id?: number;
    polygons_with_holes?: number[][][][];
}

interface GeocodeResult extends GeocodeResultItem {
    alternatives: GeocodeResultItem[];
    provenance: ProvenanceMetadata;
}

const PHOTON_CACHE = new Map<string, { timestamp: number; data: any }>();

async function geocodeLocation(query: string, includePolygon: boolean = false, warnings?: string[]): Promise<GeocodeResult> {
    // 1. Try Nominatim first (free, returns exact OSM area boundaries & alternatives)
    try {
        const polyParam = includePolygon ? "&polygon_geojson=1" : "";
        const emailParam = process.env.NOMINATIM_EMAIL ? `&email=${encodeURIComponent(process.env.NOMINATIM_EMAIL)}` : "";
        const nominatimUrl = `${NOMINATIM_BASE_URL}/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&extratags=1&limit=5${polyParam}${emailParam}`;
        const { data: items, cached, cache_age_ms, timestamp } = await fetchNominatim(nominatimUrl);

        if (Array.isArray(items) && items.length > 0) {
            const parsedItems: GeocodeResultItem[] = items.map((item: any) => {
                let bbox: BBox;
                if (item.boundingbox && item.boundingbox.length === 4) {
                    const south = parseFloat(item.boundingbox[0]);
                    const north = parseFloat(item.boundingbox[1]);
                    const west = parseFloat(item.boundingbox[2]);
                    const east = parseFloat(item.boundingbox[3]);
                    bbox = ensureValidBBox(south, west, north, east);
                } else {
                    const lat = parseFloat(item.lat);
                    const lon = parseFloat(item.lon);
                    bbox = ensureValidBBox(lat - 0.05, lon - 0.05, lat + 0.05, lon + 0.05);
                }

                const center = { lat: parseFloat(item.lat), lng: parseFloat(item.lon) };
                let osm_area_id: number | undefined;
                const osmIdNum = parseInt(item.osm_id, 10);

                if (item.osm_type === "relation" && !isNaN(osmIdNum)) {
                    osm_area_id = 3600000000 + osmIdNum;
                } else if (item.osm_type === "way" && !isNaN(osmIdNum)) {
                    osm_area_id = 2400000000 + osmIdNum;
                }

                const polygons_with_holes = item.geojson ? (extractPolygonsWithHolesLatLng(item.geojson) || undefined) : undefined;

                return {
                    matched_place: sanitizeExternalText(item.display_name, 300),
                    bbox,
                    center,
                    osm_area_id,
                    class: item.class ? sanitizeExternalText(String(item.class), 80) : undefined,
                    type: item.type ? sanitizeExternalText(String(item.type), 80) : undefined,
                    osm_type: item.osm_type ? sanitizeExternalText(String(item.osm_type), 40) : undefined,
                    osm_id: osmIdNum,
                    ...(polygons_with_holes ? { polygons_with_holes } : {})
                };
            });

            let primaryIndex = parsedItems.findIndex(i =>
                i.osm_type === "relation" &&
                (i.class === "boundary" || i.type === "administrative" || i.type === "boundary")
            );
            if (primaryIndex === -1) primaryIndex = 0;

            const primary = parsedItems[primaryIndex];
            const alternatives = parsedItems.filter((_, idx) => idx !== primaryIndex);

            return {
                ...primary,
                alternatives,
                provenance: {
                    provider: `nominatim (${NOMINATIM_BASE_URL})`,
                    attribution: OSM_ATTRIBUTION,
                    data_timestamp: timestamp,
                    cached,
                    cache_age_ms,
                    usage_policy: "https://operations.osmfoundation.org/policies/nominatim/ (max 1 req/s, cache results, set NOMINATIM_API_URL for high-volume/shared deployments)"
                }
            };
        }
    } catch (err: any) {
        log('warn', `Nominatim geocoding failed for '${query}', trying fallback provider`, { error: err.message });
    }

    // 2. Fallback to Photon (Komoot) — configurable via PHOTON_API_URL, cached & rate-limited
    try {
        const photonUrl = `${PHOTON_BASE_URL}/api/?q=${encodeURIComponent(query)}&limit=5`;
        let data: any;
        let cached = false;
        let cache_age_ms = 0;
        let timestamp = new Date().toISOString();

        const cachedEntry = PHOTON_CACHE.get(photonUrl);
        if (cachedEntry && (Date.now() - cachedEntry.timestamp < NOMINATIM_TTL_MS)) {
            data = cachedEntry.data;
            cached = true;
            cache_age_ms = Date.now() - cachedEntry.timestamp;
            timestamp = new Date(cachedEntry.timestamp).toISOString();
        } else {
            await photonRateLimit();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            try {
                const response = await fetch(photonUrl, {
                    headers: {
                        'User-Agent': APP_USER_AGENT,
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });
                if (response.ok) {
                    data = await response.json();
                    const now = Date.now();
                    setBoundedCache(PHOTON_CACHE, NOMINATIM_CACHE_MAX, photonUrl, { timestamp: now, data });
                    timestamp = new Date(now).toISOString();
                }
            } finally {
                clearTimeout(timeout);
            }
        }

        if (data && Array.isArray(data.features) && data.features.length > 0) {
            if (PHOTON_BASE_URL.includes("photon.komoot.io")) {
                warnings?.push("Used public Photon demo server (photon.komoot.io) as geocoding fallback; extensive usage may be throttled. Configure NOMINATIM_API_URL, PHOTON_API_URL, or MAPBOX_ACCESS_TOKEN for production.");
            }
            const photonItems: GeocodeResultItem[] = data.features.map((f: any) => {
                const coords = f.geometry?.coordinates || [0, 0];
                const center = { lat: coords[1], lng: coords[0] };
                const props = f.properties || {};
                let bbox: BBox;
                if (Array.isArray(props.extent) && props.extent.length === 4) {
                    bbox = ensureValidBBox(props.extent[3], props.extent[0], props.extent[1], props.extent[2]);
                } else {
                    bbox = ensureValidBBox(center.lat - 0.05, center.lng - 0.05, center.lat + 0.05, center.lng + 0.05);
                }
                const osmTypeMap: Record<string, string> = { R: "relation", W: "way", N: "node" };
                const osm_type = osmTypeMap[props.osm_type] || props.osm_type;
                const osm_id = typeof props.osm_id === 'number' ? props.osm_id : parseInt(props.osm_id, 10);
                let osm_area_id: number | undefined;
                if (osm_type === "relation" && !isNaN(osm_id)) osm_area_id = 3600000000 + osm_id;
                else if (osm_type === "way" && !isNaN(osm_id)) osm_area_id = 2400000000 + osm_id;

                const labelParts = [props.name, props.city, props.state, props.country]
                    .map(v => sanitizeExternalText(v, 120))
                    .filter(Boolean);
                return {
                    matched_place: labelParts.length > 0 ? labelParts.join(", ") : sanitizeExternalText(query, 200),
                    bbox,
                    center,
                    osm_area_id,
                    class: props.osm_key ? sanitizeExternalText(String(props.osm_key), 80) : undefined,
                    type: props.osm_value ? sanitizeExternalText(String(props.osm_value), 80) : undefined,
                    osm_type,
                    osm_id: !isNaN(osm_id) ? osm_id : undefined
                };
            });
            return {
                ...photonItems[0],
                alternatives: photonItems.slice(1),
                provenance: {
                    provider: `photon (${PHOTON_BASE_URL})`,
                    attribution: OSM_ATTRIBUTION,
                    data_timestamp: timestamp,
                    cached,
                    cache_age_ms,
                    usage_policy: "https://github.com/komoot/photon#demo-server (public demo server; extensive usage may be throttled)"
                }
            };
        }
    } catch (err: any) {
        log('warn', `Photon fallback geocoding failed for '${query}'`, { error: err.message });
    }

    // 3. Optional fallback to Mapbox if configured
    if (MAPBOX_ACCESS_TOKEN) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_ACCESS_TOKEN}&limit=5`;
            const response = await fetch(url, { signal: controller.signal });

            if (!response.ok) {
                throw new Error(`Geocoding failed with status: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            if (!data || !Array.isArray(data.features) || data.features.length === 0) {
                throw new Error(`No results found for location: ${query}`);
            }

            const mapboxItems: GeocodeResultItem[] = data.features.map((feature: any) => {
                let bbox: BBox;
                let center: { lat: number; lng: number };
                if (feature.bbox) {
                    bbox = ensureValidBBox(feature.bbox[1], feature.bbox[0], feature.bbox[3], feature.bbox[2]);
                    center = { lat: (bbox.lat1 + bbox.lat2) / 2, lng: (bbox.lng1 + bbox.lng2) / 2 };
                } else if (feature.center) {
                    center = { lat: feature.center[1], lng: feature.center[0] };
                    bbox = ensureValidBBox(center.lat - 0.05, center.lng - 0.05, center.lat + 0.05, center.lng + 0.05);
                } else {
                    throw new Error(`Unable to determine location bounds for feature`);
                }
                return {
                    matched_place: sanitizeExternalText(feature.place_name || feature.text || query, 300),
                    bbox,
                    center,
                    class: feature.properties?.category ? sanitizeExternalText(String(feature.properties.category), 80) : undefined
                };
            });

            const primary = mapboxItems[0];
            const alternatives = mapboxItems.slice(1);

            return {
                ...primary,
                alternatives,
                provenance: {
                    provider: "mapbox (api.mapbox.com)",
                    attribution: "© Mapbox © OpenStreetMap",
                    data_timestamp: new Date().toISOString(),
                    cached: false,
                    cache_age_ms: 0
                }
            };
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`Geocoding request timed out for query: ${query}`);
            }
            throw err;
        } finally {
            clearTimeout(timeout);
        }
    }

    throw new Error(`No geocoding results found for location: ${query}`);
}

interface ReverseGeocodeResult {
    matched_place: string;
    center: { lat: number; lng: number };
    bbox: BBox;
    address: Record<string, string>;
    class?: string;
    type?: string;
    osm_type?: string;
    osm_id?: number;
    share_url: string;
    provenance: ProvenanceMetadata;
    complete: boolean;
    warnings: string[];
}

async function reverseGeocode(lat: number, lng: number, zoom: number = 18): Promise<ReverseGeocodeResult> {
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new Error(`Invalid lat/lng coordinates for reverse geocoding: (${lat}, ${lng})`);
    }
    const clampedZoom = Math.max(0, Math.min(18, Math.round(zoom)));
    const emailParam = process.env.NOMINATIM_EMAIL ? `&email=${encodeURIComponent(process.env.NOMINATIM_EMAIL)}` : "";
    const url = `${NOMINATIM_BASE_URL}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=${clampedZoom}&addressdetails=1${emailParam}`;

    const { data, cached, cache_age_ms, timestamp } = await fetchNominatim(url);
    if (!data || !data.display_name) {
        throw new Error(`No reverse geocoding results found for coordinates: (${lat}, ${lng})`);
    }

    let bbox: BBox;
    if (data.boundingbox && data.boundingbox.length === 4) {
        const south = parseFloat(data.boundingbox[0]);
        const north = parseFloat(data.boundingbox[1]);
        const west = parseFloat(data.boundingbox[2]);
        const east = parseFloat(data.boundingbox[3]);
        bbox = ensureValidBBox(south, west, north, east);
    } else {
        bbox = ensureValidBBox(lat - 0.005, lng - 0.005, lat + 0.005, lng + 0.005);
    }

    const matchedPlace = sanitizeExternalText(data.display_name, 300);
    const shareUrl = buildShareUrlMarkersOnly([{ coordinates: { lat, lon: lng }, name: matchedPlace }]);

    return {
        matched_place: matchedPlace,
        center: { lat, lng },
        bbox,
        address: sanitizeExternalTags(data.address || {}, 40, 200),
        ...(data.class ? { class: sanitizeExternalText(String(data.class), 80) } : {}),
        ...(data.type ? { type: sanitizeExternalText(String(data.type), 80) } : {}),
        ...(data.osm_type ? { osm_type: sanitizeExternalText(String(data.osm_type), 40) } : {}),
        ...(data.osm_id ? { osm_id: parseInt(data.osm_id, 10) } : {}),
        share_url: shareUrl,
        provenance: {
            provider: `nominatim (${NOMINATIM_BASE_URL})`,
            attribution: OSM_ATTRIBUTION,
            data_timestamp: timestamp,
            cached,
            cache_age_ms,
            usage_policy: "https://operations.osmfoundation.org/policies/nominatim/"
        },
        complete: true,
        warnings: []
    };
}

function splitOverpassStatements(query: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inDouble = false;
    let inSingle = false;

    for (let i = 0; i < query.length; i++) {
        const char = query[i];
        if ((inDouble || inSingle) && char === '\\' && i + 1 < query.length) {
            current += char + query[i + 1];
            i++;
            continue;
        }
        if (char === '"' && !inSingle) {
            inDouble = !inDouble;
            current += char;
        } else if (char === "'" && !inDouble) {
            inSingle = !inSingle;
            current += char;
        } else if (char === ';' && !inDouble && !inSingle) {
            if (current.trim()) {
                statements.push(current.trim());
            }
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) {
        statements.push(current.trim());
    }
    return statements;
}

/**
 * Validates user/agent-provided Overpass QL core selectors without blocking
 * legitimate tag/regex/multi-statement queries. Rejects global directives,
 * unbalanced quotes/parentheses (union breakouts), parenthesized filter-bypass
 * blocks, and non-selector control statements (`out`, `make`, `area`, etc.).
 */
function validateOverpassQuery(queryRaw: string): string | null {
    if (queryRaw.length > 2000) {
        return "Error: Query is too long (maximum 2000 characters).";
    }

    let inDouble = false;
    let inSingle = false;
    let parenDepth = 0;
    let skeleton = '';

    for (let i = 0; i < queryRaw.length; i++) {
        const ch = queryRaw[i];
        if ((inDouble || inSingle) && ch === '\\' && i + 1 < queryRaw.length) {
            i++;
            continue;
        }
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (!inDouble && !inSingle) {
            if (ch === '(') parenDepth++;
            else if (ch === ')') {
                parenDepth--;
                if (parenDepth < 0) {
                    return "Error: Query contains unbalanced parentheses.";
                }
            }
            skeleton += ch;
        }
    }

    if (inDouble || inSingle) {
        return "Error: Query contains an unterminated quoted string.";
    }
    if (parenDepth !== 0) {
        return "Error: Query contains unbalanced parentheses.";
    }

    if (/\[\s*(?:out|timeout|bbox|maxsize|date|diff|adiff)\s*:/i.test(skeleton)) {
        return "Error: Query must not contain [out:], [timeout:], [bbox:], or [maxsize:] directives. The server handles these automatically.";
    }

    const skeletonStatements = skeleton.split(';').map(s => s.trim()).filter(Boolean);
    if (skeletonStatements.length === 0) {
        return "Error: Query must contain at least one Overpass selector statement (e.g. `nwr[\"amenity\"=\"cafe\"]`).";
    }

    for (const stmt of skeletonStatements) {
        if (stmt.startsWith('(')) {
            return "Error: Do not wrap query statements in outer parentheses; the server applies union and spatial filters automatically.";
        }
        if (/^(?:out|make|area|is_in|retro|for|foreach|complete|convert|timeline|local)\b/i.test(stmt)) {
            return "Error: Query must contain only Overpass element selectors (node/way/relation/nwr), not output or control statements.";
        }
    }

    return null;
}

function parseClampedTimeoutSec(raw: unknown, defaultSec = 25): number {
    if (raw === undefined || raw === null) return defaultSec;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid 'timeout_seconds': must be a positive number.`);
    }
    return Math.max(1, Math.min(180, Math.round(n)));
}

/**
 * Attaches a spatial filter (e.g. `(area.searchArea)` or `(around:2000,lat,lng)`)
 * to every selector statement in a multi-statement Overpass QL query string.
 * Respects quoted semicolons in tag values and skips non-selector/output statements.
 */
function applySpatialFilter(queryRaw: string, spatialFilter: string): string {
    if (!spatialFilter) return queryRaw.trim().endsWith(';') ? queryRaw.trim() : `${queryRaw.trim()};`;
    const statements = splitOverpassStatements(queryRaw);
    if (statements.length === 0) return queryRaw;

    const processed = statements.map(stmt => {
        // Skip non-selector statements like 'out center', directives, set operations, comments
        if (/^(out|[()\[]|->)/i.test(stmt) || /\bout\s+(body|skel|ids|meta|geom|center)/i.test(stmt)) {
            return stmt;
        }
        if (stmt.includes(spatialFilter.trim())) {
            return stmt;
        }
        // If statement defines a named set (e.g., `... -> .searchSet`), insert spatial filter before `->`
        if (/->\s*\.[a-zA-Z0-9_]+/.test(stmt)) {
            return stmt.replace(/(->\s*\.[a-zA-Z0-9_]+)/, `${spatialFilter} $1`);
        }
        return `${stmt}${spatialFilter}`;
    });

    return processed.join('; ') + ';';
}

function calculateHaversineDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function calculateBearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number): { degrees: number; cardinal: string } {
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dLambda = ((lng2 - lng1) * Math.PI) / 180;
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    const theta = Math.atan2(y, x);
    const degrees = ((theta * 180) / Math.PI + 360) % 360;
    return { degrees: Math.round(degrees * 100) / 100, cardinal: bearingToCardinal(degrees) };
}

function resamplePathGeodesic(
    coordsLngLat: number[][],
    sampleCount: number
): {
    totalDistanceMeters: number;
    samples: Array<{ lat: number; lng: number; distanceMeters: number }>;
} {
    interface PathSeg {
        latA: number;
        lngA: number;
        startDist: number;
        length: number;
        bearing: number;
    }
    const segments: PathSeg[] = [];
    let cumulative = 0;

    for (let i = 0; i < coordsLngLat.length - 1; i++) {
        const [lngA, latA] = coordsLngLat[i];
        const [lngB, latB] = coordsLngLat[i + 1];
        const inv = geodesicInverseWGS84(latA, lngA, latB, lngB);
        segments.push({
            latA,
            lngA,
            startDist: cumulative,
            length: inv.distanceMeters,
            bearing: inv.initialBearingDegrees
        });
        cumulative += inv.distanceMeters;
    }

    if (cumulative < 1e-3) {
        throw new Error(`Path has zero length; provide distinct coordinates to compute an elevation profile.`);
    }

    const samples: Array<{ lat: number; lng: number; distanceMeters: number }> = [];
    let segIdx = 0;

    for (let k = 0; k < sampleCount; k++) {
        if (k === 0) {
            samples.push({ lat: coordsLngLat[0][1], lng: coordsLngLat[0][0], distanceMeters: 0 });
            continue;
        }
        if (k === sampleCount - 1) {
            const last = coordsLngLat[coordsLngLat.length - 1];
            samples.push({ lat: last[1], lng: last[0], distanceMeters: cumulative });
            continue;
        }
        const targetDist = (k / (sampleCount - 1)) * cumulative;
        while (segIdx < segments.length - 1 && targetDist > segments[segIdx].startDist + segments[segIdx].length) {
            segIdx++;
        }
        const seg = segments[segIdx];
        const offsetInSeg = Math.max(0, Math.min(seg.length, targetDist - seg.startDist));
        const pt = geodesicDirectWGS84(seg.latA, seg.lngA, seg.bearing, offsetInSeg);
        samples.push({ lat: pt.lat, lng: pt.lng, distanceMeters: targetDist });
    }

    return { totalDistanceMeters: cumulative, samples };
}

/**
 * Parses and validates a GeoJSON LineString or raw [[lng, lat], ...] coordinate array
 * for route-corridor traffic control queries.
 */
function parseRouteCoordinates(input: unknown): number[][] {
    let parsed = input;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch (err: any) {
            throw new Error(`Invalid route_geometry JSON: ${err?.message}`);
        }
    }

    const rawCoords = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' && (parsed as any).type === 'LineString' && Array.isArray((parsed as any).coordinates))
            ? (parsed as any).coordinates
            : null;

    if (!rawCoords || rawCoords.length < 2) {
        throw new Error(`route_geometry must be a GeoJSON LineString or [[lng, lat], ...] array with at least 2 points.`);
    }

    const validCoords: number[][] = [];
    for (const pt of rawCoords) {
        if (!Array.isArray(pt) || pt.length < 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
            throw new Error(`Invalid coordinate pair in route_geometry; expected [lng, lat] numbers.`);
        }
        const [lng, lat] = pt;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            throw new Error(`Out-of-bounds coordinate [${lng}, ${lat}] in route_geometry.`);
        }
        validCoords.push([lng, lat]);
    }
    return validCoords;
}

/**
 * Thins a route polyline to keep Overpass (around:radius,...) queries fast and bounded
 * while preserving the start, end, and turns.
 */
function downsampleRouteCoords(coordsLngLat: number[][], maxPoints = 250): number[][] {
    if (coordsLngLat.length <= maxPoints) return coordsLngLat;

    // First pass: drop redundant vertices closer than 15m to the previous kept vertex
    const thinned: number[][] = [coordsLngLat[0]];
    for (let i = 1; i < coordsLngLat.length - 1; i++) {
        const prev = thinned[thinned.length - 1];
        const curr = coordsLngLat[i];
        if (calculateHaversineDistanceMeters(prev[1], prev[0], curr[1], curr[0]) >= 15) {
            thinned.push(curr);
        }
    }
    thinned.push(coordsLngLat[coordsLngLat.length - 1]);
    if (thinned.length <= maxPoints) return thinned;

    const sampled: number[][] = [];
    for (let i = 0; i < maxPoints; i++) {
        const idx = Math.min(
            thinned.length - 1,
            Math.round((i / (maxPoints - 1)) * (thinned.length - 1))
        );
        sampled.push(thinned[idx]);
    }
    return sampled;
}

/**
 * Projects a point onto a route polyline ([lng, lat][]) to determine lateral offset
 * from the route centerline and approximate distance traveled from route start.
 */
function projectPointOntoRoute(
    lat: number,
    lon: number,
    coordsLngLat: number[][]
): { distanceToRouteMeters: number; distanceAlongRouteMeters: number } {
    let bestDist = Infinity;
    let bestAlong = 0;
    let cumulative = 0;

    for (let i = 0; i < coordsLngLat.length - 1; i++) {
        const [lng1, lat1] = coordsLngLat[i];
        const [lng2, lat2] = coordsLngLat[i + 1];
        const segLen = calculateHaversineDistanceMeters(lat1, lng1, lat2, lng2);

        const cosLat = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
        const ax = lng1 * cosLat, ay = lat1;
        const bx = lng2 * cosLat, by = lat2;
        const px = lon * cosLat, py = lat;
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;

        const projLat = lat1 + t * (lat2 - lat1);
        const projLng = lng1 + t * (lng2 - lng1);
        const dist = calculateHaversineDistanceMeters(lat, lon, projLat, projLng);

        if (dist < bestDist) {
            bestDist = dist;
            bestAlong = cumulative + t * segLen;
        }
        cumulative += segLen;
    }

    return {
        distanceToRouteMeters: Math.round(bestDist * 10) / 10,
        distanceAlongRouteMeters: Math.round(bestAlong * 10) / 10
    };
}

function classifyTrafficControlElement(
    element: any,
    includeCrossings: boolean
): 'traffic_signal' | 'stop_sign' | null {
    const tags = element?.tags;
    if (!tags) return null;
    if (tags.highway === 'traffic_signals') return 'traffic_signal';
    if (tags.highway === 'stop') return 'stop_sign';
    if (
        includeCrossings &&
        tags.highway === 'crossing' &&
        (tags.crossing === 'traffic_signals' || tags['crossing:signals'] === 'yes')
    ) {
        return 'traffic_signal';
    }
    return null;
}

function isPointInPolygonRing(lat: number, lng: number, ringLatLng: number[][]): boolean {
    let inside = false;
    for (let i = 0, j = ringLatLng.length - 1; i < ringLatLng.length; j = i++) {
        const yi = ringLatLng[i][0], xi = ringLatLng[i][1];
        const yj = ringLatLng[j][0], xj = ringLatLng[j][1];
        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function isPointInPolygonWithHoles(lat: number, lng: number, polyRingsLatLng: number[][][]): boolean {
    if (!polyRingsLatLng || polyRingsLatLng.length === 0) return false;
    if (!isPointInPolygonRing(lat, lng, polyRingsLatLng[0])) return false;
    for (let h = 1; h < polyRingsLatLng.length; h++) {
        if (isPointInPolygonRing(lat, lng, polyRingsLatLng[h])) {
            return false; // Point lies inside an interior hole
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Overpass & Taginfo Bounded LRU Caches + Shared Overpass Executor
// ---------------------------------------------------------------------------

const OVERPASS_CACHE = new Map<string, { timestamp: number; data: any; endpoint: string }>();
const OVERPASS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const OVERPASS_CACHE_MAX = 100;
const OVERPASS_INFLIGHT = new Map<string, Promise<OverpassExecutionResult>>();
let preferredOverpassEndpoint: string | null = null;

const TAGINFO_CACHE = new Map<string, { timestamp: number; text: string; tags: string[] }>();
const TAGINFO_CACHE_MAX = 200;
const TAGINFO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const ROUTE_CACHE = new Map<string, { timestamp: number; data: any; provider: string }>();
const ROUTE_CACHE_MAX = 200;
const ROUTE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const ELEVATION_CACHE = new Map<string, { timestamp: number; elevations: number[] }>();
const ELEVATION_CACHE_MAX = 500;
const ELEVATION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchElevationsBatch(
    points: Array<{ lat: number; lng: number }>
): Promise<{
    elevations: number[];
    cached: boolean;
    cacheAgeMs: number;
    dataTimestamp: string;
    elevationBase: string;
}> {
    const latsParam = points.map(p => p.lat.toFixed(6)).join(",");
    const lngsParam = points.map(p => p.lng.toFixed(6)).join(",");
    const elevationBase = (process.env.ELEVATION_API_URL || "https://api.open-meteo.com/v1/elevation").replace(/\/+$/, "");
    const url = `${elevationBase}?latitude=${latsParam}&longitude=${lngsParam}`;
    const cacheKey = `${elevationBase}|${latsParam}|${lngsParam}`;

    const cachedEntry = ELEVATION_CACHE.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp < ELEVATION_CACHE_TTL_MS)) {
        return {
            elevations: cachedEntry.elevations,
            cached: true,
            cacheAgeMs: Date.now() - cachedEntry.timestamp,
            dataTimestamp: new Date(cachedEntry.timestamp).toISOString(),
            elevationBase
        };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': APP_USER_AGENT,
                'Accept': 'application/json'
            },
            signal: controller.signal
        });
        if (!res.ok) {
            throw new Error(`Open-Meteo Elevation API returned status ${res.status}`);
        }
        const json = await res.json();
        if (!Array.isArray(json.elevation)) {
            throw new Error(`Unexpected response from elevation API`);
        }
        const now = Date.now();
        setBoundedCache(ELEVATION_CACHE, ELEVATION_CACHE_MAX, cacheKey, { timestamp: now, elevations: json.elevation });
        return {
            elevations: json.elevation,
            cached: false,
            cacheAgeMs: 0,
            dataTimestamp: new Date(now).toISOString(),
            elevationBase
        };
    } finally {
        clearTimeout(timeout);
    }
}

function summarizeElevationSamples<T extends { label: string; lat: number; lng: number; elevation_meters: number }>(
    samples: T[],
    isFiniteSample: boolean
) {
    let minSample = samples[0];
    let maxSample = samples[0];
    let sum = 0;
    for (const s of samples) {
        if (s.elevation_meters < minSample.elevation_meters) minSample = s;
        if (s.elevation_meters > maxSample.elevation_meters) maxSample = s;
        sum += s.elevation_meters;
    }
    const meanElevation = roundTo(sum / samples.length, 1);
    const reliefMeters = roundTo(maxSample.elevation_meters - minSample.elevation_meters, 1);

    return {
        minSample,
        maxSample,
        sampleStats: {
            min_elevation_meters: minSample.elevation_meters,
            max_elevation_meters: maxSample.elevation_meters,
            mean_elevation_meters: meanElevation,
            sample_relief_meters: reliefMeters,
            lowest_sample: minSample,
            highest_sample: maxSample,
            is_finite_sample: isFiniteSample
        }
    };
}

interface OverpassExecutionResult {
    data: any;
    provenance: ProvenanceMetadata;
    remarkWarning?: string;
}

async function executeOverpassQuery(overpassQuery: string, timeoutSec: number): Promise<OverpassExecutionResult> {
    const cached = OVERPASS_CACHE.get(overpassQuery);
    if (cached && (Date.now() - cached.timestamp < OVERPASS_CACHE_TTL_MS)) {
        log('info', 'Overpass cache hit');
        const osmTimestamp = cached.data.osm3s?.timestamp_osm_base || new Date(cached.timestamp).toISOString();
        return {
            data: cached.data,
            provenance: {
                provider: `overpass (${cached.endpoint})`,
                attribution: OSM_ATTRIBUTION,
                data_timestamp: osmTimestamp,
                cached: true,
                cache_age_ms: Date.now() - cached.timestamp
            }
        };
    }

    const existingInflight = OVERPASS_INFLIGHT.get(overpassQuery);
    if (existingInflight) {
        log('info', 'Joining in-flight Overpass query');
        return existingInflight;
    }

    const promise = executeOverpassQueryUncached(overpassQuery, timeoutSec).finally(() => {
        OVERPASS_INFLIGHT.delete(overpassQuery);
    });
    OVERPASS_INFLIGHT.set(overpassQuery, promise);
    return promise;
}

async function executeOverpassQueryUncached(overpassQuery: string, timeoutSec: number): Promise<OverpassExecutionResult> {
    // Distinct independent operators:
    // 1. overpass-api.de (FOSSGIS / main German instance)
    // 2. overpass.private.coffee (Private.coffee — successor to Kumi Systems)
    // 3. overpass.openstreetmap.fr (OSM France instance)
    const defaultEndpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://overpass.openstreetmap.fr/api/interpreter"
    ];
    const customEndpoints = process.env.OVERPASS_API_URL
        ? process.env.OVERPASS_API_URL.split(",").map(s => s.trim()).filter(Boolean)
        : [];
    const baseEndpoints = process.env.OVERPASS_DISABLE_PUBLIC_FALLBACK === "1" && customEndpoints.length > 0
        ? customEndpoints
        : [...customEndpoints, ...defaultEndpoints];
    const endpoints = preferredOverpassEndpoint
        ? [preferredOverpassEndpoint, ...baseEndpoints.filter(e => e !== preferredOverpassEndpoint)]
        : baseEndpoints;

    const params = new URLSearchParams();
    params.append('data', overpassQuery);
    const bodyStr = params.toString();

    const clientTimeoutMs = endpoints.length > 1
        ? Math.min((timeoutSec + 5) * 1000, 18000)
        : (timeoutSec + 5) * 1000;

    // Adaptive hedging: start endpoint[0] immediately; start each subsequent endpoint
    // either after 1200ms OR immediately if the previous endpoint fails early (e.g. HTTP 502/504).
    const controllers: AbortController[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const startCallbacks: Array<() => void> = [];
    let settled = false;

    const queryEndpoint = (endpoint: string, idx: number): Promise<{ data: any; endpoint: string }> =>
        new Promise((resolve, reject) => {
            let started = false;
            const startRequest = async () => {
                if (started) return;
                started = true;
                if (settled) {
                    reject(new Error("Cancelled"));
                    return;
                }
                const controller = new AbortController();
                controllers.push(controller);
                const timeout = setTimeout(() => controller.abort(), clientTimeoutMs);
                try {
                    log('info', `Executing Overpass query at ${endpoint}`);
                    const response = await fetch(endpoint, {
                        method: "POST",
                        body: bodyStr,
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept': 'application/json',
                            'User-Agent': APP_USER_AGENT
                        },
                        signal: controller.signal
                    });
                    if (!response.ok) {
                        throw new Error(`Overpass API returned status: ${response.status} ${response.statusText}`);
                    }
                    const candidate = await response.json();
                    // Detect Overpass runtime errors (e.g. query timeout, out of memory) returned inside HTTP 200 JSON
                    if (typeof candidate?.remark === 'string' && /runtime error|timed out|out of memory|error/i.test(candidate.remark)) {
                        throw new Error(`Overpass runtime error: ${candidate.remark}`);
                    }
                    if (!candidate || !Array.isArray(candidate.elements)) {
                        throw new Error(`Overpass response missing 'elements' array`);
                    }
                    resolve({ data: candidate, endpoint });
                } catch (err: any) {
                    if (!settled) {
                        log('warn', `Overpass API failed at ${endpoint}`, { error: err.message });
                        // Immediately wake the next endpoint in line if it hasn't started yet
                        if (startCallbacks[idx + 1]) {
                            startCallbacks[idx + 1]();
                        }
                    }
                    reject(err);
                } finally {
                    clearTimeout(timeout);
                }
            };

            startCallbacks[idx] = startRequest;
            if (idx === 0) {
                startRequest();
            } else {
                const t = setTimeout(startRequest, idx * 1200);
                timers.push(t);
            }
        });

    let data: any = null;
    let usedEndpoint = endpoints[0];

    try {
        const winner = await Promise.any(
            endpoints.map((ep, idx) => queryEndpoint(ep, idx))
        );
        settled = true;
        data = winner.data;
        usedEndpoint = winner.endpoint;
        preferredOverpassEndpoint = usedEndpoint;
    } catch (aggErr: any) {
        settled = true;
        const errors: Error[] = Array.isArray(aggErr?.errors) ? aggErr.errors : [aggErr];
        const nonAbort = errors.find(e => e && e.name !== 'AbortError' && e.message !== 'Cancelled');
        if (!nonAbort && errors.some(e => e?.name === 'AbortError')) {
            throw new Error(`Overpass API request timed out on all endpoints after ${clientTimeoutMs / 1000}s. The query or area may be too large.`);
        }
        const errMsg = (nonAbort || errors[0])?.message || "Unknown Overpass error";
        throw new Error(`Overpass query failed on all endpoints: ${errMsg}`);
    } finally {
        settled = true;
        for (const t of timers) clearTimeout(t);
        for (const c of controllers) {
            try { c.abort(); } catch { /* ignore */ }
        }
    }

    const now = Date.now();
    if (OVERPASS_CACHE.size >= OVERPASS_CACHE_MAX) {
        const oldestKey = OVERPASS_CACHE.keys().next().value;
        if (oldestKey) OVERPASS_CACHE.delete(oldestKey);
    }
    OVERPASS_CACHE.set(overpassQuery, { timestamp: now, data, endpoint: usedEndpoint });

    const osmTimestamp = data.osm3s?.timestamp_osm_base || new Date(now).toISOString();
    return {
        data,
        provenance: {
            provider: `overpass (${usedEndpoint})`,
            attribution: OSM_ATTRIBUTION,
            data_timestamp: osmTimestamp,
            cached: false,
            cache_age_ms: 0
        },
        remarkWarning: typeof data.remark === 'string' ? sanitizeExternalText(data.remark, 300) : undefined
    };
}

async function getTaginfoSuggestions(keyword: string): Promise<{ text: string; tags: string[]; cached: boolean; cache_age_ms: number; timestamp: string; warning?: string }> {
    const cacheKey = keyword.toLowerCase().trim();
    const cached = TAGINFO_CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < TAGINFO_CACHE_TTL_MS)) {
        return {
            text: cached.text,
            tags: cached.tags,
            cached: true,
            cache_age_ms: Date.now() - cached.timestamp,
            timestamp: new Date(cached.timestamp).toISOString()
        };
    }

    const MAINSTREAM_KEYS = new Set([
        "amenity", "shop", "leisure", "tourism", "natural", "highway",
        "office", "healthcare", "craft", "sport", "landuse", "building",
        "historic", "emergency", "railway", "aeroway", "public_transport",
        "man_made", "Waterway", "waterway", "barrier", "power", "place"
    ]);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        let items: Array<{ key: string; value?: string; count_all?: number }> = [];

        if (MAINSTREAM_KEYS.has(cacheKey)) {
            // User asked for a top-level OSM key (e.g. "amenity", "shop", "tourism") -> fetch its most popular values
            const keyUrl = `https://taginfo.openstreetmap.org/api/4/keys/values?key=${encodeURIComponent(cacheKey)}&sortname=count_all&sortorder=desc&rp=15`;
            const res = await fetch(keyUrl, { headers: { 'User-Agent': APP_USER_AGENT }, signal: controller.signal });
            if (res.ok) {
                const json = await res.json();
                items = (json.data || []).map((d: any) => ({ key: cacheKey, value: d.value, count_all: d.count }));
            }
        } else {
            // Query both by_value (sorted by real-world count_all) and by_keyword (matches natural-language wiki terms)
            const valUrl = `https://taginfo.openstreetmap.org/api/4/search/by_value?query=${encodeURIComponent(keyword)}&sortname=count_all&sortorder=desc&rp=25`;
            const kwUrl = `https://taginfo.openstreetmap.org/api/4/search/by_keyword?query=${encodeURIComponent(keyword)}&rp=25`;
            const [valRes, kwRes] = await Promise.allSettled([
                fetch(valUrl, { headers: { 'User-Agent': APP_USER_AGENT }, signal: controller.signal }),
                fetch(kwUrl, { headers: { 'User-Agent': APP_USER_AGENT }, signal: controller.signal })
            ]);
            if (valRes.status === "fulfilled" && valRes.value.ok) {
                const json = await valRes.value.json();
                items.push(...(json.data || []));
            }
            if (kwRes.status === "fulfilled" && kwRes.value.ok) {
                const json = await kwRes.value.json();
                items.push(...(json.data || []));
            }
        }

        const seenSelectors = new Set<string>();
        const filtered = items
            .filter((item: any) => {
                if (!item.key || !MAINSTREAM_KEYS.has(item.key)) return false;
                if (item.count_all !== undefined && item.count_all < 1000) return false;
                const valStr = item.value ? `="${item.value}"` : '';
                const selector = `nwr["${item.key}"${valStr}]`;
                if (seenSelectors.has(selector)) return false;
                seenSelectors.add(selector);
                return true;
            })
            .sort((a: any, b: any) => (b.count_all ?? 0) - (a.count_all ?? 0))
            .slice(0, 10);

        const now = Date.now();
        if (filtered.length === 0) {
            const text = `No mainstream OSM tags found for '${keyword}' with usage count > 1,000.\nTry searching standard keys like amenity, shop, leisure, or tourism.`;
            return {
                text,
                tags: [],
                cached: false,
                cache_age_ms: 0,
                timestamp: new Date(now).toISOString()
            };
        }

        const tags: string[] = [];
        const lines = filtered.map((item: any) => {
            const valStr = item.value ? `="${item.value}"` : '';
            const selector = `nwr["${item.key}"${valStr}]`;
            tags.push(selector);
            const countInfo = item.count_all !== undefined ? ` (${item.count_all.toLocaleString()} objects)` : '';
            return `- ${selector}${countInfo}`;
        });

        const text = `Taginfo OSM Tag Recommendations for '${keyword}':\n\n${lines.join('\n')}`;
        setBoundedCache(TAGINFO_CACHE, TAGINFO_CACHE_MAX, cacheKey, { timestamp: now, text, tags });
        return {
            text,
            tags,
            cached: false,
            cache_age_ms: 0,
            timestamp: new Date(now).toISOString()
        };
    } catch (err: any) {
        return {
            text: `Taginfo lookup failed for '${keyword}': ${err.message}`,
            tags: [],
            cached: false,
            cache_age_ms: 0,
            timestamp: new Date().toISOString(),
            warning: `Taginfo lookup failed: ${err.message}`
        };
    } finally {
        clearTimeout(timeout);
    }
}

function buildShareUrlCircleWithMarkers(
    center: { lat: number; lng: number },
    radiusMeters: number,
    elements: Array<{ coordinates: { lat: number; lon: number }; name: string }>
): string {
    const circlePart = `C:${center.lat.toFixed(6)},${center.lng.toFixed(6)},${radiusMeters.toFixed(2)}`;
    const MAX_MARKERS = 30;
    const markerParts = elements
        .filter(e => e.coordinates?.lat !== undefined && e.coordinates?.lon !== undefined)
        .slice(0, MAX_MARKERS)
        .map(e => {
            let name = e.name || 'Point';
            if (name.length > 30) name = name.slice(0, 27) + '...';
            return `${e.coordinates.lat.toFixed(6)},${e.coordinates.lon.toFixed(6)},${encodeURIComponent(name)}`;
        });
    return `https://vibhorsingh.com/boundingbox/#${[circlePart, ...markerParts].join('|')}`;
}

async function resolveRouteEndpoint(
    input: string,
    warnings: string[]
): Promise<{ lat: number; lng: number; label: string }> {
    const coordMatch = input.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
        const p0 = parseFloat(coordMatch[1]);
        const p1 = parseFloat(coordMatch[2]);
        if (validateBBox(p0, p1, p0, p1)) {
            return { lat: p0, lng: p1, label: `(${p0.toFixed(5)}, ${p1.toFixed(5)})` };
        } else if (validateBBox(p1, p0, p1, p0)) {
            warnings.push(`Endpoint '${input}' interpreted as lng,lat -> converted to lat=${p1}, lng=${p0}.`);
            return { lat: p1, lng: p0, label: `(${p1.toFixed(5)}, ${p0.toFixed(5)})` };
        }
    }
    const geo = await geocodeLocation(input);
    return { lat: geo.center.lat, lng: geo.center.lng, label: geo.matched_place };
}

interface RouteEndpoint {
    lat: number;
    lng: number;
    label: string;
}

function summarizeOsrmRoute(
    routeObj: any,
    start: RouteEndpoint,
    end: RouteEndpoint,
    waypoints: RouteEndpoint[],
    straightLineMeters: number,
    returnSteps: boolean
) {
    const distanceMeters = Math.round(routeObj.distance * 10) / 10;
    const durationSeconds = Math.round(routeObj.duration);
    const durationMinutes = Math.round((durationSeconds / 60) * 10) / 10;
    const detourFactor = straightLineMeters > 0 ? Math.round((distanceMeters / straightLineMeters) * 100) / 100 : 1;

    const geomCoords: number[][] = (routeObj.geometry?.coordinates && routeObj.geometry.coordinates.length >= 2)
        ? routeObj.geometry.coordinates
        : [[start.lng, start.lat], ...waypoints.map(w => [w.lng, w.lat]), [end.lng, end.lat]];
    const routeGeometry = {
        type: "LineString" as const,
        coordinates: geomCoords
    };
    const lats = geomCoords.map(c => c[1]);
    const lngs = geomCoords.map(c => c[0]);
    const routeBBox = ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));

    const midIdx = Math.floor(geomCoords.length / 2);
    const midPt = geomCoords[midIdx] || [(start.lng + end.lng) / 2, (start.lat + end.lat) / 2];

    const markers = [
        { coordinates: { lat: start.lat, lon: start.lng }, name: `Origin: ${start.label}` },
        ...waypoints.map((w, idx) => ({
            coordinates: { lat: w.lat, lon: w.lng },
            name: `WP ${idx + 1}: ${w.label}`
        })),
        ...(waypoints.length === 0
            ? [{ coordinates: { lat: midPt[1], lon: midPt[0] }, name: `Route (${(distanceMeters / 1000).toFixed(1)}km, ${durationMinutes}min)` }]
            : []),
        { coordinates: { lat: end.lat, lon: end.lng }, name: `Dest: ${end.label}` }
    ];
    const shareUrl = buildShareUrlWithRoute(routeBBox, geomCoords, markers);

    const steps = returnSteps && Array.isArray(routeObj.legs)
        ? routeObj.legs.flatMap((leg: any) => leg.steps || []).map((s: any) => ({
            name: sanitizeExternalText(s.name, 200) || "unnamed road",
            distance_meters: Math.round(s.distance),
            duration_seconds: Math.round(s.duration),
            ...(s.maneuver?.type ? { maneuver: sanitizeExternalText(`${s.maneuver.type}${s.maneuver.modifier ? ' ' + s.maneuver.modifier : ''}`, 80) } : {}),
            ...(Array.isArray(s.maneuver?.location) && s.maneuver.location.length >= 2
                ? { location: { lat: s.maneuver.location[1], lng: s.maneuver.location[0] } }
                : {})
        }))
        : undefined;

    return {
        routeObj,
        geomCoords,
        routeGeometry,
        routeBBox,
        distanceMeters,
        distanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
        durationSeconds,
        durationMinutes,
        detourFactor,
        steps,
        shareUrl
    };
}

async function fetchOsrmRoute(
    originInput: string,
    destInput: string,
    profile: "driving" | "walking" | "cycling",
    returnSteps: boolean,
    warnings: string[],
    options?: { waypoints?: string[]; alternatives?: boolean }
) {
    const rawWaypoints = options?.waypoints || [];
    if (rawWaypoints.length > 20) {
        throw new Error(`Too many waypoints (${rawWaypoints.length}); maximum allowed is 20.`);
    }

    const start = await resolveRouteEndpoint(originInput, warnings);
    const resolvedWaypoints: RouteEndpoint[] = [];
    for (const wp of rawWaypoints) {
        const trimmed = typeof wp === 'string' ? wp.trim() : '';
        if (!trimmed) {
            throw new Error(`Each waypoint must be a non-empty 'lat,lng' or place name string.`);
        }
        resolvedWaypoints.push(await resolveRouteEndpoint(trimmed, warnings));
    }
    const end = await resolveRouteEndpoint(destInput, warnings);

    const requestAlternatives = options?.alternatives === true && resolvedWaypoints.length === 0;
    if (options?.alternatives === true && resolvedWaypoints.length > 0) {
        warnings.push("OSRM does not support alternative routes when waypoints are provided; returning the waypoint route only.");
    }

    const straightLineMeters = calculateHaversineDistanceMeters(start.lat, start.lng, end.lat, end.lng);
    const bearing = calculateBearingDegrees(start.lat, start.lng, end.lat, end.lng);

    // OSRM public servers (FOSSGIS Germany regional profiles + OSRM main demo)
    const osrmProfileMap: Record<string, { fossgis: string; main: string }> = {
        driving: { fossgis: "routed-car/route/v1/driving", main: "route/v1/driving" },
        walking: { fossgis: "routed-foot/route/v1/driving", main: "route/v1/foot" },
        cycling: { fossgis: "routed-bike/route/v1/driving", main: "route/v1/bike" }
    };
    const prof = osrmProfileMap[profile] || osrmProfileMap.driving;
    const allStops = [start, ...resolvedWaypoints, end];
    const coordsPair = allStops.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const queryParams = `?overview=full&geometries=geojson&steps=${returnSteps ? 'true' : 'false'}${requestAlternatives ? '&alternatives=3' : ''}`;
    const routeCacheKey = `${profile}:${coordsPair}:${returnSteps}:${requestAlternatives}`;

    let rawRoutes: any[] | null = null;
    let usedProvider = "";
    let cachedRoute = false;
    let cacheAgeMs = 0;
    let dataTimestamp = new Date().toISOString();

    const cachedEntry = ROUTE_CACHE.get(routeCacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp < ROUTE_CACHE_TTL_MS)) {
        rawRoutes = Array.isArray(cachedEntry.data) ? cachedEntry.data : [cachedEntry.data];
        usedProvider = cachedEntry.provider;
        cachedRoute = true;
        cacheAgeMs = Date.now() - cachedEntry.timestamp;
        dataTimestamp = new Date(cachedEntry.timestamp).toISOString();
    } else {
        const routingUrls: Array<{ url: string; provider: string }> = [
            {
                url: `https://routing.openstreetmap.de/${prof.fossgis}/${coordsPair}${queryParams}`,
                provider: "fossgis-osrm (https://routing.openstreetmap.de)"
            },
            {
                url: `https://router.project-osrm.org/${prof.main}/${coordsPair}${queryParams}`,
                provider: "project-osrm-demo (https://router.project-osrm.org)"
            }
        ];
        if (process.env.OSRM_API_URL) {
            const customBase = process.env.OSRM_API_URL.replace(/\/+$/, "");
            routingUrls.unshift({
                url: `${customBase}/${prof.main}/${coordsPair}${queryParams}`,
                provider: `custom-osrm (${customBase})`
            });
        }

        let lastRouteErr: Error | null = null;

        for (const candidate of routingUrls) {
            await routingRateLimit();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            try {
                const res = await fetch(candidate.url, {
                    headers: {
                        'User-Agent': APP_USER_AGENT,
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });
                if (!res.ok) throw new Error(`Status ${res.status}`);
                const json = await res.json();
                if (json.code === "Ok" && Array.isArray(json.routes) && json.routes.length > 0) {
                    rawRoutes = json.routes;
                    usedProvider = candidate.provider;
                    const now = Date.now();
                    dataTimestamp = new Date(now).toISOString();
                    setBoundedCache(ROUTE_CACHE, ROUTE_CACHE_MAX, routeCacheKey, { timestamp: now, data: rawRoutes, provider: usedProvider });
                    break;
                }
                throw new Error(json.message || `Routing returned code ${json.code}`);
            } catch (err: any) {
                lastRouteErr = err;
                log('warn', `OSRM routing failed at ${candidate.provider}`, { error: err.message });
            } finally {
                clearTimeout(timeout);
            }
        }

        if (!rawRoutes || rawRoutes.length === 0) {
            throw new Error(`Route calculation failed on all configured OSRM servers: ${lastRouteErr?.message}`);
        }
    }

    const summarized = rawRoutes.map(r =>
        summarizeOsrmRoute(r, start, end, resolvedWaypoints, straightLineMeters, returnSteps)
    );
    const primary = summarized[0];
    const alternatives = summarized.slice(1);

    const provenance: ProvenanceMetadata = {
        provider: usedProvider,
        attribution: OSM_ATTRIBUTION,
        data_timestamp: dataTimestamp,
        cached: cachedRoute,
        cache_age_ms: cacheAgeMs,
        usage_policy: "https://routing.openstreetmap.de/about.html (Max 1 req/s, no heavy/bulk usage; configure OSRM_API_URL for production workloads)"
    };

    return {
        profile,
        start,
        end,
        waypoints: resolvedWaypoints,
        routeData: primary.routeObj,
        geomCoords: primary.geomCoords,
        routeGeometry: primary.routeGeometry,
        routeBBox: primary.routeBBox,
        distanceMeters: primary.distanceMeters,
        distanceKm: primary.distanceKm,
        durationSeconds: primary.durationSeconds,
        durationMinutes: primary.durationMinutes,
        straightLineMeters,
        detourFactor: primary.detourFactor,
        steps: primary.steps,
        shareUrl: primary.shareUrl,
        alternatives,
        bearing,
        provenance
    };
}

// ---------------------------------------------------------------------------
// Overture Maps Places Helpers (STAC + Direct GeoParquet Range Reader)
// ---------------------------------------------------------------------------

const OVERTURE_STAC_URL = process.env.OVERTURE_STAC_URL || "https://stac.overturemaps.org/catalog.json";
const OVERTURE_STORAGE_PROVIDER: "aws" | "azure" =
    (process.env.OVERTURE_STORAGE_PROVIDER || "aws").toLowerCase() === "azure" ? "azure" : "aws";
const OVERTURE_FETCH_TIMEOUT_MS = Math.max(FETCH_TIMEOUT_MS, 15_000);
const OVERTURE_CATALOG_TTL_MS = 60 * 60 * 1000;     // 1 hour
const OVERTURE_META_TTL_MS = 6 * 60 * 60 * 1000;    // 6 hours
const OVERTURE_QUERY_TTL_MS = 15 * 60 * 1000;       // 15 minutes
const OVERTURE_MAX_INDEX_BYTES = 20 * 1024 * 1024;  // 20 MB cap for collections.parquet

const OVERTURE_ATTRIBUTION =
    "© Overture Maps Foundation (https://overturemaps.org); Places data © Overture Maps contributors (Meta, Microsoft, Foursquare, and others)";
const OVERTURE_USAGE_POLICY =
    "Overture Maps Places is licensed under CDLA-Permissive-2.0. Queries read GeoParquet partitions directly via HTTP range requests without an API key.";

interface OverturePlaceFile {
    id: string;
    bbox: { xmin: number; ymin: number; xmax: number; ymax: number };
    awsHref?: string;
    azureHref?: string;
}

interface OverturePlaceResult {
    id: string;
    name: string | null;
    basic_category: string | null;
    primary_category: string | null;
    alternate_categories: string[];
    category_hierarchy: string[];
    confidence: number | null;
    operating_status: string | null;
    brand: {
        name: string | null;
        wikidata: string | null;
    } | null;
    coordinates: { lat: number; lon: number };
    distance_meters: number;
    address: {
        freeform: string | null;
        locality: string | null;
        postcode: string | null;
        region: string | null;
        country: string | null;
    } | null;
    websites: string[];
    phones: string[];
    emails: string[];
    socials: string[];
    sources: string[];
    version: number | null;
}

interface OvertureCatalogEntry {
    release: string;
    releaseCatalogUrl: string;
    cachedAt: number;
}

interface OvertureIndexEntry {
    release: string;
    files: OverturePlaceFile[];
    cachedAt: number;
}

interface OvertureMetaEntry {
    metadata: FileMetaData;
    byteLength: number;
    cachedAt: number;
}

interface OvertureQueryCacheEntry {
    release: string;
    places: OverturePlaceResult[];
    scannedRowGroups: number;
    scannedFiles: number;
    cachedAt: number;
}

const overtureCatalogCache = new Map<string, OvertureCatalogEntry>();
const overtureCatalogInflight = new Map<string, Promise<OvertureCatalogEntry>>();
const overtureIndexCache = new Map<string, OvertureIndexEntry>();
const overtureIndexInflight = new Map<string, Promise<OvertureIndexEntry>>();
const overtureMetaCache = new Map<string, OvertureMetaEntry>();
const overtureMetaInflight = new Map<string, Promise<OvertureMetaEntry>>();
const overtureQueryCache = new Map<string, OvertureQueryCacheEntry>();

function getFreshCacheEntry<K, V extends { cachedAt: number }>(
    cache: Map<K, V>,
    key: K,
    ttlMs: number
): V | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt >= ttlMs) {
        cache.delete(key);
        return null;
    }
    return entry;
}

const fetchWithOvertureHeaders: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("User-Agent")) {
        headers.set("User-Agent", APP_USER_AGENT);
    }
    const timeoutSignal = AbortSignal.timeout(OVERTURE_FETCH_TIMEOUT_MS);
    let signal: AbortSignal = timeoutSignal;
    let cleanupListener: (() => void) | undefined;
    if (init?.signal) {
        const controller = new AbortController();
        const abortFromInit = () => controller.abort(init.signal?.reason);
        const abortFromTimeout = () => controller.abort(timeoutSignal.reason);
        if (init.signal.aborted) {
            controller.abort(init.signal.reason);
        } else {
            init.signal.addEventListener("abort", abortFromInit, { once: true });
            timeoutSignal.addEventListener("abort", abortFromTimeout, { once: true });
            cleanupListener = () => {
                init.signal?.removeEventListener("abort", abortFromInit);
                timeoutSignal.removeEventListener("abort", abortFromTimeout);
            };
        }
        signal = controller.signal;
    }
    try {
        return await fetch(input, { ...init, headers, signal });
    } finally {
        cleanupListener?.();
    }
};

function extractOvertureReleaseName(catalogUrl: string, fallback?: string): string {
    const pathname = new URL(catalogUrl).pathname;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length >= 2 && segments[segments.length - 1] === "catalog.json") {
        return segments[segments.length - 2];
    }
    if (segments.length >= 1) {
        return segments[segments.length - 1].replace(/\.json$/i, "");
    }
    return fallback || "unknown";
}

async function getOvertureCatalog(stacUrl: string = OVERTURE_STAC_URL): Promise<{ release: string; releaseCatalogUrl: string; cached: boolean }> {
    const cached = getFreshCacheEntry(overtureCatalogCache, stacUrl, OVERTURE_CATALOG_TTL_MS);
    if (cached) {
        return { release: cached.release, releaseCatalogUrl: cached.releaseCatalogUrl, cached: true };
    }
    const inflight = overtureCatalogInflight.get(stacUrl);
    if (inflight) {
        const res = await inflight;
        return { release: res.release, releaseCatalogUrl: res.releaseCatalogUrl, cached: false };
    }

    const promise = (async (): Promise<OvertureCatalogEntry> => {
        const resp = await fetchWithOvertureHeaders(stacUrl, { headers: { Accept: "application/json" } });
        if (!resp.ok) {
            throw new Error(`Overture STAC catalog HTTP ${resp.status} ${resp.statusText}`);
        }
        const catalog = (await resp.json()) as {
            latest?: unknown;
            links?: Array<{ rel?: string; href?: string }>;
        };
        const latestTag = typeof catalog.latest === "string" ? catalog.latest : undefined;
        const childLinks = (catalog.links || []).filter(
            (l): l is { rel: string; href: string } => l?.rel === "child" && typeof l?.href === "string"
        );

        let selectedRelease = latestTag || "unknown";
        let releaseCatalogUrl = stacUrl;
        if (childLinks.length > 0) {
            const candidates = childLinks.map((link) => {
                const url = assertSafeHttpUrl(link.href, stacUrl);
                return { release: extractOvertureReleaseName(url, latestTag), url };
            });
            const exactLatest = latestTag ? candidates.find((c) => c.release === latestTag) : undefined;
            if (exactLatest) {
                selectedRelease = exactLatest.release;
                releaseCatalogUrl = exactLatest.url;
            } else {
                const dateReleases = candidates
                    .filter((c) => /^\d{4}-\d{2}-\d{2}/.test(c.release))
                    .sort((a, b) => a.release.localeCompare(b.release));
                const picked = dateReleases.length > 0 ? dateReleases[dateReleases.length - 1] : candidates[candidates.length - 1];
                selectedRelease = picked.release;
                releaseCatalogUrl = picked.url;
            }
        }

        const entry: OvertureCatalogEntry = {
            release: selectedRelease,
            releaseCatalogUrl,
            cachedAt: Date.now(),
        };
        setBoundedCache(overtureCatalogCache, 8, stacUrl, entry);
        return entry;
    })();

    overtureCatalogInflight.set(stacUrl, promise);
    try {
        const res = await promise;
        return { release: res.release, releaseCatalogUrl: res.releaseCatalogUrl, cached: false };
    } finally {
        overtureCatalogInflight.delete(stacUrl);
    }
}

async function fetchOvertureFilesViaCollectionJson(releaseDirUrl: string): Promise<OverturePlaceFile[]> {
    const collectionUrl = new URL("places/place/collection.json", releaseDirUrl).href;
    const colResp = await fetchWithOvertureHeaders(collectionUrl, { headers: { Accept: "application/json" } });
    if (!colResp.ok) {
        throw new Error(`Overture collection HTTP ${colResp.status} at ${collectionUrl}`);
    }
    const collection = (await colResp.json()) as { links?: Array<{ rel?: string; href?: string }> };
    const itemLinks = (collection.links || [])
        .filter((l): l is { rel: string; href: string } => l?.rel === "item" && typeof l?.href === "string")
        .slice(0, 500)
        .map((l) => assertSafeHttpUrl(l.href, collectionUrl));

    const files: OverturePlaceFile[] = [];
    for (let i = 0; i < itemLinks.length; i += 8) {
        const batch = itemLinks.slice(i, i + 8);
        const items = await Promise.all(
            batch.map(async (itemUrl) => {
                const r = await fetchWithOvertureHeaders(itemUrl, { headers: { Accept: "application/json" } });
                if (!r.ok) {
                    throw new Error(`Overture STAC item HTTP ${r.status} at ${itemUrl}`);
                }
                const item = (await r.json()) as {
                    id?: string;
                    bbox?: number[];
                    assets?: { aws?: { href?: string }; azure?: { href?: string } };
                };
                if (!Array.isArray(item.bbox) || item.bbox.length < 4) return null;
                const awsHref = item.assets?.aws?.href ? assertSafeHttpUrl(item.assets.aws.href, itemUrl) : undefined;
                const azureHref = item.assets?.azure?.href ? assertSafeHttpUrl(item.assets.azure.href, itemUrl) : undefined;
                if (!awsHref && !azureHref) return null;
                return {
                    id: String(item.id || itemUrl),
                    bbox: {
                        xmin: Number(item.bbox[0]),
                        ymin: Number(item.bbox[1]),
                        xmax: Number(item.bbox[2]),
                        ymax: Number(item.bbox[3]),
                    },
                    awsHref,
                    azureHref,
                } as OverturePlaceFile;
            })
        );
        for (const item of items) {
            if (item) files.push(item);
        }
    }
    return files;
}

async function getOverturePlaceFiles(
    release: string,
    releaseCatalogUrl: string
): Promise<{ files: OverturePlaceFile[]; cached: boolean }> {
    const cached = getFreshCacheEntry(overtureIndexCache, releaseCatalogUrl, OVERTURE_CATALOG_TTL_MS);
    if (cached) {
        return { files: cached.files, cached: true };
    }
    const inflight = overtureIndexInflight.get(releaseCatalogUrl);
    if (inflight) {
        const res = await inflight;
        return { files: res.files, cached: false };
    }

    const promise = (async (): Promise<OvertureIndexEntry> => {
        const releaseDirUrl = new URL("./", releaseCatalogUrl).href;
        const collectionsParquetUrl = new URL("collections.parquet", releaseDirUrl).href;
        let files: OverturePlaceFile[] | null = null;

        const parquetResp = await fetchWithOvertureHeaders(collectionsParquetUrl);
        if (parquetResp.ok) {
            const contentLength = Number(parquetResp.headers.get("content-length") || "0");
            if (contentLength > OVERTURE_MAX_INDEX_BYTES) {
                throw new Error(`Overture collections.parquet exceeded size cap (${contentLength} bytes)`);
            }
            const buf = await parquetResp.arrayBuffer();
            if (buf.byteLength > OVERTURE_MAX_INDEX_BYTES) {
                throw new Error(`Overture collections.parquet exceeded size cap (${buf.byteLength} bytes)`);
            }
            const asyncBuf: AsyncBuffer = {
                byteLength: buf.byteLength,
                slice: (start: number, end?: number) => buf.slice(start, end),
            };
            const metadata = await parquetMetadataAsync(asyncBuf);
            const availableCols = new Set(parquetSchema(metadata).children.map((c) => c.element.name));
            const desiredCols = ["collection", "id", "bbox", "assets"].filter((c) => availableCols.has(c));
            const rows = await parquetReadObjects({
                file: asyncBuf,
                metadata,
                compressors,
                columns: desiredCols,
            });
            files = [];
            for (const row of rows) {
                if (availableCols.has("collection") && row.collection !== "place") continue;
                const b = row.bbox;
                if (!b || typeof b.xmin !== "number" || typeof b.ymin !== "number" || typeof b.xmax !== "number" || typeof b.ymax !== "number") {
                    continue;
                }
                const awsHref = row.assets?.aws?.href ? assertSafeHttpUrl(String(row.assets.aws.href), collectionsParquetUrl) : undefined;
                const azureHref = row.assets?.azure?.href ? assertSafeHttpUrl(String(row.assets.azure.href), collectionsParquetUrl) : undefined;
                if (!awsHref && !azureHref) continue;
                files.push({
                    id: String(row.id || awsHref || azureHref),
                    bbox: { xmin: b.xmin, ymin: b.ymin, xmax: b.xmax, ymax: b.ymax },
                    awsHref,
                    azureHref,
                });
            }
        } else if (parquetResp.status !== 404) {
            log("warn", `Overture collections.parquet HTTP ${parquetResp.status}, attempting collection.json fallback`);
        }

        if (!files || files.length === 0) {
            files = await fetchOvertureFilesViaCollectionJson(releaseDirUrl);
        }
        if (files.length === 0) {
            throw new Error(`No Overture Places Parquet partition files found in release ${release}`);
        }

        const entry: OvertureIndexEntry = {
            release,
            files,
            cachedAt: Date.now(),
        };
        setBoundedCache(overtureIndexCache, 8, releaseCatalogUrl, entry);
        return entry;
    })();

    overtureIndexInflight.set(releaseCatalogUrl, promise);
    try {
        const res = await promise;
        return { files: res.files, cached: false };
    } finally {
        overtureIndexInflight.delete(releaseCatalogUrl);
    }
}

function getOrderedMirrorUrls(fileEntry: OverturePlaceFile): Array<{ provider: "aws" | "azure"; url: string }> {
    const mirrors: Array<{ provider: "aws" | "azure"; url: string }> = [];
    const first = OVERTURE_STORAGE_PROVIDER;
    const second = first === "aws" ? "azure" : "aws";
    const firstHref = first === "aws" ? fileEntry.awsHref : fileEntry.azureHref;
    const secondHref = second === "aws" ? fileEntry.awsHref : fileEntry.azureHref;
    if (firstHref) mirrors.push({ provider: first, url: firstHref });
    if (secondHref && secondHref !== firstHref) mirrors.push({ provider: second, url: secondHref });
    return mirrors;
}

async function openParquetFile(url: string): Promise<{ asyncBuf: AsyncBuffer; metadata: FileMetaData; metaCached: boolean }> {
    const cached = getFreshCacheEntry(overtureMetaCache, url, OVERTURE_META_TTL_MS);
    if (cached) {
        const asyncBuf = await asyncBufferFromUrl({
            url,
            byteLength: cached.byteLength,
            fetch: fetchWithOvertureHeaders,
        });
        return { asyncBuf, metadata: cached.metadata, metaCached: true };
    }

    const inflight = overtureMetaInflight.get(url);
    if (inflight) {
        const entry = await inflight;
        const asyncBuf = await asyncBufferFromUrl({
            url,
            byteLength: entry.byteLength,
            fetch: fetchWithOvertureHeaders,
        });
        return { asyncBuf, metadata: entry.metadata, metaCached: false };
    }

    const promise = (async (): Promise<OvertureMetaEntry> => {
        const asyncBuf = await asyncBufferFromUrl({ url, fetch: fetchWithOvertureHeaders });
        const metadata = await parquetMetadataAsync(asyncBuf);
        const entry: OvertureMetaEntry = {
            metadata,
            byteLength: asyncBuf.byteLength,
            cachedAt: Date.now(),
        };
        setBoundedCache(overtureMetaCache, 32, url, entry);
        return entry;
    })();

    overtureMetaInflight.set(url, promise);
    try {
        const entry = await promise;
        const asyncBuf = await asyncBufferFromUrl({
            url,
            byteLength: entry.byteLength,
            fetch: fetchWithOvertureHeaders,
        });
        return { asyncBuf, metadata: entry.metadata, metaCached: false };
    } finally {
        overtureMetaInflight.delete(url);
    }
}

function getColumnStatNumericRange(
    rowGroup: FileMetaData["row_groups"][number],
    columnPath: string
): { min?: number; max?: number } | null {
    for (const col of rowGroup.columns) {
        const path = col.meta_data?.path_in_schema?.join(".");
        if (path === columnPath) {
            const stats = col.meta_data?.statistics;
            if (!stats) return null;
            const rawMin = stats.min_value !== undefined ? stats.min_value : stats.min;
            const rawMax = stats.max_value !== undefined ? stats.max_value : stats.max;
            const min = typeof rawMin === "number" && Number.isFinite(rawMin) ? rawMin : undefined;
            const max = typeof rawMax === "number" && Number.isFinite(rawMax) ? rawMax : undefined;
            return { min, max };
        }
    }
    return null;
}

function countMatchingRowGroups(metadata: FileMetaData, searchBBox: BBox, minConfidence: number): number {
    let matches = 0;
    for (const rg of metadata.row_groups) {
        const xmin = getColumnStatNumericRange(rg, "bbox.xmin");
        if (xmin?.min !== undefined && xmin.min > searchBBox.lng2) continue;
        const xmax = getColumnStatNumericRange(rg, "bbox.xmax");
        if (xmax?.max !== undefined && xmax.max < searchBBox.lng1) continue;
        const ymin = getColumnStatNumericRange(rg, "bbox.ymin");
        if (ymin?.min !== undefined && ymin.min > searchBBox.lat2) continue;
        const ymax = getColumnStatNumericRange(rg, "bbox.ymax");
        if (ymax?.max !== undefined && ymax.max < searchBBox.lat1) continue;
        if (minConfidence > 0) {
            const conf = getColumnStatNumericRange(rg, "confidence");
            if (conf?.max !== undefined && conf.max < minConfidence) continue;
        }
        matches++;
    }
    return matches;
}

function normalizeOvertureCategoryToken(input: string): string {
    return input.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "");
}

function buildCategorySegmentRegex(categoryInput: string): RegExp | null {
    const norm = normalizeOvertureCategoryToken(categoryInput);
    if (!norm) return null;
    const terms = [norm];
    if (norm.length > 3 && norm.endsWith("s")) {
        terms.push(norm.slice(0, -1));
    }
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`(?:^|_)(?:${escaped.join("|")})(?:_|$)`, "i");
}

function matchesOvertureCategory(row: Record<string, any>, regex: RegExp): boolean {
    if (typeof row.basic_category === "string" && regex.test(row.basic_category)) return true;
    const tax = row.taxonomy;
    if (tax && typeof tax === "object") {
        if (typeof tax.primary === "string" && regex.test(tax.primary)) return true;
        if (Array.isArray(tax.alternates) && tax.alternates.some((a: unknown) => typeof a === "string" && regex.test(a))) {
            return true;
        }
        if (Array.isArray(tax.hierarchy) && tax.hierarchy.some((h: unknown) => typeof h === "string" && regex.test(h))) {
            return true;
        }
    }
    return false;
}

function collectCommonNameStrings(common: unknown): string[] {
    if (!common) return [];
    if (Array.isArray(common)) {
        return common
            .map((entry: any) => (typeof entry === "string" ? entry : entry?.value))
            .filter((v): v is string => typeof v === "string" && v.length > 0);
    }
    if (typeof common === "object") {
        return Object.values(common as Record<string, unknown>).filter(
            (v): v is string => typeof v === "string" && v.length > 0
        );
    }
    return [];
}

function matchesOvertureQuery(row: Record<string, any>, tokens: string[]): boolean {
    const parts: string[] = [];
    if (typeof row.names?.primary === "string") parts.push(row.names.primary);
    parts.push(...collectCommonNameStrings(row.names?.common));
    if (typeof row.brand?.names?.primary === "string") parts.push(row.brand.names.primary);
    parts.push(...collectCommonNameStrings(row.brand?.names?.common));
    if (typeof row.basic_category === "string") parts.push(row.basic_category);
    if (typeof row.taxonomy?.primary === "string") parts.push(row.taxonomy.primary);
    if (Array.isArray(row.addresses) && row.addresses[0]) {
        const a0 = row.addresses[0];
        if (typeof a0.freeform === "string") parts.push(a0.freeform);
        if (typeof a0.locality === "string") parts.push(a0.locality);
    }
    if (parts.length === 0) return false;
    const haystack = parts.join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
}

function extractOverturePoint(row: Record<string, any>): { lat: number; lon: number } | null {
    const geom = row.geometry;
    if (
        geom &&
        geom.type === "Point" &&
        Array.isArray(geom.coordinates) &&
        geom.coordinates.length >= 2 &&
        typeof geom.coordinates[0] === "number" &&
        typeof geom.coordinates[1] === "number"
    ) {
        return { lat: geom.coordinates[1], lon: geom.coordinates[0] };
    }
    const b = row.bbox;
    if (b && typeof b.xmin === "number" && typeof b.xmax === "number" && typeof b.ymin === "number" && typeof b.ymax === "number") {
        return { lat: (b.ymin + b.ymax) / 2, lon: (b.xmin + b.xmax) / 2 };
    }
    return null;
}

function normalizeStringArray(val: unknown): string[] {
    if (!Array.isArray(val)) return [];
    const seen = new Set<string>();
    for (const item of val) {
        if (typeof item === "string") {
            const cleaned = sanitizeExternalText(item, 300);
            if (cleaned.length > 0) {
                seen.add(cleaned);
            }
        }
    }
    return [...seen];
}

function extractOvertureSources(sourcesVal: unknown): string[] {
    if (!Array.isArray(sourcesVal)) return [];
    const all = new Set<string>();
    const external = new Set<string>();
    for (const entry of sourcesVal) {
        if (!entry || typeof entry !== "object") continue;
        const name = typeof (entry as any).dataset === "string"
            ? (entry as any).dataset.trim()
            : typeof (entry as any).provider === "string"
                ? (entry as any).provider.trim()
                : "";
        if (!name) continue;
        all.add(name);
        if (!/^overture(?:-signals)?$/i.test(name)) {
            external.add(name);
        }
    }
    return external.size > 0 ? [...external] : [...all];
}

function formatOverturePlace(
    row: Record<string, any>,
    coords: { lat: number; lon: number },
    refCenter: { lat: number; lng: number },
    indexFallbackId: string
): OverturePlaceResult {
    const addr = Array.isArray(row.addresses) && row.addresses[0] && typeof row.addresses[0] === "object"
        ? row.addresses[0]
        : null;
    const brandName = typeof row.brand?.names?.primary === "string" ? sanitizeExternalText(row.brand.names.primary, 200) || null : null;
    const brandWikidata = typeof row.brand?.wikidata === "string" ? sanitizeExternalText(row.brand.wikidata, 80) || null : null;

    return {
        id: typeof row.id === "string" ? sanitizeExternalText(row.id, 150) || indexFallbackId : indexFallbackId,
        name: typeof row.names?.primary === "string" ? sanitizeExternalText(row.names.primary, 300) || null : null,
        basic_category: typeof row.basic_category === "string" ? sanitizeExternalText(row.basic_category, 100) || null : null,
        primary_category: typeof row.taxonomy?.primary === "string" ? sanitizeExternalText(row.taxonomy.primary, 100) || null : null,
        alternate_categories: normalizeStringArray(row.taxonomy?.alternates),
        category_hierarchy: normalizeStringArray(row.taxonomy?.hierarchy),
        confidence: typeof row.confidence === "number" && Number.isFinite(row.confidence) ? Number(row.confidence.toFixed(4)) : null,
        operating_status: typeof row.operating_status === "string" ? sanitizeExternalText(row.operating_status, 50) || null : null,
        brand: brandName || brandWikidata ? { name: brandName, wikidata: brandWikidata } : null,
        coordinates: { lat: Number(coords.lat.toFixed(6)), lon: Number(coords.lon.toFixed(6)) },
        distance_meters: Math.round(calculateHaversineDistanceMeters(refCenter.lat, refCenter.lng, coords.lat, coords.lon)),
        address: addr
            ? {
                freeform: typeof addr.freeform === "string" ? sanitizeExternalText(addr.freeform, 300) || null : null,
                locality: typeof addr.locality === "string" ? sanitizeExternalText(addr.locality, 120) || null : null,
                postcode: typeof addr.postcode === "string" ? sanitizeExternalText(addr.postcode, 40) || null : null,
                region: typeof addr.region === "string" ? sanitizeExternalText(addr.region, 80) || null : null,
                country: typeof addr.country === "string" ? sanitizeExternalText(addr.country, 80) || null : null,
            }
            : null,
        websites: normalizeHttpUrlArray(row.websites),
        phones: normalizeStringArray(row.phones),
        emails: normalizeStringArray(row.emails),
        socials: normalizeHttpUrlArray(row.socials),
        sources: extractOvertureSources(row.sources),
        version: typeof row.version === "number" ? row.version : null,
    };
}

async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const idx = nextIndex++;
            results[idx] = await worker(items[idx], idx);
        }
    });
    await Promise.all(workers);
    return results;
}

interface OvertureSearchParams {
    bbox: BBox;
    refCenter: { lat: number; lng: number };
    radiusMeters?: number;
    polygonsWithHoles?: number[][][][];
    query?: string;
    category?: string;
    minConfidence: number;
    includeClosed: boolean;
    countOnly: boolean;
}

async function searchOverturePlaces(
    params: OvertureSearchParams,
    warnings: string[]
): Promise<{
    release: string;
    places: OverturePlaceResult[];
    scannedRowGroups: number;
    scannedFiles: number;
    cached: boolean;
    cacheAgeMs: number;
}> {
    const cacheKey = JSON.stringify({
        stac: OVERTURE_STAC_URL,
        provider: OVERTURE_STORAGE_PROVIDER,
        bbox: params.bbox,
        refCenter: params.refCenter,
        radiusMeters: params.radiusMeters ?? null,
        polyCount: params.polygonsWithHoles?.length ?? 0,
        query: params.query || "",
        category: params.category || "",
        minConfidence: params.minConfidence,
        includeClosed: params.includeClosed,
        countOnly: params.countOnly,
    });
    const queryCached = getFreshCacheEntry(overtureQueryCache, cacheKey, OVERTURE_QUERY_TTL_MS);
    if (queryCached) {
        return {
            release: queryCached.release,
            places: queryCached.places,
            scannedRowGroups: queryCached.scannedRowGroups,
            scannedFiles: queryCached.scannedFiles,
            cached: true,
            cacheAgeMs: Math.max(0, Date.now() - queryCached.cachedAt),
        };
    }

    const catalog = await getOvertureCatalog(OVERTURE_STAC_URL);
    const index = await getOverturePlaceFiles(catalog.release, catalog.releaseCatalogUrl);

    const intersectingFiles = index.files.filter(
        (f) =>
            f.bbox.xmin <= params.bbox.lng2 &&
            f.bbox.xmax >= params.bbox.lng1 &&
            f.bbox.ymin <= params.bbox.lat2 &&
            f.bbox.ymax >= params.bbox.lat1
    );

    if (intersectingFiles.length === 0) {
        return {
            release: catalog.release,
            places: [],
            scannedRowGroups: 0,
            scannedFiles: 0,
            cached: false,
            cacheAgeMs: 0,
        };
    }

    // Phase 1: open Parquet footers (cached 6h) and count matching row groups before reading data chunks
    const openedFiles = await runWithConcurrency(intersectingFiles, 4, async (fileEntry) => {
        const mirrors = getOrderedMirrorUrls(fileEntry);
        let lastError: unknown;
        for (let m = 0; m < mirrors.length; m++) {
            const mirror = mirrors[m];
            try {
                const { asyncBuf, metadata } = await openParquetFile(mirror.url);
                const matchingRowGroups = countMatchingRowGroups(metadata, params.bbox, params.minConfidence);
                if (m > 0) {
                    warnings.push(`Overture primary storage (${mirrors[0].provider}) failed for ${fileEntry.id}; fell back to ${mirror.provider}.`);
                }
                return { fileEntry, mirrors, mirrorIdx: m, asyncBuf, metadata, matchingRowGroups };
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    });

    const filesWithMatches = openedFiles.filter((f) => f.matchingRowGroups > 0);
    const totalMatchingRowGroups = filesWithMatches.reduce((acc, f) => acc + f.matchingRowGroups, 0);

    if (totalMatchingRowGroups > MAX_OVERTURE_ROW_GROUPS) {
        throw new Error(
            `Search area spans ${totalMatchingRowGroups} Overture Parquet row groups across ${filesWithMatches.length} partition file(s), exceeding OVERTURE_MAX_ROW_GROUPS (${MAX_OVERTURE_ROW_GROUPS}). Narrow the bbox or radius_meters, raise min_confidence, or split the area with spatial_calc(operation='split_grid').`
        );
    }

    if (filesWithMatches.length === 0) {
        return {
            release: catalog.release,
            places: [],
            scannedRowGroups: 0,
            scannedFiles: 0,
            cached: false,
            cacheAgeMs: 0,
        };
    }

    const queryTokens = params.query
        ? params.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
        : [];
    const categoryRegex = params.category ? buildCategorySegmentRegex(params.category) : null;

    const desiredColumns = params.countOnly
        ? [
            "geometry",
            "bbox",
            "confidence",
            "operating_status",
            "basic_category",
            "taxonomy",
            ...(queryTokens.length > 0 ? ["names", "brand", "addresses"] : []),
        ]
        : [
            "id",
            "geometry",
            "bbox",
            "confidence",
            "operating_status",
            "basic_category",
            "taxonomy",
            "names",
            "brand",
            "addresses",
            "websites",
            "phones",
            "emails",
            "socials",
            "sources",
            "version",
        ];

    // Phase 2: read matching row groups with schema-safe column projection and mirror fallback
    const perFileResults = await runWithConcurrency(filesWithMatches, 4, async (entry) => {
        const readFromMirror = async (asyncBuf: AsyncBuffer, metadata: FileMetaData) => {
            const topCols = new Set(parquetSchema(metadata).children.map((c) => c.element.name));
            const leafCols = new Set<string>();
            for (const rg of metadata.row_groups) {
                for (const col of rg.columns) {
                    const p = col.meta_data?.path_in_schema?.join(".");
                    if (p) leafCols.add(p);
                }
            }

            const filter: ParquetQueryFilter = {};
            if (leafCols.has("bbox.xmin") && leafCols.has("bbox.xmax") && leafCols.has("bbox.ymin") && leafCols.has("bbox.ymax")) {
                filter["bbox.xmin"] = { $lte: params.bbox.lng2 };
                filter["bbox.xmax"] = { $gte: params.bbox.lng1 };
                filter["bbox.ymin"] = { $lte: params.bbox.lat2 };
                filter["bbox.ymax"] = { $gte: params.bbox.lat1 };
            }
            if (params.minConfidence > 0 && topCols.has("confidence")) {
                filter["confidence"] = { $gte: params.minConfidence };
            }

            const columns = desiredColumns.filter((c) => topCols.has(c));
            return await parquetReadObjects({
                file: asyncBuf,
                metadata,
                compressors,
                columns,
                filter: Object.keys(filter).length > 0 ? filter : undefined,
            });
        };

        let rows: Record<string, any>[];
        try {
            rows = await readFromMirror(entry.asyncBuf, entry.metadata);
        } catch (primaryErr) {
            const altMirror = entry.mirrors[entry.mirrorIdx + 1];
            if (!altMirror) throw primaryErr;
            const { asyncBuf, metadata } = await openParquetFile(altMirror.url);
            rows = await readFromMirror(asyncBuf, metadata);
            warnings.push(
                `Overture storage (${entry.mirrors[entry.mirrorIdx].provider}) read failed for ${entry.fileEntry.id}; fell back to ${altMirror.provider}.`
            );
        }

        const matched: OverturePlaceResult[] = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!params.includeClosed && row.operating_status === "permanently_closed") continue;
            if (params.minConfidence > 0) {
                if (typeof row.confidence !== "number" || row.confidence < params.minConfidence) continue;
            }

            const coords = extractOverturePoint(row);
            if (!coords) continue;
            if (
                coords.lat < params.bbox.lat1 ||
                coords.lat > params.bbox.lat2 ||
                coords.lon < params.bbox.lng1 ||
                coords.lon > params.bbox.lng2
            ) {
                continue;
            }
            if (params.radiusMeters !== undefined) {
                const d = calculateHaversineDistanceMeters(params.refCenter.lat, params.refCenter.lng, coords.lat, coords.lon);
                if (d > params.radiusMeters) continue;
            }
            if (params.polygonsWithHoles && params.polygonsWithHoles.length > 0) {
                const inside = params.polygonsWithHoles.some((poly) =>
                    isPointInPolygonWithHoles(coords.lat, coords.lon, poly)
                );
                if (!inside) continue;
            }

            if (categoryRegex && !matchesOvertureCategory(row, categoryRegex)) continue;
            if (queryTokens.length > 0 && !matchesOvertureQuery(row, queryTokens)) continue;

            matched.push(formatOverturePlace(row, coords, params.refCenter, `${entry.fileEntry.id}#${i}`));
        }
        return matched;
    });

    const places = perFileResults.flat();
    setBoundedCache(overtureQueryCache, 50, cacheKey, {
        release: catalog.release,
        places,
        scannedRowGroups: totalMatchingRowGroups,
        scannedFiles: filesWithMatches.length,
        cachedAt: Date.now(),
    });

    return {
        release: catalog.release,
        places,
        scannedRowGroups: totalMatchingRowGroups,
        scannedFiles: filesWithMatches.length,
        cached: false,
        cacheAgeMs: 0,
    };
}

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

const BBOX_OBJ_SCHEMA = {
    type: "object" as const,
    properties: {
        lat1: { type: "number" as const },
        lng1: { type: "number" as const },
        lat2: { type: "number" as const },
        lng2: { type: "number" as const }
    },
    required: ["lat1", "lng1", "lat2", "lng2"]
};

const PROVENANCE_SCHEMA = {
    type: "object" as const,
    properties: {
        provider: { type: "string" as const },
        attribution: { type: "string" as const },
        data_timestamp: { type: "string" as const },
        cached: { type: "boolean" as const },
        cache_age_ms: { type: "number" as const },
        usage_policy: { type: "string" as const }
    },
    required: ["provider", "data_timestamp", "cached", "cache_age_ms"]
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_bounds",
                description: "Get converted coordinates for a bounding box or natural-language location search (powered by Nominatim with configurable Photon & optional Mapbox fallbacks). Supports parsing WKT, GeoJSON, ogrinfo extent, Web Mercator tiles ('z/x/y'), single points ('lat,lng'), and raw coordinate strings, plus optional metric buffering.",
                annotations: {
                    title: "Get Bounding Box & Projections",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        location: {
                            type: "string",
                            description: "A text location to search for (e.g. 'New York City', 'Central Park'). Uses OpenStreetMap Nominatim (or configurable NOMINATIM_API_URL / PHOTON_API_URL / optional MAPBOX_ACCESS_TOKEN). Either 'location' or 'bbox' MUST be provided."
                        },
                        bbox: {
                            type: "string",
                            description: "The geometry to parse. Can be a raw bounding box string ('lat1,lng1,lat2,lng2'), a single point ('lat,lng'), a Web Mercator tile ('z/x/y'), a WKT polygon/linestring/point, a GeoJSON payload, or an `ogrinfo` extent block. Either 'location' or 'bbox' MUST be provided."
                        },
                        buffer_meters: {
                            type: "number",
                            description: "Optional distance in meters to expand (positive) or shrink (negative) the bounding box in all directions. Ideal for creating a bounding box around a single point."
                        },
                        epsg: {
                            type: "string",
                            description: "The projected EPSG code (e.g. '3857'). Defaults to '4326' (WGS84). Over 3,900 bundled projections; unknown codes are auto-fetched from epsg.io.",
                        },
                        format: {
                            type: "string",
                            description: "Format of the output. Options: wkt, geojson-bbox, leaflet, overpass, ogc-bbox, kml, geojson-polygon, csv, stac-bbox. Default: csv.",
                            enum: ["wkt", "geojson-bbox", "leaflet", "overpass", "ogc-bbox", "kml", "geojson-polygon", "csv", "stac-bbox"]
                        },
                        coord_order: {
                            type: "string",
                            description: "Toggle between 'lng,lat' (default) and 'lat,lng' coordinate ordering in the formatted output. Useful for APIs that expect swapped coordinate orders.",
                            enum: ["lng,lat", "lat,lng"]
                        },
                        zoom: {
                            type: "number",
                            description: "The map zoom level (0-22) used to calculate the map tile coordinates for the centroid. Defaults to 15."
                        },
                        precision: {
                            type: "number",
                            description: "The number of decimal places to output coordinate strings as (defaults to 6)."
                        }
                    },
                    oneOf: [
                        { required: ["location"] },
                        { required: ["bbox"] }
                    ]
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        matched_place: { type: "string" },
                        alternatives: { type: "array", items: { type: "object" } },
                        original_wgs84: BBOX_OBJ_SCHEMA,
                        projected: {
                            type: "object",
                            properties: {
                                xmin: { type: "number" },
                                ymin: { type: "number" },
                                xmax: { type: "number" },
                                ymax: { type: "number" }
                            },
                            required: ["xmin", "ymin", "xmax", "ymax"]
                        },
                        center: {
                            type: "object",
                            properties: { lat: { type: "number" }, lng: { type: "number" } },
                            required: ["lat", "lng"]
                        },
                        tile_indices: {
                            type: "object",
                            properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
                            required: ["x", "y", "z"]
                        },
                        epsg: { type: "string" },
                        format: { type: "string" },
                        coord_order: { type: "string" },
                        precision: { type: "number" },
                        area_km2: { type: "number" },
                        dimensions: {
                            type: "object",
                            properties: { width_km: { type: "number" }, height_km: { type: "number" } },
                            required: ["width_km", "height_km"]
                        },
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["original_wgs84", "projected", "center", "tile_indices", "epsg", "format", "coord_order", "precision", "area_km2", "dimensions", "share_url", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "get_h3_indices",
                description: "Get Uber H3 cell indices for a polygon (including interior holes), location boundary, or bounding box at a target resolution. When a WKT/GeoJSON polygon or named location boundary is provided, fills the exact polygon geometry (subtracting interior holes) rather than just its bounding rectangle.",
                annotations: {
                    title: "Generate H3 Hexagonal Grid Indices",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        location: {
                            type: "string",
                            description: "A text location to search for (e.g. 'San Francisco'). Either 'location' or 'bbox' MUST be provided."
                        },
                        bbox: {
                            type: "string",
                            description: "The geometry to parse. Can be a raw bounding box string ('lat1,lng1,lat2,lng2'), WKT polygon (with optional holes), GeoJSON polygon/multipolygon, tile 'z/x/y', or ogrinfo extent. Either 'location' or 'bbox' MUST be provided.",
                        },
                        resolution: {
                            type: "number",
                            description: "The H3 resolution level, from 0 to 15. (e.g. 7)"
                        },
                        compact: {
                            type: "boolean",
                            description: "Whether to return a compacted list of cells (mixing resolutions) to minimize response size. Defaults to false."
                        },
                        summary_only: {
                            type: "boolean",
                            description: "If true, returns only cell count, sample cells, and map share URL without dumping thousands of cell IDs into context. Ideal for high resolutions. Defaults to false."
                        },
                        return_geometry: {
                            type: "boolean",
                            description: "If true, return GeoJSON FeatureCollection with hex boundary polygons in addition to cell IDs. Defaults to false."
                        },
                        use_polygon_boundary: {
                            type: "boolean",
                            description: "If true (default), fills the exact WKT/GeoJSON/OSM polygon boundary (including interior holes) instead of its rectangular bounding box when available."
                        }
                    },
                    required: ["resolution"],
                    oneOf: [
                        { required: ["location"] },
                        { required: ["bbox"] }
                    ]
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        resolution: { type: "number" },
                        compact: { type: "boolean" },
                        summary_only: { type: "boolean" },
                        used_polygon_boundary: { type: "boolean" },
                        cell_count: { type: "number" },
                        cells: { type: "array", items: { type: "string" } },
                        sample_cells: { type: "array", items: { type: "string" } },
                        geojson: { type: "object" },
                        original_bbox: BBOX_OBJ_SCHEMA,
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["resolution", "compact", "summary_only", "used_polygon_boundary", "cell_count", "original_bbox", "share_url", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "generate_share_url",
                description: "Generates a URL that links to the visual Bounding Box tool to display these coordinates on a map. Supports WKT, GeoJSON, ogrinfo extent, tile 'z/x/y', and raw coordinate strings as input.",
                annotations: {
                    title: "Generate Map Verification URL",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        bbox: {
                            type: "string",
                            description: "The geometry to parse. Can be a raw bounding box string ('lat1,lng1,lat2,lng2'), WKT, GeoJSON, tile 'z/x/y', or ogrinfo extent.",
                        }
                    },
                    required: ["bbox"],
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        bbox: BBOX_OBJ_SCHEMA,
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["bbox", "share_url", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "reverse_geocode",
                description: "Reverse geocode latitude and longitude coordinates to discover context, place name, address components, and OSM details ('what is here?').",
                annotations: {
                    title: "Reverse Geocode Coordinates",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        lat: {
                            type: "number",
                            description: "Latitude coordinate (-90 to 90)."
                        },
                        lng: {
                            type: "number",
                            description: "Longitude coordinate (-180 to 180)."
                        },
                        zoom: {
                            type: "number",
                            description: "Detail zoom level from 0 (country) to 18 (building/address). Defaults to 18."
                        }
                    },
                    required: ["lat", "lng"]
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        matched_place: { type: "string" },
                        center: {
                            type: "object",
                            properties: { lat: { type: "number" }, lng: { type: "number" } },
                            required: ["lat", "lng"]
                        },
                        bbox: BBOX_OBJ_SCHEMA,
                        address: { type: "object" },
                        class: { type: "string" },
                        type: { type: "string" },
                        osm_type: { type: "string" },
                        osm_id: { type: "number" },
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["matched_place", "center", "bbox", "address", "share_url", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "search_overpass",
                description: "Execute an Overpass QL query to find POIs, roads, or other OSM features within an admin boundary area, bounding box, or radius. The server wraps your query in spatial filters, detects Overpass runtime errors, and returns structured JSON with provenance, completeness metadata, distance calculations, and a map link.\n\nSEARCH MODES:\n- Location / Admin Area: when 'location' resolves to an OSM boundary polygon (e.g. 'Manhattan', 'Seattle'), searches inside exact boundary polygon.\n- Bounding box (default): searches a rectangular area.\n- Circle: searches within an exact radius when 'radius_meters' is provided.\n- Fast Count: set 'count_only: true' to get instant element counts without downloading full element payloads.\n\nCOMMON TAG EXAMPLES:\n- Restaurants: `nwr[\"amenity\"=\"restaurant\"]`\n- Pizza: `nwr[\"amenity\"=\"fast_food\"][\"cuisine\"=\"pizza\"]`\n- Supermarkets: `nwr[\"shop\"=\"supermarket\"]`\n- Parks: `nwr[\"leisure\"=\"park\"]`\n- Hospitals: `nwr[\"amenity\"=\"hospital\"]`\n- EV Charging: `nwr[\"amenity\"=\"charging_station\"]`\n- Gyms: `nwr[\"leisure\"=\"fitness_centre\"]`\n- Banks: `nwr[\"amenity\"=\"bank\"]`",
                annotations: {
                    title: "Search OpenStreetMap via Overpass QL",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        location: {
                            type: "string",
                            description: "A text location to search for (e.g. 'Manhattan', 'San Francisco'). Either 'location' or 'bbox' MUST be provided."
                        },
                        bbox: {
                            type: "string",
                            description: "The geometry to parse. Can be a raw bounding box string ('lat1,lng1,lat2,lng2'), WKT, GeoJSON, or ogrinfo extent. Either 'location' or 'bbox' MUST be provided.",
                        },
                        query: {
                            type: "string",
                            description: "The Overpass QL core query. Example: `node[\"amenity\"=\"cafe\"]` or `nwr[\"leisure\"=\"park\"]`. Multi-statement queries supported (e.g. `nwr[\"office\"=\"coworking\"]; nwr[\"amenity\"=\"coworking_space\"]`). DO NOT include spatial filters or output directives."
                        },
                        radius_meters: {
                            type: "number",
                            description: "Search radius in metres. Enables circle mode — use ONLY when explicit distance is specified ('2km' → 2000)."
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of elements to return per page. Default is 100."
                        },
                        offset: {
                            type: "number",
                            description: "Pagination offset for retrieving subsequent pages of results. Default is 0."
                        },
                        timeout_seconds: {
                            type: "number",
                            description: "Overpass server query timeout in seconds. Default is 25."
                        },
                        use_area_boundary: {
                            type: "boolean",
                            description: "If true (default), uses exact OSM administrative boundary polygon for named locations when available, avoiding bounding box collapse."
                        },
                        sort_by_distance: {
                            type: "boolean",
                            description: "If true, sorts returned elements by distance from origin/center. Enabled by default for circle mode and point locations."
                        },
                        return_geometry: {
                            type: "boolean",
                            description: "If true, returns full geometry (polygon/polyline) for ways and relations instead of center point. Defaults to false."
                        },
                        count_only: {
                            type: "boolean",
                            description: "If true, executes an ultra-fast Overpass 'out count;' query and returns total counts (nodes, ways, relations, total) without downloading individual features. Defaults to false."
                        }
                    },
                    required: ["query"],
                    oneOf: [
                        { required: ["location"] },
                        { required: ["bbox"] }
                    ]
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        search_mode: { type: "string" },
                        count_only: { type: "boolean" },
                        matched_place: { type: "string" },
                        alternatives: { type: "array", items: { type: "object" } },
                        osm_area_id: { type: "number" },
                        counts: {
                            type: "object",
                            properties: {
                                nodes: { type: "number" },
                                ways: { type: "number" },
                                relations: { type: "number" },
                                total: { type: "number" }
                            }
                        },
                        distance_from: { type: "object" },
                        generator: { type: "string" },
                        osm3s: { type: "object" },
                        elements: { type: "array", items: { type: "object" } },
                        total_count: { type: "number" },
                        returned_count: { type: "number" },
                        offset: { type: "number" },
                        limit: { type: "number" },
                        truncated: { type: "boolean" },
                        has_more: { type: "boolean" },
                        next_offset: { type: "number" },
                        pagination_hint: { type: "string" },
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["search_mode", "count_only", "share_url", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "list_osm_tags",
                description: "Discovery tool to look up the correct OpenStreetMap tags for any category. Uses built-in category index and live Taginfo API fallback to prevent tag hallucination.",
                annotations: {
                    title: "Lookup OpenStreetMap Tags",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        category: {
                            type: "string",
                            description: "Category or keyword to look up (e.g. 'food', 'ev charging', 'gym', 'coworking', 'banks', 'dog park')."
                        }
                    },
                    required: ["category"]
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        category: { type: "string" },
                        source: { type: "string" },
                        tags: { type: "array", items: { type: "string" } },
                        recommendations_text: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["category", "source", "tags", "recommendations_text", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "aggregate_overpass_h3",
                description: "Executes an Overpass query and bins the results into H3 hexagons at a specified resolution to analyze spatial density. Plots the top density hotspots on the shareable verification map.",
                annotations: {
                    title: "Aggregate OSM Features into H3 Hexagons",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        location: {
                            type: "string",
                            description: "A text location to search for (e.g. 'Seattle')."
                        },
                        bbox: {
                            type: "string",
                            description: "The bounding box geometry to parse."
                        },
                        query: {
                            type: "string",
                            description: "The Overpass QL core query (e.g. `nwr[\"amenity\"=\"cafe\"]`)."
                        },
                        resolution: {
                            type: "number",
                            description: "The H3 resolution level (0-15) for binning. Default is 8."
                        },
                        radius_meters: {
                            type: "number",
                            description: "Optional search radius in metres around the location/bbox center."
                        },
                        timeout_seconds: {
                            type: "number",
                            description: "Overpass server query timeout in seconds. Default is 25."
                        },
                        use_area_boundary: {
                            type: "boolean",
                            description: "If true (default), uses exact OSM boundary polygon for named locations when available."
                        }
                    },
                    required: ["query", "resolution"],
                    oneOf: [
                        { required: ["location"] },
                        { required: ["bbox"] }
                    ]
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        resolution: { type: "number" },
                        matched_place: { type: "string" },
                        alternatives: { type: "array", items: { type: "object" } },
                        osm_area_id: { type: "number" },
                        total_elements: { type: "number" },
                        active_hex_count: { type: "number" },
                        hex_counts: { type: "object" },
                        hex_geojson: { type: "object" },
                        original_bbox: BBOX_OBJ_SCHEMA,
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["resolution", "total_elements", "active_hex_count", "hex_counts", "hex_geojson", "original_bbox", "share_url", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "calculate_route",
                description: "Calculate real-world travel distance, duration, turn-by-turn summary (with maneuver coordinates), GeoJSON route geometry, and route bounding box between two locations or coordinate pairs using OpenStreetMap routing (FOSSGIS / OSRM, or configurable OSRM_API_URL). Supports optional intermediate 'waypoints' and requesting 'alternatives' (up to 3 OSRM routes for side-by-side comparison with check_traffic_controls).",
                annotations: {
                    title: "Calculate Route Distance, Duration & Geometry",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        origin: {
                            type: "string",
                            description: "Starting point as 'lat,lng' coordinates (e.g. '40.7128,-74.0060') or a natural-language place name (e.g. 'Times Square, NYC')."
                        },
                        destination: {
                            type: "string",
                            description: "Ending point as 'lat,lng' coordinates (e.g. '40.6413,-73.7781') or a natural-language place name (e.g. 'JFK Airport')."
                        },
                        waypoints: {
                            type: "array",
                            description: "Optional list of intermediate via-points ('lat,lng' or place names, up to 20) to force the route through specific streets or intersections.",
                            items: { type: "string" }
                        },
                        profile: {
                            type: "string",
                            description: "Travel mode profile: 'driving' (car), 'walking' (foot), or 'cycling' (bicycle). Defaults to 'driving'.",
                            enum: ["driving", "walking", "cycling"]
                        },
                        return_steps: {
                            type: "boolean",
                            description: "If true, includes step-by-step road names, maneuver instructions, and turn coordinates. Defaults to false."
                        },
                        alternatives: {
                            type: "boolean",
                            description: "If true, requests up to 3 alternative routes from OSRM (only supported when 'waypoints' is empty). Defaults to false."
                        }
                    },
                    required: ["origin", "destination"]
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        profile: { type: "string" },
                        origin: {
                            type: "object",
                            properties: { lat: { type: "number" }, lng: { type: "number" }, label: { type: "string" } },
                            required: ["lat", "lng", "label"]
                        },
                        destination: {
                            type: "object",
                            properties: { lat: { type: "number" }, lng: { type: "number" }, label: { type: "string" } },
                            required: ["lat", "lng", "label"]
                        },
                        waypoints: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: { lat: { type: "number" }, lng: { type: "number" }, label: { type: "string" } },
                                required: ["lat", "lng", "label"]
                            }
                        },
                        distance_meters: { type: "number" },
                        distance_km: { type: "number" },
                        duration_seconds: { type: "number" },
                        duration_minutes: { type: "number" },
                        straight_line_meters: { type: "number" },
                        detour_factor: { type: "number" },
                        initial_bearing: {
                            type: "object",
                            properties: { degrees: { type: "number" }, cardinal: { type: "string" } },
                            required: ["degrees", "cardinal"]
                        },
                        route_bbox: BBOX_OBJ_SCHEMA,
                        route_geometry: {
                            type: "object",
                            properties: {
                                type: { type: "string" },
                                coordinates: { type: "array", items: { type: "array", items: { type: "number" } } }
                            },
                            required: ["type", "coordinates"]
                        },
                        steps: { type: "array", items: { type: "object" } },
                        alternatives_count: { type: "number" },
                        alternatives: { type: "array", items: { type: "object" } },
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["profile", "origin", "destination", "distance_meters", "distance_km", "duration_seconds", "duration_minutes", "straight_line_meters", "detour_factor", "initial_bearing", "route_bbox", "route_geometry", "share_url", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "get_elevation",
                description: "Query terrain elevation in meters above sea level using the Open-Meteo 90m Copernicus DEM API (free for non-commercial use; commercial use requires a paid key or self-hosted ELEVATION_API_URL). Supports 4 modes: 'points' (discrete coordinates), 'grid' (N×N bbox sample statistics), 'line_of_sight' (3D terrain intervisibility with WGS84 Earth curvature & atmospheric refraction between two points), and 'profile' (cumulative elevation gain/loss and max grade % along a route_geometry or path).",
                annotations: {
                    title: "Get Terrain Elevation, Line-of-Sight & Profiles",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        mode: {
                            type: "string",
                            enum: ["points", "grid", "line_of_sight", "profile"],
                            description: "Elevation query mode: 'points' (discrete coordinates), 'grid' (N×N bbox sample), 'line_of_sight' (3D terrain intervisibility & Earth curvature check between two points), or 'profile' (elevation gain/loss & grade profile along a path/route)."
                        },
                        points: {
                            type: "array",
                            description: "List of {lat, lng, label?} points to query elevation for (up to 100 points). Also accepted as [observer, target] in 'line_of_sight' or path vertices in 'profile'.",
                            items: {
                                type: "object",
                                properties: {
                                    lat: { type: "number" },
                                    lng: { type: "number" },
                                    label: { type: "string" }
                                },
                                required: ["lat", "lng"]
                            }
                        },
                        location: {
                            type: "string",
                            description: "A text location to sample elevation across (e.g. 'Mount Rainier', 'Denver')."
                        },
                        bbox: {
                            type: "string",
                            description: "A bounding box or point string to sample terrain elevation across (or SW-to-NE endpoints for 'line_of_sight'/'profile')."
                        },
                        grid_size: {
                            type: "number",
                            description: "Grid dimension N (N x N samples, from 2 to 10) when sampling a bounding box. Defaults to 5 (25 sample points)."
                        },
                        origin: {
                            type: "string",
                            description: "Start point ('lat,lng' or place name) for 'line_of_sight' or 'profile' mode."
                        },
                        destination: {
                            type: "string",
                            description: "End/target point ('lat,lng' or place name) for 'line_of_sight' or 'profile' mode."
                        },
                        route_geometry: {
                            type: "object",
                            description: "GeoJSON LineString ({ type: 'LineString', coordinates: [[lng, lat], ...] }) from calculate_route to sample an elevation profile along.",
                            properties: {
                                type: { type: "string" },
                                coordinates: {
                                    type: "array",
                                    items: {
                                        type: "array",
                                        items: { type: "number" }
                                    }
                                }
                            },
                            required: ["type", "coordinates"]
                        },
                        observer_height_meters: {
                            type: "number",
                            description: "Observer height in meters above ground for 'line_of_sight' (default 1.7m)."
                        },
                        target_height_meters: {
                            type: "number",
                            description: "Target height in meters above ground for 'line_of_sight' (default 0m)."
                        },
                        sample_count: {
                            type: "number",
                            description: "Number of elevation samples along the ray or route for 'line_of_sight' or 'profile' (5 to 100, default 25)."
                        },
                        refraction_coefficient: {
                            type: "number",
                            description: "Atmospheric refraction coefficient k for Earth curvature in 'line_of_sight' (default 0.13)."
                        }
                    }
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        mode: { type: "string" },
                        matched_place: { type: "string" },
                        dem_resolution_meters: { type: "number" },
                        sample_count: { type: "number" },
                        sample_stats: {
                            type: "object",
                            properties: {
                                min_elevation_meters: { type: "number" },
                                max_elevation_meters: { type: "number" },
                                mean_elevation_meters: { type: "number" },
                                sample_relief_meters: { type: "number" },
                                lowest_sample: { type: "object" },
                                highest_sample: { type: "object" },
                                is_finite_sample: { type: "boolean" }
                            },
                            required: ["min_elevation_meters", "max_elevation_meters", "mean_elevation_meters", "sample_relief_meters", "lowest_sample", "highest_sample", "is_finite_sample"]
                        },
                        samples: { type: "array", items: { type: "object" } },
                        line_of_sight: {
                            type: "object",
                            properties: {
                                origin: { type: "object" },
                                destination: { type: "object" },
                                distance_meters: { type: "number" },
                                distance_km: { type: "number" },
                                initial_bearing_degrees: { type: "number" },
                                refraction_coefficient: { type: "number" },
                                effective_earth_radius_meters: { type: "number" },
                                is_visible: { type: "boolean" },
                                min_clearance_meters: { type: "number" },
                                max_obstruction_meters: { type: "number" },
                                limiting_point: { type: "object" },
                                elevation_angle_degrees: { type: "number" },
                                radio_horizon_km: { type: "number" }
                            }
                        },
                        profile_stats: {
                            type: "object",
                            properties: {
                                total_distance_meters: { type: "number" },
                                total_distance_km: { type: "number" },
                                cumulative_gain_meters: { type: "number" },
                                cumulative_loss_meters: { type: "number" },
                                net_elevation_change_meters: { type: "number" },
                                max_incline_grade_percent: { type: "number" },
                                max_decline_grade_percent: { type: "number" },
                                steepest_segment: { type: "object" }
                            }
                        },
                        bbox: BBOX_OBJ_SCHEMA,
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["mode", "dem_resolution_meters", "sample_count", "sample_stats", "samples", "bbox", "share_url", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "spatial_calc",
                description: "Perform deterministic offline geometric calculations on bounding boxes, points, polygons, and 3D camera frustums (zero network calls): 'relation' (intersects, contains, overlap area %, union & intersection bbox between two geometries), 'point_in_geometry' (check if a point is inside a bbox or WKT/GeoJSON polygon respecting interior holes), 'distance_bearing' (WGS84 ellipsoidal Vincenty distance, initial/final bearings, geodesic midpoint, and ENU vector between two points), 'split_grid' (subdivide a bbox into an N x M grid), or 'camera_footprint' (3D ray-ellipsoid intersection to project a drone/aerial camera frustum onto the WGS84 ground polygon).",
                annotations: {
                    title: "Deterministic Spatial Geometry Calculator",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        operation: {
                            type: "string",
                            description: "The geometric operation to perform.",
                            enum: ["relation", "point_in_geometry", "distance_bearing", "split_grid", "camera_footprint"]
                        },
                        bbox_a: {
                            type: "string",
                            description: "First geometry / bounding box (for 'relation', 'point_in_geometry', 'split_grid'), origin point 'lat,lng' (for 'distance_bearing'), or camera position 'lat,lng' (for 'camera_footprint')."
                        },
                        bbox_b: {
                            type: "string",
                            description: "Second geometry / bounding box (for 'relation') or destination point 'lat,lng' (for 'distance_bearing')."
                        },
                        point: {
                            type: "string",
                            description: "Point coordinates 'lat,lng' to test in 'point_in_geometry'."
                        },
                        rows: {
                            type: "number",
                            description: "Number of latitude rows for 'split_grid' (1-20, default 2)."
                        },
                        cols: {
                            type: "number",
                            description: "Number of longitude columns for 'split_grid' (1-20, default 2)."
                        },
                        altitude_meters: {
                            type: "number",
                            description: "Camera altitude in meters above WGS84 ellipsoid for 'camera_footprint' (> 0, <= 100000)."
                        },
                        pitch_degrees: {
                            type: "number",
                            description: "Camera pitch angle in degrees for 'camera_footprint': -90 is straight down (nadir, default), -2 is near horizontal."
                        },
                        heading_degrees: {
                            type: "number",
                            description: "Camera azimuth/heading in degrees clockwise from North for 'camera_footprint' (default 0)."
                        },
                        roll_degrees: {
                            type: "number",
                            description: "Camera roll angle in degrees around look axis for 'camera_footprint' (default 0)."
                        },
                        fov_degrees: {
                            type: "number",
                            description: "Horizontal camera field of view in degrees for 'camera_footprint' (5 to 150, default 60)."
                        },
                        aspect_ratio: {
                            type: "number",
                            description: "Image width/height aspect ratio for 'camera_footprint' (0.2 to 5, default 16/9)."
                        },
                        max_ray_distance_meters: {
                            type: "number",
                            description: "Maximum slant ray clamp distance in meters when frustum corners approach the horizon (defaults to max(50000, altitude_meters * 10))."
                        }
                    },
                    required: ["operation", "bbox_a"]
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        operation: { type: "string" },
                        intersects: { type: "boolean" },
                        a_contains_b: { type: "boolean" },
                        b_contains_a: { type: "boolean" },
                        area_a_km2: { type: "number" },
                        area_b_km2: { type: "number" },
                        intersection_area_km2: { type: "number" },
                        union_area_km2: { type: "number" },
                        overlap_percent_of_a: { type: "number" },
                        overlap_percent_of_b: { type: "number" },
                        centroid_distance_meters: { type: "number" },
                        intersection_bbox: { type: ["object", "null"] },
                        union_bbox: BBOX_OBJ_SCHEMA,
                        point: { type: "object" },
                        inside: { type: "boolean" },
                        inside_bbox: { type: "boolean" },
                        inside_polygon: { type: "boolean" },
                        target_bbox: BBOX_OBJ_SCHEMA,
                        from: { type: "object" },
                        to: { type: "object" },
                        distance_meters: { type: "number" },
                        distance_km: { type: "number" },
                        spherical_distance_meters: { type: "number" },
                        bearing_degrees: { type: "number" },
                        final_bearing_degrees: { type: "number" },
                        cardinal_direction: { type: "string" },
                        midpoint: { type: "object" },
                        ellipsoid: { type: "string" },
                        enu_vector_meters: { type: "object" },
                        bbox: BBOX_OBJ_SCHEMA,
                        rows: { type: "number" },
                        cols: { type: "number" },
                        total_cells: { type: "number" },
                        original_bbox: BBOX_OBJ_SCHEMA,
                        cells: { type: "array", items: { type: "object" } },
                        camera: { type: "object" },
                        center_target: { type: "object" },
                        footprint_corners: { type: "object" },
                        footprint_geojson: { type: "object" },
                        footprint_wkt: { type: "string" },
                        area_km2: { type: "number" },
                        clamped_to_horizon: { type: "boolean" },
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: ["operation", "share_url", "provenance", "complete", "warnings"]
                }
            },
            {
                name: "check_traffic_controls",
                description: "Check OpenStreetMap for traffic signals (traffic lights) and stop signs at a junction, within a radius of a coordinate/place, across a bounding box/area, or along a route corridor. Returns explicit booleans (has_traffic_signal, has_stop_sign), junction classification (control_type: 'traffic_signals' | 'stop_sign' | 'both' | 'none'), separate counts, exact coordinates, and a shareable verification map.\n\nMODES:\n- Junction / Coordinate: pass a point in 'bbox' (e.g. '40.7580,-73.9855') with optional 'radius_meters' (defaults to 35m).\n- Bounding box / Area: pass a bbox or 'location' (without 'radius_meters') to count or list all traffic signals and stop signs inside.\n- Route corridor (by endpoints): pass 'origin' and 'destination' (plus optional 'profile': driving/walking/cycling) to route via OSRM and inspect traffic controls along the route in one call.\n- Route corridor (by geometry): pass 'route_geometry' (the GeoJSON LineString from calculate_route) with optional 'radius_meters' (defaults to 20m) to evaluate traffic signals and stop signs along a route in travel order.",
                annotations: {
                    title: "Check Traffic Signals & Stop Signs",
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        location: {
                            type: "string",
                            description: "A text location or intersection to check (e.g. 'Manhattan', '5th Ave and 42nd St, New York'). Provide 'location', 'bbox', 'route_geometry', or 'origin'+'destination'."
                        },
                        bbox: {
                            type: "string",
                            description: "Point 'lat,lng', bounding box 'lat1,lng1,lat2,lng2', WKT, GeoJSON, tile 'z/x/y', or ogrinfo extent. For a single point, 'radius_meters' defaults to 35m if omitted."
                        },
                        origin: {
                            type: "string",
                            description: "Route origin ('lat,lng' or place name) when evaluating traffic controls directly between two points. Must be paired with 'destination'."
                        },
                        destination: {
                            type: "string",
                            description: "Route destination ('lat,lng' or place name) when evaluating traffic controls directly between two points. Must be paired with 'origin'."
                        },
                        profile: {
                            type: "string",
                            description: "Routing profile when using 'origin' and 'destination': 'driving' (default), 'walking', or 'cycling'.",
                            enum: ["driving", "walking", "cycling"]
                        },
                        route_geometry: {
                            type: "object",
                            description: "GeoJSON LineString ({ type: 'LineString', coordinates: [[lng, lat], ...] }) from calculate_route to find traffic signals and stop signs along a route corridor.",
                            properties: {
                                type: { type: "string" },
                                coordinates: {
                                    type: "array",
                                    items: {
                                        type: "array",
                                        items: { type: "number" }
                                    }
                                }
                            },
                            required: ["type", "coordinates"]
                        },
                        radius_meters: {
                            type: "number",
                            description: "Search radius in meters. Enables circle mode around a point/location (defaults to 35m for a single point) or corridor width around a route (defaults to 20m)."
                        },
                        include_crossings: {
                            type: "boolean",
                            description: "If true, also treats signalized pedestrian crossings (highway=crossing with crossing=traffic_signals or crossing:signals=yes) as traffic signals. Defaults to false."
                        },
                        count_only: {
                            type: "boolean",
                            description: "If true, returns presence booleans and counts without individual feature coordinates. Defaults to false."
                        },
                        limit: {
                            type: "number",
                            description: "Maximum total elements to return across traffic_signals and stop_signs when count_only is false. Default is 200 (max 1000)."
                        },
                        offset: {
                            type: "number",
                            description: "Pagination offset when count_only is false. Default is 0."
                        },
                        timeout_seconds: {
                            type: "number",
                            description: "Overpass server query timeout in seconds. Default is 25."
                        },
                        use_area_boundary: {
                            type: "boolean",
                            description: "If true (default), uses exact OSM administrative boundary polygon for named locations when available."
                        }
                    }
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        search_mode: { type: "string" },
                        count_only: { type: "boolean" },
                        matched_place: { type: "string" },
                        alternatives: { type: "array", items: { type: "object" } },
                        osm_area_id: { type: "number" },
                        has_traffic_signal: { type: "boolean" },
                        has_stop_sign: { type: "boolean" },
                        control_type: {
                            type: "string",
                            enum: ["traffic_signals", "stop_sign", "both", "none"]
                        },
                        counts: {
                            type: "object",
                            properties: {
                                traffic_signals: { type: "number" },
                                stop_signs: { type: "number" },
                                total: { type: "number" }
                            },
                            required: ["traffic_signals", "stop_signs", "total"]
                        },
                        distance_from: { type: "object" },
                        route_summary: { type: "object" },
                        traffic_signals: { type: "array", items: { type: "object" } },
                        stop_signs: { type: "array", items: { type: "object" } },
                        returned_counts: {
                            type: "object",
                            properties: {
                                traffic_signals: { type: "number" },
                                stop_signs: { type: "number" },
                                total: { type: "number" }
                            },
                            required: ["traffic_signals", "stop_signs", "total"]
                        },
                        offset: { type: "number" },
                        limit: { type: "number" },
                        truncated: { type: "boolean" },
                        has_more: { type: "boolean" },
                        next_offset: { type: "number" },
                        share_url: { type: "string" },
                        provenance: PROVENANCE_SCHEMA,
                        complete: { type: "boolean" },
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: [
                        "search_mode",
                        "count_only",
                        "has_traffic_signal",
                        "has_stop_sign",
                        "control_type",
                        "counts",
                        "share_url",
                        "provenance",
                        "complete",
                        "warnings"
                    ]
                }
            },
            {
                name: "search_places",
                description:
                    "Query Overture Maps global Places dataset (88M+ POIs merged from Meta, Microsoft, Foursquare, and others) directly via GeoParquet range requests. Returns rich commercial POI metadata often missing in OSM: existence confidence scores (0-1), brand & Wikidata IDs, websites, phones, emails, socials, structured addresses, operating status, taxonomy categories, and contributing data sources. Either 'location' or 'bbox' is required.",
                annotations: {
                    readOnlyHint: true
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        location: {
                            type: "string",
                            description: "Location name to geocode and search within (e.g., 'Times Square, New York'). Combine with radius_meters for circular search or use_area_boundary for strict polygon filtering. Required if bbox is omitted."
                        },
                        bbox: {
                            type: "string",
                            description: "Bounding box ('lat1,lng1,lat2,lng2', WKT, GeoJSON) or single point ('lat,lng'). Required if location is omitted."
                        },
                        query: {
                            type: "string",
                            description: "Case-insensitive text filter matched across place name, brand, category, and address (e.g., 'Starbucks', 'ramen')."
                        },
                        category: {
                            type: "string",
                            description: "Overture Maps category filter matched against basic_category and taxonomy segments (e.g., 'coffee_shop', 'restaurant', 'pharmacy', 'hotel', 'grocery_store')."
                        },
                        radius_meters: {
                            type: "number",
                            description: "Search radius in meters around the location/point center. Defaults to 500 when a single point bbox is provided without radius_meters."
                        },
                        use_area_boundary: {
                            type: "boolean",
                            description: "When true with 'location' (and without radius_meters), clips places strictly to the geocoded area polygon instead of its rectangular bounding box. Defaults to false."
                        },
                        min_confidence: {
                            type: "number",
                            description: "Minimum Overture existence confidence score in [0, 1] (e.g., 0.7). Defaults to 0."
                        },
                        include_closed: {
                            type: "boolean",
                            description: "Whether to include places marked operating_status='permanently_closed'. Defaults to false."
                        },
                        sort_by: {
                            type: "string",
                            enum: ["distance", "confidence"],
                            description: "Sort order for returned places: 'distance' (nearest to center, default) or 'confidence' (highest confidence first)."
                        },
                        limit: {
                            type: "integer",
                            description: "Maximum places to return per page (default 25, max 100). Ignored when count_only is true."
                        },
                        offset: {
                            type: "integer",
                            description: "Zero-based pagination offset into matched places (default 0)."
                        },
                        count_only: {
                            type: "boolean",
                            description: "If true, returns only aggregate counts and category_counts breakdown without individual place records. Defaults to false."
                        }
                    }
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        release: { type: "string", description: "Overture Maps STAC release version queried (e.g., '2026-10-21.0')" },
                        matched_place: { type: "string", description: "Geocoded place name (when location is used)" },
                        bbox: BBOX_OBJ_SCHEMA,
                        query: { type: ["string", "null"] },
                        category: { type: ["string", "null"] },
                        count: { type: "integer", description: "Total number of matching places before pagination" },
                        returned_count: { type: "integer", description: "Number of places returned in this response" },
                        offset: { type: "integer", description: "Pagination offset used" },
                        limit: { type: "integer", description: "Page size limit used" },
                        has_more: { type: "boolean", description: "True if additional pages exist beyond offset + returned_count" },
                        next_offset: { type: ["integer", "null"], description: "Next pagination offset if has_more is true, else null" },
                        truncated: { type: "boolean", description: "True if fewer than all matched places were returned" },
                        complete: { type: "boolean", description: "True if the full spatial query completed and either all results are returned or total count is exact" },
                        stats: {
                            type: "object",
                            properties: {
                                scanned_files: { type: "integer" },
                                scanned_row_groups: { type: "integer" },
                                sort_by: { type: "string" },
                                min_confidence: { type: "number" }
                            }
                        },
                        category_counts: {
                            type: "array",
                            description: "Top categories by matched count",
                            items: {
                                type: "object",
                                properties: {
                                    category: { type: "string" },
                                    count: { type: "integer" }
                                }
                            }
                        },
                        places: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string", description: "Overture GERS place ID" },
                                    name: { type: ["string", "null"] },
                                    basic_category: { type: ["string", "null"] },
                                    primary_category: { type: ["string", "null"] },
                                    alternate_categories: { type: "array", items: { type: "string" } },
                                    category_hierarchy: { type: "array", items: { type: "string" } },
                                    confidence: { type: ["number", "null"] },
                                    operating_status: { type: ["string", "null"] },
                                    brand: {
                                        type: ["object", "null"],
                                        properties: {
                                            name: { type: ["string", "null"] },
                                            wikidata: { type: ["string", "null"] }
                                        }
                                    },
                                    coordinates: {
                                        type: "object",
                                        properties: {
                                            lat: { type: "number" },
                                            lon: { type: "number" }
                                        }
                                    },
                                    distance_meters: { type: "number" },
                                    address: {
                                        type: ["object", "null"],
                                        properties: {
                                            freeform: { type: ["string", "null"] },
                                            locality: { type: ["string", "null"] },
                                            postcode: { type: ["string", "null"] },
                                            region: { type: ["string", "null"] },
                                            country: { type: ["string", "null"] }
                                        }
                                    },
                                    websites: { type: "array", items: { type: "string" } },
                                    phones: { type: "array", items: { type: "string" } },
                                    emails: { type: "array", items: { type: "string" } },
                                    socials: { type: "array", items: { type: "string" } },
                                    sources: { type: "array", items: { type: "string" } },
                                    version: { type: ["integer", "null"] }
                                }
                            }
                        },
                        share_url: { type: "string", description: "Shareable interactive map URL showing matched places" },
                        provenance: PROVENANCE_SCHEMA,
                        warnings: { type: "array", items: { type: "string" } }
                    },
                    required: [
                        "release",
                        "bbox",
                        "count",
                        "returned_count",
                        "places",
                        "category_counts",
                        "share_url",
                        "complete",
                        "provenance",
                        "warnings"
                    ]
                }
            }
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    log('info', `Tool called: ${toolName}`, { arguments: request.params.arguments });

    try {
        if (toolName === "get_bounds") {
            const args = request.params.arguments || {};
            const warnings: string[] = [];
            let bboxObj: BBox;
            let geocodeRes: GeocodeResult | undefined;

            if (args.location) {
                try {
                    geocodeRes = await geocodeLocation(args.location as string);
                    bboxObj = geocodeRes.bbox;
                } catch (err: any) {
                    if (!args.bbox) {
                        log('error', `Geocoding failed for location: ${args.location}`, { error: err.message });
                        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                    }
                    log('warn', `Geocoding failed, falling back to bbox argument`, { error: err.message });
                    bboxObj = parseBBox(args.bbox as string, warnings);
                }
            } else if (args.bbox) {
                bboxObj = parseBBox(args.bbox as string, warnings);
            } else {
                return { content: [{ type: "text", text: "Error: Either 'location' or 'bbox' argument must be provided." }], isError: true };
            }

            const bufferMeters = args.buffer_meters as number | undefined;
            if (typeof bufferMeters === 'number' && bufferMeters !== 0) {
                bboxObj = expandBBoxMeters(bboxObj, bufferMeters);
            }

            let epsg = args.epsg as string || "4326";
            let format = args.format as string || "csv";
            let coordOrder = (args.coord_order as "lng,lat" | "lat,lng") || "lng,lat";
            let zoom = (args.zoom as number) ?? 15;
            let precision = (args.precision as number) ?? 6;

            epsg = epsg.replace(/[^0-9]/g, "");

            await ensureProjection(epsg);

            const projCoords = projectBounds(bboxObj, epsg);
            const WGS84Formatted = getFormattedBox(bboxObj, format, precision, coordOrder);

            const projBbox: BBox = {
                lat1: projCoords.ymin,
                lng1: projCoords.xmin,
                lat2: projCoords.ymax,
                lng2: projCoords.xmax
            };

            const projectedFormatted = getFormattedBox(projBbox, format, precision, coordOrder);
            const shareUrl = buildShareUrl(bboxObj);

            const dims = calculateBboxDimensions(bboxObj);
            const areaKm2 = calculateBboxArea(bboxObj);

            const centerLat = (bboxObj.lat1 + bboxObj.lat2) / 2;
            const centerLng = (bboxObj.lng1 + bboxObj.lng2) / 2;
            const tileIndices = latLngToTile(centerLat, centerLng, zoom);

            log('info', `get_bounds completed`, { epsg, format, area_km2: areaKm2 });

            const geocodeInfo = geocodeRes ? `Matched Place: "${geocodeRes.matched_place}"\n` : '';
            const altInfo = geocodeRes && geocodeRes.alternatives.length > 0
                ? `Alternates: ${geocodeRes.alternatives.map(a => `"${a.matched_place}"`).join(', ')}\n\n`
                : '\n';

            const provenance: ProvenanceMetadata = geocodeRes?.provenance || {
                provider: "offline-proj4",
                data_timestamp: new Date().toISOString(),
                cached: false,
                cache_age_ms: 0
            };

            const structuredData = {
                ...(geocodeRes ? { matched_place: geocodeRes.matched_place, alternatives: geocodeRes.alternatives } : {}),
                original_wgs84: bboxObj,
                projected: projCoords,
                center: {
                    lat: centerLat,
                    lng: centerLng
                },
                tile_indices: tileIndices,
                epsg,
                format,
                coord_order: coordOrder,
                precision,
                area_km2: areaKm2,
                dimensions: {
                    width_km: dims.widthKm,
                    height_km: dims.heightKm
                },
                share_url: shareUrl,
                provenance,
                complete: true,
                warnings
            };

            return {
                content: [
                    {
                        type: "text",
                        text: `${geocodeInfo}${altInfo}Original WGS84 Bounds (${format}):\n${WGS84Formatted}\n\nProjected to EPSG:${epsg} (${format}):\n${projectedFormatted}\n\nArea: ${areaKm2.toFixed(3)} km² (${dims.widthKm.toFixed(3)}km x ${dims.heightKm.toFixed(3)}km)\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    }
                ],
                structuredContent: structuredData
            };
        }

        else if (toolName === "get_h3_indices") {
            const args = request.params.arguments || {};
            const resolution = args.resolution as number;
            const compact = args.compact as boolean || false;
            const summaryOnly = args.summary_only as boolean || false;
            const returnGeometry = args.return_geometry as boolean || false;
            const usePolygonBoundary = args.use_polygon_boundary !== false;
            const warnings: string[] = [];

            if (resolution === undefined) {
                return { content: [{ type: "text", text: "Error: 'resolution' is required." }], isError: true };
            }

            let bboxObj: BBox;
            let geocodeRes: GeocodeResult | undefined;
            let polygonsWithHoles: number[][][][] | null = null;

            if (args.location) {
                try {
                    geocodeRes = await geocodeLocation(args.location as string, usePolygonBoundary);
                    bboxObj = geocodeRes.bbox;
                    if (usePolygonBoundary && geocodeRes.polygons_with_holes) {
                        polygonsWithHoles = geocodeRes.polygons_with_holes;
                    }
                } catch (err: any) {
                    if (!args.bbox) {
                        log('error', `Geocoding failed for H3 location: ${args.location}`, { error: err.message });
                        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                    }
                    bboxObj = parseBBox(args.bbox as string, warnings);
                    if (usePolygonBoundary) {
                        polygonsWithHoles = extractPolygonsWithHolesLatLng(args.bbox as string);
                    }
                }
            } else if (args.bbox) {
                bboxObj = parseBBox(args.bbox as string, warnings);
                if (usePolygonBoundary) {
                    polygonsWithHoles = extractPolygonsWithHolesLatLng(args.bbox as string);
                }
            } else {
                return { content: [{ type: "text", text: "Error: Either 'location' or 'bbox' argument must be provided." }], isError: true };
            }

            const cells = getH3Cells(bboxObj, resolution, compact, polygonsWithHoles);
            const usedPolygon = !!(polygonsWithHoles && polygonsWithHoles.length > 0);
            const mapUrl = usedPolygon && polygonsWithHoles![0]?.[0]?.length >= 3
                ? buildShareUrlPolygon(polygonsWithHoles![0][0])
                : buildShareUrl(bboxObj);
            const shareUrl = appendH3Preview(
                mapUrl, resolution, cells.length, summaryOnly ? cells.slice(0, 10) : cells
            );
            const provenance: ProvenanceMetadata = geocodeRes?.provenance || {
                provider: "offline-h3-js",
                data_timestamp: new Date().toISOString(),
                cached: false,
                cache_age_ms: 0
            };

            log('info', `get_h3_indices completed`, { resolution, compact, summary_only: summaryOnly, cell_count: cells.length, used_polygon: usedPolygon });

            if (summaryOnly) {
                const sampleCells = cells.slice(0, 10);
                const responseData: Record<string, unknown> = {
                    resolution,
                    compact,
                    summary_only: true,
                    used_polygon_boundary: usedPolygon,
                    cell_count: cells.length,
                    sample_cells: sampleCells,
                    original_bbox: bboxObj,
                    share_url: shareUrl,
                    provenance,
                    complete: false,
                    warnings
                };
                return {
                    content: [
                        {
                            type: "text",
                            text: `H3 summary: ${cells.length.toLocaleString()} cells generated at resolution ${resolution} (compacted: ${compact}, polygon_boundary: ${usedPolygon}).\nSample cells: ${sampleCells.join(', ')}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                        }
                    ],
                    structuredContent: responseData
                };
            }

            const responseData: Record<string, unknown> = {
                resolution,
                compact,
                summary_only: false,
                used_polygon_boundary: usedPolygon,
                cell_count: cells.length,
                cells,
                original_bbox: bboxObj,
                share_url: shareUrl,
                provenance,
                complete: true,
                warnings
            };

            if (returnGeometry) {
                responseData.geojson = h3CellsToGeoJSON(cells);
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `H3 cells generated: ${cells.length.toLocaleString()}\nResolution: ${resolution} | Compacted: ${compact} | Polygon boundary: ${usedPolygon}\n\nCells:\n${JSON.stringify(cells)}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    }
                ],
                structuredContent: responseData
            };
        }

        else if (toolName === "generate_share_url") {
            const args = request.params.arguments || {};
            const bbox = args.bbox as string;
            const warnings: string[] = [];

            if (!bbox) {
                return { content: [{ type: "text", text: "Error: 'bbox' is required." }], isError: true };
            }

            const bboxObj = parseBBox(bbox, warnings);
            const shareUrl = buildShareUrl(bboxObj);

            log('info', `generate_share_url completed`, { share_url: shareUrl });

            const structuredData = {
                bbox: bboxObj,
                share_url: shareUrl,
                provenance: {
                    provider: "offline-parser",
                    data_timestamp: new Date().toISOString(),
                    cached: false,
                    cache_age_ms: 0
                },
                complete: true,
                warnings
            };

            return {
                content: [
                    {
                        type: "text",
                        text: `View on map: ${shareUrl}${formatWarnings(warnings)}`
                    }
                ],
                structuredContent: structuredData
            };
        }

        else if (toolName === "reverse_geocode") {
            const args = request.params.arguments || {};
            const lat = args.lat as number;
            const lng = args.lng as number;
            const zoom = (args.zoom as number) ?? 18;

            if (lat === undefined || lng === undefined) {
                return { content: [{ type: "text", text: "Error: Both 'lat' and 'lng' arguments are required." }], isError: true };
            }

            const result = await reverseGeocode(lat, lng, zoom);
            log('info', `reverse_geocode completed`, { lat, lng, matched: result.matched_place });

            return {
                content: [
                    {
                        type: "text",
                        text: `Matched Location: "${result.matched_place}"\nCoordinates: (${result.center.lat.toFixed(5)}, ${result.center.lng.toFixed(5)})\nOSM Details: [${result.osm_type || 'point'}] ${result.osm_id || 'N/A'}\n\nView on map: ${result.share_url}`
                    }
                ],
                structuredContent: result
            };
        }

        else if (toolName === "search_overpass") {
            const args = request.params.arguments || {};
            const queryRaw = typeof args.query === 'string' ? args.query : '';
            const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 100;
            const limit = Math.max(1, Math.min(1000, rawLimit));
            const rawOffset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.floor(args.offset) : 0;
            const offset = Math.max(0, rawOffset);
            const timeoutSec = parseClampedTimeoutSec(args.timeout_seconds, 25);
            const useAreaBoundary = args.use_area_boundary !== false;
            if (args.radius_meters !== undefined && (typeof args.radius_meters !== 'number' || !Number.isFinite(args.radius_meters) || args.radius_meters <= 0)) {
                return { content: [{ type: "text", text: "Error: 'radius_meters' must be a positive finite number." }], isError: true };
            }
            const radiusMeters = args.radius_meters as number | undefined;
            const returnGeometry = args.return_geometry as boolean || false;
            const countOnly = args.count_only as boolean || false;
            const useCircle = typeof radiusMeters === 'number' && radiusMeters > 0;

            if (!queryRaw) {
                return { content: [{ type: "text", text: "Error: 'query' is required (e.g. `node[\"amenity\"=\"restaurant\"]`)." }], isError: true };
            }
            const queryValidationErr = validateOverpassQuery(queryRaw);
            if (queryValidationErr) {
                return { content: [{ type: "text", text: queryValidationErr }], isError: true };
            }

            const warnings: string[] = [];
            let overpassQuery: string;
            let searchModeLabel: string;
            let refPoint: { lat: number; lng: number; description: string };
            let bboxObj: BBox | undefined;
            let geocodeRes: GeocodeResult | undefined;
            let usedAreaId: number | undefined;
            const outDirective = countOnly ? "out count;" : (returnGeometry ? "out geom;" : "out center;");

            if (useCircle) {
                if (args.location) {
                    try {
                        geocodeRes = await geocodeLocation(args.location as string);
                        refPoint = { lat: geocodeRes.center.lat, lng: geocodeRes.center.lng, description: `geocoded center of "${geocodeRes.matched_place}"` };
                    } catch (err: any) {
                        if (args.bbox) {
                            log('warn', `Geocoding failed for radius search, using bbox center`, { error: err.message });
                            const fb = parseBBox(args.bbox as string, warnings);
                            refPoint = { lat: (fb.lat1 + fb.lat2) / 2, lng: (fb.lng1 + fb.lng2) / 2, description: "centroid of provided bounding box" };
                        } else {
                            log('error', `Geocoding failed for radius search: ${args.location}`, { error: err.message });
                            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                        }
                    }
                } else if (args.bbox) {
                    const fb = parseBBox(args.bbox as string, warnings);
                    refPoint = { lat: (fb.lat1 + fb.lat2) / 2, lng: (fb.lng1 + fb.lng2) / 2, description: "centroid of provided bounding box" };
                } else {
                    return { content: [{ type: "text", text: "Error: Either 'location' or 'bbox' argument must be provided." }], isError: true };
                }
                const circleFilter = `(around:${radiusMeters},${refPoint.lat},${refPoint.lng})`;
                const formattedCore = applySpatialFilter(queryRaw, circleFilter);
                overpassQuery = `[out:json][timeout:${timeoutSec}];\n(${formattedCore});\n${outDirective}`;
                searchModeLabel = `circle — ${radiusMeters}m radius around (${refPoint.lat.toFixed(5)}, ${refPoint.lng.toFixed(5)})`;
            } else {
                if (args.location) {
                    try {
                        geocodeRes = await geocodeLocation(args.location as string);
                        bboxObj = geocodeRes.bbox;
                        refPoint = { lat: geocodeRes.center.lat, lng: geocodeRes.center.lng, description: `geocoded centroid of "${geocodeRes.matched_place}"` };
                        if (useAreaBoundary && geocodeRes.osm_area_id) {
                            usedAreaId = geocodeRes.osm_area_id;
                        }
                    } catch (err: any) {
                        if (args.bbox) {
                            log('warn', `Geocoding failed, falling back to bbox argument`, { error: err.message });
                            bboxObj = parseBBox(args.bbox as string, warnings);
                            refPoint = { lat: (bboxObj.lat1 + bboxObj.lat2) / 2, lng: (bboxObj.lng1 + bboxObj.lng2) / 2, description: "centroid of provided bounding box" };
                        } else {
                            log('error', `Geocoding failed for overpass location: ${args.location}`, { error: err.message });
                            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                        }
                    }
                } else if (args.bbox) {
                    bboxObj = parseBBox(args.bbox as string, warnings);
                    refPoint = { lat: (bboxObj.lat1 + bboxObj.lat2) / 2, lng: (bboxObj.lng1 + bboxObj.lng2) / 2, description: "centroid of provided bounding box" };
                } else {
                    return { content: [{ type: "text", text: "Error: Either 'location' or 'bbox' argument must be provided." }], isError: true };
                }

                if (usedAreaId) {
                    const formattedCore = applySpatialFilter(queryRaw, "(area.searchArea)");
                    overpassQuery = `[out:json][timeout:${timeoutSec}];\narea(${usedAreaId})->.searchArea;\n(${formattedCore});\n${outDirective}`;
                    searchModeLabel = `exact OSM boundary area (id: ${usedAreaId}) for "${geocodeRes?.matched_place}"`;
                } else {
                    const formattedCore = applySpatialFilter(queryRaw, "");
                    overpassQuery = `[out:json][timeout:${timeoutSec}][bbox:${bboxObj!.lat1},${bboxObj!.lng1},${bboxObj!.lat2},${bboxObj!.lng2}];\n(${formattedCore});\n${outDirective}`;
                    searchModeLabel = `bounding box`;
                }
            }

            log('info', `search_overpass starting`, { query: queryRaw, mode: useCircle ? 'circle' : (usedAreaId ? 'area' : 'bbox'), radius_meters: radiusMeters, count_only: countOnly, timeoutSec });

            const { data, provenance, remarkWarning } = await executeOverpassQuery(overpassQuery, timeoutSec);
            if (remarkWarning) {
                warnings.push(`Overpass remark: ${remarkWarning}`);
            }

            if (countOnly) {
                const countEl = (data.elements || []).find((e: any) => e.type === "count") || data.elements?.[0] || {};
                const tags = countEl.tags || {};
                const counts = {
                    nodes: parseInt(tags.nodes || "0", 10),
                    ways: parseInt(tags.ways || "0", 10),
                    relations: parseInt(tags.relations || "0", 10),
                    total: parseInt(tags.total || "0", 10)
                };
                const shareUrl = useCircle
                    ? buildShareUrlCircleWithMarkers(refPoint, radiusMeters!, [])
                    : buildShareUrl(bboxObj || geocodeRes!.bbox);
                const countData = {
                    search_mode: useCircle ? 'circle' : (usedAreaId ? 'area' : 'bbox'),
                    count_only: true,
                    ...(geocodeRes ? { matched_place: geocodeRes.matched_place, alternatives: geocodeRes.alternatives } : {}),
                    ...(usedAreaId ? { osm_area_id: usedAreaId } : {}),
                    counts,
                    share_url: shareUrl,
                    provenance,
                    complete: !remarkWarning,
                    warnings
                };
                return {
                    content: [
                        {
                            type: "text",
                            text: `Overpass fast count executed within a ${searchModeLabel}.\nTotal matching elements: ${counts.total.toLocaleString()} (nodes: ${counts.nodes.toLocaleString()}, ways: ${counts.ways.toLocaleString()}, relations: ${counts.relations.toLocaleString()})\n\nView area on map: ${shareUrl}${formatWarnings(warnings)}`
                        }
                    ],
                    structuredContent: countData
                };
            }

            const seenIds = new Set<string>();
            let parsedElements = (data.elements || []).reduce((acc: any[], e: any) => {
                const dedupKey = `${e.type}/${e.id}`;
                if (seenIds.has(dedupKey)) return acc;
                seenIds.add(dedupKey);
                const lat = e.lat ?? e.center?.lat ?? e.geometry?.[0]?.lat;
                const lon = e.lon ?? e.center?.lon ?? e.geometry?.[0]?.lon;
                if (lat !== undefined && lon !== undefined) {
                    const distM = calculateHaversineDistanceMeters(refPoint.lat, refPoint.lng, lat, lon);
                    const cleanTags = sanitizeExternalTags(e.tags || {});
                    const el: any = {
                        id: e.id,
                        type: e.type,
                        name: cleanTags.name || "Unnamed",
                        coordinates: { lat, lon },
                        distance_meters: Math.round(distM * 10) / 10,
                        tags: cleanTags
                    };
                    if (returnGeometry && e.geometry) {
                        el.geometry = e.geometry;
                    }
                    acc.push(el);
                }
                return acc;
            }, []);

            // Deterministic sorting: sort by (distance_meters, type, id) ascending
            const sortByDistance = args.sort_by_distance !== false;
            parsedElements.sort((a: any, b: any) => {
                if (sortByDistance) {
                    const diff = (a.distance_meters ?? 0) - (b.distance_meters ?? 0);
                    if (Math.abs(diff) > 0.001) return diff;
                }
                const typeDiff = (a.type || "").localeCompare(b.type || "");
                if (typeDiff !== 0) return typeDiff;
                return (a.id ?? 0) - (b.id ?? 0);
            });

            if (args.location && useAreaBoundary && !usedAreaId && geocodeRes) {
                warnings.push(`Exact admin boundary polygon unavailable for '${geocodeRes.matched_place}', fell back to bounding box query.`);
            }

            const totalCount = parsedElements.length;
            const pagedElements = parsedElements.slice(offset, offset + limit);
            const truncated = totalCount > offset + limit;
            const hasMore = totalCount > offset + limit;
            const nextOffset = hasMore ? offset + limit : undefined;

            const shareUrl = useCircle
                ? buildShareUrlCircleWithMarkers(refPoint, radiusMeters!, pagedElements)
                : (usedAreaId && !args.bbox && pagedElements.length > 0
                    ? buildShareUrlMarkersOnly(pagedElements)
                    : buildShareUrlWithMarkers(bboxObj || geocodeRes!.bbox, pagedElements));

            log('info', `search_overpass completed`, { total: totalCount, returned: pagedElements.length, offset, limit, truncated, mode: useCircle ? 'circle' : (usedAreaId ? 'area' : 'bbox') });

            const responseData: Record<string, unknown> = {
                search_mode: useCircle ? 'circle' : (usedAreaId ? 'area' : 'bbox'),
                count_only: false,
                ...(geocodeRes ? { matched_place: geocodeRes.matched_place, alternatives: geocodeRes.alternatives } : {}),
                ...(usedAreaId ? { osm_area_id: usedAreaId } : {}),
                distance_from: refPoint,
                ...(data.generator ? { generator: data.generator } : {}),
                ...(data.osm3s ? { osm3s: data.osm3s } : {}),
                elements: pagedElements,
                total_count: totalCount,
                returned_count: pagedElements.length,
                offset,
                limit,
                truncated,
                has_more: hasMore,
                ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
                pagination_hint: hasMore
                    ? `Use offset=${nextOffset} to fetch the next page. Note: Each page re-queries Overpass; for large result sets, consider narrowing your query filters or bounding area instead of deep paging.`
                    : "End of result set.",
                share_url: shareUrl,
                provenance,
                complete: !truncated && !remarkWarning,
                warnings
            };

            const topResults = pagedElements.slice(0, 5)
                .map((e: any) => `- [${e.type}] ${e.name} (${e.coordinates.lat.toFixed(5)}, ${e.coordinates.lon.toFixed(5)}) — ${e.distance_meters}m away`)
                .join('\n');
            const moreNote = pagedElements.length > 5 ? `\n  … and ${pagedElements.length - 5} more on this page` : '';

            return {
                content: [
                    {
                        type: "text",
                        text: `Overpass query executed within a ${searchModeLabel}.\nFound ${totalCount} element${totalCount !== 1 ? 's' : ''}${totalCount > limit ? ` (showing items ${offset + 1}-${offset + pagedElements.length} of ${totalCount})` : ''}.\nDistance measured from: ${refPoint.description}\n\nTop results:\n${topResults}${moreNote}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    }
                ],
                structuredContent: responseData
            };
        }

        else if (toolName === "list_osm_tags") {
            const args = request.params.arguments || {};
            const category = (args.category as string || "").toLowerCase().trim();
            const warnings: string[] = [];

            let recommendations = "";
            let source: "built-in" | "taginfo" = "built-in";
            let tags: string[] = [];
            let provenance: ProvenanceMetadata = {
                provider: "built-in-osm-tag-index",
                data_timestamp: new Date().toISOString(),
                cached: true,
                cache_age_ms: 0
            };

            switch (true) {
                case category.includes('food') || category.includes('restaurant') || category.includes('cafe') || category.includes('pizza') || category.includes('dining'):
                    recommendations = `Restaurants: nwr["amenity"="restaurant"]\nFast Food: nwr["amenity"="fast_food"]\nCafes: nwr["amenity"="cafe"]\nBars: nwr["amenity"="bar"]\nPubs: nwr["amenity"="pub"]\nIce Cream: nwr["amenity"="ice_cream"]\nCoffee Shops: nwr["shop"="coffee"]\nBakeries: nwr["shop"="bakery"]`;
                    break;
                case category.includes('health') || category.includes('medical') || category.includes('doctor') || category.includes('hospital') || category.includes('pharmacy'):
                    recommendations = `Hospitals: nwr["amenity"="hospital"]\nClinics: nwr["amenity"="clinic"]\nPharmacies: nwr["amenity"="pharmacy"]\nDoctors: nwr["amenity"="doctors"]\nDentists: nwr["amenity"="dentist"]\nGeneral Healthcare: nwr["healthcare"]`;
                    break;
                case category.includes('transport') || category.includes('transit') || category.includes('bus') || category.includes('train') || category.includes('subway') || category.includes('gas') || category.includes('fuel') || category.includes('parking') || category.includes('airport') || category.includes('taxi'):
                    recommendations = `Parking: nwr["amenity"="parking"]\nBus Stops: nwr["highway"="bus_stop"]\nSubway Stations: nwr["railway"="station"]["station"="subway"]\nTrain Stations: nwr["railway"="station"]\nBicycle Parking: nwr["amenity"="bicycle_parking"]\nGas Stations: nwr["amenity"="fuel"]\nFerry Terminals: nwr["amenity"="ferry_terminal"]\nAerodromes: nwr["aeroway"="aerodrome"]\nTaxi Stands: nwr["amenity"="taxi"]`;
                    break;
                case category.includes('leisure') || category.includes('park') || category.includes('playground') || category.includes('theatre') || category.includes('cinema'):
                    recommendations = `Parks: nwr["leisure"="park"]\nPlaygrounds: nwr["leisure"="playground"]\nTheatres: nwr["amenity"="theatre"]\nCinemas: nwr["amenity"="cinema"]\nSports Centres: nwr["leisure"="sports_centre"]`;
                    break;
                case category.includes('retail') || category.includes('shop') || category.includes('store') || category.includes('supermarket') || category.includes('mall'):
                    recommendations = `Supermarkets: nwr["shop"="supermarket"]\nConvenience Stores: nwr["shop"="convenience"]\nMalls: nwr["shop"="mall"]\nClothes Shops: nwr["shop"="clothes"]\nBakeries: nwr["shop"="bakery"]\nAlcohol Shops: nwr["shop"="alcohol"]\nHairdressers: nwr["shop"="hairdresser"]\nLaundries: nwr["shop"="laundry"]`;
                    break;
                case category.includes('education') || category.includes('school') || category.includes('university') || category.includes('college') || category.includes('library'):
                    recommendations = `Schools: nwr["amenity"="school"]\nUniversities: nwr["amenity"="university"]\nColleges: nwr["amenity"="college"]\nKindergartens: nwr["amenity"="kindergarten"]\nLibraries: nwr["amenity"="library"]`;
                    break;
                case category.includes('tourism') || category.includes('hotel') || category.includes('motel') || category.includes('hostel') || category.includes('museum') || category.includes('attraction'):
                    recommendations = `Hotels: nwr["tourism"="hotel"]\nMotels: nwr["tourism"="motel"]\nHostels: nwr["tourism"="hostel"]\nAttractions: nwr["tourism"="attraction"]\nMuseums: nwr["tourism"="museum"]\nGuest Houses: nwr["tourism"="guest_house"]\nApartments: nwr["tourism"="apartment"]\nCampsites: nwr["tourism"="camp_site"]`;
                    break;
                case category.includes('finance') || category.includes('bank') || category.includes('atm') || category.includes('post') || category.includes('police') || category.includes('fire') || category.includes('embassy'):
                    recommendations = `Banks: nwr["amenity"="bank"]\nATMs: nwr["amenity"="atm"]\nPost Offices: nwr["amenity"="post_office"]\nPolice: nwr["amenity"="police"]\nFire Stations: nwr["amenity"="fire_station"]\nCourthouses: nwr["amenity"="courthouse"]\nEmbassies: nwr["office"="diplomatic"]`;
                    break;
                case category.includes('fitness') || category.includes('sport') || category.includes('gym') || category.includes('swimming') || category.includes('pool') || category.includes('stadium') || category.includes('golf') || category.includes('climbing'):
                    recommendations = `Gyms: nwr["leisure"="fitness_centre"]\nSwimming Pools: nwr["leisure"="swimming_pool"]\nStadiums: nwr["leisure"="stadium"]\nSports Pitches: nwr["leisure"="pitch"]\nGolf Courses: nwr["leisure"="golf_course"]\nClimbing: nwr["sport"="climbing"]`;
                    break;
                case category.includes('nature') || category.includes('outdoor') || category.includes('forest') || category.includes('water') || category.includes('beach') || category.includes('peak') || category.includes('viewpoint') || category.includes('hike') || category.includes('trail'):
                    recommendations = `Forests: nwr["landuse"="forest"]\nWater Bodies: nwr["natural"="water"]\nBeaches: nwr["natural"="beach"]\nPeaks: nwr["natural"="peak"]\nViewpoints: nwr["tourism"="viewpoint"]\nNature Reserves: nwr["leisure"="nature_reserve"]\nPicnic Sites: nwr["tourism"="picnic_site"]\nHiking Trails: way["highway"="path"]["sac_scale"]`;
                    break;
                case category.includes('religion') || category.includes('worship') || category.includes('church') || category.includes('mosque') || category.includes('synagogue') || category.includes('temple') || category.includes('cemetery'):
                    recommendations = `Places of Worship: nwr["amenity"="place_of_worship"]\nChurches: nwr["amenity"="place_of_worship"]["religion"="christian"]\nMosques: nwr["amenity"="place_of_worship"]["religion"="muslim"]\nSynagogues: nwr["amenity"="place_of_worship"]["religion"="jewish"]\nTemples: nwr["amenity"="place_of_worship"]["religion"~"buddhist|hindu"]\nCemeteries: nwr["landuse"="cemetery"]`;
                    break;
                case category.includes('ev') || category.includes('automotive') || category.includes('car') || category.includes('charging') || category.includes('mechanic') || category.includes('rental'):
                    recommendations = `EV Charging: nwr["amenity"="charging_station"]\nCar Repair: nwr["shop"="car_repair"]\nCar Dealers: nwr["shop"="car"]\nCar Wash: nwr["amenity"="car_wash"]\nCar Rental: nwr["amenity"="car_rental"]\nDriving Schools: nwr["amenity"="driving_school"]`;
                    break;
                case category.includes('nightlife') || category.includes('nightclub') || category.includes('casino') || category.includes('arcade') || category.includes('bowling') || category.includes('escape'):
                    recommendations = `Nightclubs: nwr["amenity"="nightclub"]\nCasinos: nwr["amenity"="casino"]\nArcades: nwr["leisure"="amusement_arcade"]\nBowling Alleys: nwr["leisure"="bowling_alley"]\nEscape Rooms: nwr["leisure"="escape_game"]`;
                    break;
                case category.includes('utility') || category.includes('toilet') || category.includes('water') || category.includes('bench') || category.includes('waste') || category.includes('recycling') || category.includes('shower') || category.includes('locker'):
                    recommendations = `Toilets: nwr["amenity"="toilets"]\nDrinking Water: nwr["amenity"="drinking_water"]\nBenches: nwr["amenity"="bench"]\nWaste Baskets: nwr["amenity"="waste_basket"]\nRecycling: nwr["amenity"="recycling"]\nPublic Showers: nwr["amenity"="shower"]\nLockers: nwr["amenity"="locker"]`;
                    break;
                case category.includes('work') || category.includes('office') || category.includes('coworking') || category.includes('conference'):
                    recommendations = `Coworking Spaces: nwr["office"="coworking"]; nwr["amenity"="coworking_space"];\nGeneral Offices: nwr["office"]\nConference Centres: nwr["amenity"="conference_centre"]`;
                    break;
                case category.includes('pet') || category.includes('dog') || category.includes('vet') || category.includes('zoo') || category.includes('animal'):
                    recommendations = `Dog Parks: nwr["leisure"="dog_park"]\nVeterinarians: nwr["amenity"="veterinary"]\nPet Shops: nwr["shop"="pet"]\nZoos: nwr["tourism"="zoo"]`;
                    break;
                case category.includes('childcare') || category.includes('daycare') || category.includes('child'):
                    recommendations = `Childcare/Daycare: nwr["amenity"="childcare"]\nPlaygrounds: nwr["leisure"="playground"]`;
                    break;
                case category.includes('traffic') || category.includes('signal') || category.includes('stop') || category.includes('junction') || category.includes('intersection'):
                    recommendations = `Traffic Signals: nwr["highway"="traffic_signals"]\nStop Signs: nwr["highway"="stop"]\nYield / Give Way Signs: nwr["highway"="give_way"]\nSignalized Crossings: nwr["highway"="crossing"]["crossing"="traffic_signals"]\nTraffic Signals & Stop Signs: nwr["highway"~"^(traffic_signals|stop)$"]`;
                    break;
                default: {
                    log('info', `Category '${category}' not in index, querying Taginfo API`);
                    source = "taginfo";
                    const taginfoRes = await getTaginfoSuggestions(category);
                    recommendations = taginfoRes.text;
                    tags = taginfoRes.tags;
                    if (taginfoRes.warning) warnings.push(taginfoRes.warning);
                    provenance = {
                        provider: "taginfo (https://taginfo.openstreetmap.org)",
                        attribution: OSM_ATTRIBUTION,
                        data_timestamp: taginfoRes.timestamp,
                        cached: taginfoRes.cached,
                        cache_age_ms: taginfoRes.cache_age_ms
                    };
                    break;
                }
            }

            if (source === "built-in") {
                const matches = recommendations.match(/(?:nwr|node|way|relation)\[[^\n;]+/g);
                tags = matches ? matches.map(m => m.trim()) : [];
            }

            return {
                content: [{
                    type: "text",
                    text: `OSM Tag Recommendations for '${category}':\n\n${recommendations}\n\nTip: You can use these tag selectors directly in the 'query' argument of search_overpass.`
                }],
                structuredContent: {
                    category,
                    source,
                    tags,
                    recommendations_text: recommendations,
                    provenance,
                    complete: warnings.length === 0,
                    warnings
                }
            };
        }

        else if (toolName === "aggregate_overpass_h3") {
            const args = request.params.arguments || {};
            const queryRaw = typeof args.query === 'string' ? args.query : '';
            const resolution = (args.resolution as number) ?? 8;
            const timeoutSec = parseClampedTimeoutSec(args.timeout_seconds, 25);
            const useAreaBoundary = args.use_area_boundary !== false;
            if (args.radius_meters !== undefined && (typeof args.radius_meters !== 'number' || !Number.isFinite(args.radius_meters) || args.radius_meters <= 0)) {
                return { content: [{ type: "text", text: "Error: 'radius_meters' must be a positive finite number." }], isError: true };
            }
            const radiusMeters = args.radius_meters as number | undefined;
            const useCircle = typeof radiusMeters === 'number' && radiusMeters > 0;
            const warnings: string[] = [];

            if (!queryRaw) {
                return { content: [{ type: "text", text: "Error: 'query' is required." }], isError: true };
            }
            const queryValidationErr = validateOverpassQuery(queryRaw);
            if (queryValidationErr) {
                return { content: [{ type: "text", text: queryValidationErr }], isError: true };
            }

            if (resolution < 0 || resolution > 15 || !Number.isInteger(resolution)) {
                return { content: [{ type: "text", text: `Error: Invalid H3 resolution: ${resolution}. Must be 0-15.` }], isError: true };
            }

            let bboxObj: BBox;
            let geocodeRes: GeocodeResult | undefined;
            let usedAreaId: number | undefined;

            if (args.location) {
                try {
                    geocodeRes = await geocodeLocation(args.location as string);
                    bboxObj = geocodeRes.bbox;
                    if (useAreaBoundary && geocodeRes.osm_area_id) {
                        usedAreaId = geocodeRes.osm_area_id;
                    }
                } catch (err: any) {
                    if (!args.bbox) {
                        return { content: [{ type: "text", text: `Error: Geocoding failed: ${err.message}` }], isError: true };
                    }
                    bboxObj = parseBBox(args.bbox as string, warnings);
                }
            } else if (args.bbox) {
                bboxObj = parseBBox(args.bbox as string, warnings);
            } else {
                return { content: [{ type: "text", text: "Error: Either 'location' or 'bbox' argument must be provided." }], isError: true };
            }

            log('info', `aggregate_overpass_h3 starting`, { query: queryRaw, resolution, timeoutSec, mode: useCircle ? 'circle' : (usedAreaId ? 'area' : 'bbox') });

            let overpassQuery: string;
            const centerPt = geocodeRes?.center || { lat: (bboxObj.lat1 + bboxObj.lat2) / 2, lng: (bboxObj.lng1 + bboxObj.lng2) / 2 };

            if (useCircle) {
                const circleFilter = `(around:${radiusMeters},${centerPt.lat},${centerPt.lng})`;
                const formattedCore = applySpatialFilter(queryRaw, circleFilter);
                overpassQuery = `[out:json][timeout:${timeoutSec}];\n(${formattedCore});\nout center;`;
            } else if (usedAreaId) {
                const formattedCore = applySpatialFilter(queryRaw, "(area.searchArea)");
                overpassQuery = `[out:json][timeout:${timeoutSec}];\narea(${usedAreaId})->.searchArea;\n(${formattedCore});\nout center;`;
            } else {
                const formattedCore = applySpatialFilter(queryRaw, "");
                overpassQuery = `[out:json][timeout:${timeoutSec}][bbox:${bboxObj.lat1},${bboxObj.lng1},${bboxObj.lat2},${bboxObj.lng2}];\n(${formattedCore});\nout center;`;
            }

            let execResult: OverpassExecutionResult;
            try {
                execResult = await executeOverpassQuery(overpassQuery, timeoutSec);
            } catch (err: any) {
                return { content: [{ type: "text", text: `Error: Overpass query failed: ${err.message}` }], isError: true };
            }

            const { data, provenance, remarkWarning } = execResult;
            if (remarkWarning) {
                warnings.push(`Overpass remark: ${remarkWarning}`);
            }

            let rawElements = data.elements || [];

            const hexCounts: Record<string, number> = {};
            const hexElements: Record<string, any[]> = {};

            const seenIds = new Set<string>();
            rawElements.forEach((e: any) => {
                const dedupKey = `${e.type}/${e.id}`;
                if (seenIds.has(dedupKey)) return;
                seenIds.add(dedupKey);

                const lat = e.lat ?? e.center?.lat;
                const lon = e.lon ?? e.center?.lon;

                if (lat !== undefined && lon !== undefined) {
                    const h3Index = h3.latLngToCell(lat, lon, resolution);
                    hexCounts[h3Index] = (hexCounts[h3Index] || 0) + 1;

                    if (!hexElements[h3Index]) hexElements[h3Index] = [];
                    hexElements[h3Index].push({
                        id: e.id,
                        name: sanitizeExternalText(e.tags?.name, 200) || "Unnamed"
                    });
                }
            });

            const totalGrouped = Object.values(hexCounts).reduce((a, b) => a + b, 0);
            const activeHexes = Object.keys(hexCounts);
            const geojson = h3CellsToGeoJSON(activeHexes);

            (geojson as any).features.forEach((f: any) => {
                const cellId = f.properties.h3_index;
                f.properties.count = hexCounts[cellId];
                f.properties.elements = hexElements[cellId];
            });

            const topHexes = Object.entries(hexCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);

            // Plot the top hex hotspot centroids as pins on the verification map!
            const hotspotMarkers = topHexes.map(([hex, count], idx) => {
                const [lat, lon] = h3.cellToLatLng(hex);
                return {
                    coordinates: { lat, lon },
                    name: `#${idx + 1} (${count} items)`
                };
            });

            const mapUrl = useCircle
                ? buildShareUrlCircleWithMarkers(centerPt, radiusMeters!, hotspotMarkers)
                : (hotspotMarkers.length > 0
                    ? (usedAreaId && !args.bbox
                        ? buildShareUrlMarkersOnly(hotspotMarkers)
                        : buildShareUrlWithMarkers(bboxObj, hotspotMarkers))
                    : buildShareUrl(bboxObj));

            const densestCells = Object.keys(hexCounts).sort((a, b) => hexCounts[b] - hexCounts[a]);
            const shareUrl = appendResultMetadata(
                appendH3Preview(mapUrl, resolution, activeHexes.length, densestCells, hexCounts),
                { source: "OpenStreetMap contributors · H3", warnings }
            );
            log('info', `aggregate_overpass_h3 completed`, { resolution, elements: totalGrouped, activeHexes: activeHexes.length });

            const responseData = {
                resolution,
                ...(geocodeRes ? { matched_place: geocodeRes.matched_place, alternatives: geocodeRes.alternatives } : {}),
                ...(usedAreaId ? { osm_area_id: usedAreaId } : {}),
                total_elements: totalGrouped,
                active_hex_count: activeHexes.length,
                hex_counts: hexCounts,
                hex_geojson: geojson,
                original_bbox: bboxObj,
                share_url: shareUrl,
                provenance,
                complete: !remarkWarning,
                warnings
            };

            return {
                content: [
                    {
                        type: "text",
                        text: `Aggregated ${totalGrouped} element${totalGrouped !== 1 ? 's' : ''} into ${activeHexes.length} H3 hexagon${activeHexes.length !== 1 ? 's' : ''} at resolution ${resolution}.\n\nTop hexagons by density:\n${topHexes.map(([hex, count]) => `- ${hex}: ${count} element${count !== 1 ? 's' : ''}`).join('\n')}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    }
                ],
                structuredContent: responseData
            };
        }

        else if (toolName === "calculate_route") {
            const args = request.params.arguments || {};
            const originInput = (args.origin as string || "").trim();
            const destInput = (args.destination as string || "").trim();
            const profile = (args.profile as "driving" | "walking" | "cycling") || "driving";
            const returnSteps = args.return_steps as boolean || false;
            const requestAlternatives = args.alternatives === true;
            const rawWaypoints = Array.isArray(args.waypoints) ? args.waypoints as string[] : undefined;
            const warnings: string[] = [];

            if (!originInput || !destInput) {
                return { content: [{ type: "text", text: "Error: Both 'origin' and 'destination' are required." }], isError: true };
            }
            if (args.waypoints !== undefined && !Array.isArray(args.waypoints)) {
                return { content: [{ type: "text", text: "Error: 'waypoints' must be an array of 'lat,lng' or place name strings." }], isError: true };
            }

            let routeRes;
            try {
                routeRes = await fetchOsrmRoute(originInput, destInput, profile, returnSteps, warnings, {
                    waypoints: rawWaypoints,
                    alternatives: requestAlternatives
                });
            } catch (err: any) {
                return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
            }

            const {
                start,
                end,
                waypoints: resolvedWaypoints,
                geomCoords,
                routeGeometry,
                routeBBox,
                distanceMeters,
                distanceKm,
                durationSeconds,
                durationMinutes,
                straightLineMeters,
                detourFactor,
                steps,
                shareUrl,
                alternatives: altRoutes,
                bearing,
                provenance
            } = routeRes;

            const formattedAlternatives = requestAlternatives
                ? altRoutes.map((alt, idx) => ({
                    index: idx + 1,
                    distance_meters: alt.distanceMeters,
                    distance_km: alt.distanceKm,
                    duration_seconds: alt.durationSeconds,
                    duration_minutes: alt.durationMinutes,
                    detour_factor: alt.detourFactor,
                    route_bbox: alt.routeBBox,
                    route_geometry: alt.routeGeometry,
                    ...(alt.steps ? { steps: alt.steps } : {}),
                    share_url: alt.shareUrl
                }))
                : undefined;

            const resultPayload = {
                profile,
                origin: start,
                destination: end,
                ...(resolvedWaypoints.length > 0 ? { waypoints: resolvedWaypoints } : {}),
                distance_meters: distanceMeters,
                distance_km: distanceKm,
                duration_seconds: durationSeconds,
                duration_minutes: durationMinutes,
                straight_line_meters: Math.round(straightLineMeters * 10) / 10,
                detour_factor: detourFactor,
                initial_bearing: bearing,
                route_bbox: routeBBox,
                route_geometry: routeGeometry,
                ...(steps ? { steps } : {}),
                ...(formattedAlternatives !== undefined
                    ? { alternatives_count: formattedAlternatives.length, alternatives: formattedAlternatives }
                    : {}),
                share_url: shareUrl,
                provenance,
                complete: true,
                warnings
            };

            const viaText = resolvedWaypoints.length > 0
                ? `\nVia: ${resolvedWaypoints.map(w => w.label).join(' → ')}`
                : '';
            const altText = formattedAlternatives !== undefined
                ? (formattedAlternatives.length > 0
                    ? `\n\nAlternative routes (${formattedAlternatives.length}):\n` + formattedAlternatives
                        .map(a => `- Alt ${a.index}: ${a.distance_km} km (${a.duration_minutes} min) — ${a.share_url}`)
                        .join('\n')
                    : `\n\nAlternative routes: OSRM found no qualifying alternatives for this pair.`)
                : '';

            return {
                content: [
                    {
                        type: "text",
                        text: `Route (${profile}): ${start.label} → ${end.label}${viaText}\nDistance: ${(distanceMeters / 1000).toFixed(2)} km (${distanceMeters.toLocaleString()} m) | Straight-line: ${(straightLineMeters / 1000).toFixed(2)} km (detour factor: ${detourFactor}x)\nEstimated Duration: ${durationMinutes} min (${durationSeconds} s)\nInitial Bearing: ${bearing.degrees}° (${bearing.cardinal})\nGeometry: LineString (${geomCoords.length} vertices)\n\nView route on map: ${shareUrl}${altText}${formatWarnings(warnings)}`
                    }
                ],
                structuredContent: resultPayload
            };
        }

        else if (toolName === "get_elevation") {
            const args = request.params.arguments || {};
            const warnings: string[] = [];

            const explicitMode = typeof args.mode === 'string' ? args.mode.trim() : undefined;
            if (explicitMode !== undefined && !["points", "grid", "line_of_sight", "profile"].includes(explicitMode)) {
                return {
                    content: [{ type: "text", text: `Error: Unknown get_elevation mode '${explicitMode}'. Supported: points, grid, line_of_sight, profile.` }],
                    isError: true
                };
            }

            let mode: "points" | "grid" | "line_of_sight" | "profile";
            if (explicitMode) {
                mode = explicitMode as "points" | "grid" | "line_of_sight" | "profile";
            } else if (args.observer_height_meters !== undefined || args.target_height_meters !== undefined) {
                mode = "line_of_sight";
            } else if (args.route_geometry !== undefined) {
                mode = "profile";
            } else if (args.origin !== undefined && args.destination !== undefined) {
                mode = "line_of_sight";
            } else {
                mode = "points";
            }

            const makeProvenance = (elevRes: Awaited<ReturnType<typeof fetchElevationsBatch>>): ProvenanceMetadata => ({
                provider: `open-meteo-copernicus-dem-90m (${elevRes.elevationBase})`,
                attribution: "Copernicus DEM GLO-90 via Open-Meteo (https://open-meteo.com/)",
                data_timestamp: elevRes.dataTimestamp,
                cached: elevRes.cached,
                cache_age_ms: elevRes.cacheAgeMs,
                usage_policy: "https://open-meteo.com/en/terms (Hosted API is free for non-commercial use only; commercial use requires a paid API subscription or self-hosted ELEVATION_API_URL)"
            });

            if (mode === "line_of_sight") {
                const observerHeight = args.observer_height_meters !== undefined ? Number(args.observer_height_meters) : 1.7;
                const targetHeight = args.target_height_meters !== undefined ? Number(args.target_height_meters) : 0;
                const refractionK = args.refraction_coefficient !== undefined ? Number(args.refraction_coefficient) : 0.13;
                const sampleCount = Math.max(5, Math.min(100, Math.round((args.sample_count as number) ?? 25)));

                if (!Number.isFinite(observerHeight) || observerHeight < 0) {
                    return { content: [{ type: "text", text: "Error: 'observer_height_meters' must be a non-negative number." }], isError: true };
                }
                if (!Number.isFinite(targetHeight) || targetHeight < 0) {
                    return { content: [{ type: "text", text: "Error: 'target_height_meters' must be a non-negative number." }], isError: true };
                }
                if (!Number.isFinite(refractionK) || refractionK < -1 || refractionK > 1) {
                    return { content: [{ type: "text", text: "Error: 'refraction_coefficient' must be between -1 and 1." }], isError: true };
                }

                let start: { lat: number; lng: number; label: string };
                let end: { lat: number; lng: number; label: string };

                if (args.origin !== undefined || args.destination !== undefined) {
                    if (typeof args.origin !== 'string' || !args.origin.trim() || typeof args.destination !== 'string' || !args.destination.trim()) {
                        return { content: [{ type: "text", text: "Error: Both 'origin' and 'destination' must be provided for line_of_sight." }], isError: true };
                    }
                    start = await resolveRouteEndpoint(args.origin.trim(), warnings);
                    end = await resolveRouteEndpoint(args.destination.trim(), warnings);
                } else if (Array.isArray(args.points) && args.points.length >= 2) {
                    const p0 = args.points[0] as any;
                    const p1 = args.points[1] as any;
                    const lat0 = Number(p0.lat), lng0 = Number(p0.lng);
                    const lat1 = Number(p1.lat), lng1 = Number(p1.lng);
                    if (!validateBBox(lat0, lng0, lat0, lng0) || !validateBBox(lat1, lng1, lat1, lng1)) {
                        return { content: [{ type: "text", text: "Error: Invalid coordinates in 'points' for line_of_sight." }], isError: true };
                    }
                    if (args.points.length > 2) {
                        warnings.push("More than 2 points supplied for line_of_sight; using points[0] as observer and points[1] as target.");
                    }
                    start = { lat: lat0, lng: lng0, label: p0.label || "Observer" };
                    end = { lat: lat1, lng: lng1, label: p1.label || "Target" };
                } else if (args.bbox) {
                    const b = parseBBox(args.bbox as string, warnings);
                    start = { lat: b.lat1, lng: b.lng1, label: "SW Observer" };
                    end = { lat: b.lat2, lng: b.lng2, label: "NE Target" };
                } else {
                    return { content: [{ type: "text", text: "Error: Provide 'origin' + 'destination', two 'points', or 'bbox' for mode='line_of_sight'." }], isError: true };
                }

                const inv = geodesicInverseWGS84(start.lat, start.lng, end.lat, end.lng);
                if (inv.distanceMeters < 1) {
                    return { content: [{ type: "text", text: "Error: Observer and target must be at least 1 meter apart for line_of_sight." }], isError: true };
                }

                const geoPoints = sampleGeodesicPoints(start.lat, start.lng, end.lat, end.lng, sampleCount);
                const elevRes = await fetchElevationsBatch(geoPoints);

                const validIndices: number[] = [];
                for (let i = 0; i < geoPoints.length; i++) {
                    if (typeof elevRes.elevations[i] === 'number' && Number.isFinite(elevRes.elevations[i])) {
                        validIndices.push(i);
                    }
                }
                if (!validIndices.includes(0) || !validIndices.includes(geoPoints.length - 1) || validIndices.length < 3) {
                    return { content: [{ type: "text", text: "Error: Incomplete elevation data returned for line_of_sight endpoints." }], isError: true };
                }

                const rEff = WGS84_A / (1 - refractionK);
                const obsGround = elevRes.elevations[0];
                const tgtGround = elevRes.elevations[geoPoints.length - 1];
                const obsTotal = obsGround + observerHeight;
                const tgtTotal = tgtGround + targetHeight;

                const samples = validIndices.map((idx) => {
                    const pt = geoPoints[idx];
                    const d = pt.distanceMeters;
                    const f = pt.fraction;
                    const curvDrop = (d * (inv.distanceMeters - d)) / (2 * rEff);
                    const rayElev = obsTotal + f * (tgtTotal - obsTotal) - curvDrop;
                    const groundElev = elevRes.elevations[idx];
                    const clearance = rayElev - groundElev;

                    const label = idx === 0
                        ? start.label
                        : idx === geoPoints.length - 1
                            ? end.label
                            : `LOS (${roundTo(d / 1000, 2)}km)`;

                    return {
                        label,
                        lat: roundTo(pt.lat, 6),
                        lng: roundTo(pt.lng, 6),
                        elevation_meters: roundTo(groundElev, 2),
                        distance_from_origin_meters: roundTo(d, 1),
                        fraction: roundTo(f, 4),
                        curvature_drop_meters: roundTo(curvDrop, 2),
                        ray_elevation_meters: roundTo(rayElev, 2),
                        clearance_meters: roundTo(clearance, 2)
                    };
                });

                const intermediate = samples.slice(1, -1);
                let limitingSample = intermediate[0];
                for (const s of intermediate) {
                    if (s.clearance_meters < limitingSample.clearance_meters) {
                        limitingSample = s;
                    }
                }
                const isVisible = intermediate.every(s => s.clearance_meters > 0);
                const minClearance = limitingSample.clearance_meters;
                const maxObstruction = minClearance < 0 ? roundTo(-minClearance, 2) : 0;
                const apparentTargetDelta = tgtTotal - obsTotal - (inv.distanceMeters * inv.distanceMeters) / (2 * rEff);
                const elevAngleDeg = Math.atan2(apparentTargetDelta, inv.distanceMeters) * RAD_TO_DEG;
                const radioHorizonKm = (Math.sqrt(2 * rEff * observerHeight) + Math.sqrt(2 * rEff * targetHeight)) / 1000;

                warnings.push(`Line-of-sight sampled ${samples.length} points over a 90m bare-earth DEM (Copernicus DEM GLO-90); buildings, vegetation, and sub-grid terrain ridges are not modeled.`);

                const { sampleStats } = summarizeElevationSamples(samples, true);
                const lats = samples.map(s => s.lat);
                const lngs = samples.map(s => s.lng);
                const displayBBox = ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));
                const markers = [
                    { coordinates: { lat: samples[0].lat, lon: samples[0].lng }, name: `${start.label}: ${roundTo(obsTotal, 1)}m` },
                    {
                        coordinates: { lat: limitingSample.lat, lon: limitingSample.lng },
                        name: isVisible
                            ? `Tightest Clearance (+${minClearance}m)`
                            : `Blocked (-${maxObstruction}m)`
                    },
                    { coordinates: { lat: samples[samples.length - 1].lat, lon: samples[samples.length - 1].lng }, name: `${end.label}: ${roundTo(tgtTotal, 1)}m` }
                ];
                const shareUrl = buildShareUrlWithRoute(
                    displayBBox,
                    [[start.lng, start.lat], [end.lng, end.lat]],
                    markers
                );

                const lineOfSight = {
                    origin: {
                        lat: samples[0].lat,
                        lng: samples[0].lng,
                        label: start.label,
                        ground_elevation_meters: roundTo(obsGround, 2),
                        height_above_ground_meters: roundTo(observerHeight, 2),
                        total_elevation_meters: roundTo(obsTotal, 2)
                    },
                    destination: {
                        lat: samples[samples.length - 1].lat,
                        lng: samples[samples.length - 1].lng,
                        label: end.label,
                        ground_elevation_meters: roundTo(tgtGround, 2),
                        height_above_ground_meters: roundTo(targetHeight, 2),
                        total_elevation_meters: roundTo(tgtTotal, 2)
                    },
                    distance_meters: roundTo(inv.distanceMeters, 1),
                    distance_km: roundTo(inv.distanceMeters / 1000, 3),
                    initial_bearing_degrees: roundTo(inv.initialBearingDegrees, 2),
                    refraction_coefficient: refractionK,
                    effective_earth_radius_meters: Math.round(rEff),
                    is_visible: isVisible,
                    min_clearance_meters: minClearance,
                    max_obstruction_meters: maxObstruction,
                    limiting_point: {
                        lat: limitingSample.lat,
                        lng: limitingSample.lng,
                        distance_from_origin_meters: limitingSample.distance_from_origin_meters,
                        terrain_elevation_meters: limitingSample.elevation_meters,
                        ray_elevation_meters: limitingSample.ray_elevation_meters,
                        clearance_meters: limitingSample.clearance_meters
                    },
                    elevation_angle_degrees: roundTo(elevAngleDeg, 3),
                    radio_horizon_km: roundTo(radioHorizonKm, 2)
                };

                const responseData = {
                    mode: "line_of_sight",
                    dem_resolution_meters: 90,
                    sample_count: samples.length,
                    sample_stats: sampleStats,
                    samples,
                    line_of_sight: lineOfSight,
                    bbox: displayBBox,
                    share_url: shareUrl,
                    provenance: makeProvenance(elevRes),
                    complete: true,
                    warnings
                };

                const verdict = isVisible
                    ? `CLEAR (min clearance +${minClearance} m at ${(limitingSample.distance_from_origin_meters / 1000).toFixed(2)} km)`
                    : `BLOCKED (max obstruction ${maxObstruction} m at ${limitingSample.lat}, ${limitingSample.lng}, ${(limitingSample.distance_from_origin_meters / 1000).toFixed(2)} km from origin)`;

                return {
                    content: [{
                        type: "text",
                        text: `3D Line of Sight (${samples.length} samples, k=${refractionK}): ${start.label} → ${end.label}\n- Status: ${verdict}\n- Geodesic Distance: ${lineOfSight.distance_km} km | Elevation Angle: ${lineOfSight.elevation_angle_degrees}° | Radio Horizon: ${lineOfSight.radio_horizon_km} km\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    }],
                    structuredContent: responseData
                };
            }

            if (mode === "profile") {
                const sampleCount = Math.max(5, Math.min(100, Math.round((args.sample_count as number) ?? 25)));
                let pathCoordsLngLat: number[][];

                if (args.route_geometry !== undefined) {
                    pathCoordsLngLat = parseRouteCoordinates(args.route_geometry);
                } else if (Array.isArray(args.points) && args.points.length >= 2) {
                    pathCoordsLngLat = args.points.map((p: any, i: number) => {
                        const lat = Number(p.lat), lng = Number(p.lng);
                        if (!validateBBox(lat, lng, lat, lng)) {
                            throw new Error(`Invalid coordinates at index ${i}: (${lat}, ${lng})`);
                        }
                        return [lng, lat];
                    });
                } else if (args.origin !== undefined || args.destination !== undefined) {
                    if (typeof args.origin !== 'string' || !args.origin.trim() || typeof args.destination !== 'string' || !args.destination.trim()) {
                        return { content: [{ type: "text", text: "Error: Both 'origin' and 'destination' must be provided for profile mode." }], isError: true };
                    }
                    const s = await resolveRouteEndpoint(args.origin.trim(), warnings);
                    const e = await resolveRouteEndpoint(args.destination.trim(), warnings);
                    pathCoordsLngLat = [[s.lng, s.lat], [e.lng, e.lat]];
                } else if (args.bbox) {
                    const b = parseBBox(args.bbox as string, warnings);
                    pathCoordsLngLat = [[b.lng1, b.lat1], [b.lng2, b.lat2]];
                } else {
                    return { content: [{ type: "text", text: "Error: Provide 'route_geometry', at least two 'points', 'origin' + 'destination', or 'bbox' for mode='profile'." }], isError: true };
                }

                const resampled = resamplePathGeodesic(pathCoordsLngLat, sampleCount);
                const elevRes = await fetchElevationsBatch(resampled.samples);

                const rawSamples: Array<{ label: string; lat: number; lng: number; elevation_meters: number; distance_from_origin_meters: number }> = [];
                for (let i = 0; i < resampled.samples.length; i++) {
                    const elev = elevRes.elevations[i];
                    if (typeof elev === 'number' && Number.isFinite(elev)) {
                        const pt = resampled.samples[i];
                        rawSamples.push({
                            label: i === 0 ? "Start" : i === resampled.samples.length - 1 ? "End" : `KM ${roundTo(pt.distanceMeters / 1000, 2)}`,
                            lat: roundTo(pt.lat, 6),
                            lng: roundTo(pt.lng, 6),
                            elevation_meters: roundTo(elev, 2),
                            distance_from_origin_meters: roundTo(pt.distanceMeters, 1)
                        });
                    }
                }
                if (rawSamples.length < 2) {
                    return { content: [{ type: "text", text: "Error: Insufficient elevation data returned for profile path." }], isError: true };
                }

                let cumulativeGain = 0;
                let cumulativeLoss = 0;
                let maxInclineGrade = 0;
                let maxDeclineGrade = 0;
                let steepestAbsGrade = -1;
                let steepestSeg: Record<string, unknown> = {};

                const samples = rawSamples.map((s, idx) => {
                    if (idx === 0) {
                        return { ...s, grade_from_prev_percent: 0 };
                    }
                    const prev = rawSamples[idx - 1];
                    const dz = s.elevation_meters - prev.elevation_meters;
                    const ds = s.distance_from_origin_meters - prev.distance_from_origin_meters;
                    if (dz > 0) cumulativeGain += dz;
                    else cumulativeLoss += -dz;

                    const gradePct = ds > 0 ? (dz / ds) * 100 : 0;
                    if (gradePct > maxInclineGrade) maxInclineGrade = gradePct;
                    if (gradePct < 0 && -gradePct > maxDeclineGrade) maxDeclineGrade = -gradePct;

                    if (Math.abs(gradePct) > steepestAbsGrade) {
                        steepestAbsGrade = Math.abs(gradePct);
                        steepestSeg = {
                            from_lat: prev.lat,
                            from_lng: prev.lng,
                            to_lat: s.lat,
                            to_lng: s.lng,
                            mid_lat: roundTo((prev.lat + s.lat) / 2, 6),
                            mid_lng: roundTo((prev.lng + s.lng) / 2, 6),
                            distance_meters: roundTo(ds, 1),
                            elevation_change_meters: roundTo(dz, 2),
                            grade_percent: roundTo(gradePct, 2)
                        };
                    }

                    return { ...s, grade_from_prev_percent: roundTo(gradePct, 2) };
                });

                const netChange = samples[samples.length - 1].elevation_meters - samples[0].elevation_meters;
                warnings.push(`Elevation profile sampled ${samples.length} points over a 90m resolution DEM (Copernicus DEM GLO-90).`);

                const { minSample, maxSample, sampleStats } = summarizeElevationSamples(samples, true);
                const lats = samples.map(s => s.lat);
                const lngs = samples.map(s => s.lng);
                const displayBBox = ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));

                const markers: Array<{ coordinates: { lat: number; lon: number }; name: string }> = [
                    { coordinates: { lat: samples[0].lat, lon: samples[0].lng }, name: `Start: ${samples[0].elevation_meters}m` }
                ];
                if (maxSample !== samples[0] && maxSample !== samples[samples.length - 1]) {
                    markers.push({ coordinates: { lat: maxSample.lat, lon: maxSample.lng }, name: `High: ${maxSample.elevation_meters}m` });
                }
                if (minSample !== samples[0] && minSample !== samples[samples.length - 1] && minSample !== maxSample) {
                    markers.push({ coordinates: { lat: minSample.lat, lon: minSample.lng }, name: `Low: ${minSample.elevation_meters}m` });
                }
                markers.push({
                    coordinates: { lat: samples[samples.length - 1].lat, lon: samples[samples.length - 1].lng },
                    name: `End: ${samples[samples.length - 1].elevation_meters}m`
                });

                const shareUrl = buildShareUrlWithRoute(
                    displayBBox,
                    samples.map(s => [s.lng, s.lat]),
                    markers
                );

                const profileStats = {
                    total_distance_meters: roundTo(resampled.totalDistanceMeters, 1),
                    total_distance_km: roundTo(resampled.totalDistanceMeters / 1000, 3),
                    cumulative_gain_meters: roundTo(cumulativeGain, 1),
                    cumulative_loss_meters: roundTo(cumulativeLoss, 1),
                    net_elevation_change_meters: roundTo(netChange, 1),
                    max_incline_grade_percent: roundTo(maxInclineGrade, 2),
                    max_decline_grade_percent: roundTo(maxDeclineGrade, 2),
                    steepest_segment: steepestSeg
                };

                const responseData = {
                    mode: "profile",
                    dem_resolution_meters: 90,
                    sample_count: samples.length,
                    sample_stats: sampleStats,
                    samples,
                    profile_stats: profileStats,
                    bbox: displayBBox,
                    share_url: shareUrl,
                    provenance: makeProvenance(elevRes),
                    complete: true,
                    warnings
                };

                return {
                    content: [{
                        type: "text",
                        text: `Elevation Profile (${samples.length} samples, ${profileStats.total_distance_km} km):\n- Cumulative Gain: +${profileStats.cumulative_gain_meters} m | Loss: -${profileStats.cumulative_loss_meters} m | Net: ${profileStats.net_elevation_change_meters >= 0 ? '+' : ''}${profileStats.net_elevation_change_meters} m\n- Max Grade: +${profileStats.max_incline_grade_percent}% incline / -${profileStats.max_decline_grade_percent}% decline\n- Range: ${sampleStats.min_elevation_meters} m to ${sampleStats.max_elevation_meters} m\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    }],
                    structuredContent: responseData
                };
            }

            // Default: "points" or "grid" mode
            let queryPoints: Array<{ lat: number; lng: number; label: string }> = [];
            let bboxObj: BBox | undefined;
            let geocodeRes: GeocodeResult | undefined;

            if (Array.isArray(args.points) && args.points.length > 0) {
                if (args.points.length > 100) {
                    return { content: [{ type: "text", text: "Error: Maximum 100 points allowed per call." }], isError: true };
                }
                queryPoints = args.points.map((p: any, i: number) => {
                    const lat = Number(p.lat);
                    const lng = Number(p.lng);
                    if (!validateBBox(lat, lng, lat, lng)) {
                        throw new Error(`Invalid coordinates at index ${i}: (${lat}, ${lng})`);
                    }
                    return { lat, lng, label: p.label || `Point ${i + 1}` };
                });
                const lats = queryPoints.map(p => p.lat);
                const lngs = queryPoints.map(p => p.lng);
                bboxObj = ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));
            } else {
                const locStr = typeof args.location === 'string' ? args.location.trim() : '';
                const coordMatch = locStr.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
                if (coordMatch) {
                    const p0 = parseFloat(coordMatch[1]);
                    const p1 = parseFloat(coordMatch[2]);
                    if (validateBBox(p0, p1, p0, p1)) {
                        bboxObj = { lat1: p0, lng1: p1, lat2: p0, lng2: p1 };
                    } else if (validateBBox(p1, p0, p1, p0)) {
                        warnings.push(`Coordinate '${locStr}' interpreted as lng,lat -> converted to lat=${p1}, lng=${p0}.`);
                        bboxObj = { lat1: p1, lng1: p0, lat2: p1, lng2: p0 };
                    } else {
                        geocodeRes = await geocodeLocation(locStr);
                        bboxObj = geocodeRes.bbox;
                    }
                } else if (args.location) {
                    geocodeRes = await geocodeLocation(locStr);
                    bboxObj = geocodeRes.bbox;
                } else if (args.bbox) {
                    bboxObj = parseBBox(args.bbox as string, warnings);
                } else {
                    return { content: [{ type: "text", text: "Error: Provide either 'points', 'location', or 'bbox'." }], isError: true };
                }

                const isSinglePoint = Math.abs(bboxObj.lat2 - bboxObj.lat1) < 1e-6 && Math.abs(bboxObj.lng2 - bboxObj.lng1) < 1e-6;
                if (isSinglePoint) {
                    if (explicitMode === "grid") {
                        return { content: [{ type: "text", text: "Error: Grid mode requires a non-point bounding box or area location." }], isError: true };
                    }
                    queryPoints = [{ lat: bboxObj.lat1, lng: bboxObj.lng1, label: geocodeRes?.matched_place || "Point" }];
                } else {
                    mode = "grid";
                    const gridSize = Math.max(2, Math.min(10, Math.round((args.grid_size as number) ?? 5)));
                    warnings.push(`Grid mode samples a finite ${gridSize}x${gridSize} point grid (${gridSize * gridSize} points) over a 90m resolution DEM (Copernicus DEM GLO-90). Sample statistics do not guarantee true area-wide minimum, maximum, or slope measurements.`);
                    for (let r = 0; r < gridSize; r++) {
                        const lat = bboxObj.lat1 + (bboxObj.lat2 - bboxObj.lat1) * (r / (gridSize - 1));
                        for (let c = 0; c < gridSize; c++) {
                            const lng = bboxObj.lng1 + (bboxObj.lng2 - bboxObj.lng1) * (c / (gridSize - 1));
                            queryPoints.push({ lat, lng, label: `Grid (${r + 1},${c + 1})` });
                        }
                    }
                }
            }

            const elevRes = await fetchElevationsBatch(queryPoints);
            const samples = queryPoints.map((pt, idx) => ({
                label: pt.label,
                lat: roundTo(pt.lat, 6),
                lng: roundTo(pt.lng, 6),
                elevation_meters: elevRes.elevations[idx] ?? null
            })).filter((s): s is { label: string; lat: number; lng: number; elevation_meters: number } => typeof s.elevation_meters === 'number');

            if (samples.length === 0) {
                return { content: [{ type: "text", text: "Error: No elevation data returned for the requested coordinates." }], isError: true };
            }

            const { minSample, maxSample, sampleStats } = summarizeElevationSamples(samples, mode === "grid");

            const markers = mode === "grid"
                ? [
                    { coordinates: { lat: maxSample.lat, lon: maxSample.lng }, name: `Sample High: ${maxSample.elevation_meters}m` },
                    { coordinates: { lat: minSample.lat, lon: minSample.lng }, name: `Sample Low: ${minSample.elevation_meters}m` }
                ]
                : samples.map(s => ({ coordinates: { lat: s.lat, lon: s.lng }, name: `${s.label}: ${s.elevation_meters}m` }));

            const displayBBox = bboxObj!.lat1 === bboxObj!.lat2 && bboxObj!.lng1 === bboxObj!.lng2
                ? expandBBoxMeters(bboxObj!, 500)
                : bboxObj!;
            // Only draw a bounding box rectangle on the map in grid mode; for point lookups, show pins only
            const shareUrl = mode === "grid"
                ? buildShareUrlWithMarkers(displayBBox, markers)
                : buildShareUrlMarkersOnly(markers);

            const responseData = {
                mode,
                ...(geocodeRes ? { matched_place: geocodeRes.matched_place } : {}),
                dem_resolution_meters: 90,
                sample_count: samples.length,
                sample_stats: sampleStats,
                samples,
                bbox: displayBBox,
                share_url: shareUrl,
                provenance: makeProvenance(elevRes),
                complete: true,
                warnings
            };

            const summaryText = mode === "grid"
                ? `Terrain Elevation Sample Grid (${samples.length} samples at 90m DEM resolution${geocodeRes ? ` for "${geocodeRes.matched_place}"` : ''}):\n- Sample Min: ${minSample.elevation_meters} m at (${minSample.lat}, ${minSample.lng})\n- Sample Max: ${maxSample.elevation_meters} m at (${maxSample.lat}, ${maxSample.lng})\n- Sample Mean: ${sampleStats.mean_elevation_meters} m | Sample Relief: ${sampleStats.sample_relief_meters} m`
                : `Point Elevations (${samples.length}, 90m Copernicus DEM):\n` + samples.map(s => `- ${s.label} (${s.lat}, ${s.lng}): ${s.elevation_meters} m`).join('\n');

            return {
                content: [
                    {
                        type: "text",
                        text: `${summaryText}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    }
                ],
                structuredContent: responseData
            };
        }

        else if (toolName === "spatial_calc") {
            const args = request.params.arguments || {};
            const operation = args.operation as string;
            const bboxAStr = args.bbox_a as string;
            const warnings: string[] = [];

            if (!operation || !bboxAStr) {
                return { content: [{ type: "text", text: "Error: 'operation' and 'bbox_a' are required." }], isError: true };
            }

            const provenance: ProvenanceMetadata = {
                provider: "offline-geometry-engine",
                data_timestamp: new Date().toISOString(),
                cached: false,
                cache_age_ms: 0
            };

            if (operation === "relation") {
                const bboxBStr = args.bbox_b as string;
                if (!bboxBStr) {
                    return { content: [{ type: "text", text: "Error: 'bbox_b' is required for operation='relation'." }], isError: true };
                }
                const a = parseBBox(bboxAStr, warnings);
                const b = parseBBox(bboxBStr, warnings);

                const intersects = !(b.lng1 > a.lng2 || b.lng2 < a.lng1 || b.lat1 > a.lat2 || b.lat2 < a.lat1);
                const aContainsB = a.lat1 <= b.lat1 && a.lat2 >= b.lat2 && a.lng1 <= b.lng1 && a.lng2 >= b.lng2;
                const bContainsA = b.lat1 <= a.lat1 && b.lat2 >= a.lat2 && b.lng1 <= a.lng1 && b.lng2 >= a.lng2;

                const unionBBox: BBox = {
                    lat1: Math.min(a.lat1, b.lat1),
                    lng1: Math.min(a.lng1, b.lng1),
                    lat2: Math.max(a.lat2, b.lat2),
                    lng2: Math.max(a.lng2, b.lng2)
                };

                let intersectionBBox: BBox | null = null;
                let intersectionAreaKm2 = 0;
                if (intersects) {
                    intersectionBBox = {
                        lat1: Math.max(a.lat1, b.lat1),
                        lng1: Math.max(a.lng1, b.lng1),
                        lat2: Math.min(a.lat2, b.lat2),
                        lng2: Math.min(a.lng2, b.lng2)
                    };
                    intersectionAreaKm2 = calculateBboxArea(intersectionBBox);
                }

                const areaAKm2 = calculateBboxArea(a);
                const areaBKm2 = calculateBboxArea(b);
                const unionAreaKm2 = calculateBboxArea(unionBBox);
                const overlapPctOfA = areaAKm2 > 0 ? Math.round((intersectionAreaKm2 / areaAKm2) * 10000) / 100 : 0;
                const overlapPctOfB = areaBKm2 > 0 ? Math.round((intersectionAreaKm2 / areaBKm2) * 10000) / 100 : 0;

                const centroidDistanceMeters = calculateHaversineDistanceMeters(
                    (a.lat1 + a.lat2) / 2, (a.lng1 + a.lng2) / 2,
                    (b.lat1 + b.lat2) / 2, (b.lng1 + b.lng2) / 2
                );

                const shareUrl = buildShareUrl(intersectionBBox || unionBBox);
                const payload = {
                    operation: "relation",
                    intersects,
                    a_contains_b: aContainsB,
                    b_contains_a: bContainsA,
                    area_a_km2: Math.round(areaAKm2 * 1000) / 1000,
                    area_b_km2: Math.round(areaBKm2 * 1000) / 1000,
                    intersection_area_km2: Math.round(intersectionAreaKm2 * 1000) / 1000,
                    union_area_km2: Math.round(unionAreaKm2 * 1000) / 1000,
                    overlap_percent_of_a: overlapPctOfA,
                    overlap_percent_of_b: overlapPctOfB,
                    centroid_distance_meters: Math.round(centroidDistanceMeters * 10) / 10,
                    intersection_bbox: intersectionBBox,
                    union_bbox: unionBBox,
                    share_url: shareUrl,
                    provenance,
                    complete: true,
                    warnings
                };

                return {
                    content: [
                        {
                            type: "text",
                            text: `Spatial Relation:\n- Intersects: ${intersects} | A contains B: ${aContainsB} | B contains A: ${bContainsA}\n- Intersection Area: ${payload.intersection_area_km2} km² (${overlapPctOfA}% of A, ${overlapPctOfB}% of B)\n- Centroid Distance: ${payload.centroid_distance_meters} m\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                        }
                    ],
                    structuredContent: payload
                };
            }

            else if (operation === "point_in_geometry") {
                const ptStr = args.point as string;
                if (!ptStr) {
                    return { content: [{ type: "text", text: "Error: 'point' ('lat,lng') is required for operation='point_in_geometry'." }], isError: true };
                }
                const ptBbox = parseBBox(ptStr, warnings);
                const ptLat = (ptBbox.lat1 + ptBbox.lat2) / 2;
                const ptLng = (ptBbox.lng1 + ptBbox.lng2) / 2;

                const targetBBox = parseBBox(bboxAStr, warnings);
                const insideBBox = ptLat >= targetBBox.lat1 && ptLat <= targetBBox.lat2 && ptLng >= targetBBox.lng1 && ptLng <= targetBBox.lng2;

                const polygonsWithHoles = extractPolygonsWithHolesLatLng(bboxAStr);
                let insidePolygon: boolean | undefined;
                if (polygonsWithHoles && polygonsWithHoles.length > 0) {
                    insidePolygon = polygonsWithHoles.some(polyRings => isPointInPolygonWithHoles(ptLat, ptLng, polyRings));
                }

                const isInside = insidePolygon !== undefined ? insidePolygon : insideBBox;
                const ptMarker = [{ coordinates: { lat: ptLat, lon: ptLng }, name: isInside ? "Inside" : "Outside" }];
                const shareUrl = polygonsWithHoles && polygonsWithHoles[0]?.[0]?.length >= 3
                    ? buildShareUrlPolygon(polygonsWithHoles[0][0], ptMarker)
                    : buildShareUrlWithMarkers(targetBBox, ptMarker);

                const payload = {
                    operation: "point_in_geometry",
                    point: { lat: ptLat, lng: ptLng },
                    inside: isInside,
                    inside_bbox: insideBBox,
                    ...(insidePolygon !== undefined ? { inside_polygon: insidePolygon } : {}),
                    target_bbox: targetBBox,
                    share_url: shareUrl,
                    provenance,
                    complete: true,
                    warnings
                };

                return {
                    content: [
                        {
                            type: "text",
                            text: `Point (${ptLat}, ${ptLng}) is ${isInside ? "INSIDE" : "OUTSIDE"} the target geometry (inside_bbox: ${insideBBox}${insidePolygon !== undefined ? `, inside_polygon: ${insidePolygon}` : ''}).\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                        }
                    ],
                    structuredContent: payload
                };
            }

            else if (operation === "distance_bearing") {
                const bboxBStr = args.bbox_b as string || args.point as string;
                if (!bboxBStr) {
                    return { content: [{ type: "text", text: "Error: 'bbox_b' (or 'point') is required as the destination for operation='distance_bearing'." }], isError: true };
                }
                const a = parseBBox(bboxAStr, warnings);
                const b = parseBBox(bboxBStr, warnings);
                const lat1 = (a.lat1 + a.lat2) / 2, lng1 = (a.lng1 + a.lng2) / 2;
                const lat2 = (b.lat1 + b.lat2) / 2, lng2 = (b.lng1 + b.lng2) / 2;

                const geodesic = geodesicInverseWGS84(lat1, lng1, lat2, lng2);
                const mid = geodesicDirectWGS84(lat1, lng1, geodesic.initialBearingDegrees, geodesic.distanceMeters / 2);
                const sphericalDistMeters = calculateHaversineDistanceMeters(lat1, lng1, lat2, lng2);
                const enu = computeEnuVectorMeters(lat1, lng1, 0, lat2, lng2, 0);
                const bearingDegrees = roundTo(geodesic.initialBearingDegrees, 2);
                const finalBearingDegrees = roundTo(geodesic.finalBearingDegrees, 2);
                const cardinal = bearingToCardinal(geodesic.initialBearingDegrees);
                const midpoint = {
                    lat: roundTo(mid.lat, 6),
                    lng: roundTo(mid.lng, 6)
                };

                const combinedBBox = ensureValidBBox(Math.min(lat1, lat2), Math.min(lng1, lng2), Math.max(lat1, lat2), Math.max(lng1, lng2));
                const shareUrl = buildShareUrlWithRoute(
                    combinedBBox,
                    [[lng1, lat1], [lng2, lat2]],
                    [
                        { coordinates: { lat: lat1, lon: lng1 }, name: "Point A" },
                        { coordinates: { lat: midpoint.lat, lon: midpoint.lng }, name: `Midpoint (${(geodesic.distanceMeters / 1000).toFixed(2)}km)` },
                        { coordinates: { lat: lat2, lon: lng2 }, name: "Point B" }
                    ]
                );

                const payload = {
                    operation: "distance_bearing",
                    ellipsoid: "WGS84",
                    from: { lat: lat1, lng: lng1 },
                    to: { lat: lat2, lng: lng2 },
                    distance_meters: roundTo(geodesic.distanceMeters, 1),
                    distance_km: roundTo(geodesic.distanceMeters / 1000, 3),
                    spherical_distance_meters: roundTo(sphericalDistMeters, 1),
                    bearing_degrees: bearingDegrees,
                    final_bearing_degrees: finalBearingDegrees,
                    cardinal_direction: cardinal,
                    midpoint,
                    enu_vector_meters: enu,
                    bbox: combinedBBox,
                    share_url: shareUrl,
                    provenance,
                    complete: true,
                    warnings
                };

                return {
                    content: [
                        {
                            type: "text",
                            text: `WGS84 Geodesic Distance & Bearing: (${lat1}, ${lng1}) → (${lat2}, ${lng2})\n- Distance: ${payload.distance_km} km (${payload.distance_meters} m; spherical: ${payload.spherical_distance_meters} m)\n- Initial Bearing: ${bearingDegrees}° (${cardinal}) | Final Bearing: ${finalBearingDegrees}°\n- Geodesic Midpoint: (${midpoint.lat}, ${midpoint.lng})\n- ENU Vector (m): E=${enu.east}, N=${enu.north}, U=${enu.up}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                        }
                    ],
                    structuredContent: payload
                };
            }

            else if (operation === "camera_footprint") {
                const camBBox = parseBBox(bboxAStr, warnings);
                const camLat = (camBBox.lat1 + camBBox.lat2) / 2;
                const camLng = (camBBox.lng1 + camBBox.lng2) / 2;
                if (Math.abs(camBBox.lat2 - camBBox.lat1) > 1e-6 || Math.abs(camBBox.lng2 - camBBox.lng1) > 1e-6) {
                    warnings.push("Provided 'bbox_a' for camera_footprint was a bounding box; using its center coordinate as the camera position.");
                }

                if (typeof args.altitude_meters !== 'number' || !Number.isFinite(args.altitude_meters)) {
                    return {
                        content: [{ type: "text", text: "Error: 'altitude_meters' (positive number <= 100000) is required for operation='camera_footprint'." }],
                        isError: true
                    };
                }

                const altitudeMeters = args.altitude_meters;
                const pitchDegrees = args.pitch_degrees !== undefined ? Number(args.pitch_degrees) : -90;
                const headingDegrees = args.heading_degrees !== undefined ? Number(args.heading_degrees) : 0;
                const rollDegrees = args.roll_degrees !== undefined ? Number(args.roll_degrees) : 0;
                const fovDegrees = args.fov_degrees !== undefined ? Number(args.fov_degrees) : 60;
                const aspectRatio = args.aspect_ratio !== undefined ? Number(args.aspect_ratio) : 16 / 9;
                const maxRayDistanceMeters = args.max_ray_distance_meters !== undefined
                    ? Number(args.max_ray_distance_meters)
                    : Math.max(50000, altitudeMeters * 10);

                let footprint;
                try {
                    footprint = computeCameraFootprint({
                        lat: camLat,
                        lng: camLng,
                        altitudeMeters,
                        pitchDegrees,
                        headingDegrees,
                        rollDegrees,
                        fovDegrees,
                        aspectRatio,
                        maxRayDistanceMeters
                    });
                } catch (err: any) {
                    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                }

                if (footprint.clampedToHorizon) {
                    warnings.push(`One or more frustum rays pointed near/above the horizon or exceeded ${maxRayDistanceMeters}m and were clamped along the ray azimuth.`);
                }

                const payload = {
                    operation: "camera_footprint",
                    ellipsoid: "WGS84",
                    camera: {
                        lat: roundTo(camLat, 6),
                        lng: roundTo(camLng, 6),
                        altitude_meters: altitudeMeters,
                        pitch_degrees: pitchDegrees,
                        heading_degrees: headingDegrees,
                        roll_degrees: rollDegrees,
                        fov_degrees: fovDegrees,
                        aspect_ratio: roundTo(aspectRatio, 4)
                    },
                    center_target: footprint.centerTarget,
                    footprint_corners: footprint.corners,
                    footprint_geojson: footprint.footprintGeojson,
                    footprint_wkt: footprint.footprintWkt,
                    bbox: footprint.bbox,
                    area_km2: footprint.areaKm2,
                    clamped_to_horizon: footprint.clampedToHorizon,
                    share_url: footprint.shareUrl,
                    provenance,
                    complete: true,
                    warnings
                };

                return {
                    content: [{
                        type: "text",
                        text: `Camera Footprint (WGS84): (${camLat.toFixed(5)}, ${camLng.toFixed(5)}) @ ${altitudeMeters}m alt | Pitch: ${pitchDegrees}°, Heading: ${headingDegrees}°, FOV: ${fovDegrees}°\n- Look Target: (${footprint.centerTarget.lat}, ${footprint.centerTarget.lng}) — slant ${footprint.centerTarget.slant_distance_meters} m, ground ${footprint.centerTarget.ground_distance_meters} m\n- Footprint Area: ${footprint.areaKm2} km²${footprint.clampedToHorizon ? ' (horizon-clamped)' : ''}\n- WKT: ${footprint.footprintWkt}\n\nView on map: ${footprint.shareUrl}${formatWarnings(warnings)}`
                    }],
                    structuredContent: payload
                };
            }

            else if (operation === "split_grid") {
                const rows = Math.max(1, Math.min(20, Math.round((args.rows as number) ?? 2)));
                const cols = Math.max(1, Math.min(20, Math.round((args.cols as number) ?? 2)));
                const bbox = parseBBox(bboxAStr, warnings);

                const dLat = (bbox.lat2 - bbox.lat1) / rows;
                const dLng = (bbox.lng2 - bbox.lng1) / cols;
                const cells: Array<{ row: number; col: number; bbox: BBox; csv: string }> = [];

                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        const cellBBox: BBox = {
                            lat1: Math.round((bbox.lat1 + r * dLat) * 1e6) / 1e6,
                            lng1: Math.round((bbox.lng1 + c * dLng) * 1e6) / 1e6,
                            lat2: Math.round((bbox.lat1 + (r + 1) * dLat) * 1e6) / 1e6,
                            lng2: Math.round((bbox.lng1 + (c + 1) * dLng) * 1e6) / 1e6
                        };
                        cells.push({
                            row: r + 1,
                            col: c + 1,
                            bbox: cellBBox,
                            csv: `${cellBBox.lat1},${cellBBox.lng1},${cellBBox.lat2},${cellBBox.lng2}`
                        });
                    }
                }

                const shareUrl = buildShareUrl(bbox);
                const payload = {
                    operation: "split_grid",
                    rows,
                    cols,
                    total_cells: cells.length,
                    original_bbox: bbox,
                    cells,
                    share_url: shareUrl,
                    provenance,
                    complete: true,
                    warnings
                };

                return {
                    content: [
                        {
                            type: "text",
                            text: `Split bounding box into ${rows}x${cols} grid (${cells.length} sub-boxes).\n\nView parent bbox on map: ${shareUrl}${formatWarnings(warnings)}`
                        }
                    ],
                    structuredContent: payload
                };
            }

            else {
                return {
                    content: [{ type: "text", text: `Error: Unknown spatial_calc operation '${operation}'. Supported: relation, point_in_geometry, distance_bearing, split_grid, camera_footprint.` }],
                    isError: true
                };
            }
        }

        else if (toolName === "check_traffic_controls") {
            const args = request.params.arguments || {};
            const includeCrossings = args.include_crossings === true;
            const countOnly = args.count_only === true;
            const timeoutSec = parseClampedTimeoutSec(args.timeout_seconds, 25);
            const useAreaBoundary = args.use_area_boundary !== false;
            const rawLimit = typeof args.limit === 'number' ? Math.floor(args.limit) : 200;
            const limit = Math.max(1, Math.min(1000, rawLimit));
            const offset = Math.max(0, typeof args.offset === 'number' ? Math.floor(args.offset) : 0);

            if (args.radius_meters !== undefined && (typeof args.radius_meters !== 'number' || !Number.isFinite(args.radius_meters) || args.radius_meters <= 0)) {
                return { content: [{ type: "text", text: "Error: 'radius_meters' must be a positive number." }], isError: true };
            }

            const warnings: string[] = [];
            const coreQuery = includeCrossings
                ? 'nwr["highway"~"^(traffic_signals|stop)$"]; nwr["highway"="crossing"]["crossing"="traffic_signals"]; nwr["highway"="crossing"]["crossing:signals"="yes"]'
                : 'nwr["highway"~"^(traffic_signals|stop)$"]';
            const outDirective = countOnly ? "out tags;" : "out center;";

            let overpassQuery: string;
            let searchMode: 'route_corridor' | 'circle' | 'area' | 'bbox';
            let searchModeLabel: string;
            let refPoint: { lat: number; lng: number; description: string };
            let bboxObj: BBox | undefined;
            let geocodeRes: GeocodeResult | undefined;
            let usedAreaId: number | undefined;
            let effectiveRadius: number | undefined = typeof args.radius_meters === 'number' ? args.radius_meters : undefined;
            let routeCoordsLngLat: number[][] | undefined;
            let routeSummary: Record<string, unknown> | undefined;

            const originInput = typeof args.origin === 'string' ? args.origin.trim() : '';
            const destInput = typeof args.destination === 'string' ? args.destination.trim() : '';
            if ((originInput && !destInput) || (!originInput && destInput)) {
                return {
                    content: [{ type: "text", text: "Error: Both 'origin' and 'destination' are required when evaluating traffic controls along a route." }],
                    isError: true
                };
            }

            if (args.route_geometry !== undefined || (originInput && destInput)) {
                if (args.route_geometry !== undefined) {
                    try {
                        routeCoordsLngLat = parseRouteCoordinates(args.route_geometry);
                    } catch (err: any) {
                        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                    }
                    const lats = routeCoordsLngLat.map(c => c[1]);
                    const lngs = routeCoordsLngLat.map(c => c[0]);
                    bboxObj = ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));
                    refPoint = {
                        lat: routeCoordsLngLat[0][1],
                        lng: routeCoordsLngLat[0][0],
                        description: "route start point"
                    };
                } else {
                    const profile = (args.profile as "driving" | "walking" | "cycling") || "driving";
                    let routeRes;
                    try {
                        routeRes = await fetchOsrmRoute(originInput, destInput, profile, false, warnings);
                    } catch (err: any) {
                        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                    }
                    routeCoordsLngLat = routeRes.geomCoords;
                    bboxObj = routeRes.routeBBox;
                    refPoint = {
                        lat: routeRes.start.lat,
                        lng: routeRes.start.lng,
                        description: `route start (${routeRes.start.label})`
                    };
                    routeSummary = {
                        profile: routeRes.profile,
                        origin: routeRes.start,
                        destination: routeRes.end,
                        distance_meters: routeRes.distanceMeters,
                        distance_km: Math.round((routeRes.distanceMeters / 1000) * 100) / 100,
                        duration_seconds: routeRes.durationSeconds,
                        duration_minutes: routeRes.durationMinutes
                    };
                }

                const corridorRadius = effectiveRadius ?? 20;
                effectiveRadius = corridorRadius;
                const sampled = downsampleRouteCoords(routeCoordsLngLat);
                if (sampled.length < routeCoordsLngLat.length) {
                    warnings.push(`Route polyline downsampled from ${routeCoordsLngLat.length} to ${sampled.length} vertices for Overpass corridor query.`);
                }
                const coordList = sampled.map(([lng, lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`).join(',');
                const formattedCore = applySpatialFilter(coreQuery, `(around:${corridorRadius},${coordList})`);
                overpassQuery = `[out:json][timeout:${timeoutSec}];\n(${formattedCore});\n${outDirective}`;

                searchMode = 'route_corridor';
                searchModeLabel = routeSummary
                    ? `route corridor (${routeSummary.profile}: ${(routeSummary as any).origin.label} → ${(routeSummary as any).destination.label}, ${routeSummary.distance_km} km / ${routeSummary.duration_minutes} min, ${corridorRadius}m buffer)`
                    : `route corridor (${corridorRadius}m buffer around ${routeCoordsLngLat.length}-point route)`;
            } else {
                if (args.location) {
                    try {
                        geocodeRes = await geocodeLocation(args.location as string);
                        bboxObj = geocodeRes.bbox;
                        refPoint = {
                            lat: geocodeRes.center.lat,
                            lng: geocodeRes.center.lng,
                            description: `geocoded center of "${geocodeRes.matched_place}"`
                        };
                        if (!effectiveRadius && useAreaBoundary && geocodeRes.osm_area_id) {
                            usedAreaId = geocodeRes.osm_area_id;
                        }
                    } catch (err: any) {
                        if (args.bbox) {
                            log('warn', `Geocoding failed for check_traffic_controls, falling back to bbox`, { error: err.message });
                            bboxObj = parseBBox(args.bbox as string, warnings);
                            refPoint = {
                                lat: (bboxObj.lat1 + bboxObj.lat2) / 2,
                                lng: (bboxObj.lng1 + bboxObj.lng2) / 2,
                                description: "centroid of provided bounding box"
                            };
                        } else {
                            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                        }
                    }
                } else if (args.bbox) {
                    bboxObj = parseBBox(args.bbox as string, warnings);
                    const isPoint = Math.abs(bboxObj.lat2 - bboxObj.lat1) < 1e-7 && Math.abs(bboxObj.lng2 - bboxObj.lng1) < 1e-7;
                    refPoint = {
                        lat: (bboxObj.lat1 + bboxObj.lat2) / 2,
                        lng: (bboxObj.lng1 + bboxObj.lng2) / 2,
                        description: isPoint ? `coordinate (${bboxObj.lat1.toFixed(5)}, ${bboxObj.lng1.toFixed(5)})` : "centroid of provided bounding box"
                    };
                    if (isPoint && effectiveRadius === undefined) {
                        effectiveRadius = 35;
                    }
                } else {
                    return { content: [{ type: "text", text: "Error: One of 'location', 'bbox', 'route_geometry', or 'origin'+'destination' must be provided." }], isError: true };
                }

                // If geocoded result collapsed to a point without an admin area, default to junction radius
                if (!effectiveRadius && !usedAreaId && bboxObj && Math.abs(bboxObj.lat2 - bboxObj.lat1) < 1e-7 && Math.abs(bboxObj.lng2 - bboxObj.lng1) < 1e-7) {
                    effectiveRadius = 35;
                }

                if (effectiveRadius !== undefined) {
                    const circleFilter = `(around:${effectiveRadius},${refPoint.lat},${refPoint.lng})`;
                    const formattedCore = applySpatialFilter(coreQuery, circleFilter);
                    overpassQuery = `[out:json][timeout:${timeoutSec}];\n(${formattedCore});\n${outDirective}`;
                    searchMode = 'circle';
                    searchModeLabel = `circle — ${effectiveRadius}m radius around (${refPoint.lat.toFixed(5)}, ${refPoint.lng.toFixed(5)})`;
                } else if (usedAreaId) {
                    const formattedCore = applySpatialFilter(coreQuery, "(area.searchArea)");
                    overpassQuery = `[out:json][timeout:${timeoutSec}];\narea(${usedAreaId})->.searchArea;\n(${formattedCore});\n${outDirective}`;
                    searchMode = 'area';
                    searchModeLabel = `exact OSM boundary area (id: ${usedAreaId}) for "${geocodeRes?.matched_place}"`;
                } else {
                    const formattedCore = applySpatialFilter(coreQuery, "");
                    overpassQuery = `[out:json][timeout:${timeoutSec}][bbox:${bboxObj!.lat1},${bboxObj!.lng1},${bboxObj!.lat2},${bboxObj!.lng2}];\n(${formattedCore});\n${outDirective}`;
                    searchMode = 'bbox';
                    searchModeLabel = `bounding box`;
                }

                if (args.location && effectiveRadius === undefined && useAreaBoundary && !usedAreaId && geocodeRes) {
                    warnings.push(`Exact admin boundary polygon unavailable for '${geocodeRes.matched_place}', fell back to bounding box query.`);
                }
            }

            log('info', `check_traffic_controls starting`, { searchMode, countOnly, includeCrossings, radius_meters: effectiveRadius, timeoutSec });

            const { data, provenance, remarkWarning } = await executeOverpassQuery(overpassQuery, timeoutSec);
            if (remarkWarning) {
                warnings.push(`Overpass remark: ${remarkWarning}`);
            }

            const seenIds = new Set<string>();
            const allSignals: any[] = [];
            const allStops: any[] = [];
            const allMatched: any[] = [];

            for (const e of (data.elements || [])) {
                const dedupKey = `${e.type}/${e.id}`;
                if (seenIds.has(dedupKey)) continue;
                seenIds.add(dedupKey);

                const kind = classifyTrafficControlElement(e, includeCrossings);
                if (!kind) continue;

                const lat = e.lat ?? e.center?.lat ?? e.geometry?.[0]?.lat;
                const lon = e.lon ?? e.center?.lon ?? e.geometry?.[0]?.lon;

                if (!countOnly && (lat === undefined || lon === undefined)) {
                    continue;
                }

                const cleanTags = sanitizeExternalTags(e.tags || {});
                const entry: any = {
                    id: e.id,
                    type: e.type,
                    control: kind,
                    ...(cleanTags.name ? { name: cleanTags.name } : {}),
                    tags: cleanTags
                };

                if (lat !== undefined && lon !== undefined) {
                    entry.coordinates = { lat, lon };
                    entry.distance_meters = Math.round(calculateHaversineDistanceMeters(refPoint.lat, refPoint.lng, lat, lon) * 10) / 10;
                    if (routeCoordsLngLat) {
                        const proj = projectPointOntoRoute(lat, lon, routeCoordsLngLat);
                        entry.distance_to_route_meters = proj.distanceToRouteMeters;
                        entry.distance_along_route_meters = proj.distanceAlongRouteMeters;
                    }
                }

                allMatched.push(entry);
                if (kind === 'traffic_signal') {
                    allSignals.push(entry);
                } else {
                    allStops.push(entry);
                }
            }

            const counts = {
                traffic_signals: allSignals.length,
                stop_signs: allStops.length,
                total: allMatched.length
            };
            const hasTrafficSignal = counts.traffic_signals > 0;
            const hasStopSign = counts.stop_signs > 0;
            const controlType: 'traffic_signals' | 'stop_sign' | 'both' | 'none' =
                hasTrafficSignal && hasStopSign ? 'both'
                : hasTrafficSignal ? 'traffic_signals'
                : hasStopSign ? 'stop_sign'
                : 'none';

            if (countOnly) {
                const shareUrl = searchMode === 'route_corridor'
                    ? buildShareUrlWithRoute(bboxObj!, routeCoordsLngLat!, [])
                    : searchMode === 'circle'
                        ? buildShareUrlCircleWithMarkers(refPoint, effectiveRadius!, [])
                        : buildShareUrl(bboxObj || geocodeRes!.bbox);

                const payload = {
                    search_mode: searchMode,
                    count_only: true,
                    ...(geocodeRes ? { matched_place: geocodeRes.matched_place, alternatives: geocodeRes.alternatives } : {}),
                    ...(usedAreaId ? { osm_area_id: usedAreaId } : {}),
                    has_traffic_signal: hasTrafficSignal,
                    has_stop_sign: hasStopSign,
                    control_type: controlType,
                    counts,
                    distance_from: refPoint,
                    ...(routeSummary ? { route_summary: routeSummary } : {}),
                    share_url: shareUrl,
                    provenance,
                    complete: !remarkWarning,
                    warnings
                };

                return {
                    content: [{
                        type: "text",
                        text: `Traffic control check (${searchModeLabel}):\n- Control type: ${controlType}\n- Traffic signals: ${counts.traffic_signals} (${hasTrafficSignal ? 'yes' : 'no'})\n- Stop signs: ${counts.stop_signs} (${hasStopSign ? 'yes' : 'no'})\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    }],
                    structuredContent: payload
                };
            }

            allMatched.sort((a, b) => {
                if (searchMode === 'route_corridor') {
                    const alongDiff = (a.distance_along_route_meters ?? 0) - (b.distance_along_route_meters ?? 0);
                    if (Math.abs(alongDiff) > 0.001) return alongDiff;
                    const lateralDiff = (a.distance_to_route_meters ?? 0) - (b.distance_to_route_meters ?? 0);
                    if (Math.abs(lateralDiff) > 0.001) return lateralDiff;
                } else {
                    const distDiff = (a.distance_meters ?? 0) - (b.distance_meters ?? 0);
                    if (Math.abs(distDiff) > 0.001) return distDiff;
                }
                const typeDiff = (a.type || "").localeCompare(b.type || "");
                if (typeDiff !== 0) return typeDiff;
                return (a.id ?? 0) - (b.id ?? 0);
            });

            const paged = allMatched.slice(offset, offset + limit);
            const pagedSignals = paged.filter(e => e.control === 'traffic_signal');
            const pagedStops = paged.filter(e => e.control === 'stop_sign');
            const truncated = allMatched.length > offset + limit;
            const hasMore = truncated;
            const nextOffset = hasMore ? offset + limit : undefined;

            const toMarker = (e: any) => ({
                coordinates: e.coordinates,
                name: e.control === 'traffic_signal'
                    ? (e.name ? `Signal: ${e.name}` : 'Traffic Signal')
                    : (e.name ? `Stop: ${e.name}` : 'Stop Sign')
            });
            // Keep both signal and stop-sign pins visible within the 30-marker URL cap
            const markerList = (pagedSignals.length > 0 && pagedStops.length > 0)
                ? [...pagedSignals.slice(0, 15), ...pagedStops.slice(0, 15)].map(toMarker)
                : paged.slice(0, 30).map(toMarker);

            const shareUrl = searchMode === 'route_corridor'
                ? buildShareUrlWithRoute(bboxObj!, routeCoordsLngLat!, markerList)
                : searchMode === 'circle'
                    ? buildShareUrlCircleWithMarkers(refPoint, effectiveRadius!, markerList)
                    : (searchMode === 'area' && !args.bbox && markerList.length > 0
                        ? buildShareUrlMarkersOnly(markerList)
                        : buildShareUrlWithMarkers(bboxObj || geocodeRes!.bbox, markerList));

            const returnedCounts = {
                traffic_signals: pagedSignals.length,
                stop_signs: pagedStops.length,
                total: paged.length
            };

            log('info', `check_traffic_controls completed`, { searchMode, counts, returnedCounts, truncated });

            const payload: Record<string, unknown> = {
                search_mode: searchMode,
                count_only: false,
                ...(geocodeRes ? { matched_place: geocodeRes.matched_place, alternatives: geocodeRes.alternatives } : {}),
                ...(usedAreaId ? { osm_area_id: usedAreaId } : {}),
                has_traffic_signal: hasTrafficSignal,
                has_stop_sign: hasStopSign,
                control_type: controlType,
                counts,
                distance_from: refPoint,
                ...(routeSummary ? { route_summary: routeSummary } : {}),
                traffic_signals: pagedSignals,
                stop_signs: pagedStops,
                returned_counts: returnedCounts,
                offset,
                limit,
                truncated,
                has_more: hasMore,
                ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
                share_url: shareUrl,
                provenance,
                complete: !truncated && !remarkWarning,
                warnings
            };

            const previewLines = paged.slice(0, 6).map(e => {
                const label = e.control === 'traffic_signal' ? 'Traffic Signal' : 'Stop Sign';
                const distInfo = searchMode === 'route_corridor'
                    ? `${e.distance_along_route_meters}m along route (${e.distance_to_route_meters}m off centerline)`
                    : `${e.distance_meters}m away`;
                return `- [${label}] (${e.coordinates.lat.toFixed(5)}, ${e.coordinates.lon.toFixed(5)}) — ${distInfo}`;
            }).join('\n');
            const moreNote = paged.length > 6 ? `\n  … and ${paged.length - 6} more on this page` : '';

            return {
                content: [{
                    type: "text",
                    text: `Traffic control check (${searchModeLabel}):\n- Control type: ${controlType}\n- Traffic signals: ${counts.traffic_signals} (${hasTrafficSignal ? 'yes' : 'no'})\n- Stop signs: ${counts.stop_signs} (${hasStopSign ? 'yes' : 'no'})\n${previewLines ? `\nResults:\n${previewLines}${moreNote}\n` : ''}\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                }],
                structuredContent: payload
            };
        }

        else if (toolName === "search_places") {
            const args = (request.params.arguments || {}) as Record<string, unknown>;
            const location = typeof args.location === "string" ? args.location.trim() : "";
            const bboxRaw = typeof args?.bbox === "string" ? args.bbox.trim() : "";
            const query = typeof args?.query === "string" && args.query.trim() ? args.query.trim() : undefined;
            const category = typeof args?.category === "string" && args.category.trim() ? args.category.trim() : undefined;
            const useAreaBoundary = args?.use_area_boundary === true;
            const includeClosed = args?.include_closed === true;
            const countOnly = args?.count_only === true;

            if (!location && !bboxRaw) {
                return {
                    content: [{ type: "text", text: "Provide either 'location' or 'bbox' to search Overture Maps Places." }],
                    isError: true,
                };
            }
            if (location.length > MAX_INPUT_LENGTH || bboxRaw.length > MAX_INPUT_LENGTH) {
                return {
                    content: [{ type: "text", text: `Input exceeds maximum allowed length of ${MAX_INPUT_LENGTH} bytes.` }],
                    isError: true,
                };
            }

            let radiusMeters: number | undefined;
            if (args?.radius_meters !== undefined) {
                if (typeof args.radius_meters !== "number" || !Number.isFinite(args.radius_meters) || args.radius_meters <= 0) {
                    return {
                        content: [{ type: "text", text: "'radius_meters' must be a positive finite number." }],
                        isError: true,
                    };
                }
                radiusMeters = args.radius_meters;
            }

            const minConfidence = args?.min_confidence !== undefined ? Number(args.min_confidence) : 0;
            if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
                return {
                    content: [{ type: "text", text: "'min_confidence' must be a number between 0 and 1." }],
                    isError: true,
                };
            }

            const sortBy = args?.sort_by !== undefined ? String(args.sort_by) : "distance";
            if (sortBy !== "distance" && sortBy !== "confidence") {
                return {
                    content: [{ type: "text", text: "'sort_by' must be 'distance' or 'confidence'." }],
                    isError: true,
                };
            }

            let limit = 25;
            if (args?.limit !== undefined) {
                const rawLimit = Number(args.limit);
                if (!Number.isFinite(rawLimit) || rawLimit < 1) {
                    return {
                        content: [{ type: "text", text: "'limit' must be a positive integer." }],
                        isError: true,
                    };
                }
                limit = Math.min(100, Math.floor(rawLimit));
            }

            let offset = 0;
            if (args?.offset !== undefined) {
                const rawOffset = Number(args.offset);
                if (!Number.isFinite(rawOffset) || rawOffset < 0) {
                    return {
                        content: [{ type: "text", text: "'offset' must be a non-negative integer." }],
                        isError: true,
                    };
                }
                offset = Math.floor(rawOffset);
            }

            const warnings: string[] = [];
            let searchBBox: BBox;
            let refCenter: { lat: number; lng: number };
            let useCircleMode = false;
            let polygonsWithHoles: number[][][][] | undefined;
            let matchedPlace: string | undefined;

            try {
                if (bboxRaw) {
                    if (location) {
                        warnings.push("Both 'location' and 'bbox' were provided; using explicit 'bbox' bounds.");
                    }
                    const parsedBBox = parseBBox(bboxRaw, warnings);
                    const isPoint =
                        Math.abs(parsedBBox.lat1 - parsedBBox.lat2) < 1e-9 &&
                        Math.abs(parsedBBox.lng1 - parsedBBox.lng2) < 1e-9;

                    if (isPoint) {
                        refCenter = { lat: parsedBBox.lat1, lng: parsedBBox.lng1 };
                        useCircleMode = true;
                        if (radiusMeters === undefined) {
                            radiusMeters = 500;
                            warnings.push("Single point provided without radius_meters; defaulting to 500m search radius.");
                        }
                        searchBBox = expandBBoxMeters(parsedBBox, radiusMeters);
                    } else if (radiusMeters !== undefined) {
                        refCenter = {
                            lat: (parsedBBox.lat1 + parsedBBox.lat2) / 2,
                            lng: (parsedBBox.lng1 + parsedBBox.lng2) / 2,
                        };
                        useCircleMode = true;
                        searchBBox = expandBBoxMeters(
                            { lat1: refCenter.lat, lng1: refCenter.lng, lat2: refCenter.lat, lng2: refCenter.lng },
                            radiusMeters
                        );
                    } else {
                        searchBBox = parsedBBox;
                        refCenter = {
                            lat: (parsedBBox.lat1 + parsedBBox.lat2) / 2,
                            lng: (parsedBBox.lng1 + parsedBBox.lng2) / 2,
                        };
                        let maybeGeo: any = null;
                        if (bboxRaw.startsWith("{")) {
                            try {
                                maybeGeo = JSON.parse(bboxRaw);
                            } catch {
                                maybeGeo = null;
                            }
                        } else if (/^(?:POLYGON|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i.test(bboxRaw)) {
                            try {
                                maybeGeo = parseWKT(bboxRaw);
                            } catch {
                                maybeGeo = null;
                            }
                        }
                        if (maybeGeo) {
                            const extracted = extractPolygonsWithHolesLatLng(maybeGeo);
                            if (extracted && extracted.length > 0) {
                                polygonsWithHoles = extracted;
                            }
                        }
                    }
                } else {
                    const needPolygon = useAreaBoundary && radiusMeters === undefined;
                    const geo = await geocodeLocation(location, needPolygon, warnings);
                    matchedPlace = geo.matched_place;
                    refCenter = geo.center;
                    if (radiusMeters !== undefined) {
                        useCircleMode = true;
                        searchBBox = expandBBoxMeters(
                            { lat1: refCenter.lat, lng1: refCenter.lng, lat2: refCenter.lat, lng2: refCenter.lng },
                            radiusMeters
                        );
                    } else {
                        searchBBox = geo.bbox;
                        if (useAreaBoundary) {
                            if (geo.polygons_with_holes && geo.polygons_with_holes.length > 0) {
                                polygonsWithHoles = geo.polygons_with_holes;
                            } else {
                                warnings.push(
                                    `Area boundary polygon unavailable from geocoder for '${geo.matched_place}'; falling back to rectangular bounding box.`
                                );
                            }
                        }
                    }
                }

                const result = await searchOverturePlaces(
                    {
                        bbox: searchBBox,
                        refCenter,
                        radiusMeters: useCircleMode ? radiusMeters : undefined,
                        polygonsWithHoles,
                        query,
                        category,
                        minConfidence,
                        includeClosed,
                        countOnly,
                    },
                    warnings
                );

                const sorted = [...result.places].sort((a, b) => {
                    if (sortBy === "confidence") {
                        const ca = a.confidence ?? -1;
                        const cb = b.confidence ?? -1;
                        if (cb !== ca) return cb - ca;
                    }
                    if (a.distance_meters !== b.distance_meters) {
                        return a.distance_meters - b.distance_meters;
                    }
                    if (sortBy !== "confidence") {
                        const ca = a.confidence ?? -1;
                        const cb = b.confidence ?? -1;
                        if (cb !== ca) return cb - ca;
                    }
                    const na = a.name ?? "";
                    const nb = b.name ?? "";
                    if (na !== nb) return na.localeCompare(nb);
                    return a.id.localeCompare(b.id);
                });

                const categoryMap = new Map<string, number>();
                for (const place of sorted) {
                    const cat = place.basic_category || place.primary_category || "uncategorized";
                    categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1);
                }
                const categoryCounts = [...categoryMap.entries()]
                    .map(([cat, count]) => ({ category: cat, count }))
                    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.category.localeCompare(b.category)))
                    .slice(0, 20);

                const page = countOnly ? [] : sorted.slice(offset, offset + limit);
                const hasMore = !countOnly && offset + page.length < sorted.length;
                const nextOffset = hasMore ? offset + page.length : null;
                const truncated = !countOnly && page.length < sorted.length;

                const markers = page.slice(0, 50).map((p) => ({
                    coordinates: p.coordinates,
                    name: p.name || p.basic_category || "Place",
                }));
                const mapUrl = useCircleMode && radiusMeters !== undefined
                    ? buildShareUrlCircleWithMarkers(refCenter, radiusMeters, markers)
                    : markers.length > 0
                        ? buildShareUrlWithMarkers(searchBBox, markers)
                        : buildShareUrl(searchBBox);

                const provenance: ProvenanceMetadata = {
                    provider: `Overture Maps Places (${result.release})`,
                    attribution: OVERTURE_ATTRIBUTION,
                    data_timestamp: new Date(Date.now() - result.cacheAgeMs).toISOString(),
                    cached: result.cached,
                    cache_age_ms: result.cacheAgeMs,
                    usage_policy: OVERTURE_USAGE_POLICY,
                };

                const shareUrl = appendResultMetadata(mapUrl, {
                    returned: page.length,
                    source: provenance.provider,
                    warnings: hasMore ? [...warnings, "More results are available from the MCP tool."] : warnings
                });
                const payload = {
                    release: result.release,
                    ...(matchedPlace ? { matched_place: matchedPlace } : {}),
                    bbox: searchBBox,
                    query: query ?? null,
                    category: category ?? null,
                    count: sorted.length,
                    returned_count: page.length,
                    offset,
                    limit,
                    has_more: hasMore,
                    next_offset: nextOffset,
                    truncated,
                    complete: true,
                    stats: {
                        scanned_files: result.scannedFiles,
                        scanned_row_groups: result.scannedRowGroups,
                        sort_by: sortBy,
                        min_confidence: minConfidence,
                    },
                    category_counts: categoryCounts,
                    places: page,
                    share_url: shareUrl,
                    provenance,
                    warnings,
                };

                const summaryLines: string[] = [
                    `Found **${sorted.length}** Overture Maps place(s) (release \`${result.release}\`${matchedPlace ? `, area: ${matchedPlace}` : ""}${result.cached ? ", cached" : ""}).`,
                ];
                if (countOnly) {
                    if (categoryCounts.length > 0) {
                        summaryLines.push(
                            `Top categories: ${categoryCounts.slice(0, 10).map((c) => `\`${c.category}\` (${c.count})`).join(", ")}`
                        );
                    }
                } else if (page.length > 0) {
                    summaryLines.push(`Showing ${offset + 1}-${offset + page.length} of ${sorted.length}:`);
                    for (const p of page) {
                        const confStr = p.confidence !== null ? `conf ${p.confidence.toFixed(2)}` : "conf n/a";
                        const catStr = escapeMarkdownInline(p.basic_category || p.primary_category || "place");
                        const addrStr = p.address?.freeform ? ` — ${escapeMarkdownInline(p.address.freeform)}` : "";
                        const extras: string[] = [];
                        if (p.phones[0]) extras.push(escapeMarkdownInline(p.phones[0]));
                        if (p.websites[0]) extras.push(escapeMarkdownInline(p.websites[0]));
                        const extraStr = extras.length > 0 ? ` (${extras.join(", ")})` : "";
                        summaryLines.push(`- **${escapeMarkdownInline(p.name || "(unnamed)")}** [\`${catStr}\`, ${confStr}, ${p.distance_meters}m]${addrStr}${extraStr}`);
                    }
                    if (hasMore && nextOffset !== null) {
                        summaryLines.push(`More results available (pass \`offset: ${nextOffset}\`).`);
                    }
                }
                summaryLines.push(`Map: ${shareUrl}`);
                const warningText = formatWarnings(warnings);
                if (warningText) summaryLines.push(warningText);

                return {
                    content: [{ type: "text", text: summaryLines.join("\n") }],
                    structuredContent: payload,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text", text: `search_places error: ${msg}` }],
                    isError: true,
                };
            }
        }

        else {
            log('warn', `Unknown tool requested: ${toolName}`);
            return {
                content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
                isError: true,
            };
        }
    } catch (error: any) {
        log('error', `Tool execution error in ${toolName}`, { error: error.message, stack: error.stack });
        return {
            content: [{ type: "text", text: `Tool Execution Error: ${error.message}` }],
            isError: true,
        };
    }
});

// ---------------------------------------------------------------------------
// Server Startup
// ---------------------------------------------------------------------------

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('info', `Server started`, { version: SERVER_VERSION, max_h3_cells: MAX_H3_CELLS, mapbox_configured: !!MAPBOX_ACCESS_TOKEN });

    process.on("SIGINT", async () => {
        log('info', 'Received SIGINT, shutting down');
        await server.close();
        process.exit(0);
    });

    process.on("SIGTERM", async () => {
        log('info', 'Received SIGTERM, shutting down');
        await server.close();
        process.exit(0);
    });
}
run().catch((err) => {
    log('error', 'Server startup failed', { error: err.message, stack: err.stack });
    process.exit(1);
});
