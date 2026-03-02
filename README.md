# 🌍 bbox-mcp-server

The geospatial toolkit for AI agents. **6 tools, zero config** — give any LLM the ability to parse, convert, query, and aggregate spatial data out of the box.

Every response includes a verification link to **[vibhorsingh.com/boundingbox](https://vibhorsingh.com/boundingbox/)** so you can visually confirm results on an interactive map.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## Why This Exists

| The problem | How bbox-mcp solves it |
|---|---|
| *"I have WKT but the API needs a GeoJSON bbox in EPSG:3857."* | Parses 6 input formats, projects to 3,900+ EPSG codes, outputs in 9 formats — in one call. |
| *"I keep getting the wrong OSM tags for Overpass queries."* | `list_osm_tags` returns curated tag combos. No more hallucinated `amenity=grocery`. |
| *"How many hospitals are in this district?"* | `aggregate_overpass_h3` queries Overpass and bins results into H3 hexagons server-side. |
| *"Is this bounding box actually correct?"* | Every response includes a clickable map link for visual verification. |

---

## Tools at a Glance

| Tool | What it does | Key params |
|---|---|---|
| `get_bounds` | Convert and project a bbox across formats and coordinate systems | `bbox`, `epsg`, `format`, `coord_order`, `zoom` |
| `get_h3_indices` | Generate H3 hex cell indices covering a bbox | `bbox`, `resolution`, `compact` |
| `generate_share_url` | Create a shareable map link for a bbox | `bbox` |
| `search_overpass` | Query OpenStreetMap via Overpass QL | `bbox`, `query`, `limit` |
| `list_osm_tags` | Look up correct OSM tags for a category | `category` |
| `aggregate_overpass_h3` | Run an Overpass query and bin results into H3 hexagons | `bbox`, `query`, `resolution` |

All tools accept `location` (natural language, requires Mapbox token) or `bbox` (coordinates, WKT, GeoJSON, etc).

---

## Quick Start

Add to your MCP client config:

<details>
<summary><b>Claude Desktop</b> <i>(Click to expand)</i></summary>

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
</details>

<details>
<summary><b>Cursor</b> <i>(Click to expand)</i></summary>

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
</details>

<details>
<summary><b>Windsurf</b> <i>(Click to expand)</i></summary>

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
</details>

<details>
<summary><b>VS Code (GitHub Copilot) or Google Antigravity</b> <i>(Click to expand)</i></summary>

Add to `.vscode/mcp.json` in your workspace:
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
</details>

<br/>

> Try: *"Get the bounding box for Central Park in WKT format"*

### Optional Configuration

```json
{
  "mcpServers": {
    "bbox": {
      "command": "npx",
      "args": ["-y", "bbox-mcp-server"],
      "env": {
        "MAPBOX_ACCESS_TOKEN": "pk.your-token-here",
        "OVERPASS_API_URL": "https://your.custom.overpass.instance/api/interpreter"
      }
    }
  }
}
```

| Variable | Default | Description |
|---|---|---|
| `MAPBOX_ACCESS_TOKEN` | — | Enables natural language location search (e.g. *"San Francisco"*) |
| `OVERPASS_API_URL` | auto | Custom Overpass endpoint. By default, rotates between `overpass-api.de` and `kumi.systems`. |
| `MAX_H3_CELLS` | `50000` | Safety cap for H3 grid generation |

*Or install globally: `npm install -g bbox-mcp-server`*

---

## Tool Reference

### `get_bounds`

Convert and project a bounding box across 6 input formats, 9 output formats, and 3,900+ coordinate systems. Returns the center point and tile coordinates for the centroid.

| Param | Type | Default | Description |
|---|---|---|---|
| `bbox` | string | — | Input geometry (coordinates, WKT, GeoJSON, ogrinfo extent) |
| `epsg` | string | `"4326"` | Target projection. Unknown codes auto-fetched from epsg.io. |
| `format` | string | `"csv"` | Output: `csv`, `wkt`, `geojson-bbox`, `geojson-polygon`, `leaflet`, `overpass`, `ogc-bbox`, `kml`, `stac-bbox` |
| `coord_order` | string | `"lng,lat"` | Swap to `"lat,lng"` for APIs that expect latitude first |
| `zoom` | number | `15` | Zoom level for tile coordinate calculation |
| `precision` | number | `6` | Decimal places in formatted output |

**💡 Prompt:** *"Get the bounding box for Central Park in WKT format projected to EPSG:32618"*

---

### `get_h3_indices`

Generate Uber H3 hexagonal cell indices covering a bounding box.

| Param | Type | Default | Description |
|---|---|---|---|
| `bbox` | string | — | Input geometry |
| `resolution` | number | — | H3 resolution (0–15) |
| `compact` | boolean | `false` | Merge cells into coarser parents where possible |
| `return_geometry` | boolean | `false` | Include GeoJSON hex boundaries |

**💡 Prompt:** *"Give me H3 cells at resolution 7 for downtown Chicago, include the hex geometries"*

---

### `search_overpass`

Execute an Overpass QL query within a bounding box. Returns structured results with names, coordinates, and tags.

| Param | Type | Default | Description |
|---|---|---|---|
| `bbox` | string | — | Input geometry |
| `query` | string | — | Overpass QL (e.g. `nwr["amenity"="cafe"]`). The server wraps it in a bbox filter automatically. |
| `limit` | number | `100` | Max elements returned |

**💡 Prompt:** *"Search for nwr["amenity"="bench"] in Central Park, limit 50"*

---

### `list_osm_tags`

Look up the correct OpenStreetMap tags for a category before writing an Overpass query.

| Param | Type | Description |
|---|---|---|
| `category` | string | Broad category (e.g. `"food"`, `"health"`, `"transport"`) |

**💡 Prompt:** *"What are the correct OSM tags for supermarkets?"*

---

### `aggregate_overpass_h3`

Run an Overpass query and bin results into H3 hexagons for spatial density analysis. Returns counts per cell and GeoJSON hex boundaries.

| Param | Type | Default | Description |
|---|---|---|---|
| `bbox` | string | — | Input geometry |
| `query` | string | — | Overpass QL core query |
| `resolution` | number | `8` | H3 resolution for binning |

**💡 Prompt:** *"Aggregate all hospitals in Seattle into H3 bins at resolution 7"*

---

### `generate_share_url`

Generate a shareable link to visualize a bounding box on the interactive map at vibhorsingh.com/boundingbox.

| Param | Type | Description |
|---|---|---|
| `bbox` | string | Input geometry |

**💡 Prompt:** *"Generate a share link for bbox 40.7128,-74.0060,40.7580,-73.9855"*

---

## Supported Input Formats

All tools auto-detect the input format. No need to specify which one you're using.

| Format | Example |
|---|---|
| Raw coordinates | `40.7128,-74.0060,40.7580,-73.9855` |
| WKT | `POLYGON((-74.006 40.712, -73.985 40.712, ...))` |
| GeoJSON | `{"type":"Feature","geometry":{...}}` |
| GeoJSON bbox | `{"bbox":[-74.006,40.712,-73.985,40.758]}` |
| ogrinfo extent | `Extent: (-74.006, 40.712) - (-73.985, 40.758)` |
| Space-separated | `40.7128 -74.0060 40.7580 -73.9855` |

---

## 🤖 For AI Agent Developers

### Response structure

Every tool returns two content blocks:

1. **Human-readable text** — formatted output with the map verification link
2. **Structured JSON** — all computed data, machine-parseable

Example `get_bounds` JSON response:

```json
{
  "original_wgs84": { "lat1": 40.7128, "lng1": -74.006, "lat2": 40.758, "lng2": -73.9855 },
  "projected": { "xmin": -8238310.23, "ymin": 4970241.32, "xmax": -8235527.11, "ymax": 4976491.56 },
  "center": { "lat": 40.7354, "lng": -73.99575 },
  "tile_indices": { "z": 15, "x": 9660, "y": 12284 },
  "epsg": "3857",
  "coord_order": "lng,lat",
  "area_km2": 8.681,
  "dimensions": { "width_km": 1.714, "height_km": 5.066 },
  "share_url": "https://vibhorsingh.com/boundingbox/#40.712800,-74.006000,40.758000,-73.985500"
}
```

### Error handling

All errors return `isError: true` with a descriptive message. Invalid coordinates, unknown EPSG codes, and oversized H3 requests all return clean errors — the server never crashes on bad input.

### Logging

Structured JSON logs go to **stderr** (stdout is reserved for MCP protocol). Each entry includes timestamp, level, and context.

---

## License

MIT
