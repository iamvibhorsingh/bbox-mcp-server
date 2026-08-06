import test from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP Server Test Suite", async (t) => {
    const transport = new StdioClientTransport({
        command: "node",
        args: ["./dist/index.js"],
    });

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    t.after(async () => {
        await transport.close();
    });

    await t.test("listTools returns expected tools", async () => {
        const tools = await client.listTools();
        assert.deepStrictEqual(
            tools.tools.map(t => t.name),
            ["get_bounds", "get_h3_indices", "generate_share_url", "reverse_geocode", "search_overpass", "list_osm_tags", "aggregate_overpass_h3"]
        );
    });

    await t.test("get_bounds - happy path", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", epsg: "3857", format: "geojson-bbox" }
        });
        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("Original WGS84"));
        assert.ok(result.content[0].text.includes("Projected to EPSG:3857"));
        assert.ok(result.content[0].text.includes("View on map"));
    });

    await t.test("get_bounds - coord_order lat,lng and center/tile fields", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", format: "csv", coord_order: "lat,lng", zoom: 12 }
        });
        assert.strictEqual(result.isError, undefined);

        const textOutput = result.content[0].text;
        assert.ok(textOutput.includes("40.712800,-74.006000,40.758000,-73.985500"));

        const jsonOutput = JSON.parse(result.content[1].text);
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

    await t.test("get_bounds - format sniff WKT", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "POLYGON((-74.0060 40.7128, -73.9855 40.7128, -73.9855 40.7580, -74.0060 40.7580, -74.0060 40.7128))" }
        });
        assert.strictEqual(result.isError, undefined);
        const jsonResponse = JSON.parse(result.content[1].text);
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
        const jsonResponse = JSON.parse(result.content[1].text);
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
        const jsonResponse = JSON.parse(result.content[1].text);
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
    });

    await t.test("get_h3_indices - summary_only mode", async () => {
        const result = await client.callTool({
            name: "get_h3_indices",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", resolution: 8, summary_only: true }
        });
        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("H3 summary"));
        const jsonResponse = JSON.parse(result.content[1].text);
        assert.strictEqual(jsonResponse.summary_only, true);
        assert.ok(Array.isArray(jsonResponse.sample_cells));
        assert.strictEqual(jsonResponse.cells, undefined);
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
            arguments: { bbox: "-90,-180,90,180", resolution: 10 }
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
        const jsonOutput = JSON.parse(result.content[1].text);
        assert.strictEqual(jsonOutput.center.lat, 40.73);
        assert.strictEqual(jsonOutput.center.lng, -73.99);
        assert.ok(jsonOutput.matched_place);
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

    await t.test("search_overpass - happy path with distance & pagination", async () => {
        const jfkBbox = "40.63,-73.79,40.65,-73.76";
        const query = 'nwr["amenity"="parking"]';

        const result = await client.callTool({
            name: "search_overpass",
            arguments: { bbox: jfkBbox, query, limit: 5, offset: 0 }
        });

        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("Overpass query executed within a"));
        const jsonResponse = JSON.parse(result.content[1].text);

        assert.ok(jsonResponse.elements.length > 0, "Expected elements near JFK");
        assert.ok(jsonResponse.elements[0].distance_meters !== undefined, "Expected distance_meters");
        assert.ok(jsonResponse.distance_from, "Expected distance_from reference metadata");
    });

    await t.test("list_osm_tags - happy path pre-indexed", async () => {
        const result = await client.callTool({
            name: "list_osm_tags",
            arguments: { category: "food" }
        });

        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("nwr[\"amenity\"=\"restaurant\"]"));
        assert.ok(result.content[0].text.includes("nwr[\"amenity\"=\"fast_food\"]"));
    });

    await t.test("list_osm_tags - Taginfo fallback for unknown category", async () => {
        const result = await client.callTool({
            name: "list_osm_tags",
            arguments: { category: "coworking" }
        });

        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("Coworking Spaces") || result.content[0].text.includes("Taginfo"));
    });

    await t.test("aggregate_overpass_h3 - happy path", async () => {
        const jfkBbox = "40.63,-73.79,40.65,-73.76";
        const query = 'nwr["amenity"="parking"]';

        const result = await client.callTool({
            name: "aggregate_overpass_h3",
            arguments: { bbox: jfkBbox, query, resolution: 8 }
        });

        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("Aggregated"));

        const jsonResponse = JSON.parse(result.content[1].text);

        assert.strictEqual(jsonResponse.resolution, 8);
        assert.ok(jsonResponse.total_elements > 0);
        assert.ok(jsonResponse.active_hex_count > 0);
        assert.ok(jsonResponse.hex_geojson.type === "FeatureCollection");
    });;
});
