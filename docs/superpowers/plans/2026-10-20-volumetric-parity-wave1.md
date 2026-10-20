# Volumetric Parity, Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One profile chart, one measurement card, one volumes engine in plain language (with old projects carried over intact), volume over time for every survey date, and a per-project report template with an "Add to report" action.

**Architecture:** Pure models go in `@aio/survey`: the chart series styles and hover readout in `section/chart.ts`, the time series rows in `calc/timeline.ts`, the per-tool primary and secondary readout keys in `tools/readout.ts`, the per-date engine run and base spread in `engine/series.ts`, and the kit pile conversion in `calc/kitPiles.ts`. Python mirrors the engine parts in `aio_pipelines/survey/series.py`, and shared fixtures hold the two together (ADR 0009). The React parts live in the desktop renderer, because `@aio/ui` may not depend on `@aio/survey` or `@aio/geo` (SPEC section 2):

- `renderer/charts/`: `ProfileChart`, `TimeChart`, `SurfaceChips`, export.
- `renderer/survey/card/`: `MeasureCard` and its parts.

The report renders the same components to static SVG with `renderToStaticMarkup`. The stockpile kit keeps detection and floor finding. Its piles become engine volume measurements when a project loads, and the kit's base computation, `VolumesPanel`, `ProfileChart` and register UI are deleted.

**Tech Stack:** TypeScript strict, React 19, zustand, zod 4, three.js, MapLibre, CesiumJS (globe), Vitest (jsdom, `createRoot` + `act`, no testing-library), Playwright with Electron, Python 3 (`uv`, pytest, numpy).

**Spec:** `docs/superpowers/specs/2026-10-20-volumetric-parity-design.md` (Wave 1: W1 to W4, plus the W8 template storage and "Add to report"). It extends `docs/superpowers/specs/2026-10-18-measurement-layers-design.md` (all of its plan's tasks 1 to 9 landed) and builds on `docs/superpowers/specs/2026-10-16-ui-foundation-design.md`.

## Global Constraints

- **Worktree:** work only in `E:\Dev\AIO Software\.claude\worktrees\volumetric-parity`, branch `feat/volumetric-parity`. Never touch the main checkout.
- **Checks:** `pnpm check` must be green. Run e2e the way CI does (see "E2e specs" under the Execution DAG). Keep local runs light: one Playwright run at a time, `--workers=1`, off-screen windows.
- **UI tasks** start by loading the `impeccable` and `frontend-design` skills. They use the foundation tokens (`--sp-*`, `--t-*`, `--r-*`, `--z-*`, `--d-*`) and the `@aio/ui` parts: `Button`, `IconButton`, `Chip`, `Tabs`, `Popover`, `Menu`, `Row`, `Tip`, `Icon`, `EmptyState`, and the `.seg` segmented style.
  - No raw px font sizes, colours, box-shadows or z-index outside `reportPage/`. The guard test enforces this.
- **New colours** are tokens in `packages/ui/src/tokens.css`. Each needs a dark value (`:root`), a light value (`:root[data-theme='light']`) and a `data-contrast='more'` value. Light-theme text pairs pass 4.5:1, which `tokens.test.ts` checks.
- **Fixed series styles by kind, never by order:**
  - current survey: solid, `--chart-current`
  - earlier dates: `--chart-earlier`, lighter the older they are
  - designs: dashed `6 4`, `--chart-design`
  - base: dotted `1 3`, `--chart-base`
- **Cut and fill:** one colour pair, `--cut` and `--fill` (with `--cut-a` and `--fill-a` for areas). It replaces `.sec-cut`/`.sec-fill` in `section.css`, `CUT_CSS`/`FILL_CSS` in the kit's `ProfileChart.tsx`, and the colours in `packages/volumetric/src/components/styles.tsx`.
- **Every value on screen** goes through `formatRow` (`@aio/survey`) or `formatQuantity` (`@aio/geo`) with the effective units. Angles use the new `SurveySettings.angles` (Task 1). No `toFixed` for anything a person reads.
- **Strings** go in `packages/ui/src/i18n/en.ts`, all added in Task 2. No em or en dashes in user-facing text.
- **Exact copy** (spec W3):
  - "Ignore changes smaller than"
  - "No survey data"
  - "High precision"
  - "Fill gaps: straight" and "Fill gaps: smooth"
  - "Triangulated toe" (default base)
  - "From an earlier version (kit {base})"
  - "Recompute with the standard base"
  - "was {value}"
  - "±{pct} across bases" (for example "±1.8 % across bases")
  - "Stale, recompute"
- **Base picker:** each base gets a one-line explanation:
  - Lowest point: "bins, bunkers, piles against walls"
  - Best-fit plane: "a flat, level pad"
  - Fixed level: "a known floor height"
  - Previous survey or design: "the measured ground underneath, the most accurate when it exists"
  - Custom: "edit the base's points"
- **Default base for a new volume measurement:** `{ kind: 'smart' }`, shown as "Triangulated toe".
- **No new volume maths.** `ENGINE_VERSION` (TS `engine/compare.ts:59`, Python `compare.py:78`) stays 1, and fingerprints are unchanged. A per-date result is `compareItem` run with the date as the "current" capture.
- **ADR 0009:**
  - Any computed figure this plan adds (the per-date series and the base spread) has a TypeScript and a Python executor.
  - Both read the fixtures in `packages/schema/src/__fixtures__/survey/` and must agree to 1e-6 relative.
  - Inventory totals are sums of stored engine results, made at display time in TS only (decision below).
- **Contracts** are additive only. Each change gets a row in `docs/architecture/contract-changes.md` (Task 1).
- **Pipeline pack:** bump to `0.18.1` (patch) for the new Python library module. There is no new pipeline and no new params. `APP_RANGE` stays `">=0.22.0 <2.0.0"`.
- **Existing projects:**
  - Every kit pile becomes a volume measurement that shows exactly its old figure until the person accepts "Recompute with the standard base".
  - Nothing is recomputed silently. Player mode and read-only packages convert in memory only.
- **Retired with no survivors:**
  - `survey/SectionChart.tsx`, `packages/volumetric/src/components/ProfileChart.tsx`, `VolumesPanel.tsx`
  - `sectionChart()` in `reportPage/house/survey.ts`
  - `HistoryChart` in `ElevationHistory.tsx`
  - the engine `'measure'` tool
  - `measureRowValue`'s and `labelOf`'s own pickers
  - the kit's base computation
  - At the end, `grep` for each name must be empty (Task 27).
- **Public text:** no client, site or tester names. Run `node tools/agent/check-public-text.mjs` on docs and fixtures.
- **Platform:** Windows only, offline.

## Review Focus

1. **An old project opened in player mode, or without height tiles.** Every kit pile shows its old figure and base, labelled "From an earlier version (kit tin)". There is no "Recompute" button (no surfaces), nothing is written, and no error appears.
   - Pinned in Task 6 (`converts piles with carried figures and records the converted ids`) and Task 11 (`a read-only project converts in memory and writes nothing`).
2. **A pile the person deleted after conversion comes back on the next open.** It must not: `MeasurementsFile.kitPilesConverted` lists every converted pile id.
   - Pinned in Task 6 (`skips piles already converted, even when their measurement was deleted`).
3. **A survey date that does not cover the pile, so the result is partial or refused.** The time chart and table show it marked ("Partly outside the survey" or "No survey data"), never as 0 m³. The stacked inventory total says which piles are missing on that date.
   - Pinned in Task 3 (`a refused date has no value and keeps its reason`) and Task 20 (`inventory totals count missing piles per date`).
4. **Imperial units with angles in DMS.** These must follow everywhere they show:
   - the chart's axes and hover
   - the card's primary and secondary values
   - the time table
   - CSV headers and values
   - telecom angles
   - Pinned in Task 4 (`formats angles and bearings by the site's angle settings`), Task 7 (`axis labels and hover follow imperial units`) and Task 21 (`series CSV in the display units`).
5. **A chart with nothing to draw:**
   - a single surface
   - a surface that is null along the whole line
   - twelve earlier dates
   - The chart must not divide by zero. "Shade vs" hides when nothing else is shown. Lightness clamps (the oldest earlier date is still visible at opacity 0.35).
   - Pinned in Task 3 (`earlier dates fade from 0.9 to 0.35 and clamp`, `hover skips an all-null series`) and Task 7 (`one surface: no Shade vs control`).

---

## File map

| File                                                                                                                                                                                  | Task | Responsibility                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `packages/schema/src/survey.ts`, `manifest.ts`, `report.ts`, `versions.ts`, `ipc.ts`, `reportTemplate.ts` (new), `index.ts`                                                           | 1    | all contract additions                                                                                          |
| `tools/compat/report-template.test.mjs` (new), `docs/architecture/contract-changes.md`                                                                                                | 1    | older-reader check, contract rows                                                                               |
| `packages/ui/src/tokens.css`, `tokens.test.ts`, `i18n/en.ts`                                                                                                                          | 2    | chart and cut/fill tokens, every string of the plan                                                             |
| `packages/survey/src/section/chart.ts` (new), `section/index.ts`, `calc/timeline.ts` (new), `calc/index.ts`                                                                           | 3    | series styles, shade targets, hover readout, time rows                                                          |
| `packages/survey/src/tools/readout.ts`, `tools/index.ts`                                                                                                                              | 4    | `PRIMARY_KEY`, `primaryRow`, `secondaryRows`, `formatAngle`, angle-aware `formatRow`                            |
| `packages/survey/src/engine/series.ts` (new), `engine/index.ts`; `python/src/aio_pipelines/survey/series.py` (new); `python/tests/survey_fixtures.py`, `test_survey_series.py` (new)  | 5    | per-date run and base spread, both executors, fixtures                                                          |
| `packages/survey/src/calc/kitPiles.ts` (new), `calc/index.ts`; `packages/volumetric/src/model/register.ts`                                                                            | 6    | kit pile to measurement conversion; `applyEdits` moves to `@aio/survey`                                         |
| `apps/desktop/src/renderer/charts/ProfileChart.tsx`, `SurfaceChips.tsx`, `ShadeVs.tsx`, `charts.css` (all new)                                                                        | 7    | the one profile chart                                                                                           |
| `apps/desktop/src/renderer/charts/TimeChart.tsx` (new)                                                                                                                                | 8    | volume, elevation and stacked inventory over time                                                               |
| `apps/desktop/src/renderer/charts/exportChart.ts`, `ExportFormatDialog.tsx` (new)                                                                                                     | 9    | PNG and CSV of a chart, the one export dialog                                                                   |
| `apps/desktop/src/renderer/survey/compareStore.ts`, `engineProtocol.ts`, `engineServe.ts`, `engineClient.ts`                                                                          | 10   | per-date and spread requests, stored series, staleness per date                                                 |
| `apps/desktop/src/renderer/survey/measureStore.ts`                                                                                                                                    | 11   | conversion on load and after a volumetric job, recompute with history, `liveReading` on `primaryRow`            |
| `apps/desktop/src/renderer/survey/SectionBody.tsx`, `SectionDock.tsx`, `SectionWindow.tsx`, `sectionStore.ts`, `section.css`; delete `SectionChart.tsx`                               | 12   | sections on the profile chart                                                                                   |
| `apps/desktop/src/renderer/survey/card/` (new: `MeasureCard.tsx`, `cardModel.ts`, `CardActions.tsx`, `card.css`)                                                                      | 13   | the shared card                                                                                                 |
| `apps/desktop/src/renderer/survey/Comparison.tsx` → `card/VolumeDetail.tsx`, `card/BasePicker.tsx` (new)                                                                              | 14   | volume chips, plain base picker, spread hint, carried figure, over-time table                                   |
| `MeasurementPanel.tsx`, `TelecomTools.tsx`, `ElevationHistory.tsx` (deleted), `Qa.tsx`, `workbench/benches/MeasureBench.tsx`                                                          | 15   | every measurement on the card                                                                                   |
| `apps/desktop/src/renderer/survey/measureScene.ts`, `measureRows.ts`, `shell/actions/measureActions.tsx` (palette only)                                                               | 16   | stored style drawn, labels and tree value from `primaryRow`, one palette                                        |
| `apps/desktop/src/renderer/workspace/SceneCursor.tsx`, `survey/SiteSettings.tsx`                                                                                                      | 17   | angle settings UI, cursor through the formatter                                                                 |
| `apps/desktop/src/renderer/road/useRoadMap.ts`, `road/RoadTools.tsx`, `island/useIslandLive.ts`, `workbench/benches/RoadBench.tsx`                                                    | 18   | road measure on survey maths and card, saved in survey projects                                                 |
| `packages/globe/src/measure.ts`, `renderer/globe/GlobeScreen.tsx`; `packages/engine/src/stage/Stage.ts`, `packages/engine/src/tools/measure.ts` (deleted)                             | 19   | globe on the formatter and card look; engine tool deleted                                                       |
| `apps/desktop/src/renderer/survey/VolumesView.tsx` (new), `BulkTotals.tsx`, `workbench/benches/VolumesBench.tsx`; `packages/survey/src/calc/bulk.ts`                                  | 20   | volumes view, inventory over time                                                                               |
| `packages/project/src/export/surveyCsv.ts`                                                                                                                                            | 21   | volume-over-time CSV, inventory from engine results                                                             |
| `apps/desktop/src/main/reportTemplate.ts` (new), `main/ipc` registration; `renderer/report/templateStore.ts` (new); `shell/actions/reportActions.tsx` (new), `shell/actions/index.ts` | 22   | template IPC, Add to report and Export actions                                                                  |
| `packages/volumetric/src/**`, `workspace/VolumeTools.tsx`, `workspace/Stage.tsx`, `workspace/CompareScene.tsx`, `App.tsx`, `docs/KNOWN-LIMITS.md`                                     | 23   | kit retirement, from/to picks in Volume tools                                                                   |
| `apps/desktop/src/renderer/survey/Cleanup.tsx`, `HeatmapStops.tsx`, `WholeSite.tsx`, `heatScene.ts`                                                                                   | 24   | plain words, heat legend with histogram, empty states                                                           |
| `apps/desktop/src/renderer/reportPage/house/survey.ts`, `surveyData.ts`, `sections.ts`, `main.ts`, `house.css`; `packages/ai/src/analysis-tools.ts`                                   | 25   | report on the shared chart and card, Volume over time section, template entries; assistant reads engine results |
| `apps/desktop/e2e/*`                                                                                                                                                                  | 26   | new and changed specs                                                                                           |
| `docs/architecture/adr/0013-one-volume-engine.md` (new), `python/pyproject.toml`, `docs/KNOWN-LIMITS.md`                                                                              | 27   | ADR, pack patch bump, verification                                                                              |

---

## W0: Contracts, tokens and pure models

### Task 1: Contract additions

**Files:**

- Modify: `packages/schema/src/survey.ts`
  - `ComparisonResult` (:289): add `carried?`, `uncertainty?`
  - `SurveyMeasurement` (:431): add `origin?`, `series?`, `previousResults?`
  - `MeasurementsFile` (:455): add `kitPilesConverted?`
  - `SurveySettings` (:123): add `angles?`
- Modify: `packages/schema/src/manifest.ts`: `Capture` gains `verticalAccuracy?`
- Modify: `packages/schema/src/report.ts`: `ReportSectionId` gains `'volume-over-time'`, kept in `reportSectionsExtra` as the M11 ids are
- Create: `packages/schema/src/reportTemplate.ts`, exported from `packages/schema/src/index.ts`
- Modify: `packages/schema/src/versions.ts`: `SCHEMA_REGISTRY` gains `aio.report-template` v1
- Modify: `packages/schema/src/ipc.ts`: add `report:readTemplate` and `report:writeTemplate` (next to `project:readVolumes`, :984)
- Test: `packages/schema/src/survey.test.ts`, `reportTemplate.test.ts` (new), `versions.test.ts`; `tools/compat/report-template.test.mjs` (new)
- Docs: `docs/architecture/contract-changes.md` (four rows)

**Interfaces:**

- Produces (all optional, and absent on every older file):

```ts
// survey.ts
export const AccuracySource = z.enum(['checkpoints', 'ppk', 'rtk', 'stated']);
export const VolumeUncertainty = z.looseObject({        // W6 fills it; Wave 1 never writes it
  plusMinusM3: z.number().nonnegative(), sigmaM: z.number().nonnegative().max(10), source: AccuracySource,
});
export const CarriedResult = z.looseObject({            // a kit figure carried over unchanged
  from: z.literal('kit'), base: VolumeBaseId, pile: z.string().min(1).max(200), epoch: z.string().min(1).max(200),
});
// ComparisonResult += carried: CarriedResult.optional(), uncertainty: VolumeUncertainty.optional()
export const PreviousResult = z.looseObject({
  netM3: z.number(), totalM3: z.number().nonnegative(), label: z.string().max(200), replacedAt: IsoTime,
});
export const MeasurementOrigin = z.looseObject({ kind: z.literal('kit-pile'), pile: z.string().min(1).max(200) });
// SurveyMeasurement += origin?: MeasurementOrigin, series?: z.array(ComparisonResult).max(1000),
//                      previousResults?: z.array(PreviousResult).max(20)
// MeasurementsFile += kitPilesConverted?: z.array(z.string().min(1).max(200)).max(5000)
export const AngleSettings = z.looseObject({
  angle: z.enum(['deg', 'dms']), bearing: z.enum(['dms', 'deg']), precision: z.number().int().min(0).max(4),
});
// SurveySettings += angles?: AngleSettings   (absent: { angle: 'deg', bearing: 'dms', precision: 2 }, today's look)
export const DEFAULT_ANGLES: AngleSettings;
// manifest.ts
export const CaptureVerticalAccuracy = z.object({ sigmaM: z.number().nonnegative().max(10), source: AccuracySource }).strict();
// Capture += verticalAccuracy?: CaptureVerticalAccuracy   (W6 fills it; Wave 1 never writes it)
// reportTemplate.ts
export const REPORT_TEMPLATE_SCHEMA = 'aio.report-template/1';
export const REPORT_TEMPLATE_FILE = 'report/template.json';
export const TemplateEntry = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('measurement'), id: SurveyId, parts: z.array(z.enum(['value', 'chart', 'table'])).min(1).max(3), addedAt: IsoTime }),
  z.looseObject({ kind: z.literal('section'), section: ReportSectionId }),
]);
export const ReportTemplateFile = z.looseObject({
  schema: z.literal(REPORT_TEMPLATE_SCHEMA), entries: z.array(TemplateEntry).max(500),
});
export function emptyReportTemplate(): ReportTemplateFile;
// ipc.ts
'report:readTemplate':  { request: { projectId }, response: { ok: true, file: ReportTemplateFile | null } | { ok: false, error } }
'report:writeTemplate': { request: { projectId, file: ReportTemplateFile }, response: { ok: true } | { ok: false, error } }
```

- [ ] **Step 1: Write the failing tests.** In `survey.test.ts`:
  - `parses a measurement with origin, series and previous results`
  - `an older measurement without the new fields still parses`
  - `a result with carried kit figures parses and keeps carried.base`
  - `settings without angles parse; DEFAULT_ANGLES is deg, dms, 2`

  In `reportTemplate.test.ts`:
  - `emptyReportTemplate parses`
  - `a measurement entry needs at least one part`
  - `an unknown entry kind is refused`

  In `versions.test.ts`:
  - `the registry knows aio.report-template/1`

  In `tools/compat/report-template.test.mjs` (the `rf-origins-sidecar.test.mjs` pattern):
  - schema 0.21's `MeasurementsFile` and `SurveySettings` parse a file carrying every new field.

- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run packages/schema/src/survey.test.ts packages/schema/src/reportTemplate.test.ts packages/schema/src/versions.test.ts`. Expected: FAIL (unknown exports).
- [ ] **Step 3: Implement the schemas above.** Each field carries a doc comment that says "absent on every older file", and names the wave that fills the reserved ones (W6).
- [ ] **Step 4: Run the tests and see them pass.** Run the same command plus `node --test tools/compat/report-template.test.mjs`. Expected: PASS.
- [ ] **Step 5: Add the four rows to `docs/architecture/contract-changes.md`.** Use the existing pattern: path, "additive", fields optional, what older builds do, and a downgrade caveat. Mark each "Pending founder review".
  1. `aio.measurements/1`: `origin`, `series`, `previousResults`, `kitPilesConverted`, `ComparisonResult.carried` / `uncertainty`.
     - Older builds keep the fields: `looseObject` passes them through and writes them back.
     - Downgrade caveat: an older build shows a carried result as "Stale, recompute", because its fingerprint is `kit:<pile>:<epoch>:<base>`.
  2. `aio.survey-settings/1` `angles`: older builds ignore it.
  3. `aio.project/1` `Capture.verticalAccuracy`: reserved for W6.
     - Caveat: `Capture` is a non-strict `z.object`, so an older build drops the field when it rewrites the manifest.
  4. The new file `report/template.json` (`aio.report-template/1`), the IPC `report:readTemplate`/`report:writeTemplate`, and `ReportSectionId` `volume-over-time` (in `reportSectionsExtra`).
     - Older builds ignore the file, and they ignore the section id because it sits in `reportSectionsExtra`.
     - Check that the `.aio` export copies `report/`: `grep -n "report/" packages/project/src/export`. If it does not, add `report/template.json` to the export list in this task and test it.
- [ ] **Step 6: Commit.** `feat(schema): volumetric parity wave 1 contracts`

### Task 2: Chart and cut/fill tokens, and every string

**Files:**

- Modify: `packages/ui/src/tokens.css`. Add dark values in `:root`, light values in `:root[data-theme='light']` (:122), and both contrast blocks (:185, :197).
- Modify: `packages/ui/src/tokens.test.ts`
- Modify: `packages/ui/src/i18n/en.ts`
- Test: `packages/ui/src/tokens.test.ts`, `packages/ui/src/i18n/i18n.test.ts`

**Interfaces:**

- Produces these tokens:
  - `--chart-current` (= `--acc` hue)
  - `--chart-earlier` (neutral grey)
  - `--chart-design` (a distinct hue, not a date colour or a severity colour)
  - `--chart-base`
  - `--chart-grid`
  - `--chart-crosshair`
  - `--cut`, `--fill`, `--cut-a`, `--fill-a`
  - Cut is warm and fill is cool, in the spirit of today's `#b2182b` / `#2166ac`.
- Produces these string namespaces, all keys listed in this step so later tasks add none:
  - `chart.*`: `addSurface` "+ Add survey or design", `shadeVs` "Shade vs", `none` "None", `chainage` "Chainage", `elevation` "Elevation", `direction` "{a} → {b}", `exaggeration` "Vertical exaggeration {n}:1", `cutArea` "Cut {v}", `fillArea` "Fill {v}", `grade` "Grade", `diff` "Difference", `export` "Export", `png` "PNG", `dxf` "DXF", `csv` "CSV", `addToReport` "Add to report", `base` "Base", `latest` "Latest"
  - `card.*`: `more` "More", `notes` "Notes", `flyTo` "Fly to", `hide` "Hide", `show` "Show", `delete` "Delete", `rename` "Rename", `colour` "Colour", `export` "Export", `vertices` "Vertices", `carried` "From an earlier version (kit {base})", `recomputeStandard` "Recompute with the standard base", `was` "was {value}", `spread` "±{pct} across bases", `stale` "Stale, recompute", `noData` "No survey data", `partly` "Partly outside the survey", `notComputed` "Not computed yet", `computing` "Computing", `liveEdit` "Live while you edit; saved when the edit ends."
  - `base.*`:
    - `smart` "Triangulated toe" / `smartHint` "the surveying norm for piles on uneven ground"
    - `lowest` "Lowest point" / `lowestHint` "bins, bunkers, piles against walls"
    - `plane` "Best-fit plane" / `planeHint` "a flat, level pad"
    - `level` "Fixed level" / `levelHint` "a known floor height"
    - `surface` "Previous survey or design" / `surfaceHint` "the measured ground underneath, the most accurate when it exists"
    - `custom` "Custom" / `customHint` "edit the base's points"
    - `mean` "Average edge level" / `meanHint` "a rough check against the toe's average height"
  - `vol.*`: `ignoreSmaller` "Ignore changes smaller than", `highPrecision` "High precision", `gridCell` "Grid {cell}", `from` "From", `to` "To", `overTime` "Volume over time", `change` "Change", `tonnage` "Tonnage", `inventory` "Site inventory over time", `missing` "{n} piles have no survey data on {date}", `status.*` (one line per status)
  - `cleanup.straight` "Fill gaps: straight", `cleanup.smooth` "Fill gaps: smooth"
  - `heat.editColours` "Edit colours", `heat.legend` "Height change"
  - `settings.angles.*`: "Angles", "Decimal degrees", "Degrees, minutes, seconds", "Bearings", "Decimals"
  - `report.added` "Added to the report", `report.already` "Already in the report"
  - `empty.*` for each survey and volumes empty state that Tasks 14, 15, 20 and 24 replace

- [ ] **Step 1: Write the failing tests.**
  - In `tokens.test.ts`: `chart and cut/fill tokens have dark, light and more-contrast values`, and `--cut and --fill text pass 4.5:1 on --bg-1 in the light theme` (via `contrastRatio`).
  - In `i18n.test.ts`: `no dashes in the new chart, card, base, vol strings` (the existing dash check over the new keys).
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run packages/ui/src/tokens.test.ts packages/ui/src/i18n/i18n.test.ts`
- [ ] **Step 3: Add the tokens and strings.** Teach `NON_COLOUR` nothing new, because all the new tokens are colours.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(ui): chart and cut/fill tokens, volumetric parity strings`

### Task 3: Chart model and time rows (pure)

**Files:**

- Create: `packages/survey/src/section/chart.ts`, `packages/survey/src/section/chart.test.ts`
- Modify: `packages/survey/src/section/index.ts` (re-export)
- Create: `packages/survey/src/calc/timeline.ts`, `packages/survey/src/calc/timeline.test.ts`
- Modify: `packages/survey/src/calc/index.ts` (re-export)

**Interfaces:**

- Consumes: `cutFill`, `chartScale`, `niceStep`, `gradeOf`, `Grade` from `section/`; `ComparisonResult` from `@aio/schema`.
- Produces:

```ts
// section/chart.ts
export type SeriesKind = 'current' | 'earlier' | 'design' | 'base';
export interface ChartSeries {
  key: string;
  label: string;
  kind: SeriesKind;
  capture?: string;
  date?: string;
  chainage: readonly number[];
  z: readonly (number | null)[];
}
export interface SeriesStyle {
  stroke: string;
  dash: '' | '6 4' | '1 3';
  width: number;
  opacity: number;
}
export function seriesStyle(s: ChartSeries, all: readonly ChartSeries[]): SeriesStyle;
export function orderSeries(all: readonly ChartSeries[]): ChartSeries[]; // base, designs, earlier oldest first, current last (drawn on top)
export function shadeTargets(visible: readonly ChartSeries[]): { key: string; label: string }[];
export interface HoverRow {
  key: string;
  label: string;
  z: number | null;
}
export interface HoverReadout {
  chainage: number;
  rows: HoverRow[];
  deltaM: number | null;
  grade: Grade | null;
}
export function hoverAt(
  visible: readonly ChartSeries[],
  chainage: number,
  target: string | null,
): HoverReadout;
export function zExtent(visible: readonly ChartSeries[]): [number, number] | null;
// calc/timeline.ts
export interface TimeRow {
  capture: string;
  date: string;
  label: string;
  valueM3: number | null;
  changeM3: number | null;
  tonnes: number | null;
  status: ComparisonResult['status'] | 'missing';
  reason?: string;
  stale: boolean;
  latest: boolean;
}
export function volumeRows(
  series: readonly ComparisonResult[],
  captures: readonly { id: string; date: string; label: string }[],
  opts: {
    densityTPerM3?: number;
    isStale: (r: ComparisonResult) => boolean;
    quantity?: 'net' | 'total';
  },
): TimeRow[];
export interface StackRow {
  capture: string;
  date: string;
  label: string;
  totalM3: number;
  parts: { id: string; valueM3: number }[];
  missing: string[];
}
export function stackRows(rows: ReadonlyMap<string, readonly TimeRow[]>): StackRow[];
```

Rules the tests pin:

- **Styles:**
  - `current`: `var(--chart-current)`, solid, width 2, opacity 1.
  - `earlier`: `var(--chart-earlier)`, solid, width 1.5. Opacity is `0.9` for the newest earlier date and steps linearly down to `0.35` for the oldest, clamped at 0.35.
  - `design`: `var(--chart-design)`, dash `6 4`, width 1.5.
  - `base`: `var(--chart-base)`, dash `1 3`, width 1.5.
- **Hover:** interpolates linearly between samples. A null on either side gives null. `deltaM` is current minus target. `grade` is the current series' slope over the samples either side, through `gradeOf`.
- **`volumeRows`:**
  - Sorts by date.
  - `changeM3` is the difference from the previous row that has a value.
  - A `refused` result or a missing date gives `valueM3: null` and keeps its reason.
  - `latest` marks the last row that has a value.

- [ ] **Step 1: Write the failing tests.** In `chart.test.ts`:
  - `current is solid accent, design dashed, base dotted`
  - `earlier dates fade from 0.9 to 0.35 and clamp` (12 earlier series; the oldest is 0.35, the newest 0.9)
  - `styles do not depend on the order surfaces were added`
  - `shadeTargets lists only visible non-current series`
  - `hoverAt interpolates and gives delta and grade` (the values from a 3-sample fixture)
  - `hover skips an all-null series` (its row has `z: null`, and nothing throws)
  - `zExtent is null when nothing has data`

  In `timeline.test.ts`:
  - `rows sort by date and give change since previous`
  - `a refused date has no value and keeps its reason`
  - `tonnes use density; absent density gives null`
  - `stackRows sums parts and lists piles missing on a date`

- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run packages/survey/src/section/chart.test.ts packages/survey/src/calc/timeline.test.ts`
- [ ] **Step 3: Implement the functions as specified.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(survey): chart series model and volume time rows`

### Task 4: One primary key per tool, and angle formatting

**Files:**

- Modify: `packages/survey/src/tools/readout.ts`, `packages/survey/src/tools/index.ts`
- Test: `packages/survey/src/tools/readout.test.ts` (create it if absent, otherwise extend `measure.test.ts`)

**Interfaces:**

- Consumes: `AngleSettings`, `DEFAULT_ANGLES` (Task 1); `allRows`, `ReadoutRow`, `formatBearing` (existing).
- Produces:

```ts
export const PRIMARY_KEY: Record<MeasurementTool, string>; // the row key the card, tree, labels and island show
export const SECONDARY_KEYS: Record<MeasurementTool, readonly string[]>; // at most 3, the compact line
export function primaryRow(m: SurveyMeasurement, ctx?: ReadoutContext): ReadoutRow | null;
export function secondaryRows(m: SurveyMeasurement, ctx?: ReadoutContext): ReadoutRow[];
export function formatAngle(deg: number, a: AngleSettings, locale?: NumberLocale): string; // 'deg' → "15.20°", 'dms' → 15°12'00"
export function formatBearingAs(deg: number, a: AngleSettings, locale?: NumberLocale): string;
// formatRow gains an optional last parameter: angles: AngleSettings = DEFAULT_ANGLES.
// The 'text' kind (telecom angles) and 'bearing' use it.
// ReadoutKind gains 'angle'. The telecom azimuth and inclination rows move from 'text' to 'angle'.
```

- **The primary key** must reproduce today's choice of `measureRowValue` (`measureRows.ts:27`) and `labelOf` (`measureScene.ts:149`) for every tool: telecom tools use row 0, the others the first non-null row. The one difference: `PRIMARY_KEY` is a fixed key. If that row is null, `primaryRow` falls back to the first non-null row.
- **The secondary keys:**
  - `distance`: horizontal, height, grade (spec example "Horizontal 140.9 m · Height +21.4 m · Grade 15.2 %")
  - `volume`: cut, fill, area
  - `area`: perimeter, terrain area

- [ ] **Step 1: Write the failing tests.**
  - `every tool has a primary key that allRows produces` (loop over `MeasurementTool.options`)
  - `primaryRow matches the old picker for every tool` (a fixture measurement per tool, compared with the first non-null row)
  - `distance secondary line is horizontal, height, grade`
  - `formats angles and bearings by the site's angle settings`: `formatAngle(15.2,{angle:'dms',...})==="15°12'00\""`, `formatAngle(15.2,{angle:'deg',precision:1})==="15.2°"`, and a bearing in `deg` mode gives `"045.50°"`
  - `formatRow without angles keeps today's output` (2-decimal degrees, DMS bearings)
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run packages/survey/src/tools`
- [ ] **Step 3: Implement the functions as specified.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(survey): one primary readout per tool and angle units`

### Task 5: Volume per date and base spread, in both executors

**Files:**

- Create: `packages/survey/src/engine/series.ts`, `packages/survey/src/engine/series.parity.test.ts`, `packages/survey/src/engine/series.test.ts`
- Modify: `packages/survey/src/engine/index.ts`
- Create: `python/src/aio_pipelines/survey/series.py`, `python/tests/test_survey_series.py`
- Modify: `python/tests/survey_fixtures.py`. Add `series_cases()`, which writes `packages/schema/src/__fixtures__/survey/series.json`, and update the fixtures `README.md`.
- Create (generated): `packages/schema/src/__fixtures__/survey/series.json`

**Interfaces:**

- Consumes: `compareItem`, `Resolve`, `CompareOptions` (`engine/compare.ts:374`); `projectResolver` (`engine/resolver.ts:67`); Python `compare_item` (`compare.py:395`) and `ProjectSurfaces(project, capture)` (`compare.py:652`).
- Produces:

```ts
/** Runs `item` once per capture with that capture as "current" (and "previous" as the one before it).
 *  A fixed side (a survey with a capture, a design, a base) stays fixed. Each result has toCapture or
 *  fromCapture set to the date; results come back in the order of `captures`. */
export function compareSeries(
  ring: Ring,
  item: ComparisonItem,
  resolveAt: (capture: string) => Resolve,
  captures: readonly string[],
  opts?: CompareOptions,
): Promise<ComparisonResult[]>;
export function seriesApplies(item: ComparisonItem): boolean; // true when either side is 'current' or 'previous'
export const SPREAD_BASES: readonly BaseSpec[]; // smart, fit-plane, perimeter-mean, reference perimeter-min
export interface BaseSpread {
  pct: number;
  nets: { base: string; netM3: number }[];
}
/** null when the item's `from` is not a base, or fewer than 2 bases give an ok or partial result, or the mean is 0. */
export function baseSpread(
  ring: Ring,
  item: ComparisonItem,
  resolve: Resolve,
  opts?: CompareOptions,
): Promise<BaseSpread | null>;
```

```python
def compare_series(ring, item, resolve_at, captures, site=None, now=None) -> list[dict]: ...
def series_applies(item) -> bool: ...
SPREAD_BASES: tuple[dict, ...]
def base_spread(ring, item, resolve, site=None, now=None) -> dict | None: ...  # {"pct": float, "nets": [...]}
```

**The spread formula** (fixed here, and the same in both executors): `pct = (max(totalM3) − min(totalM3)) / 2 / mean(totalM3) × 100` over the ok or partial results of `SPREAD_BASES`. The card shows it as "±{pct} across bases" with 1 decimal.

- [ ] **Step 1: Write the failing tests.**
  - In `series.test.ts`, on the in-memory grids already used by `quality.test.ts`:
    - `one result per capture in order, toCapture set`
    - `previous follows the date: the first date's previous is refused with its reason`
    - `a fixed design side stays fixed`
    - `seriesApplies is false for survey-to-design with fixed captures`
    - `baseSpread is null for a surface-to-surface item`
  - In `series.parity.test.ts`, the `parity.test.ts` pattern: read `series.json`, run `compareSeries` and `baseSpread` per case, and require statuses, reasons, fingerprints and labels to be identical and numbers to agree within 1e-6 relative. Require at least 8 series cases (two and three dates, a refused date, a partial date, a design side) and 4 spread cases.
  - In `test_survey_series.py`: the same cases through `compare_series` and `base_spread` must reproduce `series.json`.
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run packages/survey/src/engine/series` and, from `python/`, `uv run --frozen pytest tests/test_survey_series.py -v`.
  - In a worktree without `python/.venv`, use the main checkout's venv interpreter as CONTRIBUTING describes. Never `uv sync` into the shared editable install.
- [ ] **Step 3: Implement `series.py`, then generate the fixtures.** Run `uv run --frozen python tests/survey_fixtures.py`. Then implement `series.ts`.
- [ ] **Step 4: Run both test suites, plus the existing `parity.test.ts` and `test_survey_fixtures.py` (unchanged), and see them pass.**
- [ ] **Step 5: Run `uv run --frozen ruff format .` and `ruff check .` in `python/`.**
- [ ] **Step 6: Commit.** `feat(survey): volume per survey date and base spread, TS and Python`

### Task 6: Kit piles to volume measurements (pure)

**Files:**

- Create: `packages/survey/src/calc/kitPiles.ts`, `packages/survey/src/calc/kitPiles.test.ts`
- Modify: `packages/survey/src/calc/index.ts`
- Modify: `packages/volumetric/src/model/register.ts`. Move `applyEdits` (:8) and its `EffectivePile` type into `kitPiles.ts`, and re-import them here.

**Interfaces:**

- Consumes: `VolumesFile`, `BoundaryEditsFile`, `SurveyMeasurement`, `MeasurementsFile`, `CarriedResult` (Task 1).
- Produces:

```ts
export const KIT_FOLDER = 'Stockpiles';
export const KIT_BASE_LABEL: Record<VolumeBaseId, string>; // tin → "tin" etc., for "From an earlier version (kit tin)"
export function applyEdits(file: VolumesFile, edits: BoundaryEditsFile | null): EffectivePile[];
export interface KitConversion {
  added: SurveyMeasurement[];
  converted: string[];
}
/** One volume measurement per effective pile not in `file.kitPilesConverted`. carry=true sets each date's
 *  result from the kit figure of `volumes.defaultBase` (series) and the latest date as results[0]; carry=false
 *  adds the item only (the engine computes). */
export function convertKitPiles(
  volumes: VolumesFile,
  edits: BoundaryEditsFile | null,
  file: MeasurementsFile,
  opts: { carry: boolean; now: string; newId: () => string },
): KitConversion;
```

**Each measurement:**

- `tool: 'volume'`, `family: 'polygon'`
- `label`: the pile name
- `folder: KIT_FOLDER`
- `scope: { kind: 'site' }`
- `points`: the latest epoch's ring
- `material`: the pile's material, if it has one
- `origin: { kind: 'kit-pile', pile }`
- `items: [{ id, from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }]`

**Each carried result:**

- `status: 'ok'`
- `cutM3`/`fillM3`/`netM3` from the kit's `FillCut`, and `totalM3 = fill + cut`
- `areaM2` from the epoch
- `engine: 'ts'`
- `fingerprint: 'kit:<pile>:<epoch>:<base>'`
- `carried: { from: 'kit', base, pile, epoch }`
- `toCapture`: the epoch's `captureId`
- `fromLabel`: the kit base label
- `toLabel`: the capture label

- [ ] **Step 1: Write the failing tests.** The fixture is a small `VolumesFile` with 2 piles over 2 epochs, plus one boundary edit.
  - `converts piles with carried figures and records the converted ids` (the numbers equal the kit's `defaultBase` figures exactly)
  - `carry false adds measurements with no results`
  - `skips piles already converted, even when their measurement was deleted`
  - `uses the edited toe line from boundaries`
  - `a membrane-only base (tin) is carried, never offered as a live base` (the item's `from` is `smart`)
  - `applyEdits behaves as before` (moved from the kit's `store.test.ts`; the register tests keep passing)
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run packages/survey/src/calc/kitPiles.test.ts`
- [ ] **Step 3: Implement the conversion as specified.**
- [ ] **Step 4: Run the tests and see them pass**, and run `pnpm vitest run packages/volumetric`.
- [ ] **Step 5: Commit.** `feat(survey): carry stockpile kit piles over as volume measurements`

---

## W1: One profile chart

### Task 7: ProfileChart, SurfaceChips and Shade vs

Load `impeccable` and `frontend-design` first.

**Files:**

- Create:
  - `apps/desktop/src/renderer/charts/ProfileChart.tsx`
  - `apps/desktop/src/renderer/charts/SurfaceChips.tsx`
  - `apps/desktop/src/renderer/charts/ShadeVs.tsx`
  - `apps/desktop/src/renderer/charts/charts.css`
  - `apps/desktop/src/renderer/charts/index.ts`
- Test: `apps/desktop/src/renderer/charts/ProfileChart.test.tsx`, `SurfaceChips.test.tsx`

**Interfaces:**

- Consumes: Task 3 (`ChartSeries`, `seriesStyle`, `orderSeries`, `shadeTargets`, `hoverAt`, `zExtent`), `cutFill`, `chartScale`, `niceStep`, `formatQuantity`, `unitLabel`, `formatRow`; tokens and strings from Task 2.
- Produces:

```ts
export interface ChipOption {
  key: string;
  label: string;
  kind: SeriesKind;
  group: 'survey' | 'design' | 'base';
}
export function SurfaceChips(p: {
  shown: readonly ChipOption[];
  off: ReadonlySet<string>;
  addable: readonly ChipOption[];
  onToggle(key: string): void;
  onAdd(key: string): void;
  onRemove(key: string): void;
  testId?: string;
}): ReactElement;
export function ShadeVs(p: {
  targets: readonly { key: string; label: string }[];
  value: string | null;
  onChange(key: string | null): void;
}): ReactElement | null; // null when targets is empty
export interface ProfileChartProps {
  series: readonly ChartSeries[]; // the visible ones (chips decide)
  shadeVs: string | null;
  exaggeration: number;
  ends: { a: string; b: string };
  units: SurveyUnits;
  precision: SurveyPrecision;
  angles?: AngleSettings;
  pins?: readonly Pin[];
  onPin?(chainage: number): void;
  height?: number;
  width?: number; // width given → no ResizeObserver (static render for the report)
  interactive?: boolean; // false: no crosshair, no click (report)
  testId?: string;
}
export function ProfileChart(p: ProfileChartProps): ReactElement;
```

**Behaviour:**

- An SVG chart. Axes carry units (`unitLabel`), with an "A → B" direction label and the note "Vertical exaggeration {n}:1".
- Cut and fill are shaded with `--cut-a`/`--fill-a` between current and `shadeVs`. "Cut {v} · Fill {v}" sits under the chart.
- Moving the pointer shows a crosshair (`data-testid="chart-crosshair"`) and a readout (`chart-readout`) with:
  - the chainage
  - each visible surface's elevation
  - "Difference" to the shading target
  - "Grade" through `formatRow` kind `grade`
- The readout is keyboard reachable: arrow keys move the crosshair by one sample when the chart has focus.
- Click-to-pin calls `onPin` (it keeps the old `section-chart-pin` test ids).
- Chips: the current survey is on by default.
  - Clicking a chip toggles it off or on (`aria-pressed`).
  - The chip's × removes it.
  - "+ Add survey or design" opens a `Popover` `Menu` grouped Surveys, Designs and Base.
  - Each chip shows a swatch in the series style: a solid, dashed or dotted line sample.

- [ ] **Step 1: Write the failing tests.** In `ProfileChart.test.tsx` (jsdom, `createRoot` + `act`):
  - `draws current solid and design dashed regardless of order`
  - `shades cut and fill against the chosen surface and prints both areas`
  - `axis labels and hover follow imperial units` (feet labels; readout elevation in ft)
  - `hover readout lists every visible surface, difference and grade`
  - `arrow keys move the crosshair one sample`
  - `click pins at the chainage under the pointer`
  - `static render (width given, interactive false) has no crosshair and no listeners`

  In `SurfaceChips.test.tsx`:
  - `clicking a chip turns it off and on`
  - `remove takes it off`
  - `add menu groups surveys, designs, base`
  - `one surface: no Shade vs control` (this one tests `ShadeVs` with empty targets)

- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run apps/desktop/src/renderer/charts`
- [ ] **Step 3: Implement the components.** Use logical CSS properties, and put the styles in `charts.css` on tokens only.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): one profile chart with surface chips and shade vs`

### Task 8: TimeChart (volume, elevation and inventory over time)

Load `impeccable` and `frontend-design` first.

**Files:**

- Create: `apps/desktop/src/renderer/charts/TimeChart.tsx`, `TimeChart.test.tsx`
- Modify: `apps/desktop/src/renderer/charts/index.ts`. This file is shared with Task 7. Task 8 runs after Task 7 commits, or adds its export line in its own commit; see the DAG.

**Interfaces:**

- Consumes: `TimeRow`, `StackRow` (Task 3); `formatQuantity`.
- Produces:

```ts
export type TimeChartData =
  | { kind: 'volume'; rows: readonly TimeRow[] }
  | {
      kind: 'elevation';
      rows: readonly { capture: string; date: string; label: string; z: number | null }[];
    }
  | { kind: 'stack'; rows: readonly StackRow[]; names: ReadonlyMap<string, string> };
export function TimeChart(p: {
  data: TimeChartData;
  units: SurveyUnits;
  precision: SurveyPrecision;
  width?: number;
  height?: number;
  interactive?: boolean;
  testId?: string;
}): ReactElement;
```

**Behaviour:**

- The x axis is the date, spaced by date rather than by index.
- Volume shows bars, with the latest bar in `--chart-current` and the others in `--chart-earlier`.
- A stale date is hatched and has a `Tip` reading "Stale, recompute".
- A missing date is drawn as a gap, marked "No survey data".
- Elevation shows a line with dots.
- Stack shows stacked bars per pile, with a total label on top and a "{n} piles have no survey data on {date}" note.
- Hovering shows the date, the value and the change.

- [ ] **Step 1: Write the failing tests.**
  - `latest date is highlighted`
  - `a missing date is a gap with its note, not a zero bar`
  - `stale date is hatched with the stale tip`
  - `x spacing follows dates` (3 dates, 1 day and then 10 days apart)
  - `stack shows the total and names missing piles`
  - `values follow the volume unit` (yd³)
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run apps/desktop/src/renderer/charts/TimeChart.test.tsx`
- [ ] **Step 3: Implement the chart.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): time chart for volume, elevation and inventory`

### Task 9: Chart export and the one export dialog

**Files:**

- Create: `apps/desktop/src/renderer/charts/exportChart.ts`, `exportChart.test.ts`, `ExportFormatDialog.tsx`, `ExportFormatDialog.test.tsx`

**Interfaces:**

- Consumes: `bridge.call('dialog:savePath', …)` as `sectionStore.exportSection` uses it (`sectionStore.ts:381`); `ChartSeries`.
- Produces:

```ts
export function chartPng(svg: SVGSVGElement, scale?: number): Promise<Uint8Array>; // inline computed token colours, draw to canvas
export function seriesCsv(
  series: readonly ChartSeries[],
  units: SurveyUnits,
  precision: SurveyPrecision,
): string; // chainage + one column per surface, unit headers
export function savePng(bytes: Uint8Array, suggested: string): Promise<string | null>; // existing bridge save path + file write channel
export interface ExportChoice<F extends string> {
  format: F;
  label: string;
  group: 'DXF' | 'CSV' | 'PNG';
}
export function ExportFormatDialog<F extends string>(p: {
  title: string;
  choices: readonly ExportChoice<F>[];
  initial: F;
  onExport(f: F): void;
  onClose(): void;
}): ReactElement;
```

**How saving works:** `savePng` uses whichever write channel the desktop already has for user-chosen paths. Find it by checking how `ExportDialog.tsx` writes a file. If no channel can write raw bytes, use the existing `survey.section` job route for DXF and CSV only, and write the PNG through the same channel the report uses for PDFs. In either case, write down the choice in the commit message.

- [ ] **Step 1: Write the failing tests.**
  - `seriesCsv has a unit in every header and nulls as empty cells`
  - `seriesCsv converts to feet`
  - `chartPng inlines var() colours before drawing` (stub `getComputedStyle`; the serialised SVG has no `var(`)
  - `the dialog groups DXF choices and exports the picked one`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the export helpers and the dialog.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): chart PNG and CSV export, one export dialog`

### Task 12: Sections on the profile chart

Load `impeccable` and `frontend-design` first.

**Files:**

- Modify:
  - `apps/desktop/src/renderer/survey/SectionBody.tsx`
  - `apps/desktop/src/renderer/survey/SectionDock.tsx`
  - `apps/desktop/src/renderer/survey/SectionWindow.tsx`
  - `apps/desktop/src/renderer/survey/sectionStore.ts`
  - `apps/desktop/src/renderer/survey/section.css`
- Delete: `apps/desktop/src/renderer/survey/SectionChart.tsx`
- Test: `apps/desktop/src/renderer/survey/sectionStore.test.ts` (new), `SectionBody.test.tsx` (new)

**Interfaces:**

- Consumes: Task 7 (`ProfileChart`, `SurfaceChips`, `ShadeVs`) and Task 9 (`ExportFormatDialog`, `chartPng`, `seriesCsv`).
- Produces (`sectionStore.ts`):
  - `SECTION_COLOURS` and `colourOf` are removed.
  - `toggleSurface` becomes `toggleShown(key)`, and there are new `addSurface(ref)` and `removeSurface(key)`.
  - `shade: {from,to}|null` becomes `shadeVs: string|null`, whose "from" is always the current survey.
  - `sectionSeries(s: SectionState, manifest): ChartSeries[]` maps each `SectionProfile` to a kind:
    - the viewed capture is `current`
    - other captures are `earlier`
    - design layers are `design`
    - a pile's base is `base`
  - `FORMAT_LABELS` keeps its six formats but is only used by `ExportFormatDialog`.
  - The toolbar shows PNG, DXF…, CSV and Add to report. "DXF…" opens the dialog on the five DXF variants.

- [ ] **Step 1: Write the failing tests.** In `sectionStore.test.ts`:
  - `series kinds come from the surface, not the order`
  - `removing the shade target clears shadeVs`
  - `the current survey is shown by default`

  In `SectionBody.test.tsx`:
  - `toolbar has PNG, DXF, CSV and Add to report only`
  - `DXF opens the dialog with five variants`
  - `exaggeration slider still 1 to 20`

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Rewire `SectionBody` onto `ProfileChart`.**
  - Pin tables stay. Their deltas go through `formatQuantity`, and the "reference" becomes the shade target.
  - Delete `SectionChart.tsx`, and remove `.sec-cut`/`.sec-fill` from `section.css`.
  - Wire "Add to report" through `addToReport` (Task 22) when it is available. Until then, render it disabled with a reason (see the DAG note).
- [ ] **Step 4: Run the tests and see them pass**, and run `pnpm vitest run apps/desktop/src/renderer/survey/sectionEngine.test.ts`.
- [ ] **Step 5: Commit.** `feat(desktop): cross-sections on the shared profile chart`

---

## W3 and W4 data: stored series, conversion on load

### Task 10: Per-date runs and spread in the engine worker and compare store

**Files:**

- Modify:
  - `apps/desktop/src/renderer/survey/engineProtocol.ts`
  - `apps/desktop/src/renderer/survey/engineServe.ts`
  - `apps/desktop/src/renderer/survey/engineClient.ts`
  - `apps/desktop/src/renderer/survey/compareStore.ts`
- Test: `engineServe.test.ts`, `engineClient.test.ts`, `compareStore.test.ts`

**Interfaces:**

- Consumes: Task 5 (`compareSeries`, `seriesApplies`, `baseSpread`), `projectResolver`.
- Produces:

```ts
// engineProtocol.ts: EngineRequest += { kind: 'series'; id; req: SeriesRequest } | { kind: 'spread'; id; req: SpreadRequest }
export interface SeriesRequest {
  ring: Ring;
  item: ComparisonItem;
  captures: string[];
}
export interface SpreadRequest {
  ring: Ring;
  item: ComparisonItem;
  capture?: string;
}
// engineClient.ts: EngineClient += series(req): Promise<ComparisonResult[]>; spread(req): Promise<BaseSpread | null>
// compareStore.ts
export function computeSeries(id: string, opts?: { captures?: string[] }): Promise<void>; // only dates missing or stale; stores via setSeries
export function seriesStale(m: SurveyMeasurement, r: ComparisonResult): boolean; // fingerprint check per date
export function useSpread(id: string): BaseSpread | null | 'computing'; // memoised per item fingerprint, not stored
```

**Rules:**

- Results are computed on demand: when the card's chart, the volumes view or the report asks for them.
- They are stored per date in `m.series`, replacing the entry for the same item and capture. They go through a new `measureStore.setSeries(id, results)`, which, like `setComputedResults`, does not mark the file unsaved. That function lives in Task 11's file; see the DAG.
- A carried result is never stale. `isStale` returns false when `r.carried` is set.
- In read-only packages nothing is computed (KNOWN-LIMITS :317 stays true).

- [ ] **Step 1: Write the failing tests.**
  - `serve answers a series request with one result per capture`
  - `computeSeries computes only missing and stale dates`
  - `a carried result is not stale`
  - `read-only: computeSeries does nothing`
  - `spread is memoised per fingerprint`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the requests and store functions.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): per-date volume runs and base spread in the engine worker`

### Task 11: Conversion on load, recompute with history, one live reading

**Files:**

- Modify: `apps/desktop/src/renderer/survey/measureStore.ts`. Change `loadMeasurements`, `liveReading` (:774), and add `setSeries`, `recomputeStandard` and `convertAfterJob`.
- Modify: the volumetric job-complete hook. Find it with `grep -n "volumetric.build" apps/desktop/src/renderer`. It calls `convertAfterJob`.
- Test: `apps/desktop/src/renderer/survey/measureStore.kit.test.ts` (new), `measureStore.test.ts`

**Interfaces:**

- Consumes: Task 6 (`convertKitPiles`), Task 4 (`primaryRow`), IPC `project:readVolumes` (`{ volumes, edits }`).
- Produces:

```ts
export function setSeries(id: string, results: readonly ComparisonResult[]): void;
export function recomputeStandard(id: string): Promise<void>;
// Runs compareItem with { kind: 'smart' }, moves the carried results[0] into previousResults
// ({ netM3, totalM3, label: 'kit <base>', replacedAt }), drops carried series entries, and marks the file unsaved.
export function convertAfterJob(projectId: string): Promise<void>; // carry: false
export function liveReading(
  s: Pick<MeasureState, 'tool' | 'draw' | 'settings' | 'surface'>,
): string | null; // now primaryRow-based
```

**When the conversion runs:**

- On load, `loadMeasurements` reads volumes. If the project has a `VolumesFile`, it runs `convertKitPiles` with `carry = file.kitPilesConverted === undefined`.
  - A writable project gets the added measurements and `kitPilesConverted`, saved through the existing save path. The person sees no unsaved mark, because this is a conversion, not an edit.
  - A read-only project or package keeps them in memory only.
- After a volumetric build job, `convertAfterJob` runs with `carry: false`, then `computeSeries` for the new measurements (an engine figure, so nothing old is silently replaced).

- [ ] **Step 1: Write the failing tests.**
  - `an old project converts with carried figures and saves once`
  - `a read-only project converts in memory and writes nothing` (the `survey:writeMeasurements` mock is not called)
  - `reopening converts nothing new`
  - `recomputeStandard replaces the figure and keeps was`
  - `after a volumetric job new piles have no carried figure`
  - `liveReading shows the primary row` (distance shows the slope length row as today)
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run apps/desktop/src/renderer/survey/measureStore`
- [ ] **Step 3: Implement the conversion and the new store functions.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): old stockpiles open as volume measurements with their figures`

---

## W2: One measurement family

### Task 13: The shared card

Load `impeccable` and `frontend-design` first.

**Files:**

- Create:
  - `apps/desktop/src/renderer/survey/card/MeasureCard.tsx`
  - `apps/desktop/src/renderer/survey/card/cardModel.ts`
  - `apps/desktop/src/renderer/survey/card/CardActions.tsx`
  - `apps/desktop/src/renderer/survey/card/card.css`
  - `apps/desktop/src/renderer/survey/card/index.ts`
- Test: `card/cardModel.test.ts`, `card/MeasureCard.test.tsx`

**Interfaces:**

- Consumes: Task 4 (`primaryRow`, `secondaryRows`, `formatRow` with angles), Task 7 (`SurfaceChips`), `MEASURE_COLOURS` (`measureActions.tsx:38`), `TOOL_LABELS`, `effectiveUnits`.
- Produces:

```ts
export const TOOL_ICON: Record<MeasurementTool, IconName>; // one per tool; MeasureBench's FAMILY_ICON/TOOL_ICON (:139-149) move here
export interface CardModel {
  icon: IconName;
  name: string;
  tool: string;
  scope: { label: string; capture?: string } | null;
  colour: string;
  primary: { label: string; text: string } | null;
  secondary: string;
  more: { label: string; text: string }[];
}
export function cardModel(
  m: SurveyMeasurement,
  ctx: {
    settings: SurveySettings;
    templates: readonly SurveyTemplate[];
    captures: readonly { id: string; label: string }[];
    surface?: PointSampler;
  },
): CardModel;
export type CardVariant = 'live' | 'detail' | 'report';
export interface CardSlots {
  chips?: ReactNode;
  chart?: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
}
export function MeasureCard(p: {
  model: CardModel;
  variant: CardVariant;
  slots?: CardSlots;
  onRename?(name: string): void;
  actions?: ReactNode;
  testId?: string;
}): ReactElement;
export function CardActions(p: { id: string; hasChart: boolean }): ReactElement; // overflow Menu from actionsFor({kind:'measurements'}) + Export + Add to report
```

**The card's parts, in order:**

1. Header: icon, editable name (`card-name`, max 200), scope chip, colour swatch, and the overflow menu.
2. The primary value (`card-primary`): one large number in `--t-20` and `--f-mono`.
3. The secondary line (`card-secondary`), joined with " · ". "More" (`card-more`) unfolds the full readout table.
4. The chips slot.
5. The chart slot.
6. The detail slot.
7. The actions.

**What each variant shows:**

- `live`: only parts 1 to 3.
- `detail`: every part.
- `report`: header without controls, primary, secondary and chart. It renders without a store, so it is safe in `renderToStaticMarkup`.

**Card actions:** they come from the registry, so the overflow menu has exactly the right-click actions (rename, colour, hide, fly to, move, delete) plus Export and Add to report (Task 22). Before Task 22 lands, the menu simply lacks the latter two.

- [ ] **Step 1: Write the failing tests.** In `cardModel.test.ts`:
  - `every tool has an icon`
  - `distance model has primary slope and secondary horizontal, height, grade`
  - `volume primary is net in the site volume unit`
  - `telecom angles follow the angle setting`
  - `scope chip shows the survey label for survey-scoped measurements`

  In `MeasureCard.test.tsx`:
  - `live variant shows header, primary, secondary only`
  - `report variant renders to static markup with no buttons`
  - `More unfolds the full readout`
  - `rename commits on Enter and caps at 200`

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the card.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): the shared measurement card`

### Task 14: Volume card detail: plain bases, from/to chips, spread, carried figure, over time

Load `impeccable` and `frontend-design` first.

**Files:**

- Create: `apps/desktop/src/renderer/survey/card/VolumeDetail.tsx`, `card/BasePicker.tsx`, `card/VolumeDetail.test.tsx`, `card/BasePicker.test.tsx`
- Modify: `apps/desktop/src/renderer/survey/Comparison.tsx`. It shrinks to a thin wrapper that mounts `VolumeDetail` for each item, or it is deleted if nothing else imports it. Move `compareHelpers` uses accordingly.
- Modify: `apps/desktop/src/renderer/survey/compare.css`
- Keep: `BaseEditor.tsx` (the custom base vertices), mounted from `BasePicker` when Custom is picked.

**Interfaces:**

- Consumes: Task 10 (`computeSeries`, `useSpread`, `seriesStale`), Task 11 (`recomputeStandard`), Task 3 (`volumeRows`), Task 8 (`TimeChart`), Task 7 (`SurfaceChips` for from/to), `sideOptions`/`sideFor` (`calc/pickers.ts:98,204`).
- Produces:

```ts
export function BasePicker(p: {
  value: BaseSpec | SurfaceRef;
  onChange(v: BaseSpec | SurfaceRef): void;
  surfaces: readonly SideOption[];
  readOnly: boolean;
}): ReactElement;
// one Row per base with name + one-line hint (Task 2 strings); Previous survey or design opens the surface list
export function VolumeDetail(p: { m: SurveyMeasurement }): ReactElement; // chips (from/to), BasePicker, status line, spread hint, carried note, TimeChart + table
export function volumeStatusLine(
  r: ComparisonResult | undefined,
  state: { computing: boolean; live: boolean; stale: boolean },
): { tone: 'ok' | 'warn' | 'muted'; text: string };
```

**Plain words:**

- "deadband" becomes "Ignore changes smaller than".
- "Not covered" becomes "No survey data".
- "Exact (triangulated)" becomes "High precision". The grid case reads "Grid {cell}".
- The `survey-compute-ms` timer (`Comparison.tsx:197-200`) is removed.
- The five per-result notices (:555-583) and the section notices (:111, :130, :347, :352) become one `volumeStatusLine`, with `data-testid="survey-cmp-status"` kept.
- An empty state ("No survey surface is prepared yet") uses `EmptyState` with the Prepare surfaces action.

**What the card shows:**

- When a result is carried, the status line reads "From an earlier version (kit tin)".
- When surfaces exist and the project is writable, a `Button` reads "Recompute with the standard base". After recompute, the card shows "was {value}" from `previousResults[0]`.
- The spread hint is "±{pct} across bases", shown only for base items.
- The over-time table has columns Date, Volume, Change and Tonnage (tonnage only when a material density applies). The latest row is highlighted.

- [ ] **Step 1: Write the failing tests.**
  - `base picker lists six bases with their one-line hints, Triangulated toe first`
  - `new volume defaults to Triangulated toe`
  - `carried result shows the kit note and the recompute button only with surfaces`
  - `after recompute the card shows was`
  - `one status line, no ms timer`
  - `no jargon`: render the detail and assert that the text contains none of `deadband`, `Not covered`, `Exact (triangulated)`, `TIN`, ` ms`
  - `over-time table shows change and tonnage`
  - `spread hint formats ±1.8 % across bases`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the picker and the detail.**
- [ ] **Step 4: Run the tests, plus `compareHelpers.test.ts` and `compareStore.test.ts`, and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): volume card in plain words with bases, spread and volume over time`

### Task 15: Every measurement on the card

Load `impeccable` and `frontend-design` first.

**Files:**

- Modify:
  - `apps/desktop/src/renderer/survey/MeasurementPanel.tsx` (becomes `MeasureCard variant="detail"` with the tool's slots)
  - `apps/desktop/src/renderer/survey/TelecomTools.tsx` (its card becomes `MeasureCard`; guidance and the picks go in the detail slot)
  - `apps/desktop/src/renderer/workspace/workbench/benches/MeasureBench.tsx`: `LiveCard` and `SelectedCard` (:804); the icons move to `TOOL_ICON`. Also the formatting at :227 (`coord`), :285 (locked bearing) and :311 (typed bearing), which moves to `formatQuantity` and `formatBearingAs`.
  - `apps/desktop/src/renderer/survey/Qa.tsx`: the `history` panel is removed (:111)
  - `apps/desktop/src/renderer/survey/measure.css`
- Delete: `apps/desktop/src/renderer/survey/ElevationHistory.tsx`. Its `heightAt` moves to `card/pointHistory.ts`.
- Create: `apps/desktop/src/renderer/survey/card/slots.tsx`, which maps each tool to its chips, chart and detail per the spec table:
  - lines (distance, grade, vertex-table, berm-check, section): `ProfileChart` over the line's terrain per chosen surface
  - points (elevation, elevation-difference, annotation, elevation-history): `TimeChart` `elevation`, via `heightAt` per capture
  - volume: `VolumeDetail`
  - area: chips for terrain area per date, and no chart
  - azimuth, antenna-tilt, clearance and freehand: no chips and no chart
- Create: `apps/desktop/src/renderer/survey/card/pointHistory.ts`
- Test: `MeasurementPanel.test.tsx` (update), `TelecomTools.test.tsx` (update), `card/slots.test.tsx` (new), `card/pointHistory.test.ts` (new; carries the old `heightAt` tests), `MeasureBench.test.tsx` (update)

**Interfaces:**

- Consumes: Tasks 7, 8, 13, 14; `lineMetrics`, `vertexTable`, `bermCheck`, `polygonAreas` from `tools/measure.ts`.
- Produces:
  - `slotsFor(m: SurveyMeasurement, variant: CardVariant): CardSlots`
  - `heightAt(s: HeightTiles, e: number, n: number, fetchTile): Promise<number | null>`, unchanged and moved.

**Rules:**

- The "elevation-history" tool keeps working: it opens the point card with the elevation-over-time chart.
- The vertex table's bearings use `formatBearingAs`, and its coordinates use `formatQuantity` (no `toFixed(3)`).
- The style fields stay in the detail slot under "Style and label".

- [ ] **Step 1: Write the failing tests.**
  - `each tool gets the chart from the spec table` (a loop over tools, asserting the slot kind)
  - `point card shows elevation over time and Survey QA has no history panel`
  - `telecom card is the shared card with angles in the site angle unit`
  - `live card in the bench is the live variant`
  - `vertex table uses the formatter` (imperial gives ft)
  - `no toFixed in MeasureBench readouts`: a source scan in the test greps `MeasureBench.tsx` for `toFixed(`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Move every measurement onto the card.**
- [ ] **Step 4: Run the tests and see them pass**, and run `pnpm vitest run apps/desktop/src/renderer/survey apps/desktop/src/renderer/workspace/workbench`.
- [ ] **Step 5: Commit.** `feat(desktop): every measurement on the shared card; elevation history leaves Survey QA`

### Task 16: Stored style drawn, labels and tree value from one picker, one palette

**Files:**

- Modify:
  - `apps/desktop/src/renderer/survey/measureScene.ts`:
    - `Shape` (:73) gains `fill`, `fillOpacity` and `borderWidth`.
    - The 3D `addLine` (:293) and the map layers (:778-806) use them. On the map the fill uses `fill ?? color` with `fillOpacity ?? 0.18`, and the line width is `borderWidth ?? 2`. In 3D, polygons get a translucent fill mesh and lines a fat line when the border is wider than 1.
    - `labelOf` (:149) uses `primaryRow` through `formatRow`. Map labels show the name and the primary value.
  - `apps/desktop/src/renderer/survey/measureRows.ts`: `measureRowValue` (:27) becomes `primaryRow` plus `formatRow`, with `effectiveUnits` and the site angles.
  - `apps/desktop/src/renderer/shell/actions/measureActions.tsx`: export `MEASURE_COLOURS` as the one palette. The panel colour picker (Task 15's detail slot) imports it, and no other palette remains. Check with `grep -n "#ffd166" apps/desktop/src/renderer` after the change.
- Test: `measureScene.test.ts`, `measureRows.test.ts`, `shell/actions/measureActions.test.ts`

**Interfaces:**

- Consumes: Task 4 (`primaryRow`, angle-aware `formatRow`).
- Produces: `shapesOf(...)`, unchanged in signature but carrying the style fields; `labelText(m, settings, templates): string`, exported for the tests.

- [ ] **Step 1: Write the failing tests.**
  - `map fill uses stored fill and opacity`
  - `map line width uses borderWidth`
  - `3D polygon gets a fill mesh at the stored opacity`
  - `label is name and primary value`
  - `tree value and label value are the same string for every tool`
  - `the panel picker and the menu share MEASURE_COLOURS`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the drawing, labels and palette changes.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): draw stored measurement styles; one value picker and one palette`

### Task 17: Angle settings and the 3D cursor through the formatter

**Files:**

- Modify:
  - `apps/desktop/src/renderer/survey/SiteSettings.tsx`: add an "Angles" group to the units settings (angle style, bearing style, decimals) that writes `settings.angles`. `siteCursorText` (:206) takes the precision and the units.
  - `apps/desktop/src/renderer/workspace/SceneCursor.tsx` (:84): the fallback without site settings uses `formatQuantity` with metric defaults (`defaultSurveySettings()`) instead of `` `EL ${el.toFixed(1)} m` ``.
- Test: `SiteSettings.test.tsx` (create or extend), `SceneCursor.test.tsx` (create)

- [ ] **Step 1: Write the failing tests.**
  - `angles group saves dms bearings`
  - `cursor without site settings formats through formatQuantity`
  - `cursor follows feet`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Add the angles group and fix the cursor.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): angle units in site settings; cursor through the formatter`

### Task 18: Road map measure on the survey tools

**Files:**

- Modify:
  - `apps/desktop/src/renderer/road/useRoadMap.ts`: `measureText` (:124) is replaced by `roadReading(mode, vertices, settings)`, which uses `lineMetrics` and `polygonAreas` from `@aio/survey` on local coordinates and `formatRow` through `primaryRow`.
  - `apps/desktop/src/renderer/road/RoadTools.tsx` (:186): a live `MeasureCard variant="live"`, plus "Save" when the project has surveys (`manifest.captures.length > 0` and the project is writable). Save adds a `distance` or `area` measurement through `measureStore.addMeasurement`, scoped to the site.
  - `apps/desktop/src/renderer/island/useIslandLive.ts` (:190): uses `roadReading`.
  - `apps/desktop/src/renderer/workspace/workbench/benches/RoadBench.tsx`
- Test: `road/roadReading.test.ts` (new), `road/RoadTools.test.tsx` (create or extend)

**Interfaces:**

- Consumes: Tasks 4 and 13.
- Produces: `roadReading(mode: 'distance' | 'area', vertices: readonly LngLat[], settings: SurveySettings, toLocal: (p: LngLat) => XY): { primary: string; secondary: string } | null`

- [ ] **Step 1: Write the failing tests.**
  - `road distance matches lineMetrics horizontal for the same points`
  - `road area in acres with imperial settings`
  - `save appears only in a writable project with surveys`
  - `saved road measurement is a site-scoped distance`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Rebuild the road measure on the survey tools.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): road map measure on the survey tools and card`

### Task 19: Globe measure on the formatter; engine measure tool deleted

**Files:**

- Modify:
  - `packages/globe/src/measure.ts`: `formatLength` (:97) and `formatArea` (:102) are replaced by `globeReading(points, units, precision): { primary: string; secondary: string }`, which uses `formatQuantity` from `@aio/geo` (an allowed dependency). The geodesic maths stays.
  - `apps/desktop/src/renderer/globe/GlobeScreen.tsx` (:477-479): renders `MeasureCard variant="live"` with the header, value and secondary line only. There are no chips, no chart and no save.
- Delete:
  - the `'measure'` tool from `packages/engine/src/stage/Stage.ts`: the `MeasureTool` field (:190), the clear in `setTool` (:576), `clearMeasure` (:635), the click handling (:1680-1684) and the clear (:1729)
  - `packages/engine/src/tools/measure.ts`
  - the overlay's `setMeasure` if nothing else calls it
  - `formatMetres` (`overlay/declutter.ts:206`) only if nothing else uses it
  - Remove `'measure'` from the engine's tool union and its tests.
- Test: `packages/globe/src/measure.test.ts`, `packages/engine/src/stage/*.test.ts` (updated), `GlobeScreen` tests where present

- [ ] **Step 1: Write the failing tests.**
  - `globe length in feet with imperial units`
  - `globe area uses the area unit`
  - `the engine has no measure tool`: `Stage` `setTool('measure')` is a type error, and a runtime check asserts the tool list lacks it
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the globe reading and delete the engine tool.** Run `pnpm typecheck` to catch every caller.
- [ ] **Step 4: Run `pnpm vitest run packages/globe packages/engine` and see it pass.**
- [ ] **Step 5: Commit.** `refactor: globe measure through the formatter, engine measure tool removed`

---

## W3 and W4 views

### Task 20: Volumes view and inventory over time

Load `impeccable` and `frontend-design` first.

**Files:**

- Create: `apps/desktop/src/renderer/survey/VolumesView.tsx`, `VolumesView.test.tsx`
- Modify:
  - `apps/desktop/src/renderer/survey/BulkTotals.tsx`
  - `apps/desktop/src/renderer/workspace/workbench/benches/VolumesBench.tsx` (mounts `VolumesView` instead of `VolumesPanel`)
  - `packages/survey/src/calc/bulk.ts`
- Test: `packages/survey/src/calc/bulk.test.ts`

**Interfaces:**

- Consumes: Tasks 3 (`stackRows`, `volumeRows`), 8, 10, 13, 14.
- Produces:
  - `inventorySeries(ms: readonly SurveyMeasurement[], captures, opts): StackRow[]` in `calc/bulk.ts`. It covers the volume measurements in a folder, or all of them.
  - `VolumesView()`:
    - a folder filter (All piles, or a folder from `measureFolders`)
    - the volume cards in the `live` variant as rows; clicking one focuses it in the detail card
    - `BulkTotals` (current totals from engine results, unchanged maths)
    - "Site inventory over time" as a stacked `TimeChart` with its table
    - `EmptyState` when there are no volume measurements: "No stockpiles yet", with the Draw volume and Detect piles actions

- [ ] **Step 1: Write the failing tests.**
  - `inventory totals count missing piles per date`
  - `inventory sums engine results, never kit figures, unless carried` (a carried result counts with its carried value, because it is the pile's one figure)
  - `folder filter narrows the stack`
  - `empty state when no volumes`
  - `totals match the sum of the cards`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Build the view and the inventory series.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): volumes view with site inventory over time`

### Task 21: Volume over time in CSV, inventory from the engine

**Files:**

- Modify: `packages/project/src/export/surveyCsv.ts`:
  - Add `volumeSeriesCsv`.
  - `stockpileInventory` (:290) becomes `stockpileInventoryFromMeasurements`, which reads the latest two dates from `m.series` rather than kit epochs. The old function is removed once Task 25 drops its last caller.
  - `stockpileCsv` (:575) reads measurements.
- Test: `packages/project/src/export/surveyCsv.test.ts`

**Interfaces:**

- Consumes: `SurveyMeasurement.series` (Task 1). `@aio/project` may depend only on schema and geo, so it does not use `volumeRows` from `@aio/survey`. It reimplements the small row logic, and a test pins it to the same answers as Task 3's fixture.
- Produces:

```ts
export function volumeSeriesCsv(
  ms: readonly SurveyMeasurement[],
  captures: readonly { id: string; date: string; label: string }[],
  units: SurveyUnits,
  precision: SurveyPrecision,
  opts?: { densityOf?(m: SurveyMeasurement): number | null },
): string;
// header: Measurement,Folder,Date,Survey,Volume (<unit>),Change (<unit>),Tonnage (<unit>),Status,From an earlier version
export function stockpileInventoryFromMeasurements(
  ms: readonly SurveyMeasurement[],
  captures,
): StockpileInventory;
```

- [ ] **Step 1: Write the failing tests.**
  - `one row per measurement and date`
  - `series CSV in the display units`
  - `a refused date has an empty volume and its status`
  - `carried rows say yes in the last column`
  - `inventory from measurements matches the card totals`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the CSV and inventory functions.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(project): volume over time CSV and inventory from measurements`

### Task 22: Report template IPC, Add to report and Export actions

**Files:**

- Create: `apps/desktop/src/main/reportTemplate.ts`, `apps/desktop/src/main/reportTemplate.test.ts`
- Modify: the main IPC registration where `project:readVolumes` is handled (`apps/desktop/src/main/boundaries.ts` sits next to it; register the two new channels in the same router file)
- Create: `apps/desktop/src/renderer/report/templateStore.ts`, `templateStore.test.ts`
- Create: `apps/desktop/src/renderer/shell/actions/reportActions.tsx`, `reportActions.test.ts`
- Modify: `apps/desktop/src/renderer/shell/actions/index.ts` (`registerSidebarActions` calls `registerReportActions`), `shell/actions/parity.test.ts`
- Create: `apps/desktop/src/renderer/survey/card/exportMeasurement.ts`, `exportMeasurement.test.ts`

**Interfaces:**

- Consumes: Task 1 (`ReportTemplateFile`, `TemplateEntry`, the IPC), Task 9 (`chartPng`, `savePng`, `seriesCsv`), `measurementsCsv` (`surveyCsv.ts:491`), the `survey.export` pipeline (Python `SurveyExport`, `export.py:1205`) for DXF with a single measurement id. Read its params in `jobs.ts`; if it cannot filter to one id, export DXF only for line measurements, through `survey.section`, and note it in KNOWN-LIMITS.
- Produces:

```ts
// main
export function readTemplate(root: string): Promise<ReportTemplateFile | null>;
export function writeTemplate(root: string, file: ReportTemplateFile): Promise<void>; // atomic, .bak like writeBoundaries
// renderer
export function addToReport(
  id: string,
  parts?: TemplateEntry['parts'],
): Promise<'added' | 'already'>;
export function useTemplate(): ReportTemplateFile | null;
export function registerReportActions(): () => void; // 'measure.addToReport' (section 'share', multi), 'measure.export' (submenu CSV / DXF / PNG when hasChart)
export function exportMeasurement(
  id: string,
  format: 'csv' | 'dxf' | 'png',
): Promise<string | null>;
```

**Rules:**

- The default parts are `['value', 'chart']` when the tool has a chart, otherwise `['value']`.
- Adding the same measurement twice gives "Already in the report" through `announce`.
- In read-only packages both actions are disabled with the `measureEditBlocked` reason. Export stays enabled.

- [ ] **Step 1: Write the failing tests.**
  - `read returns null when no template`
  - `write is atomic and keeps a .bak`
  - `add to report appends once`
  - `already in the report on the second add`
  - `actions appear in the measurement menu and the card overflow` (parity test)
  - `export csv writes one measurement`
  - `png export only when the tool has a chart`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the IPC, store, actions and export.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): report template, Add to report and Export measurement`

### Task 23: Retire the kit's volumes UI and base computation

**Files:**

- Delete:
  - `packages/volumetric/src/components/VolumesPanel.tsx`
  - `packages/volumetric/src/components/ProfileChart.tsx`
  - `packages/volumetric/src/components/format.ts` and `format.test.ts` (callers move to `formatQuantity`)
  - the kit register UI parts of `packages/volumetric/src/model/register.ts`: `registerRows`, `sortRows`, `totals`, `registerCsv` (`applyEdits` already moved in Task 6)
  - the base computation in `model/volume.ts`: `gridBase`, `pileVolume`, `pileVolumes`, `pileChange`, `BASE_IDS`. Keep `pileEngineSurface` if `VolumetricStage` still needs a surface.
  - `model/compute.ts`: `engineBases`, `ENGINE_BASES` (replaced by Task 5's `baseSpread`)
- Modify:
  - `packages/volumetric/src/components/VolumetricStage.tsx`: the drawn-line section (:343) uses `ProfileChart` from the desktop. Move the drawn-line section into `apps/desktop/src/renderer/workspace/VolumeSection.tsx` (new) to keep the package boundary, and remove the legend swatches at :625/:629.
  - `packages/volumetric/src/components/styles.tsx`: drop the cut/fill colours and use `var(--cut)`/`var(--fill)`.
  - `packages/volumetric/src/store.ts`: drop the base and register state, and the `change` mode's first/last epoch (:593).
  - `packages/volumetric/src/index.ts`
- Modify:
  - `apps/desktop/src/renderer/workspace/VolumeTools.tsx` (:9, :34, :37, :51, :75): "Cut / fill" uses the from/to picks (`SurfaceChips` single-select pair, defaulting to the previous and the current survey) and runs the engine `WholeSite` comparison.
  - `workspace/Stage.tsx` (:142), `workspace/CompareScene.tsx` (:218), `App.tsx` (:497-499; volumes still load for detection outlines only)
  - `workbench/RightSidebar.tsx` (:227)
- Modify: `docs/KNOWN-LIMITS.md` :312 (the kit-versus-engine limit is resolved; reword it to the carried-figure behaviour) and :317.
- Test: `packages/volumetric/src/store.test.ts` (updated), `workspace/VolumeTools.test.tsx` (create)

- [ ] **Step 1: Write the failing tests.**
  - `cut/fill compares the picked surveys, not first and last`
  - `default pick is previous to current`
  - `the volumetric package exports no base computation`: an import of `pileVolume` fails `tsc`, and the runtime check is `expect(Object.keys(await import('@aio/volumetric'))).not.toContain('pileVolume')`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Delete the kit parts and rewire the callers**, then run `pnpm typecheck`.
- [ ] **Step 4: Run `pnpm vitest run packages/volumetric apps/desktop/src/renderer/workspace` and see it pass.**
- [ ] **Step 5: Commit.** `refactor: retire the stockpile kit's bases and volumes UI; volume tools pick from/to`

### Task 24: Plain words, heat map legend and empty states in the other survey views

Load `impeccable` and `frontend-design` first.

**Files:**

- Modify:
  - `apps/desktop/src/renderer/survey/Cleanup.tsx` (:225-226, :256-257): "Fill gaps: straight" and "Fill gaps: smooth"; the method values `'tin'|'thin-plate'` stay internally
  - `apps/desktop/src/renderer/survey/HeatmapStops.tsx`: `HeatLegend` (:15) becomes a colour bar with values and units plus a small histogram of the shown grid's height changes. The stop editor (`HeatmapStops`, :79) opens from an "Edit colours" action.
  - `apps/desktop/src/renderer/survey/heatScene.ts`: exposes `heatHistogram(grid, stops, bins = 24): number[]`
  - `apps/desktop/src/renderer/survey/WholeSite.tsx`
  - every other ad hoc empty state in `apps/desktop/src/renderer/survey/*.tsx` that no other task owns (`Designs.tsx`, `Overlays.tsx`, `Hydro.tsx`, `HaulRoad.tsx`, `Materials.tsx`, `Compliance.tsx`): find them with `grep -n "sv-empty\|No .* yet" apps/desktop/src/renderer/survey/*.tsx` and replace each with `EmptyState`
- Test: `heatScene.test.ts` (create or extend), `HeatmapStops.test.tsx` (new), `Cleanup.test.tsx` (new)

- [ ] **Step 1: Write the failing tests.**
  - `legend shows values in the display unit`
  - `histogram bins sum to the cell count`
  - `stops editor opens from Edit colours`
  - `cleanup says Fill gaps, never TIN or Thin-plate`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the wording, legend and empty states.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit.** `feat(desktop): plain words, heat map legend with histogram, empty states`

### Task 25: The report on the shared chart and card; the assistant reads engine results

**Files:**

- Modify: `apps/desktop/src/renderer/reportPage/house/survey.ts`:
  - `sectionChart()` (:195) and `PROFILE_COLOURS` (:192) are deleted.
  - `layoutEarthworks` (:487) renders `renderToStaticMarkup(<ProfileChart width={688} height={200} interactive={false} …/>)`.
  - `layoutStockpiles` (:348) reads the volume measurements, not `volumes.json`.
  - `layoutMeasurements` (:246) renders the template's measurement entries with `MeasureCard variant="report"` and their chart.
  - New `layoutVolumeOverTime`: one `TimeChart` and table per measurement in the template, or per stockpile when the template is empty, plus the stacked site inventory.
- Modify:
  - `reportPage/house/surveyData.ts`: `readSurveyFiles` (:125) also reads `REPORT_TEMPLATE_FILE`; `surveySectionIds` (:250) adds `volume-over-time` when any volume measurement has two or more dated results; `buildSurveyData` (:403) builds `ChartSeries` with kinds for sections (:598-625).
  - `reportPage/house/sections.ts`: `SECTION_LAYOUTS` (:1012) gains `'volume-over-time'`.
  - `reportPage/house/main.ts`: stop reading `volumes.json` (:164, :288), and run the kit conversion in memory (`convertKitPiles` with `carry` as in Task 11) so an old project prints its old figures.
  - `reportPage/house/house.css`: `svg.svsec` (:876) goes; add chart print styles using the token values resolved for print.
  - `packages/ai/src/analysis-tools.ts`: `compare_captures` (:181) reads `measurements.json` volume measurements' `series` (and converts kit piles with `carry: true` when it is absent), instead of `volumes.json` `epochs[e].volumes[base].net` (:115-207). It returns one figure per pile per date.
- Test: `reportPage/house/survey.test.ts` (replace the :604 `sectionChart` test), `surveyData.test.ts`, `packages/ai/src/analysis-tools.test.ts`

**Interfaces:**

- Consumes: Tasks 6, 7, 8, 13, 15 (`slotsFor(m, 'report')`), 21, 22 (template).

- [ ] **Step 1: Write the failing tests.**
  - `earthworks section draws the shared chart with design dashed`
  - `stockpile section shows the same figure as the card` (an engine result fixture)
  - `old project report prints the carried kit figure, labelled`
  - `template entries print as report cards in template order`
  - `volume over time section lists change since previous`
  - `assistant compare_captures returns engine figures, the same as the card`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Move the report and the assistant onto engine results and the shared components.**
- [ ] **Step 4: Run `pnpm vitest run apps/desktop/src/renderer/reportPage packages/ai` and see it pass.**
- [ ] **Step 5: Commit.** `feat(report): shared chart and card in the report, volume over time section`

---

## End to end and hand-off

### Task 26: End to end

**Files:**

- Create:
  - `apps/desktop/e2e/profile-chart.spec.ts` (change demo, two dates plus the DXF design)
  - `apps/desktop/e2e/measure-card.spec.ts` (synthetic tiny project; seed `survey/measurements.json` and validate it with `MeasurementsFile.parse`)
  - `apps/desktop/e2e/volume-over-time.spec.ts` (change demo)
  - `apps/desktop/e2e/kit-migration.spec.ts` (a synthetic tiny project seeded with a fictional `volumes.json` and `edits/boundaries.json`, validated with `VolumesFile.parse`; no pipeline Python needed)
  - `apps/desktop/e2e/report-template.spec.ts`
- Modify: `sections.spec.ts`, `volumes-general.spec.ts`, `volumetric-build.spec.ts`, `stockpile-date.spec.ts`, `spot-history.spec.ts`, `measure-tools.spec.ts`, `telecom-measurements.spec.ts`, `measurement-layers.spec.ts`, `survey-reports.spec.ts`, `house-report.spec.ts`, `island.spec.ts`, `materials.spec.ts`, `templates.spec.ts`, `survey-gaps.spec.ts`, `survey-demo.spec.ts`, `road-builder.spec.ts`, `globe.spec.ts`, `packages-globe.spec.ts` and the `island.ts` helpers.
  - At the end, `grep -n "section-shade\|survey-compute-ms\|history-table\|vol-chart\|More bases" apps/desktop/e2e` is empty.
- Checked unchanged: `workbench.spec.ts`, `sidebar-menus.spec.ts`, `change-area.spec.ts`, `a11y.spec.ts`. The `@realdata` road map spec changes if it reads the road reading text; it runs locally only.

The new tests:

- **`profile-chart.spec.ts`:**
  - `add an earlier survey and the design as chips, shade vs design, hover shows both elevations and the difference`. Assert `chart-readout` contains both surface labels and "Difference", and the cut and fill areas show.
  - `turning a chip off removes its line; DXF opens one dialog with five variants`
- **`measure-card.spec.ts`:**
  - `distance card: primary, secondary line with Horizontal · Height · Grade, profile chart`
  - `point card shows elevation over time; Survey QA has no history tab`
  - `switching units to imperial changes the card, the tree value and the map label alike`
  - `stored fill opacity is drawn on the map` (read the MapLibre paint property through the test hook already used by `measurement-layers.spec.ts`)
- **`volume-over-time.spec.ts`:**
  - `a volume measurement shows a bar per survey date with the latest highlighted and the change in the table`
  - `the site inventory stacks two piles`
  - Check the expected values against the demo's `truth.json` within its tolerance.
- **`kit-migration.spec.ts`:**
  - `an old stockpile project opens with its kit figures labelled and no unsaved mark`
  - `reopening adds nothing; a deleted pile stays deleted`
  - `in a package the figures show and nothing is written`
- **`report-template.spec.ts`:**
  - `Add to report from the card overflow, then the house report PDF contains the card` (PDF text includes the measurement name and the primary value)
  - `adding twice says Already in the report`

- [ ] **Step 1: Build the demos.** Run `pnpm demo:change --quick` (CI runs `pnpm demo:build --quick`).
- [ ] **Step 2: Write the new specs and update the changed ones.**
- [ ] **Step 3: Run each new or changed spec the CI way, one at a time.** From `apps/desktop`, in PowerShell:

  ```powershell
  $env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
  npx playwright test e2e/<spec>.spec.ts --workers=1
  ```

  The run must print `[e2e] window 1100 x 720 px at display scale 1`. Run the five new specs with `--repeat-each=3`. Specs that need pipeline Python point `QUADRION_E2E_PYTHON` at the main checkout's venv. Ask the founder for a window before the long runs.

- [ ] **Step 4: Commit.** `test(e2e): profile chart, measurement card, volume over time, kit migration, report template`

### Task 27: ADR, pack bump, verification

**Files:**

- Create: `docs/architecture/adr/0013-one-volume-engine.md`, covering:
  - The survey engine is the only volume engine.
  - The default base is `smart`, shown as "Triangulated toe".
  - Kit piles are carried, and the conversion is idempotent through `kitPilesConverted`.
  - The per-date series rule: "current" walks the dates, and fixed sides stay fixed.
  - The base-spread formula.
  - Totals are TS-only sums.
  - The reserved `uncertainty` and `verticalAccuracy` fields for W6.
  - It supersedes ADR 0009 decision 5's "volumes.json and the old base names unchanged" for display.
- Modify: `python/pyproject.toml` `version = "0.18.1"`. `APP_RANGE` is unchanged. Run `python/tests/test_app_range.py` and `apps/desktop/src/main/jobs/packVersions.test.ts`.
- Modify: `docs/KNOWN-LIMITS.md`. Add a line saying the globe's measurements are temporary.

- [ ] **Step 1: Write the ADR and bump the pack version.**
- [ ] **Step 2: Run the retirement grep. Every result must be empty.**

  ```
  git grep -n "SectionChart\|SECTION_COLOURS\|PROFILE_COLOURS\|sectionChart(\|HistoryChart\|VolumesPanel\|CUT_CSS\|FILL_CSS\|measureText(\|formatLength(\|clearMeasure\|engineBases" -- apps packages
  ```

- [ ] **Step 3: Run `pnpm check`.** Expected: green.
- [ ] **Step 4: Run the Python suite.** From `python/`: `uv run --frozen pytest -vv -rfEs tests/test_survey_*.py tests/test_app_range.py`, then `ruff check .` and `ruff format --check .`.
- [ ] **Step 5: Run the contract check.** `git diff origin/main --stat -- packages/schema apps/desktop/src/main apps/desktop/src/preload` lists only the files named in Task 1 and Task 22.
- [ ] **Step 6: Run `node tools/agent/check-public-text.mjs`** on the new docs and fixtures.
- [ ] **Step 7: Commit.** `docs(adr): one volume engine; chore(pipelines): pack 0.18.1`

---

## Execution DAG

| Task | Depends on                             | Packages touched                                                             | Unit tests                                                                                                                       |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1    | none                                   | `@aio/schema`, `tools/compat`, docs                                          | `survey.test.ts`, `reportTemplate.test.ts`, `versions.test.ts`, `report-template.test.mjs`                                       |
| 2    | none                                   | `@aio/ui`                                                                    | `tokens.test.ts`, `i18n.test.ts`                                                                                                 |
| 3    | none                                   | `@aio/survey` (section, calc)                                                | `section/chart.test.ts`, `calc/timeline.test.ts`                                                                                 |
| 4    | 1                                      | `@aio/survey` (tools)                                                        | `tools/readout.test.ts`                                                                                                          |
| 5    | 1                                      | `@aio/survey` (engine), `python/` survey, fixtures                           | `engine/series.test.ts`, `engine/series.parity.test.ts`, `test_survey_series.py`                                                 |
| 6    | 1                                      | `@aio/survey` (calc), `@aio/volumetric` (register)                           | `calc/kitPiles.test.ts`, volumetric `store.test.ts`                                                                              |
| 7    | 2, 3                                   | `@aio/desktop` (charts)                                                      | `ProfileChart.test.tsx`, `SurfaceChips.test.tsx`                                                                                 |
| 8    | 2, 3, 7                                | `@aio/desktop` (charts)                                                      | `TimeChart.test.tsx`                                                                                                             |
| 9    | 3, 7                                   | `@aio/desktop` (charts)                                                      | `exportChart.test.ts`, `ExportFormatDialog.test.tsx`                                                                             |
| 10   | 5                                      | `@aio/desktop` (survey engine worker, compareStore)                          | `engineServe.test.ts`, `engineClient.test.ts`, `compareStore.test.ts`                                                            |
| 11   | 4, 6                                   | `@aio/desktop` (measureStore)                                                | `measureStore.kit.test.ts`, `measureStore.test.ts`                                                                               |
| 12   | 7, 9                                   | `@aio/desktop` (survey sections)                                             | `sectionStore.test.ts`, `SectionBody.test.tsx`, `sectionEngine.test.ts`                                                          |
| 13   | 2, 4, 7                                | `@aio/desktop` (survey/card)                                                 | `cardModel.test.ts`, `MeasureCard.test.tsx`                                                                                      |
| 14   | 8, 10, 11, 13                          | `@aio/desktop` (survey/card, Comparison)                                     | `VolumeDetail.test.tsx`, `BasePicker.test.tsx`, `compareStore.test.ts`                                                           |
| 15   | 8, 13, 14                              | `@aio/desktop` (survey, workbench)                                           | `slots.test.tsx`, `pointHistory.test.ts`, `MeasurementPanel.test.tsx`, `TelecomTools.test.tsx`, `MeasureBench.test.tsx`          |
| 16   | 4, 15                                  | `@aio/desktop` (survey scene, rows, actions)                                 | `measureScene.test.ts`, `measureRows.test.ts`, `measureActions.test.ts`                                                          |
| 17   | 1, 4                                   | `@aio/desktop` (SiteSettings, SceneCursor)                                   | `SiteSettings.test.tsx`, `SceneCursor.test.tsx`                                                                                  |
| 18   | 4, 13                                  | `@aio/desktop` (road, island, RoadBench)                                     | `roadReading.test.ts`, `RoadTools.test.tsx`                                                                                      |
| 19   | 13                                     | `@aio/globe`, `@aio/engine`, `@aio/desktop` (globe)                          | `globe/measure.test.ts`, engine stage tests                                                                                      |
| 20   | 3, 8, 10, 13, 14                       | `@aio/survey` (bulk), `@aio/desktop` (VolumesView, BulkTotals, VolumesBench) | `bulk.test.ts`, `VolumesView.test.tsx`                                                                                           |
| 21   | 1                                      | `@aio/project`                                                               | `surveyCsv.test.ts`                                                                                                              |
| 22   | 1, 9                                   | `@aio/desktop` (main, report store, shell/actions, card export)              | `reportTemplate.test.ts` (main), `templateStore.test.ts`, `reportActions.test.ts`, `parity.test.ts`, `exportMeasurement.test.ts` |
| 23   | 7, 20                                  | `@aio/volumetric`, `@aio/desktop` (workspace)                                | volumetric `store.test.ts`, `VolumeTools.test.tsx`                                                                               |
| 24   | 2                                      | `@aio/desktop` (survey views)                                                | `heatScene.test.ts`, `HeatmapStops.test.tsx`, `Cleanup.test.tsx`                                                                 |
| 25   | 6, 7, 8, 13, 15, 21, 22                | `@aio/desktop` (reportPage), `@aio/ai`                                       | `survey.test.ts`, `surveyData.test.ts`, `analysis-tools.test.ts`                                                                 |
| 26   | 12, 14, 15, 16, 18, 19, 20, 23, 24, 25 | `@aio/desktop` (e2e)                                                         | e2e listed in Task 26                                                                                                            |
| 27   | 26                                     | docs, `python/` (version)                                                    | `pnpm check`, Python suite, e2e                                                                                                  |

**Parallel batches.** Within a batch no two tasks share a file. Dispatch each batch in one message.

| Batch | Tasks                | Notes                                                                                                                                                                                                                                                                                                |
| ----- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | 1, 2, 3              |                                                                                                                                                                                                                                                                                                      |
| B     | 4, 5, 6, 7, 21, 24   | `@aio/survey` tasks touch separate folders: `tools/`, `engine/`, `calc/kitPiles` (+ `calc/index.ts`, which Task 3 already finished). Task 7 creates `charts/index.ts`.                                                                                                                               |
| C     | 8, 9, 10, 11, 13, 17 | Task 8 alone adds a line to `charts/index.ts`; Task 9 exports from its own files, imported by path. Task 11 owns `measureStore.ts` and adds `setSeries`; Task 10 calls it, so Task 10 commits after Task 11, or stubs the import until 11 lands.                                                     |
| D     | 12, 14, 18, 19, 22   | Task 12's "Add to report" button imports `addToReport` from Task 22; Task 12 lands it disabled, and Task 22's last step enables it in `SectionBody.tsx` after Task 12 commits. Tasks 14 and 22 add files under `survey/card/` but do not touch `card/index.ts`: their consumers import them by path. |
| E     | 15, 20               |                                                                                                                                                                                                                                                                                                      |
| F     | 16, 23, 25           |                                                                                                                                                                                                                                                                                                      |
| G     | 26                   |                                                                                                                                                                                                                                                                                                      |
| H     | 27                   |                                                                                                                                                                                                                                                                                                      |

Task 24 has no dependency beyond Task 2, so it can move to any later batch if Batch B is crowded.

**Critical path:** Task 1 → Task 5 → Task 10 → Task 14 → Task 15 → Task 16 → Task 26 → Task 27. The same length runs through Task 3 → 7 → 8 → 14 and Task 1 → 4 → 11 → 14.

**Suggested branches, if the founder prefers several merges to one.** These are Wave 1's "several branches", each landing after the one before:

1. `feat/vp-foundation`: Tasks 1 to 6, 21.
2. `feat/vp-chart`: Tasks 7, 8, 9, 12.
3. `feat/vp-card`: Tasks 10, 11, 13 to 19, 22, 24.
4. `feat/vp-volumes`: Tasks 20, 23, 25.
5. Tasks 26 and 27 run per branch for that branch's specs.

The spec's ordering holds: W3 (Tasks 10, 11, 14) lands with W2's volume card, and W1 (Task 7) lands before W2's charts. One branch with this whole plan is also fine.

**E2e specs:**

- Added: `profile-chart`, `measure-card`, `volume-over-time`, `kit-migration`, `report-template`.
- Changed: `sections`, `volumes-general`, `volumetric-build`, `stockpile-date`, `spot-history`, `measure-tools`, `telecom-measurements`, `measurement-layers`, `survey-reports`, `house-report`, `island`, `materials`, `templates`, `survey-gaps`, `survey-demo`, `road-builder`, `globe`, `packages-globe`, the `island.ts` helpers, and the `@realdata` road map spec (local only) if it reads the road reading.
- Run unchanged as a check: `workbench`, `sidebar-menus`, `change-area`, `a11y`.
- Run the CI way, from `apps/desktop`, after `pnpm demo:change --quick`:

  ```
  QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/<spec>.spec.ts --workers=1
  ```

**Contract changes.** All are additive; Task 1 writes the rows.

1. `aio.measurements/1` adds:
   - `SurveyMeasurement.origin`, `.series` and `.previousResults`
   - `MeasurementsFile.kitPilesConverted`
   - `ComparisonResult.carried` and `.uncertainty` (W6's ± and its source, reserved)
2. `aio.survey-settings/1` adds `angles`.
3. `aio.project/1` adds `Capture.verticalAccuracy` (W6's survey vertical accuracy, reserved).
4. The new file `report/template.json` (`aio.report-template/1`) and its IPC `report:readTemplate`/`report:writeTemplate`.
5. `ReportSectionId` adds `volume-over-time`, kept in `reportSectionsExtra`.

The pipeline pack goes to `0.18.1`, a patch adding the library module `survey/series.py` with no new pipeline or params. `APP_RANGE` is unchanged. `ENGINE_VERSION` is unchanged.

**Files shared with other sessions:** check `git log origin/main` for open branches that touch `MeasureBench.tsx`, `measureStore.ts`, `measureScene.ts`, `Comparison.tsx` or `reportPage/house/*` before each batch, and rebase early.

## Decisions this plan makes

- The chart and the card live in the desktop renderer (`renderer/charts/`, `renderer/survey/card/`), not in `@aio/ui`. That package may not depend on `@aio/survey` or `@aio/geo`. Their pure models live in `@aio/survey`.
- The report renders the same React components with `renderToStaticMarkup`. Token colours are resolved for print in `house.css`.
- **When kit figures are carried:**
  - On the first open of a project whose measurements file has no `kitPilesConverted` (an old project), figures are carried.
  - After a volumetric build run in this app version, they are not carried, and the engine computes.
  - This means no pipeline-pack output change and no change to `volumes.json` (which is a strict schema).
- **The per-date run** sets "current" to each date. Fixed sides stay fixed. An item with no `current`/`previous` side has no series.
- **Base spread:** `(max − min) / 2 / mean` of total volume over smart, fit-plane, perimeter-mean and lowest point, in both executors. It is shown and never stored.
- **Inventory totals** are TS display-time sums of stored engine results. They are not a new engine figure, so there is no Python twin.
- **Hidden** stays personal view state (measurement layers design). It is not a record field.
- **Angle settings** live in `SurveySettings.angles` (a loose object), not in `SurveyUnits`. `SurveyUnits` is strict, so an older build would refuse the file.
- **Elevation history** keeps working as a tool. It opens the point card. Its typed-coordinate mode in Survey QA goes, because a point measurement does the same job.
- **The globe** keeps geodesic maths (planar survey maths is wrong on a globe) and uses the survey formatter and card look.
- **"Average edge level" (`perimeter-mean`)** stays in the base picker with a hint, because existing measurements use it. The spec's table lists five bases besides the default; this is the sixth.

## Open points for the founder

1. Should Wave 1 land as one branch or as the four branches suggested above? This plan works either way.
2. **"Add to report" for several marked measurements.** The plan adds each of them, in tree order. Confirm.
