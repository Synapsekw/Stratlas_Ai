# @aio/maps

Offline 2D map (MapLibre GL JS 6 + PMTiles + Protomaps basemap) and the M1 3D ground for
`basemap` layers. Owner: stream S5. See `docs/architecture/SPEC.md` section 5.

## Packs

Built once, online, by `node tools/maps/build-packs.mjs` (see the header of that file) into
`<dataRoot>/packs/<id>.pmtiles` + `<id>.json` (`MapPackInfo`):

| id     | bbox                   | zooms | size (planet build 20261003) |
| ------ | ---------------------- | ----- | ---------------------------- |
| world  | whole world            | 0-6   | 45 MB                        |
| gcc    | 34.5, 12.0, 60.0, 32.5 | 0-15  | 1.31 GB                      |
| kuwait | 46.5, 28.5, 48.5, 30.1 | 0-15  | 24 MB                        |

The same tool fetches the glyph PBFs (Noto Sans Regular, Medium, Italic; Latin and Arabic
ranges) into the git-ignored `assets/fonts/`: run `node tools/maps/build-packs.mjs --assets-only`
after a fresh clone. Sprites (`assets/sprites/dark*`) are small and committed.

## Runtime

- One merged vector source `aiomap://tiles/{z}/{x}/{y}`: the internal `aiomap` MapLibre protocol
  (`src/protocol.ts`) picks, per tile, the world pack up to its maxZoom and regional street packs
  above, reading `aio://packs/<id>.pmtiles` with range requests. Above z6 outside a regional pack
  the map is empty.
- Glyphs and sprites resolve to files bundled by Vite (`?url` imports). No URL in the style
  leaves `aiomap://` (tested in `style.test.ts`). Arabic is shaped natively by MapLibre 6.
- Style: Protomaps `dark` flavour retuned to the Mission palette; labels follow
  `<html lang>`: `en` shows English with the Arabic local name beneath, `ar` shows Arabic.
- `MapView` takes an optional `draw` seam (`MapDrawSeam`): while its `mode` is set, clicks add
  vertices (the second click of a double click is dropped), a double click finishes instead of
  zooming, the cursor is a crosshair and `drawPreview` draws the shape so far.
- `MapView` reads packs from `packs:list`, centres and fits on the open project (manifest
  `origin`, WGS84 UTM or EPSG 4326), and draws project image rasters (and kit pyramids at one
  coarse level), every video layer's flight path, the active clip's drone and ground footprint at
  `workspace.nowMs`, issues anchored by map, mesh or point cloud sightings, and a wedge for the 3D
  camera. Click an issue or flight to select it; Alt+click flies the 3D camera to that point.
- Issues are a clustered GeoJSON source: count badges in the colour of the worst member (from the
  project's severity models), a badge click zooms to where it splits, codes from z17 where they
  fit. The selected issue is never clustered; hover shows a code. `MapView` `issues`
  (`MapIssueDisplay`: show, minSeverity, heat) follows the app's Pins control and adds a heatmap.
- `registerMapAdapters()` registers a `basemap` ground: the style rendered once (2048 px over a
  5 km square around the origin) by a hidden MapLibre map and draped as a quad at y = -0.2.

## Dev harness

`pnpm -F @aio/maps dev` and open http://localhost:5179: the real controller over the installed
packs and a synthetic Al-Zour project built from the git-ignored design fixtures (packs and
fixtures are served by Vite's `/@fs/` in place of `aio://`).
