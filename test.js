import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parquetWriteBuffer } from "hyparquet-writer";

function makePlaceRow(overrides) {
    const lat = overrides.lat;
    const lon = overrides.lon;
    return {
        id: overrides.id,
        geometry: { type: "Point", coordinates: [lon, lat] },
        bbox: { xmin: lon, xmax: lon, ymin: lat, ymax: lat },
        confidence: overrides.confidence ?? 0.9,
        operating_status: overrides.operating_status ?? "open",
        basic_category: overrides.basic_category ?? "coffee_shop",
        taxonomy: overrides.taxonomy ?? {
            primary: overrides.basic_category ?? "coffee_shop",
            alternates: ["cafe"],
            hierarchy: ["eat_and_drink", overrides.basic_category ?? "coffee_shop"]
        },
        names: {
            primary: overrides.name,
            common: { en: overrides.commonName ?? overrides.name }
        },
        brand: overrides.brand ?? { names: { primary: overrides.brandName ?? "Indie" }, wikidata: "Q0" },
        addresses: [{
            freeform: overrides.address ?? "100 Main St",
            locality: overrides.locality ?? "New York",
            postcode: overrides.postcode ?? "10036",
            region: overrides.region ?? "NY",
            country: overrides.country ?? "US"
        }],
        websites: overrides.websites ?? ["https://example.com"],
        phones: overrides.phones ?? ["+12125550100"],
        emails: overrides.emails ?? ["info@example.com"],
        socials: overrides.socials ?? ["https://social.example/place"],
        sources: overrides.sources ?? [{ property: "", dataset: "meta" }],
        version: overrides.version ?? 1
    };
}

function buildPlaceParquetBuffer(places, rowGroupSize = 100) {
    const columnNames = [
        "id", "geometry", "bbox", "confidence", "operating_status",
        "basic_category", "taxonomy", "names", "brand", "addresses",
        "websites", "phones", "emails", "socials", "sources", "version"
    ];
    return Buffer.from(parquetWriteBuffer({
        rowGroupSize,
        columnData: columnNames.map((name) => ({
            name,
            data: places.map((p) => p[name]),
            ...(name === "geometry" ? { type: "GEOMETRY" } : {})
        }))
    }));
}

function buildCollectionsParquetBuffer(entries) {
    return Buffer.from(parquetWriteBuffer({
        columnData: [
            { name: "collection", data: entries.map((e) => e.collection) },
            { name: "id", data: entries.map((e) => e.id) },
            { name: "bbox", data: entries.map((e) => e.bbox) },
            { name: "assets", data: entries.map((e) => e.assets) }
        ]
    }));
}

function decodeGooglePolyline(encoded) {
    const raw = decodeURIComponent(encoded).replace(/!/g, "|");
    const pts = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    const readSigned = () => {
        let result = 0;
        let shift = 0;
        let b;
        do {
            b = raw.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        return (result & 1) ? ~(result >>> 1) : (result >>> 1);
    };
    while (index < raw.length) {
        lat += readSigned();
        lng += readSigned();
        pts.push([Number((lat / 1e5).toFixed(5)), Number((lng / 1e5).toFixed(5))]);
    }
    return pts;
}

function parseShareUrlPolylinePoints(shareUrl) {
    const hash = new URL(shareUrl).hash.replace(/^#/, "");
    const parts = hash.split(/\||%7C/i);
    const lbePart = parts.find((p) => p.startsWith("LBE:"));
    if (lbePart) {
        return decodeGooglePolyline(lbePart.slice(4));
    }
    const lbPart = parts.find((p) => p.startsWith("LB:"));
    if (!lbPart) return null;
    const nums = lbPart.slice(3).split(",").map(Number);
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
        pts.push([nums[i], nums[i + 1]]);
    }
    return pts;
}

function serveBufferWithRange(req, res, buffer, contentType = "application/vnd.apache.parquet") {
    if (req.method === "HEAD") {
        res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": String(buffer.byteLength),
            "Accept-Ranges": "bytes"
        });
        res.end();
        return;
    }
    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === "string") {
        const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
        if (!match) {
            res.writeHead(416, { "Content-Range": `bytes */${buffer.byteLength}` });
            res.end();
            return;
        }
        const start = Number(match[1]);
        const rawEnd = match[2] ? Number(match[2]) : buffer.byteLength - 1;
        const end = Math.min(rawEnd, buffer.byteLength - 1);
        if (start >= buffer.byteLength || end < start) {
            res.writeHead(416, { "Content-Range": `bytes */${buffer.byteLength}` });
            res.end();
            return;
        }
        const slice = buffer.subarray(start, end + 1);
        res.writeHead(206, {
            "Content-Type": contentType,
            "Content-Range": `bytes ${start}-${end}/${buffer.byteLength}`,
            "Content-Length": String(slice.byteLength),
            "Accept-Ranges": "bytes"
        });
        res.end(slice);
        return;
    }
    res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": String(buffer.byteLength),
        "Accept-Ranges": "bytes"
    });
    res.end(buffer);
}

test("MCP Server Test Suite", async (t) => {
    const nominatimRequestTimes = [];
    const overtureStats = { londonAwsHits: 0, londonAzureHits: 0 };

    const nycParquet = buildPlaceParquetBuffer([
        makePlaceRow({
            id: "place-blue-bottle",
            name: "Blue Bottle Coffee",
            lat: 40.7565,
            lon: -73.9860,
            confidence: 0.96,
            basic_category: "coffee_shop",
            taxonomy: { primary: "coffee_shop", alternates: ["cafe"], hierarchy: ["eat_and_drink", "coffee_and_tea", "coffee_shop"] },
            brand: { names: { primary: "Blue Bottle" }, wikidata: "Q4928901" },
            address: "1345 Avenue of the Americas",
            websites: ["https://bluebottlecoffee.com"],
            phones: ["+15106533394"],
            emails: ["hello@bluebottlecoffee.com"],
            socials: ["https://instagram.com/bluebottle"],
            sources: [{ property: "", dataset: "Overture" }, { property: "/names", dataset: "meta" }, { property: "/websites", dataset: "Foursquare" }],
            version: 2
        }),
        makePlaceRow({
            id: "place-starbucks",
            name: "Starbucks Reserve",
            lat: 40.7555,
            lon: -73.9855,
            confidence: 0.92,
            basic_category: "coffee_shop",
            taxonomy: { primary: "coffee_shop", alternates: ["bakery"], hierarchy: ["eat_and_drink", "coffee_shop"] },
            brand: { names: { primary: "Starbucks" }, wikidata: "Q37158" },
            address: "1585 Broadway",
            websites: ["https://starbucks.com"],
            phones: ["+12125550101"],
            emails: [],
            socials: [],
            sources: [{ property: "", dataset: "Microsoft" }],
            version: 1
        }),
        makePlaceRow({
            id: "place-barber",
            name: "Times Barber Shop",
            lat: 40.7550,
            lon: -73.9850,
            confidence: 0.88,
            basic_category: "barber_shop",
            taxonomy: { primary: "barber_shop", alternates: ["hair_salon"], hierarchy: ["beauty_and_spa", "barber_shop"] },
            brand: null,
            address: "200 W 42nd St",
            websites: [],
            phones: [],
            emails: [],
            socials: [],
            sources: [{ property: "", dataset: "meta" }]
        }),
        makePlaceRow({
            id: "place-jazz-bar",
            name: "Midnight Jazz Bar",
            lat: 40.7545,
            lon: -73.9845,
            confidence: 0.85,
            basic_category: "bar",
            taxonomy: { primary: "bar", alternates: ["cocktail_bar"], hierarchy: ["eat_and_drink", "nightlife", "bar"] },
            brand: null,
            address: "700 8th Ave",
            websites: ["https://midnightjazz.example"],
            phones: [],
            emails: [],
            socials: [],
            sources: [{ property: "", dataset: "Foursquare" }]
        }),
        makePlaceRow({
            id: "place-closed-cafe",
            name: "Closed Roastery",
            lat: 40.7560,
            lon: -73.9858,
            confidence: 0.90,
            operating_status: "permanently_closed",
            basic_category: "coffee_shop",
            taxonomy: { primary: "coffee_shop", alternates: [], hierarchy: ["eat_and_drink", "coffee_shop"] },
            brand: null,
            address: "1450 Broadway",
            websites: [],
            phones: [],
            emails: [],
            socials: [],
            sources: [{ property: "", dataset: "meta" }]
        }),
        makePlaceRow({
            id: "place-low-conf-cafe",
            name: "Low Conf Espresso",
            lat: 40.7570,
            lon: -73.9865,
            confidence: 0.35,
            basic_category: "coffee_shop",
            taxonomy: { primary: "coffee_shop", alternates: [], hierarchy: ["eat_and_drink", "coffee_shop"] },
            brand: null,
            address: "100 W 45th St",
            websites: [],
            phones: [],
            emails: [],
            socials: [],
            sources: [{ property: "", dataset: "BrightQuery" }]
        }),
        makePlaceRow({
            id: "place-outside-nyc",
            name: "Far Uptown Cafe",
            lat: 40.8200,
            lon: -73.9500,
            confidence: 0.99,
            basic_category: "coffee_shop",
            taxonomy: { primary: "coffee_shop", alternates: [], hierarchy: ["eat_and_drink", "coffee_shop"] },
            brand: null,
            address: "500 W 140th St",
            websites: [],
            phones: [],
            emails: [],
            socials: [],
            sources: [{ property: "", dataset: "meta" }]
        })
    ]);

    const londonParquet = buildPlaceParquetBuffer([
        makePlaceRow({
            id: "place-london-cafe",
            name: "Monmouth Coffee Company",
            lat: 51.5142,
            lon: -0.1268,
            confidence: 0.95,
            basic_category: "coffee_shop",
            address: "27 Monmouth St",
            locality: "London",
            postcode: "WC2H 9EU",
            region: "ENG",
            country: "GB",
            websites: ["https://monmouthcoffee.co.uk"],
            sources: [{ property: "", dataset: "Foursquare" }]
        })
    ]);

    const sfManyRgParquet = buildPlaceParquetBuffer([
        makePlaceRow({ id: "sf-1", name: "SF Cafe 1", lat: 37.775, lon: -122.419, locality: "San Francisco", region: "CA" }),
        makePlaceRow({ id: "sf-2", name: "SF Cafe 2", lat: 37.776, lon: -122.418, locality: "San Francisco", region: "CA" }),
        makePlaceRow({ id: "sf-3", name: "SF Cafe 3", lat: 37.777, lon: -122.417, locality: "San Francisco", region: "CA" }),
        makePlaceRow({ id: "sf-4", name: "SF Cafe 4", lat: 37.778, lon: -122.416, locality: "San Francisco", region: "CA" }),
        makePlaceRow({ id: "sf-5", name: "SF Cafe 5", lat: 37.779, lon: -122.415, locality: "San Francisco", region: "CA" })
    ], 1);

    let mockBaseUrl = "";

    const mockServer = http.createServer((req, res) => {
        const reqPath = (req.url || "").split("?")[0];
        if (req.url?.startsWith("/search")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify([{
                display_name: "Times Square Polygon Area",
                lat: "40.7558",
                lon: "-73.9854",
                boundingbox: ["40.7540", "40.7575", "-73.9870", "-73.9840"],
                osm_type: "relation",
                osm_id: "99999",
                geojson: {
                    type: "Polygon",
                    coordinates: [[
                        [-73.9866, 40.7570],
                        [-73.9846, 40.7570],
                        [-73.9846, 40.7550],
                        [-73.9866, 40.7550],
                        [-73.9866, 40.7570]
                    ]]
                }
            }]));
        } else if (reqPath === "/overture/catalog.json" || reqPath === "/overture-fallback/catalog.json") {
            const prefix = reqPath.startsWith("/overture-fallback") ? "/overture-fallback" : "/overture";
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                latest: "2026-10-21.0",
                links: [{ rel: "child", href: `.${prefix === "/overture-fallback" ? "" : ""}/2026-10-21.0/catalog.json` }]
            }));
        } else if (reqPath === "/overture/2026-10-21.0/catalog.json" || reqPath === "/overture-fallback/2026-10-21.0/catalog.json") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ id: "2026-10-21.0", links: [] }));
        } else if (reqPath === "/overture/2026-10-21.0/collections.parquet") {
            const collectionsBuf = buildCollectionsParquetBuffer([
                {
                    collection: "place",
                    id: "part-00001",
                    bbox: { xmin: -74.05, ymin: 40.65, xmax: -73.90, ymax: 40.85 },
                    assets: {
                        aws: { href: `${mockBaseUrl}/overture/aws/part-00001.parquet` },
                        azure: { href: `${mockBaseUrl}/overture/azure/part-00001.parquet` }
                    }
                },
                {
                    collection: "place",
                    id: "part-00002",
                    bbox: { xmin: -0.20, ymin: 51.45, xmax: 0.05, ymax: 51.55 },
                    assets: {
                        aws: { href: `${mockBaseUrl}/overture/aws/part-00002.parquet` },
                        azure: { href: `${mockBaseUrl}/overture/azure/part-00002.parquet` }
                    }
                }
            ]);
            serveBufferWithRange(req, res, collectionsBuf);
        } else if (reqPath === "/overture-fallback/2026-10-21.0/collections.parquet") {
            res.writeHead(404);
            res.end();
        } else if (reqPath === "/overture-fallback/2026-10-21.0/places/place/collection.json") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                links: [
                    { rel: "item", href: "./item-nyc.json" },
                    { rel: "item", href: "./item-sf.json" }
                ]
            }));
        } else if (reqPath === "/overture-fallback/2026-10-21.0/places/place/item-nyc.json") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                id: "item-nyc",
                bbox: [-74.05, 40.65, -73.90, 40.85],
                assets: { aws: { href: `${mockBaseUrl}/overture/aws/part-00001.parquet` } }
            }));
        } else if (reqPath === "/overture-fallback/2026-10-21.0/places/place/item-sf.json") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                id: "item-sf",
                bbox: [-122.45, 37.75, -122.39, 37.81],
                assets: { aws: { href: `${mockBaseUrl}/overture/aws/part-many-rg.parquet` } }
            }));
        } else if (reqPath === "/overture/aws/part-00001.parquet" || reqPath === "/overture/azure/part-00001.parquet") {
            serveBufferWithRange(req, res, nycParquet);
        } else if (reqPath === "/overture/aws/part-00002.parquet") {
            overtureStats.londonAwsHits++;
            res.writeHead(503);
            res.end();
        } else if (reqPath === "/overture/azure/part-00002.parquet") {
            overtureStats.londonAzureHits++;
            serveBufferWithRange(req, res, londonParquet);
        } else if (reqPath === "/overture/aws/part-many-rg.parquet") {
            serveBufferWithRange(req, res, sfManyRgParquet);
        } else if (req.url?.startsWith("/reverse")) {
            nominatimRequestTimes.push(Date.now());
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                display_name: `Mock Place ${nominatimRequestTimes.length}`,
                boundingbox: ["40.70", "40.71", "-74.01", "-74.00"],
                address: { city: "New York" },
                osm_type: "node",
                osm_id: "12345"
            }));
        } else if (req.url?.startsWith("/overpass-ok")) {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                const decoded = decodeURIComponent(body.replace(/^data=/, "").replace(/\+/g, " "));
                res.writeHead(200, { "Content-Type": "application/json" });
                if (decoded.includes("out count;")) {
                    res.end(JSON.stringify({
                        version: 0.6,
                        generator: "Overpass API 0.7.62",
                        osm3s: { timestamp_osm_base: "2026-11-03T00:00:00Z" },
                        elements: [
                            { type: "count", id: 0, tags: { nodes: "12", ways: "35", relations: "2", total: "49" } }
                        ]
                    }));
                } else if (decoded.includes("traffic_signals")) {
                    const includeCoords = !decoded.includes("out tags;");
                    const baseElements = [
                        { type: "node", id: 2001, ...(includeCoords ? { lat: 40.75802, lon: -73.98552 } : {}), tags: { highway: "traffic_signals" } },
                        { type: "node", id: 2002, ...(includeCoords ? { lat: 40.75840, lon: -73.98510 } : {}), tags: { highway: "stop", direction: "forward" } },
                        { type: "node", id: 2003, ...(includeCoords ? { lat: 40.75910, lon: -73.98440 } : {}), tags: { highway: "traffic_signals", name: "Broadway & 47th" } }
                    ];
                    if (decoded.includes("crossing")) {
                        baseElements.push({
                            type: "node",
                            id: 2004,
                            ...(includeCoords ? { lat: 40.75815, lon: -73.98535 } : {}),
                            tags: { highway: "crossing", crossing: "traffic_signals" }
                        });
                    }
                    res.end(JSON.stringify({
                        version: 0.6,
                        generator: "Overpass API 0.7.62",
                        osm3s: { timestamp_osm_base: "2026-11-03T00:00:00Z" },
                        elements: baseElements
                    }));
                } else {
                    res.end(JSON.stringify({
                        version: 0.6,
                        generator: "Overpass API 0.7.62",
                        osm3s: { timestamp_osm_base: "2026-11-03T00:00:00Z" },
                        elements: [
                            { type: "way", id: 1001, center: { lat: 40.6413, lon: -73.7781 }, tags: { amenity: "parking", name: "Terminal 4 Parking" } },
                            { type: "way", id: 1002, center: { lat: 40.6435, lon: -73.7820 }, tags: { amenity: "parking", name: "Terminal 1 Garage" } },
                            { type: "node", id: 1003, lat: 40.6450, lon: -73.7790, tags: { amenity: "parking", name: "Terminal 5 Yellow Lot" } },
                            { type: "way", id: 1004, center: { lat: 40.6470, lon: -73.7850 }, tags: { amenity: "parking", name: "Terminal 8 Red Garage" } },
                            { type: "node", id: 1005, lat: 40.6395, lon: -73.7755, tags: { amenity: "parking", name: "Cargo Area Parking" } },
                            { type: "way", id: 1006, center: { lat: 40.6485, lon: -73.7720 }, tags: { amenity: "parking", name: "Long Term Parking Lot 9" } }
                        ]
                    }));
                }
            });
        } else if (reqPath === "/elevation") {
            const reqUrl = new URL(req.url, mockBaseUrl);
            const lats = (reqUrl.searchParams.get("latitude") || "").split(",").filter(Boolean).map(Number);
            const lngs = (reqUrl.searchParams.get("longitude") || "").split(",").filter(Boolean).map(Number);
            const elevation = lats.map((lat, idx) => {
                const lng = lngs[idx] ?? 0;
                if (lat > 39 && lat < 40 && lng < -104) {
                    return Number((1609 + (lat - 39.73) * 500).toFixed(1));
                }
                if (lat >= 35.99 && lat <= 36.11 && lng <= -111.9 && lng >= -112.1) {
                    const distFromPeak = Math.abs(lat - 36.05);
                    const ridgeBoost = Math.max(0, 600 * (1 - distFromPeak / 0.04));
                    return Number((1500 + ridgeBoost).toFixed(1));
                }
                return 50;
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ elevation }));
        } else if (req.url?.startsWith("/overpass-runtime-error")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                version: 0.6,
                generator: "Overpass API",
                osm3s: { timestamp_osm_base: "2026-01-01T00:00:00Z" },
                elements: [],
                remark: "runtime error: Query timed out in \"query\" at line 3 after 25 seconds."
            }));
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise(resolve => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;
    mockBaseUrl = `http://127.0.0.1:${port}`;

    const transport = new StdioClientTransport({
        command: "node",
        args: ["./dist/index.js"],
        env: {
            ...process.env,
            OVERPASS_API_URL: `${mockBaseUrl}/overpass-ok`,
            OVERTURE_STAC_URL: `${mockBaseUrl}/overture/catalog.json`,
            ELEVATION_API_URL: `${mockBaseUrl}/elevation`
        }
    });

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    t.after(async () => {
        await transport.close();
        await new Promise(resolve => mockServer.close(resolve));
    });

    await t.test("listTools returns expected tools, readOnlyHint annotations, and outputSchema on every tool", async () => {
        const tools = await client.listTools();
        assert.deepStrictEqual(
            tools.tools.map(t => t.name),
            [
                "get_bounds",
                "get_h3_indices",
                "generate_share_url",
                "reverse_geocode",
                "search_overpass",
                "list_osm_tags",
                "aggregate_overpass_h3",
                "calculate_route",
                "get_elevation",
                "spatial_calc",
                "check_traffic_controls",
                "search_places"
            ]
        );
        for (const tool of tools.tools) {
            assert.strictEqual(tool.annotations?.readOnlyHint, true, `Expected readOnlyHint on ${tool.name}`);
            assert.ok(tool.outputSchema, `Expected outputSchema on ${tool.name}`);
            assert.strictEqual(tool.outputSchema.type, "object", `Expected object outputSchema on ${tool.name}`);
            assert.ok(tool.outputSchema.properties?.provenance, `Expected provenance in outputSchema of ${tool.name}`);
            assert.ok(tool.outputSchema.properties?.complete, `Expected complete in outputSchema of ${tool.name}`);
            assert.ok(tool.outputSchema.properties?.warnings, `Expected warnings in outputSchema of ${tool.name}`);
        }
    });

    await t.test("get_bounds - happy path with native structuredContent and provenance", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", epsg: "3857", format: "geojson-bbox" }
        });
        assert.strictEqual(result.isError, undefined);
        assert.strictEqual(result.content.length, 1, "Expected single concise text block alongside structuredContent");
        assert.ok(result.content[0].text.includes("Original WGS84"));
        assert.ok(result.content[0].text.includes("Projected to EPSG:3857"));
        assert.ok(result.content[0].text.includes("View on map"));
        assert.ok(result.structuredContent, "Expected structuredContent");
        assert.strictEqual(result.structuredContent.complete, true);
        assert.ok(result.structuredContent.provenance?.provider);
        assert.ok(result.structuredContent.provenance?.data_timestamp);
    });

    await t.test("get_bounds - coord_order lat,lng and center/tile fields", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", format: "csv", coord_order: "lat,lng", zoom: 12 }
        });
        assert.strictEqual(result.isError, undefined);

        const textOutput = result.content[0].text;
        assert.ok(textOutput.includes("40.712800,-74.006000,40.758000,-73.985500"));

        const jsonOutput = result.structuredContent;
        assert.strictEqual(jsonOutput.coord_order, "lat,lng");

        assert.ok(jsonOutput.center);
        assert.ok(Math.abs(jsonOutput.center.lat - 40.7354) < 0.001);
        assert.ok(Math.abs(jsonOutput.center.lng - -73.9957) < 0.001);

        assert.ok(jsonOutput.tile_indices);
        assert.strictEqual(jsonOutput.tile_indices.z, 12);
        assert.ok(typeof jsonOutput.tile_indices.x === 'number');
        assert.ok(typeof jsonOutput.tile_indices.y === 'number');
    });

    await t.test("get_bounds - invalid EPSG code returns error", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "0,0,1,1", epsg: "999999", format: "csv" }
        });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes("Unknown EPSG code"));
    });

    await t.test("get_bounds - missing arguments returns error", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: {}
        });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes("Either 'location' or 'bbox' argument must be provided"));
    });

    await t.test("get_bounds - zero area bbox", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "0,0,0,0" }
        });
        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("0.000000,0.000000,0.000000,0.000000") || result.content[0].text.includes("0.000000, 0.000000, 0.000000, 0.000000"));
        assert.ok(result.content[0].text.includes("0.000 km² (0.000km x 0.000km)"));
    });

    await t.test("get_bounds - strict input parser rejects malformed numeric tokens (40oops) and antimeridian-crossing bboxes", async () => {
        // 1. Rejects trailing garbage like '40oops'
        const garbageRes = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "40oops,-74.0060,40.7580,-73.9855" }
        });
        assert.strictEqual(garbageRes.isError, true);
        assert.ok(garbageRes.content[0].text.includes("40oops"), `Expected error mentioning 40oops, got: ${garbageRes.content[0].text}`);

        // 2. Rejects raw CSV antimeridian crossing (west=170 > east=-170) instead of flipping to [-170, 170]
        const antiCsvRes = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "-20,170,-15,-170" }
        });
        assert.strictEqual(antiCsvRes.isError, true);
        assert.ok(/antimeridian|date line/i.test(antiCsvRes.content[0].text), `Expected antimeridian error, got: ${antiCsvRes.content[0].text}`);

        // 3. Rejects GeoJSON bbox crossing antimeridian
        const antiGeojsonRes = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: JSON.stringify({ type: "Feature", bbox: [170, -20, -170, -15], geometry: null }) }
        });
        assert.strictEqual(antiGeojsonRes.isError, true);
        assert.ok(/antimeridian|date line/i.test(antiGeojsonRes.content[0].text), `Expected GeoJSON antimeridian error, got: ${antiGeojsonRes.content[0].text}`);

        // 4. Rejects WKT polygon crossing antimeridian
        const antiWktRes = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "POLYGON((175 -20, -175 -20, -175 -15, 175 -15, 175 -20))" }
        });
        assert.strictEqual(antiWktRes.isError, true);
        assert.ok(/antimeridian|date line/i.test(antiWktRes.content[0].text), `Expected WKT antimeridian error, got: ${antiWktRes.content[0].text}`);
    });

    await t.test("get_bounds - format sniff WKT", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "POLYGON((-74.0060 40.7128, -73.9855 40.7128, -73.9855 40.7580, -74.0060 40.7580, -74.0060 40.7128))" }
        });
        assert.strictEqual(result.isError, undefined);
        const jsonResponse = result.structuredContent;
        assert.strictEqual(jsonResponse.original_wgs84.lat1, 40.7128);
        assert.strictEqual(jsonResponse.original_wgs84.lng1, -74.0060);
        assert.strictEqual(jsonResponse.original_wgs84.lat2, 40.7580);
        assert.strictEqual(jsonResponse.original_wgs84.lng2, -73.9855);
    });

    await t.test("get_bounds - format sniff GeoJSON", async () => {
        const geojsonString = JSON.stringify({
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [[-74.0060, 40.7128], [-73.9855, 40.7580]]
            }
        });
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: geojsonString }
        });
        assert.strictEqual(result.isError, undefined);
        const jsonResponse = result.structuredContent;
        assert.strictEqual(jsonResponse.original_wgs84.lat1, 40.7128);
        assert.strictEqual(jsonResponse.original_wgs84.lng1, -74.0060);
        assert.strictEqual(jsonResponse.original_wgs84.lat2, 40.7580);
        assert.strictEqual(jsonResponse.original_wgs84.lng2, -73.9855);
    });

    await t.test("get_bounds - format sniff ogrinfo extent", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "Extent: (-74.006000, 40.712800) - (-73.985500, 40.758000)" }
        });
        assert.strictEqual(result.isError, undefined);
        const jsonResponse = result.structuredContent;
        assert.strictEqual(jsonResponse.original_wgs84.lat1, 40.7128);
        assert.strictEqual(jsonResponse.original_wgs84.lng1, -74.0060);
        assert.strictEqual(jsonResponse.original_wgs84.lat2, 40.7580);
        assert.strictEqual(jsonResponse.original_wgs84.lng2, -73.9855);
    });

    await t.test("get_bounds - precision control", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", precision: 2 }
        });
        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("-74.01,40.71,-73.99,40.76"));
    });

    await t.test("get_h3_indices - happy path", async () => {
        const result = await client.callTool({
            name: "get_h3_indices",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", resolution: 7, compact: true }
        });
        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("H3 cells generated") || result.content[0].text.includes("H3 Cells"));
        assert.strictEqual(result.structuredContent.complete, true);
        const { share_url, cells, cell_count } = result.structuredContent;
        const [resolution, total, ...preview] = share_url.split("|H3:")[1].split(",");
        assert.equal(resolution, "7");
        assert.equal(Number(total), cell_count);
        assert.deepEqual(preview, cells.slice(0, 64));
        assert.ok(share_url.length <= 3800);
    });

    await t.test("get_h3_indices - summary_only mode sets complete=false", async () => {
        const result = await client.callTool({
            name: "get_h3_indices",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", resolution: 8, summary_only: true }
        });
        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("H3 summary"));
        const jsonResponse = result.structuredContent;
        assert.strictEqual(jsonResponse.summary_only, true);
        assert.strictEqual(jsonResponse.complete, false);
        assert.ok(Array.isArray(jsonResponse.sample_cells));
        assert.strictEqual(jsonResponse.cells, undefined);
    });

    await t.test("get_h3_indices & spatial_calc - preserves interior polygon holes (381 cells vs 514 without hole)", async () => {
        const wktWithHole = "POLYGON((0 0, 0.4 0, 0.4 0.4, 0 0.4, 0 0), (0.1 0.1, 0.3 0.1, 0.3 0.3, 0.1 0.3, 0.1 0.1))";
        const wktOuterOnly = "POLYGON((0 0, 0.4 0, 0.4 0.4, 0 0.4, 0 0))";

        const holeRes = await client.callTool({
            name: "get_h3_indices",
            arguments: { bbox: wktWithHole, resolution: 7 }
        });
        assert.strictEqual(holeRes.isError, undefined);
        assert.strictEqual(holeRes.structuredContent.used_polygon_boundary, true);
        assert.strictEqual(holeRes.structuredContent.cell_count, 381, `Expected 381 cells when hole is preserved, got ${holeRes.structuredContent.cell_count}`);

        const outerRes = await client.callTool({
            name: "get_h3_indices",
            arguments: { bbox: wktOuterOnly, resolution: 7 }
        });
        assert.strictEqual(outerRes.isError, undefined);
        assert.strictEqual(outerRes.structuredContent.cell_count, 514);

        // Also test GeoJSON Polygon with hole
        const geojsonWithHole = JSON.stringify({
            type: "Polygon",
            coordinates: [
                [[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4], [0, 0]],
                [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3], [0.1, 0.1]]
            ]
        });
        const geoHoleRes = await client.callTool({
            name: "get_h3_indices",
            arguments: { bbox: geojsonWithHole, resolution: 7 }
        });
        assert.strictEqual(geoHoleRes.isError, undefined);
        assert.strictEqual(geoHoleRes.structuredContent.cell_count, 381);

        // Point inside the hole (0.2, 0.2) must be reported as outside the polygon
        const pipHole = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "point_in_geometry",
                bbox_a: wktWithHole,
                point: "0.2,0.2"
            }
        });
        assert.strictEqual(pipHole.isError, undefined);
        assert.strictEqual(pipHole.structuredContent.inside_bbox, true);
        assert.strictEqual(pipHole.structuredContent.inside_polygon, false);
        assert.strictEqual(pipHole.structuredContent.inside, false);
    });

    await t.test("get_h3_indices - invalid resolution returns error", async () => {
        const result = await client.callTool({
            name: "get_h3_indices",
            arguments: { bbox: "0,0,1,1", resolution: 20 }
        });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes("Invalid H3 resolution"));
    });

    await t.test("get_h3_indices - area too large for resolution", async () => {
        const result = await client.callTool({
            name: "get_h3_indices",
            arguments: { bbox: "-80,-170,80,170", resolution: 10 }
        });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes("Area too large for resolution"));
    });

    await t.test("generate_share_url - happy path", async () => {
        const result = await client.callTool({
            name: "generate_share_url",
            arguments: { bbox: "0,0,1,1" }
        });
        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("https://vibhorsingh.com/boundingbox/#0.000000,0.000000,1.000000,1.000000"));
        assert.strictEqual(result.structuredContent.complete, true);
    });

    await t.test("generate_share_url - missing bbox returns error", async () => {
        const result = await client.callTool({
            name: "generate_share_url",
            arguments: {}
        });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes("Error: 'bbox' is required"));
    });

    await t.test("reverse_geocode - happy path", async () => {
        const result = await client.callTool({
            name: "reverse_geocode",
            arguments: { lat: 40.73, lng: -73.99 }
        });
        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("Matched Location"));
        const jsonOutput = result.structuredContent;
        assert.strictEqual(jsonOutput.center.lat, 40.73);
        assert.strictEqual(jsonOutput.center.lng, -73.99);
        assert.ok(jsonOutput.matched_place);
        assert.ok(jsonOutput.provenance.usage_policy.includes("nominatim"));
    });

    await t.test("search_overpass - missing query returns error", async () => {
        const result = await client.callTool({
            name: "search_overpass",
            arguments: { bbox: "0,0,1,1" }
        });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes("Error: 'query' is required"));
    });

    await t.test("search_overpass - missing bbox/location returns error", async () => {
        const result = await client.callTool({
            name: "search_overpass",
            arguments: { query: 'node["amenity"="bench"]' }
        });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes("Either 'location' or 'bbox' argument must be provided"));
    });

    await t.test("search_overpass - unsafe query rejected", async () => {
        const result = await client.callTool({
            name: "search_overpass",
            arguments: { bbox: "0,0,1,1", query: 'node["amenity"]; [out:csv]' }
        });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes("Query must not contain"));
    });

    await t.test("search_overpass - happy path with distance, pagination, and provenance", async () => {
        const jfkBbox = "40.63,-73.79,40.65,-73.76";
        const query = 'nwr["amenity"="parking"]';

        const result = await client.callTool({
            name: "search_overpass",
            arguments: { bbox: jfkBbox, query, limit: 5, offset: 0, timeout_seconds: 8 }
        });

        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("Overpass query executed within a"));
        const jsonResponse = result.structuredContent;

        assert.ok(jsonResponse.elements.length > 0, "Expected elements near JFK");
        assert.ok(jsonResponse.elements[0].distance_meters !== undefined, "Expected distance_meters");
        assert.ok(jsonResponse.distance_from, "Expected distance_from reference metadata");
        assert.ok(jsonResponse.provenance.provider.startsWith("overpass"));
        assert.strictEqual(jsonResponse.complete, !jsonResponse.truncated);
    });

    await t.test("list_osm_tags - happy path pre-indexed", async () => {
        const result = await client.callTool({
            name: "list_osm_tags",
            arguments: { category: "food" }
        });

        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("nwr[\"amenity\"=\"restaurant\"]"));
        assert.strictEqual(result.structuredContent.source, "built-in");
        assert.ok(result.structuredContent.tags.length > 0);
    });

    await t.test("list_osm_tags - Taginfo fallback for unknown category", async () => {
        const result = await client.callTool({
            name: "list_osm_tags",
            arguments: { category: "coworking" }
        });

        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("Coworking Spaces") || result.content[0].text.includes("Taginfo"));
        assert.ok(result.structuredContent.tags.length > 0);
    });

    await t.test("aggregate_overpass_h3 - happy path", async () => {
        const jfkBbox = "40.63,-73.79,40.65,-73.76";
        const query = 'nwr["amenity"="parking"]';

        const result = await client.callTool({
            name: "aggregate_overpass_h3",
            arguments: { bbox: jfkBbox, query, resolution: 8, timeout_seconds: 8 }
        });

        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("Aggregated"));

        const jsonResponse = result.structuredContent;

        assert.strictEqual(jsonResponse.resolution, 8);
        assert.ok(jsonResponse.total_elements > 0);
        assert.ok(jsonResponse.active_hex_count > 0);
        assert.ok(jsonResponse.hex_geojson.type === "FeatureCollection");
        assert.ok(jsonResponse.share_url.includes("|"), "Expected hotspot marker pins in share_url");
        const density = jsonResponse.share_url.split("|H3:")[1].split("|")[0].split(",").slice(2);
        assert.ok(density.length > 0);
        for (const item of density) {
            const [cell, count] = item.split(".");
            assert.equal(Number(count), jsonResponse.hex_counts[cell]);
        }
        assert.strictEqual(jsonResponse.complete, true);
    });

    await t.test("get_bounds - auto-corrects unambiguous lng,lat order, tile z/x/y, and buffer_meters", async () => {
        const sfRes = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "-122.45,37.75,-122.40,37.80" }
        });
        assert.strictEqual(sfRes.isError, undefined);
        const sfJson = sfRes.structuredContent;
        assert.strictEqual(sfJson.original_wgs84.lat1, 37.75);
        assert.strictEqual(sfJson.original_wgs84.lng1, -122.45);
        assert.ok(sfRes.content[0].text.includes("Automatically transposed"));

        const tileRes = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "15/9648/12318" }
        });
        assert.strictEqual(tileRes.isError, undefined);
        const tileJson = tileRes.structuredContent;
        assert.ok(tileJson.original_wgs84.lat1 > 40.7 && tileJson.original_wgs84.lat2 < 40.8);

        const bufRes = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "40.7354,-73.9957", buffer_meters: 1000 }
        });
        assert.strictEqual(bufRes.isError, undefined);
        const bufJson = bufRes.structuredContent;
        assert.ok(bufJson.area_km2 > 3.5 && bufJson.area_km2 < 4.5, `Expected ~4 km² for 1km buffer, got ${bufJson.area_km2}`);
    });

    await t.test("search_overpass - count_only fast count mode", async () => {
        const result = await client.callTool({
            name: "search_overpass",
            arguments: { bbox: "40.63,-73.79,40.65,-73.76", query: 'nwr["amenity"="parking"]', count_only: true, timeout_seconds: 10 }
        });
        assert.strictEqual(result.isError, undefined);
        const json = result.structuredContent;
        assert.strictEqual(json.count_only, true);
        assert.ok(json.counts.total > 0);
        assert.strictEqual(json.complete, true);
    });

    await t.test("spatial_calc - relation, point_in_geometry, distance_bearing, split_grid", async () => {
        const relRes = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "relation",
                bbox_a: "40.70,-74.02,40.80,-73.95",
                bbox_b: "40.75,-74.00,40.85,-73.90"
            }
        });
        assert.strictEqual(relRes.isError, undefined);
        const relJson = relRes.structuredContent;
        assert.strictEqual(relJson.intersects, true);
        assert.ok(relJson.overlap_percent_of_a > 0);

        const pipRes = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "point_in_geometry",
                bbox_a: "POLYGON((-74.01 40.70, -73.95 40.70, -73.95 40.80, -74.01 40.80, -74.01 40.70))",
                point: "40.75,-73.98"
            }
        });
        assert.strictEqual(pipRes.isError, undefined);
        const pipJson = pipRes.structuredContent;
        assert.strictEqual(pipJson.inside, true);
        assert.strictEqual(pipJson.inside_polygon, true);
        assert.ok(pipJson.share_url.includes("#P:"), `Expected polygon #P: in share_url, got ${pipJson.share_url}`);

        const dbRes = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "distance_bearing",
                bbox_a: "40.7128,-74.0060",
                bbox_b: "40.7580,-73.9855"
            }
        });
        assert.strictEqual(dbRes.isError, undefined);
        const dbJson = dbRes.structuredContent;
        assert.strictEqual(dbJson.ellipsoid, "WGS84");
        assert.ok(dbJson.distance_meters > 5000 && dbJson.distance_meters < 6000);
        assert.ok(typeof dbJson.spherical_distance_meters === "number");
        assert.ok(typeof dbJson.final_bearing_degrees === "number");
        assert.ok(dbJson.enu_vector_meters && typeof dbJson.enu_vector_meters.east === "number" && typeof dbJson.enu_vector_meters.north === "number");
        assert.ok(dbJson.cardinal_direction);
        assert.ok(dbJson.share_url.includes("#|LB:"), `Expected no orange bbox (#|LB:) in distance_bearing share_url, got ${dbJson.share_url}`);
        assert.ok(!dbJson.share_url.includes("PB:"), `Expected no legacy PB: polygon trace in distance_bearing share_url`);
        const dbLinePts = parseShareUrlPolylinePoints(dbJson.share_url);
        assert.deepStrictEqual(dbLinePts, [
            [40.7128, -74.006],
            [40.758, -73.9855]
        ]);

        // Long-distance WGS84 geodesic midpoint (NYC -> London): true geodesic arches above 52°N, unlike naive arithmetic mean (46.11°N)
        const nycLonRes = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "distance_bearing",
                bbox_a: "40.7128,-74.0060",
                bbox_b: "51.5074,-0.1278"
            }
        });
        assert.strictEqual(nycLonRes.isError, undefined);
        const nycLonJson = nycLonRes.structuredContent;
        assert.strictEqual(nycLonJson.ellipsoid, "WGS84");
        assert.ok(nycLonJson.midpoint.lat > 52.0, `Expected true geodesic midpoint lat > 52.0, got ${nycLonJson.midpoint.lat}`);
        assert.ok(Math.abs(nycLonJson.final_bearing_degrees - nycLonJson.bearing_degrees) > 20, "Expected forward azimuth to curve over North Atlantic");

        // Camera footprint: nadir (-90 deg) and oblique (-45 deg, East heading) + invalid parameter rejection
        const nadirCamRes = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "camera_footprint",
                bbox_a: "40.7484,-73.9857",
                altitude_meters: 500,
                pitch_degrees: -90,
                fov_degrees: 60,
                aspect_ratio: 1.5
            }
        });
        assert.strictEqual(nadirCamRes.isError, undefined);
        const nadirJson = nadirCamRes.structuredContent;
        assert.strictEqual(nadirJson.ellipsoid, "WGS84");
        assert.ok(nadirJson.area_km2 > 0);
        assert.ok(nadirJson.footprint_wkt.startsWith("POLYGON(("));
        assert.strictEqual(nadirJson.footprint_geojson?.geometry?.type, "Polygon");
        assert.strictEqual(nadirJson.clamped_to_horizon, false);
        assert.ok(Math.abs(nadirJson.center_target.lat - 40.7484) < 1e-4);
        assert.ok(Math.abs(nadirJson.center_target.lng - -73.9857) < 1e-4);
        assert.ok(nadirJson.share_url.includes("#P:"), `Expected #P: polygon in camera_footprint share_url, got ${nadirJson.share_url}`);

        const obliqueCamRes = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "camera_footprint",
                bbox_a: "40.7484,-73.9857",
                altitude_meters: 500,
                pitch_degrees: -45,
                heading_degrees: 90,
                fov_degrees: 60
            }
        });
        assert.strictEqual(obliqueCamRes.isError, undefined);
        const obliqueJson = obliqueCamRes.structuredContent;
        assert.ok(obliqueJson.center_target.lng > -73.9857, "Expected East-facing camera look target east of camera");
        assert.ok(obliqueJson.area_km2 > nadirJson.area_km2, "Expected oblique footprint area to exceed nadir footprint area");

        const badPitchRes = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "camera_footprint",
                bbox_a: "40.7484,-73.9857",
                altitude_meters: 500,
                pitch_degrees: 10
            }
        });
        assert.strictEqual(badPitchRes.isError, true);

        const missingAltRes = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "camera_footprint",
                bbox_a: "40.7484,-73.9857"
            }
        });
        assert.strictEqual(missingAltRes.isError, true);

        const splitRes = await client.callTool({
            name: "spatial_calc",
            arguments: {
                operation: "split_grid",
                bbox_a: "40.0,-74.0,41.0,-73.0",
                rows: 2,
                cols: 3
            }
        });
        assert.strictEqual(splitRes.isError, undefined);
        const splitJson = splitRes.structuredContent;
        assert.strictEqual(splitJson.total_cells, 6);
        assert.strictEqual(splitJson.cells.length, 6);
    });

    await t.test("get_elevation - point lookup, grid, line_of_sight, and profile modes", async () => {
        const elevRes = await client.callTool({
            name: "get_elevation",
            arguments: {
                points: [
                    { lat: 39.7392, lng: -104.9903, label: "Denver" },
                    { lat: 40.7128, lng: -74.0060, label: "NYC" }
                ]
            }
        });
        assert.strictEqual(elevRes.isError, undefined);
        const elevJson = elevRes.structuredContent;
        assert.strictEqual(elevJson.sample_count, 2);
        assert.strictEqual(elevJson.dem_resolution_meters, 90);
        assert.strictEqual(elevJson.sample_stats.is_finite_sample, false);
        assert.ok(elevJson.sample_stats.max_elevation_meters > 1500, "Expected Denver elevation > 1500m");
        assert.ok(elevJson.provenance.usage_policy.includes("non-commercial"));
        assert.ok(elevJson.share_url.includes("#|"), `Expected markers-only share_url (#|) for point elevation, got ${elevJson.share_url}`);

        // Grid mode must flag is_finite_sample=true and include a warning about 90m DEM finite sampling
        const gridRes = await client.callTool({
            name: "get_elevation",
            arguments: {
                bbox: "39.73,-105.00,39.75,-104.98",
                grid_size: 3
            }
        });
        assert.strictEqual(gridRes.isError, undefined);
        assert.strictEqual(gridRes.structuredContent.mode, "grid");
        assert.strictEqual(gridRes.structuredContent.sample_stats.is_finite_sample, true);
        assert.ok(gridRes.structuredContent.warnings.some(w => w.includes("90m resolution DEM")));

        // Line of Sight blocked by synthetic ridge peak at 36.05,-112.0 (2100m vs 1500m endpoints)
        const blockedLosRes = await client.callTool({
            name: "get_elevation",
            arguments: {
                mode: "line_of_sight",
                origin: "36.0,-112.0",
                destination: "36.1,-112.0",
                observer_height_meters: 1.7,
                target_height_meters: 0,
                sample_count: 11
            }
        });
        assert.strictEqual(blockedLosRes.isError, undefined, blockedLosRes.content?.[0]?.text);
        const blockedJson = blockedLosRes.structuredContent;
        assert.strictEqual(blockedJson.mode, "line_of_sight");
        assert.strictEqual(blockedJson.line_of_sight.is_visible, false);
        assert.ok(blockedJson.line_of_sight.max_obstruction_meters > 500, `Expected obstruction > 500m, got ${blockedJson.line_of_sight.max_obstruction_meters}`);
        assert.ok(Math.abs(blockedJson.line_of_sight.limiting_point.lat - 36.05) < 0.01);
        assert.ok(blockedJson.share_url.includes("#|LB:"), `Expected #|LB: route in LOS share_url, got ${blockedJson.share_url}`);

        // Elevated observer/drone (700m AGL) clears the synthetic ridge
        const clearLosRes = await client.callTool({
            name: "get_elevation",
            arguments: {
                mode: "line_of_sight",
                origin: "36.0,-112.0",
                destination: "36.1,-112.0",
                observer_height_meters: 700,
                target_height_meters: 700,
                sample_count: 11
            }
        });
        assert.strictEqual(clearLosRes.isError, undefined, clearLosRes.content?.[0]?.text);
        const clearJson = clearLosRes.structuredContent;
        assert.strictEqual(clearJson.line_of_sight.is_visible, true);
        assert.ok(clearJson.line_of_sight.min_clearance_meters > 0);

        // Elevation profile along route_geometry over synthetic ridge
        const profileRes = await client.callTool({
            name: "get_elevation",
            arguments: {
                mode: "profile",
                route_geometry: {
                    type: "LineString",
                    coordinates: [
                        [-112.0, 36.0],
                        [-112.0, 36.05],
                        [-112.0, 36.1]
                    ]
                },
                sample_count: 11
            }
        });
        assert.strictEqual(profileRes.isError, undefined, profileRes.content?.[0]?.text);
        const profJson = profileRes.structuredContent;
        assert.strictEqual(profJson.mode, "profile");
        assert.ok(profJson.profile_stats.cumulative_gain_meters > 0);
        assert.ok(profJson.profile_stats.cumulative_loss_meters > 0);
        assert.ok(profJson.profile_stats.max_incline_grade_percent > 0);
        assert.ok(profJson.profile_stats.steepest_segment && typeof profJson.profile_stats.steepest_segment.grade_percent === "number");
        assert.ok(profJson.share_url.includes("#|LB:"));
    });

    await t.test("calculate_route - returns route_geometry LineString and draws one-way LB: route path on verification map", async () => {
        const routeRes = await client.callTool({
            name: "calculate_route",
            arguments: {
                origin: "40.7128,-74.0060",
                destination: "40.7580,-73.9855",
                profile: "driving"
            }
        });
        assert.strictEqual(routeRes.isError, undefined);
        const routeJson = routeRes.structuredContent;
        assert.ok(routeJson.distance_meters >= routeJson.straight_line_meters);
        assert.ok(routeJson.duration_seconds > 0);
        assert.strictEqual(routeJson.route_geometry?.type, "LineString");
        assert.ok(Array.isArray(routeJson.route_geometry?.coordinates));
        assert.ok(routeJson.route_geometry.coordinates.length >= 2);
        const expectedPrefix = routeJson.route_geometry.coordinates.length > 15 ? "LBE:" : "LB:";
        assert.ok(routeJson.share_url.includes(`vibhorsingh.com/boundingbox/#|${expectedPrefix}`), `Expected #|${expectedPrefix} one-way drawn route path in share_url, got ${routeJson.share_url}`);
        assert.ok(!routeJson.share_url.includes("PB:"), `Route share_url should not encode mirrored PB: polygon: ${routeJson.share_url}`);
        const routeLinePts = parseShareUrlPolylinePoints(routeJson.share_url);
        assert.ok(routeLinePts && routeLinePts.length >= 2);
        assert.ok(routeLinePts.length <= 200);
        const firstCoord = routeJson.route_geometry.coordinates[0];
        const lastCoord = routeJson.route_geometry.coordinates[routeJson.route_geometry.coordinates.length - 1];
        assert.deepStrictEqual(routeLinePts[0], [Number(firstCoord[1].toFixed(5)), Number(firstCoord[0].toFixed(5))]);
        assert.deepStrictEqual(routeLinePts[routeLinePts.length - 1], [Number(lastCoord[1].toFixed(5)), Number(lastCoord[0].toFixed(5))]);

        // Alternatives + return_steps (with maneuver location)
        const altRes = await client.callTool({
            name: "calculate_route",
            arguments: {
                origin: "40.7128,-74.0060",
                destination: "40.7580,-73.9855",
                profile: "driving",
                return_steps: true,
                alternatives: true
            }
        });
        assert.strictEqual(altRes.isError, undefined);
        const altJson = altRes.structuredContent;
        assert.ok(Array.isArray(altJson.steps) && altJson.steps.length > 0);
        assert.ok(typeof altJson.steps[0].location?.lat === "number" && typeof altJson.steps[0].location?.lng === "number");
        assert.strictEqual(typeof altJson.alternatives_count, "number");
        assert.ok(Array.isArray(altJson.alternatives));
        assert.strictEqual(altJson.alternatives_count, altJson.alternatives.length);
        if (altJson.alternatives.length > 0) {
            assert.strictEqual(altJson.alternatives[0].route_geometry?.type, "LineString");
            const altPrefix = altJson.alternatives[0].route_geometry.coordinates.length > 15 ? "LBE:" : "LB:";
            assert.ok(altJson.alternatives[0].share_url.includes(`#|${altPrefix}`));
        }

        // Waypoints (plus warning when combined with alternatives: true)
        const wpRes = await client.callTool({
            name: "calculate_route",
            arguments: {
                origin: "40.7128,-74.0060",
                destination: "40.7580,-73.9855",
                waypoints: ["40.7350,-73.9950"],
                profile: "driving",
                return_steps: true,
                alternatives: true
            }
        });
        assert.strictEqual(wpRes.isError, undefined);
        const wpJson = wpRes.structuredContent;
        assert.strictEqual(wpJson.waypoints?.length, 1);
        assert.ok(Array.isArray(wpJson.steps) && wpJson.steps.length > 0);
        assert.ok(wpJson.share_url.includes("WP%201"), `Expected WP 1 pin in share_url, got ${wpJson.share_url}`);
        assert.ok(wpJson.warnings.some(w => w.includes("does not support alternative routes when waypoints are provided")));

        // Invalid waypoint returns error
        const badWpRes = await client.callTool({
            name: "calculate_route",
            arguments: {
                origin: "40.7128,-74.0060",
                destination: "40.7580,-73.9855",
                waypoints: [""]
            }
        });
        assert.strictEqual(badWpRes.isError, true);
    });

    await t.test("check_traffic_controls - junction point, bbox count/coords, route corridor, and crossings", async () => {
        // 1. Single point defaults to 35m junction radius and returns both traffic signals and stop signs
        const junctionRes = await client.callTool({
            name: "check_traffic_controls",
            arguments: { bbox: "40.7580,-73.9855" }
        });
        assert.strictEqual(junctionRes.isError, undefined);
        const junctionJson = junctionRes.structuredContent;
        assert.strictEqual(junctionJson.search_mode, "circle");
        assert.strictEqual(junctionJson.has_traffic_signal, true);
        assert.strictEqual(junctionJson.has_stop_sign, true);
        assert.strictEqual(junctionJson.control_type, "both");
        assert.strictEqual(junctionJson.counts.traffic_signals, 2);
        assert.strictEqual(junctionJson.counts.stop_signs, 1);
        assert.strictEqual(junctionJson.counts.total, 3);
        assert.ok(junctionJson.traffic_signals[0].coordinates.lat);
        assert.ok(junctionJson.stop_signs[0].coordinates.lon);
        assert.ok(junctionJson.share_url.includes("#C:"));

        // 2. Bounding box count_only mode returns separate counts & booleans without feature arrays
        const countRes = await client.callTool({
            name: "check_traffic_controls",
            arguments: { bbox: "40.757,-73.987,40.760,-73.983", count_only: true }
        });
        assert.strictEqual(countRes.isError, undefined);
        const countJson = countRes.structuredContent;
        assert.strictEqual(countJson.search_mode, "bbox");
        assert.strictEqual(countJson.count_only, true);
        assert.strictEqual(countJson.counts.traffic_signals, 2);
        assert.strictEqual(countJson.counts.stop_signs, 1);
        assert.strictEqual(countJson.traffic_signals, undefined);

        // 3. Route corridor mode accepts LineString geometry, computes along-route distances, and plots open LB: route + markers
        const corridorInputCoords = [
            [-73.98555, 40.75795],
            [-73.98505, 40.75845],
            [-73.98465, 40.75885],
            [-73.98435, 40.75915]
        ];
        const routeCtrlRes = await client.callTool({
            name: "check_traffic_controls",
            arguments: {
                route_geometry: {
                    type: "LineString",
                    coordinates: corridorInputCoords
                },
                radius_meters: 25,
                include_crossings: true
            }
        });
        assert.strictEqual(routeCtrlRes.isError, undefined);
        const routeCtrlJson = routeCtrlRes.structuredContent;
        assert.strictEqual(routeCtrlJson.search_mode, "route_corridor");
        assert.strictEqual(routeCtrlJson.counts.traffic_signals, 3); // 2 signals + 1 signalized crossing
        assert.strictEqual(routeCtrlJson.counts.stop_signs, 1);
        assert.ok(typeof routeCtrlJson.traffic_signals[0].distance_along_route_meters === "number");
        assert.ok(typeof routeCtrlJson.traffic_signals[0].distance_to_route_meters === "number");
        assert.ok(routeCtrlJson.traffic_signals[0].distance_along_route_meters <= routeCtrlJson.traffic_signals[1].distance_along_route_meters);
        assert.ok(routeCtrlJson.share_url.includes("#|LB:"), `Expected one-way LB: route + markers in share_url, got ${routeCtrlJson.share_url}`);
        assert.ok(!routeCtrlJson.share_url.includes("PB:"), `Expected no mirrored PB: trace in share_url`);
        // Round-trip check: parsed LB: points equal input coordinates in the exact same order with no duplicates
        const parsedCorridorPts = parseShareUrlPolylinePoints(routeCtrlJson.share_url);
        const expectedCorridorLatLng = corridorInputCoords.map(([lng, lat]) => [Number(lat.toFixed(5)), Number(lng.toFixed(5))]);
        assert.deepStrictEqual(parsedCorridorPts, expectedCorridorLatLng);
        assert.strictEqual(
            new Set(parsedCorridorPts.map(([lat, lng]) => `${lat},${lng}`)).size,
            parsedCorridorPts.length,
            "Parsed route points must have no duplicate mirrored vertices"
        );

        // 3b. Longer >15-vertex route corridor must emit compact LBE: (including escaping `|` chunk deltas like -0.00031 deg)
        const longCorridorCoords = Array.from({ length: 20 }, (_, i) => [
            Number((-73.98555 + i * 0.00006).toFixed(5)),
            Number((40.75950 - i * (i === 5 ? 0.00031 : 0.00008)).toFixed(5))
        ]);
        // Force an exact -0.00031 lat delta between index 4 and index 5 (produces raw `|` in 1e5 Google Polyline)
        longCorridorCoords[5] = [longCorridorCoords[4][0], Number((longCorridorCoords[4][1] - 0.00031).toFixed(5))];
        const longCtrlRes = await client.callTool({
            name: "check_traffic_controls",
            arguments: {
                route_geometry: { type: "LineString", coordinates: longCorridorCoords },
                radius_meters: 25
            }
        });
        assert.strictEqual(longCtrlRes.isError, undefined);
        const longCtrlJson = longCtrlRes.structuredContent;
        assert.ok(longCtrlJson.share_url.includes("#|LBE:"), `Expected compact #|LBE: for 20-vertex corridor, got ${longCtrlJson.share_url}`);
        assert.ok(!longCtrlJson.share_url.toUpperCase().includes("%7C"), "LBE: must never emit %7C hash delimiters");
        const parsedLongPts = parseShareUrlPolylinePoints(longCtrlJson.share_url);
        const expectedLongLatLng = longCorridorCoords.map(([lng, lat]) => [lat, lng]);
        assert.deepStrictEqual(parsedLongPts, expectedLongLatLng);

        // 4. Direct origin + destination routing mode on check_traffic_controls
        const missingDestRes = await client.callTool({
            name: "check_traffic_controls",
            arguments: { origin: "40.7559,-73.9869" }
        });
        assert.strictEqual(missingDestRes.isError, true);
        assert.ok(missingDestRes.content[0].text.includes("Both 'origin' and 'destination'"));

        const directRouteRes = await client.callTool({
            name: "check_traffic_controls",
            arguments: {
                origin: "40.7559,-73.9869",
                destination: "40.7614,-73.9776",
                profile: "driving"
            }
        });
        assert.strictEqual(directRouteRes.isError, undefined);
        const directRouteJson = directRouteRes.structuredContent;
        assert.strictEqual(directRouteJson.search_mode, "route_corridor");
        assert.strictEqual(directRouteJson.route_summary?.profile, "driving");
        assert.ok(directRouteJson.route_summary?.distance_meters > 0);
        assert.ok(directRouteJson.counts.total > 0);
        assert.ok(/#\|(LB|LBE):/.test(directRouteJson.share_url), `Expected one-way LB:/LBE: route + markers in share_url, got ${directRouteJson.share_url}`);
        assert.ok(parseShareUrlPolylinePoints(directRouteJson.share_url)?.length >= 2);

        // 5. Built-in list_osm_tags recognizes traffic light queries
        const tagRes = await client.callTool({
            name: "list_osm_tags",
            arguments: { category: "traffic light" }
        });
        assert.strictEqual(tagRes.isError, undefined);
        assert.strictEqual(tagRes.structuredContent.source, "built-in");
        assert.ok(tagRes.structuredContent.recommendations_text.includes("traffic_signals"));
    });

    await t.test("concurrency & Overpass runtime-error regression tests with local mock server", async () => {
        nominatimRequestTimes.length = 0;

        const mockTransport = new StdioClientTransport({
            command: "node",
            args: ["./dist/index.js"],
            env: {
                ...process.env,
                NOMINATIM_API_URL: mockBaseUrl,
                OVERPASS_API_URL: `${mockBaseUrl}/overpass-runtime-error`,
                OVERPASS_DISABLE_PUBLIC_FALLBACK: "1"
            }
        });
        const mockClient = new Client({ name: "mock-test-client", version: "1.0.0" }, { capabilities: {} });
        await mockClient.connect(mockTransport);

        try {
            // 1. Fire 3 concurrent reverse_geocode calls for distinct coordinates
            const [r1, r2, r3] = await Promise.all([
                mockClient.callTool({ name: "reverse_geocode", arguments: { lat: 40.71, lng: -74.01 } }),
                mockClient.callTool({ name: "reverse_geocode", arguments: { lat: 40.72, lng: -74.02 } }),
                mockClient.callTool({ name: "reverse_geocode", arguments: { lat: 40.73, lng: -74.03 } })
            ]);
            assert.strictEqual(r1.isError, undefined);
            assert.strictEqual(r2.isError, undefined);
            assert.strictEqual(r3.isError, undefined);
            assert.strictEqual(nominatimRequestTimes.length, 3, "Expected 3 uncached requests to reach mock Nominatim");

            const gap1 = nominatimRequestTimes[1] - nominatimRequestTimes[0];
            const gap2 = nominatimRequestTimes[2] - nominatimRequestTimes[1];
            assert.ok(gap1 >= 900, `Expected >= 900ms between concurrent requests 1 and 2, got ${gap1}ms`);
            assert.ok(gap2 >= 900, `Expected >= 900ms between concurrent requests 2 and 3, got ${gap2}ms`);

            // 2. Verify Overpass runtime-error response inside HTTP 200 is detected and rejected (not presented as 0 counts)
            const runtimeErrCount = await mockClient.callTool({
                name: "search_overpass",
                arguments: {
                    bbox: "40.70,-74.01,40.71,-74.00",
                    query: 'nwr["amenity"="cafe"]',
                    count_only: true
                }
            });
            assert.strictEqual(runtimeErrCount.isError, true, "Expected isError=true when Overpass returns a runtime-error remark");
            assert.ok(runtimeErrCount.content[0].text.includes("Overpass runtime error"), `Expected runtime error message, got: ${runtimeErrCount.content[0].text}`);
        } finally {
            await mockTransport.close();
        }
    });

    await t.test("search_places queries mock Overture GeoParquet with filtering, pagination, caching, and mirror fallback", async () => {
        // 1. Validation: missing location & bbox
        const missingLocRes = await client.callTool({
            name: "search_places",
            arguments: { query: "coffee" }
        });
        assert.strictEqual(missingLocRes.isError, true);

        // 2. Validation: out-of-range min_confidence
        const badConfRes = await client.callTool({
            name: "search_places",
            arguments: { bbox: "40.753,-73.988,40.758,-73.983", min_confidence: 1.5 }
        });
        assert.strictEqual(badConfRes.isError, true);

        // 3. Category matching excludes 'barber_shop' when querying 'bar', and default excludes permanently_closed & outside bbox
        const barRes = await client.callTool({
            name: "search_places",
            arguments: { bbox: "40.753,-73.988,40.758,-73.983", category: "bar" }
        });
        assert.strictEqual(barRes.isError, undefined, barRes.content?.[0]?.text);
        const barData = barRes.structuredContent;
        assert.strictEqual(barData.release, "2026-10-21.0");
        assert.strictEqual(barData.count, 1);
        assert.strictEqual(barData.places[0].id, "place-jazz-bar");
        assert.ok(barData.share_url.startsWith("https://vibhorsingh.com/boundingbox/"), `Unexpected share_url: ${barData.share_url}`);
        const metadata = JSON.parse(Buffer.from(barData.share_url.split("|MCP:")[1], "base64url"));
        assert.equal(metadata.returned, barData.returned_count);
        assert.match(metadata.source, /Overture Maps Places/);
        assert.strictEqual(overtureStats.londonAwsHits, 0, "NYC bbox should prune London STAC partition completely");

        // 4. Category 'coffee shop' + min_confidence + default closed exclusion + brand/websites/phones/sources
        const coffeeRes = await client.callTool({
            name: "search_places",
            arguments: {
                bbox: "40.753,-73.988,40.758,-73.983",
                category: "coffee shop",
                min_confidence: 0.7,
                sort_by: "confidence"
            }
        });
        const coffeeData = coffeeRes.structuredContent;
        assert.strictEqual(coffeeData.count, 2, "Should include Blue Bottle & Starbucks; exclude closed, low-conf, and uptown");
        assert.strictEqual(coffeeData.places[0].id, "place-blue-bottle");
        assert.strictEqual(coffeeData.places[0].brand?.name, "Blue Bottle");
        assert.strictEqual(coffeeData.places[0].brand?.wikidata, "Q4928901");
        assert.deepStrictEqual(coffeeData.places[0].websites, ["https://bluebottlecoffee.com"]);
        assert.deepStrictEqual(coffeeData.places[0].phones, ["+15106533394"]);
        assert.deepStrictEqual(coffeeData.places[0].emails, ["hello@bluebottlecoffee.com"]);
        assert.deepStrictEqual(coffeeData.places[0].socials, ["https://instagram.com/bluebottle"]);
        assert.deepStrictEqual(coffeeData.places[0].sources, ["meta", "Foursquare"]);
        assert.strictEqual(coffeeData.complete, true);

        // 5. include_closed: true includes permanently_closed place
        const withClosedRes = await client.callTool({
            name: "search_places",
            arguments: {
                bbox: "40.753,-73.988,40.758,-73.983",
                category: "coffee_shop",
                include_closed: true,
                min_confidence: 0.7
            }
        });
        assert.strictEqual(withClosedRes.structuredContent.count, 3);
        assert.ok(withClosedRes.structuredContent.places.some(p => p.operating_status === "permanently_closed"));

        // 6. Query text filter + count_only breakdown
        const starbucksRes = await client.callTool({
            name: "search_places",
            arguments: {
                bbox: "40.753,-73.988,40.758,-73.983",
                query: "starbucks 1585"
            }
        });
        assert.strictEqual(starbucksRes.structuredContent.count, 1);
        assert.strictEqual(starbucksRes.structuredContent.places[0].id, "place-starbucks");

        const countOnlyRes = await client.callTool({
            name: "search_places",
            arguments: {
                bbox: "40.753,-73.988,40.758,-73.983",
                count_only: true
            }
        });
        const countData = countOnlyRes.structuredContent;
        assert.strictEqual(countData.count, 5);
        assert.strictEqual(countData.returned_count, 0);
        assert.deepStrictEqual(countData.places, []);
        assert.ok(countData.category_counts.some(c => c.category === "coffee_shop" && c.count === 3));

        // 7. Single point defaults to 500m circle mode + pagination + query cache hit
        const page1Res = await client.callTool({
            name: "search_places",
            arguments: {
                bbox: "40.7558,-73.9854",
                limit: 2,
                offset: 0
            }
        });
        const p1 = page1Res.structuredContent;
        assert.ok(p1.count >= 4);
        assert.strictEqual(p1.returned_count, 2);
        assert.strictEqual(p1.has_more, true);
        assert.strictEqual(p1.next_offset, 2);
        assert.strictEqual(p1.truncated, true);
        assert.ok(p1.warnings.some(w => w.includes("500m")));

        const page2Res = await client.callTool({
            name: "search_places",
            arguments: {
                bbox: "40.7558,-73.9854",
                limit: 2,
                offset: 2
            }
        });
        const p2 = page2Res.structuredContent;
        assert.strictEqual(p2.provenance.cached, true);
        assert.notStrictEqual(p2.places[0].id, p1.places[0].id);

        // 8. Mirror fallback: London AWS mirror returns 503 -> falls back to Azure 206
        const londonRes = await client.callTool({
            name: "search_places",
            arguments: { bbox: "51.50,-0.14,51.52,-0.11", category: "coffee_shop" }
        });
        assert.strictEqual(londonRes.isError, undefined, londonRes.content?.[0]?.text);
        const londonData = londonRes.structuredContent;
        assert.strictEqual(londonData.count, 1);
        assert.strictEqual(londonData.places[0].name, "Monmouth Coffee Company");
        assert.ok(overtureStats.londonAwsHits >= 1, "Expected AWS primary request attempt");
        assert.ok(overtureStats.londonAzureHits >= 1, "Expected Azure fallback read");
        assert.ok(londonData.warnings.some(w => w.toLowerCase().includes("azure")), "Expected mirror fallback warning");
    });

    await t.test("search_places supports collection.json fallback, use_area_boundary polygon clip, and OVERTURE_MAX_ROW_GROUPS guard", async () => {
        const fbTransport = new StdioClientTransport({
            command: "node",
            args: ["./dist/index.js"],
            env: {
                ...process.env,
                NOMINATIM_API_URL: mockBaseUrl,
                OVERTURE_STAC_URL: `${mockBaseUrl}/overture-fallback/catalog.json`,
                OVERTURE_MAX_ROW_GROUPS: "3"
            }
        });
        const fbClient = new Client({ name: "test-overture-fb", version: "1.0.0" }, { capabilities: {} });
        await fbClient.connect(fbTransport);

        try {
            // 1. collection.json fallback (since collections.parquet returns 404) + location + use_area_boundary polygon filter
            // Notice polygon covers lat 40.7550..40.7570, lon -73.9866..-73.9846 -> excludes Midnight Jazz Bar (40.7545, -73.9845)
            const boundaryRes = await fbClient.callTool({
                name: "search_places",
                arguments: {
                    location: "Times Square",
                    use_area_boundary: true,
                    min_confidence: 0.7
                }
            });
            assert.strictEqual(boundaryRes.isError, undefined, boundaryRes.content?.[0]?.text);
            const bData = boundaryRes.structuredContent;
            assert.strictEqual(bData.matched_place, "Times Square Polygon Area");
            assert.ok(!bData.places.some(p => p.id === "place-jazz-bar"), "Midnight Jazz Bar outside polygon boundary should be filtered out");
            assert.ok(bData.places.some(p => p.id === "place-blue-bottle"));

            // 2. OVERTURE_MAX_ROW_GROUPS guard (part-many-rg.parquet has 5 row groups > cap 3)
            const capRes = await fbClient.callTool({
                name: "search_places",
                arguments: {
                    bbox: "37.77,-122.42,37.785,-122.41"
                }
            });
            assert.strictEqual(capRes.isError, true);
            assert.ok(capRes.content[0].text.includes("OVERTURE_MAX_ROW_GROUPS"));
        } finally {
            await fbTransport.close();
        }
    });
});
