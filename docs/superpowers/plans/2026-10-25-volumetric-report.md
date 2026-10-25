# Volumetric Customer Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan approved up front:** the founder approved the four mock-ups on 25 Oct 2026 and asked for the editor the same day; approved mock-ups mean build now. Calls marked _(builder's call)_ in the spec are recorded as decided.

**Goal:** Customer volumetric reports for stockpile projects, edited in the app and exported as a PDF (pages A + B + C) or one self-contained offline HTML file (interactive view D with A, B, C for printing), on the app's own figures and the app's own pictures, after the three blocking figure bugs and three polish bugs are fixed.

**Architecture:** One pure model (`@aio/project/export` `volumetric.ts`) from the same survey data the house report builds (`buildSurveyData`); page components (React, `renderToStaticMarkup`) shared by the hidden report window (PDF, HTML) and the editor's live preview; pictures taken from the live 3D stage through an orthographic camera and saved with their framing; edits in `report/volumetric.json` on the narrative part and version model; a report-type seam so later project types add a template.

**Tech Stack:** Electron, React 19, TypeScript strict, zustand, zod (`@aio/schema`), three.js (stage), Vitest + Testing Library, Playwright (Electron e2e).

**Spec:** `docs/superpowers/specs/2026-10-25-volumetric-report-design.md`.

## Global Constraints

- Code rules in `CONTRIBUTING.md`: strict TS, no `any`, no non-null assertions; renderer never imports `electron` or `node:*`; product name only from `@aio/brand`; no em or en dashes in user-facing text; every new user-facing string in `packages/ui/src/i18n/en.ts`, added in Task 9 only (bug tasks add none; if one turns out to need a string, it asks Task 9's owner before Batch 1 ends).
- The report prints the app's figures: no second volume rule. Everything goes through `pileSeries`, `stockpileInventory`, `inventorySeries` and the engine session's `series`.
- "Change" = difference of each pile's volume between the two dates (founder). The heat map is a picture only.
- Pictures come from the app's stage rendering, never drawn by the report.
- The HTML file makes no network request: strict CSP meta, everything `data:`. Size budget 15 MB.
- TDD: each task writes its failing test first. Bug tasks start with a test that reproduces the bug (systematic-debugging phase 1: reproduce, find the root cause, then fix).
- e2e: the synthetic quarry demo (`quarryProject` fixture, `tools/demo/survey-demo.mjs`: three monthly surveys, orthophoto per date, three stockpiles with materials, `truth.json`) and the synthetic kit project of `kit-migration.spec.ts`. Real projects only in `@realdata` tests (none planned). Before any e2e run: `pnpm demo:change --quick` (and `pnpm demo:build --quick` for the full CI set). Run every added or changed spec the CI way from `apps/desktop`:
  `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/<spec>.spec.ts --workers=1` (PowerShell: set the three `$env:` variables first). The log must print `[e2e] window 1100 x 720 px at display scale 1`. Worktrees have no `python/.venv`: point `QUADRION_E2E_PYTHON` at the main checkout's venv (memory: e2e in a worktree).
- One heavy run at a time (`pnpm check`, Playwright, pytest) through the shared lock runner, even inside a batch; e2e windows stay off-screen through the fixtures.
- Public text (commits, notes, docs, test names) carries no client, site or person names: "the demo yard", "a stockpile yard". `node tools/agent/check-public-text.mjs <files>` on every doc and spec touched.
- Never write to the main checkout; never bare `git stash`.

## Review Focus

1. **Figures equal the app.** The editor preview, the PDF and the HTML show for every pile and date exactly what the Volumes tab shows (Task 25 compares them on screen). Any drift means a second rule crept in.
2. **Per-date outlines everywhere a series runs** (Tasks 2, 3a, 3b): the app's `computeSeries`, the report's `volumesOverTime` and the fingerprints (`inputsKey`, `seriesFingerprints`) all use `outlineOn(m, capture)`; a stale check that still hashes `points` only would keep old figures current.
3. **The capture puts everything back** (Task 22): date in focus, Show surface, camera pose, selection, label visibility; and it never writes a picture over the person's view on screen without the progress card.
4. **Generated vs written text** (Task 23): a `template` newest version is regenerated on each preview and export; a `user` one never changes; Reset adds a `template` version; old files with no versions are generated.
5. **No network from the HTML** (Tasks 20, 25): no `http:`, `https:` or protocol-relative URL in the file (an SVG `xmlns` is allowed), CSP present with the script's hash, zero blocked requests when opened in a window that refuses every non-`file:`/`data:`/`blob:` request.

---

## Decisions this plan makes

- **Report page entry:** the volumetric report lays out in the existing `house.html` page with `only=volumetric-pdf | volumetric-html | volumetric-model` (no new Vite entry, no CSP change). `reportWindow.ts` gains those kinds: `volumetric-pdf` prints, `volumetric-html` writes `window.__report.html` as the CSV kinds write `window.__report.csv`, `volumetric-model` returns `window.__report.model` (JSON) to the editor.
- **One data path for the preview:** the editor asks main for the model (`report:volumetricModel`), which runs the same hidden page as the export with `only=volumetric-model`. The preview, PDF and HTML therefore share one computation. The model is cached in the editor until the data or the compared date changes.
- **Pagination by counts, not measuring:** A takes 12 table rows, "A, continued" 30; B takes 8 cards and 24 compact rows, continued 40; C's bar chart 24 piles, continued 40. Pure `pagePlan(model, pages)`; the page count is then known before printing and asserted in tests.
- **HTML viewer script:** `viewer/viewer.ts` is strict TS, bundled to one IIFE string at build by a small Vite plugin (`?script` import suffix, esbuild `bundle + iife + minify`) added to `electron.vite.config.ts` and `vitest.config.ts`. The exported file is not an app page, so the app CSP's no-inline rule does not apply to it; the file carries its own CSP with the script's SHA-256.
- **Fonts in the HTML:** IBM Plex Sans 400 and 600 and Plex Mono 400, latin subset `woff2` from `@fontsource`, as `data:` URIs (about 120 KB).
- **Pictures:** JPEG; photo and 3D quality 0.80, heat map and elevation 0.88; longest side 2000 px, stepped down to 1600 and 1200 px to meet the 15 MB HTML budget; at most the 6 newest dates in the HTML. PDF crops are cut as separate JPEGs at 600 px (Chromium may not share one image across crops); the HTML crops with CSS from the date picture.
- **Pictures storage:** `report/views/volumetric/` (`frame.json` `aio.report-views/1` and the JPEGs) in a folder project; a package holds them in memory for the session.
- **Outline per date (bug 1):** `SurveyMeasurement.outlines?: { capture: string; points: SitePoint[] }[]` (max 1000, one per capture). `outlineOn(m, capture) = outlines.find(capture)?.points ?? points`. An outline edit writes `points` and, when the edited date has an entry, that entry too. Already converted projects: a one-time fill from `volumes.json` for kit-pile measurements whose `points` still overlap the kit's latest ring by at least 0.98 (`overlapShare`), recorded in `MeasurementsFile.kitOutlinesAdded` (ids), journaled with its own command label (like the height repair).
- **Report offered** when the project has at least one volume measurement with a stockpile item (`stockpileItem`) and figures on one date; page C and the change figures need two.
- **Export formats:** `volumetric-pdf` and `volumetric-html`, both under the package kind `report-pdf` (a package that forbids report exports forbids both).

## File Structure

New:

- `packages/survey/src/calc/outlines.ts` (+ test): `outlineOn`, `seriesRequests` (captures grouped by outline), `kitOutlines` (per-epoch rings), `addKitOutlines` (one-time fill).
- `packages/project/src/export/volumetric.ts` (+ test): `volumetricModel`, `inShortSentence`, `methodNote`, `pileCrop`, `pagePlan`, `volumetricCsv`.
- `packages/brand/src/lockup.ts` (+ test): `lockupSvg({ on: 'dark' | 'light' })`, `symbolSvg()`.
- `apps/desktop/src/main/reportText.ts` (+ test), `apps/desktop/src/main/reportViews.ts` (+ test).
- `apps/desktop/src/renderer/reportPage/types/` `template.ts` (the seam), `index.ts` (registry).
- `apps/desktop/src/renderer/reportPage/volumetric/` `cover.tsx`, `piles.tsx`, `change.tsx`, `chrome.tsx` (band, footer, markers), `volumetric.css`, `run.ts`, `html.ts`, `fonts.ts`, `viewer/viewer.ts`, `viewer/viewer.css`, `viewer/types.ts`, tests beside each.
- `apps/desktop/src/renderer/report/volumetric/` `captureViews.ts`, `framing.ts`, `editorModel.ts`, `useVolumetric.ts`, `VolumetricEditor.tsx`, `volumetricEditor.css`, tests beside each.
- `apps/desktop/e2e/volumetric-report.spec.ts`, `apps/desktop/e2e/volumetric-report-edit.spec.ts`, `apps/desktop/e2e/volumes-cut-fill.spec.ts`, `apps/desktop/e2e/htmlOffline.ts` (helper: open a file in a window that refuses the network).

Changed: see each task.

## Execution DAG

| Task | Title                                               | Depends on      | Packages / areas                                   |
| ---- | --------------------------------------------------- | --------------- | -------------------------------------------------- |
| 1    | All contract changes                                | none            | `@aio/schema`, docs                                |
| 4    | Bug 2: Whole site cut and fill shows zeros          | none            | desktop renderer (survey/volumes), e2e             |
| 5    | Bug 3: inventory tonnes with the site-wide density  | none            | desktop renderer (survey/volumes), e2e             |
| 7    | Bug 5: 3D pile labels overlap                       | none            | desktop renderer (survey)                          |
| 8    | Bug 6: pile card chart labels and per-date table    | none            | desktop renderer (charts, survey/card), e2e        |
| 9    | All new strings                                     | none            | `@aio/ui` (en.ts)                                  |
| 11   | Brand lockup and symbol as SVG text                 | none            | `@aio/brand`                                       |
| 2    | Bug 1a: outlines per date in the survey package     | 1               | `@aio/survey`                                      |
| 6    | Bug 4: Map mode heat map and pile labels            | 4               | desktop renderer (workspace, survey), e2e          |
| 12   | Volumetric model (pure)                             | 1               | `@aio/project`                                     |
| 13   | Main: report text and pictures files                | 1               | desktop main, journal                              |
| 3a   | Bug 1b: the app's series use each date's outline    | 2               | desktop renderer (survey stores), e2e              |
| 3b   | Bug 1c: the report's series use each date's outline | 2               | desktop renderer (reportPage/house/surveyData.ts)  |
| 14   | Main: volumetric export kinds and the model IPC     | 13              | desktop main (exports)                             |
| 15   | Report-type seam and page A                         | 9, 11, 12       | desktop renderer (reportPage)                      |
| 19   | Interactive viewer D                                | 12              | desktop renderer (reportPage/volumetric/viewer)    |
| 22   | Taking the pictures from the stage                  | 1, 13           | desktop renderer (report/volumetric), engine use   |
| 23   | Editor model and saving                             | 1, 12, 13       | desktop renderer (report/volumetric)               |
| 16   | Page B: pile cards                                  | 15              | desktop renderer (reportPage/volumetric)           |
| 17   | Page C: what changed                                | 15              | desktop renderer (reportPage/volumetric)           |
| 18   | Report page run: PDF and model                      | 3b, 14, 16, 17  | desktop renderer (reportPage)                      |
| 24   | Editor UI and the Reports entry                     | 16, 17, 22, 23  | desktop renderer (report, screens, exports)        |
| 20   | Standalone HTML file                                | 18, 19          | desktop renderer (reportPage/volumetric), Vite cfg |
| 25   | e2e: report figures, PDF, offline HTML              | 3a, 5, 20, 24   | desktop e2e                                        |
| 26   | e2e: edit, persist, reset, pages on and off         | 20, 24          | desktop e2e                                        |
| 27   | Final verification and "How to test"                | 6, 7, 8, 25, 26 | all                                                |

**Parallel batches** (tasks in a batch share no files; dispatch each batch in one message):

1. **Batch 1:** Task 1, Task 4, Task 5, Task 7, Task 8, Task 9, Task 11.
2. **Batch 2:** Task 2, Task 6, Task 12, Task 13.
3. **Batch 3:** Task 3a, Task 3b, Task 14, Task 15, Task 19, Task 22, Task 23.
4. **Batch 4:** Task 16, Task 17.
5. **Batch 5:** Task 18, Task 24.
6. **Batch 6:** Task 20.
7. **Batch 7:** Task 25, Task 26 (written in parallel; their Playwright runs one after the other).
8. **Batch 8:** Task 27.

**Shared files and who owns them:** `en.ts` only Task 9. `contract-changes.md`, `packages/schema/src/{survey,report,ipc,versions}.ts` and `docs/architecture/data-conventions.md` only Task 1. `apps/desktop/src/main/index.ts`: Task 13 (text, pictures) then Task 14 (model IPC), different batches. `reportWindow.ts`, `jobs.ts`, `run.ts` (main exports) only Task 14. `cutFill.ts`, `CutFillPane.tsx` Task 4; `stageCutFill.tsx`, `heatScene.ts` Task 6 (after 4); `volumes-cut-fill.spec.ts` Task 4 then 6. `measureScene.ts` only Task 7 (Task 6 draws Map labels in the map layer, not in `measureScene.ts`; if the root cause is there, Task 6 waits for Task 7, already done in Batch 1). `inventory.ts`, `useInventory.ts`, `InventoryPane.tsx`, `kit-migration.spec.ts` Task 5, then `kit-migration.spec.ts` Task 3a (different batches). `compareStore.ts`, `measureStore.ts` only Task 3a. `surveyData.ts` only Task 3b. `house/main.ts` only Task 18. `volumetric.css`: Task 15 creates it; 16 and 17 put their rules in `piles.css` and `change.css` imported by their own components. `run.ts` (report page) Task 18 then Task 20. `Reports.tsx`, `exportModel.ts` only Task 24. `electron.vite.config.ts`, `vitest.config.ts` only Task 20. `TimeChart.tsx`, `VolumeDetail.tsx`, `measure.css`, `volume-over-time.spec.ts` only Task 8 (Task 7 hides a colliding label with an inline style or a class in its own `labelDeclutter.css`).

**Critical path:** Task 1 → Task 12 → Task 15 → Task 16 / 17 → Task 18 → Task 20 → Task 25 → Task 27 (eight steps). Task 2 → Task 3b joins at Task 18; Task 13 → Task 14 joins at Task 18; Task 22 / 23 → Task 24 joins at Task 25.

---

## Phase 0: the figures and the polish bugs

### Task 1: All contract changes

**Files:** `packages/schema/src/survey.ts`, `packages/schema/src/report.ts`, `packages/schema/src/ipc.ts`, `packages/schema/src/versions.ts`, `packages/schema/src/index.ts`, tests `packages/schema/src/report.test.ts` (new), `packages/schema/src/survey.outlines.test.ts` (new), `packages/schema/src/schema.test.ts`, `docs/architecture/contract-changes.md`, `docs/architecture/data-conventions.md`.

- [ ] Failing tests first: `outlines` parses (one entry per capture, max 1000, `points` 3+ vertices); a file with `kitOutlinesAdded` parses and an older file without it still does; `ReportTextFile` round-trips, refuses a bad part id, keeps an unknown key (loose); `ReportViewsFrame` (`aio.report-views/1`: `extent`, `widthPx`, `heightPx`, `mPerPx`, `views[]` with `{ name, kind: 'photo' | 'elevation' | 'cutfill' | '3d', capture, pair?, file }`, `markers3d` by capture and measurement id, `fingerprint`) parses; `EXPORT_FORMAT_KIND['volumetric-pdf']` and `['volumetric-html']` are `report-pdf`; the export kind map test in `schema.test.ts` lists both.
- [ ] `survey.ts`: `MeasurementOutline` and optional `SurveyMeasurement.outlines`; `MeasurementsFile.kitOutlinesAdded` (ids, max 5000). Both additive on loose objects.
- [ ] `report.ts`: refactor `currentNarrative` / `addNarrativeVersion` onto part-level helpers `currentVersion(part)` and `withVersion(part, v)` (no behaviour change; the narrative tests stay green), then `REPORT_TEXT_SCHEMA`, `ReportTypeId`, `VolumetricTextId`, `ReportPageId`, `ReportTextFile`, `reportTextPath(report)`, `REPORT_VIEWS_SCHEMA`, `ReportViewsFrame`, `reportViewsDir(report)` as in spec section 6 and 7.
- [ ] `ipc.ts`: `report:readText` (`{ projectId, report }` to `{ ok, file | null, readOnly }`), `report:writeText` (`{ projectId, report, file }`), `report:saveViews` (`{ projectId, report, frame, files: { name, data: Uint8Array }[] }`, names `^[a-z0-9-]{1,80}\.jpg$`, at most 64 files), `report:volumetricModel` (`{ projectId, compareWith? }` to `{ ok, model: unknown }`, the model typed in `@aio/project`), `EXPORT_FORMATS` += `volumetric-pdf`, `volumetric-html`.
- [ ] `versions.ts`: families `aio.report-text` (`report/<report>.json`) and `aio.report-views` (`report/views/<report>/frame.json`), since 0.x of this build.
- [ ] One `contract-changes.md` row per change (outlines and `kitOutlinesAdded`; report text file; views frame; the four IPC channels; the two export formats), and the two files in `data-conventions.md`.
- [ ] `pnpm --filter @aio/schema test`, `pnpm typecheck`; commit `feat(schema): report text, report views, per-date outlines and volumetric export formats`.

### Task 2: Bug 1a: outlines per date in the survey package

**Files:** `packages/survey/src/calc/outlines.ts` (new), `outlines.test.ts` (new), `packages/survey/src/calc/kitPiles.ts`, `kitPiles.test.ts`, `packages/survey/src/calc/index.ts`, `packages/survey/src/index.ts`, an engine-level test `packages/survey/src/engine/series.outlines.test.ts` (new).

- [ ] **Reproduce first** (`series.outlines.test.ts`): two synthetic height grids on a flat base; a cone pile at A on date 1 that is moved and shrunk to B on date 2 (known volumes). Running the engine's series with the date-2 ring for both dates gives the wrong date-1 volume (assert the failure the bug shows); with each date's ring both are within 1 % of the truth.
- [ ] `kitPiles.test.ts`: a two-epoch kit pile whose rings differ converts with `outlines` per epoch (each draped on its epoch's DSM through `heightAt`), `points` still the latest ring.
- [ ] `outlines.ts`: `outlineOn(m, capture)`; `seriesRequests(m, captures)` returns `{ ring, captures }[]`, one per distinct outline, in capture order; `kitOutlines(pile, volumes, toSite, heightAt?)`; `addKitOutlines(file, volumes, edits, opts)` fills kit-pile measurements without `outlines` whose `points` overlap the kit's latest ring by at least 0.98, records ids in `kitOutlinesAdded`, never runs twice, returns `{ file, changed }`.
- [ ] `convertKitPiles` writes `outlines`; `openWithKitPiles` runs `addKitOutlines` (read-only mode: in memory only).
- [ ] `pnpm --filter @aio/survey test`; commit `fix(survey): each survey date's figure uses that date's pile outline`.

### Task 3a: Bug 1b: the app's series use each date's outline

**Files:** `apps/desktop/src/renderer/survey/compareStore.ts`, `compareStore.test.ts`, `apps/desktop/src/renderer/survey/measureStore.ts`, `measureStore.kit.test.ts`, `apps/desktop/src/renderer/survey/measureMove.ts` (outline edit), `measureMove.test.ts`, `apps/desktop/e2e/kit-migration.spec.ts`.

- [ ] Failing test in `compareStore.test.ts`: a measurement with two outlines; `computeSeries` sends each capture with its own ring (mock engine client records the requests); `inputsKey` changes when one date's outline changes.
- [ ] `computeSeriesNow` loops `seriesRequests(m, captures)` per item; fingerprints per request; `inputsKey` hashes `outlines`.
- [ ] `measureStore.kit.test.ts`: opening a project converted before this build adds the outlines once (journal command label "Added each survey date's pile outline"), and not again on the next open; a pile the person moved gets none.
- [ ] Outline edit while a date with an entry is in focus updates that entry and `points` (test in `measureMove.test.ts`).
- [ ] `kit-migration.spec.ts`: extend the synthetic kit (rings differ per epoch) and assert the converted `measurements.json` carries one outline per epoch. Run it the CI way.
- [ ] Commit `fix(survey): the Volumes tab works each date out on that date's outline`.

### Task 3b: Bug 1c: the report's series use each date's outline

**Files:** `apps/desktop/src/renderer/reportPage/house/surveyData.ts`, `apps/desktop/src/renderer/reportPage/house/survey.test.ts`.

- [ ] Failing test: `volumesOverTime` (through `buildSurveyData` with a fake engine) asks each date with its own ring; the report's per-date figures equal the app's for the same inputs (the same `seriesRequests`).
- [ ] Use `seriesRequests` and `outlineOn` in `volumesOverTime`; the outline printed per date (`PileOverTime.outline`) becomes `outlines` by capture with the latest as today's `outline`.
- [ ] Commit `fix(report): survey reports work each date out on that date's outline`.

### Task 4: Bug 2: Whole site cut and fill shows zeros

**Files:** `apps/desktop/src/renderer/survey/volumes/cutFill.ts`, `cutFill.test.ts`, `CutFillPane.tsx`, `CutFillPane.test.tsx`, `apps/desktop/e2e/volumes-cut-fill.spec.ts` (new).

- [ ] **Reproduce:** e2e on the quarry demo (pipeline Python), Volumes tab, Cut & fill, Whole site, pair m2 to m3: Cut, Fill and Net must not all be 0.0 and must match the demo truth's site change within the quick grid tolerance. Note whether it fails here; if it passes on the demo, reproduce on a two-date kit-converted fixture in `cutFill.test.ts` (the real project was a converted kit project).
- [ ] Root cause (trace `wholeSiteCutFill` → `EngineClient.site` → the answer the pane reads) written in the commit body; failing unit test for it; fix.
- [ ] Commit `fix(survey): Whole site cut and fill shows the site's figures`.

### Task 5: Bug 3: inventory tonnes with the site-wide density

**Files:** `apps/desktop/src/renderer/survey/volumes/inventory.ts`, `inventory.test.ts`, `apps/desktop/src/renderer/survey/useInventory.ts`, `apps/desktop/src/renderer/survey/volumes/InventoryPane.tsx`, `InventoryPane.test.tsx`, `apps/desktop/e2e/kit-migration.spec.ts`.

- [ ] Failing test: `inventoryModel` for kit-pile measurements with no site materials and a kit density of 1.6 t/m³ gives tonnes = volume x 1.6 (today null).
- [ ] Root cause (expected: `inventoryByMaterial` resolves only `m.material` against site materials; `pileMaterial` with the kit density is never asked): pass a `materialOf(m)` resolver built from `pileMaterial(m, materials, kit)`; group label "Stockpile material (site density)".
- [ ] `kit-migration.spec.ts`: the Inventory's Tonnes column shows the kit figure x density. Run CI way.
- [ ] Commit `fix(survey): inventory tonnes use the site-wide density`.

### Task 6: Bug 4: Map mode heat map and pile labels

**Files:** `apps/desktop/src/renderer/workspace/stageCutFill.tsx`, `stageCutFill.test.tsx`, `apps/desktop/src/renderer/survey/heatScene.ts`, the map measurement layer (`apps/desktop/src/renderer/survey/overlaysMap.ts` or where the map draws measurement outlines; find it first), its test, `apps/desktop/e2e/volumes-cut-fill.spec.ts`.

- [ ] Reproduce in `volumes-cut-fill.spec.ts`: Map mode (stage tools switch), Show, Cut & fill: the map has the heat image layer (`aio-survey-heat` source present, via `page.evaluate` on the map controller test hook) and the stockpile labels are visible.
- [ ] Root cause for each (the heat may share Task 4's cause; the labels may never be added in Map mode); failing unit tests; fix. Labels in Map mode: name only, the 3D label's style.
- [ ] Commit `fix(workspace): Map mode draws the cut and fill heat map and pile labels`.

### Task 7: Bug 5: 3D pile labels overlap

**Files:** `apps/desktop/src/renderer/survey/labelDeclutter.ts` (new), `labelDeclutter.test.ts` (new), `apps/desktop/src/renderer/survey/measureScene.ts`, `measureScene.test.ts`.

- [ ] Failing test: three label boxes that overlap on screen; `declutter(boxes)` keeps the larger pile's label in place, nudges the next up by its height plus 4 px, hides one that still collides (shows it on hover), in priority order (selected, then volume).
- [ ] Run it each frame on the labels `measureScene` moves (screen boxes from `getBoundingClientRect` once per size change, positions per frame).
- [ ] Commit `fix(survey): 3D pile labels never overlap`.

### Task 8: Bug 6: pile card chart labels and per-date table

**Files:** `apps/desktop/src/renderer/charts/TimeChart.tsx`, `TimeChart.test.tsx`, `apps/desktop/src/renderer/survey/card/VolumeDetail.tsx`, its CSS (`apps/desktop/src/renderer/survey/measure.css` volume table rules), `apps/desktop/e2e/volume-over-time.spec.ts`.

- [ ] Failing test: `TimeChart` with two and three dates labels every date (today only the first); labels that would collide drop to every other, the first and last always shown.
- [ ] Per-date table: no wrap at the right panel's narrowest width (test asserts `white-space: nowrap` cells and the date column's short format).
- [ ] `volume-over-time.spec.ts`: each date's tick label is visible on the card's chart. Run CI way.
- [ ] Commit `fix(survey): the pile card's chart names every date`.

---

## Phase 1: the report

### Task 9: All new strings

**Files:** `packages/ui/src/i18n/en.ts`, `packages/ui/src/i18n/i18n.test.ts` if it lists namespaces.

- [ ] Add `vreport.*`: the editor (fields, defaults "Stockpile volume report", hints, Reset to generated, Take pictures, stale bar, Export PDF, Export HTML, pages A/B/C labels, read-only note, one-date note), the pages (KPI labels, table heads, "In short", method lines, key words for the heat map, "A, continued", footer "Prepared by {company} with {product}", "Page {n}"), the viewer (toggles, Save as PDF, Download CSV, list heads), the "In short" phrase pieces, Reports block "Customer reports", the export actions ("Volumetric report (PDF)", "Volumetric report (HTML)") and errors (budget refused, no pictures, not offered). No em or en dashes (the i18n test checks).
- [ ] Commit `feat(ui): strings for the volumetric report`.

### Task 11: Brand lockup and symbol as SVG text

**Files:** `packages/brand/src/lockup.ts` (new), `lockup.test.ts` (new), `packages/brand/src/index.ts`.

- [ ] Failing test: `lockupSvg({ on: 'dark' })` has the kit file's viewBox `0 0 746.11 156`, the symbol's pieces and the wordmark paths, colours `#EEF2F5` and mint `#5ED1B3`; `on: 'light'` uses ink and teal; `symbolSvg()`; the product name only from `brand`.
- [ ] Compose from `SYMBOL` and `WORDMARK` with the kit's transforms (read `docs/brand/quadrion/kit/lockup/quadrion-horizontal-on-dark.svg`); no import (the file stays loadable by type stripping, like `marks.ts`).
- [ ] Commit `feat(brand): the horizontal lockup and symbol as SVG text`.

### Task 12: Volumetric model (pure)

**Files:** `packages/project/src/export/volumetric.ts` (new), `volumetric.test.ts` (new), `packages/project/src/export/index.ts`.

- [ ] Tests first with a synthetic 19-pile, two-date input (fictional names P01 to P19): ranking by latest m³; KPIs (stock, tonnes with "n of m" when partial, change m³ and %, survey error only when every pile has `uncertainty`); share of stock (8 named + Others); cards for the 8 largest, compact list for the rest; `inShortSentence` per spec section 5 (fall, rise, steady, one date, counter-mover rule, no minus signs or dashes); `methodNote` (base name, cell, GSD, CRS, density per material or site-wide); `pileCrop` (union of both dates' outlines, 25 % margin, 20 m minimum, square, in frame pixels); marker numbers follow the ranking; `pagePlan` row counts per decision above; `volumetricCsv` equals `stockpileCsv` output for the same dates.
- [ ] Input type `VolumetricInput` built from `ReportSurveyData` pieces (`volumes.piles`, `stockpiles`, `captures`, `settings.materials`, kit density), the manifest (customer, site, crs), the frame and the resolved text; output `VolumetricModel` (JSON-safe, the `report:volumetricModel` payload).
- [ ] Commit `feat(project): the volumetric report model`.

### Task 13: Main: report text and pictures files

**Files:** `apps/desktop/src/main/reportText.ts` (new), `reportText.test.ts` (new), `apps/desktop/src/main/reportViews.ts` (new), `reportViews.test.ts` (new), `apps/desktop/src/main/journal.ts`, `journal.test.ts`, `apps/desktop/src/main/index.ts` (handlers `report:readText`, `report:writeText`, `report:saveViews`).

- [ ] Tests first, modelled on `narrative.ts`: read null when absent; newer-version refusal; invalid file message; write with `.bak` and the changed-on-disk refusal; a package reads in place and refuses writes; `saveViews` writes into `report/views/<report>/` atomically (part files, then rename; old pictures not in the new frame removed), refuses names outside the pattern and paths outside the folder.
- [ ] Journal: `report:writeText` and `report:saveViews` recorded like `report:writeNarrative` (pictures as one record with file names and sizes, not bytes).
- [ ] Commit `feat(desktop): save the report text and pictures with the project`.

### Task 14: Main: volumetric export kinds and the model IPC

**Files:** `apps/desktop/src/main/exports/reportWindow.ts`, `apps/desktop/src/main/exports/jobs.ts`, `jobs.test.ts`, `apps/desktop/src/main/exports/run.ts`, `run.test.ts`, `apps/desktop/src/main/exports/reportWindow.test.ts` (new, pure parts), `apps/desktop/src/main/index.ts` (handler `report:volumetricModel`).

- [ ] Tests first: `SURVEY_KIND` maps `volumetric-pdf` and `volumetric-html`; the save dialog filter is `.pdf` / `.html` and the default name "<project> volumetric report <date>.<ext>"; a project with no volume measurements is refused with the spec's message; `reportQuery` for the volumetric kinds carries `only` and `compare`; the html kind writes `window.__report.html` text (utf8) through `.part` then rename; the model kind returns `window.__report.model` and never prints.
- [ ] `ReportKind` += `volumetric-pdf`, `volumetric-html`, `volumetric-model`; deadline 15 minutes.
- [ ] Commit `feat(desktop): volumetric report exports and the editor's model`.

### Task 15: Report-type seam and page A

**Files:** `apps/desktop/src/renderer/reportPage/types/template.ts` (new), `types/index.ts` (new), `apps/desktop/src/renderer/reportPage/volumetric/chrome.tsx` (new), `cover.tsx` (new), `volumetric.css` (new), `cover.test.tsx` (new), `template.test.ts` (new). Load the `impeccable` and `frontend-design` skills first.

- [ ] Tests first (`renderToStaticMarkup`): the band has the lockup, title, "Prepared for", site, both dates, pile count; three KPI tiles, and two when the model has no survey error; the "In short" text and the intro when set; the ranked table rows and diverging bars (width proportional, colour by sign); the method note; the footer text and page number; the orthophoto `<img>` with markers placed through the frame; "A, continued" pages from `pagePlan`.
- [ ] The `ReportTemplate` interface and `REPORT_TEMPLATES` registry (spec section 8) with `volumetric` partly filled (cover only; 16 and 17 add theirs through the template's `pages` map).
- [ ] Print tokens in `volumetric.css` (ink, teal, mint, the heat ramp's red and blue, Plex), A4 `@page`, one `.vr-page` per page with `break-after: page`.
- [ ] Commit `feat(report): the volumetric report's cover page`.

### Task 16: Page B: pile cards

**Files:** `apps/desktop/src/renderer/reportPage/volumetric/piles.tsx` (new), `piles.css` (new), `piles.test.tsx` (new).

- [ ] Tests first: share-of-stock bar segments sum to 100 % with Others; 8 cards for 19 piles, each with two crops (before, after) using the crop JPEG names from the frame, change chip, tonnes, footprint, peak height, note when set; the compact list for the other 11 with a note mark; continued pages per `pagePlan`.
- [ ] Register the page in the volumetric template.
- [ ] Commit `feat(report): the volumetric report's pile cards`.

### Task 17: Page C: what changed

**Files:** `apps/desktop/src/renderer/reportPage/volumetric/change.tsx` (new), `change.css` (new), `change.test.tsx` (new).

- [ ] Tests first: before and after photos with the same frame; the heat map picture with the app's legend (`HeatLegend` rendered static, the range from `legendRangeM`) and the markers; the plain-words key with the deadband value; the sorted change bar chart (largest drawdown first); closing remarks on the last printed page; C left out with one date.
- [ ] Register the page in the template.
- [ ] Commit `feat(report): the volumetric report's what-changed page`.

### Task 18: Report page run: PDF and model

**Files:** `apps/desktop/src/renderer/reportPage/volumetric/run.ts` (new), `run.test.ts` (new), `apps/desktop/src/renderer/reportPage/house/main.ts`.

- [ ] Tests first (fake reader): `only=volumetric-model` publishes `{ state: 'ready', model }` and lays nothing out; `volumetric-pdf` lays out the pages the text file turns on, publishes `pages` equal to `pagePlan`'s count; missing pictures: the page lays out with a "Take pictures in the app" placeholder for the model kind and refuses for the export kinds with the spec's message; edits are read from `report/volumetric.json` (`template` parts regenerated from the model, `user` parts as written).
- [ ] `house/main.ts`: route `only=volumetric-*` to `runVolumetric` before the house layout (reuse `readSurveyFiles` and `buildSurveyData` with `fillDates: true`).
- [ ] Commit `feat(report): lay out and print the volumetric report`.

### Task 19: Interactive viewer D

**Files:** `apps/desktop/src/renderer/reportPage/volumetric/viewer/types.ts` (new), `viewer.ts` (new), `viewer.css` (new), `viewer.test.ts` (new, jsdom).

- [ ] Tests first: boots from a `<script type="application/json" id="vr-data">` block; date, view and unit toggles swap the picture and the figures; clicking a marker or a list row selects the pile and fills the card (crops by CSS `background-position` and `background-size` from the frame); the list sorts by volume and change; Download CSV creates a `Blob` of the embedded CSV and clicks an `a[download]`; Save as PDF calls `window.print`; keyboard: toggles are buttons with `aria-pressed`, markers are buttons with the pile name.
- [ ] No imports beyond the viewer's own files (the bundle must be standalone); strings come in the data block.
- [ ] Commit `feat(report): the volumetric report's interactive view`.

### Task 20: Standalone HTML file

**Files:** `apps/desktop/src/renderer/reportPage/volumetric/html.ts` (new), `html.test.ts` (new), `fonts.ts` (new), `apps/desktop/src/renderer/reportPage/volumetric/run.ts`, `apps/desktop/electron.vite.config.ts` (the `?script` plugin), `apps/desktop/vitest.config.ts`, `apps/desktop/src/renderer/env.d.ts` (module declaration for `*?script`).

- [ ] Tests first: the document has `<!doctype html>`, charset, viewport, the CSP meta with the script's `sha256` (recomputed in the test), no `http:`, `https:` or `//host` URL outside `xmlns`; every `<img>` and CSS `url()` is `data:`; fonts are `data:font/woff2`; pages A, B, C are inside a `.vr-print` block hidden on screen and shown in `@media print`, D hidden in print; the edited summary text appears; the size guard steps the pictures down and refuses above 15 MB at 1200 px.
- [ ] `run.ts`: `only=volumetric-html` builds the pages and the viewer data and publishes `html`.
- [ ] Commit `feat(report): export the volumetric report as one offline HTML file`.

### Task 22: Taking the pictures from the stage

**Files:** `apps/desktop/src/renderer/report/volumetric/framing.ts` (new), `framing.test.ts` (new), `captureViews.ts` (new), `captureViews.test.ts` (new).

- [ ] Tests first: `frameFor(extent, maxSide)` gives `mPerPx`, pixel size and the world-to-pixel and pixel-to-world maps (round trip within half a pixel); the orthographic camera for a frame looks straight down with the extent exactly in view; with a fake stage and stores, `captureViews` sets each date and Show surface in turn, renders through the orthographic camera to an offscreen target, encodes at the spec's quality, records 3D marker pixels by projecting pile centres, and restores date, surface, camera pose, selection and label visibility even when a shot throws.
- [ ] Waits for the date's tiles and the heat map to settle (the stage's tile-loading idle and the `siteHeat` answer) with a time limit per shot, then `report:saveViews`.
- [ ] Commit `feat(report): take the report's pictures from the 3D stage`.

### Task 23: Editor model and saving

**Files:** `apps/desktop/src/renderer/report/volumetric/editorModel.ts` (new), `editorModel.test.ts` (new), `useVolumetric.ts` (new), `useVolumetric.test.tsx` (new).

- [ ] Tests first (reusing `narrativeModel.ts` patterns): resolved texts from the file and the generated defaults (title, Prepared for from `manifest.customer`, Prepared by from branding `companyName`, summary from `inShortSentence`, method from `methodNote`); editing a part saves a `user` version; Reset adds a `template` version; pile notes capped at 280 characters; page toggles keep at least one page on; save is debounced (600 ms) and flushed on unmount; a read-only package never writes; the model is fetched once per compared date and data fingerprint.
- [ ] Commit `feat(report): the volumetric report editor's model and saving`.

### Task 24: Editor UI and the Reports entry

**Files:** `apps/desktop/src/renderer/report/volumetric/VolumetricEditor.tsx` (new), `VolumetricEditor.test.tsx` (new), `volumetricEditor.css` (new), `apps/desktop/src/renderer/screens/Reports.tsx`, `apps/desktop/src/renderer/exports/exportModel.ts`, `exportModel.test.ts`. Load `impeccable` and `frontend-design` first.

- [ ] Tests first: the Customer reports block shows Volumetric report only when offered; the editor shows the fields (spec section 6) and the live preview pages; typing in the summary updates the preview; Reset to generated restores the generated sentence; the stale-pictures bar with Take pictures; Export PDF and Export HTML run `volumetric-pdf` and `volumetric-html`; a package shows the read-only note; the export actions appear in `EXPORT_ACTIONS` with their policy kind.
- [ ] Layout: fields column (360 px) beside the scaled preview, at 1100 x 720 and on large screens; the panel styles of the narrative editor (no new visual style).
- [ ] Commit `feat(report): edit the volumetric report before export`.

### Task 25: e2e: report figures, PDF, offline HTML

**Files:** `apps/desktop/e2e/volumetric-report.spec.ts` (new), `apps/desktop/e2e/htmlOffline.ts` (new).

- [ ] On the quarry demo (pipeline Python, surfaces prepared as `volume-over-time.spec.ts` does): read each pile's latest and previous m³ and tonnes in the Volumes tab inventory; open Reports, Volumetric report: the preview's table and KPIs show the same figures; Take pictures (progress card, then the preview shows the photo); Export PDF: `pdfText` has the cover, the pile cards and What changed, the page count equals the plan's (3 for the demo's three piles), the figures match; Export HTML: the file is under 15 MB, opens in a window from `htmlOffline.ts` (new partition, `session.webRequest.onBeforeRequest` cancels and records anything not `file:`, `data:` or `blob:`) with zero recorded requests, the map picture has `naturalWidth > 0`, a marker click selects that pile's card, the units toggle shows tonnes, Download CSV yields the CSV (`will-download`), and `printToPDF` of that window has the same page count as the PDF.
- [ ] Run CI way, `--repeat-each=2` once to catch timing; commit `test(e2e): the volumetric report on the quarry demo`.

### Task 26: e2e: edit, persist, reset, pages on and off

**Files:** `apps/desktop/e2e/volumetric-report-edit.spec.ts` (new).

- [ ] Quarry demo: write a summary "Edited summary for the demo yard.", a title, a note on SP1; Export HTML: the file contains all three; close and reopen the project: the editor shows them; `report/volumetric.json` has `user` versions; Reset to generated: the preview shows the generated sentence and the next HTML export contains it; turn page B off: the PDF has one page fewer and no pile cards.
- [ ] Run CI way; commit `test(e2e): editing the volumetric report`.

### Task 27: Final verification and "How to test"

- [ ] `pnpm check` green; every spec added or changed (`volumes-cut-fill`, `kit-migration`, `volume-over-time`, `volumetric-report`, `volumetric-report-edit`) green the CI way; `node tools/agent/check-public-text.mjs` on the spec, the plan, the session note and the e2e specs; the HTML size of the quarry demo recorded in the session note.
- [ ] Independent review (strongest model, high effort) of the diff against the Review Focus list, before the hand-off.
- [ ] Write the "How to test" walkthrough below into the closing message and the session note; `/wrapup`; `node tools/agent/finish-task.mjs`; hand over to the merge coordinator.

**How to test (for the founder):**

1. Open the copy of the two-survey stockpile project. Volumes tab, Inventory: the latest and previous totals and the change now match the old kit's figures (about 12,499 m³ less), and Tonnes shows figures at 1.6 t/m³.
2. Volumes tab, Cut & fill, Whole site: Cut, Fill and Net are not zero. Switch the stage to Map, Show, Cut & fill: the heat map and the pile names are on the map. In 3D, pile names next to each other no longer overlap.
3. Click a pile with two dates: its card's chart names both dates and the per-date table does not wrap.
4. Reports, Customer reports, Volumetric report. Check the preview's figures against the Volumes tab. Press Take pictures and wait: the cover shows the orthophoto with numbered piles.
5. Rewrite the "In short" sentence, set Prepared for, add a note to one pile, add closing remarks. Leave and come back: everything is still there. Press Reset to generated on the summary: the sentence comes back from the figures.
6. Export PDF: pages A, B and C, your texts in them. Turn page B off and export again: no pile cards.
7. Export HTML, turn off Wi-Fi, open the file in a browser: switch dates, views and units, click piles, Download CSV, Save as PDF.
