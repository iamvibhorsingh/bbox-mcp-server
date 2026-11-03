import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP Server Test Suite", async (t) => {
    const nominatimRequestTimes = [];

    const mockServer = http.createServer((req, res) => {
        if (req.url?.startsWith("/reverse")) {
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
    const mockBaseUrl = `http://127.0.0.1:${port}`;

    const transport = new StdioClientTransport({
        command: "node",
        args: ["./dist/index.js"],
        env: {
            ...process.env,
            OVERPASS_API_URL: `${mockBaseUrl}/overpass-ok`
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
                "spatial_calc"
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
        assert.ok(dbJson.distance_meters > 5000 && dbJson.distance_meters < 6000);
        assert.ok(dbJson.cardinal_direction);
        assert.ok(dbJson.share_url.includes("#|PB:"), `Expected no orange bbox (#|PB:) in distance_bearing share_url, got ${dbJson.share_url}`);

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

    await t.test("get_elevation - point lookup and grid sample_stats with 90m DEM resolution", async () => {
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
    });

    await t.test("calculate_route - returns route_geometry LineString and draws route path (PB:) on verification map", async () => {
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
        assert.ok(routeJson.share_url.includes("vibhorsingh.com/boundingbox/#|PB:"), `Expected #|PB: drawn route path (without orange bbox) in share_url, got ${routeJson.share_url}`);
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
});
