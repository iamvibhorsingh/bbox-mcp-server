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
import proj4defs from "./proj4defs.json" with { type: "json" };
import { wktToGeoJSON as parseWKT } from "@terraformer/wkt";

const SERVER_NAME = "bbox-mcp-server";
const SERVER_VERSION = "1.1.0";

const MAX_H3_CELLS = process.env.MAX_H3_CELLS ? parseInt(process.env.MAX_H3_CELLS, 10) : 50000;
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
            const values = Object.values(current);
            for (let i = values.length - 1; i >= 0; i--) {
                stack.push(values[i]);
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

function parseBBox(input: string): BBox {
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
        } catch (e) { /* Fall through to next parser */ }
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
    } catch (e) { /* Not valid JSON, fall through */ }

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
        } catch (e) { /* Full WKT parse failed */ }
    }

    // --- 4. Standard Coordinate Array Sniffer ---
    // Strip brackets/parentheses and split by commas or spaces
    const cleanInput = input.replace(/[\[\]\(\)]/g, '').trim();
    // Support space-separated (GDAL) or comma-separated
    const parts = cleanInput.split(/[\s,]+/).map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

    if (parts.length === 4) {
        // Assume format: lat1, lng1, lat2, lng2 OR minX, minY, maxX, maxY
        // BBox finder defaults to minLat, minLng, maxLat, maxLng
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

function projectBounds(bbox: BBox, epsg: string): { xmin: number, ymin: number, xmax: number, ymax: number } {
    if (epsg === "4326") {
        return { xmin: bbox.lng1, ymin: bbox.lat1, xmax: bbox.lng2, ymax: bbox.lat2 };
    }

    const epsgKey = `EPSG:${epsg}`;
    if (!proj4.defs(epsgKey)) {
        throw new Error(`Unknown EPSG code: ${epsg}. Make sure it exists in proj4defs.`);
    }

    const p1 = proj4(epsgKey, [bbox.lng1, bbox.lat1]);
    const p2 = proj4(epsgKey, [bbox.lng2, bbox.lat2]);

    return {
        xmin: p1[0],
        ymin: p1[1],
        xmax: p2[0],
        ymax: p2[1],
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

function getFormattedBox(bbox: BBox, format: string, precision: number = 6): string {
    const xmin = bbox.lng1.toFixed(precision);
    const ymin = bbox.lat1.toFixed(precision);
    const xmax = bbox.lng2.toFixed(precision);
    const ymax = bbox.lat2.toFixed(precision);

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

function buildShareUrl(bbox: BBox): string {
    const hash = `${bbox.lat1.toFixed(6)},${bbox.lng1.toFixed(6)},${bbox.lat2.toFixed(6)},${bbox.lng2.toFixed(6)}`;
    return `https://vibhorsingh.com/boundingbox/#${hash}`;
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

async function geocodeLocation(query: string): Promise<BBox> {
    if (!MAPBOX_ACCESS_TOKEN) {
        throw new Error('Mapbox API token not configured. Set MAPBOX_ACCESS_TOKEN environment variable to use the location search feature. Alternatively, provide exact coordinate bounds via the `bbox` argument.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_ACCESS_TOKEN}&limit=1`;
        const response = await fetch(url, { signal: controller.signal });

        if (!response.ok) {
            throw new Error(`Geocoding failed with status: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (!data || typeof data !== "object" || !Array.isArray(data.features)) {
            throw new Error(`Unexpected geocoding response format from Mapbox API for query: ${query}`);
        }
        if (!data.features || data.features.length === 0) {
            throw new Error(`No results found for location: ${query}`);
        }

        const feature = data.features[0];
        if (feature.bbox) {
            // mb bbox format: minX, minY, maxX, maxY
            return {
                lat1: feature.bbox[1],
                lng1: feature.bbox[0],
                lat2: feature.bbox[3],
                lng2: feature.bbox[2]
            };
        } else if (feature.center) {
            // create a small bbox around the center point (10km roughly)
            const centerLng = feature.center[0];
            const centerLat = feature.center[1];
            const offset = 0.05;
            return {
                lat1: centerLat - offset,
                lng1: centerLng - offset,
                lat2: centerLat + offset,
                lng2: centerLng + offset
            };
        } else {
            throw new Error(`Unable to determine bounding box for location: ${query}`);
        }
    } catch (err: any) {
        if (err.name === 'AbortError') {
            throw new Error(`Geocoding request timed out after ${FETCH_TIMEOUT_MS / 1000}s for query: ${query}`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
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
                            description: "A text location to search for (e.g. 'San Francisco'). Requires MAPBOX_ACCESS_TOKEN env var. Either 'location' or 'bbox' MUST be provided."
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
            let bboxObj: BBox;

            if (args.location) {
                try {
                    bboxObj = await geocodeLocation(args.location as string);
                } catch (err: any) {
                    if (!args.bbox) {
                        log('error', `Geocoding failed for location: ${args.location}`, { error: err.message });
                        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                    }
                    // User provided bbox fallback
                    log('warn', `Geocoding failed, falling back to bbox argument`, { error: err.message });
                    bboxObj = parseBBox(args.bbox as string);
                }
            } else if (args.bbox) {
                bboxObj = parseBBox(args.bbox as string);
            } else {
                return { content: [{ type: "text", text: "Error: Either 'location' or 'bbox' argument must be provided." }], isError: true };
            }

            let epsg = args.epsg as string || "4326";
            let format = args.format as string || "csv";
            let precision = args.precision as number || 6;

            epsg = epsg.replace(/[^0-9]/g, "");

            // Dynamically fetch projection if not bundled
            await ensureProjection(epsg);

            const projCoords = projectBounds(bboxObj, epsg);
            const WGS84Formatted = getFormattedBox(bboxObj, format, precision);

            // Build projected bbox for formatting (uses projected values)
            const projBbox: BBox = {
                lat1: projCoords.ymin,
                lng1: projCoords.xmin,
                lat2: projCoords.ymax,
                lng2: projCoords.xmax
            };

            const projectedFormatted = getFormattedBox(projBbox, format, precision);
            const shareUrl = buildShareUrl(bboxObj);

            const dims = calculateBboxDimensions(bboxObj);
            const areaKm2 = calculateBboxArea(bboxObj);

            log('info', `get_bounds completed`, { epsg, format, area_km2: areaKm2 });

            return {
                content: [
                    {
                        type: "text",
                        text: `Original WGS84 Bounds (${format}):\n${WGS84Formatted}\n\nProjected to EPSG:${epsg} (${format}):\n${projectedFormatted}\n\nArea: ${areaKm2.toFixed(3)} km² (${dims.widthKm.toFixed(3)}km x ${dims.heightKm.toFixed(3)}km)\n\nView on map: ${shareUrl}`
                    },
                    {
                        type: "text",
                        text: JSON.stringify({
                            original_wgs84: bboxObj,
                            projected: projCoords,
                            epsg,
                            format,
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
            const returnGeometry = args.return_geometry as boolean || false;

            if (resolution === undefined) {
                return { content: [{ type: "text", text: "Error: 'resolution' is required." }], isError: true };
            }

            let bboxObj: BBox;
            if (args.location) {
                try {
                    bboxObj = await geocodeLocation(args.location as string);
                } catch (err: any) {
                    if (!args.bbox) {
                        log('error', `Geocoding failed for H3 location: ${args.location}`, { error: err.message });
                        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
                    }
                    bboxObj = parseBBox(args.bbox as string);
                }
            } else if (args.bbox) {
                bboxObj = parseBBox(args.bbox as string);
            } else {
                return { content: [{ type: "text", text: "Error: Either 'location' or 'bbox' argument must be provided." }], isError: true };
            }

            const cells = getH3Cells(bboxObj, resolution, compact);
            const shareUrl = buildShareUrl(bboxObj);

            log('info', `get_h3_indices completed`, { resolution, compact, cell_count: cells.length });

            const responseData: Record<string, unknown> = {
                resolution,
                compact,
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
                        text: `H3 Cells Generated: ${cells.length.toLocaleString()}\nResolution: ${resolution}\nCompacted: ${compact}\n\nCells:\n${JSON.stringify(cells)}\n\nView original bounding box on map: ${shareUrl}`
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

            if (!bbox) {
                return { content: [{ type: "text", text: "Error: 'bbox' is required." }], isError: true };
            }

            const bboxObj = parseBBox(bbox);
            const shareUrl = buildShareUrl(bboxObj);

            log('info', `generate_share_url completed`, { share_url: shareUrl });

            return {
                content: [
                    {
                        type: "text",
                        text: `View on map: ${shareUrl}\nNote: you can paste this URL directly in your browser.`
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
