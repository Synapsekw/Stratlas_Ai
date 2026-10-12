# Agent photo tools and the Globe in the compact profile: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent can start photo processing (`process_photos`, approved), read a run's accuracy (`accuracy_summary`), and small local models get the Globe and photo tools in the compact profile.

**Architecture:** Specs and executors live in `@aio/ai` (`photo-tool-specs.ts`, `photo-tools.ts`); the host work goes through two new optional `AppHooks` members (`processPhotos`, `photoRuns`), implemented by a new desktop module (`photogrammetry/agentHooks.ts`) that does what the **Create maps from photos** dialog does, and registered in `bootstrap.ts`. No `@aio/schema` change.

**Tech Stack:** TypeScript, zod 4, Vitest, Playwright with Electron, zustand.

**Spec:** `docs/plans/2026-10-12-m10-agent-photo-tools-design.md`

## Global Constraints

- Worktree `E:\Dev\AIO Software\.claude\worktrees\m10-agent-photo-tools`, branch `feat/m10-agent-photo-tools`. Never edit the main checkout; stage by path, never `git add -A`, never `git stash`, never `--no-verify`.
- No `@aio/schema` change. `AppHooks` stays in `packages/ai/src/tool-kit.ts`.
- Compact descriptions: at most 100 characters, no en or em dashes, equal to `COMPACT_TOOLS[name]`.
- Tool error texts are fixed sentences for the model (`ToolError`), plain English, no file paths of the person's photos.
- Electron windows stay off-screen in e2e (the fixtures do this); e2e runs with `--workers=1`, one Playwright run at a time.
- Commit messages: conventional commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no client, site or person names.

## Review Focus

- A project with two photos layers and no `layer` given: the tool must refuse with both ids and names, never pick one silently (Task 2 test "asks which layer when there are several").
- The person refuses the approval card: nothing starts (existing `approvalFor`; Task 1 test pins `approvalFor('process_photos') === true`, `accuracy_summary` false).
- Not enough disk on the data drive: the start is refused with the dialog's sentence before `jobs:start` is called (Task 3 test "refuses when the disk is short").
- A run that has no accuracy report yet (still aligning): `accuracy_summary` answers about the newest run with a report and names the newer one, or says "no accuracy report yet" when none has one (Task 2 tests).
- Ground control first: no products queued, so maps never start by themselves (Task 3 test "queues no products with ground control first").

## File structure

| File                                                                            | Responsibility                                                        | Task |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---- |
| `packages/ai/src/photo-tool-specs.ts` (new)                                     | zod inputs and `ToolSpec`s of `process_photos` and `accuracy_summary` | 1    |
| `packages/ai/src/tools.ts`                                                      | spread the photo specs into `BUILT_IN`; four `COMPACT_TOOLS` entries  | 1    |
| `packages/ai/src/tool-kit.ts`                                                   | `AppHooks.processPhotos`, `AppHooks.photoRuns` and their types        | 1    |
| `packages/ai/src/index.ts`                                                      | export the new hook types                                             | 1    |
| `packages/ai/src/tools.test.ts`                                                 | compact profile cap 28, the four names, risks                         | 1    |
| `packages/ai/src/photo-tools.ts` (new)                                          | executors of the two tools                                            | 2    |
| `packages/ai/src/photo-tools.test.ts` (new)                                     | their unit tests                                                      | 2    |
| `packages/ai/src/renderer-tools.ts`                                             | `import './photo-tools'`                                              | 2    |
| `apps/desktop/src/renderer/photogrammetry/agentHooks.ts` (new)                  | `agentProcessPhotos`, `agentPhotoRuns`                                | 3    |
| `apps/desktop/src/renderer/photogrammetry/agentHooks.test.ts` (new)             | their unit tests                                                      | 3    |
| `apps/desktop/src/renderer/bootstrap.ts`                                        | register the two hooks                                                | 3    |
| `apps/desktop/e2e/agent-photo.spec.ts` (new)                                    | the e2e                                                               | 4    |
| `apps/desktop/e2e/agent-eval.cases.ts`                                          | `accuracy_summary` in `READ_TOOLS`                                    | 4    |
| `docs/KNOWN-LIMITS.md`, `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md` | limits and follow-up status                                           | 4    |

## Execution DAG

```
T1 (ai: specs, hook types, compact)
 ├─> T2 (ai: executors)        ┐  batch 2, in parallel: no shared files
 └─> T3 (desktop: hooks)       ┘
        T2 + T3 ─> T4 (e2e, eval list, docs)
```

| Batch | Tasks  | Depends on | Shared files                                              |
| ----- | ------ | ---------- | --------------------------------------------------------- |
| 1     | T1     | none       | none                                                      |
| 2     | T2, T3 | T1         | none (T2: `packages/ai`; T3: `apps/desktop/src/renderer`) |
| 3     | T4     | T2, T3     | none                                                      |

Critical path: T1 -> T2 -> T4 (T3 is about as long as T2). Size: 4 tasks; T1 small, T2 medium, T3 medium, T4 medium (most of its time is the e2e run on the stand-in pipelines).

## Packages per task

| Task | Packages                   |
| ---- | -------------------------- |
| T1   | `@aio/ai`                  |
| T2   | `@aio/ai`                  |
| T3   | `@aio/desktop` (renderer)  |
| T4   | `@aio/desktop` (e2e), docs |

## Contract changes

None: no `@aio/schema` change, no new IPC channel, no file format change. No row for `docs/architecture/contract-changes.md`. `AppHooks` is an `@aio/ai` interface with two new optional members.

## Tests per task

| Task | Unit                                                                       | e2e                                                                                                          |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| T1   | `packages/ai/src/tools.test.ts` (compact profile, risks, specs registered) | none                                                                                                         |
| T2   | `packages/ai/src/photo-tools.test.ts` (new)                                | none                                                                                                         |
| T3   | `apps/desktop/src/renderer/photogrammetry/agentHooks.test.ts` (new)        | none                                                                                                         |
| T4   | none                                                                       | `agent-photo.spec.ts` (new); `agent-eval.cases.ts` (list only, the eval needs a real model and stays opt-in) |

---

### Task 1: Specs, hook types and the compact profile

**Files:**

- Create: `packages/ai/src/photo-tool-specs.ts`
- Modify: `packages/ai/src/tools.ts` (imports; `BUILT_IN` after `...SHOW_TOOL_SPECS`; `COMPACT_TOOLS`)
- Modify: `packages/ai/src/tool-kit.ts` (`AppHooks`, around line 87)
- Modify: `packages/ai/src/index.ts` (the `export { ... } from './renderer-tools'` block; add the types there if `renderer-tools.ts` re-exports `tool-kit` types, else export from `./tool-kit`)
- Test: `packages/ai/src/tools.test.ts`

**Interfaces:**

- Produces: `photoToolInputs` (`process_photos`, `accuracy_summary`), `PhotoToolName`, `PHOTO_TOOL_SPECS`; `ProcessPhotosRequest`, `ProcessPhotosStarted`, `PhotoRunRead`, `AppHooks.processPhotos`, `AppHooks.photoRuns`.

- [ ] **Step 1: Write the failing tests** in `tools.test.ts`

In `offers a short list with short descriptions in every window`, change the cap and its comment:

```ts
// 13 everyday tools, the four change tools (C1, every window), the four modelling
// tools (C5: 3D view, map and point cloud), the three show tools, the two Globe tools
// and the two photo tools
expect(compact.length, w).toBeLessThanOrEqual(28);
```

Add to the `compact tool profile` describe:

```ts
it('has the Globe and photo tools in every window', () => {
  for (const w of WindowKind.options)
    expect(names(w, 'compact'), w).toEqual(
      expect.arrayContaining(['list_sites', 'show_on_globe', 'process_photos', 'accuracy_summary']),
    );
});
```

And a new describe:

```ts
describe('photo tools', () => {
  it('asks before process_photos and not before accuracy_summary', () => {
    expect(getToolSpec('process_photos')?.meta).toMatchObject({ risk: 'write', scope: 'project' });
    expect(approvalFor('process_photos')).toBe(true);
    expect(getToolSpec('accuracy_summary')?.meta).toMatchObject({ risk: 'read', scope: 'project' });
    expect(approvalFor('accuracy_summary')).toBe(false);
  });

  it('fills the defaults of process_photos and refuses unknown fields', () => {
    expect(getToolSpec('process_photos')?.input.parse({})).toEqual({
      preset: 'standard',
      gnss: 'auto',
      groundControlFirst: false,
    });
    expect(() => getToolSpec('process_photos')?.input.parse({ folders: ['C:/x'] })).toThrow();
    expect(() => getToolSpec('process_photos')?.input.parse({ products: [] })).toThrow();
  });
});
```

(Import `approvalFor` and `getToolSpec` from `./tools` if the file does not already.)

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aio/ai exec vitest run src/tools.test.ts`
Expected: FAIL (no `process_photos` spec; compact list lacks the four names).

- [ ] **Step 3: Write `photo-tool-specs.ts`**

```ts
/**
 * Agent tools of maps from photos (M10 integration follow-up): specs only, shared by the main
 * process (offered to the model) and the renderer. Executors: `photo-tools.ts`; the host work
 * goes through `AppHooks.processPhotos` and `AppHooks.photoRuns`.
 */
import { PhotoPreset, PhotoProduct } from '@aio/schema';
import { z } from 'zod';
import type { ToolSpec } from './tools';

export const photoToolInputs = {
  process_photos: z
    .object({
      layer: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Photos layer id or name from list_layers; default the project's only photos layer",
        ),
      preset: PhotoPreset.default('standard').describe(
        'Quality: fast (quick look), standard, high (slowest, most detail)',
      ),
      gnss: z
        .enum(['auto', 'rtk', 'standard', 'ignore'])
        .default('auto')
        .describe('How far to trust the camera positions: auto reads the photos'),
      products: z
        .array(PhotoProduct)
        .min(1)
        .optional()
        .describe(
          'What to make: ortho, dsm, dtm, cloud, mesh, tiles; default the usual set for the quality',
        ),
      groundControlFirst: z
        .boolean()
        .default(false)
        .describe('True: stop after alignment so a person marks ground control points first'),
    })
    .strict(),
  accuracy_summary: z
    .object({
      run: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe('Run id; default the newest run that has an accuracy report'),
    })
    .strict(),
} as const;

export type PhotoToolName = keyof typeof photoToolInputs;

export const PHOTO_TOOL_SPECS: readonly ToolSpec[] = [
  {
    meta: {
      name: 'process_photos',
      description:
        'Create maps from a photos layer of the open project, as Create maps from photos does: align the photos with a quality preset, then build the maps (orthophoto, surface models, point cloud, 3D model) as layers when the alignment finishes. Runs for minutes to hours as a job; the app asks for approval first. Answers the run id and the time estimate.',
      scope: 'project',
      risk: 'write',
    },
    input: photoToolInputs.process_photos,
  },
  {
    meta: {
      name: 'accuracy_summary',
      description:
        'How accurate a photo run is: checkpoint and control point RMSE (horizontal and vertical, metres), reprojection error, ground sample distance, the ground control table (points, roles, residuals, marks) and the warnings of its accuracy report.',
      scope: 'project',
      risk: 'read',
    },
    input: photoToolInputs.accuracy_summary,
  },
];
```

- [ ] **Step 4: Wire into `tools.ts`**

Add `import { PHOTO_TOOL_SPECS } from './photo-tool-specs';`, then `...PHOTO_TOOL_SPECS,` after `...SHOW_TOOL_SPECS,` in `BUILT_IN`. In `COMPACT_TOOLS`, after the show tools:

```ts
  // M10: the Globe and maps from photos
  list_sites: 'List the sites of the project library on the Globe.',
  show_on_globe: 'Open the Globe at a site. Ends your reply: the panel closes.',
  process_photos: 'Make maps from a photos layer. Asks for approval first.',
  accuracy_summary: 'How accurate a photo run is: checkpoint RMSE and ground control.',
```

- [ ] **Step 5: Add the hook types to `tool-kit.ts`**

Above `export interface AppHooks`:

```ts
/** What `process_photos` asks the app to start (the dialog's simple flow, without the dialog). */
export interface ProcessPhotosRequest {
  layerId: string;
  preset: PhotoPreset;
  gnss: 'auto' | 'rtk' | 'standard' | 'ignore';
  products: PhotoProduct[];
  groundControlFirst: boolean;
}

/** What the app started: the run id, the time estimate in words, the survey date (or null). */
export interface ProcessPhotosStarted {
  run: string;
  estimate: string;
  surveyDate: string | null;
}

/** One run as `accuracy_summary` reads it. */
export interface PhotoRunRead {
  run: PhotoRun;
  accuracy: AccuracyReport | null;
  gcp: GcpFile | null;
}
```

Inside `AppHooks`:

```ts
  /** Start `photo.align` on a photos layer and queue its maps (throws a ToolError when refused). */
  processPhotos?: (req: ProcessPhotosRequest) => Promise<ProcessPhotosStarted>;
  /** The open project's photo runs (`photo:runs`, newest first) and one run with its report. */
  photoRuns?: {
    list: () => Promise<PhotoRunSummary[]>;
    read: (run: string) => Promise<PhotoRunRead>;
  };
```

Add the `@aio/schema` type imports (`AccuracyReport`, `GcpFile`, `PhotoPreset`, `PhotoProduct`, `PhotoRun`, `PhotoRunSummary`). Export `ProcessPhotosRequest`, `ProcessPhotosStarted`, `PhotoRunRead` from `index.ts` next to `type AppHooks`.

- [ ] **Step 6: Run, expect PASS**

Run: `pnpm --filter @aio/ai exec vitest run src/tools.test.ts src/main.test.ts src/show-tools.test.ts`
Expected: PASS. Then `pnpm --filter @aio/ai typecheck` (or `pnpm typecheck` at the root if the package has no script).

- [ ] **Step 7: Commit**

```bash
git add packages/ai/src/photo-tool-specs.ts packages/ai/src/tools.ts packages/ai/src/tool-kit.ts packages/ai/src/index.ts packages/ai/src/tools.test.ts
git commit -m "feat(ai): photo tool specs and the Globe and photo tools in the compact profile"
```

---

### Task 2: The executors

**Files:**

- Create: `packages/ai/src/photo-tools.ts`, `packages/ai/src/photo-tools.test.ts`
- Modify: `packages/ai/src/renderer-tools.ts` (add `import './photo-tools';` beside `import './collab-tools';`)

**Interfaces:**

- Consumes (Task 1): `photoToolInputs`, `PhotoToolName`, `AppHooks.processPhotos`, `AppHooks.photoRuns`, `ProcessPhotosStarted`, `PhotoRunRead`.
- Produces: registered renderer tools `process_photos`, `accuracy_summary`.

- [ ] **Step 1: Write the failing tests** (`photo-tools.test.ts`)

Build the context like `analysis-tools.test.ts` (`ctx(over, ws)` with `fixtureWorkspace()` and `fixtureManifest()` from `./test-fixtures`), opening a project whose manifest has photos layers:

```ts
import type { AccuracyReport, GcpFile, PhotoRun, PhotoRunSummary } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { runRendererTool, type RendererToolContext } from './renderer-tools';
import { fixtureManifest, fixtureWorkspace } from './test-fixtures';

const photos = (id: string, name: string) => ({ kind: 'photos' as const, id, name, items: [] });

function withLayers(layers: ReturnType<typeof photos>[]) {
  const ws = fixtureWorkspace();
  const m = fixtureManifest();
  ws.getState().openProject(
    { id: 'p1', root: 'E:/p1', manifest: { ...m, layers: [...m.layers, ...layers] } },
    [],
  );
  return ws;
}

function ctx(
  over: Partial<RendererToolContext> = {},
  ws = fixtureWorkspace(),
): RendererToolContext {
  return {
    workspace: ws,
    window: 'scene3d',
    scene: () => null,
    fetchJson: () => Promise.reject(new Error('HTTP 404')),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-12T12:00:00Z'),
    ...over,
  };
}

const started = { run: '20261012-1200', estimate: 'About 5 to 10 min', surveyDate: '2026-03-14' };

describe('process_photos', () => {
  it('starts the only photos layer with the dialog defaults', async () => {
    const processPhotos = vi.fn(() => Promise.resolve(started));
    const r = await runRendererTool(
      'process_photos',
      {},
      ctx({ app: { processPhotos } }, withLayers([photos('ph', 'Flight')])),
    );
    expect(processPhotos).toHaveBeenCalledWith({
      layerId: 'ph',
      preset: 'standard',
      gnss: 'auto',
      products: ['ortho', 'dsm', 'dtm', 'cloud', 'mesh'],
      groundControlFirst: false,
    });
    expect(r.summary).toBe('Run 20261012-1200 started');
    expect(r.result).toMatchObject({
      run: '20261012-1200',
      layer: 'ph',
      estimate: 'About 5 to 10 min',
    });
  });

  it('uses the fast products for the fast preset and keeps the products given', async () => {
    const processPhotos = vi.fn(() => Promise.resolve(started));
    const c = ctx({ app: { processPhotos } }, withLayers([photos('ph', 'Flight')]));
    await runRendererTool('process_photos', { preset: 'fast' }, c);
    expect(processPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({ products: ['ortho', 'dsm'] }),
    );
    await runRendererTool('process_photos', { products: ['cloud'] }, c);
    expect(processPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({ products: ['cloud'] }),
    );
  });

  it('finds a layer by name, case-insensitive', async () => {
    const processPhotos = vi.fn(() => Promise.resolve(started));
    const c = ctx(
      { app: { processPhotos } },
      withLayers([photos('a', 'North flight'), photos('b', 'South flight')]),
    );
    await runRendererTool('process_photos', { layer: 'south FLIGHT' }, c);
    expect(processPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ layerId: 'b' }));
  });

  it('asks which layer when there are several', async () => {
    const c = ctx(
      { app: { processPhotos: vi.fn() } },
      withLayers([photos('a', 'North flight'), photos('b', 'South flight')]),
    );
    await expect(runRendererTool('process_photos', {}, c)).rejects.toThrow(
      'This project has 2 photos layers. Say which one: a (North flight), b (South flight).',
    );
  });

  it('says what is missing: a photos layer, the named layer, the desktop app', async () => {
    const app = { processPhotos: vi.fn() };
    await expect(
      runRendererTool('process_photos', {}, ctx({ app }, withLayers([]))),
    ).rejects.toThrow('This project has no photos layer.');
    await expect(
      runRendererTool(
        'process_photos',
        { layer: 'x' },
        ctx({ app }, withLayers([photos('a', 'North flight')])),
      ),
    ).rejects.toThrow('No photos layer "x". The photos layers: a (North flight).');
    await expect(
      runRendererTool('process_photos', {}, ctx({}, withLayers([photos('a', 'A')]))),
    ).rejects.toThrow('Processing photos is only in the desktop app.');
  });
});
```

Accuracy tests, with fakes typed against the schema (fill required fields with the minimum; cast with `as PhotoRun` where the loose objects need more):

```ts
const summary = (
  id: string,
  status: PhotoRunSummary['status'],
  withAccuracy: boolean,
): PhotoRunSummary => ({
  id,
  createdAt: '2026-10-12T10:00:00Z',
  status,
  preset: 'standard',
  photos: 12,
  products: [],
  ...(withAccuracy ? { accuracy: { meanReprojPx: 0.7 } } : {}),
});

const report: AccuracyReport = {
  schema: 'aio.photo-accuracy/1',
  run: 'r1',
  createdAt: '2026-10-12T10:30:00Z',
  crs: { epsg: 32639 },
  gsdCm: 2.1,
  images: { total: 12, registered: 12 },
  meanReprojPx: 0.71234,
  points: [
    {
      id: 'G1',
      role: 'control',
      dxM: 0.01,
      dyM: 0.02,
      dzM: -0.03,
      reprojPx: 0.5,
      marks: 4,
      usedInAdjustment: true,
    },
    {
      id: 'C1',
      role: 'check',
      dxM: 0.03,
      dyM: 0.04,
      dzM: 0.05,
      reprojPx: 0.6,
      marks: 3,
      usedInAdjustment: false,
    },
  ],
  rmse: {
    control: { n: 1, horizontalM: 0.02236, verticalM: 0.03 },
    check: { n: 1, horizontalM: 0.05, verticalM: 0.05 },
  },
  checkpointsInAdjustment: false,
  warnings: [{ code: 'few-marks', message: 'C1 has 3 marks.', point: 'C1' }],
};
```

Test cases (each a separate `it`):

1. `'reads the newest run with a report by default'`: `list` answers `[summary('r2','aligning',false), summary('r1','adjusted',true)]`; `read('r1')` answers `{ run, accuracy: report, gcp }` with a `gcp` of two points (`G1` control, `C1` check, one `disabled: true` third point `G2`). Expect `read` called with `'r1'`; `result.accuracy.check` equals `{ n: 1, horizontalM: 0.05, verticalM: 0.05 }`; `result.accuracy.basis` is `'ground control'`; `result.accuracy.meanReprojPx` is `0.71`; `result.gcp` is `{ control: 2, check: 1, disabled: 1, marked: 2, points: [...] }` with `points[0].id === 'C1'` (worst horizontal first, `horizontalM: 0.05`); `result.otherRuns` is `[{ id: 'r2', status: 'aligning', createdAt: ... }]`; `summary` is `'Check RMSE 0.050 m horizontal, 0.050 m vertical (1 point)'`.
2. `'says GNSS only without control points'`: report with `rmse: {}` and `points: []`; `basis` `'GNSS only'`, `summary` `'GNSS only'`.
3. `'answers about a run without a report'`: list `[summary('r2','aligning',false)]`, `read` answers `accuracy: null, gcp: null`; `result.accuracy` null, `result.note` `'Run r2 is aligning: it has no accuracy report yet.'`, summary `'r2: aligning, no accuracy report yet'`.
4. `'reads the run asked for, and lists the ids of a wrong one'`: `{ run: 'r2' }` reads `r2`; `{ run: 'nope' }` rejects with `'No photo run "nope". The runs: r2, r1.'`.
5. `'says when there are no runs, or no desktop app'`: list `[]` rejects with `'No photo runs in this project yet. Use process_photos to start one.'`; without `photoRuns` rejects with `'Photo runs are only read in the desktop app.'`.
6. `'caps the points at 30 and the warnings at 10'`: 40 points, 15 warnings in the report; lengths 30 and 10.

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aio/ai exec vitest run src/photo-tools.test.ts`
Expected: FAIL with `The tool "process_photos" is not available in this window.`

- [ ] **Step 3: Write `photo-tools.ts`**

```ts
/**
 * Executors of the photo tools (M10 integration follow-up): `process_photos` starts a run the way
 * Create maps from photos does, through `AppHooks.processPhotos`; `accuracy_summary` reads a run
 * and its accuracy report through `AppHooks.photoRuns`.
 */
import type {
  AccuracyReport,
  GcpFile,
  PhotoPreset,
  PhotoProduct,
  PhotoRunSummary,
} from '@aio/schema';
import { photoToolInputs, type PhotoToolName } from './photo-tool-specs';
import {
  plural,
  project,
  registerRendererTool,
  ToolError,
  type RendererToolContext,
  type ToolRunResult,
} from './tool-kit';

/** The dialog's products for a quality (`defaultProducts` in the desktop's estimate.ts). */
export function defaultPhotoProducts(preset: PhotoPreset): PhotoProduct[] {
  return preset === 'fast' ? ['ortho', 'dsm'] : ['ortho', 'dsm', 'dtm', 'cloud', 'mesh'];
}

function define<N extends PhotoToolName>(
  name: N,
  run: (
    input: ReturnType<(typeof photoToolInputs)[N]['parse']>,
    ctx: RendererToolContext,
  ) => Promise<ToolRunResult>,
): void {
  registerRendererTool(name, (input, ctx) =>
    run(
      photoToolInputs[name].parse(input) as ReturnType<(typeof photoToolInputs)[N]['parse']>,
      ctx,
    ),
  );
}

const mm = (n: number) => Math.round(n * 1000) / 1000;
const named = (l: { id: string; name: string }) => `${l.id} (${l.name})`;

define('process_photos', async (input, ctx) => {
  const layers = project(ctx).manifest.layers.filter((l) => l.kind === 'photos');
  if (!layers.length)
    throw new ToolError(
      'This project has no photos layer. Import photos first, or use Create maps from photos in the Builder to read a folder.',
    );
  let layer = layers.length === 1 ? layers[0] : undefined;
  if (input.layer) {
    const want = input.layer.trim().toLowerCase();
    layer =
      layers.find((l) => l.id.toLowerCase() === want) ??
      layers.find((l) => l.name.toLowerCase() === want);
    if (!layer)
      throw new ToolError(
        `No photos layer "${input.layer}". The photos layers: ${layers.map(named).join(', ')}.`,
      );
  }
  if (!layer)
    throw new ToolError(
      `This project has ${String(layers.length)} photos layers. Say which one: ${layers.map(named).join(', ')}.`,
    );
  const start = ctx.app?.processPhotos;
  if (!start) throw new ToolError('Processing photos is only in the desktop app.');
  const products = input.products ?? defaultPhotoProducts(input.preset);
  const s = await start({
    layerId: layer.id,
    preset: input.preset,
    gnss: input.gnss,
    products,
    groundControlFirst: input.groundControlFirst,
  });
  return {
    result: {
      run: s.run,
      layer: layer.id,
      preset: input.preset,
      gnss: input.gnss,
      products,
      groundControlFirst: input.groundControlFirst,
      estimate: s.estimate,
      surveyDate: s.surveyDate,
      note: input.groundControlFirst
        ? 'The photos are being aligned. The maps wait until a person marks the ground control points in the run (Create maps from photos). Progress shows in Jobs. Use accuracy_summary afterwards.'
        : 'The photos are being aligned; the maps start by themselves when that finishes and come in as layers. Progress shows in Jobs and under Create maps from photos. Use accuracy_summary afterwards.',
    },
    summary: `Run ${s.run} started`,
  };
});
```

`accuracy_summary` in the same file (helpers kept small and pure):

```ts
const rmse = (r: { n: number; horizontalM: number; verticalM: number } | undefined) =>
  r ? { n: r.n, horizontalM: mm(r.horizontalM), verticalM: mm(r.verticalM) } : null;

function gcpTable(gcp: GcpFile | null, report: AccuracyReport | null) {
  if (!gcp) return null;
  const active = gcp.points.filter((p) => !p.disabled);
  const rows = (report?.points ?? []).map((p) => ({
    id: p.id,
    role: p.role,
    dxM: mm(p.dxM),
    dyM: mm(p.dyM),
    dzM: mm(p.dzM),
    horizontalM: mm(Math.hypot(p.dxM, p.dyM)),
    marks: p.marks,
    used: p.usedInAdjustment ?? null,
  }));
  rows.sort((a, b) => b.horizontalM - a.horizontalM);
  return {
    control: gcp.points.filter((p) => p.role === 'control').length,
    check: gcp.points.filter((p) => p.role === 'check').length,
    disabled: gcp.points.length - active.length,
    marked: active.filter((p) => p.marks.length > 0).length,
    points: rows.slice(0, 30),
  };
}

function pickRun(runs: readonly PhotoRunSummary[], asked: string | undefined): PhotoRunSummary {
  if (!runs.length)
    throw new ToolError('No photo runs in this project yet. Use process_photos to start one.');
  if (asked) {
    const hit = runs.find((r) => r.id === asked);
    if (!hit)
      throw new ToolError(
        `No photo run "${asked}". The runs: ${runs
          .slice(0, 20)
          .map((r) => r.id)
          .join(', ')}.`,
      );
    return hit;
  }
  return runs.find((r) => r.accuracy) ?? (runs[0] as PhotoRunSummary);
}

define('accuracy_summary', async (input, ctx) => {
  project(ctx);
  const runs = ctx.app?.photoRuns;
  if (!runs) throw new ToolError('Photo runs are only read in the desktop app.');
  const chosen = pickRun(await runs.list(), input.run);
  const all = await runs.list();
  const { run, accuracy, gcp } = await runs.read(chosen.id);
  const otherRuns = all
    .filter((r) => r.id !== chosen.id)
    .slice(0, 5)
    .map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt }));
  const base = {
    run: run.id,
    status: run.status,
    preset: run.preset,
    createdAt: run.createdAt,
    photos: { count: run.photos.count, registered: run.photos.registered ?? null },
  };
  if (!accuracy)
    return {
      result: {
        ...base,
        accuracy: null,
        gcp: gcpTable(gcp, null),
        warnings: [],
        otherRuns,
        note: `Run ${run.id} is ${run.status}: it has no accuracy report yet.`,
      },
      summary: `${run.id}: ${run.status}, no accuracy report yet`,
    };
  const check = rmse(accuracy.rmse.check);
  const control = rmse(accuracy.rmse.control);
  const basis = control && control.n > 0 ? 'ground control' : 'GNSS only';
  return {
    result: {
      ...base,
      accuracy: {
        basis,
        check,
        control,
        meanReprojPx: Math.round(accuracy.meanReprojPx * 100) / 100,
        gsdCm: accuracy.gsdCm ?? null,
        cameraResiduals: accuracy.cameraResiduals ?? null,
      },
      gcp: gcpTable(gcp, accuracy),
      warnings: accuracy.warnings.slice(0, 10).map((w) => ({ code: w.code, message: w.message })),
      otherRuns,
    },
    summary:
      check && check.n > 0
        ? `Check RMSE ${check.horizontalM.toFixed(3)} m horizontal, ${check.verticalM.toFixed(3)} m vertical (${plural(check.n, 'point')})`
        : basis,
  };
});
```

Call `runs.list()` once (store it; the snippet above shows the intent, reuse one `all` for `pickRun` and `otherRuns`). Read the hooks from `ctx.app` only, as `analysis-tools.ts` does (`defaultToolContext` supplies the registered hooks).

- [ ] **Step 4: Register**: add `import './photo-tools';` to `renderer-tools.ts` beside `import './collab-tools';`.

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm --filter @aio/ai exec vitest run src/photo-tools.test.ts src/tools.test.ts`
Expected: PASS. Then `pnpm --filter @aio/ai test` and the package typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/ai/src/photo-tools.ts packages/ai/src/photo-tools.test.ts packages/ai/src/renderer-tools.ts
git commit -m "feat(ai): process_photos and accuracy_summary executors"
```

---

### Task 3: The desktop hooks

**Files:**

- Create: `apps/desktop/src/renderer/photogrammetry/agentHooks.ts`, `apps/desktop/src/renderer/photogrammetry/agentHooks.test.ts`
- Modify: `apps/desktop/src/renderer/bootstrap.ts` (inside the existing `registerAppHooks({ ... })` call, after `showOnGlobe`)

**Interfaces:**

- Consumes (Task 1): `ProcessPhotosRequest`, `ProcessPhotosStarted`, `PhotoRunRead`, `ToolError` from `@aio/ai`. Existing: `startAlign` (`actions.ts`), `newRunId`, `diskNeed`, `formatMinutes` (`estimate.ts`), `daysOfItems`, `pickSurveyDate`, `pickParams` (`surveyDate.ts`), `photoUi` (`store.ts`), `bridge` (`../shell`), `workspace` (`@aio/workspace`).
- Produces: `agentProcessPhotos(req: ProcessPhotosRequest): Promise<ProcessPhotosStarted>`, `agentPhotoRuns: NonNullable<AppHooks['photoRuns']>`.

- [ ] **Step 1: Write the failing tests** (`agentHooks.test.ts`), mocking as `actions.test.ts` does

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
const project = {
  id: 'p1',
  root: 'D:/Projects/site',
  manifest: {
    crs: { epsg: 32639 },
    captures: [{ id: 'c1', label: 'Survey', date: '2026-10-01' }],
    layers: [
      {
        kind: 'photos',
        id: 'ph',
        name: 'Flight',
        items: [{ takenAt: '2026-03-14T10:00:00' }, { takenAt: '2026-03-14T10:01:00' }],
      },
    ],
  },
};
vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) as unknown },
  jobs: { getState: () => ({ refresh: () => Promise.resolve() }) },
}));
vi.mock('@aio/workspace', () => ({ workspace: { getState: () => ({ project }) } }));

import { agentPhotoRuns, agentProcessPhotos } from './agentHooks';
import { photoUi } from './store';

const ok = (value: unknown) =>
  Promise.resolve({ ok: true, value: { ok: true, ...(value as object) } });
const estimate = { minutes: [5, 10], notes: [] };
const req = {
  layerId: 'ph',
  preset: 'standard',
  gnss: 'auto',
  products: ['ortho', 'dsm'],
  groundControlFirst: false,
} as const;

function answer(over: Record<string, unknown> = {}) {
  call.mockImplementation((channel: string) => {
    if (channel in over) return Promise.resolve(over[channel]);
    if (channel === 'photo:estimate') return ok({ estimate });
    if (channel === 'photo:runs') return ok({ runs: [] });
    if (channel === 'jobs:start') return ok({});
    throw new Error(`unexpected ${channel}`);
  });
}

beforeEach(() => {
  call.mockReset();
  photoUi.setState({ pending: {}, dates: {} });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 12, 12, 0));
});
```

Cases:

1. `'starts photo.align on the layer and queues the maps under the photos day'`: `answer()`; result `{ run: '20261012-1200', estimate: 'About 5 to 10 min', surveyDate: '2026-03-14' }` (use whatever `formatMinutes([5, 10])` returns: assert `estimate` equals `formatMinutes([5, 10])` imported from `./estimate`); the `jobs:start` call is `{ pipeline: 'photo.align', project: 'D:/Projects/site', params: { photos: { layer: 'ph' }, run: '20261012-1200', preset: 'standard', gnss: 'auto' } }`; `photoUi.getState().pending['20261012-1200']` equals `{ root: 'D:/Projects/site', preset: 'standard', products: ['ortho', 'dsm'], captureDate: '2026-03-14' }`; `dates[run]` equals `{ captureDate: '2026-03-14' }`.
2. `'picks the next free run id'`: `photo:runs` answers runs `[{ id: '20261012-1200' }]`; run is `'20261012-1200-2'`.
3. `'queues no products with ground control first'`: `groundControlFirst: true`; `pending` has no entry; `dates[run]` is set.
4. `'refuses when the disk is short'`: estimate notes `['Needs 40 GB free on the data drive, has 12 GB. Free some space.']`; rejects with a message containing `Needs 40 GB free on the data drive, has 12 GB`; no `jobs:start` call.
5. `'refuses a layer with nothing to process'`: estimate minutes `[0, 0]`; rejects with `'There are no photos to process in this layer.'`.
6. `'passes on a refused start'`: `jobs:start` answers `{ ok: true, value: { ok: false, error: 'Processing photos needs the pipeline pack.' } }`; rejects with that sentence; nothing queued.
7. `'refuses without an open project, or with a layer that is gone'`: layer id `'gone'` rejects with `'The photos layer "gone" is not in the open project.'`.
8. `'reads the runs and one run with its control points'`: `photo:runs` answers runs; `photo:readRun` answers `{ run: R, accuracy: A }`; `photo:readGcp` answers `{ gcp: G }`; `agentPhotoRuns.list()` resolves the runs and called `photo:runs` with `{ projectId: 'p1' }`; `agentPhotoRuns.read('r1')` resolves `{ run: R, accuracy: A, gcp: G }`. A refused `photo:readRun` (`{ ok: false, error: 'boom' }` at the transport level) rejects with `'boom'`.

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/photogrammetry/agentHooks.test.ts`
Expected: FAIL (module `./agentHooks` not found).

- [ ] **Step 3: Write `agentHooks.ts`**

```ts
/**
 * The agent's photo tools on the app side (`AppHooks.processPhotos`, `AppHooks.photoRuns`):
 * `process_photos` starts a run as **Create maps from photos** does in its simple flow (the
 * estimate's disk check, a new run id, `photo.align`, the survey date picked from the photos, the
 * maps queued unless ground control comes first); `accuracy_summary` reads runs through main.
 * Refusals are thrown as ToolErrors with main's sentence.
 */
import {
  ToolError,
  type AppHooks,
  type ProcessPhotosRequest,
  type ProcessPhotosStarted,
} from '@aio/ai';
import { workspace } from '@aio/workspace';
import { bridge } from '../shell';
import { startAlign } from './actions';
import { diskNeed, formatMinutes, newRunId } from './estimate';
import { photoUi } from './store';
import { daysOfItems, pickParams, pickSurveyDate } from './surveyDate';

type Answer<T> =
  | { ok: true; value: ({ ok: true } & T) | { ok: false; error: string } }
  | { ok: false; error: string };

function value<T>(r: Answer<T>): T {
  if (!r.ok) throw new ToolError(r.error);
  if (!r.value.ok) throw new ToolError(r.value.error);
  return r.value;
}

function openProject() {
  const p = workspace.getState().project;
  if (!p) throw new ToolError('No project is open.');
  return p;
}

export async function agentProcessPhotos(req: ProcessPhotosRequest): Promise<ProcessPhotosStarted> {
  const project = openProject();
  const layer = project.manifest.layers.find((l) => l.kind === 'photos' && l.id === req.layerId);
  if (!layer || layer.kind !== 'photos')
    throw new ToolError(`The photos layer "${req.layerId}" is not in the open project.`);
  const photos = { layer: layer.id };
  const { estimate } = value(
    await bridge.call('photo:estimate', {
      projectId: project.id,
      photos,
      preset: req.preset,
      products: req.products,
    }),
  );
  const disk = diskNeed(estimate);
  if (disk)
    throw new ToolError(
      `Needs ${disk.needs} free on the data drive, has ${disk.has}. Free some space, then try again.`,
    );
  if (estimate.minutes[1] === 0)
    throw new ToolError('There are no photos to process in this layer.');
  const { runs } = value(await bridge.call('photo:runs', { projectId: project.id }));
  const run = newRunId(
    new Date(),
    runs.map((r) => r.id),
  );
  const err = await startAlign({
    root: project.root,
    run,
    photos,
    preset: req.preset,
    gnss: req.gnss,
  });
  if (err) throw new ToolError(err);
  const pick = pickSurveyDate(daysOfItems(layer.items), project.manifest.captures, layer.capture);
  const date = pickParams(pick);
  const ui = photoUi.getState();
  ui.setDate(run, date);
  if (!req.groundControlFirst)
    ui.setPending(run, { root: project.root, preset: req.preset, products: req.products, ...date });
  return {
    run,
    estimate: formatMinutes(estimate.minutes),
    surveyDate: pick.kind === 'none' ? null : pick.date,
  };
}

export const agentPhotoRuns: NonNullable<AppHooks['photoRuns']> = {
  list: async () => value(await bridge.call('photo:runs', { projectId: openProject().id })).runs,
  read: async (run) => {
    const projectId = openProject().id;
    const [r, g] = await Promise.all([
      bridge.call('photo:readRun', { projectId, run }),
      bridge.call('photo:readGcp', { projectId, run }),
    ]);
    const { run: file, accuracy } = value(r);
    return { run: file, accuracy, gcp: value(g).gcp };
  },
};
```

Notes for the implementer: `DatePick` carries `date` on both `existing` and `new`. Adjust the `Answer` type to the real `bridge.call` result type (`../shell`) rather than redefining it, if one is exported. Check the disk sentence the dialog shows (`ProcessWizard.tsx`, search `disk`) and reuse its words.

- [ ] **Step 4: Register in `bootstrap.ts`**

```ts
import { agentPhotoRuns, agentProcessPhotos } from './photogrammetry/agentHooks';
```

and in `registerAppHooks({ ... })`, after `showOnGlobe`:

```ts
    // M10 maps from photos: process_photos and accuracy_summary
    processPhotos: agentProcessPhotos,
    photoRuns: agentPhotoRuns,
```

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/photogrammetry/agentHooks.test.ts src/renderer/photogrammetry/actions.test.ts`
Expected: PASS. Then `pnpm --filter @aio/desktop typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/photogrammetry/agentHooks.ts apps/desktop/src/renderer/photogrammetry/agentHooks.test.ts apps/desktop/src/renderer/bootstrap.ts
git commit -m "feat(desktop): app hooks for the agent's photo tools"
```

---

### Task 4: End to end, eval list and docs

**Files:**

- Create: `apps/desktop/e2e/agent-photo.spec.ts`
- Modify: `apps/desktop/e2e/agent-eval.cases.ts` (`READ_TOOLS`: add `'accuracy_summary'` after `'list_sites'`)
- Modify: `docs/KNOWN-LIMITS.md` (Globe section: replace "The Globe tools are not in the compact tool profile." with nothing more than the first sentence; add under the processing section: "The agent's **process_photos** reads a photos layer only (no folders), takes the project's coordinate system and picks the survey date as the dialog does by itself.")
- Modify: `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md` (Integration follow-ups, Agent bullet: append "Done 12 Oct 2026 (`docs/plans/2026-10-12-m10-agent-photo-tools.md`).")

**Interfaces:**

- Consumes: Tasks 2 and 3 (the tools work in the app); e2e helpers `photoFixtures`, `openPhotoSite`, `PHOTO_PLATFORM`, `PHOTO_PLATFORM_ONLY` (`photoPack.ts`), `test`, `expect`, `hasPipelinePython`, `VENV_PYTHON` (`fixtures.ts`).

- [ ] **Step 1: Write the spec**

```ts
/**
 * The agent's photo tools end to end (M10 integration follow-up), with the scripted test model
 * (`#tool` lines) on the stand-in pipelines: process_photos asks for approval, starts a run on
 * the project's photos layer, the maps come back as layers by themselves, then accuracy_summary
 * reads that run (GNSS only, no ground control). Synthetic photos only; zero network.
 */
import type { Page } from '@playwright/test';
import { expect, hasPipelinePython, test as plain, VENV_PYTHON } from './fixtures';
import {
  openPhotoSite,
  PHOTO_PLATFORM,
  PHOTO_PLATFORM_ONLY,
  photoFixtures,
  type PhotoFixtures,
  type PhotoWorkerFixtures,
} from './photoPack';

const test = plain.extend<PhotoFixtures, PhotoWorkerFixtures>({
  ...photoFixtures,
  // the photo pack and the scripted model
  appEnv: async ({ photoPackEnv, photoSite }, use) => {
    expect(photoSite.dir).toBeTruthy();
    await use({ ...photoPackEnv, QUADRION_AI_TEST_PROVIDER: '1' });
  },
});

const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });

async function send(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled({ timeout: 60_000 });
  await box.fill(text);
  await box.press('Enter');
  // the first send shows what leaves the machine
  const preview = win.getByRole('dialog', { name: /Send to/ });
  if (await preview.isVisible().catch(() => false))
    await preview.getByRole('button', { name: 'Send' }).click();
}

const layers = (win: Page) =>
  win.evaluate(
    () =>
      (
        window as unknown as {
          __stratlas: {
            workspace: {
              getState: () => { project?: { manifest: { layers: { kind: string }[] } } };
            };
          };
        }
      ).__stratlas.workspace
        .getState()
        .project?.manifest.layers.map((l) => l.kind) ?? [],
  );

test.describe('agent photo tools on the stand-in pipelines', () => {
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  test.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);

  test('process_photos asks, starts a run whose maps come back, accuracy_summary reads it', async ({
    win,
  }) => {
    test.setTimeout(240_000);
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await openPhotoSite(win);

    await send(win, 'make maps from the photos #tool process_photos {"preset":"fast"}');
    await agent(win).getByRole('button', { name: 'Approve' }).click();
    await expect(agent(win)).toContainText(/Run \d{8}-\d{4}(-\d+)? started/, { timeout: 60_000 });

    // the maps start by themselves after alignment and come in as layers (fast: ortho and DSM)
    await expect
      .poll(async () => (await layers(win)).filter((k) => k === 'raster').length, {
        timeout: 150_000,
      })
      .toBeGreaterThanOrEqual(2);

    await send(win, 'how accurate is it #tool accuracy_summary {}');
    await expect(agent(win)).toContainText('Tool accuracy_summary returned', { timeout: 60_000 });
    await expect(agent(win)).toContainText('GNSS only');
  });

  test('a refused approval starts nothing', async ({ win }) => {
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await openPhotoSite(win);
    await send(win, 'make maps #tool process_photos {}');
    await agent(win)
      .getByRole('button', { name: /Decline|Refuse|Deny/ })
      .click();
    expect(
      await win.evaluate(() => window.aio.invoke('photo:runs', { projectId: 'e2e-photos' })),
    ).toMatchObject({
      ok: true,
      value: { ok: true, runs: [] },
    });
  });
});
```

Before running, check against the existing specs and fix the spec to match what the app does: the approval buttons' names (`agent.spec.ts` uses `Approve`; find the refuse button in `packages/ai/src/AgentPanel.tsx`), the scripted reply text after a tool result (`scripted.ts`, `lastToolResult`: the step chip shows the summary, the reply says `Tool <name> returned ...`), which layer kinds the stand-ins add for `fast` (`photo-process.spec.ts`, after "Your maps are ready"), whether `window.aio.invoke` is reachable from `win.evaluate` in these fixtures, and the `Probe` type the photo specs use for `__stratlas` (reuse it instead of the inline cast).

- [ ] **Step 2: Run the way CI runs it**

From the worktree, once: `pnpm demo:build --quick` (worktrees have no `python/.venv`: set `QUADRION_E2E_PYTHON` to the main checkout's venv python and pass `--python` to `demo:build`, see the e2e-in-a-worktree note in CONTRIBUTING.md). Then from `apps/desktop`:

```bash
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 QUADRION_E2E_SCALE=1 pnpm exec playwright test e2e/agent-photo.spec.ts --workers=1
```

Expected: 2 passed (or skipped with the platform or Python reason on a machine without them; a skip is not a pass for the hand-off).

- [ ] **Step 3: Eval list and docs**: apply the `agent-eval.cases.ts`, `KNOWN-LIMITS.md` and M10 plan edits listed above. Run `pnpm format:check` (prettier `--write` the touched files if needed) and `node tools/agent/check-public-text.mjs docs/KNOWN-LIMITS.md docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`.

- [ ] **Step 4: Full check**: `pnpm check` green in the worktree.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/agent-photo.spec.ts apps/desktop/e2e/agent-eval.cases.ts docs/KNOWN-LIMITS.md docs/plans/2026-10-07-m10-globe-and-photogrammetry.md
git commit -m "test(e2e): the agent starts photo processing and reads its accuracy"
```

---

## How to test (for the founder)

1. Install the build from this branch (or run it from the worktree) with the pipeline pack installed and the agent switched on (Settings, AI).
2. Open a project that has a photos layer (or import a folder of drone photos into a project first: Builder, **Import files**).
3. In the Scene, open the agent panel on the right and type: "Make maps from the photos, fast quality."
4. An approval card appears for **process_photos** with the layer, quality and products. Click **Approve**.
5. The agent answers with the run id and how long it should take. Open **Jobs** (or Builder, **Create maps from photos**): the run is aligning. When the photos are matched, the maps start by themselves; when they finish, the orthophoto and surface model appear as layers, exactly as when you start from the dialog.
6. Ask the agent: "How accurate is that run?" It answers with the reprojection error and says the accuracy is from GNSS only (no ground control yet). After you mark ground control points and click **Adjust** in the run, ask again: it gives the checkpoint RMSE (horizontal and vertical, in metres) and the worst points, matching the run's **Accuracy** tab.
7. Try "Make maps, but I want to mark ground control first": the run aligns and stops; no maps start until you mark the points and continue in the run panel.
8. Click **Decline** on a **process_photos** card: no run starts.
9. With a small local model (Settings, AI, local model with the compact tool profile), ask "Show the sites on the Globe": the agent can now use **list_sites** and **show_on_globe** (the Globe opens and the agent panel closes with the project view, as before).

## Self-review

- Spec coverage: `process_photos` (T1 spec, T2 executor, T3 host), `accuracy_summary` (T1, T2, T3), compact profile (T1), errors and edge cases (T2 and T3 tests, Review Focus), e2e (T4), docs and limits (T4), decisions (spec). No contract change, stated.
- Names used across tasks: `ProcessPhotosRequest`, `ProcessPhotosStarted`, `PhotoRunRead`, `AppHooks.processPhotos`, `AppHooks.photoRuns.{list,read}`, `photoToolInputs`, `PHOTO_TOOL_SPECS`, `agentProcessPhotos`, `agentPhotoRuns`, `defaultPhotoProducts`: consistent.
- Execution method: subagent-driven, batches as in the DAG (T2 and T3 in one message).
