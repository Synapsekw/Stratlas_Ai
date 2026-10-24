# Volumetrics redesign: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is test first: write the failing test, run it and see it fail for the stated reason, then make it pass.

**Approval:** approved by the founder up front, 24 Oct 2026: build from this plan without waiting for a review of it.

**Goal:** Fix the converted piles' heights and the "No survey data" cards, then rebuild the volumes experience around a pile panel, a chart and scene linked both ways, one date control with a 160 px dates chart strip and timelapse, and a Volumes tab with Inventory, Cut and fill and Materials with dated densities.

**Spec:** `docs/plans/2026-10-24-volumetrics-redesign-design.md`. Read it before any task: it holds the copy, the layout and the board numbers this plan refers to. The look is the founder-approved Design canvas (private artifact `DB5QCSDcq6xE7NakdnVADk`, boards 1 to 11; read a board with the Artifact tool, `action: "read"`, path `project/<Board>.dc.html`). Mock-up figures and material names are not product data.

**Base:** worktree `E:\Dev\AIO Software\.claude\worktrees\volumetrics-redesign`, branch `feat/volumetrics-redesign`, off `main` at `2787e0379`. Every path below is relative to it.

**Architecture:** Heights are fixed where piles are made (`@aio/survey` `kitPiles.ts`, given a height sampler) and repaired once on load by the renderer's measurement store. Surfaces prepare through the existing `survey.prepare` job started quietly on open, with a per-date state every chip and chart reads. The pile panel, the linked hover store, the strip's player and the compare pair are renderer state in `apps/desktop`; the pure maths (pile axis, figure on a date, density on a date, inventory by material) lives in `@aio/survey`. The only schema changes are three optional fields.

**Tech stack:** TypeScript strict, React 19, zustand (`createStore` + `useStore`), three.js (`@aio/engine` stage), MapLibre (`@aio/maps`), zod (`@aio/schema`), hand-rolled SVG charts (`apps/desktop/src/renderer/charts`), Vitest, Playwright with Electron.

## Decided, not open

**Which figure converted old-kit piles show.** Founder, 24 Oct 2026: the standard-base engine figure by default once surfaces exist (as in the mock-ups: 63 402 m³ on the later date where the app showed the carried 63 827 m³), with the kit figure kept as "was" in History. Task A7 runs the existing acceptance path (`recomputeCarried`, `compareStore.ts:584`) on its own, once per pile, in writable projects; it amends ADR 0013 point 4.

## Stages (one merge each)

| Stage | Lands                                                                                                                                            | Tasks  | Contract change                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------- |
| A     | Heights fix, surfaces prepared on open with per-date chip states, standard-base figures for converted piles                                      | A0-A9  | `kitHeightsRepaired`, `Settings.autoPrepareSurfaces` |
| B     | Pile panel (Overview, Profile with a turnable long axis, History), linked hover chart and scene, section window                                  | B0-B8  | none                                                 |
| C     | Figures follow the date, Stockpiles group, dates strip and timelapse, Volumes tab (Inventory, Cut & fill, Materials), Show control, folded fixes | C0-C12 | `SiteMaterial.colour`, `SiteMaterial.densityHistory` |

Each stage ends with its verification task, `/wrapup`, `node tools/agent/finish-task.mjs` and the merge procedure in `CLAUDE.md` (lock, green PR, `ff-only`, announce). The founder sees each stage on `main` before the next merges. Stage B starts building as soon as Stage A's tasks are committed (it touches no Stage A file except `en.ts`, which each stage's strings task owns); rebase B onto `main` after A lands, and C after B. No pipeline pack change in any stage.

## Global Constraints

- TypeScript strict, no `any`, no non-null assertions; renderer never imports `electron` or `node:*`; packages import only what `docs/architecture/SPEC.md` section 2 allows (`@aio/survey` may not import `@aio/volumetric`).
- Copy exactly as the spec; strings in `packages/ui/src/i18n/en.ts` (dotted keys, `{name}` placeholders, `_one`/`_other` plurals), no em or en dashes in user-facing text, no `title=` tooltips, spacing, z-index and shadow from tokens (`--sp-*`, `--z-*`, `--el-*`). Load the `impeccable` and `frontend-design` skills before any UI task and read the task's boards first.
- Numbers: thin-space-free grouping as the app formats them today (`formatNumber` with the project's units and precision); signs use the Unicode minus "−" as the boards do.
- Nothing is estimated between surveys. A figure never shows without its status (carried, stale, partial, refused, preparing).
- Read-only projects and packages never write: repairs and acceptance happen in memory or not at all.
- Heavy work only through the setting `autoPrepareSurfaces` (absent = on), always visible and cancellable in Jobs.
- Public repo: never write the founder's real project or site name, in code, fixtures, docs or commit messages ("the founder's two-date stockpile project"); run `node tools/agent/check-public-text.mjs <files>` on every doc added or changed.
- e2e: specs under `apps/desktop/e2e/`, windows off-screen through the fixtures, `--workers=1`, one Playwright run at a time, CI way (`QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp`), `pnpm demo:build --quick` first; pipeline specs need `QUADRION_E2E_PYTHON` at the main checkout's venv. A new floating control is checked with `document.elementFromPoint` at 1100 x 700 (`test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } })`).
- Unit tests: `pnpm vitest run <file>` from the worktree root. Commits: conventional, stage by path, never `git add -A`, never a bare `git stash`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A pile a person already edited must never be re-heighted.** Input: a converted pile where one vertex was dragged (non-zero Z) and the rest are 0. Expected: untouched, not listed in `kitHeightsRepaired`. Test in A2 (`needsHeightRepair` false) and A3.
2. **Auto prepare on a big project the founder is using.** Input: setting on, three dates of large DSMs, the person cancels in Jobs. Expected: the job stops, nothing restarts until reopen, cards show "Prepare" chips. Test in A5 (`shouldAutoPrepare` with `cancelled`).
3. **Dates out of order or without a date.** Input: a capture with no date, captures added out of time order. Expected: the strip, the History table and `densityOn` order by capture date and skip undated captures without throwing. Tests in C2 (`densityOn` with an undated capture) and C4a (`stripScale` ignores undated).
4. **A material density edit from a middle date.** Input: three surveys, edit from the second. Expected: the first keeps its tonnes, second and third change, `densityTPerM3` equals the newest entry. Test in C2 (`withDensityFrom`).
5. **Hover on a line with one survey or a gap in a surface.** Input: one series, or a chainage where one series has no z. Expected: one dot, no gap line, tag without a delta; no NaN in the tag or the scene. Test in B1 (`markerAt`).

---

# Stage A: heights and surfaces

## Stage A Execution DAG

| Task | Title                                   | Depends on          | Packages                        |
| ---- | --------------------------------------- | ------------------- | ------------------------------- |
| A0   | Strings, Stage A set                    | none                | `@aio/ui`                       |
| A1   | Schema fields and contract row          | none                | `@aio/schema`, docs             |
| A2   | Heights at conversion and repair (pure) | A1                  | `@aio/survey`                   |
| A4   | Map picks never fall back to 0          | none                | `apps/desktop`                  |
| A5   | Prepare surfaces on open, surface state | A0, A1              | `apps/desktop`                  |
| A3   | Heights in the measurement store        | A2                  | `apps/desktop`                  |
| A6   | Chips and cards with per-date states    | A5                  | `apps/desktop`                  |
| A7b  | Preparing card and sidebar date status  | A5                  | `apps/desktop`                  |
| A7   | Repair and accept once surfaces exist   | A3, A5              | `apps/desktop`, docs (ADR 0013) |
| A8   | e2e and docs, Stage A                   | A3, A4, A6, A7, A7b | `apps/desktop/e2e`              |
| A9   | Verification, Stage A                   | A8                  | none                            |

Parallel batches (no file shared inside a batch; dispatch each batch in one message):

- **A-1:** A0, A1, A4.
- **A-2:** A2, A5.
- **A-3:** A3, A6, A7b.
- **A-4:** A7.
- **A-5:** A8, then A9.

Critical path: A1 → A2 → A3 → A7 → A8 → A9.

### Task A0: strings, Stage A set

**Files:** Modify `packages/ui/src/i18n/en.ts` (near `mcard.*` :5810 and `empty.survey.*` :6029). Test: `packages/ui/src/i18n/i18n.test.ts` (existing catalogue checks).

**Produces** keys (English exactly as the spec, sections 1 and 2): `surface.state.ready`, `surface.state.preparing` ("preparing {pct} %"), `surface.state.prepare` ("Prepare"), `surface.state.none` ("No elevation for this date"), `surface.preparing.title`, `surface.preparing.count` ("Preparing {done} of {total}"), `surface.preparing.onOpen`, `mcard.surfacePreparing`, `mcard.noElevation`, `mcard.notMeasured`, `chart.building` ("Building the height surface for {date}…"), `chart.buildingRest` ("The {ready} line is ready; {waiting} and the cut/fill shading appear when it finishes."), `settings.autoPrepare.label`, `settings.autoPrepare.hint` ("Runs in the background and shows in Jobs. You can cancel it.").

- [ ] Step 1: add the keys; run `pnpm vitest run packages/ui/src/i18n`; expected PASS (no dashes, no duplicate keys).
- [ ] Step 2: commit `feat(ui): strings for prepared surfaces and their states`.

### Task A1: schema fields and contract row

**Files:** Modify `packages/schema/src/survey.ts` (`MeasurementsFile`, next to `kitPilesConverted` :570), `packages/schema/src/ipc.ts` (`Settings` :488), `docs/architecture/contract-changes.md`. Test: `packages/schema/src/survey.test.ts` (both fields; `Settings` is parsed there too, or in a new `packages/schema/src/settings.test.ts`).

**Produces:** `MeasurementsFile.kitHeightsRepaired?: string[]` (`z.array(Id).max(5000).optional()`); `Settings.autoPrepareSurfaces?: boolean`.

- [ ] Step 1: tests `kitHeightsRepaired round-trips and is optional` (parse a file with and without it; the parsed value equals the input) and `autoPrepareSurfaces is optional` (a settings object without it parses; with `false` keeps `false`). Run, expect FAIL (unknown key stripped or type error).
- [ ] Step 2: add the fields; run, expect PASS; `pnpm typecheck`.
- [ ] Step 3: add the Stage A row (text in "Contract changes" below). Commit `feat(schema): kit height repair mark and the auto-prepare setting`.

### Task A2: heights at conversion and repair (pure)

**Files:** Modify `packages/survey/src/calc/kitPiles.ts` (`kitToSite` :360, `KitOpenOptions` :364, `kitConversion` :421-433, `convertKitPiles` :228-253), `packages/survey/src/index.ts`. Test: `packages/survey/src/calc/kitPiles.test.ts` (the Z = 0 assertion at :316-317 changes).

**Interfaces (produces):**

- `kitToSite(origin: readonly number[], xz: readonly [number, number], z?: number): SitePoint` (z defaults to 0).
- `type KitHeightAt = (epoch: string, e: number, n: number) => number | null`; `KitOpenOptions.heightAt?: KitHeightAt`. `kitConversion` drapes each converted outline with the epoch whose outline it is.
- `drapeZ(points: readonly SitePoint[], at: (e: number, n: number) => number | null): number[] | null`: a vertex with no height takes the previous vertex's, leading misses take the first found; `null` when no vertex has a height.
- `kitEpochOf(m: SurveyMeasurement): string | null`: `results[0]?.carried?.epoch`, else the latest carried epoch in `series`.
- `needsHeightRepair(m: SurveyMeasurement, file: MeasurementsFile, originH: number): boolean`: `origin?.kind === 'kit-pile'`, every vertex Z exactly 0, `originH !== 0`, id not in `file.kitHeightsRepaired`.
- `repairKitHeights(file: MeasurementsFile, heights: ReadonlyMap<string, readonly number[]>): { file: MeasurementsFile; repaired: string[] }`: sets Z for the ids given (lengths must match the points, all finite, else skipped), appends them to `kitHeightsRepaired`, leaves `updatedAt`, `pickedOn`, `results`, `series` and `previousResults` untouched.

- [ ] Step 1: tests (replace the :317 assertion):
  - `conversion drapes the outline on the kit DSM`: `heightAt` returning `100 + e * 0.01`; every converted vertex Z equals that.
  - `conversion without heightAt keeps Z 0` (old behaviour for callers that pass none).
  - `drapeZ fills holes from the previous vertex and leading holes from the first found`; `drapeZ returns null when nothing has a height`.
  - `needsHeightRepair`: true for an all-zero kit pile with originH 51; false when one vertex is non-zero, when originH is 0, when the id is listed, for a non-kit measurement.
  - `repairKitHeights sets Z, lists the id, and keeps updatedAt, pickedOn, results, series, previousResults`; `repairKitHeights skips an id whose heights do not match the point count`; running it twice lists each id once.
- [ ] Step 2: run `pnpm vitest run packages/survey/src/calc/kitPiles.test.ts`, expect FAIL.
- [ ] Step 3: implement; export the new names from `src/index.ts`.
- [ ] Step 4: run, expect PASS. Commit `fix(survey): converted kit piles take real heights, with a one-time repair`.

### Task A3: heights in the measurement store

**Files:** Create `apps/desktop/src/renderer/survey/kitHeights.ts`. Modify `apps/desktop/src/renderer/survey/measureStore.ts` (`loadMeasurements` :333-395, `kitOptions` :448, `openedWithKitPiles` :461, `writeConversion` :481, `convertAfterJob` :515-541), `apps/desktop/src/renderer/reportPage/house/surveyData.ts` (`withKitPiles` :161-170). Tests: `apps/desktop/src/renderer/survey/kitHeights.test.ts`, `apps/desktop/src/renderer/survey/measureStore.kit.test.ts`, `apps/desktop/src/renderer/reportPage/house/survey.test.ts` (:589, :769).

**Interfaces:**

- Consumes A2 (`KitHeightAt`, `needsHeightRepair`, `repairKitHeights`, `drapeZ`, `kitEpochOf`), `decodeDsm` and `sampleDsm` from `@aio/volumetric` (`model/kitdata.ts`, `model/dsm.ts`), `groundAt` (`survey/dateSurfaces.ts:129`).
- Produces `kitDsmHeightAt(projectId: string, epochs: readonly string[], fetchText: (url: string) => Promise<string | null>): Promise<KitHeightAt>` (loads `aio://project/<id>/legacy/data/dsm_<epoch>.js` once per epoch; a missing file gives `null` heights for that epoch), and `kitRepairHeights(projectId: string, file: MeasurementsFile, manifest: Manifest, deps: { dsm: KitHeightAt; groundAt: typeof groundAt; captureOfEpoch: (epoch: string) => string | null }): Promise<ReadonlyMap<string, number[]>>` (DSM first, else the prepared surface of the epoch's capture; the epoch-to-capture rule is the one `workspace/volumeDates.ts` uses).
- Produces `repairKitHeightsNow(projectId: string): Promise<string[]>` exported from `measureStore.ts` (repairs the open file, writes quietly through the `writeConversion` path when the project is writable and something was repaired, returns the ids). A7 calls it.

- [ ] Step 1: tests:
  - `kitHeights.test.ts`: `DSM heights win over the prepared surface`; `a missing DSM falls back to the prepared surface of the epoch's capture`; `nothing found gives no entry`.
  - `measureStore.kit.test.ts`: `a writable open converts with real heights and writes once`; `an earlier conversion with Z 0 is repaired once and listed; a reopen writes nothing`; `a read-only open repairs in memory only` (no write call); `convertAfterJob drapes the new piles`; `a repair never marks the project unsaved`.
  - `survey.test.ts` (report): the in-memory kit piles have non-zero Z when the fixture has a DSM.
- [ ] Step 2: run the three files, expect FAIL.
- [ ] Step 3: implement: `kitOptions` gains `heightAt` (await `kitDsmHeightAt` before `openedWithKitPiles`), the load path runs `kitRepairHeights` + `repairKitHeights` after conversion, `writeConversion` also writes `kitHeightsRepaired`.
- [ ] Step 4: run, expect PASS. Commit `fix(survey): converted piles sit on the ground in 3D, repaired once on open`.

### Task A4: map picks never fall back to 0

**Files:** Create `apps/desktop/src/renderer/survey/mapHeights.ts`. Modify `apps/desktop/src/renderer/survey/measureScene.ts` (`attachMap` :816, `site` :846-849), `apps/desktop/src/renderer/survey/MeasureToolbar.tsx` (:94-106, create and warm the heights for the date in view). Tests: `apps/desktop/src/renderer/survey/mapHeights.test.ts`, `apps/desktop/src/renderer/survey/measureScene.test.ts` (:509 uses `clampZ () => 0`).

**Interfaces (produces):** `createMapHeights(projectId: string, fetchTile: FetchTile): MapHeights` with `warm(tiles: HeightTiles | null): Promise<void>` (loads the tiles around the view for the date in view, reuses `tilesSampler`, `survey/card/pointHistory.ts:62`) and `at(e: number, n: number): number | null` (sync, cached tiles only). `fallbackZ(at: number | null, prev: SitePoint | null, originH: number): number` (pure: surface, else previous vertex, else origin height). `attachMap` opts gain `heights?: MapHeights`.

- [ ] Step 1: tests `fallbackZ prefers the surface, then the previous vertex, then the origin height`; `at returns null before warm and the bilinear height after`; in `measureScene.test.ts` `a map pick that misses the stage takes the cached surface height` and `with nothing cached it takes the previous vertex, then the origin height, never 0` (origin height 51).
- [ ] Step 2: run, expect FAIL. Step 3: implement (warm on the focused date's tiles from `MeasureToolbar.tsx`'s existing map attach). Step 4: run, expect PASS.
- [ ] Step 5: commit `fix(survey): map points never fall back to height 0`.

### Task A5: prepare surfaces on open, and the surface state per date

**Files:** Create `apps/desktop/src/renderer/survey/surfacesWatch.ts`, `apps/desktop/src/renderer/survey/surfaceStates.ts`. Modify `apps/desktop/src/renderer/survey/compareStore.ts` (`prepareParams` :911, `prepareSurfaces` :932, `refreshSurfaces` :227), `apps/desktop/src/renderer/survey/qaStore.ts` (`refreshQa` :104), `apps/desktop/src/renderer/App.tsx` (next to the line-up wiring :436), `apps/desktop/src/renderer/screens/settings/ProcessingEngine.tsx`. Tests: `surfacesWatch.test.ts`, `surfaceStates.test.ts`, `compareHelpers.test.ts` (prepareParams), `screens/settings/ProcessingEngine.test.tsx`.

**Interfaces (produces):**

- `type SurfaceState = { kind: 'ready' } | { kind: 'preparing'; pct: number } | { kind: 'missing' } | { kind: 'none' }`.
- `surfaceStates(manifest: Manifest, prepared: readonly PreparedSurface[], running: readonly JobRecord[]): ReadonlyMap<string, SurfaceState>` (by capture id; `none` when the capture has no DSM raster and no cloud) and `useSurfaceStates(): ReadonlyMap<string, SurfaceState>`.
- `prepareParams(manifest, prepared, only?: readonly string[])` now covers a date's DSM, else its point cloud (as `qaStore.ensureSurface` :205 does), and sets `capture` on each surface. `prepareDates(captures: readonly string[]): Promise<string | null>` starts one job for those dates (chips' Prepare).
- `shouldAutoPrepare(x: { setting: boolean; writable: boolean; hasPython: boolean; cancelled: boolean; missing: number }): boolean`.
- `connectSurfacesWatch(deps: SurfacesWatchDeps): () => void`, modelled on `LineUpWatchDeps` (`lineup/lineUpWatch.ts:49`): on project open and manifest change, starts `jobs.getState().startQuiet({ pipeline: 'survey.prepare', ... })` when `shouldAutoPrepare`; remembers a cancel for the project until it closes; checks the same project is still open before starting.
- After any `survey.prepare` job ends, both `compareStore` and `qaStore` surfaces refresh (`refreshSurfaces` calls `refreshQa`).
- Settings: a switch "Prepare survey surfaces when a project opens" (`settings.autoPrepare.*`) writing `autoPrepareSurfaces`.

- [ ] Step 1: tests: `shouldAutoPrepare` truth table (setting off, read-only, no Python, cancelled, nothing missing each give false); `surfaceStates` (ready, preparing with the job's progress as a whole percentage for the captures in its params, missing, none for a date with neither DSM nor cloud); `prepareParams falls back to the cloud and sets capture`; `the watch starts one quiet job on open and none after a cancel`; `a finished job refreshes both stores`; the settings switch writes `autoPrepareSurfaces: false`.
- [ ] Step 2: run, expect FAIL. Step 3: implement and wire in `App.tsx`. Step 4: run, expect PASS.
- [ ] Step 5: commit `feat(survey): survey surfaces prepare in the background when a project opens`.

### Task A6: chips and cards with per-date states

**Files:** Modify `apps/desktop/src/renderer/survey/card/slots.tsx` (`useDatedSurfaces` :277-288 and consumers :343, :401, :480, :524-581, :646, :712, :793-801, :861, :954-992), `apps/desktop/src/renderer/survey/card/pointHistory.ts` (`DatedSurface` :80), `apps/desktop/src/renderer/charts/SurfaceChips.tsx`, `apps/desktop/src/renderer/survey/card/VolumeDetail.tsx` (:748, :890), `apps/desktop/src/renderer/charts/TimeChart.tsx` (:463, :586, :599), `apps/desktop/src/renderer/charts/charts.css`. Tests: `slots.test.tsx`, `SurfaceChips.test.tsx`, `VolumeDetail.test.tsx`, `TimeChart.test.tsx`.

**Interfaces:** Consumes A5 `useSurfaceStates`, `prepareDates`. Produces `useSurveyDates(): DatedSurface[]` (every dated capture, oldest first; `DatedSurface` gains `state: SurfaceState` and `tiles: HeightTiles | null`); `ChipOption.state?: SurfaceState` and `SurfaceChips` prop `onPrepare?: (key: string) => void` (chip `data-state`, preparing shows the percentage and is not toggleable, missing shows a Prepare button, none is disabled with the reason as its accessible description); `TimeChart` prop `gapReason?: (capture: string) => string`.

- [ ] Step 1: tests: `a line card lists every survey date as a chip, ready, preparing 62 % and Prepare`; `Prepare on a chip starts prepareDates for that date`; `a date without elevation is a disabled chip with "No elevation for this date"`; `no card shows "No survey data"` (each slot's empty state uses `mcard.surfacePreparing`, `mcard.noElevation` or `mcard.notMeasured`); `TimeChart gap tip uses gapReason`.
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: run, expect PASS.
- [ ] Step 5: commit `feat(survey): cards show every survey date with its surface state`.

### Task A7b: preparing card and sidebar date status (board 7)

**Files:** Create `apps/desktop/src/renderer/survey/PreparingCard.tsx` (+ styles in `survey/measure.css`). Modify `apps/desktop/src/renderer/workspace/Stage.tsx` (mount next to the stage floats), `apps/desktop/src/renderer/shell/Sidebar.tsx` (survey date rows :312-345). Tests: `PreparingCard.test.tsx`, `shell/Sidebar.measures.test.tsx`.

**Interfaces:** Consumes `useSurfaceStates`. Produces `PreparingCard(): JSX.Element | null` (`data-testid="preparing-card"`; shown while any date is preparing; closes 2 s after the last finishes).

- [ ] Step 1: tests `the card lists each date as ready or its percentage, with "Preparing 1 of 2" and the started-on-open line`; `the card hides 2 s after the job ends` (fake timers); `a sidebar date row reads "preparing 62 %" while its job runs and "ready" after, nothing when no job ran`.
- [ ] Step 2: run, expect FAIL. Step 3: implement (bottom-left float, 330 px wide, scrim tokens). Step 4: run, expect PASS.
- [ ] Step 5: commit `feat(survey): the stage shows surfaces preparing and the sidebar their status`.

### Task A7: repair and accept once surfaces exist

**Files:** Create `apps/desktop/src/renderer/survey/kitAccept.ts`. Modify `apps/desktop/src/renderer/App.tsx` (wire), `docs/architecture/adr/0013-one-volume-engine.md` (amend point 4). Test: `apps/desktop/src/renderer/survey/kitAccept.test.ts`.

**Interfaces:** Consumes `repairKitHeightsNow` (A3), `useSurfaceStates`/`surfaceStates` (A5), `recomputeCarried(ids)` (`compareStore.ts:584`, keeps the kit figure in `previousResults` as "was"). Produces `kitPilesToAccept(file: MeasurementsFile, states: ReadonlyMap<string, SurfaceState>, captureOfEpoch: (epoch: string) => string | null): string[]` (converted piles with a carried headline whose every series date is `ready`) and `connectKitReady(deps: { onProjectOpen; onJobEnded; writable: () => boolean }): () => void` (on open and after each `survey.prepare` ends: `repairKitHeightsNow`, then `recomputeCarried(kitPilesToAccept(...))` when writable).

- [ ] Step 1: tests: `piles whose dates are all ready are accepted`; `a pile with a preparing date waits`; `an accepted pile (no carried result) is not picked again`; `a read-only project accepts nothing`; `acceptance keeps the kit figure as was` (mock `recomputeCarried`, then assert on a real `recomputeCarried` result in `compareStore` tests if one exists: `previousResults[0].carried.from === 'kit'`).
- [ ] Step 2: run, expect FAIL. Step 3: implement; amend ADR 0013 point 4 with: "Since 24 Oct 2026 (founder): once a converted pile's dates all have prepared surfaces, the app accepts the standard base on its own, once per pile, in writable projects; the kit figure stays in `previousResults` and shows as was in the pile's History." Step 4: run, expect PASS.
- [ ] Step 5: commit `feat(survey): converted piles take the standard-base figure once surfaces exist`.

### Task A8: e2e and docs, Stage A

**Files:** Modify `apps/desktop/e2e/kit-migration.spec.ts` (fixture: origin height 51, one `legacy/data/dsm_<epoch>.js` per epoch made with the kit encoder the spec's fixture already uses or `kitdata.test.ts`'s helper; the assertion near :264 on the outline). Create `apps/desktop/e2e/surfaces-auto.spec.ts`. Modify `apps/desktop/e2e/measure-card.spec.ts`. Modify `docs/KNOWN-LIMITS.md` if it lists Prepare surfaces as manual.

- [ ] Step 1: `kit-migration.spec.ts`: new tests `converted piles sit on the kit DSM: every vertex within 0.05 m` (read `measurements.json`), `an earlier conversion with Z 0 is repaired once: kitHeightsRepaired lists the piles and a second open leaves the file byte-identical`, `in a package the heights are repaired in memory and nothing is written`. The existing four tests stay green.
- [ ] Step 2: `surfaces-auto.spec.ts` (earthworks demo through `openDemo`, `PIPELINE_ENV`, skip without `hasPipelinePython()`): `opening a project with unprepared dates starts one quiet prepare job; the distance card lists both dates, preparing then ready`; `with the setting off nothing starts and the chip offers Prepare, which starts it`; `a cancelled prepare is not restarted until the project reopens`; `the preparing card does not cover the view at 1100 x 700` (`elementFromPoint` at the view centre and 40 px above the card reaches the canvas).
- [ ] Step 3: `measure-card.spec.ts`: `a date without a surface shows as a chip, not "No survey data"`.
- [ ] Step 4: run each spec the CI way; expect PASS (`--repeat-each=3` on `surfaces-auto.spec.ts`).
- [ ] Step 5: commit `test(e2e): kit heights and surfaces prepared on open`.

### Task A9: verification, Stage A

- [ ] `pnpm check` green; the CI-way run of `kit-migration`, `surfaces-auto`, `measure-card`, `profile-chart`, `sections`, `volumes-general`, `volume-over-time`, `measurement-dates`, `hydro` (all touch prepare or kit piles) passes; then `/wrapup`, `node tools/agent/finish-task.mjs`, merge per `CLAUDE.md`.

---

# Stage B: pile panel and linked hover

## Stage B Execution DAG

| Task | Title                                       | Depends on     | Packages                          |
| ---- | ------------------------------------------- | -------------- | --------------------------------- |
| B0   | Strings, Stage B set                        | none           | `@aio/ui`                         |
| B1   | Linked hover store and line geometry        | none           | `apps/desktop`                    |
| B4   | Pile long axis (pure)                       | none           | `@aio/survey`                     |
| B2   | ProfileChart controlled crosshair, pin, fly | B0, B1         | `apps/desktop`                    |
| B3   | Hover marker in 3D and Map, scene to chart  | B1             | `apps/desktop`                    |
| B5b  | Opening the pile panel from 3D, Map, lists  | B0             | `apps/desktop`, `@aio/volumetric` |
| B5a  | Pile panel                                  | B0, B1, B2, B4 | `apps/desktop`                    |
| B6   | Line cards, section dock and window linked  | B2, B3         | `apps/desktop`                    |
| B5c  | Pile line in the scene and stage hints      | B3, B5a        | `apps/desktop`                    |
| B7   | e2e, Stage B                                | B5a-c, B6      | `apps/desktop/e2e`                |
| B8   | Verification, Stage B                       | B7             | none                              |

Parallel batches:

- **B-1:** B0, B1, B4.
- **B-2:** B2, B3, B5b.
- **B-3:** B5a, B6.
- **B-4:** B5c.
- **B-5:** B7, then B8.

Critical path: B1 → B2 → B5a → B5c → B7 → B8.

### Task B0: strings, Stage B set

**Files:** `packages/ui/src/i18n/en.ts`. Keys (text from spec sections 3 and 4): `pile.back`, `pile.position` ("Pile {n} of {total}"), `pile.prev`, `pile.next`, `pile.density`, `pile.densityAria`, `pile.noMaterial`, `pile.pickMaterial`, `pile.volume`, `pile.tonnes`, `pile.vs` ("vs {date}"), `pile.atDensity` ("at {density} t/m³"), `pile.first`, `pile.footprint`, `pile.maxHeight`, `pile.base`, `pile.tab.overview`, `pile.tab.profile`, `pile.tab.history`, `pile.more`, `pile.shadeVs`, `pile.lineAxis` ("Line: long axis · {length}"), `pile.addDate` ("+ Date or design"), `pile.cutWhole`, `pile.fill`, `pile.largestDrop` ("Largest drop {value} at {chainage}"), `pile.lineHint`, `pile.escHint`, `pile.history.title`, `pile.history.both`, `pile.history.first` ("first"), `pile.history.was` ("was {value} · earlier version"), `pile.history.note`, `hover.following`, `hover.legend` ("{date} surface · where {earlier} was · A to here"), `hover.snapped` ("Pointer on the line · snapped to {chainage}"), `hover.follows`, `hover.footer`, `hover.pinned` ("{chainage} · pinned"), `hover.pinnedHint`, `hover.split`, `chart.chainage` ("Chainage {value}"), `chart.deltaCut` ("Δ {value} cut"), `chart.deltaFill` ("Δ {value} fill"), `section.close`, `section.addPinHere` ("Add pin here").

- [ ] Add, run `pnpm vitest run packages/ui/src/i18n`, commit `feat(ui): strings for the pile panel and linked hover`.

### Task B1: linked hover store and line geometry

**Files:** Create `apps/desktop/src/renderer/survey/linkedHover.ts`, `apps/desktop/src/renderer/survey/linkedHoverGeom.ts`. Tests: `linkedHover.test.ts`, `linkedHoverGeom.test.ts`.

**Interfaces (produces):**

```ts
export interface HoverLine {
  key: string; // 'measure:<id>' | 'pile:<id>' | 'section' | 'kit-section'
  polyline: readonly (readonly [number, number])[]; // site E, N
  series: readonly ChartSeries[]; // the chart's shown series, oldest first
}
export interface HoverPoint {
  key: string;
  chainageM: number;
  source: 'chart' | '3d' | 'map';
}
export interface LinkedHoverState {
  lines: ReadonlyMap<string, HoverLine>;
  hover: HoverPoint | null;
  pin: HoverPoint | null;
  fly: { key: string; chainageM: number; nonce: number } | null;
  register(line: HoverLine): () => void;
  setHover(p: HoverPoint | null): void;
  setPin(p: HoverPoint | null): void; // null clears
  flyTo(key: string, chainageM: number): void;
}
export const linkedHover: StoreApi<LinkedHoverState>;
export function useLinkedHover<T>(select: (s: LinkedHoverState) => T): T;
```

Geometry: `pointAt(polyline, chainageM): [number, number]` (replaces `atChainage`, `slots.tsx:756`, which B6 deletes); `chainageOf(polyline, e, n): { chainageM: number; offsetM: number }`; `snapScreen(screen: readonly (readonly [number, number])[], cumulM: readonly number[], x: number, y: number, maxPx?: number): number | null` (default 12 px; returns the chainage of the nearest point on the projected line); `markerAt(line: HoverLine, chainageM: number): { e: number; n: number; dots: { key: string; capture?: string; z: number }[]; deltaM: number | null }` (z linearly interpolated per series, a series with no z there is left out; delta = newest dated series minus the one before, null with fewer than two); `tagText(chainageM, deltaM, fmt): string` ("42.3 m · −1.63", no delta part when null).

- [ ] Step 1: tests: register and unregister; a pin survives `setHover(null)`; `setPin(null)` clears; `flyTo` bumps the nonce; `pointAt`/`chainageOf` round-trip on an L-shaped polyline; `snapScreen` snaps within 12 px and returns null at 13 px; `markerAt` with two series gives both z and the delta, with one series no delta, with a gap in one series one dot and no delta (Review Focus 5); `tagText` uses the minus sign.
- [ ] Step 2: run, expect FAIL. Step 3: implement (vanilla `createStore`, model `workspace/workbench/drawerStore.ts`). Step 4: run, PASS.
- [ ] Step 5: commit `feat(survey): one hover and pin store shared by charts and scene`.

### Task B4: pile long axis

**Files:** Create `packages/survey/src/section/pileAxis.ts`; modify `packages/survey/src/index.ts`. Test: `packages/survey/src/section/pileAxis.test.ts`.

**Interfaces (produces):** `interface PileAxis { a: [number, number]; b: [number, number]; centre: [number, number]; angleDeg: number; lengthM: number }`; `pileAxis(ring: readonly SitePoint[], opts?: { angleDeg?: number; marginPct?: number }): PileAxis` (centre = area centroid; default angle = principal axis of the polygon's second moments, degrees clockwise from east, in [0, 180); ends = the ring's extent along the axis plus `marginPct` (default 5) of the length on each side); `rotateAxis(axis: PileAxis, ring, deltaDeg: number): PileAxis`; `moveAxisEnd(axis: PileAxis, end: 'a' | 'b', p: readonly [number, number]): PileAxis` (the other end stays).

- [ ] Step 1: tests: a 100 x 20 rectangle rotated 30° gives angle 30 ± 0.01 and length 110 ± 0.01; a square gives a stable angle (0); `angleDeg` option is honoured; `rotateAxis` by 90 swaps to the short extent; `moveAxisEnd` keeps the other end and recomputes length.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(survey): the long axis of a pile`.

### Task B2: ProfileChart with a controlled crosshair, pin and fly

**Files:** Modify `apps/desktop/src/renderer/charts/ProfileChart.tsx` (`ProfileChartProps` :45-63, local `at` :208, `handlers` :259-274, crosshair :398-413, readout :416), `apps/desktop/src/renderer/charts/charts.css`. Test: `apps/desktop/src/renderer/charts/ProfileChart.test.tsx`.

**Interfaces:** Props added: `hoverAt?: number | null` (controlled when not `undefined`), `onHover?: (chainageM: number | null) => void`, `pinnedAt?: number | null`, `onPinAt?: (chainageM: number | null) => void`, `onFly?: (chainageM: number) => void`, `readoutAction?: ReactNode` (B6's "Add pin here"). When `onPinAt` is given a click pins (a click on the pinned point clears), and the existing `onPin` (section pins) is no longer called on click. Readout: "Chainage 42.3 m", one line per series "10 Jan 64.41 m", then `chart.deltaCut`/`chart.deltaFill`; two dots joined by a dashed gap when they differ by more than 0.05 m; pinned: solid accent crosshair with a pin badge and `hover.pinned`. Esc clears the pin first, then the hover.

- [ ] Step 1: tests: `controlled hoverAt draws the crosshair without a pointer`; `pointer move calls onHover with the chainage`; `click calls onPinAt, a second click on the pin clears it`; `double-click calls onFly`; `the readout shows chainage, both elevations and Δ cut`; `a 0.02 m difference draws no gap line`; `Esc clears the pin and then the hover`; the existing nine tests still pass (adjust only "click pins" to the new rule when `onPinAt` is absent).
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(charts): the profile chart's point can be driven and pinned from outside`.

### Task B3: hover marker in 3D and Map, scene to chart

**Files:** Create `apps/desktop/src/renderer/survey/hoverScene.ts`. Modify `apps/desktop/src/renderer/survey/MeasureToolbar.tsx` (`MeasureLayer` attaches :94-106). Test: `apps/desktop/src/renderer/survey/hoverScene.test.ts`.

**Interfaces:** Consumes B1. Produces `attachHover3d(stage: Stage, frame: Frame): () => void` and `attachHoverMap(ctl: MapController, frame: Frame): () => void`.

- 3D: one dot per `markerAt` dot (`PointsMaterial`, `sizeAttenuation: false`; the newest date filled, earlier dates as rings), a `LineDashedMaterial` gap, a ground ring under the newest dot, the A-to-point stretch as a `Line2` in the accent colour, and an HTML tag in the labels overlay (`data-testid="link-tag"`, `data-key`, `data-chainage`, text from `tagText`), pin badge (`data-testid="link-pin"`) when pinned. Positions from `frame.toLocal`; screen projection as `toScreen` (`measureScene.ts:304`). Raycast disabled on all of it.
- Map: GeoJSON source `aio-link` with layers `aio-link-trace`, `aio-link-gap`, `aio-link-dot`, the tag and pin as MapLibre markers with the same test ids.
- Scene to chart: on pointer move over the canvas or map container, project each registered line, `snapScreen`; a hit sets `setHover({ source: '3d' | 'map' })`, a miss clears a hover this view set. A click on a snapped line pins (`stage.claimClicks` returns true only when snapped); a double-click calls `flyTo`, and the fly is done by `workspace.getState().flyTo({ kind: 'point', p, distance: 40 })` (3D) and the map's point fly (the one `flyTo` drives in Map view).
- Both Split panes get it because `MeasureLayer` attaches per pane; the dots follow the chart's series, not the pane's date.

- [ ] Step 1: tests (fake stage and map controller as `measureScene.test.ts` builds them): `a chart hover adds dots, gap, trace and a tag with "42.3 m · −1.63"`; `one series: one dot, no gap, tag without delta`; `pointer within 12 px of a registered line sets the hover with source 3d`; `a click on the snapped line pins and is claimed; elsewhere it is not claimed`; `double-click asks the workspace to fly to the point`; `the map attach adds the aio-link layers and removes them on detach`.
- [ ] Step 2: FAIL; Step 3: implement and attach in `MeasureLayer`; Step 4: PASS. Step 5: commit `feat(survey): the chart's point shows on the line in 3D and on the map, and the line drives the chart`.

### Task B5b: opening the pile panel from 3D, Map and lists

**Files:** Create `apps/desktop/src/renderer/survey/pile/openPile.ts`, `apps/desktop/src/renderer/survey/pile/kitPileLink.ts`. Modify `apps/desktop/src/renderer/survey/measurePick.ts` (`pickClick` :108), `apps/desktop/src/renderer/workspace/workbench/measureFollow.ts` (:62-79), `apps/desktop/src/renderer/survey/volumesPick.ts`, `apps/desktop/src/renderer/shell/Sidebar.tsx` (`measures.onSelect` :860), `packages/volumetric/src/components/VolumetricStage.tsx` (:449-487: pick body tops in every body mode, and the toe lines when bodies are hidden), `apps/desktop/src/renderer/App.tsx` (wire `connectKitPilePick`). Tests: `openPile.test.ts`, `kitPileLink.test.ts`, `measurePick.test.ts`, `measureFollow` tests if present.

**Interfaces (produces):** `isPile(m: SurveyMeasurement): boolean` (`tool === 'volume'` and a polygon); `openPile(id: string): void` (reveal the Volumes bench as `measureFollow.ts` reveals Measure, `pickInVolumesView(id)`, `select([id], id)`); `connectKitPilePick(): () => void` (a `volumetric` `selected` change maps the kit pile to its measurement by `origin.pile` and calls `openPile`).

- [ ] Step 1: tests: `a click on a pile in 3D or Map opens the Volumes tab, not Measure`; `a kit pile pick opens its converted measurement`; `a sidebar Stockpiles row opens the pile`; `a non-pile measurement still goes to Measure`; `a body-top click in In place mode picks the pile` (store test in `packages/volumetric/src/store.test.ts` or a new `VolumetricStage.pick.test.ts` with a fake stage).
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(volumes): a pile click anywhere opens it in the Volumes tab`.

### Task B5a: pile panel

**Files:** Create in `apps/desktop/src/renderer/survey/pile/`: `PilePanel.tsx`, `PileHeader.tsx`, `PileOverview.tsx`, `PileProfile.tsx`, `PileHistory.tsx`, `pileView.ts`, `pile.css`. Modify `apps/desktop/src/renderer/survey/VolumesView.tsx` (the focused pile renders `PilePanel` instead of `DetailCard` :313), `apps/desktop/src/renderer/charts/TimeChart.tsx` (prop `yTitle?: string` and `valueOf?` for tonnes bars). Tests: `PilePanel.test.tsx`, `PileProfile.test.tsx`, `PileHistory.test.tsx`, `pileView.test.ts`, `VolumesView.test.tsx`.

**Interfaces:** Consumes B2 props, B4 `pileAxis`, B1 `register`, A5 `useSurfaceStates`, `pileMaterial` (`kitPiles.ts:405`), `sampleProfile` (as `useLine` uses it), `BasePicker`, `Calculators`, `HeatControls`. Produces `PilePanel({ id }: { id: string }): JSX.Element` (`data-testid="pile-panel"`), and the store `pileView` with `{ tab: 'overview' | 'profile' | 'history'; axis: ReadonlyMap<string, PileAxis>; historyUnit: 'm3' | 't' | 'both'; setAxis(id, axis); setTab(tab); setHistoryUnit(u) }`.

- Header, KPI, facts, status, tabs, Overview with More, Profile (chips with states, Shade vs, the chart registered as `pile:<id>` with B1, facts, Open larger, Export PNG, Add to report), History (chart, table with `was` line from `previousResults` when `carried.from === 'kit'`, note, Export CSV, Add to report) exactly as spec section 3. Density in Stage B writes `SiteMaterial.densityTPerM3` through the existing materials save (Stage C makes it dated). Placeholder while a date prepares uses `chart.building`/`chart.buildingRest`.

- [ ] Step 1: tests: `the panel shows name, material, density, Volume, Tonnes and vs previous`; `vs reads "first survey" with one date and "preparing 62 %" while the earlier surface prepares`; `a carried result shows its status line`; `‹ Inventory returns and Pile 2 of 19 steps`; `Profile draws one series per ready date along the long axis and registers pile:<id>`; `History lists one row per date with density and tonnes, "first" on the earliest, and the was line for a replaced kit figure`; `More holds heat map, swell and weighed tonnage`; `density edit writes the material`.
- [ ] Step 2: FAIL; Step 3: implement (boards 2, 3, 7; panel width 400 px; tiles 1.25fr 1fr 1fr). Step 4: PASS.
- [ ] Step 5: commit `feat(volumes): the pile panel with overview, profile and history`.

### Task B6: line cards, section dock and window linked

**Files:** Modify `apps/desktop/src/renderer/survey/card/slots.tsx` (`useLine` :646, `LineProfile` :793-816, delete `atChainage` :756 for `pointAt`), `apps/desktop/src/renderer/survey/SectionBody.tsx` (:291-311), `apps/desktop/src/renderer/survey/SectionWindow.tsx` (non-modal: no scrim, no focus trap, Esc closes, panel over the lower 55 % of the stage), `apps/desktop/src/renderer/survey/SectionDock.tsx` (:29-52, :120: close button `section.close`, close when its measurement is unfocused or deleted), `apps/desktop/src/renderer/workspace/VolumeSection.tsx` (:87, register `kit-section`). Tests: `slots.test.tsx`, `SectionBody.test.tsx`, `SectionWindow.test.tsx` (create), `SectionDock.test.tsx` (create).

**Interfaces:** Consumes B1, B2. Line cards register `measure:<id>`; the section dock and window register `section` (one at a time); a section pin is added with `section.addPinHere` in the chart readout (`readoutAction`).

- [ ] Step 1: tests: `a distance card's chart drives the hover store and follows it`; `the section window has no scrim and Esc closes it`; `the dock closes when its measurement is deleted and has a close button`; `Add pin here adds a section pin at the hovered chainage`; `the kit section panel registers its line`.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(survey): line cards and sections link their charts to the scene`.

### Task B5c: pile line in the scene and stage hints

**Files:** Create `apps/desktop/src/renderer/survey/pile/pileAxisScene.ts`, `apps/desktop/src/renderer/workspace/StageHint.tsx`. Modify `apps/desktop/src/renderer/survey/MeasureToolbar.tsx` (attach), `apps/desktop/src/renderer/workspace/Stage.tsx` (mount `StageHint`). Tests: `pileAxisScene.test.ts`, `StageHint.test.tsx`.

**Interfaces:** Consumes `pileView` (B5a), `pileAxis`, `rotateAxis`, `moveAxisEnd` (B4), hover store (B1). Produces `attachPileAxis3d(stage, frame): () => void`, `attachPileAxisMap(ctl, frame): () => void` (dashed line, A and B labels, ↻ at the centre; dragging A or B moves that end, dragging ↻ turns about the centre; writes `pileView.setAxis`); `StageHint()`: bottom-left float choosing one message: pinned (`hover.pinnedHint`), following the chart (`hover.following` + legend), pointer on the line (`hover.snapped`), a pile open (`pile.lineHint` and `pile.escHint`), else none.

- [ ] Step 1: tests: `dragging B moves only B and updates the profile key's line`; `dragging ↻ by 15° turns the axis by 15°`; `the hint follows the state in that order`; `the hint does not catch clicks` (pointer-events none).
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(volumes): the pile's profile line can be moved and turned in the scene`.

### Task B7: e2e, Stage B

**Files:** Create `apps/desktop/e2e/pile-panel.spec.ts` (quarry demo, `openDemo`, as `volume-over-time.spec.ts`), `apps/desktop/e2e/linked-hover.spec.ts` (earthworks demo, two surveys prepared with `runJob('survey.prepare')`, `PIPELINE_ENV`). Modify `profile-chart.spec.ts` (click now pins), `sections.spec.ts` (window non-modal, Add pin here), `volume-over-time.spec.ts` and `kit-migration.spec.ts:367` (picking a pile opens `pile-panel`, figures read from its KPI tiles).

- [ ] Step 1: `pile-panel.spec.ts`: `an Inventory row opens the pile panel with volume, tonnes and change`; `a click on the pile's label in 3D and on its outline in Map opens the same panel` (click at the pile's `.sv-labels` label position; Map via the Stage tools switch); `Profile shows a chip per survey and the chart; History has one row per survey`; `Esc returns to the inventory`; `the pile panel's floats do not cover the view at 1100 x 700`.
- [ ] Step 2: `linked-hover.spec.ts`: `hovering the chart shows the tag on the line in 3D with chainage and delta`; `moving the pointer onto the line on the map moves the chart crosshair` (point from the line's map label position); `click pins: the pin stays after the pointer leaves; Esc clears it`; `double-click flies: the tag ends near the view centre`; `in Split both panes show the tag`; `with the section window open the tag stays visible above it` (`elementFromPoint` at the tag returns the tag).
- [ ] Step 3: run all changed specs the CI way, `--repeat-each=3` on the two new ones; expect PASS. Step 4: commit `test(e2e): pile panel and linked hover`.

### Task B8: verification, Stage B

- [ ] `pnpm check`; the CI-way run of the Stage B specs plus `measure-card`, `compare`, `island`, `small-window`, `stage-overlays`, `volumetric-build`; `/wrapup`; finish and merge per `CLAUDE.md`.

---

# Stage C: dates, strip, Volumes tab

## Stage C Execution DAG

| Task | Title                                                                       | Depends on    | Packages                          |
| ---- | --------------------------------------------------------------------------- | ------------- | --------------------------------- |
| C0   | Strings, Stage C set                                                        | none          | `@aio/ui`                         |
| C1   | Material colour and dated density, contract row                             | none          | `@aio/schema`, docs               |
| C2   | Figure on a date, density on a date, inventory by material, headline status | C1            | `@aio/survey`                     |
| C4a  | Strip model, player and compare pair (pure)                                 | none          | `apps/desktop`                    |
| C5a  | Map raster blend                                                            | none          | `@aio/maps`                       |
| C3   | Figures follow the date; Stockpiles group                                   | C0, C2        | `apps/desktop`                    |
| C7   | Cut & fill pane                                                             | C0, C2, C4a   | `apps/desktop`                    |
| C8   | Materials pane with dated density                                           | C0, C2        | `apps/desktop`                    |
| C9   | Folded fixes                                                                | C0, C2        | `apps/desktop`, `@aio/volumetric` |
| C4b  | Dates strip component and slot                                              | C4a, C2, C8   | `apps/desktop`                    |
| C6a  | Volumes bench: header, segments, Inventory                                  | C3, C7, C8    | `apps/desktop`                    |
| C6b  | Show control; notch Volumes row and kit controls                            | C0            | `apps/desktop`                    |
| C5b  | Timelapse                                                                   | C4b, C5a, C6a | `apps/desktop`                    |
| C10  | e2e and docs, Stage C                                                       | all above     | `apps/desktop/e2e`                |
| C11  | Verification, Stage C                                                       | C10           | none                              |

Parallel batches:

- **C-1:** C0, C1, C4a, C5a.
- **C-2:** C2, C6b.
- **C-3:** C3, C7, C8, C9.
- **C-4:** C4b, C6a.
- **C-5:** C5b.
- **C-6:** C10, then C11.

Critical path: C1 → C2 → C8 → C6a → C5b → C10 → C11 (C4b in parallel with C6a).

File ownership inside batches: C3 owns `measureRows.ts`, `Sidebar.tsx`, `measureScene.ts`, `pileFigures.ts`, `VolumesView.tsx`; C7 owns `volumes/CutFillPane.tsx`, `engineServe.ts`, `engineProtocol.ts`, `survey/heatLegend.tsx`; C8 owns `volumes/MaterialsPane.tsx`, `volumes/materialsDraft.ts`, `survey/Materials.tsx`, `benches/MeasureBench.tsx`; C9 owns `TimeChart.tsx`, `VolumeDetail.tsx`, `MeasureCard.tsx`, `slots.tsx`, `Calculators.tsx`, `baseNames.ts`, `VolumetricStage.tsx`, `dsm.ts`; C4b owns `workspace/dates/DatesStrip.tsx`, `WorkspaceScreen.tsx`, `timelinePref.ts`, `styles.css`; C6a owns `VolumesBench.tsx`, `volumes/VolumesHeader.tsx`, `volumes/InventoryPane.tsx`; C6b owns `workspace/StageShow.tsx`, `Stage.tsx`, `island/groups.tsx`, `VolumeTools.tsx`.

### Task C0: strings, Stage C set

**Files:** `packages/ui/src/i18n/en.ts`. Keys for spec sections 5 and 6: `strip.*` (region "Survey dates chart", play, pause, previous, next, speed, loop, mode volume/tonnes/cutFill, compare, fit, fitAll, collapse, expand, siteTotalOwnScale, siteTotalFaded, pileChip, clearPile "Clear the pile and show the site", preparing, waiting, preview "· preview, unsaved", readout lines, switch "Dates" / "Footage"); `timelapse.*` (playing "Playing · {date}", blend, between, crossfade, swipe, hold, siteTotal, onlyAtSurveys, lastPassed, nextSurvey, playbackNote, fadingIn, fadingOut); `volumes.*` (title "Stockpile inventory", source, export, piles, byMaterial, vs, segment names, groupedBy, deltaVs, columns, siteTotal, noMaterial, more "+ {count} more"); `cutfill.*` (from, to, insidePiles, wholeSite, ignoreUnder, ignoreAria, cut, removed, fill, added, net, wholeSiteLine, byPile, folded "+ {count} piles within ±{value}", note, legendTitle, ignored, clickPile, compareFrom, compareTo); `materials.*` (title, add, columns, allMaterials, unsaved, densityFrom, history, new, keptFor, impact, pilesOf, assign, cancel, save, importCsv, exportCsv, colourBy, colour.material/change/none); `show.*` (caption, photo, elevation, cutFill, outlines, labels); `stockpiles.*` (group "Stockpiles", count "{count} · {date}", netChange, byMaterial); `vol.swipe`, `vol.sectionLine` ("Section line between the surveys"), `vol.swipeBetween` ("Swipe between surveys"); change `base.kitTin` (:5875) to "Triangulated toe"; `mcard.cutPlusFill` ("Cut + fill").

- [ ] Add, run `pnpm vitest run packages/ui/src/i18n`, commit `feat(ui): strings for the dates strip and the Volumes tab`.

### Task C1: material colour and dated density

**Files:** `packages/schema/src/survey.ts` (`SiteMaterial` :92), `docs/architecture/contract-changes.md`. Test: `packages/schema/src/survey.test.ts`.

**Produces:** `SiteMaterial.colour?: string` (`/^#[0-9a-f]{6}$/i`); `SiteMaterial.densityHistory?: { fromCapture: SurveyId; tPerM3: number }[]` (each `tPerM3` > 0 and ≤ 30, max 100, refinement: `fromCapture` unique).

- [ ] Tests `colour accepts #rrggbb only`, `densityHistory rejects a repeated capture`, `a material without the new fields still parses`. FAIL, implement, PASS, add the Stage C row, commit `feat(schema): material colour and density from a survey date`.

### Task C2: figure on a date, density on a date, inventory by material, headline status

**Files:** Create `packages/survey/src/calc/figures.ts`. Modify `packages/survey/src/calc/materials.ts`, `packages/survey/src/calc/bulk.ts` (`pileSeries` :153-174, `inventorySeries` :218), `packages/survey/src/tools/readout.ts` (`primaryText`, `primaryRow` :321, `allRows` :280-285), `packages/survey/src/index.ts`. Tests: `figures.test.ts`, `materials.test.ts`, `bulk.test.ts`, `readout.test.ts`.

**Interfaces (produces):**

- `interface PileFigure { capture: string; netM3: number; cutM3: number; fillM3: number; status: 'ok' | 'partial' | 'stale' | 'refused' | 'carried' }`; `figureOn(m: SurveyMeasurement, capture: string): PileFigure | null` (the stored result when it is that capture's, else the `series` row for it, else null).
- `densityOn(material: SiteMaterial, capture: string, dateOf: (capture: string) => number | null): number | null` (latest `densityHistory` entry whose capture date is on or before the date; before the first entry, the first entry; no history: `densityTPerM3`; an undated capture: `densityTPerM3`).
- `withDensityFrom(material: SiteMaterial, fromCapture: string, tPerM3: number, earliestCapture: string, dateOf): SiteMaterial` (first edit seeds `{ fromCapture: earliestCapture, tPerM3: densityTPerM3 }` when there was a density; replaces an entry with the same capture; sorts by date; sets `densityTPerM3` to the newest entry's value).
- `MATERIAL_PALETTE: readonly string[]` (eight CSS custom property names `--mat-1` to `--mat-8`) and `materialColour(m: SiteMaterial, index: number): string` (`m.colour` or the palette entry).
- `interface MaterialGroup { material: SiteMaterial | null; colour: string; volumeM3: number; tonnes: number | null; deltaM3: number | null; piles: { id: string; label: string; volumeM3: number; tonnes: number | null; deltaM3: number | null }[] }`; `inventoryByMaterial(piles: readonly SurveyMeasurement[], capture: string, previous: string | null, materials: readonly SiteMaterial[], dateOf): MaterialGroup[]` (groups by volume, piles by volume, "No material" last with null tonnes).
- `foldSmall<T extends { netM3: number }>(rows: readonly T[], keep?: number): { shown: T[]; folded: { count: number; withinM3: number } | null }` (keep default 13, sorted by net ascending; `withinM3` is the largest folded |net| rounded up to a whole m³).
- `primaryText(m, opts?: { capture?: string })` uses `figureOn` when a capture is given; the headline row carries a status note for carried, stale, partial and refused results.

- [ ] Step 1: tests: `figureOn prefers the stored result for its own date and the series row for another date, null when absent`; `densityOn` (before, on, after an entry; undated capture; no history) and Review Focus 3 and 4 cases; `withDensityFrom seeds the earlier density from the earliest survey and keeps densityTPerM3 at the newest`; `inventoryByMaterial groups, sorts, subtotals and puts No material last`; `foldSmall keeps 13 and reports +6 within 35`; `primaryText with a capture shows that date's figure`; `a carried headline says it is from an earlier version` (and refused, partial).
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(survey): figures and densities on a survey date, inventory by material`.

### Task C4a: strip model, player and compare pair

**Files:** Create in `apps/desktop/src/renderer/workspace/dates/`: `stripModel.ts`, `datesPlayer.ts`, `compareDates.ts`. Tests: `stripModel.test.ts`, `datesPlayer.test.ts`, `compareDates.test.ts`.

**Interfaces (produces):**

- `stripScale(dates: readonly number[], widthPx: number, pad?: number): { x(t: number): number; t(x: number): number; t0: number; t1: number }` (pad default 0.04 of the span each side; undated captures are never passed; one date gives a 30-day window centred on it).
- `monthTicks(t0: number, t1: number): { t: number; label: string }[]` (first of each month, label "Dec 2020" from the locale).
- `snapToSurvey(t: number, dates: readonly number[]): number` (nearest).
- `type StripMode = 'volume' | 'tonnes' | 'cutFill'`; `stackSeries(groups by date, mode)`, `cutFillBars(pairs: { from: string; to: string; cutM3: number; fillM3: number }[], scale)`, `yTicks(max: number): number[]` (three ticks, "80k" style labels through `formatCompact`).
- Player store `datesPlayer`: `{ playing: boolean; speed: 0.5 | 1 | 2 | 4; loop: boolean; t: number | null; between: 'crossfade' | 'swipe' | 'hold'; play(); pause(); setSpeed(); toggleLoop(); seek(t); setBetween(); tick(dtMs: number, dates: readonly number[]) }`, and the pure `advance(t: number, dates: readonly number[], dtMs: number, speed: number, loop: boolean): { t: number; passed: number; next: number | null; f: number; ended: boolean }` with `GAP_MS_AT_1X = 2000` (each gap between consecutive surveys takes 2 s at 1×, whatever its length in days).
- `compareDates` store: `{ on: boolean; from: string | null; to: string | null; set(from, to); toggle() }` with defaults from the focus (the survey before it, and it).

- [ ] Step 1: tests: scale round-trip and padding; one date; month ticks across a year end; snap; `advance` takes 2 s per gap at 1× and 1 s at 2×, reports `f` 0.5 at the middle, stops at the end without loop and wraps with loop; undated captures excluded (Review Focus 3); compare defaults and swap when from is after to.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(workspace): the dates strip's scale, player and compare pair`.

### Task C5a: map raster blend

**Files:** `packages/maps/src/controller.ts` (`applyRasterDisplay` :1276-1290, `applyVisibility` :1293-1297, pyramid loading :858-859), `packages/maps/src/index.ts`. Test: `packages/maps/src/controller.test.ts`.

**Interfaces (produces):** `MapController.setRasterBlend(blend: readonly { layerId: string; opacity: number }[] | null): void`: while set, those layers are visible (their pyramid tiles load) with the given `raster-opacity`, overriding `hidden` and `rasterOpacity`; `null` restores the normal display.

- [ ] Tests `blend shows a hidden layer with the given opacity`, `null restores visibility and opacity`, `a blended hidden layer loads its pyramid tiles`. FAIL, implement, PASS, commit `feat(maps): blend two raster layers for a crossfade`.

### Task C3: figures follow the date; Stockpiles group

**Files:** Modify `apps/desktop/src/renderer/survey/measureRows.ts` (`needsDate` :22-29, `buildMeasureItems` :58-75), `apps/desktop/src/renderer/shell/Sidebar.tsx` (:309-369), `apps/desktop/src/renderer/survey/measureScene.ts` (`labelText` :168, :187), `apps/desktop/src/renderer/workspace/pileFigures.ts`, `apps/desktop/src/renderer/survey/VolumesView.tsx` (`BulkTotals` row :286). Tests: `measureRows.test.ts`, `shell/Sidebar.measures.test.tsx`, `measureScene.test.ts`, `pileFigures.test.ts`, `VolumesView.test.tsx`.

**Interfaces:** Consumes `figureOn`, `primaryText(m, { capture })`, `foldSmall`. Produces `stockpileItems(measurements: readonly SurveyMeasurement[], capture: string | null, mode: 'volume' | 'net' | 'material'): SidebarItem[]` (spec section 5 "Stockpiles in the sidebar"); `needsDate` returns false for site-scoped piles.

- [ ] Step 1: tests: `the same pile shows different figures on two dates in the sidebar row, the scene label and the Volumes card`; `kit piles are no longer under Needs a date and sit in Stockpiles with "19 · 10 Jan"`; `rows sort by the date's volume, ten shown then "+ 9 more"`; `net mode sorts by loss`; `totals use the date in focus, not the latest`.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `fix(volumes): pile figures and totals follow the date in focus`.

### Task C7: Cut & fill pane (board 4)

**Files:** Create `apps/desktop/src/renderer/survey/volumes/CutFillPane.tsx`, `apps/desktop/src/renderer/survey/volumes/cutFill.ts`, `apps/desktop/src/renderer/survey/heatLegend.tsx`. Modify `apps/desktop/src/renderer/survey/engineServe.ts` (`site` :184-219: honour `deadbandM`), `apps/desktop/src/renderer/survey/engineProtocol.ts` (`SiteRequest` :72 gains `deadbandM?: number`). Tests: `cutFill.test.ts`, `CutFillPane.test.tsx`, `engineServe.test.ts`.

**Interfaces:** Consumes `compareDates` (C4a), `foldSmall`, `compareItem` (`packages/survey/src/engine/compare.ts:374`) through the engine worker client, `heatRamp` (`calc/heatmap.ts:70`). Produces `cutFillByPile(piles, from: string, to: string, thresholdM: number, run): Promise<{ id: string; label: string; cutM3: number; fillM3: number; netM3: number }[]>` (one surface-to-surface comparison per pile ring with `deadbandM` and `useDeadband: true`), `CutFillPane()` (`data-testid="cutfill-pane"`), `HeatLegend({ from, to, thresholdM, rangeM })` (bottom-left float). Threshold default 0.10 m, kept per project in the renderer (`localStorage` key `stratlas.cutFill.<project>`, read in try/catch).

- [ ] Step 1: tests: `per-pile cut and fill use the threshold`; `whole site passes deadbandM to the engine`; `the pane shows Cut, Fill, Net with the pile count and the whole-site line with Inside piles`; `bars sort by net and fold the rest`; `From after To swaps`; `the legend reads "Height change 10 Jan minus 31 Dec"`.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(volumes): the Cut & fill pane with per-pile change and a threshold`.

### Task C8: Materials pane with dated density (board 5)

**Files:** Create `apps/desktop/src/renderer/survey/volumes/MaterialsPane.tsx`, `apps/desktop/src/renderer/survey/volumes/materialsDraft.ts`. Modify `apps/desktop/src/renderer/survey/Materials.tsx` (retire the dialog; keep its CSV import and export functions, moved into the pane), `apps/desktop/src/renderer/workspace/workbench/benches/MeasureBench.tsx` (:533: the materials button opens the Volumes tab's Materials pane). Tests: `MaterialsPane.test.tsx`, `materialsDraft.test.ts`, `Materials.test.tsx` (moved or deleted with the dialog).

**Interfaces:** Consumes C2 (`densityOn`, `withDensityFrom`, `materialColour`, `inventoryByMaterial`). Produces the `materialsDraft` store `{ draft: SiteMaterial[] | null; edit(id, patch); setDensityFrom(id, fromCapture, tPerM3); assign(id, pileIds); cancel(); save(): Promise<void> }` (save writes `settings.materials` and each assigned pile's `material`), and `MaterialsPane()` (`data-testid="materials-pane"`).

- [ ] Step 1: tests: `the table shows density, swell, piles, m³ and tonnes per material and All materials`; `editing density from 10 Jan shows the impact line and leaves 31 Dec tonnes as they were`; `Save writes densityHistory and densityTPerM3 equal to the newest entry`; `Cancel drops the draft`; `Assign piles moves a pile from another material`; `CSV import and export still work` (the cases from `materials.spec.ts`).
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(volumes): the Materials pane with densities from a survey date`.

### Task C9: folded fixes

**Files:** `apps/desktop/src/renderer/charts/TimeChart.tsx` (`PAD` :65, y title :421, x labels :416, stack colours `partFill` :259-265), `apps/desktop/src/renderer/survey/card/VolumeDetail.tsx` (:745 label), `apps/desktop/src/renderer/survey/card/MeasureCard.tsx` (:87), `apps/desktop/src/renderer/survey/card/slots.tsx` (:152-158 area card sections), `apps/desktop/src/renderer/survey/Calculators.tsx` (:30 bail-out), `apps/desktop/src/renderer/survey/card/baseNames.ts` (`KIT_BASES` :59), `packages/volumetric/src/components/VolumetricStage.tsx` (:68, :95-98, `KIT_BASE_NAME` :251), `packages/volumetric/src/model/dsm.ts` (`CHANGE_RAMP` :81-88). Tests: `TimeChart.test.tsx`, `VolumeDetail.test.tsx`, `MeasureCard.test.tsx`, `slots.test.tsx`, `baseNames` test, `packages/volumetric/src/model/dsm.test.ts`.

- [ ] Step 1: tests: `the y title stays inside the chart` (title x ≥ 0 for a long title); `x labels are at least 56 px apart`; `stack parts take material colours`; `the card row reads "Cut + fill"`; `a live card shows the status chip`; `an area card without volume items shows no material, swell or weighed tonnage`; `the kit tin base reads "Triangulated toe"`; `the kit change ramp follows the survey heat map settings and the legend uses the project's units`.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `fix(volumes): chart clipping, one meaning of total, base names and status on live cards`.

### Task C4b: dates strip component and slot (boards 1, 2, 4, 5, 7)

**Files:** Create `apps/desktop/src/renderer/workspace/dates/DatesStrip.tsx`, `apps/desktop/src/renderer/workspace/dates/datesStrip.css`. Modify `apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx` (:99-108 `.tl-wrap` branch), `apps/desktop/src/renderer/workspace/timelinePref.ts` (:10-21), `apps/desktop/src/renderer/styles.css` (`.ws` rows :1689-1691 only if needed). Tests: `DatesStrip.test.tsx`, `timelinePref.test.ts`.

**Interfaces:** Consumes C4a, `useInventory` series, `figureOn`, `materialsDraft`, `useSurfaceStates`, the renderer timeline store (`focusSurvey`, `step`). Produces `bottomSlot(x: { hasVideo: boolean; datedCaptures: number; hasVolumes: boolean; pref: 'dates' | 'footage' | null; shown: boolean }): 'dates' | 'footage' | 'none'` and `DatesStrip()` (`role="region"`, `aria-label` from `strip.region`, 160 px, collapsed 30 px remembered per project as `stratlas.datesStrip.collapsed`).

- [ ] Step 1: tests: `bottomSlot` table (no video and 2 dates: dates; one date: none; video: pref, default dates with volumes, footage without); `the strip draws a marker per survey and month gridlines`; `dragging the playhead focuses the nearest survey`; `Compare draws the band with its label and brackets move it`; `Tonnes uses the draft density and says preview, unsaved`; `a selected pile shows its line, the faded total and the Pile chip that clears it`; `a preparing date shows hatched with its percentage`; `collapse is remembered`.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(workspace): the dates chart strip under the stage`.

### Task C6a: Volumes bench: header, segments, Inventory (board 1)

**Files:** Modify `apps/desktop/src/renderer/workspace/workbench/benches/VolumesBench.tsx`. Create `apps/desktop/src/renderer/survey/volumes/VolumesHeader.tsx`, `apps/desktop/src/renderer/survey/volumes/InventoryPane.tsx`. Retire `apps/desktop/src/renderer/survey/VolumesView.tsx` (its folder filter and CSV export move to the header's Export; its tests move to `InventoryPane.test.tsx`). Tests: `VolumesBench.test.tsx`, `VolumesBench.panel.test.tsx`, `InventoryPane.test.tsx`, `VolumesHeader.test.tsx`.

**Interfaces:** Consumes C3, C7 `CutFillPane`, C8 `MaterialsPane`, B5a `PilePanel`, C2 `inventoryByMaterial`. Keeps test ids `volumes-view` (bench root), `volumes-pile` (pile rows, `data-id`), `volumes-inventory-table`; adds `volumes-segment`, `volumes-kpi`.

- [ ] Step 1: tests: `the header shows the date in focus, volume, tonnes and change`; `Inventory groups by material with subtotals, four piles then "+ 2 more", and Site total`; `a row opens the pile panel; ‹ Inventory comes back`; `the segment switches to Cut & fill and Materials`; `no kit controls above the inventory` (replaces the old `VolumesBench.test.tsx:59-98` expectations).
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(volumes): the Volumes tab with Inventory, Cut & fill and Materials`.

### Task C6b: Show control; notch Volumes row and kit controls

**Files:** Create `apps/desktop/src/renderer/workspace/StageShow.tsx`. Modify `apps/desktop/src/renderer/workspace/Stage.tsx` (mount top-left while the Volumes bench is open), `apps/desktop/src/renderer/workspace/island/groups.tsx` (`SURFACES`/`BODIES` :560-569, `KitVolumeRow` :580-635: drop the date and Surface choices, keep Swipe, bodies and the section line), `apps/desktop/src/renderer/workspace/VolumeTools.tsx` (`VolumeDateSwipe` :33-70, `VolumeSurfaces` :132, `SECTION_LINE_LABEL` :209 to `vol.sectionLine`, "Swipe" :66 to `vol.swipe`). Tests: `StageShow.test.tsx`, `island/groups.test.tsx`, `VolumeTools.test.tsx`.

**Interfaces:** Produces `StageShow()` (`role="group"`, label `show.caption`; Photo / Elevation / Cut & fill write the volumetric `surface` for kit projects and the layer display for others; Outlines and Labels toggles; on the Materials pane it renders "Colour piles by").

- [ ] Step 1: tests: `Show switches Photo, Elevation and Cut & fill`; `the notch Volumes row has no date or Surface choice`; `strings come from the catalogue` (no "Swipe" literal); `the Show control does not cover the view at 1100 x 700` (unit: it sits in a corner box ≤ 260 x 80 px).
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(volumes): one Show control on the stage; no duplicate kit controls`.

### Task C5b: timelapse (board 6)

**Files:** Create `apps/desktop/src/renderer/workspace/dates/timelapse.ts`, `apps/desktop/src/renderer/workspace/dates/TimelapseFloats.tsx`. Modify `apps/desktop/src/renderer/workspace/island/IslandDate.tsx` ("Playing · {date}"), `apps/desktop/src/renderer/survey/volumes/InventoryPane.tsx` and `VolumesHeader.tsx` ("last survey passed", Next survey tile, note), `apps/desktop/src/renderer/workspace/Stage.tsx` (mount floats). Tests: `timelapse.test.ts`, `TimelapseFloats.test.tsx`, `IslandDate` test.

**Interfaces:** Consumes `datesPlayer` (C4a), `setRasterBlend` (C5a), volumetric `setSwipe` for kit projects. Produces `connectTimelapse(deps): () => void`: on each tick, the focus is the last survey passed (`focusSurvey`), the Map blends the passed and next orthos with opacities 1 − f and f (Crossfade), the 3D view switches at f = 0.5 (Crossfade) or at the next survey (Hold), Swipe drives the kit swipe at f; on pause, a manual date change, a pile click or Esc it stops and calls `setRasterBlend(null)`.

- [ ] Step 1: tests: `crossfade sets both opacities from f`; `hold keeps the earlier date until the next survey`; `3D swaps at the middle with crossfade`; `a manual date change stops playback and clears the blend`; `the notch reads Playing · 5 Jan 2021`; `the panel shows the last survey passed and never a value between surveys`; `Swipe is hidden without the kit`.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS. Step 5: commit `feat(workspace): play through the survey dates in 3D and on the map`.

### Task C10: e2e and docs, Stage C

**Files:** Create `apps/desktop/e2e/dates-strip.spec.ts`, `apps/desktop/e2e/volumes-tab.spec.ts`. Modify `volumetric-build.spec.ts` (:136-143 "Surface colours" to the Show control), `materials.spec.ts` (dialog to the Materials pane), `volume-over-time.spec.ts` (inventory chart now in the strip: `[aria-label="Survey dates chart"] g[data-stack]`), `stockpile-date.spec.ts` (the footage timeline check stays; add the strip present with two dates), `timeline.spec.ts` and `island.spec.ts` (stage shorter by the strip: the date stays put), `volumes-general.spec.ts` (`survey-bulk-net` location), `survey-reports.spec.ts` (tonnes per date with a dated density), `timeline-lanes.spec.ts` (Dates | Footage switch).

- [ ] Step 1: `dates-strip.spec.ts` (quarry demo): `two or more dates show the strip; its markers match the survey dates`; `dragging the playhead moves the notch date and the pile figures`; `Compare shows the band and its change`; `play steps through every date and stops at the end; loop wraps`; `a selected pile shows its line and the Pile chip clears it`; `in a project with video the switch shows Dates and Footage and remembers the choice` (tiny video fixture as `timeline-lanes.spec.ts`); `the strip and floats do not cover the view at 1100 x 700`.
- [ ] Step 2: `volumes-tab.spec.ts` (quarry demo): `Inventory groups piles by material with a site total that matches the sum`; `Cut & fill with Inside piles and Whole site, the threshold changes the totals`; `a density from the latest survey changes only that date's tonnes and History shows both densities`; `the Show control switches to Elevation and Cut & fill`.
- [ ] Step 3: run all new and changed specs the CI way (`--repeat-each=3` on the two new ones); expect PASS. Step 4: commit `test(e2e): dates strip, timelapse and the Volumes tab`.

### Task C11: verification, Stage C

- [ ] `pnpm check`; the CI-way run of every spec in C10 plus `compare`, `split-resize`, `small-window`, `stage-overlays`, `a11y`, `kit-migration`, `pile-panel`, `linked-hover`; `/wrapup`; finish and merge per `CLAUDE.md` (this branch touches many files: merge last and say so in the announcement).

---

## Contract changes

Rows for `docs/architecture/contract-changes.md` (header `| Date | Change | Why | Streams affected | Approved by |`), one per stage that changes contracts.

**Stage A (Task A1):**

| 2026-10-24 | `MeasurementsFile` gains optional `kitHeightsRepaired` (array of measurement ids, max 5000): converted kit piles whose all-zero heights were set from the kit DSM or the prepared surface, so the one-time repair never runs twice. `Settings` gains optional `autoPrepareSurfaces` (boolean; absent means on): prepare survey surfaces in the background when a project opens. Behaviour: converted kit piles are stored with real heights; once a converted pile's dates all have prepared surfaces the app accepts the standard base on its own (ADR 0013 point 4 amended), keeping the kit figure in `previousResults`. Older builds keep both fields (loose objects) and show the accepted figure as an ordinary engine result. | Converted piles sat at minus the origin height in 3D and seeded custom bases at 0; cards showed "No survey data" until Prepare surfaces ran | S2 UI, survey | Founder, 24 Oct 2026 |

**Stage C (Task C1):**

| 2026-10-24 | `SiteMaterial` gains optional `colour` (`#rrggbb`) and optional `densityHistory` (`{ fromCapture, tPerM3 }[]`, max 100, unique `fromCapture`): a density applies from that survey date until the next entry; earlier dates keep theirs. `densityTPerM3` stays and is written as the newest entry's value, so older builds show the current density for every date. Package APIs, no schema change: `@aio/survey` exports `figureOn`, `densityOn`, `withDensityFrom`, `materialColour`, `MATERIAL_PALETTE`, `inventoryByMaterial`, `foldSmall`, `pileAxis`, `rotateAxis`, `moveAxisEnd`, `drapeZ`, `kitEpochOf`, `needsHeightRepair`, `repairKitHeights`; `primaryText` takes an optional `{ capture }`; `@aio/maps` `MapController.setRasterBlend`. | Tonnes by material per survey date with densities that change over time; material colours for the inventory, strip and map | S2 UI, survey, maps | Founder, 24 Oct 2026 |

Stage B has no contract change (renderer-only state); its package API (`pileAxis` and friends) is listed in the Stage C row if Stage B lands without a row, or gets its own "Package APIs, no `@aio/schema` change" row in B8 if the founder wants each stage recorded.

## e2e specs

| Spec                                                                                                                           | Stage | New or changed | What it proves                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------- | -------------------------------------------------------------------- |
| `kit-migration.spec.ts`                                                                                                        | A, B  | changed        | real heights, one-time repair, package in memory; pile panel on pick |
| `surfaces-auto.spec.ts`                                                                                                        | A     | new            | quiet prepare on open, setting off, cancel, chip states, no cover    |
| `measure-card.spec.ts`                                                                                                         | A     | changed        | no "No survey data" for an unprepared date                           |
| `pile-panel.spec.ts`                                                                                                           | B     | new            | panel from list, 3D and Map; tabs; Esc                               |
| `linked-hover.spec.ts`                                                                                                         | B     | new            | chart to scene, scene to chart, pin, fly, Split, section window      |
| `profile-chart.spec.ts`                                                                                                        | B     | changed        | click pins                                                           |
| `sections.spec.ts`                                                                                                             | B     | changed        | non-modal window, Add pin here                                       |
| `volume-over-time.spec.ts`                                                                                                     | B, C  | changed        | pile panel; inventory stack in the strip                             |
| `dates-strip.spec.ts`                                                                                                          | C     | new            | strip, playhead, compare, play, pile line, video switch              |
| `volumes-tab.spec.ts`                                                                                                          | C     | new            | Inventory, Cut & fill, dated density, Show                           |
| `volumetric-build`, `materials`, `stockpile-date`, `timeline`, `island`, `volumes-general`, `survey-reports`, `timeline-lanes` | C     | changed        | moved controls and the shorter stage                                 |

## How to test (founder walkthrough, per stage)

**Stage A**

1. Open the two-date stockpile project in 3D: pile outlines sit on the piles, not below the ground.
2. Watch the bottom-left: "Preparing survey surfaces" lists both dates with percentages; Jobs shows one job you can cancel.
3. Open a line's card: both dates show as chips, preparing then ready; no "No survey data".
4. When preparing ends, the pile figures change to the standard base (63 402 m³ total on the later date in the mock-ups' example); a pile's card says nothing about an earlier version any more.
5. Settings > Processing tools: turn off "Prepare survey surfaces when a project opens", reopen another project: nothing starts and chips offer Prepare.

**Stage B**

1. Click a pile in 3D: the Volumes tab opens on that pile with volume, tonnes and the change.
2. Profile tab: both dates over the pile's long axis; drag ↻ in 3D to turn the line; the chart follows.
3. Hover the chart: dots, a dashed gap and "42.3 m · −1.63" on the pile; move the pointer onto the line in 3D: the chart follows. Click to pin, Esc to clear, double-click to fly.
4. Split 3D and Map: the point moves in both and in the chart.
5. History tab: one row per date with density and tonnes, and the old kit figure as "was".

**Stage C**

1. The dates strip under the stage shows the site's volume by material; drag the playhead to the earlier date: the notch, the sidebar Stockpiles and the pile labels all change.
2. Press play: the map crossfades from one date to the next; figures change only at survey dates.
3. Volumes tab > Cut & fill: pick From and To, Inside piles, change Ignore under: totals and bars update, the map shows the heat map.
4. Materials: change a density from the later date, Save: tonnes change for that date only; the pile's History shows both densities.
5. Show: Photo, Elevation, Cut & fill switch the stage; there are no date or surface buttons left in the Volumes tab.

## Follow-ups (not in this plan)

- Calibrate from weighbridge (board 5 button; founder: later).
- Persist a pile's profile line angle in the project.
- The assistant's `loadPiles` (`packages/ai/src/analysis-tools.ts:137`) still opens converted piles without the repaired heights in memory; figures are unaffected.
- Swipe during timelapse for projects without the kit.
- Weighed tonnage is still memory-only (`compareStore.ts:117`).
- A BVH for terrain meshes (slow terrain area without prepared surfaces), from the parity follow-ups.
