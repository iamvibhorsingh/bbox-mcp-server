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
        const names = tools.tools.map(tool => tool.name);
        assert.deepStrictEqual(names, ["get_bounds", "get_h3_indices", "generate_share_url"]);
    });

    await t.test("get_bounds - happy path", async () => {
        const result = await client.callTool({
            name: "get_bounds",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", epsg: "3857", format: "geojson-bbox" }
        });
        assert.strictEqual(result.isError, undefined); // MCP SDK doesn't always return isError: false, often it's just undefined or missing if okay
        assert.ok(result.content[0].text.includes("Original WGS84"));
        assert.ok(result.content[0].text.includes("Projected to EPSG:3857"));
        assert.ok(result.content[0].text.includes("View on map"));
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
        // Check Area and Dimensions string
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
        // Expect format to be truncated to 2 decimals
        assert.ok(result.content[0].text.includes("-74.01,40.71,-73.99,40.76"));
    });

    await t.test("get_h3_indices - happy path", async () => {
        const result = await client.callTool({
            name: "get_h3_indices",
            arguments: { bbox: "40.7128,-74.0060,40.7580,-73.9855", resolution: 7, compact: true }
        });
        assert.strictEqual(result.isError, undefined);
        assert.ok(result.content[0].text.includes("H3 Cells Generated"));
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
});
