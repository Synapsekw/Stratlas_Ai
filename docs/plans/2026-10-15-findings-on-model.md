# Findings on a Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach AI findings to a mesh or point-cloud layer the person picks, as a real area (an `spolygon` outline on a mesh, a `polygon3` prism plus a point `selection` on a cloud), draw those areas in the 3D view, suggest matches across survey dates, and let the assistant place findings behind the approval step.

**Architecture:** Projection runs in the renderer (spec approach A). `@aio/engine` gains a layer-filtered `raycastRay` and a ray-provider seam; `@aio/pointcloud` registers a cone ray query, a photo-frustum refine and a prism point query through it. `@aio/annotate` owns the projector (`crossview/place.ts`), the placed-area rules (automatic pin replaced, `from` kept consistent) and the overlay drawing; `@aio/change` owns footprint matching. The desktop renderer wires them: a placement store and controller, the offer bar in `Toasts`, the issue list's right-click entry and the assistant hooks.

**Tech Stack:** TypeScript strict (exactOptionalPropertyTypes, noUncheckedIndexedAccess), zod 4, three.js 0.186, React 19, zustand 5, Vitest, Playwright with Electron.

**Spec:** `docs/plans/2026-10-15-findings-on-model-design.md` (approved 15 Oct 2026). Executors read both.

## Global Constraints

- TypeScript strict everywhere; no `any`, no non-null assertions (`!`). `exactOptionalPropertyTypes` is on: never assign `undefined` to an optional field, spread `...(x ? { k: x } : {})` instead.
- Packages depend only on `schema` and the packages listed in `docs/architecture/SPEC.md` section 2: `annotate` may use engine, geo, video, ui, workspace, collab, never `pointcloud`; `ai` may use engine, geo, workspace, never `annotate`; `change` uses schema, ui, workspace, video, collab. The desktop renderer wires `annotate` to `pointcloud` and `ai`.
- Renderer code never imports `electron` or `node:*`; it talks to main through `window.aio` (the `bridge`).
- User-facing text lives in `packages/ui/src/i18n/en.ts` (keys `place.*`), with no emoji and no em or en dashes (CONTRIBUTING; `i18n.test.ts` enforces dashes).
- No string literal of the form `aio.<name>/<n>` for the selection file anywhere in `apps`, `packages`, `python/src` or `tools` (the registry test in `packages/schema/src/versions.test.ts` would demand a registry row). The selection file is identified by its magic `AIOSEL01`.
- Contract change: one row in `docs/architecture/contract-changes.md` (text in "Contract changes" below). Old files stay valid: every new schema field is optional.
- Writes to issues go through the issue editor (`issueEditor`), so undo, validation, saving and the journal work. Never `upsertIssue` from the placement code.
- Thresholds, verbatim from the spec: densify every **8 px**; mesh needs **at least 60 % hits and 3 points**; cloud grid **7 x 7**; reject hits farther than **3 MAD** from the median depth; pad a hull thinner than **0.1 m** to 0.1 m; cloud needs **at least 60 % of grid rays hitting and 3 hull points**; `refineAround` default timeout **3 s**; matching overlap = intersection over the smaller area, **at least 0.3**.
- Commits: conventional (`feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`), staged by path (never `git add -A` or `git add .`), every message ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Electron windows in tests stay off-screen (the e2e fixtures handle it; never launch Electron outside `e2e/fixtures.ts`). E2E with `--workers=1`, one Playwright run at a time.
- Work only in the worktree `E:\Dev\AIO Software\.claude\worktrees\findings-on-model` (branch `feat/findings-on-model`).

## Review Focus

The five inputs the spec implies but does not spell out, most likely to bite first. Each has a test in the task named.

1. **A photo no viewer has opened yet in this session** (its pixel size is unknown, so no camera can be built). Expected: placement learns the size from the image file and places it; it does not report "no photo outline". Test: Task 11, `ensureSizes` remembers the probed size; Task 11 store test "places an issue whose photo size was unknown".
2. **Placing on a hidden layer** (the change demo hides the earlier mesh and both clouds). Expected: the layer is shown, the placement waits for it, and only if it never loads does it say "not loaded". Test: Task 11 `layerReady` shows the layer; store test "reports every issue as not loaded when the layer never becomes ready".
3. **Placing the same finding on the same layer twice** (the person re-places after a bad first try). Expected: the second area replaces the first, no duplicates. Test: Task 7 `withPlacedArea` "replaces an earlier area on the same layer".
4. **Removing, moving or merging sightings after placing** (indices shift). Expected: every `from` still names the same photo sighting, or is dropped when that sighting went. Test: Task 7 ops tests "removeSighting reindexes from", "mergeIssues shifts from", "moveSighting drops from".
5. **Undo pressed after another edit happened** (the bar's Undo must not undo someone else's change), and **a read-only package**. Expected: Undo only undoes the placement step it made; on a package nothing is written and the bar shows the editor's refusal. Test: Task 11 store tests "undo only undoes its own step" and "shows the editor's refusal and writes nothing"; Task 1 main test "refuses to write into a package".

---

## Execution DAG

| Task | Title                                                         | Depends on       | Packages touched                                  |
| ---- | ------------------------------------------------------------- | ---------------- | ------------------------------------------------- |
| 1    | Schema contract, selection file, `project:writeSelection`     | none             | schema, tools (compat), apps/desktop (main), docs |
| 2    | Placement strings                                             | none             | ui                                                |
| 3    | Engine: layer-filtered `raycastRay`, ray providers            | none             | engine                                            |
| 4    | Point cloud: cone ray query, prism points, `refineAround`     | 3                | pointcloud                                        |
| 5    | Change: footprint matching, `suggestMatches`, Make issue fix  | none             | change                                            |
| 6    | Assistant tools: `place_on_model`, `add_sighting`, `layer`    | none             | ai                                                |
| 7    | Annotate: placed areas, `from` upkeep, pin marker, seams      | 1                | annotate                                          |
| 8    | Annotate: the projector (`crossview/place.ts`)                | 1, 3, 7          | annotate                                          |
| 9    | Annotate: drawing areas, hover, click, anchors                | 1, 7             | annotate                                          |
| 10   | Annotate: issue list right-click "Place on model..."          | 2, 7             | annotate                                          |
| 11   | Desktop: placement store, controller, accept and change hooks | 1, 2, 4, 5, 7, 8 | apps/desktop (renderer)                           |
| 12   | Desktop: offer bar and evidence start photo                   | 2, 7, 11         | apps/desktop (renderer)                           |
| 13   | Desktop: assistant hooks                                      | 6, 11            | apps/desktop (renderer)                           |
| 14   | End to end: `findings-on-model.spec.ts` and CI-style re-runs  | all              | apps/desktop (e2e)                                |

**Parallel batches** (each batch dispatched in one message; no task in a batch shares a file with another task of that batch):

| Batch | Tasks         | File overlap check                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1    | 1, 2, 3, 5, 6 | 1: `packages/schema/src/{annotation,selection,ipc,index,placement.test}.ts`, `tools/compat/findings-on-model-additive.test.mjs`, `apps/desktop/src/main/{selection,selection.test,index}.ts`, two docs. 2: `packages/ui/src/i18n/{en,i18n.test}.ts`. 3: `packages/engine/src/{types,stage/Stage,stage/Stage.test}.ts`. 5: `packages/change/src/*`. 6: `packages/ai/src/*`. Disjoint. |
| B2    | 4, 7          | 4: `packages/pointcloud/src/*`. 7: `packages/annotate/src/{model/*,crossview/camera*,crossview/derive*,runtime,index}.ts`. Disjoint.                                                                                                                                                                                                                                                 |
| B3    | 8, 9, 10      | 8: `annotate/src/crossview/{place,outline,frustum,lens}*.ts`, `annotate/src/index.ts`. 9: `annotate/src/tools/{areas,areas.test,overlay,mesh,mesh.test,scene.test}.ts`. 10: `annotate/src/components/{IssueRowMenu.tsx,IssueRegister.tsx,IssueRegister.test.tsx}`. Only Task 8 edits `index.ts` in B3. Disjoint.                                                                     |
| B4    | 11            | alone                                                                                                                                                                                                                                                                                                                                                                                |
| B5    | 12, 13        | 12: `renderer/placement/PlaceOnModelNotice{,.test}.tsx`, `renderer/exports/Toasts.tsx`, `renderer/issueCard/{model,model.test,evidence}.ts`. 13: `renderer/placement/{agentHooks,agentHooks.test,index}.ts`. Disjoint (Task 12 does not touch `placement/index.ts`).                                                                                                                 |
| B6    | 14            | alone                                                                                                                                                                                                                                                                                                                                                                                |

**Critical path:** 1 → 7 → 8 → 11 → 12 → 14 (six batches; 3 → 4 → 11 runs beside it and is one task shorter). Task 8 is the longest single task; start it first in B3.

## Tests per task

| Task | Unit tests (new or changed)                                                                                                                                                 | Run                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `schema/src/placement.test.ts` (fields, round-trip, selection codec, IPC request), `tools/compat/findings-on-model-additive.test.mjs`, `desktop/src/main/selection.test.ts` | `pnpm --filter @aio/schema exec vitest run src/placement.test.ts`, `pnpm exec vitest run tools/compat/findings-on-model-additive.test.mjs`, `pnpm --filter @aio/desktop exec vitest run src/main/selection.test.ts` |
| 2    | `ui/src/i18n/i18n.test.ts` (placement strings, existing dash and problem checks)                                                                                            | `pnpm --filter @aio/ui exec vitest run src/i18n/i18n.test.ts`                                                                                                                                                       |
| 3    | `engine/src/stage/Stage.test.ts` (layer filter, providers, `rayLayers`)                                                                                                     | `pnpm --filter @aio/engine exec vitest run src/stage/Stage.test.ts`                                                                                                                                                 |
| 4    | `pointcloud/src/rayMath.test.ts`, `cloudRay.test.ts`, `refine.test.ts`                                                                                                      | `pnpm --filter @aio/pointcloud exec vitest run src/rayMath.test.ts src/cloudRay.test.ts src/refine.test.ts`                                                                                                         |
| 5    | `change/src/footprint.test.ts`, `issues.test.ts` (footprint pairing, `suggestMatches`), `issueOps.test.ts` (cloud kind)                                                     | `pnpm --filter @aio/change exec vitest run src/footprint.test.ts src/issues.test.ts src/issueOps.test.ts`                                                                                                           |
| 6    | `ai/src/placement-tools.test.ts`, `renderer-tools.test.ts` (`layer`), existing `tools.test.ts`                                                                              | `pnpm --filter @aio/ai exec vitest run src/placement-tools.test.ts src/renderer-tools.test.ts src/tools.test.ts`                                                                                                    |
| 7    | `annotate/src/model/placed.test.ts`, `model/ops.test.ts`, `model/editor.test.ts`, `crossview/camera.test.ts`, `crossview/derive.test.ts`, `runtime.test.ts`                 | `pnpm --filter @aio/annotate exec vitest run src/model src/crossview src/runtime.test.ts`                                                                                                                           |
| 8    | `annotate/src/crossview/outline.test.ts`, `frustum.test.ts`, `place.test.ts`                                                                                                | `pnpm --filter @aio/annotate exec vitest run src/crossview`                                                                                                                                                         |
| 9    | `annotate/src/tools/areas.test.ts`, `mesh.test.ts`, `scene.test.ts`                                                                                                         | `pnpm --filter @aio/annotate exec vitest run src/tools`                                                                                                                                                             |
| 10   | `annotate/src/components/IssueRegister.test.tsx`                                                                                                                            | `pnpm --filter @aio/annotate exec vitest run src/components/IssueRegister.test.tsx`                                                                                                                                 |
| 11   | `desktop/src/renderer/placement/{layers,store,controller}.test.ts`                                                                                                          | `pnpm --filter @aio/desktop exec vitest run src/renderer/placement`                                                                                                                                                 |
| 12   | `desktop/src/renderer/placement/PlaceOnModelNotice.test.tsx`, `issueCard/model.test.ts`                                                                                     | `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/PlaceOnModelNotice.test.tsx src/renderer/issueCard/model.test.ts`                                                                                |
| 13   | `desktop/src/renderer/placement/agentHooks.test.ts`                                                                                                                         | `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/agentHooks.test.ts`                                                                                                                              |
| 14   | e2e only                                                                                                                                                                    | see Task 14                                                                                                                                                                                                         |

Every task ends with `pnpm typecheck` and `pnpm lint` (whole repo, quick) before its commit; the last task runs the full `pnpm check`.

**E2E specs.** Added: `apps/desktop/e2e/findings-on-model.spec.ts` (Task 14). Re-run unchanged, CI style: `agent.spec.ts`, `detections.spec.ts` (`@realdata`; skips without the founder's data), `change-core.spec.ts`, `change-cloud.spec.ts`.

The new spec uses the `demoProject` fixture (`e2e/fixtures.ts`), which opens the bundled change demo (`tools/demo/build-change-demo.mjs`, `pnpm demo:change --quick`). The demo has what the spec needs on two dates (`d1`, `d2`): a GLB mesh per date (`model-d1` hidden, `model-d2` shown), a `png-packed` point cloud per date (`cloud-d1`, `cloud-d2`, both hidden), posed photos (`photos-d1`, `photos-d2`, pinhole, rendered from the same scene, so poses are exact) and marker detection passes (`detections/markers-d1.json`, `markers-d2.json`) whose detections are already `accepted`. The demo lacks waiting detections, so the spec builds its fixture in the working copy before it opens the review: it copies one detection of a marker seen on both dates (`truth.changes.detection.items`, verdict `unchanged`) from each pass into `detections/e2e-d1.json` and `e2e-d2.json` with `status: 'draft'` and new ids. The detection review reads `detections/` the first time its screen opens, so the files are in place in time. No pipeline Python is needed for the new spec; `change-cloud.spec.ts` needs it, so point `QUADRION_E2E_PYTHON` at the main checkout's venv.

## Contract changes

`@aio/schema` (Task 1):

- `annotation.ts`: `PointSelection` (`type: 'selection'`) gains `lod?: number` (int, at least 0). The mesh and point-cloud `Sighting` variants gain `from?: { sighting: number }` (int, at least 0; strict object). New export `ProjectedFrom`.
- New `selection.ts`: the selection file format (see Task 1), `SELECTION_MAGIC`, `SELECTION_HEADER_BYTES`, `SELECTION_MAX_POINTS`, `SelectionName`, `selectionByteLength`, `encodeSelection`, `decodeSelection`.
- `ipc.ts`: new channel `project:writeSelection`.

The open spec point "does the deriver mark its pins" is resolved here: it does not today (`derive.ts` returns a bare `spoint`, and `Sighting` has no marker field). The marker is the new `from` itself: **an automatic crossview pin is a mesh `spoint` sighting that carries `from`**, the index of the image or video sighting it was back-projected from. Hand-placed pins never carry `from`. No third field is needed. Pins written before this change carry no `from` and are kept (listed under open risks).

The selection asset format: the codebase has no selection writer or reader (`type: 'selection'` is declared in the schema and read nowhere), so this plan defines a minimal one. Points are stored as float32 x, y, z in the project local frame, not as indices into octree chunks: chunk indices depend on how a cloud was tiled and decoded and break on any re-tiling or a COPC/png-packed switch, while coordinates need nothing but the file to read. Float32 keeps sub-millimetre precision within a few kilometres of the origin (the local frame is origin-relative), and a 50 000 point selection is 600 KB.

Row for `docs/architecture/contract-changes.md` (append at the end of the table, one line):

```markdown
| 2026-10-15 | Findings on a model (plan `2026-10-15-findings-on-model`). `annotation.ts`: the `selection` cloud geometry gains optional `lod` (the octree depth it was cut at, so a later recut knows it is partial); mesh and point-cloud sightings gain optional `from: { sighting }` (index of the issue's image or video sighting the area, or the automatic crossview pin, was projected from; an automatic pin is a mesh `spoint` with `from`). New `selection.ts`: the point selection file `selections/<name>.sel` (data-conventions section 35: little-endian magic `AIOSEL01`, uint32 count, uint32 lod, then count x 3 float32 x, y, z in the local frame), `SelectionName`, `encodeSelection`, `decodeSelection`. IPC additive: `project:writeSelection` (`{ projectId, name, data }` to `{ ok: true, path }` or `{ ok: false, error }`; refused on a package; not journalled). Older builds read these issues and drop the new fields. |
```

## Package ownership

| Task        | Owns (edits)                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| 1           | `packages/schema`, `tools/compat` (one new file), `apps/desktop/src/main` (selection writer), `docs/architecture` |
| 2           | `packages/ui` (`i18n/en.ts`, `i18n/i18n.test.ts` only)                                                            |
| 3           | `packages/engine`                                                                                                 |
| 4           | `packages/pointcloud`                                                                                             |
| 5           | `packages/change`                                                                                                 |
| 6           | `packages/ai`                                                                                                     |
| 7, 8, 9, 10 | `packages/annotate` (disjoint files, see batches)                                                                 |
| 11, 12, 13  | `apps/desktop/src/renderer` (disjoint files)                                                                      |
| 14          | `apps/desktop/e2e`                                                                                                |

## File Structure

New files and their single responsibility:

| File                                                         | Responsibility                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `packages/schema/src/selection.ts`                           | The selection file format: name rule, encode, decode, size limits                        |
| `apps/desktop/src/main/selection.ts`                         | Write `selections/<name>.sel` atomically after checking the bytes                        |
| `packages/pointcloud/src/rayMath.ts`                         | Pure: nearest point within a cone around a ray; points inside a vertical prism           |
| `packages/pointcloud/src/cloudRay.ts`                        | The stage ray provider over loaded chunks, and `pointsInPrism` for a layer               |
| `packages/pointcloud/src/refine.ts`                          | `refineAround`: load finer nodes inside a photo frustum, resolve on settle or timeout    |
| `packages/change/src/footprint.ts`                           | Pure plan-view footprints: hull, area, convex clip, overlap                              |
| `packages/ai/src/placement-tools.ts`                         | Executors of `place_on_model` and `add_sighting` (through `AppHooks`)                    |
| `packages/annotate/src/model/placed.ts`                      | What a placed area and an automatic pin are; keeping `from` right when sightings move    |
| `packages/annotate/src/crossview/camera.ts`                  | The camera (pose, lens, pixel size, shape) of an image or video sighting                 |
| `packages/annotate/src/crossview/outline.ts`                 | Pure 2D: outlines of shapes, densify, grid, point in ring, hull, padding, median and MAD |
| `packages/annotate/src/crossview/frustum.ts`                 | The six planes and pixel scale of a posed photo                                          |
| `packages/annotate/src/crossview/place.ts`                   | `placeOnLayer`: project a finding onto a mesh or cloud layer                             |
| `packages/annotate/src/tools/areas.ts`                       | Areas of placed issues: list, GPU buffers, screen rings, hit test                        |
| `packages/annotate/src/components/IssueRowMenu.tsx`          | The issue list's right-click menu                                                        |
| `apps/desktop/src/renderer/placement/layers.ts`              | Layer choices for the picker (same date first), which issues have a photo shape          |
| `apps/desktop/src/renderer/placement/store.ts`               | The placement store: offer, place, result, undo, match queue                             |
| `apps/desktop/src/renderer/placement/controller.ts`          | Live wiring: the scene and cloud ops, photo sizes, layer readiness, the selection write  |
| `apps/desktop/src/renderer/placement/index.ts`               | The app's placement store and its start-up (issue list action, assistant hooks)          |
| `apps/desktop/src/renderer/placement/PlaceOnModelNotice.tsx` | The offer bar, result and match suggestions                                              |
| `apps/desktop/src/renderer/placement/agentHooks.ts`          | `AppHooks.placeOnModel` and `AppHooks.addSighting` for the assistant                     |
| `apps/desktop/e2e/findings-on-model.spec.ts`                 | End to end on the change demo                                                            |

---

### Task 1: Schema contract, selection file and `project:writeSelection`

**Files:**

- Modify: `packages/schema/src/annotation.ts` (the `PointSelection` object and the `mesh` and `pointcloud` members of `Sighting`)
- Create: `packages/schema/src/selection.ts`
- Modify: `packages/schema/src/index.ts` (one `export * from './selection';` line after `./annotation`)
- Modify: `packages/schema/src/ipc.ts` (import from `./selection`; new channel after `project:writeIssues`)
- Test: `packages/schema/src/placement.test.ts` (new)
- Test: `tools/compat/findings-on-model-additive.test.mjs` (new)
- Create: `apps/desktop/src/main/selection.ts`
- Test: `apps/desktop/src/main/selection.test.ts` (new)
- Modify: `apps/desktop/src/main/index.ts` (import and one `handle(...)` next to `project:writeBoundaries`)
- Modify: `docs/architecture/contract-changes.md` (one row at the end), `docs/architecture/data-conventions.md` (new section 35)

**Interfaces:**

- Consumes: nothing new.
- Produces (all from `@aio/schema`):
  - `ProjectedFrom = z.object({ sighting: z.number().int().nonnegative() }).strict()`; on `Sighting` `{ on: 'mesh' }` and `{ on: 'pointcloud' }`: `from?: { sighting: number }`.
  - `PointSelection` gains `lod?: number`.
  - `SELECTION_MAGIC = 'AIOSEL01'`, `SELECTION_HEADER_BYTES = 16`, `SELECTION_MAX_POINTS = 2_000_000`, `SelectionName` (zod string `^[A-Za-z0-9_-]{1,120}$`), `selectionByteLength(count: number): number`, `encodeSelection(positions: Float32Array, lod: number): Uint8Array`, `decodeSelection(bytes: Uint8Array): { positions: Float32Array; lod: number } | null`.
  - IPC `'project:writeSelection'`: request `{ projectId: string; name: string; data: Uint8Array }`, response `{ ok: true; path: string } | { ok: false; error: string }`.
  - Main: `writeSelection(root: string, name: string, data: Uint8Array): Promise<IpcResponse<'project:writeSelection'>>` in `apps/desktop/src/main/selection.ts`.

- [ ] **Step 1: Write the failing schema test**

Create `packages/schema/src/placement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Issue } from './annotation';
import { ipc } from './ipc';
import {
  decodeSelection,
  encodeSelection,
  SELECTION_HEADER_BYTES,
  SelectionName,
  selectionByteLength,
} from './selection';

const base = {
  id: 'i1',
  code: 'F01',
  classId: 'crack',
  severityModelId: 'sev',
  severity: 2,
  status: 'draft',
  title: 'Crack',
  note: '',
  author: 'Demo',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  source: 'agent',
} as const;

const ring = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 0, 1],
];

const placed = {
  ...base,
  sightings: [
    { on: 'image', layer: 'photos', photo: 'P1', geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 } },
    { on: 'mesh', layer: 'model', geom: { type: 'spolygon', points: ring }, from: { sighting: 0 } },
    {
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'polygon3', points: ring, height: 0.4 },
      from: { sighting: 0 },
    },
    {
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'selection', src: { path: 'selections/i1-cloud.sel' }, count: 12, lod: 4 },
      from: { sighting: 0 },
    },
  ],
};

describe('findings on a model: issue fields', () => {
  it('keeps from on mesh and cloud sightings and lod on a selection through a JSON round trip', () => {
    expect(Issue.parse(JSON.parse(JSON.stringify(placed)))).toEqual(placed);
  });

  it('still reads issues without the new fields', () => {
    expect(Issue.safeParse({ ...base, sightings: [placed.sightings[0]] }).success).toBe(true);
  });

  it('refuses a negative or fractional from index, extra keys in from and a negative lod', () => {
    const accepts = (s: unknown) => Issue.safeParse({ ...base, sightings: [s] }).success;
    const mesh = placed.sightings[1];
    expect(accepts({ ...mesh, from: { sighting: -1 } })).toBe(false);
    expect(accepts({ ...mesh, from: { sighting: 0.5 } })).toBe(false);
    expect(accepts({ ...mesh, from: { sighting: 0, extra: 1 } })).toBe(false);
    const sel = placed.sightings[3];
    expect(accepts({ ...sel, geom: { ...sel?.geom, lod: -2 } })).toBe(false);
  });
});

describe('selection files', () => {
  it('round-trips points and the octree depth', () => {
    const pts = new Float32Array([0, 1, 2, -3.5, 4.25, 1e3]);
    const bytes = encodeSelection(pts, 6);
    expect(bytes.byteLength).toBe(selectionByteLength(2));
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('AIOSEL01');
    const back = decodeSelection(bytes);
    expect(back?.lod).toBe(6);
    expect([...(back?.positions ?? [])]).toEqual([...pts]);
  });

  it('refuses a wrong magic, a short file and a count that does not match the length', () => {
    const good = encodeSelection(new Float32Array([1, 2, 3]), 0);
    const wrong = good.slice();
    wrong[0] = 0x58;
    expect(decodeSelection(wrong)).toBeNull();
    expect(decodeSelection(good.subarray(0, SELECTION_HEADER_BYTES - 1))).toBeNull();
    expect(decodeSelection(good.subarray(0, good.byteLength - 4))).toBeNull();
  });

  it('refuses positions that are not whole points', () => {
    expect(() => encodeSelection(new Float32Array([1, 2]), 0)).toThrow('x, y, z');
  });

  it('names files with letters, digits, dash and underscore only', () => {
    expect(SelectionName.safeParse('i1-cloud-d2').success).toBe(true);
    expect(SelectionName.safeParse('../x').success).toBe(false);
    expect(SelectionName.safeParse('').success).toBe(false);
  });

  it('has an IPC channel that checks the name', () => {
    const req = ipc['project:writeSelection'].request;
    const data = encodeSelection(new Float32Array([0, 0, 0]), 1);
    expect(req.safeParse({ projectId: 'p', name: 'i1-cloud', data }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', name: 'a/b', data }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aio/schema exec vitest run src/placement.test.ts`
Expected: FAIL, `Cannot find module './selection'`.

- [ ] **Step 3: Add the fields to `annotation.ts`**

Replace the `PointSelection` declaration with:

```ts
export const PointSelection = z.object({
  type: z.literal('selection'),
  src: AssetRef,
  count: z.number().int().positive(),
  /** The octree depth the selection was cut at, so a later recut knows it is partial. */
  lod: z.number().int().nonnegative().optional(),
});
```

Above `export const Sighting`, add:

```ts
/**
 * The image or video sighting of the same issue that a 3D sighting was projected from (its
 * index in `sightings`): a placed area, or the automatic crossview pin (a mesh `spoint` with
 * `from`). Hand-placed sightings never carry it.
 */
export const ProjectedFrom = z.object({ sighting: z.number().int().nonnegative() }).strict();
```

In `Sighting`, change the `mesh` and `pointcloud` members to:

```ts
  z.object({ on: z.literal('mesh'), layer: Id, geom: MeshGeom, from: ProjectedFrom.optional() }),
```

```ts
  z.object({
    on: z.literal('pointcloud'),
    layer: Id,
    geom: CloudGeom,
    from: ProjectedFrom.optional(),
  }),
```

- [ ] **Step 4: Create `packages/schema/src/selection.ts`**

```ts
import { z } from 'zod';

/**
 * Point selection files (`selections/<name>.sel`, data-conventions section 35): the points of a
 * point cloud inside a placed finding, as float32 x, y, z in the project local frame (metres).
 * Little-endian: 8 bytes ASCII magic `AIOSEL01`, uint32 point count, uint32 octree depth (lod),
 * then count x 3 float32. Coordinates, not chunk indices: they survive a re-tiling of the cloud.
 */
export const SELECTION_MAGIC = 'AIOSEL01';
export const SELECTION_HEADER_BYTES = 16;
/** 2 million points, 24 MB: far more than one finding holds at loaded detail. */
export const SELECTION_MAX_POINTS = 2_000_000;

/** File name of a selection without `.sel`: letters, digits, dash and underscore. */
export const SelectionName = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/, {
  message: 'A selection name is letters, digits, dash and underscore (at most 120)',
});

export function selectionByteLength(count: number): number {
  return SELECTION_HEADER_BYTES + count * 12;
}

export function encodeSelection(positions: Float32Array, lod: number): Uint8Array {
  if (positions.length % 3 !== 0) throw new Error('A selection holds whole points (x, y, z)');
  const count = positions.length / 3;
  const out = new Uint8Array(selectionByteLength(count));
  out.set(new TextEncoder().encode(SELECTION_MAGIC), 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, count, true);
  view.setUint32(12, Math.max(0, Math.floor(lod)), true);
  for (let i = 0; i < positions.length; i++)
    view.setFloat32(SELECTION_HEADER_BYTES + i * 4, positions[i] ?? 0, true);
  return out;
}

/** The points and depth of a selection file; null when it is not one. */
export function decodeSelection(
  bytes: Uint8Array,
): { positions: Float32Array; lod: number } | null {
  if (bytes.byteLength < SELECTION_HEADER_BYTES) return null;
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== SELECTION_MAGIC) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const lod = view.getUint32(12, true);
  if (count > SELECTION_MAX_POINTS || bytes.byteLength !== selectionByteLength(count)) return null;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < positions.length; i++)
    positions[i] = view.getFloat32(SELECTION_HEADER_BYTES + i * 4, true);
  return { positions, lod };
}
```

Add to `packages/schema/src/index.ts`, after `export * from './annotation';`:

```ts
// Findings on a model: the point selection file (selections/<name>.sel)
export * from './selection';
```

- [ ] **Step 5: Add the IPC channel**

In `packages/schema/src/ipc.ts`, add to the imports:

```ts
import { SELECTION_MAX_POINTS, SelectionName, selectionByteLength } from './selection';
```

and after the `'project:writeIssues'` entry:

```ts
  /**
   * Write the points of a placed finding (`selections/<name>.sel`, data-conventions section 35),
   * replacing a file of that name. Refused on a package and for bytes that are not a selection
   * file. Not journalled (a binary asset, like a thumbnail). Answers the project path.
   */
  'project:writeSelection': {
    request: z
      .object({
        projectId: z.string().min(1),
        name: SelectionName,
        data: z
          .instanceof(Uint8Array)
          .refine((d) => d.byteLength <= selectionByteLength(SELECTION_MAX_POINTS), {
            message: 'A selection is at most 2 million points',
          }),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), path: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
```

- [ ] **Step 6: Run the schema tests to verify they pass**

Run: `pnpm --filter @aio/schema exec vitest run src/placement.test.ts src/versions.test.ts`
Expected: PASS (the registry test stays green: no `aio.<name>/<n>` literal was added).

- [ ] **Step 7: Write and run the compat test**

Create `tools/compat/findings-on-model-additive.test.mjs`:

```js
// Findings on a model (plan 2026-10-15-findings-on-model) is additive for files 0.11 reads:
// mesh and point-cloud sightings gain an optional `from`, the selection geometry an optional `lod`;
// 0.11's Issue drops what it does not know and keeps reading the issue.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const issue = {
  id: 'i1',
  code: 'F01',
  classId: 'crack',
  severityModelId: 'sev',
  severity: 2,
  status: 'draft',
  title: 'Crack',
  note: '',
  author: 'Demo',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  source: 'agent',
  sightings: [
    { on: 'image', layer: 'photos', photo: 'P1', geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 } },
    {
      on: 'mesh',
      layer: 'model',
      geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] },
      from: { sighting: 0 },
    },
    {
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'selection', src: { path: 'selections/i1-cloud.sel' }, count: 3, lod: 2 },
      from: { sighting: 0 },
    },
  ],
};

describe('findings on a model are additive', () => {
  it('0.11 reads an issue with placed areas', () => {
    expect(current.Issue.safeParse(issue).success).toBe(true);
    expect(v011.Issue.safeParse(issue).success).toBe(true);
  });
});
```

Run: `pnpm exec vitest run --project tools tools/compat/findings-on-model-additive.test.mjs`
Expected: PASS.

- [ ] **Step 8: Write the failing main test**

Create `apps/desktop/src/main/selection.test.ts`:

```ts
import { decodeSelection, encodeSelection } from '@aio/schema';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSelection } from './selection';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-sel-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const readBack = async (name: string) =>
  decodeSelection(new Uint8Array(await readFile(join(root, 'selections', `${name}.sel`))));

describe('writeSelection', () => {
  it('writes selections/<name>.sel and answers its project path', async () => {
    const data = encodeSelection(new Float32Array([1, 2, 3, 4, 5, 6]), 3);
    expect(await writeSelection(root, 'i1-cloud', data)).toEqual({
      ok: true,
      path: 'selections/i1-cloud.sel',
    });
    const back = await readBack('i1-cloud');
    expect(back?.lod).toBe(3);
    expect(back?.positions.length).toBe(6);
    // no temporary file left beside it
    expect(await readdir(join(root, 'selections'))).toEqual(['i1-cloud.sel']);
  });

  it('replaces a selection of the same name', async () => {
    await writeSelection(root, 'a', encodeSelection(new Float32Array([0, 0, 0]), 1));
    await writeSelection(root, 'a', encodeSelection(new Float32Array([1, 1, 1, 2, 2, 2]), 2));
    expect((await readBack('a'))?.positions.length).toBe(6);
  });

  it('refuses bytes that are not a selection file', async () => {
    expect(await writeSelection(root, 'a', new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      error: 'The point selection is not a valid selection file.',
    });
  });
});
```

Run: `pnpm --filter @aio/desktop exec vitest run src/main/selection.test.ts`
Expected: FAIL, `Cannot find module './selection'`.

- [ ] **Step 9: Create `apps/desktop/src/main/selection.ts` and its handler**

```ts
/**
 * Point selections of placed findings (`<root>/selections/<name>.sel`, data-conventions section
 * 35): written whole through a temporary file and a rename, after the bytes are checked. Binary
 * assets beside issues.json, not journalled (like the thumbnail cache). Packages are refused by
 * the IPC handler before this runs.
 */
import { decodeSelection, type IpcResponse } from '@aio/schema';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SELECTIONS_DIR = 'selections';

export async function writeSelection(
  root: string,
  name: string,
  data: Uint8Array,
): Promise<IpcResponse<'project:writeSelection'>> {
  if (!decodeSelection(data))
    return { ok: false, error: 'The point selection is not a valid selection file.' };
  const dir = join(root, SELECTIONS_DIR);
  const file = join(dir, `${name}.sel`);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, file);
    return { ok: true, path: `${SELECTIONS_DIR}/${name}.sel` };
  } catch (e) {
    return {
      ok: false,
      error: `The point selection was not saved: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
```

In `apps/desktop/src/main/index.ts`, add `import { writeSelection } from './selection';` next to the `./orientation` import, and after the `handle('project:writeBoundaries', ...)` block:

```ts
handle('project:writeSelection', ({ projectId, name, data }) => {
  if (registry.package(projectId))
    return {
      ok: false,
      error: 'This project is a read-only package. Its findings cannot be changed.',
    };
  const root = registry.root(projectId);
  if (root === undefined) return { ok: false, error: `Project "${projectId}" is not open.` };
  return writeSelection(root, name, data);
});
```

The package refusal is the Review Focus 5 guard on the main side; the handler is a three-line branch like `project:writeBoundaries`, so it is checked by Task 14's e2e (the demo is a folder, not a package) and by review, not a separate unit test.

- [ ] **Step 10: Run the main test to verify it passes**

Run: `pnpm --filter @aio/desktop exec vitest run src/main/selection.test.ts`
Expected: PASS.

- [ ] **Step 11: Document the contract**

Append the row from "Contract changes" above to the table in `docs/architecture/contract-changes.md`. Append to `docs/architecture/data-conventions.md`:

```markdown
## 35. Findings placed on a model (`selections/`)

An issue found in a photo or video frame can be placed on a mesh or point-cloud layer (plan `2026-10-15-findings-on-model`). The placed sightings carry `from: { sighting }`, the index of the image or video sighting they were projected from:

- on a mesh, an `spolygon` outline on the surface;
- on a point cloud, a `polygon3` prism (plan-view ring at the base height, `height` up) and a second sighting, a `selection` of the loaded points inside the prism, with `lod` the octree depth the points were cut at (the selection covers only the detail loaded then).

The automatic crossview pin (ANN-9) is a mesh `spoint` with `from`; placing an area on a layer removes that layer's automatic pin and any earlier area there. Hand-placed pins have no `from`.

`selections/<name>.sel` (name: letters, digits, dash, underscore; the app uses `<issue id>-<layer id>`), little-endian: 8 bytes ASCII magic `AIOSEL01`, uint32 point count, uint32 lod, then count x 3 float32 x, y, z in the project local frame (metres). Written by `project:writeSelection` (temporary file and rename; refused on a package; not journalled).
```

- [ ] **Step 12: Typecheck, lint, format and commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: no errors (run `pnpm exec prettier --write` on the touched files if the format check fails).

```bash
git add packages/schema/src/annotation.ts packages/schema/src/selection.ts packages/schema/src/index.ts packages/schema/src/ipc.ts packages/schema/src/placement.test.ts tools/compat/findings-on-model-additive.test.mjs apps/desktop/src/main/selection.ts apps/desktop/src/main/selection.test.ts apps/desktop/src/main/index.ts docs/architecture/contract-changes.md docs/architecture/data-conventions.md
git commit -m "feat(schema): placed findings carry from, selections a lod and a file format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Placement strings

**Files:**

- Modify: `packages/ui/src/i18n/en.ts` (a block before the closing `} as const satisfies Record<string, string>;`)
- Test: `packages/ui/src/i18n/i18n.test.ts` (one new `it`)

**Interfaces:**

- Produces: the `place.*` keys below, used by Tasks 10, 11 and 12 through `t()` / `useT()` from `@aio/ui`.

- [ ] **Step 1: Write the failing test**

Add inside the top-level `describe` of `packages/ui/src/i18n/i18n.test.ts`, after "has the strings for adding a survey date":

```ts
it('has the strings for placing findings on a model', () => {
  expect(t('place.offer', { count: 2 })).toBe('Connect 2 findings to a model?');
  expect(t('place.offer', { count: 1 })).toBe('Connect 1 finding to a model?');
  expect(t('place.result', { placed: 12, count: 14, layer: 'Mesh 3 Mar' })).toBe(
    'Placed 12 of 14 on Mesh 3 Mar.',
  );
  expect(t('place.missed', { count: 2 })).toBe('2 missed the model.');
  expect(t('place.match', { code: 'AI-31', other: 'AI-12', date: '3 Mar' })).toBe(
    'AI-31 looks like AI-12 from 3 Mar',
  );
  expect(t('place.menu', { count: 1 })).toBe('Place on model...');
  expect(t('place.menu', { count: 3 })).toBe('Place 3 on model...');
  for (const [k, v] of Object.entries(en))
    if (k.startsWith('place.')) expect(v, k).not.toMatch(/\p{Extended_Pictographic}/u);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aio/ui exec vitest run src/i18n/i18n.test.ts`
Expected: FAIL (`t` returns the key itself).

- [ ] **Step 3: Add the strings**

In `packages/ui/src/i18n/en.ts`, before `} as const satisfies Record<string, string>;`:

```ts
  // Findings on a model (placing AI findings on a mesh or point cloud)
  'place.offer_one': 'Connect {count} finding to a model?',
  'place.offer_other': 'Connect {count} findings to a model?',
  'place.layer': 'Model layer',
  'place.group.sameDate': 'Same date as the photos',
  'place.group.other': 'Other layers',
  'place.kind.mesh': 'mesh',
  'place.kind.pointcloud': 'point cloud',
  'place.go': 'Place',
  'place.notNow': 'Not now',
  'place.placing': 'Placing on {layer}',
  'place.result_one': 'Placed {placed} of {count} on {layer}.',
  'place.result_other': 'Placed {placed} of {count} on {layer}.',
  'place.missed_one': '{count} missed the model.',
  'place.missed_other': '{count} missed the model.',
  'place.noPhoto_one': '{count} has no photo outline to place.',
  'place.noPhoto_other': '{count} have no photo outline to place.',
  'place.notLoaded': '{layer} did not load in the 3D view. Open the 3D view and try again.',
  'place.noLayers': 'This project has no mesh or point cloud to place findings on.',
  'place.undo': 'Undo',
  'place.dismiss': 'Dismiss',
  'place.match': '{code} looks like {other} from {date}',
  'place.same': 'Same',
  'place.different': 'Different',
  'place.skipAll': 'Skip all',
  'place.matched': '{code} and {other} are tracked as one finding.',
  'place.menu_one': 'Place on model...',
  'place.menu_other': 'Place {count} on model...',
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @aio/ui exec vitest run src/i18n/i18n.test.ts`
Expected: PASS, including "uses no em or en dashes" and "has no problems".

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/i18n/en.ts packages/ui/src/i18n/i18n.test.ts
git commit -m "feat(ui): strings for placing findings on a model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Engine, a layer-filtered `raycastRay` and ray providers

**Files:**

- Modify: `packages/engine/src/types.ts` (new `RayOptions`, `RayProvider`; `SceneHandle.raycastRay` signature; optional `addRayProvider`, `rayLayers`)
- Modify: `packages/engine/src/stage/Stage.ts:471-490` (`raycastRay`; new `addRayProvider`, `rayLayers`; field `rayProviders`)
- Test: `packages/engine/src/stage/Stage.test.ts` (one new `it` after "casts world rays against content, ignoring section planes, then the ground")

**Interfaces:**

- Produces (exported through `export type * from './types'`):

```ts
export interface RayOptions {
  /** Only this layer: its raycast targets and the ray providers that have it; no ground plane. */
  layer?: string;
  /** Half-angle (radians) of the cone a point-cloud provider searches around the ray. */
  coneRad?: number;
}
export interface RayProvider {
  /** Layers it can hit now (shown, with content loaded). */
  layers(): readonly string[];
  cast(origin: Vector3, dir: Vector3, layer: string, opts: RayOptions): Intersection | null;
}
// SceneHandle:
raycastRay(origin: Vector3, dir: Vector3, opts?: RayOptions): Intersection | null;
addRayProvider?(provider: RayProvider): () => void;
rayLayers?(): ReadonlySet<string>;
```

Without `opts.layer`, `raycastRay` behaves exactly as today (meshes, then the ground; providers are never asked), so the deriver, the agent tools and the video trace are unchanged, and point clouds never turn an automatic pin into an `on: 'mesh'` sighting on a cloud layer. The new members are optional so the `SceneHandle` test stubs (`satisfies SceneHandle` in annotate, ai, video, tiles) keep compiling.

- [ ] **Step 1: Write the failing test**

Add to `packages/engine/src/stage/Stage.test.ts`, inside the same `describe` as the world-ray test:

```ts
it('casts at one layer only, asking the ray providers that have it, without the ground', async () => {
  const { stage, store, resize } = make();
  resize(800, 600);
  store.getState().openProject(project([meshLayer('plant')]));
  await flush();
  const o = new Vector3(0, 5, 50);
  const d = new Vector3(0, 0, -1);
  expect(stage.raycastRay(o, d, { layer: 'plant' })?.object.type).toBe('Mesh');
  // another layer: nothing, and no ground fallback
  const down = new Vector3(0, -1, 0);
  expect(stage.raycastRay(new Vector3(30, 10, 30), down, { layer: 'x' })).toBeNull();
  const cast = vi.fn(
    (origin: Vector3, _dir: Vector3, _layer: string, opts: { coneRad?: number }) => ({
      distance: 3,
      point: origin.clone().add(new Vector3(0, 0, -3)),
      object: new Points(),
      index: Math.round((opts.coneRad ?? 0) * 1000),
    }),
  );
  const off = stage.addRayProvider({ layers: () => ['cloud'], cast });
  const hit = stage.raycastRay(o, d, { layer: 'cloud', coneRad: 0.002 });
  expect(hit?.distance).toBe(3);
  expect(hit?.index).toBe(2);
  expect(cast).toHaveBeenCalledTimes(1);
  // without a layer the providers are never asked: the mesh and the ground as before
  expect(stage.raycastRay(o, d)?.object.type).toBe('Mesh');
  expect(cast).toHaveBeenCalledTimes(1);
  expect([...stage.rayLayers()].sort()).toEqual(['cloud', 'plant']);
  off();
  expect(stage.raycastRay(o, d, { layer: 'cloud' })).toBeNull();
  expect([...stage.rayLayers()]).toEqual(['plant']);
  stage.dispose();
});
```

(`Points`, `Vector3` and `vi` are already imported in this file; `make`, `project`, `meshLayer` and `flush` are its helpers. If the fake mesh adapter registers its target under another id than the layer id, read it from the adapter at the top of the file and use that id.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aio/engine exec vitest run src/stage/Stage.test.ts -t "casts at one layer"`
Expected: FAIL, `stage.addRayProvider is not a function`.

- [ ] **Step 3: Add the types**

In `packages/engine/src/types.ts`, after the `RaycastProvider` type:

```ts
/** Options of `SceneHandle.raycastRay`. */
export interface RayOptions {
  /** Only this layer: its raycast targets and the ray providers that have it; no ground plane. */
  layer?: string;
  /** Half-angle (radians) of the cone a point-cloud provider searches around the ray. */
  coneRad?: number;
}

/**
 * Content that `raycastRay` reaches only when asked for one of its layers (point clouds: a ray
 * meets no point exactly, so a provider searches a cone around it). Registered by the stream
 * that draws the content.
 */
export interface RayProvider {
  /** Layers it can hit now (shown, with content loaded). */
  layers(): readonly string[];
  cast(origin: Vector3, dir: Vector3, layer: string, opts: RayOptions): Intersection | null;
}
```

In `SceneHandle`, replace the `raycastRay` declaration and add two optional members after `addRaycastProvider`:

```ts
  /**
   * Cast a world-space ray (camera poses of photos and video frames) against visible content,
   * then the ground plane y = 0. Section planes are ignored: the camera saw the real asset.
   * Mesh hits name their layer through `userData.layerId` on the layer root. With `opts.layer`,
   * only that layer: its meshes and the ray providers that have it (point clouds), no ground.
   */
  raycastRay(origin: Vector3, dir: Vector3, opts?: RayOptions): Intersection | null;
```

```ts
  /** Add content `raycastRay` reaches by layer (point clouds). Returns an unsubscribe function. */
  addRayProvider?(provider: RayProvider): () => void;
  /** Layers `raycastRay` can hit now: shown raycast targets and the ray providers' layers. */
  rayLayers?(): ReadonlySet<string>;
```

- [ ] **Step 4: Implement in `Stage.ts`**

Add the field next to `providers`:

```ts
  private readonly rayProviders = new Set<RayProvider>();
```

Add `RayOptions` and `RayProvider` to the type import from `../types` (beside `RaycastProvider`). Replace `raycastRay` and add the two methods after `addRaycastProvider`:

```ts
  raycastRay(origin: Vector3, dir: Vector3, opts: RayOptions = {}): Intersection | null {
    this.raycaster.set(origin, dir.clone().normalize());
    this.raycaster.layers.mask = 1 | (1 << PICK_LAYER);
    const hits: Intersection[] = [];
    for (const [root, layerId] of this.targets) {
      if (opts.layer !== undefined && layerId !== opts.layer) continue;
      if (!visibleChain(root)) continue;
      this.raycaster.intersectObject(root, true, hits);
    }
    let hit: Intersection | null =
      hits.filter((h) => visibleChain(h.object)).sort((a, b) => a.distance - b.distance)[0] ??
      null;
    if (opts.layer === undefined) return hit ?? this.groundHit();
    const o = this.raycaster.ray.origin.clone();
    const d = this.raycaster.ray.direction.clone();
    for (const p of this.rayProviders) {
      if (!p.layers().includes(opts.layer)) continue;
      const h = p.cast(o, d, opts.layer, opts);
      if (h && (!hit || h.distance < hit.distance)) hit = h;
    }
    return hit;
  }
```

```ts
  addRayProvider(provider: RayProvider): () => void {
    this.rayProviders.add(provider);
    return () => {
      this.rayProviders.delete(provider);
    };
  }

  rayLayers(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [root, id] of this.targets) if (visibleChain(root)) out.add(id);
    for (const p of this.rayProviders) for (const id of p.layers()) out.add(id);
    return out;
  }
```

- [ ] **Step 5: Run the stage tests**

Run: `pnpm --filter @aio/engine exec vitest run src/stage/Stage.test.ts`
Expected: PASS (the new test and every existing ray test).

- [ ] **Step 6: Typecheck the stubs and commit**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors; the annotate, ai, video and tiles stubs (`raycastRay: () => null`) still fit.

```bash
git add packages/engine/src/types.ts packages/engine/src/stage/Stage.ts packages/engine/src/stage/Stage.test.ts
git commit -m "feat(engine): cast world rays at one layer and through ray providers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Point cloud, cone ray query, prism points and `refineAround`

**Files:**

- Create: `packages/pointcloud/src/rayMath.ts`, test `packages/pointcloud/src/rayMath.test.ts`
- Create: `packages/pointcloud/src/cloudRay.ts`, test `packages/pointcloud/src/cloudRay.test.ts`
- Create: `packages/pointcloud/src/refine.ts`, test `packages/pointcloud/src/refine.test.ts`
- Modify: `packages/pointcloud/src/manager.ts` (focus fields and methods; `update` takes `pxPerM`; the LOD call in `frame()`)
- Modify: `packages/pointcloud/src/adapter.ts` (`managerFor` registers the ray provider; `release` removes it)
- Modify: `packages/pointcloud/src/index.ts` (exports)

**Interfaces:**

- Consumes: `RayProvider`, `RayOptions`, `SceneHandle.addRayProvider?` from Task 3.
- Produces (from `@aio/pointcloud`):

```ts
// rayMath.ts (pure)
export interface RayChunk {
  positions: ArrayLike<number>;
  matrix?: ArrayLike<number>; // column-major 4x4 chunk to local frame; absent: identity
  floor?: number; // smallest search radius, metres (about the point spacing)
  keep?: (x: number, y: number, z: number, index: number) => boolean; // chunk coordinates
}
export interface RayPointHit {
  chunk: number;
  index: number;
  t: number;
  point: [number, number, number];
}
export interface RayPointOptions {
  coneRad: number;
  maxDist?: number;
  floor?: number;
}
export function raycastPoints(
  ray: { origin: V3; dir: V3 },
  chunks: readonly RayChunk[],
  opts: RayPointOptions,
): RayPointHit | null;
export interface Prism {
  ring: readonly (readonly [number, number])[];
  minY: number;
  maxY: number;
} // ring in (x, z)
export function pointsInPrismOf(chunks: readonly RayChunk[], prism: Prism): Float32Array;
// cloudRay.ts
export function cloudRayProvider(handle: SceneHandle): RayProvider;
export function pointsInPrism(handle: SceneHandle, layer: string, prism: Prism): Float32Array;
// refine.ts
export interface LodFocus {
  eye: V3;
  planes: readonly Plane4[];
  pxPerM: number;
} // re-exported from manager.ts
export interface RefineResult {
  depth: number;
  settled: boolean;
  release(): void;
}
export function refineAround(
  handle: SceneHandle,
  focus: LodFocus,
  timeoutMs?: number,
): Promise<RefineResult>; // default 3000
```

`raycastPoints` follows the spec: the nearest point along the ray whose distance from it is within `coneRad * t`, with an absolute floor (default 0.01 m, raised per chunk to 0.75 x its point spacing so a sparse node is still hit). The provider respects the section planes and the hidden classes exactly as `pickPoint` does (`drawnPoints` plus the shared planes). `pointsInPrism` takes every loaded point inside the prism, ignoring section planes and class filters: a section cut or a hidden class must not change which points belong to a finding.

- [ ] **Step 1: Write the failing pure tests**

Create `packages/pointcloud/src/rayMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pointsInPrismOf, raycastPoints, type RayChunk } from './rayMath';

// a row of points along z at x = 0, y = 0, and one off to the side
const row: RayChunk = { positions: new Float32Array([0, 0, 0, 0, 0, -5, 0, 0, -10, 0.5, 0, -2]) };
const down = { origin: [0, 0, 10] as const, dir: [0, 0, -1] as const };

describe('raycastPoints', () => {
  it('returns the nearest point along the ray inside the cone', () => {
    const hit = raycastPoints(down, [row], { coneRad: 0.001 });
    expect(hit).toMatchObject({ chunk: 0, index: 0, point: [0, 0, 0] });
    expect(hit?.t).toBeCloseTo(10, 6);
  });

  it('widens with distance: a point 0.5 m off the ray is hit only by a wide enough cone', () => {
    const side = { origin: [0.5, 0, 10] as const, dir: [0, 0, -1] as const };
    // straight through (0.5, 0, -2): the nearest point along this ray
    expect(raycastPoints(side, [row], { coneRad: 0.001 })?.index).toBe(3);
    const off = { origin: [1.5, 0, 10] as const, dir: [0, 0, -1] as const };
    expect(raycastPoints(off, [row], { coneRad: 0.001 })).toBeNull();
    // 1 m off at t = 12: needs coneRad >= 1 / 12
    expect(raycastPoints(off, [row], { coneRad: 0.09 })?.index).toBe(3);
  });

  it('keeps an absolute floor for points close to the camera, raised by the chunk spacing', () => {
    const near: RayChunk = { positions: new Float32Array([0.02, 0, 9.5]) };
    expect(raycastPoints(down, [near], { coneRad: 0 })).toBeNull();
    expect(raycastPoints(down, [near], { coneRad: 0, floor: 0.03 })?.index).toBe(0);
    expect(raycastPoints(down, [{ ...near, floor: 0.03 }], { coneRad: 0 })?.index).toBe(0);
  });

  it('skips points behind the camera, past maxDist and those keep rejects', () => {
    const behind: RayChunk = { positions: new Float32Array([0, 0, 20]) };
    expect(raycastPoints(down, [behind], { coneRad: 0.01 })).toBeNull();
    expect(raycastPoints(down, [row], { coneRad: 0.001, maxDist: 9 })).toBeNull();
    const keep: RayChunk = { ...row, keep: (_x, _y, z) => z < -1 };
    expect(raycastPoints(down, [keep], { coneRad: 0.001 })?.index).toBe(1);
  });

  it('applies the chunk matrix (column-major) and reports chunk-space indices', () => {
    // translate the row by +3 in x
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1];
    const moved: RayChunk = { ...row, matrix: m };
    const ray = { origin: [3, 0, 10] as const, dir: [0, 0, -2] as const };
    const hit = raycastPoints(ray, [row, moved], { coneRad: 0.001 });
    expect(hit).toMatchObject({ chunk: 1, index: 0, point: [3, 0, 0] });
  });
});

describe('pointsInPrismOf', () => {
  it('returns the points inside the plan-view ring and the height range, in the local frame', () => {
    const pts: RayChunk = {
      positions: new Float32Array([0, 0, 0, 0, 2, 0, 5, 0, 0, 0.2, 0.5, 0.2]),
    };
    const ring = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const;
    const out = pointsInPrismOf([pts], { ring, minY: -0.1, maxY: 1 });
    expect([...out]).toEqual([0, 0, 0, 0.2, 0.5, 0.2].map((v) => Math.fround(v)));
  });
});
```

Run: `pnpm --filter @aio/pointcloud exec vitest run src/rayMath.test.ts`
Expected: FAIL, `Cannot find module './rayMath'`.

- [ ] **Step 2: Create `packages/pointcloud/src/rayMath.ts`**

```ts
/**
 * Ray and prism queries over point positions (findings on a model). Pure: no three.js. Positions
 * are xyz triples in chunk coordinates; `matrix` maps them to the local frame.
 */
type V3 = readonly [number, number, number];

export interface RayChunk {
  positions: ArrayLike<number>;
  /** Column-major 4x4 from the chunk's coordinates to the local frame; absent: identity. */
  matrix?: ArrayLike<number>;
  /** Smallest search radius around the ray in metres (about the chunk's point spacing). */
  floor?: number;
  /** Rejects points (section planes, hidden classes); gets chunk coordinates and the index. */
  keep?: (x: number, y: number, z: number, index: number) => boolean;
}

export interface RayPointHit {
  chunk: number;
  index: number;
  /** Distance along the ray, metres. */
  t: number;
  point: [number, number, number];
}

export interface RayPointOptions {
  /** Half-angle of the search cone, radians: a point at distance t may be coneRad * t off. */
  coneRad: number;
  maxDist?: number;
  /** Absolute smallest search radius, metres. Default 0.01. */
  floor?: number;
}

/** Plan-view ring (x, z) and a height range (local y). */
export interface Prism {
  ring: readonly (readonly [number, number])[];
  minY: number;
  maxY: number;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A function mapping chunk coordinates to the local frame. */
function transformOf(m: ArrayLike<number> | undefined) {
  const e = (i: number) => (m ?? IDENTITY)[i] ?? IDENTITY[i] ?? 0;
  const [m0, m1, m2, m4, m5, m6, m8, m9, m10, m12, m13, m14] = [
    e(0),
    e(1),
    e(2),
    e(4),
    e(5),
    e(6),
    e(8),
    e(9),
    e(10),
    e(12),
    e(13),
    e(14),
  ];
  return (x: number, y: number, z: number, out: [number, number, number]) => {
    out[0] = m0 * x + m4 * y + m8 * z + m12;
    out[1] = m1 * x + m5 * y + m9 * z + m13;
    out[2] = m2 * x + m6 * y + m10 * z + m14;
  };
}

/** The nearest point along the ray within the cone (or the floor radius), or null. */
export function raycastPoints(
  ray: { origin: V3; dir: V3 },
  chunks: readonly RayChunk[],
  opts: RayPointOptions,
): RayPointHit | null {
  const [ox, oy, oz] = ray.origin;
  const len = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2]) || 1;
  const dx = ray.dir[0] / len;
  const dy = ray.dir[1] / len;
  const dz = ray.dir[2] / len;
  const maxDist = opts.maxDist ?? Infinity;
  const w: [number, number, number] = [0, 0, 0];
  let best: RayPointHit | null = null;
  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    if (!c) continue;
    const toLocal = transformOf(c.matrix);
    const floor = Math.max(opts.floor ?? 0.01, c.floor ?? 0);
    const n = Math.floor(c.positions.length / 3);
    for (let i = 0; i < n; i++) {
      const lx = c.positions[i * 3] ?? 0;
      const ly = c.positions[i * 3 + 1] ?? 0;
      const lz = c.positions[i * 3 + 2] ?? 0;
      toLocal(lx, ly, lz, w);
      const vx = w[0] - ox;
      const vy = w[1] - oy;
      const vz = w[2] - oz;
      const t = vx * dx + vy * dy + vz * dz;
      if (t <= 0 || t > maxDist || (best !== null && t >= best.t)) continue;
      const perp2 = vx * vx + vy * vy + vz * vz - t * t;
      const r = Math.max(opts.coneRad * t, floor);
      if (perp2 > r * r) continue;
      if (c.keep && !c.keep(lx, ly, lz, i)) continue;
      best = { chunk: ci, index: i, t, point: [w[0], w[1], w[2]] };
    }
  }
  return best;
}

/** Even-odd test of a plan-view point against a ring. */
export function inRing(x: number, z: number, ring: Prism['ring']): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}

/** Every point inside the prism, as xyz triples in the local frame. */
export function pointsInPrismOf(chunks: readonly RayChunk[], prism: Prism): Float32Array {
  const xs = prism.ring.map((p) => p[0]);
  const zs = prism.ring.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const out: number[] = [];
  const w: [number, number, number] = [0, 0, 0];
  for (const c of chunks) {
    const toLocal = transformOf(c.matrix);
    const n = Math.floor(c.positions.length / 3);
    for (let i = 0; i < n; i++) {
      toLocal(c.positions[i * 3] ?? 0, c.positions[i * 3 + 1] ?? 0, c.positions[i * 3 + 2] ?? 0, w);
      const [x, y, z] = w;
      if (y < prism.minY || y > prism.maxY || x < x0 || x > x1 || z < z0 || z > z1) continue;
      if (inRing(x, z, prism.ring)) out.push(x, y, z);
    }
  }
  return Float32Array.from(out);
}
```

Run: `pnpm --filter @aio/pointcloud exec vitest run src/rayMath.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing provider test**

Create `packages/pointcloud/src/cloudRay.test.ts` (the fake scene and decoder are those of `pick.test.ts`: kit raw units are millimetres, points at z = 0 m and z = 2 m on the axis and one at x = 3 m):

```ts
import type { RayProvider, SceneHandle } from '@aio/engine';
import type { Vector2 } from 'three';
import { PerspectiveCamera, Plane, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createPointcloudAdapter } from './adapter';
import { cloudRayProvider, pointsInPrism } from './cloudRay';
import type { Decoder } from './pool';
import { createPointcloudSettings } from './settings';

async function load(clippingPlanes: Plane[] = []) {
  const frames = new Set<() => void>();
  const providers: RayProvider[] = [];
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const handle = {
    scene: new Scene(),
    camera,
    renderer: {
      clippingPlanes,
      getPixelRatio: () => 1,
      getDrawingBufferSize: (v: Vector2) => v.set(500, 500),
      domElement: { clientWidth: 500, clientHeight: 500 },
    },
    projectId: 'p',
    clippingPlanes,
    addRaycastProvider: () => () => undefined,
    addRayProvider: (p: RayProvider) => {
      providers.push(p);
      return () => providers.splice(providers.indexOf(p), 1);
    },
    addContentBounds: () => () => undefined,
    requestRender: () => undefined,
    onFrame: (cb: () => void) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
  } as unknown as SceneHandle;
  const decoder: Decoder = {
    decode: () =>
      Promise.resolve({
        id: 0,
        count: 3,
        position: new Int16Array([0, 0, 0, 0, 0, 2000, 3000, 0, 0]),
        intensity: new Uint8Array(3),
        bounds: { min: [0, 0, 0], max: [3, 0, 2] },
      }),
    dispose: () => undefined,
  };
  const adapter = createPointcloudAdapter({
    decoder: () => decoder,
    settings: createPointcloudSettings(null),
  });
  const layer = await adapter.create(
    {
      kind: 'pointcloud',
      id: 'f101',
      name: 'f101',
      visible: true,
      src: { path: 'a.bin' },
      format: 'kit-packed',
    },
    { scene: handle, url: () => 'x' },
  );
  for (const f of frames) f();
  await new Promise((r) => setTimeout(r, 0));
  for (const f of frames) f();
  return { handle, providers, layer };
}

const o = new Vector3(0, 0, 10);
const d = new Vector3(0, 0, -1);

describe('cloudRayProvider', () => {
  it('is registered with the stage while a cloud shows and names its loaded layers', async () => {
    const { handle, providers, layer } = await load();
    expect(providers).toHaveLength(1);
    expect(cloudRayProvider(handle).layers()).toEqual(['f101']);
    layer.setVisible(false);
    expect(cloudRayProvider(handle).layers()).toEqual([]);
    layer.dispose();
    expect(providers).toHaveLength(0);
  });

  it('hits the nearest point along the ray with its layer on the object', async () => {
    const { handle } = await load();
    const hit = cloudRayProvider(handle).cast(o, d, 'f101', { coneRad: 0.001 });
    expect(hit?.point.distanceTo(new Vector3(0, 0, 2))).toBeLessThan(1e-6);
    expect(hit?.distance).toBeCloseTo(8, 5);
    expect(hit?.index).toBe(1);
    expect(hit?.object.userData.layerId).toBe('f101');
    expect(cloudRayProvider(handle).cast(o, d, 'other', { coneRad: 0.001 })).toBeNull();
  });

  it('skips points the section planes cut away', async () => {
    // keep z < 1 only
    const { handle } = await load([new Plane(new Vector3(0, 0, -1), 1)]);
    expect(cloudRayProvider(handle).cast(o, d, 'f101', { coneRad: 0.001 })?.index).toBe(0);
  });
});

describe('pointsInPrism', () => {
  it('takes every loaded point inside the prism, section planes or not', async () => {
    const { handle } = await load([new Plane(new Vector3(0, 0, -1), 1)]);
    const ring = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 2.5],
      [-0.5, 2.5],
    ] as const;
    const pts = pointsInPrism(handle, 'f101', { ring, minY: -1, maxY: 1 });
    expect(pts.length).toBe(6);
    expect(pointsInPrism(handle, 'nope', { ring, minY: -1, maxY: 1 }).length).toBe(0);
  });
});
```

Run: `pnpm --filter @aio/pointcloud exec vitest run src/cloudRay.test.ts`
Expected: FAIL, `Cannot find module './cloudRay'`.

- [ ] **Step 4: Create `packages/pointcloud/src/cloudRay.ts` and register it**

```ts
/**
 * Point clouds as `raycastRay` content (findings on a model): a cone around the ray over the
 * loaded chunks of one layer, respecting the section planes and the hidden classes as
 * `pickPoint` does, and the points inside a prism for a finding's selection.
 */
import type { RayProvider, SceneHandle } from '@aio/engine';
import { Vector3, type Intersection, type Points } from 'three';
import { getCloudManager } from './adapter';
import { drawnPoints } from './pick';
import { pointsInPrismOf, raycastPoints, type Prism, type RayChunk } from './rayMath';

const world = new Vector3();

function chunksOf(
  handle: SceneHandle,
  layerId: string,
  drawnOnly: boolean,
): { chunks: RayChunk[]; objects: Points[] } {
  const layer = getCloudManager(handle)?.layers.get(layerId);
  const chunks: RayChunk[] = [];
  const objects: Points[] = [];
  if (!layer?.visible) return { chunks, objects };
  const planes = handle.clippingPlanes;
  for (const c of layer.chunks) {
    const obj = c.object;
    if (!obj) continue;
    obj.updateMatrixWorld();
    const drawn = drawnOnly ? drawnPoints(obj) : undefined;
    if (drawn === false) continue;
    const m = obj.matrixWorld;
    const keep =
      drawnOnly && (planes.length > 0 || drawn)
        ? (x: number, y: number, z: number, i: number) => {
            if (drawn && !drawn(i)) return false;
            if (!planes.length) return true;
            world.set(x, y, z).applyMatrix4(m);
            return planes.every((p) => p.distanceToPoint(world) >= 0);
          }
        : undefined;
    const spacing = c.spacing ?? layer.baseSize / 2 ** c.lod;
    chunks.push({
      positions: obj.geometry.getAttribute('position').array,
      matrix: m.elements,
      floor: spacing * 0.75,
      ...(keep ? { keep } : {}),
    });
    objects.push(obj);
  }
  return { chunks, objects };
}

export function cloudRayProvider(handle: SceneHandle): RayProvider {
  return {
    layers: () => {
      const m = getCloudManager(handle);
      if (!m) return [];
      return [...m.layers.values()].filter((l) => l.visible && l.loaded.size > 0).map((l) => l.id);
    },
    cast: (origin, dir, layer, opts) => {
      const { chunks, objects } = chunksOf(handle, layer, true);
      const hit = raycastPoints(
        { origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z] },
        chunks,
        { coneRad: opts.coneRad ?? 0.002 },
      );
      const object = hit ? objects[hit.chunk] : undefined;
      if (!hit || !object) return null;
      const out: Intersection = {
        distance: hit.t,
        point: new Vector3(...hit.point),
        object,
        index: hit.index,
      };
      return out;
    },
  };
}

/** The loaded points of a cloud layer inside a prism (local frame xyz triples). */
export function pointsInPrism(handle: SceneHandle, layer: string, prism: Prism): Float32Array {
  return pointsInPrismOf(chunksOf(handle, layer, false).chunks, prism);
}
```

In `packages/pointcloud/src/adapter.ts`: import `cloudRayProvider` from `./cloudRay`, add `const rays = new WeakMap<SceneHandle, () => void>();` next to `pickers`, and in `managerFor` right after the `pickers.set(...)` call:

```ts
// and in SceneHandle.raycastRay by layer (placing findings from photos)
rays.set(handle, handle.addRayProvider?.(cloudRayProvider(handle)) ?? (() => undefined));
```

In `release`, after `pickers.delete(handle);`:

```ts
rays.get(handle)?.();
rays.delete(handle);
```

Run: `pnpm --filter @aio/pointcloud exec vitest run src/cloudRay.test.ts src/pick.test.ts src/adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing refine test**

Create `packages/pointcloud/src/refine.test.ts`:

```ts
import type { SceneHandle } from '@aio/engine';
import type { Vector2 } from 'three';
import { PerspectiveCamera, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createPointcloudAdapter } from './adapter';
import { frustumPlanes } from './octree';
import type { Decoder } from './pool';
import type { DecodedChunk, DecodeRequest } from './protocol';
import { refineAround } from './refine';
import { createPointcloudSettings } from './settings';

function fakeHandle() {
  const frames = new Set<(dt: number) => void>();
  const camera = new PerspectiveCamera(60, 1, 0.1, 5000);
  camera.position.set(0, 50, 100);
  camera.updateMatrixWorld();
  const handle = {
    scene: new Scene(),
    camera,
    renderer: {
      clippingPlanes: [],
      capabilities: { logarithmicDepthBuffer: false },
      getPixelRatio: () => 1,
      getDrawingBufferSize: (v: Vector2) => v.set(800, 600),
      domElement: { clientWidth: 800, clientHeight: 600 },
    },
    projectId: 'p',
    requestRender: vi.fn(),
    onFrame: (cb: (dt: number) => void) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
    holdContinuous: () => () => undefined,
    clippingPlanes: [],
    addRaycastProvider: () => () => undefined,
    addContentBounds: () => () => undefined,
  } as unknown as SceneHandle;
  return {
    handle,
    frame: () => {
      for (const f of frames) f(16);
    },
  };
}

function fakeDecoder() {
  const jobs: Omit<DecodeRequest, 'id'>[] = [];
  const resolvers: (() => void)[] = [];
  const decoder: Decoder = {
    decode(job) {
      jobs.push(job);
      return new Promise<DecodedChunk>((resolve) => {
        resolvers.push(() => {
          resolve({
            id: 0,
            count: 10,
            position: new Int16Array(30),
            intensity: new Uint8Array(10),
            bounds: { min: [0, 0, 0], max: [1, 1, 1] },
          });
        });
      });
    },
    dispose: vi.fn(),
  };
  return { decoder, jobs, finishAll: () => resolvers.splice(0).forEach((r) => r()) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const chunk = (x: number, lod: number) => ({
  file: `clouds/c${String(x)}.png`,
  points: 1000,
  lod,
  bounds: { min: [x, 0, 0], max: [x + 20, 10, 20] },
});
const index = {
  schema: 'aio.pngcloud/1',
  bounds: { min: [-500, 0, 0], max: [500, 10, 20] },
  chunks: [chunk(0, 0), chunk(-10, 1), chunk(400, 1)],
};

async function setup() {
  const { handle, frame } = fakeHandle();
  const d = fakeDecoder();
  const adapter = createPointcloudAdapter({
    decoder: () => d.decoder,
    settings: createPointcloudSettings(null),
    fetchJson: () => Promise.resolve(index),
  });
  handle.camera.lookAt(0, 0, 10); // c400 lies outside this view
  handle.camera.updateMatrixWorld();
  await adapter.create(
    {
      kind: 'pointcloud',
      id: 'pc',
      name: 'pc',
      visible: true,
      src: { path: 'clouds/pc.json' },
      format: 'png-packed',
    },
    { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
  );
  frame();
  d.finishAll();
  await flush();
  frame();
  return { handle, frame, d };
}

const eye = [410, 30, 60] as const;
const focus = {
  eye,
  planes: frustumPlanes({ eye, target: [410, 0, 10], fovDeg: 40, aspect: 1, near: 0.1, far: 500 }),
  pxPerM: 1000,
};
const urls = (d: ReturnType<typeof fakeDecoder>) => d.jobs.map((j) => j.url);

describe('refineAround', () => {
  it('loads the nodes a photo sees, then settles and reports their depth', async () => {
    const { handle, frame, d } = await setup();
    expect(urls(d)).not.toContain('aio://project/p/clouds/c400.png');
    const done = refineAround(handle, focus, 2000);
    frame();
    expect(urls(d)).toContain('aio://project/p/clouds/c400.png');
    d.finishAll();
    await flush();
    frame();
    frame();
    const r = await done;
    expect(r.settled).toBe(true);
    expect(r.depth).toBe(1);
    r.release();
    r.release(); // twice is harmless
  });

  it('gives up after the timeout when no frame comes', async () => {
    const { handle } = await setup();
    const r = await refineAround(handle, focus, 30);
    expect(r.settled).toBe(false);
    r.release();
  });

  it('resolves at once on a scene without clouds', async () => {
    const { handle } = fakeHandle();
    const r = await refineAround(handle, focus);
    expect(r).toMatchObject({ depth: 0, settled: true });
  });
});
```

Run: `pnpm --filter @aio/pointcloud exec vitest run src/refine.test.ts`
Expected: FAIL, `Cannot find module './refine'`.

- [ ] **Step 6: Add the focus to `CloudManager`**

In `packages/pointcloud/src/manager.ts`, add `boxInFrustum` to the import from `./octree`, and export the focus type near `CopcLayerInfo`:

```ts
/** A view the octree refines for instead of the camera's (placing a finding from a photo). */
export interface LodFocus {
  eye: V3;
  planes: readonly Plane4[];
  /** Pixels per metre at distance 1 of that view (the photo's focal length in pixels). */
  pxPerM: number;
}
```

Fields in `CloudManager`:

```ts
  private focus: LodFocus | null = null;
  private focusSeq = 0;
  /** The `focusSeq` the last level-of-detail selection was made for. */
  private selectedSeq = 0;
```

Change `update` to take the pixel scale:

```ts
  private update(
    eye: [number, number, number],
    budget: number,
    frustum: Plane4[],
    pxPerM = this.pxPerM,
  ): void {
```

and inside it pass `{ budget, pxPerM, minPx: REFINE_PX, frustum }` to `selectNodes`. In `frame()`, replace the line `this.update([eye.x, eye.y, eye.z], effectiveBudget(s) * this.share, planes);` with:

```ts
const budget = effectiveBudget(s) * this.share;
const f = this.focus;
if (f) this.update([f.eye[0], f.eye[1], f.eye[2]], budget, [...f.planes], f.pxPerM);
else this.update([eye.x, eye.y, eye.z], budget, planes);
this.selectedSeq = this.focusSeq;
```

Methods (after `heightRange`):

```ts
  /** Refine for `focus` instead of the camera until `clearFocus`. Returns its number. */
  setFocus(focus: LodFocus): number {
    this.focus = focus;
    this.focusSeq++;
    this.dirty = true;
    this.handle.requestRender();
    return this.focusSeq;
  }

  /** Back to the camera's view, if focus `seq` is still the one in force. */
  clearFocus(seq: number): void {
    if (seq !== this.focusSeq || !this.focus) return;
    this.focus = null;
    this.focusSeq++;
    this.dirty = true;
    this.handle.requestRender();
  }

  /** A selection was made for focus `seq` and everything it wanted is loaded (or failed). */
  settled(seq: number): boolean {
    if (this.selectedSeq < seq || this.inflight > 0 || this.ready.size > 0) return false;
    for (const l of this.layers.values()) if (l.pagesLoading.size > 0) return false;
    const owner = this.lod?.owner;
    return this.wanted.every((k) => {
      const c = owner?.get(k)?.byKey.get(k);
      return !c || c.object !== null || c.failed;
    });
  }

  /** Deepest octree depth loaded among the shown chunks that meet `planes`. */
  deepestLoaded(planes: readonly Plane4[]): number {
    let depth = 0;
    for (const l of this.layers.values()) {
      if (!l.visible) continue;
      for (const c of l.loaded) if (c.lod > depth && boxInFrustum(c.bounds, planes)) depth = c.lod;
    }
    return depth;
  }
```

- [ ] **Step 7: Create `packages/pointcloud/src/refine.ts`**

```ts
/**
 * Load finer point-cloud nodes inside a photo's view before a finding is projected from it
 * (findings on a model): the octree refines for the photo frustum instead of the camera until
 * `release`, and the promise resolves when loading settles or after `timeoutMs`.
 */
import type { SceneHandle } from '@aio/engine';
import { getCloudManager } from './adapter';
import type { LodFocus } from './manager';

export type { LodFocus } from './manager';

export interface RefineResult {
  /** Deepest octree depth loaded inside the frustum. */
  depth: number;
  /** False when the timeout ended the wait. */
  settled: boolean;
  /** Hand the level of detail back to the camera. Safe to call more than once. */
  release(): void;
}

export function refineAround(
  handle: SceneHandle,
  focus: LodFocus,
  timeoutMs = 3000,
): Promise<RefineResult> {
  const manager = getCloudManager(handle);
  if (!manager) return Promise.resolve({ depth: 0, settled: true, release: () => undefined });
  const seq = manager.setFocus(focus);
  const hold = (handle as Partial<SceneHandle>).holdContinuous?.('pointcloud-refine');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    hold?.();
    manager.clearFocus(seq);
  };
  return new Promise((resolve) => {
    const started = performance.now();
    let done = false;
    let off: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settled: boolean) => {
      if (done) return;
      done = true;
      off();
      if (timer !== undefined) clearTimeout(timer);
      resolve({ depth: manager.deepestLoaded(focus.planes), settled, release });
    };
    off = handle.onFrame(() => {
      if (manager.settled(seq)) finish(true);
      else if (performance.now() - started >= timeoutMs) finish(false);
    });
    // frames may stop (a hidden window): the timeout still ends the wait
    timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}
```

- [ ] **Step 8: Export and run the package tests**

Add to `packages/pointcloud/src/index.ts`:

```ts
export { cloudRayProvider, pointsInPrism } from './cloudRay';
export {
  pointsInPrismOf,
  raycastPoints,
  type Prism,
  type RayChunk,
  type RayPointHit,
  type RayPointOptions,
} from './rayMath';
export { refineAround, type LodFocus, type RefineResult } from './refine';
```

Run: `pnpm --filter @aio/pointcloud test`
Expected: PASS (all pointcloud tests, the three new files included).

- [ ] **Step 9: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add packages/pointcloud/src/rayMath.ts packages/pointcloud/src/rayMath.test.ts packages/pointcloud/src/cloudRay.ts packages/pointcloud/src/cloudRay.test.ts packages/pointcloud/src/refine.ts packages/pointcloud/src/refine.test.ts packages/pointcloud/src/manager.ts packages/pointcloud/src/adapter.ts packages/pointcloud/src/index.ts
git commit -m "feat(pointcloud): cone ray query, prism points and refine around a photo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Change, footprint matching, `suggestMatches` and the Make issue kind fix

**Files:**

- Create: `packages/change/src/footprint.ts`, test `packages/change/src/footprint.test.ts`
- Modify: `packages/change/src/issues.ts` (`Placed` gets `foot`; step 2 of `issueChanges` split in footprint pairs, then the distance rule; new `isTracked`, `suggestMatches`, `MatchSuggestion`)
- Modify: `packages/change/src/issueOps.ts` (`sightingFor` writes the cloud kinds)
- Modify: `packages/change/src/core.ts` (exports)
- Test: `packages/change/src/issues.test.ts`, `packages/change/src/issueOps.test.ts` (new `it`s)

**Interfaces:**

- Consumes: nothing from other tasks (reads `spolygon` and `polygon3` sightings, which exist today).
- Produces (from `@aio/change` and `@aio/change/core`):

```ts
export type XZ = readonly [number, number];
export const MIN_OVERLAP = 0.3;
export function footprintOf(issue: Pick<Issue, 'sightings'>): XZ[] | null;
export function convexHullXZ(points: readonly XZ[]): XZ[];
export function areaXZ(ring: readonly XZ[]): number;
export function clipConvex(subject: readonly XZ[], clip: readonly XZ[]): XZ[];
export function footprintOverlap(a: readonly XZ[], b: readonly XZ[]): number;
export interface MatchSuggestion {
  issue: Issue;
  overlap: number;
  capture: string;
}
export function isTracked(issue: Issue, issues: readonly Issue[]): boolean;
export function suggestMatches(
  issue: Issue,
  issues: readonly Issue[],
  index: Pick<DateIndex, 'captures' | 'of'>,
): MatchSuggestion[];
```

Decisions inside the spec's rule:

- A footprint is the plan-view (x, z) **convex hull** of the first `spolygon` (mesh) or `polygon3` ring (cloud) of the issue; overlap of two convex polygons is exact with Sutherland-Hodgman clipping, while an outline that wraps a surface can self-intersect in plan view. The hull is what a person reads as "the same patch".
- "Neither already tracked" means the issue shares its `track` with another issue. `draftFromChange` gives every Make issue draft a track of its own (`track: ctx.id`), and such a draft must still get suggestions.
- In `issueChanges`, two issues that both have footprints match only by overlap (method `footprint`); the distance rule applies when either has only a pin, as the spec says.

- [ ] **Step 1: Write the failing footprint test**

Create `packages/change/src/footprint.test.ts`:

```ts
import type { Issue, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  areaXZ,
  clipConvex,
  convexHullXZ,
  footprintOf,
  footprintOverlap,
  type XZ,
} from './footprint';
import { issue } from './testing';

const square = (x: number, z: number, s: number): XZ[] => [
  [x, z],
  [x + s, z],
  [x + s, z + s],
  [x, z + s],
];
const ring3 = (pts: readonly XZ[], y = 0): Vec3[] => pts.map(([x, z]) => [x, y, z]);

describe('footprints', () => {
  it('builds the convex hull counter-clockwise without repeated points', () => {
    const hull = convexHullXZ([
      [0, 0],
      [2, 0],
      [1, 1],
      [2, 2],
      [0, 2],
      [0, 0],
    ]);
    expect(hull).toHaveLength(4);
    expect(areaXZ(hull)).toBeCloseTo(4, 9);
  });

  it('clips two convex polygons', () => {
    const inter = clipConvex(square(0, 0, 2), square(1, 1, 2));
    expect(areaXZ(inter)).toBeCloseTo(1, 9);
    expect(clipConvex(square(0, 0, 1), square(5, 5, 1))).toEqual([]);
  });

  it('measures overlap as the intersection over the smaller area', () => {
    expect(footprintOverlap(square(0, 0, 2), square(0, 0, 1))).toBeCloseTo(1, 9);
    expect(footprintOverlap(square(0, 0, 2), square(1, 1, 2))).toBeCloseTo(0.25, 9);
    expect(footprintOverlap(square(0, 0, 1), square(3, 3, 1))).toBe(0);
  });

  it('reads a mesh outline or a cloud prism, never a pin', () => {
    const pin = issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0] });
    expect(footprintOf(pin)).toBeNull();
    const outline: Issue = {
      ...pin,
      sightings: [
        {
          on: 'mesh',
          layer: 'model-d1',
          geom: { type: 'spolygon', points: ring3(square(0, 0, 1), 3) },
        },
      ],
    };
    expect(areaXZ(footprintOf(outline) ?? [])).toBeCloseTo(1, 9);
    const prism: Issue = {
      ...pin,
      sightings: [
        {
          on: 'pointcloud',
          layer: 'c',
          geom: { type: 'polygon3', points: ring3(square(0, 0, 2)), height: 1 },
        },
      ],
    };
    expect(areaXZ(footprintOf(prism) ?? [])).toBeCloseTo(4, 9);
  });
});
```

Run: `pnpm --filter @aio/change exec vitest run src/footprint.test.ts`
Expected: FAIL, `Cannot find module './footprint'`.

- [ ] **Step 2: Create `packages/change/src/footprint.ts`**

```ts
import type { Issue } from '@aio/schema';

/**
 * Plan-view footprints of issues placed as areas on a model (findings on a model): the convex
 * hull of a mesh outline (`spolygon`) or a cloud prism ring (`polygon3`) in (x, z), and the
 * overlap of two footprints as the intersection over the smaller area. Pure.
 */
export type XZ = readonly [number, number];

/** Two placed areas are the same defect when they overlap at least this much. */
export const MIN_OVERLAP = 0.3;

const cross = (o: XZ, a: XZ, b: XZ) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull, counter-clockwise (x right, z up), no repeated points (Andrew's monotone chain). */
export function convexHullXZ(points: readonly XZ[]): XZ[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const half = (list: readonly XZ[]): XZ[] => {
    const out: XZ[] = [];
    for (const p of list) {
      while (out.length >= 2) {
        const a = out[out.length - 2];
        const b = out[out.length - 1];
        if (a && b && cross(a, b, p) <= 0) out.pop();
        else break;
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

export function areaXZ(ring: readonly XZ[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** Sutherland-Hodgman: the part of convex `subject` inside convex `clip` (both counter-clockwise). */
export function clipConvex(subject: readonly XZ[], clip: readonly XZ[]): XZ[] {
  let out: XZ[] = [...subject];
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    if (!a || !b) continue;
    const input = out;
    out = [];
    const inside = (p: XZ) => cross(a, b, p) >= 0;
    const meet = (p: XZ, q: XZ): XZ => {
      const dp = cross(a, b, p);
      const dq = cross(a, b, q);
      const t = dp / (dp - dq);
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    };
    for (let k = 0; k < input.length; k++) {
      const p = input[k];
      const q = input[(k + 1) % input.length];
      if (!p || !q) continue;
      if (inside(q)) {
        if (!inside(p)) out.push(meet(p, q));
        out.push(q);
      } else if (inside(p)) out.push(meet(p, q));
    }
  }
  return out.length >= 3 ? out : [];
}

export function footprintOverlap(a: readonly XZ[], b: readonly XZ[]): number {
  const small = Math.min(areaXZ(a), areaXZ(b));
  if (small <= 0) return 0;
  return areaXZ(clipConvex(convexHullXZ(a), convexHullXZ(b))) / small;
}

/** The issue's plan-view footprint: its first outline or prism, as a convex hull. */
export function footprintOf(issue: Pick<Issue, 'sightings'>): XZ[] | null {
  for (const s of issue.sightings) {
    const pts =
      s.on === 'mesh' && s.geom.type === 'spolygon'
        ? s.geom.points
        : s.on === 'pointcloud' && s.geom.type === 'polygon3'
          ? s.geom.points
          : null;
    if (!pts) continue;
    const hull = convexHullXZ(pts.map((p): XZ => [p[0], p[2]]));
    if (hull.length >= 3 && areaXZ(hull) > 1e-9) return hull;
  }
  return null;
}
```

Run: `pnpm --filter @aio/change exec vitest run src/footprint.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing matching tests**

Add to `packages/change/src/issues.test.ts` (import `suggestMatches`, `isTracked` from `./issues`, `type Issue` and `type Vec3` from `@aio/schema`):

```ts
describe('placed areas: footprint matching', () => {
  const area = (
    code: string,
    layer: string,
    x: number,
    z: number,
    over: Partial<Issue> = {},
  ): Issue => ({
    ...issue({ code, layer, at: [x, 0, z] }),
    sightings: [
      {
        on: 'mesh',
        layer,
        geom: {
          type: 'spolygon',
          points: [
            [x, 0, z],
            [x + 1, 0, z],
            [x + 1, 0, z + 1],
            [x, 0, z + 1],
          ] as Vec3[],
        },
        from: { sighting: 0 },
      },
    ],
    ...over,
  });

  it('pairs overlapping areas of the same class across dates, largest overlap first', () => {
    const a = area('F01', 'model-d1', 0, 0);
    const near = area('F02', 'model-d2', 0.2, 0); // overlap 0.8
    const nearer = area('F03', 'model-d2', 0.1, 0); // overlap 0.9
    const items = byId(run([a, near, nearer]));
    expect(items['issue:F01']).toMatchObject({ to: nearer.id, method: 'footprint' });
    expect(items['issue:F02']).toMatchObject({ verdict: 'new' });
  });

  it('does not pair areas that overlap less than 0.3, even when their centres are close', () => {
    const a = area('F01', 'model-d1', 0, 0);
    const b = area('F02', 'model-d2', 0.8, 0); // overlap 0.2, centres 0.8 m apart
    const items = byId(run([a, b]));
    expect(items['issue:F01']).not.toHaveProperty('to');
  });

  it('keeps the distance rule when one of the two has only a pin', () => {
    const a = area('F01', 'model-d1', 0, 0);
    const pin = issue({ code: 'F02', layer: 'model-d2', at: [0.6, 0, 0.6] });
    expect(byId(run([a, pin]))['issue:F01']).toMatchObject({ to: pin.id, method: 'mesh' });
  });

  it('suggests matches on other dates, best first, skipping tracked issues and other classes', () => {
    const a = area('F01', 'model-d1', 0, 0);
    const b = area('F02', 'model-d2', 0.1, 0);
    const c = area('F03', 'model-d2', 0.5, 0);
    const other = area('F04', 'model-d2', 0, 0, { classId: 'coating' });
    const same = area('F05', 'model-d1', 0, 0);
    const list = [a, b, c, other, same];
    expect(suggestMatches(a, list, index).map((m) => [m.issue.code, m.capture])).toEqual([
      ['F02', 'd2'],
      ['F03', 'd2'],
    ]);
    // a track of its own (a Make issue draft) is not a link; a shared one is
    const own = { ...b, track: b.id };
    expect(isTracked(own, [a, own])).toBe(false);
    const linked = [{ ...a, track: 't' }, { ...c, track: 't' }, b];
    expect(isTracked(linked[0] as Issue, linked)).toBe(true);
    expect(suggestMatches(b, linked, index).map((m) => m.issue.code)).toEqual([]);
    expect(
      suggestMatches(issue({ code: 'F09', layer: 'model-d1', at: [0, 0, 0] }), list, index),
    ).toEqual([]);
  });
});
```

Add to `packages/change/src/issueOps.test.ts`, inside `describe('make an issue from a change')`:

```ts
it('writes a point-cloud sighting when the later model is a point cloud', () => {
  const manifest = {
    ...SITE,
    layers: [
      ...SITE.layers,
      {
        kind: 'pointcloud' as const,
        id: 'cloud-d2',
        name: 'Cloud',
        visible: true,
        capture: 'd2',
        src: { path: 'clouds/d2.json' },
        format: 'png-packed' as const,
      },
    ],
  };
  const at = draftFromChange(
    { kind: 'region', id: 'r', verdict: 'added', at: [1, 2, 3] },
    { ...ctx, manifest, meshLayer: 'cloud-d2' },
  );
  expect(at.ok && at.issue.sightings[0]).toEqual({
    on: 'pointcloud',
    layer: 'cloud-d2',
    geom: { type: 'point3', p: [1, 2, 3] },
  });
  const outlineLocal: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
  ];
  const ring = draftFromChange(
    { kind: 'region', id: 'r', verdict: 'added', outlineLocal },
    { ...ctx, manifest, meshLayer: 'cloud-d2' },
  );
  expect(ring.ok && ring.issue.sightings[0]).toEqual({
    on: 'pointcloud',
    layer: 'cloud-d2',
    geom: { type: 'polygon3', points: outlineLocal },
  });
  expect(ring.ok && IssueSchema.safeParse(ring.issue).success).toBe(true);
});
```

Run: `pnpm --filter @aio/change exec vitest run src/issues.test.ts src/issueOps.test.ts`
Expected: FAIL (`suggestMatches` is not exported; the cloud draft is `on: 'mesh'`).

- [ ] **Step 4: Footprint pairing and `suggestMatches` in `issues.ts`**

Import at the top: `import { footprintOf, footprintOverlap, MIN_OVERLAP, type XZ } from './footprint';`. Update the doc comment's "Matching" bullet to: "a confirmed `track` first; else, for two issues placed as areas, the same class with footprints overlapping at least `MIN_OVERLAP` (largest first); else the same class within `max(0.5 m, 2% of the site height)` of the mesh or point cloud sighting, nearest first."

Replace `interface Placed` and the `place` helper:

```ts
interface Placed {
  issue: Issue;
  at: { p: Vec3; method: 'mesh' | 'pointcloud' } | null;
  foot: XZ[] | null;
}
```

```ts
const place = (i: Issue): Placed => ({ issue: i, at: issuePosition(i), foot: footprintOf(i) });
```

Replace the block from `// 2. same class, nearest within the tolerance` to the end of its assignment loop with:

```ts
// 2. two placed areas of the same class: footprint overlap, largest first
const overlaps: { x: Placed; y: Placed; o: number }[] = [];
for (const x of a) {
  if (pairOf.has(x) || !x.foot) continue;
  for (const y of b) {
    if (taken.has(y) || !y.foot || y.issue.classId !== x.issue.classId) continue;
    const o = footprintOverlap(x.foot, y.foot);
    if (o >= MIN_OVERLAP) overlaps.push({ x, y, o });
  }
}
overlaps.sort((p, q) => q.o - p.o);
for (const { x, y } of overlaps) {
  if (pairOf.has(x) || taken.has(y)) continue;
  pairOf.set(x, { b: y, method: 'footprint' });
  taken.add(y);
}
// 3. same class, nearest within the tolerance (one of the two has only a pin)
const candidates: { x: Placed; y: Placed; d: number }[] = [];
for (const x of a) {
  if (pairOf.has(x) || !x.at) continue;
  for (const y of b) {
    if (taken.has(y) || !y.at || y.issue.classId !== x.issue.classId) continue;
    if (x.foot && y.foot) continue;
    const d = dist3(x.at.p, y.at.p);
    if (d <= tolerance) candidates.push({ x, y, d });
  }
}
candidates.sort((p, q) => p.d - q.d);
for (const { x, y } of candidates) {
  if (pairOf.has(x) || taken.has(y)) continue;
  pairOf.set(x, { b: y, method: x.at?.method ?? 'mesh' });
  taken.add(y);
}
```

Add after `issueChanges`:

```ts
/** The issue shares its track with another issue (a confirmed match). */
export function isTracked(issue: Issue, issues: readonly Issue[]): boolean {
  const t = issue.track;
  return t !== undefined && issues.some((o) => o.id !== issue.id && o.track === t);
}

export interface MatchSuggestion {
  issue: Issue;
  /** Intersection over the smaller footprint, 0 to 1. */
  overlap: number;
  /** The capture the suggested issue belongs to. */
  capture: string;
}

/**
 * Issues of other dates that look like `issue` once it is placed as an area: the same class,
 * footprints overlapping at least `MIN_OVERLAP`, neither linked to another issue yet. Best first.
 * The same rule `issueChanges` matches areas with; nothing here changes an issue.
 */
export function suggestMatches(
  issue: Issue,
  issues: readonly Issue[],
  index: Pick<DateIndex, 'captures' | 'of'>,
): MatchSuggestion[] {
  const foot = footprintOf(issue);
  const date = issueDate(issue, index);
  if (!foot || !date || isTracked(issue, issues)) return [];
  const out: MatchSuggestion[] = [];
  for (const o of issues) {
    if (o.id === issue.id || o.classId !== issue.classId) continue;
    const capture = issueDate(o, index);
    if (!capture || capture === date || isTracked(o, issues)) continue;
    const f = footprintOf(o);
    if (!f) continue;
    const overlap = footprintOverlap(foot, f);
    if (overlap >= MIN_OVERLAP) out.push({ issue: o, overlap, capture });
  }
  return out.sort((p, q) => q.overlap - p.overlap || p.issue.code.localeCompare(q.issue.code));
}
```

- [ ] **Step 5: The Make issue kind fix in `issueOps.ts`**

Add above `sightingFor`:

```ts
/** A 3D sighting at a point or along a ring, of the kind the layer needs (mesh or point cloud). */
function onLayer(
  layer: string,
  ctx: DraftContext,
  geom: { at: Vec3 } | { ring: Vec3[] },
): Sighting {
  const cloud = ctx.manifest.layers.find((l) => l.id === layer)?.kind === 'pointcloud';
  if ('ring' in geom)
    return cloud
      ? { on: 'pointcloud', layer, geom: { type: 'polygon3', points: geom.ring } }
      : { on: 'mesh', layer, geom: { type: 'spolygon', points: geom.ring } };
  return cloud
    ? { on: 'pointcloud', layer, geom: { type: 'point3', p: geom.at } }
    : { on: 'mesh', layer, geom: { type: 'spoint', p: geom.at, n: [0, 1, 0] } };
}
```

(add `Vec3` to the `@aio/schema` type import). In `sightingFor`, replace the region outline return and the final point return:

```ts
    const layer = ctx.meshLayer;
    if (item.outlineLocal && layer) return onLayer(layer, ctx, { ring: item.outlineLocal });
  }
  const layer = (item.kind === 'component' ? item.layerTo : undefined) ?? ctx.meshLayer;
  if (item.at && layer) return onLayer(layer, ctx, { at: item.at });
  return null;
```

Add to `core.ts`: `isTracked`, `suggestMatches`, `type MatchSuggestion` in the `./issues` export, and

```ts
export {
  areaXZ,
  clipConvex,
  convexHullXZ,
  footprintOf,
  footprintOverlap,
  MIN_OVERLAP,
  type XZ,
} from './footprint';
```

- [ ] **Step 6: Run the change tests**

Run: `pnpm --filter @aio/change test`
Expected: PASS (new tests and every existing issue change test: pins still match by distance).

- [ ] **Step 7: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add packages/change/src/footprint.ts packages/change/src/footprint.test.ts packages/change/src/issues.ts packages/change/src/issues.test.ts packages/change/src/issueOps.ts packages/change/src/issueOps.test.ts packages/change/src/core.ts
git commit -m "feat(change): match placed findings by footprint and suggest matches

Make issue now writes a point-cloud sighting when the later model is a cloud.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Assistant tools, `place_on_model`, `add_sighting` and `create_issue_draft` `layer`

**Files:**

- Modify: `packages/ai/src/tools.ts` (`toolInputs`: `create_issue_draft.layer`, `place_on_model`, `add_sighting`; two `spec(...)` entries in `BUILT_IN` after `create_issue_draft`)
- Modify: `packages/ai/src/tool-kit.ts` (types `PlaceOutcome`, `PlaceOnModelRequest`, `PlaceOnModelResult`, `SightingAt`, `AddSightingRequest`, `AddSightingResult`; `AppHooks.placeOnModel`, `AppHooks.addSighting`)
- Create: `packages/ai/src/placement-tools.ts`
- Modify: `packages/ai/src/renderer-tools.ts` (`import './placement-tools';`; `pointSighting` and `draftLocation` take the layer; `create_issue_draft` passes `input.layer`)
- Modify: `packages/ai/src/index.ts` (export the new types)
- Test: `packages/ai/src/placement-tools.test.ts` (new), `packages/ai/src/renderer-tools.test.ts` (new `it`s)

**Interfaces:**

- Consumes: nothing from other tasks. The desktop registers the hooks in Task 13.
- Produces (from `@aio/ai`, types):

```ts
export interface PlaceOutcome {
  id: string;                     // the id the model gave (issue code or id, or detection id)
  code?: string;                  // the issue code once there is an issue
  placed?: { on: 'mesh' | 'pointcloud'; type: string }[];
  reason?: string;                // why nothing was placed: 'missed' | 'no-photo-shape' | 'layer-not-loaded' | 'unknown' | an accept problem
}
export interface PlaceOnModelRequest { ids: readonly string[]; layer: string }
export interface PlaceOnModelResult { layer: { id: string; name: string }; outcomes: PlaceOutcome[]; undo?: () => void }
export type SightingAt =
  | { kind: 'point'; p: Vec3 }
  | { kind: 'photo'; photo: string; box: [number, number, number, number] };
export interface AddSightingRequest { issue: string; layer: string; at: SightingAt }
export interface AddSightingResult { code: string; placed: { on: 'mesh' | 'pointcloud'; type: string }[]; undo?: () => void }
// AppHooks
placeOnModel?: (req: PlaceOnModelRequest) => Promise<PlaceOnModelResult>;
addSighting?: (req: AddSightingRequest) => Promise<AddSightingResult>;
```

The executors live in `@aio/ai` (so the registry test "has an executor for every catalogue tool" stays true) and do their work through `AppHooks`, like `process_photos` does: `@aio/ai` may not import `@aio/annotate`. Both tools are risk `write`, so `approvalFor` makes the panel ask before they run. They stay out of `COMPACT_TOOLS` (the compact profile is capped at 28 tools).

- [ ] **Step 1: Write the failing tests**

Create `packages/ai/src/placement-tools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runRendererTool, ToolError, type RendererToolContext } from './renderer-tools';
import { fixtureWorkspace } from './test-fixtures';
import { approvalFor, getToolSpec, riskOf } from './tools';
import type { AddSightingRequest, AppHooks, PlaceOnModelRequest } from './tool-kit';

function ctx(app: AppHooks = {}): RendererToolContext {
  return {
    workspace: fixtureWorkspace(),
    window: 'scene3d',
    scene: () => null,
    fetchJson: () => Promise.resolve(null),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-15T12:00:00Z'),
    app,
  };
}

describe('placement tools', () => {
  it('are write tools that ask for approval', () => {
    for (const n of ['place_on_model', 'add_sighting']) {
      expect(getToolSpec(n), n).toBeDefined();
      expect(riskOf(n), n).toBe('write');
      expect(approvalFor(n), n).toBe(true);
    }
  });

  it('place_on_model hands the ids and layer to the app and reports each outcome', async () => {
    const undo = vi.fn();
    const placeOnModel = vi.fn((req: PlaceOnModelRequest) =>
      Promise.resolve({
        layer: { id: 'm1', name: 'Plant mesh' },
        outcomes: req.ids.map((id, k) =>
          k === 0
            ? { id, code: 'AG01', placed: [{ on: 'mesh' as const, type: 'spolygon' }] }
            : { id, code: 'AG02', reason: 'missed' },
        ),
        undo,
      }),
    );
    const r = await runRendererTool(
      'place_on_model',
      { ids: ['AG01', 'review.json#d2'], layer: 'Plant mesh' },
      ctx({ placeOnModel }),
    );
    expect(placeOnModel).toHaveBeenCalledWith({
      ids: ['AG01', 'review.json#d2'],
      layer: 'Plant mesh',
    });
    expect(r.summary).toBe('1 of 2 findings placed on Plant mesh');
    expect(r.result).toMatchObject({ outcomes: [{ code: 'AG01' }, { reason: 'missed' }] });
    r.undo?.();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('add_sighting resolves a place to a point, or passes a photo box', async () => {
    const calls: AddSightingRequest[] = [];
    const addSighting = vi.fn((req: AddSightingRequest) => {
      calls.push(req);
      return Promise.resolve({
        code: 'F01',
        placed: [{ on: 'pointcloud' as const, type: 'point3' }],
      });
    });
    const c = ctx({ addSighting });
    await runRendererTool(
      'add_sighting',
      { issue: 'F01', layer: 'pc1', at: { kind: 'point', p: [1, 2, 3] } },
      c,
    );
    await runRendererTool(
      'add_sighting',
      { issue: 'F01', layer: 'm1', at: { photo: 'P7', box: [10, 20, 30, 40] } },
      c,
    );
    expect(calls).toEqual([
      { issue: 'F01', layer: 'pc1', at: { kind: 'point', p: [1, 2, 3] } },
      { issue: 'F01', layer: 'm1', at: { kind: 'photo', photo: 'P7', box: [10, 20, 30, 40] } },
    ]);
  });

  it('say they need the desktop app when the hooks are missing', async () => {
    await expect(
      runRendererTool('place_on_model', { ids: ['F01'], layer: 'm1' }, ctx()),
    ).rejects.toBeInstanceOf(ToolError);
    await expect(
      runRendererTool(
        'add_sighting',
        { issue: 'F01', layer: 'm1', at: { kind: 'point', p: [0, 0, 0] } },
        ctx(),
      ),
    ).rejects.toThrow('only in the desktop app');
  });

  it('refuse a box with no area', async () => {
    await expect(
      runRendererTool(
        'add_sighting',
        { issue: 'F01', layer: 'm1', at: { photo: 'P7', box: [0, 0, 0, 5] } },
        ctx(),
      ),
    ).rejects.toThrow('Invalid input');
  });
});
```

Add to `describe('write and send tools')` in `packages/ai/src/renderer-tools.test.ts`:

```ts
it('create_issue_draft writes the kind the named layer needs', async () => {
  const c = ctx();
  await runRendererTool(
    'create_issue_draft',
    {
      title: 'On the cloud',
      severity: 2,
      classId: 'coating',
      layer: 'pc1',
      at: { kind: 'point', p: [4, 5, 6] },
    },
    c,
  );
  const created = c.workspace.getState().issues.find((i) => i.title === 'On the cloud');
  expect(created?.sightings).toEqual([
    { on: 'pointcloud', layer: 'pc1', geom: { type: 'point3', p: [4, 5, 6] } },
  ]);
  await expect(
    runRendererTool(
      'create_issue_draft',
      {
        title: 'x',
        severity: 2,
        classId: 'coating',
        layer: 'v1',
        at: { kind: 'point', p: [0, 0, 0] },
      },
      c,
    ),
  ).rejects.toThrow('no mesh or point cloud layer "v1"');
});
```

Run: `pnpm --filter @aio/ai exec vitest run src/placement-tools.test.ts src/renderer-tools.test.ts`
Expected: FAIL (`place_on_model` is not a tool; `layer` is not allowed by the strict input).

- [ ] **Step 2: Add the hook types to `tool-kit.ts`**

After `PhotoRunRead`:

```ts
/** What placing one finding came to (`place_on_model`). */
export interface PlaceOutcome {
  /** The id the model gave: an issue code or id, or a detection id. */
  id: string;
  /** The issue's code, once there is an issue. */
  code?: string;
  /** What was placed: one entry per sighting written. */
  placed?: { on: 'mesh' | 'pointcloud'; type: string }[];
  /** Why nothing was placed (missed, no-photo-shape, layer-not-loaded, unknown, an accept problem). */
  reason?: string;
}

export interface PlaceOnModelRequest {
  ids: readonly string[];
  /** Layer id or name. */
  layer: string;
}

export interface PlaceOnModelResult {
  layer: { id: string; name: string };
  outcomes: PlaceOutcome[];
  /** Takes the placement back (the issues it changed), when nothing changed them since. */
  undo?: () => void;
}

/** Where `add_sighting` adds a place: a point, or a box on a photo to project onto the layer. */
export type SightingAt =
  | { kind: 'point'; p: Vec3 }
  | { kind: 'photo'; photo: string; box: [number, number, number, number] };

export interface AddSightingRequest {
  /** Issue code or id. */
  issue: string;
  /** Layer id or name. */
  layer: string;
  at: SightingAt;
}

export interface AddSightingResult {
  code: string;
  placed: { on: 'mesh' | 'pointcloud'; type: string }[];
  undo?: () => void;
}
```

In `AppHooks`, after `createClass`:

```ts
  /** Place findings on a mesh or point cloud layer (accepting waiting detections first). */
  placeOnModel?: (req: PlaceOnModelRequest) => Promise<PlaceOnModelResult>;
  /** Add a place on a mesh or point cloud layer to an existing issue. */
  addSighting?: (req: AddSightingRequest) => Promise<AddSightingResult>;
```

- [ ] **Step 3: Add the inputs and specs to `tools.ts`**

In `toolInputs.create_issue_draft`, after `at`:

```ts
      layer: z
        .string()
        .min(1)
        .optional()
        .describe('Mesh or point cloud layer id or name to put the issue on; default the first mesh'),
```

After `create_issue_draft` in `toolInputs`:

```ts
  place_on_model: z
    .object({
      ids: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .describe('Issue codes or ids, or detection ids from the detection review (waiting ones are accepted first)'),
      layer: z.string().min(1).describe('Mesh or point cloud layer id or name, from list_layers'),
    })
    .strict(),
  add_sighting: z
    .object({
      issue: z.string().min(1).describe('Issue code or id, e.g. F05'),
      layer: z.string().min(1).describe('Mesh or point cloud layer id or name, from list_layers'),
      at: z
        .union([
          Target,
          z
            .object({
              photo: z.string().min(1).describe('Photo id'),
              box: z
                .tuple([z.number(), z.number(), z.number().positive(), z.number().positive()])
                .describe('[x, y, width, height] in photo pixels'),
            })
            .strict(),
        ])
        .describe('A place, or a box on a named photo to project onto the layer'),
    })
    .strict(),
```

In `BUILT_IN`, after the `create_issue_draft` spec:

```ts
  spec(
    'place_on_model',
    {
      description:
        'Place findings on a mesh or point cloud layer as a real area projected from the photo boxes they were found in: an outline on a mesh, a prism with the points inside on a point cloud. Waiting detections named by id are accepted first. Answers per id what was placed or why it missed. The app asks for approval first.',
      scope: 'project',
      risk: 'write',
    },
    true,
  ),
  spec(
    'add_sighting',
    {
      description:
        'Add a place on a mesh or point cloud layer to an existing issue: at a place or point, or projected from a box on a named photo. The app asks for approval first.',
      scope: 'project',
      risk: 'write',
    },
    true,
  ),
```

- [ ] **Step 4: Create `packages/ai/src/placement-tools.ts`**

```ts
/**
 * Executors of the placement tools (findings on a model): `place_on_model` and `add_sighting`.
 * The projection lives in @aio/annotate, which this package may not import, so both act through
 * `AppHooks` (registered by the desktop renderer, apps/desktop/src/renderer/placement).
 */
import { targetPoint } from './places';
import { define, plural, ToolError, type SightingAt } from './tool-kit';

const NEEDS_APP = 'Placing findings on a model is only in the desktop app.';

define('place_on_model', async (input, ctx) => {
  const hook = ctx.app?.placeOnModel;
  if (!hook) throw new ToolError(NEEDS_APP);
  const r = await hook({ ids: input.ids, layer: input.layer });
  const placed = r.outcomes.filter((o) => (o.placed?.length ?? 0) > 0).length;
  return {
    result: { layer: r.layer, outcomes: r.outcomes },
    summary: `${String(placed)} of ${plural(r.outcomes.length, 'finding')} placed on ${r.layer.name}`,
    ...(r.undo ? { undo: r.undo } : {}),
  };
});

define('add_sighting', async (input, ctx) => {
  const hook = ctx.app?.addSighting;
  if (!hook) throw new ToolError(NEEDS_APP);
  const where = input.at;
  const at: SightingAt =
    'photo' in where
      ? { kind: 'photo', photo: where.photo, box: where.box }
      : { kind: 'point', p: await targetPoint(ctx, where) };
  const r = await hook({ issue: input.issue, layer: input.layer, at });
  return {
    result: { code: r.code, placed: r.placed },
    summary: `${r.code}: ${plural(r.placed.length, 'place')} added`,
    ...(r.undo ? { undo: r.undo } : {}),
  };
});
```

In `renderer-tools.ts`, add `import './placement-tools';` beside `import './photo-tools';`.

- [ ] **Step 5: `create_issue_draft` honours `layer`**

In `renderer-tools.ts`, replace `pointSighting` and `draftLocation`:

```ts
function pointSighting(ctx: RendererToolContext, p: Vec3, layer?: string, named = false): Sighting {
  const layers = project(ctx).manifest.layers;
  const pick = layer ? layers.find((l) => l.id === layer || l.name === layer) : undefined;
  if (named && layer && pick?.kind !== 'mesh' && pick?.kind !== 'pointcloud')
    throw new ToolError(
      `There is no mesh or point cloud layer "${layer}". Use list_layers for the layer ids.`,
    );
  if (pick?.kind === 'pointcloud')
    return { on: 'pointcloud', layer: pick.id, geom: { type: 'point3', p } };
  const mesh = (pick?.kind === 'mesh' ? pick : undefined) ?? layers.find((l) => l.kind === 'mesh');
  if (mesh) return { on: 'mesh', layer: mesh.id, geom: { type: 'spoint', p, n: [0, 1, 0] } };
  const cloud = layers.find((l) => l.kind === 'pointcloud');
  if (cloud) return { on: 'pointcloud', layer: cloud.id, geom: { type: 'point3', p } };
  throw new ToolError('This project has no 3D layer to place the issue on.');
}

/** Where the draft goes, and the class of the issue it was made from, if any. */
async function draftLocation(
  ctx: RendererToolContext,
  at: Target | undefined,
  layer: string | undefined,
): Promise<{ sightings: Sighting[]; classId?: string }> {
  const ws = ctx.workspace.getState();
  const target: Target | null =
    at ??
    (ws.selection?.kind === 'issue' || ws.selection?.kind === 'asset'
      ? { kind: ws.selection.kind, id: ws.selection.id }
      : null);
  if (!target) {
    throw new ToolError(
      'Say where the issue is: select an asset or issue, or give a place or a point, then try again.',
    );
  }
  if (target.kind === 'issue' && !layer) {
    const src = findIssue(ctx, target.id);
    const first = src.sightings[0];
    if (!first) throw new ToolError(`Issue ${src.code} has no location to copy.`);
    return { sightings: [first], classId: src.classId };
  }
  const p = await targetPoint(ctx, target);
  if (layer) return { sightings: [pointSighting(ctx, p, layer, true)] };
  const assetLayer = target.kind === 'asset' ? assetRef(ctx, target.id)?.layer.id : undefined;
  return { sightings: [pointSighting(ctx, p, assetLayer)] };
}
```

and in `create_issue_draft` call `draftLocation(ctx, input.at, input.layer)`. (With a layer and an issue target, the draft goes at that issue's 3D point on the named layer; `targetPoint` already resolves issue targets.)

Export from `packages/ai/src/index.ts` (beside the other `tool-kit` type exports re-exported by `renderer-tools.ts`; add them to that `export { ... } from './tool-kit'` list in `renderer-tools.ts` if the index re-exports through it):

```ts
export type {
  AddSightingRequest,
  AddSightingResult,
  PlaceOnModelRequest,
  PlaceOnModelResult,
  PlaceOutcome,
  SightingAt,
} from './tool-kit';
```

- [ ] **Step 6: Run the ai tests**

Run: `pnpm --filter @aio/ai test`
Expected: PASS (the new tests, "has an executor for every catalogue tool", the compact profile limits).

- [ ] **Step 7: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add packages/ai/src/tools.ts packages/ai/src/tool-kit.ts packages/ai/src/placement-tools.ts packages/ai/src/placement-tools.test.ts packages/ai/src/renderer-tools.ts packages/ai/src/renderer-tools.test.ts packages/ai/src/index.ts
git commit -m "feat(ai): place_on_model and add_sighting tools, create_issue_draft layer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Annotate, placed areas, `from` upkeep, the pin marker and runtime seams

**Files:**

- Create: `packages/annotate/src/model/placed.ts`, test `packages/annotate/src/model/placed.test.ts`
- Modify: `packages/annotate/src/model/ops.ts` (`removeSighting`, `moveSighting`, `mergeIssues`)
- Test: `packages/annotate/src/model/ops.test.ts` (new `it`s in `describe('sightings')`)
- Modify: `packages/annotate/src/model/editor.ts` (`commitIssues`)
- Test: `packages/annotate/src/model/editor.test.ts` (new `it`s)
- Create: `packages/annotate/src/crossview/camera.ts`, test `packages/annotate/src/crossview/camera.test.ts`
- Modify: `packages/annotate/src/crossview/derive.ts` (uses `sightingCamera`; marks its pin with `from`)
- Test: `packages/annotate/src/crossview/derive.test.ts` (new `it`)
- Modify: `packages/annotate/src/runtime.ts` (`imageSizeOf`, `cameraSources`, issue list actions)
- Test: `packages/annotate/src/runtime.test.ts` (new `it`)
- Modify: `packages/annotate/src/index.ts` (exports)

**Interfaces:**

- Consumes: `from?: { sighting: number }` on mesh and cloud sightings (Task 1).
- Produces (from `@aio/annotate`):

```ts
// model/placed.ts
export function isAutoPin(s: Sighting): boolean;          // mesh spoint with from
export function isPlacedArea(s: Sighting): boolean;       // from + (mesh spolygon | cloud polygon3 | cloud selection)
export function hasPlacedArea(issue: Pick<Issue, 'sightings'>): boolean;
export function placedFrom(issue: Pick<Issue, 'sightings'>): number | null;
export function keepSightings(sightings: readonly Sighting[], keep: (s: Sighting, i: number) => boolean): Sighting[];
export function shiftFrom(sightings: readonly Sighting[], offset: number): Sighting[];
export function dropFrom(s: Sighting): Sighting;
export function withPlacedArea(issue: Issue, layer: string, added: readonly Sighting[], now: string): Issue;
// model/editor.ts (IssueEditor)
commitIssues(issues: readonly Issue[], label: string): Result<null>;
// crossview/camera.ts
export interface CameraSources {
  layers: () => readonly Layer[];
  flight: (layerId: string) => readonly PoseSample[] | null;
  imageSize: (layerId: string, photoId: string | null) => Vec2 | null;
  orientation?: () => OrientationFile | null;
}
export interface SightingCamera { pose: CameraPose; lens: LensModel; size: Vec2; geom: ImageGeom | FrameGeom }
export function sightingCamera(s: Sighting, src: CameraSources): SightingCamera | null;
// crossview/derive.ts
export interface DeriverSources extends CameraSources { scene: () => RaySurface | null }
// runtime.ts
export function imageSizeOf(layerId: string, photoId: string | null): Vec2 | null;
export const cameraSources: CameraSources;
export interface IssueListActions { placeOnModel?: (ids: readonly string[]) => void }
export function setIssueListActions(actions: IssueListActions): () => void;
export function useIssueListActions(): IssueListActions;
```

The automatic pin marker decided in "Contract changes": the deriver writes `from: { sighting: <index of the image or video sighting> }` on the pin it makes. `withPlacedArea` removes, on the placed layer only, the automatic pin and any earlier placed area (re-placing replaces), and keeps every `from` naming the same sighting after the removal shifts indices.

- [ ] **Step 1: Write the failing `placed` tests**

Create `packages/annotate/src/model/placed.test.ts`:

```ts
import type { Sighting } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { LATER, makeIssue, meshSighting, photoSighting, videoSighting } from '../testing';
import {
  dropFrom,
  hasPlacedArea,
  isAutoPin,
  isPlacedArea,
  keepSightings,
  placedFrom,
  shiftFrom,
  withPlacedArea,
} from './placed';

const ring: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 0, 1],
];
const autoPin = (layer: string, from: number): Sighting => ({
  on: 'mesh',
  layer,
  geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] },
  from: { sighting: from },
});
const outline = (layer: string, from: number): Sighting => ({
  on: 'mesh',
  layer,
  geom: { type: 'spolygon', points: ring },
  from: { sighting: from },
});

describe('placed areas', () => {
  it('tells automatic pins and placed areas from hand-made sightings', () => {
    expect(isAutoPin(autoPin('m', 0))).toBe(true);
    expect(isAutoPin(meshSighting)).toBe(false);
    expect(isPlacedArea(outline('m', 0))).toBe(true);
    expect(isPlacedArea({ on: 'mesh', layer: 'm', geom: { type: 'spolygon', points: ring } })).toBe(
      false,
    );
    expect(
      isPlacedArea({
        on: 'pointcloud',
        layer: 'c',
        geom: { type: 'selection', src: { path: 's.sel' }, count: 3 },
        from: { sighting: 0 },
      }),
    ).toBe(true);
    expect(isPlacedArea(photoSighting)).toBe(false);
  });

  it('finds the photo a placed area came from, ignoring a stale index', () => {
    const issue = makeIssue({ sightings: [videoSighting, photoSighting, outline('m', 1)] });
    expect(hasPlacedArea(issue)).toBe(true);
    expect(placedFrom(issue)).toBe(1);
    expect(placedFrom(makeIssue({ sightings: [photoSighting, outline('m', 7)] }))).toBeNull();
    expect(placedFrom(makeIssue({ sightings: [photoSighting] }))).toBeNull();
  });

  it('keeps from pointing at the same sighting when others go, and drops it when its sighting goes', () => {
    const list = [meshSighting, photoSighting, outline('m', 1)];
    expect(keepSightings(list, (_, i) => i !== 0)).toEqual([photoSighting, outline('m', 0)]);
    expect(keepSightings(list, (_, i) => i !== 1)).toEqual([
      meshSighting,
      { on: 'mesh', layer: 'm', geom: { type: 'spolygon', points: ring } },
    ]);
    expect(shiftFrom([outline('m', 0), photoSighting], 3)).toEqual([
      outline('m', 3),
      photoSighting,
    ]);
    expect(dropFrom(outline('m', 2))).toEqual({
      on: 'mesh',
      layer: 'm',
      geom: { type: 'spolygon', points: ring },
    });
  });

  it('replaces the automatic pin on the placed layer only', () => {
    const issue = makeIssue({
      sightings: [photoSighting, autoPin('m', 0), autoPin('other', 0), meshSighting],
    });
    const next = withPlacedArea(issue, 'm', [outline('m', 0)], LATER);
    expect(next.sightings).toEqual([
      photoSighting,
      autoPin('other', 0),
      meshSighting,
      outline('m', 0),
    ]);
    expect(next.updatedAt).toBe(LATER);
  });

  it('replaces an earlier area on the same layer, and renumbers from after the removals', () => {
    const issue = makeIssue({ sightings: [autoPin('m', 1), photoSighting, outline('m', 1)] });
    const next = withPlacedArea(issue, 'm', [outline('m', 1)], LATER);
    // the pin and the old outline went: the photo is now sighting 0
    expect(next.sightings).toEqual([photoSighting, outline('m', 0)]);
  });
});
```

Run: `pnpm --filter @aio/annotate exec vitest run src/model/placed.test.ts`
Expected: FAIL, `Cannot find module './placed'`.

- [ ] **Step 2: Create `packages/annotate/src/model/placed.ts`**

```ts
import type { Issue, Sighting } from '@aio/schema';

/**
 * Findings placed on a model (plan 2026-10-15-findings-on-model). A 3D sighting that was
 * projected from one of the issue's image or video sightings names it in `from` (its index):
 * the automatic crossview pin (a mesh `spoint`) and the placed areas (a mesh `spolygon`, a cloud
 * `polygon3` and its `selection`). Indices move when sightings are removed, moved or merged;
 * these helpers keep every `from` naming the same sighting. Pure.
 */

type From = { sighting: number };

const fromOf = (s: Sighting): From | undefined =>
  s.on === 'mesh' || s.on === 'pointcloud' ? s.from : undefined;

function withFrom(s: Sighting, from: From | null): Sighting {
  if (s.on !== 'mesh' && s.on !== 'pointcloud') return s;
  if (from) return { ...s, from };
  const copy = { ...s };
  delete copy.from;
  return copy;
}

/** The pin the deriver back-projected from a photo or frame shape. */
export function isAutoPin(s: Sighting): boolean {
  return s.on === 'mesh' && s.geom.type === 'spoint' && s.from !== undefined;
}

/** An area placed on a model from a photo or frame shape (outline, prism or its selection). */
export function isPlacedArea(s: Sighting): boolean {
  if (s.on === 'mesh') return s.from !== undefined && s.geom.type === 'spolygon';
  if (s.on === 'pointcloud')
    return s.from !== undefined && (s.geom.type === 'polygon3' || s.geom.type === 'selection');
  return false;
}

export function hasPlacedArea(issue: Pick<Issue, 'sightings'>): boolean {
  return issue.sightings.some(isPlacedArea);
}

/** The image or video sighting the first placed area came from; null when none (or stale). */
export function placedFrom(issue: Pick<Issue, 'sightings'>): number | null {
  for (const s of issue.sightings) {
    if (!isPlacedArea(s)) continue;
    const at = fromOf(s)?.sighting;
    const src = at === undefined ? undefined : issue.sightings[at];
    if (at !== undefined && (src?.on === 'image' || src?.on === 'video')) return at;
  }
  return null;
}

/**
 * The sightings `keep` says yes to, with every `from` pointing at the same sighting in the new
 * order; a `from` whose sighting went is dropped.
 */
export function keepSightings(
  sightings: readonly Sighting[],
  keep: (s: Sighting, i: number) => boolean,
): Sighting[] {
  const moved = new Map<number, number>();
  const kept: Sighting[] = [];
  sightings.forEach((s, i) => {
    if (!keep(s, i)) return;
    moved.set(i, kept.length);
    kept.push(s);
  });
  return kept.map((s) => {
    const f = fromOf(s);
    if (!f) return s;
    const to = moved.get(f.sighting);
    return withFrom(s, to === undefined ? null : { sighting: to });
  });
}

/** Sightings placed after `offset` others (a merge): their `from` moves with them. */
export function shiftFrom(sightings: readonly Sighting[], offset: number): Sighting[] {
  return sightings.map((s) => {
    const f = fromOf(s);
    return f ? withFrom(s, { sighting: f.sighting + offset }) : s;
  });
}

/** A sighting leaving its issue (linked to another): its `from` no longer means anything. */
export function dropFrom(s: Sighting): Sighting {
  return withFrom(s, null);
}

/**
 * The issue with `added` placed on `layer`: that layer's automatic pin and any earlier placed
 * area go (placing again replaces), `added` joins at the end. The `from` of `added` counts in
 * the issue as it was; every `from` still names the same sighting afterwards.
 */
export function withPlacedArea(
  issue: Issue,
  layer: string,
  added: readonly Sighting[],
  now: string,
): Issue {
  const n = issue.sightings.length;
  const sightings = keepSightings(
    [...issue.sightings, ...added],
    (s, i) => i >= n || s.layer !== layer || !(isAutoPin(s) || isPlacedArea(s)),
  );
  return { ...issue, sightings, updatedAt: now };
}
```

Run: `pnpm --filter @aio/annotate exec vitest run src/model/placed.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing ops and editor tests**

Add to `describe('sightings')` in `packages/annotate/src/model/ops.test.ts` (import `type Sighting` from `@aio/schema`):

```ts
const areaFrom = (i: number): Sighting => ({
  on: 'mesh',
  layer: 'tank',
  geom: {
    type: 'spolygon',
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
    ],
  },
  from: { sighting: i },
});

it('removeSighting reindexes from', () => {
  const issue = makeIssue({ sightings: [meshSighting, photoSighting, areaFrom(1)] });
  const r = removeSighting(issue, 0, LATER);
  expect(r.ok && r.value.sightings).toEqual([photoSighting, areaFrom(0)]);
});

it('mergeIssues shifts from by the sightings already there', () => {
  const target = makeIssue({ id: 't', sightings: [meshSighting, videoSighting] });
  const source = makeIssue({ id: 's', code: 'F02', sightings: [photoSighting, areaFrom(0)] });
  expect(mergeIssues(target, source, LATER).sightings.slice(2)).toEqual([
    photoSighting,
    areaFrom(2),
  ]);
});

it('moveSighting drops from on the moved sighting and reindexes the rest', () => {
  const from = makeIssue({ id: 'a', sightings: [videoSighting, photoSighting, areaFrom(1)] });
  const to = makeIssue({ id: 'b', code: 'F02', sightings: [meshSighting] });
  const plain: Sighting = {
    on: 'mesh',
    layer: 'tank',
    geom: {
      type: 'spolygon',
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
      ],
    },
  };
  const r = moveSighting(from, 2, to, LATER);
  expect(r.ok && r.value.to.sightings[1]).toEqual(plain);
  const moved = moveSighting(from, 0, to, LATER);
  expect(moved.ok && moved.value.from?.sightings).toEqual([photoSighting, areaFrom(0)]);
});
```

Add to `describe('IssueEditor')` in `packages/annotate/src/model/editor.test.ts`:

```ts
it('commits computed issues as one undo step, and refuses unknown or invalid ones', () => {
  const a = makeIssue({ id: 'a', code: 'F01' });
  const b = makeIssue({ id: 'b', code: 'F02' });
  const { store, editor, calls } = setup([a, b]);
  const r = editor.commitIssues(
    [
      { ...a, title: 'Placed', track: 't1' },
      { ...b, track: 't1' },
    ],
    'Match F01 and F02',
  );
  expect(r.ok).toBe(true);
  expect(store.getState().issues.map((i) => i.track)).toEqual(['t1', 't1']);
  expect(editor.state.undoLabel).toBe('Match F01 and F02');
  expect(calls).toHaveLength(1);
  expect(editor.undo()).toBe(true);
  expect(store.getState().issues.map((i) => i.track)).toEqual([undefined, undefined]);
  expect(editor.commitIssues([makeIssue({ id: 'zz' })], 'x').ok).toBe(false);
  expect(editor.commitIssues([{ ...a, severity: 99 }], 'x').ok).toBe(false);
  expect(editor.commitIssues([], 'x')).toEqual({ ok: true, value: null });
});
```

Run: `pnpm --filter @aio/annotate exec vitest run src/model/ops.test.ts src/model/editor.test.ts`
Expected: FAIL (indices unchanged; `commitIssues` is not a function).

- [ ] **Step 4: Keep `from` right in `ops.ts` and add `commitIssues`**

In `packages/annotate/src/model/ops.ts`, import `import { dropFrom, keepSightings, shiftFrom } from './placed';` and change three bodies:

```ts
return ok({
  ...issue,
  sightings: keepSightings(issue.sightings, (_, i) => i !== index),
  updatedAt: now,
});
```

(in `removeSighting`),

```ts
const rest = keepSightings(from.sightings, (_, i) => i !== index);
return ok({
  from: rest.length ? { ...from, sightings: rest, updatedAt: now } : null,
  to: addSighting(to, dropFrom(s), now),
});
```

(in `moveSighting`), and in `mergeIssues`:

```ts
    sightings: [...target.sightings, ...shiftFrom(source.sightings, target.sightings.length)],
```

In `packages/annotate/src/model/editor.ts`, add to `IssueEditor` after `createMany`:

```ts
  /**
   * Write issues computed elsewhere (findings placed on a model, a confirmed match) as one undo
   * step, validated; nothing is written when one is refused or unknown.
   */
  commitIssues(issues: readonly Issue[], label: string): Result<null>;
```

and to the returned object after `createMany`:

```ts
    commitIssues(issues, label) {
      if (readOnly()) return fail(READ_ONLY_ERROR);
      if (issues.length === 0) return ok(null);
      const after: Record<string, Issue> = {};
      for (const i of issues) {
        if (!get(i.id)) return fail(`Issue "${i.id}" does not exist`);
        after[i.id] = i;
      }
      return commit(label, after);
    },
```

Run: `pnpm --filter @aio/annotate exec vitest run src/model`
Expected: PASS.

- [ ] **Step 5: Write the failing camera and deriver tests**

Create `packages/annotate/src/crossview/camera.test.ts`:

```ts
import type { Layer, Quat, Sighting } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { sightingCamera, type CameraSources } from './camera';

const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const layers: Layer[] = [
  {
    kind: 'photos',
    id: 'photos',
    name: 'Photos',
    visible: true,
    items: [
      {
        id: 'F01',
        src: { path: 'photos/F01.jpg' },
        pos: [3, 10, 4],
        q: down,
        lens: { model: 'pinhole', hfovDeg: 90, aspect: 4 / 3 },
      },
      { id: 'nopose', src: { path: 'photos/x.jpg' } },
    ],
  },
];
const src = (size: [number, number] | null): CameraSources => ({
  layers: () => layers,
  flight: () => null,
  imageSize: () => size,
});
const box: Sighting = {
  on: 'image',
  layer: 'photos',
  photo: 'F01',
  geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 },
};

describe('sightingCamera', () => {
  it('builds the photo camera with its pixel size and shape', () => {
    expect(sightingCamera(box, src([1200, 900]))).toEqual({
      pose: { pos: [3, 10, 4], q: down },
      lens: { model: 'pinhole', hfovDeg: 90, aspect: 4 / 3 },
      size: [1200, 900],
      geom: box.on === 'image' ? box.geom : null,
    });
  });

  it('has no camera without a pose or a known size', () => {
    expect(sightingCamera(box, src(null))).toBeNull();
    expect(sightingCamera({ ...box, photo: 'nopose' }, src([10, 10]))).toBeNull();
    expect(sightingCamera({ on: 'map', layer: 'photos', geojson: {} }, src([10, 10]))).toBeNull();
  });
});
```

Add to `packages/annotate/src/crossview/derive.test.ts`:

```ts
it('marks its pin with the photo sighting it was projected from', () => {
  const s: Sighting = {
    on: 'image',
    layer: 'photos',
    photo: 'F01',
    geom: { type: 'point', x: 600, y: 450 },
  };
  const other: Sighting = { ...s, geom: { type: 'point', x: 10, y: 10 } };
  expect(deriver()(s, makeIssue({ sightings: [s] }))[0]).toMatchObject({ from: { sighting: 0 } });
  expect(deriver()(s, makeIssue({ sightings: [other, s] }))[0]).toMatchObject({
    from: { sighting: 1 },
  });
});
```

Run: `pnpm --filter @aio/annotate exec vitest run src/crossview/camera.test.ts src/crossview/derive.test.ts`
Expected: FAIL (`./camera` missing; no `from` on the pin).

- [ ] **Step 6: Create `crossview/camera.ts` and use it in the deriver**

`packages/annotate/src/crossview/camera.ts`:

```ts
import { clipCamera, clipKeys, clipPoseAt, correctedPhoto, photoCorrection } from '@aio/geo';
import type {
  FrameGeom,
  ImageGeom,
  Layer,
  LensModel,
  OrientationFile,
  PoseSample,
  Sighting,
  Vec2,
} from '@aio/schema';
import type { CameraPose } from './lens';

/** Where the camera of a photo or a video frame comes from. */
export interface CameraSources {
  layers: () => readonly Layer[];
  /** Pose samples of a video layer's flight (loaded by the video window or `loadFlightPoses`). */
  flight: (layerId: string) => readonly PoseSample[] | null;
  /** Pixel size of a photo or video frame, once known. Video falls back to 1280 x lens aspect. */
  imageSize: (layerId: string, photoId: string | null) => Vec2 | null;
  /** The project's orientation.json (hand-set camera directions), if any. */
  orientation?: () => OrientationFile | null;
}

/** The camera an image or video sighting was seen with, and its shape in that image. */
export interface SightingCamera {
  pose: CameraPose;
  lens: LensModel;
  size: Vec2;
  /** The shape in image pixels (for video: at the first keyframe). */
  geom: ImageGeom | FrameGeom;
}

/** Null for other sightings, an unposed photo, a photo of unknown size or a flight not loaded. */
export function sightingCamera(s: Sighting, src: CameraSources): SightingCamera | null {
  const layer = src.layers().find((l) => l.id === s.layer);
  if (s.on === 'image' && layer?.kind === 'photos') {
    const found = layer.items.find((p) => p.id === s.photo);
    const photo = found
      ? correctedPhoto(found, photoCorrection(src.orientation?.(), layer.id, found.id))
      : undefined;
    const size = src.imageSize(layer.id, s.photo);
    if (!photo?.pos || !photo.q || !photo.lens || !size) return null;
    return { pose: { pos: photo.pos, q: photo.q }, lens: photo.lens, size, geom: s.geom };
  }
  if (s.on === 'video' && layer?.kind === 'video') {
    const key = s.track[0];
    const samples = src.flight(layer.id);
    if (!key || !samples?.length) return null;
    const size: Vec2 = src.imageSize(layer.id, null) ?? [
      1280,
      Math.round(1280 / layer.lens.aspect),
    ];
    // the camera as every view draws it: direction keyframes, else the log with its bias
    const keys = clipKeys(src.orientation?.(), layer.id);
    const at = clipPoseAt(samples, layer.offsetMs + key.t * 1000, clipCamera(layer, keys));
    return { pose: { pos: at.pos, q: at.q }, lens: layer.lens, size, geom: key.geom };
  }
  return null;
}
```

Replace `packages/annotate/src/crossview/derive.ts` with:

```ts
import type { DeriveSightings } from '../model/editor';
import { backProject, geomCenter, type RaySurface } from './backproject';
import { sightingCamera, type CameraSources } from './camera';

export interface DeriverSources extends CameraSources {
  scene: () => RaySurface | null;
}

/**
 * ANN-9 automation: when an image or video sighting is added to an issue that has no mesh
 * sighting yet, cast a ray from the camera pose through the shape's centre and add the mesh pin.
 * The pin names the sighting it came from (`from`): that marks it as automatic, so placing the
 * finding as an area on that layer replaces it (model/placed.ts).
 */
export function createDeriver(src: DeriverSources): DeriveSightings {
  return (sighting, issue) => {
    if (issue.sightings.some((s) => s.on === 'mesh')) return [];
    const scene = src.scene();
    if (!scene) return [];
    const cam = sightingCamera(sighting, src);
    const px = cam ? geomCenter(cam.geom) : null;
    if (!cam || !px) return [];
    const pin = backProject(cam.pose, cam.lens, px, cam.size, scene);
    if (!pin) return [];
    const at = issue.sightings.lastIndexOf(sighting);
    return [{ ...pin, from: { sighting: at >= 0 ? at : issue.sightings.length - 1 } }];
  };
}
```

Run: `pnpm --filter @aio/annotate exec vitest run src/crossview`
Expected: PASS (every existing deriver test too: `toMatchObject` and the field checks ignore the new `from`; fix any `toEqual` on a derived pin by adding `from` to the expected value).

- [ ] **Step 7: Runtime seams**

Add a test to `packages/annotate/src/runtime.test.ts` (import `cameraSources`, `imageSizeOf`, `rememberImageSize`, `setIssueListActions` from `./runtime`):

```ts
it('shares remembered sizes and the issue list actions', () => {
  rememberImageSize('photos', 'F09', [640, 480]);
  expect(imageSizeOf('photos', 'F09')).toEqual([640, 480]);
  expect(cameraSources.imageSize('photos', 'F09')).toEqual([640, 480]);
  expect(imageSizeOf('photos', 'nope')).toBeNull();
  const placeOnModel = (ids: readonly string[]) => ids.length;
  const off = setIssueListActions({ placeOnModel });
  off();
});
```

In `packages/annotate/src/runtime.ts`: import `type CameraSources` from `./crossview/camera`; add after `rememberImageSize`:

```ts
/** The pixel size remembered for a photo (or a video frame when `photoId` is null). */
export function imageSizeOf(layerId: string, photoId: string | null): Vec2 | null {
  return sizes.get(sizeKey(layerId, photoId)) ?? null;
}

/** Cameras of the open project's photos and frames, for projecting their shapes. */
export const cameraSources: CameraSources = {
  layers: () => workspace.getState().project?.manifest.layers ?? [],
  flight: getFlightPoses,
  imageSize: imageSizeOf,
  orientation: () => workspace.getState().orientation,
};
```

and make the deriver use it: `derive: createDeriver({ ...cameraSources, scene: () => getActiveScene() }),`. After `useTeamPolicy`:

```ts
/** Actions the app adds to the issue list's right-click menu (it owns what they do). */
export interface IssueListActions {
  /** "Place on model...": the ids of the issues right-clicked (the checked ones, else one). */
  placeOnModel?: (ids: readonly string[]) => void;
}

const listActions = createStore<IssueListActions>()(() => ({}));

/** Set the issue list actions; returns a function that removes them. */
export function setIssueListActions(actions: IssueListActions): () => void {
  listActions.setState(actions, true);
  return () => {
    if (listActions.getState() === actions) listActions.setState({}, true);
  };
}

export function useIssueListActions(): IssueListActions {
  return useStore(listActions, (s) => s);
}
```

Exports in `packages/annotate/src/index.ts`: add to the runtime block `cameraSources`, `imageSizeOf`, `setIssueListActions`, `useIssueListActions`, `type IssueListActions`; after the crossview block:

```ts
export { sightingCamera, type CameraSources, type SightingCamera } from './crossview/camera';
export {
  dropFrom,
  hasPlacedArea,
  isAutoPin,
  isPlacedArea,
  keepSightings,
  placedFrom,
  shiftFrom,
  withPlacedArea,
} from './model/placed';
```

- [ ] **Step 8: Run the package tests, typecheck and commit**

Run: `pnpm --filter @aio/annotate test && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add packages/annotate/src/model/placed.ts packages/annotate/src/model/placed.test.ts packages/annotate/src/model/ops.ts packages/annotate/src/model/ops.test.ts packages/annotate/src/model/editor.ts packages/annotate/src/model/editor.test.ts packages/annotate/src/crossview/camera.ts packages/annotate/src/crossview/camera.test.ts packages/annotate/src/crossview/derive.ts packages/annotate/src/crossview/derive.test.ts packages/annotate/src/runtime.ts packages/annotate/src/runtime.test.ts packages/annotate/src/index.ts
git commit -m "feat(annotate): placed areas replace the automatic pin and keep from right

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Annotate, the projector (`crossview/place.ts`)

**Files:**

- Create: `packages/annotate/src/crossview/outline.ts`, test `packages/annotate/src/crossview/outline.test.ts`
- Create: `packages/annotate/src/crossview/frustum.ts`, test `packages/annotate/src/crossview/frustum.test.ts`
- Modify: `packages/annotate/src/crossview/lens.ts` (export the existing `focalPx`)
- Create: `packages/annotate/src/crossview/place.ts`, test `packages/annotate/src/crossview/place.test.ts`
- Modify: `packages/annotate/src/index.ts` (exports)

**Interfaces:**

- Consumes: `RayOptions` (Task 3, type only); `sightingCamera`, `CameraSources`, `SightingCamera` (Task 7); `from` and `lod` (Task 1).
- Produces (from `@aio/annotate`):

```ts
// crossview/frustum.ts
export type Plane4 = [number, number, number, number]; // n . p + d >= 0 inside
export interface PhotoFrustum {
  eye: Vec3;
  planes: Plane4[];
  pxPerM: number;
}
export function photoFrustum(
  pose: CameraPose,
  lens: LensModel,
  size: Vec2,
  near?: number,
  far?: number,
): PhotoFrustum;
// crossview/place.ts
export const STEP_PX = 8,
  GRID = 7,
  MIN_HIT_RATE = 0.6,
  MIN_POINTS = 3,
  MAD_K = 3,
  MIN_SIZE_M = 0.1,
  REFINE_MS = 3000;
export type PlaceFailure = 'no-photo-shape' | 'missed' | 'layer-not-loaded';
export interface PrismQuery {
  ring: readonly Vec2[];
  minY: number;
  maxY: number;
} // ring in (x, z)
export interface CloudPlaceOps {
  refineAround(focus: PhotoFrustum, timeoutMs: number): Promise<{ depth: number; release(): void }>;
  pointsInPrism(layer: string, prism: PrismQuery): Float32Array;
}
export interface PlaceScene {
  raycastRay(origin: Vector3, dir: Vector3, opts?: RayOptions): Intersection | null;
  rayLayers?(): ReadonlySet<string>;
  cloud?: CloudPlaceOps;
}
export interface PendingSelection {
  positions: Float32Array;
  count: number;
  lod: number;
}
export type PlaceResult =
  | { ok: true; sightings: Sighting[]; from: number; hitRate: number; selection?: PendingSelection }
  | { ok: false; reason: PlaceFailure };
export interface PlaceCandidate {
  index: number;
  cam: SightingCamera;
  ring: Vec2[];
  area: number;
}
export function placeCandidates(issue: Issue, src: CameraSources): PlaceCandidate[];
export function placeOnLayer(
  issue: Issue,
  layer: Layer,
  scene: PlaceScene,
  src: CameraSources,
): Promise<PlaceResult>;
export function selectionSighting(
  layer: string,
  src: AssetRef,
  sel: PendingSelection,
  from: number,
): Sighting;
export function selectionName(issueId: string, layer: string): string;
```

`placeOnLayer` returns the sightings to add; it never writes. The caller (Task 11) writes the selection file, appends `selectionSighting(...)`, and commits through `withPlacedArea` and `issueEditor.commitIssues`, so undo and validation work (spec section 3, last bullet). A cloud's selection stays pending in the result for that reason. The pin replacement happens in `withPlacedArea` (Task 7).

Decisions inside the spec's numbers:

- The cloud cone half-angle is two photo pixels (`2 * hfov / width`); the provider raises it to 0.75 x the node spacing (Task 4) so a sparse cloud is still hit.
- The 3 MAD test uses `max(MAD, 0.01 m)`, so a flat patch seen straight on (MAD near 0) does not reject its own points.
- The prism height is at least 0.1 m (the hull padding rule applied to height as well); a flat patch would otherwise get a zero-height prism that selects nothing.
- The 60 % grid test counts every grid ray that hits, before the depth rejection; the hull needs 3 kept points after it.

- [ ] **Step 1: Write the failing 2D helper tests**

Create `packages/annotate/src/crossview/outline.test.ts`:

```ts
import type { Vec2 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  convexHull2,
  densify,
  gridInside,
  hullWidth,
  mad,
  median,
  outlineOf,
  padHull,
  pointInRing,
  ringArea,
} from './outline';

const square: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('outlines', () => {
  it('outlines boxes, rotated boxes and polygons; not points or masks', () => {
    expect(outlineOf({ type: 'box', x: 1, y: 2, w: 3, h: 4 })).toEqual([
      [1, 2],
      [4, 2],
      [4, 6],
      [1, 6],
    ]);
    const rot = outlineOf({ type: 'rotbox', x: 0, y: 0, w: 4, h: 2, angleDeg: 90 }) ?? [];
    const xs = rot.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2, 9);
    expect(outlineOf({ type: 'polygon', points: square })).toEqual(square);
    expect(outlineOf({ type: 'point', x: 1, y: 1 })).toBeNull();
    expect(outlineOf({ type: 'mask', src: { path: 'm.png' } })).toBeNull();
  });

  it('densifies a closed ring every step pixels', () => {
    const d = densify(square, 8);
    expect(d).toHaveLength(8); // each 10 px edge in 2 steps
    expect(d[0]).toEqual([0, 0]);
    expect(d[1]).toEqual([5, 0]);
    expect(densify(square, 100)).toHaveLength(4);
  });

  it('lays an n x n grid inside the ring', () => {
    expect(gridInside(square, 7)).toHaveLength(49);
    const tri: Vec2[] = [
      [0, 0],
      [10, 0],
      [0, 10],
    ];
    const g = gridInside(tri, 7);
    expect(g.length).toBeGreaterThan(15);
    expect(g.length).toBeLessThan(35);
    expect(g.every((p) => pointInRing(p, tri))).toBe(true);
  });

  it('measures rings and hulls', () => {
    expect(ringArea(square)).toBe(100);
    expect(convexHull2([...square, [5, 5], [0, 0]])).toHaveLength(4);
    expect(hullWidth(convexHull2(square))).toBeCloseTo(10, 9);
  });

  it('pads a thin hull to the minimum width, and leaves a wide one alone', () => {
    const line: Vec2[] = [
      [0, 0],
      [5, 0.02],
      [10, 0],
    ];
    const padded = padHull(line, 0.1);
    expect(hullWidth(padded)).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(padHull(square, 0.1)).toEqual(convexHull2(square));
    expect(hullWidth(padHull([[3, 4]], 0.1))).toBeGreaterThanOrEqual(0.1 - 1e-9);
  });

  it('takes the median and the median absolute deviation', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100], 3)).toBe(1);
  });
});
```

Run: `pnpm --filter @aio/annotate exec vitest run src/crossview/outline.test.ts`
Expected: FAIL, `Cannot find module './outline'`.

- [ ] **Step 2: Create `packages/annotate/src/crossview/outline.ts`**

```ts
import type { FrameGeom, ImageGeom, Vec2 } from '@aio/schema';

/**
 * 2D helpers of the projector (findings on a model): shape outlines in image pixels, samples
 * along and inside them, and plan-view hulls in metres. Pure.
 */

/** The outline of a box, rotated box or polygon, in image pixels; null for points and masks. */
export function outlineOf(g: ImageGeom | FrameGeom): Vec2[] | null {
  switch (g.type) {
    case 'box':
      return [
        [g.x, g.y],
        [g.x + g.w, g.y],
        [g.x + g.w, g.y + g.h],
        [g.x, g.y + g.h],
      ];
    case 'rotbox': {
      const cx = g.x + g.w / 2;
      const cy = g.y + g.h / 2;
      const a = (g.angleDeg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const corners: Vec2[] = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ];
      return corners.map(([u, v]): Vec2 => {
        const dx = (u * g.w) / 2;
        const dy = (v * g.h) / 2;
        return [cx + dx * c - dy * s, cy + dx * s + dy * c];
      });
    }
    case 'polygon':
      return g.points.map((p): Vec2 => [p[0], p[1]]);
    default:
      return null;
  }
}

/** Samples along a closed ring, one every `step` (the corners included). */
export function densify(ring: readonly Vec2[], step = 8): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Even-odd point in ring. */
export function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** The cell centres of an n x n grid over the ring's bounds that fall inside it. */
export function gridInside(ring: readonly Vec2[], n = 7): Vec2[] {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const out: Vec2[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const p: Vec2 = [x0 + ((i + 0.5) * (x1 - x0)) / n, y0 + ((j + 0.5) * (y1 - y0)) / n];
      if (pointInRing(p, ring)) out.push(p);
    }
  return out;
}

export function ringArea(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

const turn = (o: Vec2, a: Vec2, b: Vec2) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull, counter-clockwise, no repeated points (Andrew's monotone chain). */
export function convexHull2(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const half = (list: readonly Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of list) {
      while (out.length >= 2) {
        const a = out[out.length - 2];
        const b = out[out.length - 1];
        if (a && b && turn(a, b, p) <= 0) out.pop();
        else break;
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/** The smallest width of a convex hull (0 for fewer than three points). */
export function hullWidth(hull: readonly Vec2[]): number {
  if (hull.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    let far = 0;
    for (const p of hull)
      far = Math.max(
        far,
        Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len,
      );
    best = Math.min(best, far);
  }
  return best === Infinity ? 0 : best;
}

const OCTAGON: Vec2[] = Array.from({ length: 8 }, (_, k): Vec2 => [
  Math.cos((k * Math.PI) / 4),
  Math.sin((k * Math.PI) / 4),
]);

/**
 * The hull of `points`, grown to at least `minWidth` across when it is thinner (like the Cloud
 * box tool's padding): every point is widened by an octagon whose inner radius is minWidth / 2.
 */
export function padHull(points: readonly Vec2[], minWidth: number): Vec2[] {
  const hull = convexHull2(points);
  if (hull.length >= 3 && hullWidth(hull) >= minWidth) return hull;
  const r = minWidth / 2 / Math.cos(Math.PI / 8);
  const grown: Vec2[] = [];
  for (const [x, y] of hull) for (const [dx, dy] of OCTAGON) grown.push([x + dx * r, y + dy * r]);
  return convexHull2(grown);
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length === 0) return 0;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

/** Median absolute deviation around `centre`. */
export function mad(xs: readonly number[], centre: number): number {
  return median(xs.map((x) => Math.abs(x - centre)));
}
```

Run: `pnpm --filter @aio/annotate exec vitest run src/crossview/outline.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing frustum test**

Create `packages/annotate/src/crossview/frustum.test.ts`:

```ts
import type { Quat, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { photoFrustum, type Plane4 } from './frustum';

const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const inside = (planes: Plane4[], p: Vec3) =>
  planes.every(([nx, ny, nz, d]) => nx * p[0] + ny * p[1] + nz * p[2] + d >= -1e-9);

describe('photoFrustum', () => {
  it('holds what a photo looking straight down sees, and its pixel scale', () => {
    const f = photoFrustum(
      { pos: [3, 10, 4], q: down },
      { model: 'pinhole', hfovDeg: 90, aspect: 4 / 3 },
      [1200, 900],
    );
    expect(f.planes).toHaveLength(6);
    expect(f.eye).toEqual([3, 10, 4]);
    expect(f.pxPerM).toBeCloseTo(600, 6);
    expect(inside(f.planes, [3, 0, 4])).toBe(true);
    expect(inside(f.planes, [12, 0, 4])).toBe(true); // 9 m aside at 10 m: inside 45 degrees
    expect(inside(f.planes, [30, 0, 4])).toBe(false);
    expect(inside(f.planes, [3, 20, 4])).toBe(false); // behind the camera
  });

  it('works for a wide f-theta lens', () => {
    const f = photoFrustum(
      { pos: [0, 10, 0], q: down },
      { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 },
      [1280, 720],
    );
    expect(inside(f.planes, [0, 0, 0])).toBe(true);
    expect(inside(f.planes, [100, 0, 0])).toBe(false);
  });
});
```

Run: `pnpm --filter @aio/annotate exec vitest run src/crossview/frustum.test.ts`
Expected: FAIL, `Cannot find module './frustum'`.

- [ ] **Step 4: Create `frustum.ts` and export `focalPx`**

In `packages/annotate/src/crossview/lens.ts`, change `function focalPx(` to `export function focalPx(` (and add the doc line `/** Focal length in pixels for an image `width` wide. */`).

`packages/annotate/src/crossview/frustum.ts`:

```ts
import type { LensModel, Vec2, Vec3 } from '@aio/schema';
import { focalPx, pixelToCameraRay, rotate, type CameraPose } from './lens';

/** A plane as [nx, ny, nz, d]: a point p is inside when n . p + d >= 0. */
export type Plane4 = [number, number, number, number];

/** What a posed photo sees, for loading point-cloud detail there (`refineAround`). */
export interface PhotoFrustum {
  eye: Vec3;
  planes: Plane4[];
  /** The photo's focal length in pixels: pixels per metre at distance 1. */
  pxPerM: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The six planes of a photo's view: four through its corner rays, near and far. */
export function photoFrustum(
  pose: CameraPose,
  lens: LensModel,
  size: Vec2,
  near = 0.3,
  far = 1000,
): PhotoFrustum {
  const [w, h] = size;
  const corners: Vec2[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const rays = corners.map((c) => rotate(pose.q, pixelToCameraRay(lens, c, size)));
  const fwd = unit(rotate(pose.q, [0, 0, -1]));
  const planes: Plane4[] = [];
  for (let i = 0; i < 4; i++) {
    const a = rays[i];
    const b = rays[(i + 1) % 4];
    if (!a || !b) continue;
    let n = unit(cross(a, b));
    if (dot(n, fwd) < 0) n = [-n[0], -n[1], -n[2]];
    planes.push([n[0], n[1], n[2], -dot(n, pose.pos)]);
  }
  const at = (d: number): Vec3 => [
    pose.pos[0] + fwd[0] * d,
    pose.pos[1] + fwd[1] * d,
    pose.pos[2] + fwd[2] * d,
  ];
  planes.push([fwd[0], fwd[1], fwd[2], -dot(fwd, at(near))]);
  planes.push([-fwd[0], -fwd[1], -fwd[2], dot(fwd, at(far))]);
  return { eye: pose.pos, planes, pxPerM: focalPx(lens, w) };
}
```

Run: `pnpm --filter @aio/annotate exec vitest run src/crossview/frustum.test.ts src/crossview/lens.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing projector tests**

Create `packages/annotate/src/crossview/place.test.ts`:

```ts
import type { Issue, Layer, Quat, Sighting } from '@aio/schema';
import { Object3D, Vector3, type Intersection } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { makeIssue } from '../testing';
import type { CameraSources } from './camera';
import {
  placeCandidates,
  placeOnLayer,
  selectionName,
  selectionSighting,
  type CloudPlaceOps,
  type PlaceScene,
} from './place';

const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const lens = { model: 'pinhole' as const, hfovDeg: 90, aspect: 4 / 3 };
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const photos: Layer = {
  kind: 'photos',
  id: 'photos',
  name: 'Photos',
  visible: true,
  items: [
    { id: 'F01', src: { path: 'p/F01.jpg' }, pos: [3, 10, 4], q: down, lens },
    { id: 'F02', src: { path: 'p/F02.jpg' }, pos: [3, 10, 4], q: down, lens },
    { id: 'nopose', src: { path: 'p/x.jpg' } },
  ],
};
const mesh: Layer = {
  kind: 'mesh',
  id: 'site',
  name: 'Site',
  visible: true,
  src: { path: 'm.glb' },
  transform: I,
};
const cloud: Layer = {
  kind: 'pointcloud',
  id: 'cloud',
  name: 'Cloud',
  visible: true,
  src: { path: 'c.json' },
  format: 'png-packed',
};
const src: CameraSources = {
  layers: () => [photos, mesh, cloud],
  flight: () => null,
  imageSize: () => [1200, 900],
};
// 1200 px across 20 m at 10 m: 60 px a metre; the image centre (600, 450) sees (3, 0, 4)
const box = (photo: string, x: number, y: number, w: number, h: number): Sighting => ({
  on: 'image',
  layer: 'photos',
  photo,
  geom: { type: 'box', x, y, w, h },
});

/** The ground y = 0 as the given layer; `hole` drops hits, `far` pushes hits 20 m deeper. */
function plane(
  layer: string,
  opts: {
    hole?: (p: Vector3) => boolean;
    far?: (p: Vector3) => boolean;
    cloud?: CloudPlaceOps;
  } = {},
): PlaceScene {
  return {
    raycastRay: (o, d, r): Intersection | null => {
      if (r?.layer !== layer || d.y >= 0) return null;
      const t = -o.y / d.y;
      const p = o.clone().addScaledVector(d, t);
      if (opts.hole?.(p)) return null;
      const extra = opts.far?.(p) ? 20 : 0;
      return {
        distance: t + extra,
        point: o.clone().addScaledVector(d, t + extra),
        object: new Object3D(),
      };
    },
    rayLayers: () => new Set([layer]),
    ...(opts.cloud ? { cloud: opts.cloud } : {}),
  };
}

const issueWith = (...sightings: Sighting[]): Issue => makeIssue({ sightings });

describe('placeOnLayer on a mesh', () => {
  it('lays the densified outline on the surface, marked with the photo it came from', async () => {
    const r = await placeOnLayer(
      issueWith(box('F01', 500, 400, 200, 100)),
      mesh,
      plane('site'),
      src,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.from).toBe(0);
    expect(r.hitRate).toBe(1);
    const s = r.sightings[0];
    if (s?.on !== 'mesh' || s.geom.type !== 'spolygon') throw new Error('expected an outline');
    expect(s).toMatchObject({ layer: 'site', from: { sighting: 0 } });
    expect(s.geom.points).toHaveLength(25 + 13 + 25 + 13);
    for (const p of s.geom.points) {
      expect(p[1]).toBeCloseTo(0, 6);
      expect(p[0]).toBeGreaterThan(3 - 100 / 60 - 1e-6);
      expect(p[0]).toBeLessThan(3 + 100 / 60 + 1e-6);
    }
  });

  it('drops misses but needs 60 % of the samples on the model', async () => {
    // x > 4 m is a hole: 180 of 480 outline pixels miss (hit rate 0.625)
    const hole = (p: Vector3) => p.x > 4;
    const ok = await placeOnLayer(
      issueWith(box('F01', 540, 420, 180, 60)),
      mesh,
      plane('site', { hole }),
      src,
    );
    expect(ok.ok && ok.hitRate).toBeGreaterThanOrEqual(0.6);
    expect(ok.ok && ok.hitRate).toBeLessThan(0.7);
    // x > 3.2 m: most of it misses
    const most = (p: Vector3) => p.x > 3.2;
    expect(
      await placeOnLayer(
        issueWith(box('F01', 540, 420, 180, 60)),
        mesh,
        plane('site', { hole: most }),
        src,
      ),
    ).toEqual({ ok: false, reason: 'missed' });
  });

  it('takes the shape with the best hit rate, then the larger one', async () => {
    const hole = (p: Vector3) => p.x > 4;
    const big = box('F01', 540, 420, 180, 60); // hit rate 0.625
    const small = box('F02', 570, 420, 60, 60); // all of it on the model
    const r = await placeOnLayer(issueWith(big, small), mesh, plane('site', { hole }), src);
    expect(r.ok && r.from).toBe(1);
    const larger = box('F02', 520, 400, 120, 100);
    const tie = await placeOnLayer(issueWith(small, larger), mesh, plane('site'), src);
    expect(tie.ok && tie.from).toBe(1);
  });

  it('says why it could not place', async () => {
    const point: Sighting = {
      on: 'image',
      layer: 'photos',
      photo: 'F01',
      geom: { type: 'point', x: 1, y: 1 },
    };
    expect(await placeOnLayer(issueWith(point), mesh, plane('site'), src)).toEqual({
      ok: false,
      reason: 'no-photo-shape',
    });
    expect(
      await placeOnLayer(issueWith(box('nopose', 0, 0, 10, 10)), mesh, plane('site'), src),
    ).toEqual({
      ok: false,
      reason: 'no-photo-shape',
    });
    expect(
      await placeOnLayer(issueWith(box('F01', 500, 400, 200, 100)), mesh, plane('other'), src),
    ).toEqual({
      ok: false,
      reason: 'layer-not-loaded',
    });
    expect(
      placeCandidates(issueWith(point, box('F01', 0, 0, 8, 8)), src).map((c) => c.index),
    ).toEqual([1]);
  });
});

describe('placeOnLayer on a point cloud', () => {
  const ops = (positions = new Float32Array([3, 0, 4, 3.1, 0, 4.1])) => {
    const release = vi.fn();
    const cloudOps: CloudPlaceOps = {
      refineAround: vi.fn(() => Promise.resolve({ depth: 5, release })),
      pointsInPrism: vi.fn(() => positions),
    };
    return { cloudOps, release };
  };

  it('builds the prism from the hits, rejects what was seen through a gap, and cuts the selection', async () => {
    const { cloudOps, release } = ops();
    // beyond x = 4 m the rays pass a gap and hit 20 m deeper
    const far = (p: Vector3) => p.x > 4;
    const r = await placeOnLayer(
      issueWith(box('F01', 540, 420, 180, 60)),
      cloud,
      plane('cloud', { far, cloud: cloudOps }),
      src,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.hitRate).toBe(1);
    const s = r.sightings[0];
    if (s?.on !== 'pointcloud' || s.geom.type !== 'polygon3') throw new Error('expected a prism');
    expect(s.from).toEqual({ sighting: 0 });
    expect(s.geom.height).toBeCloseTo(0.1, 9); // flat ground: the minimum height
    for (const p of s.geom.points) {
      expect(p[1]).toBeCloseTo(0, 6);
      expect(p[0]).toBeLessThanOrEqual(4 + 1e-6);
    }
    expect(r.selection).toMatchObject({ count: 2, lod: 5 });
    expect(cloudOps.refineAround).toHaveBeenCalledWith(
      expect.objectContaining({ eye: [3, 10, 4] }),
      3000,
    );
    expect(cloudOps.pointsInPrism).toHaveBeenCalledWith(
      'cloud',
      expect.objectContaining({ minY: expect.closeTo(0, 6), maxY: expect.closeTo(0.1, 6) }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('needs 60 % of the grid rays to hit, and always hands the detail back', async () => {
    const { cloudOps, release } = ops();
    const hole = (p: Vector3) => p.x > 2.9;
    expect(
      await placeOnLayer(
        issueWith(box('F01', 540, 420, 180, 60)),
        cloud,
        plane('cloud', { hole, cloud: cloudOps }),
        src,
      ),
    ).toEqual({ ok: false, reason: 'missed' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('leaves the selection out when no loaded point is inside', async () => {
    const { cloudOps } = ops(new Float32Array(0));
    const r = await placeOnLayer(
      issueWith(box('F01', 500, 400, 200, 100)),
      cloud,
      plane('cloud', { cloud: cloudOps }),
      src,
    );
    expect(r.ok && r.selection).toBeUndefined();
  });

  it('is not loaded without the cloud operations', async () => {
    expect(
      await placeOnLayer(issueWith(box('F01', 500, 400, 200, 100)), cloud, plane('cloud'), src),
    ).toEqual({
      ok: false,
      reason: 'layer-not-loaded',
    });
  });
});

describe('selection sightings', () => {
  it('names the file after the issue and layer, and writes count and lod', () => {
    expect(selectionName('3f2a-b', 'cloud d2')).toBe('3f2a-b-cloud-d2');
    expect(
      selectionSighting(
        'cloud',
        { path: 'selections/x.sel' },
        { positions: new Float32Array(6), count: 2, lod: 4 },
        0,
      ),
    ).toEqual({
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'selection', src: { path: 'selections/x.sel' }, count: 2, lod: 4 },
      from: { sighting: 0 },
    });
  });
});
```

Run: `pnpm --filter @aio/annotate exec vitest run src/crossview/place.test.ts`
Expected: FAIL, `Cannot find module './place'`.

- [ ] **Step 6: Create `packages/annotate/src/crossview/place.ts`**

```ts
/**
 * Findings on a model (plan 2026-10-15-findings-on-model, spec section 3): project an issue's
 * photo or frame shape onto a mesh or point-cloud layer as a real area. Every image or video
 * sighting with a box or polygon is a candidate; the best hit rate wins, ties to the larger
 * shape. Nothing is written here: the caller writes the selection file and commits the result
 * through the issue editor (`withPlacedArea`, `commitIssues`).
 */
import type { RayOptions } from '@aio/engine';
import type { AssetRef, Issue, Layer, Sighting, Vec2, Vec3 } from '@aio/schema';
import { Vector3, type Intersection } from 'three';
import { sightingCamera, type CameraSources, type SightingCamera } from './camera';
import { photoFrustum, type PhotoFrustum } from './frustum';
import { pixelToWorldRay } from './lens';
import { densify, gridInside, mad, median, outlineOf, padHull, ringArea } from './outline';

export const STEP_PX = 8;
export const GRID = 7;
export const MIN_HIT_RATE = 0.6;
export const MIN_POINTS = 3;
export const MAD_K = 3;
export const MIN_SIZE_M = 0.1;
export const REFINE_MS = 3000;

export type PlaceFailure = 'no-photo-shape' | 'missed' | 'layer-not-loaded';

/** A vertical prism: a plan-view ring (x, z) and a height range (local y). */
export interface PrismQuery {
  ring: readonly Vec2[];
  minY: number;
  maxY: number;
}

/** What the projector needs of the point clouds (the app wires @aio/pointcloud here). */
export interface CloudPlaceOps {
  refineAround(focus: PhotoFrustum, timeoutMs: number): Promise<{ depth: number; release(): void }>;
  pointsInPrism(layer: string, prism: PrismQuery): Float32Array;
}

/** What the projector needs of the scene (a `SceneHandle` fits, plus the cloud operations). */
export interface PlaceScene {
  raycastRay(origin: Vector3, dir: Vector3, opts?: RayOptions): Intersection | null;
  rayLayers?(): ReadonlySet<string>;
  cloud?: CloudPlaceOps;
}

/** The points of a cloud finding, before their file is written. */
export interface PendingSelection {
  positions: Float32Array;
  count: number;
  lod: number;
}

export type PlaceResult =
  | { ok: true; sightings: Sighting[]; from: number; hitRate: number; selection?: PendingSelection }
  | { ok: false; reason: PlaceFailure };

export interface PlaceCandidate {
  /** Index of the image or video sighting. */
  index: number;
  cam: SightingCamera;
  ring: Vec2[];
  /** Area in image pixels (the tie-break). */
  area: number;
}

interface Placed {
  sightings: Sighting[];
  hitRate: number;
  selection?: PendingSelection;
}

/** The image and video sightings with a box or polygon and a known camera (masks skipped). */
export function placeCandidates(issue: Issue, src: CameraSources): PlaceCandidate[] {
  const out: PlaceCandidate[] = [];
  issue.sightings.forEach((s, index) => {
    if (s.on !== 'image' && s.on !== 'video') return;
    const cam = sightingCamera(s, src);
    const ring = cam ? outlineOf(cam.geom) : null;
    if (!cam || !ring || ring.length < 3) return;
    out.push({ index, cam, ring, area: ringArea(ring) });
  });
  return out;
}

function rayOf(cam: SightingCamera, px: Vec2): { o: Vector3; d: Vector3 } {
  const r = pixelToWorldRay(cam.pose, cam.lens, px, cam.size);
  return { o: new Vector3(...r.origin), d: new Vector3(...r.dir) };
}

const hitPoint = (h: Intersection): Vec3 => [h.point.x, h.point.y, h.point.z];

function placeMesh(c: PlaceCandidate, layer: string, scene: PlaceScene): Placed | null {
  const samples = densify(c.ring, STEP_PX);
  const points: Vec3[] = [];
  for (const px of samples) {
    const { o, d } = rayOf(c.cam, px);
    const hit = scene.raycastRay(o, d, { layer });
    if (hit) points.push(hitPoint(hit));
  }
  const hitRate = samples.length ? points.length / samples.length : 0;
  if (hitRate < MIN_HIT_RATE || points.length < MIN_POINTS) return null;
  return {
    hitRate,
    sightings: [
      { on: 'mesh', layer, geom: { type: 'spolygon', points }, from: { sighting: c.index } },
    ],
  };
}

/** Half-angle of the cloud search cone: two pixels of the photo. */
const coneOf = (c: PlaceCandidate) => (2 * ((c.cam.lens.hfovDeg * Math.PI) / 180)) / c.cam.size[0];

async function placeCloud(
  c: PlaceCandidate,
  layer: string,
  scene: PlaceScene,
  ops: CloudPlaceOps,
): Promise<Placed | null> {
  const detail = await ops.refineAround(
    photoFrustum(c.cam.pose, c.cam.lens, c.cam.size),
    REFINE_MS,
  );
  try {
    const coneRad = coneOf(c);
    const cast = (px: Vec2) => {
      const { o, d } = rayOf(c.cam, px);
      return scene.raycastRay(o, d, { layer, coneRad });
    };
    const isHit = (h: Intersection | null): h is Intersection => h !== null;
    const grid = gridInside(c.ring, GRID);
    const gridHits = grid.map(cast).filter(isHit);
    const hitRate = grid.length ? gridHits.length / grid.length : 0;
    if (hitRate < MIN_HIT_RATE) return null;
    const hits = [...gridHits, ...densify(c.ring, STEP_PX).map(cast).filter(isHit)];
    // hits far behind the rest saw the background through a gap
    const depths = hits.map((h) => h.distance);
    const mid = median(depths);
    const spread = Math.max(mad(depths, mid), 0.01);
    const kept = hits.filter((h) => Math.abs(h.distance - mid) <= MAD_K * spread);
    if (kept.length < MIN_POINTS) return null;
    const ys = kept.map((h) => h.point.y);
    const base = Math.min(...ys);
    const height = Math.max(Math.max(...ys) - base, MIN_SIZE_M);
    const ring = padHull(
      kept.map((h): Vec2 => [h.point.x, h.point.z]),
      MIN_SIZE_M,
    );
    if (ring.length < MIN_POINTS) return null;
    const points = ring.map(([x, z]): Vec3 => [x, base, z]);
    const positions = ops.pointsInPrism(layer, { ring, minY: base, maxY: base + height });
    const count = Math.floor(positions.length / 3);
    return {
      hitRate,
      sightings: [
        {
          on: 'pointcloud',
          layer,
          geom: { type: 'polygon3', points, height },
          from: { sighting: c.index },
        },
      ],
      ...(count > 0 ? { selection: { positions, count, lod: detail.depth } } : {}),
    };
  } finally {
    detail.release();
  }
}

/** Project the issue's best photo or frame shape onto `layer` (spec section 3). */
export async function placeOnLayer(
  issue: Issue,
  layer: Layer,
  scene: PlaceScene,
  src: CameraSources,
): Promise<PlaceResult> {
  if (layer.kind !== 'mesh' && layer.kind !== 'pointcloud')
    return { ok: false, reason: 'layer-not-loaded' };
  const candidates = placeCandidates(issue, src);
  if (candidates.length === 0) return { ok: false, reason: 'no-photo-shape' };
  if (scene.rayLayers && !scene.rayLayers().has(layer.id))
    return { ok: false, reason: 'layer-not-loaded' };
  const cloud = scene.cloud;
  if (layer.kind === 'pointcloud' && !cloud) return { ok: false, reason: 'layer-not-loaded' };
  let best: { c: PlaceCandidate; r: Placed } | null = null;
  for (const c of candidates) {
    const r =
      layer.kind === 'mesh'
        ? placeMesh(c, layer.id, scene)
        : cloud
          ? await placeCloud(c, layer.id, scene, cloud)
          : null;
    if (!r) continue;
    if (
      !best ||
      r.hitRate > best.r.hitRate ||
      (r.hitRate === best.r.hitRate && c.area > best.c.area)
    )
      best = { c, r };
  }
  if (!best) return { ok: false, reason: 'missed' };
  return {
    ok: true,
    sightings: best.r.sightings,
    from: best.c.index,
    hitRate: best.r.hitRate,
    ...(best.r.selection ? { selection: best.r.selection } : {}),
  };
}

/** The selection sighting once its file is written. */
export function selectionSighting(
  layer: string,
  src: AssetRef,
  sel: PendingSelection,
  from: number,
): Sighting {
  return {
    on: 'pointcloud',
    layer,
    geom: { type: 'selection', src, count: sel.count, lod: sel.lod },
    from: { sighting: from },
  };
}

/** The selection file name (`SelectionName`): issue id and layer id, made safe. */
export function selectionName(issueId: string, layer: string): string {
  return `${issueId}-${layer}`.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 120) || 'selection';
}
```

Exports in `packages/annotate/src/index.ts`, after the Task 7 crossview exports:

```ts
export { photoFrustum, type PhotoFrustum, type Plane4 } from './crossview/frustum';
export {
  GRID,
  MIN_HIT_RATE,
  placeCandidates,
  placeOnLayer,
  selectionName,
  selectionSighting,
  STEP_PX,
  type CloudPlaceOps,
  type PendingSelection,
  type PlaceCandidate,
  type PlaceFailure,
  type PlaceResult,
  type PlaceScene,
  type PrismQuery,
} from './crossview/place';
```

- [ ] **Step 7: Run the crossview tests**

Run: `pnpm --filter @aio/annotate exec vitest run src/crossview`
Expected: PASS. If the "0.625" hit-rate test lands a sample exactly on x = 4, it counts as a hit (`p.x > 4` misses); the expected range is 0.6 to 0.7.

- [ ] **Step 8: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add packages/annotate/src/crossview/outline.ts packages/annotate/src/crossview/outline.test.ts packages/annotate/src/crossview/frustum.ts packages/annotate/src/crossview/frustum.test.ts packages/annotate/src/crossview/lens.ts packages/annotate/src/crossview/place.ts packages/annotate/src/crossview/place.test.ts packages/annotate/src/index.ts
git commit -m "feat(annotate): project findings from photos onto a mesh or point cloud

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Annotate, drawing areas, hover, click and anchors

**Files:**

- Create: `packages/annotate/src/tools/areas.ts`, test `packages/annotate/src/tools/areas.test.ts`
- Modify: `packages/annotate/src/tools/mesh.ts` (`bestAnchor` prefers a placed area; `issuePins` takes the ids to skip)
- Test: `packages/annotate/src/tools/mesh.test.ts` (new `it`s)
- Modify: `packages/annotate/src/tools/overlay.ts` (area meshes, layout, labels, hover, click; rebuild on `hidden`)
- Test: `packages/annotate/src/tools/scene.test.ts` (new `it`)

**Interfaces:**

- Consumes: `isPlacedArea` (Task 7); `from` (Task 1).
- Produces (internal to annotate; the overlay is already exported):

```ts
export interface IssueArea {
  issueId: string;
  code: string;
  title: string;
  color: string;
  layer: string;
  kind: 'surface' | 'prism';
  ring: Vec3[];
  height: number;
  centre: Vec3;
}
export function issueAreas(
  issues: readonly Issue[],
  models: readonly SeverityModel[],
  selectedId: string | null,
  filter: PinFilter,
  hidden: Readonly<Record<string, true>>,
): IssueArea[];
export interface AreaBuffers {
  lines: Float32Array;
  lineColors: Float32Array;
  fill: Float32Array;
  fillColors: Float32Array;
}
export function areaBuffers(
  areas: readonly IssueArea[],
  highlight: ReadonlySet<string>,
  rgb: (css: string) => [number, number, number],
): AreaBuffers;
export interface ScreenPoint {
  x: number;
  y: number;
}
export interface AreaHit {
  issueId: string;
  rings: ScreenPoint[][];
  centre: ScreenPoint | null;
}
export function screenAreas(
  areas: readonly IssueArea[],
  project: (p: Vec3) => ScreenPoint | null,
): AreaHit[]; // one per area, same order
export function hitArea(hits: readonly AreaHit[], x: number, y: number): string | null;
// mesh.ts
export function issuePins(
  issues,
  models,
  selectedId,
  filter?: PinFilter,
  skip?: ReadonlySet<string>,
): IssuePin[];
```

Overlay rules (spec section 5): an `spolygon` is a line on the surface with a faint fill, a `polygon3` a wireframe prism with a translucent fill, both in the severity colour; the issue code as a label at the area centre; no pin for an issue whose area is drawn; hover highlights the area and shows the issue title as the canvas tooltip (the pattern the cluster badge uses); a click selects the issue from the 3D view, which opens its photos beside it (`startCardFocus` and `openEvidence` in the desktop, starting photo in Task 12). Areas follow `issuesOnScreen` and are skipped while their layer is hidden; such an issue gets its pin back.

Decision: `spolygon` stores no normals, so the "small offset along the normal" is done in the vertex shader as a pull towards the camera of 0.3 % of the view distance (the heat map shader's trick). It keeps the line in front of the surface it lies on at any angle, with the depth test on.

- [ ] **Step 1: Write the failing area tests**

Create `packages/annotate/src/tools/areas.test.ts`:

```ts
import type { Issue, Sighting, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { makeIssue, photoSighting, tankModel } from '../testing';
import { areaBuffers, hitArea, issueAreas, screenAreas } from './areas';

const ring: Vec3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [2, 0, 2],
  [0, 0, 2],
];
const outline = (layer: string): Sighting => ({
  on: 'mesh',
  layer,
  geom: { type: 'spolygon', points: ring },
  from: { sighting: 0 },
});
const prism: Sighting = {
  on: 'pointcloud',
  layer: 'cloud',
  geom: { type: 'polygon3', points: ring, height: 1 },
  from: { sighting: 0 },
};
const placed = (over: Partial<Issue> = {}) =>
  makeIssue({ sightings: [photoSighting, outline('tank'), prism], ...over });

describe('issueAreas', () => {
  it('lists the outline and the prism of a placed issue in its severity colour', () => {
    const a = issueAreas([placed()], [tankModel], null, 'all', {});
    expect(a.map((x) => [x.kind, x.layer, x.height])).toEqual([
      ['surface', 'tank', 0],
      ['prism', 'cloud', 1],
    ]);
    expect(a[0]?.color).toBe('#e5484d');
    expect(a[0]?.centre).toEqual([1, 0, 1]);
    expect(a[1]?.centre).toEqual([1, 0.5, 1]);
  });

  it('skips hidden layers, hand-drawn polygons and issues the pin filter hides', () => {
    expect(
      issueAreas([placed()], [tankModel], null, 'all', { tank: true }).map((x) => x.layer),
    ).toEqual(['cloud']);
    const drawn = makeIssue({
      sightings: [{ on: 'mesh', layer: 'tank', geom: { type: 'spolygon', points: ring } }],
    });
    expect(issueAreas([drawn], [tankModel], null, 'all', {})).toEqual([]);
    const low = placed({ severity: 2 });
    expect(issueAreas([low], [tankModel], null, 4, {})).toEqual([]);
    expect(issueAreas([low], [tankModel], low.id, 4, {})).toHaveLength(2);
  });
});

describe('areaBuffers', () => {
  it('draws a surface as its ring with a fan, a prism as a wireframe with closed faces', () => {
    const [surface, box] = issueAreas([placed()], [tankModel], null, 'all', {});
    if (!surface || !box) throw new Error('no areas');
    const rgb = (): [number, number, number] => [1, 0, 0];
    const s = areaBuffers([surface], new Set(), rgb);
    expect(s.lines.length / 3).toBe(8); // 4 segments
    expect(s.fill.length / 3).toBe(12); // 4 triangles
    const p = areaBuffers([box], new Set(), rgb);
    expect(p.lines.length / 3).toBe(24); // bottom, top, 4 posts
    expect(p.fill.length / 3).toBe(48); // 2 fans and 4 sides of 2 triangles
    const lit = areaBuffers([surface], new Set([surface.issueId]), rgb);
    expect(lit.lineColors[1]).toBeGreaterThan(0); // mixed towards white
    expect(s.lineColors[1]).toBe(0);
  });
});

describe('screen hits', () => {
  it('projects each area and picks the smallest under the cursor', () => {
    const areas = issueAreas(
      [
        placed({ id: 'big' }),
        makeIssue({
          id: 'small',
          code: 'F02',
          sightings: [
            photoSighting,
            {
              ...outline('tank'),
              geom: { type: 'spolygon', points: ring.map((p): Vec3 => [p[0] / 4, 0, p[2] / 4]) },
            },
          ],
        }),
      ],
      [tankModel],
      null,
      'all',
      { cloud: true },
    );
    const top = (p: Vec3) => ({ x: p[0] * 100, y: p[2] * 100 });
    const hits = screenAreas(areas, top);
    expect(hits.map((h) => h.issueId)).toEqual(['big', 'small']);
    expect(hits[0]?.centre).toEqual({ x: 100, y: 100 });
    expect(hitArea(hits, 20, 20)).toBe('small');
    expect(hitArea(hits, 150, 150)).toBe('big');
    expect(hitArea(hits, 500, 500)).toBeNull();
    // off screen: no ring, no centre, still in order
    expect(screenAreas(areas, () => null).map((h) => [h.rings.length, h.centre])).toEqual([
      [0, null],
      [0, null],
    ]);
  });
});
```

Add to `packages/annotate/src/tools/mesh.test.ts`:

```ts
describe('placed areas', () => {
  it('prefer a placed area for the best anchor', () => {
    const issue = makeIssue({
      sightings: [
        photoSighting,
        { on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [9, 9, 9], n: [0, 1, 0] } },
        {
          on: 'pointcloud',
          layer: 'c',
          geom: {
            type: 'polygon3',
            points: [
              [0, 0, 0],
              [3, 0, 0],
              [3, 0, 3],
            ],
          },
          from: { sighting: 0 },
        },
      ],
    });
    expect(bestAnchor(issue)).toEqual([2, 0, 1]);
  });

  it('leave out the pins of issues whose area is drawn', () => {
    const a = makeIssue({ id: 'a' });
    const b = makeIssue({ id: 'b', code: 'F02' });
    expect(
      issuePins([a, b], [tankModel], null, 'all', new Set(['a'])).map((p) => p.issueId),
    ).toEqual(['b']);
  });
});
```

Run: `pnpm --filter @aio/annotate exec vitest run src/tools/areas.test.ts src/tools/mesh.test.ts`
Expected: FAIL (`./areas` missing; the anchor is the spoint; `issuePins` ignores the fifth argument).

- [ ] **Step 2: Create `packages/annotate/src/tools/areas.ts`**

```ts
import type { Issue, SeverityModel, Vec3 } from '@aio/schema';
import { isPlacedArea } from '../model/placed';
import { pinPasses, type PinFilter } from './declutter';
import { severityColor } from './mesh';

/**
 * Findings placed on a model, as the overlay draws them (spec section 5): a mesh outline is a
 * surface ring, a cloud prism a ring at its base with a height. Pure, apart from the colours.
 */
export interface IssueArea {
  issueId: string;
  code: string;
  title: string;
  color: string;
  layer: string;
  kind: 'surface' | 'prism';
  ring: Vec3[];
  height: number;
  centre: Vec3;
}

const centroid = (pts: readonly Vec3[]): Vec3 => {
  const s = pts.reduce<Vec3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  const n = pts.length || 1;
  return [s[0] / n, s[1] / n, s[2] / n];
};

/** The areas to draw: placed outlines and prisms on shown layers of issues the filter passes. */
export function issueAreas(
  issues: readonly Issue[],
  models: readonly SeverityModel[],
  selectedId: string | null,
  filter: PinFilter,
  hidden: Readonly<Record<string, true>>,
): IssueArea[] {
  const out: IssueArea[] = [];
  for (const i of issues) {
    if (i.id !== selectedId && !pinPasses(i.severity, filter)) continue;
    const color = severityColor(
      models.find((m) => m.id === i.severityModelId),
      i.severity,
    );
    for (const s of i.sightings) {
      if (!isPlacedArea(s) || hidden[s.layer]) continue;
      const base = { issueId: i.id, code: i.code, title: i.title, color, layer: s.layer };
      if (s.on === 'mesh' && s.geom.type === 'spolygon')
        out.push({
          ...base,
          kind: 'surface',
          ring: s.geom.points,
          height: 0,
          centre: centroid(s.geom.points),
        });
      else if (s.on === 'pointcloud' && s.geom.type === 'polygon3') {
        const height = s.geom.height ?? 0;
        const c = centroid(s.geom.points);
        out.push({
          ...base,
          kind: 'prism',
          ring: s.geom.points,
          height,
          centre: [c[0], c[1] + height / 2, c[2]],
        });
      }
    }
  }
  return out;
}

export interface AreaBuffers {
  /** Line segment end points, xyz. */
  lines: Float32Array;
  lineColors: Float32Array;
  /** Fill triangles, xyz. */
  fill: Float32Array;
  fillColors: Float32Array;
}

const lift = (p: Vec3, h: number): Vec3 => [p[0], p[1] + h, p[2]];

/** One draw for every area's lines and one for every fill; highlighted areas lighter. */
export function areaBuffers(
  areas: readonly IssueArea[],
  highlight: ReadonlySet<string>,
  rgb: (css: string) => [number, number, number],
): AreaBuffers {
  const lines: number[] = [];
  const lineColors: number[] = [];
  const fill: number[] = [];
  const fillColors: number[] = [];
  for (const a of areas) {
    const [r, g, b] = rgb(a.color);
    const k = highlight.has(a.issueId) ? 0.35 : 0;
    const lc = [r + (1 - r) * k, g + (1 - g) * k, b + (1 - b) * k];
    const fc = [r + (1 - r) * k * 0.5, g + (1 - g) * k * 0.5, b + (1 - b) * k * 0.5];
    const seg = (p: Vec3, q: Vec3) => {
      lines.push(...p, ...q);
      lineColors.push(...lc, ...lc);
    };
    const tri = (p: Vec3, q: Vec3, s: Vec3) => {
      fill.push(...p, ...q, ...s);
      fillColors.push(...fc, ...fc, ...fc);
    };
    const n = a.ring.length;
    const mid = centroid(a.ring);
    for (let i = 0; i < n; i++) {
      const p = a.ring[i];
      const q = a.ring[(i + 1) % n];
      if (!p || !q) continue;
      seg(p, q);
      tri(mid, p, q);
      if (a.kind === 'prism') {
        const pt = lift(p, a.height);
        const qt = lift(q, a.height);
        seg(pt, qt);
        seg(p, pt);
        tri(lift(mid, a.height), pt, qt);
        tri(p, q, qt);
        tri(p, qt, pt);
      }
    }
  }
  return {
    lines: Float32Array.from(lines),
    lineColors: Float32Array.from(lineColors),
    fill: Float32Array.from(fill),
    fillColors: Float32Array.from(fillColors),
  };
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** An area on the screen: its projected rings (base and top for a prism) and its centre. */
export interface AreaHit {
  issueId: string;
  rings: ScreenPoint[][];
  centre: ScreenPoint | null;
}

/** One entry per area, in order; rings with a point off screen are left out. */
export function screenAreas(
  areas: readonly IssueArea[],
  project: (p: Vec3) => ScreenPoint | null,
): AreaHit[] {
  return areas.map((a) => {
    const rings: ScreenPoint[][] = [];
    for (const h of a.kind === 'prism' ? [0, a.height] : [0]) {
      const pts = a.ring.map((p) => project(lift(p, h)));
      if (pts.length >= 3 && pts.every((p): p is ScreenPoint => p !== null)) rings.push(pts);
    }
    return { issueId: a.issueId, rings, centre: project(a.centre) };
  });
}

const inside = (ring: readonly ScreenPoint[], x: number, y: number) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
};

const area = (ring: readonly ScreenPoint[]) => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
};

/** The issue of the smallest area under a screen point, or null. */
export function hitArea(hits: readonly AreaHit[], x: number, y: number): string | null {
  let best: { id: string; size: number } | null = null;
  for (const h of hits)
    for (const r of h.rings) {
      if (!inside(r, x, y)) continue;
      const size = area(r);
      if (!best || size < best.size) best = { id: h.issueId, size };
    }
  return best?.id ?? null;
}
```

- [ ] **Step 3: Anchors and pins in `mesh.ts`**

Import `import { isPlacedArea } from '../model/placed';`. In `bestAnchor`, before the existing loop:

```ts
// a placed area stands for the issue first (its centre), then the pins as before
for (const s of issue.sightings) {
  if (!isPlacedArea(s)) continue;
  const a = sightingAnchor(s);
  if (a) return a;
}
```

Change `issuePins` to take the issues to skip:

```ts
const NONE: ReadonlySet<string> = new Set();

/** Pins of the issues with a 3D anchor that pass `filter`; the selected issue always shows. */
export function issuePins(
  issues: readonly Issue[],
  models: readonly SeverityModel[],
  selectedId: string | null,
  filter: PinFilter = 'all',
  /** Issues drawn as areas instead (findings on a model): no pin. */
  skip: ReadonlySet<string> = NONE,
): IssuePin[] {
  const out: IssuePin[] = [];
  for (const i of issues) {
    if (skip.has(i.id)) continue;
```

(the rest of the loop unchanged).

Run: `pnpm --filter @aio/annotate exec vitest run src/tools/areas.test.ts src/tools/mesh.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing overlay test**

Add to `describe('installIssueOverlay')` in `packages/annotate/src/tools/scene.test.ts` (import `type Issue, type Vec3` from `@aio/schema`, `type BufferGeometry` from `three`):

```ts
it('draws a placed area instead of its pin, hovers and picks its issue', () => {
  // a 4 x 4 m outline facing the camera, centred on the view (0, 2, 0)
  const ring: Vec3[] = [
    [-2, 0, 0],
    [2, 0, 0],
    [2, 4, 0],
    [-2, 4, 0],
  ];
  const placed: Issue = makeIssue({
    id: 'placed',
    title: 'Crack on the shell',
    sightings: [
      photoSighting,
      {
        on: 'mesh',
        layer: 'tank',
        geom: { type: 'spolygon', points: ring },
        from: { sighting: 0 },
      },
    ],
  });
  const store = createWorkspace();
  store.getState().openProject({ id: 'p', root: 'r', manifest }, [placed]);
  const uninstall = installIssueOverlay(store, createPinDisplay(null));
  const { handle, frames } = fakeHandle();
  setActiveScene(handle);
  frame(frames);
  expect(layoutOf(handle)?.items).toEqual([]);
  const areas = pinGroup(handle)?.getObjectByName('annotate-issue-areas');
  expect(areas?.visible).toBe(true);
  const lines = areas?.getObjectByName('annotate-area-lines') as
    { geometry: BufferGeometry } | undefined;
  expect(lines?.geometry.getAttribute('position').count).toBe(8);
  const at = (pinGroup(handle)?.userData.areas as { issueId: string; x: number; y: number }[])[0];
  expect(at?.issueId).toBe('placed');
  expect(at?.x).toBeCloseTo(400, 0);
  expect(at?.y).toBeCloseTo(300, 0);
  const el = handle.renderer.domElement as unknown as EventTarget & { title: string };
  const ev = (type: string) =>
    Object.assign(new Event(type), { button: 0, buttons: 0, clientX: 400, clientY: 300 });
  el.dispatchEvent(ev('pointermove'));
  expect(el.title).toBe('Crack on the shell');
  el.dispatchEvent(ev('pointerdown'));
  el.dispatchEvent(ev('pointerup'));
  expect(store.getState().selection).toEqual({ kind: 'issue', id: 'placed' });
  // its layer hidden: the area goes and the pin comes back
  store.getState().setLayerVisible('tank', false);
  frame(frames);
  expect(layoutOf(handle)?.items.map((i) => i.kind)).toEqual(['pin']);
  uninstall();
});
```

Run: `pnpm --filter @aio/annotate exec vitest run src/tools/scene.test.ts -t "placed area"`
Expected: FAIL (`annotate-issue-areas` is undefined).

- [ ] **Step 5: Draw the areas in `overlay.ts`**

Imports: add `DoubleSide`, `LineSegments`, `Mesh` to the `three` import; add

```ts
import {
  areaBuffers,
  hitArea,
  issueAreas,
  screenAreas,
  type AreaHit,
  type IssueArea,
} from './areas';
```

and `type PinLabel` is already imported from `./declutter`. Shaders, beside `HEAT_FRAG`:

```ts
// Placed areas (findings on a model): pulled towards the camera by a share of the distance so
// the outline stays in front of the surface it lies on, depth-tested against everything else.
const AREA_VERT = /* glsl */ `
attribute vec3 color;
uniform float uPull;
varying vec3 vColor;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(-mv.z, 0.001);
  mv.xyz -= normalize(mv.xyz) * min(uPull * d, d * 0.5);
  gl_Position = projectionMatrix * mv;
}`;

const AREA_FRAG = /* glsl */ `
uniform float uAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, uAlpha);
}`;
```

In `attach`, after `let closeList ...`:

```ts
// placed areas: one line draw and one fill draw for all of them
const areaGroup = new Group();
areaGroup.name = 'annotate-issue-areas';
areaGroup.visible = false;
group.add(areaGroup);
const areaMaterial = (alpha: number) =>
  new ShaderMaterial({
    vertexShader: AREA_VERT,
    fragmentShader: AREA_FRAG,
    uniforms: { uPull: { value: 0.003 }, uAlpha: { value: alpha } },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
  });
const lineMat = areaMaterial(0.95);
const fillMat = areaMaterial(0.16);
const areaLines = new LineSegments(new BufferGeometry(), lineMat);
areaLines.name = 'annotate-area-lines';
areaLines.frustumCulled = false;
areaLines.renderOrder = 998;
const areaFill = new Mesh(new BufferGeometry(), fillMat);
areaFill.name = 'annotate-area-fill';
areaFill.frustumCulled = false;
areaFill.renderOrder = 997;
areaGroup.add(areaFill, areaLines);
let areas: IssueArea[] = [];
let areaHits: AreaHit[] = [];
const writeAreas = () => {
  const s = store.getState();
  const lit = new Set<string>();
  if (s.selection?.kind === 'issue') lit.add(s.selection.id);
  if (hoverId) lit.add(hoverId);
  const b = areaBuffers(areas, lit, rgbOf);
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute('position', new BufferAttribute(b.lines, 3));
  lineGeo.setAttribute('color', new BufferAttribute(b.lineColors, 3));
  const fillGeo = new BufferGeometry();
  fillGeo.setAttribute('position', new BufferAttribute(b.fill, 3));
  fillGeo.setAttribute('color', new BufferAttribute(b.fillColors, 3));
  // a fresh geometry frees the old buffers on the GPU
  areaLines.geometry.dispose();
  areaFill.geometry.dispose();
  areaLines.geometry = lineGeo;
  areaFill.geometry = fillGeo;
  areaGroup.visible = areas.length > 0;
};
```

In `rebuild`, replace `pins = issuePins(shown, models, sel, d.filter);` with:

```ts
areas = issueAreas(shown, models, sel, d.filter, s.hidden);
pins = issuePins(shown, models, sel, d.filter, new Set(areas.map((a) => a.issueId)));
writeAreas();
```

In `layout`, after `const out = layoutPins({...});`:

```ts
areaHits = screenAreas(areas, project(w, h));
const areaLabels: PinLabel[] = [];
areas.forEach((a, k) => {
  const c = areaHits[k]?.centre;
  if (c && occlusion.clear(a.centre))
    areaLabels.push({ key: a.issueId, kind: 'code', text: a.code, x: c.x, y: c.y, color: a.color });
});
group.userData.areas = areaHits.map((hit) => ({
  issueId: hit.issueId,
  x: hit.centre?.x ?? null,
  y: hit.centre?.y ?? null,
}));
```

and change `labels.render(out.labels);` to `labels.render([...out.labels, ...areaLabels]);`.

In the store subscription, areas depend on hidden layers too:

```ts
if (
  issues ||
  s.hidden !== prev.hidden ||
  s.selection !== prev.selection ||
  s.project !== prev.project
)
  rebuild();
```

In `onUp`, at the top of the `if (!hit) {` block:

```ts
const areaId = hitArea(areaHits, at.x, at.y);
if (areaId) {
  store.getState().select({ kind: 'issue', id: areaId });
  return;
}
```

In `onMove`, replace the lines from `const labelled = ...` to the end of the `if (id !== hoverId)` block with:

```ts
const labelled = hit ? null : labels.hitCode(e.clientX, e.clientY);
const areaId = hit || labelled ? null : hitArea(areaHits, at.x, at.y);
const id = hit?.kind === 'pin' ? (hit.members[0]?.issueId ?? null) : (labelled ?? areaId);
const style = (el as Partial<HTMLElement>).style;
if (style) {
  const over = hit !== null || labelled !== null || areaId !== null;
  if (over && (style.cursor === '' || hoverCursor)) {
    style.cursor = 'pointer';
    hoverCursor = true;
  } else if (!over && hoverCursor) {
    style.cursor = '';
    hoverCursor = false;
  }
  (el as Partial<HTMLElement>).title =
    hit?.kind === 'cluster'
      ? `${hit.members.length} issues: click to expand`
      : areaId
        ? (areas.find((a) => a.issueId === areaId)?.title ?? '')
        : '';
}
if (id !== hoverId) {
  hoverId = id;
  writeAreas();
  dirty = true;
  handle.requestRender();
}
```

In `detach`, beside the other disposals:

```ts
areaLines.geometry.dispose();
areaFill.geometry.dispose();
lineMat.dispose();
fillMat.dispose();
```

- [ ] **Step 6: Run the tool tests**

Run: `pnpm --filter @aio/annotate exec vitest run src/tools`
Expected: PASS (the new test, and every existing overlay test: issues without placed areas draw exactly as before).

- [ ] **Step 7: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add packages/annotate/src/tools/areas.ts packages/annotate/src/tools/areas.test.ts packages/annotate/src/tools/mesh.ts packages/annotate/src/tools/mesh.test.ts packages/annotate/src/tools/overlay.ts packages/annotate/src/tools/scene.test.ts
git commit -m "feat(annotate): draw placed findings as outlines and prisms on the model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Annotate, the issue list's right-click "Place on model..."

**Files:**

- Create: `packages/annotate/src/components/IssueRowMenu.tsx`
- Modify: `packages/annotate/src/components/IssueRegister.tsx` (menu state; `onContextMenu` on rows; render the menu)
- Test: `packages/annotate/src/components/IssueRegister.test.tsx` (new `describe`)

**Interfaces:**

- Consumes: `useIssueListActions`, `setIssueListActions` (Task 7, from `../runtime`); `place.menu` (Task 2).
- Produces: a row's right-click calls `IssueListActions.placeOnModel(ids)`, where `ids` are the checked issues when the row is one of them, else that row's issue. The desktop sets the action (Task 11). Without an action, or in a read-only package, the browser menu is left alone (no `preventDefault`).

The founder's standing rule (right-click menus, 15 Oct) is that sidebar actions are on right-click; the menu is a small portal-free fixed `div` with `role="menu"`, Esc and a click elsewhere close it, the first item takes focus.

- [ ] **Step 1: Write the failing test**

Add to `packages/annotate/src/components/IssueRegister.test.tsx` (import `setIssueListActions` from `../runtime`, `vi` from `vitest`):

```ts
describe('IssueRegister right-click menu', () => {
  afterEach(() => {
    workspace.getState().closeProject();
  });

  const rightClick = (ui: ReturnType<typeof mount>, code: string) => {
    const row = [...ui.el.querySelectorAll('.ann-row')].find((r) => r.textContent?.includes(code));
    if (!row) throw new Error(`no row ${code}`);
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    });
    act(() => {
      row.dispatchEvent(ev);
    });
    return ev;
  };

  it('offers Place on model for the row, or for every checked row', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(5));
    const placeOnModel = vi.fn();
    const off = setIssueListActions({ placeOnModel });
    const ui = mount();
    expect(rightClick(ui, 'D0001').defaultPrevented).toBe(true);
    const item = () => document.querySelector('[data-testid="issue-place-on-model"]');
    expect(item()?.textContent).toBe('Place on model...');
    act(() => {
      item()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(placeOnModel).toHaveBeenLastCalledWith(['i1']);
    expect(item()).toBeNull();
    ui.click('[data-tick="D0002"]');
    ui.click('[data-tick="D0003"]');
    rightClick(ui, 'D0003');
    expect(item()?.textContent).toBe('Place 2 on model...');
    act(() => {
      item()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect([...(placeOnModel.mock.lastCall?.[0] ?? [])].sort()).toEqual(['i2', 'i3']);
    // Esc closes it
    rightClick(ui, 'D0004');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(item()).toBeNull();
    off();
    ui.unmount();
  });

  it('leaves the browser menu alone without the action', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(2));
    const ui = mount();
    expect(rightClick(ui, 'D0001').defaultPrevented).toBe(false);
    expect(document.querySelector('[data-testid="issue-row-menu"]')).toBeNull();
    ui.unmount();
  });
});
```

(If the existing tick handler needs Shift or plain clicks for checking, follow the pattern of the "sets the status of the checked issues" test; the assertion is that the checked set is sent.)

Run: `pnpm --filter @aio/annotate exec vitest run src/components/IssueRegister.test.tsx -t "right-click"`
Expected: FAIL (`defaultPrevented` is false; no menu).

- [ ] **Step 2: Create `packages/annotate/src/components/IssueRowMenu.tsx`**

```tsx
import { useT } from '@aio/ui';
import { useEffect, useRef } from 'react';

export interface IssueRowMenuProps {
  /** Client pixels of the right-click. */
  x: number;
  y: number;
  /** How many issues the menu acts on. */
  count: number;
  onPlace: () => void;
  onClose: () => void;
}

const MENU_W = 220;
const MENU_H = 44;

/** The issue list's right-click menu: actions the app set with `setIssueListActions`. */
export function IssueRowMenu({ x, y, count, onPlace, onClose }: IssueRowMenuProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || !ref.current?.contains(target)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_H - 8));
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="issue-row-menu"
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 70,
        minWidth: 180,
        padding: 4,
        background: 'var(--bg-1, #12161c)',
        border: '1px solid var(--line-strong, #39424e)',
        borderRadius: 6,
        boxShadow: '0 12px 32px rgba(0,0,0,.45)',
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="ann-btn ghost"
        data-testid="issue-place-on-model"
        style={{ width: '100%', justifyContent: 'flex-start' }}
        onClick={() => {
          onPlace();
          onClose();
        }}
      >
        {t('place.menu', { count })}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `IssueRegister.tsx`**

Add `useCallback` to the React import, `useIssueListActions` to the `../runtime` import and `import { IssueRowMenu } from './IssueRowMenu';`. In the component, after the `checked` state:

```tsx
const listActions = useIssueListActions();
const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
const closeMenu = useCallback(() => {
  setMenu(null);
}, []);
```

On the row `div` in `renderRow`, after `onClick`:

```tsx
        onContextMenu={(e) => {
          if (readOnly || !listActions.placeOnModel) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, ids: live.has(i.id) ? [...live] : [i.id] });
        }}
```

At the end of the panel, just before the closing `</div>` of `ann-panel`:

```tsx
{
  menu && listActions.placeOnModel && (
    <IssueRowMenu
      x={menu.x}
      y={menu.y}
      count={menu.ids.length}
      onPlace={() => {
        listActions.placeOnModel?.(menu.ids);
      }}
      onClose={closeMenu}
    />
  );
}
```

- [ ] **Step 4: Run the component tests**

Run: `pnpm --filter @aio/annotate exec vitest run src/components`
Expected: PASS (new tests, and the existing register and `renderToString` tests).

- [ ] **Step 5: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add packages/annotate/src/components/IssueRowMenu.tsx packages/annotate/src/components/IssueRegister.tsx packages/annotate/src/components/IssueRegister.test.tsx
git commit -m "feat(annotate): Place on model on the issue list's right-click menu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Desktop, the placement store, controller and the accept and change hooks

**Files:**

- Create: `apps/desktop/src/renderer/placement/layers.ts`, test `placement/layers.test.ts`
- Create: `apps/desktop/src/renderer/placement/store.ts`, test `placement/store.test.ts`
- Create: `apps/desktop/src/renderer/placement/controller.ts`, test `placement/controller.test.ts`
- Create: `apps/desktop/src/renderer/placement/index.ts`
- Modify: `apps/desktop/src/renderer/bootstrap.ts` (call `startPlacement()`; `placement` in the `__stratlas` probe)
- Modify: `apps/desktop/src/renderer/detections/store.ts` (remember photo sizes on load; offer after accepting; `acceptByIds`)
- Modify: `apps/desktop/src/renderer/change/actions.ts` (offer after Make issue)

**Interfaces:**

- Consumes: `placeOnLayer`, `withPlacedArea`, `selectionName`, `selectionSighting`, `cameraSources`, `imageSizeOf`, `rememberImageSize`, `setIssueListActions`, `issueEditor.commitIssues`, `type PlaceScene`, `type PlaceResult`, `type PlaceFailure` (Tasks 7, 8); `refineAround`, `pointsInPrism` (Task 4); `suggestMatches`, `issueDate`, `trackPair` (Task 5, existing); `encodeSelection`, IPC `project:writeSelection` (Task 1); `SceneHandle.rayLayers` (Task 3).
- Produces:

```ts
// placement/layers.ts
export interface LayerChoice {
  id: string;
  name: string;
  kind: 'mesh' | 'pointcloud';
  sameDate: boolean;
}
export function layerChoices(
  manifest: Pick<ProjectManifest, 'layers'>,
  dates: { of: Readonly<Record<string, string>> } | null,
  issues: readonly Issue[],
): LayerChoice[];
export function hasPhotoShape(issue: Pick<Issue, 'sightings'>): boolean;
// placement/store.ts
export type OfferSource = 'detections' | 'change' | 'menu';
export interface PlaceOutcome {
  id: string;
  code: string;
  ok: boolean;
  reason?: PlaceFailure;
  sightings?: Sighting[];
}
export interface PlaceSummary {
  layerId: string;
  layerName: string;
  total: number;
  placed: number;
  missed: number;
  noPhoto: number;
  notLoaded: number;
  label: string;
  outcomes: PlaceOutcome[];
}
export interface MatchOffer {
  issueId: string;
  code: string;
  otherId: string;
  otherCode: string;
  date: string;
}
export interface PlacementState {
  offer: { ids: string[]; source: OfferSource } | null;
  layerId: string | null;
  noLayers: boolean;
  busy: boolean;
  result: PlaceSummary | null;
  matches: MatchOffer[];
  error: string | null;
  offerIds(ids: readonly string[], source: OfferSource): void;
  setLayer(id: string): void;
  place(): Promise<PlaceSummary | null>;
  placeIds(ids: readonly string[], layerId: string): Promise<PlaceSummary | null>;
  notNow(): void;
  undo(): void;
  same(): void;
  different(): void;
  skipAll(): void;
  dismiss(): void;
}
export interface PlacementDeps {
  workspace: StoreApi<Workspace>;
  editor: Pick<IssueEditor, 'commitIssues' | 'undo' | 'state'>;
  place(issue: Issue, layer: Layer): Promise<PlaceResult>;
  writeSelection(projectId: string, name: string, data: Uint8Array): Promise<string | null>;
  ready(layerId: string): Promise<boolean>;
  now(): string;
  newId(): string;
}
export function createPlacementStore(deps: PlacementDeps): StoreApi<PlacementState>;
export function shortDate(date: string): string; // '2026-03-03' -> '3 Mar'
// placement/controller.ts
export function placeScene(h: SceneHandle): PlaceScene;
export type ProbeSize = (url: string) => Promise<Vec2 | null>;
export const probeImageSize: ProbeSize;
export function ensureSizes(
  ws: StoreApi<Workspace>,
  issue: Issue,
  probe?: ProbeSize,
): Promise<void>;
export function layerReady(
  ws: StoreApi<Workspace>,
  layerId: string,
  scene?: () => SceneHandle | null,
  timeoutMs?: number,
  stepMs?: number,
): Promise<boolean>;
// placement/index.ts
export const placement: StoreApi<PlacementState>;
export function offerPlacement(ids: readonly string[], source: OfferSource): void;
export function usePlacement<T>(select: (s: PlacementState) => T): T;
export function startPlacement(): () => void;
// detections/store.ts
export function acceptByIds(
  ids: readonly string[],
):
  | { accepted: { id: string; issueId: string }[]; skipped: { id: string; problem: string }[] }
  | { error: string };
```

`controller.ts` holds no bridge (it would pull `window.aio` into its test); `index.ts` builds the live dependencies with the bridge. The placing is sequential (one refine at a time), and the whole batch is one editor step, so the bar's Undo takes it back in one go. The bar's Undo calls `editor.undo()` only while the editor's `undoLabel` is still this placement's label (Review Focus 5).

- [ ] **Step 1: Write the failing layer-choice test**

Create `apps/desktop/src/renderer/placement/layers.test.ts`:

```ts
import type { Issue, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { hasPhotoShape, layerChoices } from './layers';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
  layers: [
    {
      kind: 'mesh',
      id: 'model-d1',
      name: 'Model 1 Mar',
      visible: false,
      capture: 'd1',
      src: { path: 'a.glb' },
      transform: I,
    },
    {
      kind: 'mesh',
      id: 'model-d2',
      name: 'Model 3 Sep',
      visible: true,
      capture: 'd2',
      src: { path: 'b.glb' },
      transform: I,
    },
    {
      kind: 'pointcloud',
      id: 'cloud-d2',
      name: 'Cloud 3 Sep',
      visible: false,
      capture: 'd2',
      src: { path: 'c.json' },
      format: 'png-packed',
    },
    { kind: 'photos', id: 'photos-d2', name: 'Photos', visible: true, capture: 'd2', items: [] },
  ],
} as unknown as Pick<ProjectManifest, 'layers'>;
const dates = { of: { 'model-d1': 'd1', 'model-d2': 'd2', 'cloud-d2': 'd2', 'photos-d2': 'd2' } };
const onPhoto = {
  sightings: [
    { on: 'image', layer: 'photos-d2', photo: 'P', geom: { type: 'box', x: 0, y: 0, w: 1, h: 1 } },
  ],
} as unknown as Issue;

describe('layer choices', () => {
  it('lists meshes and clouds, the photos date first', () => {
    expect(layerChoices(manifest, dates, [onPhoto]).map((c) => [c.id, c.kind, c.sameDate])).toEqual(
      [
        ['model-d2', 'mesh', true],
        ['cloud-d2', 'pointcloud', true],
        ['model-d1', 'mesh', false],
      ],
    );
    expect(layerChoices(manifest, null, [onPhoto]).map((c) => c.id)).toEqual([
      'model-d1',
      'model-d2',
      'cloud-d2',
    ]);
  });

  it('knows which issues have a photo or frame shape to place', () => {
    expect(hasPhotoShape(onPhoto)).toBe(true);
    const point = {
      sightings: [{ on: 'image', layer: 'p', photo: 'P', geom: { type: 'point', x: 0, y: 0 } }],
    } as unknown as Issue;
    expect(hasPhotoShape(point)).toBe(false);
    const pin = {
      sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
    } as unknown as Issue;
    expect(hasPhotoShape(pin)).toBe(false);
  });
});
```

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/layers.test.ts`
Expected: FAIL, `Cannot find module './layers'`.

- [ ] **Step 2: Create `placement/layers.ts`**

```ts
import type { Issue, ProjectManifest } from '@aio/schema';

/** A layer a finding can be placed on, for the picker. */
export interface LayerChoice {
  id: string;
  name: string;
  kind: 'mesh' | 'pointcloud';
  /** Of a survey date the findings' photos or frames belong to. */
  sameDate: boolean;
}

/** The project's mesh and point-cloud layers, those of the photos' dates first (spec section 6). */
export function layerChoices(
  manifest: Pick<ProjectManifest, 'layers'>,
  dates: { of: Readonly<Record<string, string>> } | null,
  issues: readonly Issue[],
): LayerChoice[] {
  const photoDates = new Set<string>();
  for (const i of issues)
    for (const s of i.sightings) {
      if (s.on !== 'image' && s.on !== 'video') continue;
      const d = dates?.of[s.layer];
      if (d) photoDates.add(d);
    }
  const all: LayerChoice[] = [];
  for (const l of manifest.layers) {
    if (l.kind !== 'mesh' && l.kind !== 'pointcloud') continue;
    const d = dates?.of[l.id];
    all.push({
      id: l.id,
      name: l.name,
      kind: l.kind,
      sameDate: d !== undefined && photoDates.has(d),
    });
  }
  return [...all.filter((c) => c.sameDate), ...all.filter((c) => !c.sameDate)];
}

/** An image sighting with a box, rotated box or polygon, or a video sighting (always shaped). */
export function hasPhotoShape(issue: Pick<Issue, 'sightings'>): boolean {
  return issue.sightings.some((s) =>
    s.on === 'image'
      ? s.geom.type === 'box' || s.geom.type === 'rotbox' || s.geom.type === 'polygon'
      : s.on === 'video' && s.track.length > 0,
  );
}
```

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/layers.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing store test**

Create `apps/desktop/src/renderer/placement/store.test.ts`:

```ts
import type { EditorState, PlaceResult } from '@aio/annotate';
import {
  decodeSelection,
  err,
  ok,
  type Issue,
  type ProjectManifest,
  type Sighting,
  type Vec3,
} from '@aio/schema';
import { captureIndex, createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { createPlacementStore, shortDate, type PlacementDeps } from './store';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'd1', label: 'First', date: '2026-03-03' },
    { id: 'd2', label: 'Second', date: '2026-09-01' },
  ],
  layers: [
    {
      kind: 'mesh',
      id: 'model-d1',
      name: 'Model 3 Mar',
      visible: false,
      capture: 'd1',
      src: { path: 'a.glb' },
      transform: I,
    },
    {
      kind: 'mesh',
      id: 'model-d2',
      name: 'Model 1 Sep',
      visible: true,
      capture: 'd2',
      src: { path: 'b.glb' },
      transform: I,
    },
    {
      kind: 'pointcloud',
      id: 'cloud-d2',
      name: 'Cloud 1 Sep',
      visible: false,
      capture: 'd2',
      src: { path: 'c.json' },
      format: 'png-packed',
    },
    { kind: 'photos', id: 'photos-d1', name: 'Photos 1', visible: true, capture: 'd1', items: [] },
    { kind: 'photos', id: 'photos-d2', name: 'Photos 2', visible: true, capture: 'd2', items: [] },
  ],
  severityModels: [
    { id: 'sev', name: 'Sev', levels: [{ value: 1, label: 'L', color: '#888888', criteria: '' }] },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'C',
      assetType: 'site',
      classes: [{ id: 'marker', label: 'Marker', color: '#aa00aa', severityModel: 'sev' }],
    },
  ],
};
const square = (x: number): Vec3[] => [
  [x, 0, 0],
  [x + 1, 0, 0],
  [x + 1, 0, 1],
  [x, 0, 1],
];
const photo = (layer: string): Sighting => ({
  on: 'image',
  layer,
  photo: 'P1',
  geom: { type: 'box', x: 1, y: 1, w: 20, h: 20 },
});
const autoPin: Sighting = {
  on: 'mesh',
  layer: 'model-d2',
  geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] },
  from: { sighting: 0 },
};
const issue = (id: string, code: string, sightings: Sighting[]): Issue => ({
  id,
  code,
  classId: 'marker',
  severityModelId: 'sev',
  severity: 1,
  status: 'draft',
  title: code,
  note: '',
  author: 'Demo',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  sightings,
  source: 'agent',
});
const A = issue('a', 'F01', [photo('photos-d2'), autoPin]);
const B = issue('b', 'F02', [photo('photos-d2')]);
const PIN = issue('c', 'F03', [autoPin]);
const OLD = issue('e', 'F04', [
  photo('photos-d1'),
  {
    on: 'mesh',
    layer: 'model-d1',
    geom: { type: 'spolygon', points: square(0.1) },
    from: { sighting: 0 },
  },
]);

function setup(over: Partial<PlacementDeps> = {}, results: Record<string, PlaceResult> = {}) {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p', root: 'r', manifest }, [A, B, PIN, OLD]);
  ws.getState().setDates(captureIndex(manifest));
  const state: EditorState = {
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    save: { state: 'saved' },
    lastError: null,
  };
  const editor = {
    state,
    commitIssues: vi.fn((list: readonly Issue[], label: string) => {
      for (const i of list) ws.getState().upsertIssue(i);
      editor.state = { ...editor.state, canUndo: true, undoLabel: label };
      return ok(null);
    }),
    undo: vi.fn(() => true),
  };
  const placed: PlaceResult = {
    ok: true,
    sightings: [
      {
        on: 'mesh',
        layer: 'model-d2',
        geom: { type: 'spolygon', points: square(0) },
        from: { sighting: 0 },
      },
    ],
    from: 0,
    hitRate: 1,
  };
  const deps: PlacementDeps = {
    workspace: ws,
    editor,
    place: vi.fn((i: Issue) =>
      Promise.resolve<PlaceResult>(
        results[i.id] ?? (i.id === 'a' ? placed : { ok: false, reason: 'missed' }),
      ),
    ),
    writeSelection: vi.fn(() => Promise.resolve('selections/x.sel')),
    ready: vi.fn(() => Promise.resolve(true)),
    now: () => '2026-10-15T12:00:00.000Z',
    newId: () => 'track-1',
    ...over,
  };
  return { ws, editor, deps, store: createPlacementStore(deps) };
}

describe('the placement offer', () => {
  it('offers the issues with a photo shape, on a layer of their date first, and merges offers', () => {
    const { store } = setup();
    store.getState().offerIds(['a', 'c'], 'detections');
    expect(store.getState().offer).toEqual({ ids: ['a'], source: 'detections' });
    expect(store.getState().layerId).toBe('model-d2');
    store.getState().offerIds(['b'], 'detections');
    expect(store.getState().offer?.ids).toEqual(['a', 'b']);
    store.getState().notNow();
    expect(store.getState().offer).toBeNull();
    store.getState().offerIds(['c'], 'menu');
    expect(store.getState().offer).toBeNull();
  });
});

describe('placing', () => {
  it('places in one editor step, replaces the automatic pin and counts the misses', async () => {
    const { store, ws, editor } = setup();
    store.getState().offerIds(['a', 'b'], 'detections');
    const r = await store.getState().place();
    expect(r).toMatchObject({
      placed: 1,
      missed: 1,
      total: 2,
      layerName: 'Model 1 Sep',
      label: 'Place 1 issue on Model 1 Sep',
    });
    expect(editor.commitIssues).toHaveBeenCalledTimes(1);
    const a = ws.getState().issues.find((i) => i.id === 'a');
    expect(a?.sightings.map((s) => (s.on === 'mesh' ? s.geom.type : s.on))).toEqual([
      'image',
      'spolygon',
    ]);
    expect(store.getState().offer).toBeNull();
    expect(store.getState().result?.placed).toBe(1);
  });

  it('writes the selection file of a cloud finding and adds its sighting', async () => {
    const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const cloudResult: PlaceResult = {
      ok: true,
      sightings: [
        {
          on: 'pointcloud',
          layer: 'cloud-d2',
          geom: { type: 'polygon3', points: square(0), height: 0.2 },
          from: { sighting: 0 },
        },
      ],
      from: 0,
      hitRate: 1,
      selection: { positions, count: 2, lod: 3 },
    };
    const { store, ws, deps } = setup({}, { a: cloudResult });
    await store.getState().placeIds(['a'], 'cloud-d2');
    const [projectId, name, bytes] = vi.mocked(deps.writeSelection).mock.calls[0] ?? [];
    expect([projectId, name]).toEqual(['p', 'a-cloud-d2']);
    expect(decodeSelection(bytes ?? new Uint8Array())?.lod).toBe(3);
    const a = ws.getState().issues.find((i) => i.id === 'a');
    expect(a?.sightings.at(-1)).toEqual({
      on: 'pointcloud',
      layer: 'cloud-d2',
      geom: { type: 'selection', src: { path: 'selections/x.sel' }, count: 2, lod: 3 },
      from: { sighting: 0 },
    });
  });

  it('places an issue whose photo size was unknown: the deps learn it before projecting', async () => {
    const order: string[] = [];
    const { store } = setup({
      place: vi.fn((i: Issue) => {
        order.push(`place ${i.id}`);
        return Promise.resolve({ ok: false as const, reason: 'no-photo-shape' as const });
      }),
    });
    const r = await store.getState().placeIds(['b'], 'model-d2');
    expect(order).toEqual(['place b']);
    expect(r?.noPhoto).toBe(1);
  });

  it('reports every issue as not loaded when the layer never becomes ready', async () => {
    const { store, deps, editor } = setup({ ready: vi.fn(() => Promise.resolve(false)) });
    const r = await store.getState().placeIds(['a', 'b'], 'model-d1');
    expect(r).toMatchObject({ placed: 0, notLoaded: 2 });
    expect(deps.place).not.toHaveBeenCalled();
    expect(editor.commitIssues).not.toHaveBeenCalled();
  });

  it('shows the editor refusal and writes nothing', async () => {
    const { store, editor } = setup();
    editor.commitIssues.mockImplementation(() =>
      err<null>('This project is a read-only package. Issues cannot be changed.'),
    );
    expect(await store.getState().placeIds(['a'], 'model-d2')).toBeNull();
    expect(store.getState().error).toContain('read-only package');
    expect(store.getState().busy).toBe(false);
  });

  it('undo only undoes its own step', async () => {
    const { store, editor } = setup();
    await store.getState().placeIds(['a'], 'model-d2');
    store.getState().undo();
    expect(editor.undo).toHaveBeenCalledTimes(1);
    await store.getState().placeIds(['a'], 'model-d2');
    editor.state = { ...editor.state, undoLabel: 'Edit F09' };
    store.getState().undo();
    expect(editor.undo).toHaveBeenCalledTimes(1);
    expect(store.getState().result).toBeNull();
  });
});

describe('match suggestions', () => {
  it('suggests the earlier finding with an overlapping footprint, and Same gives both one track', async () => {
    const { store, ws, editor } = setup();
    await store.getState().placeIds(['a'], 'model-d2');
    expect(store.getState().matches).toEqual([
      { issueId: 'a', code: 'F01', otherId: 'e', otherCode: 'F04', date: '3 Mar' },
    ]);
    store.getState().same();
    expect(editor.commitIssues).toHaveBeenLastCalledWith(expect.any(Array), 'Match F04 and F01');
    const tracks = ws
      .getState()
      .issues.filter((i) => i.id === 'a' || i.id === 'e')
      .map((i) => i.track);
    expect(tracks).toEqual(['track-1', 'track-1']);
    expect(store.getState().matches).toEqual([]);
  });

  it('Different and Skip all drop suggestions without changing issues', async () => {
    const { store, editor } = setup();
    await store.getState().placeIds(['a'], 'model-d2');
    store.getState().different();
    expect(store.getState().matches).toEqual([]);
    await store.getState().placeIds(['a'], 'model-d2');
    store.getState().skipAll();
    expect(store.getState().matches).toEqual([]);
    expect(editor.commitIssues).toHaveBeenCalledTimes(2);
  });

  it('writes capture dates short', () => {
    expect(shortDate('2026-03-03')).toBe('3 Mar');
    expect(shortDate('not a date')).toBe('not a date');
  });
});
```

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/store.test.ts`
Expected: FAIL, `Cannot find module './store'`.

- [ ] **Step 4: Create `placement/store.ts`**

```ts
/**
 * Findings on a model, the app side (spec section 6): the offer to connect findings to a mesh or
 * point cloud, placing them (one editor step), the result with Undo, and match suggestions with
 * Same, Different and Skip all. The projection and the rules of a placed area live in
 * @aio/annotate; the matching rule in @aio/change. Dependencies are injected (index.ts wires the
 * live ones) so the store is tested without a scene or the bridge.
 */
import {
  selectionName,
  selectionSighting,
  withPlacedArea,
  type IssueEditor,
  type PlaceFailure,
  type PlaceResult,
} from '@aio/annotate';
import { issueDate, suggestMatches, trackPair } from '@aio/change';
import { encodeSelection, type Issue, type Layer, type Sighting } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { hasPhotoShape, layerChoices } from './layers';

export type OfferSource = 'detections' | 'change' | 'menu';

export interface PlaceOutcome {
  id: string;
  code: string;
  ok: boolean;
  reason?: PlaceFailure;
  sightings?: Sighting[];
}

export interface PlaceSummary {
  layerId: string;
  layerName: string;
  total: number;
  placed: number;
  missed: number;
  noPhoto: number;
  notLoaded: number;
  /** The editor step's label: Undo acts only while it is the last step. */
  label: string;
  outcomes: PlaceOutcome[];
}

export interface MatchOffer {
  issueId: string;
  code: string;
  otherId: string;
  otherCode: string;
  /** The other issue's survey date, short ("3 Mar"). */
  date: string;
}

export interface PlacementState {
  offer: { ids: string[]; source: OfferSource } | null;
  layerId: string | null;
  /** The project has no mesh or point cloud. */
  noLayers: boolean;
  busy: boolean;
  result: PlaceSummary | null;
  matches: MatchOffer[];
  error: string | null;
  offerIds(ids: readonly string[], source: OfferSource): void;
  setLayer(id: string): void;
  place(): Promise<PlaceSummary | null>;
  placeIds(ids: readonly string[], layerId: string): Promise<PlaceSummary | null>;
  notNow(): void;
  undo(): void;
  same(): void;
  different(): void;
  skipAll(): void;
  dismiss(): void;
}

export interface PlacementDeps {
  workspace: StoreApi<Workspace>;
  editor: Pick<IssueEditor, 'commitIssues' | 'undo' | 'state'>;
  place(issue: Issue, layer: Layer): Promise<PlaceResult>;
  /** Write a selection file; its project path, or null when it was not written. */
  writeSelection(projectId: string, name: string, data: Uint8Array): Promise<string | null>;
  /** Show the layer when hidden and wait until the 3D view can cast rays at it. */
  ready(layerId: string): Promise<boolean>;
  now(): string;
  newId(): string;
}

const plural = (n: number) => `${String(n)} issue${n === 1 ? '' : 's'}`;

/** "3 Mar" for a capture date (YYYY-MM-DD); the text itself when it is not a date. */
export function shortDate(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function createPlacementStore(deps: PlacementDeps): StoreApi<PlacementState> {
  const issueById = (id: string) => deps.workspace.getState().issues.find((i) => i.id === id);

  return createStore<PlacementState>()((set, get) => {
    const matchesFor = (placed: readonly Issue[]): MatchOffer[] => {
      const ws = deps.workspace.getState();
      const dates = ws.dates;
      if (!dates) return [];
      const out: MatchOffer[] = [];
      const seen = new Set<string>();
      for (const p of placed) {
        const current = issueById(p.id) ?? p;
        const best = suggestMatches(current, ws.issues, dates)[0];
        if (!best) continue;
        const key = [current.id, best.issue.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const capture = dates.captures.find((c) => c.id === best.capture);
        out.push({
          issueId: current.id,
          code: current.code,
          otherId: best.issue.id,
          otherCode: best.issue.code,
          date: capture ? shortDate(capture.date) : best.capture,
        });
      }
      return out;
    };

    const placeIds = async (
      ids: readonly string[],
      layerId: string,
    ): Promise<PlaceSummary | null> => {
      const project = deps.workspace.getState().project;
      const layer = project?.manifest.layers.find((l) => l.id === layerId);
      if (!project || !layer) return null;
      set({ busy: true, error: null });
      try {
        const ready = await deps.ready(layerId);
        const outcomes: PlaceOutcome[] = [];
        const next: Issue[] = [];
        for (const id of ids) {
          const issue = issueById(id);
          if (!issue) continue;
          if (!ready) {
            outcomes.push({ id, code: issue.code, ok: false, reason: 'layer-not-loaded' });
            continue;
          }
          const r = await deps.place(issue, layer);
          if (!r.ok) {
            outcomes.push({ id, code: issue.code, ok: false, reason: r.reason });
            continue;
          }
          let sightings = r.sightings;
          if (r.selection) {
            const path = await deps.writeSelection(
              project.id,
              selectionName(issue.id, layer.id),
              encodeSelection(r.selection.positions, r.selection.lod),
            );
            if (path)
              sightings = [
                ...sightings,
                selectionSighting(layer.id, { path }, r.selection, r.from),
              ];
          }
          next.push(withPlacedArea(issue, layer.id, sightings, deps.now()));
          outcomes.push({ id, code: issue.code, ok: true, sightings });
        }
        const label = `Place ${plural(next.length)} on ${layer.name}`;
        if (next.length > 0) {
          const c = deps.editor.commitIssues(next, label);
          if (!c.ok) {
            set({ busy: false, error: c.error });
            return null;
          }
        }
        const count = (reason: PlaceFailure) => outcomes.filter((o) => o.reason === reason).length;
        const summary: PlaceSummary = {
          layerId,
          layerName: layer.name,
          total: outcomes.length,
          placed: next.length,
          missed: count('missed'),
          noPhoto: count('no-photo-shape'),
          notLoaded: count('layer-not-loaded'),
          label,
          outcomes,
        };
        set({ busy: false, result: summary, matches: matchesFor(next) });
        return summary;
      } catch (e) {
        set({ busy: false, error: e instanceof Error ? e.message : String(e) });
        return null;
      }
    };

    const dropMatch = (ids: readonly string[]) =>
      get()
        .matches.slice(1)
        .filter((m) => !ids.includes(m.issueId) && !ids.includes(m.otherId));

    return {
      offer: null,
      layerId: null,
      noLayers: false,
      busy: false,
      result: null,
      matches: [],
      error: null,
      offerIds(ids, source) {
        const ws = deps.workspace.getState();
        const project = ws.project;
        if (!project) return;
        const merged = [...new Set([...(get().offer?.ids ?? []), ...ids])];
        const issues = merged
          .map(issueById)
          .filter((i): i is Issue => i !== undefined && hasPhotoShape(i));
        if (issues.length === 0) return;
        const choices = layerChoices(project.manifest, ws.dates, issues);
        const keep = get().layerId;
        const layerId =
          keep && choices.some((c) => c.id === keep) ? keep : (choices[0]?.id ?? null);
        set({
          offer: { ids: issues.map((i) => i.id), source },
          layerId,
          noLayers: choices.length === 0,
        });
      },
      setLayer(id) {
        set({ layerId: id });
      },
      async place() {
        const { offer, layerId } = get();
        if (!offer || !layerId) return null;
        set({ offer: null });
        const r = await placeIds(offer.ids, layerId);
        if (!r && get().error) set({ offer });
        return r;
      },
      placeIds,
      notNow() {
        set({ offer: null });
      },
      undo() {
        const r = get().result;
        if (r && r.placed > 0 && deps.editor.state.undoLabel === r.label) deps.editor.undo();
        set({ result: null, matches: [] });
      },
      same() {
        const m = get().matches[0];
        const dates = deps.workspace.getState().dates;
        const a = m ? issueById(m.issueId) : undefined;
        const b = m ? issueById(m.otherId) : undefined;
        if (!m || !a || !b || !dates) {
          set({ matches: get().matches.slice(1) });
          return;
        }
        const at = (i: Issue) => dates.captures.findIndex((c) => c.id === issueDate(i, dates));
        const [earlier, later] = at(a) <= at(b) ? [a, b] : [b, a];
        const r = trackPair(
          earlier,
          later,
          { from: issueDate(earlier, dates) ?? '', to: issueDate(later, dates) ?? '' },
          deps.now(),
          deps.newId,
        );
        const changed = [r.earlier, r.later].filter(
          (x): x is Issue => x !== undefined && x !== issueById(x.id),
        );
        const c = deps.editor.commitIssues(changed, `Match ${earlier.code} and ${later.code}`);
        set({ matches: dropMatch([a.id, b.id]), ...(c.ok ? {} : { error: c.error }) });
      },
      different() {
        set({ matches: get().matches.slice(1) });
      },
      skipAll() {
        set({ matches: [] });
      },
      dismiss() {
        set({ result: null, matches: [], error: null });
      },
    };
  });
}
```

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/store.test.ts`
Expected: PASS. (In "places an issue whose photo size was unknown", the size probing is the live `place` dependency's first step, `ensureSizes`; Step 5 tests it. This store test pins that the store hands an issue with an unknown size to `place` and counts its `no-photo-shape` answer.)

- [ ] **Step 5: Write the failing controller test**

Create `apps/desktop/src/renderer/placement/controller.test.ts`:

```ts
import { imageSizeOf } from '@aio/annotate';
import type { SceneHandle } from '@aio/engine';
import type { Issue, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { ensureSizes, layerReady } from './controller';

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: [{ id: 'P9', src: { path: 'photos/P9.jpg' } }],
    },
    {
      kind: 'pointcloud',
      id: 'cloud',
      name: 'Cloud',
      visible: false,
      src: { path: 'c.json' },
      format: 'png-packed',
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;
const onP9 = {
  sightings: [
    { on: 'image', layer: 'photos', photo: 'P9', geom: { type: 'box', x: 0, y: 0, w: 5, h: 5 } },
  ],
} as unknown as Issue;

describe('ensureSizes', () => {
  it('learns the size of a photo no viewer has shown, once', async () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: 'r', manifest }, []);
    const probe = vi.fn(() => Promise.resolve([4000, 3000] as [number, number]));
    expect(imageSizeOf('photos', 'P9')).toBeNull();
    await ensureSizes(ws, onP9, probe);
    expect(imageSizeOf('photos', 'P9')).toEqual([4000, 3000]);
    expect(probe).toHaveBeenCalledWith('aio://project/p/photos/P9.jpg');
    await ensureSizes(ws, onP9, probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('layerReady', () => {
  it('shows a hidden layer and waits until the 3D view can cast at it', async () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: 'r', manifest }, []);
    expect(ws.getState().hidden.cloud).toBe(true);
    let loaded = false;
    const scene = () =>
      ({ rayLayers: () => new Set(loaded ? ['cloud'] : []) }) as unknown as SceneHandle;
    setTimeout(() => {
      loaded = true;
    }, 20);
    expect(await layerReady(ws, 'cloud', scene, 1000, 5)).toBe(true);
    expect(ws.getState().hidden.cloud).toBeUndefined();
  });

  it('gives up when the layer never loads or there is no 3D view', async () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: 'r', manifest }, []);
    expect(await layerReady(ws, 'cloud', () => null, 30, 5)).toBe(false);
  });
});
```

(The `aio://project/<id>/<path>` form is what `assetUrl` from `@aio/workspace` returns for a path asset; if it differs, assert `assetUrl('p', { path: 'photos/P9.jpg' })` instead.)

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/controller.test.ts`
Expected: FAIL, `Cannot find module './controller'`.

- [ ] **Step 6: Create `placement/controller.ts` and `placement/index.ts`**

`apps/desktop/src/renderer/placement/controller.ts`:

```ts
/**
 * The live side of placing findings: the 3D view as the projector's scene (with the point
 * cloud's refine and prism queries), the pixel size of photos no viewer has opened yet, and
 * waiting for a layer to be ready for rays. No bridge here, so it is testable in node.
 */
import { imageSizeOf, rememberImageSize, type PlaceScene } from '@aio/annotate';
import { getActiveScene, type SceneHandle } from '@aio/engine';
import { pointsInPrism, refineAround } from '@aio/pointcloud';
import type { Issue, Vec2 } from '@aio/schema';
import { assetUrl, type Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';

export function placeScene(h: SceneHandle): PlaceScene {
  return {
    raycastRay: (o, d, opts) => h.raycastRay(o, d, opts),
    rayLayers: () => h.rayLayers?.() ?? new Set<string>(),
    cloud: {
      refineAround: (focus, ms) => refineAround(h, focus, ms),
      pointsInPrism: (layer, prism) => pointsInPrism(h, layer, prism),
    },
  };
}

export type ProbeSize = (url: string) => Promise<Vec2 | null>;

/** The natural size of an image file (the size the photo viewer measures shapes in). */
export const probeImageSize: ProbeSize = (url) =>
  new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      resolve([im.naturalWidth, im.naturalHeight]);
    };
    im.onerror = () => {
      resolve(null);
    };
    im.src = url;
  });

/** Remember the pixel size of each photo the issue is marked on that no viewer has shown yet. */
export async function ensureSizes(
  ws: StoreApi<Workspace>,
  issue: Issue,
  probe: ProbeSize = probeImageSize,
): Promise<void> {
  const project = ws.getState().project;
  if (!project) return;
  for (const s of issue.sightings) {
    if (s.on !== 'image' || imageSizeOf(s.layer, s.photo)) continue;
    const layer = project.manifest.layers.find((l) => l.id === s.layer);
    const photo = layer?.kind === 'photos' ? layer.items.find((p) => p.id === s.photo) : undefined;
    if (!photo) continue;
    const size = await probe(assetUrl(project.id, photo.src));
    if (size) rememberImageSize(s.layer, s.photo, size);
  }
}

/** Show the layer when hidden, then wait until the 3D view can cast rays at it. */
export async function layerReady(
  ws: StoreApi<Workspace>,
  layerId: string,
  scene: () => SceneHandle | null = getActiveScene,
  timeoutMs = 15_000,
  stepMs = 100,
): Promise<boolean> {
  const s = ws.getState();
  if (s.hidden[layerId]) s.setLayerVisible(layerId, true);
  const end = Date.now() + timeoutMs;
  const has = () => scene()?.rayLayers?.().has(layerId) === true;
  while (Date.now() < end) {
    if (has()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return has();
}
```

`apps/desktop/src/renderer/placement/index.ts`:

```ts
/**
 * The app's placement of findings on a model: the store with the live 3D view, pointcloud and
 * bridge behind it, the offer the review and the Changes panel make, and the issue list's
 * right-click action. `startPlacement` runs once at start-up (bootstrap.ts).
 */
import { cameraSources, issueEditor, placeOnLayer, setIssueListActions } from '@aio/annotate';
import { getActiveScene } from '@aio/engine';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { bridge } from '../shell';
import { ensureSizes, layerReady, placeScene } from './controller';
import {
  createPlacementStore,
  type OfferSource,
  type PlacementDeps,
  type PlacementState,
} from './store';

function liveDeps(): PlacementDeps {
  return {
    workspace,
    editor: issueEditor,
    place: async (issue, layer) => {
      await ensureSizes(workspace, issue);
      const h = getActiveScene();
      if (!h) return { ok: false, reason: 'layer-not-loaded' };
      return placeOnLayer(issue, layer, placeScene(h), cameraSources);
    },
    writeSelection: async (projectId, name, data) => {
      const r = await bridge.call('project:writeSelection', { projectId, name, data });
      return r.ok && r.value.ok ? r.value.path : null;
    },
    ready: (id) => layerReady(workspace, id),
    now: () => new Date().toISOString(),
    newId: () => globalThis.crypto.randomUUID(),
  };
}

export const placement = createPlacementStore(liveDeps());

export function offerPlacement(ids: readonly string[], source: OfferSource): void {
  placement.getState().offerIds(ids, source);
}

export function usePlacement<T>(select: (s: PlacementState) => T): T {
  return useStore(placement, select);
}

/** The issue list's "Place on model..." opens the same offer. Returns a stop function. */
export function startPlacement(): () => void {
  const stopList = setIssueListActions({
    placeOnModel: (ids) => {
      offerPlacement(ids, 'menu');
    },
  });
  return () => {
    stopList();
  };
}

export type { OfferSource, PlacementState, PlaceSummary } from './store';
```

(Check `bridge.call`'s answer shape in `renderer/bridge.ts`: `{ ok: true, value } | { ok: false, error }`, as `createBridge` returns.)

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement`
Expected: PASS.

- [ ] **Step 7: Hook the review, the Changes panel and start-up**

`apps/desktop/src/renderer/detections/store.ts`:

- import `rememberImageSize` beside `issueEditor` from `@aio/annotate`, and `import { offerPlacement } from '../placement';`
- in `loadDetections`, after `const res = r.value;`:

```ts
// the photos' pixel sizes: the crossview pin and placing findings on a model need them
for (const [key, size] of Object.entries(res.sizes)) {
  const cut = key.indexOf('/');
  if (cut > 0) rememberImageSize(key.slice(0, cut), key.slice(cut + 1), [size[0], size[1]]);
}
```

- in `acceptCurrent`, before each `return { ok: true, issueId: ... }`: `offerPlacement([created.value.id], 'detections');` (new issue) and `offerPlacement([mode.issueId], 'detections');` (linked issue).
- in `acceptAll`, before `return { accepted: items.length, ... }`: `offerPlacement(items.map((x) => x.issueId), 'detections');`
- add after `acceptAll`:

```ts
/**
 * Accept the named detections for the assistant (`place_on_model`): waiting ones become draft
 * issues as one editor step (as Accept all does); already accepted ones answer their issue.
 * No offer: the assistant places them itself.
 */
export function acceptByIds(
  ids: readonly string[],
):
  | { accepted: { id: string; issueId: string }[]; skipped: { id: string; problem: string }[] }
  | { error: string } {
  const s = detections.getState();
  if (s.readOnly) return { error: t('det.save.readOnly') };
  const want = new Set(ids);
  const list = s.review.detections.filter((d) => want.has(d.id));
  const done = list.flatMap((d) =>
    d.status === 'accepted' && d.issueId ? [{ id: d.id, issueId: d.issueId }] : [],
  );
  const skipped = list
    .filter((d) => d.status !== 'draft' && !(d.status === 'accepted' && d.issueId))
    .map((d) => ({ id: d.id, problem: 'not-waiting' }));
  const r = acceptMany(list, issueEditor.context(), sizeOf);
  skipped.push(...r.skipped.map((x) => ({ id: x.detection.id, problem: x.problem })));
  if (r.accepted.length === 0) return { accepted: done, skipped };
  const label = acceptLabel(r.accepted.length);
  const created = issueEditor.createMany(
    r.accepted.map((a) => a.input),
    label,
  );
  if (!created.ok) return { error: created.error };
  const items = r.accepted.flatMap((a, i) => {
    const issue = created.value[i];
    return issue ? [{ id: a.detection.id, issueId: issue.id }] : [];
  });
  dispatch({
    type: 'acceptedMany',
    items,
    label,
    by: authorName() || 'user',
    now: new Date().toISOString(),
  });
  return { accepted: [...done, ...items], skipped };
}
```

`apps/desktop/src/renderer/change/actions.ts`: import `import { offerPlacement } from '../placement';` and in `makeIssue`, after `saveIssues([r.issue]);`:

```ts
// a finding from a later photo can be placed on the later model (spec section 6)
offerPlacement([r.issue.id], 'change');
```

`apps/desktop/src/renderer/bootstrap.ts`: import `import { placement, startPlacement } from './placement';`, call `startPlacement();` right after `registerAgentHooks();`, and add to the `__stratlas` object:

```ts
      /** Findings on a model: the offer, the result and the match suggestions (e2e). */
      placement,
```

- [ ] **Step 8: Run the desktop tests, typecheck and commit**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement src/renderer/detections src/renderer/change && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add apps/desktop/src/renderer/placement/layers.ts apps/desktop/src/renderer/placement/layers.test.ts apps/desktop/src/renderer/placement/store.ts apps/desktop/src/renderer/placement/store.test.ts apps/desktop/src/renderer/placement/controller.ts apps/desktop/src/renderer/placement/controller.test.ts apps/desktop/src/renderer/placement/index.ts apps/desktop/src/renderer/bootstrap.ts apps/desktop/src/renderer/detections/store.ts apps/desktop/src/renderer/change/actions.ts
git commit -m "feat(desktop): place accepted findings on a model and suggest matches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Desktop, the offer bar and the evidence's starting photo

**Files:**

- Create: `apps/desktop/src/renderer/placement/PlaceOnModelNotice.tsx`, test `placement/PlaceOnModelNotice.test.tsx`
- Modify: `apps/desktop/src/renderer/exports/Toasts.tsx` (host the notice after `PhotoAlignNotice`)
- Modify: `apps/desktop/src/renderer/issueCard/model.ts` (`evidenceStart`)
- Test: `apps/desktop/src/renderer/issueCard/model.test.ts` (new `it`)
- Modify: `apps/desktop/src/renderer/issueCard/evidence.ts` (`openEvidence` starts at `evidenceStart`)

**Interfaces:**

- Consumes: `PlacementState`, `placement` (Task 11); `layerChoices` (Task 11); `place.*` strings (Task 2); `placedFrom` (Task 7).
- Produces: `PlaceOnModelNotice({ store }: { store: StoreApi<PlacementState> })` with test ids `place-notice`, `place-offer`, `place-layer`, `place-go`, `place-not-now`, `place-busy`, `place-result`, `place-result-text`, `place-undo`, `place-dismiss`, `place-match`, `place-same`, `place-different`, `place-skip-all`, `place-error` (Task 14 uses them); `evidenceStart(manifest: ProjectManifest, issue: Issue): number`.

The notice takes the store as a prop (Toasts passes the app's `placement`), so its test renders a store with fake dependencies and never loads the bridge. It is one toast in the existing bottom-right stack, built like `PhotoAlignNotice` (`toast`, `toast-h`, `toast-p`, `btn sm`, `btn ghost icon sm`), so it never covers the 3D view more than the other notices do.

- [ ] **Step 1: Write the failing notice test**

Create `apps/desktop/src/renderer/placement/PlaceOnModelNotice.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { PlaceResult } from '@aio/annotate';
import { ok, type ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaceOnModelNotice } from './PlaceOnModelNotice';
import { createPlacementStore } from './store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'mesh',
      id: 'model',
      name: 'Mesh 3 Mar',
      visible: true,
      src: { path: 'a.glb' },
      transform: I,
    },
    {
      kind: 'pointcloud',
      id: 'cloud',
      name: 'Cloud 3 Mar',
      visible: true,
      src: { path: 'c.json' },
      format: 'png-packed',
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

function mount() {
  workspace.getState().openProject({ id: 'p', root: 'r', manifest }, []);
  const undo = vi.fn(() => true);
  const store = createPlacementStore({
    workspace,
    editor: {
      state: {
        canUndo: true,
        canRedo: false,
        undoLabel: 'Place 12 issues on Mesh 3 Mar',
        redoLabel: null,
        save: { state: 'saved' },
        lastError: null,
      },
      commitIssues: vi.fn(() => ok(null)),
      undo,
    },
    place: vi.fn(() => Promise.resolve<PlaceResult>({ ok: false, reason: 'missed' })),
    writeSelection: vi.fn(() => Promise.resolve(null)),
    ready: vi.fn(() => Promise.resolve(true)),
    now: () => '2026-10-15T12:00:00.000Z',
    newId: () => 't',
  });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  act(() => {
    root.render(<PlaceOnModelNotice store={store} />);
  });
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`);
  const click = (id: string) => {
    act(() => {
      q(id)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  return {
    store,
    undo,
    el,
    q,
    click,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      el.remove();
    },
  };
}

afterEach(() => {
  workspace.getState().closeProject();
});

describe('PlaceOnModelNotice', () => {
  it('shows nothing until there is an offer, a result or a match', () => {
    const ui = mount();
    expect(ui.q('place-notice')).toBeNull();
    ui.unmount();
  });

  it('asks to connect the findings, lists the layers and closes on Not now', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({ offer: { ids: ['a', 'b'], source: 'detections' }, layerId: 'model' });
    });
    expect(ui.q('place-offer')?.textContent).toContain('Connect 2 findings to a model?');
    const options = [...(ui.q('place-layer')?.querySelectorAll('option') ?? [])].map(
      (o) => o.textContent,
    );
    expect(options).toEqual(['Mesh 3 Mar (mesh)', 'Cloud 3 Mar (point cloud)']);
    ui.click('place-not-now');
    expect(ui.store.getState().offer).toBeNull();
    expect(ui.q('place-notice')).toBeNull();
    ui.unmount();
  });

  it('reports the result with Undo, then a match with Same, Different and Skip all', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({
        result: {
          layerId: 'model',
          layerName: 'Mesh 3 Mar',
          total: 14,
          placed: 12,
          missed: 2,
          noPhoto: 0,
          notLoaded: 0,
          label: 'Place 12 issues on Mesh 3 Mar',
          outcomes: [],
        },
        matches: [
          { issueId: 'x', code: 'AI-31', otherId: 'y', otherCode: 'AI-12', date: '3 Mar' },
          { issueId: 'z', code: 'AI-32', otherId: 'w', otherCode: 'AI-13', date: '3 Mar' },
        ],
      });
    });
    expect(ui.q('place-result-text')?.textContent).toBe(
      'Placed 12 of 14 on Mesh 3 Mar. 2 missed the model.',
    );
    expect(ui.q('place-match')?.textContent).toContain('AI-31 looks like AI-12 from 3 Mar');
    ui.click('place-different');
    expect(ui.q('place-match')?.textContent).toContain('AI-32 looks like AI-13');
    ui.click('place-skip-all');
    expect(ui.q('place-match')).toBeNull();
    ui.click('place-undo');
    expect(ui.undo).toHaveBeenCalledTimes(1);
    expect(ui.q('place-notice')).toBeNull();
    ui.unmount();
  });

  it('uses no em or en dash in what it shows', () => {
    const ui = mount();
    act(() => {
      ui.store.setState({ offer: { ids: ['a'], source: 'menu' }, layerId: 'cloud' });
    });
    expect(ui.el.textContent).not.toMatch(/[–—]/);
    ui.unmount();
  });
});
```

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/PlaceOnModelNotice.test.tsx`
Expected: FAIL, `Cannot find module './PlaceOnModelNotice'`.

- [ ] **Step 2: Create `placement/PlaceOnModelNotice.tsx`**

```tsx
import { Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { layerChoices } from './layers';
import type { PlacementState } from './store';

/**
 * Findings on a model, bottom right (spec section 6): "Connect N findings to a model?" with the
 * layer picker, Place and Not now; then "Placed 12 of 14 on Mesh 3 Mar. 2 missed the model."
 * with Undo; then the match suggestions one at a time with Same, Different and Skip all.
 */
export function PlaceOnModelNotice({ store }: { store: StoreApi<PlacementState> }) {
  const t = useT();
  const s = useStore(store, (x) => x);
  const project = useWorkspace((w) => w.project);
  const dates = useWorkspace((w) => w.dates);
  const issues = useWorkspace((w) => w.issues);
  const match = s.matches[0];
  if (!s.offer && !s.result && !match && !s.error && !s.busy) return null;
  const offered = s.offer ? issues.filter((i) => s.offer?.ids.includes(i.id)) : [];
  const choices = project ? layerChoices(project.manifest, dates, offered) : [];
  const layerName =
    project?.manifest.layers.find((l) => l.id === (s.result?.layerId ?? s.layerId))?.name ?? '';
  const r = s.result;
  const resultText = r
    ? [
        t('place.result', { placed: r.placed, count: r.total, layer: r.layerName }),
        r.missed ? t('place.missed', { count: r.missed }) : '',
        r.noPhoto ? t('place.noPhoto', { count: r.noPhoto }) : '',
        r.notLoaded ? t('place.notLoaded', { layer: r.layerName }) : '',
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  const groups = [true, false].map((sameDate) => ({
    sameDate,
    list: choices.filter((c) => c.sameDate === sameDate),
  }));
  return (
    <div className="toast" data-testid="place-notice">
      {s.offer && (
        <div data-testid="place-offer">
          <div className="toast-h">
            <Icon name="photo" size={14} />
            <b>{t('place.offer', { count: s.offer.ids.length })}</b>
            <span className="toast-grow" />
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label={t('place.dismiss')}
              onClick={() => {
                store.getState().notNow();
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
          {s.noLayers ? (
            <div className="toast-p">{t('place.noLayers')}</div>
          ) : (
            <div
              className="toast-p"
              style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <select
                aria-label={t('place.layer')}
                data-testid="place-layer"
                value={s.layerId ?? ''}
                disabled={s.busy}
                onChange={(e) => {
                  store.getState().setLayer(e.target.value);
                }}
              >
                {groups.map((g) =>
                  g.list.length > 0 ? (
                    <optgroup
                      key={String(g.sameDate)}
                      label={t(g.sameDate ? 'place.group.sameDate' : 'place.group.other')}
                    >
                      {g.list.map((c) => (
                        <option key={c.id} value={c.id}>
                          {`${c.name} (${t(c.kind === 'mesh' ? 'place.kind.mesh' : 'place.kind.pointcloud')})`}
                        </option>
                      ))}
                    </optgroup>
                  ) : null,
                )}
              </select>
              <button
                type="button"
                className="btn sm"
                data-testid="place-go"
                disabled={s.busy || !s.layerId}
                onClick={() => void store.getState().place()}
              >
                {t('place.go')}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                data-testid="place-not-now"
                onClick={() => {
                  store.getState().notNow();
                }}
              >
                {t('place.notNow')}
              </button>
            </div>
          )}
        </div>
      )}
      {s.busy && !s.offer && (
        <div className="toast-p" data-testid="place-busy">
          {t('place.placing', { layer: layerName })}
        </div>
      )}
      {s.error && (
        <div className="toast-p" role="alert" data-testid="place-error">
          {s.error}
        </div>
      )}
      {r && (
        <div className="toast-h" data-testid="place-result">
          <Icon name="check" size={14} />
          <span className="toast-p" data-testid="place-result-text">
            {resultText}
          </span>
          <span className="toast-grow" />
          {r.placed > 0 && (
            <button
              type="button"
              className="btn ghost sm"
              data-testid="place-undo"
              onClick={() => {
                store.getState().undo();
              }}
            >
              <Icon name="undo" size={12} />
              {t('place.undo')}
            </button>
          )}
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('place.dismiss')}
            data-testid="place-dismiss"
            onClick={() => {
              store.getState().dismiss();
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {match && (
        <div data-testid="place-match">
          <div className="toast-p">
            {t('place.match', { code: match.code, other: match.otherCode, date: match.date })}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn sm"
              data-testid="place-same"
              onClick={() => {
                store.getState().same();
              }}
            >
              {t('place.same')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="place-different"
              onClick={() => {
                store.getState().different();
              }}
            >
              {t('place.different')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="place-skip-all"
              onClick={() => {
                store.getState().skipAll();
              }}
            >
              {t('place.skipAll')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

In `apps/desktop/src/renderer/exports/Toasts.tsx`: import `import { placement } from '../placement';` and `import { PlaceOnModelNotice } from '../placement/PlaceOnModelNotice';`, and render `<PlaceOnModelNotice store={placement} />` right after `<PhotoAlignNotice />`.

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/PlaceOnModelNotice.test.tsx`
Expected: PASS.

- [ ] **Step 3: Write the failing evidence-start test**

Add to `describe('issue evidence')` in `apps/desktop/src/renderer/issueCard/model.test.ts` (import `evidenceStart` from `./model`):

```ts
it('starts on the photo a placed area was projected from', () => {
  const big = {
    on: 'image' as const,
    layer: 'photos',
    photo: 'p1',
    geom: { type: 'box' as const, x: 0, y: 0, w: 90, h: 90 },
  };
  const small = {
    on: 'image' as const,
    layer: 'photos',
    photo: 'p2',
    geom: { type: 'box' as const, x: 0, y: 0, w: 9, h: 9 },
  };
  const area = {
    on: 'mesh' as const,
    layer: 'm',
    geom: {
      type: 'spolygon' as const,
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
      ] as [number, number, number][],
    },
    from: { sighting: 1 },
  };
  const placed = issue({ sightings: [big, small, area] });
  // p1 is the largest mark and comes first; the area came from p2
  expect(photoEvidence(issueEvidence(manifest, placed)).map((e) => e.photo)).toEqual(['p1', 'p2']);
  expect(evidenceStart(manifest, placed)).toBe(1);
  expect(evidenceStart(manifest, issue({ sightings: [big, small] }))).toBe(0);
});
```

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/issueCard/model.test.ts`
Expected: FAIL, `evidenceStart is not a function`.

- [ ] **Step 4: Add `evidenceStart` and use it**

In `apps/desktop/src/renderer/issueCard/model.ts`, import `import { placedFrom } from '@aio/annotate';` and add after `evidenceKind`:

```ts
/**
 * Where the evidence opens: the photo a placed area was projected from (findings on a model,
 * "click opens the photos it was found in, starting with the from sighting"), else the best one.
 */
export function evidenceStart(manifest: ProjectManifest, issue: Issue): number {
  const from = placedFrom(issue);
  const s = from === null ? undefined : issue.sightings[from];
  if (s?.on !== 'image') return 0;
  const k = photoEvidence(issueEvidence(manifest, issue)).findIndex(
    (e) => e.key === `${s.layer}/${s.photo}`,
  );
  return k >= 0 ? k : 0;
}
```

In `apps/desktop/src/renderer/issueCard/evidence.ts`, import `evidenceStart` from `./model` and in `openEvidence` change `index: 0` to `index: evidenceStart(project.manifest, issue)`.

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/issueCard`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add apps/desktop/src/renderer/placement/PlaceOnModelNotice.tsx apps/desktop/src/renderer/placement/PlaceOnModelNotice.test.tsx apps/desktop/src/renderer/exports/Toasts.tsx apps/desktop/src/renderer/issueCard/model.ts apps/desktop/src/renderer/issueCard/model.test.ts apps/desktop/src/renderer/issueCard/evidence.ts
git commit -m "feat(desktop): offer bar for findings on a model; a placed finding opens its photo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Desktop, the assistant hooks

**Files:**

- Create: `apps/desktop/src/renderer/placement/agentHooks.ts`, test `placement/agentHooks.test.ts`
- Modify: `apps/desktop/src/renderer/placement/index.ts` (`startPlacement` registers the hooks)

**Interfaces:**

- Consumes: `AppHooks`, `PlaceOnModelResult`, `AddSightingResult`, `AddSightingRequest`, `PlaceOnModelRequest`, `ToolError`, `registerAppHooks` (Task 6); `placement.placeIds` (Task 11); `acceptByIds` (Task 11); `issueEditor.addSighting`, `issueEditor.undo`, `issueEditor.state` (existing).
- Produces:

```ts
export interface PlacementHookDeps {
  workspace: StoreApi<Workspace>;
  placeIds(ids: readonly string[], layerId: string): Promise<PlaceSummary | null>;
  acceptByIds: typeof acceptByIds;
  editor: Pick<IssueEditor, 'addSighting' | 'undo' | 'state'>;
}
export function createPlacementHooks(
  deps: PlacementHookDeps,
): Required<Pick<AppHooks, 'placeOnModel' | 'addSighting'>>;
```

Rules: a layer is found by id or by name (case-insensitive) among mesh and point-cloud layers, else a `ToolError` naming them. An id is an issue id or code, else a detection id (accepted first through `acceptByIds`), else outcome `unknown`. `add_sighting` at a point adds a mesh `spoint` or a cloud `point3`; at a photo box it adds the image sighting (one editor step) and then places the issue on the layer from that box through `placeIds` (a second step); Undo takes back the steps that are still the last ones.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/placement/agentHooks.test.ts`:

```ts
import { ToolError } from '@aio/ai';
import type { EditorState } from '@aio/annotate';
import { ok, type Issue, type ProjectManifest, type Sighting } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { createPlacementHooks, type PlacementHookDeps } from './agentHooks';
import type { PlaceSummary } from './store';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'mesh',
      id: 'model',
      name: 'Site model',
      visible: true,
      src: { path: 'a.glb' },
      transform: I,
    },
    {
      kind: 'pointcloud',
      id: 'cloud',
      name: 'Cloud',
      visible: true,
      src: { path: 'c.json' },
      format: 'png-packed',
    },
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: [{ id: 'P7', src: { path: 'p/P7.jpg' } }],
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;
const F01 = {
  id: 'i1',
  code: 'F01',
  sightings: [
    { on: 'image', layer: 'photos', photo: 'P7', geom: { type: 'box', x: 0, y: 0, w: 5, h: 5 } },
  ],
} as unknown as Issue;

function setup() {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p', root: 'r', manifest }, [F01]);
  const summary = (ids: readonly string[]): PlaceSummary => ({
    layerId: 'model',
    layerName: 'Site model',
    total: ids.length,
    placed: 1,
    missed: ids.length - 1,
    noPhoto: 0,
    notLoaded: 0,
    label: 'Place 1 issue on Site model',
    outcomes: ids.map((id, k) =>
      k === 0
        ? {
            id,
            code: 'F01',
            ok: true,
            sightings: [
              {
                on: 'mesh',
                layer: 'model',
                geom: {
                  type: 'spolygon',
                  points: [
                    [0, 0, 0],
                    [1, 0, 0],
                    [1, 0, 1],
                  ],
                },
                from: { sighting: 0 },
              } as Sighting,
            ],
          }
        : { id, code: 'F02', ok: false, reason: 'missed' as const },
    ),
  });
  const state: EditorState = {
    canUndo: true,
    canRedo: false,
    undoLabel: 'Place 1 issue on Site model',
    redoLabel: null,
    save: { state: 'saved' },
    lastError: null,
  };
  const deps: PlacementHookDeps = {
    workspace: ws,
    placeIds: vi.fn((ids: readonly string[]) => Promise.resolve(summary(ids))),
    acceptByIds: vi.fn(() => ({
      accepted: [{ id: 'det-1', issueId: 'i2' }],
      skipped: [{ id: 'det-9', problem: 'no-class' }],
    })),
    editor: {
      state,
      addSighting: vi.fn(() => ok(F01)),
      undo: vi.fn(() => true),
    },
  };
  return { ws, deps, hooks: createPlacementHooks(deps) };
}

describe('assistant placement hooks', () => {
  it('place_on_model accepts named detections first, places, and reports per id', async () => {
    const { deps, hooks } = setup();
    const r = await hooks.placeOnModel({
      ids: ['F01', 'det-1', 'det-9', 'nothing'],
      layer: 'site MODEL',
    });
    expect(deps.acceptByIds).toHaveBeenCalledWith(['det-1', 'det-9', 'nothing']);
    expect(deps.placeIds).toHaveBeenCalledWith(['i1', 'i2'], 'model');
    expect(r.layer).toEqual({ id: 'model', name: 'Site model' });
    expect(r.outcomes).toEqual([
      { id: 'F01', code: 'F01', placed: [{ on: 'mesh', type: 'spolygon' }] },
      { id: 'det-1', code: 'F02', reason: 'missed' },
      { id: 'det-9', reason: 'no-class' },
      { id: 'nothing', reason: 'unknown' },
    ]);
    r.undo?.();
    expect(deps.editor.undo).toHaveBeenCalledTimes(1);
  });

  it('names the layers when the one asked for is not a mesh or cloud', async () => {
    const { hooks } = setup();
    await expect(hooks.placeOnModel({ ids: ['F01'], layer: 'Photos' })).rejects.toBeInstanceOf(
      ToolError,
    );
    await expect(hooks.placeOnModel({ ids: ['F01'], layer: 'x' })).rejects.toThrow(
      'Site model, Cloud',
    );
  });

  it('add_sighting puts a point of the layer kind on the issue', async () => {
    const { deps, hooks } = setup();
    const r = await hooks.addSighting({
      issue: 'F01',
      layer: 'cloud',
      at: { kind: 'point', p: [1, 2, 3] },
    });
    expect(deps.editor.addSighting).toHaveBeenCalledWith('i1', {
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'point3', p: [1, 2, 3] },
    });
    expect(r).toMatchObject({ code: 'F01', placed: [{ on: 'pointcloud', type: 'point3' }] });
  });

  it('add_sighting from a photo box adds the box, then projects it onto the layer', async () => {
    const { deps, hooks } = setup();
    const r = await hooks.addSighting({
      issue: 'F01',
      layer: 'model',
      at: { kind: 'photo', photo: 'P7', box: [10, 20, 30, 40] },
    });
    expect(deps.editor.addSighting).toHaveBeenCalledWith('i1', {
      on: 'image',
      layer: 'photos',
      photo: 'P7',
      geom: { type: 'box', x: 10, y: 20, w: 30, h: 40 },
    });
    expect(deps.placeIds).toHaveBeenCalledWith(['i1'], 'model');
    expect(r.placed).toEqual([{ on: 'mesh', type: 'spolygon' }]);
    await expect(
      hooks.addSighting({
        issue: 'F01',
        layer: 'model',
        at: { kind: 'photo', photo: 'nope', box: [0, 0, 1, 1] },
      }),
    ).rejects.toThrow('No photo "nope"');
    await expect(
      hooks.addSighting({ issue: 'F99', layer: 'model', at: { kind: 'point', p: [0, 0, 0] } }),
    ).rejects.toThrow('No issue "F99"');
  });
});
```

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement/agentHooks.test.ts`
Expected: FAIL, `Cannot find module './agentHooks'`.

- [ ] **Step 2: Create `placement/agentHooks.ts`**

```ts
/**
 * The assistant's placement tools (`place_on_model`, `add_sighting`, executors in @aio/ai
 * placement-tools.ts) act through these hooks, behind the panel's Approve: the same store, the
 * same detection acceptance and the same issue editor as the person's own clicks.
 */
import { ToolError, type AppHooks, type PlaceOutcome } from '@aio/ai';
import type { IssueEditor } from '@aio/annotate';
import type { Issue, Layer, Sighting } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import type { acceptByIds } from '../detections/store';
import type { PlaceSummary } from './store';

export interface PlacementHookDeps {
  workspace: StoreApi<Workspace>;
  placeIds(ids: readonly string[], layerId: string): Promise<PlaceSummary | null>;
  acceptByIds: typeof acceptByIds;
  editor: Pick<IssueEditor, 'addSighting' | 'undo' | 'state'>;
}

type ModelLayer = Extract<Layer, { kind: 'mesh' | 'pointcloud' }>;

const placedOf = (sightings: readonly Sighting[] | undefined) =>
  (sightings ?? []).flatMap((s) =>
    s.on === 'mesh' || s.on === 'pointcloud' ? [{ on: s.on, type: s.geom.type }] : [],
  );

export function createPlacementHooks(
  deps: PlacementHookDeps,
): Required<Pick<AppHooks, 'placeOnModel' | 'addSighting'>> {
  const manifest = () => {
    const p = deps.workspace.getState().project;
    if (!p) throw new ToolError('Open a project first.');
    return p.manifest;
  };
  const layerOf = (ref: string): ModelLayer => {
    const models = manifest().layers.filter(
      (l): l is ModelLayer => l.kind === 'mesh' || l.kind === 'pointcloud',
    );
    const want = ref.trim().toLowerCase();
    const l = models.find((x) => x.id === ref || x.name.toLowerCase() === want);
    if (!l)
      throw new ToolError(
        `There is no mesh or point cloud layer "${ref}". The layers: ${models.map((x) => x.name).join(', ')}.`,
      );
    return l;
  };
  const issueOf = (ref: string): Issue | undefined =>
    deps.workspace.getState().issues.find((i) => i.id === ref || i.code === ref);
  const undoIf = (label: string | undefined) => {
    if (label && deps.editor.state.undoLabel === label) deps.editor.undo();
  };

  return {
    async placeOnModel(req) {
      const layer = layerOf(req.layer);
      const issueIds = new Map<string, string>();
      const rest: string[] = [];
      for (const id of req.ids) {
        const i = issueOf(id);
        if (i) issueIds.set(id, i.id);
        else rest.push(id);
      }
      const early = new Map<string, PlaceOutcome>();
      if (rest.length) {
        const a = deps.acceptByIds(rest);
        if ('error' in a) throw new ToolError(a.error);
        for (const x of a.accepted) issueIds.set(x.id, x.issueId);
        for (const x of a.skipped) early.set(x.id, { id: x.id, reason: x.problem });
      }
      const summary = await deps.placeIds([...new Set(issueIds.values())], layer.id);
      const byIssue = new Map((summary?.outcomes ?? []).map((o) => [o.id, o]));
      const outcomes: PlaceOutcome[] = req.ids.map((id) => {
        const issueId = issueIds.get(id);
        const o = issueId ? byIssue.get(issueId) : undefined;
        if (o?.ok) return { id, code: o.code, placed: placedOf(o.sightings) };
        if (o) return { id, code: o.code, reason: o.reason ?? 'missed' };
        return early.get(id) ?? { id, reason: 'unknown' };
      });
      const label = summary && summary.placed > 0 ? summary.label : undefined;
      return {
        layer: { id: layer.id, name: layer.name },
        outcomes,
        ...(label ? { undo: () => undoIf(label) } : {}),
      };
    },

    async addSighting(req) {
      const layer = layerOf(req.layer);
      const issue = issueOf(req.issue);
      if (!issue) throw new ToolError(`No issue "${req.issue}". Use list_issues for the codes.`);
      if (req.at.kind === 'point') {
        const p = req.at.p;
        const s: Sighting =
          layer.kind === 'pointcloud'
            ? { on: 'pointcloud', layer: layer.id, geom: { type: 'point3', p } }
            : { on: 'mesh', layer: layer.id, geom: { type: 'spoint', p, n: [0, 1, 0] } };
        const r = deps.editor.addSighting(issue.id, s);
        if (!r.ok) throw new ToolError(r.error);
        const label = deps.editor.state.undoLabel ?? undefined;
        return { code: issue.code, placed: placedOf([s]), undo: () => undoIf(label) };
      }
      const photo = req.at.photo;
      const photos = manifest().layers.find(
        (l) => l.kind === 'photos' && l.items.some((x) => x.id === photo),
      );
      if (!photos) throw new ToolError(`No photo "${photo}" in this project.`);
      const [x, y, w, h] = req.at.box;
      const image: Sighting = {
        on: 'image',
        layer: photos.id,
        photo,
        geom: { type: 'box', x, y, w, h },
      };
      const added = deps.editor.addSighting(issue.id, image);
      if (!added.ok) throw new ToolError(added.error);
      const first = deps.editor.state.undoLabel ?? undefined;
      const summary = await deps.placeIds([issue.id], layer.id);
      const o = summary?.outcomes.find((x) => x.id === issue.id);
      const second = summary && summary.placed > 0 ? summary.label : undefined;
      return {
        code: issue.code,
        placed: o?.ok ? placedOf(o.sightings) : [],
        undo: () => {
          undoIf(second);
          undoIf(first);
        },
      };
    },
  };
}
```

(`placedOf` on an image sighting returns nothing, so `add_sighting` from a box reports what was placed on the model, or an empty list when the box missed it; the box itself stays as a sighting and the tool result says so through `placed: []`.)

In `apps/desktop/src/renderer/placement/index.ts`: import `registerAppHooks` from `@aio/ai`, `createPlacementHooks` from `./agentHooks` and `acceptByIds` from `../detections/store`, and in `startPlacement` before the `return`:

```ts
const stopHooks = registerAppHooks(
  createPlacementHooks({
    workspace,
    placeIds: (ids, layerId) => placement.getState().placeIds(ids, layerId),
    acceptByIds,
    editor: issueEditor,
  }),
);
```

and call `stopHooks();` in the returned function.

- [ ] **Step 3: Run the tests**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/placement`
Expected: PASS.

- [ ] **Step 4: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add apps/desktop/src/renderer/placement/agentHooks.ts apps/desktop/src/renderer/placement/agentHooks.test.ts apps/desktop/src/renderer/placement/index.ts
git commit -m "feat(desktop): the assistant places findings and adds sightings on a model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: End to end, `findings-on-model.spec.ts` and the CI-style re-runs

**Files:**

- Create: `apps/desktop/e2e/findings-on-model.spec.ts`

**Interfaces:**

- Consumes: the `demoProject` fixture (`e2e/fixtures.ts`); test ids of Tasks 10 and 12 (`issue-place-on-model`, `place-*`); the probes `__stratlas.workspace`, `.stage()`, `.evidence`, `.placement` (Task 11); the overlay's `userData.areas` on the `annotate-issue-pins` group (Task 9).
- Produces: one spec, no `@realdata` (synthetic demo only).

- [ ] **Step 1: Write the spec**

```ts
/**
 * Findings on a model end to end, on the change demo (synthetic; pnpm demo:change --quick): two
 * marker detections, one per survey date, accepted in the review; the offer to connect them to a
 * model; the later one placed on the later mesh (an outline drawn instead of its pin, a click on
 * it opening its photo) and on the later point cloud (a prism and a point selection file); the
 * earlier one on the earlier mesh, the match suggestion, and Same giving both one track.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

interface S {
  on: string;
  layer: string;
  photo?: string;
  geom?: { type: string; src?: { path?: string } };
  from?: { sighting: number };
}
interface IssueLite {
  id: string;
  code: string;
  title: string;
  track?: string;
  sightings: S[];
}
interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        issues: IssueLite[];
        select(s: null): void;
        flyTo(t: { kind: 'point'; p: [number, number, number]; distance: number }): void;
      };
    };
    stage(): {
      scene: { getObjectByName(n: string): { userData: Record<string, unknown> } | undefined };
    } | null;
    evidence: { getState(): { open: { issueId: string; index: number } | null } };
  };
}

/** One waiting copy of a marker detection of `date`, in its own pass file. */
async function draftPass(root: string, date: 'd1' | 'd2', marker: string): Promise<void> {
  const src = JSON.parse(
    await readFile(join(root, 'detections', `markers-${date}.json`), 'utf8'),
  ) as {
    detections: { id: string }[];
  } & Record<string, unknown>;
  const d = src.detections.find((x) => x.id.startsWith(`${marker}-`));
  if (!d) throw new Error(`marker ${marker} is not in the ${date} pass`);
  const pass = {
    ...src,
    producer: 'e2e',
    detections: [{ ...d, id: `e2e-${date}`, status: 'draft' }],
  };
  await writeFile(join(root, 'detections', `e2e-${date}.json`), JSON.stringify(pass, null, 2));
}

const issues = (win: Page) =>
  win.evaluate(() => (window as unknown as Inspect).__stratlas.workspace.getState().issues);

/** Right-click the issue in the scene's issue list and place it on `layer`. */
async function placeFromList(win: Page, code: string, layer: string): Promise<void> {
  await win
    .getByRole('tablist', { name: 'Context' })
    .getByRole('tab', { name: /Issues/ })
    .click();
  const row = win.getByTestId('issue-register').getByRole('option', { name: new RegExp(code) });
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await win.getByTestId('issue-place-on-model').click();
  await expect(win.getByTestId('place-offer')).toBeVisible();
  await win.getByTestId('place-layer').selectOption(layer);
  await win.getByTestId('place-go').click();
  await expect(win.getByTestId('place-result-text')).toContainText('Placed 1 of 1 on', {
    timeout: 60_000,
  });
}

/** The overlay's area of an issue, in canvas pixels, once the camera has settled on it. */
async function areaOnScreen(win: Page, issueId: string): Promise<{ x: number; y: number }> {
  let at = { x: -1, y: -1 };
  let last = '';
  await expect
    .poll(
      async () => {
        const a = await win.evaluate((id) => {
          const g = (window as unknown as Inspect).__stratlas
            .stage()
            ?.scene.getObjectByName('annotate-issue-pins');
          const list = (g?.userData.areas ?? []) as {
            issueId: string;
            x: number | null;
            y: number | null;
          }[];
          return list.find((x) => x.issueId === id && x.x !== null) ?? null;
        }, issueId);
        if (!a || a.x === null || a.y === null) return false;
        const now = `${Math.round(a.x)},${Math.round(a.y)}`;
        const still = now === last;
        last = now;
        at = { x: a.x, y: a.y };
        return still;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true);
  return at;
}

test('places accepted findings on the mesh and the cloud, and matches them across dates', async ({
  demoProject,
}) => {
  test.setTimeout(300_000);
  const { win, root, truth } = demoProject;
  const items =
    (truth.changes.detection as { items?: { marker: string; verdict: string }[] }).items ?? [];
  const marker = items.find((i) => i.verdict === 'unchanged')?.marker;
  if (!marker) throw new Error('the change demo has no marker seen on both dates');
  await draftPass(root, 'd1', marker);
  await draftPass(root, 'd2', marker);
  const before = new Set((await issues(win)).map((i) => i.id));

  // 1. accept both in the review: the offer to connect them appears
  await win.locator('.nav-item', { hasText: 'Detections' }).click();
  await expect(win.getByTestId('det-counts')).toContainText('2 waiting', { timeout: 60_000 });
  await win.getByTestId('det-accept-all').click();
  await win.getByTestId('det-batch-ok').click();
  await expect(win.getByTestId('place-offer')).toContainText('Connect 2 findings to a model?');
  await win.getByTestId('place-not-now').click();
  await expect(win.getByTestId('place-offer')).toHaveCount(0);
  const fresh = (await issues(win)).filter((i) => !before.has(i.id));
  const later = fresh.find((i) => i.sightings.some((s) => s.layer === 'photos-d2'));
  const earlier = fresh.find((i) => i.sightings.some((s) => s.layer === 'photos-d1'));
  if (!later || !earlier) throw new Error('the two accepted findings are not there');

  // 2. the later finding on the later mesh: an outline instead of its pin
  await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 60_000 });
  await placeFromList(win, later.code, 'model-d2');
  await expect
    .poll(async () =>
      (await issues(win)).find((i) => i.id === later.id)?.sightings.map((s) => s.geom?.type),
    )
    .toContain('spolygon');
  const placed = (await issues(win)).find((i) => i.id === later.id);
  // its automatic pin on that mesh is gone
  expect(
    placed?.sightings.filter((s) => s.layer === 'model-d2' && s.geom?.type === 'spoint'),
  ).toEqual([]);
  await win.getByTestId('place-dismiss').click();

  // 3. hovering shows its title, a click opens its photo beside the 3D view
  // look at the outline from 6 m with nothing selected, so the click below is a new pick
  await win.evaluate((id) => {
    const ws = (window as unknown as Inspect).__stratlas.workspace.getState();
    const outline = ws.issues
      .find((x) => x.id === id)
      ?.sightings.find((s) => s.geom?.type === 'spolygon')?.geom as
      { points?: number[][] } | undefined;
    const pts = outline?.points ?? [];
    const mean = (k: number) => pts.reduce((a, p) => a + (p[k] ?? 0), 0) / Math.max(pts.length, 1);
    ws.select(null);
    ws.flyTo({ kind: 'point', p: [mean(0), mean(1), mean(2)], distance: 6 });
  }, later.id);
  const canvas = win.locator('[data-scene-view] canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no 3D canvas');
  const at = await areaOnScreen(win, later.id);
  await win.mouse.move(box.x + at.x, box.y + at.y);
  await expect(canvas).toHaveAttribute('title', later.title);
  await win.mouse.click(box.x + at.x, box.y + at.y);
  await expect
    .poll(() =>
      win.evaluate(
        () => (window as unknown as Inspect).__stratlas.evidence.getState().open?.issueId ?? null,
      ),
    )
    .toBe(later.id);
  await win.keyboard.press('Escape');

  // 4. the same finding on the later point cloud: a prism and its point selection file
  await placeFromList(win, later.code, 'cloud-d2');
  const onCloud =
    (await issues(win))
      .find((i) => i.id === later.id)
      ?.sightings.filter((s) => s.layer === 'cloud-d2') ?? [];
  expect(onCloud.map((s) => s.geom?.type).sort()).toEqual(['polygon3', 'selection']);
  const sel = onCloud.find((s) => s.geom?.type === 'selection')?.geom?.src?.path ?? '';
  expect(sel).toMatch(/^selections\/.+\.sel$/);
  await access(join(root, sel));
  await win.getByTestId('place-dismiss').click();

  // 5. the earlier finding on the earlier mesh: "looks like" the later one; Same tracks both
  await placeFromList(win, earlier.code, 'model-d1');
  await expect(win.getByTestId('place-match')).toContainText(
    `${earlier.code} looks like ${later.code} from`,
  );
  await win.getByTestId('place-same').click();
  await expect
    .poll(async () => {
      const list = await issues(win);
      const a = list.find((i) => i.id === earlier.id)?.track;
      const b = list.find((i) => i.id === later.id)?.track;
      return a !== undefined && a === b;
    })
    .toBe(true);
});
```

Before running, read `e2e/fixtures.ts` for the exact `demoProject` and `truth` types, and `e2e/issue-card.spec.ts` for how a click in the 3D view is made; follow them where the names differ. The window stays off-screen through the fixtures.

- [ ] **Step 2: Build the demos and run the new spec the way CI runs it**

From `apps/desktop` in PowerShell (the worktree has no `python/.venv`; point at the main checkout's):

```powershell
pnpm demo:build --quick --python "E:\Dev\AIO Software\python\.venv\Scripts\python.exe"
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
npx playwright test e2e/findings-on-model.spec.ts --workers=1 --repeat-each=3
```

(`pnpm demo:change --quick` alone is enough for this spec; CI builds every demo, so build them all before the re-runs below.)
Expected: 3 passed; the log prints `[e2e] window 1100 x 720 px at display scale 1`.

- [ ] **Step 3: Re-run the touched specs the same way**

```powershell
npx playwright test e2e/agent.spec.ts e2e/change-core.spec.ts e2e/change-cloud.spec.ts e2e/detections.spec.ts --workers=1
```

Expected: all pass; `detections.spec.ts` is `@realdata` and skips without the founder's data on this machine (say so in the hand-off if it skipped). `agent.spec.ts` covers the panel's approval of `write` tools, which `place_on_model` and `add_sighting` are; `change-core.spec.ts` covers Make issue and the issue verdicts (now with footprint matching); `change-cloud.spec.ts` covers the cloud paths next to the new ray provider.

- [ ] **Step 4: Full check and commit**

Run (repo root): `pnpm check`
Expected: lint, format, typecheck and every unit test green.

```bash
git add apps/desktop/e2e/findings-on-model.spec.ts
git commit -m "test(desktop): findings on a model end to end on the change demo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage (self-review)

| Spec section                                                                                                                                                       | Task(s)        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 1. Contract: `selection.lod?`, `from?` on mesh and cloud                                                                                                           | 1              |
| 2. Cloud ray query, ray target, `refineAround` (3 s)                                                                                                               | 3, 4           |
| 3. Projector: candidates, mesh 8 px / 60 % / 3 pts, cloud grid, 3 MAD, hull, 0.1 m pad, selection, writes through the editor                                       | 8, 11          |
| 4. Replacing the automatic pin; never-placed keep pins; `bestAnchor` prefers areas                                                                                 | 7, 9           |
| 5. Drawing, label, hover title, click opens photos from `from`, visibility rules                                                                                   | 9, 12          |
| 6. Offer bar after review accept and Make issue, layer picker same date first, result with Undo, matches one at a time, issue list right-click, strings in `en.ts` | 2, 10, 11, 12  |
| 7. Footprint matching, `suggestMatches`, change verdicts use it                                                                                                    | 5, 11          |
| 8. `place_on_model`, `add_sighting`, `create_issue_draft` `layer`, write risk                                                                                      | 6, 13          |
| 9. Make issue writes `on: 'pointcloud'`                                                                                                                            | 5              |
| Testing: unit list and the e2e flow                                                                                                                                | every task, 14 |

Placeholder scan: no "TBD", no "similar to Task N"; every code step has its code. Type names checked across tasks: `PlaceResult`, `PlaceScene`, `CloudPlaceOps`, `PhotoFrustum`, `LodFocus` (structurally the same as `PhotoFrustum`), `Prism` and `PrismQuery` (the same shape), `PlaceSummary`, `PlaceOutcome` (desktop store) and `PlaceOutcome` (ai hook type; only `agentHooks.ts` imports the ai one).

## Open risks

- **Pins made before this change have no `from`.** They are not recognised as automatic and stay beside a placed area (drawn only when the issue has no drawn area, so the view is still right); `issuePosition` in change may still read such a pin first. A one-off clean-up can be added later if founders see it.
- **Selections are not journalled or synced.** `selections/*.sel` sits beside `issues.json` but the M9 journal and the team sync carry only the journalled JSON files; a second reviewer's copy gets the `selection` sighting without its file. The prism still draws and matches. A blob or journal path for binary assets is a follow-up.
- **Placing waits for the 3D view.** With the stage on Map only, or a layer that never loads, every finding reports "did not load in the 3D view" after 15 s. The bar says so; it does not switch the stage to 3D itself.
- **Undo of the detection acceptance.** The assistant's `place_on_model` undo takes back the placement, not the acceptance of detections it accepted first (that stays one step earlier in the editor history, undoable from the review).
- **ODM principal point and distortion** do not reach `PhotoRef` (spec known limit): outlines can shift near photo edges; the e2e uses exact synthetic poses.
- **WARP timing.** Placing on a cloud waits up to 3 s per finding for refinement; on CI's software renderer the frames come slowly. The e2e allows 60 s per placement and the spec 300 s; run it with `--repeat-each=3` before the hand-off.

## How to test (for the founder)

1. Open **Demo change site (2 dates)** from Projects.
2. Go to **Detections**, draw or run a detection on a photo of the second date, and **Accept** it. Bottom right: "Connect 1 finding to a model?" with a layer list (the second date's mesh and point cloud first).
3. Pick the mesh and press **Place**. Expected: "Placed 1 of 1 on Site model ...", with **Undo**. In **Scene**, the finding is an outline on the model in its severity colour with its code at the centre; no pin.
4. Hover the outline: it lights up and shows the finding's title. Click it: the photo opens beside the 3D view on the photo it was found in, its box drawn.
5. In **Scene**, open the **Issues** tab, right-click the finding, **Place on model...**, pick the point cloud, **Place**: a box-shaped prism appears around the points.
6. Accept a detection of the same marker on a first-date photo and place it on the first date's mesh. Expected: "F.. looks like F.. from <date>" with **Same**, **Different**, **Skip all**. **Same** links both: the Changes view now pairs them.
7. Press **Undo** on a result: the outline goes and the pin comes back.
8. In the assistant panel ask "place F05 on the mesh": the panel asks for approval before anything changes.

## Execution handoff

Plan saved to `docs/plans/2026-10-15-findings-on-model.md`. Recommended: **subagent-driven** (superpowers:subagent-driven-development), one fresh implementer and one reviewer per task, batches as in the Execution DAG (B1 five tasks at once, B3 three), because the tasks meet only at the interfaces listed above and a wrong shared type would surface late in Task 11.
