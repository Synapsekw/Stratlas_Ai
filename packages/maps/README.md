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

In the app, Settings, Offline maps manages packs (`PackCoverage` draws them on a small world map):
import a `.pmtiles` file (with an optional `MapPackInfo` `.json` beside it), remove a pack, or
add a region online by country (`regions.ts`: GCC states and a world list) or a drawn box at a
chosen max zoom, with a size estimate (`estimate.ts`, fitted to the packs above). Downloads are a
TypeScript PMTiles extract over HTTP ranges in the main process (`apps/desktop/src/main/packs/`),
resume from the partial file after a dropped link or a restart, are verified (size, every gzip
tile's CRC-32, header zoom and area) and written with `source`, `build` and `builtAt`.

## Runtime

- One merged vector source `aiomap://tiles/{z}/{x}/{y}`: the internal `aiomap` MapLibre protocol
  (`src/protocol.ts`) picks, per tile, the world pack up to its maxZoom and regional street packs
  above, reading `aio://packs/<id>.pmtiles` with range requests. Above z6 outside a regional pack
  the map is empty.
- Glyphs and sprites resolve to files bundled by Vite (`?url` imports). No URL in the style
  leaves `aiomap://` (tested in `style.test.ts`). Arabic is shaped natively by MapLibre 6.
- Style: one street style, always dark (founder decision 2026-10-05), in every app theme and
  everywhere a map appears (Map view, split panes, the 3D `basemap` ground, road workspace, the
  wizard and georeference pickers, Settings coverage, the package player). It is the Protomaps
  `dark` flavour retuned to the Mission tokens (`src/ink.ts`: `STREET` for the basemap,
  `MAP_INK` for overlays, both converted from the tokens' oklch): land, water and land use a few
  steps apart, roads lighter by class, labels between `--fg-3` and `--fg-1`, no severity hue or
  accent in the basemap, POI icons dimmed. `style.test.ts` checks the contrasts. A `basemap`
  layer's `style` field is not read. Map roots carry `aio-map` and `data-surface="dark"`, so
  the dark Mission tokens apply inside them (controls, popups, status text, `src/map.css`) even in
  the light app theme. Labels follow `<html lang>`: `en` shows English with the Arabic local name
  beneath, `ar` shows Arabic.
- `MapView` takes an optional `draw` seam (`MapDrawSeam`): while its `mode` is set, clicks add
  vertices (the second click of a double click is dropped), a double click finishes instead of
  zooming, the cursor is a crosshair and `drawPreview` draws the shape so far.
- `MapView` reads packs from `packs:list`, centres and fits on the open project (manifest
  `origin`, WGS84 UTM or EPSG 4326), and draws project image rasters, every video layer's flight
  path, the active clip's drone and ground footprint at `workspace.nowMs`, issues anchored by map,
  mesh or point cloud sightings, and a wedge for the 3D camera (`cameraWedge`). Click an issue or
  flight to select it; Alt+click flies the 3D camera to that point. Hovering an issue or an
  overlay feature shows a tooltip.
- Kit pyramids draw at full detail: one coarse level (at most 16 tiles) stays as a backdrop and
  `pyramidView` picks, after every move, the coarsest level as sharp as the screen and the tiles
  in view (at most 48) as image sources. A tile missing from the package is not asked for again.
- Issues are clustered GeoJSON sources: count badges in the colour of the worst member (from the
  project's severity models), a badge click zooms to where it splits, codes from z17 where they
  fit. The selected issue is never clustered; hover shows a code and a tooltip. `MapView` `issues`
  (`MapIssueDisplay`: show, minSeverity, heat) follows the app's Pins control and adds a heatmap.
- Issues with a Polygon or MultiPolygon map sighting draw as polygons from z17 and are clustered
  points below (their own source, clustering up to z16; other issues cluster up to z19). Markers
  and shapes are coloured by their severity model (`issueColorBy="class"`: by class colour),
  higher severities on top; the selected one gets a white halo. `issueFilter` keeps only the
  given issue ids. `issueFeatures` builds every issue feature (points, focus, heat, shapes).
- GeoJSON overlay seam: `overlays` (`MapOverlay[]`: inline features or an `aio://` URL, MapLibre
  style layers, `visible`, optional `tooltip` and `onClick`) draw between the rasters and the
  issues (`above: true` layers over them). Manifest `vector` layers become overlays through
  `styleLayers` (line, fill, circle, label, step `colorBy`, `minZoom`) and follow layer visibility.
- The map follows `workspace.lastCamera`: a point request centres it (its distance sets the
  zoom), an issue request fits its polygon, home fits the project.
- `lineLengthM` and `polygonAreaM2` measure lon/lat shapes on the WGS84 ellipsoid (local radii,
  centimetre level over a site). The container element carries `__aioMap` for end-to-end tests.
- `registerMapAdapters()` registers a `basemap` ground: the style rendered once (2048 px over a
  5 km square around the origin) by a hidden MapLibre map and draped as a quad at y = -0.2.

## Dev harness

`pnpm -F @aio/maps dev` and open http://localhost:5179: the real controller over the installed
packs and a synthetic Al-Zour project built from the git-ignored design fixtures (packs and
fixtures are served by Vite's `/@fs/` in place of `aio://`).
