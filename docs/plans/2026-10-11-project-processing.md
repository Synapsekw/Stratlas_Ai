# Processing belongs to the project: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the machine-wide Jobs screen with a **Processing** chip and drawer that belong to the open project, start work where it lives, and move the raw pipeline forms to Settings.

**Architecture:** A new renderer folder `apps/desktop/src/renderer/processing/` holds pure rules (`model.ts`, `pipelines.ts`), a small UI store (`store.ts`) and the views. The job list, job details and pipeline form are moved out of `screens/Jobs.tsx` into shared components, used by the drawer and by a folded **Advanced** section in Settings, Processing tools. Then the Jobs screen and its nav item are removed. The main process, `@aio/schema` and the Python pack do not change.

**Tech Stack:** TypeScript strict, React 18, zustand vanilla stores, Vitest (jsdom for components), Playwright with Electron.

**Spec:** `docs/plans/2026-10-11-project-processing-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Work only in the worktree `.claude/worktrees/project-processing` on branch `feat/project-processing`. Never edit the main checkout. Never run a bare `git stash`.
- TypeScript strict: no `any`, no non-null assertions (`!`).
- Renderer code never imports `electron` or `node:*`.
- No em or en dashes in user-facing text. The middle dot `·` is allowed (the app already uses it).
- The word for the feature is **Processing**. The word "Jobs" must not remain in user-facing text, except "job" for one unit of processing (a row), which stays.
- New user-facing strings go through the message catalogue (`packages/ui/src/i18n/en.ts`, read with `t()`). Strings inside components that are only moved stay as they are.
- No change to `packages/schema`, to IPC channels, to `apps/desktop/src/main` or to `python/`. If a task seems to need one, stop and report: it would be a contract change.
- Keep these DOM hooks exactly, because end to end specs use them: `.job-row`, `[data-job]`, `[data-status]`, `.job-detail`, `.job-log`, `#job-pipeline`, `#job-f-<key>`, `data-testid="job-start"`, `data-testid="job-advanced"`, `data-testid="create-maps"`, `data-testid="photo-runs"`.
- Do not edit the contents of `apps/desktop/src/renderer/photogrammetry/` (another branch owns it). `PhotoRuns` is rendered as it is; `photoUi.getState().openWizard()` and `openRun()` are called as they are.
- Public repo: no client, site, tester or person names in code, docs or commit messages.
- Conventional commits, body lines at most 100 characters, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Local test load (founder's instruction): end to end runs use `--workers=1`, one run at a time on the workstation. Never run two Playwright runs at once.

Commands, all from the worktree root unless a step says otherwise:

- One unit test file: `pnpm exec vitest run <path> --retry=0`
- Types: `pnpm typecheck`
- Everything: `pnpm check`
- One end to end spec the way CI runs it, from `apps/desktop`:
  `pnpm exec electron-vite build` once after renderer changes, then
  `QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/<spec>.spec.ts --workers=1`

## Review Focus

Inputs the spec implies but no single task obviously owns. Each has a test in the task named.

1. **The same project folder spelled differently** (`D:\Sites\A`, `d:/sites/a/`): its jobs must still count as this project's. Test in Task 3 (`projectJobs`).
2. **Old failures from earlier sessions**: opening a project with a failed job from last week must not light the chip; a job that was interrupted by quitting must. Test in Task 3 (`needsAttention`).
3. **A read-only package is open while another project is processing**: the chip shows "running elsewhere", the drawer has no start button and no list of its own. Tests in Task 3 (`chipState`) and Task 7 (`DrawerList`).
4. **A pipeline the app does not know** (a newer pack): its row still renders, tagged System. Test in Task 2 (`jobKind`).
5. **The picked job disappears** (the index keeps 500 jobs; the project is switched while details are open): the drawer falls back to the list, never a blank panel, and never another project's job under this project's name. Test in Task 3 (`shownJob`), used in Task 8.

## Execution DAG

```
T1 messages
 ├─ T2 pipelines + kinds ─┐
 ├─ T3 model ─────────────┤
 └─ T4 ui store ──────────┤
                          T5 shared parts out of Jobs.tsx
                          ├─ T6 chip
                          ├─ T7 drawer list (pure view)
                          └─ T9 Settings, Advanced
                             T8 drawer container + start dialog   (needs T6, T7)
                             T10 shell wiring, Jobs screen removed (needs T8, T9)
                             T11 entry points and wording          (needs T10)
                             ├─ T12 e2e helpers + processing-drawer.spec
                             │   └─ T13 changed e2e specs
                             └─ T14 guide
                                T15 full check, CI-way e2e, hand-off (needs T13, T14)
```

Parallel batches (no shared files inside a batch; dispatch each batch in one message):

| Batch | Tasks                              | Notes                                                                                                                          |
| ----- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A     | T1                                 | alone: every later task reads its message keys                                                                                 |
| B     | T2, T3, T4                         | three new files each with its test; T3 also exports two helpers from `jobs.ts`                                                 |
| C     | T5                                 | alone: it splits `screens/Jobs.tsx`                                                                                            |
| D     | T6, T7, T9                         | new files only, except T9 adds one line to `screens/settings/ProcessingTools.tsx`                                              |
| E     | T8                                 | alone                                                                                                                          |
| F     | T10                                | alone: the shell files                                                                                                         |
| G     | T11                                | alone: entry points; shares `en.ts` with nobody                                                                                |
| H     | T12 then T13, with T14 beside them | T14 is docs only and can run beside the e2e tasks. T12 and T13 run Playwright, so they run one after the other, never together |
| I     | T15                                | alone                                                                                                                          |

Critical path: T1, T3, T5, T7, T8, T10, T11, T12, T13, T15.

Packages touched: `@aio/ui` (T1, T11: messages only), `@aio/desktop` (all others), `docs/` (T14). Contract changes: none.

## File structure

New, all under `apps/desktop/src/renderer/processing/`:

| File                    | Responsibility                                                                   | Task                                       |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| `pipelines.ts`          | Pipelines by area, plain job titles, the kind of every pipeline                  | T2                                         |
| `model.ts`              | Pure rules: a project's jobs, running elsewhere, needs attention, the chip state | T3                                         |
| `store.ts`              | UI state: drawer open, picked job, last looked per project, the start dialog     | T4                                         |
| `JobParts.tsx`          | Status chip, progress bar, clock, duration, `useNow`                             | T5                                         |
| `JobList.tsx`           | One job row                                                                      | T5                                         |
| `JobDetail.tsx`         | A job's details and live log                                                     | T5                                         |
| `PipelineForm.tsx`      | A pipeline's fields and Start                                                    | T5                                         |
| `ProcessingChip.tsx`    | The title bar chip                                                               | T6                                         |
| `DrawerList.tsx`        | The drawer's list view, props only                                               | T7                                         |
| `ProcessingDrawer.tsx`  | The drawer: reads the stores, shows the list or one job                          | T8                                         |
| `PipelineDialog.tsx`    | Start one pipeline for the open project                                          | T8                                         |
| `AdvancedPipelines.tsx` | Settings: the raw form and every job on this computer                            | T9                                         |
| `processing.css`        | Styles of the chip, the drawer, the dialog and the Advanced section              | T6 to T9 (each task appends its own block) |

Removed in T10: `screens/Jobs.tsx`, `screens/jobTaskActions.ts`, `screens/jobTasks.ts`, `screens/jobTasks.test.ts`.

---

### Task 1: Messages

**Files:**

- Modify: `packages/ui/src/i18n/en.ts`

**Interfaces:**

- Produces: the message keys below, typed as `MessageKey` by `@aio/ui`.

- [ ] **Step 1: Add the block**

In `packages/ui/src/i18n/en.ts`, add this block directly above the line `  // Jobs: inspection pipeline form` (near line 1035):

```ts
  // Processing: the open project's chip and drawer (renderer/processing)
  'processing.title': 'Processing',
  'processing.chip.one': 'Processing {pct}%',
  'processing.chip.many': 'Processing · {count} running',
  'processing.chip.attention_one': '{count} needs attention',
  'processing.chip.attention_other': '{count} need attention',
  'processing.chip.elsewhere': 'Processing · {count} running elsewhere',
  'processing.chip.tip': 'What this project is processing, and what finished',
  'processing.close': 'Close',
  'processing.createMaps': 'Create maps from photos',
  'processing.toolsMissing':
    'Processing cannot run yet: the processing tools are missing or need an update.',
  'processing.toolsUpdate': 'Update processing tools',
  'processing.running': 'Running',
  'processing.finished': 'Finished',
  'processing.older': 'Show older',
  'processing.elsewhere': 'Running in other projects',
  'processing.empty': 'Nothing is processing in {name} and nothing has finished yet.',
  'processing.noProject': 'No project is open.',
  'processing.back': 'Back',
  'processing.kind.maps': 'Maps and models',
  'processing.kind.survey': 'Survey',
  'processing.kind.ai': 'AI analysis',
  'processing.kind.files': 'Files',
  'processing.kind.system': 'System',
  'processing.detail.settings': 'Settings used',
  'processing.detail.log': 'Log',
  'processing.detail.openRun': 'Open run',
  'processing.detail.jobId': 'Job id',
  'processing.dialog.runsIn': 'Runs in {name}.',
  'processing.dialog.start': 'Start',
  'processing.advanced.title': 'Advanced: run a pipeline directly',
  'processing.advanced.help':
    'Every pipeline of the processing tools with its own parameters, and every job on this computer. For support.',
  'processing.advanced.all': 'All jobs on this computer',
  'processing.advanced.none': 'No job has run on this computer yet.',
  'det.toIssues': 'Turn detections into issues',
```

- [ ] **Step 2: Check the catalogue still passes its own tests and types**

Run: `pnpm exec vitest run packages/ui/src/i18n/i18n.test.ts --retry=0`
Expected: PASS.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/i18n/en.ts
git commit -m "feat(ui): messages for the project's processing chip and drawer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pipelines by area, titles and kinds

**Files:**

- Create: `apps/desktop/src/renderer/processing/pipelines.ts`
- Create: `apps/desktop/src/renderer/processing/pipelines.test.ts`
- Modify: `apps/desktop/src/renderer/screens/jobTasks.ts` (lines 1 to 127 move out; a re-export stays)
- Modify: `apps/desktop/src/renderer/screens/jobTasks.test.ts` (two `describe` blocks move out)

**Interfaces:**

- Consumes: message keys `processing.kind.*` (Task 1).
- Produces, from `processing/pipelines.ts`:
  - everything `screens/jobTasks.ts` exported for areas and titles, unchanged: `PipelineGroupId`, `PIPELINE_GROUPS`, `PIPELINE_GROUP`, `PipelineInfo`, `ungroupedPipelines`, `groupedPipelines`, `jobTitle(name: PipelineName): string`
  - `type JobKind = 'maps' | 'survey' | 'ai' | 'files' | 'system'`
  - `JOB_KIND: Record<PipelineName, JobKind>`
  - `KIND_LABEL: Record<JobKind, MessageKey>`
  - `jobKind(name: string): JobKind`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/processing/pipelines.test.ts`. Move the two blocks `describe('pipelines by area (the Advanced list)', ...)` and `describe('job titles', ...)` out of `screens/jobTasks.test.ts` into it, unchanged, importing what they use from `./pipelines`. Then add:

```ts
import { PIPELINES } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { JOB_KIND, jobKind, KIND_LABEL } from './pipelines';

describe('the kind of a job', () => {
  it('gives every pipeline of the schema exactly one kind', () => {
    expect(Object.keys(JOB_KIND).sort()).toEqual(PIPELINES.map((p) => p.name).sort());
  });

  it('tells map processing from AI analysis', () => {
    expect(jobKind('photo.products')).toBe('maps');
    expect(jobKind('model.fit_cloud')).toBe('maps');
    expect(jobKind('inspection.run')).toBe('ai');
    expect(jobKind('aik.cameras')).toBe('ai');
    expect(jobKind('survey.compare')).toBe('survey');
    expect(jobKind('road.build')).toBe('survey');
    expect(jobKind('survey.export')).toBe('files');
    expect(jobKind('tiles.mesh')).toBe('files');
    expect(jobKind('packs.imagery')).toBe('system');
    expect(jobKind('system.selftest')).toBe('system');
  });

  it('files a pipeline it does not know under System', () => {
    expect(jobKind('later.pipeline')).toBe('system');
  });

  it('has a label for every kind', () => {
    expect(Object.keys(KIND_LABEL).sort()).toEqual(['ai', 'files', 'maps', 'survey', 'system']);
  });
});
```

Merge the imports at the top of the file so each module is imported once. In `screens/jobTasks.test.ts` leave only `describe('the tasks of New job', ...)` and the imports it needs.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/pipelines.test.ts --retry=0`
Expected: FAIL, cannot resolve `./pipelines`.

- [ ] **Step 3: Create `pipelines.ts`**

Move lines 1 to 127 of `screens/jobTasks.ts` (the header comment, the imports, `PipelineGroupId`, `PIPELINE_GROUPS`, `PIPELINE_GROUP`, `PipelineInfo`, `groupOf`, `ungroupedPipelines`, `groupedPipelines`, `PLAIN_TITLES`, `jobTitle`) into the new file, unchanged except:

Replace the header comment with:

```ts
/**
 * The pipelines in a person's words: their area (the Advanced list in Settings), a job's plain
 * title, and its kind (the tag on a row of the project's Processing drawer). The pipeline titles
 * and descriptions are the frozen contract of `@aio/schema`; the plain words live here.
 */
```

Replace the imports with:

```ts
import { PIPELINES, type PipelineName } from '@aio/schema';
import type { MessageKey } from '@aio/ui';
```

Append:

```ts
// ---------------------------------------------------------------- the kind of a job

/** What a job is, for the tag on its row: map processing and AI work are told apart at a glance. */
export type JobKind = 'maps' | 'survey' | 'ai' | 'files' | 'system';

/**
 * The kind of every pipeline. A `Record` over `PipelineName`: a pipeline added to the schema
 * without a kind here does not compile, and `pipelines.test.ts` fails on it.
 */
export const JOB_KIND: Record<PipelineName, JobKind> = {
  'photo.align': 'maps',
  'photo.georef': 'maps',
  'photo.products': 'maps',
  'model.fit_cloud': 'maps',
  'volumetric.process': 'survey',
  'volumetric.build': 'survey',
  'change.raster': 'survey',
  'change.surface': 'survey',
  'change.cloud': 'survey',
  'change.mesh': 'survey',
  'change.frames': 'survey',
  'survey.prepare': 'survey',
  'survey.compare': 'survey',
  'survey.overlay': 'survey',
  'survey.section': 'survey',
  'survey.qa': 'survey',
  'survey.cleanup': 'survey',
  'geo.calibration': 'survey',
  'hydro.flood': 'survey',
  'hydro.flow': 'survey',
  'hydro.rainfall': 'survey',
  'haul.analyse': 'survey',
  'road.build': 'survey',
  'aik.cameras': 'ai',
  'aik.project': 'ai',
  'aik.records': 'ai',
  'inspection.run': 'ai',
  'pointcloud.to_copc': 'files',
  'drawing.import': 'files',
  'design.import': 'files',
  'opf.import': 'files',
  'opf.export': 'files',
  'tiles.mesh': 'files',
  'tiles.cloud': 'files',
  'survey.export': 'files',
  'packs.imagery': 'system',
  'packs.terrain': 'system',
  'system.selftest': 'system',
};

export const KIND_LABEL: Record<JobKind, MessageKey> = {
  maps: 'processing.kind.maps',
  survey: 'processing.kind.survey',
  ai: 'processing.kind.ai',
  files: 'processing.kind.files',
  system: 'processing.kind.system',
};

/** A job's kind. A pipeline this version does not know (a newer pack) is System. */
export function jobKind(name: string): JobKind {
  return (JOB_KIND as Partial<Record<string, JobKind>>)[name] ?? 'system';
}
```

- [ ] **Step 4: Keep `screens/jobTasks.ts` working until Task 10 removes it**

At the top of what is left of `screens/jobTasks.ts` (the tasks of New job), put:

```ts
/**
 * The tasks **New job** offers. Removed with the Jobs screen; the pipelines' areas, titles and
 * kinds live in `processing/pipelines.ts`.
 */
import type { PipelineName } from '@aio/schema';
import type { IconName } from '@aio/ui';

export {
  groupedPipelines,
  jobTitle,
  PIPELINE_GROUP,
  PIPELINE_GROUPS,
  ungroupedPipelines,
  type PipelineGroupId,
  type PipelineInfo,
} from '../processing/pipelines';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/pipelines.test.ts apps/desktop/src/renderer/screens/jobTasks.test.ts --retry=0`
Expected: PASS, both files.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/processing/pipelines.ts apps/desktop/src/renderer/processing/pipelines.test.ts apps/desktop/src/renderer/screens/jobTasks.ts apps/desktop/src/renderer/screens/jobTasks.test.ts
git commit -m "feat(desktop): every pipeline has a kind for the processing list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The rules

**Files:**

- Create: `apps/desktop/src/renderer/processing/model.ts`
- Create: `apps/desktop/src/renderer/processing/model.test.ts`
- Modify: `apps/desktop/src/renderer/jobs.ts:104-105` (export two helpers)

**Interfaces:**

- Consumes: `isActive` from `../jobs`; `JobRecord`, `LibraryEntry` from `@aio/schema`.
- Produces, from `../jobs`: `folderKey(p: string): string`, `sameFolder(a: string, b: string): boolean` (now exported).
- Produces, from `processing/model.ts`:
  - `interface ProjectJobs { running: JobRecord[]; finished: JobRecord[] }`
  - `projectJobs(all: readonly JobRecord[], root: string | null): ProjectJobs`
  - `runningElsewhere(all: readonly JobRecord[], root: string | null): JobRecord[]`
  - `interface Seen { start: string; seenAt: string | null }`
  - `needsAttention(finished: readonly JobRecord[], seen: Seen): JobRecord[]`
  - `type ChipState = { kind: 'hidden' } | { kind: 'idle' } | { kind: 'one'; pct: number } | { kind: 'many'; count: number } | { kind: 'attention'; count: number } | { kind: 'elsewhere'; count: number }`
  - `chipState(input: { own: boolean; mine: ProjectJobs; elsewhere: number; attention: number }): ChipState`
  - `projectLabel(folder: string, library: readonly Pick<LibraryEntry, 'name' | 'path'>[]): string`
  - `shownJob(all: readonly JobRecord[], picked: string | null, root: string | null): JobRecord | undefined`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/processing/model.test.ts`:

```ts
import type { JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  chipState,
  needsAttention,
  projectJobs,
  projectLabel,
  runningElsewhere,
  shownJob,
  type ProjectJobs,
} from './model';

const A = 'D:\\Sites\\A';
const B = 'D:\\Sites\\B';

let n = 0;
const job = (over: Partial<JobRecord>): JobRecord =>
  ({
    id: `job-${String(++n)}`,
    pipeline: 'system.selftest',
    project: A,
    status: 'done',
    progress: 1,
    params: {},
    steps: [],
    artifacts: [],
    createdAt: '2026-10-11T08:00:00.000Z',
    updatedAt: '2026-10-11T08:05:00.000Z',
    ...over,
  }) as JobRecord;

const none: ProjectJobs = { running: [], finished: [] };

describe('a project and its jobs', () => {
  it('splits the open project into running and finished and leaves the others out', () => {
    const run = job({ status: 'running', progress: 0.4 });
    const done = job({});
    const other = job({ project: B, status: 'running' });
    expect(projectJobs([run, done, other], A)).toEqual({ running: [run], finished: [done] });
  });

  it('knows the same folder under another spelling', () => {
    const j = job({ project: 'd:/sites/a/' });
    expect(projectJobs([j], A).finished).toEqual([j]);
  });

  it('has nothing without a project', () => {
    expect(projectJobs([job({})], null)).toEqual(none);
  });

  it('lists what runs in other projects, never the finished and never a map pack build', () => {
    const elsewhere = job({ project: B, status: 'running' });
    const pack = job({
      project: 'D:\\Data\\packs\\work',
      pipeline: 'packs.imagery',
      status: 'running',
    });
    const all = [job({ status: 'running' }), job({ project: B }), elsewhere, pack];
    expect(runningElsewhere(all, A)).toEqual([elsewhere]);
  });

  it('counts every running project job as elsewhere when no project is open', () => {
    const a = job({ status: 'starting' });
    const b = job({ project: B, status: 'cancelling' });
    expect(runningElsewhere([a, b], null)).toEqual([a, b]);
  });
});

describe('what needs a look', () => {
  const start = '2026-10-11T07:00:00.000Z';

  it('leaves a failure from before this session alone', () => {
    const old = job({ status: 'failed', updatedAt: '2026-10-04T10:00:00.000Z' });
    expect(needsAttention([old], { start, seenAt: null })).toEqual([]);
  });

  it('marks a failure of this session until the drawer was opened after it', () => {
    const failed = job({ status: 'failed', updatedAt: '2026-10-11T09:00:00.000Z' });
    expect(needsAttention([failed], { start, seenAt: null })).toEqual([failed]);
    expect(needsAttention([failed], { start, seenAt: '2026-10-11T08:30:00.000Z' })).toEqual([
      failed,
    ]);
    expect(needsAttention([failed], { start, seenAt: '2026-10-11T09:30:00.000Z' })).toEqual([]);
  });

  it('marks an interrupted job at start, whenever it was interrupted, until it is looked at', () => {
    const cut = job({ status: 'interrupted', updatedAt: '2026-10-11T06:59:00.000Z' });
    expect(needsAttention([cut], { start, seenAt: null })).toEqual([cut]);
    expect(needsAttention([cut], { start, seenAt: '2026-10-11T07:10:00.000Z' })).toEqual([]);
  });

  it('never marks a job that is done or was cancelled', () => {
    const later = '2026-10-11T09:00:00.000Z';
    const all = [job({ updatedAt: later }), job({ status: 'cancelled', updatedAt: later })];
    expect(needsAttention(all, { start, seenAt: null })).toEqual([]);
  });
});

describe('the chip', () => {
  const running = (progress: number) => job({ status: 'running', progress });

  it('is idle in a project with nothing running', () => {
    expect(chipState({ own: true, mine: none, elsewhere: 0, attention: 0 })).toEqual({
      kind: 'idle',
    });
  });

  it('shows the percent of the one running job', () => {
    const mine = { running: [running(0.4)], finished: [] };
    expect(chipState({ own: true, mine, elsewhere: 0, attention: 0 })).toEqual({
      kind: 'one',
      pct: 40,
    });
  });

  it('counts several running jobs', () => {
    const mine = { running: [running(0.1), running(0.2), running(0.3)], finished: [] };
    expect(chipState({ own: true, mine, elsewhere: 0, attention: 0 })).toEqual({
      kind: 'many',
      count: 3,
    });
  });

  it('puts what needs attention before what runs', () => {
    const mine = { running: [running(0.4)], finished: [] };
    expect(chipState({ own: true, mine, elsewhere: 0, attention: 1 })).toEqual({
      kind: 'attention',
      count: 1,
    });
  });

  it('points elsewhere only when nothing runs here', () => {
    expect(chipState({ own: true, mine: none, elsewhere: 2, attention: 0 })).toEqual({
      kind: 'elsewhere',
      count: 2,
    });
    const mine = { running: [running(0.4)], finished: [] };
    expect(chipState({ own: true, mine, elsewhere: 2, attention: 0 })).toEqual({
      kind: 'one',
      pct: 40,
    });
  });

  it('hides without a project of its own, unless something runs elsewhere', () => {
    expect(chipState({ own: false, mine: none, elsewhere: 0, attention: 0 })).toEqual({
      kind: 'hidden',
    });
    expect(chipState({ own: false, mine: none, elsewhere: 1, attention: 0 })).toEqual({
      kind: 'elsewhere',
      count: 1,
    });
  });
});

describe('the name of another project', () => {
  it('uses the library name of the folder, else the folder name', () => {
    const library = [{ name: 'North quarry', path: 'D:/Sites/B' }];
    expect(projectLabel(B, library)).toBe('North quarry');
    expect(projectLabel('D:\\Sites\\C\\', library)).toBe('C');
  });
});

describe('the job whose details show', () => {
  it('is the picked job of the open project', () => {
    const mine = job({});
    expect(shownJob([mine], mine.id, A)).toBe(mine);
  });

  it('is a picked job of another project only while it runs', () => {
    const running = job({ project: B, status: 'running' });
    const done = job({ project: B });
    expect(shownJob([running, done], running.id, A)).toBe(running);
    expect(shownJob([running, done], done.id, A)).toBeUndefined();
    expect(shownJob([running, done], running.id, null)).toBe(running);
  });

  it('is none when nothing is picked or the picked job is gone', () => {
    expect(shownJob([job({})], null, A)).toBeUndefined();
    expect(shownJob([job({})], 'job-gone', A)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/model.test.ts --retry=0`
Expected: FAIL, cannot resolve `./model`.

- [ ] **Step 3: Export the folder helpers from `jobs.ts`**

In `apps/desktop/src/renderer/jobs.ts`, replace lines 104 and 105:

```ts
const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sameFolder = (a: string, b: string) => folderKey(a) === folderKey(b);
```

with:

```ts
/** A project folder as a key: slashes one way, no trailing slash, lower case. */
export const folderKey = (p: string): string =>
  p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** Two spellings of one project folder. */
export const sameFolder = (a: string, b: string): boolean => folderKey(a) === folderKey(b);
```

- [ ] **Step 4: Write `model.ts`**

Create `apps/desktop/src/renderer/processing/model.ts`:

```ts
/**
 * The rules of the project's Processing chip and drawer, as pure functions: which jobs belong to
 * the open project, what runs elsewhere on this computer, what still needs a look, and what the
 * chip says. The job index is machine-wide (`jobs:list`); a job belongs to the project whose
 * folder it wrote into.
 */
import type { JobRecord, LibraryEntry } from '@aio/schema';
import { isActive, sameFolder } from '../jobs';

export interface ProjectJobs {
  /** Newest first, as the index gives them. */
  running: JobRecord[];
  finished: JobRecord[];
}

/** The jobs of the project at `root`. Without a project (or in a package), none. */
export function projectJobs(all: readonly JobRecord[], root: string | null): ProjectJobs {
  if (root === null) return { running: [], finished: [] };
  const mine = all.filter((j) => sameFolder(j.project, root));
  return { running: mine.filter(isActive), finished: mine.filter((j) => !isActive(j)) };
}

/**
 * What is running in other project folders. A map pack build is not project work (Settings, Map
 * packs shows it), so it is left out.
 */
export function runningElsewhere(all: readonly JobRecord[], root: string | null): JobRecord[] {
  return all.filter(
    (j) =>
      isActive(j) &&
      !j.pipeline.startsWith('packs.') &&
      (root === null || !sameFolder(j.project, root)),
  );
}

export interface Seen {
  /** When this session started (ISO). */
  start: string;
  /** When the drawer was last opened or closed in this project, this session (ISO), or null. */
  seenAt: string | null;
}

/**
 * The finished jobs a person has not looked at: a failure of this session since the drawer was
 * last open, and any interrupted job until the drawer is opened once (it waits for Resume).
 */
export function needsAttention(finished: readonly JobRecord[], seen: Seen): JobRecord[] {
  return finished.filter((j) => {
    if (j.status === 'interrupted') return seen.seenAt === null || j.updatedAt > seen.seenAt;
    if (j.status === 'failed') return j.updatedAt > (seen.seenAt ?? seen.start);
    return false;
  });
}

export type ChipState =
  | { kind: 'hidden' }
  | { kind: 'idle' }
  | { kind: 'one'; pct: number }
  | { kind: 'many'; count: number }
  | { kind: 'attention'; count: number }
  | { kind: 'elsewhere'; count: number };

/**
 * What the chip says. `own` is false with no project open and in a read-only package, which has
 * no processing of its own: the chip then shows only while something runs elsewhere.
 */
export function chipState(input: {
  own: boolean;
  mine: ProjectJobs;
  elsewhere: number;
  attention: number;
}): ChipState {
  const { own, mine, elsewhere, attention } = input;
  if (own && attention > 0) return { kind: 'attention', count: attention };
  const first = mine.running[0];
  if (own && mine.running.length === 1 && first)
    return { kind: 'one', pct: Math.round(first.progress * 100) };
  if (own && mine.running.length > 1) return { kind: 'many', count: mine.running.length };
  if (elsewhere > 0) return { kind: 'elsewhere', count: elsewhere };
  return own ? { kind: 'idle' } : { kind: 'hidden' };
}

/** A project folder by the name the library knows it under, else by its folder name. */
export function projectLabel(
  folder: string,
  library: readonly Pick<LibraryEntry, 'name' | 'path'>[],
): string {
  const known = library.find((e) => sameFolder(e.path, folder));
  if (known) return known.name;
  return (
    folder
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? folder
  );
}

/**
 * The job whose details the drawer shows: the picked one, if it belongs to the open project or
 * is still running elsewhere. A picked job that is gone, or that belongs to a project no longer
 * open, shows nothing: the drawer falls back to its list.
 */
export function shownJob(
  all: readonly JobRecord[],
  picked: string | null,
  root: string | null,
): JobRecord | undefined {
  if (picked === null) return undefined;
  const job = all.find((j) => j.id === picked);
  if (!job) return undefined;
  const here = root !== null && sameFolder(job.project, root);
  return here || isActive(job) ? job : undefined;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/model.test.ts apps/desktop/src/renderer/jobs.test.ts --retry=0`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/processing/model.ts apps/desktop/src/renderer/processing/model.test.ts apps/desktop/src/renderer/jobs.ts
git commit -m "feat(desktop): rules for a project's processing and its chip" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The UI store

**Files:**

- Create: `apps/desktop/src/renderer/processing/store.ts`
- Create: `apps/desktop/src/renderer/processing/store.test.ts`

**Interfaces:**

- Consumes: `folderKey` from `../jobs` (Task 3 exports it; until Task 3 has landed in the same batch, import it the same way, the batch is merged before typecheck); `JobDraft` from `../jobs`; `workspace` from `@aio/workspace`.
- Produces, from `processing/store.ts`:
  - `interface ProcessingUi { open: boolean; picked: string | null; start: string; seen: Record<string, string>; dialog: JobDraft | null; openDrawer(jobId?: string): void; closeDrawer(): void; pick(id: string | null): void; openDialog(req: JobDraft): void; closeDialog(): void }`
  - `createProcessingStore(deps: { now: () => Date; root: () => string | null }): StoreApi<ProcessingUi>`
  - `processing: StoreApi<ProcessingUi>` (the app's one)
  - `useProcessing<T>(selector: (s: ProcessingUi) => T): T`
  - `seenAtOf(s: Pick<ProcessingUi, 'seen'>, root: string | null): string | null`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/processing/store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createProcessingStore, seenAtOf } from './store';

function make(root: string | null = 'D:\\Sites\\A') {
  let t = Date.parse('2026-10-11T08:00:00.000Z');
  const where = { root };
  const store = createProcessingStore({
    now: () => new Date((t += 60_000)),
    root: () => where.root,
  });
  return { store, where };
}

describe('the processing drawer state', () => {
  it('starts closed and remembers when the session started', () => {
    const { store } = make();
    expect(store.getState().open).toBe(false);
    expect(store.getState().start).toBe('2026-10-11T08:01:00.000Z');
    expect(seenAtOf(store.getState(), 'D:\\Sites\\A')).toBeNull();
  });

  it('notes the look when the drawer opens, and again when it closes', () => {
    const { store } = make();
    store.getState().openDrawer();
    expect(store.getState().open).toBe(true);
    expect(seenAtOf(store.getState(), 'd:/sites/a')).toBe('2026-10-11T08:02:00.000Z');
    store.getState().closeDrawer();
    expect(store.getState().open).toBe(false);
    expect(seenAtOf(store.getState(), 'D:\\Sites\\A')).toBe('2026-10-11T08:03:00.000Z');
  });

  it('keeps the look per project', () => {
    const { store, where } = make();
    store.getState().openDrawer();
    where.root = 'D:\\Sites\\B';
    expect(seenAtOf(store.getState(), where.root)).toBeNull();
  });

  it('opens on a job when asked, and goes back to the list', () => {
    const { store } = make();
    store.getState().openDrawer('job-7');
    expect(store.getState().picked).toBe('job-7');
    store.getState().pick(null);
    expect(store.getState().picked).toBeNull();
    expect(store.getState().open).toBe(true);
  });

  it('opens without a project and notes nothing', () => {
    const { store } = make(null);
    store.getState().openDrawer();
    expect(store.getState().open).toBe(true);
    expect(store.getState().seen).toEqual({});
  });

  it('holds one start dialog at a time', () => {
    const { store } = make();
    const req = { pipeline: 'road.build' as const, project: 'D:\\Sites\\A', values: {} };
    store.getState().openDialog(req);
    expect(store.getState().dialog).toEqual(req);
    store.getState().closeDialog();
    expect(store.getState().dialog).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/store.test.ts --retry=0`
Expected: FAIL, cannot resolve `./store`.

- [ ] **Step 3: Write `store.ts`**

Create `apps/desktop/src/renderer/processing/store.ts`:

```ts
/**
 * What the Processing chip and drawer remember for the session: whether the drawer is open, the
 * job whose details show, when each project's drawer was last looked at (the chip's "needs
 * attention" counts from there) and the one start dialog. Nothing here is saved.
 */
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { folderKey, type JobDraft } from '../jobs';

export interface ProcessingUi {
  open: boolean;
  /** The job whose details the drawer shows, or null for the list. */
  picked: string | null;
  /** When this session started (ISO). */
  start: string;
  /** Per project folder key: when its drawer was last opened or closed (ISO). */
  seen: Record<string, string>;
  /** One pipeline to start for the open project (`PipelineDialog`), or null. */
  dialog: JobDraft | null;
  /** Open the drawer, on a job's details when `jobId` is given. */
  openDrawer: (jobId?: string) => void;
  closeDrawer: () => void;
  pick: (id: string | null) => void;
  openDialog: (req: JobDraft) => void;
  closeDialog: () => void;
}

export function seenAtOf(s: Pick<ProcessingUi, 'seen'>, root: string | null): string | null {
  return root === null ? null : (s.seen[folderKey(root)] ?? null);
}

export function createProcessingStore(deps: {
  now: () => Date;
  root: () => string | null;
}): StoreApi<ProcessingUi> {
  const looked = (seen: Record<string, string>): Record<string, string> => {
    const root = deps.root();
    return root === null ? seen : { ...seen, [folderKey(root)]: deps.now().toISOString() };
  };
  return createStore<ProcessingUi>()((set) => ({
    open: false,
    picked: null,
    start: deps.now().toISOString(),
    seen: {},
    dialog: null,
    openDrawer: (jobId) => {
      set((s) => ({ open: true, picked: jobId ?? null, seen: looked(s.seen) }));
    },
    closeDrawer: () => {
      set((s) => ({ open: false, picked: null, seen: looked(s.seen) }));
    },
    pick: (id) => {
      set({ picked: id });
    },
    openDialog: (req) => {
      set({ dialog: req });
    },
    closeDialog: () => {
      set({ dialog: null });
    },
  }));
}

/** The app's one. */
export const processing = createProcessingStore({
  now: () => new Date(),
  root: () => workspace.getState().project?.root ?? null,
});

export function useProcessing<T>(selector: (s: ProcessingUi) => T): T {
  return useStore(processing, selector);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/store.test.ts --retry=0`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/processing/store.ts apps/desktop/src/renderer/processing/store.test.ts
git commit -m "feat(desktop): session state of the processing drawer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Shared parts out of `screens/Jobs.tsx`

The Jobs screen keeps working after this task, on the moved parts. Nothing a person sees changes except a kind tag on each row.

**Files:**

- Create: `apps/desktop/src/renderer/processing/JobParts.tsx`
- Create: `apps/desktop/src/renderer/processing/JobList.tsx`
- Create: `apps/desktop/src/renderer/processing/JobDetail.tsx`
- Create: `apps/desktop/src/renderer/processing/PipelineForm.tsx`
- Create: `apps/desktop/src/renderer/processing/PipelineForm.test.tsx`
- Create: `apps/desktop/src/renderer/processing/processing.css`
- Modify: `apps/desktop/src/renderer/screens/Jobs.tsx`

**Interfaces:**

- Consumes: `jobTitle`, `jobKind`, `KIND_LABEL`, `groupedPipelines` from `./pipelines` (Task 2); message keys (Task 1); `runOfJob`, `photoUi` from `../photogrammetry/store`.
- Produces:
  - `JobParts.tsx`: `STATUS`, `StatusChip({ status })`, `Bar({ job })`, `clock(iso?: string): string`, `duration(job: JobRecord, now: number): string`, `useNow(active: boolean): number`, `pct(f: number): string`
  - `JobList.tsx`: `JobRow(props: { job: JobRecord; selected: boolean; now: number; project?: string | undefined; onPick: () => void })`
  - `JobDetail.tsx`: `JobDetail(props: { job: JobRecord; now: number; folded?: boolean })`
  - `PipelineForm.tsx`: `PipelineForm(props: { draft?: JobDraft | null; fixed?: boolean; onClose?: (() => void) | undefined; onStarted?: ((jobId: string) => void) | undefined })`

- [ ] **Step 1: Write the failing test for the form's fixed mode**

Create `apps/desktop/src/renderer/processing/PipelineForm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn<(req: unknown) => Promise<string | null>>(() => Promise.resolve(null));

vi.mock('../shell', () => ({
  bridge: { call: vi.fn(() => Promise.resolve({ ok: false, error: 'no dialog' })) },
  jobs: { getState: () => ({ start, selected: 'job-1' }) },
  useJobs: (selector: (s: { runtime: { found: boolean } }) => unknown) =>
    selector({ runtime: { found: true } }),
}));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (
    selector: (s: { project: { root: string; manifest: { type: string } } }) => unknown,
  ) => selector({ project: { root: 'D:\\Sites\\A', manifest: { type: 'inspection' } } }),
}));

import { PipelineForm } from './PipelineForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  start.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const settle = () => act(() => Promise.resolve());

describe('the pipeline form', () => {
  it('offers the pipeline and the project folder when it is free', () => {
    act(() => {
      root = createRoot(host);
      root.render(<PipelineForm />);
    });
    expect(host.querySelector('#job-pipeline')).not.toBeNull();
    expect(host.querySelector('#job-f-project')).not.toBeNull();
  });

  it('fixed to one pipeline of the open project, asks for neither and starts there', async () => {
    const onStarted = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(
        <PipelineForm
          fixed
          draft={{ pipeline: 'inspection.run', project: 'D:\\Sites\\A', values: {} }}
          onStarted={onStarted}
          onClose={onClose}
        />,
      );
    });
    expect(host.querySelector('#job-pipeline')).toBeNull();
    expect(host.querySelector('#job-f-project')).toBeNull();
    expect(host.querySelector('#job-f-detections')).not.toBeNull();
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="job-start"]')?.click();
    });
    await settle();
    expect(start).toHaveBeenCalledWith({
      pipeline: 'inspection.run',
      project: 'D:\\Sites\\A',
      params: {},
    });
    expect(onStarted).toHaveBeenCalledWith('job-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the form open and says why when the job does not start', async () => {
    start.mockResolvedValueOnce('The processing tools are missing.');
    const onStarted = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(
        <PipelineForm
          fixed
          draft={{ pipeline: 'inspection.run', project: 'D:\\Sites\\A', values: {} }}
          onStarted={onStarted}
        />,
      );
    });
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="job-start"]')?.click();
    });
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'The processing tools are missing.',
    );
    expect(onStarted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/PipelineForm.test.tsx --retry=0`
Expected: FAIL, cannot resolve `./PipelineForm`.

- [ ] **Step 3: Create `JobParts.tsx`**

Move from `screens/Jobs.tsx` into `processing/JobParts.tsx`, each now `export`ed: `STATUS` (lines 27 to 35), `pct` (line 53), `clock` (55 to 64), `duration` (66 to 74), `useNow` (76 to 88), `StatusChip` (90 to 98), `Bar` (100 to 113). In `Bar`, `titleOf` becomes `jobTitle`. File header and imports:

```tsx
/** The small parts every list and detail of jobs shares: status, progress, times. */
import type { JobRecord } from '@aio/schema';
import { useEffect, useState } from 'react';
import { jobTitle } from './pipelines';
```

- [ ] **Step 4: Create `JobList.tsx`**

```tsx
/** One job as a row: its plain title, kind, status, times and progress. */
import type { JobRecord } from '@aio/schema';
import { t } from '@aio/ui';
import { Bar, clock, duration, StatusChip } from './JobParts';
import { jobKind, jobTitle, KIND_LABEL } from './pipelines';
import './processing.css';

export function JobRow({
  job,
  selected,
  now,
  project,
  onPick,
}: {
  job: JobRecord;
  selected: boolean;
  now: number;
  /** The project's name, where the list holds more than one project's jobs. */
  project?: string | undefined;
  onPick: () => void;
}) {
  const kind = jobKind(job.pipeline);
  return (
    <button
      type="button"
      role="listitem"
      className="job-row"
      aria-current={selected ? 'true' : undefined}
      data-job={job.id}
      data-kind={kind}
      onClick={onPick}
    >
      <span className="jr-top">
        <b>{jobTitle(job.pipeline)}</b>
        <StatusChip status={job.status} />
      </span>
      <span className="jr-sub">
        <span className="jr-kind">{t(KIND_LABEL[kind])}</span>
        {project !== undefined && <span className="mono">{project}</span>}
        <span>
          {clock(job.createdAt)} · {duration(job, now)}
        </span>
      </span>
      <Bar job={job} />
    </button>
  );
}
```

Create `processing/processing.css` with its first block:

```css
/* ---------- processing: the kind tag of a job row ---------- */
.jr-sub .jr-kind {
  flex: none;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--fg-2);
  font-size: 11px;
  line-height: 16px;
}
.job-row[data-kind='ai'] .jr-kind {
  border-color: var(--line-strong);
  color: var(--fg-0);
}
```

`.jr-sub` (in `styles.css`, near line 4006) is already a flex row with a gap, so the tag sits beside the times. The colours are tokens of `packages/ui/src/tokens.css`.

- [ ] **Step 5: Create `JobDetail.tsx`**

Move `STEP_ICON` (lines 37 to 44), `LogTail` (504 to 534) and `Detail` (536 to 684) from `screens/Jobs.tsx`. Rename `Detail` to `JobDetail`, export it, replace `titleOf` with `jobTitle`, and make these changes:

Imports:

```tsx
/**
 * One job: status, progress, Cancel and Resume, steps, outputs, the parameters it ran with and
 * its live log. `folded` is the drawer's narrow form: one column, the parameters and the log
 * folded away.
 */
import type { JobLogLine, JobRecord, JobStep } from '@aio/schema';
import { Icon, t, type IconName } from '@aio/ui';
import { useLayoutEffect, useRef, useState } from 'react';
import { canResume, isActive } from '../jobs';
import { photoUi, runOfJob } from '../photogrammetry/store';
import { jobs, useJobs } from '../shell';
import { Bar, clock, duration, pct, STATUS, StatusChip } from './JobParts';
import { jobTitle } from './pipelines';
```

Signature:

```tsx
export function JobDetail({
  job,
  now,
  folded = false,
}: {
  job: JobRecord;
  now: number;
  folded?: boolean;
}) {
```

After `const params = Object.entries(job.params);` add:

```tsx
const run = runOfJob(job);
```

In the header, the job id shows only in the wide form. Replace

```tsx
<span className="mono faint">{job.id}</span>
```

with

```tsx
{
  !folded && <span className="mono faint">{job.id}</span>;
}
```

In `.jd-acts`, before the **Open output** button, add:

```tsx
{
  run && (
    <button
      type="button"
      className="btn sm"
      data-testid="job-open-run"
      onClick={() => {
        photoUi.getState().openRun(run);
      }}
    >
      <Icon name="link" size={14} />
      {t('processing.detail.openRun')}
    </button>
  );
}
```

Replace everything from `<div className="jd-grid">` to the end of the component's JSX (the grid, the `Log` heading and `<LogTail />`) with:

```tsx
{
  (() => {
    const steps = (
      <div className="jd-col">
        <h3 className="caps">Steps</h3>
        <ol className="jd-steps">
          {job.steps.length === 0 && <li className="faint">Waiting for the runtime.</li>}
          {job.steps.map((s) => {
            const icon = STEP_ICON[s.state];
            return (
              <li key={s.name} data-state={s.state}>
                <span className="si">{icon ? <Icon name={icon} size={12} /> : <i />}</span>
                <span className="sn">{s.title ?? s.name}</span>
                <span className="ss">{s.state === 'skipped' ? 'kept from last run' : s.state}</span>
              </li>
            );
          })}
        </ol>
        {outputs.length > 0 && (
          <>
            <h3 className="caps">Outputs</h3>
            <ul className="jd-out">
              {outputs.map((a) => (
                <li key={a.path} className="mono">
                  <Icon name={a.kind === 'folder' ? 'layers' : 'report'} size={12} />
                  {a.path}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
    const facts = (
      <dl className="jd-kv">
        <dt>Project</dt>
        <dd className="mono">{job.project}</dd>
        {params.map(([k, v]) => (
          <div key={k} className="kvr">
            <dt>{k}</dt>
            <dd className="mono">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
        <dt>Started</dt>
        <dd>{clock(job.createdAt)}</dd>
        {job.finishedAt && (
          <>
            <dt>Finished</dt>
            <dd>{clock(job.finishedAt)}</dd>
          </>
        )}
        {job.packVersion && (
          <>
            <dt>Processing tools</dt>
            <dd className="mono">{job.packVersion}</dd>
          </>
        )}
        {folded && (
          <>
            <dt>{t('processing.detail.jobId')}</dt>
            <dd className="mono">{job.id}</dd>
          </>
        )}
      </dl>
    );
    return folded ? (
      <>
        {steps}
        <details className="jd-fold" data-testid="job-settings">
          <summary>{t('processing.detail.settings')}</summary>
          {facts}
        </details>
        <details className="jd-fold" data-testid="job-log-fold">
          <summary>{t('processing.detail.log')}</summary>
          <LogTail lines={lines} />
        </details>
      </>
    ) : (
      <>
        <div className="jd-grid">
          {steps}
          <div className="jd-col">
            <h3 className="caps">Job</h3>
            {facts}
          </div>
        </div>
        <h3 className="caps jd-logh">Log</h3>
        <LogTail lines={lines} />
      </>
    );
  })();
}
```

The opening tag gains the form as an attribute: `<section className="job-detail" aria-label="Job details" data-job={job.id} data-form={folded ? 'folded' : 'wide'}>`. `data-job` lets a spec read the id of the job shown, in either form.

Append to `processing.css`:

```css
/* ---------- processing: a job's details, folded (the drawer) ---------- */
.job-detail[data-form='folded'] {
  padding: 0;
  overflow: visible;
}
.jd-fold {
  margin-top: 12px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}
.jd-fold > summary {
  cursor: pointer;
  color: var(--fg-1);
  font-size: 12px;
}
.jd-fold[open] > summary {
  margin-bottom: 8px;
}
.jd-fold .job-log {
  max-height: 240px;
}
```

- [ ] **Step 6: Create `PipelineForm.tsx`**

Move `FieldInput` (lines 117 to 234) and `PipelineForm` (236 to 348) from `screens/Jobs.tsx`, with `const PIPELINE_AREAS = groupedPipelines(PIPELINES);` (line 47). Export `PipelineForm`. Imports:

```tsx
/**
 * The form of one pipeline, as the pack takes it. Free (Settings, Advanced): the person picks the
 * pipeline and the project folder. `fixed`: one pipeline for the open project, given as `draft`,
 * with neither question.
 */
import { PIPELINES, type PipelineName } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { buildParams, FORMS, type Field, type JobDraft } from '../jobs';
import { bridge, jobs, useJobs } from '../shell';
import { groupedPipelines } from './pipelines';
```

New signature:

```tsx
export function PipelineForm({
  draft,
  fixed = false,
  onClose,
  onStarted,
}: {
  draft?: JobDraft | null;
  /** One pipeline for one project (`draft`): no pipeline list, no project folder field. */
  fixed?: boolean;
  /** Shows a Close button and is called after a start. */
  onClose?: (() => void) | undefined;
  onStarted?: ((jobId: string) => void) | undefined;
}) {
```

In `submit`, replace the last two lines (`if (err) setError(err); else onClose();`) with:

```tsx
if (err) {
  setError(err);
  return;
}
// the store selects the job it has just started
const id = jobs.getState().selected;
if (id) onStarted?.(id);
onClose?.();
```

Wrap the pipeline `<div className="nj-field">…</div>` (the `<select id="job-pipeline">` and its help) and the following `<FieldInput field={{ key: 'project', … }} … />` in `{!fixed && (<> … </>)}`.

Replace the buttons block with:

```tsx
<div className="nj-acts">
  {onClose && (
    <button type="button" className="btn sm ghost" onClick={onClose}>
      Close
    </button>
  )}
  <button
    type="submit"
    className="btn sm primary"
    disabled={busy || runtime?.found === false}
    data-testid="job-start"
  >
    <Icon name="play" size={14} />
    {busy ? 'Starting' : fixed ? t('processing.dialog.start') : 'Start job'}
  </button>
</div>
```

- [ ] **Step 7: Point `screens/Jobs.tsx` at the moved parts**

Delete the moved code from `screens/Jobs.tsx` (lines 27 to 113, 117 to 348 and 464 to 684, and `const titleOf`, `PIPELINE_AREAS`, `pct`). Keep `baseName`. Import:

```tsx
import { JobDetail } from '../processing/JobDetail';
import { JobRow } from '../processing/JobList';
import { useNow } from '../processing/JobParts';
import { PipelineForm } from '../processing/PipelineForm';
```

and remove the imports that are no longer used (`PIPELINES`, `JobLogLine`, `JobStep`, `PipelineName`, `IconName`, `useLayoutEffect`, `useRef`, `buildParams`, `canResume`, `FORMS`, `Field`, `bridge`, `groupedPipelines`, `jobTitle`). In `JobsScreen`:

- both `<JobRow … onPick={closeNew} />` become

```tsx
<JobRow
  key={j.id}
  job={j}
  selected={!creating && j.id === job?.id}
  now={now}
  project={baseName(j.project)}
  onPick={() => {
    closeNew();
    void jobs.getState().select(j.id);
  }}
/>
```

- `<Detail job={job} now={now} />` becomes `<JobDetail job={job} now={now} />`.

`NewJobPanel` keeps `<PipelineForm draft={draft} onClose={onClose} />` as it is.

- [ ] **Step 8: Run the tests and types**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing --retry=0`
Expected: PASS, including the three `PipelineForm` tests.

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/processing apps/desktop/src/renderer/screens/Jobs.tsx
git commit -m "refactor(desktop): job row, details and pipeline form as shared parts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The chip

**Files:**

- Create: `apps/desktop/src/renderer/processing/ProcessingChip.tsx`
- Create: `apps/desktop/src/renderer/processing/ProcessingChip.test.tsx`
- Modify: `apps/desktop/src/renderer/processing/processing.css` (append)

**Interfaces:**

- Consumes: `chipState`, `needsAttention`, `projectJobs`, `runningElsewhere`, `ChipState` (Task 3); `processing`, `useProcessing`, `seenAtOf` (Task 4); message keys (Task 1).
- Produces: `chipText(state: ChipState): string`, `ChipView(props: { state: ChipState; open: boolean; onToggle: () => void })`, `ProcessingChip()` (mounted in Task 10).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/processing/ProcessingChip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({ useJobs: () => [], useShell: () => null }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: () => null,
  workspace: { getState: () => ({ project: null }) },
}));

import { ChipView, chipText } from './ProcessingChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="processing-chip"]');

describe('what the chip says', () => {
  it('reads each state in plain words', () => {
    expect(chipText({ kind: 'idle' })).toBe('Processing');
    expect(chipText({ kind: 'one', pct: 40 })).toBe('Processing 40%');
    expect(chipText({ kind: 'many', count: 3 })).toBe('Processing · 3 running');
    expect(chipText({ kind: 'attention', count: 1 })).toBe('1 needs attention');
    expect(chipText({ kind: 'attention', count: 2 })).toBe('2 need attention');
    expect(chipText({ kind: 'elsewhere', count: 1 })).toBe('Processing · 1 running elsewhere');
  });
});

describe('the chip', () => {
  it('is not there when hidden', () => {
    act(() => {
      root = createRoot(host);
      root.render(<ChipView state={{ kind: 'hidden' }} open={false} onToggle={() => undefined} />);
    });
    expect(chip()).toBeNull();
  });

  it('is a button that says whether the drawer is open, and toggles it', () => {
    const onToggle = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(<ChipView state={{ kind: 'one', pct: 40 }} open={false} onToggle={onToggle} />);
    });
    expect(chip()?.textContent).toBe('Processing 40%');
    expect(chip()?.getAttribute('aria-expanded')).toBe('false');
    expect(chip()?.getAttribute('aria-controls')).toBe('processing-drawer');
    expect(chip()?.dataset.state).toBe('one');
    act(() => chip()?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('carries a warning mark when something needs attention', () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <ChipView
          state={{ kind: 'attention', count: 1 }}
          open={false}
          onToggle={() => undefined}
        />,
      );
    });
    expect(chip()?.dataset.state).toBe('attention');
    expect(chip()?.querySelector('svg')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/ProcessingChip.test.tsx --retry=0`
Expected: FAIL, cannot resolve `./ProcessingChip`.

- [ ] **Step 3: Write `ProcessingChip.tsx`**

```tsx
/**
 * The Processing chip of the title bar: what the open project is processing, in a word, and the
 * button that opens its drawer. With no project of its own (none open, or a read-only package)
 * it shows only while another project is running something.
 */
import { Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useJobs, useShell } from '../shell';
import { chipState, needsAttention, projectJobs, runningElsewhere, type ChipState } from './model';
import { processing, seenAtOf, useProcessing } from './store';
import './processing.css';

export function chipText(state: ChipState): string {
  switch (state.kind) {
    case 'one':
      return t('processing.chip.one', { pct: state.pct });
    case 'many':
      return t('processing.chip.many', { count: state.count });
    case 'attention':
      return t('processing.chip.attention', { count: state.count });
    case 'elsewhere':
      return t('processing.chip.elsewhere', { count: state.count });
    case 'idle':
    case 'hidden':
      return t('processing.title');
  }
}

export function ChipView({
  state,
  open,
  onToggle,
}: {
  state: ChipState;
  open: boolean;
  onToggle: () => void;
}) {
  if (state.kind === 'hidden') return null;
  return (
    <button
      type="button"
      className="chip-status proc-chip"
      data-testid="processing-chip"
      data-state={state.kind}
      title={t('processing.chip.tip')}
      aria-expanded={open}
      aria-controls="processing-drawer"
      onClick={onToggle}
    >
      <Icon name={state.kind === 'attention' ? 'warn' : 'clock'} size={14} />
      {chipText(state)}
    </button>
  );
}

export function ProcessingChip() {
  useT();
  const all = useJobs((s) => s.jobs);
  const project = useWorkspace((s) => s.project?.root ?? null);
  const pkg = useShell((s) => s.pkg !== null);
  const open = useProcessing((s) => s.open);
  const start = useProcessing((s) => s.start);
  const root = pkg ? null : project;
  const seenAt = useProcessing((s) => seenAtOf(s, root));
  const state = useMemo(() => {
    const mine = projectJobs(all, root);
    return chipState({
      own: root !== null,
      mine,
      elsewhere: runningElsewhere(all, root).length,
      // while the drawer is open the person is looking
      attention: open ? 0 : needsAttention(mine.finished, { start, seenAt }).length,
    });
  }, [all, root, open, start, seenAt]);
  return (
    <ChipView
      state={state}
      open={open}
      onToggle={() => {
        const p = processing.getState();
        if (p.open) p.closeDrawer();
        else p.openDrawer();
      }}
    />
  );
}
```

`t('processing.chip.attention', { count })` picks `processing.chip.attention_one` or `_other` from the count, the way `t('builder.surveys.count', { count })` does.

Append to `processing.css`:

```css
/* ---------- processing: the title bar chip ---------- */
.proc-chip {
  app-region: no-drag;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.proc-chip[data-state='one'],
.proc-chip[data-state='many'] {
  color: var(--fg-0);
}
.proc-chip[data-state='attention'] {
  border-color: var(--warn);
  color: var(--warn);
}
```

`--warn` is a token of `packages/ui/src/tokens.css` (the warning colour, the one `.job-state.warn` shows).

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/ProcessingChip.test.tsx --retry=0`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/processing/ProcessingChip.tsx apps/desktop/src/renderer/processing/ProcessingChip.test.tsx apps/desktop/src/renderer/processing/processing.css
git commit -m "feat(desktop): the Processing chip" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The drawer's list, as a pure view

**Files:**

- Create: `apps/desktop/src/renderer/processing/DrawerList.tsx`
- Create: `apps/desktop/src/renderer/processing/DrawerList.test.tsx`

**Interfaces:**

- Consumes: `JobRow` (Task 5); message keys (Task 1).
- Produces: `FINISHED_SHOWN = 20`, and

```ts
export interface DrawerListProps {
  /** The open project's name; null with no project of its own (none open, or a package). */
  projectName: string | null;
  running: readonly JobRecord[];
  finished: readonly JobRecord[];
  elsewhere: readonly { job: JobRecord; project: string }[];
  toolsMissing: boolean;
  now: number;
  onPick: (id: string) => void;
  onCreateMaps: () => void;
  onUpdateTools: () => void;
  /** The project's maps from photos (`PhotoRuns`), shown under Finished. */
  children?: ReactNode;
}
export function DrawerList(props: DrawerListProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/processing/DrawerList.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { JobRecord } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawerList, FINISHED_SHOWN, type DrawerListProps } from './DrawerList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let n = 0;
const job = (over: Partial<JobRecord>): JobRecord =>
  ({
    id: `job-${String(++n)}`,
    pipeline: 'photo.products',
    project: 'D:\\Sites\\A',
    status: 'done',
    progress: 1,
    params: {},
    steps: [],
    artifacts: [],
    createdAt: '2026-10-11T08:00:00.000Z',
    updatedAt: '2026-10-11T08:05:00.000Z',
    ...over,
  }) as JobRecord;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function show(over: Partial<DrawerListProps>) {
  const props: DrawerListProps = {
    projectName: 'Site A',
    running: [],
    finished: [],
    elsewhere: [],
    toolsMissing: false,
    now: Date.parse('2026-10-11T09:00:00.000Z'),
    onPick: vi.fn(),
    onCreateMaps: vi.fn(),
    onUpdateTools: vi.fn(),
    ...over,
  };
  act(() => {
    root = createRoot(host);
    root.render(<DrawerList {...props} />);
  });
  return props;
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rows = (id: string) => [...(q(id)?.querySelectorAll('.job-row') ?? [])];

describe('the processing list of a project', () => {
  it('says so when there is nothing yet, and still offers Create maps', () => {
    const props = show({});
    expect(q('proc-empty')?.textContent).toBe(
      'Nothing is processing in Site A and nothing has finished yet.',
    );
    act(() => q('create-maps')?.click());
    expect(props.onCreateMaps).toHaveBeenCalledTimes(1);
  });

  it('lists running before finished, each row with its kind', () => {
    const run = job({ status: 'running', progress: 0.4 });
    const done = job({ pipeline: 'inspection.run' });
    const props = show({ running: [run], finished: [done] });
    expect(rows('proc-running').map((r) => r.getAttribute('data-job'))).toEqual([run.id]);
    expect(rows('proc-finished').map((r) => r.getAttribute('data-kind'))).toEqual(['ai']);
    expect(q('proc-empty')).toBeNull();
    act(() => (rows('proc-finished')[0] as HTMLButtonElement).click());
    expect(props.onPick).toHaveBeenCalledWith(done.id);
  });

  it('shows the last finished jobs and the rest on Show older', () => {
    const many = Array.from({ length: FINISHED_SHOWN + 3 }, () => job({}));
    show({ finished: many });
    expect(rows('proc-finished')).toHaveLength(FINISHED_SHOWN);
    act(() => q('proc-older')?.click());
    expect(rows('proc-finished')).toHaveLength(FINISHED_SHOWN + 3);
    expect(q('proc-older')).toBeNull();
  });

  it('says when the tools are missing and leads to the update', () => {
    const props = show({ toolsMissing: true });
    expect(q('proc-tools')?.textContent).toContain('Processing cannot run yet');
    act(() => q('proc-tools')?.querySelector('button')?.click());
    expect(props.onUpdateTools).toHaveBeenCalledTimes(1);
  });

  it('names the project of what runs elsewhere', () => {
    const other = job({ project: 'D:\\Sites\\B', status: 'running' });
    show({ elsewhere: [{ job: other, project: 'North quarry' }] });
    expect(rows('proc-elsewhere')[0]?.textContent).toContain('North quarry');
  });

  it('puts the maps from photos under the lists', () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <DrawerList
          projectName="Site A"
          running={[]}
          finished={[]}
          elsewhere={[]}
          toolsMissing={false}
          now={0}
          onPick={() => undefined}
          onCreateMaps={() => undefined}
          onUpdateTools={() => undefined}
        >
          <p data-testid="slot">runs</p>
        </DrawerList>,
      );
    });
    expect(q('slot')).not.toBeNull();
  });
});

describe('the processing list without a project of its own', () => {
  it('has no start button and no lists of its own, only what runs elsewhere', () => {
    const other = job({ project: 'D:\\Sites\\B', status: 'running' });
    show({ projectName: null, elsewhere: [{ job: other, project: 'North quarry' }] });
    expect(q('create-maps')).toBeNull();
    expect(q('proc-running')).toBeNull();
    expect(q('proc-finished')).toBeNull();
    expect(q('proc-empty')).toBeNull();
    expect(rows('proc-elsewhere')).toHaveLength(1);
  });

  it('says no project is open when nothing runs anywhere', () => {
    show({ projectName: null });
    expect(q('proc-none')?.textContent).toBe('No project is open.');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/DrawerList.test.tsx --retry=0`
Expected: FAIL, cannot resolve `./DrawerList`.

- [ ] **Step 3: Write `DrawerList.tsx`**

```tsx
/**
 * The list view of the Processing drawer, from props only: the one start button, the tools
 * notice, the open project's running and finished jobs, its maps from photos (the slot) and what
 * runs in other projects. With no project of its own, only the last part.
 */
import type { JobRecord } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { useState, type ReactNode } from 'react';
import { JobRow } from './JobList';
import './processing.css';

/** Finished jobs shown before **Show older**. */
export const FINISHED_SHOWN = 20;

export interface DrawerListProps {
  /** The open project's name; null with no project of its own (none open, or a package). */
  projectName: string | null;
  running: readonly JobRecord[];
  finished: readonly JobRecord[];
  elsewhere: readonly { job: JobRecord; project: string }[];
  toolsMissing: boolean;
  now: number;
  onPick: (id: string) => void;
  onCreateMaps: () => void;
  onUpdateTools: () => void;
  /** The project's maps from photos (`PhotoRuns`), shown under Finished. */
  children?: ReactNode;
}

export function DrawerList({
  projectName,
  running,
  finished,
  elsewhere,
  toolsMissing,
  now,
  onPick,
  onCreateMaps,
  onUpdateTools,
  children,
}: DrawerListProps) {
  const [older, setOlder] = useState(false);
  const own = projectName !== null;
  const shown = older ? finished : finished.slice(0, FINISHED_SHOWN);
  const row = (job: JobRecord, project?: string) => (
    <JobRow
      key={job.id}
      job={job}
      selected={false}
      now={now}
      project={project}
      onPick={() => {
        onPick(job.id);
      }}
    />
  );
  return (
    <div className="proc-list">
      {own && (
        <button
          type="button"
          className="btn primary proc-go"
          data-testid="create-maps"
          onClick={onCreateMaps}
        >
          <Icon name="photo" size={16} />
          {t('processing.createMaps')}
        </button>
      )}
      {own && toolsMissing && (
        <div className="proc-tools" data-testid="proc-tools">
          <Icon name="warn" size={14} />
          <span>{t('processing.toolsMissing')}</span>
          <button type="button" className="btn sm" onClick={onUpdateTools}>
            {t('processing.toolsUpdate')}
          </button>
        </div>
      )}
      {own && running.length > 0 && (
        <section data-testid="proc-running">
          <h3 className="caps">{t('processing.running')}</h3>
          <div role="list" aria-label={t('processing.running')}>
            {running.map((j) => row(j))}
          </div>
        </section>
      )}
      {own && finished.length > 0 && (
        <section data-testid="proc-finished">
          <h3 className="caps">{t('processing.finished')}</h3>
          <div role="list" aria-label={t('processing.finished')}>
            {shown.map((j) => row(j))}
          </div>
          {!older && finished.length > FINISHED_SHOWN && (
            <button
              type="button"
              className="btn sm ghost"
              data-testid="proc-older"
              onClick={() => {
                setOlder(true);
              }}
            >
              {t('processing.older')}
            </button>
          )}
        </section>
      )}
      {own && running.length === 0 && finished.length === 0 && (
        <p className="proc-empty faint" data-testid="proc-empty">
          {t('processing.empty', { name: projectName })}
        </p>
      )}
      {own && children}
      {elsewhere.length > 0 && (
        <section data-testid="proc-elsewhere">
          <h3 className="caps">{t('processing.elsewhere')}</h3>
          <div role="list" aria-label={t('processing.elsewhere')}>
            {elsewhere.map((e) => row(e.job, e.project))}
          </div>
        </section>
      )}
      {!own && elsewhere.length === 0 && (
        <p className="proc-empty faint" data-testid="proc-none">
          {t('processing.noProject')}
        </p>
      )}
    </div>
  );
}
```

Append to `processing.css`:

```css
/* ---------- processing: the drawer's list ---------- */
.proc-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.proc-list h3 {
  margin: 0 0 6px;
}
.proc-go {
  justify-content: center;
}
.proc-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 12px;
}
.proc-empty {
  margin: 0;
  font-size: 12px;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/processing/DrawerList.test.tsx --retry=0`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/processing/DrawerList.tsx apps/desktop/src/renderer/processing/DrawerList.test.tsx apps/desktop/src/renderer/processing/processing.css
git commit -m "feat(desktop): the list of a project's processing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The drawer and the start dialog

**Files:**

- Create: `apps/desktop/src/renderer/processing/ProcessingDrawer.tsx`
- Create: `apps/desktop/src/renderer/processing/PipelineDialog.tsx`
- Modify: `apps/desktop/src/renderer/processing/processing.css` (append)

**Interfaces:**

- Consumes: `DrawerList` (Task 7); `JobDetail`, `PipelineForm`, `useNow` (Task 5); `projectJobs`, `runningElsewhere`, `projectLabel`, `shownJob` (Task 3); `processing`, `useProcessing` (Task 4); `jobTitle` (Task 2); `PhotoRuns` from `../photogrammetry/PhotoRuns`; `photoUi` from `../photogrammetry/store`; `openProcessingTools` from `../processingTools`.
- Produces: `ProcessingDrawer()`, `PipelineDialog()` (both mounted in Task 10), and `focusChip(): void` exported from `ProcessingDrawer.tsx`.

Both are thin containers over tested parts; the end to end spec of Task 12 exercises them.

- [ ] **Step 1: Write `ProcessingDrawer.tsx`**

```tsx
/**
 * The Processing drawer: the open project's processing, opened from the title bar chip. It lies
 * over the right of the screen and does not block the app. The list (`DrawerList`), or one job's
 * details with **Back**. Esc inside it, or its close button, closes it; focus returns to the chip.
 * It also closes when the photo wizard or a run's panel opens over the screen.
 */
import { Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { PhotoRuns } from '../photogrammetry/PhotoRuns';
import { photoUi } from '../photogrammetry/store';
import { openProcessingTools } from '../processingTools';
import { jobs, useJobs, useShell } from '../shell';
import { DrawerList } from './DrawerList';
import { JobDetail } from './JobDetail';
import { useNow } from './JobParts';
import { projectJobs, projectLabel, runningElsewhere, shownJob } from './model';
import { processing, useProcessing } from './store';
import './processing.css';

export function focusChip(): void {
  document.querySelector<HTMLElement>('[data-testid="processing-chip"]')?.focus();
}

export function ProcessingDrawer() {
  useT();
  const open = useProcessing((s) => s.open);
  const picked = useProcessing((s) => s.picked);
  const all = useJobs((s) => s.jobs);
  const runtime = useJobs((s) => s.runtime);
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg !== null);
  const library = useShell((s) => s.library);
  const heading = useRef<HTMLHeadingElement>(null);
  const own = project !== null && !pkg;
  const root = own ? project.root : null;
  const mine = useMemo(() => projectJobs(all, root), [all, root]);
  const elsewhere = useMemo(
    () =>
      runningElsewhere(all, root).map((job) => ({
        job,
        project: projectLabel(job.project, library ?? []),
      })),
    [all, root, library],
  );
  const now = useNow(open && mine.running.length + elsewhere.length > 0);
  const photoOpen = useStore(photoUi, (s) => s.view !== null);

  // the photo wizard and a run's panel lie over the screen: the drawer makes way for them
  useEffect(() => {
    if (photoOpen) processing.getState().closeDrawer();
  }, [photoOpen]);
  // opening reads the list again and takes the focus
  useEffect(() => {
    if (!open) return;
    void jobs.getState().refresh();
    heading.current?.focus();
  }, [open]);

  if (!open) return null;
  // a picked job that is gone, or of a project no longer open, falls back to the list
  const job = shownJob(all, picked, root);
  const close = () => {
    processing.getState().closeDrawer();
    focusChip();
  };
  return (
    <aside
      id="processing-drawer"
      className="proc-drawer"
      aria-label={t('processing.title')}
      data-testid="processing-drawer"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <header className="proc-h">
        {job && (
          <button
            type="button"
            className="btn sm ghost"
            data-testid="proc-back"
            onClick={() => {
              processing.getState().pick(null);
            }}
          >
            <Icon name="back" size={14} />
            {t('processing.back')}
          </button>
        )}
        <div className="proc-t">
          <h2 ref={heading} tabIndex={-1}>
            {t('processing.title')}
          </h2>
          {own && (
            <p className="muted" dir="auto" data-testid="proc-project">
              {project.manifest.name}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('processing.close')}
          data-testid="proc-close"
          onClick={close}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="proc-b">
        {job ? (
          <JobDetail job={job} now={now} folded />
        ) : (
          <DrawerList
            projectName={own ? project.manifest.name : null}
            running={mine.running}
            finished={mine.finished}
            elsewhere={elsewhere}
            toolsMissing={runtime?.found === false}
            now={now}
            onPick={(id) => {
              processing.getState().pick(id);
              void jobs.getState().select(id);
            }}
            onCreateMaps={() => {
              // the drawer closes as the wizard opens (the effect above)
              photoUi.getState().openWizard();
            }}
            onUpdateTools={() => {
              close();
              openProcessingTools();
            }}
          >
            <PhotoRuns />
          </DrawerList>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Write `PipelineDialog.tsx`**

```tsx
/**
 * Start one pipeline for the open project: the pipeline's own fields, never a project folder.
 * Opened with `processing.getState().openDialog(draft)` from the screen the work belongs to
 * (Detections, road setup). When the job has started, the Processing drawer opens on it.
 */
import { Icon, t, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useRef } from 'react';
import { PipelineForm } from './PipelineForm';
import { jobTitle } from './pipelines';
import { processing, useProcessing } from './store';
import './processing.css';

export function PipelineDialog() {
  useT();
  const req = useProcessing((s) => s.dialog);
  const name = useWorkspace((s) => s.project?.manifest.name);
  const dlg = useRef<HTMLDivElement>(null);
  const close = () => {
    processing.getState().closeDialog();
  };
  useFocusTrap(dlg, req !== null, { onEscape: close });
  if (!req || name === undefined) return null;
  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dlg}
        className="dlg proc-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="proc-dlg-h"
        data-testid="pipeline-dialog"
      >
        <div className="dlg-h">
          <div>
            <h2 id="proc-dlg-h">{jobTitle(req.pipeline)}</h2>
            <span className="sub" dir="auto">
              {t('processing.dialog.runsIn', { name })}
            </span>
          </div>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('processing.close')}
            onClick={close}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="dlg-b">
          <PipelineForm
            key={req.pipeline}
            fixed
            draft={req}
            onClose={close}
            onStarted={(id) => {
              processing.getState().openDrawer(id);
            }}
          />
        </div>
      </div>
    </div>
  );
}
```

Read `apps/desktop/src/renderer/detections/AiDetectDialog.tsx` lines 258 to 296 first and match its `dlg-scrim` / `dlg` / `dlg-h` markup exactly (heading level, the `sub` span), so the dialog looks like the app's others.

Append to `processing.css`:

```css
/* ---------- processing: the drawer ---------- */
.proc-drawer {
  position: fixed;
  inset-block: var(--tb-h) 0;
  inset-inline-end: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  width: min(400px, calc(100vw - 56px));
  border-inline-start: 1px solid var(--line);
  background: var(--bg-1);
  box-shadow: -8px 0 24px rgb(0 0 0 / 25%);
}
.proc-h {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.proc-t {
  flex: 1;
  min-width: 0;
}
.proc-t h2 {
  margin: 0;
  font-size: 15px;
}
.proc-t h2:focus {
  outline: none;
}
.proc-t p {
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.proc-b {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
}
.proc-dlg .new-job {
  padding: 0;
}
```

`--tb-h` is the title bar's height (the `.app` grid uses it), `--bg-1` the panel background. The drawer's layer, 50, is above the screen and below the toasts and the guide (60) and the dialogs (`.dlg-scrim`, 110), so the photo wizard, the start dialog and a toast all show over it.

- [ ] **Step 3: Types and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors. (Nothing mounts the two components yet; Task 10 does.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/processing/ProcessingDrawer.tsx apps/desktop/src/renderer/processing/PipelineDialog.tsx apps/desktop/src/renderer/processing/processing.css
git commit -m "feat(desktop): the Processing drawer and the start dialog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Settings, Processing tools, Advanced

**Files:**

- Create: `apps/desktop/src/renderer/processing/AdvancedPipelines.tsx`
- Modify: `apps/desktop/src/renderer/screens/settings/ProcessingTools.tsx` (one import, one line in the last `return`)
- Modify: `apps/desktop/src/renderer/processing/processing.css` (append)

**Interfaces:**

- Consumes: `PipelineForm`, `JobRow`, `JobDetail`, `useNow` (Task 5); `projectLabel` (Task 3); message keys (Task 1).
- Produces: `AdvancedPipelines()`.

- [ ] **Step 1: Write `AdvancedPipelines.tsx`**

```tsx
/**
 * Settings, Processing tools, **Advanced: run a pipeline directly**: every pipeline of the
 * processing tools with its own form, and every job on this computer whichever project it
 * belongs to. For support and the automated tests; folded until asked for.
 */
import { t, useT } from '@aio/ui';
import { useEffect, useState } from 'react';
import { isActive } from '../jobs';
import { jobs, useJobs, useShell } from '../shell';
import { JobDetail } from './JobDetail';
import { JobRow } from './JobList';
import { useNow } from './JobParts';
import { projectLabel } from './model';
import { PipelineForm } from './PipelineForm';
import './processing.css';

export function AdvancedPipelines() {
  useT();
  const [open, setOpen] = useState(false);
  const list = useJobs((s) => s.jobs);
  const selected = useJobs((s) => s.selected);
  const library = useShell((s) => s.library);
  const now = useNow(open && list.some(isActive));
  const job = list.find((j) => j.id === selected);
  useEffect(() => {
    if (open) void jobs.getState().refresh();
  }, [open]);
  return (
    <details
      className="sblock proc-adv"
      data-testid="job-advanced"
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary>{t('processing.advanced.title')}</summary>
      {open && (
        <>
          <p className="help">{t('processing.advanced.help')}</p>
          <PipelineForm />
          <h3 className="caps">{t('processing.advanced.all')}</h3>
          {list.length === 0 ? (
            <p className="help" data-testid="jobs-none">
              {t('processing.advanced.none')}
            </p>
          ) : (
            <div className="jobs-list" role="list" aria-label={t('processing.advanced.all')}>
              {list.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  selected={j.id === job?.id}
                  now={now}
                  project={projectLabel(j.project, library ?? [])}
                  onPick={() => {
                    void jobs.getState().select(j.id);
                  }}
                />
              ))}
            </div>
          )}
          {job && <JobDetail job={job} now={now} />}
        </>
      )}
    </details>
  );
}
```

- [ ] **Step 2: Mount it**

In `apps/desktop/src/renderer/screens/settings/ProcessingTools.tsx` add the import

```tsx
import { AdvancedPipelines } from '../../processing/AdvancedPipelines';
```

and in the component's last `return`, directly before the closing `</>`:

```tsx
<AdvancedPipelines />
```

- [ ] **Step 3: Styles**

Append to `processing.css`:

```css
/* ---------- processing: Settings, Processing tools, Advanced ---------- */
.proc-adv > summary {
  cursor: pointer;
  font-weight: 600;
}
.proc-adv[open] > summary {
  margin-bottom: 8px;
}
.proc-adv .new-job {
  padding: 0;
  max-width: 560px;
}
.proc-adv .jobs-list {
  max-height: 320px;
  overflow-y: auto;
  margin-bottom: 12px;
}
.proc-adv .job-detail {
  padding: 0;
  overflow: visible;
}
```

- [ ] **Step 4: Types, lint and the Settings unit tests**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

Run: `pnpm exec vitest run apps/desktop/src/renderer/screens/settings --retry=0`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/processing/AdvancedPipelines.tsx apps/desktop/src/renderer/processing/processing.css apps/desktop/src/renderer/screens/settings/ProcessingTools.tsx
git commit -m "feat(desktop): raw pipeline forms and all jobs under Settings, Advanced" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Wire the shell and remove the Jobs screen

**Files:**

- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/shell/TitleBar.tsx`
- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx`
- Modify: `apps/desktop/src/renderer/shell/Palette.tsx`
- Modify: `apps/desktop/src/renderer/store.ts:20-31`
- Modify: `apps/desktop/src/renderer/processingTools.ts` (`resumeAfterTools`)
- Modify: `apps/desktop/src/renderer/ProcessingToolsNotice.tsx`
- Modify: `apps/desktop/src/renderer/road/RoadSetup.tsx` (`runRoadBuilder`)
- Modify: `apps/desktop/src/renderer/builder/NewProjectWizard.tsx:254-255`
- Modify: `apps/desktop/src/renderer/jobs.ts` (the draft leaves the store)
- Modify: `apps/desktop/src/renderer/styles.css` (the Jobs screen's own rules)
- Modify: `packages/ui/src/i18n/en.ts` (`nav.jobs` goes)
- Delete: `apps/desktop/src/renderer/screens/Jobs.tsx`, `screens/jobTaskActions.ts`, `screens/jobTasks.ts`, `screens/jobTasks.test.ts`

`RoadSetup.tsx`, `NewProjectWizard.tsx` and `processingTools.ts` are in this task, not Task 11, because each calls `go('jobs')`, which stops compiling the moment the screen is removed.

**Interfaces:**

- Consumes: `ProcessingChip` (Task 6), `ProcessingDrawer`, `PipelineDialog` (Task 8), `processing` (Task 4), `jobTitle` from `processing/pipelines` (Task 2).
- Produces: no `jobs` screen; `jobs` store without `draft` and `prepare` (the type `JobDraft` stays in `jobs.ts`).

- [ ] **Step 1: `store.ts`**

Remove the line `  | 'jobs'` from `export type Screen`.

- [ ] **Step 2: `App.tsx`**

- Remove `import { JobsScreen } from './screens/Jobs';` and the `case 'jobs': return <JobsScreen />;` arm.
- Change `import { jobTitle } from './screens/jobTasks';` to `import { jobTitle } from './processing/pipelines';`.
- Add:

```tsx
import { PipelineDialog } from './processing/PipelineDialog';
import { ProcessingDrawer } from './processing/ProcessingDrawer';
```

- In the returned tree, after `<Palette />`:

```tsx
      <ProcessingDrawer />
      <PipelineDialog />
```

- [ ] **Step 3: `TitleBar.tsx`**

- Remove `  jobs: 'nav.jobs',` from `VIEW_LABEL`.
- Add `import { ProcessingChip } from '../processing/ProcessingChip';`.
- Make it the first child of `<div className="tb-status">`:

```tsx
<ProcessingChip />
```

- [ ] **Step 4: `Sidebar.tsx`**

- Remove `  { screen: 'jobs', label: 'nav.jobs', icon: 'clock' },` from `NAV`.
- Remove `const runningJobs = useJobs((s) => s.jobs.filter(isActive).length);` and the imports `isActive` and `useJobs` if nothing else in the file uses them.
- Replace

```tsx
// Pipelines write into project folders: a package (player) has no Jobs.
const nav = pkg ? withReview.filter((n) => n.screen !== 'jobs') : withReview;
```

with `const nav = withReview;` (and remove `const pkg = …` if it is now unused).

- Replace the `count` expression with:

```tsx
              count={
                n.screen === 'projects'
                  ? libCount
                  : n.screen === 'issues'
                    ? issueCount
                    : undefined
              }
```

- [ ] **Step 5: `Palette.tsx`**

- Remove `  { screen: 'jobs', title: 'Jobs', icon: 'clock' },` from `SCREENS`.
- Add `import { processing } from '../processing/store';`.
- Directly after the `go:processing-tools` command, add:

```tsx
// the open project's processing (the title bar chip opens the same drawer)
list.push({
  id: 'open:processing',
  title: t('processing.title'),
  group: 'Navigate',
  icon: 'clock',
  keywords: ['jobs', 'running', 'progress', 'log', 'maps from photos'],
  run: () => {
    processing.getState().openDrawer();
  },
});
```

- [ ] **Step 6: `processingTools.ts`**

In `resumeAfterTools`, replace `shell.getState().go('jobs');` with `shell.getState().go('scene');`. In the file's header comment and in the comment above `onChanged`, replace "the Jobs header" with "the Processing drawer", and in the comment of `openProcessingTools` replace "the Jobs screen" with "the Processing drawer".

- [ ] **Step 7: `ProcessingToolsNotice.tsx`**

Add `import { useProcessing } from './processing/store';`. Replace

```tsx
const jobsSaysIt = screen === 'jobs' && status.state !== 'too-old';
if (screen === 'settings' || photoOpen || jobsSaysIt) return null;
```

with

```tsx
const drawerSaysIt = drawerOpen && status.state !== 'too-old';
if (screen === 'settings' || photoOpen || drawerSaysIt) return null;
```

and add, beside the other hooks (above the `useEffect`, so hook order never changes):

```tsx
// the Processing drawer says it itself when no tools can be used at all
const drawerOpen = useProcessing((s) => s.open);
```

In the doc comment and the inline comment, replace `the Jobs screen's "Jobs cannot run yet"` with `the Processing drawer's "Processing cannot run yet"`, and "and Jobs, whose own panel" with "and the Processing drawer, which".

- [ ] **Step 8: `road/RoadSetup.tsx`**

Replace `runRoadBuilder` with:

```tsx
/** Open the road survey's start dialog for the open project, the drawn line filled in. */
export function runRoadBuilder(): void {
  const root = workspace.getState().project?.root;
  if (!root) return;
  const saved = setupStore.getState().saved;
  processing.getState().openDialog({
    pipeline: 'road.build',
    project: root,
    values: saved ? { centreline: DRAWN_CENTRELINE } : {},
  });
}
```

Add `import { processing } from '../processing/store';` and drop `jobs` and `shell` from the `../shell` import if nothing else in the file uses them (`shell` is used by `startDrawing`; `jobs` is not).

- [ ] **Step 9: `builder/NewProjectWizard.tsx`**

Replace `shell.getState().go('jobs');` (line 255) with:

```tsx
// the new project is open on the Scene (`created`): show its build, the job just started
processing.getState().openDrawer(jobError ? undefined : (jobs.getState().selected ?? undefined));
```

Add `import { processing } from '../processing/store';`.

- [ ] **Step 10: `jobs.ts`**

Remove from `JobsState` the field `draft: JobDraft | null;`, from `JobsActions` the action `prepare`, and from `createJobsStore` the `draft: null,` initial value and the `prepare: (draft) => { set({ draft }); },` action. Change the comment on `JobDraft` to:

```ts
/** One pipeline with its form filled in, for the start dialog (`processing/PipelineDialog`). */
```

Run `grep -rn "prepare(\|\.draft" apps/desktop/src/renderer --include=*.ts --include=*.tsx` and fix any test that still sets them (`jobs.test.ts` may assert the initial `draft: null`: remove that assertion).

- [ ] **Step 11: Delete the screen**

```bash
git rm apps/desktop/src/renderer/screens/Jobs.tsx apps/desktop/src/renderer/screens/jobTaskActions.ts apps/desktop/src/renderer/screens/jobTasks.ts apps/desktop/src/renderer/screens/jobTasks.test.ts
```

- [ ] **Step 12: `styles.css`**

In the block that starts at `/* ---------- jobs ---------- */` (near line 3676), delete the rules that only the removed screen used and keep the ones the moved parts use.

Delete: `.jobs`, `.jobs-side`, `.jobs-h` (and its `h1`, `p`, `.btn`), `.jobs-rt` (all of them, including `.jobs-rt-fix`), `.jobs-side > .nj-err`, `.jobs-go` (both), `.job-new` (both), `.jn-h` (all), `.jn-sec` (both), `.jn-tasks`, every `.nj-task` rule, `.nj-task .nj-need`, `.jn-adv` (all).

Keep: `.new-job`, every `.nj-field`, `.nj-list`, `.nj-row`, `.nj-help`, `.nj-err`, `.nj-acts` rule, `.jobs-list`, `.jl-h`, every `.job-row`, `.jr-*`, `.job-state`, `.job-bar`, `.job-detail`, `.jd-*`, `.job-log` rule.

Rename the block's comment to `/* ---------- jobs: rows, details and the pipeline form (renderer/processing) ---------- */`.

Then check nothing else used a deleted class: `grep -rn "jobs-side\|jobs-h\|jobs-rt\|jobs-go\|job-new\|jn-h\|jn-sec\|jn-tasks\|nj-task\|nj-need\|jn-adv" apps/desktop/src packages --include=*.tsx --include=*.ts --include=*.css` must print nothing.

- [ ] **Step 13: `en.ts`**

Remove the line `  'nav.jobs': 'Jobs',`.

- [ ] **Step 14: Find what is left**

Run: `grep -rn "'jobs'\|screens/Jobs\|jobTasks\|jobTaskActions\|nav\.jobs" apps/desktop/src packages/ui/src --include=*.ts --include=*.tsx`
Expected: only `Pick<JobsState, 'jobs' | 'logs'>` in `jobs.ts` and the `'jobs'` search keyword of the two palette commands (a person may still type "jobs" to find Processing).

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

Run: `pnpm exec vitest run apps/desktop/src/renderer packages/ui --retry=0`
Expected: PASS.

- [ ] **Step 15: See it in the app**

From `apps/desktop`:

```bash
pnpm exec electron-vite build
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/shell.spec.ts --workers=1
```

Expected: it passes (the sidebar, the title bar and the command search render without the Jobs screen). The e2e fixtures keep the window off-screen; never start a visible app on the workstation. Specs that still click the Jobs item are fixed in Tasks 12 and 13, not here.

- [ ] **Step 16: Commit**

```bash
git add -A apps/desktop/src/renderer packages/ui/src/i18n/en.ts
git commit -m "feat(desktop): processing lives in the project, the Jobs screen is gone" -m "The title bar chip opens the open project's drawer. The road survey build
and the new stockpile project lead to it instead of to the Jobs screen." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Entry points and wording

**Files:**

- Modify: `apps/desktop/src/renderer/screens/Detections.tsx` (the header, after the `det-ai-open` button)
- Modify: `apps/desktop/src/renderer/screens/FirstStart.tsx:66-67`
- Modify: `packages/ui/src/i18n/en.ts` (lines near 676, 694, 909, 910, 1035, 1076, 2718, 2719)

**Interfaces:**

- Consumes: `processing.getState().openDialog(draft: JobDraft)` (Task 4), the mounted `PipelineDialog` (Task 10), message key `det.toIssues` (Task 1).

- [ ] **Step 1: The Detections button**

In `apps/desktop/src/renderer/screens/Detections.tsx`, add `import { processing } from '../processing/store';`. Directly after the closing `</button>` of the `data-testid="det-ai-open"` button (near line 484), add:

```tsx
{
  project.manifest.type === 'inspection' && (
    <button
      type="button"
      className="btn sm"
      data-testid="det-to-issues"
      disabled={readOnly}
      onClick={() => {
        processing
          .getState()
          .openDialog({ pipeline: 'inspection.run', project: project.root, values: {} });
      }}
    >
      <Icon name="issues" size={14} />
      {t('det.toIssues')}
    </button>
  );
}
```

`project` and `readOnly` are already in scope there (the neighbouring button uses `readOnly`; `project.id` is used further down). If `project` is typed without `root` in this component, read it from `useWorkspace((s) => s.project)` as the file already does.

- [ ] **Step 2: Wording that still says Jobs**

In `packages/ui/src/i18n/en.ts` change these values (keys unchanged):

| Key                                                            | New value                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.installed`                                              | `Processing tools {version} are installed. Processing uses them from now on.`                                                         |
| the key at line 694 (the "not made for this version" sentence) | `The processing tools on this computer are not made for this version of {product}. Processing does not start until they are updated.` |
| `builder.surveys.count_one`                                    | `{count} survey date, built after creating (see Processing)`                                                                          |
| `builder.surveys.count_other`                                  | `{count} survey dates, built after creating (see Processing)`                                                                         |
| the key at line 2718 (`Building {name} in the pipeline pack…`) | `Building {name} with the processing tools. It appears here when it is done.`                                                         |
| `g7.packs.failed`                                              | `The pack was not built. Settings, Processing tools, Advanced lists the job and its log.`                                             |

Change the two comments `// Jobs: inspection pipeline form` and `// Road builder (road.build in the Jobs panel)` to `// Inspection pipeline form (Detections, Turn detections into issues)` and `// Road builder (road.build, started from road setup)`.

In `apps/desktop/src/renderer/screens/FirstStart.tsx` lines 66 and 67, replace `in Jobs.` with `in the background.` and `(Jobs)` with nothing, so the two sentences read:

```
'Builds projects from raw photos, surveys and road data in the background.'
'Needed to build projects from raw data, for survey processing and for Suggest boundaries. Viewing, annotating, measuring, volumes, maps and reports work wit…'
```

Keep the rest of the second sentence exactly as it is in the file.

- [ ] **Step 3: Nothing user-facing says Jobs any more**

Run: `grep -rn "Jobs\b" apps/desktop/src/renderer packages/ui/src/i18n/en.ts --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -v "^.*://\|JobsState\|JobsActions\|type Jobs\|<Jobs>\|useJobs\|createJobsStore\|: Jobs\b"`
Expected: only code comments. Read each hit: a string a person can see must not say "Jobs".

Run: `pnpm typecheck && pnpm lint && pnpm exec vitest run apps/desktop/src/renderer packages/ui --retry=0`
Expected: no errors, PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/screens/Detections.tsx apps/desktop/src/renderer/screens/FirstStart.tsx packages/ui/src/i18n/en.ts
git commit -m "feat(desktop): start the AI inspection from Detections" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: End to end helpers and the new spec

**Files:**

- Modify: `apps/desktop/e2e/fixtures.ts:656-665` (`openPipelineForm`; two new helpers)
- Modify: `apps/desktop/e2e/photoPack.ts:318-325` (`openWizard`)
- Create: `apps/desktop/e2e/processing-drawer.spec.ts`
- Delete: `apps/desktop/e2e/jobs-chooser.spec.ts`
- Modify: `tools/ci/e2e-timings.json`

**Interfaces:**

- Produces, from `e2e/fixtures.ts`:
  - `processingChip(win: Page): Locator`
  - `openProcessing(win: Page): Promise<Locator>` (the drawer; a no-op when it is open)
  - `closeProcessing(win: Page): Promise<void>`
  - `openPipelineForm(win: Page): Promise<void>` now goes to Settings, Processing tools, Advanced by itself and is safe to call twice.

Playwright runs one at a time on this workstation: `--workers=1`, and never while another Playwright run is going.

- [ ] **Step 1: The helpers in `fixtures.ts`**

Replace the doc comment and body of `openPipelineForm` (lines 656 to 665) with:

```ts
/** The title bar chip of the open project's processing. */
export const processingChip = (win: Page) => win.getByTestId('processing-chip');

/** Open the Processing drawer from its chip (nothing to do when it is open); the drawer. */
export async function openProcessing(win: Page) {
  const drawer = win.getByTestId('processing-drawer');
  if (!(await drawer.isVisible())) await processingChip(win).click();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Close the Processing drawer if it is open. */
export async function closeProcessing(win: Page): Promise<void> {
  const drawer = win.getByTestId('processing-drawer');
  if (await drawer.isVisible()) await drawer.getByTestId('proc-close').click();
  await expect(drawer).toHaveCount(0);
}

/**
 * Settings, Processing tools, **Advanced: run a pipeline directly**: the form that takes a
 * pipeline (`#job-pipeline`) and its parameters and starts it (`job-start`), with every job on
 * this computer and the details of the one started below it. Specs that run a pipeline by name go
 * through here. Safe to call again while the form is showing.
 */
export async function openPipelineForm(win: Page): Promise<void> {
  const form = win.locator('#job-pipeline');
  if (await form.isVisible()) return;
  await closeProcessing(win);
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Processing tools' })
    .click();
  const advanced = win.getByTestId('job-advanced');
  if (!(await advanced.evaluate((el) => (el as HTMLDetailsElement).open)))
    await advanced.locator('summary').click();
  await expect(form).toBeVisible();
}
```

- [ ] **Step 2: `openWizard` in `photoPack.ts`**

Replace lines 318 to 325 with:

```ts
/** The Processing drawer's **Create maps from photos**: the one-screen dialog. */
export async function openWizard(win: Page) {
  const drawer = await openProcessing(win);
  await drawer.getByTestId('create-maps').click();
  const wizard = win.getByRole('dialog', { name: 'Create maps from photos' });
  await expect(wizard).toBeVisible();
  return wizard;
}
```

and add `openProcessing` to the file's existing import from `./fixtures`.

- [ ] **Step 3: Write the new spec**

Create `apps/desktop/e2e/processing-drawer.spec.ts`:

```ts
/**
 * Processing belongs to the project: the title bar chip and the drawer it opens show the open
 * project's processing and nothing else; **Create maps from photos** starts from the drawer; the
 * raw pipeline forms and every job on this computer are under Settings, Processing tools,
 * **Advanced**. The first tests start no job and need no pipeline Python.
 */
import { PIPELINES } from '@aio/schema';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import {
  closeProcessing,
  expect,
  hasPipelinePython,
  launchApp,
  openPipelineForm,
  openProcessing,
  PIPELINE_ENV,
  processingChip,
  test,
} from './fixtures';

/** Screenshots for a person to look at: only with QUADRION_E2E_SHOTS set to a folder. */
const SHOTS = process.env.QUADRION_E2E_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const TINY = 'E2E tiny project';

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: TINY }).click();
  await expect(win.locator('.crumbs')).toContainText(TINY);
}

test('the chip opens the open project processing, and closing gives the focus back', async ({
  win,
}) => {
  // no project, nothing running: no chip, and no Jobs item in the sidebar
  await expect(processingChip(win)).toHaveCount(0);
  await expect(win.locator('.sb-nav .nav-item', { hasText: 'Jobs' })).toHaveCount(0);

  await openTiny(win);
  const chip = processingChip(win);
  await expect(chip).toHaveText('Processing');
  await expect(chip).toHaveAttribute('aria-expanded', 'false');

  const drawer = await openProcessing(win);
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.getByRole('heading', { level: 2, name: 'Processing' })).toBeFocused();
  await expect(drawer.getByTestId('proc-project')).toHaveText(TINY);
  await expect(drawer.getByTestId('create-maps')).toHaveText('Create maps from photos');
  await expect(drawer.getByTestId('proc-empty')).toHaveText(
    `Nothing is processing in ${TINY} and nothing has finished yet.`,
  );
  await expect(drawer.getByTestId('photo-runs')).toBeVisible();
  // plain words: no pipeline names, no dashes
  expect(await drawer.innerText()).not.toMatch(/pipeline|photogrammetry|COPC|–|—/i);
  await expectAccessible(win, 'Processing drawer', {
    include: '[data-testid="processing-drawer"]',
  });
  await shot(win, 'processing-drawer');

  // Esc inside the drawer closes it; the chip has the focus again
  await win.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(chip).toBeFocused();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');

  // the drawer stays with the project across screens
  await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
  await expect(chip).toHaveText('Processing');
});

test('Create maps from photos starts from the drawer, which makes way for it', async ({ win }) => {
  await openTiny(win);
  const drawer = await openProcessing(win);
  await drawer.getByTestId('create-maps').click();
  await expect(win.getByRole('dialog', { name: 'Create maps from photos' })).toBeVisible();
  await expect(drawer).toHaveCount(0);
});

test('a project that is not an inspection has no Turn detections into issues', async ({ win }) => {
  await openTiny(win);
  await win.locator('.sb-nav .nav-item', { hasText: 'Detections' }).click();
  await expect(win.locator('.crumbs b')).toHaveText('Detections');
  await expect(win.getByTestId('det-to-issues')).toHaveCount(0);
});

test('Settings, Advanced holds every pipeline by area and every job on this computer', async ({
  win,
}) => {
  await openTiny(win);
  await openPipelineForm(win);
  const advanced = win.getByTestId('job-advanced');
  const pick = win.locator('#job-pipeline');
  expect(await pick.locator('optgroup').evaluateAll((els) => els.map((e) => e.label))).toEqual([
    'Photos to maps',
    'Inspection',
    'Stockpiles and volumes',
    'Change between dates',
    'Survey tools',
    'Water and haul roads',
    'Import and convert',
    'Map packs',
    'Road survey',
    'System',
  ]);
  const values = await pick.locator('option').evaluateAll((els) => els.map((e) => e.value));
  expect([...values].sort()).toEqual(PIPELINES.map((p) => p.name).sort());

  await pick.selectOption('pointcloud.to_copc');
  const info = PIPELINES.find((p) => p.name === 'pointcloud.to_copc');
  await expect(advanced).toContainText(info?.description ?? '');
  // the open project is the folder the form starts from
  await expect(win.getByLabel(/^Project folder/)).not.toHaveValue('');
  await expect(win.getByTestId('job-start')).toBeVisible();
  await expect(advanced.getByTestId('jobs-none')).toHaveText(
    'No job has run on this computer yet.',
  );
  await expectAccessible(win, 'Settings, Advanced pipelines', {
    include: '[data-testid="job-advanced"]',
  });
  await advanced.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
  });
  await shot(win, 'processing-advanced');
});

test.describe('with the runtime', () => {
  test.skip(!hasPipelinePython(), 'no Python with aio_pipelines (uv sync in python/)');

  test('a job shows on its project chip and drawer, and as running elsewhere after', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(180_000);
    const app = await launchApp(dataRoot, PIPELINE_ENV);
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await openTiny(win);

      // a self-test that waits a minute, for the open project
      await openPipelineForm(win);
      await win.getByLabel('Pipeline', { exact: true }).selectOption('system.selftest');
      await win.getByLabel('Wait (s)').fill('60');
      await win.getByTestId('job-start').click();
      const chip = processingChip(win);
      await expect(chip).toHaveText(/^Processing \d+%$/, { timeout: 60_000 });
      await expect(chip).toHaveAttribute('data-state', 'one');

      // the project's drawer lists it, with its kind, and opens its details
      await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
      let drawer = await openProcessing(win);
      const row = drawer.getByTestId('proc-running').locator('.job-row');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Check the pipeline pack');
      await expect(row).toHaveAttribute('data-kind', 'system');
      await expect(drawer.getByTestId('proc-empty')).toHaveCount(0);
      await row.click();
      const detail = drawer.locator('.job-detail');
      await expect(detail).toHaveAttribute('data-form', 'folded');
      const wait = detail.locator('.jd-steps li', { hasText: 'Wait' });
      await expect(wait).toHaveAttribute('data-state', 'running', { timeout: 60_000 });
      await expectAccessible(win, 'Processing drawer, a job', {
        include: '[data-testid="processing-drawer"]',
      });

      // cancel and resume from the drawer
      await detail.getByRole('button', { name: 'Cancel' }).click();
      await expect(detail.locator('.jd-h .job-state')).toHaveText('Cancelled', {
        timeout: 15_000,
      });
      await expect(chip).toHaveText('Processing');
      await detail.getByRole('button', { name: 'Resume' }).click();
      await expect(wait).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
      await detail.getByTestId('job-log-fold').locator('summary').click();
      await expect(detail.locator('.job-log')).toContainText('Cancelled');

      // Back to the list, then close the project: the job is now running elsewhere
      await drawer.getByTestId('proc-back').click();
      await expect(drawer.getByTestId('proc-running').locator('.job-row')).toHaveCount(1);
      await closeProcessing(win);
      await win.locator('.proj-switch').focus();
      await win.keyboard.press('Enter');
      await win.locator('.proj-menu').getByRole('menuitem', { name: 'Close project' }).click();
      await expect(chip).toHaveText('Processing · 1 running elsewhere');

      drawer = await openProcessing(win);
      await expect(drawer.getByTestId('create-maps')).toHaveCount(0);
      await expect(drawer.getByTestId('proc-running')).toHaveCount(0);
      const other = drawer.getByTestId('proc-elsewhere').locator('.job-row');
      await expect(other).toHaveCount(1);
      await expect(other).toContainText(TINY);

      // it can be opened and cancelled from here; once it has stopped, nothing is left to show
      await other.click();
      await drawer.locator('.job-detail').getByRole('button', { name: 'Cancel' }).click();
      await expect(drawer.getByTestId('proc-none')).toHaveText('No project is open.', {
        timeout: 15_000,
      });
      await closeProcessing(win);
      await expect(chip).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
```

Before running, open `apps/desktop/e2e/jobs.spec.ts` at the test `start, cancel, resume and finish a job from the Jobs panel` and copy its exact `try` / `finally` shape for a launched app (how it closes the app and what it does with `network`), so this spec ends the same way.

- [ ] **Step 4: Delete the chooser spec and update the timings**

```bash
git rm apps/desktop/e2e/jobs-chooser.spec.ts
```

In `tools/ci/e2e-timings.json` add, in alphabetical order (after the `e2e/photo-*` entries):

```json
  "e2e/processing-drawer.spec.ts": 15,
```

`jobs-chooser.spec.ts` has no entry there, so nothing is removed.

- [ ] **Step 5: Run the new spec the way CI does**

From `apps/desktop`:

```bash
pnpm exec electron-vite build
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/processing-drawer.spec.ts --workers=1
```

Expected: 5 passed (4 when there is no pipeline Python: the last is skipped). Fix the app or the spec until it does. A failure of `toBeFocused` on the heading or the chip is a real focus bug in Task 8: fix it there.

- [ ] **Step 6: Commit**

```bash
git add -A apps/desktop/e2e/fixtures.ts apps/desktop/e2e/photoPack.ts apps/desktop/e2e/processing-drawer.spec.ts apps/desktop/e2e/jobs-chooser.spec.ts tools/ci/e2e-timings.json
git commit -m "test(e2e): the Processing chip, drawer and Settings Advanced" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The specs that reached features through the Jobs screen

Eight specs change. Line numbers are those of `main` at the start of this branch; the quoted lines identify each place.

**Files:**

- Modify: `apps/desktop/e2e/jobs.spec.ts`
- Modify: `apps/desktop/e2e/inspection.spec.ts`
- Modify: `apps/desktop/e2e/opf.spec.ts`
- Modify: `apps/desktop/e2e/samples.spec.ts`
- Modify: `apps/desktop/e2e/road-builder.spec.ts`
- Modify: `apps/desktop/e2e/volumetric-build.spec.ts`
- Modify: `apps/desktop/e2e/photo-process.spec.ts`
- Modify: `apps/desktop/e2e/processing-tools.spec.ts`
- Modify: `apps/desktop/e2e/a11y.spec.ts`

`gcp-marking.spec.ts` and `photo-real.spec.ts` reach the wizard only through `photoPack.ts` (Task 12) and do not change.

**Interfaces:**

- Consumes: `openPipelineForm`, `openProcessing`, `closeProcessing`, `processingChip` from `./fixtures` (Task 12).

- [ ] **Step 1: `jobs.spec.ts`**

Test at line 50. Replace the whole test with:

```ts
test('without a pipeline pack Settings says where it looked', async ({ win, dataRoot }) => {
  await openPipelineForm(win);
  await expect(win.getByTestId('tools-state')).toHaveAttribute('data-state', 'missing');
  // the Location row prints `status.dir ?? status.runtimeDir` (ProcessingTools.tsx)
  await expect(win.getByTestId('tools-info')).toContainText(join(dataRoot.root, 'runtime'));
  await expect(win.getByTestId('job-start')).toBeDisabled();
});
```

Test at line 69 (`the app picks the newest pipeline pack…`). Replace lines 103 to 105

```ts
await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
await expect(win.locator('.jobs-rt')).toContainText(`Processing tools ${newest}`);
await openPipelineForm(win);
```

with

```ts
await openPipelineForm(win);
await expect(win.getByTestId('tools-version')).toHaveText(newest);
```

Test at line 126. Rename it `start, cancel, resume and finish a job from Settings, Advanced`. Replace lines 135 and 136

```ts
await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
await expect(win.locator('.jobs-rt')).toContainText('Processing tools dev');
```

with

```ts
await openPipelineForm(win);
await expect(win.getByTestId('tools-state')).toHaveAttribute('data-state', 'dev');
```

and lines 151 to 153 (the running count on the Jobs nav item) with:

```ts
// no project is open: the title bar says something is running, elsewhere
await expect(processingChip(win)).toHaveText('Processing · 1 running elsewhere');
```

Test at line 182 (the LAZ conversion). Delete lines 216 and 217 (the comment and the click on the Jobs nav item); the wait below them polls `jobs:list` and stays.

Add `processingChip` to the import from `./fixtures`.

- [ ] **Step 2: `inspection.spec.ts`**

Replace `runInspection` (lines 203 to 218) with:

```ts
/**
 * Start the inspection pipeline and wait for it to finish; the job's id. On an inspection
 * project, the way a person does it: Detections, **Turn detections into issues**. Otherwise from
 * Settings, Advanced.
 */
async function runInspection(win: Page, inspectionProject: boolean): Promise<string> {
  if (inspectionProject) {
    await win.locator('.sb-nav .nav-item', { hasText: 'Detections' }).click();
    await win.getByTestId('det-to-issues').click();
    const dialog = win.getByTestId('pipeline-dialog');
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(
      'Inspection: detections to issues',
    );
    await expect(dialog).toContainText('Runs in');
    // one pipeline for the open project: neither is asked for
    await expect(dialog.locator('#job-pipeline')).toHaveCount(0);
    await expect(dialog.locator('#job-f-project')).toHaveCount(0);
    await expect(dialog.getByLabel('Detections', { exact: true })).toBeVisible();
    await dialog.getByTestId('job-start').click();
    await expect(dialog).toHaveCount(0);
  } else {
    await openPipelineForm(win);
    await expect(win.getByTestId('tools-state')).toHaveAttribute('data-state', 'dev');
    await win.getByLabel('Pipeline', { exact: true }).selectOption('inspection.run');
    await expect(win.getByLabel('Detections', { exact: true })).toBeVisible();
    await win.getByTestId('job-start').click();
  }
  // the drawer (from Detections) or the Advanced section shows the job that was started
  const detail = win.locator('.job-detail');
  await expect(detail.locator('.jd-h h2')).toHaveText('Inspection: detections to issues');
  await expect(detail.locator('.jd-h .job-state')).toHaveText('Done', { timeout: 180_000 });
  await expect(detail.locator('.jd-steps li[data-state="done"]')).toHaveCount(6);
  const id = (await detail.getAttribute('data-job')) ?? '';
  await closeProcessing(win);
  return id;
}
```

The three callers (lines 424, 459, 575 with `true`; 674 with `false`) stay as they are. Add `closeProcessing` to the import from `./fixtures`. In the comments at lines 14 and 423 and the test title at line 331, replace "from the Jobs panel" with "from Detections" and "the Jobs panel offers the inspection pipeline" with "Detections offers Turn detections into issues".

- [ ] **Step 3: `opf.spec.ts`**

Delete line 63 (`await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();`). `runJob` calls `openPipelineForm`, which now goes to Settings by itself and returns at once on the second call. In the header comment at line 20, replace "from the Jobs panel" with "from Settings, Advanced".

- [ ] **Step 4: `samples.spec.ts`**

- Lines 187 to 192: delete the line `await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();` inside `run`.
- Line 331: `'2 survey dates, built in Jobs'` becomes `'2 survey dates, built after creating'`.
- Directly after line 332 (`await runJob(win, () => wiz.getByRole('button', { name: 'Create project' }).click(), 240_000);`) add `await closeProcessing(win);` (the new project opens with the drawer on its build).
- Line 411: delete the click on the Jobs nav item.
- Comments at lines 5, 181 and 405: "from the Jobs panel" / "then Jobs, New job, Start job" / "from Jobs" become "from Settings, Advanced".
- Add `closeProcessing` to the import from `./fixtures`.

- [ ] **Step 5: `road-builder.spec.ts`**

Replace lines 220 to 230 with:

```ts
await setup.getByRole('button', { name: 'Run the road builder' }).click();
const dialog = win.getByTestId('pipeline-dialog');
await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Road survey');
await expect(dialog).toContainText('Runs in Road e2e.');
// one pipeline for the open project: neither is asked for, the drawn line is filled in
await expect(dialog.locator('#job-pipeline')).toHaveCount(0);
await expect(dialog.locator('#job-f-project')).toHaveCount(0);
await expect(dialog.locator('#job-f-centreline')).toHaveValue('road/centreline-drawn.geojson');
await dialog.locator('#job-f-ortho').fill(fx.ortho);
await dialog.locator('#job-f-defects').fill(fx.defects);
await dialog.locator('#job-f-unitLength').fill('30');
await dialog.getByTestId('job-start').click();
// the Processing drawer opens on the job
const detail = win.getByTestId('processing-drawer').locator('.job-detail');
await expect(detail.locator('.jd-h .job-state')).toHaveText('Done', { timeout: 240_000 });
await detail.getByTestId('job-log-fold').locator('summary').click();
await expect(detail.locator('.job-log')).toContainText('network PCI');
await closeProcessing(win);
```

Add `closeProcessing` to the import from `./fixtures`. Comments at lines 12 and 219: "run from the Jobs panel" / "from the Jobs panel" become "started from road setup".

- [ ] **Step 6: `volumetric-build.spec.ts`**

- Line 141: `'2 survey dates, built in Jobs'` becomes `'2 survey dates, built after creating'`.
- Replace lines 145 to 147 with:

```ts
// the new project opens with the Processing drawer on its build
const detail = win.getByTestId('processing-drawer').locator('.job-detail');
await expect(detail.locator('.jd-h h2')).toHaveText('Volumetric survey', { timeout: 30_000 });
expect(await detail.getAttribute('data-job')).toContain('volumetric-build');
await expect(detail.locator('.jd-h .job-state')).toHaveText('Done', { timeout: 180_000 });
```

- After the steps loop (line 152) add `await closeProcessing(win);`.
- Test title (line 95) and comments (4, 144): "Jobs panel" becomes "Processing drawer".
- Add `closeProcessing` to the import from `./fixtures`.

- [ ] **Step 7: `photo-process.spec.ts`**

Lines 287 to 291 become:

```ts
// the runs list in the Processing drawer, and from the result straight to the map
await panel.getByRole('button', { name: 'Close' }).click();
const drawer = await openProcessing(win);
const runs = drawer.getByTestId('photo-runs');
await expect(runs.locator(`[data-run="${run}"]`)).toContainText('Done');
await runs.locator(`[data-run="${run}"]`).getByRole('button', { name: 'Open run' }).click();
await expect(drawer).toHaveCount(0);
```

Lines 327 to 333 become:

```ts
// from the project's processing: the photo job reads in plain words and opens its run
await panel.getByRole('button', { name: 'Close' }).click();
const drawer = await openProcessing(win);
await drawer
  .locator('.job-row', { hasText: 'Maps from photos: matching the photos' })
  .first()
  .click();
await drawer.getByTestId('job-open-run').click();
await expect(drawer).toHaveCount(0);
```

Add `openProcessing` to the import from `./fixtures`. If either test already declares a variable named `drawer`, name these `processingDrawer`.

- [ ] **Step 8: `processing-tools.spec.ts`**

Add near the top, after `openTinyProject`:

```ts
/** The version of the processing tools the job runner would use, or null. */
const runtimeVersion = (win: Page) =>
  win.evaluate(async () => {
    const r = await window.aio.invoke('jobs:list', {});
    return r.runtime.found ? r.runtime.version : null;
  });
```

and add `closeProcessing`, `openProcessing` to the import from `./fixtures`.

Test at line 80: rename the end of its title from `and Jobs follows` to `and processing follows`. Replace lines 143 to 146 with:

```ts
// processing follows without a restart: nothing says the tools are missing, the notice is gone
await expect.poll(() => runtimeVersion(win)).toBe('0.5.0');
await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
const drawer = await openProcessing(win);
await expect(drawer.getByTestId('proc-tools')).toHaveCount(0);
await closeProcessing(win);
await expect(win.getByTestId('tools-notice')).toHaveCount(0);
```

Test at line 167: replace lines 188 to 190 with

```ts
// the pack has been read again and the notice still stays away
await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
await expect.poll(() => runtimeVersion(win)).toBe('0.2.0');
```

and lines 209 and 210 with

```ts
await expect.poll(() => runtimeVersion(win)).toBe('99.1.0');
```

Test at line 254: rename `…from Create maps and from Jobs, and leads back` to `…from Create maps and from the Processing drawer, and leads back`. Replace lines 271 to 277 with:

```ts
// the drawer says it itself ("Processing cannot run yet"): the notice does not say it twice
const drawer = await openProcessing(win);
const panel = drawer.getByTestId('proc-tools');
await expect(panel).toContainText('the processing tools are missing or need an update');
await expect(notice).toHaveCount(0);

await drawer.getByTestId('create-maps').click();
```

and lines 299 and 300 with:

```ts
await expect.poll(() => runtimeVersion(win)).toBe('0.5.0');
const after = await openProcessing(win);
await expect(after.getByTestId('proc-tools')).toHaveCount(0);
await closeProcessing(win);
```

Test at line 308: rename it `the Processing drawer opens the same page`. Replace lines 315 to 319 with:

```ts
const drawer = await openProcessing(win);
await drawer
  .getByTestId('proc-tools')
  .getByRole('button', { name: 'Update processing tools' })
  .click();
```

Header comment, line 8: "the Jobs header shows the new version" becomes "processing uses the new version".

- [ ] **Step 9: `a11y.spec.ts`**

Line 433: remove `'Jobs'` from the list, so it reads `['Issues', 'Media', 'Detections', 'Reports']`. Directly after that loop's closing brace add:

```ts
// the open project's processing: the chip and the drawer over the screen
const processingDrawer = await openProcessing(win);
await expect(processingDrawer.getByTestId('create-maps')).toBeVisible();
await expectAccessible(win, 'Processing drawer');
await closeProcessing(win);
```

Replace lines 510 to 516 (the `nav(win, 'Jobs')` block) with:

```ts
// a control that goes away with its panel: the Processing drawer closed from its own button
const processingDrawer = await openProcessing(win);
await processingDrawer.getByTestId('proc-close').focus();
await win.keyboard.press('Enter');
await expect(processingDrawer).toHaveCount(0);
const afterDrawer = await expectFocusMeaningful(win, 'closing the Processing drawer');
expect(afterDrawer.lost).toBe(false);
```

Add `closeProcessing`, `openProcessing` to the import from `./fixtures`.

- [ ] **Step 10: Nothing reaches for the Jobs screen any more**

Run from the worktree root:

```bash
grep -rn "hasText: 'Jobs'\|jobs-rt\|job-chooser\|New job\|built in Jobs\|nav(win, 'Jobs')\|data-task" apps/desktop/e2e
```

Expected: nothing.

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 11: Run each changed spec the way CI does, one at a time**

From `apps/desktop`, after `pnpm exec electron-vite build` and, once, `pnpm demo:build --quick` from the root:

```bash
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/jobs.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/a11y.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/processing-tools.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/photo-process.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/gcp-marking.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/inspection.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/opf.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/road-builder.spec.ts --workers=1
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/volumetric-build.spec.ts --workers=1
```

Run them one after the other, never two at once. Expected: each passes; tests that need what this workstation lacks report as skipped, and the report says which. `samples.spec.ts` and `photo-real.spec.ts` need the sample datasets (`QUADRION_SAMPLES`) and real data: run them if the data is there, otherwise list them as "not run locally" in the hand-off.

A failure is fixed where the fault is: a wrong selector in the spec, or a real bug in Tasks 5 to 11.

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/e2e
git commit -m "test(e2e): specs reach features where they now start" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The guide

Docs only. Can run beside Tasks 12 and 13.

**Files:**

- Modify: `docs/guide/01-install.md`, `02-projects.md`, `08-building-projects.md`, `09-volumes-and-roads.md`, `12-settings.md`, `13-troubleshooting.md`, `15-imagery-and-surface-change.md`, `16-cloud-and-model-change.md`, `28-processing-photos.md`, `31-imagery-and-terrain-packs.md`, `32-3d-tiles.md`, `33-opf.md`, `36-volumes-bases-and-comparisons.md`, `38-designs-alignments-and-compliance.md`
- Modify: `docs/KNOWN-LIMITS.md`

Rules: no em or en dashes; `{product}` stays a placeholder; UI names in bold exactly as the app shows them.

- [ ] **Step 1: Rewrite "Run a job" in `08-building-projects.md`**

Replace the section from `## Run a job` up to (not including) `## Review detections` with:

```markdown
## Processing

Heavy work runs in the background on this computer: making maps from photos, comparing survey dates, converting a point cloud, an AI inspection. It always belongs to the project it was started in.

**Processing**, in the title bar, shows what the open project is doing: "Processing 40%" while one thing runs, "Processing · 3 running" for several, and a warning mark with "1 needs attention" when something failed or was interrupted. With no project open it shows only while another project is still working ("Processing · 1 running elsewhere").

Click it to open the drawer:

- **Create maps from photos** turns drone photos into maps and a 3D model: see [Creating maps from photos](28-processing-photos.md).
- **Running** and **Finished** list this project's work, newest first. Each line has a tag: **Maps and models**, **Survey**, **AI analysis** or **Files**.
- **Maps from photos** lists the project's runs, with **Open run**, **Create maps again**, **Export as OPF** and **Delete work files**.
- **Running in other projects** appears only when another project is still working. Each line names its project.

Click a line to see its steps and progress. **Cancel** stops it. After a failure, a cancel or an interruption (quitting {product} while it ran), **Resume** carries on from the next step. **Open output** and **Log file** show what it wrote. **Settings used** and **Log** are folded away until you open them. **Back** returns to the list.

Everything else starts where the work is: compare dates and survey tools on the **Scene**, imports from **Import files**, the AI inspection from **Detections**, a road survey from its setup panel.

Processing writes into the open project, always with a backup, and never drops your own issues.

The list is kept on this computer for the project's folder. A project that was moved, or opened on another computer, starts with an empty list; its maps, runs and reports are all still there.

The processing tools themselves are installed and updated in **Settings**, **Processing tools**: see [Processing tools](12-settings.md#processing-tools).
```

In the following `## Review detections` section, add this paragraph at its end:

```markdown
On an inspection project, **Turn detections into issues** on the **Detections** screen places the accepted detections on the model and groups them into issues. It asks only for the inspection's own options, then runs for the open project; the **Processing** drawer opens on it.
```

Line 36 of the same file: `A LAS or LAZ point cloud is converted by a job in **Jobs**; the cloud appears when the job is done.` becomes `A LAS or LAZ point cloud is converted in the background; **Processing** in the title bar shows the progress, and the cloud appears when it is done.`

- [ ] **Step 2: A section for Advanced in `12-settings.md`**

At the end of the `## Processing tools` section add:

```markdown
### Advanced: run a pipeline directly

At the bottom of the page, folded away. It is for support: every pipeline of the processing tools with its own form, for when no screen of {product} fits, and **All jobs on this computer**, whichever project they belong to.

1. Open **Advanced: run a pipeline directly**.
2. Pick the **Pipeline** and the **Project folder** (the open project by default), fill in the pipeline's fields, and click **Start job**.

The pipelines are grouped by area: **Photos to maps**, **Inspection**, **Stockpiles and volumes**, **Change between dates**, **Survey tools**, **Water and haul roads**, **Import and convert**, **Map packs**, **Road survey** and **System** (**Check the pipeline pack**). A job started here for the open project also shows in its **Processing** drawer.
```

In the same file, line 34: `**Jobs** shows the new version at once; there is no restart.` becomes `Processing uses the new version at once; there is no restart.` Read line 47 and reword any "Jobs" in it the same way (the **Processing** drawer says "Processing cannot run yet" where the Jobs screen said "Jobs cannot run yet").

- [ ] **Step 3: The other chapters**

| File and line                                | Old                                                                                                       | New                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-install.md:26`                           | `**Jobs** shows "Processing tools" and the version.`                                                      | `the page shows the version, and processing uses it from then on.`                                                                                                                                 |
| `02-projects.md:58`                          | `…**Detections**, **Reports** and **Jobs**.`                                                              | `…**Detections** and **Reports**.` Then add a list item below it: `- **Processing**, in the title bar: what the open project is processing. See [Processing](08-building-projects.md#processing).` |
| `09-volumes-and-roads.md:12`                 | `{product} starts the **Volumetric survey** job and shows **Jobs**. When it is **Done**, open **Scene**.` | `{product} opens the new project and starts the **Volumetric survey**; the **Processing** drawer opens on it. When it says **Done**, close the drawer.`                                            |
| `09-volumes-and-roads.md:54`                 | `**Jobs**, **New job**, **Advanced: run a pipeline directly**, **Road survey**: pick the…`                | `In the road setup panel, click **Run the road builder**: pick the…` (the rest of the sentence stays, minus any mention of a project folder)                                                       |
| `13-troubleshooting.md:31`                   | `## Jobs do not start`                                                                                    | `## Processing does not start`                                                                                                                                                                     |
| `13-troubleshooting.md:33`                   | `"Jobs cannot run yet: the processing tools are missing or need an update"`                               | `"Processing cannot run yet: the processing tools are missing or need an update"` (in the **Processing** drawer)                                                                                   |
| `15-imagery-and-surface-change.md:15`        | `The job shows in **Jobs** while it runs.`                                                                | `**Processing** in the title bar shows it while it runs.`                                                                                                                                          |
| `16-cloud-and-model-change.md:10`            | `The job shows in **Jobs** while it runs.`                                                                | `**Processing** in the title bar shows it while it runs.`                                                                                                                                          |
| `31-imagery-and-terrain-packs.md:11`         | `**Jobs** shows its progress.`                                                                            | `The page shows its progress.`                                                                                                                                                                     |
| `32-3d-tiles.md:8`                           | `open **Jobs**, choose **Mesh to 3D Tiles** or **Point cloud to 3D Tiles**`                               | `open **Settings**, **Processing tools**, **Advanced: run a pipeline directly**, choose **Mesh to 3D Tiles** or **Point cloud to 3D Tiles**`                                                       |
| `33-opf.md:7`                                | `then **Jobs**, **New job**, **Advanced: run a pipeline directly**, **OPF import**`                       | `then **Settings**, **Processing tools**, **Advanced: run a pipeline directly**, **OPF import**`                                                                                                   |
| `33-opf.md:20`                               | `Open **Jobs**, **New job**, **Advanced: run a pipeline directly**, **OPF export**.`                      | `Open **Processing**, and on the run under **Maps from photos** click **Export as OPF**. (Or **Settings**, **Processing tools**, **Advanced: run a pipeline directly**, **OPF export**.)`          |
| `36-volumes-bases-and-comparisons.md:9`      | `wait for the job in **Jobs**`                                                                            | `wait for it under **Processing**`                                                                                                                                                                 |
| `38-designs-alignments-and-compliance.md:16` | `**Jobs**, **New job**, **Advanced: run a pipeline directly**, **Import design**`                         | `**Settings**, **Processing tools**, **Advanced: run a pipeline directly**, **Import design**`                                                                                                     |

In `28-processing-photos.md`, find every place that tells the reader to open **Jobs** to reach **Create maps from photos** or the runs list (`grep -n "Jobs" docs/guide/28-processing-photos.md`) and replace it with **Processing** in the title bar; the runs list is "**Maps from photos** in the **Processing** drawer".

Links: `grep -rn "#run-a-job\|#jobs-do-not-start" docs apps/desktop/src packages` and point each at `#processing` or `#processing-does-not-start`.

- [ ] **Step 4: The known limit**

In `docs/KNOWN-LIMITS.md` add, in the list where the other project limits are:

```markdown
- **Processing history stays on the computer.** The **Processing** drawer lists what this computer ran for a project's folder. A project that is moved or opened on another computer starts with an empty list. Its maps, runs and reports are unaffected.
```

- [ ] **Step 5: Check**

```bash
grep -rn "\*\*Jobs\*\*\|New job" docs/guide
node tools/agent/check-public-text.mjs docs/guide/*.md docs/KNOWN-LIMITS.md
pnpm format:check
pnpm test
```

Expected: the grep prints nothing; no client or site names; formatting clean (run `pnpm exec prettier --write` on the files you changed if not); the unit tests pass, among them the ones that read the guide for the in-app help.

- [ ] **Step 6: Commit**

```bash
git add docs/guide docs/KNOWN-LIMITS.md
git commit -m "docs(guide): processing belongs to the project" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Whole-branch check and hand-off

**Files:** none new. Fixes go in the file at fault, each as its own commit.

- [ ] **Step 1: Everything**

Run from the worktree root: `pnpm check`
Expected: lint, format, types and every unit test pass.

- [ ] **Step 2: The words**

```bash
grep -rn "Jobs\b" apps/desktop/src/renderer packages/ui/src/i18n/en.ts docs/guide | grep -v "\.test\.\|JobsState\|JobsActions\|useJobs\|createJobsStore\|type Jobs\|: Jobs\b\|<Jobs>"
grep -rn "—\|–" apps/desktop/src/renderer/processing packages/ui/src/i18n/en.ts | grep "processing\."
```

Expected: the first prints only code comments about the jobs store; the second prints nothing.

- [ ] **Step 3: End to end, the CI way, once more on the final code**

From `apps/desktop`: `pnpm exec electron-vite build`, then run `e2e/processing-drawer.spec.ts` and every spec of Task 13 Step 11 again, one at a time with `--workers=1`. Add `e2e/shell.spec.ts` (the palette and the sidebar) and `e2e/package.spec.ts` (a read-only package, where the chip must not show). Record for the hand-off: passed, skipped (and why), not run locally (and why).

- [ ] **Step 4: Look at it**

With `QUADRION_E2E_SHOTS` set to a folder in the session scratchpad, run `e2e/processing-drawer.spec.ts` once more and open `processing-drawer.png` and `processing-advanced.png`. Check by eye, at 1100 x 700: the chip sits in the title bar without pushing the other chips out; the drawer does not cover the title bar; text is not clipped; the kind tags read clearly in the dark theme. Fix what is off in `processing.css`.

- [ ] **Step 5: Hand off**

```bash
node tools/agent/finish-task.mjs
```

It rebases onto the latest `origin/main`, runs the checks and prints the hand-off message. If the rebase brings in changes to a file this branch touches (`shell/Sidebar.tsx`, `App.tsx`, `en.ts`, an e2e spec), rerun Step 1 and the affected specs. Send the message to the Orchestrator session with: branch `feat/project-processing`, head SHA, the one-line summary "processing belongs to the project: a title bar chip and drawer replace the Jobs screen", the check and e2e status from Step 3, "no contract change", and "touches many files: merge last in the round".

- [ ] **Step 6: How to test, for the founder**

Close the session with this walkthrough (and put it in the session note):

1. Open a project. In the title bar, next to the sync and connection chips, there is a new **Processing** chip. The sidebar no longer has **Jobs**.
2. Click **Processing**. A drawer opens on the right with the project's name, **Create maps from photos**, and **Maps from photos**. With nothing run yet it says "Nothing is processing in _name_ and nothing has finished yet."
3. Click **Create maps from photos**. The wizard opens and the drawer closes. Start a run. The chip changes to "Processing 12%" and counts up.
4. Click the chip again. The run is under **Running** with the tag **Maps and models**. Click it: steps, **Cancel**, **Open run**. **Back** returns to the list.
5. Open another project while it runs. The chip reads "Processing · 1 running elsewhere"; the drawer shows it under **Running in other projects** with the first project's name.
6. On an inspection project, open **Detections**. There is a new button, **Turn detections into issues**. It asks for the inspection's options only and says "Runs in _name_."
7. On a road survey in setup, **Run the road builder** opens the same kind of dialog with the drawn centreline filled in.
8. **Settings**, **Processing tools**, scroll down: **Advanced: run a pipeline directly** holds the raw forms and **All jobs on this computer**.
