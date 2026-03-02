import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runTest() {
    console.log("Starting MCP Client Test...");

    // Connect to the local MCP server we just built
    const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/index.js"]
    });

    const client = new Client({
        name: "test-client",
        version: "1.0.0"
    }, {
        capabilities: {}
    });

    try {
        await client.connect(transport);
        console.log("Connected to bbox-mcp-server");

        console.log("\n--- Testing search_overpass ---");

        // Let's use a slightly larger bounding box of Central Park, and search for benches!
        // There are thousands of benches in Central park.
        const bbox = "40.764,-73.973,40.781,-73.956";
        const query = 'node["amenity"="bench"]';

        console.log(`Searching for: ${query} in bbox: ${bbox}`);

        const result = await client.callTool({
            name: "search_overpass",
            arguments: {
                bbox: bbox,
                query: query
            }
        });

        if (result.isError) {
            console.error("Tool returned an error:", result.content);
        } else {
            console.log("\nSuccess! Summary of results:");
            console.log(result.content[0].text);

            const jsonStr = result.content[1]?.text as string;
            if (jsonStr) {
                const data = JSON.parse(jsonStr);
                console.log(`\nParsed JSON confirmed: ${data.elements?.length} elements returned.`);
            }
        }

    } catch (err: any) {
        console.error("Test failed with exception:", err.message);
    } finally {
        await client.close();
        console.log("\nTest completed.");
    }
}

runTest();
