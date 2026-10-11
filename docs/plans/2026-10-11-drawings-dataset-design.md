# Drawings as a dataset: design

Date: 11 Oct 2026. Branch: `feat/drawings-dataset`.

## Why

Drawings come into a project today only as DXF, only through the Model builder, and then sit under **Maps and rasters** with no control over how they lie over the site. A scanned plan, a PDF sheet or a screenshot of a layout cannot be brought in at all, and a drawing cannot be read beside the 3D view without first being placed.

## What the founder asked for

"One of the subfolders or subdatasets should be drawings. I should be able to upload any type of drawing, of course, then layer it on top of everything else, but also have it side by side in a split screen."

The scope below is a proposal; the founder has not reviewed it. Choices taken without an answer are listed under "Decisions to review".

## Behaviour

1. **A Drawings group** in the Datasets list (and in every survey date folder): every plan raster stored under `drawings/` and every vector layer stored under `drawings/`. The group header has an **Add drawing** button; the same action sits beside **Add data** at the top of the list, in the command palette and on the empty project hint.
2. **More file types.** PDF, PNG, JPEG, WebP, SVG and TIFF without a georeference import as drawings. A PDF or PNG that is dropped or picked through **Add data** goes to Drawings by itself. A JPEG stays a photo, and a georeferenced TIFF stays an ortho, unless it comes in through **Add drawing**. DXF keeps its pipeline. DWG stays out, and its message names the formats that work.
3. **PDF pages.** Each page becomes one drawing. A PDF of one page imports at once. A PDF of several pages asks which pages to bring in (default: the first page; at most 20 per import, and the card says so when the file has more).
4. **Side by side at once.** A new drawing opens in the split view beside the 3D view or the map without being placed: the **Ortho and plans** pane lists drawings first, under their own heading, and each PDF page is its own entry. **Open side by side** on a drawing row switches to the split with that drawing on the right.
5. **Not placed.** A picture has no position or scale. It gets a provisional placement (centred on the project origin, north up, 100 m on its long side), is saved hidden, and its row says "not placed". **Place on the site** opens the split (3D left, drawing right): click a point on the drawing, then the same spot in the 3D view, on the map, or type its coordinate. Two or more pairs give a similarity fit (the fit the model alignment uses, level mode); **Place** saves the corners, shows the drawing and clears "not placed".
6. **Overlay controls** on a drawing row: an opacity slider (3D and map) and **On top in 3D**, which draws the drawing over models and point clouds instead of being hidden by them. Both are remembered per project on this computer.

## How it is built

### Files (data-conventions section 15)

```
drawings/<stem>.<ext>            the original as picked (pdf, png, jpg, webp, svg, tif; dxf as before)
drawings/<stem>/plan.png         the drawing as a PNG: raster layer sheet-<stem>, role plan, format image
drawings/<stem>/placement.json   aio.drawingplacement/1 with units "px" and the optional sizePx
```

A PDF of several pages keeps one original, `drawings/<stem>.pdf`, and one folder per page, `drawings/<stem>-p<N>/`. No new layer kind, raster role or raster format: an installer already in the field reads these projects as it reads a DXF plan today. Image drawings use the layer id prefix `sheet-`; `plan-<stem>` stays the DXF plan, so the Model builder can tell which drawings have parts.

### Who decodes what

Electron's main process decodes PNG and JPEG (`nativeImage`) and TIFF (the builder's own reader), so those import in one `builder:import` call. PDF, WebP and SVG need Chromium: main copies the original into `drawings/` and answers an import item that carries a `drawing` hint; the renderer draws the pages from the project copy (pdf.js for PDF, an image element for the others) and hands each PNG back through `builder:addDrawingPage`. There is no canvas in main and no new dependency.

PDF pages are drawn at 220 dpi, at least 4096 and at most 8192 pixels on the long side, never above 600 dpi (so an A4 page comes out at about 350 dpi and an A0 at about 175). Pictures above 8192 pixels are scaled down to it.

### Contract changes (all additive)

- `LayerPatch` gains `{ corners }` for a raster drawn as one image. Saving it on a drawing also sets the layer visible and marks its `placement.json` as placed.
- `builder:import` request gains the optional `drawings` flag (the **Add drawing** path).
- `ImportItem` gains the optional `drawing` hint (`stem`, `src`, `name`).
- New IPC channels `builder:addDrawingPage` and `builder:closeDrawing`.
- `aio.drawingplacement/1` gains the optional `sizePx`; `units` may be `"px"`.
- `@aio/workspace` gains the `layerDisplay` store (opacity and on top per layer, view state only).

### Packages

- `@aio/schema`: the contract above.
- `@aio/project` (`builder/drawings.ts`, new): stems, provisional corners, placement file, `importDrawingImage`, `stageDrawing`, `addDrawingPage`, `markDrawingPlaced`; `raw.ts` calls it; `create.ts` `updateLayers` takes the corners patch.
- `@aio/ui`: the `drawings` tree group, the group action, the row settings button and the inline row block; the pane strings.
- `@aio/workspace`: `layerDisplay`.
- `@aio/engine`: the raster adapter applies opacity and on top to plan rasters.
- `@aio/maps`: the controller reads the opacity (0.75 stays the default for plans).
- `@aio/modelling`: `DrawingInfo.source` (`dxf` or `image`).
- Desktop main: `nativeImageOps.toPng`, the new handler, preload.
- Desktop renderer (`drawings/`, new): pure model (pages, sizes, fit to corners), page drawing, the store, the row controls, the place strip; small edits in `builder/state.ts`, `ImportPanel.tsx`, `Sidebar.tsx`, `Palette.tsx`, `SplitPanes.tsx`, `RasterPane.tsx`, `stagePrefs.ts`.

## Decisions to review

1. **Only layers under `drawings/` are in the group.** Plan rasters that older importers wrote elsewhere stay under Maps and rasters, so existing projects and their tests do not move.
2. **A new picture drawing starts hidden in 3D and on the map** until it is placed. An unplaced 100 m sheet over the site is noise; it is one click away (the eye) and opens side by side at once.
3. **PDF pages keep their white paper.** That reads correctly side by side; over the site the opacity slider makes it see-through. Turning paper transparent is a follow-up.
4. **A multi-page PDF asks for pages**, proposes the first one and takes at most 20 per import: every page is a drawing that cannot be removed yet.
5. **Importing the same file again adds a second drawing** (`<stem>-2`); a DXF import still replaces.
6. **Opacity in 3D defaults to 100 percent**, on the map to 75 percent as before, until the slider is moved; then one value drives both.
7. **Site points come from the 3D view, the mini map or typed coordinates.** Clicking the main map pane is not wired.
8. **Cancelling the page question, or a file that cannot be drawn, leaves nothing behind**: the copy the import made is removed (`builder:closeDrawing`). Only closing the app in the middle of an import leaves the copy.
9. **A DXF named like a picture drawing comes in under the next free name** through the import; the model builder refuses it instead, because its job cannot take another name there.
10. **Limits are those of a plain raster import**: 144 megapixels and 300 MB, checked from the header before decoding.
11. **A hidden drawing is not loaded** in the 3D view or on the map until it is first shown.

## Out of scope (follow-ups)

- DWG and IFC (third-party converters, founder decision).
- Drawings on the globe.
- Vector line work in 3D (PDF and SVG are drawn as pictures).
- Linking pan and zoom between a drawing pane and the map or the 3D view.
- Reordering layers.
- Paper to transparent for scanned and PDF sheets.
- Removing a drawing from the project (no layer can be removed in the app today).
- The rotation a phone camera records (EXIF orientation) for photos brought in as drawings.
- A PDF row that says "Failed" when earlier pages of the same file were added before the failure: say how many came in.
- The opacity slider shows 75 percent for a drawing nobody set, while the 3D view draws it solid: one default for both views.
- Picking up a staged drawing again after the app was closed in the middle of its import.

## Errors

- A file that cannot be decoded reports on its own import row; the rest of the import goes on.
- A picture above 144 megapixels or 300 MB is refused before it is decoded, with its size in the message.
- A PDF page whose PNG is over the 64 MB hand-over limit is drawn again at 70, 50 and 35 percent; when it still does not fit, its row says so in plain words.
- A PDF with a password, or one pdf.js cannot open, fails on its row; the copy stays in `drawings/`.
- Place with fewer than two pairs, or two pairs at one drawing point, keeps the button disabled or says why.

## Tests

Unit tests per package (listed per task in the plan) and one end to end spec, `apps/desktop/e2e/drawings.spec.ts`: import a PNG and a two page PDF made in the test, see them under Drawings, open one side by side, pick a PDF page in the pane chooser, move the opacity slider and read it back on the map and in the 3D scene.
