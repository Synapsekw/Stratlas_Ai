# Drawings as a dataset: implementation plan

**Goal:** a Drawings group in the Datasets list, drawings from PDF, PNG, JPEG, WebP, SVG and plain TIFF, side by side at once, placed by point pairs, with opacity and on top controls.

**Design:** `docs/plans/2026-10-11-drawings-dataset-design.md`.

**Architecture:** drawings stay `raster` layers with `role: 'plan'` and `format: 'image'` under `drawings/<stem>/plan.png`. Main decodes PNG, JPEG and TIFF; the renderer draws PDF, WebP and SVG from the project copy and hands the pages back. Placement is a corners patch on the existing layer patch. Opacity and on top are view preferences in renderer storage, mirrored into a small store both views read.

**Tech stack:** TypeScript, React, zod, zustand, three.js, MapLibre, pdf.js (bundled), Electron `nativeImage`, Vitest, Playwright. No new dependency. `python/` is not touched.

## Global rules

- Test first: the failing unit test, then the code.
- No new layer kind, raster role or raster format (pinned by `packages/schema/src/m10.test.ts`, `m11.test.ts`, `tools/compat/*`).
- Keep edits to the files other branches also touch small and local: `workspace/SplitPanes.tsx`, `packages/project/src/builder/raw.ts`, `renderer/builder/state.ts`, `builder/ImportPanel.tsx`. `workspace/splitModel.ts`, `m8Mounts.tsx`, `Stage.tsx` and `CompareScene.tsx` are not edited.
- User-facing text: plain English, no emoji, no em or en dashes, no client, site or person names.
- Heavy commands (check, whole-package tests, demo builds, Playwright, commits) go through the one at a time runner of this session.

## Execution DAG

```
T1 schema ──┬─> T2 project ──┬─> T6 main ───────────┐
            │                │                      ├─> T8 renderer UI ──> T9 e2e
            └────────────────┴─> T7 renderer logic ─┤
T3 ui tree ─────────────────────────────────────────┤
T4 workspace + engine + maps ───────────────────────┤
T5 modelling ───────────────────────────────────────┘
T10 docs ── independent (final wording after T8)
```

| Batch | Tasks          | Why they can run together                                               |
| ----- | -------------- | ----------------------------------------------------------------------- |
| 1     | T1, T3, T4, T5 | Four different packages, no shared file, no dependency between them     |
| 2     | T2, T10        | T2 needs T1's types; the docs touch no code                             |
| 3     | T6, T7         | Main and renderer folders; both need T1 and T2, neither needs the other |
| 4     | T8             | Needs the tree (T3), the display store (T4), the source flag (T5), T7   |
| 5     | T9             | Needs the built app                                                     |

**Critical path:** T1, T2, T6, T8, T9.

**How it is executed:** inline by one agent, in batch order. The workstation is shared with three other build agents and every heavy command is serialised, so parallel subagents in one worktree would only queue behind each other; the batches still say what is independent.

**Contract change (T1 adds the row to `docs/architecture/contract-changes.md`):** `LayerPatch` gains `{ corners }`; `builder:import` gains the optional `drawings`; `ImportItem` gains the optional `drawing`; new channel `builder:addDrawingPage`; `aio.drawingplacement/1` gains the optional `sizePx` and the unit `px`; `@aio/workspace` gains `layerDisplay` (T4). All additive.

**End to end specs:** adds `apps/desktop/e2e/drawings.spec.ts` (T9). Run again, unchanged: `builder.spec.ts`, `model-builder.spec.ts`, `timeline.spec.ts` (tree and date folders), `compare.spec.ts` (split panes).

**Packages touched:** T1 `@aio/schema`; T2 `@aio/project`; T3 `@aio/ui`; T4 `@aio/workspace`, `@aio/engine`, `@aio/maps`; T5 `@aio/modelling` and `renderer/modeller`; T6 desktop main and preload; T7, T8 desktop renderer (plus pane strings in `@aio/ui`); T9 desktop e2e; T10 docs.

---

### T1: contract (`@aio/schema`)

Files: `packages/schema/src/builder.ts`, `ipc.ts`, `builder.test.ts`; `docs/architecture/contract-changes.md`.

- `LayerPatch`: new union member `z.object({ corners: z.object({ tl: Vec3, tr: Vec3, bl: Vec3 }) }).strict()`.
- `ImportItem.drawing?: { stem, src, name }`.
- `builder:import` request: `drawings: z.boolean().optional()`.
- `builder:addDrawingPage`: request `{ projectId, stem, name, page?, pages?, png }` (strict; `png` a `Uint8Array` of at most 64 MB), response `{ ok: true, manifest, layerId }` or `{ ok: false, error }`.

Tests (`builder.test.ts`): the corners patch parses and refuses extra keys; the old patches still parse; `builder:import` takes `drawings` and still refuses unknown keys; an item with and without `drawing` parses; `builder:addDrawingPage` takes exactly its keys. The pinned kinds, roles and formats tests stay untouched and green.

### T2: drawings in the builder library (`@aio/project`)

Files: `packages/project/src/builder/drawings.ts` (new), `drawings.test.ts` (new), `raw.ts`, `raw.test.ts`, `create.ts`, `index.ts`.

- `drawings.ts`: `DRAWING_LONG_M = 100`, `MAX_DRAWING_PX = 8192`, `MAX_DRAWING_MP = 400`; `provisionalCorners(w, h)`; `placementFor(file, corners, w, h, provisional)`; `pngSize(bytes)`; `imageSize(head)` (PNG and JPEG headers); `drawingStem(root, manifest, name, pages?)`; `addDrawingLayer(root, m, { stem, name, width, height })` (writes `placement.json`, pushes the `sheet-<stem>` layer, hidden); `stageDrawing` (copy the original, answer the hint); `addDrawingPage(root, req)` (validate the PNG, write `plan.png`, layer, manifest); `markDrawingPlaced(root, layer)`.
- `ImageOps.toPng?(src, dst, maxPx)` (optional, so other callers keep compiling).
- `raw.ts`: PNG, and with `drawings` JPEG, through `toPng`; TIFF without a georeference (and any TIFF with `drawings`) through the TIFF reader; PDF, WebP and SVG staged with the hint; the DWG and unknown type messages name the formats that work.
- `create.ts` `updateLayers`: the corners patch (image rasters only; a drawing also becomes visible and its placement file is marked placed).

Tests: corners are centred, north up, 100 m on the long side; placement matrix maps pixel corners to the layer corners; stems are unique against layers and files and page stems carry `-p<N>`; a PNG lands as `drawings/<stem>.png`, `plan.png`, `placement.json` and a hidden `sheet-` layer that `isDrawingPlan` accepts; a JPEG is a photo without the flag and a drawing with it; a TIFF without georeference becomes a drawing; a PDF is copied and answers the hint; `addDrawingPage` refuses a non PNG and a bad stem and names page layers; the corners patch moves an image raster, refuses a mesh, shows a drawing and clears `provisional`.

### T3: the Drawings group (`@aio/ui`)

Files: `packages/ui/src/tree/model.ts`, `model.test.ts`, `dateModel.test.ts`, `DatasetTree.tsx`, `DatasetTree.test.tsx`, `DateTree.tsx`, `i18n/en.ts`, `mission.css`.

- `TreeGroupKind` gains `drawings` (after Maps and rasters). A raster with role `plan` or a vector whose path starts with `drawings/` goes there. `TreeItem.drawing` marks the plan rows. `buildDatasetTree` takes `opts.unplaced` (layer ids) for the "not placed" meta.
- `DatasetTree`: `groupAction(group)` (a small button on the header), `onDrawingSettings(item)` (a button on plan rows), `rowExtra(item)` (a block under a row). `DateTree` passes them through. Drawings open by default.

Tests: a DXF plan, its vector layers and a `sheet-` layer are in Drawings and no longer under Maps and rasters; a plan outside `drawings/` stays where it was; the unplaced meta; date folders get their own Drawings group; the header button calls its action and does not toggle the group; the settings button and the extra block render for plan rows only.

### T4: opacity and on top (`@aio/workspace`, `@aio/engine`, `@aio/maps`)

Files: `packages/workspace/src/layerDisplay.ts` (new), `layerDisplay.test.ts` (new), `index.ts`; `packages/engine/src/adapters/raster.ts`, `raster.test.ts` (new or existing); `packages/maps/src/controller.ts`, `geo.ts` or a small pure helper with its test.

- `layerDisplay`: `{ byLayer, replace(all), set(id, patch) }`, `LayerDisplay = { opacity?: number; onTop?: boolean }`, values clamped.
- Engine: `planDraw(display)` (pure: opacity, depth test, render order); image and pyramid plan rasters follow the store.
- Maps: `rasterOpacity(role, display)`; raster layers follow the store.

Tests: the store clamps and replaces; `planDraw` defaults leave today's look (opacity 1, depth test on, same render order) and on top turns the depth test off and lifts the order above models; `rasterOpacity` is 0.75 for a plan without a preference, 0.95 for an ortho, the preference when set.

### T5: which drawings have parts (`@aio/modelling`)

Files: `packages/modelling/src/drawing.ts`, `drawing.test.ts`; `apps/desktop/src/renderer/modeller/store.ts`, `ModellerLayer.tsx`.

- `DrawingInfo.source`: `image` for a `sheet-` layer, else `dxf`. The Model builder lists and reads parts from `dxf` drawings only.

Tests: both sources are recognised; `isDrawingPlan` accepts both.

### T6: main and preload (desktop)

Files: `apps/desktop/src/main/images.ts`, `builder.ts`, `builder.test.ts`, `index.ts`, `apps/desktop/src/preload/index.ts`.

- `nativeImageOps.toPng`; `builderImport` passes `drawings`; `builderAddDrawingPage(req, registry)`; the handler (refused on a package); the preload allow list.

Tests (`builder.test.ts`): a page lands in an open project and a closed project is refused.

### T7: renderer logic (desktop)

Files: `apps/desktop/src/renderer/drawings/model.ts` + `model.test.ts`, `rasterise.ts`, `store.ts` + `store.test.ts`, `display.ts` + `display.test.ts`; `workspace/stagePrefs.ts`; `builder/state.ts`, `builder/ImportPanel.tsx`.

- `model.ts`: `parsePages(text, count, cap)`, `pageScale(widthPt, heightPt)`, `fitSize(w, h, max)`, `pixelAt(corners, size, local)`, `cornersFromPairs(pairs, size)` (level similarity fit from `@aio/geo`), `openSideBySide(pref, mode, layerId)`.
- `rasterise.ts`: PDF pages through pdf.js, WebP and SVG through an image element, each to a PNG.
- `store.ts`: staged drawings waiting for pages, the page question, the open row controls, the place session.
- `display.ts`: parse and clamp the per project preferences (`StagePref.drawings`), mirror them into `layerDisplay`.
- `state.ts`: `importFiles(paths, altitude, { drawings })`, `pickAndAddDrawing()`, the drawing filters; items with a hint are drawn and finished.

Tests: page lists ("1-3, 7", out of range, cap); page scale bounds; corners from two and three pairs against a known similarity; pixel under a local point; preferences survive a bad value; the split preference puts the drawing on the right.

### T8: renderer UI (desktop)

Files: `renderer/drawings/DrawingsLayer.tsx`, `DrawingControls.tsx`, `PlaceStrip.tsx`, `drawings.css`; `shell/Sidebar.tsx`, `shell/Palette.tsx`, `App.tsx`, `workspace/SplitPanes.tsx` (chooser groups and the place strip mount), `workspace/RasterPane.tsx` (click to pick and marks).

Tests: covered by T9 and by the component tests of T3; the pure parts are tested in T7.

### T9: end to end

File: `apps/desktop/e2e/drawings.spec.ts` (new), two tests.

1. A PNG (sharp) and a two page PDF (written by hand in the test) are imported through Add data; both pages are asked for; three rows appear under Drawings marked "not placed"; **Side by side** shows the PNG in the raster pane; the chooser lists the PDF pages and switching shows one; the opacity slider and **On top in 3D** change the drawing's material in the 3D scene and the layer's `raster-opacity` on the map; the row controls do not cover the 3D view (`elementFromPoint`); the drawing is placed by two typed points (after one pair picked in the 3D view and removed), and the manifest corners and `placement.json` are checked.
2. A JPEG, a WebP, an SVG and a TIFF without a georeference come in through **Add drawing**, and again through the Drawings header.

Run the CI way: `npx playwright test e2e/drawings.spec.ts --workers=1` with the 1100 x 700 window and the software renderer, then the neighbouring specs named above. Since the rebase onto the CI window fix the window is 1100 x 720 at display scale 1.

### T10: docs

Files: `docs/architecture/data-conventions.md` (section 15), `docs/KNOWN-LIMITS.md`, `docs/guide/18-model-builder.md` (or the page that covers adding data), `docs/TESTING.md`. Checked with `node tools/agent/check-public-text.mjs`.
