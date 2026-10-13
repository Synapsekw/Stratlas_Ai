# Delete datasets and runs, and start a failed run over: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one remove operation for any mix of dataset layers, photogrammetry runs and survey dates
that finds and takes along everything computed from them, moves their files to the project's
`.trash/` in one step with a full rollback, and is offered from the Datasets tree (rows, group
headers, date folders, multi-select), the Processing drawer (**Delete run**, **Start over...**) and
the library (**Empty project trash**).

**Architecture:** `@aio/schema` gains `RemoveTarget`, `RemovalPlan`, `TrashRecord` (`aio.trash/1`)
and four IPC channels. `@aio/project` gets three pure-Node modules: `builder/trash.ts` (the trash
folder: stamps, sweep, size, empty), `builder/removePlan.ts` (`planRemoval`: reads the project's own
files and grows the set of things to remove to a fixed point) and `builder/remove.ts`
(`removeItems`: replan, move, rewrite side files, one manifest save, rollback); `removeWalk` becomes
a case of it. Main (`main/removal.ts`) wires the channels, hands the job index in for the live-job
refusal, deletes job records after the save, and the journal reconciles the files the removal
touched. The renderer gets one confirm dialog in `@aio/ui` (`RemoveDialog`, text from a pure
`removeText.ts`), one removal store that every entry point calls (`shell/removal.ts`), row marks in
the tree, and a **Start over...** that seeds the process wizard from `run.json`.

**Tech stack:** TypeScript strict, zod 4, Vitest (node and jsdom), React 19 + zustand, Electron
main, Playwright with Electron.

**Spec:** `docs/plans/2026-10-13-delete-and-start-over-design.md` (founder-approved 13 Oct 2026; read
it first, this plan argues from it). Parent: `docs/plans/2026-10-12-walk-layer-and-placing-design.md`
("Remove walk", `.trash/`, the seven-day sweep).

## Global constraints

- Work only in `E:\Dev\AIO Software\.claude\worktrees\delete-and-start-over` (branch
  `feat/delete-and-start-over`). Never edit the main checkout or another worktree. Stage by path,
  never `git add -A`, never a bare `git stash`, never `--no-verify`.
- TypeScript strict, no `any`, no non-null assertions. Public API from each package's
  `src/index.ts`; package dependencies as in `docs/architecture/SPEC.md` section 2: `@aio/project`
  depends on `schema` and `geo` only (so it cannot import `layerFiles` from `@aio/sync`, see
  Task 3), `@aio/ui` on `schema` only.
- Renderer code never imports `electron` or `node:*`.
- User-facing text: no em or en dashes, sentence case, no emoji. The photogrammetry renderer keeps
  its English inline (no `useT`); tree, dialog, library and issue card strings go to
  `packages/ui/src/i18n/en.ts` (Task 7 adds every key).
- Public text rule: no client, site, tester or person names in code, fixtures, docs or commit
  messages; run `node tools/agent/check-public-text.mjs <files>` on every doc you add or change.
- e2e windows stay off-screen (the fixtures do it), `--workers=1`, one Playwright run at a time;
  stop local tests when the founder asks.
- Commits: conventional, each ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Values fixed by the spec (founder, 13 Oct 2026):
  - Removed things go to `<project>/.trash/<stamp>-<slug>/` in their **project layout**, plus
    `removed.json` (`aio.trash/1`); stamp `20261013T081530Z` (UTC, no separators); kept **seven
    days** (`TRASH_KEEP_DAYS = 7`) and swept when the project opens; **Empty project trash** frees
    the space at once. No in-app Restore in this version.
  - Walk removals keep their entry name `<stamp>-<walk id>/` holding the walk folder's files, plus
    `removed.json`; `walkRemove.test.ts` passes unchanged.
  - **Never move or delete anything outside the project root.** A run whose `photos.source` is
    `{ folders }` and a DXF read from its own path are never moved; every path that resolves
    outside the root (a `..`, a link, a junction) refuses the whole removal. Hash assets
    (`assets/sha256/<hash>`) are never moved; a path another remaining layer names is never
    moved.
  - Refused (the plan carries `refused`, nothing moves): a package (`packageRefusal`, main), a
    view-only reviewer (renderer `canEdit`; main has no reviewer check for manifest writes, see
    "Spec gaps"), a **live job** (`starting|running|cancelling`) of this project whose
    `params.run` is a removed run or whose `params` name a removed layer anywhere (deep scan),
    and an unknown target. The refusal names the job: "Creating maps for run 3 is still running.
    Cancel it first."
  - Dependents are shown and **taken along in one step**; nothing is left half-broken.
  - **Issues are kept** ("Dataset removed" on the card); walk pins and survey measurements keep
    their missing-target behaviour.
  - Deleting a survey date removes the date too, unless `volumes.json`,
    `survey/qa/<capture>.json` or a survey measurement still names it; then the empty date stays
    and the dialog says why.
  - **Empty project trash** lives in a Datasets footer line ("Trash 2.3 GB · Empty", shown only
    when the trash is not empty) and in the library's project menu.
  - Hub peers: a removal syncs as a manifest change only (peer file clean-up is a follow-up).
  - **Start over...** on `failed` and `cancelled` runs opens the wizard filled from `run.json`;
    the old run goes to the trash only after the new run's `startAlign` answered ok; a failed
    removal there does not stop the new run. **Resume** stays as it is.
  - Job records leave `userData/jobs.json` only after the manifest save.
  - **Delete work files** (`photo:cleanWork`, recycle bin) is unchanged.

## Spec gaps found while planning (decided here, flag to the founder in the hand-off)

1. **Schema file.** `builder.ts` cannot import `PhotoRun` (cycle: `builder` to `photogrammetry` to
   `manifest` to `builder`). The new types live in a new `packages/schema/src/removal.ts`.
2. **`layerFiles` is in `@aio/sync`**, which `@aio/project` may not depend on. `removePlan.ts` has
   its own `layerRefs` over the same kinds; Task 6 adds a desktop test that the two agree for
   every layer kind.
3. **Walk layer ids are `walk-<id>`**, so the "parent folder named after the layer id" rule misses
   walk folders; `ownedPaths` takes a walk's folder from `walkFolder(record.path)`.
4. **`procmodel.json` and the package plan are not files.** Procedural models are
   `models/<id>.procmodel.json` and do not name their built layer (the layer names the model
   through `derived.source`), and `excludedLayers` is only computed at package export. Neither
   needs a rewrite; `tilesets.json` is the only side file rewritten.
5. **`manifest.json.bak` is overwritten by the next save.** `removed.json`'s `manifestBefore`
   names a copy written into the trash entry, `manifest.before.json`.
6. **Plan fields added** for the dialog: `keptCaptures` is `{ id, by: 'volume' | 'qa' |
'measurement' }[]` (the spec's `string[]` cannot say why), `keptOutside: string[]` (the folders a
   removed run reads in place: "Your original photos are not touched"), a run's `status` is
   nullable (a run folder without a readable `run.json`). `builder:emptyTrash` answers
   `{ ok: true, freed, held }` (the failure table needs the held count).
7. **Folder existence for Start over.** The renderer cannot stat a folder; `photo:readRun` gains
   an optional `missingFolders` (additive).
8. **Journal lists.** `builder:emptyTrash` touches no journaled file, so only `builder:remove` joins
   the journal's post-write reconcile (with the files the plan names, not only `manifest.json`).
9. **A removal that moves nothing** (layer files already gone) writes no trash entry, as
   `removeWalk` did; the `.bak` is then the only record.
10. **Main has no view-only-reviewer refusal** for any manifest write today; this plan keeps the
    renderer gate (`canEdit`) and the package refusal in main, as for other manifest writes.
11. `since: '0.12'` in the schema registry (the app is 0.12.0; no version bump in this plan).

## Review focus

1. **A path inside the project that is a junction or symlink pointing outside.** The plan must
   refuse and nothing may move. Test in Task 3 (`refuses a path that leads outside the project
through a junction`) and Task 5 (`moves nothing when a raster folder is a junction`).
2. **A file locked by Windows or open in another process mid-move** (a viewer, antivirus, the
   Globe streaming tiles). Moves retry through `renameWhenFree`; when one is still refused, the
   ones already moved come back. Tests in Task 5 (`waits for a file held open for a moment`,
   `rolls back when the third move fails`, `leaves the files in the trash with removed.json when
the way back is refused too`); the renderer releases viewers first, Task 10 (`hides,
deselects and releases the layers before it asks main`).
3. **The manifest save failing mid-way.** Side files and moved files come back, the trash entry is
   deleted, the error is shown. Test in Task 5 (`rolls back files and tilesets.json when the save
fails`) and Task 6 (`deletes no job record when the save fails`).
4. **A date folder holding a dataset that a comparison in another date also uses.** The comparison
   and its derived layers go; the other date and its own layers stay. Test in Task 3 (`a date
takes its layers and the comparison into another date, and that date's layers stay`).
5. **Start over when the wizard is cancelled, or the new start is refused.** The failed run must
   not be trashed. Test in Task 9 (`removes nothing when the start was refused or there is nothing
to replace`) and the e2e step 4 (Escape leaves the run listed and no `.trash/`).

Also pinned: removing a layer while its tiles are open in the Globe (Task 10 release-first test and
Task 5 lock-retry test); a run that failed before commit (Task 3, layers found by the `<run>-*`
convention); a run read from outside folders (Task 3, never in `files`).

---

## Execution DAG

```
                         T1 schema + IPC + preload + docs (G0)
     ┌────────┬────────┬────────┼─────────┬──────────┐
     T2       T3       T4       T7        T8         T9
    trash    plan    JobStore  dialog    marks     start-over
     │        │      .delete   + i18n    (ui)      model
     └───┬────┘        │        │         │          │
         T5 removeItems │        T10 removal store + host
         │              │        │         │          │
         └──────┬───────┘        ├─────────┤          │
                T6 main IPC      T11 Datasets tree    T12 Processing drawer + wizard
                │                T13 library + issue card   (T12 needs T9, T10)
                └────────────────┴───────┬────────────┘
                                 T14 e2e + docs (needs all)
                                         │
                                 T15 verification and hand-off
```

| Batch | Tasks (run at once, no shared files) | Waits for                                        |
| ----- | ------------------------------------ | ------------------------------------------------ |
| 0     | T1                                   | nothing                                          |
| 1     | T2, T3, T4, T7, T8, T9               | T1                                               |
| 2     | T5, T10                              | T5: T2, T3; T10: T7                              |
| 3     | T6, T11, T12, T13                    | T6: T4, T5; T11: T8, T10; T12: T9, T10; T13: T10 |
| 4     | T14                                  | all of batch 3                                   |
| 5     | T15                                  | T14                                              |

**Critical path:** T1, T3, T5, T6, T14, T15 (the plan and the removal carry the feature; the UI
path T1, T7, T10, T11 is one task shorter).

Shared-file check per batch:

- Batch 1: T2 `packages/project/src/builder/trash.ts`, `trash.test.ts`, `walkRemove.ts`,
  `builder/index.ts`; T3 `builder/removePlan.ts`, `removePlan.test.ts`, `removeFixture.ts` (does
  not touch `index.ts`); T4 `apps/desktop/src/main/jobs/store.ts`, `store.test.ts`; T7
  `packages/ui/src/tree/RemoveDialog.tsx`, `removeText.ts`, tests, `packages/ui/src/index.ts`,
  `packages/ui/src/i18n/en.ts`; T8
  `packages/ui/src/tree/marks.ts`, `marks.test.ts`, `model.ts`, `DatasetTree.tsx`, `DateTree.tsx`,
  `walkRows.test.tsx`, `DateTree.test.tsx`, `packages/ui/src/mission.css`; T9
  `apps/desktop/src/renderer/photogrammetry/startOver.ts`, `startOver.test.ts`, `store.ts`,
  `store.test.ts`. No file is in two tasks.
- Batch 2: T5 `builder/remove.ts`, `remove.test.ts`, `walkRemove.ts`, `builder/index.ts`; T10
  `apps/desktop/src/renderer/shell/removal.ts`, `removal.test.ts`, `RemoveHost.tsx`, `App.tsx`.
- Batch 3: T6 `apps/desktop/src/main/removal.ts`, `removal.test.ts`, `main/index.ts`,
  `main/journal.ts`, `journal.test.ts`, `main/photogrammetry.ts`, `main/layerRefs.test.ts`; T11
  `shell/Sidebar.tsx`, `shell/DateMenus.tsx`, `walks/walks.ts`, `walks/walks.test.ts`,
  `i18n/en.ts` (drops the three old walk confirm keys only); T12 `photogrammetry/PhotoRuns.tsx`,
  `RunPanel.tsx`, `ProcessWizard.tsx`, `PhotoProcessLayer.tsx`; T13 `screens/ProjectMenu.tsx`,
  `screens/projectMenuModel.ts`, `projectMenuModel.test.ts`, `issueCard/IssueCard.tsx`,
  `issueCard/model.ts`, `issueCard/model.test.ts`. No file is in two tasks.

## Package ownership

| Task | Packages                                                                |
| ---- | ----------------------------------------------------------------------- |
| T1   | `@aio/schema`, desktop preload, docs                                    |
| T2   | `@aio/project`                                                          |
| T3   | `@aio/project`                                                          |
| T4   | desktop main                                                            |
| T5   | `@aio/project`                                                          |
| T6   | desktop main                                                            |
| T7   | `@aio/ui`                                                               |
| T8   | `@aio/ui`                                                               |
| T9   | desktop renderer (`photogrammetry/`)                                    |
| T10  | desktop renderer (`shell/`, `App.tsx`)                                  |
| T11  | desktop renderer (`shell/`, `walks/`), `@aio/ui` (`en.ts`, key removal) |
| T12  | desktop renderer (`photogrammetry/`)                                    |
| T13  | desktop renderer (`screens/`, `issueCard/`)                             |
| T14  | desktop e2e, docs                                                       |
| T15  | none (verification)                                                     |

## Sizes

S: under half a day of agent work; M: about one; L: more. T1 M, T2 S, T3 L, T4 S, T5 L, T6 M,
T7 M, T8 M, T9 S, T10 M, T11 L, T12 M, T13 S, T14 L, T15 M. Fifteen tasks, about 14 agent-days in
all; with the batches above about 5 working days end to end.

## e2e specs

- **New** `apps/desktop/e2e/delete-and-start-over.spec.ts` (Task 14): delete the Video group,
  delete the photos layer with its run, the trash footer and Empty, Start over cancelled, Start over
  started (pipeline Python only).
- **Changed** `apps/desktop/e2e/walk-place.spec.ts`: the remove test uses the dialog's test ids
  (`remove-dialog`, `remove-dialog-confirm`) instead of `walk-remove-confirm` / `walk-remove-yes`.
- **Run, unchanged but at risk:** `processing-drawer.spec.ts`, `photo-process.spec.ts` (new
  buttons in the run row), `timeline.spec.ts` and `survey-dates-add.spec.ts` (date menus),
  `library.spec.ts` and `project-menu.spec.ts` (a new menu item), `small-window.spec.ts`.

All of them run the CI way (CONTRIBUTING.md, "End to end the way CI runs it"): from
`apps/desktop`, `pnpm demo:change --quick` built first (and `pnpm demo:build --quick` for the full
set), then `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx
playwright test e2e/<spec>.spec.ts --workers=1`; the log must print `[e2e] window 1100 x 720 px at
display scale 1`. In a worktree point `QUADRION_E2E_PYTHON` at the main checkout's
`python\.venv\Scripts\python.exe` (worktrees have no venv).

## Contract change row (for `docs/architecture/contract-changes.md`, added in Task 1)

```
| 2026-10-13 | **Minor:** new IPC `builder:removePlan` (`{ projectId, targets: RemoveTarget[] }` to `{ ok: true, plan: RemovalPlan }` or `{ ok: false, error }`), `builder:remove` (same request, `{ ok: true, manifest, plan }`), `builder:trash` (`{ projectId }` to `{ bytes, entries }`), `builder:emptyTrash` (`{ projectId }` to `{ ok: true, freed, held }` or `{ ok: false, error }`). New schema types `RemoveTarget` (`{ layer }`, `{ run }` or `{ capture }`), `RemoveWhy`, `RemovalPlan` and the file schema `aio.trash/1` (`TrashRecord`, `.trash/<entry>/removed.json`: `at`, `targets`, `plan`, `manifestBefore`), in `removal.ts`, registered in `versions.ts` (since 0.12). `photo:readRun` success gains the optional `missingFolders`. `walks:remove` keeps its shape; its trash entry gains `removed.json`. The manifest schema does not change (entries only leave it); older builds open a project after a removal unchanged. Approval: founder, 13 Oct 2026. |
```

---

### Task 1: Schema contract, IPC, preload and docs (G0)

**Files:**

- Create: `packages/schema/src/removal.ts`, `packages/schema/src/removal.test.ts`
- Modify: `packages/schema/src/index.ts` (export `./removal`)
- Modify: `packages/schema/src/ipc.ts` (four channels after `'builder:removeCapture'`, about line
  1525; `photo:readRun` response, about line 2304)
- Modify: `packages/schema/src/versions.ts` (one row after the `aio.walkorient` row, about line 510)
- Modify: `packages/schema/src/versions.test.ts` (one test)
- Modify: `apps/desktop/src/preload/index.ts` (four allow-list entries after `'walks:remove': true`,
  line 101)
- Modify: `docs/architecture/contract-changes.md` (the row above, at the end of the table)
- Modify: `docs/architecture/data-conventions.md` (new section 33, `.trash/`; section 32's
  "Removing" bullet points to it)

**Packages:** `@aio/schema`, desktop preload, docs.

**Interfaces (produces, used by every later task):**

```ts
// packages/schema/src/removal.ts
import { z } from 'zod';
import { Id, IsoTime, ProjectPath } from './common';
import { PhotoRun } from './photogrammetry';

export const TRASH_SCHEMA = 'aio.trash/1';

/** What a removal names: a manifest layer, a photogrammetry run, or a survey date. */
export const RemoveTarget = z.union([
  z.object({ layer: Id }).strict(),
  z.object({ run: z.string().min(1).max(128) }).strict(),
  z.object({ capture: Id }).strict(),
]);

/** Why a thing is in a plan: asked for, used by, made by, or filed under another removed thing. */
export const RemoveWhy = z.union([
  z.literal('asked'),
  z.object({ usedBy: z.string().min(1) }).strict(),
  z.object({ madeBy: z.string().min(1) }).strict(),
  z.object({ filedUnder: z.string().min(1) }).strict(),
]);

export const KeptCapture = z
  .object({ id: Id, by: z.enum(['volume', 'qa', 'measurement']) })
  .strict();

export const RemovalPlan = z
  .object({
    layers: z.array(
      z.object({ id: Id, name: z.string(), kind: z.string(), why: RemoveWhy }).strict(),
    ),
    runs: z.array(
      z
        .object({
          id: z.string().min(1).max(128),
          /** null: the run folder has no readable `run.json`. */
          status: PhotoRun.shape.status.nullable(),
          why: RemoveWhy,
        })
        .strict(),
    ),
    changes: z.array(
      z.object({ id: z.string().min(1), name: z.string(), why: RemoveWhy }).strict(),
    ),
    tilesets: z.array(z.string()),
    surfaces: z.array(z.string()),
    /** `detections/<file>.json` paths naming a removed layer. */
    detections: z.array(ProjectPath),
    jobs: z.array(z.string()),
    captures: z.array(Id),
    keptCaptures: z.array(KeptCapture),
    /** Folders a removed run reads in place: never moved. */
    keptOutside: z.array(z.string()),
    /** Project-relative paths that move to `.trash/`. */
    files: z.array(ProjectPath),
    bytes: z.number().int().nonnegative(),
    refused: z.string().optional(),
    touches: z
      .object({ issues: z.number().int().nonnegative(), walkPins: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();

/** `.trash/<entry>/removed.json` (`aio.trash/1`): what one removal moved, for a restore by hand. */
export const TrashRecord = z
  .object({
    schema: z.literal(TRASH_SCHEMA),
    at: IsoTime,
    targets: z.array(RemoveTarget).min(1),
    plan: RemovalPlan,
    /** The manifest as it was, a file in the same entry (`manifest.before.json`). */
    manifestBefore: z.string().min(1).max(260),
  })
  .strict();

export type RemoveTarget = z.infer<typeof RemoveTarget>;
export type RemoveWhy = z.infer<typeof RemoveWhy>;
export type KeptCapture = z.infer<typeof KeptCapture>;
export type RemovalPlan = z.infer<typeof RemovalPlan>;
export type TrashRecord = z.infer<typeof TrashRecord>;

/** A plan with nothing in it (the start of `planRemoval`, and a refusal's body). */
export function emptyRemovalPlan(): RemovalPlan {
  return {
    layers: [],
    runs: [],
    changes: [],
    tilesets: [],
    surfaces: [],
    detections: [],
    jobs: [],
    captures: [],
    keptCaptures: [],
    keptOutside: [],
    files: [],
    bytes: 0,
    touches: { issues: 0, walkPins: 0 },
  };
}
```

```ts
// packages/schema/src/ipc.ts, after 'builder:removeCapture'
  /**
   * What removing `targets` takes along (delete and start over, 13 Oct 2026): read from disk, no
   * change. `plan.refused` says why the removal cannot happen (a package, a live job, an unknown
   * target).
   */
  'builder:removePlan': {
    request: z
      .object({ projectId: z.string().min(1), targets: z.array(RemoveTarget).min(1).max(5000) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), plan: RemovalPlan }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Remove `targets` and what they take along: files to `.trash/`, one manifest save. */
  'builder:remove': {
    request: z
      .object({ projectId: z.string().min(1), targets: z.array(RemoveTarget).min(1).max(5000) })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), manifest: ProjectManifest, plan: RemovalPlan }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** What the project trash holds (0 and 0 for a package or an unknown project). */
  'builder:trash': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({
      bytes: z.number().int().nonnegative(),
      entries: z.number().int().nonnegative(),
    }),
  },
  /** Delete the project trash for good; `held` entries were in use and stay. */
  'builder:emptyTrash': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        freed: z.number().int().nonnegative(),
        held: z.number().int().nonnegative(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
```

```ts
// packages/schema/src/ipc.ts, 'photo:readRun' success member becomes
z.object({
  ok: z.literal(true),
  run: PhotoRun,
  accuracy: AccuracyReport.nullable(),
  /** Folders of a `{ folders }` source that are not there any more (Start over). */
  missingFolders: z.array(z.string()).optional(),
}),
```

- [ ] **Step 1: Write the failing tests** in `packages/schema/src/removal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RemovalPlan, RemoveTarget, TRASH_SCHEMA, TrashRecord, emptyRemovalPlan } from './removal';
import { ipc } from './ipc';

describe('removal contract', () => {
  it('takes a layer, a run and a survey date as targets, and nothing else', () => {
    expect(RemoveTarget.safeParse({ layer: 'photos-a' }).success).toBe(true);
    expect(RemoveTarget.safeParse({ run: '20261012-0930' }).success).toBe(true);
    expect(RemoveTarget.safeParse({ capture: 'c1' }).success).toBe(true);
    expect(RemoveTarget.safeParse({ layer: 'a', run: 'b' }).success).toBe(false);
    expect(RemoveTarget.safeParse({ file: 'x' }).success).toBe(false);
  });

  it('parses an empty plan and one with every kind of reason', () => {
    expect(RemovalPlan.parse(emptyRemovalPlan())).toEqual(emptyRemovalPlan());
    const plan = {
      ...emptyRemovalPlan(),
      layers: [
        { id: 'photos-a', name: 'Flight A', kind: 'photos', why: 'asked' },
        { id: 'r-ortho', name: 'Ortho', kind: 'raster', why: { madeBy: 'r' } },
        { id: 'heat', name: 'Heat', kind: 'raster', why: { usedBy: 'r-ortho' } },
        { id: 'dsm', name: 'DSM', kind: 'raster', why: { filedUnder: 'c1' } },
      ],
      runs: [{ id: 'broken', status: null, why: { usedBy: 'photos-a' } }],
      keptCaptures: [{ id: 'c3', by: 'volume' }],
      files: ['photogrammetry/broken', 'rasters/r-ortho'],
      bytes: 2048,
    };
    expect(RemovalPlan.safeParse(plan).success).toBe(true);
  });

  it('refuses a path out of the project in files', () => {
    const plan = { ...emptyRemovalPlan(), files: ['../elsewhere'] };
    expect(RemovalPlan.safeParse(plan).success).toBe(false);
  });

  it('reads a trash record and refuses aio.trash/2', () => {
    const rec = {
      schema: TRASH_SCHEMA,
      at: '2026-10-13T08:15:30.000Z',
      targets: [{ run: '20261012-0930' }],
      plan: emptyRemovalPlan(),
      manifestBefore: 'manifest.before.json',
    };
    expect(TrashRecord.safeParse(rec).success).toBe(true);
    expect(TrashRecord.safeParse({ ...rec, schema: 'aio.trash/2' }).success).toBe(false);
  });

  it('has the four channels', () => {
    for (const c of ['builder:removePlan', 'builder:remove', 'builder:trash', 'builder:emptyTrash'])
      expect(Object.keys(ipc)).toContain(c);
  });
});
```

And in `versions.test.ts`:

```ts
it('registers the trash record of a removal', () => {
  expect(SCHEMA_REGISTRY.find((e) => e.family === 'aio.trash')).toMatchObject({
    version: 1,
    home: 'project',
    where: '.trash/<entry>/removed.json',
    since: '0.12',
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing):
      `pnpm --filter @aio/schema test -- removal versions`
- [ ] **Step 3: Implement** `removal.ts` as above; `export * from './removal';` in `index.ts`; the
      four channels and the `missingFolders` field in `ipc.ts` (import `RemoveTarget`,
      `RemovalPlan` from `./removal`); the registry row

```ts
  // what one removal moved to the project trash (delete and start over; founder, 13 Oct 2026)
  {
    family: 'aio.trash',
    version: 1,
    home: 'project',
    where: '.trash/<entry>/removed.json',
    since: '0.12',
  },
```

and in `apps/desktop/src/preload/index.ts` after `'walks:remove': true,`:

```ts
  'builder:removePlan': true,
  'builder:remove': true,
  'builder:trash': true,
  'builder:emptyTrash': true,
```

- [ ] **Step 4: Docs.** Add the contract change row (section above) at the end of the table in
      `docs/architecture/contract-changes.md`. Add to `docs/architecture/data-conventions.md`:

```md
## 33. The project trash (`.trash/`)

Removals (`builder:remove`, `walks:remove`; delete and start over, 13 Oct 2026) move files into
`<project>/.trash/<stamp>-<slug>/`, one entry per removal. `<stamp>` is the UTC time without
separators (`20261013T081530Z`); `<slug>` is the first target: a layer id, `run-<run id>`, or
`date-<capture id>`; a taken name gets `-2`, `-3` and so on. The entry holds:

- the moved files and folders **in their project layout** (`rasters/<id>/...`,
  `photogrammetry/<run>/...`, `jobs/<jobId>/...`, `change/<id>.json`, `tiles/<id>/...`);
- a copy of each side file the removal rewrote, at its project path (`tilesets.json`);
- `manifest.before.json`, the manifest as it was before the removal;
- `removed.json` (`TrashRecord`, `aio.trash/1`): `at` (ISO time), `targets` (`RemoveTarget[]`),
  `plan` (`RemovalPlan`: what went and why) and `manifestBefore` (`manifest.before.json`).

A walk removal keeps its own layout: the entry `<stamp>-<walk id>/` is the walk folder itself, with
`removed.json` added. A removal that moves no file writes no entry.

Restoring by hand within seven days: copy the entry's folders back to the project folder, and
replace `manifest.json` with `manifest.before.json` (or put back only the layers you need). The app
has no Restore yet.

Never moved: anything outside the project folder (photo folders a run reads in place, a DXF read
from its own path), hash assets (`assets/sha256/`), and a file another remaining layer names. A path
that leads outside the project (a link or junction) refuses the whole removal.

Entries older than seven days (`TRASH_KEEP_DAYS`) are deleted when the project opens; **Empty
project trash** deletes them all at once (an entry in use stays and is reported). `.trash/` never
goes into a package, and hub peers receive only the manifest change.
```

and change section 32's "Removing" bullet to end with "(the trash: section 33)".

- [ ] **Step 5: Run** `pnpm --filter @aio/schema test`, `pnpm typecheck`, `pnpm format:check`,
      `node tools/agent/check-public-text.mjs docs/architecture/data-conventions.md docs/architecture/contract-changes.md`.
      Expect PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/removal.ts packages/schema/src/removal.test.ts packages/schema/src/index.ts packages/schema/src/ipc.ts packages/schema/src/versions.ts packages/schema/src/versions.test.ts apps/desktop/src/preload/index.ts docs/architecture/contract-changes.md docs/architecture/data-conventions.md
git commit -m "feat(schema): removal targets, plan, trash record and the four removal channels" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: The trash folder (`builder/trash.ts`)

**Files:**

- Create: `packages/project/src/builder/trash.ts`, `packages/project/src/builder/trash.test.ts`
- Modify: `packages/project/src/builder/walkRemove.ts` (the trash constants, `stampOf`,
  `sweepTrash` move out; it imports them back)
- Modify: `packages/project/src/builder/index.ts` (lines 107 to 113: export the trash names from
  `./trash`, keep `removeWalk` and `RemoveWalkOptions` from `./walkRemove`)

**Packages:** `@aio/project`.

**Interfaces:**

- Consumes: nothing new.
- Produces:

```ts
export const TRASH_DIR = '.trash';
export const TRASH_KEEP_DAYS = 7;
/** `20261013T081530Z`: sorts by time and has no characters Windows refuses. */
export function stampOf(d: Date): string;
/** The time an entry name starts with, or null for a name that is not an entry. */
export function stampTime(name: string): number | null;
export interface TrashOptions {
  /** The delete itself (tests hand in one that fails for a held entry). */
  rm?: (path: string) => Promise<void>;
}
/** Bytes under `abs` (links are counted as links, never followed); 0 when it is gone. */
export function pathBytes(abs: string): Promise<number>;
/** A free `.trash/<stamp>-<slug>[-n]` for a removal at `at`: absolute path, not created. */
export function freeTrashEntry(root: string, at: Date, slug: string): Promise<string>;
export function sweepTrash(
  root: string,
  now?: () => Date,
  keepMs?: number,
  o?: TrashOptions,
): Promise<string[]>;
export function trashSize(root: string): Promise<{ bytes: number; entries: number }>;
export function emptyTrash(
  root: string,
  o?: TrashOptions,
): Promise<{ freed: number; removed: string[]; held: string[] }>;
```

- [ ] **Step 1: Write the failing tests** in `trash.test.ts`:

```ts
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TRASH_DIR,
  emptyTrash,
  freeTrashEntry,
  stampOf,
  stampTime,
  sweepTrash,
  trashSize,
} from './trash';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-trash-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NOW = new Date('2026-10-13T08:15:30.000Z');
const entry = async (name: string, bytes: number) => {
  const dir = join(root, TRASH_DIR, name, 'rasters', 'x');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'tiles.json'), Buffer.alloc(bytes, 1));
};

describe('trash', () => {
  it('stamps in UTC without separators and reads the stamp back', () => {
    expect(stampOf(NOW)).toBe('20261013T081530Z');
    expect(stampTime('20261013T081530Z-run-1')).toBe(NOW.getTime());
    expect(stampTime('notes.txt')).toBeNull();
  });

  it('finds a free entry name', async () => {
    const first = await freeTrashEntry(root, NOW, 'run-20261012-0930');
    expect(first.endsWith(join(TRASH_DIR, '20261013T081530Z-run-20261012-0930'))).toBe(true);
    await mkdir(first, { recursive: true });
    expect(await freeTrashEntry(root, NOW, 'run-20261012-0930')).toBe(`${first}-2`);
  });

  it('sizes what the trash holds', async () => {
    await entry('20261013T081530Z-a', 1000);
    await entry('20261012T081530Z-b', 24);
    expect(await trashSize(root)).toEqual({ bytes: 1024, entries: 2 });
  });

  it('answers 0 and 0 without a trash folder', async () => {
    expect(await trashSize(root)).toEqual({ bytes: 0, entries: 0 });
    expect(await emptyTrash(root)).toEqual({ freed: 0, removed: [], held: [] });
  });

  it('empties every entry and reports what it freed', async () => {
    await entry('20261013T081530Z-a', 1000);
    await entry('20261012T081530Z-b', 24);
    const r = await emptyTrash(root);
    expect(r.freed).toBe(1024);
    expect(r.removed.sort()).toEqual(['20261012T081530Z-b', '20261013T081530Z-a']);
    expect(await readdir(join(root, TRASH_DIR))).toEqual([]);
  });

  it('leaves an entry that is held open and reports it', async () => {
    await entry('20261013T081530Z-a', 1000);
    await entry('20261012T081530Z-held', 24);
    const held = (p: string) =>
      p.endsWith('held')
        ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        : rm(p, { recursive: true, force: true });
    const r = await emptyTrash(root, { rm: held });
    expect(r).toEqual({
      freed: 1000,
      removed: ['20261013T081530Z-a'],
      held: ['20261012T081530Z-held'],
    });
    expect(await readdir(join(root, TRASH_DIR))).toEqual(['20261012T081530Z-held']);
  });

  it('sweeps with a keep time of zero like emptying, stamped entries only', async () => {
    await entry('20261013T081530Z-a', 10);
    expect(await sweepTrash(root, () => NOW, 0)).toEqual([]);
    expect(await sweepTrash(root, () => new Date(NOW.getTime() + 1000), 0)).toEqual([
      '20261013T081530Z-a',
    ]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/project test -- trash`
- [ ] **Step 3: Implement** `trash.ts`:

```ts
import { lstat, mkdir, readdir, rm as fsRm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * The project trash (data-conventions section 33): one entry per removal, `<stamp>-<slug>`,
 * swept seven days later when the project opens, or all at once by Empty project trash.
 */

export const TRASH_DIR = '.trash';
/** How long removed files are kept. */
export const TRASH_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-|$)/;

export function stampOf(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

export function stampTime(name: string): number | null {
  const m = STAMP.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, se ?? 0);
}

export interface TrashOptions {
  rm?: (path: string) => Promise<void>;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const removeTree = (p: string) => fsRm(p, { recursive: true, force: true, maxRetries: 3 });

export async function pathBytes(abs: string): Promise<number> {
  let info;
  try {
    info = await lstat(abs);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(abs)) total += await pathBytes(join(abs, name));
  return total;
}

export async function freeTrashEntry(root: string, at: Date, slug: string): Promise<string> {
  const base = join(root, TRASH_DIR, `${stampOf(at)}-${slug}`);
  await mkdir(join(root, TRASH_DIR), { recursive: true });
  if (!(await exists(base))) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${String(n)}`;
    if (!(await exists(name))) return name;
  }
}

async function entries(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, TRASH_DIR));
  } catch {
    return [];
  }
}

export async function sweepTrash(
  root: string,
  now: () => Date = () => new Date(),
  keepMs: number = TRASH_KEEP_DAYS * DAY_MS,
  o: TrashOptions = {},
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await entries(root)) {
    const at = stampTime(name);
    if (at === null || now().getTime() - at <= keepMs) continue;
    try {
      await (o.rm ?? removeTree)(join(root, TRASH_DIR, name));
      removed.push(name);
    } catch {
      // held open for now: the next open tries again
    }
  }
  return removed;
}

export async function trashSize(root: string): Promise<{ bytes: number; entries: number }> {
  const names = await entries(root);
  let bytes = 0;
  for (const name of names) bytes += await pathBytes(join(root, TRASH_DIR, name));
  return { bytes, entries: names.length };
}

export async function emptyTrash(
  root: string,
  o: TrashOptions = {},
): Promise<{ freed: number; removed: string[]; held: string[] }> {
  const removed: string[] = [];
  const held: string[] = [];
  let freed = 0;
  for (const name of await entries(root)) {
    const abs = join(root, TRASH_DIR, name);
    const bytes = await pathBytes(abs);
    try {
      await (o.rm ?? removeTree)(abs);
      removed.push(name);
      freed += bytes;
    } catch {
      held.push(name);
    }
  }
  return { freed, removed, held };
}
```

In `walkRemove.ts` delete `TRASH_DIR`, `TRASH_KEEP_DAYS`, `DAY_MS`, `stampOf`, `STAMP` and
`sweepTrash`, and import `TRASH_DIR`, `stampOf` from `./trash` (Task 5 rewrites the rest). In
`index.ts` replace the `./walkRemove` export block with:

```ts
export { removeWalk, type RemoveWalkOptions } from './walkRemove';
export {
  TRASH_DIR,
  TRASH_KEEP_DAYS,
  emptyTrash,
  freeTrashEntry,
  pathBytes,
  stampOf,
  stampTime,
  sweepTrash,
  trashSize,
  type TrashOptions,
} from './trash';
```

- [ ] **Step 4: Run** `pnpm --filter @aio/project test -- trash walkRemove` (the walk tests still
      pass unchanged) and `pnpm typecheck`. Expect PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/project/src/builder/trash.ts packages/project/src/builder/trash.test.ts packages/project/src/builder/walkRemove.ts packages/project/src/builder/index.ts
git commit -m "feat(project): the project trash, its size and Empty" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Resolving dependents (`builder/removePlan.ts`)

**Files:**

- Create: `packages/project/src/builder/removePlan.ts`
- Create: `packages/project/src/builder/removeFixture.ts` (test-only helper, not exported from
  `index.ts`; Task 5 uses it too)
- Test: `packages/project/src/builder/removePlan.test.ts`

**Packages:** `@aio/project`. Does not touch `builder/index.ts` (Task 5 exports).

**Interfaces:**

- Consumes: `RemoveTarget`, `RemovalPlan`, `RemoveWhy`, `KeptCapture`, `emptyRemovalPlan` (T1);
  `pathBytes`, `TRASH_DIR` (T2); `readManifestFile` (`manifestFile.ts`), `walkFolder`
  (`walkPaths.ts`); schema constants `PHOTO_DIR`, `CHANGE_DIR`, `SURFACES_DIR`, `TILES_DIR`,
  `TILESETS_FILE`, `MEASUREMENTS_FILE`.
- Produces:

```ts
/** A job of this project as the plan needs it (main hands in its job index). */
export interface PlanJob {
  id: string;
  pipeline: string;
  status: string;
  params: Record<string, unknown>;
}
export interface PlanOptions {
  /** This project's jobs from `userData/jobs.json`; none: no job is known. */
  jobs?: readonly PlanJob[];
  /** Set for a package: the plan is refused with this sentence. */
  readOnly?: string;
}
export const RUN_PRODUCTS: readonly ['ortho', 'dsm', 'dtm', 'cloud', 'mesh'];
/** Project-relative paths of a layer's `{ path }` refs; mirrors `layerFiles` in `@aio/sync`. */
export function layerRefs(layer: Layer): string[];
/** What a layer owns on disk: its folder when a ref's parent folder is named after it, else files. */
export function ownedPaths(layer: Layer): string[];
/** Every string found under one of `keys`, anywhere in `v`. */
export function valuesUnder(v: unknown, keys: ReadonlySet<string>): Set<string>;
/** The first string anywhere in `v` that is in `ids`, or null. */
export function namesAny(v: unknown, ids: ReadonlySet<string>): string | null;
export function planRemoval(
  root: string,
  targets: readonly RemoveTarget[],
  o?: PlanOptions,
): Promise<RemovalPlan>;
```

- [ ] **Step 1: The fixture** `removeFixture.ts` (deterministic; no `aio.*` schema literal that the
      registry does not know):

```ts
import type { Layer } from '@aio/schema';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createProject, readManifestFile, writeManifestFile } from './create';
import type { PlanJob } from './removePlan';

/*
 * One project with every kind of dependent a removal must find (delete and start over, 13 Oct
 * 2026): a photos layer under date c1 with a finished run (two map layers by `outputs`, a 3D
 * tileset by `run`, a comparison into date c2 with its heat layer, a tileset `from` its DSM, a
 * prepared surface and a cleaned copy), a run that failed mid-commit (a `<run>-ortho` layer the run
 * does not list, a job folder), a run read from folders outside the project, two clips sharing a
 * flight file, two meshes sharing a model file, a detection pass, two issues, and date c3 that a
 * volume names. Survey dates: c1 12 Oct, c2 26 Oct, c3 2 Nov 2026.
 */

export const RUN_DONE = '20261012-0815';
export const RUN_FAILED = '20261012-0930';
export const RUN_FOLDERS = '20261013-0700';
export const OUTSIDE = 'C:/Survey photos/12 Oct';
export const FIXTURE_JOBS: PlanJob[] = [
  { id: 'job-done', pipeline: 'photo.products', status: 'done', params: { run: RUN_DONE } },
  { id: 'job-failed', pipeline: 'photo.align', status: 'failed', params: { run: RUN_FAILED } },
];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

type Raster = Extract<Layer, { kind: 'raster' }>;
const raster = (id: string, capture?: string, derived?: Raster['derived']): Raster => ({
  kind: 'raster',
  id,
  name: id,
  visible: true,
  src: { path: `rasters/${id}/tiles.json` },
  role: 'dsm',
  format: 'kit-pyramid',
  ...(capture ? { capture } : {}),
  ...(derived ? { derived } : {}),
});

export async function makeRemoveProject(): Promise<{ dir: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'aio-remove-'));
  const { root } = await createProject(dir, {
    name: 'Remove',
    type: 'inspection',
    epsg: 32639,
    origin: [500000, 3200000, 0],
    severityTemplate: null,
  });
  const put = async (rel: string, text = 'x') => {
    const f = join(root, ...rel.split('/'));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, text);
  };
  const json = (rel: string, v: unknown) => put(rel, JSON.stringify(v));
  const lens = { model: 'pinhole' as const, hfovDeg: 70, aspect: 1.5 };
  const clip = (id: string): Layer => ({
    kind: 'video',
    id,
    name: id,
    visible: true,
    src: { path: `video/${id}.mp4` },
    flight: { src: { path: 'flights/f1.json' }, startUtcMs: 0 },
    lens,
    offsetMs: 0,
  });
  const mesh = (id: string): Layer => ({
    kind: 'mesh',
    id,
    name: id,
    visible: true,
    src: { path: 'models/shared.glb' },
    transform: IDENTITY,
  });
  const m0 = await readManifestFile(root);
  await writeManifestFile(root, {
    ...m0,
    captures: [
      { id: 'c1', label: 'Survey', date: '2026-10-12' },
      { id: 'c2', label: 'Survey', date: '2026-10-26' },
      { id: 'c3', label: 'Survey', date: '2026-11-02' },
    ],
    layers: [
      ...m0.layers,
      {
        kind: 'photos',
        id: 'photos-a',
        name: 'Flight A',
        visible: true,
        capture: 'c1',
        items: [
          { id: 'p1', src: { path: 'photos/p1.jpg' } },
          { id: 'p2', src: { path: 'photos/p2.jpg' } },
        ],
      },
      raster(`${RUN_DONE}-ortho`, 'c1'),
      raster(`${RUN_DONE}-dsm`, 'c1'),
      raster(`${RUN_FAILED}-ortho`),
      raster('dsm-b', 'c2'),
      raster('chg-1-heat', 'c2', {
        kind: 'change',
        changeId: 'chg-1',
        from: 'c1',
        to: 'c2',
        source: [`${RUN_DONE}-dsm`, 'dsm-b'],
      }),
      raster('dsm-c', 'c3'),
      clip('clip-1'),
      clip('clip-2'),
      mesh('mesh-a'),
      mesh('mesh-b'),
    ],
  });
  for (const p of [
    'photos/p1.jpg',
    'photos/p2.jpg',
    'photos/thumbs/p1.jpg',
    'video/clip-1.mp4',
    'video/clip-2.mp4',
    'flights/f1.json',
    'models/shared.glb',
    `sources/${RUN_DONE}-ortho.json`,
    'jobs/job-done/job.log',
    'jobs/job-failed/job.log',
    'change/chg-1/stats.json',
  ])
    await put(p);
  for (const id of [
    `${RUN_DONE}-ortho`,
    `${RUN_DONE}-dsm`,
    `${RUN_FAILED}-ortho`,
    'dsm-b',
    'chg-1-heat',
    'dsm-c',
  ])
    await put(`rasters/${id}/tiles.json`, '{}');
  const run = (id: string, status: string, source: unknown, layers: string[], tilesets: string[]) =>
    json(`photogrammetry/${id}/run.json`, {
      schema: 'aio.photo-run/1',
      id,
      status,
      preset: 'standard',
      photos: { source, count: 2 },
      outputs: { layers, tilesets, files: [] },
    });
  await run(
    RUN_DONE,
    'done',
    { layer: 'photos-a' },
    [`${RUN_DONE}-ortho`, `${RUN_DONE}-dsm`],
    [`${RUN_DONE}-mesh`],
  );
  await run(RUN_FAILED, 'failed', { layer: 'photos-a' }, [], []);
  await run(RUN_FOLDERS, 'failed', { folders: [OUTSIDE] }, [], []);
  await json('change/chg-1.json', {
    id: 'chg-1',
    from: 'c1',
    to: 'c2',
    producer: 'change.raster',
    items: [{ id: 'i1', layerFrom: `${RUN_DONE}-dsm`, layerTo: 'dsm-b' }],
    layers: ['chg-1-heat'],
  });
  const ts = (id: string, extra: Record<string, string>) => ({
    id,
    name: id,
    kind: 'mesh',
    src: `tiles/${id}/tileset.json`,
    visible: true,
    ...extra,
  });
  await json('tilesets.json', {
    schema: 'aio.tilesets/1',
    entries: [
      ts(`${RUN_DONE}-mesh`, { run: RUN_DONE }),
      ts('dsm-tiles', { from: `${RUN_DONE}-dsm` }),
      ts('b-tiles', { from: 'dsm-b' }),
    ],
  });
  for (const id of [`${RUN_DONE}-mesh`, 'dsm-tiles', 'b-tiles'])
    await put(`tiles/${id}/tileset.json`, '{}');
  const surface = (id: string, source: unknown) =>
    json(`survey/surfaces/${id}/tiles.json`, { schema: 'aio.height-tiles/1', id, source });
  await surface('s-a', { kind: 'dsm', layer: `${RUN_DONE}-dsm` });
  await surface('s-a-clean', { kind: 'derived', of: 's-a', edits: [] });
  await surface('s-b', { kind: 'dsm', layer: 'dsm-b' });
  await json('detections/pass-1.json', {
    schema: 'aio.detections/1',
    layer: 'photos-a',
    detections: [],
  });
  await json('detections/pass-2.json', {
    schema: 'aio.detections/1',
    layer: 'other',
    detections: [],
  });
  await json('issues.json', {
    schema: 'aio.issues/1',
    issues: [
      { id: 'i-a', sightings: [{ on: 'image', layer: 'photos-a' }] },
      { id: 'i-b', sightings: [{ on: 'map', layer: 'dsm-b' }] },
    ],
  });
  await json('volumes.json', {
    schema: 'aio.volumes/1',
    piles: [],
    captures: [{ captureId: 'c3' }],
  });
  return { dir, root };
}
```

Walks are covered by `walkRemove.test.ts`, unchanged.

- [ ] **Step 2: Write the failing tests** in `removePlan.test.ts`:

```ts
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_JOBS,
  OUTSIDE,
  RUN_DONE,
  RUN_FAILED,
  RUN_FOLDERS,
  makeRemoveProject,
} from './removeFixture';
import { namesAny, ownedPaths, planRemoval, valuesUnder } from './removePlan';

let dir: string;
let root: string;
beforeEach(async () => {
  ({ dir, root } = await makeRemoveProject());
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id).sort();

describe('planRemoval', () => {
  it('a photos layer takes its runs, their layers by outputs and by id, the comparison, tilesets, surfaces, detections and jobs', async () => {
    const p = await planRemoval(root, [{ layer: 'photos-a' }], { jobs: FIXTURE_JOBS });
    expect(p.refused).toBeUndefined();
    expect(ids(p.runs)).toEqual([RUN_DONE, RUN_FAILED].sort());
    expect(ids(p.layers)).toEqual(
      [
        'chg-1-heat',
        'photos-a',
        `${RUN_DONE}-dsm`,
        `${RUN_DONE}-ortho`,
        `${RUN_FAILED}-ortho`,
      ].sort(),
    );
    // the failed run never listed it: found by the <run>-ortho convention
    expect(p.layers.find((l) => l.id === `${RUN_FAILED}-ortho`)?.why).toEqual({
      madeBy: RUN_FAILED,
    });
    expect(p.runs.find((r) => r.id === RUN_DONE)?.why).toEqual({ usedBy: 'photos-a' });
    expect(ids(p.changes)).toEqual(['chg-1']);
    expect(p.changes[0]?.name).toBe('2026-10-12 to 2026-10-26');
    expect([...p.tilesets].sort()).toEqual([`${RUN_DONE}-mesh`, 'dsm-tiles']);
    expect([...p.surfaces].sort()).toEqual(['s-a', 's-a-clean']);
    expect(p.detections).toEqual(['detections/pass-1.json']);
    expect([...p.jobs].sort()).toEqual(['job-done', 'job-failed']);
    expect(p.files).toEqual(
      expect.arrayContaining([
        `photogrammetry/${RUN_DONE}`,
        `photogrammetry/${RUN_FAILED}`,
        `rasters/${RUN_FAILED}-ortho`,
        `rasters/${RUN_DONE}-dsm`,
        `sources/${RUN_DONE}-ortho.json`,
        'photos/p1.jpg',
        'photos/p2.jpg',
        'photos/thumbs/p1.jpg',
        'change/chg-1.json',
        'change/chg-1',
        'tiles/dsm-tiles',
        `tiles/${RUN_DONE}-mesh`,
        'survey/surfaces/s-a',
        'survey/surfaces/s-a-clean',
        'detections/pass-1.json',
        'jobs/job-failed',
        'jobs/job-done',
      ]),
    );
    expect(p.files).not.toContain('rasters/dsm-b');
    expect(p.files).not.toContain('photos/thumbs/p2.jpg'); // never there
    expect(p.touches).toEqual({ issues: 1, walkPins: 0 });
    expect(p.bytes).toBeGreaterThan(0);
  });

  it("a date takes its layers and the comparison into another date, and that date's layers stay", async () => {
    const p = await planRemoval(root, [{ capture: 'c1' }]);
    expect(p.captures).toEqual(['c1']);
    expect(p.layers.find((l) => l.id === 'photos-a')?.why).toEqual({ filedUnder: 'c1' });
    expect(ids(p.changes)).toEqual(['chg-1']);
    expect(ids(p.layers)).toContain('chg-1-heat');
    expect(ids(p.layers)).not.toContain('dsm-b');
    expect(p.surfaces).not.toContain('s-b');
    expect(p.tilesets).not.toContain('b-tiles');
    expect(p.captures).not.toContain('c2');
  });

  it('keeps a date that a volume names, and says so', async () => {
    const p = await planRemoval(root, [{ capture: 'c3' }]);
    expect(ids(p.layers)).toEqual(['dsm-c']);
    expect(p.captures).toEqual([]);
    expect(p.keptCaptures).toEqual([{ id: 'c3', by: 'volume' }]);
  });

  it('never lists the folders a run reads in place', async () => {
    const p = await planRemoval(root, [{ run: RUN_FOLDERS }]);
    expect(p.files).toEqual([`photogrammetry/${RUN_FOLDERS}`]);
    expect(p.keptOutside).toEqual([OUTSIDE]);
  });

  it('does not move a file another remaining layer names', async () => {
    expect((await planRemoval(root, [{ layer: 'mesh-a' }])).files).toEqual([]);
    const clip = await planRemoval(root, [{ layer: 'clip-1' }]);
    expect(clip.files).toEqual(['video/clip-1.mp4']);
  });

  it('removes a layer whose files are already gone', async () => {
    await rm(join(root, 'rasters', 'dsm-c'), { recursive: true });
    const p = await planRemoval(root, [{ layer: 'dsm-c' }]);
    expect(ids(p.layers)).toEqual(['dsm-c']);
    expect(p.files).toEqual([]);
  });

  it('lists a run folder without a readable run.json by its folder name', async () => {
    await writeFile(join(root, 'photogrammetry', RUN_FAILED, 'run.json'), 'not json');
    const p = await planRemoval(root, [{ run: RUN_FAILED }]);
    expect(p.runs).toEqual([{ id: RUN_FAILED, status: null, why: 'asked' }]);
    expect(p.files).toContain(`photogrammetry/${RUN_FAILED}`);
    expect(ids(p.layers)).toEqual([`${RUN_FAILED}-ortho`]);
  });

  it('refuses while a job of a removed run is live, naming it', async () => {
    const jobs = [
      { id: 'j1', pipeline: 'photo.products', status: 'running', params: { run: RUN_DONE } },
    ];
    const p = await planRemoval(root, [{ layer: 'photos-a' }], { jobs });
    expect(p.refused).toBe(`Creating maps for run ${RUN_DONE} is still running. Cancel it first.`);
    expect(p.files).toEqual([]);
  });

  it('refuses while a live job names a removed layer deep in its params', async () => {
    const jobs = [
      {
        id: 'j2',
        pipeline: 'change.raster',
        status: 'cancelling',
        params: { pair: { layerFrom: 'dsm-b' } },
      },
    ];
    const p = await planRemoval(root, [{ layer: 'dsm-b' }], { jobs });
    expect(p.refused).toMatch(/still running\. Cancel it first\./);
  });

  it('a finished job never refuses', async () => {
    const p = await planRemoval(root, [{ layer: 'photos-a' }], { jobs: FIXTURE_JOBS });
    expect(p.refused).toBeUndefined();
  });

  it('refuses a package and an unknown target', async () => {
    const pkg = 'This project is a read-only package. Nothing can be added or changed.';
    expect((await planRemoval(root, [{ layer: 'photos-a' }], { readOnly: pkg })).refused).toBe(pkg);
    expect((await planRemoval(root, [{ layer: 'nope' }])).refused).toBe(
      'There is no dataset "nope" in this project.',
    );
    expect((await planRemoval(root, [{ run: 'nope' }])).refused).toMatch(/no run "nope"/);
    expect((await planRemoval(root, [{ capture: 'nope' }])).refused).toMatch(/no survey date/);
  });

  it('refuses a path that leads outside the project through a junction', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'aio-outside-'));
    try {
      await writeFile(join(outside, 'precious.tif'), 'keep');
      await rm(join(root, 'rasters', 'dsm-b'), { recursive: true });
      await symlink(outside, join(root, 'rasters', 'dsm-b'), 'junction');
      const p = await planRemoval(root, [{ layer: 'dsm-b' }]);
      expect(p.refused).toMatch(/rasters\/dsm-b" leads outside the project folder/);
      expect(p.files).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('helpers', () => {
  it('owns a folder named after the layer, else the file, plus thumbs and sources', () => {
    expect(
      ownedPaths({
        kind: 'raster',
        id: 'r-ortho',
        name: 'r',
        visible: true,
        src: { path: 'rasters/r-ortho/tiles.json' },
        role: 'ortho',
        format: 'kit-pyramid',
      }),
    ).toEqual(['rasters/r-ortho', 'sources/r-ortho.json']);
    expect(
      ownedPaths({
        kind: 'photos',
        id: 'ph',
        name: 'p',
        visible: true,
        items: [
          { id: 'a', src: { path: 'photos/a.JPG' } },
          { id: 'h', src: { hash: 'a'.repeat(64) } },
        ],
      }),
    ).toEqual(['photos/a.JPG', 'photos/thumbs/a.jpg']);
  });

  it('finds layer names deep in change items and job params', () => {
    expect([
      ...valuesUnder(
        { items: [{ a: { layer: 'x' } }, { layerTo: 'y' }] },
        new Set(['layer', 'layerTo']),
      ),
    ]).toEqual(['x', 'y']);
    expect(namesAny({ p: [{ q: 'dsm-b' }] }, new Set(['dsm-b']))).toBe('dsm-b');
    expect(namesAny({ p: 3 }, new Set(['dsm-b']))).toBeNull();
  });
});
```

- [ ] **Step 3: Run, expect FAIL:** `pnpm --filter @aio/project test -- removePlan`
- [ ] **Step 4: Implement** `removePlan.ts`:

```ts
import {
  CHANGE_DIR,
  MEASUREMENTS_FILE,
  PHOTO_DIR,
  SURFACES_DIR,
  TILES_DIR,
  TILESETS_FILE,
  emptyRemovalPlan,
  type AssetRef,
  type KeptCapture,
  type Layer,
  type RemovalPlan,
  type RemoveTarget,
  type RemoveWhy,
} from '@aio/schema';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { readManifestFile } from './manifestFile';
import { pathBytes, TRASH_DIR } from './trash';
import { walkFolder } from './walkPaths';

/*
 * What a removal takes along (delete and start over, founder 13 Oct 2026; spec "Resolving
 * dependents"). Read from the project's own files, never from an index: the manifest, every
 * `photogrammetry/<run>/run.json`, `change/*.json`, `tilesets.json`, `survey/surfaces/<id>/tiles.json`,
 * `detections/*.json`, `issues.json`, `volumes.json`, `survey/qa/` and `survey/measurements.json`.
 * The set grows to a fixed point; issues, walk pins and measurements are kept and only counted.
 * Pure data: the dialog shows it and `removeItems` plans again from disk before it moves anything.
 */

export interface PlanJob {
  id: string;
  pipeline: string;
  status: string;
  params: Record<string, unknown>;
}

export interface PlanOptions {
  jobs?: readonly PlanJob[];
  readOnly?: string;
}

export const RUN_PRODUCTS = ['ortho', 'dsm', 'dtm', 'cloud', 'mesh'] as const;
const LIVE = new Set(['starting', 'running', 'cancelling']);
const STATUS = new Set([
  'aligning',
  'aligned',
  'adjusted',
  'processing',
  'done',
  'failed',
  'cancelled',
]);
const LAYER_KEYS = new Set(['layer', 'layerFrom', 'layerTo']);
/** What a person calls a job in a refusal. */
const JOB_WORDS: Readonly<Record<string, string>> = {
  'photo.align': 'Matching the photos',
  'photo.georef': 'Adjusting with ground control',
  'photo.products': 'Creating maps',
  'tiles.mesh': 'Making 3D tiles',
  'tiles.cloud': 'Making 3D tiles',
  'opf.export': 'Exporting as OPF',
};
/** Never moved, whatever names them. */
const NEVER = ['manifest.json', TRASH_DIR, 'assets', 'journal'];

type Json = Record<string, unknown>;
type RunStatus = RemovalPlan['runs'][number]['status'];
const asRecord = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const asStrings = (v: unknown): string[] =>
  asArray(v).filter((x): x is string => typeof x === 'string');
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
const abs = (root: string, rel: string) => join(root, ...rel.split('/'));
const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );
const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export function valuesUnder(
  v: unknown,
  keys: ReadonlySet<string>,
  out: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v as unknown[]) valuesUnder(x, keys, out);
    return out;
  }
  const r = asRecord(v);
  if (r)
    for (const [k, x] of Object.entries(r)) {
      if (keys.has(k) && typeof x === 'string') out.add(x);
      else valuesUnder(x, keys, out);
    }
  return out;
}

export function namesAny(v: unknown, ids: ReadonlySet<string>): string | null {
  if (typeof v === 'string') return ids.has(v) ? v : null;
  for (const x of Array.isArray(v) ? (v as unknown[]) : Object.values(asRecord(v) ?? {})) {
    const hit = namesAny(x, ids);
    if (hit !== null) return hit;
  }
  return null;
}

export function layerRefs(layer: Layer): string[] {
  const out: string[] = [];
  const add = (ref: AssetRef | undefined) => {
    if (!ref || !('path' in ref)) return;
    const p = norm(ref.path);
    if (!out.includes(p)) out.push(p);
  };
  switch (layer.kind) {
    case 'mesh':
    case 'pointcloud':
    case 'raster':
    case 'vector':
      add(layer.src);
      break;
    case 'video':
      add(layer.src);
      add(layer.poster);
      add(layer.flight.src);
      break;
    case 'walk':
      add(layer.record);
      add(layer.src);
      add(layer.poster);
      add(layer.path?.raw);
      add(layer.path?.orientation);
      add(layer.path?.orientationData);
      add(layer.path?.points);
      add(layer.flight?.src);
      break;
    case 'photos':
    case 'panoramas':
      for (const item of layer.items) add(item.src);
      break;
    case 'basemap':
    case 'legacy':
      break;
  }
  return out;
}

/** `photos/a.JPG` has its thumbnail at `photos/thumbs/a.jpg` (data-conventions section 2). */
function thumbOf(p: string): string {
  const i = p.lastIndexOf('/');
  const stem = p.slice(i + 1).replace(/\.[^.]+$/, '');
  return `${i < 0 ? '' : `${p.slice(0, i)}/`}thumbs/${stem}.jpg`;
}

export function ownedPaths(layer: Layer): string[] {
  const out = new Set<string>();
  if (layer.kind === 'walk') {
    // walk layers are `walk-<id>`: the folder comes from the record, not from the layer id
    const folder = 'path' in layer.record ? walkFolder(layer.record.path) : null;
    if (folder) out.add(folder);
    return [...out];
  }
  for (const p of layerRefs(layer)) {
    const parts = p.split('/');
    if (parts.length >= 2 && parts[parts.length - 2] === layer.id)
      out.add(parts.slice(0, -1).join('/'));
    else out.add(p);
    if (layer.kind === 'photos' || layer.kind === 'panoramas') out.add(thumbOf(p));
  }
  if (layer.kind === 'raster') out.add(`sources/${layer.id}.json`);
  return [...out];
}

interface RunFile {
  id: string;
  status: RunStatus;
  source: Json | null;
  layers: string[];
  tilesets: string[];
}
interface ChangeFile {
  id: string;
  from?: string;
  to?: string;
  layers: string[];
  names: Set<string>;
}
interface Project {
  runs: RunFile[];
  changes: ChangeFile[];
  tilesets: { id: string; src?: string; from?: string; run?: string }[];
  surfaces: { id: string; layer?: string; of?: string }[];
  detections: { path: string; layer?: string }[];
  issues: unknown[];
}

async function readProject(root: string): Promise<Project> {
  const runs: RunFile[] = [];
  for (const id of await names(abs(root, PHOTO_DIR))) {
    if (!(await isDir(join(abs(root, PHOTO_DIR), id)))) continue;
    const doc = asRecord(await readJson(join(abs(root, PHOTO_DIR), id, 'run.json')));
    const outputs = asRecord(doc?.outputs);
    const status = str(doc?.status);
    runs.push({
      id,
      status:
        status !== undefined && STATUS.has(status) ? (status as NonNullable<RunStatus>) : null,
      source: asRecord(asRecord(doc?.photos)?.source),
      layers: asStrings(outputs?.layers),
      tilesets: asStrings(outputs?.tilesets),
    });
  }
  const changes: ChangeFile[] = [];
  for (const f of await names(abs(root, CHANGE_DIR))) {
    if (!f.endsWith('.json')) continue;
    const doc = asRecord(await readJson(join(abs(root, CHANGE_DIR), f)));
    if (!doc) continue;
    changes.push({
      id: f.slice(0, -'.json'.length),
      ...(str(doc.from) ? { from: str(doc.from) } : {}),
      ...(str(doc.to) ? { to: str(doc.to) } : {}),
      layers: asStrings(doc.layers),
      names: valuesUnder(doc.items, LAYER_KEYS),
    });
  }
  const tilesets = asArray(asRecord(await readJson(abs(root, TILESETS_FILE)))?.entries).flatMap(
    (e) => {
      const r = asRecord(e);
      const id = str(r?.id);
      return r && id ? [{ id, src: str(r.src), from: str(r.from), run: str(r.run) }] : [];
    },
  );
  const surfaces: Project['surfaces'] = [];
  for (const id of await names(abs(root, SURFACES_DIR))) {
    const src = asRecord(
      asRecord(await readJson(join(abs(root, SURFACES_DIR), id, 'tiles.json')))?.source,
    );
    surfaces.push({ id, layer: str(src?.layer), of: str(src?.of) });
  }
  const detections: Project['detections'] = [];
  for (const f of await names(join(root, 'detections'))) {
    if (!f.endsWith('.json')) continue;
    const doc = asRecord(await readJson(join(root, 'detections', f)));
    detections.push({ path: `detections/${f}`, layer: str(doc?.layer) });
  }
  const issues = asArray(asRecord(await readJson(join(root, 'issues.json')))?.issues);
  return { runs, changes, tilesets, surfaces, detections, issues };
}

async function captureKeptBy(root: string, id: string): Promise<KeptCapture['by'] | null> {
  if (valuesUnder(await readJson(join(root, 'volumes.json')), new Set(['captureId'])).has(id))
    return 'volume';
  if (await exists(join(root, 'survey', 'qa', `${id}.json`))) return 'qa';
  if (valuesUnder(await readJson(abs(root, MEASUREMENTS_FILE)), new Set(['capture'])).has(id))
    return 'measurement';
  return null;
}

/** True when `rel` is not a plain path inside the project, or resolves outside it (a link). */
async function leadsOutside(root: string, realRoot: string, rel: string): Promise<boolean> {
  if (rel.split('/').includes('..') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return true;
  let real: string;
  try {
    real = await realpath(abs(root, rel));
  } catch {
    return false; // gone: nothing to move
  }
  const r = relative(fold(realRoot), fold(real));
  return r === '' || r.startsWith('..') || isAbsolute(r);
}

export async function planRemoval(
  root: string,
  targets: readonly RemoveTarget[],
  o: PlanOptions = {},
): Promise<RemovalPlan> {
  const refuse = (why: string): RemovalPlan => ({ ...emptyRemovalPlan(), refused: why });
  if (o.readOnly !== undefined) return refuse(o.readOnly);
  const m = await readManifestFile(root);
  const pf = await readProject(root);
  const byId = new Map(m.layers.map((l) => [l.id, l]));
  const layerWhy = new Map<string, RemoveWhy>();
  const runWhy = new Map<string, RemoveWhy>();
  const changeWhy = new Map<string, RemoveWhy>();
  const captures: string[] = [];
  const keptCaptures: KeptCapture[] = [];
  const take = (id: string, why: RemoveWhy) => {
    if (!byId.has(id) || layerWhy.has(id)) return false;
    layerWhy.set(id, why);
    return true;
  };

  for (const t of targets) {
    if ('layer' in t) {
      if (!byId.has(t.layer)) return refuse(`There is no dataset "${t.layer}" in this project.`);
      layerWhy.set(t.layer, 'asked');
    } else if ('run' in t) {
      if (!pf.runs.some((r) => r.id === t.run))
        return refuse(`There is no run "${t.run}" in this project.`);
      runWhy.set(t.run, 'asked');
    } else {
      if (!m.captures.some((c) => c.id === t.capture))
        return refuse(`There is no survey date "${t.capture}" in this project.`);
      for (const l of m.layers) if (l.capture === t.capture) take(l.id, { filedUnder: t.capture });
      const by = await captureKeptBy(root, t.capture);
      if (by) keptCaptures.push({ id: t.capture, by });
      else captures.push(t.capture);
    }
  }

  for (let grew = true; grew;) {
    grew = false;
    for (const r of pf.runs) {
      const src = str(r.source?.layer);
      if (!runWhy.has(r.id) && src !== undefined && layerWhy.has(src)) {
        runWhy.set(r.id, { usedBy: src });
        grew = true;
      }
    }
    for (const id of [...runWhy.keys()]) {
      const listed = pf.runs.find((r) => r.id === id)?.layers ?? [];
      for (const l of [...listed, ...RUN_PRODUCTS.map((s) => `${id}-${s}`)])
        if (take(l, { madeBy: id })) grew = true;
    }
    for (const c of pf.changes) {
      if (changeWhy.has(c.id)) continue;
      const hit = [...c.names, ...c.layers].find((id) => layerWhy.has(id));
      if (hit !== undefined) {
        changeWhy.set(c.id, { usedBy: hit });
        grew = true;
      }
    }
    for (const c of pf.changes)
      if (changeWhy.has(c.id))
        for (const id of c.layers) if (take(id, { madeBy: c.id })) grew = true;
    for (const l of m.layers) {
      const d = l.derived;
      if (d?.changeId && changeWhy.has(d.changeId) && take(l.id, { madeBy: d.changeId }))
        grew = true;
      const src = d?.source?.find((s) => layerWhy.has(s));
      if (src !== undefined && take(l.id, { usedBy: src })) grew = true;
    }
  }

  const runIds = new Set(runWhy.keys());
  const layerIds = new Set(layerWhy.keys());
  for (const j of o.jobs ?? []) {
    if (!LIVE.has(j.status)) continue;
    const words = JOB_WORDS[j.pipeline] ?? `The ${j.pipeline} job`;
    const run = str(j.params.run);
    if (run !== undefined && runIds.has(run))
      return refuse(`${words} for run ${run} is still running. Cancel it first.`);
    const hit = namesAny(j.params, layerIds);
    if (hit !== null)
      return refuse(
        `${words} uses "${byId.get(hit)?.name ?? hit}" and is still running. Cancel it first.`,
      );
  }

  const runTilesets = new Set(pf.runs.filter((r) => runIds.has(r.id)).flatMap((r) => r.tilesets));
  const tilesets = pf.tilesets.filter(
    (t) =>
      (t.run !== undefined && runIds.has(t.run)) ||
      (t.from !== undefined && layerIds.has(t.from)) ||
      runTilesets.has(t.id),
  );
  const surfaceIds = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const s of pf.surfaces)
      if (
        !surfaceIds.has(s.id) &&
        ((s.layer !== undefined && layerIds.has(s.layer)) ||
          (s.of !== undefined && surfaceIds.has(s.of)))
      ) {
        surfaceIds.add(s.id);
        grew = true;
      }
  }
  const detections = pf.detections
    .filter((d) => d.layer !== undefined && layerIds.has(d.layer))
    .map((d) => d.path);
  const jobs = (o.jobs ?? []).filter((j) => {
    const run = str(j.params.run);
    return run !== undefined && runIds.has(run);
  });

  const removed = m.layers.filter((l) => layerIds.has(l.id));
  const kept = m.layers
    .filter((l) => !layerIds.has(l.id))
    .flatMap((l) => [...ownedPaths(l), ...layerRefs(l)]);
  const candidates = new Set<string>();
  for (const id of runIds) candidates.add(`${PHOTO_DIR}/${id}`);
  for (const l of removed) for (const p of ownedPaths(l)) candidates.add(p);
  for (const t of tilesets) {
    const folder = `${TILES_DIR}/${t.id}`;
    candidates.add(
      t.src !== undefined && !norm(t.src).startsWith(`${folder}/`) ? norm(t.src) : folder,
    );
  }
  for (const c of changeWhy.keys()) {
    candidates.add(`${CHANGE_DIR}/${c}.json`);
    candidates.add(`${CHANGE_DIR}/${c}`);
  }
  for (const s of surfaceIds) candidates.add(`${SURFACES_DIR}/${s}`);
  for (const d of detections) candidates.add(d);
  for (const j of jobs) candidates.add(`jobs/${j.id}`);

  const realRoot = await realpath(root);
  const files: string[] = [];
  // sorted: a folder comes before what is inside it, so nothing moves twice
  for (const rel of [...candidates].sort()) {
    if (rel === '' || NEVER.some((n) => overlaps(rel, n))) continue;
    if (kept.some((k) => overlaps(rel, k))) continue;
    if (files.some((f) => rel.startsWith(`${f}/`))) continue;
    if (await leadsOutside(root, realRoot, rel))
      return refuse(
        `"${rel}" leads outside the project folder (a link or junction). Nothing was removed.`,
      );
    if (await exists(abs(root, rel))) files.push(rel);
  }
  let bytes = 0;
  for (const f of files) bytes += await pathBytes(abs(root, f));

  const walkPins = m.layers.reduce(
    (n, l) =>
      n +
      (l.kind === 'walk' && !layerIds.has(l.id)
        ? (l.place?.pins.filter((p) => layerIds.has(p.surface)).length ?? 0)
        : 0),
    0,
  );
  const issues = pf.issues.filter((i) =>
    asArray(asRecord(i)?.sightings).some((s) => {
      const id = str(asRecord(s)?.layer);
      return id !== undefined && layerIds.has(id);
    }),
  ).length;
  const dateOf = (id?: string) => m.captures.find((c) => c.id === id)?.date ?? id ?? '';
  return {
    ...emptyRemovalPlan(),
    layers: removed.map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      why: layerWhy.get(l.id) ?? 'asked',
    })),
    runs: [...runIds].map((id) => ({
      id,
      status: pf.runs.find((r) => r.id === id)?.status ?? null,
      why: runWhy.get(id) ?? 'asked',
    })),
    changes: pf.changes
      .filter((c) => changeWhy.has(c.id))
      .map((c) => ({
        id: c.id,
        name: `${dateOf(c.from)} to ${dateOf(c.to)}`,
        why: changeWhy.get(c.id) ?? 'asked',
      })),
    tilesets: tilesets.map((t) => t.id),
    surfaces: [...surfaceIds],
    detections,
    jobs: jobs.map((j) => j.id),
    captures,
    keptCaptures,
    keptOutside: pf.runs
      .filter((r) => runIds.has(r.id))
      .flatMap((r) => asStrings(r.source?.folders)),
    files,
    bytes,
    touches: { issues, walkPins },
  };
}
```

- [ ] **Step 5: Run** `pnpm --filter @aio/project test -- removePlan`, then `pnpm typecheck` and
      `pnpm lint`. Expect PASS. The junction test runs on Windows without admin rights
      (`'junction'`); elsewhere the third argument is ignored and a directory symlink is made.
- [ ] **Step 6: Commit**

```bash
git add packages/project/src/builder/removePlan.ts packages/project/src/builder/removePlan.test.ts packages/project/src/builder/removeFixture.ts
git commit -m "feat(project): plan a removal and everything it takes along" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: `JobStore.delete`

**Files:**

- Modify: `apps/desktop/src/main/jobs/store.ts` (a method after `get`, line 47)
- Create: `apps/desktop/src/main/jobs/store.test.ts`

**Packages:** desktop main.

**Interfaces:** Produces `JobStore.delete(id: string): boolean` (false for an unknown or active
job; the caller flushes).

- [ ] **Step 1: Write the failing test** `store.test.ts`:

```ts
import type { JobRecord } from '@aio/schema';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from './store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-jobstore-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const job = (id: string, status: JobRecord['status'], createdAt: string): JobRecord => ({
  id,
  pipeline: 'photo.align',
  project: 'C:/projects/site',
  params: { run: '20261012-0930' },
  status,
  progress: 0,
  steps: [],
  artifacts: [],
  createdAt,
  updatedAt: createdAt,
});

describe('JobStore.delete', () => {
  it('forgets a finished job and the index on disk follows after a flush', async () => {
    const file = join(dir, 'jobs.json');
    const s = new JobStore(file);
    s.put(job('job-failed', 'failed', '2026-10-13T08:00:00.000Z'));
    s.put(job('job-done', 'done', '2026-10-13T09:00:00.000Z'));
    expect(s.delete('job-failed')).toBe(true);
    await s.flush();
    expect(s.get('job-failed')).toBeUndefined();
    const again = new JobStore(file);
    await again.load();
    expect(again.all().map((j) => j.id)).toEqual(['job-done']);
  });

  it('keeps an active job and answers false for one it does not know', () => {
    const s = new JobStore(join(dir, 'jobs.json'));
    s.put(job('job-live', 'running', '2026-10-13T08:00:00.000Z'));
    expect(s.delete('job-live')).toBe(false);
    expect(s.get('job-live')).toBeDefined();
    expect(s.delete('nope')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/desktop test -- jobs/store`.
- [ ] **Step 3: Implement** in `store.ts` after `get`:

```ts
  /**
   * Forget a job (the jobs of a removed run, after the manifest save). An active job is never
   * forgotten; false for that and for an id the index does not hold. The caller flushes.
   */
  delete(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || ACTIVE.has(job.status)) return false;
    this.jobs.delete(id);
    return true;
  }
```

- [ ] **Step 4: Run** the test again and `pnpm typecheck`. Expect PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/jobs/store.ts apps/desktop/src/main/jobs/store.test.ts
git commit -m "feat(desktop): the job index can forget a finished job" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Removing (`builder/remove.ts`), and `removeWalk` as one case

**Files:**

- Create: `packages/project/src/builder/remove.ts`, `packages/project/src/builder/remove.test.ts`
- Modify: `packages/project/src/builder/walkRemove.ts` (whole body: `removeWalk` delegates)
- Modify: `packages/project/src/builder/index.ts` (exports below)
- Test, unchanged and passing: `packages/project/src/builder/walkRemove.test.ts`

**Packages:** `@aio/project`.

**Interfaces:**

- Consumes: `planRemoval`, `PlanOptions` (T3); `freeTrashEntry`, `TRASH_DIR` (T2);
  `renameWhenFree`, `RenameOptions` (`../import/rename`); `updateManifestFile`;
  `TRASH_SCHEMA`, `TrashRecord`, `TILESETS_FILE`, `WALKS_DIR` (schema).
- Produces:

```ts
export const MANIFEST_BEFORE = 'manifest.before.json';
export interface RemoveOptions extends PlanOptions {
  rename?: RenameOptions['rename'];
  sleep?: RenameOptions['sleep'];
  platform?: NodeJS.Platform;
  /** `removeWalk`: the entry is the walk folder itself, `<stamp>-<walk id>/`, as before. */
  walkLayout?: boolean;
}
export interface RemoveResult {
  manifest: ProjectManifest;
  plan: RemovalPlan;
  /** The trash entry's name, or null when nothing moved. */
  trash: string | null;
}
export function removeItems(
  root: string,
  targets: readonly RemoveTarget[],
  now?: () => Date,
  o?: RemoveOptions,
): Promise<RemoveResult>;
// unchanged signature
export function removeWalk(
  root: string,
  layerId: string,
  now?: () => Date,
  o?: RemoveWalkOptions,
): Promise<ProjectManifest>;
```

`index.ts` gains:

```ts
export {
  RUN_PRODUCTS,
  layerRefs,
  namesAny,
  ownedPaths,
  planRemoval,
  valuesUnder,
  type PlanJob,
  type PlanOptions,
} from './removePlan';
export { MANIFEST_BEFORE, removeItems, type RemoveOptions, type RemoveResult } from './remove';
```

- [ ] **Step 1: Write the failing tests** `remove.test.ts`:

```ts
import { TrashRecord } from '@aio/schema';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename as fsRename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readManifestFile } from './manifestFile';
import { MANIFEST_BEFORE, removeItems } from './remove';
import { FIXTURE_JOBS, RUN_DONE, RUN_FAILED, makeRemoveProject } from './removeFixture';
import { planRemoval } from './removePlan';

let dir: string;
let root: string;
beforeEach(async () => {
  ({ dir, root } = await makeRemoveProject());
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-10-13T08:15:30.000Z');
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const at = (...p: string[]) => join(root, ...p);
const trashEntries = () => readdir(at('.trash')).catch(() => [] as string[]);
const tilesetIds = async () =>
  (
    JSON.parse(await readFile(at('tilesets.json'), 'utf8')) as { entries: { id: string }[] }
  ).entries.map((e) => e.id);
const busy = (msg: string) => Object.assign(new Error(msg), { code: 'EBUSY' });

describe('removeItems', () => {
  it('moves the files in their project layout and writes removed.json and the manifest before', async () => {
    const r = await removeItems(root, [{ run: RUN_FAILED }], () => NOW, { jobs: FIXTURE_JOBS });
    const entry = `20261013T081530Z-run-${RUN_FAILED}`;
    expect(r.trash).toBe(entry);
    expect(await trashEntries()).toEqual([entry]);
    expect(await exists(at('.trash', entry, 'photogrammetry', RUN_FAILED, 'run.json'))).toBe(true);
    expect(await exists(at('.trash', entry, 'rasters', `${RUN_FAILED}-ortho`, 'tiles.json'))).toBe(
      true,
    );
    expect(await exists(at('.trash', entry, 'jobs', 'job-failed', 'job.log'))).toBe(true);
    expect(await exists(at('photogrammetry', RUN_FAILED))).toBe(false);
    expect(r.manifest.layers.some((l) => l.id === `${RUN_FAILED}-ortho`)).toBe(false);
    expect((await readManifestFile(root)).layers.some((l) => l.id === `${RUN_FAILED}-ortho`)).toBe(
      false,
    );
    const rec = TrashRecord.parse(
      JSON.parse(await readFile(at('.trash', entry, 'removed.json'), 'utf8')),
    );
    expect(rec).toMatchObject({
      at: NOW.toISOString(),
      targets: [{ run: RUN_FAILED }],
      manifestBefore: MANIFEST_BEFORE,
    });
    expect(rec.plan.jobs).toEqual(['job-failed']);
    expect(await readFile(at('.trash', entry, MANIFEST_BEFORE), 'utf8')).toContain(
      `${RUN_FAILED}-ortho`,
    );
  });

  it('rewrites tilesets.json and keeps a copy in the trash', async () => {
    const r = await removeItems(root, [{ layer: `${RUN_DONE}-dsm` }], () => NOW);
    expect((await tilesetIds()).sort()).toEqual([`${RUN_DONE}-mesh`, 'b-tiles'].sort());
    const copy = JSON.parse(
      await readFile(at('.trash', r.trash ?? '', 'tilesets.json'), 'utf8'),
    ) as {
      entries: unknown[];
    };
    expect(copy.entries).toHaveLength(3);
    expect(await exists(at('tiles', 'dsm-tiles'))).toBe(false);
  });

  it('removes a date and everything filed under it in one save', async () => {
    const r = await removeItems(root, [{ capture: 'c1' }], () => NOW, { jobs: FIXTURE_JOBS });
    expect(r.manifest.captures.map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(r.manifest.layers.some((l) => l.capture === 'c1')).toBe(false);
    expect(r.manifest.layers.some((l) => l.id === 'dsm-b')).toBe(true);
  });

  it('waits for a file held open for a moment (Windows)', async () => {
    let n = 0;
    const rename = async (a: string, b: string) => {
      n += 1;
      if (n <= 2) throw busy('held by a viewer');
      await fsRename(a, b);
    };
    const r = await removeItems(root, [{ layer: 'clip-1' }], () => NOW, {
      rename,
      platform: 'win32',
      sleep: () => Promise.resolve(),
    });
    expect(r.trash).not.toBeNull();
    expect(await exists(at('video', 'clip-1.mp4'))).toBe(false);
  });

  it('rolls back when the third move fails', async () => {
    const before = (await planRemoval(root, [{ layer: 'photos-a' }], { jobs: FIXTURE_JOBS })).files;
    let n = 0;
    const rename = async (a: string, b: string) => {
      n += 1;
      if (n === 3) throw busy('photos/p1.jpg is held open');
      await fsRename(a, b);
    };
    await expect(
      removeItems(root, [{ layer: 'photos-a' }], () => NOW, {
        jobs: FIXTURE_JOBS,
        rename,
        platform: 'linux',
      }),
    ).rejects.toThrow(/held open.*Nothing was removed\./);
    for (const f of before) expect(await exists(at(...f.split('/'))), f).toBe(true);
    expect((await readManifestFile(root)).layers.some((l) => l.id === 'photos-a')).toBe(true);
    expect(await trashEntries()).toEqual([]);
  });

  it('leaves the files in the trash with removed.json when the way back is refused too', async () => {
    let n = 0;
    const rename = async (a: string, b: string) => {
      n += 1;
      if (n >= 3) throw busy('held');
      await fsRename(a, b);
    };
    await expect(
      removeItems(root, [{ layer: 'photos-a' }], () => NOW, {
        jobs: FIXTURE_JOBS,
        rename,
        platform: 'linux',
      }),
    ).rejects.toThrow(/could not be moved back.*\.trash/);
    const [entry] = await trashEntries();
    expect(entry).toBeDefined();
    expect(await exists(at('.trash', entry ?? '', 'removed.json'))).toBe(true);
  });

  it('rolls back files and tilesets.json when the save fails', async () => {
    // a folder where the backup goes: the save refuses before it writes the manifest
    await rm(at('manifest.json.bak'), { force: true });
    await mkdir(at('manifest.json.bak'));
    await expect(removeItems(root, [{ layer: `${RUN_DONE}-dsm` }], () => NOW)).rejects.toThrow();
    expect(await tilesetIds()).toHaveLength(3);
    expect(await exists(at('rasters', `${RUN_DONE}-dsm`, 'tiles.json'))).toBe(true);
    expect(await exists(at('change', 'chg-1.json'))).toBe(true);
    expect((await readManifestFile(root)).layers.some((l) => l.id === `${RUN_DONE}-dsm`)).toBe(
      true,
    );
    expect(await trashEntries()).toEqual([]);
  });

  it('plans again from disk: a job started since refuses and nothing moves', async () => {
    const jobs = [
      { id: 'j1', pipeline: 'photo.products', status: 'starting', params: { run: RUN_DONE } },
    ];
    await expect(removeItems(root, [{ run: RUN_DONE }], () => NOW, { jobs })).rejects.toThrow(
      /still running/,
    );
    expect(await exists(at('photogrammetry', RUN_DONE, 'run.json'))).toBe(true);
    expect(await trashEntries()).toEqual([]);
  });

  it('moves nothing when a raster folder is a junction', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'aio-outside-'));
    try {
      await writeFile(join(outside, 'precious.tif'), 'keep');
      await rm(at('rasters', 'dsm-c'), { recursive: true });
      await symlink(outside, at('rasters', 'dsm-c'), 'junction');
      await expect(removeItems(root, [{ layer: 'dsm-c' }], () => NOW)).rejects.toThrow(
        /outside the project/,
      );
      expect(await readFile(join(outside, 'precious.tif'), 'utf8')).toBe('keep');
      expect((await readManifestFile(root)).layers.some((l) => l.id === 'dsm-c')).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/project test -- remove.test walkRemove`
- [ ] **Step 3: Implement** `remove.ts`:

```ts
import {
  TILESETS_FILE,
  TRASH_SCHEMA,
  WALKS_DIR,
  type ProjectManifest,
  type RemovalPlan,
  type RemoveTarget,
  type TrashRecord,
} from '@aio/schema';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { renameWhenFree, type RenameOptions } from '../import/rename';
import { updateManifestFile } from './manifestFile';
import { planRemoval, type PlanOptions } from './removePlan';
import { freeTrashEntry, TRASH_DIR } from './trash';

/*
 * Removing (delete and start over, spec "Removing"): plan again from disk, move every file into one
 * trash entry, rewrite `tilesets.json` (a copy goes first), save the manifest once, write
 * `removed.json`. When a move is refused, the moves made come back and nothing changed; when the
 * save fails, the side file and the files come back; when the way back is refused too, the files
 * stay in the entry with `removed.json` and the error says where.
 */

export const MANIFEST_BEFORE = 'manifest.before.json';

export interface RemoveOptions extends PlanOptions {
  rename?: RenameOptions['rename'];
  sleep?: RenameOptions['sleep'];
  platform?: NodeJS.Platform;
  walkLayout?: boolean;
}

export interface RemoveResult {
  manifest: ProjectManifest;
  plan: RemovalPlan;
  trash: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const slugOf = (t: RemoveTarget) =>
  'layer' in t ? t.layer : 'run' in t ? `run-${t.run}` : `date-${t.capture}`;

export async function removeItems(
  root: string,
  targets: readonly RemoveTarget[],
  now: () => Date = () => new Date(),
  o: RemoveOptions = {},
): Promise<RemoveResult> {
  const plan = await planRemoval(root, targets, o);
  if (plan.refused !== undefined) throw new Error(plan.refused);
  const first = targets[0];
  if (first === undefined) throw new Error('Nothing to remove.');
  const ro: RenameOptions = {
    ...(o.rename ? { rename: o.rename } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.platform ? { platform: o.platform } : {}),
  };
  const rewrite = plan.tilesets.length > 0;
  const only = plan.files.length === 1 ? (plan.files[0] ?? '') : '';
  // a walk alone keeps the walk entry layout (`<stamp>-<walk id>/`), whichever channel removes it
  const onlyWalk =
    plan.layers.length === 1 && plan.layers[0]?.kind === 'walk' && plan.runs.length === 0;
  const flat = (o.walkLayout === true || onlyWalk) && !rewrite && only.startsWith(`${WALKS_DIR}/`);
  const at = now();
  const entry =
    plan.files.length === 0 && !rewrite
      ? null
      : await freeTrashEntry(root, at, flat ? only.slice(WALKS_DIR.length + 1) : slugOf(first));
  const before = await readFile(join(root, 'manifest.json'), 'utf8');
  const moved: { from: string; to: string }[] = [];
  const sides: { file: string; text: string }[] = [];

  const record = (): TrashRecord => ({
    schema: TRASH_SCHEMA,
    at: at.toISOString(),
    targets: [...targets],
    plan,
    manifestBefore: MANIFEST_BEFORE,
  });
  const writeRecord = async (dir: string) => {
    await writeFile(join(dir, MANIFEST_BEFORE), before);
    await writeFile(join(dir, 'removed.json'), `${JSON.stringify(record(), null, 2)}\n`);
  };
  /** Put back what was changed; answers what could not come back. */
  const undo = async (): Promise<string[]> => {
    const stuck: string[] = [];
    for (const s of [...sides].reverse())
      await writeFile(s.file, s.text).catch(() => {
        stuck.push(s.file);
      });
    for (const mv of [...moved].reverse())
      await renameWhenFree(mv.to, mv.from, ro).catch(() => {
        stuck.push(mv.from);
      });
    return stuck;
  };
  /** After a failure: the entry goes when everything came back, else it keeps a record. */
  const fail = async (e: unknown, nothing: string): Promise<never> => {
    const stuck = await undo();
    if (stuck.length > 0 && entry !== null) {
      await writeRecord(entry).catch(() => undefined);
      throw new Error(
        `${message(e)} ${String(stuck.length)} file(s) could not be moved back. They are in ${TRASH_DIR}/${basename(entry)}, listed in removed.json.`,
      );
    }
    if (entry !== null && !flat)
      await rm(entry, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`${message(e)}${nothing}`);
  };

  try {
    for (const rel of plan.files) {
      const from = join(root, ...rel.split('/'));
      const to = flat && entry !== null ? entry : join(entry ?? root, ...rel.split('/'));
      await mkdir(dirname(to), { recursive: true });
      try {
        await renameWhenFree(from, to, ro);
      } catch (e) {
        throw new Error(`${rel} could not be moved to the project trash (${message(e)}).`);
      }
      moved.push({ from, to });
    }
    if (rewrite && entry !== null) {
      const file = join(root, TILESETS_FILE);
      const text = await readFile(file, 'utf8');
      await writeFile(join(entry, TILESETS_FILE), text);
      sides.push({ file, text });
      const doc = JSON.parse(text) as { entries?: { id?: unknown }[] };
      const gone = new Set(plan.tilesets);
      const entries = (doc.entries ?? []).filter(
        (e) => typeof e.id !== 'string' || !gone.has(e.id),
      );
      await writeFile(file, `${JSON.stringify({ ...doc, entries }, null, 2)}\n`);
    }
  } catch (e) {
    return fail(e, ' Nothing was removed.');
  }

  const layerIds = new Set(plan.layers.map((l) => l.id));
  const captureIds = new Set(plan.captures);
  let manifest: ProjectManifest;
  try {
    const r = await updateManifestFile(root, (m) => ({
      manifest: {
        ...m,
        layers: m.layers.filter((l) => !layerIds.has(l.id)),
        captures: m.captures.filter((c) => !captureIds.has(c.id)),
      },
    }));
    manifest = r.manifest;
  } catch (e) {
    return fail(e, '');
  }
  if (entry !== null) await writeRecord(entry);
  return { manifest, plan, trash: entry === null ? null : basename(entry) };
}
```

`walkRemove.ts` becomes:

```ts
import type { ProjectManifest } from '@aio/schema';
import type { RenameOptions } from '../import/rename';
import { readManifestFile } from './manifestFile';
import { removeItems } from './remove';

/*
 * Removing a walk (the walk layer and placing, "The smaller points"): one case of `removeItems`
 * (delete and start over, 13 Oct 2026). Its folder `walks/<id>/` moves to `.trash/<stamp>-<id>/`
 * as before, now with `removed.json`; the folder moves first, the layer leaves the manifest in one
 * save, and a failed save moves the folder back.
 */

export interface RemoveWalkOptions {
  rename?: RenameOptions['rename'];
}

export async function removeWalk(
  root: string,
  layerId: string,
  now: () => Date = () => new Date(),
  o: RemoveWalkOptions = {},
): Promise<ProjectManifest> {
  const layer = (await readManifestFile(root)).layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`There is no layer "${layerId}" in this project.`);
  if (layer.kind !== 'walk') throw new Error(`"${layer.name}" is not a walk.`);
  return (await removeItems(root, [{ layer: layerId }], now, { ...o, walkLayout: true })).manifest;
}
```

Then the `index.ts` exports above.

- [ ] **Step 4: Run** `pnpm --filter @aio/project test` (all of it: `walkRemove.test.ts` unchanged,
      `remove.test.ts`, `removePlan.test.ts`, `trash.test.ts`), `pnpm typecheck`, `pnpm lint`.
      Expect PASS. If a walk test fails, fix `remove.ts`, never the walk test.
- [ ] **Step 5: Commit**

```bash
git add packages/project/src/builder/remove.ts packages/project/src/builder/remove.test.ts packages/project/src/builder/walkRemove.ts packages/project/src/builder/index.ts
git commit -m "feat(project): remove datasets, runs and dates to the project trash with rollback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Main: the removal channels, job records, the journal, Start over's folders

**Files:**

- Create: `apps/desktop/src/main/removal.ts`, `apps/desktop/src/main/removal.test.ts`
- Create: `apps/desktop/src/main/layerRefs.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (beside `walks:remove`, about line 1307: four handlers)
- Modify: `apps/desktop/src/main/journal.ts` (header comment line 13; a `builder:remove` branch
  before the `builder:updateLayers` branch, about line 956)
- Modify: `apps/desktop/src/main/journal.test.ts` (`writers` list, about line 950)
- Modify: `apps/desktop/src/main/photogrammetry.ts` (`photo:readRun`, line 1071: `missingFolders`)

**Packages:** desktop main.

**Interfaces:**

- Consumes: `planRemoval`, `removeItems`, `trashSize`, `emptyTrash`, `layerRefs`, `PlanJob`
  (`@aio/project/builder`); `JobStore.delete` (T4); `layerFiles` (`@aio/sync`); `samePath`
  (`./libraryActions`).
- Produces:

```ts
import type * as Builder from '@aio/project/builder';
export type RemovalLib = Pick<
  typeof Builder,
  'planRemoval' | 'removeItems' | 'trashSize' | 'emptyTrash'
>;
export interface RemovalDeps {
  root: (projectId: string) => string | undefined;
  isPackage: (projectId: string) => boolean;
  jobs: () => readonly JobRecord[];
  deleteJob: (id: string) => boolean;
  flushJobs: () => Promise<void>;
  log: (line: string) => void;
  lib?: () => Promise<RemovalLib>;
}
export const PACKAGE_REFUSAL: string;
export function planJobsFor(root: string, all: readonly JobRecord[]): PlanJob[];
export function removalPlanAnswer(
  req: IpcRequest<'builder:removePlan'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:removePlan'>>;
export function removeAnswer(
  req: IpcRequest<'builder:remove'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:remove'>>;
export function trashAnswer(
  req: IpcRequest<'builder:trash'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:trash'>>;
export function emptyTrashAnswer(
  req: IpcRequest<'builder:emptyTrash'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:emptyTrash'>>;
/** The journaled files a removal changed: the manifest, tilesets.json, change sets, detections. */
export function journaledRemovals(plan: RemovalPlan): string[];
```

- [ ] **Step 1: Write the failing tests** `removal.test.ts`:

```ts
import {
  emptyRemovalPlan,
  type JobRecord,
  type ProjectManifest,
  type RemovalPlan,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  PACKAGE_REFUSAL,
  emptyTrashAnswer,
  journaledRemovals,
  planJobsFor,
  removalPlanAnswer,
  removeAnswer,
  trashAnswer,
  type RemovalDeps,
  type RemovalLib,
} from './removal';

const ROOT = 'C:/data/projects/site';
const job = (id: string, project: string): JobRecord => ({
  id,
  pipeline: 'photo.align',
  project,
  params: { run: 'r1' },
  status: 'failed',
  progress: 0,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
});
const PLAN: RemovalPlan = {
  ...emptyRemovalPlan(),
  jobs: ['job-1'],
  runs: [{ id: 'r1', status: 'failed', why: 'asked' }],
};
const MANIFEST = {} as ProjectManifest;

function deps(
  lib: Partial<RemovalLib>,
  order: string[] = [],
  o: { pkg?: boolean } = {},
): RemovalDeps {
  return {
    root: (id) => (id === 'p' ? ROOT : undefined),
    isPackage: () => o.pkg === true,
    jobs: () => [job('job-1', ROOT), job('job-other', 'C:/data/projects/other')],
    deleteJob: (id) => {
      order.push(`delete ${id}`);
      return true;
    },
    flushJobs: () => {
      order.push('flush');
      return Promise.resolve();
    },
    log: (line) => {
      order.push(`log ${line}`);
    },
    lib: () => Promise.resolve(lib as RemovalLib),
  };
}

describe('removal channels', () => {
  it("hands the plan this project's jobs only", async () => {
    let seen: string[] = [];
    const lib: Partial<RemovalLib> = {
      planRemoval: (_root, _t, o) => {
        seen = (o?.jobs ?? []).map((j) => j.id);
        return Promise.resolve(PLAN);
      },
    };
    const r = await removalPlanAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, deps(lib));
    expect(r).toEqual({ ok: true, plan: PLAN });
    expect(seen).toEqual(['job-1']);
    expect(planJobsFor('c:\\data\\projects\\site', [job('a', ROOT)]).map((j) => j.id)).toEqual(
      process.platform === 'win32' ? ['a'] : [],
    );
  });

  it('deletes job records only after the save, then flushes', async () => {
    const order: string[] = [];
    const lib: Partial<RemovalLib> = {
      removeItems: () => {
        order.push('save');
        return Promise.resolve({ manifest: MANIFEST, plan: PLAN, trash: 'x' });
      },
    };
    const r = await removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, deps(lib, order));
    expect(r).toEqual({ ok: true, manifest: MANIFEST, plan: PLAN });
    expect(order).toEqual(['save', 'delete job-1', 'flush']);
  });

  it('deletes no job record when the save fails', async () => {
    const order: string[] = [];
    const lib: Partial<RemovalLib> = {
      removeItems: () => Promise.reject(new Error('manifest.json could not be saved')),
    };
    const r = await removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, deps(lib, order));
    expect(r).toEqual({ ok: false, error: 'manifest.json could not be saved' });
    expect(order).toEqual([]);
  });

  it('keeps going when a job record cannot be deleted, and logs it', async () => {
    const order: string[] = [];
    const lib: Partial<RemovalLib> = {
      removeItems: () => Promise.resolve({ manifest: MANIFEST, plan: PLAN, trash: 'x' }),
    };
    const d = deps(lib, order);
    d.deleteJob = () => {
      throw new Error('index locked');
    };
    expect((await removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, d)).ok).toBe(true);
    expect(order.some((l) => l.startsWith('log ') && l.includes('job-1'))).toBe(true);
  });

  it('refuses a package and a project that is not open', async () => {
    const pkg = deps({}, [], { pkg: true });
    expect(await removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, pkg)).toEqual({
      ok: false,
      error: PACKAGE_REFUSAL,
    });
    const plan = await removalPlanAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, pkg);
    expect(plan.ok && plan.plan.refused).toBe(PACKAGE_REFUSAL);
    expect(await trashAnswer({ projectId: 'p' }, pkg)).toEqual({ bytes: 0, entries: 0 });
    expect(await emptyTrashAnswer({ projectId: 'p' }, pkg)).toEqual({
      ok: false,
      error: PACKAGE_REFUSAL,
    });
    expect(
      (await removeAnswer({ projectId: 'closed', targets: [{ run: 'r1' }] }, deps({}))).ok,
    ).toBe(false);
  });

  it('sizes and empties the trash', async () => {
    const lib: Partial<RemovalLib> = {
      trashSize: () => Promise.resolve({ bytes: 2048, entries: 2 }),
      emptyTrash: () => Promise.resolve({ freed: 1024, removed: ['a'], held: ['b'] }),
    };
    expect(await trashAnswer({ projectId: 'p' }, deps(lib))).toEqual({ bytes: 2048, entries: 2 });
    expect(await emptyTrashAnswer({ projectId: 'p' }, deps(lib))).toEqual({
      ok: true,
      freed: 1024,
      held: 1,
    });
  });

  it('names the journaled files a removal changed', () => {
    expect(
      journaledRemovals({
        ...emptyRemovalPlan(),
        tilesets: ['t'],
        changes: [{ id: 'chg-1', name: 'x', why: 'asked' }],
        detections: ['detections/pass-1.json'],
      }),
    ).toEqual(['manifest.json', 'tilesets.json', 'change/chg-1.json', 'detections/pass-1.json']);
    expect(journaledRemovals(emptyRemovalPlan())).toEqual(['manifest.json']);
  });
});
```

`layerRefs.test.ts` (spec gap 2: the two file lists must agree):

```ts
import { layerRefs } from '@aio/project/builder';
import type { Layer } from '@aio/schema';
import { layerFiles } from '@aio/sync';
import { describe, expect, it } from 'vitest';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const lens = { model: 'pinhole' as const, hfovDeg: 70, aspect: 1.5 };
const LAYERS: Layer[] = [
  {
    kind: 'mesh',
    id: 'm',
    name: 'm',
    visible: true,
    src: { path: 'models/m.glb' },
    transform: IDENTITY,
  },
  {
    kind: 'pointcloud',
    id: 'pc',
    name: 'pc',
    visible: true,
    src: { path: 'clouds/pc.copc.laz' },
    format: 'copc',
  },
  {
    kind: 'raster',
    id: 'r',
    name: 'r',
    visible: true,
    src: { path: 'rasters/r/tiles.json' },
    role: 'ortho',
    format: 'kit-pyramid',
  },
  {
    kind: 'vector',
    id: 'v',
    name: 'v',
    visible: true,
    src: { path: 'vectors/v.geojson' },
    format: 'geojson',
  },
  {
    kind: 'video',
    id: 'c',
    name: 'c',
    visible: true,
    src: { path: 'video/c.mp4' },
    poster: { path: 'video/c.jpg' },
    flight: { src: { path: 'flights/c.json' }, startUtcMs: 0 },
    lens,
    offsetMs: 0,
  },
  {
    kind: 'walk',
    id: 'walk-w',
    name: 'w',
    visible: true,
    record: { path: 'walks/w/walk.json' },
    src: { path: 'walks/w/playback.mp4' },
    poster: { path: 'walks/w/poster.jpg' },
    durationS: 10,
  },
  {
    kind: 'photos',
    id: 'ph',
    name: 'ph',
    visible: true,
    items: [
      { id: 'a', src: { path: 'photos/a.jpg' } },
      { id: 'b', src: { hash: 'b'.repeat(64) } },
    ],
  },
  {
    kind: 'panoramas',
    id: 'pa',
    name: 'pa',
    visible: true,
    items: [{ id: 'x', src: { path: 'panos/x.jpg' }, pos: [0, 0, 0], headingDeg: 0 }],
  },
];

describe('layerRefs agrees with layerFiles (@aio/sync)', () => {
  for (const layer of LAYERS)
    it(`for a ${layer.kind} layer`, () => {
      const sync = layerFiles({ layers: [layer] })
        .filter((f) => f.sha256 === undefined)
        .map((f) => f.path)
        .sort();
      expect([...layerRefs(layer)].sort()).toEqual(sync);
    });
});
```

In `journal.test.ts` add `'builder:remove'` to the `writers` list.

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/desktop test -- removal layerRefs journal`
- [ ] **Step 3: Implement** `removal.ts`:

```ts
/**
 * Removing datasets, runs and survey dates (delete and start over, 13 Oct 2026): the four
 * `builder:` removal channels. The plan and the removal are `@aio/project/builder`'s; main adds
 * the package refusal, hands in this project's jobs (the live-job refusal and the job folders of a
 * removed run), and forgets the job records of removed runs once the manifest is saved (they
 * cannot come back from the trash; the job folders can). The journal records the files the plan
 * names (`journaledRemovals`, used by `journal.ts`).
 */
import type * as Builder from '@aio/project/builder';
import type { PlanJob } from '@aio/project/builder';
import {
  emptyRemovalPlan,
  type IpcRequest,
  type IpcResponse,
  type JobRecord,
  type RemovalPlan,
} from '@aio/schema';
import { samePath } from './libraryActions';

export type RemovalLib = Pick<
  typeof Builder,
  'planRemoval' | 'removeItems' | 'trashSize' | 'emptyTrash'
>;

export interface RemovalDeps {
  root: (projectId: string) => string | undefined;
  isPackage: (projectId: string) => boolean;
  jobs: () => readonly JobRecord[];
  deleteJob: (id: string) => boolean;
  flushJobs: () => Promise<void>;
  log: (line: string) => void;
  lib?: () => Promise<RemovalLib>;
}

export const PACKAGE_REFUSAL =
  'This project is a read-only package. Nothing can be added or changed.';
/** The builder library loads on first use (a static import empties the main bundle, as in builder.ts). */
const load = (d: RemovalDeps): Promise<RemovalLib> =>
  (d.lib ?? (() => import('@aio/project/builder')))();
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
const notOpen = (id: string) => `Project "${id}" is not open. Open it, then try again.`;

export function planJobsFor(root: string, all: readonly JobRecord[]): PlanJob[] {
  return all
    .filter((j) => samePath(j.project, root))
    .map((j) => ({ id: j.id, pipeline: j.pipeline, status: j.status, params: j.params }));
}

export async function removalPlanAnswer(
  req: IpcRequest<'builder:removePlan'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:removePlan'>> {
  if (d.isPackage(req.projectId))
    return { ok: true, plan: { ...emptyRemovalPlan(), refused: PACKAGE_REFUSAL } };
  const root = d.root(req.projectId);
  if (root === undefined) return { ok: false, error: notOpen(req.projectId) };
  try {
    const lib = await load(d);
    return {
      ok: true,
      plan: await lib.planRemoval(root, req.targets, { jobs: planJobsFor(root, d.jobs()) }),
    };
  } catch (e) {
    return { ok: false, error: text(e) };
  }
}

export async function removeAnswer(
  req: IpcRequest<'builder:remove'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:remove'>> {
  if (d.isPackage(req.projectId)) return { ok: false, error: PACKAGE_REFUSAL };
  const root = d.root(req.projectId);
  if (root === undefined) return { ok: false, error: notOpen(req.projectId) };
  let done: Awaited<ReturnType<RemovalLib['removeItems']>>;
  try {
    const lib = await load(d);
    done = await lib.removeItems(root, req.targets, undefined, {
      jobs: planJobsFor(root, d.jobs()),
    });
  } catch (e) {
    return { ok: false, error: text(e) };
  }
  // after the save only: a record cannot come back from the trash
  for (const id of done.plan.jobs) {
    try {
      d.deleteJob(id);
    } catch (e) {
      d.log(
        `Removal: the job record ${id} was not deleted (${text(e)}); it shows as a job whose run no longer exists.`,
      );
    }
  }
  await d.flushJobs().catch((e: unknown) => {
    d.log(`Removal: the job index was not written (${text(e)}).`);
  });
  return { ok: true, manifest: done.manifest, plan: done.plan };
}

export async function trashAnswer(
  req: IpcRequest<'builder:trash'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:trash'>> {
  const root = d.isPackage(req.projectId) ? undefined : d.root(req.projectId);
  if (root === undefined) return { bytes: 0, entries: 0 };
  try {
    return await (await load(d)).trashSize(root);
  } catch {
    return { bytes: 0, entries: 0 };
  }
}

export async function emptyTrashAnswer(
  req: IpcRequest<'builder:emptyTrash'>,
  d: RemovalDeps,
): Promise<IpcResponse<'builder:emptyTrash'>> {
  if (d.isPackage(req.projectId)) return { ok: false, error: PACKAGE_REFUSAL };
  const root = d.root(req.projectId);
  if (root === undefined) return { ok: false, error: notOpen(req.projectId) };
  try {
    const r = await (await load(d)).emptyTrash(root);
    return { ok: true, freed: r.freed, held: r.held.length };
  } catch (e) {
    return { ok: false, error: text(e) };
  }
}

export function journaledRemovals(plan: RemovalPlan): string[] {
  return [
    'manifest.json',
    ...(plan.tilesets.length > 0 ? ['tilesets.json'] : []),
    ...plan.changes.map((c) => `change/${c.id}.json`),
    ...plan.detections,
  ];
}
```

In `main/index.ts`, after the `walks:remove` handler:

```ts
// Delete datasets, runs and survey dates to the project trash (delete and start over)
const removalDeps: RemovalDeps = {
  root: (id) => registry.root(id),
  isPackage: (id) => registry.package(id) !== undefined,
  jobs: () => jobStore.all(),
  deleteJob: (id) => jobStore.delete(id),
  flushJobs: () => jobStore.flush(),
  log: (line) => {
    appLog.write('warn', [line]);
  },
};
handle('builder:removePlan', (req) => removalPlanAnswer(req, removalDeps));
handle('builder:remove', (req) => removeAnswer(req, removalDeps));
handle('builder:trash', (req) => trashAnswer(req, removalDeps));
handle('builder:emptyTrash', (req) => emptyTrashAnswer(req, removalDeps));
```

(import `removalPlanAnswer`, `removeAnswer`, `trashAnswer`, `emptyTrashAnswer`, `RemovalDeps` from
`./removal`; `walks:remove` stays as it is and now runs through `removeItems` inside `removeWalk`.)

In `journal.ts`, before the `builder:updateLayers` branch:

```ts
if (channel === 'builder:remove') {
  // the removal moved files and rewrote side files: record each journaled one it names
  return async (req) => {
    const r = (await handler(req)) as IpcResponse<'builder:remove'>;
    const { projectId } = req as IpcRequest<'builder:remove'>;
    const root = deps.projects.root(projectId);
    if (r.ok && root !== undefined && !deps.projects.package(projectId)) {
      try {
        const st = await load(root);
        if (st.meta.journal === 'on')
          await serial(st, () => reconcile(st, journaledRemovals(r.plan), undefined));
      } catch (e) {
        console.warn(`Journal: could not record builder:remove in ${root} (${String(e)}).`);
      }
    }
    return r as IpcResponse<C>;
  };
}
```

(import `journaledRemovals` from `./removal`; `removal.ts` imports the builder library lazily, so
the journal module stays light. Add `builder:remove` to the header comment's list.) If the
wrapper's return type does not accept `IpcResponse<C>` as written, follow the cast the
`tilesets:import` branch uses.

In `photogrammetry.ts`, `photo:readRun`, before the final return:

```ts
const source = r.run.photos.source;
const missingFolders =
  'folders' in source
    ? (
        await Promise.all(
          source.folders.map(async (f) =>
            (await stat(f).then(
              (s) => s.isDirectory(),
              () => false,
            ))
              ? null
              : f,
          ),
        )
      ).filter((f): f is string => f !== null)
    : [];
return {
  ok: true,
  run: r.run,
  accuracy,
  ...(missingFolders.length > 0 ? { missingFolders } : {}),
};
```

- [ ] **Step 4: Run** the desktop tests above, then `pnpm --filter @aio/desktop test` (whole
      main suite: `journal.test.ts`, `builder.test.ts`, `project.test.ts` must stay green),
      `pnpm typecheck`, `pnpm lint`. Expect PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/removal.ts apps/desktop/src/main/removal.test.ts apps/desktop/src/main/layerRefs.test.ts apps/desktop/src/main/index.ts apps/desktop/src/main/journal.ts apps/desktop/src/main/journal.test.ts apps/desktop/src/main/photogrammetry.ts
git commit -m "feat(desktop): removal channels, job records after the save, journal of removed files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: The confirm dialog and every new string (`@aio/ui`)

**Before you start:** load the `impeccable` and `frontend-design` skills. The dialog follows the
project delete dialog (`apps/desktop/src/renderer/screens/ProjectMenu.tsx`, `DeleteDialog`): same
`dlg-scrim` / `dlg` / `dlg-h` / `dlg-b` / `dlg-f` classes, `alertdialog`, Cancel focused first.

**Files:**

- Create: `packages/ui/src/tree/removeText.ts`, `packages/ui/src/tree/removeText.test.ts`
- Create: `packages/ui/src/tree/RemoveDialog.tsx`, `packages/ui/src/tree/RemoveDialog.test.tsx`
- Modify: `packages/ui/src/index.ts` (export both)
- Modify: `packages/ui/src/i18n/en.ts` (all keys below, in one block after the `tree.` keys; the
  `library.menu.emptyTrash` key beside `library.menu.delete`, line 228; the `card.` keys beside
  `card.noPhoto`)

**Packages:** `@aio/ui`.

**Interfaces:**

- Consumes: `RemovalPlan`, `RemoveTarget` (T1); `useT`, `t` (`../i18n`), `useFocusTrap`
  (`../focus`), `formatBytes` (`../format`), `Icon`.
- Produces:

```ts
// removeText.ts
export interface RemoveTextOptions {
  /** A survey date in words ("12 Oct 2026"). */
  dateLabel: (captureId: string) => string;
  /** "2.3 GB". Default `formatBytes`. */
  size?: (bytes: number) => string;
}
export interface RemoveText {
  title: string;
  asked: string[];
  also: string[];
  keeps: string[];
  space: string | null;
  note: string;
  refused: string | null;
}
export function removeText(
  targets: readonly RemoveTarget[],
  plan: RemovalPlan,
  t: (key: MessageKey, vars?: Vars) => string,
  o: RemoveTextOptions,
): RemoveText;

// RemoveDialog.tsx
export interface RemoveDialogProps {
  targets: readonly RemoveTarget[];
  /** null while the plan is being worked out. */
  plan: RemovalPlan | null;
  busy: boolean;
  /** Why the last Delete did not go through. */
  error: string | null;
  dateLabel: (captureId: string) => string;
  onCancel: () => void;
  onConfirm: () => void;
  returnTo?: () => HTMLElement | null;
}
export function RemoveDialog(props: RemoveDialogProps): JSX.Element;
```

The English strings (exact; no dashes; `_one` / `_other` are plural forms):

```ts
  // delete datasets, runs and survey dates (delete and start over)
  'remove.title.one': 'Delete {name}?',
  'remove.title.many_one': 'Delete {count} dataset?',
  'remove.title.many_other': 'Delete {count} datasets?',
  'remove.title.run': 'Delete run {run}?',
  'remove.title.date': 'Delete everything from {date}?',
  'remove.asked': 'Deletes:',
  'remove.also': 'Also removes:',
  'remove.keeps': 'Keeps:',
  'remove.line.run': 'Run {run}',
  'remove.line.more': 'and {count} more',
  'remove.line.filed_one': '{count} dataset filed under this date',
  'remove.line.filed_other': '{count} datasets filed under this date',
  'remove.line.runWith_one': 'Run {run} and its {count} map layer',
  'remove.line.runWith_other': 'Run {run} and its {count} map layers',
  'remove.line.runLayers_one': '{count} map layer made by run {run}',
  'remove.line.runLayers_other': '{count} map layers made by run {run}',
  'remove.line.layers_one': '{count} dataset made from them',
  'remove.line.layers_other': '{count} datasets made from them',
  'remove.line.changes_one': '{count} comparison ({names})',
  'remove.line.changes_other': '{count} comparisons ({names})',
  'remove.line.surfaces_one': '{count} prepared surface',
  'remove.line.surfaces_other': '{count} prepared surfaces',
  'remove.line.tilesets_one': '{count} 3D tileset',
  'remove.line.tilesets_other': '{count} 3D tilesets',
  'remove.line.detections_one': '{count} detection pass',
  'remove.line.detections_other': '{count} detection passes',
  'remove.line.jobs_one': '{count} job folder',
  'remove.line.jobs_other': '{count} job folders',
  'remove.line.dates_one': 'The survey date {dates}',
  'remove.line.dates_other': 'The survey dates {dates}',
  'remove.keep.issues_one': "{count} issue will show 'Dataset removed'",
  'remove.keep.issues_other': "{count} issues will show 'Dataset removed'",
  'remove.keep.pins_one': '{count} walk pin loses its drawing',
  'remove.keep.pins_other': '{count} walk pins lose their drawing',
  'remove.keep.date.volume': 'The survey date {date} stays: a volume uses it',
  'remove.keep.date.qa': 'The survey date {date} stays: its survey check uses it',
  'remove.keep.date.measurement': 'The survey date {date} stays: a survey measurement uses it',
  'remove.keep.originals': 'Your original photos are not touched.',
  'remove.space': 'Space freed: {size}, for good when the project trash is emptied',
  'remove.note': 'Everything goes to the project trash and is deleted for good after seven days.',
  'remove.loading': 'Working out what goes with it',
  'remove.refusedTitle': 'This cannot be deleted now',
  'remove.failed': 'Nothing was deleted.',
  'remove.cancel': 'Cancel',
  'remove.confirm': 'Delete',
  'remove.busy': 'Deleting',
  'remove.close': 'Close',
  'tree.delete': 'Delete…',
  'tree.marked': '{count} selected',
  'tree.marked.clear': 'Clear selection',
  'tree.trash': 'Trash {size}',
  'tree.trash.empty': 'Empty',
  'trash.confirm.title': 'Delete the project trash for good?',
  'trash.confirm.text_one': '{size}, {count} removal. This cannot be undone.',
  'trash.confirm.text_other': '{size}, {count} removals. This cannot be undone.',
  'trash.confirm.yes': 'Delete for good',
  'trash.confirm.busy': 'Deleting',
  'trash.emptied': 'The project trash is empty. {size} freed.',
  'trash.none': 'The project trash is empty.',
  'trash.held_one': '{count} removal could not be deleted yet: something still uses it. Try again later.',
  'trash.held_other': '{count} removals could not be deleted yet: something still uses them. Try again later.',
  'library.menu.emptyTrash': 'Empty project trash',
  'card.datasetRemoved': 'Dataset removed',
  'card.datasetRemoved.tip': 'The dataset this issue was seen on was deleted. The issue keeps its text, position and photos.',
```

- [ ] **Step 1: Write the failing tests.** `removeText.test.ts`:

```ts
import { emptyRemovalPlan, type RemovalPlan } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { removeText } from './removeText';

const o = {
  dateLabel: (id: string) => ({ c1: '12 Oct 2026', c3: '2 Nov 2026' })[id] ?? id,
  size: () => '2.3 GB',
};
const plan = (p: Partial<RemovalPlan>): RemovalPlan => ({ ...emptyRemovalPlan(), ...p });

describe('removeText', () => {
  it('a photos layer: its run and map layers, the comparison, jobs, kept issues and originals', () => {
    const x = removeText(
      [{ layer: 'photos-a' }],
      plan({
        layers: [
          { id: 'photos-a', name: 'Flight A', kind: 'photos', why: 'asked' },
          { id: 'r3-ortho', name: 'Ortho', kind: 'raster', why: { madeBy: 'r3' } },
          { id: 'r3-dsm', name: 'DSM', kind: 'raster', why: { madeBy: 'r3' } },
          { id: 'heat', name: 'Heat', kind: 'raster', why: { madeBy: 'chg-1' } },
        ],
        runs: [{ id: 'r3', status: 'failed', why: { usedBy: 'photos-a' } }],
        changes: [{ id: 'chg-1', name: '12 Oct to 26 Oct', why: { usedBy: 'r3-dsm' } }],
        jobs: ['j1', 'j2'],
        touches: { issues: 2, walkPins: 0 },
        keptOutside: ['C:/Photos'],
        bytes: 2_400_000_000,
      }),
      t,
      o,
    );
    expect(x.title).toBe('Delete Flight A?');
    expect(x.asked).toEqual(['Flight A']);
    expect(x.also).toEqual([
      'Run r3 and its 2 map layers',
      '1 dataset made from them',
      '1 comparison (12 Oct to 26 Oct)',
      '2 job folders',
    ]);
    expect(x.keeps).toEqual([
      "2 issues will show 'Dataset removed'",
      'Your original photos are not touched.',
    ]);
    expect(x.space).toBe('Space freed: 2.3 GB, for good when the project trash is emptied');
    expect(x.note).toBe(
      'Everything goes to the project trash and is deleted for good after seven days.',
    );
    expect(x.refused).toBeNull();
  });

  it('a run asked for: the title names the run and its layers are counted', () => {
    const x = removeText(
      [{ run: 'r3' }],
      plan({
        runs: [{ id: 'r3', status: 'failed', why: 'asked' }],
        layers: [{ id: 'r3-ortho', name: 'Ortho', kind: 'raster', why: { madeBy: 'r3' } }],
      }),
      t,
      o,
    );
    expect(x.title).toBe('Delete run r3?');
    expect(x.asked).toEqual(['Run r3']);
    expect(x.also).toEqual(['1 map layer made by run r3']);
  });

  it('a date: the title, the filed datasets, and a kept date says why', () => {
    const x = removeText(
      [{ capture: 'c3' }],
      plan({
        layers: [{ id: 'dsm-c', name: 'DSM', kind: 'raster', why: { filedUnder: 'c3' } }],
        keptCaptures: [{ id: 'c3', by: 'volume' }],
      }),
      t,
      o,
    );
    expect(x.title).toBe('Delete everything from 2 Nov 2026?');
    expect(x.asked).toEqual(['1 dataset filed under this date']);
    expect(x.keeps).toEqual(['The survey date 2 Nov 2026 stays: a volume uses it']);
    expect(x.space).toBeNull();
  });

  it('many rows: a counted title and at most eight names', () => {
    const layers = Array.from({ length: 10 }, (_, i) => ({
      id: `v${String(i)}`,
      name: `Clip ${String(i)}`,
      kind: 'video',
      why: 'asked' as const,
    }));
    const x = removeText(
      layers.map((l) => ({ layer: l.id })),
      plan({ layers }),
      t,
      o,
    );
    expect(x.title).toBe('Delete 10 datasets?');
    expect(x.asked).toHaveLength(9);
    expect(x.asked[8]).toBe('and 2 more');
  });

  it('a refused plan carries its reason', () => {
    const x = removeText(
      [{ run: 'r3' }],
      plan({ refused: 'Creating maps for run r3 is still running. Cancel it first.' }),
      t,
      o,
    );
    expect(x.refused).toBe('Creating maps for run r3 is still running. Cancel it first.');
  });
});
```

`RemoveDialog.test.tsx` (jsdom, like `walkRows.test.tsx`):

```tsx
// @vitest-environment jsdom
import { emptyRemovalPlan } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoveDialog, type RemoveDialogProps } from './RemoveDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});
const show = (p: Partial<RemoveDialogProps>) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const props: RemoveDialogProps = {
    targets: [{ run: 'r3' }],
    plan: { ...emptyRemovalPlan(), runs: [{ id: 'r3', status: 'failed', why: 'asked' }] },
    busy: false,
    error: null,
    dateLabel: (id) => id,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...p,
  };
  act(() => root?.render(<RemoveDialog {...props} />));
  return props;
};
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('RemoveDialog', () => {
  it('is an alertdialog with Cancel focused first, and Delete confirms', () => {
    const p = show({});
    expect(q('remove-dialog')?.getAttribute('role')).toBe('alertdialog');
    expect(q('remove-dialog-title')?.textContent).toBe('Delete run r3?');
    expect(document.activeElement).toBe(q('remove-dialog-cancel'));
    act(() => q('remove-dialog-confirm')?.click());
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the loading line and no Delete while the plan is worked out', () => {
    show({ plan: null });
    expect(q('remove-dialog')?.textContent).toContain('Working out what goes with it');
    expect(q('remove-dialog-confirm')).toBeNull();
  });

  it('a refused plan shows its reason and only Close', () => {
    const p = show({
      plan: {
        ...emptyRemovalPlan(),
        refused: 'Creating maps for run r3 is still running. Cancel it first.',
      },
    });
    expect(q('remove-dialog-refused')?.textContent).toContain('still running');
    expect(q('remove-dialog-confirm')).toBeNull();
    act(() => q('remove-dialog-close')?.click());
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows why the last Delete failed', () => {
    show({
      error: 'photos/p1.jpg could not be moved to the project trash (busy). Nothing was removed.',
    });
    expect(q('remove-dialog-error')?.textContent).toContain('Nothing was deleted.');
  });
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/ui test -- removeText RemoveDialog`
- [ ] **Step 3: Implement** `removeText.ts`:

```ts
import type { RemovalPlan, RemoveTarget, RemoveWhy } from '@aio/schema';
import { formatBytes } from '../format';
import type { MessageKey, Vars } from '../i18n';

/*
 * The words of the delete confirm (delete and start over, spec "The confirm dialog"): what was
 * asked for, what goes with it, what is kept, the space and the trash note. Pure, so the dialog
 * and its tests read the same lines.
 */

type T = (key: MessageKey, vars?: Vars) => string;
const SHOWN = 8;
const madeBy = (why: RemoveWhy, id: string) =>
  typeof why === 'object' && 'madeBy' in why && why.madeBy === id;
const KEPT_DATE = {
  volume: 'remove.keep.date.volume',
  qa: 'remove.keep.date.qa',
  measurement: 'remove.keep.date.measurement',
} as const;

export function removeText(
  targets: readonly RemoveTarget[],
  plan: RemovalPlan,
  t: T,
  o: RemoveTextOptions,
): RemoveText {
  const size = o.size ?? formatBytes;
  const first = targets[0];
  const asked = (why: RemoveWhy) => why === 'asked';
  const title =
    targets.length === 1 && first !== undefined && 'capture' in first
      ? t('remove.title.date', { date: o.dateLabel(first.capture) })
      : targets.length === 1 && first !== undefined && 'run' in first
        ? t('remove.title.run', { run: first.run })
        : targets.length === 1 && first !== undefined && 'layer' in first
          ? t('remove.title.one', {
              name: plan.layers.find((l) => l.id === first.layer)?.name ?? first.layer,
            })
          : t('remove.title.many', { count: targets.length });

  const askedLines: string[] = [];
  const filed = plan.layers.filter(
    (l) => typeof l.why === 'object' && 'filedUnder' in l.why,
  ).length;
  if (filed > 0) askedLines.push(t('remove.line.filed', { count: filed }));
  const names = [
    ...plan.layers.filter((l) => asked(l.why)).map((l) => l.name),
    ...plan.runs.filter((r) => asked(r.why)).map((r) => t('remove.line.run', { run: r.id })),
  ];
  askedLines.push(...names.slice(0, SHOWN));
  if (names.length > SHOWN) askedLines.push(t('remove.line.more', { count: names.length - SHOWN }));

  const also: string[] = [];
  const runIds = new Set(plan.runs.map((r) => r.id));
  for (const r of plan.runs) {
    const count = plan.layers.filter((l) => madeBy(l.why, r.id)).length;
    if (!asked(r.why))
      also.push(
        count > 0
          ? t('remove.line.runWith', { run: r.id, count })
          : t('remove.line.run', { run: r.id }),
      );
    else if (count > 0) also.push(t('remove.line.runLayers', { run: r.id, count }));
  }
  const others = plan.layers.filter(
    (l) =>
      !asked(l.why) &&
      !(typeof l.why === 'object' && 'filedUnder' in l.why) &&
      ![...runIds].some((id) => madeBy(l.why, id)),
  ).length;
  if (others > 0) also.push(t('remove.line.layers', { count: others }));
  if (plan.changes.length > 0)
    also.push(
      t('remove.line.changes', {
        count: plan.changes.length,
        names: plan.changes.map((c) => c.name).join(', '),
      }),
    );
  if (plan.surfaces.length > 0)
    also.push(t('remove.line.surfaces', { count: plan.surfaces.length }));
  if (plan.tilesets.length > 0)
    also.push(t('remove.line.tilesets', { count: plan.tilesets.length }));
  if (plan.detections.length > 0)
    also.push(t('remove.line.detections', { count: plan.detections.length }));
  if (plan.jobs.length > 0) also.push(t('remove.line.jobs', { count: plan.jobs.length }));
  const dropped = plan.captures.filter(
    (c) => !targets.some((x) => 'capture' in x && x.capture === c),
  );
  if (dropped.length > 0)
    also.push(
      t('remove.line.dates', { count: dropped.length, dates: dropped.map(o.dateLabel).join(', ') }),
    );

  const keeps: string[] = [];
  if (plan.touches.issues > 0) keeps.push(t('remove.keep.issues', { count: plan.touches.issues }));
  if (plan.touches.walkPins > 0)
    keeps.push(t('remove.keep.pins', { count: plan.touches.walkPins }));
  for (const k of plan.keptCaptures) keeps.push(t(KEPT_DATE[k.by], { date: o.dateLabel(k.id) }));
  if (plan.keptOutside.length > 0) keeps.push(t('remove.keep.originals'));

  return {
    title,
    asked: askedLines,
    also,
    keeps,
    space: plan.bytes > 0 ? t('remove.space', { size: size(plan.bytes) }) : null,
    note: t('remove.note'),
    refused: plan.refused ?? null,
  };
}
```

(Put the `RemoveTextOptions` and `RemoveText` interfaces above it, as in Interfaces. If the i18n
module does not export `Vars` and `MessageKey` types from `../i18n`, import them from where
`useT`'s type comes from; do not widen to `string`.)

`RemoveDialog.tsx`:

```tsx
import type { RemovalPlan, RemoveTarget } from '@aio/schema';
import { useRef } from 'react';
import { useFocusTrap } from '../focus';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import { removeText } from './removeText';

/**
 * The one confirm of every removal (delete and start over, spec "The confirm dialog"): what was
 * asked for, **Also removes**, **Keeps**, the space, the trash note; Cancel has focus first. A
 * refused plan shows its reason and only Close. Rendered by the app's removal host in a portal.
 */
export function RemoveDialog(props: RemoveDialogProps) {
  const { plan, busy, error } = props;
  const t = useT();
  const dlg = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    if (!busy) props.onCancel();
  };
  useFocusTrap(dlg, true, {
    onEscape: cancel,
    initial: () => cancelRef.current,
    ...(props.returnTo ? { returnTo: props.returnTo } : {}),
  });
  const text = plan ? removeText(props.targets, plan, t, { dateLabel: props.dateLabel }) : null;
  const list = (label: string, lines: string[], id: string) =>
    lines.length > 0 && (
      <div data-testid={id}>
        <p className="rm-h">{label}</p>
        <ul className="rm-list">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={dlg}
        className="dlg rm-dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-dialog-title"
        aria-describedby="remove-dialog-note"
        data-testid="remove-dialog"
      >
        <div className="dlg-h">
          <Icon name="trash" size={16} />
          <h2 id="remove-dialog-title" data-testid="remove-dialog-title" dir="auto">
            {text?.title ?? t('remove.loading')}
          </h2>
        </div>
        <div className="dlg-b">
          {!text && <p className="help">{t('remove.loading')}</p>}
          {text?.refused != null && (
            <p className="notice danger" role="alert" data-testid="remove-dialog-refused">
              <Icon name="warn" size={14} />
              <span>
                <b>{t('remove.refusedTitle')}</b> {text.refused}
              </span>
            </p>
          )}
          {text && text.refused === null && (
            <>
              {list(t('remove.asked'), text.asked, 'remove-dialog-asked')}
              {list(t('remove.also'), text.also, 'remove-dialog-also')}
              {list(t('remove.keeps'), text.keeps, 'remove-dialog-keeps')}
              {text.space && (
                <p className="mono small" data-testid="remove-dialog-space">
                  {text.space}
                </p>
              )}
              <p id="remove-dialog-note" className="help">
                {text.note}
              </p>
            </>
          )}
          {error && (
            <p className="notice danger" role="alert" data-testid="remove-dialog-error">
              <Icon name="warn" size={14} />
              <span>
                <b>{t('remove.failed')}</b> {error}
              </span>
            </p>
          )}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          {text?.refused != null ? (
            <button
              ref={cancelRef}
              type="button"
              className="btn"
              onClick={props.onCancel}
              data-testid="remove-dialog-close"
            >
              {t('remove.close')}
            </button>
          ) : (
            <>
              <button
                ref={cancelRef}
                type="button"
                className="btn ghost"
                onClick={cancel}
                disabled={busy}
                data-testid="remove-dialog-cancel"
              >
                {t('remove.cancel')}
              </button>
              {text && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={props.onConfirm}
                  disabled={busy}
                  data-testid="remove-dialog-confirm"
                >
                  <Icon name="trash" size={14} />
                  {busy ? t('remove.busy') : t('remove.confirm')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

`index.ts`: `export { RemoveDialog, type RemoveDialogProps } from './tree/RemoveDialog';` and
`export { removeText, type RemoveText, type RemoveTextOptions } from './tree/removeText';`. Add
the strings to `en.ts`.

- [ ] **Step 4: Design pass.** With `impeccable` loaded, check the dialog at the 1100 x 700 window:
      the lists scroll inside `dlg-b` when long (`max-height` on `.rm-list` is set by the host's CSS,
      Task 10), the danger button is the only red, the title wraps without pushing the icon.
- [ ] **Step 5: Run** `pnpm --filter @aio/ui test` (the i18n test checks the new keys: no dashes,
      plural pairs), `pnpm typecheck`, `pnpm lint`. Expect PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/tree/removeText.ts packages/ui/src/tree/removeText.test.ts packages/ui/src/tree/RemoveDialog.tsx packages/ui/src/tree/RemoveDialog.test.tsx packages/ui/src/index.ts packages/ui/src/i18n/en.ts
git commit -m "feat(ui): the delete confirm, its words and the trash strings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Marks in the tree (multi-select)

**Before you start:** load the `impeccable` and `frontend-design` skills (a marked row must read
differently from the selected row and from a hidden one, in both themes).

**Files:**

- Create: `packages/ui/src/tree/marks.ts`, `packages/ui/src/tree/marks.test.ts`
- Modify: `packages/ui/src/tree/model.ts` (re-export the marks API so `export * from
'./tree/model'` carries it; no change to `packages/ui/src/index.ts`)
- Modify: `packages/ui/src/tree/DatasetTree.tsx` (props after `walkActions`, line 81; the row's
  `onClick` and class, lines 328 to 360; remove the walk row's inline confirm: `removing`
  state line 175, `removeConfirm` lines 253 to 295, its call at line 331)
- Modify: `packages/ui/src/tree/walkRows.test.tsx` (marks; the Remove button now calls
  `onRemove` at once)
- Modify: `packages/ui/src/mission.css` (`.titem.marked` beside `.titem.sel`, line 1028)
- `DateTree.tsx` needs no change: it spreads the shared props into each nested `DatasetTree`
  (line 318); a test pins that.
- Modify: `packages/ui/src/tree/DateTree.test.tsx` (one test)

**Packages:** `@aio/ui`.

**Interfaces:**

- Produces:

```ts
// marks.ts
export interface MarkMods {
  ctrl: boolean;
  shift: boolean;
}
export interface Marks {
  marked: ReadonlySet<string>;
  /** The row Shift ranges from: the last row clicked with Ctrl, or alone. */
  anchor: string | null;
}
export const NO_MARKS: Marks;
/** Marks after a click on layer `id` over the rows in display `order`; a plain click clears. */
export function nextMarks(m: Marks, order: readonly string[], id: string, mods: MarkMods): Marks;

// DatasetTreeProps gains
  /** Layer ids marked for a group action (Delete). */
  marked?: ReadonlySet<string> | undefined;
  /** Ctrl+click or Shift+click on a layer row; without it a modified click selects as before. */
  onMark?: ((item: TreeItem, mods: MarkMods) => void) | undefined;
```

`WalkRowActions.onRemove` keeps its signature; it now opens the shared dialog (Task 11), so the row
has no confirm of its own.

- [ ] **Step 1: Write the failing tests.** `marks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NO_MARKS, nextMarks } from './marks';

const order = ['a', 'b', 'c', 'd', 'e'];
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };
const plain = { ctrl: false, shift: false };

describe('nextMarks', () => {
  it('Ctrl toggles one row and moves the anchor', () => {
    const one = nextMarks(NO_MARKS, order, 'b', ctrl);
    expect([...one.marked]).toEqual(['b']);
    expect(one.anchor).toBe('b');
    expect([...nextMarks(one, order, 'b', ctrl).marked]).toEqual([]);
  });

  it('Shift marks the range in display order from the anchor, either way', () => {
    const from = nextMarks(NO_MARKS, order, 'b', ctrl);
    expect([...nextMarks(from, order, 'd', shift).marked]).toEqual(['b', 'c', 'd']);
    const back = nextMarks(nextMarks(NO_MARKS, order, 'd', ctrl), order, 'a', shift);
    expect([...back.marked].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('Shift without an anchor marks the row alone and anchors there', () => {
    const m = nextMarks(NO_MARKS, order, 'c', shift);
    expect([...m.marked]).toEqual(['c']);
    expect(m.anchor).toBe('c');
  });

  it('a plain click clears the marks', () => {
    const m = nextMarks(nextMarks(NO_MARKS, order, 'a', ctrl), order, 'c', plain);
    expect(m).toEqual(NO_MARKS);
  });
});
```

In `walkRows.test.tsx` (jsdom; its `mount(props)` helper renders the walk group with row
`walk-a` and answers `{ q, click }`), add the marks test there rather than in the server-rendered
`DatasetTree.test.tsx`:

```tsx
it('Ctrl+click and Shift+click mark rows; a plain click selects', () => {
  const marks: [string, boolean, boolean][] = [];
  const selected: string[] = [];
  const { q } = mount({
    marked: new Set(['walk-a']),
    onMark: (it, m) => marks.push([it.id, m.ctrl, m.shift]),
    onSelect: (it) => selected.push(it.id),
  });
  const row = q('[data-testid="tree-row-walk-a"]');
  if (!row) throw new Error('no row');
  expect(row.className).toContain('marked');
  expect(row.getAttribute('aria-selected')).toBe('true');
  act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
  act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
  act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(marks).toEqual([
    ['walk-a', true, false],
    ['walk-a', false, true],
  ]);
  expect(selected).toEqual(['walk-a']);
});
```

and replace `removes only after the inline confirm, and Cancel keeps the walk` with:

```tsx
it('Remove on a walk row calls onRemove at once (the shared dialog asks)', () => {
  const removed: string[] = [];
  const { click, q } = mount({
    walkActions: { onOpen: () => undefined, onRemove: (it) => removed.push(it.id) },
  });
  click('[data-testid="walk-remove-walk-a"]');
  expect(removed).toEqual(['walk-a']);
  expect(q('[data-testid="walk-remove-confirm"]')).toBeNull();
});
```

(If `mount`'s default props do not show the `walk-a` row under an open 360 walks group, pass the
same props the file's other tests pass.)

In `DateTree.test.tsx`, beside its existing render tests (reuse its folders fixture and base
props; `first` is the first layer id of the first folder):

```tsx
it('marks reach the rows inside date folders', () => {
  const first = folders[0]?.layerIds[0] ?? '';
  const html = renderToStaticMarkup(<DateTree {...baseProps} marked={new Set([first])} />);
  expect(html).toMatch(
    new RegExp(`class="titem[^"]* marked[^"]*"[^>]*data-testid="tree-row-${first}"`),
  );
});
```

(Use the file's own names for the folders fixture and base props; the attribute order in the
regular expression follows the row's JSX, class before `data-testid`.)

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/ui test -- marks walkRows DateTree`
- [ ] **Step 3: Implement** `marks.ts`:

```ts
/*
 * Marking Datasets rows for one action (delete and start over, spec "Multi-select"): Ctrl+click
 * toggles a row, Shift+click marks the range from the anchor in display order, a plain click
 * clears the marks (and selects as before). Esc clears too (the caller). Pure, so the tree and
 * the sidebar share it.
 */

export interface MarkMods {
  ctrl: boolean;
  shift: boolean;
}

export interface Marks {
  marked: ReadonlySet<string>;
  anchor: string | null;
}

export const NO_MARKS: Marks = { marked: new Set(), anchor: null };

export function nextMarks(m: Marks, order: readonly string[], id: string, mods: MarkMods): Marks {
  if (mods.shift) {
    const from = m.anchor === null ? -1 : order.indexOf(m.anchor);
    const to = order.indexOf(id);
    if (from < 0 || to < 0) return { marked: new Set([id]), anchor: id };
    const [a, b] = from <= to ? [from, to] : [to, from];
    return { marked: new Set(order.slice(a, b + 1)), anchor: m.anchor };
  }
  if (mods.ctrl) {
    const marked = new Set(m.marked);
    if (marked.has(id)) marked.delete(id);
    else marked.add(id);
    return { marked, anchor: id };
  }
  return NO_MARKS;
}
```

In `model.ts` add `export { NO_MARKS, nextMarks, type MarkMods, type Marks } from './marks';`.

In `DatasetTree.tsx`: the two props; in `row()`:

```tsx
    const marked = it.layerId !== undefined && props.marked?.has(it.layerId) === true;
    // ...
        aria-selected={sel || marked}
        className={`titem${sub ? ' sub' : ''}${sel ? ' sel' : ''}${marked ? ' marked' : ''}${off ? ' hidden' : ''}${walkActs ? ' has-acts' : ''}`}
        onClick={(e) => {
          const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
          if ((mods.ctrl || mods.shift) && props.onMark && it.layerId) {
            e.preventDefault();
            props.onMark(it, mods);
            return;
          }
          props.onSelect(it);
        }}
```

Delete `removing`, `setRemoving`, `removeConfirm` and the `confirm` local; the walk row's Remove
button calls `onRemove(it)` directly; `extra` becomes `props.rowExtra?.(it) ?? null`. Drop the
focus-return refs that only the confirm used (`rowEls` stays if other code uses it; check). Add a
`.titem.marked` rule beside `.titem.sel` in `packages/ui/src/mission.css` (line 1028): the same
accent as `.sel` at a weaker strength (a tinted background, no left bar), so a marked row reads
apart from the selected one and from a hidden one in both themes.

- [ ] **Step 4: Run** `pnpm --filter @aio/ui test`, `pnpm typecheck` (the desktop `Sidebar.tsx`
      still compiles: `walkActions` is unchanged), `pnpm lint`. Expect PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/tree/marks.ts packages/ui/src/tree/marks.test.ts packages/ui/src/tree/model.ts packages/ui/src/tree/DatasetTree.tsx packages/ui/src/tree/walkRows.test.tsx packages/ui/src/tree/DateTree.test.tsx packages/ui/src/mission.css
git commit -m "feat(ui): mark Datasets rows with Ctrl and Shift; the walk row asks through the shared dialog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Start over: the wizard's starting values (model)

**Files:**

- Create: `apps/desktop/src/renderer/photogrammetry/startOver.ts`,
  `apps/desktop/src/renderer/photogrammetry/startOver.test.ts`
- Modify: `apps/desktop/src/renderer/photogrammetry/store.ts` (`PhotoView`, `openWizard`, lines 11,
  51, 77 to 79)
- Modify: `apps/desktop/src/renderer/photogrammetry/store.test.ts` (one test)

**Packages:** desktop renderer (`photogrammetry/`).

**Interfaces:**

- Consumes: `PhotoRun`, `PhotoSource`, `PhotoPreset`, `PhotoProduct`, `Layer` (schema);
  `defaultProducts` (`./estimate`).
- Produces:

```ts
export type Gnss = 'auto' | 'rtk' | 'standard' | 'ignore';
/** What Start over fills the wizard with (spec "Processing drawer"). */
export interface WizardInitial {
  /** null: the photos are gone (`missing` says why); the photos step starts empty. */
  source: PhotoSource | null;
  missing?: string;
  preset: PhotoPreset;
  gnss: Gnss;
  crs?: { epsg: number };
  products: PhotoProduct[];
  capture?: string;
  /** The run this one replaces: it goes to the trash once the new run has started. */
  replaces: string;
}
export function wizardInitialOf(
  run: Pick<PhotoRun, 'id' | 'photos' | 'preset' | 'crs' | 'settings' | 'capture'>,
  layers: readonly Pick<Layer, 'id' | 'kind'>[],
  missingFolders?: readonly string[],
): WizardInitial;
/** After **Start**: remove the replaced run when the start went through; a note when it could not. */
export function replaceAfterStart(
  started: boolean,
  initial: WizardInitial | undefined,
  remove: (run: string) => Promise<string | null>,
): Promise<string | null>;
/** Start over is offered on these statuses only. */
export const START_OVER: ReadonlySet<PhotoRun['status']>;
// store.ts
export type PhotoView = { kind: 'wizard'; initial?: WizardInitial } | { kind: 'run'; run: string; tab: RunTab };
openWizard: (initial?: WizardInitial) => void;
```

- [ ] **Step 1: Write the failing tests** `startOver.test.ts`:

```ts
import type { PhotoRun } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { START_OVER, replaceAfterStart, wizardInitialOf } from './startOver';

type Run = Pick<PhotoRun, 'id' | 'photos' | 'preset' | 'crs' | 'settings' | 'capture'>;
const run = (p: Partial<Run> = {}): Run => ({
  id: '20261012-0930',
  photos: { source: { layer: 'photos-a' }, count: 120 },
  preset: 'high',
  crs: { epsg: 32640 },
  settings: {
    run: '20261012-0930',
    preset: 'high',
    gnss: 'rtk',
    crs: { epsg: 32640 },
    products: { products: ['ortho', 'dsm'] },
  },
  capture: 'c1',
  ...p,
});
const layers = [{ id: 'photos-a', kind: 'photos' as const }];

describe('wizardInitialOf', () => {
  it('takes the photos, preset, GNSS, coordinate system, products and date of the run', () => {
    expect(wizardInitialOf(run(), layers)).toEqual({
      source: { layer: 'photos-a' },
      preset: 'high',
      gnss: 'rtk',
      crs: { epsg: 32640 },
      products: ['ortho', 'dsm'],
      capture: 'c1',
      replaces: '20261012-0930',
    });
  });

  it('a run that failed before its maps: the preset defaults and automatic GNSS', () => {
    const x = wizardInitialOf(run({ settings: { run: 'r' } }), layers);
    expect(x.gnss).toBe('auto');
    expect(x.products.length).toBeGreaterThan(0);
  });

  it('leaves the photos step empty and says why when the photos layer was removed', () => {
    const x = wizardInitialOf(run(), []);
    expect(x.source).toBeNull();
    expect(x.missing).toMatch(/photos of run 20261012-0930 were removed/);
  });

  it('leaves the photos step empty when every folder is gone, and keeps the ones still there', () => {
    const src = { folders: ['C:/A', 'C:/B'] };
    const gone = wizardInitialOf(run({ photos: { source: src, count: 2 } }), layers, [
      'C:/A',
      'C:/B',
    ]);
    expect(gone.source).toBeNull();
    expect(gone.missing).toMatch(/not there any more/);
    const half = wizardInitialOf(run({ photos: { source: src, count: 2 } }), layers, ['C:/A']);
    expect(half.source).toEqual({ folders: ['C:/B'] });
    expect(half.missing).toMatch(/C:\/A/);
  });

  it('is offered on failed and cancelled runs only', () => {
    expect([...START_OVER].sort()).toEqual(['cancelled', 'failed']);
  });
});

describe('replaceAfterStart', () => {
  it('removes nothing when the start was refused or there is nothing to replace', async () => {
    const remove = vi.fn(() => Promise.resolve(null));
    expect(await replaceAfterStart(false, wizardInitialOf(run(), layers), remove)).toBeNull();
    expect(await replaceAfterStart(true, undefined, remove)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes the replaced run once the new one started', async () => {
    const remove = vi.fn(() => Promise.resolve(null));
    expect(await replaceAfterStart(true, wizardInitialOf(run(), layers), remove)).toBeNull();
    expect(remove).toHaveBeenCalledWith('20261012-0930');
  });

  it('a failed removal does not stop the new run: it is a note', async () => {
    const remove = () =>
      Promise.resolve('Creating maps for run 20261012-0930 is still running. Cancel it first.');
    expect(await replaceAfterStart(true, wizardInitialOf(run(), layers), remove)).toBe(
      'Run 20261012-0930 is still there: Creating maps for run 20261012-0930 is still running. Cancel it first.',
    );
  });
});
```

In `store.test.ts`:

```ts
it('opens the wizard with Start over values and closing forgets them', () => {
  const initial = {
    source: { layer: 'p' },
    preset: 'fast' as const,
    gnss: 'auto' as const,
    products: [],
    replaces: 'r1',
  };
  photoUi.getState().openWizard(initial);
  expect(photoUi.getState().view).toEqual({ kind: 'wizard', initial });
  photoUi.getState().close();
  expect(photoUi.getState().view).toBeNull();
  photoUi.getState().openWizard();
  expect(photoUi.getState().view).toEqual({ kind: 'wizard' });
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/desktop test -- startOver photogrammetry/store`
- [ ] **Step 3: Implement** `startOver.ts`:

```ts
import type { Layer, PhotoProduct, PhotoRun, PhotoSource, PhotoPreset } from '@aio/schema';
import { defaultProducts } from './estimate';

/*
 * Start over (delete and start over, spec "Processing drawer"): the process wizard filled in from
 * a failed or cancelled run's `run.json`; the old run goes to the trash only once the new run's
 * first job started (founder decision 3, spec decision 6), and a refused removal is a note, never a
 * stop. English inline, as the rest of the photogrammetry renderer.
 */

export type Gnss = 'auto' | 'rtk' | 'standard' | 'ignore';

export interface WizardInitial {
  source: PhotoSource | null;
  missing?: string;
  preset: PhotoPreset;
  gnss: Gnss;
  crs?: { epsg: number };
  products: PhotoProduct[];
  capture?: string;
  replaces: string;
}

export const START_OVER: ReadonlySet<PhotoRun['status']> = new Set(['failed', 'cancelled']);
const GNSS: ReadonlySet<string> = new Set(['auto', 'rtk', 'standard', 'ignore']);
const PRODUCTS: ReadonlySet<string> = new Set(['cloud', 'dsm', 'dtm', 'ortho', 'mesh', 'tiles']);
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function wizardInitialOf(
  run: Pick<PhotoRun, 'id' | 'photos' | 'preset' | 'crs' | 'settings' | 'capture'>,
  layers: readonly Pick<Layer, 'id' | 'kind'>[],
  missingFolders: readonly string[] = [],
): WizardInitial {
  const s = run.settings ?? {};
  const gnss = typeof s.gnss === 'string' && GNSS.has(s.gnss) ? (s.gnss as Gnss) : 'auto';
  const listed = record(s.products)?.products;
  const products = (Array.isArray(listed) ? (listed as unknown[]) : []).filter(
    (p): p is PhotoProduct => typeof p === 'string' && PRODUCTS.has(p),
  );
  let source: PhotoSource | null = run.photos.source;
  let missing: string | undefined;
  if ('layer' in source) {
    const layer = source.layer;
    if (!layers.some((l) => l.id === layer && l.kind === 'photos')) {
      source = null;
      missing = `The photos of run ${run.id} were removed from the project. Choose the photos again.`;
    }
  } else {
    const gone = source.folders.filter((f) => missingFolders.includes(f));
    const left = source.folders.filter((f) => !missingFolders.includes(f));
    if (left.length === 0) {
      source = null;
      missing = `The photo folders of run ${run.id} are not there any more (${gone.join(', ')}). Choose the photos again.`;
    } else if (gone.length > 0) {
      source = { folders: left };
      missing = `Some photo folders of run ${run.id} are not there any more: ${gone.join(', ')}.`;
    }
  }
  return {
    source,
    ...(missing !== undefined ? { missing } : {}),
    preset: run.preset,
    gnss,
    ...('epsg' in run.crs ? { crs: { epsg: run.crs.epsg } } : {}),
    products: products.length > 0 ? products : defaultProducts(run.preset),
    ...(run.capture !== undefined ? { capture: run.capture } : {}),
    replaces: run.id,
  };
}

export async function replaceAfterStart(
  started: boolean,
  initial: WizardInitial | undefined,
  remove: (run: string) => Promise<string | null>,
): Promise<string | null> {
  if (!started || initial === undefined) return null;
  const error = await remove(initial.replaces);
  return error === null ? null : `Run ${initial.replaces} is still there: ${error}`;
}
```

In `store.ts`: `import type { WizardInitial } from './startOver';`, the `PhotoView` and
`openWizard` signatures above, and:

```ts
  openWizard: (initial) => {
    set({ view: initial ? { kind: 'wizard', initial } : { kind: 'wizard' } });
  },
```

(`defaultProducts` must return `PhotoProduct[]`; if the `{ epsg: 32640 }` literal in the test does
not satisfy `Crs`, pass `crs: { epsg: 32640 } as PhotoRun['crs']`.)

- [ ] **Step 4: Run** the tests again, `pnpm typecheck`. Expect PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/photogrammetry/startOver.ts apps/desktop/src/renderer/photogrammetry/startOver.test.ts apps/desktop/src/renderer/photogrammetry/store.ts apps/desktop/src/renderer/photogrammetry/store.test.ts
git commit -m "feat(desktop): Start over values from a failed run, and the old run only after the start" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: The removal store and its dialog host (renderer)

**Before you start:** load the `impeccable` and `frontend-design` skills (the host owns the
dialog's few layout rules and the Empty trash confirm).

**Files:**

- Create: `apps/desktop/src/renderer/shell/removalModel.ts`,
  `apps/desktop/src/renderer/shell/removalModel.test.ts` (pure store, ports injected)
- Create: `apps/desktop/src/renderer/shell/removal.ts` (the app's instance and its ports)
- Create: `apps/desktop/src/renderer/shell/RemoveHost.tsx`, `apps/desktop/src/renderer/shell/removal.css`
- Modify: `apps/desktop/src/renderer/App.tsx` (`<RemoveHost />` beside `<Lightbox />`, line 431)

**Packages:** desktop renderer.

**Interfaces:**

- Consumes: the four channels (T1), `RemoveDialog`, `formatBytes`, `useT` (T7), `Bridge`
  (`../bridge`), `workspace` (`@aio/workspace`), `walks` (`../walks/walks`), `photoUi`
  (`../photogrammetry/store`), `jobs` (`../shell`), `rasterPacks` (`../workspace/siteTiles`).
- Produces:

```ts
// removalModel.ts
export interface RemovalPorts {
  bridge: Bridge;
  projectId: () => string | null;
  /** Let go of the layers before their files move: hide, deselect, close a walk's 360 pane. */
  release: (layerIds: readonly string[]) => Promise<void>;
  applyManifest: (manifest: ProjectManifest) => void;
  /** After a removal: photo runs, jobs and 3D tiles read again. */
  refresh: (plan: RemovalPlan) => void;
}
export interface RemovalUi {
  targets: RemoveTarget[] | null;
  plan: RemovalPlan | null;
  busy: boolean;
  error: string | null;
  /** The open project's trash; null until read. */
  trash: { bytes: number; entries: number } | null;
  /** Entries the last Empty could not delete. */
  held: number;
  /** Bumped after each removal (panels that list runs read again). */
  removed: number;
  ask: (targets: RemoveTarget[]) => Promise<void>;
  cancel: () => void;
  confirm: () => Promise<boolean>;
  /** Remove without the dialog (Start over's old run): null when done, else why not. */
  removeNow: (targets: RemoveTarget[]) => Promise<string | null>;
  loadTrash: (projectId?: string) => Promise<void>;
  /** null when emptied (held entries are in `held`), else why not. */
  emptyTrash: (projectId?: string) => Promise<string | null>;
}
export function createRemovalStore(p: RemovalPorts): StoreApi<RemovalUi>;
// removal.ts
export const removal: StoreApi<RemovalUi>;
export function useRemoval<T>(selector: (s: RemovalUi) => T): T;
/** Open the confirm for `targets` (every Delete entry point calls this). */
export function askRemove(targets: RemoveTarget[]): void;
// RemoveHost.tsx
export function RemoveHost(): JSX.Element | null;
/** "Delete the project trash for good?" confirm; used by the Datasets footer and the library menu. */
export function EmptyTrashDialog(props: {
  projectId: string;
  onClose: () => void;
  returnTo?: () => HTMLElement | null;
}): JSX.Element;
```

- [ ] **Step 1: Write the failing tests** `removalModel.test.ts`:

```ts
import {
  emptyRemovalPlan,
  type IpcChannel,
  type ProjectManifest,
  type RemovalPlan,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Bridge } from '../bridge';
import { createRemovalStore, type RemovalPorts } from './removalModel';

const PLAN: RemovalPlan = {
  ...emptyRemovalPlan(),
  layers: [{ id: 'clip-1', name: 'Clip 1', kind: 'video', why: 'asked' }],
  files: ['video/clip-1.mp4'],
  bytes: 10,
};
const MANIFEST = { layers: [] } as unknown as ProjectManifest;

function ports(answers: Partial<Record<IpcChannel, unknown>>, log: string[]): RemovalPorts {
  const bridge: Bridge = {
    call: (channel, req) => {
      log.push(`call ${channel} ${JSON.stringify(req)}`);
      const value = answers[channel];
      return Promise.resolve(
        value instanceof Error
          ? { ok: false, error: value.message }
          : { ok: true, value: value as never },
      );
    },
  };
  return {
    bridge,
    projectId: () => 'p',
    release: (ids) => {
      log.push(`release ${ids.join(',')}`);
      return Promise.resolve();
    },
    applyManifest: () => {
      log.push('manifest');
    },
    refresh: () => {
      log.push('refresh');
    },
  };
}

describe('removal store', () => {
  it('asks main for the plan when the dialog opens', async () => {
    const log: string[] = [];
    const s = createRemovalStore(ports({ 'builder:removePlan': { ok: true, plan: PLAN } }, log));
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(s.getState().targets).toEqual([{ layer: 'clip-1' }]);
    expect(s.getState().plan).toEqual(PLAN);
  });

  it('hides, deselects and releases the layers before it asks main', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports(
        {
          'builder:removePlan': { ok: true, plan: PLAN },
          'builder:remove': { ok: true, manifest: MANIFEST, plan: PLAN },
          'builder:trash': { bytes: 10, entries: 1 },
        },
        log,
      ),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(await s.getState().confirm()).toBe(true);
    const at = (prefix: string) => log.findIndex((l) => l.startsWith(prefix));
    expect(at('release clip-1')).toBeGreaterThan(-1);
    expect(at('release clip-1')).toBeLessThan(at('call builder:remove'));
    expect(at('manifest')).toBeGreaterThan(at('call builder:remove'));
    expect(s.getState().targets).toBeNull();
    expect(s.getState().removed).toBe(1);
  });

  it('keeps the dialog open with the reason when main refuses', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports(
        {
          'builder:removePlan': { ok: true, plan: PLAN },
          'builder:remove': { ok: false, error: 'held open' },
        },
        log,
      ),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(await s.getState().confirm()).toBe(false);
    expect(s.getState().error).toBe('held open');
    expect(s.getState().targets).toEqual([{ layer: 'clip-1' }]);
    expect(log).not.toContain('manifest');
  });

  it('a refused plan never calls builder:remove', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports({ 'builder:removePlan': { ok: true, plan: { ...PLAN, refused: 'busy' } } }, log),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(await s.getState().confirm()).toBe(false);
    expect(log.some((l) => l.startsWith('call builder:remove '))).toBe(false);
  });

  it('empties the trash and keeps the held count', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports(
        {
          'builder:emptyTrash': { ok: true, freed: 10, held: 1 },
          'builder:trash': { bytes: 5, entries: 1 },
        },
        log,
      ),
    );
    expect(await s.getState().emptyTrash()).toBeNull();
    expect(s.getState().held).toBe(1);
    expect(s.getState().trash).toEqual({ bytes: 5, entries: 1 });
  });
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/desktop test -- removalModel`
- [ ] **Step 3: Implement** `removalModel.ts`:

```ts
import type { ProjectManifest, RemovalPlan, RemoveTarget } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand';
import type { Bridge, Res } from '../bridge';

/*
 * Every removal of the window goes through here (delete and start over): the Datasets tree, the
 * Processing drawer, Start over and the library's Empty project trash. The dialog opens on a plan
 * from main; Delete lets go of the layers first (a viewer holding a file makes the move wait),
 * then asks main, then applies the saved manifest and reads runs, jobs and tilesets again.
 */

const errorOf = <T extends { ok: boolean; error?: string }>(r: Res<T>): string | null =>
  !r.ok ? r.error : r.value.ok ? null : (r.value.error ?? 'Failed.');

export function createRemovalStore(p: RemovalPorts): StoreApi<RemovalUi> {
  return createStore<RemovalUi>()((set, get) => {
    const run = async (
      targets: RemoveTarget[],
      plan: RemovalPlan | null,
    ): Promise<string | null> => {
      const projectId = p.projectId();
      if (projectId === null) return 'No project is open.';
      if (plan?.refused !== undefined) return plan.refused;
      const layerIds = plan
        ? plan.layers.map((l) => l.id)
        : targets.flatMap((t) => ('layer' in t ? [t.layer] : []));
      await p.release(layerIds);
      const r = await p.bridge.call('builder:remove', { projectId, targets });
      const error = errorOf(r);
      if (error !== null || !r.ok || !r.value.ok) return error ?? 'Failed.';
      p.applyManifest(r.value.manifest);
      p.refresh(r.value.plan);
      set((s) => ({ removed: s.removed + 1 }));
      void get().loadTrash(projectId);
      return null;
    };
    return {
      targets: null,
      plan: null,
      busy: false,
      error: null,
      trash: null,
      held: 0,
      removed: 0,
      ask: async (targets) => {
        const projectId = p.projectId();
        set({ targets, plan: null, busy: false, error: null });
        if (projectId === null) return;
        const r = await p.bridge.call('builder:removePlan', { projectId, targets });
        if (get().targets !== targets) return; // closed or asked again meanwhile
        if (r.ok && r.value.ok) set({ plan: r.value.plan });
        else set({ error: errorOf(r) });
      },
      cancel: () => {
        if (!get().busy) set({ targets: null, plan: null, error: null });
      },
      confirm: async () => {
        const { targets, plan } = get();
        if (targets === null || plan === null || plan.refused !== undefined) return false;
        set({ busy: true, error: null });
        const error = await run(targets, plan);
        if (error !== null) {
          set({ busy: false, error });
          return false;
        }
        set({ targets: null, plan: null, busy: false });
        return true;
      },
      removeNow: (targets) => run(targets, null),
      loadTrash: async (projectId = p.projectId() ?? undefined) => {
        if (projectId === undefined) return;
        const r = await p.bridge.call('builder:trash', { projectId });
        if (r.ok) set({ trash: r.value });
      },
      emptyTrash: async (projectId = p.projectId() ?? undefined) => {
        if (projectId === undefined) return 'No project is open.';
        const r = await p.bridge.call('builder:emptyTrash', { projectId });
        const error = errorOf(r);
        if (error !== null || !r.ok || !r.value.ok) return error ?? 'Failed.';
        set({ held: r.value.held });
        await get().loadTrash(projectId);
        return null;
      },
    };
  });
}
```

(Put the `RemovalPorts` and `RemovalUi` interfaces from Interfaces above it. `builder:trash` has no
`ok` field, so `loadTrash` reads `r.value` directly.)

`removal.ts`:

```ts
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import type { RemoveTarget } from '@aio/schema';
import { photoUi } from '../photogrammetry/store';
import { bridge, jobs } from '../shell';
import { walks } from '../walks/walks';
import { rasterPacks } from '../workspace/siteTiles';
import { createRemovalStore, type RemovalUi } from './removalModel';

/** How long viewers get to let go of a file before it moves (as `removeWalk` waits for the 360 pane). */
const RELEASE_MS = 50;

export const removal = createRemovalStore({
  bridge,
  projectId: () => workspace.getState().project?.id ?? null,
  release: async (ids) => {
    const ws = workspace.getState();
    ws.setLayersVisible(ids, false);
    const sel = ws.selection;
    if (sel && (ids.includes(sel.id) || (sel.layer !== undefined && ids.includes(sel.layer))))
      ws.select(null);
    for (const id of ids) walks.getState().release(id);
    await new Promise((resolve) => setTimeout(resolve, RELEASE_MS));
  },
  applyManifest: (m) => {
    workspace.getState().replaceManifest(m);
  },
  refresh: (plan) => {
    if (plan.runs.length > 0) photoUi.getState().bump();
    if (plan.jobs.length > 0) void jobs.getState().refresh();
    if (plan.tilesets.length > 0) rasterPacks.getState().refresh();
  },
});

export function useRemoval<T>(selector: (s: RemovalUi) => T): T {
  return useStore(removal, selector);
}

export function askRemove(targets: RemoveTarget[]): void {
  void removal.getState().ask(targets);
}
```

(`'../shell'` is `renderer/shell.ts`, as `photogrammetry/PhotoRuns.tsx` imports it. If importing `siteTiles` from
`shell/` makes a cycle that the lint rule `import/no-cycle` reports, move the `rasterPacks` call
behind a `refreshTilesets` callback that `siteTiles.ts` registers, and say so in the commit.)

`RemoveHost.tsx`:

```tsx
import { Icon, RemoveDialog, formatBytes, formatDate, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { removal, useRemoval } from './removal';
import './removal.css';

/** The removal dialog of the window, open while the removal store holds targets. */
export function RemoveHost() {
  const targets = useRemoval((s) => s.targets);
  const plan = useRemoval((s) => s.plan);
  const busy = useRemoval((s) => s.busy);
  const error = useRemoval((s) => s.error);
  const captures = useWorkspace((s) => s.project?.manifest.captures);
  if (targets === null) return null;
  const dateLabel = (id: string) => {
    const c = captures?.find((x) => x.id === id);
    return c ? formatDate(c.date) : id;
  };
  return createPortal(
    <RemoveDialog
      targets={targets}
      plan={plan}
      busy={busy}
      error={error}
      dateLabel={dateLabel}
      onCancel={() => {
        removal.getState().cancel();
      }}
      onConfirm={() => void removal.getState().confirm()}
    />,
    document.body,
  );
}

/** "Delete the project trash for good?": the Datasets footer and the library menu open it. */
export function EmptyTrashDialog({
  projectId,
  onClose,
  returnTo,
}: {
  projectId: string;
  onClose: () => void;
  returnTo?: () => HTMLElement | null;
}) {
  const t = useT();
  const trash = useRemoval((s) => s.trash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dlg = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  /** The library menu can open it on a project whose trash is empty: then it only says so. */
  const nothing = trash !== null && trash.entries === 0;
  const cancel = () => {
    if (!busy) onClose();
  };
  useFocusTrap(dlg, true, {
    onEscape: cancel,
    initial: () => keep.current,
    ...(returnTo ? { returnTo } : {}),
  });
  // the library menu opens it for a project that may not be open: read that project's trash
  useEffect(() => {
    void removal.getState().loadTrash(projectId);
  }, [projectId]);
  const confirm = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void removal
      .getState()
      .emptyTrash(projectId)
      .then((failed) => {
        setBusy(false);
        if (failed === null) onClose();
        else setError(failed);
      });
  };
  return createPortal(
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={dlg}
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="trash-empty-title"
        aria-describedby="trash-empty-text"
        data-testid="trash-empty"
      >
        <div className="dlg-h">
          <Icon name="trash" size={16} />
          <h2 id="trash-empty-title">{t('trash.confirm.title')}</h2>
        </div>
        <div className="dlg-b">
          <p id="trash-empty-text" style={{ margin: 0 }}>
            {nothing
              ? t('trash.none')
              : t('trash.confirm.text', {
                  size: formatBytes(trash?.bytes ?? 0),
                  count: trash?.entries ?? 0,
                })}
          </p>
          {error && (
            <p className="notice danger" role="alert" style={{ margin: 0 }}>
              <Icon name="warn" size={14} />
              <span>{error}</span>
            </p>
          )}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          <button
            ref={keep}
            type="button"
            className="btn ghost"
            onClick={cancel}
            disabled={busy}
            data-testid="trash-empty-cancel"
          >
            {nothing ? t('remove.close') : t('remove.cancel')}
          </button>
          {!nothing && (
            <button
              type="button"
              className="btn danger"
              onClick={confirm}
              disabled={busy}
              data-testid="trash-empty-confirm"
            >
              <Icon name="trash" size={14} />
              {busy ? t('trash.confirm.busy') : t('trash.confirm.yes')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

(If `@aio/ui` does not export `useFocusTrap` or `formatDate` from its index, import them the way
`screens/ProjectMenu.tsx` and `shell/Sidebar.tsx` do.)

`removal.css`: `.rm-dlg .rm-list { max-height: 40vh; overflow: auto; margin: 4px 0 8px; padding-left: 18px; }`,
`.rm-dlg .rm-h { margin: 8px 0 2px; font-weight: 600; }`, and `.tree-foot` (the Datasets footer
line of Task 11: one line, small, padded like `.tree-h`).

`App.tsx`: `import { RemoveHost } from './shell/RemoveHost';` and `<RemoveHost />` after
`<Lightbox />`.

- [ ] **Step 4: Run** `pnpm --filter @aio/desktop test -- removalModel`, `pnpm typecheck`,
      `pnpm lint`. Expect PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/shell/removalModel.ts apps/desktop/src/renderer/shell/removalModel.test.ts apps/desktop/src/renderer/shell/removal.ts apps/desktop/src/renderer/shell/RemoveHost.tsx apps/desktop/src/renderer/shell/removal.css apps/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): one removal store and dialog host for every Delete" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Delete in the Datasets tree: rows, group headers, date folders, marks, footer

**Before you start:** load the `impeccable` and `frontend-design` skills (the "3 selected ·
Delete…" header control and the footer line must fit the 1100 x 700 window and the icon rail).

**Files:**

- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx` (`Datasets`: marks state, `onMark`, the
  marked header control, Delete and Esc keys, the walk row's `onRemove`, the item menu in both
  modes, the trash footer; lines 280 to 610)
- Modify: `apps/desktop/src/renderer/shell/DateMenus.tsx` (`LayerDateMenuProps` gains `onDelete`
  and `dateMoves`; `DateFolderMenuProps` gains `onDelete`; lines 221 to 575)
- Modify: `apps/desktop/src/renderer/walks/walks.ts` (delete `removeWalk` and `RELEASE_MS`, lines
  177 to 199: the dialog and the removal store do it now)
- Modify: `apps/desktop/src/renderer/walks/walks.test.ts` (drop the `removeWalk` tests)
- Modify: `packages/ui/src/i18n/en.ts` (delete `walk.row.confirm`, `walk.row.confirmYes`,
  `walk.row.confirmNo`, line 1939, now unused)
- Create: `apps/desktop/src/renderer/shell/DateMenus.test.tsx` (jsdom) if none exists, else add to
  it

**Packages:** desktop renderer (`shell/`, `walks/`), `@aio/ui` (`en.ts`, key removal only).

**Interfaces:**

- Consumes: `NO_MARKS`, `nextMarks`, `Marks`, `MarkMods`, `treeLayerIds` (T8, `@aio/ui`);
  `askRemove`, `useRemoval`, `removal`, `EmptyTrashDialog` (T10); i18n keys (T7).
- Produces:

```ts
// DateMenus.tsx
export interface LayerDateMenuProps {
  // ...as today, plus:
  /** Delete… at the bottom (an editable project, rows that can be deleted). */
  onDelete?: ((layerIds: string[]) => void) | undefined;
  /** False with survey dates off: no "File under" list, only Compare and Delete. Default true. */
  dateMoves?: boolean | undefined;
}
export interface DateFolderMenuProps {
  // ...as today, plus:
  /** Delete… for the date and everything filed under it (not on Every date). */
  onDelete?: ((capture: string) => void) | undefined;
}
```

- [ ] **Step 1: Write the failing tests** `DateMenus.test.tsx` (if `useCompareContext` needs a
      provider, wrap `mountMenu`'s element in it the way `Sidebar.tsx` renders the menus):

```tsx
// @vitest-environment jsdom
import { EVERY_DATE, type DateFolder } from '@aio/ui';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { DateFolderMenu, LayerDateMenu, type LayerDateMenuProps } from './DateMenus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
const mountMenu = (el: ReactElement) => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(el));
};
const C1 = { id: 'c1', label: 'Survey', date: '2026-10-12' };
const props: LayerDateMenuProps = {
  menu: { x: 10, y: 10, name: 'Clip 1', layerIds: ['clip-1'], from: EVERY_DATE },
  captures: [C1],
  tags: {},
  every: EVERY_DATE,
  canEdit: true,
  onClose: () => undefined,
  onMove: () => undefined,
};
const readOnlyProps: LayerDateMenuProps = { ...props, canEdit: false };
const folder: DateFolder = {
  id: 'c1',
  capture: C1,
  label: '12 Oct 2026',
  groups: [],
  layerIds: [],
};
const folderMenu = (f: DateFolder, onDelete: (capture: string) => void) => (
  <DateFolderMenu
    menu={{ x: 10, y: 10, folder: f, expanded: true, toggle: () => undefined }}
    folder={f}
    tag={undefined}
    focused={false}
    hidden={{}}
    canEdit
    onClose={() => undefined}
    onFocus={() => undefined}
    onSetVisible={() => undefined}
    onRename={() => undefined}
    onStyle={() => undefined}
    onDelete={onDelete}
  />
);

it('a row menu offers Delete… that hands over its layers', () => {
  const deleted: string[][] = [];
  mountMenu(
    <LayerDateMenu
      menu={{ x: 10, y: 10, name: 'Clip 1', layerIds: ['clip-1'], from: EVERY_DATE }}
      captures={[]}
      tags={{}}
      every={EVERY_DATE}
      canEdit
      onClose={() => undefined}
      onMove={() => undefined}
      onDelete={(ids) => deleted.push(ids)}
    />,
  );
  act(() => document.querySelector<HTMLElement>('[data-testid="menu-delete"]')?.click());
  expect(deleted).toEqual([['clip-1']]);
});

it('no Delete… in a read-only project', () => {
  mountMenu(<LayerDateMenu {...readOnlyProps} onDelete={() => undefined} />);
  expect(document.querySelector('[data-testid="menu-delete"]')).toBeNull();
});

it('with dates off the menu has no File under list', () => {
  mountMenu(<LayerDateMenu {...props} dateMoves={false} onDelete={() => undefined} />);
  expect(document.querySelector('[data-testid^="move-to-"]')).toBeNull();
});

it('a date folder offers Delete… for its date, Every date does not', () => {
  const deleted: string[] = [];
  mountMenu(folderMenu(folder, (c) => deleted.push(c)));
  act(() => document.querySelector<HTMLElement>('[data-testid="date-menu-delete"]')?.click());
  expect(deleted).toEqual(['c1']);
  act(() => root?.unmount());
  root = null;
  mountMenu(folderMenu({ ...folder, id: EVERY_DATE, capture: null }, () => undefined));
  expect(document.querySelector('[data-testid="date-menu-delete"]')).toBeNull();
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/desktop test -- DateMenus`
- [ ] **Step 3: Implement the menus.** In `LayerDateMenu`, after the `canEdit &&` block:

```tsx
{
  canEdit && onDelete && (
    <>
      <div className="dmenu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="dmenu-item danger"
        data-testid="menu-delete"
        onClick={() => {
          onClose();
          onDelete(menu.layerIds);
        }}
      >
        <Icon name="trash" size={14} />
        <span>{t('tree.delete')}</span>
      </button>
    </>
  );
}
```

and wrap the "File under" block in `dateMoves !== false &&`. The `empty` check stays
(`!canEdit && !compare`). In `DateFolderMenu`, after the reset item, inside `canEdit`:

```tsx
{
  capture &&
    props.onDelete &&
    item('delete', 'trash', t('tree.delete'), () => {
      props.onDelete?.(capture.id);
    });
}
```

(`item` closes the menu and gives `data-testid="date-menu-delete"`.)

- [ ] **Step 4: Implement the Sidebar.** In `Datasets`:

```tsx
const [marks, setMarks] = useState<Marks>(NO_MARKS);
const removed = useRemoval((s) => s.removed);
const trash = useRemoval((s) => s.trash);
const [emptying, setEmptying] = useState(false);
// display order for Shift ranges: date folders top to bottom, or the plain tree
const order = useMemo(
  () => (datesOn ? folders.flatMap((f) => treeLayerIds(f.groups)) : treeLayerIds(groups)),
  [datesOn, folders, groups],
);
const kinds = useMemo(() => new Map(project.manifest.layers.map((l) => [l.id, l.kind])), [project]);
/** Rows that can be deleted: layers, not retired viewers or basemaps. */
const deletable = (ids: readonly string[]) =>
  ids.filter((id) => {
    const k = kinds.get(id);
    return k !== undefined && k !== 'legacy' && k !== 'basemap';
  });
const askLayers = (ids: readonly string[]) => {
  const ok = deletable(ids);
  if (ok.length > 0) askRemove(ok.map((layer) => ({ layer })));
};
// a removal, a project switch: the marks go
useEffect(() => {
  setMarks(NO_MARKS);
}, [removed, project.id]);
// the footer reads the trash on open (and the store reads it again after each removal)
useEffect(() => {
  void removal.getState().loadTrash(project.id);
}, [project.id]);
const onMark = (it: TreeItem, mods: MarkMods) => {
  const id = it.layerId;
  if (id !== undefined) setMarks((m) => nextMarks(m, order, id, mods));
};
const select = (it: TreeItem) => {
  setMarks(NO_MARKS);
  onSelect(it);
};
```

Pass to both trees: `marked={marks.marked}`, `onMark={canEdit ? onMark : undefined}`,
`onSelect={select}`. In dates-off mode also pass the menus:

```tsx
          onItemMenu={(it, at) => {
            const ids = it.layerId ? [it.layerId] : (it.children ?? []).flatMap((c) => (c.layerId ? [c.layerId] : []));
            if (ids.length > 0) setItemMenu({ ...at, name: it.name, item: it, layerIds: ids, from: EVERY_DATE });
          }}
          onGroupMenu={(g, layerIds, at) => {
            setItemMenu({ ...at, name: g.label, layerIds, from: EVERY_DATE });
          }}
```

and render `LayerDateMenu` whenever `itemMenu` is set (not only with dates on), with
`dateMoves={datesOn}` and
`onDelete={canEdit && deletable(itemMenu.layerIds).length > 0 ? askLayers : undefined}`.
`DateFolderMenu` gets `onDelete={canEdit ? (capture) => { askRemove([{ capture }]); } : undefined}`.

The walk row: `onRemove: canEdit ? (it: TreeItem) => { if (it.layerId) askLayers([it.layerId]); } : undefined`
(and drop the `removeWalk` import).

The header, before `AddSurveyDateButton`, when `canEdit && marks.marked.size > 0`:

```tsx
<button
  type="button"
  className="btn sm ghost tree-marked"
  data-testid="tree-marked-delete"
  onClick={() => {
    askLayers([...marks.marked]);
  }}
>
  {t('tree.marked', { count: marks.marked.size })} · {t('tree.delete')}
</button>
```

Keys, on the `sb-tree` section root:

```tsx
      onKeyDown={(e) => {
        if (e.key === 'Escape' && marks.marked.size > 0) {
          e.stopPropagation();
          setMarks(NO_MARKS);
        } else if (e.key === 'Delete' && canEdit && marks.marked.size > 0) {
          e.preventDefault();
          askLayers([...marks.marked]);
        }
      }}
```

The footer, at the end of the section (hidden in the icon rail and when the trash is empty):

```tsx
{
  canEdit && !collapsed && trash !== null && trash.entries > 0 && (
    <div className="tree-foot sb-hide" data-testid="tree-trash">
      <span className="faint small">{t('tree.trash', { size: formatBytes(trash.bytes) })}</span>
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        className="link-btn small"
        data-testid="tree-trash-empty"
        onClick={() => {
          setEmptying(true);
        }}
      >
        {t('tree.trash.empty')}
      </button>
    </div>
  );
}
{
  emptying && (
    <EmptyTrashDialog
      projectId={project.id}
      onClose={() => {
        setEmptying(false);
      }}
    />
  );
}
```

After a successful empty with `held > 0`, show `t('trash.held', { count: held })` through the
existing `DateNotes` note (`setNote({ text, danger: false })`) — read `held` with
`useRemoval((s) => s.held)` and set the note in an effect when it changes to above zero.

Delete `removeWalk` and `RELEASE_MS` from `walks/walks.ts` and their tests from `walks.test.ts`;
delete the three `walk.row.confirm*` keys from `en.ts`.

- [ ] **Step 5: Run** `pnpm --filter @aio/desktop test -- DateMenus Sidebar walks`,
      `pnpm --filter @aio/ui test`, `pnpm typecheck`, `pnpm lint`. Expect PASS.
- [ ] **Step 6: Look at it.** With the `impeccable` skill: start the app on the demo project
      (`pnpm dev` in the worktree, off-screen is not needed for a manual look, but close it after),
      Ctrl+click three rows, check the header control and the marked rows in the light and dark
      themes and the 1100 x 700 window; right-click a group header and a date folder; open and
      cancel the dialog. Fix what reads badly.
- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/shell/Sidebar.tsx apps/desktop/src/renderer/shell/DateMenus.tsx apps/desktop/src/renderer/shell/DateMenus.test.tsx apps/desktop/src/renderer/walks/walks.ts apps/desktop/src/renderer/walks/walks.test.ts packages/ui/src/i18n/en.ts
git commit -m "feat(desktop): Delete on Datasets rows, groups, date folders and marked rows; the trash footer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: The Processing drawer: Delete run, Start over…

**Before you start:** load the `impeccable` and `frontend-design` skills (two more buttons in a
run row that already has four; the row must still wrap cleanly in the drawer at 1100 x 720).

**Files:**

- Modify: `apps/desktop/src/renderer/photogrammetry/PhotoRuns.tsx` (run row actions, lines 112 to
  205; reload on `removed`)
- Modify: `apps/desktop/src/renderer/photogrammetry/RunPanel.tsx` (Start over… next to Resume,
  lines 405 to 435; the run note)
- Modify: `apps/desktop/src/renderer/photogrammetry/ProcessWizard.tsx` (seeded state lines 137 to
  150, the title line 389, the missing-photos line at the photos step, `go()` lines 296 to 324;
  `Gnss` comes from `./startOver`)
- Modify: `apps/desktop/src/renderer/photogrammetry/actions.ts` (`openStartOver`)
- Modify: `apps/desktop/src/renderer/photogrammetry/store.ts` (`notes` per run)
- Modify: `apps/desktop/src/renderer/photogrammetry/store.test.ts`,
  `apps/desktop/src/renderer/photogrammetry/actions.test.ts`

**Packages:** desktop renderer (`photogrammetry/`).

**Interfaces:**

- Consumes: `WizardInitial`, `wizardInitialOf`, `replaceAfterStart`, `START_OVER` (T9);
  `askRemove`, `removal`, `useRemoval` (T10); `photo:readRun`'s `missingFolders` (T1, T6).
- Produces:

```ts
// actions.ts
/** Start over…: read the run and open the wizard filled in from it; null, or why not. */
export function openStartOver(
  projectId: string,
  run: string,
  layers: readonly Pick<Layer, 'id' | 'kind'>[],
): Promise<string | null>;
// store.ts
  /** A line under a run in its panel (Start over's old run that stayed). */
  notes: Record<string, string>;
  setNote: (run: string, note: string | null) => void;
```

- [ ] **Step 1: Write the failing tests.** In `actions.test.ts` (its `call` is the mocked
      `bridge.call` of `vi.mock('../shell', ...)`; add `openStartOver` to the `./actions` import):

```ts
it('openStartOver reads the run and opens the wizard with its values and missing folders', async () => {
  call.mockResolvedValueOnce({
    ok: true,
    value: {
      ok: true,
      run: {
        schema: 'aio.photo-run/1',
        id: 'r9',
        createdAt: '2026-10-13T07:00:00.000Z',
        status: 'failed',
        preset: 'fast',
        photos: { source: { folders: ['C:/A'] }, count: 3 },
        cameras: [],
        crs: { epsg: 32639 },
        stages: [],
        outputs: { layers: [], tilesets: [], files: [] },
        versions: {},
      },
      accuracy: null,
      missingFolders: ['C:/A'],
    },
  });
  expect(await openStartOver('p', 'r9', [])).toBeNull();
  expect(call).toHaveBeenCalledWith('photo:readRun', { projectId: 'p', run: 'r9' });
  const view = photoUi.getState().view;
  expect(view?.kind === 'wizard' ? view.initial?.replaces : null).toBe('r9');
  expect(view?.kind === 'wizard' ? view.initial?.source : undefined).toBeNull();
});
```

In `store.test.ts`:

```ts
it('keeps a note per run and clears it', () => {
  photoUi.getState().setNote('r1', 'Run r0 is still there: held open');
  expect(photoUi.getState().notes).toEqual({ r1: 'Run r0 is still there: held open' });
  photoUi.getState().setNote('r1', null);
  expect(photoUi.getState().notes).toEqual({});
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/desktop test -- photogrammetry`
- [ ] **Step 3: Implement.** `actions.ts`:

```ts
export async function openStartOver(
  projectId: string,
  run: string,
  layers: readonly Pick<Layer, 'id' | 'kind'>[],
): Promise<string | null> {
  const r = await bridge.call('photo:readRun', { projectId, run });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  photoUi.getState().openWizard(wizardInitialOf(r.value.run, layers, r.value.missingFolders ?? []));
  return null;
}
```

`store.ts`: `notes: {}` and

```ts
  setNote: (run, note) => {
    set((s) => {
      const notes = Object.fromEntries(Object.entries(s.notes).filter(([k]) => k !== run));
      if (note) notes[run] = note;
      return { notes };
    });
  },
```

`PhotoRuns.tsx`, in each run row's `ph-acts`, after **Delete work files** (only `!pkg` and not a
view-only reviewer: `const lookOnly = useAnnotateReadOnly();` and `const canEdit = !pkg && !lookOnly;`):

```tsx
{
  canEdit && START_OVER.has(r.status) && (
    <button
      type="button"
      className="btn sm ghost"
      data-testid={`run-start-over-${r.id}`}
      onClick={() => {
        void openStartOver(project.id, r.id, project.manifest.layers).then(setError);
      }}
    >
      Start over…
    </button>
  );
}
{
  canEdit && (
    <button
      type="button"
      className="btn sm ghost danger"
      data-testid={`run-delete-${r.id}`}
      disabled={liveRuns.has(r.id)}
      title={
        liveRuns.has(r.id) ? `A job of run ${r.id} is still running. Cancel it first.` : undefined
      }
      onClick={() => {
        askRemove([{ run: r.id }]);
      }}
    >
      Delete run
    </button>
  );
}
```

with

```tsx
const removed = useRemoval((s) => s.removed);
const liveKey = useJobs((s) =>
  s.jobs
    .filter(
      (j) =>
        isActive(j) &&
        runOfJob(j) !== null &&
        folderKey(j.project) === folderKey(project?.root ?? ''),
    )
    .map((j) => runOfJob(j))
    .join(','),
);
const liveRuns = useMemo(() => new Set(liveKey.split(',').filter(Boolean)), [liveKey]);
```

and `removed` added to the `photo:runs` effect's dependencies (`[projectId, version, jobsKey, removed]`).
`isActive` comes from `../jobs`.

`RunPanel.tsx`: beside **Resume** (and for a `cancelled` run without a job to resume), when
`data.run` is loaded, `START_OVER.has(data.run.status)` and the project can be edited:

```tsx
<button
  type="button"
  className="btn sm"
  data-testid="run-start-over"
  onClick={() => {
    if (project) void openStartOver(project.id, run, project.manifest.layers).then(setError);
  }}
>
  Start over…
</button>
```

and the note under the header: `{notes[run] && <p className="small" role="status">{notes[run]}</p>}`
(`const notes = usePhotoUi((s) => s.notes);`). Use the panel's own error setter name.

`ProcessWizard.tsx`:

```tsx
// Start over: the values of the run it replaces, read once when the dialog opens
const [start] = useState(() => {
  const v = photoUi.getState().view;
  return v?.kind === 'wizard' ? v.initial : undefined;
});
const src = start?.source ?? null;
const [kind, setKind] = useState<'layer' | 'folders'>(
  src ? ('layer' in src ? 'layer' : 'folders') : layers.length ? 'layer' : 'folders',
);
const [layerId, setLayerId] = useState(
  src && 'layer' in src ? src.layer : start ? '' : (layers[0]?.id ?? ''),
);
const [folders, setFolders] = useState<string[]>(src && 'folders' in src ? src.folders : []);
const [epsg, setEpsg] = useState<number | null>(start?.crs?.epsg ?? projectEpsg);
const [gnss, setGnss] = useState<Gnss>(start?.gnss ?? SIMPLE_DEFAULTS.gnss);
const [preset, setPreset] = useState<PhotoPreset>(start?.preset ?? SIMPLE_DEFAULTS.preset);
const [products, setProducts] = useState<PhotoProduct[]>(
  start?.products ?? defaultProducts(SIMPLE_DEFAULTS.preset),
);
const [dateChoice, setDateChoice] = useState<string | null>(start?.capture ?? null);
```

(`projectEpsg` must be computed above these lines; move its line up.) The title:
`<h2>{start ? `Start run ${start.replaces} over` : TITLE}</h2>`. At the photos step:
`{start?.missing && <p className="small faint" data-testid="start-over-missing">{start.missing}</p>}`.
In `go()`, after the `if (err) { ... return; }` block and before `ui.openRun(run, 'progress')`:

```ts
// the old run goes only now that the new one started (never on Cancel or a refused start)
const note = await replaceAfterStart(true, start, (old) =>
  removal.getState().removeNow([{ run: old }]),
);
if (note) ui.setNote(run, note);
```

Delete the wizard's own `type Gnss` and import it from `./startOver`.

- [ ] **Step 4: Run** `pnpm --filter @aio/desktop test -- photogrammetry`, `pnpm typecheck`,
      `pnpm lint`. Expect PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/photogrammetry/PhotoRuns.tsx apps/desktop/src/renderer/photogrammetry/RunPanel.tsx apps/desktop/src/renderer/photogrammetry/ProcessWizard.tsx apps/desktop/src/renderer/photogrammetry/actions.ts apps/desktop/src/renderer/photogrammetry/actions.test.ts apps/desktop/src/renderer/photogrammetry/store.ts apps/desktop/src/renderer/photogrammetry/store.test.ts
git commit -m "feat(desktop): Delete run and Start over in the Processing drawer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Empty project trash in the library menu; "Dataset removed" on the issue card

**Before you start:** load the `impeccable` skill (one menu item, one card line).

**Files:**

- Modify: `apps/desktop/src/renderer/screens/projectMenuModel.ts` (`ProjectActionId` gains
  `'emptyTrash'`, placed after `reveal`)
- Modify: `apps/desktop/src/renderer/screens/projectMenuModel.test.ts`
- Modify: `apps/desktop/src/renderer/screens/ProjectMenu.tsx` (`ICON`, `LABEL`, `run`, the dialog
  state `'emptyTrash'`, lines 25 to 40 and 440 to 470)
- Modify: `apps/desktop/src/renderer/issueCard/model.ts` (`removedLayersOf`),
  `apps/desktop/src/renderer/issueCard/model.test.ts`
- Modify: `apps/desktop/src/renderer/issueCard/IssueCard.tsx` (`Evidence`, lines 200 to 214)

**Packages:** desktop renderer (`screens/`, `issueCard/`).

**Interfaces:**

- Consumes: `EmptyTrashDialog` (T10); keys `library.menu.emptyTrash`, `card.datasetRemoved`,
  `card.datasetRemoved.tip` (T7).
- Produces: `removedLayersOf(manifest: Pick<ProjectManifest, 'layers'>, issue: Pick<Issue, 'sightings'>): string[]`.

- [ ] **Step 1: Write the failing tests.** `projectMenuModel.test.ts`:

```ts
it('offers Empty project trash after Show in folder for a folder project, not for a package', () => {
  const ids = projectActions(nativeEntry, { dataRoot: DATA, current: false }).map((a) => a.id);
  expect(ids.indexOf('emptyTrash')).toBe(ids.indexOf('reveal') + 1);
  const pkg = projectActions(packageEntry, { dataRoot: DATA, current: false }).find(
    (a) => a.id === 'emptyTrash',
  );
  expect(pkg?.why).toBe('package');
});
```

(`nativeEntry`, `packageEntry` and `DATA` are the file's existing fixtures; use their names.)
`issueCard/model.test.ts`:

```ts
it('names the layers an issue was seen on that the project no longer has', () => {
  const issue = {
    sightings: [
      { on: 'map', layer: 'gone' },
      { on: 'map', layer: 'here' },
      { on: 'map', layer: 'gone' },
    ],
  } as Pick<Issue, 'sightings'>;
  expect(removedLayersOf({ layers: [{ id: 'here' } as Layer] }, issue)).toEqual(['gone']);
  expect(
    removedLayersOf({ layers: [{ id: 'gone' } as Layer, { id: 'here' } as Layer] }, issue),
  ).toEqual([]);
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/desktop test -- projectMenuModel issueCard`
- [ ] **Step 3: Implement.** `projectMenuModel.ts`:

```ts
export type ProjectActionId = 'open' | 'rename' | 'reveal' | 'emptyTrash' | 'export' | 'close' | 'delete';
// in projectActions, after { id: 'reveal' }:
    withWhy('emptyTrash', entry.package ? 'package' : entry.kind !== 'native' ? 'kit' : undefined),
```

`ProjectMenu.tsx`: `ICON.emptyTrash = 'trash'`, `LABEL.emptyTrash = 'library.menu.emptyTrash'`,
the dialog state type `'rename' | 'delete' | 'emptyTrash' | null`, `run('emptyTrash')` sets it, and

```tsx
{
  dialog === 'emptyTrash' && (
    <EmptyTrashDialog
      projectId={entry.id}
      onClose={() => {
        setDialog(null);
      }}
      returnTo={() => more.current}
    />
  );
}
```

(`EmptyTrashDialog` portals itself, reads the project's trash on mount and, for an empty trash,
says so with only Close; Task 10.)

`issueCard/model.ts`:

```ts
/** Layers an issue was seen on that the project no longer has (the dataset was deleted). */
export function removedLayersOf(
  manifest: Pick<ProjectManifest, 'layers'>,
  issue: Pick<Issue, 'sightings'>,
): string[] {
  const ids = new Set(manifest.layers.map((l) => l.id));
  return [...new Set(issue.sightings.map((s) => s.layer).filter((id) => !ids.has(id)))];
}
```

`IssueCard.tsx`, `Evidence`, where it returns the "no photo" line:

```tsx
if (!first && videos.length === 0) {
  return removedLayersOf(project.manifest, issue).length > 0 ? (
    <p
      className="ic-none faint small"
      data-testid="issue-card-removed"
      title={t('card.datasetRemoved.tip')}
    >
      {t('card.datasetRemoved')}
    </p>
  ) : (
    <p className="ic-none faint small">{t('card.noPhoto')}</p>
  );
}
```

- [ ] **Step 4: Run** the tests, `pnpm typecheck`, `pnpm lint`. Expect PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/screens/projectMenuModel.ts apps/desktop/src/renderer/screens/projectMenuModel.test.ts apps/desktop/src/renderer/screens/ProjectMenu.tsx apps/desktop/src/renderer/issueCard/model.ts apps/desktop/src/renderer/issueCard/model.test.ts apps/desktop/src/renderer/issueCard/IssueCard.tsx
git commit -m "feat(desktop): Empty project trash in the library menu; issues show Dataset removed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: End to end, known limits and the guide line

**Files:**

- Create: `apps/desktop/e2e/delete-and-start-over.spec.ts`
- Modify: `apps/desktop/e2e/walk-place.spec.ts` (the remove test, lines 193 to 230)
- Modify: `docs/KNOWN-LIMITS.md` (lines 49 and 106; new lines under "## Builder")
- Modify: `docs/architecture/data-conventions.md` only if Task 1's section 33 needs a correction
  found while testing

**Packages:** desktop e2e, docs.

**Interfaces:** Consumes every test id above: `remove-dialog`, `remove-dialog-title`,
`remove-dialog-also`, `remove-dialog-keeps`, `remove-dialog-confirm`, `remove-dialog-cancel`,
`menu-delete`, `date-menu-delete`, `tree-marked-delete`, `tree-trash`, `tree-trash-empty`,
`trash-empty`, `trash-empty-confirm`, `run-delete-<run>`, `run-start-over-<run>`,
`tree-row-<layer>`, `photo-runs`, `photo-start`, `photo-run`.

The spec, step by step (all synthetic data; the window stays off-screen through the fixtures;
zero network):

- **Fixture** (`test.extend`, written before the app starts, in `dataRoot.projectDir`, the tiny
  project): a photos layer `photos-a` (two 1 x 1 JPEGs from a base64 constant, capture
  `capture-1`); two video layers `clip-1`, `clip-2` sharing `flights/f1.json` (the `aio.flight/1`
  shape and the two-frame MP4 from `video-first.spec.ts`'s `tinyMp4`, copied, not imported); a
  failed run `20261012-0930` (`photogrammetry/<run>/run.json`: `status: 'failed'`,
  `photos.source: { layer: 'photos-a' }`, `preset: 'fast'`, empty `outputs`); a hidden raster
  `20261012-0930-ortho` (`rasters/20261012-0930-ortho/tiles.json`); a job folder
  `jobs/job-0930/job.log`; and `jobs.json` in `dataRoot.userData` with one `failed`
  `photo.align` record `job-0930` whose `project` is the project folder and `params.run` the run.
- **1. Delete the Video group.** Open the project. Right-click the Video group header in Datasets;
  click **Delete…** (`menu-delete`). The dialog title is "Delete 2 datasets?" and it lists Clip 1 and
  Clip 2; **Delete**. Both rows are gone; `.trash/` holds one entry with `video/clip-1.mp4`,
  `video/clip-2.mp4` and `flights/f1.json` and a `removed.json` whose `schema` is `aio.trash/1`.
- **2. Delete the photos layer with its run.** Right-click `tree-row-photos-a`, **Delete…**. The
  dialog's **Also removes** (`remove-dialog-also`) reads "Run 20261012-0930 and its 1 map layer"
  and "1 job folder"; **Delete**. `tree-row-photos-a` and `tree-row-20261012-0930-ortho` are gone;
  the second trash entry holds `photogrammetry/20261012-0930/run.json` and
  `jobs/job-0930/job.log`; `jobs.json` no longer lists `job-0930` (poll the file for up to 5 s).
- **3. Empty the trash.** The footer `tree-trash` reads "Trash … · Empty"; click `tree-trash-empty`;
  the dialog `trash-empty` says "2 removals"; **Delete for good**. The footer is gone and `.trash/`
  is empty.
- **4. Start over, cancelled** (pipeline Python only: `test.skip(!hasPipelinePython(), ...)` as
  `photo-process.spec.ts` does, and its platform check; on the photo fixtures of `photoPack.ts`,
  with a failed run `20261013-0700` written into the photo project before launch:
  `photos.source: { layer: 'photos' }`, `preset: 'fast'`, `settings: { gnss: 'standard' }`). Open
  the photo site, open Processing, click `run-start-over-20261013-0700`. The wizard's title reads
  "Start run 20261013-0700 over" and Fast is chosen. Press Escape. The run is still in
  `photo-runs`, and the project has no `.trash/` folder.
- **5. Start over, started.** Click `run-start-over-20261013-0700` again, then `photo-start`. The new
  run's panel opens (`photo-run`); back in the drawer, `[data-run="20261013-0700"]` is gone and
  `.trash/<stamp>-run-20261013-0700/photogrammetry/20261013-0700/run.json` exists.
- **Also:** at the 1100 x 700 window the dialog's buttons are in view (`toBeInViewport`).

`walk-place.spec.ts`: the remove test clicks the walk row's Remove, then expects `remove-dialog`
with the walk's name in its title, clicks `remove-dialog-confirm`, and keeps its existing checks
that the row is gone and `.trash/<stamp>-<walk id>/` holds the playback file.

- [ ] **Step 1: Write the spec** as above, in the house e2e style (read `video-first.spec.ts` for a
      fixture written before launch, `photo-process.spec.ts` for the photo fixtures, the skip and
      `openProcessing`). Put a header comment saying what it covers and that parts 4 and 5 need the
      pipeline Python.
- [ ] **Step 2: Build the demos and run it the CI way**, from `apps/desktop` (PowerShell):

```powershell
pnpm demo:change --quick
pnpm demo:build --quick
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
npx playwright test e2e/delete-and-start-over.spec.ts e2e/walk-place.spec.ts --workers=1
```

      Expect PASS, and `[e2e] window 1100 x 720 px at display scale 1` in the log. Then
      `--repeat-each=3` on the new spec. Then the at-risk specs, one run at a time:
      `processing-drawer`, `photo-process`, `timeline`, `survey-dates-add`, `library`,
      `project-menu`, `small-window`.

- [ ] **Step 3: Known limits.** In `docs/KNOWN-LIMITS.md`: delete the line "A drawing cannot be
      removed from a project in the app yet…" (line 106; it can now: **Delete…** on its row); in
      line 49 change "A walk cannot be renamed or removed from the app yet (delete its folder under
      `walks` in the project folder)." to "A walk cannot be renamed from the app yet."; and add under
      "## Builder":

```md
- **Deleting datasets and runs.** **Delete…** on a dataset, a group, a survey date or marked rows, and **Delete run** in Processing, move the files to the project trash (`.trash` in the project folder) with everything made from them; they are deleted for good after seven days or with **Empty project trash**. There is no Restore in the app yet: within the seven days, copy the entry's folders back into the project folder and replace `manifest.json` with the entry's `manifest.before.json` (data-conventions section 33).
- **Deleting on a shared project.** Other computers of a hub or Team Server receive a deletion as a change to the project only; their copies of the files stay until a later version cleans them up.
- Single photos cannot be removed from a photos layer; delete the layer and import the photos you want again.
```

- [ ] **Step 4: Run** `pnpm format:check` and
      `node tools/agent/check-public-text.mjs docs/KNOWN-LIMITS.md apps/desktop/e2e/delete-and-start-over.spec.ts`.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/delete-and-start-over.spec.ts apps/desktop/e2e/walk-place.spec.ts docs/KNOWN-LIMITS.md
git commit -m "test(e2e): delete datasets, runs and the trash, and start a failed run over" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Verification and hand-off

**Files:** none new (fix what the checks find, in the task that owns the file).

**Packages:** none.

- [ ] **Step 1:** `pnpm check` in the worktree (lint, format check, typecheck, all unit tests).
      Expect green. Evidence: the summary lines of each part.
- [ ] **Step 2:** The e2e specs of Task 14 once more, the CI way (as in Task 14 Step 2), with the
      demos built: `delete-and-start-over`, `walk-place`, then the at-risk list. Expect green;
      record the window line.
- [ ] **Step 3:** An independent review (a `general-purpose` agent, strongest model, high effort)
      of the whole branch against the spec and this plan's Review Focus: each of the five has its
      test and the test fails without the code it pins (revert the line, run, restore).
- [ ] **Step 4:** `node tools/agent/finish-task.mjs` in the worktree (rebases on `origin/main`,
      runs the checks, scans commit messages for client and site names). Scan the added lines with
      the handover pattern (`apps/desktop/dist/HANDOVER-2026-10-12.md`, section 3).
- [ ] **Step 5:** Write the founder's **How to test** into the closing message (draft below; adjust
      to what was built).

**How to test (draft):**

1. Open a project with a failed **Create maps from photos** run (or start one and press **Stop**).
   Open **Processing** in the title bar: the run row has **Start over…** and **Delete run**.
2. Click **Start over…**. The dialog is titled "Start run <id> over" with the same photos, quality
   and date. Press **Cancel**: the failed run is still in the list.
3. Click **Start over…** again, change a setting, press **Start**. The new run starts; the failed
   run leaves the list and its maps leave Datasets.
4. In **Datasets**, right-click a dataset: **Delete…**. The dialog lists what goes with it (a
   run, its map layers, a comparison) and what stays (issues show "Dataset removed"). Press
   **Delete**: the rows are gone.
5. Ctrl+click two rows and Shift+click a third: the header shows "3 selected · Delete…". Press the
   Delete key: the same dialog for all three. Esc clears the selection.
6. Right-click a survey date folder: **Delete…** removes the date and everything filed under it
   (if a volume uses the date, the dialog says the date stays).
7. At the bottom of Datasets, "Trash 2.3 GB · Empty": click **Empty**, confirm. The line goes, and
   the project folder's `.trash` is empty. The same is in the library: the project's **…** menu,
   **Empty project trash**.
8. An issue seen on a deleted dataset still opens; its card says "Dataset removed".
9. In a package or as a reviewer who may only look, none of the Delete actions are offered.

---

## Self-review against the spec

| Spec item                                                                                                                                                              | Where                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| One remove operation for layers, runs, dates; rollback                                                                                                                 | T3, T5                                    |
| `walks:remove` becomes a case of it; walk tests unchanged                                                                                                              | T5                                        |
| Run's job folders and job records                                                                                                                                      | T3 (folders), T4, T6 (records after save) |
| Trash layout, `removed.json` (`aio.trash/1`), seven days, Empty                                                                                                        | T1, T2, T5, T10, T11, T13                 |
| Dependent table (date, photos layer, run, any layer, change set)                                                                                                       | T3                                        |
| Procedural model and package plan rows                                                                                                                                 | Spec gap 4: nothing to rewrite            |
| Kept: issues ("Dataset removed"), walk pins, measurements                                                                                                              | T3 (counts), T7 (lines), T13 (card)       |
| Refusals: package, reviewer, live job, unknown target                                                                                                                  | T3, T6, T11, T12 (`canEdit`)              |
| Never outside the root; hash assets; shared paths                                                                                                                      | T3, T5 (junction tests)                   |
| Failures table (held file, save fails, way back fails, stale plan, gone files, unreadable run.json, job delete fails, removed photos for Start over, held trash entry) | T5, T3, T6, T9, T2, T11                   |
| IPC four channels, preload, journal                                                                                                                                    | T1, T6                                    |
| Datasets: rows, group headers, date folders, marks, `canEdit`                                                                                                          | T8, T11                                   |
| Walk inline confirm replaced by the dialog                                                                                                                             | T8, T11, T14 (`walk-place.spec.ts`)       |
| Processing drawer: Delete run (disabled while live), Start over…                                                                                                       | T12                                       |
| WizardInitial, wizard seeded, title, Start then remove, note                                                                                                           | T9, T12                                   |
| Confirm dialog text, Cancel first, refused shows Close only                                                                                                            | T7                                        |
| Empty trash in footer and library menu, its confirm text                                                                                                               | T10, T11, T13                             |
| Contract row (Minor), `versions.ts`, data-conventions                                                                                                                  | T1                                        |
| KNOWN-LIMITS (drawing removal now possible; follow-ups)                                                                                                                | T14                                       |
| i18n strings in `packages/ui/src/i18n`                                                                                                                                 | T7 (T11 deletes the three walk keys)      |
| e2e spec and the CI way                                                                                                                                                | T14, T15                                  |
