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

const SERVER_NAME = "bbox-mcp-server";
const SERVER_VERSION = pkg.version;

const MAX_H3_CELLS = (() => {
    if (!process.env.MAX_H3_CELLS) return 50000;
    const v = parseInt(process.env.MAX_H3_CELLS, 10);
    if (!Number.isFinite(v) || v <= 0) {
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', server: 'bbox-mcp-server', message: `Invalid MAX_H3_CELLS="${process.env.MAX_H3_CELLS}", using default 50000` }));
        return 50000;
    }
    return v;
})();
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

// ---------------------------------------------------------------------------
// Pure Functions Ported from bbox.js
// ---------------------------------------------------------------------------

function validateBBox(lat1: number, lng1: number, lat2: number, lng2: number): boolean {
    if (isNaN(lat1) || isNaN(lng1) || isNaN(lat2) || isNaN(lng2)) return false;
    if (lat1 < -90 || lat1 > 90 || lat2 < -90 || lat2 > 90) return false;
    if (lng1 < -180 || lng1 > 180 || lng2 < -180 || lng2 > 180) return false;
    return true;
}

function parseBBox(input: string, warnings?: string[]): BBox {
    if (!input || typeof input !== 'string') {
        throw new Error(`Invalid bbox input.`);
    }

    // Input size guard — prevent blocking the event loop on huge payloads
    if (input.length > MAX_INPUT_LENGTH) {
        throw new Error(`Input too large (${(input.length / 1024).toFixed(0)} KB). Maximum allowed is ${(MAX_INPUT_LENGTH / 1024).toFixed(0)} KB.`);
    }

    // --- 1. ogrinfo Extent Sniffer ---
    // Matches: "Extent: (-74.006000, 40.712800) - (-73.985500, 40.758000)"
    const ogrMatch = input.match(/Extent\:\s\((.*)\)/);
    if (ogrMatch && ogrMatch[1]) {
        try {
            const pairs = ogrMatch[1].split(") - (");
            if (pairs.length === 2) {
                const minCoords = pairs[0].replace('(', '').split(',').map(s => parseFloat(s.trim()));
                const maxCoords = pairs[1].replace(')', '').split(',').map(s => parseFloat(s.trim()));

                // Assuming format: (minX, minY) - (maxX, maxY) where X=lng, Y=lat
                return ensureValidBBox(minCoords[1], minCoords[0], maxCoords[1], maxCoords[0]);
            }
        } catch (e: any) { log('info', 'parseBBox: ogrinfo extent parse failed, trying next parser', { error: e?.message }); }
    }

    // --- 2. GeoJSON Sniffer ---
    try {
        const json = JSON.parse(input);
        if (json.bbox && json.bbox.length === 4) {
            // standard GeoJSON bbox: [minX, minY, maxX, maxY]
            return ensureValidBBox(json.bbox[1], json.bbox[0], json.bbox[3], json.bbox[2]);
        }

        // Multi-Geometry Coordinate Extraction (using shared, stack-safe utility)
        const allCoords = extractCoords(json);

        if (allCoords.length > 0) {
            const lngs = allCoords.map(c => c[0]);
            const lats = allCoords.map(c => c[1]);
            return ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));
        }
    } catch (e: any) { log('info', 'parseBBox: GeoJSON parse failed, trying next parser', { error: e?.message }); }

    // --- 3. WKT Sniffer ---
    if (input.toUpperCase().includes("POLYGON") || input.toUpperCase().includes("POINT") || input.toUpperCase().includes("LINESTRING")) {
        try {
            const geojson = parseWKT(input) as any;
            const allCoords = extractCoords(geojson.coordinates || geojson);

            if (allCoords.length > 0) {
                const lngs = allCoords.map(c => c[0]);
                const lats = allCoords.map(c => c[1]);
                return ensureValidBBox(safeMin(lats), safeMin(lngs), safeMax(lats), safeMax(lngs));
            }
        } catch (e: any) { log('info', 'parseBBox: WKT parse failed, trying next parser', { error: e?.message }); }
    }

    // --- 4. Standard Coordinate Array Sniffer ---
    // Strip brackets/parentheses and split by commas or spaces
    const cleanInput = input.replace(/[\[\]\(\)]/g, '').trim();
    // Support space-separated (GDAL) or comma-separated
    const parts = cleanInput.split(/[\s,]+/).map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

    if (parts.length === 4) {
        // Default interpretation: lat1, lng1, lat2, lng2
        // Detect ambiguity: if both (lat,lng) and (lng,lat) orderings are valid,
        // the caller may have a transposed box without knowing it.
        const asLatLng = validateBBox(parts[0], parts[1], parts[2], parts[3]);
        const asLngLat = validateBBox(parts[1], parts[0], parts[3], parts[2]);
        if (asLatLng && asLngLat && (parts[0] !== parts[1] || parts[2] !== parts[3])) {
            warnings?.push(
                `Ambiguous coordinate order: interpreted as lat,lng,lat,lng → (${parts[0]}, ${parts[1]}, ${parts[2]}, ${parts[3]}). ` +
                `If your source uses lng,lat order (GeoJSON, GDAL, most GIS tools), the bounding box may be transposed. ` +
                `Use GeoJSON or WKT input to avoid ambiguity.`
            );
        }
        return ensureValidBBox(parts[0], parts[1], parts[2], parts[3]);
    }

    throw new Error(`Failed to parse bounding box. Input must be one of: WKT, GeoJSON, ogrinfo extent, or "lat1,lng1,lat2,lng2" string. Got: ${input.substring(0, 50)}...`);
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

    // Project all four corners to handle axis flips and oblique/rotated CRS
    const corners = [
        proj4(epsgKey, [bbox.lng1, bbox.lat1]),
        proj4(epsgKey, [bbox.lng2, bbox.lat1]),
        proj4(epsgKey, [bbox.lng1, bbox.lat2]),
        proj4(epsgKey, [bbox.lng2, bbox.lat2]),
    ];

    const xs = corners.map(c => c[0]);
    const ys = corners.map(c => c[1]);

    return {
        xmin: Math.min(...xs),
        ymin: Math.min(...ys),
        xmax: Math.max(...xs),
        ymax: Math.max(...ys),
    };
}

/**
 * Attempts to dynamically fetch an EPSG projection definition from epsg.io
 * if it's not in the bundled proj4defs.json. Caches the result for future
 * calls within the same server session.
 */
async function ensureProjection(epsg: string): Promise<void> {
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

        const proj4String = await response.text();

        if (!proj4String || proj4String.includes('<!DOCTYPE html>') || proj4String.trim().length === 0) {
            throw new Error(`Invalid proj4 string received for EPSG:${epsg}`);
        }

        proj4.defs(epsgKey, proj4String.trim());
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
// Geographic Math Formulas (Ported from bbox.js)
// ---------------------------------------------------------------------------

function calculateBboxDimensions(bbox: BBox): { widthKm: number, heightKm: number } {
    const R = 6371; // Earth's radius in km
    const lat1 = bbox.lat1 * Math.PI / 180;
    const lat2 = bbox.lat2 * Math.PI / 180;
    const lng1 = bbox.lng1 * Math.PI / 180;
    const lng2 = bbox.lng2 * Math.PI / 180;

    // Use Haversine distance conceptually matching leaflet distanceTo
    const widthKm = R * Math.abs(lng2 - lng1) * Math.cos((lat1 + lat2) / 2);
    const heightKm = R * Math.abs(lat2 - lat1);

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

function buildShareUrl(bbox: BBox): string {
    const hash = `${bbox.lat1.toFixed(6)},${bbox.lng1.toFixed(6)},${bbox.lat2.toFixed(6)},${bbox.lng2.toFixed(6)}`;
    return `https://vibhorsingh.com/boundingbox/#${hash}`;
}

function buildShareUrlWithMarkers(
    bbox: BBox,
    elements: Array<{ coordinates: { lat: number; lon: number }; name: string }>
): string {
    const bboxPart = `${bbox.lat1.toFixed(6)},${bbox.lng1.toFixed(6)},${bbox.lat2.toFixed(6)},${bbox.lng2.toFixed(6)}`;
    const MAX_MARKERS = 30;
    const markerParts = elements
        .filter(e => e.coordinates?.lat !== undefined && e.coordinates?.lon !== undefined)
        .slice(0, MAX_MARKERS)
        .map(e => {
            let name = e.name || 'Point';
            if (name.length > 30) name = name.slice(0, 27) + '...';
            return `${e.coordinates.lat.toFixed(6)},${e.coordinates.lon.toFixed(6)},${encodeURIComponent(name)}`;
        });
    const hashParts = [bboxPart, ...markerParts];
    return `https://vibhorsingh.com/boundingbox/#${hashParts.join('|')}`;
}

function getH3Cells(bbox: BBox, resolution: number, compact: boolean): string[] {
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

    // H3 v4 polygon format: [ [lat, lng]... ]
    const polygon = [
        [bbox.lat1, bbox.lng1],
        [bbox.lat2, bbox.lng1],
        [bbox.lat2, bbox.lng2],
        [bbox.lat1, bbox.lng2],
        [bbox.lat1, bbox.lng1]
    ];

    let cells = h3.polygonToCells(polygon, resolution);

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
// Nominatim Rate Limiter, Caching, and Utilities
// ---------------------------------------------------------------------------

let lastNominatimRequestTime = 0;
const NOMINATIM_CACHE = new Map<string, { timestamp: number; data: any }>();
const NOMINATIM_TTL_MS = 60 * 60 * 1000; // 1 hour TTL
const NOMINATIM_BASE_URL = (process.env.NOMINATIM_API_URL || "https://nominatim.openstreetmap.org").replace(/\/+$/, "");

async function fetchNominatim(url: string): Promise<any> {
    const cached = NOMINATIM_CACHE.get(url);
    if (cached && (Date.now() - cached.timestamp < NOMINATIM_TTL_MS)) {
        return cached.data;
    }

    const now = Date.now();
    const timeSinceLast = now - lastNominatimRequestTime;
    if (timeSinceLast < 1000) {
        await new Promise(resolve => setTimeout(resolve, 1000 - timeSinceLast));
    }
    lastNominatimRequestTime = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': `${SERVER_NAME}/${SERVER_VERSION} (https://github.com/iamvibhorsingh/bbox-mcp-server)`,
                'Accept': 'application/json'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Nominatim request failed with status: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        NOMINATIM_CACHE.set(url, { timestamp: Date.now(), data });
        return data;
    } catch (err: any) {
        if (err.name === 'AbortError') {
            throw new Error(`Nominatim request timed out after ${FETCH_TIMEOUT_MS / 1000}s for URL: ${url}`);
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
}

interface GeocodeResult extends GeocodeResultItem {
    alternatives: GeocodeResultItem[];
}

async function geocodeLocation(query: string): Promise<GeocodeResult> {
    // 1. Try Nominatim first (free, returns exact OSM area boundaries & alternatives)
    try {
        const nominatimUrl = `${NOMINATIM_BASE_URL}/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&extratags=1&limit=5`;
        const items = await fetchNominatim(nominatimUrl);

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

                return {
                    matched_place: item.display_name,
                    bbox,
                    center,
                    osm_area_id,
                    class: item.class,
                    type: item.type,
                    osm_type: item.osm_type,
                    osm_id: osmIdNum
                };
            });

            // Boundary relation preference: prefer relation with class=boundary or type=administrative/boundary
            let primaryIndex = parsedItems.findIndex(i =>
                i.osm_type === "relation" &&
                (i.class === "boundary" || i.type === "administrative" || i.type === "boundary")
            );
            if (primaryIndex === -1) primaryIndex = 0;

            const primary = parsedItems[primaryIndex];
            const alternatives = parsedItems.filter((_, idx) => idx !== primaryIndex);

            return {
                ...primary,
                alternatives
            };
        }
    } catch (err: any) {
        log('warn', `Nominatim geocoding failed for '${query}', trying Mapbox fallback`, { error: err.message });
    }

    // 2. Fallback to Mapbox if available
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
                    matched_place: feature.place_name || feature.text || query,
                    bbox,
                    center,
                    class: feature.properties?.category
                };
            });

            const primary = mapboxItems[0];
            const alternatives = mapboxItems.slice(1);

            return {
                ...primary,
                alternatives
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
}

async function reverseGeocode(lat: number, lng: number, zoom: number = 18): Promise<ReverseGeocodeResult> {
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new Error(`Invalid lat/lng coordinates for reverse geocoding: (${lat}, ${lng})`);
    }
    const clampedZoom = Math.max(0, Math.min(18, Math.round(zoom)));
    const url = `${NOMINATIM_BASE_URL}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=${clampedZoom}&addressdetails=1`;

    const data = await fetchNominatim(url);
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

    const shareUrl = buildShareUrl(bbox);

    return {
        matched_place: data.display_name,
        center: { lat, lng },
        bbox,
        address: data.address || {},
        class: data.class,
        type: data.type,
        osm_type: data.osm_type,
        osm_id: data.osm_id ? parseInt(data.osm_id, 10) : undefined,
        share_url: shareUrl
    };
}

function splitOverpassStatements(query: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inDouble = false;
    let inSingle = false;

    for (let i = 0; i < query.length; i++) {
        const char = query[i];
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

async function getTaginfoSuggestions(keyword: string): Promise<string> {
    const url = `https://taginfo.openstreetmap.org/api/4/search/by_keyword?query=${encodeURIComponent(keyword)}&rp=30`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const MAINSTREAM_KEYS = new Set([
        "amenity", "shop", "leisure", "tourism", "natural", "highway",
        "office", "healthcare", "craft", "sport", "landuse", "building",
        "historic", "emergency", "railway", "aeroway", "public_transport"
    ]);

    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': `${SERVER_NAME}/${SERVER_VERSION} (https://github.com/iamvibhorsingh/bbox-mcp-server)` },
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`Taginfo status: ${response.status}`);
        }
        const data = await response.json();
        const results = data.data || [];

        const filtered = results
            .filter((item: any) =>
                item.key &&
                MAINSTREAM_KEYS.has(item.key) &&
                (item.count_all ?? 0) >= 1000
            )
            .sort((a: any, b: any) => (b.count_all ?? 0) - (a.count_all ?? 0))
            .slice(0, 10);

        if (filtered.length === 0) {
            return `No mainstream OSM tags found for '${keyword}' with usage count > 1,000.\nTry searching standard keys like amenity, shop, leisure, or tourism.`;
        }

        const lines = filtered.map((item: any) => {
            const valStr = item.value ? `="${item.value}"` : '';
            return `- nwr["${item.key}"${valStr}] (${(item.count_all || 0).toLocaleString()} objects)`;
        });

        return `Taginfo OSM Tag Recommendations for '${keyword}':\n\n${lines.join('\n')}`;
    } catch (err: any) {
        return `Taginfo lookup failed for '${keyword}': ${err.message}`;
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

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_bounds",
                description: "Get converted coordinates for a bounding box or text location search. Supports parsing WKT, GeoJSON, ogrinfo extent, and raw coordinate strings. If MAPBOX_ACCESS_TOKEN is not set, you MUST provide explicit coordinates via 'bbox'.",
                inputSchema: {
                    type: "object",
                    properties: {
                        location: {
                            type: "string",
                            description: "A text location to search for (e.g. 'New York City'). Requires MAPBOX_ACCESS_TOKEN env var. Either 'location' or 'bbox' MUST be provided."
                        },
                        bbox: {
                            type: "string",
                            description: "The geometry to parse. Can be a raw bounding box string ('lat1,lng1,lat2,lng2'), a WKT polygon/linestring/point, a GeoJSON payload, or an `ogrinfo` extent block. The Minimum Bounding Rectangle (MBR) encapsulating the geometry will be extracted. Either 'location' or 'bbox' MUST be provided."
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
            },
            {
                name: "get_h3_indices",
                description: "Get Uber H3 cell indices for a bounding box area at a target resolution. Input supports WKT, GeoJSON, ogrinfo extent, and raw coordinate strings.",
                inputSchema: {
                    type: "object",
                    properties: {
                        location: {
                            type: "string",
                            description: "A text location to search for (e.g. 'San Francisco'). Either 'location' or 'bbox' MUST be provided."
                        },
                        bbox: {
                            type: "string",
                            description: "The geometry to parse. Can be a raw bounding box string ('lat1,lng1,lat2,lng2'), WKT, GeoJSON, or ogrinfo extent. Either 'location' or 'bbox' MUST be provided.",
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
                        }
                    },
                    required: ["resolution"],
                    oneOf: [
                        { required: ["location"] },
                        { required: ["bbox"] }
                    ]
                },
            },
            {
                name: "generate_share_url",
                description: "Generates a URL that links to the visual Bounding Box tool to display these coordinates on a map. Supports WKT, GeoJSON, ogrinfo extent, and raw coordinate strings as input.",
                inputSchema: {
                    type: "object",
                    properties: {
                        bbox: {
                            type: "string",
                            description: "The geometry to parse. Can be a raw bounding box string ('lat1,lng1,lat2,lng2'), WKT, GeoJSON, or ogrinfo extent.",
                        }
                    },
                    required: ["bbox"],
                },
            },
            {
                name: "reverse_geocode",
                description: "Reverse geocode latitude and longitude coordinates to discover context, place name, address components, and OSM details ('what is here?').",
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
                }
            },
            {
                name: "search_overpass",
                description: "Execute an Overpass QL query to find POIs, roads, or other OSM features within an admin boundary area, bounding box, or radius. The server wraps your query in spatial filters and returns structured JSON with distance calculations and a map link.\n\nSEARCH MODES:\n- Location / Admin Area: when 'location' resolves to an OSM boundary polygon (e.g. 'Manhattan', 'Seattle'), searches inside exact boundary polygon.\n- Bounding box (default): searches a rectangular area.\n- Circle: searches within an exact radius when 'radius_meters' is provided.\n\nCOMMON TAG EXAMPLES:\n- Restaurants: `nwr[\"amenity\"=\"restaurant\"]`\n- Pizza: `nwr[\"amenity\"=\"fast_food\"][\"cuisine\"=\"pizza\"]`\n- Supermarkets: `nwr[\"shop\"=\"supermarket\"]`\n- Parks: `nwr[\"leisure\"=\"park\"]`\n- Hospitals: `nwr[\"amenity\"=\"hospital\"]`\n- EV Charging: `nwr[\"amenity\"=\"charging_station\"]`\n- Gyms: `nwr[\"leisure\"=\"fitness_centre\"]`\n- Banks: `nwr[\"amenity\"=\"bank\"]`",
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
                        }
                    },
                    required: ["query"],
                    oneOf: [
                        { required: ["location"] },
                        { required: ["bbox"] }
                    ]
                },
            },
            {
                name: "list_osm_tags",
                description: "Discovery tool to look up the correct OpenStreetMap tags for any category. Uses built-in category index and live Taginfo API fallback to prevent tag hallucination.",
                inputSchema: {
                    type: "object",
                    properties: {
                        category: {
                            type: "string",
                            description: "Category or keyword to look up (e.g. 'food', 'ev charging', 'gym', 'coworking', 'banks', 'dog park')."
                        }
                    },
                    required: ["category"]
                }
            },
            {
                name: "aggregate_overpass_h3",
                description: "Executes an Overpass query and bins the results into H3 hexagons at a specified resolution to analyze spatial density.",
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

            return {
                content: [
                    {
                        type: "text",
                        text: `${geocodeInfo}${altInfo}Original WGS84 Bounds (${format}):\n${WGS84Formatted}\n\nProjected to EPSG:${epsg} (${format}):\n${projectedFormatted}\n\nArea: ${areaKm2.toFixed(3)} km² (${dims.widthKm.toFixed(3)}km x ${dims.heightKm.toFixed(3)}km)\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    },
                    {
                        type: "text",
                        text: JSON.stringify({
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
                            share_url: shareUrl
                        }, null, 2)
                    }
                ]
            };
        }

        else if (toolName === "get_h3_indices") {
            const args = request.params.arguments || {};
            const resolution = args.resolution as number;
            const compact = args.compact as boolean || false;
            const summaryOnly = args.summary_only as boolean || false;
            const returnGeometry = args.return_geometry as boolean || false;
            const warnings: string[] = [];

            if (resolution === undefined) {
                return { content: [{ type: "text", text: "Error: 'resolution' is required." }], isError: true };
            }

            let bboxObj: BBox;
            let geocodeRes: GeocodeResult | undefined;

            if (args.location) {
                try {
                    geocodeRes = await geocodeLocation(args.location as string);
                    bboxObj = geocodeRes.bbox;
                } catch (err: any) {
                    if (!args.bbox) {
                        log('error', `Geocoding failed for H3 location: ${args.location}`, { error: err.message });
                        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                    }
                    bboxObj = parseBBox(args.bbox as string, warnings);
                }
            } else if (args.bbox) {
                bboxObj = parseBBox(args.bbox as string, warnings);
            } else {
                return { content: [{ type: "text", text: "Error: Either 'location' or 'bbox' argument must be provided." }], isError: true };
            }

            const cells = getH3Cells(bboxObj, resolution, compact);
            const shareUrl = buildShareUrl(bboxObj);

            log('info', `get_h3_indices completed`, { resolution, compact, summary_only: summaryOnly, cell_count: cells.length });

            if (summaryOnly) {
                const sampleCells = cells.slice(0, 10);
                const responseData: Record<string, unknown> = {
                    resolution,
                    compact,
                    summary_only: true,
                    cell_count: cells.length,
                    sample_cells: sampleCells,
                    original_bbox: bboxObj,
                    share_url: shareUrl
                };
                return {
                    content: [
                        {
                            type: "text",
                            text: `H3 summary: ${cells.length.toLocaleString()} cells generated at resolution ${resolution} (compacted: ${compact}).\nSample cells: ${sampleCells.join(', ')}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                        },
                        {
                            type: "text",
                            text: JSON.stringify(responseData, null, 2)
                        }
                    ]
                };
            }

            const responseData: Record<string, unknown> = {
                resolution,
                compact,
                summary_only: false,
                cell_count: cells.length,
                cells,
                original_bbox: bboxObj,
                share_url: shareUrl
            };

            if (returnGeometry) {
                responseData.geojson = h3CellsToGeoJSON(cells);
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `H3 cells generated: ${cells.length.toLocaleString()}\nResolution: ${resolution} | Compacted: ${compact}\n\nCells:\n${JSON.stringify(cells)}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    },
                    {
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
                    }
                ]
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

            return {
                content: [
                    {
                        type: "text",
                        text: `View on map: ${shareUrl}${formatWarnings(warnings)}`
                    },
                    {
                        type: "text",
                        text: JSON.stringify({
                            bbox: bboxObj,
                            share_url: shareUrl
                        }, null, 2)
                    }
                ]
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
                    },
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
        }

        else if (toolName === "search_overpass") {
            const args = request.params.arguments || {};
            const queryRaw = args.query as string;
            const limit = (args.limit as number) || 100;
            const offset = (args.offset as number) || 0;
            const timeoutSec = (args.timeout_seconds as number) || 25;
            const useAreaBoundary = args.use_area_boundary !== false;
            const radiusMeters = args.radius_meters as number | undefined;
            const returnGeometry = args.return_geometry as boolean || false;
            const useCircle = typeof radiusMeters === 'number' && radiusMeters > 0;

            if (!queryRaw) {
                return { content: [{ type: "text", text: "Error: 'query' is required (e.g. `node[\"amenity\"=\"restaurant\"]`)." }], isError: true };
            }
            if (queryRaw.length > 2000) {
                return { content: [{ type: "text", text: "Error: Query is too long (maximum 2000 characters)." }], isError: true };
            }
            if (queryRaw.includes("[out:") || queryRaw.includes("[timeout:") || queryRaw.includes("[bbox:")) {
                return { content: [{ type: "text", text: "Error: Query must not contain [out:], [timeout:], or [bbox:] directives. The server handles these automatically." }], isError: true };
            }

            const warnings: string[] = [];
            let overpassQuery: string;
            let searchModeLabel: string;
            let refPoint: { lat: number; lng: number; description: string };
            let bboxObj: BBox | undefined;
            let geocodeRes: GeocodeResult | undefined;
            let usedAreaId: number | undefined;

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
                const outDirective = returnGeometry ? "out geom;" : "out center;";
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

                const outDirective = returnGeometry ? "out geom;" : "out center;";
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

            log('info', `search_overpass starting`, { query: queryRaw, mode: useCircle ? 'circle' : (usedAreaId ? 'area' : 'bbox'), radius_meters: radiusMeters, timeoutSec });

            const endpoints = [
                "https://overpass-api.de/api/interpreter",
                "https://overpass.kumi.systems/api/interpreter"
            ];
            if (process.env.OVERPASS_API_URL) {
                endpoints.unshift(process.env.OVERPASS_API_URL);
            }

            let data: any = null;
            let lastError: Error | null = null;
            const params = new URLSearchParams();
            params.append('data', overpassQuery);

            const clientTimeoutMs = (timeoutSec + 5) * 1000;

            for (const endpoint of endpoints) {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), clientTimeoutMs);
                try {
                    log('info', `Executing Overpass query at ${endpoint}`);
                    const response = await fetch(endpoint, {
                        method: "POST",
                        body: params.toString(),
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept': 'application/json',
                            'User-Agent': `${SERVER_NAME}/${SERVER_VERSION} (https://github.com/iamvibhorsingh/bbox-mcp-server)`
                        },
                        signal: controller.signal
                    });
                    if (!response.ok) {
                        throw new Error(`Overpass API returned status: ${response.status} ${response.statusText}`);
                    }
                    data = await response.json();
                    break;
                } catch (err: any) {
                    lastError = err;
                    log('warn', `Overpass API failed at ${endpoint}`, { error: err.message });
                } finally {
                    clearTimeout(timeout);
                }
            }

            if (!data) {
                if (lastError?.name === 'AbortError') {
                    return { content: [{ type: "text", text: `Error: Overpass API request timed out on all endpoints after ${clientTimeoutMs / 1000}s. The query or area may be too large.` }], isError: true };
                }
                throw new Error(`Overpass query failed on all endpoints: ${lastError?.message}`);
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
                    const el: any = {
                        id: e.id,
                        type: e.type,
                        name: e.tags?.name || "Unnamed",
                        coordinates: { lat, lon },
                        distance_meters: Math.round(distM * 10) / 10,
                        tags: e.tags || {}
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
                : buildShareUrlWithMarkers(bboxObj || geocodeRes!.bbox, pagedElements);

            log('info', `search_overpass completed`, { total: totalCount, returned: pagedElements.length, offset, limit, truncated, mode: useCircle ? 'circle' : (usedAreaId ? 'area' : 'bbox') });

            const responseData: Record<string, unknown> = {
                search_mode: useCircle ? 'circle' : (usedAreaId ? 'area' : 'bbox'),
                ...(geocodeRes ? { matched_place: geocodeRes.matched_place, alternatives: geocodeRes.alternatives } : {}),
                ...(usedAreaId ? { osm_area_id: usedAreaId } : {}),
                distance_from: refPoint,
                generator: data.generator,
                osm3s: data.osm3s,
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
                share_url: shareUrl
            };

            const topResults = pagedElements.slice(0, 5)
                .map((e: any) => `- [${e.type}] ${e.name} (${e.coordinates.lat.toFixed(5)}, ${e.coordinates.lon.toFixed(5)}) — ${e.distance_meters}m away`)
                .join('\n');
            const moreNote = pagedElements.length > 5 ? `\n  … and ${pagedElements.length - 5} more on this page (see JSON)` : '';

            return {
                content: [
                    {
                        type: "text",
                        text: `Overpass query executed within a ${searchModeLabel}.\nFound ${totalCount} element${totalCount !== 1 ? 's' : ''}${totalCount > limit ? ` (showing items ${offset + 1}-${offset + pagedElements.length} of ${totalCount})` : ''}.\nDistance measured from: ${refPoint.description}\n\nTop results:\n${topResults}${moreNote}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    },
                    {
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
                    }
                ]
            };
        }

        else if (toolName === "list_osm_tags") {
            const args = request.params.arguments || {};
            const category = (args.category as string || "").toLowerCase().trim();

            let recommendations = "";
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
                default:
                    log('info', `Category '${category}' not in index, querying Taginfo API`);
                    recommendations = await getTaginfoSuggestions(category);
                    break;
            }

            return {
                content: [{
                    type: "text",
                    text: `OSM Tag Recommendations for '${category}':\n\n${recommendations}\n\nTip: You can use these tag selectors directly in the 'query' argument of search_overpass.`
                }]
            };
        }

        else if (toolName === "aggregate_overpass_h3") {
            const args = request.params.arguments || {};
            const queryRaw = args.query as string;
            const resolution = (args.resolution as number) ?? 8;
            const timeoutSec = (args.timeout_seconds as number) || 25;
            const useAreaBoundary = args.use_area_boundary !== false;
            const warnings: string[] = [];

            if (!queryRaw) {
                return { content: [{ type: "text", text: "Error: 'query' is required." }], isError: true };
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

            log('info', `aggregate_overpass_h3 starting`, { query: queryRaw, resolution, timeoutSec, mode: usedAreaId ? 'area' : 'bbox' });

            let overpassQuery: string;
            if (usedAreaId) {
                const formattedCore = applySpatialFilter(queryRaw, "(area.searchArea)");
                overpassQuery = `[out:json][timeout:${timeoutSec}];\narea(${usedAreaId})->.searchArea;\n(${formattedCore});\nout center;`;
            } else {
                const formattedCore = applySpatialFilter(queryRaw, "");
                overpassQuery = `[out:json][timeout:${timeoutSec}][bbox:${bboxObj.lat1},${bboxObj.lng1},${bboxObj.lat2},${bboxObj.lng2}];\n(${formattedCore});\nout center;`;
            }

            let data: any = null;
            let lastError: Error | null = null;
            const params = new URLSearchParams();
            params.append('data', overpassQuery);

            const endpoints = [
                "https://overpass-api.de/api/interpreter",
                "https://overpass.kumi.systems/api/interpreter"
            ];

            if (process.env.OVERPASS_API_URL) {
                endpoints.unshift(process.env.OVERPASS_API_URL);
            }

            const clientTimeoutMs = (timeoutSec + 5) * 1000;

            for (const endpoint of endpoints) {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), clientTimeoutMs);

                try {
                    const response = await fetch(endpoint, {
                        method: "POST",
                        body: params.toString(),
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept': 'application/json',
                            'User-Agent': `${SERVER_NAME}/${SERVER_VERSION} (https://github.com/iamvibhorsingh/bbox-mcp-server)`
                        },
                        signal: controller.signal
                    });

                    if (!response.ok) throw new Error(`Status: ${response.status}`);
                    data = await response.json();
                    break;
                } catch (err: any) {
                    lastError = err;
                } finally {
                    clearTimeout(timeout);
                }
            }

            if (!data) {
                return { content: [{ type: "text", text: `Error: Overpass query failed: ${lastError?.message}` }], isError: true };
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
                        name: e.tags?.name || "Unnamed"
                    });
                }
            });

            const shareUrl = buildShareUrl(bboxObj);
            const totalGrouped = Object.values(hexCounts).reduce((a, b) => a + b, 0);

            const activeHexes = Object.keys(hexCounts);
            const geojson = h3CellsToGeoJSON(activeHexes);

            (geojson as any).features.forEach((f: any) => {
                const cellId = f.properties.h3_index;
                f.properties.count = hexCounts[cellId];
                f.properties.elements = hexElements[cellId];
            });

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
                share_url: shareUrl
            };

            const topHexes = Object.entries(hexCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);

            return {
                content: [
                    {
                        type: "text",
                        text: `Aggregated ${totalGrouped} element${totalGrouped !== 1 ? 's' : ''} into ${activeHexes.length} H3 hexagon${activeHexes.length !== 1 ? 's' : ''} at resolution ${resolution}.\n\nTop hexagons by density:\n${topHexes.map(([hex, count]) => `- ${hex}: ${count} element${count !== 1 ? 's' : ''}`).join('\n')}\n\nView on map: ${shareUrl}${formatWarnings(warnings)}`
                    },
                    {
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
                    }
                ]
            };
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
