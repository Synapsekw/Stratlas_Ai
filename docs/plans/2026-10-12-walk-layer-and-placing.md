# Walk layer and placing: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** a 360 walk becomes a `walk` layer that a person places on a drawing or the map with two
or more pins, and whose path and still dots show on that surface.

**Architecture:** `@aio/schema` gains the layer kind, the calibration and the two pipeline file
schemas. A pure fit in `@aio/geo` (`walk/`) turns raw path + pins into model positions and
headings; the renderer runs it live while pins move, `@aio/project` runs the same code on save to
write `pose.json`. Main migrates side-folder walks to layers on open. The renderer adds a place
session store, the **Place walk** strip, and the path drawn on the drawing pane (image pixels) and
the map (GeoJSON overlay).

**Tech stack:** TypeScript strict, zod 4, Vitest, React 19 + zustand, MapLibre, Playwright with
Electron.

**Spec:** `docs/plans/2026-10-12-walk-layer-and-placing-design.md` (read it first; this plan argues
from it). Parent design: `docs/plans/2026-10-07-walks-360-design.md`.

## Global constraints

- Work only in `E:\Dev\AIO Software\.claude\worktrees\walk-layer-and-placing`. Stage by path,
  never `git add -A`, never `git stash`, never `--no-verify`.
- TypeScript strict, no `any`, no non-null assertions. Public API from each package's
  `src/index.ts`; package dependencies as in `docs/architecture/SPEC.md` section 2 (`@aio/geo`
  depends on `@aio/schema` only).
- Renderer code never imports `electron` or `node:*`.
- No em or en dashes in user-facing text; sentence case; no emoji.
- No client, site or tester names anywhere (`node tools/agent/check-public-text.mjs <files>`).
- e2e windows stay off-screen (the fixtures do it); `--workers=1`; one Playwright run at a time.
- Heavy commands (checks, e2e, commits) go through the shared runner:
  `node "C:/Users/D/AppData/Local/Temp/claude/E--Dev-AIO-Software/68c639ff-ec76-48fc-8873-7df406c7d74b/scratchpad/heavy.mjs" --cwd "<worktree>" '<command>'`.
- Commits: conventional (`feat(schema): ...`), ending
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Values fixed by the spec: layer id `walk-<walk id>`; `heightM` default 1.7; two pins at least
  5 m apart; blend window 2 s either side of a pin; quality thresholds 0.5 m (`check`) and 2 m
  (`poor`); at most 64 pins; pose rate 30 Hz with an orientation file (decimated), else 10 Hz; pose lens
  `{ model: 'pinhole', hfovDeg: 90, aspect: 2 }`; `.trash/` kept seven days; app version 0.12.0.

## Review focus

1. **A drawing placed again after the walk was placed on it**: the walk must follow (pose
   rewritten). Test in task 5 (`rewrites the pose when a pinned drawing gets new corners`).
2. **Opening a project twice, or a project already migrated by another machine**: migration must
   not add a second layer. Test in task 3 (`is idempotent`, `matches by record path, not id`).
3. **A walk whose `raw-path.json` is missing, corrupt, or `aio.walkpath/2`**: places pins-only,
   never throws. Tests in tasks 2 (`pins-only when raw is null`) and 5 (`reads a corrupt raw path
as missing`).
4. **Pins all at the same time or the same spot, and pins dragged past each other in time**:
   refusal text, sorted pins, no NaN in the path. Tests in task 2 (`refuses pins under 5 m`,
   `sorts pins by t`, `never returns NaN`).
5. **A project with no coordinate system**: Map is not offered, drawings work. Test in task 8
   (`offers no Map without a CRS`) and task 12 (e2e uses a project with no CRS).

---

## Execution DAG

```
                 T1 schema + fixture (G0)
        ┌──────┬───────┼────────┬────────┬────────┐
        T2     T3      T4       T6       T7       (T1 only)
       fit   migrate  package  compat   kind
        │      │      + sync   corpus   lists
        ├──────┼──────┐
        T5     T8     T9       T10 (needs T3)    T11 (needs T3)
       pose  session overlays  Datasets rows      remove walk
        │      │      │         │
        └──────┴──────┴────┬────┘
                           T12 Place walk strip (needs T5, T8, T9, T10)
                           │
                           T13 e2e, docs, version (needs all)
```

| Batch | Tasks (run at once, no shared files) | Waits for                                      |
| ----- | ------------------------------------ | ---------------------------------------------- |
| 0     | T1                                   | nothing                                        |
| 1     | T2, T3, T4, T6, T7                   | T1                                             |
| 2     | T5, T8, T9, T10, T11                 | batch 1 (T5: T2, T3; T8, T9: T2; T10, T11: T3) |
| 3     | T12                                  | T5, T8, T9, T10                                |
| 4     | T13                                  | all                                            |

**Critical path:** T1, T2, T8, T12, T13 (the fit and the place session carry the feature).

Shared-file check per batch: batch 1 touches schema-free areas only (T2 `packages/geo/src/walk/`;
T3 `packages/project/src/builder/walk*.ts`, `raw.ts`, `apps/desktop/src/main/project.ts`; T4
`packages/project/src/package/*`, `packages/sync/src/blobs/*`, `packageModel.ts`,
`PackageExport.tsx`, `export/house.ts`; T6 `tools/compat/*`, `docs/release/*`; T7 `packages/ai`,
`packages/workspace/src/captures.ts`, `CompareScene.tsx`, `Stage.tsx`, `SurveyDate.tsx`,
`Projects.tsx`, `reportPage/house/sections.ts`). Batch 2: T5 `packages/project/src/builder/walkPose.ts`
and `create.ts`; T8 `apps/desktop/src/renderer/walks/place*.ts`; T9 `packages/maps/src/*`,
`apps/desktop/src/renderer/walks/walkOverlay*.ts*`, `workspace/RasterPane.tsx`; T10
`packages/ui/src/tree/*`, `walks/WalkList.tsx`, `walks/walkStore.ts`, `walks/walks.ts`,
`shell/Sidebar.tsx`; T11 `apps/desktop/src/main/walks.ts`, `main/index.ts`, `main/journal.ts`,
`preload`, `packages/project/src/builder/walkRemove.ts`. No file is in two tasks of one batch.

## Package ownership

| Task | Packages                                                                          |
| ---- | --------------------------------------------------------------------------------- |
| T1   | `@aio/schema`, `@aio/ui` (tree group key only), desktop renderer (two maps), docs |
| T2   | `@aio/geo`                                                                        |
| T3   | `@aio/project`, desktop main                                                      |
| T4   | `@aio/project` (package, export), `@aio/sync`, desktop renderer                   |
| T5   | `@aio/project`                                                                    |
| T6   | `tools/compat`, docs                                                              |
| T7   | `@aio/ai`, `@aio/workspace`, desktop renderer                                     |
| T8   | desktop renderer (`walks/`)                                                       |
| T9   | `@aio/maps`, desktop renderer                                                     |
| T10  | `@aio/ui`, desktop renderer                                                       |
| T11  | `@aio/project`, desktop main, preload                                             |
| T12  | desktop renderer                                                                  |
| T13  | desktop e2e, docs, `apps/desktop/package.json`                                    |

## Sizes

S: under half a day of agent work; M: about one; L: more. T1 M, T2 L, T3 M, T4 M, T5 M, T6 S,
T7 S, T8 M, T9 L, T10 M, T11 S, T12 L, T13 M. Thirteen tasks.

## e2e specs

- **New** `apps/desktop/e2e/walk-place.spec.ts`: place on a drawing (date step, start, end, path
  dots, Pin here, Save, reopen), remove a walk.
- **Changed** `apps/desktop/e2e/walk-360.spec.ts`: the walk opens from its Datasets row (the
  separate list is gone); the imported walk is a layer.
- **Run, unchanged but at risk:** `drawings.spec.ts` (RasterView marks), `small-window.spec.ts`
  (strip in 1100 x 700).

## Contract change row (for `docs/architecture/contract-changes.md`)

```
| 2026-10-12 | **Major:** new layer kind `walk` (`Layer`), with `WalkCalibration` and `WalkPin`; side-folder walks (`walks/<id>/walk.json`, `aio.walk/1`) become `walk` layers on open. 0.10 and later keep the layer as an opaque entry; 0.9 and older refuse the project (upgrade note in RELEASE-NOTES and UPGRADE-POLICY). New file schemas `aio.walkpath/1` (`walks/<id>/raw-path.json`) and `aio.walkorient/1` (`walks/<id>/orientation.json` header plus `orientation.bin`, five float32 LE per record), written by `walk.process`, owned here. `walks/<id>/pose.json` is `aio.flight/1`. `LayerPatch` gains `{ walk: WalkCalibration \| null }`; a `{ corners }` patch on a drawing rewrites the pose of walks pinned to it. New IPC `walks:remove`. App 0.12.0. Compat: `tools/compat/walk-kind.test.mjs`, frozen `schema-0.11`. Approval: founder, 12 Oct 2026. |
```

---

### Task 1: Schema contract, fixture and the three kind maps (G0)

**Files:**

- Modify: `packages/schema/src/walks.ts` (add pin, calibration, raw path, orientation)
- Modify: `packages/schema/src/layers.ts` (the `walk` member)
- Modify: `packages/schema/src/builder.ts` (`LayerPatch` walk variant)
- Modify: `packages/schema/src/versions.ts` (two registry rows)
- Modify: `packages/schema/src/ipc.ts` (`walks:remove`)
- Modify: `packages/schema/src/index.ts` (exports)
- Modify: `packages/ui/src/tree/model.ts` (`TreeGroupKind` gains `walks`, `groupOf.walk`)
- Modify: `apps/desktop/src/renderer/workspace/SelectionCard.tsx` (`KIND.walk`)
- Modify: `apps/desktop/src/renderer/shell/Palette.tsx` (`LAYER_ICON.walk`, `LAYER_KIND.walk`)
- Create: `tools/fixtures/make-walk-path.mjs`, `packages/schema/src/__fixtures__/walk/raw-path.synthetic.json`, `.../orientation.synthetic.json`, `.../orientation.synthetic.bin`, `.../raw-path.broken.json`
- Modify: `docs/architecture/contract-changes.md`, `docs/architecture/data-conventions.md` (section 32)
- Test: `packages/schema/src/walks.test.ts`, `packages/schema/src/versions.test.ts`

**Interfaces (produces, used by every later task):**

```ts
// walks.ts
export const WALK_PATH_SCHEMA = 'aio.walkpath/1';
export const WALK_ORIENT_SCHEMA = 'aio.walkorient/1';
export const MODEL_SURFACE = '@model';
export const WALK_HEIGHT_M = 1.7;
export const MAX_WALK_PINS = 64;
export const WalkPin = z.object({
  t: z.number().nonnegative(),
  surface: z.union([z.literal(MODEL_SURFACE), Id]),
  at: z.tuple([z.number(), z.number()]),
  y: z.number().optional(),
}).strict();
export const WalkQuality = z.enum(['good', 'check', 'poor', 'unplaced']);
export const WalkCalibration = z.object({
  pins: z.array(WalkPin).max(MAX_WALK_PINS),
  yawOffsetDeg: z.number().min(-180).max(180),
  heightM: z.number().min(0).max(10).default(WALK_HEIGHT_M),
  quality: WalkQuality,
  placedOn: z.string().min(1).max(128).optional(),
}).strict();
export const WalkStill = z.object({
  n: z.number().int().nonnegative(), t: z.number().nonnegative(),
  pos: Vec3.optional(), q: Quat.optional(),
  segment: z.number().int().nonnegative().optional(), steps: z.number().nonnegative(),
});
export const WalkRawPath = z.object({
  schema: z.literal(WALK_PATH_SCHEMA), walk: z.string().min(1),
  source: z.enum(['sfm', 'pins-only']), up: Vec3.optional(),
  stills: z.array(WalkStill).min(1).max(100_000),
  walking: z.object({ startT: z.number(), endT: z.number() }).optional(),
  kept: z.array(z.number().int().nonnegative()).optional(),
});
export const WALK_ORIENT_LAYOUT = 'f32le-t-xyzw';
export const WALK_ORIENT_RECORD_BYTES = 20;
export const WalkOrientation = z.object({
  schema: z.literal(WALK_ORIENT_SCHEMA),
  rateHz: z.number().min(1).max(2000),
  count: z.number().int().nonnegative().max(50_000_000),
  convention: z.literal('xyzw-camera-threejs'),
  frame: z.literal('raw'),
  startOffsetS: z.number(),
  data: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),   // a file name in the walk's folder, no path
  layout: z.literal(WALK_ORIENT_LAYOUT),
});
/** Records of orientation.bin as [t, qx, qy, qz, qw] rows (t = playback seconds, startOffsetS added); null when the length is not count * 20. Non-finite records dropped, quaternions normalised. */
export function readWalkOrientationData(header: WalkOrientation, bytes: Uint8Array): Float64Array[] | null;
export const WalkPathRefs = z.object({ raw: AssetRef, orientation: AssetRef.optional(), orientationData: AssetRef.optional(), points: AssetRef.optional() }).strict();
export type WalkPin, WalkCalibration, WalkQuality, WalkStill, WalkRawPath, WalkOrientation, WalkPathRefs
// layers.ts: member of Layer
z.object({ kind: z.literal('walk'), ...base, record: AssetRef, src: AssetRef,
  poster: AssetRef.optional(), durationS: z.number().nonnegative(),
  path: WalkPathRefs.optional(), place: WalkCalibration.optional(), flight: FlightRef.optional() })
export type WalkLayer = Extract<Layer, { kind: 'walk' }>;
// builder.ts LayerPatch: new member
z.object({ walk: WalkCalibration.nullable() }).strict()
// ipc.ts
'walks:remove': { request: { projectId, layerId }, response: { ok: true, manifest } | { ok: false, error } }
```

Note: `layers.ts` must import `WalkCalibration` and `WalkPathRefs` from `walks.ts`, and `walks.ts`
must not import `layers.ts` (no cycle); `FlightRef` stays in `layers.ts`.

- [ ] **Step 1: Write the failing tests** in `walks.test.ts`:

```ts
describe('walk layer', () => {
  const layer = {
    kind: 'walk',
    id: 'walk-a',
    name: 'A',
    record: 'walks/a/walk.json',
    src: 'walks/a/playback.mp4',
    durationS: 81.9,
  };
  it('parses a bare walk layer and defaults visible', () => {
    expect(Layer.parse(layer)).toMatchObject({ kind: 'walk', visible: true });
  });
  it('parses a placed walk with a drawing pin and a model pin', () => {
    const place = {
      pins: [
        { t: 4, surface: 'sheet-ground', at: [120, 340] },
        { t: 80, surface: '@model', at: [12.5, -40], y: 2.1 },
      ],
      yawOffsetDeg: 0,
      quality: 'good',
    };
    expect(Layer.parse({ ...layer, place }).place?.heightM).toBe(1.7);
  });
  it('refuses 65 pins', () => {
    /* MAX_WALK_PINS + 1 pins: safeParse fails */
  });
  it('refuses a yaw offset of 200', () => {
    /* safeParse fails */
  });
  it('LAYER_KINDS has walk', () => expect(LAYER_KINDS.has('walk')).toBe(true));
});
describe('raw path and orientation files', () => {
  it('reads the synthetic fixture', () =>
    expect(WalkRawPath.safeParse(fixture).success).toBe(true));
  it('reads a still with no pose (unregistered)', () => {
    /* {n, t, steps} only */
  });
  it('refuses aio.walkpath/2', () => {
    /* readVersioned gives the newer-version refusal */
  });
  it('reads the orientation fixture', () => {
    /* success */
  });
});
describe('LayerPatch walk', () => {
  it('takes a calibration and null', () => {
    /* both parse */
  });
});
```

and in `versions.test.ts` assert `SCHEMA_REGISTRY` has `aio.walkpath` and `aio.walkorient`,
version 1, home `project`, since `0.12`.

- [ ] **Step 2: Run them, expect FAIL**: `pnpm --filter @aio/schema test -- walks versions`.
- [ ] **Step 3: Implement** the schema above, the registry rows
      (`where: 'walks/<id>/raw-path.json'` and `'walks/<id>/orientation.json'`), the IPC entry, the
      exports. Add `walks: '360 walks'` group to `TreeGroupKind` and `groupOf.walk = 'walks'` (label
      string key `tree.group.walks`, add it to the ui strings), `KIND.walk = { label: '360 walk', icon:
'pano' }`, `LAYER_ICON.walk = 'pano'`, `LAYER_KIND.walk = '360 walk'`.
- [ ] **Step 4: Fixture generator.** `tools/fixtures/make-walk-path.mjs` writes, deterministically
      (no randomness): an L-shaped walk, 40 m east then 30 m north in the model, sampled every 0.5 s at
      1.2 m/s, standing still for the first 4 s; the raw frame is the model rotated by 37 degrees about
      up, scaled by 0.23 and shifted by `[3, -1, 7]`, with `up: [0, 1, 0]`; stills carry `pos`, `q`
      (camera looking along the travel direction), `segment: 0`, `steps` (1.8 steps per metre),
      `walking: { startT: 4, endT: <last t> }`, `kept` every second still. The broken variant drops
      registration for t in [30, 38] and puts the stills after it in `segment: 1` with a different
      raw rotation (a second SfM model). The orientation header plus `orientation.synthetic.bin` sample the same orientation at 200 Hz (`startOffsetS: 0`), written with the `f32le-t-xyzw` layout.
      Header comment in each JSON is not possible, so the script's header says what the ground truth
      is: export it as `GROUND_TRUTH = { rotDeg: 37, scale: 0.23, shift: [3, -1, 7] }` from
      `tools/fixtures/walk-truth.mjs` for the tests of tasks 2 and 5.
- [ ] **Step 5: Docs.** Add the contract change row above. Rewrite data-conventions section 32 for
      the layer (fields as in the spec), the file list, the two new schemas, the pin surfaces and the
      pose file, removing "PROPOSAL pending founder review" from the title only for the parts the
      founder decided (keep the marker on the pipeline files).
- [ ] **Step 6: Run** `pnpm --filter @aio/schema test`, `pnpm typecheck` (the three maps compile),
      `pnpm format:check`. Expect PASS.
- [ ] **Step 7: Commit** `feat(schema): walk path and orientation files, the walk layer kind` (the pipeline branch cherry-picks this commit by its subject prefix `feat(schema): walk path and orientation files`).

### Task 2: The fit (`@aio/geo`, `walk/`)

**Files:**

- Create: `packages/geo/src/walk/horizontal.ts`, `similarity2.ts`, `fit.ts`, `quality.ts`,
  `pose.ts`, `index.ts`; tests next to each
- Modify: `packages/geo/src/index.ts` (export `walk/index`)

**Interfaces:**

- Consumes: `WalkRawPath`, `WalkOrientation`, `WalkPin`, `WalkCalibration`, `PoseSample` types
  (T1).
- Produces:

```ts
export type XZ = [number, number];
/** A drawing's affine from image px to model x/z (from its corners) and its base height. */
export interface SurfaceFrame {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  tz: number;
  baseY: number;
  provisional: boolean;
}
export interface WalkSurfaces {
  drawing(id: string): SurfaceFrame | null;
} // null: gone
export interface Sim2 {
  s: number;
  cos: number;
  sin: number;
  tx: number;
  tz: number;
}
export function sim2FromPairs(a0: XZ, a1: XZ, b0: XZ, b1: XZ): Sim2 | null; // null: degenerate
export function applySim2(m: Sim2, p: XZ): XZ;
export function horizontalPath(raw: WalkRawPath): {
  t: number[];
  xz: (XZ | null)[];
  segment: (number | null)[];
  steps: number[];
};
export function pinTarget(pin: WalkPin, s: WalkSurfaces): { xz: XZ; y: number | null } | null;
export interface FitPin {
  index: number;
  t: number;
  target: XZ;
  active: boolean;
  residualM: number | null;
}
export interface WalkFit {
  /** Model x/z and ground height at time t (seconds); null before two active pins. */
  at(t: number): { xz: XZ; groundY: number; headingRad: number; dashed: boolean } | null;
  pins: FitPin[];
  gaps: { fromT: number; toT: number }[]; // unpinned segments
  pinsOnly: boolean;
  notToScale: boolean;
  error: string | null; // e.g. the 5 m refusal
}
export function fitWalk(
  raw: WalkRawPath | null,
  cal: Pick<WalkCalibration, 'pins' | 'yawOffsetDeg'>,
  s: WalkSurfaces,
  durationS: number,
): WalkFit;
export function walkQuality(fit: WalkFit): WalkCalibration['quality'];
export function walkBadgeText(fit: WalkFit, fmt: (s: number) => string): string | null; // "Path broken 3:12 to 3:20: add a pin after the gap"
export function walkPathPoints(
  fit: WalkFit,
  raw: WalkRawPath | null,
  durationS: number,
): { line: { xz: XZ; dashed: boolean }[][]; stills: { n: number; t: number; xz: XZ }[] };
export function walkPoseSamples(
  fit: WalkFit,
  raw: WalkRawPath | null,
  orient: WalkOrientation | null,
  cal: WalkCalibration,
  durationS: number,
): PoseSample[];
export const MIN_PIN_SPAN_M = 5;
export const BLEND_S = 2;
```

- [ ] **Step 1: Failing tests** (`fit.test.ts`, using the fixture and `GROUND_TRUTH`):

```ts
it('maps the raw path onto the truth with two pins', () => {
  const pins = [pinAtTruth(4), pinAtTruth(lastT)]; // '@model' pins at the true positions
  const fit = fitWalk(raw, { pins, yawOffsetDeg: 0 }, noDrawings, dur);
  for (const t of [10, 25, 50]) expect(dist(fit.at(t)!.xz, truthXZ(t))).toBeLessThan(1e-6);
});
it('refuses pins under 5 m', () => {
  expect(fit.error).toMatch(/at least 5 m/);
  expect(fit.at(10)).toBeNull();
});
it('sorts pins by t', () => {
  /* pins given end first: same result as sorted */
});
it('blends without a jump at an inner pin', () => {
  // third pin 2 m off the truth at t=30: consecutive samples every 0.05 s differ < 1 cm + walk step
});
it('records the residual of an added pin', () => {
  /* third pin 3 m off: residualM ≈ 3 (±0.01) */
});
it('fits a broken path segment by segment', () => {
  /* broken fixture, pins in both segments: error < 1e-6 */
});
it('reports an unpinned segment as a gap', () => {
  /* pins only in segment 0: gaps = [{fromT:30,toT:...}], dashed */
});
it('pins-only by steps when raw is null', () => {
  /* 2 pins, midpoint by steps */
});
it('pins-only by time when steps are all zero', () => {});
it('moves with the drawing', () => {
  // pins on 'sheet-a' in px; surfaces.drawing('sheet-a') returns frame F, then F shifted 10 m east:
  // every at(t).xz moves 10 m east
});
it('deactivates a pin whose drawing is gone', () => {
  /* drawing() -> null: pin.active false */
});
it('never returns NaN', () => {
  /* pins at same t, at same spot, t beyond duration: no NaN anywhere */
});
```

`quality.test.ts`: two pins good; residual 0.6 check; 2.5 poor; one pin unplaced; gap check;
pins-only check; inactive pin check. Badge text for a gap uses `formatWalkTime`-style `m:ss`.
`pose.test.ts`: samples at 30 Hz with the orientation fixture (200 Hz decimated), 10 Hz without; `t` in ms from 0;
`pos[1] = groundY + heightM`; the heading of a sample equals fit heading plus `yawOffsetDeg`
(rotate 90 and compare the forward vector); positions match `fit.at`.

- [ ] **Step 2: Run, expect FAIL**: `pnpm --filter @aio/geo test -- walk`.
- [ ] **Step 3: Implement.**
  - `sim2FromPairs`: complex-number form: `m = (b1 - b0) / (a1 - a0)`, `s = |m|`, translation
    `b0 - m * a0`; null when `|a1 - a0| < 1e-9`.
  - `horizontalPath`: rotation taking `up` (or the mean camera down axis negated) to +Y
    (`Quaternion.setFromUnitVectors`-style math written out, no three.js dependency in geo), then
    `[x, z]`.
  - `fitWalk`: active pins sorted by `t`; raw position at each pin by linear interpolation between
    the registered stills around it in the pin's segment; segment fits per spec rules 4 to 6;
    `at(t)`: find the stretch, apply its `Sim2`; within `BLEND_S` of an inner pin mix the two
    stretches' outputs with smoothstep `w = 3u^2 - 2u^3`, `u = (t - (tp - BLEND_S)) / (2 * BLEND_S)`;
    residual of pin k = distance between its target and the fit made without it (only for k with
    two other active pins); ground: pins' `y` interpolated by time, else the drawing's `baseY`,
    else 0; heading: fitted rotation angle plus the raw camera yaw (or travel direction when
    pins-only).
  - `walkPoseSamples`: quaternion `Ry(heading + yawOffset)` composed with the raw camera pitch and
    roll; position `[x, groundY + heightM, z]`.
- [ ] **Step 4: Run, expect PASS**; `pnpm --filter @aio/geo typecheck`.
- [ ] **Step 5: Commit** `feat(geo): walk fit from pins, broken paths, pins-only and quality`.

### Task 3: Walk layers in a project and the migration

**Files:**

- Create: `packages/project/src/builder/walkLayers.ts`, `walkLayers.test.ts`
- Modify: `packages/project/src/builder/walks.ts` (`importWalk` returns the layer it adds),
  `packages/project/src/builder/raw.ts` (write that layer into the manifest with the import's other
  layers), `packages/project/src/builder/index.ts` (exports), `packages/project/src/builder/create.ts`
  (`PACKAGE_DIRS` gains `walks`)
- Modify: `apps/desktop/src/main/project.ts` (call `migrateWalks` after the manifest is read,
  before it is answered; package path: `walkLayersInMemory`)
- Test: `walkLayers.test.ts`, `raw.test.ts` (walk import adds a layer), `apps/desktop/src/main/project.test.ts` if present, else a case in the nearest main test

**Interfaces:**

```ts
export function walkLayerId(walkId: string, taken: ReadonlySet<string>): string; // walk-<id>, walk-<id>-2 ...
export function walkCaptureFor(walk: WalkFile, captures: readonly Capture[]): string | undefined; // single exact date match
export function walkLayerFor(
  walk: WalkFile,
  m: ProjectManifest,
  files: { raw: boolean; orientation: boolean; points: boolean },
): WalkLayer;
export function missingWalkLayers(
  walks: readonly WalkFile[],
  m: ProjectManifest,
  filesOf: (id: string) => { raw: boolean; orientation: boolean; points: boolean },
): WalkLayer[];
export async function migrateWalks(
  root: string,
): Promise<{ added: WalkLayer[]; saved: boolean; error?: string }>;
export async function refreshWalkPaths(root: string): Promise<string[]>; // fills `path` on layers whose files appeared; ids changed
```

- [ ] **Step 1: Failing tests:**

```ts
it('adds one layer per side-folder walk', async () => {
  /* tmp project, two walks/x/walk.json: 2 walk layers, ids walk-x */
});
it('sets the capture on a single exact date match', () => {
  /* capturedAt 2026-01-01T12:00:00, capture date 2026-01-01 */
});
it('sets no capture when two dates match or none does', () => {});
it('is idempotent', async () => {
  /* migrate twice: still 2 layers, second call saved=false */
});
it('matches by record path, not id', async () => {
  /* a layer walk-x-2 with record walks/x/walk.json exists: nothing added */
});
it('takes the next id when walk-x is used by another layer', () => {});
it('fills path when raw-path.json exists', () => {});
it('keeps unknown layers on save', async () => {
  /* manifest holds an opaque kind: still there after migration */
});
it('reports a failed save and keeps the layers in memory', async () => {
  /* injected write that throws */
});
it('a walk import writes its layer', async () => {
  /* raw.test: importWalk via the raw importer adds kind walk */
});
```

- [ ] **Step 2: Run, expect FAIL**: `pnpm --filter @aio/project test -- walkLayers raw`.
- [ ] **Step 3: Implement** with `updateManifestFile` (one read-and-save turn, backup as every
      save). In `main/project.ts`: after a folder project opens, `await migrateWalks(root)` then
      `refreshWalkPaths(root)`; when anything was added, read the manifest again for the answer and
      log `"<n> walks became layers"` through the project log the open path already uses. For a
      package, add `missingWalkLayers(packageWalks(...), manifest, ...)` to the answered manifest only.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(project): side-folder walks become walk layers on open`.

### Task 4: Packages, hub sync and the house export

**Files:**

- Modify: `packages/project/src/package/plan.ts` (`ownership()` walk case: the folder
  `walks/<id>/` as a prefix), `packages/project/src/package/package.ts` (`requiredFiles()` walk:
  `record`, `src`), `packages/project/src/package/planWalks.test.ts`,
  `packages/project/src/export/house.ts` (walk row: count, total length in minutes)
- Modify: `packages/sync/src/blobs/index.ts` (`layerFiles` walk), `packages/sync/src/blobs/fetch.ts`
  (walk on demand, as video), tests next to them
- Modify: `apps/desktop/src/renderer/packageModel.ts` (`GROUPS` gains `walk`, label "360 walks"),
  `apps/desktop/src/renderer/shell/PackageExport.tsx` (`groupIcon` walk: `pano`), `packageModel.test.ts`

**Interfaces:** consumes `WalkLayer` (T1). Produces nothing new for other tasks.

- [ ] **Step 1: Failing tests:**

```ts
// planWalks.test.ts
it('a walk layer owns its whole folder', () => {
  /* plan.layers share for walk-a includes walks/a/* incl. stills/ */
});
it('leaves the folder out when the walk layer is excluded', () => {});
it('still carries a side-folder walk with no layer', () => {
  /* old behaviour kept */
});
// package.test.ts
it('a walk layer needs its record and playback copy', () => {});
// sync blobs
it("layerFiles lists a walk layer's files", () => {
  // record, src, poster, path.raw, path.orientation, path.orientationData, path.points, flight.src; no stills
});
it('fetches walk files on demand', () => expect(fetchPolicy('walk')).toBe(fetchPolicy('video')));
// packageModel.test.ts
it('groups walks under 360 walks', () => {});
```

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @aio/project test -- plan package house`,
      `pnpm --filter @aio/sync test -- blobs`, `pnpm --filter desktop test -- packageModel`.
- [ ] **Step 3: Implement.** Update the two existing planWalks tests only where a walk now has a
      layer; the side-folder cases stay as they are.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(project): walk layers in packages, hub sync and the house export`.

### Task 5: The pose file

**Files:**

- Create: `packages/project/src/builder/walkPose.ts`, `walkPose.test.ts`
- Modify: `packages/project/src/builder/create.ts` (`patchLayers` walk patch; `updateLayers`
  writes the pose after a walk patch and after a corners patch on a drawing with pins on it)

**Interfaces:**

- Consumes: `fitWalk`, `walkQuality`, `walkPoseSamples`, `SurfaceFrame` (T2); `WalkLayer`,
  `LayerPatch` walk (T1); `placementFor` / drawing corners (`drawingPlacement.ts`).
- Produces:

```ts
export function surfacesOf(
  m: ProjectManifest,
  placements: ReadonlyMap<string, { baseY: number; provisional: boolean }>,
): WalkSurfaces;
export async function readWalkInputs(
  root: string,
  layer: WalkLayer,
): Promise<{ raw: WalkRawPath | null; orient: WalkOrientation | null; problems: string[] }>;
export async function writeWalkPose(
  root: string,
  m: ProjectManifest,
  layerId: string,
): Promise<{ flight: FlightRef | null; quality: WalkQuality }>;
```

- [ ] **Step 1: Failing tests:**

```ts
it('writes aio.flight/1 with pinhole 90 x 2 and samples from the fit', async () => {});
it('sets flight on the layer and the computed quality', async () => {
  /* quality from walkQuality, not from the patch */
});
it('clears flight and deletes pose.json when the walk patch is null', async () => {});
it('rewrites the pose when a pinned drawing gets new corners', async () => {
  // updateLayers(root, ['sheet-a'], { corners: shifted }) -> pose.json positions moved 10 m
});
it('reads a corrupt raw path as missing (pins-only) and reports it', async () => {});
it('reads aio.walkpath/2 as missing', async () => {});
it('startUtcMs from capturedAt read as UTC; 0 when absent', async () => {});
```

- [ ] **Step 2: Run, expect FAIL**: `pnpm --filter @aio/project test -- walkPose create`.
- [ ] **Step 3: Implement.** The quality saved is always recomputed in main (the renderer's value
      is a preview). The pose is written to `walks/<id>/pose.json.tmp` then renamed
      (`renameWhenFree`).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(project): walk pose file from the fit, rewritten when a drawing moves`.

### Task 6: Compatibility corpus and the upgrade note

**Files:**

- Create: `tools/compat/schema-0.11/` (via `node tools/compat/extract-schema.mjs 0.11`, as the
  0.10 copy was made), `tools/compat/walk-kind.test.mjs`
- Modify: `tools/compat/corpus/` (add `walk-layer` project, through `build-corpus.mjs`),
  `docs/release/UPGRADE-POLICY.md` (a "New layer kinds" paragraph and the walk note),
  `docs/release/RELEASE-NOTES-1.0.md` (an "Upgrading to 0.12" note with the spec's wording)

- [ ] **Step 1: Failing test** `walk-kind.test.mjs`:

```js
test('0.10 keeps a walk layer opaque and saves it back unchanged', () => {
  const r = schema010.parseManifestTolerant(walkProject);
  assert.ok(r.ok);
  assert.equal(r.value.unknownLayers[0].kind, 'walk');
  const saved = schema010.keepUnknownLayers(walkProject, r.value.manifest);
  assert.deepEqual(saved.value.layers.at(-1), walkProject.layers.at(-1));
});
test('0.11 keeps it too', () => {
  /* same with schema-0.11 */
});
test('0.9 refuses the project (expected, the upgrade note says so)', () => {
  /* schema-0.9 parse fails */
});
test('this build reads it as a walk layer', () => {
  /* current schema */
});
```

- [ ] **Step 2: Run, expect FAIL**: `node --test tools/compat/walk-kind.test.mjs`.
- [ ] **Step 3: Implement** the corpus entry and docs.
- [ ] **Step 4: Run, expect PASS**, plus `node --test tools/compat/corpus.test.mjs`.
- [ ] **Step 5: Commit** `test(compat): walk layer kind across 0.9, 0.10 and 0.11`.

### Task 7: The other kind lists

**Files:**

- Modify: `packages/ai/src/tools.ts` (`list_layers` enum gains `walk`), `packages/ai/src/site.ts`
  (count walks), `packages/workspace/src/captures.ts` (`DATED_KINDS` gains `walk`),
  `apps/desktop/src/renderer/workspace/CompareScene.tsx` (`SECOND_VIEW_DROPS` gains `walk`),
  `apps/desktop/src/renderer/workspace/Stage.tsx` (DatesOnScreen kinds: walk counts),
  `apps/desktop/src/renderer/change/SurveyDate.tsx`, `apps/desktop/src/renderer/screens/Projects.tsx`,
  `apps/desktop/src/renderer/reportPage/house/sections.ts`
- Test: the nearest existing test of each (`captures.test.ts`, `tools.test.ts`, `site.test.ts`)

- [ ] **Step 1: Failing tests**: `captureIndex` dates a walk named after a capture; `list_layers`
      accepts `kind: 'walk'`; the site summary counts one walk.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: walk layers in dates, compare, the agent and the house report`.

### Task 8: The place session (renderer, pure model and store)

**Files:**

- Create: `apps/desktop/src/renderer/walks/placeModel.ts`, `placeModel.test.ts`,
  `apps/desktop/src/renderer/walks/placeStore.ts`, `placeStore.test.ts`

**Interfaces:**

- Consumes: `fitWalk`, `walkQuality`, `walkBadgeText`, `walkPathPoints`, `SurfaceFrame` (T2),
  `WalkLayer` (T1).
- Produces:

```ts
export type PlaceStep = 'date' | 'surface' | 'start' | 'end' | 'correct';
export type PlaceSurface =
  { kind: 'drawing'; id: string; name: string; dated: boolean } | { kind: 'map' };
export function placeSurfaces(m: ProjectManifest, walk: WalkLayer, hasCrs: boolean): PlaceSurface[]; // walk's date drawings, undated drawings, then map
export function surfaceFramesOf(m: ProjectManifest): WalkSurfaces; // from raster corners; baseY from tl[1]
export function firstStep(walk: WalkLayer): PlaceStep; // 'date' when no capture
export function dateChoices(
  walk: WalkLayer,
  captures: readonly Capture[],
  capturedAt?: string,
): { pick: string[]; add?: string };
export interface PlaceState {
  layerId: string | null;
  step: PlaceStep;
  surface: PlaceSurface | null;
  pins: WalkPin[];
  yawOffsetDeg: number;
  armed: 'start' | 'end' | 'pin' | 'align-360' | 'align-surface' | null;
  timeS: number;
  dirty: boolean;
  error: string | null;
  align: { yawRad: number; t: number } | null;
  start(walk: WalkLayer, m: ProjectManifest): void;
  chooseSurface(s: PlaceSurface): void;
  setTime(t: number): void;
  click(surfaceAt: [number, number], y?: number): void; // drops the armed pin, or finishes align
  pinHere(): void;
  movePin(i: number, at: [number, number]): void;
  removePin(i: number): void;
  armAlign(): void;
  align360(yawRad: number): void;
  setYaw(deg: number): void;
  calibration(): WalkCalibration; // with quality from the live fit
  cancel(): void;
}
export function createPlaceStore(deps: {
  fit: typeof fitWalk;
  seek: (t: number) => void;
}): StoreApi<PlaceState>;
```

- [ ] **Step 1: Failing tests** (`placeModel.test.ts`, `placeStore.test.ts`):

```ts
it('offers no Map without a CRS', () => {});
it("lists the walk's date drawings, then undated ones, then Map", () => {});
it('starts at the date step when the walk has no capture', () => {});
it('date choices: the capturedAt date first, add when missing', () => {});
it('start then end then correct; seeks to walking.startT and endT', () => {
  // seek called with 4 then lastT from the fixture
});
it('keeps the start pin when the end is under 5 m and shows the error', () => {});
it('pinHere arms a pin at the current time; a click drops it; pins stay sorted by t', () => {});
it('movePin marks dirty and changes the live fit', () => {});
it('align sets the yaw offset so the landmark bearing matches', () => {
  // align360(yawRad of landmark in camera frame), click(target): yawOffsetDeg equals the expected angle within 0.01
});
it('setYaw wraps to -180..180', () => {});
it('cancel restores nothing and clears the session', () => {});
it('pins on a drawing store image px; pins on the map store model x/z with surface @model', () => {});
```

- [ ] **Step 2: Run, expect FAIL**: `pnpm --filter desktop test -- placeModel placeStore`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(desktop): the place walk session model`.

### Task 9: The path on the drawing pane and on the map

**Files:**

- Create: `apps/desktop/src/renderer/walks/walkOverlay.ts` (pure geometry), `walkOverlay.test.ts`,
  `apps/desktop/src/renderer/walks/WalkSheetOverlay.tsx` (SVG in image pixels),
  `apps/desktop/src/renderer/walks/walkMapOverlay.ts` (`MapOverlay` builder), test
- Modify: `apps/desktop/src/renderer/workspace/RasterPane.tsx` (`RasterView` gains an optional
  `overlay` render prop drawn inside `.raster-plane` with the view scale, and draggable marks:
  `RasterPick.onDrag?(index, px)`), `packages/maps/src/controller.ts` (a one-shot point pick:
  `pickPoint(onPick: (local: Vec3) => void): () => void`, cursor crosshair while armed, Escape
  cancels), `packages/maps/src/MapView.tsx` (pass through), tests in `packages/maps/src/controller.test.ts` if present else `pick.test.ts`
- Modify: the map pane mount in `apps/desktop/src/renderer/workspace/` that owns `MapView` (call
  `setOverlays` with the walk overlays alongside the existing ones)

**Interfaces:**

- Consumes: `walkPathPoints`, `WalkFit` (T2), `WalkLayer` (T1), `--date-N` colours (existing
  `captureColour` helper in `@aio/workspace`).
- Produces:

```ts
export interface WalkDrawing { id: string; colour: string; line: { pts: [number, number][]; dashed: boolean }[]; stills: [number, number][]; pins: { at: [number, number]; n: number; active: boolean }[]; now?: { at: [number, number]; headingRad: number } }
export function toSheet(frame: SurfaceFrame, xz: XZ): [number, number];   // inverse affine, model -> image px
export function walkDrawingsForSheet(walks: readonly { layer: WalkLayer; fit: WalkFit; raw: WalkRawPath | null }[], sheet: SurfaceFrame, colourOf: (l: WalkLayer) => string, opts: { placingId: string | null; nowT: number | null }): WalkDrawing[];
export function walkMapOverlays(walks: ..., proj: { toLonLat(v: Vec3): [number, number] }, colourOf, opts): MapOverlay[];
export function WalkSheetOverlay(props: { drawings: WalkDrawing[]; scale: number; onPinDrag?: (layerId: string, i: number, px: [number, number]) => void }): JSX.Element;
```

- [ ] **Step 1: Failing tests:**

```ts
it('toSheet inverts the drawing affine', () => {
  /* round trip px -> model -> px within 1e-9 */
});
it('splits the line at a gap and marks it dashed', () => {});
it('draws a walk on every drawing, not only its own', () => {});
it('hides unplaced walks except the one being placed', () => {});
it('drops points outside a generous sheet bound (no huge SVG paths)', () => {
  /* clamp to 4x sheet size */
});
it('map overlay: a line layer, a circle layer for stills, one for pins, in the date colour', () => {});
it('map pick returns the local point of the click and disarms', () => {
  /* controller with a fake map */
});
it('RasterView: dragging a mark calls onDrag, a plain click still picks', () => {
  /* testing-library pointer events */
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Line 2 px, still dots 3 px, pins as numbered 18 px markers, all at a
      constant screen size (`scale(1/view.scale)` as the place marks). Outside a place session the
      line is at 60 % opacity. Keep `drawings.spec.ts` behaviour: no overlay prop, no change.
- [ ] **Step 4: Run, expect PASS**, plus `pnpm --filter @aio/maps test`.
- [ ] **Step 5: Commit** `feat(desktop): walk path, stills and pins on drawings and the map`.

### Task 10: Walks in the Datasets tree

**Files:**

- Modify: `packages/ui/src/tree/model.ts` (`metaOf` walk: length `m:ss`), `packages/ui/src/tree/DatasetTree.tsx`
  (walk row badge slot and the group header action), ui strings, tests
- Modify: `apps/desktop/src/renderer/walks/walkStore.ts` (walks come from the manifest's walk
  layers; `walks:list` only for the record details), `walks.ts`, `walkStore.test.ts`,
  `apps/desktop/src/renderer/walks/Walk360Pane.tsx` (reads the layer: `src`, `poster`),
  `apps/desktop/src/renderer/shell/Sidebar.tsx` (drop `<WalkList />`), delete `WalkList.tsx`
- Create: `apps/desktop/src/renderer/walks/walkBadge.ts`, test

**Interfaces:**

```ts
export type WalkBadge = {
  text: 'Needs placing' | 'Check placing' | 'Path not computed' | 'Files missing';
  tone: 'info' | 'warn';
} | null;
export function walkBadge(layer: WalkLayer, filesMissing: boolean): WalkBadge;
// DatasetTree: row actions for kind walk: 'open', 'place', 'remove' (callbacks from the app)
```

- [ ] **Step 1: Failing tests:** badge for each state (precedence: Files missing, Needs placing,
      Path not computed, Check placing); the tree puts a walk under 360 walks in its date folder; the
      group header shows **Add 360 video** (not in a package); the store lists walk layers in manifest
      order and keeps the selection across a manifest update.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(desktop): walks in the Datasets tree with their placing badge`.

### Task 11: Remove walk

**Files:**

- Create: `packages/project/src/builder/walkRemove.ts`, test
- Modify: `apps/desktop/src/main/index.ts` (`walks:remove` handler, refused for packages and
  read-only projects), `apps/desktop/src/main/journal.ts` (classify `walks:remove` as a write, as
  `builder:updateLayers`), `apps/desktop/src/preload/*` if channels are listed there,
  `apps/desktop/src/main/journal.test.ts`

**Interfaces:**

```ts
export async function removeWalk(
  root: string,
  layerId: string,
  now?: () => Date,
): Promise<ProjectManifest>; // layer out, folder to .trash/<stamp>-<id>
export async function sweepTrash(root: string, now?: () => Date): Promise<string[]>; // older than 7 days removed; called on open
```

- [ ] **Step 1: Failing tests:** removes the layer and moves the folder; refuses a layer that is not
      a walk; a missing folder still removes the layer; sweep keeps a 6-day-old entry and removes an
      8-day-old one; the journal classifies the channel; `.trash/` never goes into a package (`SKIP` in
      `plan.ts`, a one-line addition with its own test, coordinated with task 4 by landing after it).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(project): remove a walk, its files kept in .trash for seven days`.

### Task 12: The Place walk strip

Load `impeccable` and `frontend-design` before writing the component; follow the spec's "Visual
direction" and the existing `drawings/DrawingPane.tsx` `PlaceStrip` layout and classes.

**Files:**

- Create: `apps/desktop/src/renderer/walks/PlaceWalkStrip.tsx`, `placeWalk.css`,
  `apps/desktop/src/renderer/walks/placeWalk.ts` (glue: open the split, mount, save)
- Modify: `apps/desktop/src/renderer/walks/Walk360Pane.tsx` (time out to the place store, seek in,
  a click-to-pick-direction mode for Align view, the north tick when placed),
  `apps/desktop/src/renderer/drawings/DrawingPane.tsx` (mount the strip and the overlay when a
  walk is being placed on this drawing), the map pane mount (strip and pick), `walks/walks.ts`
  (`placeWalk(layerId)` action used by the tree row)
- Test: `PlaceWalkStrip.test.tsx`, `placeWalk.test.ts`

**Interfaces:**

- Consumes: everything from T5 (save through `builder.saveLayers([id], { walk })`, which answers
  the manifest with the pose written), T8 store, T9 overlays and map pick, T10 row action,
  `builder:ensureCapture` and `LayerPatch { capture }` for the date step.
- Produces: `placeWalk(layerId: string): void`.

- [ ] **Step 1: Failing tests** (testing-library):

```tsx
it('shows the date step with the capturedAt date first and Add survey date when missing', () => {});
it('Place on lists drawings and Map; choosing one opens it in the surface pane', () => {});
it('step text: Where did the walk start? Click the spot.', () => {});
it('only the current step button is primary', () => {});
it('Pin here is disabled until two pins exist', () => {});
it('the yaw field steps 1 with arrows and 10 with Shift', () => {});
it('Save sends the walk patch and closes; the badge updates from the answered manifest', () => {});
it('closing with unsaved pins asks inline: Keep these pins?', () => {});
it('pins-only note when the walk has no path', () => {});
it('no modal element is rendered at any step', () => {
  /* no role=dialog */
});
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** Strip copy, exactly:
      "Choose the survey date of this walk", "Place on", "Where did the walk start? Click the spot.",
      "Where did it end? Click the spot.", "Scrub to a moment, then Pin here and click the true spot.",
      "Click a landmark in the 360 view", "Now click the same landmark here", "Path not computed:
      the walk is placed between your pins.", buttons "Pin here", "Align view", "Save", "Cancel".
      Check the strip in 1100 x 700: it must not cover the drawing (`elementFromPoint` assert in T13).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(desktop): place a walk on a drawing or the map`.

### Task 13: End to end, docs and the version

**Files:**

- Create: `apps/desktop/e2e/walk-place.spec.ts`, `apps/desktop/e2e/walkFixture.ts` (builds the
  project: a PNG drawing via the drawing import path, a W1 walk folder with a 2 s equirect MP4 made
  by ffmpeg as `walk-360.spec.ts` does, the synthetic `raw-path.json` copied in, no CRS)
- Modify: `apps/desktop/e2e/walk-360.spec.ts` (open from the Datasets row)
- Modify: `apps/desktop/package.json` (`0.12.0`), `docs/TESTING.md` (a Walk placing stage),
  `docs/KNOWN-LIMITS.md` (3D view not a surface yet; stills not synced; walk not on the clock),
  `docs/guide/` page on 360 video (placing section), `docs/plans/2026-10-07-walks-360-design.md`
  (status line: decision 1 flipped to the `walk` kind, built parts)

- [ ] **Step 1: Write the spec:**

```ts
test('place a walk on a drawing', async ({ app }) => {
  // open fixture project; Datasets > Survey date folder > 360 walks shows the walk with "Needs placing"
  // row menu > Place walk; date step: pick the date; Place on: the drawing
  // strip says "Where did the walk start?"; click the sheet at the start px; then end px
  // expect the overlay path element and >= 10 still dots
  // scrub to 30 s; Pin here; click a spot; badge text in the strip updates
  // Save; badge gone from the row; reopen the project; still placed; pose.json exists in walks/<id>/
  // elementFromPoint on the drawing centre reaches the drawing, in 1100 x 700 too
});
test('remove a walk', async ({ app }) => {
  /* row menu > Remove walk > confirm inline: row gone, walks/<id> moved to .trash */
});
```

Skip only when ffmpeg is missing (CI installs it).

- [ ] **Step 2: Run the way CI does**, from `apps/desktop` (PowerShell):
      `$env:QUADRION_WINDOW_SIZE='1100x720'; $env:QUADRION_E2E_SCALE='1'; $env:QUADRION_E2E_SWGL='1'`
      after `pnpm demo:build --quick` (point `--python` and `QUADRION_E2E_PYTHON` at the main
      checkout's venv in a worktree), then
      `npx playwright test e2e/walk-place.spec.ts e2e/walk-360.spec.ts e2e/drawings.spec.ts e2e/small-window.spec.ts --workers=1`.
      Expect PASS and the line `[e2e] window 1100 x 720 px at display scale 1`.
- [ ] **Step 3: Docs and version**, `node tools/agent/check-public-text.mjs` on every changed doc.
- [ ] **Step 4: `pnpm check`** through the runner. Expect green.
- [ ] **Step 5: Commit** `test(desktop): place and remove a walk end to end; app 0.12.0`.

---

## How to test (for the founder, once built)

1. Open a project that has a 360 walk imported before this build (or import an `.insv` through
   **Add 360 video**). In **Datasets**, open its survey date folder: the walk is under **360
   walks** with **Needs placing**. (If the walk has no date it sits outside the date folders.)
2. Click the walk's row menu, **Place walk**. If it asks for a survey date, pick one (or **Add
   survey date**).
3. In **Place on**, pick a drawing (or **Map** when the project is on Earth). The split shows the
   360 video on one side and the drawing on the other.
4. The video jumps to where the walk starts. Click on the drawing where you were. It jumps to the
   end: click there. The whole path appears in the date's colour with dots for the stills.
5. Scrub the 360 to a corner of the walk, click **Pin here**, then click the true spot on the
   drawing. The path bends to it and the strip says how far it was off. Drag a pin: the path
   follows.
6. Click **Align view**, click a landmark in the 360, then the same landmark on the drawing: the
   north tick in the 360 moves.
7. **Save**. The badge goes. Close and reopen the project: the walk is still placed. Place the
   drawing itself again (**Place on the site**): the walk moves with it.
8. In **Export package**, untick **360 walks**: the package size drops by the walk's folder.
9. Row menu, **Remove walk**, confirm: the row goes; the files are in the project's `.trash`
   folder.

Until `walk.process` lands, a real walk shows **Path not computed** and places between your pins
only; the path follows the pins in straight stretches.

## Blockers and questions for the founder

1. **Merge order with `feat/walk-process-pipeline`:** task 1 (the `aio.walkpath/1` and
   `aio.walkorient/1` schemas) should land first, or that branch cherry-picks it, so the pipeline
   writes what placing reads.
2. **0.9 testers:** once a project has a walk layer, 0.9 and older cannot open it. Anyone still on
   0.9 must update before opening such a project.
3. **3D view as a surface** is left for W3 (with the 3D path). Say if you want it in this branch.
4. **Remove walk** moves the folder to `.trash/` for seven days rather than deleting it.
