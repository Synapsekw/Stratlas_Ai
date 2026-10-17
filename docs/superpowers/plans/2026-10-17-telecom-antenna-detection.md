# Telecom Antenna Detection (Merge 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click on **Detect antennas** runs a background job that finds, boxes and measures every antenna on a tower crown from the point cloud, links the best photos, and gives the engineer a reviewable inventory (accept, reject, equipment fields, CSV), with optional AI labelling of type that never touches a number.

**Architecture:** A new Python pipeline `telecom.antennas` (`python/src/aio_pipelines/telecom/`) locates the crown, grows planar faces, pairs them into oriented boxes, classifies and measures them, scores photos, writes crops, and commits `telecom/antennas.json` (`aio.antennas/1`) merged with the previous run. Main reads and writes that file through journaled IPC (`telecom:readAntennas`, `telecom:writeAntennas`) and runs AI labelling in `@aio/ai` behind a preview token (`ai:antennaLabelPreview`, `ai:labelAntennas`). The renderer gets a store, two standalone components, a scene layer, and a temporary entry point `survey/DetectAntennas.tsx` mounted by one line in `TelecomTools.tsx`.

**Tech Stack:** Python 3.13 (numpy, scipy `cKDTree`/`ConvexHull`, pyproj, Pillow), zod v4 (`@aio/schema`), Electron main, `@aio/ai` (`generateText` route), React 19 + zustand vanilla stores, three.js, vitest (jsdom, `createRoot` + `act`), pytest, Playwright Electron.

**Spec:** `docs/superpowers/specs/2026-10-17-telecom-antenna-detection-design.md` (section numbers below refer to it).

## Global Constraints

- Azimuth: clockwise from north of the outward face normal's horizontal part; outward = away from the tower axis; stored as grid (`azimuthGridDeg`); true = grid + `convergenceDeg`, where convergence is `gridConvergenceDeg` (`packages/geo/src/crs.ts`, grid azimuth of true north = -convergence).
- Downtilt: angle of the face normal below horizontal, positive = beam points down (`downtilt = -asin(n_up)`), mechanical only.
- Plumb: sideways lean of the face's long axis from vertical, in the face plane, positive = top leans right seen from the front (the viewer looks along -normal; for a north-facing unit, right is west).
- W / H / D = across the face / along the long axis / front to back, metres; altitude and E, N = box centre in project CRS and vertical datum.
- Dish: azimuth and elevation (positive up) of the dish axis plus diameter; no downtilt or plumb.
- The layer's `heightOffsetM` is always applied (project Z = file Z + `heightOffsetM`; Python `change/sources.py` `height_offset_m(layer)`, 0 when absent).
- No CRS: E, N, Z are local metres from the project origin, `convergenceDeg` is null and every azimuth reads "Project north".
- Synthetic accuracy targets: azimuth within 1°, downtilt and plumb within 1.5°, W/H/D within 0.03 m.
- Width filter never caps at 1 m (plausible width 0.12 to 3.0 m).
- Job label "Detecting antennas" (`en.ts` key `jobs.telecom.antennas`).
- Entry point hidden without a point-cloud layer (and in read-only packages); disabled with `disabledReason` only while a run is going or the cloud is still loading.
- Status is shown by outline style and a text chip, never colour alone; kind colours are secondary.
- AI never sets numbers: labelling changes only `kind`, `kindBasis` and `ai`.
- AI gates: `check('vision')` (route, offline-only, cloud switch, project policy, key), `aiCloudPhotos` or the per-request photo consent, and a send-preview token for every cloud request.
- Every visible string is a key in `packages/ui/src/i18n/en.ts` (added once, by Task 1); no em or en dashes.
- No client, site or person names, real coordinates or site thresholds in code, tests, fixtures, docs or commits (`node tools/agent/check-public-text.mjs`).
- Heavy work only in the Python job runner; main and renderer never touch the cloud points.
- Frozen files, never edited: `Stage.tsx`, `workspace/tools/*`, `RightHeader`, the workbench store, the stage sections of `styles.css`, `packages/ui/src/shortcuts.ts`, `MeasurementPanel.tsx`, the builder placement tools, `packages/survey/src/tools/telecom.ts`. `TelecomTools.tsx` gets exactly one `<DetectAntennas />` line.

## Review Focus

1. **No axis, or two masts of about the same height.** The job must stop with `TOWER_HINT_NEEDED`, the UI must ask for one click and re-run with `params.towerHint`. Tests: Task 3 `test_two_masts_need_a_hint` / `test_hint_picks_the_mast`; Task 8 `needs a hint after the job fails with the hint message, then re-runs with towerHint`.
2. **Project without a CRS.** `convergenceDeg` null, `run.north = 'project'`, and every azimuth labelled "Project north", never "True". Tests: Task 5 `test_no_crs_is_project_north`; Task 9 `labels project north when convergence is null`.
3. **Re-run over a reviewed file.** Accepted and rejected units and user fields survive; an accepted unit not found again is kept and flagged. Tests: Task 5 `test_merge_*` and `test_rerun_keeps_review`; Task 12 e2e accept, reload, still accepted.
4. **AI refused or offline mid-flow.** The inventory stays, no number changes, the reason shows. Tests: Task 7 `refuses offline-only`, `refuses a cloud call without a valid preview token`, `refuses photos without consent`; Task 8 `applyAiLabels never changes a number`; Task 11 `shows the AI refusal and keeps the inventory`.
5. **`heightOffsetM` set vs absent.** With the offset set, centres agree with project heights; without it, nothing is shifted. Tests: Task 5 `test_height_offset_applied` / `test_height_offset_absent`.

## Execution DAG

| Batch | Tasks (dispatch each batch in one message)      | Depends on                        | Files shared within the batch                                                                   |
| ----- | ----------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1     | Task 1, Task 2                                  | none                              | none                                                                                            |
| 2     | Task 3, Task 4, Task 6, Task 8, Task 9, Task 10 | 3, 4: Task 2; 6, 8, 9, 10: Task 1 | none (Task 2 created `telecom/__init__.py`; Task 1 wrote every `en.ts`, `ipc.ts`, preload line) |
| 3     | Task 5, Task 7                                  | 5: Tasks 1, 3, 4; 7: Tasks 1, 6   | none                                                                                            |
| 4     | Task 11                                         | Tasks 7, 8, 9, 10                 | n/a                                                                                             |
| 5     | Task 12, Task 13                                | 12: Tasks 5, 6, 11; 13: Task 11   | none                                                                                            |

**Critical path:** Task 1 → Task 6 → Task 7 → Task 11 → Task 12 (Task 7 waits on Task 6 because both edit `apps/desktop/src/main/index.ts`). The Python chain Task 2 → Task 4 → Task 5 → Task 12 has one batch of slack, but Task 4 is the hardest algorithm: give it the strongest model.

### Tests, e2e, contract and packages per task

| Task | Unit tests                                                                                                 | e2e                                                                                                       | Contract                                                                                 | Packages                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | `packages/schema/src/antennas.test.ts`, `versions.test.ts` (existing, must stay green)                     | none                                                                                                      | `aio.antennas/1`, `telecom.antennas` + `TelecomAntennasParams`, 4 IPC channels: two rows | schema, ui (en.ts), desktop (preload, renderer job tables) |
| 2    | `python/tests/test_antenna_synth.py`                                                                       | none                                                                                                      | none                                                                                     | python (tests)                                             |
| 3    | `python/tests/test_telecom_crown.py`                                                                       | none                                                                                                      | none                                                                                     | python                                                     |
| 4    | `python/tests/test_telecom_faces.py`, `test_telecom_measure.py`                                            | none                                                                                                      | none                                                                                     | python                                                     |
| 5    | `python/tests/test_telecom_photos.py`, `test_telecom_merge.py`, `test_telecom_pipeline.py`                 | none                                                                                                      | none (pack version bump)                                                                 | python                                                     |
| 6    | `apps/desktop/src/main/telecom.test.ts`, `telecomPack.test.ts`, `journal.test.ts` (new case)               | none                                                                                                      | none                                                                                     | desktop (main)                                             |
| 7    | `packages/ai/src/antennaLabel.test.ts`, `packages/ai/src/antennaLabelRuntime.test.ts`                      | none                                                                                                      | none                                                                                     | ai, desktop (main)                                         |
| 8    | `apps/desktop/src/renderer/telecom/antennaStore.test.ts`                                                   | none                                                                                                      | none                                                                                     | desktop (renderer)                                         |
| 9    | `telecom/antennaFormat.test.ts`, `AntennaInventory.test.tsx`, `AntennaDetails.test.tsx`                    | none                                                                                                      | none                                                                                     | desktop (renderer)                                         |
| 10   | `telecom/antennaScene.test.ts`                                                                             | none                                                                                                      | none                                                                                     | desktop (renderer)                                         |
| 11   | `survey/DetectAntennas.test.tsx`, `telecom/antennaCsv.test.ts`, `survey/TelecomTools.test.tsx` (mock line) | none                                                                                                      | none                                                                                     | desktop (renderer)                                         |
| 12   | none                                                                                                       | add `apps/desktop/e2e/telecom-antennas.spec.ts`; run `telecom-measurements.spec.ts` (shared fixture file) | none                                                                                     | desktop (e2e)                                              |
| 13   | `pnpm format:check`                                                                                        | none                                                                                                      | none                                                                                     | docs                                                       |

## Task 1: Schema, contracts, strings and job tables

**Files:**

- Create: `packages/schema/src/antennas.ts`, `packages/schema/src/antennas.test.ts`, `packages/schema/src/__fixtures__/antennas-contract.json`
- Modify: `packages/schema/src/index.ts` (`export * from './antennas';`), `packages/schema/src/jobs.ts` (`PipelineName` += `'telecom.antennas'`; `PIPELINES` entry title `'Detect antennas'`; `PARAMS` += `'telecom.antennas': TelecomAntennasParams`), `packages/schema/src/ipc.ts` (four channels), `packages/schema/src/versions.ts` (`{ family: 'aio.antennas', version: 1, home: 'project', where: 'telecom/antennas.json', since: '0.20' }`), `apps/desktop/src/preload/index.ts` (four `CHANNELS` lines), `apps/desktop/src/renderer/jobs.ts` (`FORMS['telecom.antennas'] = []`), `apps/desktop/src/renderer/processing/pipelines.ts` (`PIPELINE_GROUP` `'survey'`, `JOB_KIND` `'survey'`, and `TITLE_KEYS` below), `packages/ui/src/i18n/en.ts`, `docs/architecture/contract-changes.md`
- Test: `packages/schema/src/antennas.test.ts`

**Packages touched:** schema, ui, desktop (preload, renderer).

**Interfaces:**

- Produces (all from `@aio/schema`):

```ts
export const ANTENNAS_SCHEMA = 'aio.antennas/1';
export const ANTENNAS_FILE = 'telecom/antennas.json';
export const ANTENNA_CROPS_DIR = 'telecom/crops'; // `<dir>/<unitId>.jpg`
export const TELECOM_ANTENNAS_MIN_PACK = '0.14.0';
export const TELECOM_ANTENNAS_FEATURE = 'Antenna detection';
export const TOWER_HINT_NEEDED =
  'Could not tell which structure is the tower. Click the tower once in the 3D view and run again.';
export const AntennaKind = z.enum(['panel', 'short', 'dish', 'other']);
export const AntennaKindBasis = z.enum(['geometry', 'ai', 'user']);
export const AntennaStatus = z.enum(['draft', 'accepted', 'rejected']);
export const AntennaAiLabel = z.enum(['panel', 'short-antenna', 'radio-unit', 'dish', 'other']);
export const AI_LABEL_KIND: Record<AntennaAiLabel, AntennaKind>; // short-antenna→short, radio-unit→other
export const AntennaValue; // { value: number, basis: ValueBasis, quality: ParamQuality }, refine quality.basis === basis
export const AntennaBox; // { centre: [E,N,Z], axes: [across, up, outward] (unit ENZ vectors), extents: [w,h,d] }
export const AntennaPhoto; // { layer: string, id: string, score: 0..1 }
export const AntennaUserFields; // { model?: str<=120, weightKg?: 0..500, frequencies?: str<=200, active?: boolean }
export const AntennaUnit; // see fields below
export const AntennaRun; // see fields below
export const AntennasFile; // { schema: literal ANTENNAS_SCHEMA, run: AntennaRun, units: AntennaUnit[] (<=500) }
export const TelecomAntennasParams; // { run: /^run-[a-z0-9-]{1,60}$/, cloud?: {layer}, towerHint?: [x, z] (local), floorFraction?: 0.3..0.95 }, strict
export type AntennaKind, AntennaKindBasis, AntennaStatus, AntennaAiLabel, AntennaValue, AntennaBox,
  AntennaPhoto, AntennaUserFields, AntennaUnit, AntennaRun, AntennasFile, TelecomAntennasParams;
```

`AntennaUnit` (strict): `id` (`/^ant-[a-z0-9-]{1,60}$/`), `name` (1..40, e.g. `A3`), `kind`, `kindBasis`, `ai?: DetectionOrigin.extend({ reason: z.string().max(200).optional() })`, `status`, `notFoundInLatest?: true`, `box`, `support` (int, total face points), `azimuthGridDeg?`, `downtiltDeg?`, `plumbDeg?`, `elevationDeg?`, `diameterM?`, `widthM`, `heightM`, `depthM` (all `AntennaValue`), `convergenceDeg: number | null`, `photos: AntennaPhoto[]` (max 3), `crop?: string` (project-relative), `user: AntennaUserFields`, `runId`, `createdAt: IsoTime`. Refine, only when `kindBasis === 'geometry'`: `panel`/`short` need `azimuthGridDeg` and `downtiltDeg`; `dish` needs `azimuthGridDeg`, `elevationDeg`, `diameterM`; `other` has none of the five angle/diameter fields. Units relabelled by AI or a person keep whatever the geometry measured.

`AntennaRun` (strict): `id`, `at: IsoTime`, `params: TelecomAntennasParams`, `cloudLayer: string`, `axis: { point: Vec3, dir: Vec3, source: 'evidence' | 'auto' | 'hint' }` (ENZ), `crown: { floorZ, topZ, radiusM }`, `north: 'grid' | 'project'`, `warnings: string[]` (each <=300), `counts: { panel, short, dish, other }`, `ai?: DetectionRun`.

IPC (`ipc.ts`, each `request` strict):

```ts
'telecom:readAntennas':  { request: { projectId }, response: { ok: true, file: AntennasFile | null, readOnly: boolean } | Failure },
'telecom:writeAntennas': { request: { projectId, file: AntennasFile }, response: OkOrFailure },
'ai:antennaLabelPreview': { request: { projectId, unitIds: string[1..200] },
  response: { ok: true, provider: string, model: string, cloud: boolean, photosAllowed: boolean,
              crops: { unitId: string, path: string }[], missing: string[],
              estimate: { images: number, inputTokens: number, costUsd?: number }, token: string }
          | { ok: false, error: string } },
'ai:labelAntennas': { request: { runId, projectId, unitIds: string[1..200], token?: string, photos?: boolean },
  response: { ok: true, provider, model, promptVersion, labels: { unitId, label: AntennaAiLabel, reason: string }[],
              inputTokens, outputTokens, costUsd?: number, warnings: string[] } | Failure },
```

`pipelines.ts`: `const TITLE_KEYS: Partial<Record<PipelineName, MessageKey>> = { 'telecom.antennas': 'jobs.telecom.antennas' };` and `jobTitle` returns `t(TITLE_KEYS[name])` first.

`en.ts` keys (exact values; every renderer task uses these, none adds more without a follow-up commit here):

```ts
'jobs.telecom.antennas': 'Detecting antennas',
'telecom.antennas.detect': 'Detect antennas',
'telecom.antennas.detect.tip': 'Find and measure the antennas on the tower from the point cloud',
'telecom.antennas.running': 'Antenna detection is already running.',
'telecom.antennas.loading': 'The point cloud is still loading.',
'telecom.antennas.title': 'Antenna inventory',
'telecom.antennas.empty.none.title': 'No antenna run yet',
'telecom.antennas.empty.none.body': 'Detect antennas finds and measures every antenna on the tower.',
'telecom.antennas.empty.nothing.title': 'Nothing found',
'telecom.antennas.empty.nothing.body': 'No antennas were found on the crown. Check the warnings, or use the Azimuth and Antenna tilt tools.',
'telecom.antennas.summary.antennas_one': '{count} antenna',
'telecom.antennas.summary.antennas_other': '{count} antennas',
'telecom.antennas.summary.other': '{count} other equipment',
'telecom.antennas.summary.review_one': '{count} needs review',
'telecom.antennas.summary.review_other': '{count} need review',
'telecom.antennas.kind.panel': 'Panel antennas',
'telecom.antennas.kind.short': 'Short antennas',
'telecom.antennas.kind.dish': 'Microwave dishes',
'telecom.antennas.kind.other': 'Other equipment',
'telecom.antennas.status.draft': 'Draft',
'telecom.antennas.status.accepted': 'Accepted',
'telecom.antennas.status.rejected': 'Rejected',
'telecom.antennas.notFound': 'Not found in latest run',
'telecom.antennas.show': 'Show {name} in 3D',
'telecom.antennas.hide': 'Hide {name} in 3D',
'telecom.antennas.more': 'More for {name}',
'telecom.antennas.accept': 'Accept',
'telecom.antennas.reject': 'Reject',
'telecom.antennas.details': 'Open details',
'telecom.antennas.value.type': 'Type',
'telecom.antennas.value.azimuth': 'Azimuth',
'telecom.antennas.value.downtilt': 'Downtilt',
'telecom.antennas.value.plumb': 'Plumb',
'telecom.antennas.value.elevation': 'Elevation',
'telecom.antennas.value.diameter': 'Diameter',
'telecom.antennas.value.width': 'Width',
'telecom.antennas.value.height': 'Height',
'telecom.antennas.value.depth': 'Depth',
'telecom.antennas.value.altitude': 'Centre altitude',
'telecom.antennas.value.coordinates': 'Centre E, N',
'telecom.antennas.north.true': 'True {deg}',
'telecom.antennas.north.grid': 'Grid {deg}',
'telecom.antennas.north.project': 'Project north {deg}',
'telecom.antennas.basis.measured': 'Measured',
'telecom.antennas.basis.observed': 'Observed',
'telecom.antennas.basis.inferred': 'Inferred',
'telecom.antennas.basis.user': 'Entered by you',
'telecom.antennas.kindBasis.geometry': 'Type from geometry',
'telecom.antennas.kindBasis.ai': 'Type labelled by AI ({provider})',
'telecom.antennas.kindBasis.user': 'Type set by you',
'telecom.antennas.quality': 'Fit residual {residual} mm, {support} points, {coverage}% coverage',
'telecom.antennas.notMeasured': 'Not measured',
'telecom.antennas.mechanical': 'Mechanical tilt only. Electrical tilt is inside the antenna and is not measured.',
'telecom.antennas.field.model': 'Model',
'telecom.antennas.field.weight': 'Weight (kg)',
'telecom.antennas.field.frequencies': 'Frequencies',
'telecom.antennas.field.active': 'In service',
'telecom.antennas.photos': 'Best photos',
'telecom.antennas.photos.none': 'No photo sees this unit.',
'telecom.antennas.photo.open': 'Open photo {n}',
'telecom.antennas.hint.title': 'Which one is the tower?',
'telecom.antennas.hint.body': 'Click the tower once in the 3D view. Detection then runs again.',
'telecom.antennas.hint.cancel': 'Cancel',
'telecom.antennas.options': 'Detection options',
'telecom.antennas.cloud': 'Point cloud',
'telecom.antennas.cloud.auto': 'Automatic',
'telecom.antennas.aiLabel': 'Label with AI',
'telecom.antennas.aiLabel.tip': 'Sends a crop of each unit\'s best photo to the AI provider to tell antennas, radio units and dishes apart. AI never changes a measurement.',
'telecom.antennas.ai.title': 'Send photo crops for labelling',
'telecom.antennas.ai.body_one': '{count} crop leaves this computer for {provider}.',
'telecom.antennas.ai.body_other': '{count} crops leave this computer for {provider}.',
'telecom.antennas.ai.photos': 'Allow photos of this project to be sent for this request',
'telecom.antennas.ai.send': 'Send',
'telecom.antennas.ai.cancel': 'Cancel',
'telecom.antennas.ai.skipped': 'AI labelling skipped: {reason}',
'telecom.antennas.csv': 'Export CSV',
'telecom.antennas.csv.drafts': 'Include drafts',
'telecom.antennas.csv.done': 'Exported to {path}.',
'telecom.antennas.warnings': 'Warnings',
```

`antennas-contract.json`: `{ "towerHintMessage": <TOWER_HINT_NEEDED>, "matchRadiusM": 0.3, "example": <a valid AntennasFile with one panel (accepted, user model), one dish, one other> }`. Python (Task 5) checks the same file.

- [ ] **Step 1: Write the failing test** `antennas.test.ts`:

```ts
it('parses the contract example and round-trips it', () => {
  const f = AntennasFile.parse(contract.example);
  expect(AntennasFile.parse(JSON.parse(JSON.stringify(f)))).toEqual(f);
});
it('pins the tower hint message to the shared fixture', () =>
  expect(TOWER_HINT_NEEDED).toBe(contract.towerHintMessage));
it('refuses a geometry panel without azimuth or downtilt', () => {
  const u = { ...panel, azimuthGridDeg: undefined };
  expect(AntennaUnit.safeParse(u).success).toBe(false);
});
it('refuses angles on a geometry "other" unit, allows them once AI relabelled', () => {
  expect(AntennaUnit.safeParse({ ...panel, kind: 'other' }).success).toBe(false);
  expect(AntennaUnit.safeParse({ ...panel, kind: 'other', kindBasis: 'ai' }).success).toBe(true);
});
it('refuses residualM on an inferred value', () =>
  expect(
    AntennaValue.safeParse({
      value: 0.15,
      basis: 'inferred',
      quality: { basis: 'inferred', residualM: 0.003 },
    }).success,
  ).toBe(false));
it('maps AI labels one to one onto kinds', () =>
  expect(AI_LABEL_KIND).toEqual({
    panel: 'panel',
    'short-antenna': 'short',
    'radio-unit': 'other',
    dish: 'dish',
    other: 'other',
  }));
it('validates params strictly', () => {
  expect(pipelineParams('telecom.antennas').safeParse({ run: 'run-a1' }).success).toBe(true);
  expect(pipelineParams('telecom.antennas').safeParse({ run: 'run-a1', radius: 3 }).success).toBe(
    false,
  );
  expect(pipelineParams('telecom.antennas').safeParse({ run: 'x' }).success).toBe(false);
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/schema/src/antennas.test.ts`; expect FAIL (module not found).
- [ ] **Step 3: Implement** `antennas.ts` and the edits listed under Files. Add two rows to `contract-changes.md` (header `| Date | Change | Why | Streams affected | Approved by |`): (a) `2026-10-17 | Additive file schema aio.antennas/1 (telecom/antennas.json, crops under telecom/crops/), pipeline telecom.antennas with TelecomAntennasParams, min pack 0.14.0 | Antenna inventory, spec section 3 | @aio/schema, python pack, desktop (main, renderer) | Founder go-ahead on the antenna detection spec, 17 Oct 2026`; (b) the four IPC channels, same date and approval, streams `@aio/schema, @aio/ai, desktop (main, preload, renderer)`.
- [ ] **Step 4: Run** `pnpm vitest run packages/schema/src` and `pnpm typecheck`; expect PASS (the exhaustive `Record<PipelineName, …>` tables and `CHANNELS satisfies Record<IpcChannel, true>` must compile).
- [ ] **Step 5: Commit** `git commit -m "feat(schema): aio.antennas/1, telecom.antennas params and antenna IPC contracts"`.

## Task 2: Synthetic tower crown generator

**Files:**

- Create: `python/tests/antenna_synth.py`, `python/tests/test_antenna_synth.py`, `python/src/aio_pipelines/telecom/__init__.py` (docstring only: `"""Telecom antenna detection (telecom.antennas)."""`)

**Packages touched:** python.

**Interfaces:**

- Consumes: `synth_assets.toward`, `synth_assets._shaft`, `synth_assets._ring`, `synth_assets._segment`, `synth_assets.write_las`.
- Produces:

```python
def tower_cloud(kind: str = "monopole", seed: int = 1, noise: float = 0.003,
                occlude: bool = True, points_per_m2: float = 4000.0,
                ground: bool = True) -> tuple[np.ndarray, dict]:
    """Local frame (x east, y up, z south). truth = {"axis": {"point", "dir"}, "height", "shaftRadiusAt": [[y, r]...],
    "units": [{"name", "kind", "centre", "azimuthDeg", "downtiltDeg", "plumbDeg", "widthM", "heightM", "depthM",
               "diameterM"?, "elevationDeg"?}]}"""
def two_masts_cloud(seed: int = 1, gap_m: float = 20.0) -> tuple[np.ndarray, dict]   # two 30 m monopoles; truth["masts"] = [{"xz": [x, z]}, ...]
def make_tower_project(root: Path, cloud: np.ndarray, *, epsg: int | None = 32633,
                       height_offset_m: float | None = None, photos: list[dict] | None = None,
                       origin: tuple[float, float, float] = (400000.0, 5600000.0, 0.0)) -> Path
    # LAS via write_las (file Z lowered by height_offset_m when set) + manifest.json (aio.project/1,
    # one pointcloud layer id "tower-cloud", format "las", heightOffsetM when set, crs local when epsg is None)
def main(argv: list[str] | None = None) -> int
    # CLI for the e2e: --kind, --seed, --points-per-m2, --out <file.f32> writes little-endian float32 xyz
    # (local frame) and <out>.json with the truth
```

Monopole: 30 m twelve-sided shaft tapering 0.6 to 0.35 m radius, a ring headframe at 27 m (pipe radius 2.0 m) with three vertical mount pipes per sector, shaft brackets at radius 0.4 to 0.9 m. Units (truth): per sector at 0°, 120°, 240°: one panel 0.30 x 1.40 x 0.15 m at downtilt 2°, 4°, 6° and plumb 0°, +1°, -1°; one short antenna 0.40 x 0.90 x 0.20 m; one wide unit 1.50 x 1.20 x 0.20 m at 300° (proves no 1 m cap); one dish diameter 0.60 m at 60°, elevation 1°; one radio unit 0.30 x 0.40 x 0.15 m on the inner ring facing sideways (kind `other`). Lattice: 40 m four-leg tower (reuse `lattice_cloud` geometry style), crown at 36 to 39 m with the same unit set. Each box samples all six faces at `points_per_m2` with Gaussian `noise`; `occlude=True` drops the back face of the 240° panel and half the side faces of every unit.

- [ ] **Step 1: Write the failing test** `test_antenna_synth.py`:

```python
def test_monopole_truth_is_complete():
    xyz, truth = tower_cloud("monopole", seed=1)
    kinds = sorted(u["kind"] for u in truth["units"])
    assert kinds.count("panel") == 4 and kinds.count("short") == 3 and kinds.count("dish") == 1 and kinds.count("other") == 1
    assert max(u["widthM"] for u in truth["units"]) == pytest.approx(1.5)
    assert xyz[:, 1].max() == pytest.approx(truth["height"], abs=0.3)
def test_seeded_and_deterministic():
    assert np.array_equal(tower_cloud(seed=3)[0], tower_cloud(seed=3)[0])
def test_lattice_has_crown_units():
    _, truth = tower_cloud("lattice", seed=2)
    assert all(u["centre"][1] > 35.0 for u in truth["units"])
def test_cli_writes_float32(tmp_path):
    out = tmp_path / "tower.f32"
    assert main(["--kind", "monopole", "--seed", "3", "--out", str(out)]) == 0
    pts = np.fromfile(out, dtype="<f4").reshape(-1, 3)
    assert len(pts) > 50_000 and (tmp_path / "tower.f32.json").exists()
def test_make_tower_project_offset(tmp_path):
    xyz, _ = tower_cloud(seed=1)
    root = make_tower_project(tmp_path / "p", xyz, height_offset_m=2.5)
    layer = json.loads((root / "manifest.json").read_text())["layers"][0]
    assert layer["heightOffsetM"] == 2.5 and layer["format"] == "las"
```

- [ ] **Step 2: Run** `cd python && uv run pytest tests/test_antenna_synth.py -q`; expect FAIL (ImportError).
- [ ] **Step 3: Implement** `antenna_synth.py` with the signatures above. A unit's local axes come from: start across = east, up = up, outward = north; rotate by downtilt about across (outward tips down for positive), then by plumb about outward (top toward the viewer's right for positive), then by azimuth about up (clockwise from north). Truth values are exactly the inputs.
- [ ] **Step 4: Run**; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "test(python): synthetic tower crown generator for antenna detection"`.

## Task 3: Crown location

**Files:**

- Create: `python/src/aio_pipelines/telecom/crown.py`, `python/tests/test_telecom_crown.py`

**Packages touched:** python.

**Interfaces:**

- Consumes: `engineer.cloud.read_region(layer_path, fmt, region, max_points, ctx, origin, seed, offset_m)`, `engineer.axis.estimate_axis(xyz, seed) -> Axis` (`Axis.point`, `.dir`, `.to_frame(xyz) -> (u, w, h)`), `inspection.frame.read_manifest`, `inspection.frame.asset_path`, `change.sources.height_offset_m`, `runtime.JobError`; Task 2 `tower_cloud`, `two_masts_cloud`, `make_tower_project`.
- Produces:

```python
TOWER_HINT_NEEDED = "Could not tell which structure is the tower. Click the tower once in the 3D view and run again."
NO_TOWER = "No upright tower was found in the point cloud. Antenna detection needs a monopole or lattice tower."
SPARSE_CROWN = "The point cloud is too sparse around the tower top to measure antennas."
EMPTY_BAND = "The point cloud has no points in the tower's equipment band."
NO_CLOUD = "This project has no point cloud to detect antennas in."
CROP_RADIUS_M = 30.0; HINT_RADIUS_M = 8.0; DEFAULT_FLOOR_FRACTION = 0.7
SAME_HEIGHT_RATIO = 0.85; MIN_CROWN_POINTS = 5_000; CROWN_MARGIN_M = 3.0

@dataclass
class Crown:
    axis: Axis; source: str            # "evidence" | "auto" | "hint"
    height: float; top_y: float; floor_y: float; radius_m: float
    shaft_r: Callable[[np.ndarray], np.ndarray]   # shaft radius at height h along the axis
    xyz: np.ndarray                    # crown cylinder points, local frame, heightOffsetM applied
    layer_id: str; warnings: list[str]

def pick_cloud_layer(project: Path, manifest: dict, requested: str | None) -> tuple[dict, dict | None]
    # (layer, evidence) — requested id, else the cloud of the newest engineering/<run>/run.json
    # (sources.clouds[0]) that has evidence.json, else the last visible pointcloud layer; JobError(NO_CLOUD)
def newest_evidence(project: Path) -> dict | None   # {"axis", "height", "crop", "base", "cloud"} or None
def shaft_radius_fn(xyz: np.ndarray, axis: Axis, height: float) -> Callable[[np.ndarray], np.ndarray]
def locate_crown(ctx, project: Path, manifest: dict, params: dict) -> Crown
```

- [ ] **Step 1: Write the failing tests** (`make_tower_project` + a minimal ctx stub with `check`, `job.dir`, `project`):

```python
def crown_for(tmp_path, xyz, **params):
    """make_tower_project + a ctx stub (check, job.dir, project), then locate_crown with {"run": "run-t", **params}."""
def off_axis(c, xz):
    return float(np.hypot(c.axis.point[0] - xz[0], c.axis.point[2] - xz[1]))

def test_auto_finds_monopole_axis(tmp_path):
    xyz, truth = tower_cloud("monopole", seed=1)
    c = crown_for(tmp_path, xyz)
    p = truth["axis"]["point"]
    assert c.source == "auto" and off_axis(c, (p[0], p[2])) < 0.1
    assert c.top_y == pytest.approx(truth["height"], abs=0.3)
    assert c.floor_y <= min(u["centre"][1] - u["heightM"] / 2 for u in truth["units"])
def test_evidence_axis_is_used(tmp_path):
    # writes engineering/run-e/run.json (sources.clouds [{layer: "tower-cloud"}]) and evidence.json (axis, height)
    assert crown_for(tmp_path, tower_cloud(seed=1)[0]).source == "evidence"
def test_two_masts_need_a_hint(tmp_path):
    with pytest.raises(JobError, match="Click the tower once"):
        crown_for(tmp_path, two_masts_cloud(seed=1)[0])
def test_hint_picks_the_mast(tmp_path):
    xyz, truth = two_masts_cloud(seed=1)
    c = crown_for(tmp_path, xyz, towerHint=truth["masts"][1]["xz"])
    assert c.source == "hint" and off_axis(c, truth["masts"][1]["xz"]) < 0.15
def test_ground_only_has_no_tower(tmp_path):        # JobError(NO_TOWER)
def test_sparse_crown(tmp_path):                    # 400 random points of the crown kept, JobError(SPARSE_CROWN)
def test_empty_band(tmp_path):                      # evidence height 30 m, cloud cut at 12 m, JobError(EMPTY_BAND)
def test_lattice_crown(tmp_path):                   # auto, floor below the lowest unit
```

- [ ] **Step 2: Run** `cd python && uv run pytest tests/test_telecom_crown.py -q`; expect FAIL.
- [ ] **Step 3: Implement** `crown.py`. Algorithm:
  1. `layer, evidence = pick_cloud_layer(...)`; `offset = height_offset_m(layer)`; origin from manifest.
  2. Axis: evidence → `Axis(point, dir)` from `evidence["axis"]`, height from `evidence["height"]`. Hint → `read_region` with `{"centre": hint, "radiusM": HINT_RADIUS_M}`, then `estimate_axis`. Auto → `read_region(region=None, max_points=400_000)`; 1 m plan grid of (max y minus 2nd-percentile ground y); keep cells above half the tallest; connected components (8-neighbour); a component wider than 12 m is not slender and is skipped; if the two tallest slender components differ by less than `1 - SAME_HEIGHT_RATIO` of the taller and are more than 5 m apart → `JobError(TOWER_HINT_NEEDED)`; re-read `{"centre": seed_xz, "radiusM": CROP_RADIUS_M}` at full density, `estimate_axis`. No component, or `axis.dir[1] < 0.5` (the `model.evidence` upright check) → `JobError(NO_TOWER)` (auto) or `JobError(TOWER_HINT_NEEDED)` (an ambiguous auto seed).
  3. `shaft_radius_fn`: 98th-percentile radius in 1 m height slices from 0.1 to 0.6 of the height, linear fit, extrapolated (the inline envelope of `find_antenna_candidates`, reimplemented here; `members.py` is not edited).
  4. Floor: the lowest 0.25 m slice above `0.5 * height` with at least 50 points beyond `shaft_r(h) + 0.25` begins the equipment band; floor = that height minus 0.3 m; none → `DEFAULT_FLOOR_FRACTION * height` (or `params["floorFraction"]`), warning added.
  5. Crown read: `read_region` with `{"min": [cx - R, floor_y, cz - R], "max": [cx + R, top_y + 1, cz + R]}`, `R = shaft_r(floor) + CROWN_MARGIN_M`, then a radius mask. Fewer than 50 points → `EMPTY_BAND`; fewer than `MIN_CROWN_POINTS` → `SPARSE_CROWN`.
- [ ] **Step 4: Run**; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(pipelines): locate the tower crown for antenna detection"`.

## Task 4: Faces, boxes, classification and measurement

**Files:**

- Create: `python/src/aio_pipelines/telecom/faces.py`, `python/src/aio_pipelines/telecom/boxes.py`, `python/src/aio_pipelines/telecom/measure.py`, `python/tests/test_telecom_faces.py`, `python/tests/test_telecom_measure.py`

**Packages touched:** python.

**Interfaces:**

- Consumes: `modelfit.ransac.ransac_circle(xz, dist, rng, iters) -> (cx, cz, r, mask) | None`, `modelfit.ransac.fit_circle`, Task 2 `tower_cloud` (tests pass the truth axis and crop the crown band themselves, so this task does not wait for Task 3).
- Produces:

```python
# faces.py
VOXEL_M = 0.015; NORMAL_K = 16; MAX_CURVATURE = 0.02; UPRIGHT_MAX_NY = 0.5
GROW_RADIUS_M = 0.035; GROW_DOT = 0.985; GROW_OFFSET_M = 0.008; MIN_FACE_POINTS = 150
SPLIT_RMS_M = 0.010; RANSAC_THR_M = 0.008; KEEP_RMS_M = 0.012
@dataclass
class Face:
    points: np.ndarray; centre: np.ndarray; normal: np.ndarray  # outward, local frame
    up: np.ndarray; side: np.ndarray; height: float; width: float; rms: float; support: int; coverage: float
def voxel_down(xyz: np.ndarray, size: float = VOXEL_M) -> np.ndarray
def normals(xyz: np.ndarray, k: int = NORMAL_K) -> tuple[np.ndarray, np.ndarray]   # (normals, curvature)
def ransac_planes(xyz: np.ndarray, rng: np.random.Generator, thr: float = RANSAC_THR_M,
                  min_points: int = MIN_FACE_POINTS, iters: int = 300) -> list[np.ndarray]
def planar_faces(xyz: np.ndarray, axis_point: np.ndarray, axis_dir: np.ndarray,
                 shaft_r: Callable[[np.ndarray], np.ndarray], seed: int = 0) -> list[Face]
# boxes.py
MIN_W, MAX_W = 0.12, 3.0; MIN_H, MAX_H = 0.25, 3.5; MIN_D, MAX_D = 0.04, 0.8
PAIR_DOT = 0.97; PAIR_ALONG_M = 0.35; PAIR_LATERAL_M = 0.2; PAIR_Z_OVERLAP_M = 0.1; DUP_M = 0.15
@dataclass
class Unit:
    kind: str; front: Face; faces: list[Face]; centre: np.ndarray; axes: np.ndarray  # rows across, up, outward
    extents: np.ndarray; depth_measured: bool; support: int; dish: dict | None   # {"diameter", "axis", "rms"}
def pair_faces(faces: list[Face], axis_point: np.ndarray, crown_xyz: np.ndarray) -> list[Unit]
def classify(unit: Unit, radial: np.ndarray) -> str          # "panel" | "short" | "dish" | "other"
# measure.py
def azimuth_deg(n: np.ndarray) -> float                      # atan2(n_x, -n_z) mod 360
def downtilt_deg(n: np.ndarray) -> float                     # -asin(n_y)
def plumb_deg(long_axis: np.ndarray, n: np.ndarray) -> float
def grid_convergence_deg(lon: float, lat: float, epsg: int) -> float   # mirrors packages/geo gridConvergenceDeg
def to_project(xyz_local: np.ndarray, origin: tuple[float, float, float]) -> np.ndarray   # E=ox+x, N=oy-z, Z=oz+y
def measure_unit(unit: Unit, origin, convergence: float | None) -> dict   # JSON-ready AntennaUnit fields
```

- [ ] **Step 1: Write the failing tests.** `test_telecom_measure.py`, conventions by hand:

```python
def test_conventions_by_hand():
    n = np.array([0.0, -math.sin(math.radians(5)), -math.cos(math.radians(5))])  # north, beam 5° down
    assert azimuth_deg(n) == pytest.approx(0.0, abs=1e-6) and downtilt_deg(n) == pytest.approx(5.0)
    assert azimuth_deg(np.array([1.0, 0, 0])) == pytest.approx(90.0)
    top_west = np.array([-math.sin(math.radians(2)), math.cos(math.radians(2)), 0.0])
    assert plumb_deg(top_west, np.array([0.0, 0, -1])) == pytest.approx(2.0)   # north-facing, top leans west = right
def test_convergence_matches_the_app():
    assert grid_convergence_deg(18.0, 45.0, 32633) == pytest.approx(2.12, abs=0.02)   # east of the meridian: positive
    assert grid_convergence_deg(15.0, 45.0, 32633) == pytest.approx(0.0, abs=1e-3)
def test_to_project_round_trip():
    assert to_project(np.array([[1.0, 2.0, 3.0]]), (100.0, 200.0, 10.0)).tolist() == [[101.0, 197.0, 12.0]]
@pytest.mark.parametrize("kind", ["monopole", "lattice"])
def test_synthetic_crown_accuracy(kind):
    units, truth = detect_on_truth_axis(kind, seed=1)   # helper: crop band, planar_faces, pair_faces, classify, measure_unit
    for t in [u for u in truth["units"] if u["kind"] != "other"]:
        m = match(units, t, radius=0.3)
        assert m["kind"] == t["kind"]
        assert ang(m["azimuthGridDeg"]["value"], t["azimuthDeg"]) <= 1.0
        if t["kind"] != "dish":
            assert abs(m["downtiltDeg"]["value"] - t["downtiltDeg"]) <= 1.5
            assert abs(m["plumbDeg"]["value"] - t["plumbDeg"]) <= 1.5
        for k in ("widthM", "heightM", "depthM"): assert abs(m[k]["value"] - t[k]) <= 0.03
        if t["kind"] == "dish":
            assert abs(m["diameterM"]["value"] - t["diameterM"]) <= 0.03
            assert abs(m["elevationDeg"]["value"] - t["elevationDeg"]) <= 1.5
def test_wide_unit_is_kept_as_a_panel():               # the 1.5 m unit is found, kind "panel", widthM within 0.03
def test_no_units_on_shaft_brackets():                 # no unit centre within shaft_r(h) + 0.1 of the axis
def test_no_duplicates():                              # no two units within 0.3 m
def test_radio_unit_is_never_an_antenna():             # nothing of kind panel/short within 0.3 m of the radio unit
def test_occluded_panel_gets_inferred_depth():         # 240° panel: depthM basis "inferred", no residualM
def test_quality_fields():                             # azimuth quality basis "measured", 0 < residualM < 0.01, support > 150, 0 < coverage <= 1
```

`test_telecom_faces.py`: `normals` on a noisy plane gives |n·truth| > 0.99; `ransac_planes` splits two touching perpendicular planes into two; `planar_faces` returns no face from a vertical cylinder of radius 0.05 (mount pipe) and none from a horizontal ring.

- [ ] **Step 2: Run** `cd python && uv run pytest tests/test_telecom_faces.py tests/test_telecom_measure.py -q`; expect FAIL.
- [ ] **Step 3: Implement.** `planar_faces`: voxel down; drop points with radius below `shaft_r(h) + 0.05` (shaft and brackets); `normals` by k-NN PCA; keep `|n_y| < UPRIGHT_MAX_NY` and curvature `< MAX_CURVATURE`; grow regions with `cKDTree.query_pairs(GROW_RADIUS_M)` keeping pairs with `|n_i·n_j| > GROW_DOT` and plane offset `< GROW_OFFSET_M`, connected components of at least `MIN_FACE_POINTS`; SVD plane per component; components with RMS above `SPLIT_RMS_M` go through `ransac_planes` (upright candidate planes only); keep faces with RMS `< KEEP_RMS_M` and width at least 0.08 m; orient each normal outward (`n_h · (centre_h - axis_h) > 0`); height = 0.5 to 99.5 percentile along `up`, width = 1 to 99 percentile along `side`; coverage = occupied share of a 5 cm grid over w x h.
      `pair_faces` (concise pseudocode):

  ```
  big = faces with MIN_H <= height and MIN_W <= width <= MAX_W, by support descending
  for f in big not used:
      group = [f] + [g not used: |f.n·g.n| > PAIR_DOT and |Δ·f.n| < PAIR_ALONG_M
                     and |Δ·f.side| < PAIR_LATERAL_M and up-overlap(f, g) > PAIR_Z_OVERLAP_M]
      front = the group's face farthest out along its normal, among faces at least 0.6 x the tallest
      across, up, outward = front.side, front.up (long axis by in-plane PCA), front.normal
      w = front.width; h = span of all group points along up
      if len(group) > 1: d = max-min of face offsets along outward; depth_measured = True
      else: d = 99th pct depth behind the front of crown points inside the w x h footprint, capped at MAX_D; depth_measured = False
      centre = front.centre - outward * d / 2 (+ up-centring)
  drop units outside MIN/MAX W, H, D; merge units with centres within DUP_M and |dot| > PAIR_DOT (keep larger support)
  dish test per unit: ConvexHull of front points in (side, up); ransac_circle on hull vertices, dist 0.01;
      dish when circle rms < 0.02 r, |w - h| / max(w, h) < 0.15 and 0.2 <= 2r <= 1.8
  ```

  `classify`: dish as above → `"dish"`; `|outward_h · radial_h| < 0.5` (faces sideways or inward) → `"other"`; `h >= 1.2` → `"panel"`; `0.6 <= h < 1.2` → `"short"`; else `"other"`. `measure_unit` writes `{value, basis, quality}` with `basis "measured"`, `quality {basis, residualM: front.rms, support, coverage}` for angles, W and H; D is measured or `inferred` (no residual or support); dish elevation = `-downtilt` of the dish axis and diameter `2r`; `other` gets no angles; values rounded to 0.1° and 1 mm.

- [ ] **Step 4: Run**; expect PASS. Profile once on the lattice crown: the whole task's functions under 20 s.
- [ ] **Step 5: Commit** `git commit -m "feat(pipelines): planar faces, oriented boxes and antenna measurements"`.

## Task 5: Best photos, re-run merge, pipeline and registration

**Files:**

- Create: `python/src/aio_pipelines/telecom/photos.py`, `python/src/aio_pipelines/telecom/merge.py`, `python/src/aio_pipelines/telecom/pipeline.py`, `python/tests/test_telecom_photos.py`, `python/tests/test_telecom_merge.py`, `python/tests/test_telecom_pipeline.py`
- Modify: `python/src/aio_pipelines/pipelines.py` (import + `TelecomAntennas(),` under a `# Telecom (pipeline pack 0.14.0)` comment), `python/pyproject.toml` and `python/uv.lock` (version `0.14.0`; if `main` has moved past it, take the next minor and update `TELECOM_ANTENNAS_MIN_PACK` in Task 1's file in the same commit)

**Packages touched:** python.

**Interfaces:**

- Consumes: Task 3 `locate_crown`, `Crown`, message constants; Task 4 `planar_faces`, `pair_faces`, `classify`, `measure_unit`, `grid_convergence_deg`; `runtime.Step`, `StepContext.stage/out/progress/check/outputs`, `commit_files`, `atomic_write_json`, `JobError`; `params.known_keys`, `params.text`, `params.number`, `params.numbers`; `inspection.frame.photo_layers`, `inspection.frame.rotate`, `inspection.frame.asset_path`; `packages/schema/src/__fixtures__/antennas-contract.json` (Task 1).
- Produces:

```python
# photos.py
CROP_MAX_PX = 1568; CROP_MARGIN = 0.15; TOP_PHOTOS = 3
def project_points(item: dict, lens: dict, size: tuple[int, int], pts_local: np.ndarray) -> tuple[np.ndarray, np.ndarray]
    # three.js camera: looks along local -Z of q, up +Y; f = (W/2) / tan(hfov/2); returns (px (n,2), depth (n,))
def score_photo(corners_px, depth, size, view_dir, normal, distance_m) -> float
    # 0 when any corner is behind or the box is under 25% in frame; else
    # 0.4 * in-frame share + 0.4 * max(0, -view_dir·normal) + 0.2 / (1 + distance_m / 20); no occlusion test in v1
def best_photos(units: list[dict], manifest: dict, project: Path, check) -> dict[str, list[dict]]   # unit id → [{layer, id, score}]
def write_crop(project: Path, unit: dict, photo: dict, manifest: dict, out: Path) -> Path | None    # JPEG, longest side <= CROP_MAX_PX
# merge.py
MATCH_RADIUS_M = 0.3
def merge_runs(previous: dict | None, units: list[dict], run_id: str) -> list[dict]
# pipeline.py
class TelecomAntennas:
    name = "telecom.antennas"; title = "Detect antennas"
    description = "Find, box and measure the antennas on a tower crown from a point cloud."
    keys = frozenset({"run", "cloud", "towerHint", "floorFraction"})
    def validate(self, params: dict) -> dict
    def inputs(self, params: dict, project: Path) -> list[str]   # ["manifest.json", "clouds", "engineering"]
    def plan(self, params: dict) -> list[Step]
    # steps: crown (w 2, saves staging/crown.npz), faces (w 3, staging/faces.npz), boxes (w 1, returns unit dicts),
    # photos (w 1, stages crops/<id>.jpg), commit (w 0.2)
```

`merge_runs` rules (spec section 5): match a new unit to an old one when centres are within `MATCH_RADIUS_M` and either the kinds are equal or the old `kindBasis` is `ai`/`user`. Matched `accepted`: keep `id`, `name`, `status`, `user`, `kind`/`kindBasis`/`ai` when not geometry; take new geometry only when `new.support > old.support`. Matched `rejected`: keep the old unit unchanged. Matched `draft`: new geometry, old `id` and `name`, old non-geometry kind. Unmatched old `accepted`: kept with `notFoundInLatest: true`. Unmatched old `draft` or `rejected`: dropped. New: `status "draft"`, `id f"ant-{run_id[4:]}-{k}"`, `name f"A{n}"` continuing after the highest existing number, numbered clockwise by azimuth from north. A matched unit clears `notFoundInLatest`.

- [ ] **Step 1: Write the failing tests.**

```python
# test_telecom_photos.py
def test_facing_photo_projects_to_centre(tmp_path):     # camera 10 m out on the unit's normal: centre within 2 px of (W/2, H/2)
def test_facing_beats_oblique_and_behind(tmp_path):     # order [facing, oblique 60°]; behind scored 0 and excluded
def test_crop_is_bounded(tmp_path):                     # JPEG exists, max(size) <= 1568, contains the projected box + margin
def test_no_photos_gives_empty_lists(tmp_path)
# test_telecom_merge.py
def test_merge_accepted_keeps_review_and_better_geometry()   # status, user.model kept; geometry replaced only when support grows
def test_merge_rejected_stays_rejected()
def test_merge_drops_unmatched_drafts_and_flags_accepted()   # notFoundInLatest True on the old accepted unit
def test_merge_ai_relabelled_matches_any_kind()              # old kind "other" (kindBasis "ai") matches new "panel", kind kept
def test_merge_new_units_are_drafts_named_after_existing()
# test_telecom_pipeline.py (run_job from conftest, make_tower_project from Task 2)
def test_registered():
    assert "telecom.antennas" in all_pipelines()
def test_validate():                                   # unknown key, bad run id, towerHint not 2 numbers → JobError
REQUIRED = {"id", "name", "kind", "kindBasis", "status", "box", "support", "widthM", "heightM", "depthM",
            "convergenceDeg", "photos", "user", "runId", "createdAt"}
def test_runs_end_to_end(tmp_path):
    xyz, truth = tower_cloud(seed=1)
    root = make_tower_project(tmp_path / "p", xyz, epsg=32633)
    run_job(all_pipelines()["telecom.antennas"], root, {"run": "run-a"})
    f = json.loads((root / "telecom" / "antennas.json").read_text())
    contract = json.loads(CONTRACT.read_text())
    assert f["schema"] == "aio.antennas/1"
    assert REQUIRED <= set(contract["example"]["units"][0]) and REQUIRED <= set(f["units"][0])
    assert f["run"]["north"] == "grid" and f["run"]["cloudLayer"] == "tower-cloud"
    lon, lat = pyproj.Transformer.from_crs(32633, 4326, always_xy=True).transform(400000.0, 5600000.0)
    assert f["units"][0]["convergenceDeg"] == pytest.approx(grid_convergence_deg(lon, lat, 32633), abs=0.01)
    panel = next(u for u in truth["units"] if u["kind"] == "panel")
    got = nearest(f["units"], panel)                    # helper: unit whose box centre is closest in E, N
    assert got["box"]["centre"][0] == pytest.approx(400000.0 + panel["centre"][0], abs=0.05)
    assert got["box"]["centre"][1] == pytest.approx(5600000.0 - panel["centre"][2], abs=0.05)
def test_no_crs_is_project_north(tmp_path):            # epsg=None: run.north "project", every convergenceDeg None
def test_height_offset_applied(tmp_path):              # height_offset_m=2.5: panel centre Z == truth y (abs 0.03)
def test_height_offset_absent(tmp_path):               # no offset: centre Z == truth y, and the LAS was not lowered
def test_rerun_keeps_review(tmp_path):                 # accept A1 + user model "X" in the file; run again; still accepted, model "X"
def test_tower_hint_message_matches_contract():
    assert TOWER_HINT_NEEDED == json.loads(CONTRACT.read_text())["towerHintMessage"]
def test_progress_and_cancel(tmp_path):                # Recorder sees increasing progress; cancel event raises Cancelled, nothing committed
```

- [ ] **Step 2: Run** `cd python && uv run pytest tests/test_telecom_photos.py tests/test_telecom_merge.py tests/test_telecom_pipeline.py -q`; expect FAIL.
- [ ] **Step 3: Implement.** The `boxes` step computes convergence once at the crown centre (`grid_convergence_deg` from the manifest's `epsg` via pyproj; None without one) and calls `measure_unit`. The `commit` step re-reads `telecom/antennas.json` at commit time (the user may have reviewed during the run), runs `merge_runs`, builds `run` (axis and crown converted with `to_project`, `counts`, `warnings`, `north`), writes it with `atomic_write_json(ctx.stage("antennas.json"))`, commits crops first and `telecom/antennas.json` last with `commit_files`. Crops of kept-but-unmatched units are left in place. Progress messages: "Locating the tower crown", "Finding planar faces", "Fitting antenna boxes", "Picking the best photos", "Saving the inventory".
- [ ] **Step 4: Run**; expect PASS. Then `cd python && uv run pytest -q -k "telecom or antenna"` and `uv run ruff check src tests`.
- [ ] **Step 4b (local only, not CI):** run the job on the reference tower project (a copy, through the real-data gate) and compare against its manual azimuths and the spike's numbers; the crown must finish in under 2 minutes. Record the result in the session note without site names or coordinates.
- [ ] **Step 5: Commit** `git commit -m "feat(pipelines): telecom.antennas job with best photos and re-run merge"`.

## Task 6: Main-process file handlers and pack gate

**Files:**

- Create: `apps/desktop/src/main/telecom.ts`, `apps/desktop/src/main/telecom.test.ts`, `apps/desktop/src/main/telecomPack.ts`, `apps/desktop/src/main/telecomPack.test.ts`
- Modify: `apps/desktop/src/main/journal.ts` (`WRITERS['telecom:writeAntennas'] = (r) => ({ projectId: r.projectId, rel: ANTENNAS_FILE, after: r.file })`), `apps/desktop/src/main/journal.test.ts` (one case), `apps/desktop/src/main/index.ts` (`registerTelecomIpc(...)` next to `registerSurveyIpc`; `antennaPackRefusal` beside `evidencePackRefusal` in `jobs:start`), `apps/desktop/src/main/survey.ts` (export `SurveyProjects` if it is not exported)

**Packages touched:** desktop (main).

**Interfaces:**

- Consumes: `AntennasFile`, `ANTENNAS_FILE`, `ANTENNA_CROPS_DIR`, `TELECOM_ANTENNAS_MIN_PACK`, `TELECOM_ANTENNAS_FEATURE` (Task 1); `readJsonSeen`, `writeJsonSeen(file, data, { backup: true, name })`, `newerOnDisk`, `parseAs`, `readArchiveJson` (as `main/survey.ts` uses them); `compareVersions` (`./jobs/pack`).
- Produces:

```ts
export async function readAntennas(
  projects: SurveyProjects,
  projectId: string,
): Promise<IpcResponse<'telecom:readAntennas'>>;
export async function writeAntennas(
  projects: SurveyProjects,
  projectId: string,
  file: AntennasFile,
): Promise<IpcResponse<'telecom:writeAntennas'>>;
export async function readAntennaCrop(
  root: string,
  unitId: string,
): Promise<{ path: string; bytes: Buffer } | null>;
export function registerTelecomIpc(deps: { handle: Handle; projects: SurveyProjects }): void;
export function antennaPackRefusal(pipeline: string, packVersion: string | null): string | null;
```

- [ ] **Step 1: Write the failing tests** (`telecom.test.ts`, temp project folder):

```ts
it('reads null when there is no run yet', async () =>
  expect(await readAntennas(projects, 'p1')).toEqual({ ok: true, file: null, readOnly: false }));
it('writes atomically with a .bak and reads it back', ...);       // telecom/antennas.json + .bak after the second write
it('refuses a write over a newer file on disk', ...);              // job committed after the read → ok: false
it('refuses writes into a package and reads from it read-only', ...);
it('refuses a file saved by a newer version', ...);               // schema 'aio.antennas/2' → the "newer version" message
it('reads a crop only from telecom/crops and only for a safe unit id', async () =>
  expect(await readAntennaCrop(root, '../manifest')).toBeNull());
// telecomPack.test.ts
expect(antennaPackRefusal('telecom.antennas', '0.13.1')).toBe('Antenna detection needs processing tools 0.14.0 or later (these are 0.13.1). Update them in Settings, Processing tools.');
expect(antennaPackRefusal('telecom.antennas', 'dev')).toBeNull();
expect(antennaPackRefusal('model.evidence', '0.10.0')).toBeNull();
// journal.test.ts
it('journals telecom:writeAntennas against telecom/antennas.json', ...);
```

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/main/telecom.test.ts src/main/telecomPack.test.ts src/main/journal.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** following `readMeasurements` / `writeMeasurements` line by line (`parseAs(raw, AntennasFile, 'aio.antennas', ANTENNAS_FILE)`), and `evidencePackRefusal` for the gate.
- [ ] **Step 4: Run**; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(desktop): journaled antenna inventory handlers and pack gate"`.

## Task 7: AI labelling call

**Files:**

- Create: `packages/ai/src/antennaLabel.ts`, `packages/ai/src/antennaLabel.test.ts`, `packages/ai/src/antennaLabelRuntime.test.ts`
- Modify: `packages/ai/src/main.ts` (`AgentRuntimeHost.telecom?`, `AgentRuntime.antennaLabelPreview` / `labelAntennas`), `packages/ai/src/index.ts` (exports), `apps/desktop/src/main/index.ts` (the `telecom` host in `createAgentRuntime`, `handle('ai:antennaLabelPreview', …)`, `handle('ai:labelAntennas', …)`)

**Packages touched:** ai, desktop (main).

**Interfaces:**

- Consumes: `AntennaAiLabel`, `AI_LABEL_KIND`, IPC types (Task 1); `readAntennas`, `readAntennaCrop` (Task 6); in `main.ts`: `check('vision', projectId)`, `runs`, `host.recordUsage`, `generateText`, `provider.languageModel(route.model, key)`; from `detect.ts`: `DEFAULT_BATCH`, `planBatches`, `sendSize`, `imageTokens`, `extractJson`, `SEND_MAX_PX`; `evidencePolicy` reader for `{ ai, photos }`.
- Produces:

```ts
export const ANTENNA_LABEL_PROMPT_VERSION = 'antenna-label-v1';
export function antennaLabelInstructions(): string;   // the fixed label set, one label per image, a reason of 20 words or fewer, JSON only
export function antennaLabelUserText(keys: readonly string[]): string;
export function parseAntennaLabels(text: string, keys: readonly string[]):
  { labels: { unitId: string; label: AntennaAiLabel; reason: string }[]; warnings: string[] };
export function estimateAntennaLabel(images: number): { images: number; inputTokens: number };
export interface TelecomLabelHost {
  policy(projectId: string): Promise<{ ai: AiPolicy; photos: boolean } | { error: string } | null>;
  crops(projectId: string, unitIds: readonly string[]): Promise<{ unitId: string; path: string; dataUrl: string; sha256: string }[]>;
}
// AgentRuntime
antennaLabelPreview(req: IpcRequest<'ai:antennaLabelPreview'>): Promise<IpcResponse<'ai:antennaLabelPreview'>>;
labelAntennas(req: IpcRequest<'ai:labelAntennas'>): Promise<IpcResponse<'ai:labelAntennas'>>;
```

Preview issues a one-time token (5 minutes) bound to `projectId` and the content key (sorted unit ids + crop sha256 + route). `labelAntennas` gate order: busy `runId` → `check('vision')` → for a cloud route, a valid unused token, else `"Show the send preview first."` → `policy.photos || req.photos`, else `"Photos of this project may not leave this computer. Allow them in the preview."` → send in batches of `DEFAULT_BATCH`, images sized by `sendSize(…, SEND_MAX_PX)` → `host.recordUsage(projectId, { provider, model, inputTokens, outputTokens, costUsd })`. A local route needs no token or photo consent.

- [ ] **Step 1: Write the failing tests.**

```ts
// antennaLabel.test.ts
it('parses one label per key and drops unknown labels with a warning', () => {
  const r = parseAntennaLabels('{"labels":[{"key":"ant-1","label":"radio-unit","reason":"small box"},{"key":"ant-2","label":"omni","reason":"x"}]}', ['ant-1', 'ant-2']);
  expect(r.labels).toEqual([{ unitId: 'ant-1', label: 'radio-unit', reason: 'small box' }]);
  expect(r.warnings).toHaveLength(1);
});
it('never asks for numbers', () => expect(antennaLabelInstructions()).not.toMatch(/azimuth|tilt|degree|size/i));
// antennaLabelRuntime.test.ts (createAgentRuntime with createScriptedProvider and a fake telecom host)
it('refuses offline-only before anything is read', ...);         // crops() not called
it('refuses a cloud call without a valid preview token', ...);    // also a reused token, and one for other unit ids
it('refuses photos without consent and accepts the per-request consent', ...);
it('labels and records usage once per run', ...);                 // recordUsage called with the summed tokens
it('lists units without a crop as missing in the preview', ...);
```

- [ ] **Step 2: Run** `pnpm vitest run packages/ai/src/antennaLabel.test.ts packages/ai/src/antennaLabelRuntime.test.ts`; expect FAIL.
- [ ] **Step 3: Implement**, then wire main: the `telecom` host reads policy the way `engineerRuntimeHost` does and crops through `readAntennas` (crop path per unit) and `readAntennaCrop` (bytes → `data:image/jpeg;base64,…`, sha256).
- [ ] **Step 4: Run** the tests and `pnpm typecheck`; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(ai): label detected antennas from photo crops behind the send preview"`.

## Task 8: Renderer antenna store

**Files:**

- Create: `apps/desktop/src/renderer/telecom/antennaStore.ts`, `apps/desktop/src/renderer/telecom/antennaStore.test.ts`

**Packages touched:** desktop (renderer).

**Interfaces:**

- Consumes: `bridge`, `jobs` (`../shell`); `AntennasFile`, `AntennaUnit`, `AntennaStatus`, `AntennaUserFields`, `AI_LABEL_KIND`, `TOWER_HINT_NEEDED`, `IpcResponse` (Task 1).
- Produces:

```ts
export interface AntennaState {
  projectId: string | null;
  root: string | null;
  file: AntennasFile | null;
  readOnly: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  message: string | null;
  jobId: string | null;
  running: boolean;
  needsHint: boolean;
  selected: string | null;
  hidden: Record<string, true>;
  cloudLayer: string | null; // null = automatic
}
export const antennaStore: StoreApi<AntennaState>;
export function useAntennas<T>(selector: (s: AntennaState) => T): T;
export function loadAntennas(projectId: string, root: string): Promise<void>;
export function runDetection(opts?: { towerHint?: [number, number] }): Promise<void>;
export function cancelHint(): void;
export function setCloudLayer(id: string | null): void;
export function setUnitStatus(id: string, status: AntennaStatus): Promise<void>;
export function patchUnitUser(id: string, fields: AntennaUserFields): Promise<void>;
export function selectAntenna(id: string | null): void;
export function toggleAntennaHidden(id: string): void;
export function applyAiLabels(
  res: Extract<IpcResponse<'ai:labelAntennas'>, { ok: true }>,
  runId: string,
): Promise<void>;
export function getAiLabelPref(projectId: string): boolean; // localStorage 'quadrion.telecom.aiLabel.<id>', try/catch, false
export function setAiLabelPref(projectId: string, on: boolean): void;
```

- [ ] **Step 1: Write the failing tests** (`vi.mock('../shell', …)` as `TelecomTools.test.tsx` does):

```ts
it('loads no run yet as a ready null file', ...);
it('starts telecom.antennas with a run id and the chosen cloud', async () => {
  await runDetection();
  expect(bridge.call).toHaveBeenCalledWith('jobs:start', { pipeline: 'telecom.antennas', project: '/p', params: { run: expect.stringMatching(/^run-[a-z0-9-]+$/) } });
  expect(antennaStore.getState().running).toBe(true);
});
it('ignores a second run while one is going', ...);
it('reloads the file when the job finishes', ...);               // jobs store emits status 'done' for jobId
it('needs a hint after the job fails with the hint message, then re-runs with towerHint', async () => {
  emitJob({ id: 'j1', status: 'failed', error: TOWER_HINT_NEEDED });
  expect(antennaStore.getState().needsHint).toBe(true);
  await runDetection({ towerHint: [1.5, -2] });
  expect(lastStart().params.towerHint).toEqual([1.5, -2]);
});
it('accepts a unit and writes the file', ...);                   // telecom:writeAntennas with status 'accepted'
it('patches user fields without touching values', ...);
it('applyAiLabels never changes a number', async () => {
  const before = structuredClone(state().file!.units[0]);
  await applyAiLabels(okLabels([{ unitId: before.id, label: 'radio-unit', reason: 'r' }]), 'ai-1');
  const after = state().file!.units[0];
  expect(after.kind).toBe('other'); expect(after.kindBasis).toBe('ai');
  expect({ ...after, kind: before.kind, kindBasis: before.kindBasis, ai: undefined }).toEqual({ ...before, ai: undefined });
  expect(state().file!.run.ai?.costUsd).toBe(0.01);
});
it('leaves user-set kinds alone', ...);
it('keeps the AI preference per project and survives a throwing localStorage', ...);
```

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom/antennaStore.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** with `createStore` from `zustand` like `measureStore.ts`. Job watch: `jobs.subscribe` and the record whose `id === jobId`; status `done` → `loadAntennas`; `failed` with `error` containing `TOWER_HINT_NEEDED` → `needsHint`; any other failure → `message = error`. Each review change writes immediately; a refused write (newer on disk) reloads and sets `message`.
- [ ] **Step 4: Run**; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(desktop): antenna inventory store with run, review and AI label merge"`.

## Task 9: AntennaInventory and AntennaDetails

**Files:**

- Create: `apps/desktop/src/renderer/telecom/antennaFormat.ts`, `antennaFormat.test.ts`, `AntennaInventory.tsx`, `AntennaInventory.test.tsx`, `AntennaDetails.tsx`, `AntennaDetails.test.tsx` (all in `apps/desktop/src/renderer/telecom/`)

**Packages touched:** desktop (renderer).

**Interfaces:**

- Consumes: `Row`, `Chip`, `EmptyState`, `Button`, `IconButton`, `Menu`, `Tip`, `t`/`useT` (`@aio/ui`); `assetUrl` (`@aio/workspace`); Task 1 types and keys.
- Produces:

```ts
export function trueAzimuth(gridDeg: number, convergenceDeg: number): number; // ((g + c) % 360 + 360) % 360
export function azimuthLines(
  unit: AntennaUnit,
): { primary: string; secondary: string | null } | null;
export function formatDeg(v: number, signed?: boolean): string; // '123.4°', '+3.0°'
export function qualityTip(v: AntennaValue): string;
export interface AntennaInventoryProps {
  file: AntennasFile | null;
  selected: string | null;
  hidden: Record<string, true>;
  readOnly: boolean;
  onSelect(id: string): void;
  onToggleVisible(id: string): void;
  onSetStatus(id: string, status: AntennaStatus): void;
  onOpenDetails(id: string): void;
}
export function AntennaInventory(props: AntennaInventoryProps): ReactElement;
export interface AntennaDetailsProps {
  unit: AntennaUnit;
  projectId: string;
  readOnly: boolean;
  aiProvider?: string;
  onSetStatus(status: AntennaStatus): void;
  onPatchUser(fields: AntennaUserFields): void;
  onOpenPhoto(layer: string, photoId: string): void;
}
export function AntennaDetails(props: AntennaDetailsProps): ReactElement;
```

Rows: `Row kind="tree"`, `data-testid="antenna-row"`, `data-status`, `data-selected`, label = name, azimuth primary, downtilt; trailing `IconButton` eye (`telecom.antennas.show`/`hide`) and a `Menu` (Accept, Reject, Open details). Groups in order panel, short, dish, other, each under its kind heading. Status chip `Chip kind="status"` with the status text (draft `warn`, accepted `acc`, rejected `off`) plus `telecom.antennas.notFound` when flagged. Details: a `dl` of type (with kind basis), azimuth (true first, grid second, or project north), downtilt with the mechanical note, plumb, elevation and diameter for dishes, W/H/D, altitude, E, N; each value's basis text and a `Tip` with `qualityTip`; fields model, weight, frequencies, active (saved on blur or change; weight must parse to 0 to 500); photo thumbnails from `assetUrl(projectId, { path: crop })` for the first, buttons for each photo calling `onOpenPhoto`; Accept and Reject buttons.

- [ ] **Step 1: Write the failing tests.**

```ts
it('adds convergence for true north and wraps', () => expect(trueAzimuth(359.5, 1.0)).toBeCloseTo(0.5));
it('labels project north when convergence is null', () =>
  expect(azimuthLines(unit({ azimuthGridDeg: v(123.4), convergenceDeg: null }))).toEqual({ primary: 'Project north 123.4°', secondary: null }));
it('shows true first and grid second when convergence is known', () =>
  expect(azimuthLines(unit({ azimuthGridDeg: v(123.4), convergenceDeg: 1.2 }))).toEqual({ primary: 'True 124.6°', secondary: 'Grid 123.4°' }));
it('groups rows by kind in order with a summary line', ...);    // '2 antennas · 1 other equipment · 3 need review'
it('shows the no-run and nothing-found empty states', ...);
it('calls back on select, eye and menu accept', ...);           // onSetStatus('ant-1', 'accepted')
it('gives other equipment no azimuth or downtilt', ...);
it('marks status with text, not colour alone', ...);            // chip text 'Draft' and data-status on the row
it('shows basis and quality for each value', ...);              // 'Measured' + tip 'Fit residual 3.0 mm, 812 points, 74% coverage'
it('shows Not measured for a missing plumb', ...);
it('saves a model on blur and refuses a negative weight', ...);
it('opens the photo viewer from a thumbnail', ...);
it('names the AI provider in the kind basis', ...);              // 'Type labelled by AI (Claude)'
```

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom/antennaFormat.test.ts src/renderer/telecom/AntennaInventory.test.tsx src/renderer/telecom/AntennaDetails.test.tsx`; expect FAIL.
- [ ] **Step 3: Implement.** No layout chrome of their own (no panel, no header bar): a root `div` with `role="tree"` for the inventory and a plain `section` for the details, spacing through `--sp-*` only. Load the `impeccable` skill first.
- [ ] **Step 4: Run**; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(desktop): standalone antenna inventory and details components"`.

## Task 10: Scene layer with two-way selection

**Files:**

- Create: `apps/desktop/src/renderer/telecom/antennaScene.ts`, `apps/desktop/src/renderer/telecom/antennaScene.test.ts`

**Packages touched:** desktop (renderer).

**Interfaces:**

- Consumes: `EngineStage` (`@aio/engine`: `scene`, `camera`, `renderer.domElement`, `requestRender`, `raycast`); `Frame` and `frameOf` (`../survey/measureScene`); Task 1 types.
- Produces:

```ts
export const KIND_COLOURS: Record<AntennaKind, string> = {
  panel: '#4fb3ff',
  short: '#a78bfa',
  dish: '#34d399',
  other: '#f5a524',
};
export interface AntennaSceneState {
  file: AntennasFile | null;
  selected: string | null;
  hidden: Record<string, true>;
}
export function buildAntennaGroup(state: AntennaSceneState, frame: Frame): Group; // name 'aio-telecom-antennas', renderOrder 41
export function pickAntennaAt(group: Group, camera: Camera, ndc: [number, number]): string | null;
export function attachAntennaLayer(
  stage: EngineStage,
  frame: Frame,
  opts: {
    getState(): AntennaSceneState;
    subscribe(cb: () => void): () => void;
    onPick(id: string): void;
  },
): () => void;
export function armTowerPick(
  stage: EngineStage,
  onPoint: (local: [number, number, number]) => void,
): () => void;
```

Per visible unit: a translucent `Mesh` box (opacity 0.18, `depthWrite: false`, `userData.antennaId`) positioned from `frame.toLocal(box.centre)` with its basis from `box.axes` (E,N,Z → local x, y, z = E, Z, -N); an outline `LineSegments` named `antenna-outline:<id>`: accepted solid `LineBasicMaterial`, draft `LineDashedMaterial` (dash 0.08, gap 0.05), rejected `LineDashedMaterial` (dash 0.02, gap 0.04) at opacity 0.35; a facing arrow `antenna-facing:<id>` for units with `azimuthGridDeg` (direction local `x = sin az, z = -cos az`; length `max(0.5, min(heightM, 5))`; head at 0.25 and 0.15 of the length, as the measure scene's `addFacing`); the selected unit adds `antenna-highlight` (outline at 2x scale offset, `#ffffff`). Clicks: `pointerdown`/`pointerup` on the canvas under 4 px apart → `pickAntennaAt` → `onPick`. Rebuild on `subscribe`, then `requestRender`.

- [ ] **Step 1: Write the failing tests** (three in node, no WebGL):

```ts
it('builds one box per visible unit with its id', ...);          // hidden unit omitted
it('draws status by outline style', () => {
  expect(outline(g, 'ant-acc').material).toBeInstanceOf(LineBasicMaterial);
  expect(outline(g, 'ant-draft').material).toBeInstanceOf(LineDashedMaterial);
  expect((outline(g, 'ant-rej').material as LineDashedMaterial).dashSize).toBeCloseTo(0.02);
});
it('adds a facing arrow only to units with an azimuth', ...);     // none for kind 'other'
it('points the arrow east for azimuth 90', ...);                  // tip.x > centre.x, |tip.z - centre.z| < 1e-6
it('highlights the selected unit', ...);
it('picks the box under the cursor', ...);                        // camera looking at the box → its id; empty space → null
```

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom/antennaScene.test.ts`; expect FAIL.
- [ ] **Step 3: Implement**; dispose geometries and materials on rebuild and detach.
- [ ] **Step 4: Run**; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(desktop): antenna scene layer with box picking"`.

## Task 11: Temporary entry point, panel, AI preview and CSV

**Files:**

- Create: `apps/desktop/src/renderer/survey/DetectAntennas.tsx`, `apps/desktop/src/renderer/survey/DetectAntennas.test.tsx`, `apps/desktop/src/renderer/telecom/antennaCsv.ts`, `apps/desktop/src/renderer/telecom/antennaCsv.test.ts`, `apps/desktop/src/renderer/telecom/AntennaSendPreview.tsx`
- Modify: `apps/desktop/src/renderer/survey/TelecomTools.tsx` (exactly one line, `<DetectAntennas />`, directly before the closing `</section>`, plus its import), `apps/desktop/src/renderer/survey/TelecomTools.test.tsx` (`vi.mock('./DetectAntennas', () => ({ DetectAntennas: () => null }))`)

**Packages touched:** desktop (renderer).

**Interfaces:**

- Consumes: Task 8 store API; Task 9 components and `trueAzimuth`; Task 10 `attachAntennaLayer`, `armTowerPick`; `SendDialog` (`@aio/ai`); `openPhoto(layerId, photoId)` (`../builder/photoOpen`); `getActiveStage`, `onActiveScene` (`@aio/engine`); `useWorkspace`, `useShell`; `frameOf`; `bridge.call('dialog:saveFile', { defaultName, data, title })`; `bridge.call('ai:antennaLabelPreview' | 'ai:labelAntennas')`.
- Produces:

```ts
export function DetectAntennas(): ReactElement | null;
export const CSV_COLUMNS: readonly string[]; // id,name,kind,kindBasis,status,azimuthTrueDeg,azimuthGridDeg,convergenceDeg,azimuthBasis,
// downtiltDeg,downtiltBasis,plumbDeg,plumbBasis,elevationDeg,diameterM,widthM,heightM,depthM,depthBasis,
// centreE,centreN,altitudeM,residualMm,support,model,weightKg,frequencies,active,bestPhoto,notFoundInLatest,runId
export function antennasToCsv(file: AntennasFile, opts: { includeDrafts: boolean }): string;
export function AntennaSendPreview(props: {
  preview: Extract<IpcResponse<'ai:antennaLabelPreview'>, { ok: true }>;
  projectId: string;
  onSend(photos: boolean): void;
  onCancel(): void;
}): ReactElement;
```

Behaviour: renders nothing without a project, or when `manifest.layers` has no `pointcloud`, or for a read-only package. Otherwise a `Button` `data-testid="detect-antennas"` (`telecom.antennas.detect`, tip `.detect.tip`), `disabledReason` `telecom.antennas.running` while running, `telecom.antennas.loading` while the chosen cloud (or any visible cloud when automatic) has `stage.layerLoaded(id) === false`; an options `IconButton` opening a `Popover` (cloud select when there is more than one cloud, the **Label with AI** checkbox bound to `getAiLabelPref`/`setAiLabelPref`). The temporary panel `section data-testid="antenna-panel"` appears once a file is loaded or a run started: warnings list, `AntennaInventory`, `AntennaDetails` for the selected unit, an **Export CSV** button `data-testid="antenna-csv"` with an **Include drafts** checkbox (rejected never exported). While it is shown the scene layer is attached to the active 3D stage; `onPick` selects and scrolls the row into view (`block: 'nearest'`). `needsHint` shows the hint text, arms `armTowerPick`, and re-runs with `[x, z]`. After a finished run with the AI preference on: preview → `AntennaSendPreview` → `ai:labelAntennas` with `runId` `ai-<time>` → `applyAiLabels`; a refused preview or call shows `telecom.antennas.ai.skipped` and leaves the inventory as it is.

- [ ] **Step 1: Write the failing tests.**

```ts
// antennaCsv.test.ts
it('exports accepted units only by default, with basis columns', ...);  // header === CSV_COLUMNS.join(','), 1 data row
it('adds drafts when asked and never rejected units', ...);
it('leaves true azimuth empty without convergence and escapes quotes', ...);
// DetectAntennas.test.tsx
it('is hidden without a point cloud', ...);                           // container empty, tiny mesh-only manifest
it('is disabled with a reason while running and while the cloud loads', ...);   // aria-disabled + reason text
it('starts detection on click', ...);                                  // runDetection called
it('asks for a tower click after a hint failure and re-runs with it', ...);
it('shows the AI refusal and keeps the inventory', ...);              // preview { ok: false, error: 'offline' } → skipped line, rows remain
it('exports the CSV through the save dialog', ...);                    // dialog:saveFile { defaultName: 'antenna-inventory.csv' }
```

- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/survey/DetectAntennas.test.tsx src/renderer/telecom/antennaCsv.test.ts src/renderer/survey/TelecomTools.test.tsx`; expect FAIL.
- [ ] **Step 3: Implement.** Check the diff of `TelecomTools.tsx` is two lines (import + mount) and no class, markup or order changed.
- [ ] **Step 4: Run**, then `pnpm check`; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(desktop): temporary Detect antennas entry with inventory panel and CSV"`.

## Task 12: End-to-end spec on a synthetic tower

**Files:**

- Create: `apps/desktop/e2e/telecom-antennas.spec.ts`
- Modify: `apps/desktop/e2e/telecomFixtures.ts` (extract `packPngCloud(dir, name, points, rgb?)` from the cloud branch of `writeTelecomFace`, unchanged output; add `writeTelecomTower(dir): Promise<void>`)

**Packages touched:** desktop (e2e).

**Interfaces:**

- Consumes: `test`, `expect`, `win`, `dataRoot`, `tinyManifest`, `PIPELINE_ENV`, `VENV_PYTHON`, `hasPipelinePython` (`./fixtures`); `expectAccessible` (`./a11y`); the Task 2 CLI `python/tests/antenna_synth.py --kind monopole --seed 3 --points-per-m2 1500 --out <tmp>/tower.f32`.
- Produces: `writeTelecomTower(dir)` runs the CLI with `VENV_PYTHON`, packs the points as a png-packed layer `tower-cloud` (`cloud/index.json`), and writes the manifest (local CRS). A png-packed cloud needs no PDAL and the pipeline reads it whole (`read_region`).

- [ ] **Step 1: Write the spec** (`test.use({ appEnv: PIPELINE_ENV })`, `test.skip(!hasPipelinePython(), …)`):

```ts
// openTiny(win): the project-card click and canvas wait of openFace in telecom-measurements.spec.ts
test('hides Detect antennas in a project without a point cloud', async ({ win }) => {
  await openTiny(win);
  await expect(win.getByTestId('telecom-tools')).toBeVisible();
  await expect(win.getByTestId('detect-antennas')).toHaveCount(0);
});
test('detects antennas, accepts one and keeps it after a reload', async ({ win, dataRoot }) => {
  await writeTelecomTower(dataRoot.projectDir);
  await openTiny(win);
  await win.getByTestId('detect-antennas').click();
  const rows = win.getByTestId('antenna-panel').getByTestId('antenna-row');
  await expect.poll(() => rows.count(), { timeout: 180_000 }).toBeGreaterThanOrEqual(3);
  await expect(win.getByTestId('antenna-panel')).toContainText('Project north');
  await rows
    .first()
    .getByRole('button', { name: /^More for / })
    .click();
  await win.getByRole('menuitem', { name: 'Accept' }).click();
  await expect(rows.first()).toHaveAttribute('data-status', 'accepted');
  await expectAccessible(win, 'Antenna inventory', { include: '[data-testid="antenna-panel"]' });
  await win.reload();
  // reopen as telecom-measurements.spec.ts does, then:
  await expect(win.getByTestId('antenna-panel').getByTestId('antenna-row').first()).toHaveAttribute(
    'data-status',
    'accepted',
  );
  const saved = AntennasFile.parse(
    JSON.parse(await readFile(join(dataRoot.projectDir, 'telecom', 'antennas.json'), 'utf8')),
  );
  expect(saved.units.filter((u) => u.status === 'accepted')).toHaveLength(1);
});
```

- [ ] **Step 2: Run to fail** with `writeTelecomTower` still throwing `new Error('not implemented')`: from `apps/desktop`, `pnpm demo:build --quick`, then `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/telecom-antennas.spec.ts --workers=1`; expect the second test to FAIL on "not implemented".
- [ ] **Step 3: Implement** `packPngCloud` and `writeTelecomTower`, then run `e2e/telecom-antennas.spec.ts e2e/telecom-measurements.spec.ts` the same way; expect PASS, and the log line `[e2e] window 1100 x 720 px at display scale 1`. Fix whatever the CI-sized window shows (the panel scrolls inside the right aside; the button is not clipped). Re-run with `--repeat-each=3`.
- [ ] **Step 4: Commit** `git commit -m "test(e2e): detect antennas on a synthetic tower, accept and reload"`.

## Task 13: Guide page and known limits

**Files:**

- Create: `docs/guide/45-antenna-inventory.md`
- Modify: `docs/KNOWN-LIMITS.md` (new `## Telecom antenna inventory` section after `## Engineering models`)

**Packages touched:** docs.

**Interfaces:**

- Consumes: the UI names of Task 11 and the en.ts strings of Task 1.

- [ ] **Step 1: Write the guide**, in the style of `44-engineering-models.md`: when to use it (a tower project with a point cloud), **Detect antennas** in the Telecom tools, the tower click when asked, reading the inventory (true and grid north, project north without a CRS, mechanical downtilt, plumb sign, basis and fit quality on hover), review (accept, reject, equipment fields, re-run keeps your review, "Not found in latest run"), photos, **Label with AI** (off by default, the preview shows every crop, AI never changes a number), CSV export, and that the engineering model's antennas stay approximate while the inventory is measured.
- [ ] **Step 2: Write the limits** as single-line bullets: needs a monopole or lattice tower axis (no rooftop or water-tower sites); grid and true north only; mechanical tilt only; small radio units and units merged with neighbours can be missed; thresholds are tuned on synthetic crowns and one reference site; photo occlusion is not checked; png-packed and kit-packed clouds are read whole; the engineering model does not read the inventory yet.
- [ ] **Step 3: Run** `npx prettier --write docs/guide/45-antenna-inventory.md docs/KNOWN-LIMITS.md`, `node tools/agent/check-public-text.mjs docs/guide/45-antenna-inventory.md docs/KNOWN-LIMITS.md` and `pnpm format:check`; expect clean.
- [ ] **Step 4: Commit** `git commit -m "docs(guide): antenna inventory page and known limits"`.

## Merge 2 (later, after the stage-island stage 2 workbench lands)

- The **Detect antennas** entry moves to a tile in the island's Measure group, next to the telecom tools (stage-island plan Tasks 12 and 13 name the files).
- `AntennaInventory` moves into `<Section id="telecom-antennas" bench="measure">` in `MeasureBench`; `AntennaDetails` is hosted by the live card or the row's ⋯.
- Progress shows only through the jobs chip and the island live line.
- The CSV button moves under the Measure bench's export menu, next to "Export survey data".
- `DetectAntennas.tsx`'s temporary panel and its mount line in `TelecomTools.tsx` are deleted; the availability rules (hidden without a cloud, disabled only while running or loading) carry over.
- `telecom-antennas.spec.ts` drives the island tile instead. The UI rework session reviews the wiring diff before it merges.
