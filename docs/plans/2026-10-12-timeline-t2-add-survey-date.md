# Timeline T2: add a survey date. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** every flight lands in a project as its own survey date with all its layers filed under
it, a survey date can be added by hand, and older projects can file their recorded datasets once.

**Architecture:** main dates the import (one day per import, every created layer tagged, photos
per date, folders expanded); the renderer edits that date in the import card (with New survey date
and tidy up through one new IPC channel, `builder:removeCapture`), adds dates from a Datasets
popover and runs a one-time filing prompt built on pure helpers in `@aio/workspace`.

**Tech stack:** TypeScript, React 19, zustand, Zod (`@aio/schema`), Vitest, Playwright with
Electron.

**Spec:** `docs/plans/2026-10-12-timeline-t2-add-survey-date-design.md` (read it first; the
"Decisions taken (founder to confirm)" there are assumptions of this plan).

**Worktree:** `E:\Dev\AIO Software\.claude\worktrees\timeline-t2-add-survey-date`, branch
`feat/timeline-t2-add-survey-date`. Never edit the main checkout. Stage by path (no `git add -A`),
no `git stash`, no `--no-verify`. Electron windows stay off-screen (the e2e fixtures do this);
e2e with `--workers=1`.

## Global constraints

- No manifest schema change. The only `@aio/schema` change is the new channel
  `builder:removeCapture` and doc comments on `builder:import` / `builder:altitudePlan`.
- Copy: sentence case, plain verbs, no em dashes, no client, site or person names. Every new string
  goes through `packages/ui/src/i18n/en.ts` (task 7 adds all of them).
- Folder limit: 20,000 files per import (`MAX_FOLDER_FILES = 20_000`).
- Survey date ids and labels come from `captureForDate` (`capture-<date>`, label `Survey`).
- localStorage key for the prompt: `stratlas.datePrompt`; every read and write in try/catch.
- Read-only (package, look-only reviewer): no Add survey date button, no prompt, select disabled.
- UI reuses existing classes: `dmenu` (popover), `.dtree-note` (prompt), `.survey-date` and
  `.input` (import card). New CSS only in `apps/desktop/src/renderer/shell/surveyDates.css`.

## Review focus

1. A flight folder with DJI `.LRF` proxies, `.SRT` files and `Thumbs.db`: only one summary row for
   the left-out files, SRTs still pair with their MP4 (pinned in task 5, `builder.test.ts`).
2. Importing a second flight on a day that already has a date: no second date, photos appended to
   that date's photos layer, not to the project-wide `photos` (task 4).
3. Re-dating twice in the import card (new date, then back to the metadata date): the date the
   import created is removed only when empty, a date that existed before is never removed (task 8).
4. A project with a name-dated layer ("Ortho 2024-11-06") and no `capture`: the prompt leaves it
   alone (task 6).
5. The prompt racing an import: not shown while `builder.importing` is set, and a project switch
   clears it (task 10).

## File map

| File                                                                                                                                                         | Task | Responsibility                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------- |
| `packages/geo/src/clock.ts` (new), `clock.test.ts`, `index.ts`                                                                                               | 1    | `defaultUtcOffsetMin(origin, epsg)`                                    |
| `packages/project/src/builder/folders.ts` (new), `folders.test.ts`, `index.ts`                                                                               | 2    | `expandImportPaths`                                                    |
| `packages/schema/src/ipc.ts`, `packages/schema/src/builder.test.ts`                                                                                          | 3    | `builder:removeCapture` contract, path comments                        |
| `packages/project/src/builder/create.ts`, `manifestFile.test.ts`                                                                                             | 3    | `removeCapture(root, captureId)`                                       |
| `packages/project/src/builder/raw.ts`, `raw.test.ts`                                                                                                         | 4    | one date per import, tagging, photos per date, `isImportableExtension` |
| `apps/desktop/src/main/builder.ts`, `builder.test.ts`, `index.ts`, `journal.ts`, `journal.test.ts`, `apps/desktop/src/preload/index.ts`                      | 5    | folders in import and plan, removeCapture handler, journal             |
| `packages/workspace/src/surveyDays.ts` (new), `surveyDays.test.ts`, `index.ts`                                                                               | 6    | recording days, prompt plan                                            |
| `packages/ui/src/i18n/en.ts`, `packages/ui/src/icons/paths.tsx`                                                                                              | 7    | strings, `calendar-plus` icon                                          |
| `apps/desktop/src/renderer/change/SurveyDate.tsx`, `SurveyDate.test.tsx` (new), `builder/SurveyDate.tsx`, `builder/state.ts`, `builder/state.test.ts`        | 8    | import card select, New survey date, tidy up, `pickAndImportFolder`    |
| `apps/desktop/src/renderer/shell/AddSurveyDate.tsx` (new), `AddSurveyDate.test.tsx`, `surveyDates.css` (new)                                                 | 9    | Add survey date popover                                                |
| `apps/desktop/src/renderer/shell/DatePrompt.tsx` (new), `DatePrompt.test.tsx`, `datePromptPref.ts` (new), `datePromptPref.test.ts`                           | 10   | one-time prompt                                                        |
| `apps/desktop/src/renderer/shell/Sidebar.tsx`, `Palette.tsx`                                                                                                 | 11   | wiring and Ctrl+K commands                                             |
| `apps/desktop/e2e/survey-dates-add.spec.ts` (new)                                                                                                            | 12   | e2e                                                                    |
| `docs/guide/28-survey-dates.md`, `docs/TESTING.md`, `docs/architecture/contract-changes.md`, `docs/architecture/data-conventions.md`, `docs/KNOWN-LIMITS.md` | 13   | docs                                                                   |

## Execution DAG

```
Batch 1 (parallel, no shared files):  T1  T2  T3  T6  T7
Batch 2 (parallel):                   T4 (after T1)  T5 (after T2, T3)  T8 (after T3, T7)  T10 (after T1, T6, T7)
Batch 3:                              T9 (after T7, T8)
Batch 4:                              T11 (after T9, T10)
Batch 5 (parallel):                   T12 (after T4, T5, T11)  T13 (after T11)
```

| Task | Depends on  | Size | Packages                           |
| ---- | ----------- | ---- | ---------------------------------- |
| T1   |             | S    | `@aio/geo`                         |
| T2   |             | S    | `@aio/project`                     |
| T3   |             | S    | `@aio/schema`, `@aio/project`      |
| T4   | T1          | M    | `@aio/project`                     |
| T5   | T2, T3      | M    | desktop main, preload              |
| T6   |             | S    | `@aio/workspace`                   |
| T7   |             | S    | `@aio/ui`                          |
| T8   | T3, T7      | M    | desktop renderer (builder, change) |
| T9   | T7, T8      | M    | desktop renderer (shell)           |
| T10  | T1, T6, T7  | M    | desktop renderer (shell)           |
| T11  | T9, T10     | S    | desktop renderer (shell)           |
| T12  | T4, T5, T11 | M    | desktop e2e                        |
| T13  | T11         | S    | docs                               |

**Critical path:** T3 (or T7) → T8 → T9 → T11 → T12: five batches. T1 → T4 and T2 → T5 run
beside it and finish in batch 2. T8's unit tests mock the bridge, so it does not wait for T5; only
the e2e (T12) needs T5 in.

**Shared-file check:** `raw.ts` only in T4; `create.ts` only in T3; `main/builder.ts` only in T5;
`Sidebar.tsx` and `Palette.tsx` only in T11; `en.ts` and `paths.tsx` only in T7 (later tasks use
the keys, never add them; a missing key is a T7 fix, made by the orchestrating session).

**Heavy runs:** one Playwright run at a time, `--workers=1`. Unit tests per package with
`pnpm --filter <pkg> test -- <file>`.

---

### Task 1: default UTC offset in `@aio/geo`

**Files:** create `packages/geo/src/clock.ts`, `packages/geo/src/clock.test.ts`; modify
`packages/geo/src/index.ts` (export).

**Interfaces:** produces
`defaultUtcOffsetMin(origin: readonly [number, number, number], epsg: number): number` (minutes,
`round(lon / 15) * 60`, 0 when the CRS cannot be read). Used by T4 (replaces `defaultUtcOffset` in
`raw.ts`) and T10.

- [ ] **Step 1: failing test**

```ts
import { describe, expect, it } from 'vitest';
import { defaultUtcOffsetMin } from './clock';
import { fromWgs84 } from './index';

describe('defaultUtcOffsetMin', () => {
  it('rounds the longitude to whole hours', () => {
    expect(defaultUtcOffsetMin(fromWgs84([48.1352, 29.0276, 0], 32639), 32639)).toBe(180);
    expect(defaultUtcOffsetMin(fromWgs84([-73.98, 40.75, 0], 32618), 32618)).toBe(-300);
  });
  it('is 0 for a CRS it cannot read', () => {
    expect(defaultUtcOffsetMin([0, 0, 0], 999999)).toBe(0);
  });
});
```

- [ ] **Step 2:** `pnpm --filter @aio/geo test -- clock` fails (module missing).
- [ ] **Step 3: implement**

```ts
import { toWgs84 } from './index';

/** The clock offset of a project from its longitude: whole hours, in minutes; 0 when unknown. */
export function defaultUtcOffsetMin(
  origin: readonly [number, number, number],
  epsg: number,
): number {
  try {
    const [lon] = toWgs84([origin[0], origin[1], origin[2]], epsg);
    return Number.isFinite(lon) ? Math.round(lon / 15) * 60 : 0;
  } catch {
    return 0;
  }
}
```

If importing `toWgs84` from `./index` makes a cycle, import it from the module that defines it.

- [ ] **Step 4:** test passes; `pnpm --filter @aio/geo typecheck`.
- [ ] **Step 5:** commit `feat(geo): default utc offset of a project origin`.

### Task 2: folder expansion in `@aio/project`

**Files:** create `packages/project/src/builder/folders.ts`, `folders.test.ts`; modify
`packages/project/src/builder/index.ts` (export).

**Interfaces:** produces

```ts
export const MAX_FOLDER_FILES = 20_000;
export interface LeftOut {
  folder: string;
  count: number;
  exts: string[];
}
export interface Expanded {
  files: string[]; // every file to import, given files first in their order, then each folder's files sorted
  leftOut: LeftOut[]; // per folder, files with an extension the import does not know
  tooMany: string | null; // the folder that went over MAX_FOLDER_FILES, else null
}
export async function expandImportPaths(
  paths: readonly string[],
  known: (ext: string) => boolean, // lower-case ext with the dot, e.g. '.jpg'
  limit?: number, // default MAX_FOLDER_FILES
): Promise<Expanded>;
```

Rules: a path that is a file is kept as given (even with an unknown extension: the import reports
it as today). A directory is walked recursively; entries whose name starts with `.` are skipped;
symlinks are not followed (`lstat`); files sorted by full path; a duplicate path (same file given
twice) is kept once. When the running total of folder files passes `limit`, stop and return
`tooMany` with that folder and `files: []`.

- [ ] **Step 1: failing tests** (temp dirs with `mkdtemp`):
  - folder with `a/CLIP_0001.MP4`, `a/CLIP_0001.SRT`, `a/CLIP_0001.LRF`, `a/.hidden/x.jpg`,
    `a/Thumbs.db`, `a/sub/IMG_2.JPG` and `known = (e) => ['.mp4', '.srt', '.jpg'].includes(e)`:
    `files` is the MP4, SRT and `sub/IMG_2.JPG` sorted; `leftOut` is
    `[{ folder: <a>, count: 2, exts: ['.db', '.lrf'] }]`.
  - a given file with an unknown extension is kept in `files`.
  - `limit = 2` with three known files returns `tooMany: <a>`, `files: []`.
  - the same file given directly and inside a given folder appears once.
- [ ] **Step 2:** `pnpm --filter @aio/project test -- folders` fails.
- [ ] **Step 3:** implement with `node:fs/promises` `lstat`/`readdir`; `extname(name).toLowerCase()`.
- [ ] **Step 4:** tests pass.
- [ ] **Step 5:** commit `feat(project): expand folders given to an import`.

### Task 3: `builder:removeCapture` contract and library

**Files:** modify `packages/schema/src/ipc.ts` (new channel after `builder:ensureCapture`; doc
comments of `builder:import` and `builder:altitudePlan` `paths`: "files or folders; a folder is
read recursively"), `packages/schema/src/builder.test.ts`; modify
`packages/project/src/builder/create.ts`, `packages/project/src/builder/index.ts`,
`packages/project/src/builder/manifestFile.test.ts`.

**Interfaces:** produces

```ts
// ipc.ts
/**
 * Remove a survey date that no layer names (`Layer.capture`): only `manifest.captures` changes.
 * Refused while a layer names it, for an unknown id and on a package. Backed up and validated.
 */
'builder:removeCapture': {
  request: z.object({ projectId: z.string().min(1), captureId: z.string().min(1) }).strict(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), manifest: ProjectManifest, backup: z.string() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
},
// create.ts
export async function removeCapture(
  root: string,
  captureId: string,
): Promise<{ manifest: ProjectManifest; backup: string }>;
```

Errors (thrown, turned into `{ ok: false }` by main): unknown id `There is no survey date
"<id>" in this project.`; named `<n> datasets are filed under this date. Move them first.`

- [ ] **Step 1: failing tests**: schema parses a good request and refuses an extra key and an
      empty id (`builder.test.ts`, next to the `builder:ensureCapture` cases); `removeCapture` removes
      an empty date and backs up, refuses a date a layer names (manifest unchanged), refuses an unknown
      id (`manifestFile.test.ts`, next to the `updateCapture` cases).
- [ ] **Step 2:** both test files fail.
- [ ] **Step 3:** implement `removeCapture` with `updateManifestFile` like `updateCapture`; export
      from `builder/index.ts`; add the channel.
- [ ] **Step 4:** `pnpm --filter @aio/schema test` and `pnpm --filter @aio/project test --
manifestFile` pass; `pnpm --filter @aio/schema typecheck`.
- [ ] **Step 5:** commit `feat(schema): builder:removeCapture for an empty survey date`.

### Task 4: one import, one survey date (`raw.ts`)

**Files:** modify `packages/project/src/builder/raw.ts`, `packages/project/src/builder/raw.test.ts`.

**Interfaces:** consumes `defaultUtcOffsetMin` (T1), `captureForDate` (existing). Produces
`export function isImportableExtension(ext: string): boolean` (union of `PHOTO`, `VIDEO`, `MESH`,
`RASTER`, `CLOUD`, `DRAWING`, `DESIGN`, `OPF`, `.srt`, `.mtl`, `.xml`, `.dwg`, `.insv`, `.lrv`, and
`isDrawingFile(ext, false)`), exported from `builder/index.ts` for T5; and
`export function importDay(days: readonly string[]): string | null` (most frequent, tie to the
earlier; `null` for none).

Changes inside `importRawFiles`:

1. Replace `defaultUtcOffset(m)` with `defaultUtcOffsetMin(m.origin, epsg)`; delete the local
   function.
2. Replace the two `addCapture(m, …)` calls with pushes into `const days: string[] = []` (photo:
   `meta.takenAt?.slice(0, 10)`, video: `start.slice(0, 10)`), only for `YYYY-MM-DD` values.
3. Photos go into a per-import list `const newPhotos: PhotoRef[] = []` instead of `photosLayer()`
   during the loop; the item's `layerId` is filled in at the end (keep the row objects in an array
   `photoRows` to patch).
4. Remember the ids of layers this import pushes (`created: Set<string>`), including video, mesh,
   raster rows.
5. After the loop (also after a cancel), `const day = importDay(days)`:
   - `day === null`: photos go to `photosLayer()` as today; nothing is tagged; no date added.
   - else `const c = captureForDate(m, day); m.captures = c.manifest.captures;` every layer in
     `created` gets `capture: c.captureId`; photos go to the photos layer with
     `capture === c.captureId` (append), else a new layer
     `{ kind: 'photos', id: uniqueId(\`photos-${day}\`, layerIdTaken(m)), name: 'Photos',
     visible: true, items: newPhotos, capture: c.captureId }`; patch the photo rows' `layerId`.
6. Photo id uniqueness: `uniqueId` over every photos layer's items in the project plus
   `newPhotos` (photo files go to `photos/<id>.jpg`, one folder for all layers).

- [ ] **Step 1: failing tests** in `raw.test.ts` (reuse `withExif`, `deps`, `project`):
  - "files every layer of a dated import under the day most files carry": three photos on
    2019-01-24, one on 2019-01-25, a GLB: one capture `2019-01-24`; the mesh and the photos layer
    carry its id; the photos layer is `photos-2019-01-24`. Update the existing first test, which
    expected two captures, to this rule.
  - "a tie goes to the earlier day".
  - "a second import on the same day appends to that date's photos layer and adds no date".
  - "an import with no dated file adds no date, tags nothing and uses the project photos layer".
  - "a video's day is its local start day" (SRT stub from the existing video test with
    `startUtcMs` 2024-11-05T22:30Z and offset 180: day 2024-11-06, video layer tagged).
  - "a cancelled import files what it read" (use the existing cancel signal test pattern).
  - `isImportableExtension('.lrf') === false`, `('.SRT'.toLowerCase())` true.
- [ ] **Step 2:** `pnpm --filter @aio/project test -- raw` fails on the new cases.
- [ ] **Step 3:** implement the changes above. Leave `mergeImport` untouched; run
      `importMerge.test.ts` to confirm.
- [ ] **Step 4:** `pnpm --filter @aio/project test` passes (raw, rawWalks, importMerge).
- [ ] **Step 5:** commit `feat(project): one import is one survey date, every new layer filed`.

### Task 5: main wiring (folders, removeCapture, journal)

**Files:** modify `apps/desktop/src/main/builder.ts`, `builder.test.ts`, `index.ts`, `journal.ts`,
`journal.test.ts`, `apps/desktop/src/preload/index.ts`.

**Interfaces:** consumes `expandImportPaths`, `MAX_FOLDER_FILES` (T2), `removeCapture` (T3),
`isImportableExtension` (T4; until T4 lands, the test injects the predicate). Produces the
`builder:removeCapture` handler and folder support on `builder:import` / `builder:altitudePlan`.

- `builderImport`: before `importRuns.begin`, `const ex = await expandImportPaths(req.paths,
isImportableExtension)`. `ex.tooMany` → `{ ok: false, error: \`${basename(folder)} holds more
  than 20,000 files. Import a smaller folder.\` }`. No files and no left-out → `{ ok: false, error:
  'The folder holds no files to import.' }`. Progress total is `ex.files.length`. The import gets
`ex.files`. Each `leftOut`becomes one appended row`{ file: basename(folder), kind: 'unknown',
  status: 'skipped', message: \`${count} files in ${basename(folder)} are not data this app imports
  (${exts.join(', ')}).\` }`.
- `builderAltitudePlan`: expands the same way (left-out ignored, `tooMany` → error).
- `builderRemoveCapture(req, registry)` mirrors `builderUpdateCapture`.
- `index.ts`: `handle('builder:removeCapture', (req) => packageRefusal(req.projectId) ??
builderRemoveCapture(req, registry))`. `preload/index.ts`: allow the channel.
- `journal.ts`: add `builder:removeCapture` to the manifest-diffed channel list (the `if` near line
  850 and its `IpcRequest` union).

- [ ] **Step 1: failing tests** (`builder.test.ts`): a folder with an MP4, its SRT, an LRF and
      `Thumbs.db` imports the clip (SRT paired) and returns one summary row naming `.db, .lrf`; the
      progress total is 2; a folder over the limit (inject `limit` via a small exported
      `expandFor(req.paths)` helper or a module constant override) answers the error; altitude plan
      accepts a folder; `removeCapture` removes an empty date, refuses a named date and a closed
      project. `journal.test.ts`: the channel list includes `builder:removeCapture`.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- builder journal` fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** tests pass; `pnpm --filter @aio/desktop typecheck`.
- [ ] **Step 5:** commit `feat(desktop): import folders and remove an empty survey date`.

### Task 6: recording days and the prompt plan (`@aio/workspace`)

**Files:** create `packages/workspace/src/surveyDays.ts`, `surveyDays.test.ts`; modify
`packages/workspace/src/index.ts` (export).

**Interfaces:** produces

```ts
/** The local day a layer was recorded on: photos by most items' `takenAt`, video by flight start. */
export function recordingDay(layer: Layer, utcOffsetMin: number): string | null;
export interface FilingGroup {
  day: string; // YYYY-MM-DD
  captureId: string | null; // existing date of that day, null when it must be added
  layerIds: string[];
}
/** Layers in Every date that carry a recording day, grouped by day, oldest day first. */
export function planFiling(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  index: CaptureIndex,
  utcOffsetMin: number,
): FilingGroup[];
```

`planFiling` takes only layers with no entry in `index.of` (so name-dated layers and layers with
their own `capture` are out), kind `photos` or `video`, and a non-null `recordingDay`. A photo
item day is `takenAt.slice(0, 10)` (already local); a video day is
`new Date(flight.startUtcMs + utcOffsetMin * 60_000).toISOString().slice(0, 10)`. Majority with a
tie to the earlier day (same rule as `importDay` in T4; keep a local copy, the packages do not
depend on each other).

- [ ] **Step 1: failing tests**: photo layer majority day; photo layer without dates → null; video
      day across midnight with offset +180; `planFiling` with one existing date and one missing day
      (two groups, `captureId` set and null); a layer named "Ortho 2024-11-06" and a mesh are left out;
      a video with `capture` set is left out.
- [ ] **Step 2:** `pnpm --filter @aio/workspace test -- surveyDays` fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** tests pass.
- [ ] **Step 5:** commit `feat(workspace): recording days of layers and a filing plan`.

### Task 7: strings and icon (`@aio/ui`)

**Files:** modify `packages/ui/src/i18n/en.ts`, `packages/ui/src/icons/paths.tsx`.

Add these keys (next to `change.surveyDate*` and `tree.dates.*`; `change.surveyDateNew` exists,
change its value to `New survey date...`):

| Key                            | Text                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `change.surveyDateNewDay`      | `Day`                                                               |
| `change.surveyDateAdd`         | `Add`                                                               |
| `change.surveyDateCancel`      | `Cancel`                                                            |
| `change.surveyDateNewTag`      | `{date} · {label} (new)`                                            |
| `change.surveyDateFrom.photos` | `Read from the photos.`                                             |
| `change.surveyDateFrom.video`  | `Read from the video.`                                              |
| `change.surveyDateFrom.both`   | `Read from the photos and video.`                                   |
| `tree.addDate`                 | `Add survey date`                                                   |
| `tree.addDate.tip`             | `Add an empty survey date, or import a flight folder as a new date` |
| `tree.addDate.date`            | `Date`                                                              |
| `tree.addDate.name`            | `Name`                                                              |
| `tree.addDate.namePlaceholder` | `Survey`                                                            |
| `tree.addDate.submit`          | `Add date`                                                          |
| `tree.addDate.folder`          | `Import a flight folder...`                                         |
| `tree.addDate.folderHint`      | `The date is read from the files.`                                  |
| `tree.addDate.folderTitle`     | `Import a flight folder`                                            |
| `tree.addDate.exists`          | `{date} is already a survey date.`                                  |
| `tree.addDate.invalid`         | `Enter a date as day, month and year.`                              |
| `tree.datePrompt.title`        | `{count} datasets in Every date were recorded on survey days.`      |
| `tree.datePrompt.existing`     | `{count} under {date}`                                              |
| `tree.datePrompt.new`          | `{count} under a new date, {date}`                                  |
| `tree.datePrompt.file`         | `File them`                                                         |
| `tree.datePrompt.later`        | `Not now`                                                           |
| `tree.datePrompt.done`         | `Filed {count} datasets.`                                           |
| `palette.addSurveyDate`        | `Add survey date...`                                                |
| `palette.importFlightFolder`   | `Import a flight folder...`                                         |

Icon `calendar-plus`: a calendar outline (rounded rect 3,5 to 21,21, two binding ticks at x 8 and
16 from y 3 to 7, a header line at y 10) with a plus centred at 12,15.5 (arms 2.5 long), on the
same 24 px grid and stroke as `folder` and `plus`.

- [ ] **Step 1:** add an `en.test.ts` case (or extend the existing i18n key test) that the keys
      exist and contain no `—`.
- [ ] **Step 2:** fails. **Step 3:** add keys and icon. **Step 4:** `pnpm --filter @aio/ui test`
      and typecheck pass (the `IconName` union picks up the new name).
- [ ] **Step 5:** commit `feat(ui): strings and icon for adding survey dates`.

### Task 8: import card date select, New survey date, tidy up

**Files:** modify `apps/desktop/src/renderer/change/SurveyDate.tsx`; create
`apps/desktop/src/renderer/change/SurveyDate.test.tsx`; modify
`apps/desktop/src/renderer/builder/SurveyDate.tsx`, `builder/state.ts`, `builder/state.test.ts`.

**Interfaces:** consumes `builder:ensureCapture`, `builder:removeCapture` (T3), strings (T7).
Produces:

```ts
// change/SurveyDate.tsx
export async function newSurveyDate(day: string): Promise<{ captureId: string } | { error: string }>;
export async function removeEmptyCapture(captureId: string): Promise<string | null>; // no-op (null) when a layer names it
export function SurveyDateSelect(props: {
  layerIds: readonly string[]; label: string; noneLabel: string; testId: string;
  suggestedDay?: string;               // prefill of New survey date, else today
  createdHere?: readonly string[];     // capture ids the import created: removed when left empty
  source?: 'photos' | 'video' | 'both' | null; // the "Read from ..." line
}): JSX.Element | null;
// builder/state.ts
importResult: { ...; newDates?: string[]; dateSource?: 'photos' | 'video' | 'both' | null }
pickAndImportFolder: () => Promise<void>;
```

Behaviour:

- `SurveyDateSelect` renders whenever `layerIds.length > 0` (drop the `captures.length < 2`
  guard). Options `''` (Not dated), each capture (oldest first), `'new'` (New survey date...).
- Choosing `'new'` shows the inline row: `<input type="date" className="input">` prefilled with
  `suggestedDay ?? today (local)`, **Add**, **Cancel** (`data-testid` `${testId}-new`,
  `${testId}-add`). Add: `newSurveyDate(day)` then `setLayersCapture(layerIds, captureId)`.
- After any successful change, for each id in `createdHere` that differs from the new value:
  `removeEmptyCapture(id)` (checks the fresh manifest; only calls the channel when no layer has
  `capture === id`).
- Option label of a capture in `createdHere`: `change.surveyDateNewTag`.
- `source` line under the select (`className="faint small"`).
- `state.ts` `importFiles`: keep `const before = new Set(project.manifest.captures.map((c) =>
c.id))` before the call; after success
  `newDates = r.value.manifest.captures.filter((c) => !before.has(c.id)).map((c) => c.id)`;
  `dateSource` from the imported rows' kinds (`photo` / `video`) when any imported layer has a
  `capture`, else null. `pickAndImportFolder`: `dialog:openFolder` with title
  `t('tree.addDate.folderTitle')`, then `importFiles([path])`.
- `builder/SurveyDate.tsx` `ImportSurveyDate` passes `createdHere={result.newDates}`,
  `source={result.dateSource}`, `suggestedDay` = the date of the first new capture.

- [ ] **Step 1: failing tests** (`SurveyDate.test.tsx`, Testing Library with a mocked `bridge`
      and a seeded `workspace`): renders with 0 and 1 captures; lists Not dated, the dates oldest
      first and New survey date...; New survey date calls `builder:ensureCapture` with the typed day
      then `builder:updateLayers` with `{ capture }`; re-dating away from a `createdHere` date that is
      now empty calls `builder:removeCapture`; re-dating away from a date not in `createdHere` never
      does; a `createdHere` date still named by another layer is not removed; disabled when read-only.
      `state.test.ts`: `newDates` and `dateSource` after an import that added a date;
      `pickAndImportFolder` imports the picked folder and does nothing on cancel.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- SurveyDate state` fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** tests pass, plus `photogrammetry` tests untouched and green.
- [ ] **Step 5:** commit `feat(desktop): survey date of an import with any number of dates`.

### Task 9: Add survey date popover

**Files:** create `apps/desktop/src/renderer/shell/AddSurveyDate.tsx`,
`apps/desktop/src/renderer/shell/AddSurveyDate.test.tsx`,
`apps/desktop/src/renderer/shell/surveyDates.css`.

**Interfaces:** consumes `newSurveyDate` (T8), `updateCapture` (`shell/dateFolders.ts`),
`timeline.getState().focusSurvey`, `builder.getState().pickAndImportFolder` (T8), strings and icon
(T7). Produces:

```ts
export const addDateMenu: StoreApi<{ open: boolean; set(open: boolean): void }>; // zustand vanilla
export function AddSurveyDateButton(props: { onNote: (text: string) => void }): JSX.Element;
```

The button (`className="eye"`, `data-testid="add-survey-date"`, icon `calendar-plus`,
`aria-label` `tree.addDate`, `aria-expanded`) toggles a popover (`role="dialog"`,
`aria-label` `tree.addDate`, `className="dmenu add-date"`) placed under the button and kept inside
the window (reuse `place()` logic from `DateMenus.tsx` by copying its clamp, 10 lines, not
importing internals). Fields: date (`type="date"`, default today local), name (placeholder
`Survey`), **Add date** (`data-testid="add-date-submit"`), a separator, **Import a flight
folder...** (`data-testid="add-date-folder"`) with the hint line.

Submit: invalid date → inline error `tree.addDate.invalid`; else `newSurveyDate(day)`; when the
date was new (capture id not in the manifest before) and a name was typed →
`updateCapture(id, { label: name.trim() })`; existed → `onNote(t('tree.addDate.exists', { date:
formatDate(day) }))`; then `focusSurvey(id)`, close, return focus to the button. Escape closes and
returns focus. Outside click closes. Folder: close, `pickAndImportFolder()`.

- [ ] **Step 1: failing tests**: opens and closes (button, Escape, outside click); submit calls
      `builder:ensureCapture` then `builder:updateCapture` with the label when new; an existing day
      calls `onNote` and does not rename; invalid date shows the error and calls nothing; folder entry
      calls `pickAndImportFolder`; `addDateMenu.set(true)` opens it (for the palette).
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- AddSurveyDate` fails.
- [ ] **Step 3:** implement; styles in `surveyDates.css` (field grid of two columns, 8 px rhythm,
      existing tokens only).
- [ ] **Step 4:** tests pass.
- [ ] **Step 5:** commit `feat(desktop): add a survey date by hand from Datasets`.

### Task 10: one-time prompt

**Files:** create `apps/desktop/src/renderer/shell/datePromptPref.ts`, `datePromptPref.test.ts`,
`DatePrompt.tsx`, `DatePrompt.test.tsx`.

**Interfaces:** consumes `planFiling` (T6), `defaultUtcOffsetMin` (T1), `moveLayersToDate`,
`undoDateMove` (`shell/dateFolders.ts`), `newSurveyDate` (T8: if T8 has not landed, call
`bridge.call('builder:ensureCapture', …)` directly in a local helper), strings (T7). Produces:

```ts
// datePromptPref.ts
export function createDatePromptPref(
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): StoreApi<{ done: Record<string, true>; finish(projectId: string): void }>;
export const datePromptPref: ReturnType<typeof createDatePromptPref>;
// DatePrompt.tsx
export function DatePrompt(props: {
  canEdit: boolean;
  onResult: (note: { text: string; undo?: { moved: MovedLayer[]; target: string | null } }) => void;
}): JSX.Element | null;
```

`DatePrompt` reads the open project, `useCaptureIndex()`, `builder.importing`; computes
`planFiling(manifest, index, defaultUtcOffsetMin(manifest.origin, epsg))` (epsg 0 → offset 0);
renders nothing when `!canEdit`, importing, no groups, or `datePromptPref.done[projectId]`.
Otherwise `<p className="dtree-note" role="status" data-testid="date-prompt">` with the title, one
line per group (`existing` / `new`), **File them** (`data-testid="date-prompt-file"`) and
**Not now** (`data-testid="date-prompt-later"`). File: for each group, `captureId ??
(await newSurveyDate(day)).captureId`, then `moveLayersToDate(layerIds, captureId)`; stop at the
first error and report it; `finish(projectId)`; `onResult({ text: tree.datePrompt.done, undo })`
with `undo` only when there was one group. Not now: `finish(projectId)`.

- [ ] **Step 1: failing tests**: pref round trip, a malformed stored value reads as empty, storage
      that throws is ignored; prompt shown for a project with an undated photos layer and an undated
      video; File them creates the missing date, moves both groups and finishes; Not now finishes;
      hidden when done, read-only, or while importing; hidden for a name-dated layer only.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- DatePrompt datePromptPref` fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** tests pass.
- [ ] **Step 5:** commit `feat(desktop): offer once to file recorded datasets under their dates`.

### Task 11: wiring in Datasets and Ctrl+K

**Files:** modify `apps/desktop/src/renderer/shell/Sidebar.tsx`,
`apps/desktop/src/renderer/shell/Palette.tsx`.

- `Datasets` header: after the drawing button, `{canEdit && <AddSurveyDateButton onNote={(text)
=> setNote({ text, danger: false })} />}`; import `./surveyDates.css`.
- Render `<DatePrompt canEdit={canEdit} onResult={(n) => setNote({ text: n.text, danger: false,
...(n.undo ? { undo: n.undo } : {}) })} />` above the note. The note is rendered only when
  `datesOn` today: render it also when the prompt or Add survey date created the first date (drop
  the `datesOn &&` guard on the note; the note is cleared on project switch already).
- `Palette.tsx`: two commands next to the survey commands, shown when a project is open and not
  read-only: `add-survey-date` (`palette.addSurveyDate`, opens the sidebar if collapsed, then
  `addDateMenu.getState().set(true)`) and `import-flight-folder` (`palette.importFlightFolder`,
  `builder.getState().pickAndImportFolder()`).

- [ ] **Step 1: failing tests**: extend the existing Sidebar/Palette tests (or `DateMenus.test.tsx`
      neighbours) for: the button shows for an editable project and not in a package; the prompt's
      note appears in the type-first tree; the palette lists both commands and runs them.
- [ ] **Step 2:** fails. **Step 3:** implement. **Step 4:** `pnpm --filter @aio/desktop test`
      passes.
- [ ] **Step 5:** commit `feat(desktop): add survey date and the filing prompt in Datasets`.

### Task 12: e2e

**Files:** create `apps/desktop/e2e/survey-dates-add.spec.ts`.

Use `builder.spec.ts` patterns: `withExif` from `@aio/project/builder/testing` on a real JPEG made
with `sharp` (64 x 48), `nextOpenDialog(app, [folder])` for `dialog:openFolder` (check its handler
uses `showOpenDialog`; adapt the stub if it does not), `savedManifest` from `timeline.spec.ts`
(copy the helper).

Specs:

1. **"a flight folder comes in as a new survey date, and the date can be changed"**: tiny project
   (one date 2026-01-01). Folder with three EXIF photos dated 2024-11-06 and a `notes.txt`. Click
   `add-survey-date`, then `add-date-folder`. Expect the import card's `import-survey-date` select
   to show `6 Nov 2024 · Survey (new)`, the "Read from the photos." line, and a skipped row naming
   `.txt`. On disk: captures `2026-01-01`, `2024-11-06`; a photos layer `photos-2024-11-06` with
   that capture. Then New survey date..., day 2024-11-07, Add: on disk the layer is under
   `capture-2024-11-07` and `capture-2024-11-06` is gone. The Datasets list has a 7 Nov 2024
   folder.
2. **"a survey date is added by hand and focused"**: `undatedProject` fixture (no dates, from
   `timeline.spec.ts`). Add survey date, date 2026-02-03, name "Baseline", Add date. The tree turns
   date-first with one folder "3 Feb 2026", focused; on disk the capture has label `Baseline`.
   Adding 2026-02-03 again shows the "already a survey date" note and adds nothing.
3. **"recorded datasets in Every date are filed once"**: a project written before start with a
   photos layer (items with `takenAt` 2026-01-01) and no `capture`, plus a mesh. The project also has a second undated photos layer (items dated 2026-01-01) so the note reads
   "2 datasets in Every date...". File them: both under 1 Jan 2026; the mesh stays in
   Every date; reopen the project: no prompt. Second project variant: Not now, reopen: no prompt.

Run the way CI runs it: `pnpm demo:build --quick` (with `--python` pointing at the main checkout's
venv), then from `apps/desktop` with `QUADRION_WINDOW_SIZE=1100x700`, `QUADRION_E2E_SCALE=1`,
`QUADRION_E2E_SWGL=1`, `QUADRION_E2E_PYTHON` set: `pnpm exec playwright test
survey-dates-add.spec.ts --workers=1`. Then re-run `builder.spec.ts`, `timeline.spec.ts`,
`project-types.spec.ts`, `jobs.spec.ts` the same way; fix any expectation that assumed one capture
per day or the single `photos` layer (expected after T4).

- [ ] **Step 1:** write the spec. **Step 2:** run, see it pass against the built branch (it fails
      before T11). **Step 3:** re-run the four neighbours. **Step 4:** commit
      `test(e2e): add a survey date by hand, from a flight folder and by the filing prompt`.

### Task 13: docs

**Files:** modify `docs/guide/28-survey-dates.md` (new section "Adding a survey date": the button,
the folder import, the import card, the prompt), `docs/TESTING.md` (a Timeline T2 stage with the
"How to test" steps below and a row in the stages table), `docs/architecture/data-conventions.md`
section 13 (an import files its layers under one date; photos per date),
`docs/KNOWN-LIMITS.md` (pipeline-job layers are not dated on arrival; files of several days in one
import go under one date), `docs/architecture/contract-changes.md` (row below).

Contract-changes row:

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                          | Affects                                                                                                           | Status                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 2026-10-12 | Additive: new IPC channel `builder:removeCapture` (`{ projectId, captureId }` to `{ ok: true, manifest, backup }` or `{ ok: false, error }`): removes a survey date from `manifest.captures` when no layer's `capture` names it; refused while one does, for an unknown id and on a package; journalled like `builder:updateCapture`. Behaviour: `builder:import` and `builder:altitudePlan` accept folders in `paths` (read recursively in main, dot entries skipped, files of unknown types left out with one `skipped` row per folder, 20,000 files at most); `builder:import` files every layer it creates under one survey date, the day most dated files carry, and adds only that date (it added one date per day and filed nothing); photos go to a photos layer per date (`photos-<date>`). No type or manifest version change; older builds read `capture` since M8 | Timeline T2: a flight comes in as its own survey date with every layer filed under it, and correcting the date in the import card must not leave an empty date behind (design `docs/plans/2026-10-12-timeline-t2-add-survey-date-design.md`) | `@aio/schema`, `@aio/project` (import, captures), desktop main, preload, renderer (import card, Datasets, Ctrl+K) | pending founder review |

- [ ] **Step 1:** write the docs; run `node tools/agent/check-public-text.mjs <files>` and
      `pnpm format:check` (prettier `--write` the docs). **Step 2:** commit
      `docs: adding survey dates (guide, testing, contract change)`.

---

## Verification before hand-off

- `pnpm check` green in the worktree.
- `survey-dates-add.spec.ts` and the four neighbours green the CI way (Task 12).
- `node tools/agent/finish-task.mjs`, then hand off per `CLAUDE.md` (merge-order note: this branch
  carries a contract change).

## How to test (for the founder)

1. Open a project that has one survey date or none (the construction progress project works).
2. **Recorded datasets prompt:** at the top of Datasets a note says how many datasets in Every date
   were recorded on survey days and under which dates they go. Click **File them**. The video and
   photos move into the date folder; models and drawings stay in Every date. Close and reopen the
   project: the note does not come back.
3. **Add a date by hand:** in the Datasets header click the calendar-plus button. Pick a date,
   type a name such as "Baseline", click **Add date**. A new, greyed date folder appears and is
   the date you are viewing; the date bar shows it. Do it again with the same day: a note says it
   is already a survey date.
4. **Import a flight folder:** open the same button and click **Import a flight folder...**. Pick
   a folder straight off the drone card (photos and/or video with their SRT files). The import card
   lists the files; files the app does not use (LRF proxies, text files) are summed up in one row.
   Under the list, **Survey date** shows the day of the flight with "(new)" and "Read from the
   photos and video."
5. The new date folder holds every dataset of that flight (video, photos, any ortho or model you
   had in the folder). Step to it with the date bar arrows.
6. **Change the date:** in the import card pick **New survey date...**, set another day, click
   **Add**. The datasets move to that day and the wrong date disappears from Datasets. Picking an
   existing date works the same way.
7. Drag a folder from Explorer onto the window: it imports the same way.
8. Select any dataset: the Selection card's **Belongs to date...** now also offers **New survey
   date...**, also in a project with only one date.
9. Ctrl+K, type "survey": **Add survey date...** opens the popover; **Import a flight folder...**
   opens the folder dialog.
10. Open a shared package: there is no calendar-plus button and no prompt.
