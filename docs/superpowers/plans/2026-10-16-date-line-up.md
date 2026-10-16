# Line up dates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Line up a whole survey date with another, once, and have every view and every job use the corrected position: a measured sideways shift saved on the date that moves, offered by a background notice and from the Changes panel, shown before and after saving, with Undo.

**Architecture:** The correction is one optional field, `lineUp`, on a capture in `manifest.captures[]`: an absolute shift in metres east and north in the project frame, plus the date it was lined up with. Nothing is written into files or into stored coordinates. One resolver per language (`@aio/workspace` `layerDateShifts`, Python `aio_pipelines.captures.date_shift`) says which layer takes which shift, from the same membership rules, pinned by one shared fixture. Every reader of a position adds the shift after the layer's own placement (local frame: `x += east`, `z -= north`; project CRS: `E += east`, `N += north`); every writer of something drawn on a date subtracts it, so stored coordinates never depend on when an item was drawn. A new pipeline job, `change.lineup`, measures the shift coarse to fine with the existing phase correlation; a renderer store runs the step, saves through `builder:updateCapture`, and shows the notice with Undo, like Drop to ground.

**Tech Stack:** TypeScript (zod schema, zustand stores, three.js engine, MapLibre map, Cesium globe, React, Vitest), Electron e2e (Playwright), Python pipelines (numpy, scipy, scikit-image, rasterio, PDAL, pytest).

**Spec:** `docs/superpowers/specs/2026-10-16-date-line-up-design.md` (approved by the founder on 16 Oct 2026, including every "My call"). Executors read both.

## Decisions (for the founder)

Calls 1 to 16 of the spec stand. These are the choices the spec left to the builder, and the places where the code differed from the recon:

1. **Field:** `Capture.lineUp?: { eastM, northM, with, spreadM?, at }`. `eastM`/`northM` is the absolute shift of the date (call 3), each within -500..500 m, rounded to the millimetre; `with` is the capture it was lined up with when saved (shown as "Lined up with ...", never followed: call 11); `spreadM` the measurement's spread; `at` an ISO time. Absent means no shift. Written only through `builder:updateCapture` with `{ lineUp }` (`null` removes it), so the journal, the backup and the manifest save are the ones a date rename already uses.
2. **Which layers take a date's shift:** the layers `captureIndex(manifest)` (no volume hints) files under that date, of the dated kinds (`mesh`, `pointcloud`, `raster`, `photos`, `panoramas`, `video`, `walk`, `vector`), never a change result (`derived.kind === 'change'`, computed in the lined-up frame already). The recon's `captureIndex(manifest, hints)` cannot be computed in main, in `@aio/engine` or in Python (the hints come from the volumetric store), and Python's `frames.layer_capture` uses other name rules. So: TS and Python both resolve without hints, the Python port follows `captureIndex` rules 1 and 3 exactly, and a shared fixture holds them to the same answers. A volumetric project's layers that only the hints file under a date get an explicit `capture` written in the same save as the line-up (one `builder:updateLayers` call, undone with it), so the hintless answer equals the hinted one for every layer that moves.
3. **Readers add, writers subtract.** Every place that turns a stored position into a drawn or computed one adds the shift after the layer's own placement (mesh `transform`, cloud frame origin and `heightOffsetM`, video `positionOffsetM`, photo corrections from `orientation.json`, raster `corners` or file georeference). Every place that saves an item drawn on a dated layer (sightings and their `.sel` selections, survey-scoped measurements, volume rings of an epoch, walk placements) subtracts its date's shift before writing. Helpers: `shiftLocal` / `unshiftLocal`, `shiftEN`, `shiftTransform`, `shiftCorners`, `shiftedLayer` in `@aio/schema` `dateShift.ts`.
4. **Drawn items follow their layer.** Every sighting kind has a `layer` (`annotation.ts`), including the point-cloud `selection` and the findings placed on a model (data-conventions 35), so a sighting takes its layer's shift. Survey measurements take the shift of `scope.capture` when `scope.kind === 'survey'`; site-scoped ones, section lines and terrain edits never move. Volume rings follow their epoch's `captureId`; a pile's `zoneRing` (both dates) never moves. Detections and image or frame sightings are in pixels and follow their photo. No schema change is needed for drawn items.
5. **Products of one date stay in that date's frame.** A job that makes a new dated layer from one date (a DSM or cleaned copy of a cloud, a surface from the date's cloud) reads without the shift and writes the date on the result, so the shift applies when it is read, like any layer. A job that combines a dated layer with anything else (change, survey preparation and export, engineering evidence, model fit, inspection, 3D Tiles) reads with the shift. 3D Tiles sets are not a dated kind: a set built before a line-up stays where it was (known limit, build it again), as for a cloud height offset.
6. **Measurement:** `change.lineup` reads both dates as currently placed (their stored shifts applied), so its answer is the correction still needed; the store adds it to the moved date's current shift (call 3). Orthos first; a date with no ortho uses its DSM's slope (`np.hypot` of the height gradient), not the raw heights. The recon said `register.py` already handles slopes: it does not (surface change high-passes the heights themselves), so slope is added here. Coarse to fine: a power-of-two coarse level chosen so `COARSE_SEARCH_M = 60` m fits in a tile's search (`step / 3`), then the full resolution on at most `MAX_FINE_TILES = 48` of the most textured tiles.
7. **Confidence** (constants in `register.py`, tested on synthetic shifts and a rotated copy): `ok` needs at least `MIN_TILES = 6` fine tiles and a spread of at most `MAX_SPREAD_PX = 1.0` px; fewer tiles is `texture`; a larger spread is `disagree`; a common footprint under `MIN_OVERLAP = 0.3` of the smaller date's is `overlap`; a correction within the tolerance (2 px of the coarser ortho cell) is `aligned`. Only `ok` can be saved.
8. **Background check:** on project open and on every manifest change, each pair of dates that both have an ortho (or DSM), with the date that most overlaps, is measured once per pair of layers; the pairs measured and the pairs answered "Not now" are kept per project in renderer `localStorage` (keys `quadrion.lineUp.measured`, `quadrion.lineUp.notNow`, 500 entries each, as `mapCoverage/offer.ts`). A project that already holds two misaligned dates is measured on its first open with this build. No pipeline Python: no check, no notice.
9. **Refusal in the Changes panel:** today the refusal is only a job's error text. `JobError` gains an optional `code` and `data`, written into `job.json` as `failure` and carried by `JobRecord.failure` (additive). Imagery and surface change raise `code: 'misaligned'` with `{ from, to, shiftM, shiftPx, eastM, northM }`; the panel shows "These dates are 2.01 m apart." with **Line up dates**, and after a saved line-up the same change run starts again by itself. The message in the job log becomes "... Line up the dates first."
10. **Out of date:** change sets have no fingerprint today. A set gains `lineUp?: { from?, to? }`, the shifts of its two dates when it was computed (pipeline and in-app producers). `changeSetStale(set, manifest)` compares them with the dates' current shifts (1 mm); the panel marks a stale set "Out of date" with **Run again**. Survey comparisons already have a fingerprint; the shifts join it.
11. **The step:** no date is chosen when it opens (call 2), so **Line up** stays disabled until one is. The preview is the overlap of the two orthos' overview level drawn on a canvas with a divider, the moved date drawn without (Before) or with (After) the correction.
12. **Exports and older builds:** `layer:export` sidecars carry `dateShiftM: { eastM, northM }` when the layer has a shift; files are never rewritten; packages carry the manifest as it is. Builds before this one open a project with `lineUp` (the capture object is not strict), show the date at its file position and drop the field on their next manifest save. Same treatment as `heightOffsetM`; pinned by a compat test.

## Global Constraints

- TypeScript strict, no `any`, no non-null assertions; packages export from `src/index.ts` and keep the SPEC section 2 dependencies: `@aio/globe` and `@aio/project` get shifts passed in (they do not depend on `@aio/workspace`); `@aio/engine`, `@aio/maps`, `@aio/pointcloud`, `@aio/video`, `@aio/volumetric`, `@aio/annotate`, `@aio/change` may call `@aio/workspace`.
- Renderer never imports `electron` or `node:*`.
- User-facing strings only in `packages/ui/src/i18n/en.ts` (Task 2 owns the file), no em or en dashes.
- Public repo: no client, site or person names in code, tests, docs or commits.
- Shifts: metres east and north, finite, `-500 <= v <= 500`, rounded to the millimetre where written (`Math.round(v * 1000) / 1000`, Python `round(v, 3)`). Local frame `x += eastM`, `z -= northM`; project CRS `E += eastM`, `N += northM` (data-conventions section 1).
- A shift is added after the layer's own placement and replaces none of it (spec call 10). Common layers, base maps, terrain and the street map never move (call 8).
- Shown distances: two decimals, `"2.01 m"`.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `pnpm check` green; Python suites touched green (`cd python; uv run pytest <files> -q`); changed e2e specs run the CI way (CONTRIBUTING.md, "End to end the way CI runs it") with `--workers=1`.
- Contract change: one row in `docs/architecture/contract-changes.md` (Task 1) covering every item in "Contract change" below.

## Review Focus

1. **Drawing on a date after it was lined up:** a pin, a selection, a survey measurement or a walk placement made on the moved date must be saved in the date's own frame, so Undo of the line-up takes it along with the date instead of leaving it 2 m off (Task 14 `stores a mesh sighting placed on a shifted date in the date's own frame`, Task 17 `saves a survey-scoped measurement without the shift`, Task 11 `saves a walk placement without the shift`).
2. **A dataset moved to another date after a line-up** (Belongs to date, drag onto a date folder): it takes the new date's shift at once and drops the old one (Task 3 `a layer moved to another date takes that date's shift`, Task 9 `recreates a layer when its date shift changes`).
3. **Lining up when the kept date is itself shifted, or when the person swaps which date stays put:** the saved shift is absolute and a third date lined up with either lands in the same place (Task 20 `plans an absolute shift when the kept date is already shifted`, `moves the other date when keep is swapped`).
4. **A change result on the moved date:** its layer carries the later date's `capture` but must never take the shift (Task 3 `a change result never takes a shift`), and its set shows Out of date (Task 18 `marks a set stale when one of its dates was lined up after it`).
5. **A site the measurement cannot trust** (water, a rotated ortho, dates that hardly overlap, a site that is already aligned): no save, a plain reason (Task 19 tests `refuses a rotated copy`, `refuses a flat image`, `refuses dates that hardly overlap`, `answers aligned for dates already lined up`).

---

## Execution DAG

| Task | Title                                                    | Depends on | Packages                                        | Model                |
| ---- | -------------------------------------------------------- | ---------- | ----------------------------------------------- | -------------------- |
| 1    | Schema: capture field, shift helpers, change set, docs   | none       | `@aio/schema`, compat, docs                     | sonnet               |
| 2    | Strings                                                  | none       | `@aio/ui` (en.ts)                               | haiku                |
| 3    | Workspace resolver                                       | 1          | `@aio/workspace`                                | sonnet               |
| 4    | Python resolver                                          | 1          | python                                          | sonnet               |
| 5    | Job failure codes                                        | 1          | python runtime, `@aio/schema` (jobs), main      | sonnet               |
| 6    | Pipelines: imagery and surface change                    | 4, 5       | python                                          | opus                 |
| 7    | Pipelines: cloud, mesh and frame change                  | 4          | python                                          | sonnet               |
| 8    | Pipelines: survey, tiles, inspection, engineer, modelfit | 4, 6       | python                                          | sonnet               |
| 9    | Engine: layer sync and rasters                           | 3          | `@aio/engine`                                   | opus                 |
| 10   | Point clouds                                             | 3          | `@aio/pointcloud`, desktop renderer             | sonnet               |
| 11   | Video, volumetric, walks                                 | 3          | `@aio/video`, `@aio/volumetric`, renderer walks | sonnet               |
| 12   | 2D map                                                   | 3          | `@aio/maps`                                     | sonnet               |
| 13   | Globe                                                    | 3          | `@aio/globe`, renderer globe                    | sonnet               |
| 14   | Annotate: pins, drapes, crossview, sighting writers      | 3          | `@aio/annotate`                                 | opus                 |
| 15   | Project writer, extents, sidecar, main                   | 3          | `@aio/project`, desktop main                    | sonnet               |
| 16   | Renderer placement helpers                               | 3          | desktop renderer                                | sonnet               |
| 17   | Survey measurements and placed findings                  | 3          | desktop renderer                                | sonnet               |
| 18   | Change package: in-app shifts, staleness, panel states   | 2, 3       | `@aio/change`                                   | sonnet               |
| 19   | Measure job `change.lineup`                              | 5, 6       | python, `@aio/schema` (jobs), renderer jobs.ts  | opus                 |
| 20   | Line-up store, step, notice, background check            | 2, 3, 15   | desktop renderer                                | opus                 |
| 21   | Wiring: job, Changes panel, date folder                  | 18, 19, 20 | desktop renderer                                | sonnet (opus review) |
| 22   | Docs: guide and known limits                             | 20         | docs                                            | haiku                |
| 23   | End to end specs                                         | all        | desktop e2e                                     | sonnet               |

**Parallel batches** (no shared files inside a batch; dispatch each batch in one message):

- **Batch A:** 1, 2
- **Batch B:** 3, 4, 5
- **Batch C:** 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18
- **Batch D:** 8, 19, 20
- **Batch E:** 21, 22
- **Batch F:** 23, then the whole-branch review and `pnpm check`

**Critical path:** 1 -> 4 -> 6 -> 19 -> 21 -> 23 (and, as long, 1 -> 3 -> 15 -> 20 -> 21 -> 23).

**Shared-file owners** (only this task edits the file): `packages/ui/src/i18n/en.ts` Task 2; `docs/architecture/contract-changes.md` and `data-conventions.md` Task 1; `packages/schema/src/jobs.ts` Task 5 (`JobRecord.failure`) then Task 19 (pipeline name and params), never in one batch; `python/src/aio_pipelines/captures.py` Task 4; `python/src/aio_pipelines/change/sources.py`, `imagery.py`, `register.py` Task 6 then Task 19; `python/src/aio_pipelines/change/changeset.py` Task 6; `python/src/aio_pipelines/pipelines.py` Task 19; `apps/desktop/src/renderer/jobs.ts` Task 19; `apps/desktop/src/renderer/exports/Toasts.tsx` and `App.tsx` Task 20; `apps/desktop/src/renderer/change/producers/raster.ts` Task 21; `apps/desktop/e2e/fixtures.ts` Task 23.

**Contract change** (Task 1 writes the row; the tasks in brackets build each part): `Capture.lineUp` and `CapturePatch.lineUp` [1, 15]; `@aio/schema` `dateShift.ts` helpers and the optional third argument of `cloudFrameOrigin` [1]; `ChangeSet.lineUp` [1, 6, 18]; `LineUpMeasure` [1, 19]; `JobRecord.failure` and `job.json` `failure` [5]; pipeline `change.lineup`, its params and its `lineup.json` result [19]; `layer:export` sidecar `dateShiftM` [15]. Builds before this one ignore all of them; they drop `lineUp` on their next manifest save.

**e2e specs:** new `apps/desktop/e2e/line-up-dates.spec.ts` (a copy of the change demo with its later date moved 2 m east, made by a new fixture; needs the pipeline Python for the measurement and change runs, skips without it). Neighbours rerun unchanged: `change-raster.spec.ts`, `change-demo.spec.ts`, `compare.spec.ts`, `change-core.spec.ts`, `drop-to-ground.spec.ts`, `align-to.spec.ts`.

---

### Task 1: Schema: capture field, shift helpers, change set, docs

**Files:**

- Modify: `packages/schema/src/manifest.ts` (`Capture`, about line 12)
- Modify: `packages/schema/src/builder.ts:259-276` (`CapturePatch` and its `refine` message)
- Create: `packages/schema/src/dateShift.ts`; modify `packages/schema/src/cloudFrame.ts`, `packages/schema/src/index.ts`
- Modify: `packages/schema/src/change.ts` (`ChangeSet`, about line 231)
- Create: `packages/schema/src/__fixtures__/date-shift/membership.json` (shared with Python, Task 4)
- Create: `tools/compat/date-line-up-additive.test.mjs` (pattern: `pointcloud-cleanup-additive.test.mjs`)
- Test: create `packages/schema/src/dateShift.test.ts`; `packages/schema/src/cloudFrame.test.ts`, `builder.test.ts`, `schema.test.ts`, `change.test.ts`
- Docs: `docs/architecture/contract-changes.md` (one row, 2026-10-16, Status "pending founder review"); `docs/architecture/data-conventions.md` new section 38 "Lined-up dates" (Decisions 1 to 5, 10, 12), one sentence each in sections 1 (shift after placement), 13 (the field and the patch) and 14 (`lineUp` on change sets)

**Interfaces:**

- Produces: `CaptureLineUp = z.object({ eastM, northM: z.number().min(-500).max(500), with: Id, spreadM: z.number().nonnegative().optional(), at: z.string().datetime() }).strict()`; `Capture.lineUp: CaptureLineUp.optional()`.
- Produces: `CapturePatch.lineUp: CaptureLineUp.nullable().optional()`; refine message `'Give label, colour, icon or lineUp'`.
- Produces in `dateShift.ts`: `interface DateShift { eastM: number; northM: number }`; `captureLineUpShift(c: Capture): DateShift | null`; `isZeroShift(s: DateShift | null | undefined): boolean` (both within 0.0005); `shiftLocal(p: Vec3, s: DateShift | null): Vec3`; `unshiftLocal(p: Vec3, s: DateShift | null): Vec3`; `shiftEN<T extends readonly number[]>(p: T, s: DateShift | null, sign?: 1 | -1): T` (first two entries are E, N); `shiftTransform(t: readonly number[] | undefined, s: DateShift | null): number[] | undefined` (column-major elements 12 and 14; identity when `t` is absent and the shift is not zero); `shiftCorners(c: RasterCorners, s: DateShift | null): RasterCorners`; `shiftedLayer(layer: Layer, s: DateShift | null): Layer` (mesh `transform`; raster `corners` when present; panoramas `items[].pos`; video `positionOffsetM` plus `[eastM, 0, -northM]`; every other kind returned as is, its reader applies the shift); all return the input unchanged for a null or zero shift.
- Produces: `cloudFrameOrigin(origin: Vec3, layer: { heightOffsetM?: number }, shift?: DateShift | null): Vec3` returning `[origin[0] - eastM, origin[1] - northM, origin[2] - heightOffsetM]`.
- Produces: `ChangeSet.lineUp: z.object({ from: DateShiftSchema.optional(), to: DateShiftSchema.optional() }).strict().optional()`.
- Produces in `change.ts`: `LineUpMeasure = { keep, move, layerKeep, layerMove: Id; source: 'ortho' | 'dsm'; eastM, northM, totalM, cellM, tolerancePx, spreadPx: number; tiles: number; verdict: 'ok' | 'aligned' | 'texture' | 'disagree' | 'overlap' }`, the `lineup.json` result of Task 19 (Task 20 types against it).
- Produces: fixture `{ cases: { name: string; manifest: ProjectManifest; expected: Record<string, DateShift> }[] }` with at least: explicit `capture`; a date token in the name; two dates in one name (common, no shift); a change result layer with a lined-up `capture` (no shift); a `basemap` with `capture` (no shift); a capture without `lineUp`; a layer whose explicit `capture` contradicts its name.

- [ ] **Step 1: Write the failing tests**
  - `dateShift.test.ts`: `it('moves a local point east and north')` (`shiftLocal([1, 2, 3], { eastM: 2, northM: 1 })` is `[3, 2, 2]`; `unshiftLocal` returns `[1, 2, 3]`); `it('shifts a column-major transform')` (elements 12 and 14 become `+2` and `-1`, others unchanged; absent transform gives an identity with them); `it('shifts raster corners and leaves a cloud as it is')`; `it('adds the shift to a video offset')` (`positionOffsetM: [0, 5, 0]` gives `[2, 5, -1]`); `it('returns the same object for no shift')` (`toBe`).
  - `cloudFrame.test.ts` `it('moves the frame origin against the date shift')`: `cloudFrameOrigin([500000, 3200000, 10], { heightOffsetM: -30.81 }, { eastM: 2, northM: -1 })` equals `[499998, 3200001, 40.81]`.
  - `schema.test.ts` `it('keeps a capture line-up')` and `it('refuses a line-up beyond 500 m')`; `builder.test.ts` `it('takes a lineUp patch and null')`; `change.test.ts` `it('keeps the shifts a change set was computed with')` and `it('parses a line-up measurement')`.
  - `date-line-up-additive.test.mjs`: the 0.11 schema parses a manifest with `captures[0].lineUp` and its output has no `lineUp` (the known drop); the current schema keeps it.
- [ ] **Step 2:** `pnpm --filter @aio/schema test -- dateShift cloudFrame schema builder change` and `npx vitest run tools/compat/date-line-up-additive.test.mjs`: the new ones FAIL.
- [ ] **Step 3:** Implement the field, the patch, the helpers and the fixture; export from `index.ts`.
- [ ] **Step 4:** Same commands, then `pnpm --filter @aio/schema typecheck`: PASS. `pnpm typecheck` at the root must stay green (the third argument is optional).
- [ ] **Step 5:** Write the contract row (every item of "Contract change" above, the older-build drop, packages `@aio/schema`, `@aio/workspace`, `@aio/project`, `@aio/engine`, `@aio/pointcloud`, `@aio/maps`, `@aio/globe`, `@aio/annotate`, `@aio/change`, `@aio/video`, `@aio/volumetric`, desktop, pipelines) and the data-conventions text.
- [ ] **Step 6:** Commit `feat(schema): line up survey dates`.

### Task 2: Strings

**Files:**

- Modify: `packages/ui/src/i18n/en.ts` (a `lineUp.*` block next to `drop.*`, about line 4095; `change.*` keys next to `change.run.surface`, about line 2417)
- Test: `packages/ui/src/i18n/*.test.ts` (existing key and dash checks)

**Interfaces:** Produces these keys, exact text:

- `'lineUp.title': 'Line up dates'`, `'lineUp.action': 'Line up dates'`, `'lineUp.confirm': 'Line up'`, `'lineUp.cancel': 'Cancel'`, `'lineUp.notNow': 'Not now'`
- `'lineUp.keep': 'Keep in place'`, `'lineUp.keepHint': 'Choose the date that stays where it is. The other date moves onto it.'`
- `'lineUp.measuring': 'Measuring how far apart the dates are...'`
- `'lineUp.shift': '{ew}, {ns} ({distance} in all)'`; `'lineUp.east': '{distance} east'`, `'lineUp.west': '{distance} west'`, `'lineUp.north': '{distance} north'`, `'lineUp.south': '{distance} south'`
- `'lineUp.confident': 'Confident: {tiles} matching areas agree within {spread}.'`
- `'lineUp.moves': 'Moves with {date}: {layers} and {items}.'`; `'lineUp.layers_one': '{count} dataset'`, `'lineUp.layers_other': '{count} datasets'`, `'lineUp.items_one': '{count} drawn item'`, `'lineUp.items_other': '{count} drawn items'`
- `'lineUp.before': 'Before'`, `'lineUp.after': 'After'`
- `'lineUp.done': '{moved} lined up with {kept} ({distance}).'`, `'lineUp.undone': 'Line-up undone.'`, `'lineUp.redone': 'Lined up again.'`, `'lineUp.removed': 'Line-up of {moved} removed.'`
- `'lineUp.offer': "{moved} doesn't line up with {kept}. Its {source} sits {distance} away."`, `'lineUp.source.ortho': 'ortho'`, `'lineUp.source.dsm': 'DSM'`
- `'lineUp.refuse.texture': 'These dates cannot be lined up: there is too little detail to match (water, snow or bare ground, for example).'`
- `'lineUp.refuse.disagree': 'These dates cannot be lined up: parts of them point to different shifts, so one may be turned or scaled against the other. Lining up only moves a date sideways.'`
- `'lineUp.refuse.overlap': 'These dates hardly overlap.'`
- `'lineUp.refuse.aligned': 'These dates already line up (within {distance}).'`
- `'lineUp.refuse.noImagery': 'Each date needs an ortho or a DSM to be lined up.'`
- `'lineUp.failed': 'The measurement did not finish: {error}'`
- `'lineUp.folder': 'Lined up with {kept} ({distance})'`, `'lineUp.remove': 'Remove line-up'`
- `'change.misaligned': 'These dates are {distance} apart.'`, `'change.stale': 'Out of date: a date was lined up after this was computed.'`, `'change.rerun': 'Run again'`

- [ ] **Step 1:** Add the keys.
- [ ] **Step 2:** `pnpm --filter @aio/ui test -- i18n` and `pnpm --filter @aio/ui typecheck`: PASS (no dashes, keys unique).
- [ ] **Step 3:** Commit `feat(ui): strings for lining up dates`.

### Task 3: Workspace resolver

**Files:**

- Create: `packages/workspace/src/dateShifts.ts`; modify `packages/workspace/src/captures.ts` (export `DATED_KINDS`), `packages/workspace/src/index.ts`
- Test: create `packages/workspace/src/dateShifts.test.ts`

**Interfaces:**

- Consumes: `captureIndex`, Task 1 `DateShift`, `captureLineUpShift`, the fixture.
- Produces: `layerDateShifts(m: Pick<ProjectManifest, 'captures' | 'layers'>): Readonly<Record<string, DateShift>>` (non-zero shifts only, Decision 2; memoised on the manifest object with a `WeakMap`); `dateShiftOf(m, layerId: string): DateShift | null`; `captureShift(m, captureId: string): DateShift | null`; `shiftKey(s: DateShift | null): string` (`''` for none, else `"<e>,<n>"` to the millimetre, for cache keys); `hintOnlyLayers(m, hints: CaptureHints, captureId: string): string[]` (layers the hinted index files under the date and the hintless one does not; Task 20 pins them).

- [ ] **Step 1: Write the failing tests:** `it('matches the shared membership fixture')` (every case: `layerDateShifts(c.manifest)` equals `c.expected`); `it('a change result never takes a shift')`; `it('a layer moved to another date takes that date's shift')` (set `capture` from d2 to d1: the shift follows); `it('finds layers only the volume hints date')`; `it('keys a shift to the millimetre')`.
- [ ] **Step 2:** `pnpm --filter @aio/workspace test -- dateShifts`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command, then `pnpm --filter @aio/workspace typecheck`: PASS.
- [ ] **Step 5:** Commit `feat(workspace): resolve the date shift of a layer`.

### Task 4: Python resolver

**Files:**

- Modify: `python/src/aio_pipelines/captures.py`
- Test: create `python/tests/test_captures_shift.py` (reads `packages/schema/src/__fixtures__/date-shift/membership.json` the way `test_changeset.py` reads the change fixtures)

**Interfaces:**

- Produces: `layer_captures(manifest: dict[str, Any]) -> dict[str, str]` (port of `captureIndex` rules 1 and 3 without hints: own `capture` when it names a known capture; else, with two or more captures and a dated kind, the one capture whose id or date spelling (`dateSpellings`, all 14 forms) the id or name carries as a whole token); `date_shift(manifest, layer_id: str) -> tuple[float, float]` (east, north; `(0.0, 0.0)` for none, a change result or an undated kind); `capture_shift(manifest, capture_id: str) -> tuple[float, float]`; `local_delta(shift) -> tuple[float, float]` (`(east, -north)`, for x and z); `shift_transform(t: list[float] | None, shift) -> list[float] | None`.

- [ ] **Step 1:** Tests: `test_shifts_match_the_shared_fixture` (parametrised over the cases); `test_date_spellings_match_the_workspace` (`"31 Dec 2020"`, `"20201231"`, `"December 31, 2020"` file a layer); `test_shift_transform_moves_elements_12_and_14`; `test_no_shift_for_a_change_result`.
- [ ] **Step 2:** `cd python; uv run pytest tests/test_captures_shift.py -q`: FAIL.
- [ ] **Step 3:** Implement. Leave `change/frames.py` `layer_capture` alone (its pairing is not about shifts).
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `feat(pipelines): date shift of a layer`.

### Task 5: Job failure codes

**Files:**

- Modify: `python/src/aio_pipelines/runtime.py` (`JobError` at line 42; `_manifest` at about 335 and the `except JobError` at about 453)
- Modify: `packages/schema/src/jobs.ts` (`JobRecord`, about line 1267)
- Modify: the main-process reader of `job.json` into `JobRecord` (`apps/desktop/src/main/jobs/runner.ts`; grep `error:` there)
- Test: `python/tests/test_runtime.py`, `apps/desktop/src/main/jobs/runner.test.ts`, `packages/schema/src/jobs.test.ts`

**Interfaces:**

- Produces: `JobError(message: str, *, code: str | None = None, data: dict[str, Any] | None = None)`; `job.json` gains `"failure": {"code": str, "data": dict}` when a coded `JobError` ends the job.
- Produces: `JobFailure = z.object({ code: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), data: z.record(z.string(), z.unknown()) })`; `JobRecord.failure: JobFailure.optional()`.

- [ ] **Step 1:** Tests: `test_job_error_code_reaches_job_json` (a step raising `JobError("x", code="misaligned", data={"shiftM": 2.01})`: `job.json` has `failure` and `error == "x"`); `test_plain_job_error_has_no_failure`; `runner.test.ts` `it('carries a failure code from job.json')`; `jobs.test.ts` `it('keeps a job failure code')`.
- [ ] **Step 2:** Run `uv run pytest tests/test_runtime.py -q`, `pnpm --filter @aio/schema test -- jobs`, `pnpm --filter @aio/desktop test -- runner`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same commands: PASS.
- [ ] **Step 5:** Commit `feat(jobs): failure codes a panel can act on`.

### Task 6: Pipelines: imagery and surface change

**Files:**

- Modify: `python/src/aio_pipelines/change/imagery.py` (`Ortho.__init__` about 175: shift `self.tl` by `local_delta`; `_sample_cog` about 347: `ds.transform` translated by `(east, north)`; `Ortho` gets the shift from `date_shift(manifest, layer["id"])` where it is built)
- Modify: `python/src/aio_pipelines/change/sources.py` (`grid_source` about 113: `x0 += east`, `y1 += north`; `cloud_source` passes the shift on)
- Modify: `python/src/aio_pipelines/change/surface.py` (`Surface.points` about 170: x and z by `local_delta`; `_dsm_heights` about 236 via the shifted grid transform; `surface_fingerprint` about 96 includes both shifts)
- Modify: `python/src/aio_pipelines/change/register.py` (`refusal` text) and `raster.py` (about 448) and `surface.py` `register` (about 463): raise `JobError(refusal(...), code="misaligned", data=...)`
- Modify: `python/src/aio_pipelines/change/changeset.py` (writes `lineUp` from the two captures' shifts when either is not zero)
- Test: `python/tests/test_change_raster.py`, `test_change_sources.py`, `test_change_surface.py`, `test_changeset.py`

**Interfaces:**

- Consumes: Task 4 `date_shift`, `capture_shift`, `local_delta`; Task 5 `JobError(code, data)`.
- Produces: `refusal(px, cell, max_px) -> str` = `f"The two dates are {px:.1f} px ({px * cell:.2f} m) apart; the largest shift allowed is {max_px:g} px. Line up the dates first."`; failure data `{"from", "to", "shiftM", "shiftPx", "eastM", "northM"}` where east and north say where the later date's content sits relative to the earlier one (content 2 m east gives `eastM ≈ +2`).

- [ ] **Step 1:** Tests: `test_ortho_reads_with_the_date_shift` (a kit-pyramid and a COG ortho with `lineUp` `{eastM: 2, northM: 0}` sample the same pixel 2 m east); `test_grid_source_carries_the_shift`; `test_surface_points_carry_the_shift` and `test_surface_fingerprint_changes_with_a_line_up`; `test_raster_refusal_has_the_misaligned_code` (synthetic pair 10.7 px apart: `failure.code == "misaligned"`, `abs(data["eastM"] - 2.0) < 0.1`, message ends `"Line up the dates first."`); `test_a_lined_up_pair_runs` (same pair, later date `lineUp: {eastM: -2, northM: 0}`: the job completes and `registration.shiftPx < 0.5`); `test_change_set_records_the_shifts`.
- [ ] **Step 2:** `uv run pytest tests/test_change_raster.py tests/test_change_sources.py tests/test_change_surface.py tests/test_changeset.py -q`: the new ones FAIL.
- [ ] **Step 3:** Implement; a layer's own placement first, then the shift.
- [ ] **Step 4:** Same command: PASS (the existing ones too).
- [ ] **Step 5:** Commit `feat(pipelines): imagery and surface change read lined-up dates`.

### Task 7: Pipelines: cloud, mesh and frame change

**Files:**

- Modify: `python/src/aio_pipelines/change/cloud.py` (`PdalSource(..., offset, shift)` about 666: fold east and north into the LAS header offsets in `read` about 743; the crop `bounds` about 862 and 893 and `_info` bounds take the shift back out; `context` about 866 collects shifts)
- Modify: `python/src/aio_pipelines/change/mesh.py` (`ChangeMesh.compare` about 137: `load_parts(path, shift_transform(transform, shift))`)
- Modify: `python/src/aio_pipelines/change/frames.py` (`_pose(item, delta=(0.0, 0.0))` about 192; `_pose_pairs` passes each photo layer's `local_delta`)
- Test: `python/tests/test_change_cloud.py`, `test_change_mesh.py`, `test_change_frames.py`

**Interfaces:** Consumes Task 4. The cloud change result keeps no shift (Decision 2).

- [ ] **Step 1:** Tests: `test_cloud_change_applies_the_date_shift` (cloud B = A moved 2 m east in the file, B's date `lineUp: {eastM: -2}`: distances about 0); `test_cloud_crop_bounds_are_in_file_coordinates`; `test_mesh_change_applies_the_date_shift`; `test_pose_pairs_use_shifted_positions` (two photos 2 m apart in the files, lined up: gap under 0.05 m).
- [ ] **Step 2:** `uv run pytest tests/test_change_cloud.py tests/test_change_mesh.py tests/test_change_frames.py -q`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `feat(pipelines): cloud, mesh and frame change read lined-up dates`.

### Task 8: Pipelines: survey, tiles, inspection, engineer, modelfit

**Files:**

- Modify: `python/src/aio_pipelines/survey/prepare.py` (`read_raster` about 150 shifts `ds.transform`; fingerprint about 494 includes the shift), `survey/export.py` (`export_surface` 629, `export_ortho` 736, `export_cloud` 803: exports carry the shift), `survey/compare.py` (comparison fingerprint includes the two dates' shifts); `survey/cleanup.py` stays unshifted (Decision 5) with a comment saying why
- Modify: `python/src/aio_pipelines/tiles/cloud.py` (`read_points` adds `local_delta`), `tiles/mesh.py` (the read step uses `shift_transform`)
- Modify: `python/src/aio_pipelines/inspection/frame.py` (`load_meshes` about 117)
- Modify: `python/src/aio_pipelines/engineer/pipeline.py` (`crop` about 299: cloud points and mesh transform), `engineer/cloud.py` (`_world_bounds(region, origin, offset_m, shift=(0.0, 0.0))` about 45)
- Modify: `python/src/aio_pipelines/modelfit/segment.py` (`load_layer_points` about 88, all formats)
- Test: `python/tests/test_survey_prepare.py`, `test_survey_export.py`, `test_survey_compare.py`, `test_tiles.py`, `test_inspection*.py` (the frame tests), `test_engineer_cloud.py`, `test_modelfit.py`

**Interfaces:** Consumes Task 4, and Task 6's shifted `grid_source`.

- [ ] **Step 1:** Tests, each with a dated layer whose date has `lineUp: {eastM: 2, northM: -1}` against the same layer without it: `test_prepare_reads_the_shift_and_reruns_on_it`; `test_export_carries_the_shift` (exported CRS bounds +2 E, -1 N); `test_comparison_is_stale_after_a_line_up`; `test_cloud_tiles_carry_the_shift`; `test_mesh_tiles_carry_the_shift`; `test_inspection_meshes_carry_the_shift`; `test_engineer_crop_carries_the_shift` (and its PDAL bounds stay in file coordinates); `test_fit_points_carry_the_shift`; `test_dtm_filter_stays_in_the_date_frame`.
- [ ] **Step 2:** Run those files with `uv run pytest ... -q`: the new ones FAIL.
- [ ] **Step 3:** Implement without applying the shift twice where `grid_source` already did.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `feat(pipelines): survey, tiles and model jobs read lined-up dates`.

### Task 9: Engine: layer sync and rasters

**Files:**

- Modify: `packages/engine/src/types.ts:284-288` (`AdapterContext`)
- Modify: `packages/engine/src/Stage.ts` (about 1146: the context gets `shiftOf` from `layerDateShifts` of the open manifest)
- Modify: `packages/engine/src/layers/layerSync.ts` (identity key at 24 adds `shiftKey`; `create` at 78-102 passes `shiftedLayer(layer, shift)`)
- Modify: `packages/engine/src/adapters/raster.ts` (`pyramidRaster` about 375-452: index corners through `shiftCorners`)
- Test: `packages/engine/src/layers/layerSync.test.ts`, `packages/engine/src/adapters/raster.test.ts`

**Interfaces:**

- Consumes: Task 3 `layerDateShifts`, `shiftKey`; Task 1 `shiftedLayer`, `shiftCorners`.
- Produces: `AdapterContext.shiftOf(layerId: string): DateShift | null` (Tasks 10, 11 and 16 read it). Mesh, image raster, panoramas and video take the shift through `shiftedLayer`; photos are left to the app's corrected-photos wrapper (Task 16) so the shift comes after the hand corrections; marker sites, bounds and callout anchors follow because they read the shifted layer.

- [ ] **Step 1:** Tests: `it('creates a dated mesh with the date shift in its transform')` (group matrix x +2, z +1 for `{eastM: 2, northM: -1}`); `it('recreates a layer when its date shift changes')` (one dispose, one create); `it('leaves a common layer where it is')`; `it('places pyramid tiles with the date shift')`; `it('moves panorama markers and the camera centre with the date')`.
- [ ] **Step 2:** `pnpm --filter @aio/engine test -- layerSync raster panoramas`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command, then `pnpm --filter @aio/engine test` whole and typecheck: PASS.
- [ ] **Step 5:** Commit `feat(engine): draw a lined-up date at its corrected place`.

### Task 10: Point clouds

**Files:**

- Modify: `packages/pointcloud/src/adapter.ts` (COPC at 253 and 302: `cloudFrameOrigin(project, layer, ctx.shiftOf(layer.id))`; png-packed `lift()` at 232-247 also moves `quant.offset` x and z and the bounds)
- Modify: `apps/desktop/src/renderer/pointcloud/cleanupScene.ts` and every other `cloudFrameOrigin(` call under `apps/desktop/src/renderer/pointcloud/` (grep): pass `dateShiftOf(manifest, layer.id)`
- Test: `packages/pointcloud/src/adapter.test.ts`, `apps/desktop/src/renderer/pointcloud/cleanupScene.test.ts`

**Interfaces:** Consumes `AdapterContext.shiftOf` (Task 9), `cloudFrameOrigin` (Task 1), `dateShiftOf` (Task 3). Cleanup recipes stay in file coordinates.

- [ ] **Step 1:** Tests: `it('streams a COPC from the shifted frame origin')` (origin `[0, 0, 100]`, shift `{eastM: 2, northM: 1}`: `loadCopc` sees `[-2, -1, 100]`); `it('moves png-packed chunks with the date')` (bounds x +2, z -1); `it('converts the clip box of a lined-up cloud back to file coordinates')`.
- [ ] **Step 2:** `pnpm --filter @aio/pointcloud test -- adapter` and `pnpm --filter @aio/desktop test -- cleanupScene`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same commands: PASS.
- [ ] **Step 5:** Commit `feat(pointcloud): draw a lined-up cloud at its corrected place`.

### Task 11: Video, volumetric, walks

**Files:**

- Modify: `packages/video/src/rig.ts` (`buildPath(f, shift)` at 557 and its cache key at 331 add `shiftKey`; poses and bounds already get the shifted `positionOffsetM` from Task 9)
- Modify: `packages/volumetric/src/scene/controller.ts` (230-236, 276-285, 580: a pile epoch's ring and solids through `captureShift(manifest, epoch.captureId)`; `zoneRing` unshifted) and the ring editor's save path in `packages/volumetric/src` (grep `BoundaryEdit`): subtract before saving
- Modify: `apps/desktop/src/renderer/walks/WalkSceneMount.tsx` (75-88), `walkMapOverlay.ts`, `placeWalk.ts` (a placement picked on the shifted scene is saved minus the shift)
- Test: `packages/video/src/rig.test.ts`, `packages/volumetric/src/scene/controller.test.ts`, `apps/desktop/src/renderer/walks/placeWalk.test.ts`, `walkMapOverlay.test.ts`

**Interfaces:** Consumes Tasks 1 and 3.

- [ ] **Step 1:** Tests: `it('draws the flight path of a lined-up video at the corrected place')`; `it('moves an epoch ring with its date and leaves the zone ring')`; `it('saves an edited epoch ring without the shift')`; `it('draws a walk of a lined-up date shifted')`; `it('saves a walk placement without the shift')`.
- [ ] **Step 2:** `pnpm --filter @aio/video test -- rig`, `pnpm --filter @aio/volumetric test -- controller`, `pnpm --filter @aio/desktop test -- placeWalk walkMapOverlay`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same commands: PASS.
- [ ] **Step 5:** Commit `feat(video,volumetric): lined-up dates in flights, piles and walks`.

### Task 12: 2D map

**Files:**

- Modify: `packages/maps/src/controller.ts` (`rasterImages` 651, `addRasterImages` 697, `showWaitingRasters` 746, `updatePyramids` 771: corners through `shiftCorners`; flights and drone 859-942: positions through `shiftLocal`; `vectorOverlaysFor` 1082: a vector layer with a shift gets its GeoJSON fetched and rewritten by `shiftedGeoJson`, others keep the URL)
- Modify: `packages/maps/src/overlays.ts` (`issueAnchor` 135: a mesh or cloud sighting through its layer's shift; a map sighting through `proj.toLocal`, shift, `proj.toLonLat`)
- Modify: `packages/maps/src/photoPins.ts` (`placed` 78: shift after `correctedPhoto`)
- Create: `packages/maps/src/shiftGeoJson.ts`
- Test: `packages/maps/src/controller.test.ts`, `overlays.test.ts`, `photoPins.test.ts`, create `shiftGeoJson.test.ts`

**Interfaces:**

- Consumes: Tasks 1 and 3; `frameProjection` (`geo.ts:128`).
- Produces: `shiftedGeoJson(gj: GeoJSON.GeoJSON, s: DateShift, proj: FrameProjection): GeoJSON.GeoJSON` (every position through local, shifted, back; properties untouched).

- [ ] **Step 1:** Tests: `it('moves every position of a GeoJSON by the shift')` (a point 2 m east in metres within 1 mm, via `proj`); `it('places a lined-up ortho quad at the corrected place')`; `it('moves a photo pin after its correction')`; `it('moves a map sighting of a lined-up layer')`; `it('keeps a common vector on its URL')`.
- [ ] **Step 2:** `pnpm --filter @aio/maps test -- shiftGeoJson controller overlays photoPins`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `feat(maps): show lined-up dates at their corrected place`.

### Task 13: Globe

**Files:**

- Modify: `packages/globe/src/view/siteOutputs.ts:20` (`SiteOutputs.rasters[]` gains `shift?: DateShift`), `packages/globe/src/projectRasters.ts` (`pyramidPlacement(index, frame, shift?)` about 86), `packages/globe/src/view/projectRasterProvider.ts` (uses it)
- Modify: `apps/desktop/src/renderer/globe/siteOutputsStore.ts` (fills `shift` from `dateShiftOf`) and the caller of `setIssuePins` (passes shifted local points)
- Test: `packages/globe/src/projectRasters.test.ts`, `apps/desktop/src/renderer/globe/siteOutputsStore.test.ts`

**Interfaces:** `@aio/globe` takes the shift as data (no `@aio/workspace` dependency).

- [ ] **Step 1:** Tests: `it('places a pyramid with a date shift')` (lon/lat of the top-left corner equals the unshifted placement of a point 2 m east); `it('passes the date shift of each raster')`.
- [ ] **Step 2:** `pnpm --filter @aio/globe test -- projectRasters` and `pnpm --filter @aio/desktop test -- siteOutputsStore`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same commands: PASS.
- [ ] **Step 5:** Commit `feat(globe): lined-up dates on the globe`.

### Task 14: Annotate: pins, drapes, crossview, sighting writers

**Files:**

- Modify: `packages/annotate/src/model/mesh.ts` (`sightingAnchor` 18, `bestAnchor` 46, `issuePins` 86: anchors through their sighting layer's shift), `packages/annotate/src/tools/overlay.ts` (338) and `drape.ts` (`mapToLocal` 10: shift after the conversion)
- Modify: `packages/annotate/src/crossview/camera.ts` (`sightingCamera` 35: an image sighting's pose after `correctedPhoto`, then the shift; a video sighting through the shifted `positionOffsetM`)
- Modify: `packages/annotate/src/PhotoViewer.tsx` (166-200: 3D anchors projected with shifted anchors and shifted poses)
- Modify: every place in `packages/annotate/src` that creates a `mesh`, `pointcloud` or `map` sighting from a pick (grep `kind: 'mesh'`, `'spoint'`, `'polygon3'`, `'spolygon'`, `on: 'map'`; image, video and pano sightings are in pixels or directions and stay as they are): `unshiftLocal` (map: through local) before saving
- Test: `packages/annotate/src/model/mesh.test.ts`, `tools/overlay.test.ts`, `crossview/camera.test.ts`, and the tests of the sighting tools touched

**Interfaces:** Consumes Tasks 1 and 3 (`dateShiftOf(manifest, sighting.layer)`).

- [ ] **Step 1:** Tests: `it('draws a pin of a lined-up mesh at the corrected place')`; `it('drapes a map polygon of a lined-up date shifted')`; `it('frames an image sighting of a lined-up date from the shifted camera')`; `it('stores a mesh sighting placed on a shifted date in the date's own frame')` (pick at x = 12 on a date shifted 2 m east: saved x = 10); `it('stores a map sighting placed on a shifted date in the date's own frame')`.
- [ ] **Step 2:** `pnpm --filter @aio/annotate test -- mesh overlay camera` plus the tool tests: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same commands, then `pnpm --filter @aio/annotate test` whole: PASS.
- [ ] **Step 5:** Commit `feat(annotate): pins follow their date's line-up`.

### Task 15: Project writer, extents, sidecar, main

**Files:**

- Modify: `packages/project/src/builder/create.ts` (`updateCapture` 315-335: `lineUp` set with millimetre rounding, `null` deletes; refuses `lineUp.with` equal to the date itself or unknown)
- Modify: `packages/project/src/builder/extents.ts` (`layerExtent(root, m, l, orientation, shift?: DateShift | null)` about 92 and `layerExtents(root, m, orientation, shifts?: Readonly<Record<string, DateShift>>)` about 150)
- Modify: `packages/project/src/builder/layerFiles.ts:68-81` (`crsSidecar` writes `dateShiftM`)
- Modify: `apps/desktop/src/main/builder.ts` (the `builder:layerExtents` and `layer:info` handlers pass `layerDateShifts(m)`; the export handler passes the layer's shift)
- Test: `packages/project/src/builder/captures.test.ts` (or the file testing `updateCapture`), `extents.test.ts`, `layerFiles.test.ts`, `apps/desktop/src/main/builder.test.ts`

**Interfaces:**

- Produces: `builder:updateCapture` with `{ lineUp }` saves it; throws `` `A date cannot be lined up with itself.` `` and `` `Capture "${id}" is not in this project.` `` for a bad `with`.
- Produces: extents of a dated layer moved by its shift (the far-content check in `renderer/builder/farContent.ts` then needs nothing).

- [ ] **Step 1:** Tests: `it('saves, rounds and removes a line-up')`; `it('refuses a line-up with itself')`; `it('moves a dated extent by its shift')` (mesh, raster, photos, COPC); `it('writes the date shift into the sidecar')` (and no key without one); main `it('sends extents with the date shifts')`.
- [ ] **Step 2:** `pnpm --filter @aio/project test -- captures extents layerFiles` and `pnpm --filter @aio/desktop test -- main/builder`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same commands and typecheck: PASS.
- [ ] **Step 5:** Commit `feat(project): save a line-up and shift extents and exports`.

### Task 16: Renderer placement helpers

**Files:**

- Modify: `apps/desktop/src/renderer/builder/photoPoses.ts:20-69` (`createCorrectedPhotosAdapter`: shift each item after its correction, from `ctx.shiftOf`)
- Modify: `apps/desktop/src/renderer/shell/layerBounds.ts` (`layerBounds` 65: corners, photo and panorama positions through the shift; scene boxes and file extents are already shifted)
- Modify: `apps/desktop/src/renderer/workspace/spot/spotEntries.ts` (27-71: every `pos` after correction, then the shift)
- Modify: `apps/desktop/src/renderer/workspace/FramesPane.tsx` (about 203: `calibratedVideoPose` result shifted)
- Test: `photoPoses.test.ts`, `layerBounds.test.ts`, `spot/spotEntries.test.ts`, `FramesPane.test.tsx`

**Interfaces:** Consumes Tasks 1, 3 and `AdapterContext.shiftOf` (Task 9). `compare.ts`, `compareWith.ts` and `MapSwipe.tsx` need no change: they pick layers or work in screen space, and the views they compare are shifted by Tasks 9 and 12.

- [ ] **Step 1:** Tests: `it('shifts a corrected photo after its correction')` (a hand-set position from `orientation.json` plus the shift); `it('frames a lined-up raster at its corrected place')`; `it('matches spots across lined-up dates')` (two photos 2 m apart in the files match after the line-up); `it('places a video frame of a lined-up date shifted')`.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- photoPoses layerBounds spotEntries FramesPane`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `feat(desktop): bounds, spots and frames follow a line-up`.

### Task 17: Survey measurements and placed findings

**Files:**

- Modify: `apps/desktop/src/renderer/survey/measureScene.ts`, `measureDisplay.ts` (survey-scoped measurements drawn through `shiftEN` of `scope.capture`), `measureStore.ts` (saved with `shiftEN(..., -1)`)
- Modify: `apps/desktop/src/renderer/placement/store.ts` (the `.sel` points and the `polygon3` / `spolygon` sightings it writes are unshifted with the target layer's shift before `project:writeSelection` and the save)
- Test: `measureScene.test.ts`, `measureStore.test.ts`, `placement/store.test.ts`

**Interfaces:** Consumes Tasks 1 and 3.

- [ ] **Step 1:** Tests: `it('draws a survey-scoped measurement with its date shift')`; `it('leaves a site measurement where it is')`; `it('saves a survey-scoped measurement without the shift')`; `it('writes a selection of a lined-up cloud in the date's own frame')`.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- measureScene measureStore placement/store`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `feat(desktop): measurements and findings follow a line-up`.

### Task 18: Change package: in-app shifts, staleness, panel states

**Files:**

- Modify: `packages/change/src/compute.ts` (`computeInApp` 69: vector positions through their layer's shift after `src.toLocal`; issue positions through Task 14's shifted anchors), `packages/change/src/issues.ts` (`issuePosition` 63)
- Modify: the in-app producers in `packages/change/src` (write `lineUp` on the sets they save)
- Create: `packages/change/src/stale.ts`
- Modify: `packages/change/src/store.ts` (35-52: `misaligned: { from: string; to: string; shiftM: number; producer: string } | null`, `setMisaligned`), `packages/change/src/ChangePanel.tsx` (props `onLineUp?: (from: string, to: string) => void`, `onRerun?: (producer: string) => void`; a stale set shows `change.stale` and `change.rerun`; the misaligned state shows `change.misaligned` and `lineUp.action`)
- Test: `compute.test.ts`, create `stale.test.ts`, `ChangePanel.test.tsx`, `store.test.ts`

**Interfaces:**

- Produces: `changeSetStale(set: ChangeSet, m: Pick<ProjectManifest, 'captures'>): boolean` (each side's recorded shift, absent meaning zero, against `captureShift` within 1 mm).
- Produces: testids `chg-stale`, `chg-rerun`, `chg-misaligned`, `chg-lineup`.

- [ ] **Step 1:** Tests: `it('compares vectors of a lined-up date at the corrected place')` (a feature 2 m off in the file is unchanged after the line-up); `it('records the shifts on a saved set')`; `it('marks a set stale when one of its dates was lined up after it')`; `it('keeps a set computed after the line-up fresh')`; `it('shows the gap and Line up dates when a run was refused')` (`chg-misaligned` text `These dates are 2.01 m apart.`, clicking `chg-lineup` calls `onLineUp('d1', 'd2')`); `it('offers Run again on a stale set')`.
- [ ] **Step 2:** `pnpm --filter @aio/change test -- compute stale ChangePanel store`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `feat(change): lined-up dates, stale sets and the line-up action`.

### Task 19: Measure job `change.lineup`

**Files:**

- Modify: `python/src/aio_pipelines/change/register.py` (new `slope`, `measure_line_up`, constants)
- Create: `python/src/aio_pipelines/change/lineup.py` (`ChangeLineUp`, template `ChangeRaster` read and register steps)
- Modify: `python/src/aio_pipelines/pipelines.py` (`all_pipelines`, about line 61)
- Modify: `packages/schema/src/jobs.ts` (`PipelineName` about 42, `PIPELINES` about 97, `ChangeLineUpParams`, `PARAMS` about 1177)
- Modify: `apps/desktop/src/renderer/jobs.ts` (`FORMS` about 375: `'change.lineup': []`; not a manifest writer)
- Test: create `python/tests/test_change_lineup.py` (synthetic pairs from `imagery_synth.py`); `packages/schema/src/jobs.test.ts`, `change.test.ts`

**Interfaces:**

- Produces: `register.py` constants `COARSE_SEARCH_M = 60.0`, `MAX_FINE_TILES = 48`, `MIN_TILES = 6`, `MAX_SPREAD_PX = 1.0`, `MIN_OVERLAP = 0.3`; `slope(heights: np.ndarray, cell: float) -> np.ndarray`; `measure_line_up(a: np.ndarray, b: np.ndarray, valid: np.ndarray, cell: float, log: bool = True) -> dict[str, Any]` returning `{dy, dx, px, tiles, spread, coarse}` (coarse level found first, then at most `MAX_FINE_TILES` fine tiles of the most texture after moving `b` by the coarse answer).
- Produces: `ChangeLineUpParams = { keep: Id; move: Id; layerKeep?: Id; layerMove?: Id }` (the layers default to each date's ortho, else its DSM).
- Produces: artifact `jobs/<id>/lineup.json`, a `LineUpMeasure` (Task 1), where `eastM`/`northM` is the correction still needed by `move` (both dates read with their current shifts, Decision 6). The job never writes the manifest.

- [ ] **Step 1: Write the failing tests**
  - `test_measures_a_two_metre_shift` (synthetic ortho pair at 0.1875 m cells, later moved 2.0 m east: `verdict == "ok"`, `abs(eastM + 2.0) < 0.05`, `abs(northM) < 0.05`).
  - `test_measures_forty_metres_coarse_to_fine` (40 m north: within 0.1 m, `coarse > 1`).
  - `test_reads_a_bounded_number_of_fine_tiles` (a 4096 px pair: `tiles <= MAX_FINE_TILES`).
  - `test_refuses_a_rotated_copy` (3 degrees: `verdict == "disagree"`); `test_refuses_a_flat_image` (`texture`); `test_refuses_dates_that_hardly_overlap` (10 % overlap: `overlap`).
  - `test_answers_aligned_for_dates_already_lined_up` (the moved date's `lineUp` already corrects the 2 m: `verdict == "aligned"`).
  - `test_uses_dsm_slope_without_an_ortho` (`source == "dsm"`, same shift found).
  - TS: `jobs.test.ts` `it('knows the change.lineup pipeline and its params')`.
- [ ] **Step 2:** `uv run pytest tests/test_change_lineup.py -q` and `pnpm --filter @aio/schema test -- jobs`: FAIL.
- [ ] **Step 3:** Implement (constants as above; adjust a constant only with the test that shows why, and note it in the commit).
- [ ] **Step 4:** Same commands, then `uv run pytest tests/test_change_raster.py tests/test_change_surface.py -q` and `pnpm --filter @aio/desktop typecheck`: PASS.
- [ ] **Step 5:** Commit `feat(pipelines): measure how far two dates are apart`.

### Task 20: Line-up store, step, notice, background check

**Files:**

- Create in `apps/desktop/src/renderer/lineup/`: `planLineUp.ts` (pure), `lineUpMemory.ts`, `lineUpStore.ts`, `LineUpDialog.tsx`, `LineUpNotice.tsx`, `LineUpOffer.tsx`, `lineUpWatch.ts`, `lineup.css`
- Modify: `apps/desktop/src/renderer/exports/Toasts.tsx` (render `<LineUpOffer />` and `<LineUpNotice />` after `<DropNotice />`), `apps/desktop/src/renderer/App.tsx` (mount `<LineUpDialog />` beside `<Toasts />`)
- Test: `planLineUp.test.ts`, `lineUpMemory.test.ts`, `lineUpStore.test.ts`, `LineUpDialog.test.tsx`, `LineUpNotice.test.tsx`, `lineUpWatch.test.ts` next to them

**Interfaces:**

- Consumes: Task 1 types, Task 2 strings, Task 3 `captureShift`, `layerDateShifts`, `hintOnlyLayers`; Task 15's `builder:updateCapture` `{ lineUp }`; `otherUndo` (`AlignToNotice.tsx`); `LineUpMeasure` (Task 1).
- Produces in `planLineUp.ts`: `planLineUp(m: LineUpMeasure, keepId: string, manifest: ProjectManifest, at: string): { moveId: string; lineUp: CaptureLineUp; previous: CaptureLineUp | null; totalM: number }` (keep is `m.keep`: move `m.move` to its current shift plus the correction; keep is `m.move`: move `m.keep` to its current shift minus it; `with` is `keepId`); `movesWith(manifest, captureId, issues: readonly Issue[], measurements: readonly SurveyMeasurement[]): { layers: number; items: number }`; `formatMetres(m: number): string` (`"2.01 m"`); `shiftWords(eastM: number, northM: number, t: T): string` (`lineUp.shift`); `pairsToMeasure(manifest, extents: Record<string, Box>, measured: ReadonlySet<string>): { keep: string; move: string; layerKeep: string; layerMove: string; key: string }[]` (each date with an ortho or DSM against the other date it most overlaps; `key` `"<layerKeep>|<layerMove>"`, sorted ids).
- Produces in `lineUpMemory.ts`: `createLineUpMemory(storage: Storage | null)` with `measured(projectId): Set<string>`, `markMeasured(projectId, key)`, `isNotNow(projectId, key): boolean`, `notNow(projectId, key)` (keys `quadrion.lineUp.measured`, `quadrion.lineUp.notNow`, 500 entries each, blocked storage falls back to the session).
- Produces in `lineUpStore.ts`: `createLineUpStore(deps: LineUpDeps): StoreApi<LineUpStore>` with
  - `LineUpDeps { workspace: StoreApi<Workspace>; measure(keep: string, move: string): Promise<LineUpMeasure | { error: string }>; saveCapture(captureId: string, lineUp: CaptureLineUp | null): Promise<string | null>; pinCaptures(layerIds: readonly string[], captureId: string | null): Promise<string | null>; hints(): CaptureHints; issues(): readonly Issue[]; measurements(): readonly SurveyMeasurement[]; memory: LineUpMemory; now(): string }`
  - `LineUpStore { dialog: LineUpDialogState | null; offer: LineUpOfferState | null; notice: LineUpNoticeState | null; open(a: string, b: string, then?: () => void): Promise<void>; choose(keepId: string): void; confirm(): Promise<void>; remove(captureId: string): Promise<void>; apply(): Promise<void>; dismiss(): void; offerFrom(m: LineUpMeasure, key: string): void; acceptOffer(): Promise<void>; notNow(): void }`
  - `LineUpDialogState { a: string; b: string; keep: string | null; measuring: boolean; measure: LineUpMeasure | null; error: string | null; moves: { layers: number; items: number } | null; then?: () => void }`
  - `confirm()` pins hint-only layers of the moved date (Decision 2), saves the capture, shows `lineUp.done` with Undo, runs `then`; `apply()` restores the previous `lineUp` (or `null`) and the pins, and flips to Redo; one run at a time; the notice goes when another project opens, as `dropStore.ts`.
- Produces in `lineUpWatch.ts`: `watchLineUps(deps: { store: StoreApi<LineUpStore>; workspace: StoreApi<Workspace>; extents(): Promise<Record<string, Box>>; measure: LineUpDeps['measure']; memory: LineUpMemory; hasPython(): boolean }): () => void` (on open and manifest change: measure each pair in `pairsToMeasure` once, mark it measured, and `offerFrom` when `verdict === 'ok'` and the pair is not "Not now").
- Produces testids: `lineup-dialog`, `lineup-keep-<captureId>`, `lineup-shift`, `lineup-confidence`, `lineup-refusal`, `lineup-moves`, `lineup-preview`, `lineup-before`, `lineup-after`, `lineup-confirm`, `lineup-cancel`, `lineup-offer`, `lineup-offer-text`, `lineup-offer-go`, `lineup-offer-later`, `lineup-notice`, `lineup-text`, `lineup-undo`, `lineup-redo`.

- [ ] **Step 1: Write the failing tests**
  - `planLineUp.test.ts`: `it('moves the later date by the correction')` (correction `{-2, 0}`, keep d1: d2 `lineUp` `{eastM: -2, northM: 0, with: 'd1'}`); `it('moves the other date when keep is swapped')` (keep d2: d1 gets `{2, 0}`); `it('plans an absolute shift when the kept date is already shifted')` (d1 at `{1, 1}`, d2 at 0, correction measured between placed dates: d2 ends at d1's frame); `it('counts what moves with a date')` (layers of the date, issues with a sighting on them, survey measurements scoped to it; a site measurement not counted); `it('writes distances with two decimals and compass words')` (`2.01 m west, 0.00 m north (2.01 m in all)`); `it('pairs each date with the one it most overlaps')`.
  - `lineUpMemory.test.ts`: `it('remembers Not now per project and pair')`, `it('works without storage')`.
  - `lineUpStore.test.ts` (fake deps): `it('measures, lines up and undoes')` (one `saveCapture`, notice text `Survey 13 April 2026 lined up with Survey 2 March 2026 (2.00 m).`, `apply()` saves the previous value and shows Redo); `it('keeps Line up off until a date is chosen')`; `it('shows the reason and saves nothing for a refused measurement')` (`texture` gives `lineUp.refuse.texture`); `it('runs the change again after a line-up from the Changes panel')` (`then` called once, after the save); `it('removes a line-up with undo')`; `it('pins layers only the volume hints date')`; `it('drops the notice and writes nothing when another project opens')`.
  - `LineUpDialog.test.tsx`: `it('shows the shift, confidence, counts and a preview')`, `it('switches the preview between Before and After')`.
  - `LineUpNotice.test.tsx`: `it('undoes on Ctrl+Z')`, `it('leaves Ctrl+Z to a field')`.
  - `lineUpWatch.test.ts`: `it('offers a line-up once for a new ortho')` (offer text `Survey 13 April 2026 doesn't line up with Survey 2 March 2026. Its ortho sits 2.00 m away.`); `it('measures a pair once')`; `it('stays quiet after Not now')`; `it('does nothing without the pipeline Python')`; `it('does not offer for an aligned or refused pair')`.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- planLineUp lineUpMemory lineUpStore LineUpDialog LineUpNotice lineUpWatch`: FAIL.
- [ ] **Step 3:** Implement (UI work loads `impeccable` and `frontend-design` first; the dialog uses the app's existing dialog and toast classes; it must fit a 1100 x 700 window).
- [ ] **Step 4:** Same command, then `pnpm --filter @aio/desktop typecheck`: PASS.
- [ ] **Step 5:** Commit `feat(desktop): line up dates step, notice and background check`.

### Task 21: Wiring: job, Changes panel, date folder

**Files:**

- Create: `apps/desktop/src/renderer/lineup/lineUpSession.ts` (the app instance of Task 20's store and watcher: `measure` starts `change.lineup` through the jobs store, waits for it and reads `lineup.json` the way the change producers read job outputs; `saveCapture` calls `builder:updateCapture`; `pinCaptures` calls `builder.getState().saveLayers` with `{ capture }`; `hints` from `volumeHints(volumetric.getState())`; Line up and Drop to ground dismiss each other's notice, as `dropSession.ts` does with Align to)
- Modify: `apps/desktop/src/renderer/change/producers/raster.ts` (imagery and surface: when the job fails with `failure.code === 'misaligned'`, `setMisaligned` with its data)
- Modify: the component that mounts `ChangePanel` (grep `<ChangePanel`): `onLineUp` opens the step with `then` rerunning the refused producer; `onRerun` runs a producer again
- Modify: `apps/desktop/src/renderer/shell/DateMenus.tsx` and `dateFolders.ts` (a lined-up date shows `lineUp.folder` in its folder tooltip and its menu offers `lineUp.action` and `lineUp.remove`)
- Test: `lineUpSession.test.ts`, `change/producers/raster.test.ts`, `shell/DateMenus.test.tsx`

**Interfaces:** Consumes Tasks 5, 18, 19, 20. Produces menu testids `date-menu-line-up`, `date-menu-remove-line-up`.

- [ ] **Step 1:** Tests: `it('measures through the change.lineup job')`; `it('reports a failed measurement')`; `it('turns a misaligned refusal into the panel state')`; `it('leaves another failure as it is')`; `it('shows a lined-up date and removes its line-up')`; `it('opens the step from the date menu with the other date')` (two dates: the other; more: the one it most overlaps).
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- lineUpSession producers/raster DateMenus`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command, `pnpm --filter @aio/desktop typecheck`, and `pnpm --filter @aio/desktop test -- parity`: PASS.
- [ ] **Step 5:** Commit `feat(desktop): line up dates from the Changes panel and the date folder`.

### Task 22: Docs: guide and known limits

**Files:**

- Modify: `docs/guide/15-imagery-and-surface-change.md` (new section "Line up dates": the notice, the Changes panel action, the step, Undo, removing a line-up, what moves; line 37's quoted refusal text updated)
- Modify: `docs/KNOWN-LIMITS.md` (line 78: "Line up dates" replaces "Align the layers first"; new lines: manual point picking is not available yet; only sideways shifts, no rotation, scale or height; a 3D Tiles set or a change result made before a line-up keeps the old place (build or run it again); builds before this one show the date at its file position and drop the line-up on their next save; the background check needs the pipeline Python)
- Check: `node tools/agent/check-public-text.mjs docs/KNOWN-LIMITS.md docs/guide/15-imagery-and-surface-change.md`

- [ ] **Step 1:** Write the text (UI names exactly as Task 2's strings; no dashes).
- [ ] **Step 2:** `pnpm format:check` and the public-text check: pass.
- [ ] **Step 3:** Commit `docs: lining up survey dates`.

### Task 23: End to end specs

**Files:**

- Modify: `apps/desktop/e2e/fixtures.ts` (new `createMisalignedDemo(dataRoot: DataRoot, shift: { eastM: number; northM: number }): Promise<{ id: string; root: string }>`)
- Create: `apps/desktop/e2e/line-up-dates.spec.ts`

**Interfaces:**

- The demo stays byte for byte as it is (its truth and `change-raster.spec.ts` assume aligned dates). `createMisalignedDemo` copies `DEMO_FOLDER/demo-change-site` into the data root as project `e2e-misaligned` and moves date `d2` 2 m east in its stored data only: `model-d2` transform element 12, `ortho-d2` and `dsm-d2` layer `corners` and the `corners` of their `tiles.json`, `sources/dsm-d2.json` `x0`, and `photos-d2` item positions, each by `+eastM` (x) and `-northM` (z) or `+northM` (N). The clouds stay (hidden in the demo, not asserted). This gives the same kind of 2 m, 10.7 px gap at the `--quick` 0.1875 m ortho cell as the founder's project.
- Consumes: `PIPELINE_ENV`, `hasPipelinePython`, `changeDemoTruth`, `hasChangeDemo`, the Changes panel steps of `change-raster.spec.ts`, the compare steps of `compare.spec.ts`.

- [ ] **Step 1: Write the specs** (header comment: synthetic data, off-screen, zero network; skips without the change demo or the pipeline Python)
  - `test('a misaligned survey offers Line up dates, and Not now is remembered')`: open `e2e-misaligned`; `lineup-offer-text` matches `/^Survey 13 April 2026 doesn't line up with Survey 2 March 2026\. Its ortho sits 2\.\d\d m away\.$/` (within 1.90 to 2.10 m); click `lineup-offer-later`; reopen the project: no `lineup-offer` within 10 s.
  - `test('imagery change refused, lined up from the Changes panel, then runs clean')`: Run imagery change; `chg-misaligned` shows `These dates are 2.0x m apart.`; click `chg-lineup`; in `lineup-dialog` `lineup-confirm` is disabled until `lineup-keep-d1` is chosen; `lineup-shift` reads `2.0x m west, 0.0x m north`; `lineup-confidence` starts `Confident`; click `lineup-after` then `lineup-confirm`; `lineup-text` reads `Survey 13 April 2026 lined up with Survey 2 March 2026 (2.0x m).`; `manifest.json` `captures` `d2.lineUp.eastM` within -2 ± 0.1, `northM` within 0 ± 0.1, `with === 'd1'`; `rasters/ortho-d2/tiles.json` unchanged byte for byte; the imagery change run starts by itself and finishes; its regions match `truth.counts.expected` as `change-raster.spec.ts` checks them, and its `registration.shiftM < 0.2`.
  - `test('the lined-up date lines up in 3D, on the map and for pins')`: after a line-up (seed `lineUp` `{eastM: -2, northM: 0, with: 'd1'}` in the copy to skip the job), the scene node `layer:model-d2` world x translation equals `layer:model-d1`'s within 0.05; Compare dates on two maps: the `ortho-d2` quad's top-left lon/lat equals `ortho-d1`'s within 0.05 m (via `__stratlas`); an issue with a mesh sighting on `model-d2` at the tank centre of the demo truth shifted 2 m east is drawn within 0.05 m of the same tank on `model-d1`; Swipe drags the divider over the two orthos with no 2 m step at a tank edge (pixel row comparison across the divider within 2 px).
  - `test('undo puts the date back and keeps a pin drawn after the line-up on its feature')`: line up, place a pin on `model-d2` at the tank top, Ctrl+Z on the scene: `d2.lineUp` gone, `lineup-redo` shows, the pin is drawn 2 m east of `model-d1`'s tank together with the model (still on the d2 tank).
- [ ] **Step 2:** From `apps/desktop`: `pnpm demo:build --quick`, then in PowerShell `$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'` and `npx playwright test e2e/line-up-dates.spec.ts --workers=1 --repeat-each=3`. The log prints `[e2e] window 1100 x 720 px at display scale 1`; all pass (the pipeline Python from `uv sync` in `python/`, or `QUADRION_E2E_PYTHON`).
- [ ] **Step 3:** Run the neighbours the same way: `e2e/change-raster.spec.ts`, `e2e/change-demo.spec.ts`, `e2e/change-core.spec.ts`, `e2e/compare.spec.ts`, `e2e/drop-to-ground.spec.ts`, `e2e/align-to.spec.ts`.
- [ ] **Step 4:** Commit `test(desktop): line up dates end to end`.

## Finish

- [ ] `pnpm check` green; `cd python; uv run pytest -q` green for the touched suites (the full suite if time allows).
- [ ] Independent review of the whole branch on the strongest model (focus: one shift per layer and never two, readers add and writers subtract, Python and TS membership agree, the Review Focus list).
- [ ] Session note with a "How to test" walkthrough: open a project with two survey dates whose orthos sit a couple of metres apart (or the misaligned demo copy), wait for "... doesn't line up with ...", click Line up dates, choose the date to keep, check the shift, swipe Before and After, click Line up and read the notice; swipe the two dates in Compare dates, look at a pin on both dates and the 3D view; run imagery change in the Changes panel; press Ctrl+Z; right-click the date folder and remove the line-up.
