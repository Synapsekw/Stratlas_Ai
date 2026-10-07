# @aio/tiles

3D Tiles in the three.js site view (M10 stream G7, decision 3): large processed meshes and clouds,
3D Tiles from other software, and terrain and imagery around the site, so every site tool
(picking, issues, measuring, the cutaway) works on them. Public API: `src/index.ts`.

- `entries.ts`: `readTilesets` (`<project>/tilesets.json`, `aio.tilesets/1`; an absent file means
  no tilesets) and `tilesetsToLoad` (visible entries, by survey date).
- `budgets.ts`: `TILES_BUDGETS` per graphics tier (screen-space error, cache cap, whether terrain
  and imagery around the site are offered).
- `frame.ts`: the project local frame and ECEF through the project CRS (`@aio/geo`, proj4).
  The local frame is flat in the CRS, not a tangent plane, so tiles are placed with one matrix
  per tile fitted at its centre (within a millimetre over a leaf), never one matrix per site.
- `adapter.ts`: `attachTileset(scene, { url, entry, frame, budget })`, a 3DTilesRendererJS
  `TilesRenderer` in the engine's scene: the tier budget, a raycast target (hits name the mesh
  layer the tileset came from, else `tileset:<id>`), the stage's section planes, redraws while
  loading. Meshopt through three's bundled decoder; no Draco or KTX2 (the engine refuses Draco
  the same way). The glTF plugin is imported from its source file: the plugins bundle also holds
  the Cesium ion and Google providers, whose host names the offline bundle check refuses.
- `packs.ts`: imagery and terrain packs as tile providers, shared with MapLibre
  (`@aio/maps` `rasterPacks.ts`) and the Globe (G6): `createRasterTileSource(kind, packs)` gives
  the best covering tile across packs and the credits; `decodeTerrarium`, `rasterPackUrl`
  (`aio://packs/<kind>/<id>.pmtiles`).
- `surroundings.ts`: `buildSurroundings`, terrain and imagery around the site as one mesh in the
  local frame, just under the project's ground, not pickable.

`3d-tiles-renderer` is pinned at 0.5.3 (pre-1.0; Apache-2.0; its dependencies `pbf`,
`@mapbox/vector-tile` (BSD-3-Clause), `@mapbox/point-geometry` (ISC), `resolve-protobuf-schema`
and `protocol-buffers-schema` (MIT), `pmtiles` (BSD-3-Clause)). The tests keep our own record of
its behaviour (load, placement, budgets, disposal).
