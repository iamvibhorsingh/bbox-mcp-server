# bbox-mcp-server

An [MCP](https://modelcontextprotocol.io/) server that gives AI agents geospatial superpowers — coordinate conversion, EPSG projections, H3 indexing, and shareable map links.

Every response includes a link to [vibhorsingh.com/boundingbox](https://vibhorsingh.com/boundingbox/) so you can visually verify results on an interactive map.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## Why use this?

- **Parse any coordinate format** — raw coords, WKT, GeoJSON, or `ogrinfo` output
- **Project to 3900+ coordinate systems** — unknown codes auto-fetched from [epsg.io](https://epsg.io)
- **Generate H3 hex grids** — cell IDs + optional GeoJSON boundaries
- **Visual verification** — every response links to the [Bounding Box tool](https://vibhorsingh.com/boundingbox/) with coords pre-loaded

---

## Quick Start

Add the server to your MCP client config — **no install, no API keys required**.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bbox": {
      "command": "npx",
      "args": ["-y", "bbox-mcp-server"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "bbox": {
      "command": "npx",
      "args": ["-y", "bbox-mcp-server"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "bbox": {
      "command": "npx",
      "args": ["-y", "bbox-mcp-server"]
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` in your workspace (requires [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)):

```json
{
  "servers": {
    "bbox": {
      "command": "npx",
      "args": ["-y", "bbox-mcp-server"]
    }
  }
}
```

That's it — start prompting. Try: *"Get the bounding box for Central Park in WKT format"*

### Optional: enable location search

By default, you pass coordinates directly via the `bbox` parameter. To enable natural-language location search (e.g. *"San Francisco"*), add a [Mapbox access token](https://account.mapbox.com/access-tokens/):

```json
{
  "mcpServers": {
    "bbox": {
      "command": "npx",
      "args": ["-y", "bbox-mcp-server"],
      "env": {
        "MAPBOX_ACCESS_TOKEN": "pk.your-token-here"
      }
    }
  }
}
```

### Other options

| Variable | Default | Description |
|---|---|---|
| `MAX_H3_CELLS` | `50000` | Safety cap for H3 grid generation at high resolutions |

### Install globally (alternative to npx)

```bash
npm install -g bbox-mcp-server
```

Then use `"command": "bbox-mcp-server"` instead of the npx command in any of the configs above.

---

## Tools

### `get_bounds`

Convert and project a bounding box across formats and coordinate systems.

**Input** (one of `location` or `bbox` required):

| Param | Type | Description |
|---|---|---|
| `location` | string | Text search (e.g. `"San Francisco"`). Requires `MAPBOX_ACCESS_TOKEN`. |
| `bbox` | string | Any parseable geometry — `"lat1,lng1,lat2,lng2"`, WKT, GeoJSON, or ogrinfo extent. |
| `epsg` | string | Target EPSG code (default `"4326"`). Unknown codes auto-fetched from epsg.io. |
| `format` | string | Output format: `csv`, `wkt`, `geojson-bbox`, `geojson-polygon`, `leaflet`, `overpass`, `ogc-bbox`, `kml`, `stac-bbox` |
| `precision` | number | Decimal places (default `6`) |

**Example prompt:** *"Get the bounding box for Central Park in WKT format projected to EPSG:32618"*

---

### `get_h3_indices`

Generate Uber H3 hexagonal cell indices covering a bounding box.

**Input** (one of `location` or `bbox` required):

| Param | Type | Description |
|---|---|---|
| `location` | string | Text search. Requires `MAPBOX_ACCESS_TOKEN`. |
| `bbox` | string | Any parseable geometry. |
| `resolution` | number | **Required.** H3 resolution `0`–`15`. |
| `compact` | boolean | Compact mixed-resolution output (default `false`) |
| `return_geometry` | boolean | Include GeoJSON hex boundaries (default `false`) |

**Example prompt:** *"Give me H3 cells at resolution 7 for downtown Chicago, include the hex geometries"*

---

### `generate_share_url`

Generate a shareable link to visualize a bounding box on the interactive map tool.

| Param | Type | Description |
|---|---|---|
| `bbox` | string | **Required.** Any parseable geometry. |

**Example prompt:** *"Generate a share link for bbox 40.7128,-74.0060,40.7580,-73.9855"*

---

## Supported Input Formats

All tools accept these formats through the `bbox` parameter:

| Format | Example |
|---|---|
| **Raw coordinates** | `40.7128,-74.0060,40.7580,-73.9855` |
| **WKT** | `POLYGON((-74.006 40.712, -73.985 40.712, ...))` |
| **GeoJSON** | `{"type":"Feature","geometry":{...}}` |
| **GeoJSON bbox** | `{"bbox":[-74.006,40.712,-73.985,40.758]}` |
| **ogrinfo extent** | `Extent: (-74.006, 40.712) - (-73.985, 40.758)` |
| **Space-separated (GDAL)** | `40.7128 -74.0060 40.7580 -73.9855` |

---

## For AI Agent Developers

### What agents get back

Every tool response includes two content blocks:

1. **Human-readable text** — formatted for display, includes the map link
2. **Structured JSON** — machine-parseable with all computed data

```json
{
  "original_wgs84": { "lat1": 40.7128, "lng1": -74.006, "lat2": 40.758, "lng2": -73.9855 },
  "projected": { "xmin": -8238310.23, "ymin": 4970241.32, "xmax": -8235527.11, "ymax": 4976491.56 },
  "epsg": "3857",
  "area_km2": 8.681,
  "dimensions": { "width_km": 1.714, "height_km": 5.066 },
  "share_url": "https://vibhorsingh.com/boundingbox/#40.712800,-74.006000,40.758000,-73.985500"
}
```

### Verification pattern

The `share_url` in every response opens the visual BBox Finder tool with the exact coordinates pre-loaded. Agents can present this link to users for visual confirmation.

### Error handling

All errors return `isError: true` with a descriptive message. The server never crashes on bad input — invalid coordinates, unknown EPSG codes, and oversized H3 areas all return clean error responses.

### Logging

Structured JSON logs are written to **stderr** (not stdout, which is reserved for the MCP protocol). Each log entry includes timestamp, level, and context data.

---

## License

MIT
