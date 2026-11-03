# 🌍 bbox-mcp-server

**FREE Geospatial tools for AI agents, with results you can inspect on a map.**

Search OpenStreetMap, convert coordinates, generate H3 grids, calculate routes, and sample terrain elevation. **10 MCP tools, no API keys required to get started.** Spatial results include shareable links to the [interactive map](https://vibhorsingh.com/boundingbox/).

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## Try asking

- “Find cafes near Times Square.”
- “Find me pizza near the Colosseum?”
- “Eiffel Tower to the Louvre: walk or bike? Compare the routes.”
- “Where are Manhattan’s coffee hotspots?”
- “EV road trip: find chargers within 5km of Monterey.”
- “How high up is Denver, really?”

## Quick start

Requires **Node.js 18+**. Add this to your MCP client configuration:

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

| Client | Configuration file |
|---|---|
| Claude Desktop | `claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (GitHub Copilot) | `.vscode/mcp.json` - use `servers` instead of `mcpServers` |

## Tools

| Tool | What it does |
|---|---|
| `get_bounds` | Find, buffer, convert, and project bounding boxes across formats and coordinate systems. |
| `get_h3_indices` | Generate H3 cells for a bounding box or exact polygon boundary, including holes. |
| `generate_share_url` | Create a shareable map link for a bounding box. |
| `reverse_geocode` | Resolve coordinates to an address and OpenStreetMap details. |
| `search_overpass` | Find or count OSM features within an area, bounding box, or radius. |
| `list_osm_tags` | Find OSM tags by category using curated suggestions and Taginfo fallback. |
| `aggregate_overpass_h3` | Group OSM query results into H3 hexagons for density analysis. |
| `calculate_route` | Get driving, walking, or cycling distance, duration, and route geometry. |
| `get_elevation` | Get elevation for points or sample a terrain grid using the 90m Copernicus DEM. |
| `spatial_calc` | Calculate geometry relations, point containment, distance/bearing, and grid subdivisions offline. |

Your MCP client discovers each tool's full parameter and output schemas automatically. H3 tools use `resolution` (0–15).

## Inputs and outputs

Tools with a `location` parameter accept place names. Tools with a `bbox` parameter auto-detect raw coordinates, single points, `z/x/y` tiles, WKT, GeoJSON, GeoJSON bboxes, and `ogrinfo` extents.

**Coordinate order:** raw bboxes default to `lat1,lng1,lat2,lng2`; points use `lat,lng`. Use GeoJSON or WKT to avoid ambiguity, for example `{"bbox":[-74.006,40.712,-73.985,40.758]}` in west/south/east/north order. `coord_order` on `get_bounds` controls formatted output only.

`get_bounds` supports 3,900+ bundled projections via `epsg` and nine output formats: `csv`, `wkt`, `geojson-bbox`, `geojson-polygon`, `leaflet`, `overpass`, `ogc-bbox`, `kml`, and `stac-bbox`.

For Overpass searches, supply a selector such as `nwr["amenity"="cafe"]`; the server adds spatial filters. Set `radius_meters` for an explicit distance or omit it to search the area. Use `list_osm_tags` to find selectors by category.

## Configuration

Place search uses Nominatim with Photon fallback; a Mapbox token is optional. Defaults work without configuration.

<details>
<summary>Optional environment variables</summary>

Add an `env` object alongside `command` and `args` in your server configuration.

| Variable | Purpose / default |
|---|---|
| `OSM_USER_AGENT` | Identify your application and contact; defaults to the server name, version, and repository URL. |
| `NOMINATIM_EMAIL` | Optional contact email for Nominatim requests. |
| `NOMINATIM_API_URL` | Geocoder endpoint; defaults to `https://nominatim.openstreetmap.org`. |
| `PHOTON_API_URL` | Fallback geocoder; defaults to `https://photon.komoot.io`. |
| `MAPBOX_ACCESS_TOKEN` | Optional additional geocoding fallback. |
| `OVERPASS_API_URL` | Custom Overpass endpoint(s); defaults rotate across public instances. |
| `OSRM_API_URL` | Preferred routing endpoint; defaults use public OSRM services. |
| `ELEVATION_API_URL` | Elevation endpoint; defaults to `https://api.open-meteo.com/v1/elevation`. |
| `MAX_H3_CELLS` | H3 generation cap; defaults to `50000`. |

</details>

## For developers

Successful calls return readable `content` and `structuredContent` matching the tool's output schema, including `provenance`, `complete`, and `warnings`. Spatial tools also return `share_url`. Errors use `isError: true`; structured logs go to stderr, keeping stdout reserved for MCP.

To run from source:

```sh
npm install
npm test
npm start
```

`npm test` builds the server and runs the test suite.

## Data and service use

Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Public services have usage limits: avoid bulk scraping and frequent polling, and configure your own endpoints for shared or heavy workloads.

- [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) and [FOSSGIS routing](https://routing.openstreetmap.de/about.html) limit requests to 1 per second. Nominatim also requires application identification, caching, and attribution. The server's per-process queue does not cover traffic across multiple instances.
- [Photon's public endpoint](https://github.com/komoot/photon#demo-server) is a demo service without availability guarantees.
- [Open-Meteo's free API](https://open-meteo.com/en/terms) is for non-commercial use. Elevation grids return sample statistics, not guaranteed terrain-wide extrema or slopes.

[MIT License](./LICENSE)
