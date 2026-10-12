# Processed outputs and change heat maps on the Globe: design

**Date:** 12 Oct 2026. **Branch:** `feat/m10-globe-processed-outputs`. **Plan:** `docs/plans/2026-10-12-m10-globe-processed-outputs.md`.

**Brief.** This covers two parts of the M10 plan (`docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`): the exit criterion "outputs open ... in the Globe" and the "Change detection (M8)" follow-up.

1. Orthophotos made by photo processing do not show on the Globe yet (`docs/KNOWN-LIMITS.md`, Globe: "Processed orthophotos do not show on the Globe yet"). Processed outputs should show on the Globe at their site.
2. The Globe should show change heat maps (the `change.raster` and `change.surface` outputs) as imagery. `packages/globe/src/layers.ts` has no such layer yet.
3. Two processed surveys of the same site should run `change.raster`, `change.surface` and `change.cloud` with nothing in between. An end to end spec proves it on synthetic data.

## Understanding

**Outcome.** A person processes drone photos for two survey dates and runs change detection. On the Globe they then see the site's orthophoto draped on the Earth where the site is, and can switch on that site's change heat map, its shaded DSM and its other survey dates, with a legend for the heat map. This holds offline and in every Globe look.

**Constraints, from the brief and the M10 plan.**

- **Zero network.** Everything is read from `aio://project/<id>/...`. There is no new host and no CSP change. The zero-network guard stays green with the outputs drawn.
- **Performance.** The Globe stays a lazily loaded chunk, and a closed Globe still gives its WebGL context back. On the Low tier (CI, software renderer) the outputs still draw, with a smaller tile cache.
- **The 2 cm rule.** The Globe and the site view place a point within 2 cm of each other, through PROJ (`@aio/globe` `projectToLonLat`), never through a UTM-as-metres shortcut.
- **Nothing is edited on the Globe.** These are imagery layers and toggles only.
- **Schema contracts are frozen.** Any field is additive and optional, with a row in `docs/architecture/contract-changes.md`.

**What exists already (read from the code).**

- `photo.products` writes `raster` layers with `format: 'kit-pyramid'` for the ortho (`role: 'ortho'`) and the shaded DSM and DTM (`role: 'dsm'`), plus a COPC `pointcloud`, each with `capture` set. The full mesh goes to 3D Tiles through `tiles.mesh` into `tilesets.json`.
- `change.raster` and `change.surface` write their heat map as a `raster` with `role: 'plan'`, `format: 'kit-pyramid'` and `derived.kind: 'change'`. Its `tiles.json` carries a `legend` (`@aio/maps` `changeStyle.ts` reads it). `change.cloud` writes a `pointcloud` with a `Distance` scalar.
- A kit pyramid (`aio.tiles/1`, data-conventions section 5) is a grid of square tiles per level. Its `corners` (`tl`, `tr`, `bl`) are in the project's local frame (x east, z south): this is not a Web Mercator pyramid.
- The Globe already draws the **open project's** 3D Tiles (`GlobeController.setTilesets`, through `tilesets:list`) and its issue pins. `globe:sites` builds a `GlobeSite` for every library project from its manifest, but carries no layers and no frame.
- Library folder projects are registered with the protocol (`library.ts` calls `registry.register`), so `aio://project/<libraryId>/...` and `tilesets:list` work for a project that is not open.
- The change producers (`renderer/change/producers/raster.ts`, `cloud.ts`) pair the layers of two dates by capture and by name. Only an end to end run on processed surveys shows whether they accept `photo.products` layers.

**Success criteria.**

1. On the Globe, the open project's latest orthophoto draws at its site, within 2 cm of where the site view puts it (checked at the pyramid's corners and centre).
2. Picking another site on the Globe draws that site's latest orthophoto and its 3D Tiles too (two sites at most: the open project and the picked one).
3. The site card lists the site's processed outputs (orthos by survey date, shaded DSMs, change heat maps), each with a switch. A heat map that is on shows its legend.
4. A new end to end spec processes two synthetic surveys of one site, runs imagery, surface and cloud change from the Changes panel, checks the verdicts against the synthetic truth, and then sees the heat map drawn on the Globe.
5. `pnpm check` is green, the changed Globe spec and the new spec pass the way CI runs them, and the zero-network guard and the WebGL give-back test stay green.

## Approaches considered

**A. A Cesium imagery provider that resamples kit-pyramid tiles (recommended).** A custom `ImageryProvider` on Cesium's `GeographicTilingScheme`, limited to the pyramid's rectangle. For each geographic tile Cesium asks for, it picks the pyramid level whose pixels best match, reads the overlapping pyramid tiles from `aio://project/...` and draws them onto a 256 px canvas with one affine transform. The affine transform is fitted from the pyramid corners taken exactly through PROJ; over a site of a kilometre it is within millimetres. The result drapes on terrain, stacks with packs and online satellite through the layer plan, and Cesium does the tile scheduling, culling and caching.

- For: it is the "project orthos on the Globe" path the M10 plan named (`KitPyramidImageryProvider`, decision 5 of the imagery section). It needs one plan kind in `layers.ts` and no new files on disk.
- Against: about 250 lines of canvas resampling, and pixels that are resampled once (bilinear, which is invisible at Globe distances).

**B. Ground primitives: one textured quad per pyramid tile.** This is how `@aio/maps` `pyramidView` draws on the map.

- For: no resampling.
- Against: it is our own level selection and culling on top of Cesium, quads do not drape on terrain (they float or clip), it does not stack with imagery layers, and every tile adds to the draw-call budget.

**C. Have the pipelines also write a Web Mercator PMTiles copy of each output.**

- For: Cesium-native tiles with no resampling at run time.
- Against: a pipeline and data-conventions change, more disk per output, and nothing for outputs already made or imported.

**Choice: A.**

## Design

### Data: which outputs a site has (contract, additive)

`GlobeSite` (`@aio/schema` `globe.ts`) gains two optional fields:

- `frame?: { crs, origin }`: the project's CRS and local-frame origin. With it, the renderer can place a site that is not open (its rasters and any imported tileset `transform`) without reading the manifest.
- `rasters?: GlobeRaster[]`: the site's `raster` layers with `format: 'kit-pyramid'` that are not drafts. Each is `{ layerId, name, role: 'ortho' | 'dsm' | 'plan', src: AssetRef, capture?: Id, change?: true }`, where `change` is set when `derived.kind === 'change'`.

Main (`apps/desktop/src/main/globe.ts` `siteOf`) fills both fields from the manifest it already reads. It reads no extra file, so `globe:sites` costs the same. For an open `.aio` package, the rasters also come from its manifest; its members are served in place.

### Pure logic (`packages/globe/src/projectRasters.ts`, new)

- `parsePyramid(json)`: reads an `aio.tiles/1` index, with levels coarse to fine and the optional `legend` passed through. It returns null when the file is not an index.
- `pyramidPlacement(index, frame)`: takes the corners and the centre to WGS84 through `projectToLonLat`, and returns the lon/lat rectangle (with a small margin) and the affine map from lon/lat to pyramid (u, v), fitted from the three corners. A test checks the centre against exact PROJ within 2 cm.
- `pyramidTilesFor(index, placement, rect, metresPerPixel, maxTiles)`: the level and the tiles that cover a geographic rectangle (the same rule as `@aio/maps` `pyramidView`, restated here because `@aio/globe` does not depend on `@aio/maps`).
- `defaultShown(site)`: what a site in focus shows before the person touches anything, which is the orthophoto of its latest survey date. When several orthos share that date, the first layer wins.
- `rasterOrder(shown)`: draw order, bottom first: orthos by date, then shaded DSMs, then change heat maps.

`layers.ts` gains the plan kind `{ kind: 'project-raster'; raster: R }`, and `GlobeLayerInput` gains `projectRasters?: readonly R[]`. Project rasters sit **on top** of every base and pack layer, in every look (street, satellite, Natural Earth). The person's own survey wins where it is.

### View (`packages/globe/src/view/`)

- `projectRasterProvider.ts` (new): a `KitPyramidImageryProvider` as approach A describes. Pyramid tiles are fetched from `aio://project/<id>/<path>` and decoded with `createImageBitmap`. A bounded LRU keeps the decoded pyramid tiles: 48 on Medium and High, 16 on Low, closed when the provider is dropped. Resampled tiles are 256 px. `maximumLevel` comes from the pyramid's finest ground pixel. A missing tile gives a transparent tile, and a failing read sets `lastError` and never throws into Cesium.
- `controller.ts`: `setTilesets(projectId, ...)` becomes `setSiteOutputs(outputs: readonly SiteOutputs[])`. `SiteOutputs` is `{ projectId, georef, tilesets, rasters }`. The controller diffs by project and layer id, so switching one raster off does not reload the tilesets. Rasters go through `planGlobeLayers` as `project-raster` entries. `inspect()` gains `projectRasters: { projectId, layerId, ready, tiles, lastError }[]`. Leaving the Globe disposes every provider and its cache.
- `GlobeView.tsx`: the prop `tilesets` is replaced by `outputs: readonly SiteOutputs[]`.

### Renderer (`apps/desktop/src/renderer/globe/`)

- **Sites in focus:** the open project, plus the picked site when it is another project. Two at most.
- For each site in focus, `tilesets:list { projectId }` gives its tilesets (as today for the open project). Its rasters and frame come from `GlobeSite`. The georef is `{ ...frame, heightOffset: 0 }`, as `georefOf` already does.
- `SiteOutputs.tsx` (new) is a section of the site card, "On the Globe", with one switch per raster: orthos labelled by survey date, "Shaded surface" for a DSM, and "Imagery change" or "Surface change" for a heat map (from its legend kind). A heat map that is on shows its legend, using `@aio/maps` `parseChangeLegend`, `defaultLegend` and `legendGradient`, as the map does. The switches are held per project for the session (a small store in the renderer) and not saved.
- Strings go through `t()` with new keys in `packages/ui/src/i18n/en.ts`.

### The two-survey end to end proof

- `python/tests/products_synth.py` gains a scene variant. The stockpile height and a second box become parameters (default unchanged). `python/tests/two_surveys_synth.py` (new) writes one project with captures `c1` (7 Oct) and `c2` (21 Oct) and one aligned run each, from the same cameras' layout. In the later scene the stockpile is 2 m higher and a 3 m shed stands on open ground. Its `truth.json` gives the shed's outline, the pile's footprint, and the expected fill volume within tolerance.
- `apps/desktop/e2e/photo-two-surveys-fixture.py` (new) calls it. `apps/desktop/e2e/photo-change.spec.ts` (new) does the rest:
  1. `photo.products` for each run with `products: ['cloud', 'dsm', 'ortho']`, `preset: 'fast'` and the run's `capture`.
  2. Open the project, open Changes for c1 to c2, and check that **Run imagery change**, **Run surface change** and **Run cloud change** are offered (their `available` is true).
  3. Run all three, then check against the truth: an imagery region over the shed, a `fill` surface region over the pile with its volume within tolerance, and cloud distances above threshold at the shed and the pile and below it on open ground.
  4. Open the Globe: the surface heat map listed in the site card, switched on, `inspect().projectRasters` ready, a red-dominant pixel inside the pile footprint, and the network log empty.
- If the run shows that a producer refuses processed layers (for example the cloud pairing by name), the fix goes in `renderer/change/producers/` with a unit test, as part of the same task.

### Errors

- An unreadable `tiles.json` leaves that switch disabled with "This map could not be read." on its row. Nothing is drawn and nothing is thrown.
- A site whose CRS cannot be placed (a local grid) has no `frame`. Its card shows no "On the Globe" section, as before.
- A raster whose project is a locked package is not listed: `globe:sites` has no manifest for it.

### Testing

- **Vitest:** the schema (new fields parse, old sites parse, `m10.test.ts` still pins the `Settings` key set); `globe.test.ts` in main (rasters and frame from manifests: drafts, other formats and `legacy` left out, `change` flag); `projectRasters.test.ts` (index parsing, placement within 2 cm of PROJ at the corners and centre for EPSG 32640 and a WKT, tile selection and `maxTiles`, defaults, order); `globe.test.ts` in `@aio/globe` (the `project-raster` plan kind in each look); the provider's resampling against a synthetic two-colour pyramid in jsdom with a canvas stub; `SiteOutputs.test.tsx` and `GlobeScreen.test.tsx` (switches, legend, sites in focus).
- **pytest:** `test_two_surveys_synth.py` (truth agrees with the scene; captures and runs are written).
- **Playwright:** `globe.spec.ts` gains "processed orthos and change heat maps draw at their site" on the `globeLibrary` fixture, which now carries a small synthetic kit-pyramid ortho per capture and a heat map. The new `photo-change.spec.ts` covers the two-survey chain (it needs the pipeline Python and PDAL, and skips without them, like `photo-products.spec.ts`).

## Decisions taken (founder to confirm)

The founder was not available while this was scoped. Each question was answered with the recommended option:

1. **Which sites draw outputs?** The open project and the site picked on the Globe, two at most. Not every site in view: that would scale the GPU and memory cost with the library.
2. **Which outputs?** Every `kit-pyramid` raster: orthos, shaded DSMs and DTMs, and change heat maps. Plus the 3D Tiles already in `tilesets.json`, now also for the picked site. The `change.cloud` result (a point cloud with distances) stays in the site view: it has no tileset, and the cloud heat map is drawn there. COG-only and plain-image rasters are left out for now.
3. **What shows by default?** The orthophoto of the latest survey date. DSMs, older dates and heat maps are off until switched on in the site card. The switches last for the session and are not saved (no settings contract).
4. **Where do they sit in the stack?** Above packs and online satellite, in every look. Heat maps go above orthos.
5. **How are they drawn?** Approach A: an imagery provider that resamples the project's own kit-pyramid tiles. No new files, no pipeline change.
6. **Contract change.** `GlobeSite.frame?` and `GlobeSite.rasters?`, additive and optional.
7. **Legend.** A heat map that is on shows the same legend as on the map, from its `tiles.json`.
8. **End to end cost.** The two-survey spec uses the Fast preset and only the cloud, DSM and ortho products (no mesh or tiles), so it stays under 10 minutes on CI. It is not tagged `@realdata` (the data is synthetic).

## Out of scope

- Footprints for every site and a date filter on the Globe (the timeline milestone).
- Drawing outputs for every site at once.
- COG or plain-image rasters on the Globe.
- The `change.cloud` result on the Globe.
- Editing or measuring on outputs.
