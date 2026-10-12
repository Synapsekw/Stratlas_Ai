# M10 follow-ups: packages (X1) and journal — design

Status: proposed, 12 Oct 2026. Written by a scoping session while the founder was away: the questions brainstorming would have asked are answered with the recommended option and listed under "Decisions taken (founder to confirm)".

Source: `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`, integration follow-ups **Packages (X1)** and **Journal (M9)**; decision 12 (customer imagery in packages); `docs/KNOWN-LIMITS.md`, "Imagery, terrain and 3D Tiles".

## Intent

M10 added photo processing, 3D Tiles, imagery and terrain packs and the Globe, but two integration seams were left open:

1. **Packages** ship every file no layer owns. A processed project therefore sends the COLMAP database and the products work folder (`photogrammetry/<run>/work/`, often several GB) to the customer, while customer imagery, which the builder may want to send, cannot go at all. The player opens the package but has no imagery or terrain on the Globe unless the customer's machine has the same pack, and a package opened after the Globe was already visited does not fly to its site.
2. **The journal** does not see M10 files. `tilesets.json` and `photogrammetry/<run>/gcp.json` are written by main with `writeJsonSeen`, outside the journal's wrapped writers, and `photogrammetry/<run>/run.json` and the pipeline's `tilesets.json` entries are not journaled files, so the job-end reconcile never records them. Imported tilesets and ground control edits are missing from History.

Success: a package of a processed project carries the run's records and reports and its tiles, never `work/`; customer imagery or terrain travels only when the builder ticks it, clipped to the site; the player shows the Globe at the package's site with that imagery, its tilesets and issue count, and nothing in player mode can start processing; History lists tileset imports and edits, ground control edits and each processing job's run and tileset changes (`via.pipeline`).

## What exists (read before building)

- `packages/project/src/package/plan.ts`: `planPackage` and its `SKIP` list. Files no layer owns travel. Layer files of a run (`rasters/`, `clouds/`, `models/`) are owned by their layers and are not affected here.
- Run folder layout: data-conventions section 21. Besides `run.json`, `gcp.json` and `report/`, a run holds `cameras-sfm.json`, `sparse/`, `mesh/full.glb` (input to `tiles.mesh`), COG copies `dsm.tif`, `dtm.tif`, `ortho.tif`, and `work/` (`work/database.db` from `photo/align.py` ~1264, `work/products/<key>/` from `photo/products.py` ~385).
- Street map packs already travel: `apps/desktop/src/main/packs/embed.ts` clips an installed pack to the site (`projectBbox`, `planExtract`, `runExtract`) into `packs/<id>.pmtiles` with `packs/<id>.json`; `embeddedPacks`, `listWithEmbedded` and `findEmbedded` list and serve them for open packages; `aio://packs/<id>.pmtiles` falls back to the package (`protocol/handler.ts` ~241). The export dialog is `renderer/shell/PackageExport.tsx` (the map pack switch).
- Imagery and terrain packs: `<data>/packs/imagery|terrain/<id>.pmtiles` with `<id>.json` (`RasterPackMeta`, `customerLicence`), listed by `listRasterPacks` and served by `rasterPackFile` from disk only (`packs/raster.ts`). `RasterPackInfo.source` already allows `'package'`.
- Globe: `globe:packs` lists only installed raster packs (`main/globe.ts`); `globeProjectReader` reads a package as manifest only (`issues: []`, `tilesets: null`). `GlobeScreen` starts at the module-level `lastCamera` once the Globe was opened in the session, else at the open project's site. Tilesets of a package already list and stream (`tilesets:list` reads the archive, `aio://project/<id>/...` serves members).
- Player mode: `jobs:start` refuses `.aio` paths (`main/index.ts` ~1113); photogrammetry writers, `tilesets:write` and `tilesets:import` refuse packages; the Processing drawer shows "Create maps" only for folders. `renderer/processingTools.ts` `resumeAfterTools` opens the wizard without checking for a package (main still refuses the run).
- Journal: `apps/desktop/src/main/journal.ts` `WRITERS` (ops first, then the handler's write), the after-write reconcile used by `builder:updateLayers`, and the job-end reconcile with `via.pipeline`. `packages/journal/src/diff.ts` `isJournaledFile`, `FILES`, `JOURNALED_DIRS`, `externalOp` (`record.external`, before and after content hashes). `journaledFiles(root)` scans only top-level files and one level of `JOURNALED_DIRS`.

## Approaches considered

**Run folder in packages.** (a) Skip only `work/` (what the brief literally says). (b) An allow-list: only `run.json`, `gcp.json` and `report/**` of a run travel. (c) Keep everything. Recommended **(b)**: the COG copies and `mesh/full.glb` duplicate layers and tiles that already travel, and `sparse/` and `cameras-sfm.json` only serve processing, which the player never does. A file a layer owns still travels even inside a run folder (ownership wins over the rule), so a future layer pointing into a run is not broken.

**Raster packs in packages.** (a) Copy the whole pack file. (b) Clip to the site with the existing PMTiles extract, as street packs do. Recommended **(b)**: a region pack can be 0.5 to 2 GB, and a clip also limits how much licensed imagery leaves the builder's machine.

**Journal record kinds.** (a) `record.external` per file write (hash-only, as `orientation.json` and `survey/cleanups.json` do today), with a label on the op so History reads "Imported 3D Tiles "Bridge"". (b) New op kinds `tileset.add|patch|remove`, `gcp.edit`, `photo.run` (an `@aio/schema` change, payload schemas, `OP_PERMISSION` rows, unknown-kind handling in older builds and the Team Server). Recommended **(a)**: no contract change, the precedent exists, and per-entry kinds can come later if History needs field-level detail for tilesets.

## Design

### 1. Package plan: the run folder rule (packages/project)

`planPackage` gains a rule, applied only to files no layer owns: a path under `photogrammetry/<run>/` travels only when it is `run.json`, `gcp.json` (and not its `.bak`, already skipped) or under `report/`. Everything else in a run folder is left out and not counted in `baseBytes`. `tilesets.json` and `tiles/**` keep travelling (no change). The rule is a pure function (`runFileTravels(path)`) beside `SKIP`.

### 2. Raster packs in packages (schema, main, renderer)

- **Contract** (`@aio/schema`, additive): `package:plan` and `PackageExportOptions` gain optional `rasterPacks: RasterPackRef[]`, where `RasterPackRef = { kind: 'imagery' | 'terrain', id }`. `PackagePlan` gains optional `rasterPacks: PackageRasterPlan[]`: every installed imagery and terrain pack that covers the site, with `kind`, `id`, `label`, `licence`, `attribution`, `customerLicence`, and either `{ ok: true, bytes, tiles, maxZoom }` (clip size; included in `totalBytes` only when requested) or `{ ok: false, reason }`. New constant `EMBEDDED_RASTER_DIRS = { imagery: 'packs/imagery', terrain: 'packs/terrain' }`.
- **Main** (`packs/rasterEmbed.ts`, new): `planRasterEmbeds` sizes clips for the covering packs (site box from `projectBbox` with the street map's margin, or 1 km when the map switch is off; the pack's own max zoom); `writeRasterEmbeds` clips the requested ones to temp files and returns members `packs/<kind>/<id>.pmtiles` and `packs/<kind>/<id>.json` (`RasterPackMeta` with `bbox` the clipped box, `customerLicence`, licence and attribution kept). `packageRasterPacks(archive)`, `embeddedRasterPacks(installed, packages, kind)` and `findEmbeddedRaster(kind, id, packages)` mirror the street pack trio, with ids `pkg-<projectId>-<id>` so a package pack never shadows an installed one. A request naming a pack that is not installed or does not cover the site is refused with the pack's name.
- **Packaging** (`packages.ts`): plan and export call the above; members join `extra`.
- **Player** (`globe.ts`, `protocol/handler.ts`): `globe:packs` returns installed packs, then the package packs the machine lacks (`source: 'package'`); `aio://packs/imagery|terrain/<id>.pmtiles` falls back to the open package.
- **Export dialog** (`PackageExport.tsx`): a section "Imagery and terrain" lists the covering packs, each with a tick box, unticked by default. A customer-licensed pack shows its licence and attribution and the reminder "Licensed to you by the provider. Send it only if the licence allows this recipient to see it." A pack that cannot be clipped shows its reason and no tick box. The ticked clips' size is added to the total.

### 3. Player mode Globe (main, renderer)

- `globeProjectReader` reads an open package's `issues.json` and `tilesets.json` members (same parsers as folders), so a package site shows its open issues and tilesets on the Globe.
- `GlobeScreen` remembers the camera per project: `lastCamera` becomes `{ projectId, camera }`, and when the open project differs from the remembered one the Globe starts at the open project's site. This is what makes a package opened later in the session fly to its site.
- `resumeAfterTools` does nothing while a package is open (no wizard in player mode).
- Nothing else changes: main already refuses every processing entry for packages, and the e2e spec checks it.

### 4. Journal for M10 files (packages/journal, main)

- `isJournaledFile` follows `tilesets.json`, `photogrammetry/<run>/run.json` and `photogrammetry/<run>/gcp.json`; `journaledFiles(root)` also scans `photogrammetry/*/` for those two names. They stay `record.external` (no `FILES` entry), hash-only.
- `externalOp(rel, before, after, label?)` carries an optional label; `diffRecordFile` passes the label of a command whose `ids` include `'file'` (the WRITERS' commands), so a wrapped write can name itself.
- `WRITERS` gains `tilesets:write` (`tilesets.json`, label "3D Tiles list edited") and `photo:writeGcp` (`photogrammetry/<run>/gcp.json`, label "Ground control edited"). Their handlers keep `writeJsonSeen`; the wrapper adds the ops first, exactly like `orientation:write`.
- `tilesets:import` (entry computed in the handler) and `photo:applyPoses` (manifest changed in a turn, `updateManifestFile`) get the after-write reconcile already used for `builder:updateLayers`, recording `tilesets.json` and `manifest.json` respectively, attributed to the person; the import's op is labelled "Imported 3D Tiles "<name>"".
- Jobs: no code change beyond the files becoming journaled. `photo.align`, `photo.georef`, `photo.products`, `tiles.mesh` and `tiles.cloud` changes to `run.json`, `gcp.json` (predictions) and `tilesets.json` are recorded at job end with `via.pipeline` by the existing reconcile.
- Packages stay read-only: their journal is never appended (unchanged).

### Error handling

- A raster clip that fails mid-export aborts the export with the pack's name and the reason; temp files are removed (as `writeEmbed` does).
- A package whose `packs/<kind>/<id>.json` is not valid `RasterPackMeta` is ignored (not listed, not served).
- A journal failure never blocks a write or an open (existing behaviour: warnings in the log).

### Testing

Unit tests per module (TDD), plus one new e2e spec `apps/desktop/e2e/packages-globe.spec.ts` (export of a processed fixture project with a customer imagery pack ticked, then opened in player mode) and one added test in `apps/desktop/e2e/tilesets.spec.ts` (History lists the import). Details per task in the plan.

## Out of scope

- **Job results and the manifest's turn taking** (north star "Owed"; KNOWN-LIMITS "A processing job files its results outside the app's turn taking"). The pipelines write `manifest.json` (and `tilesets.json`) from their own process. Fixing that means jobs return their results and main files them through `updateManifestFile`, across every pipeline that adds layers: its own brief. This branch makes such writes visible in History (`via.pipeline`) but does not change who writes them.
- Per-entry journal kinds for tilesets and ground control (approach (b) above).
- Embedding street, imagery or terrain packs that are not installed (downloads), and placing tilesets in a local frame.

## Decisions taken (founder to confirm)

1. **Run folders in packages travel by allow-list**: `run.json`, `gcp.json` and `report/` only; `work/`, `sparse/`, `cameras-sfm.json`, `mesh/full.glb` and the COG copies stay behind. An editable copy extracted from such a package can show the run and its accuracy but cannot re-run products without aligning again.
2. **Imagery and terrain packs are both offered**, every covering pack unticked by default (customer-licensed or not), since a region pack is large; customer-licensed ones show licence, attribution and a reminder (decision 12).
3. **Packs travel clipped to the site** (the map pack's margin when the map switch is on, else 1 km), at the pack's own maximum zoom, not as whole files.
4. **Journal records are `record.external` with a label**, not new op kinds: no `@aio/schema` journal change. History shows "Imported 3D Tiles "<name>"", "3D Tiles list edited", "Ground control edited" and each processing job's file changes under the pipeline's name.
5. **`run.json` is journaled** (hash-only), so History shows which job changed a run; `report/` files and `work/` are not.
6. **The Globe remembers its camera per project**, so opening a different project (or package) starts the Globe at that project's site.
7. **The turn-taking of job results is a separate brief**, not part of this branch.
