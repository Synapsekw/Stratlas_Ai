# @aio/tiles

3D Tiles in the three.js site view (M10 stream G7, decision 3): large processed meshes and clouds,
3D Tiles from other software, and terrain and imagery around the site, all through
3DTilesRendererJS behind this package, so every site tool (picking, issues, measuring, the
cutaway) works on them. Public API: `src/index.ts`. Depends on `@aio/schema`.

## G0 contents

- `entries.ts`: `readTilesets` (`<project>/tilesets.json`, `aio.tilesets/1`; an absent file means
  no tilesets) and `tilesetsToLoad` (visible entries, by survey date).
- `budgets.ts`: `TILES_BUDGETS` per graphics tier (screen-space error, cache cap, whether terrain
  and imagery around the site are offered).

## Planned (G7)

The engine adapter registered in `packages/engine/src/adapters/register.ts`
(`registerTilesetAdapter`), the Terrarium, quantized-mesh and PMTiles imagery plugins, Draco and
KTX2 loaders pointed at the app's bundled decoders (never a CDN). `3d-tiles-renderer` is added as
a dependency by G7 and pinned (0.5.x is pre-1.0).
