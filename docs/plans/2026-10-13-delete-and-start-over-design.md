# Delete datasets and runs, and start a failed run over

Date: 13 Oct 2026. Branch: `feat/delete-and-start-over`. Status: spec written from the founder's
decisions of 13 Oct; the choices the founder did not make are listed under "Decisions taken
(founder to confirm)".

Builds on: `2026-10-12-walk-layer-and-placing-design.md` ("Remove walk", the `.trash/` folder and
its seven-day sweep), which this design turns into the general case.

## The problem

A failed photogrammetry run (photos to maps) leaves its folder, its job folders and sometimes half
its layers behind, and the next attempt adds another run beside it. Nothing in the app removes a
run: **Delete work files** (`photo:cleanWork`) only sends `photogrammetry/<run>/work/` to the
recycle bin. Datasets cannot be removed at all, except a 360 walk, one at a time
(`walks:remove`). There is no way to remove a group, everything under a survey date, or a hand-picked
set of rows.

## What the founder decided (13 Oct 2026)

1. **Removed things go to the project's `.trash/`**, as walks do today, and are swept seven days
   later when the project opens. An **Empty project trash (2.3 GB)** action frees the space at once.
   No Restore in the app in this version: a person restores by hand from `.trash/` within seven
   days. In-app Restore is a follow-up.
2. **Dependents are shown and taken along.** The confirm lists everything that goes ("Also
   removes: run 3 and its 4 map layers, 1 comparison") and all of it goes in one step. Nothing is
   left half-broken.
3. **Start over…** on a failed or cancelled run opens the process wizard filled in with the same
   photos and settings; the failed run goes to the trash when the new run starts. **Resume**
   stays as it is.

## Who uses it, and what success looks like

The person who processes drone photos in the office. A run failed at 80 % on a bad setting; they
want it gone, with its half-written maps, and a new run with the setting changed, in three clicks.
Or a test import of the wrong day's video and photos: they select the date folder, press Delete,
read one dialog that says what goes and how much space comes back, and confirm. Success: after
either, the Datasets list, the Processing drawer and the disk agree, nothing points at a missing
layer, and the space is back after **Empty project trash**.

## Scope

In:

- One remove operation in `@aio/project` for any mix of dataset layers and photogrammetry runs,
  with dependent resolution, trash moves, one manifest save and rollback.
- `walks:remove` becomes one case of it.
- Removing a run's job folders and job records (`userData/jobs.json`).
- Datasets tree: **Delete…** on rows, group headers and survey-date folders; multi-select.
- Processing drawer: **Delete run** on every run, **Start over…** on failed and cancelled runs.
- The confirm dialog, the trash size, **Empty project trash**.

Out:

- Restore from the app (follow-up). Removing single photos from a photos layer. Removing issues,
  measurements, designs or volumes (they have their own editors). Removal on a hub peer: the
  manifest change syncs through the journal as any edit does; peers' copies of the files are left
  to the sync layer (see decisions).

## Facts the design rests on

- **Imports copy.** `builderImport` (`apps/desktop/src/main/builder.ts`) calls `importRawFiles`
  (`packages/project/src/builder/raw.ts`): photos to `photos/<id>.jpg`, video to `video/<id>.mp4`,
  models to `models/`, walks to `walks/<id>/`. Every manifest `AssetRef` is `{ hash }` or a
  project-relative `{ path }` (`ProjectPath` forbids `..`, drive letters and leading `/`). So a
  layer's files are always inside the project, and originals are never touched.
- **Two exceptions read outside the project and must never be moved:** a run whose
  `photos.source` is `{ folders: [...] }` (absolute folders read in place, `PhotoSource` in
  `packages/schema/src/photogrammetry.ts`), and a DXF handed to `drawing.import` by its own path
  (`dxfSource`, `builder/drawings.ts`). Neither is stored as an `AssetRef`. The remove operation
  also checks every path it moves: anything that resolves outside the project root is refused.
- **Hash assets** (`assets/sha256/<hash>`) are content-addressed and may be shared; they are never
  moved by a removal (the sync layer owns them).
- **A run** is `photogrammetry/<run>/run.json` (`PhotoRun`, `aio.photo-run/1`): `photos.source`,
  `preset`, `crs`, `settings` (the job params), `capture`, `status`
  (`aligning|aligned|adjusted|processing|done|failed|cancelled`), and
  `outputs: { layers, tilesets, files }`. `photo.products` (`_commit` in
  `python/src/aio_pipelines/photo/products.py`) adds layers `<run>-ortho`, `<run>-dsm`,
  `<run>-dtm`, `<run>-cloud`, `<run>-mesh`, with files under `rasters/<id>/`, `sources/<id>.json`,
  `clouds/<run>.copc.laz`, `models/<run>-mesh.glb`; tilesets go to `tiles/<id>/` with a
  `tilesets.json` entry carrying `run`. A run that failed before commit may have no layers but
  staged files in `jobs/<jobId>/`.
- **Jobs** (`JobRecord`, `packages/schema/src/jobs.ts`) link to a run only through
  `params.run` and to a project through `project` (the folder). `jobDir(job)` is
  `<project>/jobs/<jobId>/` (`apps/desktop/src/main/jobs/runner.ts`). `JobStore`
  (`main/jobs/store.ts`) has no remove. The renderer's `jobsOfRun` (`photogrammetry/store.ts`)
  already matches `params.run` plus the project folder.
- **Comparisons** are change sets: `change/<id>.json` plus `change/<id>/`, with derived layers
  carrying `derived: { kind: 'change', changeId, source: [layer ids], runId: <job id> }`
  (`LayerDerived`, `packages/schema/src/layers.ts`; `ChangeSet` in `change.ts`, whose items name
  `layerFrom`, `layerTo`, `layer`, `a.layer`, `b.layer`).

## Data model

### What a removal names

```ts
// packages/schema/src/builder.ts (new)
type RemoveTarget =
  | { layer: string } // a manifest layer id
  | { run: string } // a PhotoRunId
  | { capture: string }; // a survey date: every layer filed under it, then the date itself

type RemovalPlan = {
  layers: { id: string; name: string; kind: string; why: RemoveWhy }[];
  runs: { id: string; status: PhotoRun['status']; why: RemoveWhy }[];
  changes: { id: string; name: string; why: RemoveWhy }[]; // comparisons
  tilesets: string[];
  surfaces: string[]; // prepared survey surfaces built from a removed layer
  detections: string[]; // detections/<file>.json naming a removed layer
  jobs: string[]; // job ids of removed runs
  captures: string[]; // survey dates that go (date-folder removal only)
  keptCaptures: string[]; // dates asked for that something else still names (volumes, survey)
  files: string[]; // project-relative paths that move to .trash/
  bytes: number; // what the files weigh
  refused?: string; // set when the whole removal cannot happen (why, in plain words)
  touches: { issues: number; walkPins: number }; // kept, but lose their target (see below)
};
type RemoveWhy = 'asked' | { usedBy: string } | { madeBy: string } | { filedUnder: string };
```

The plan is pure data: the dialog shows it, and the removal carries it out from a fresh read.

### The trash

`.trash/<stamp>-<slug>/` (stamp as today, `20261013T081530Z`; slug from the first target, e.g.
`run-20261012-3`), holding the moved paths **in their project layout** (`rasters/<id>/...`,
`photogrammetry/<run>/...`, `jobs/<jobId>/...`), plus `removed.json`:

```ts
type TrashRecord = {
  schema: 'aio.trash/1';
  at: string; // ISO time
  targets: RemoveTarget[];
  plan: RemovalPlan; // what went, so a person can put it back by hand
  manifestBefore: string; // the manifest backup file name (updateManifestFile's backup)
};
```

One folder per removal keeps `sweepTrash` (`walkRemove.ts`) unchanged: it already deletes any
entry whose name starts with a stamp older than seven days. Walk removals keep writing
`<stamp>-<walk id>/` as today plus the same `removed.json`. `.trash/` is already left out of
packages; data-conventions gains a short `.trash/` section for the layout and `aio.trash/1`.

## Resolving dependents (`packages/project/src/builder/removePlan.ts`)

`planRemoval(root, targets): Promise<RemovalPlan>` reads the manifest, `tilesets.json`, every
`photogrammetry/*/run.json`, every `change/*.json`, `survey/surfaces/*/tiles.json`,
`detections/*.json`, `procmodel.json` and the package plan, then grows the set to a fixed point:

| From                      | Takes along                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a survey date             | every layer with `capture` equal to it; the date itself unless `volumes.json`, `survey/qa/<capture>.json` or a survey measurement still names it (then it is listed under `keptCaptures`, and the empty folder stays)                                            |
| a photos layer            | every run with `photos.source.layer` equal to it                                                                                                                                                                                                                 |
| a run                     | its folder `photogrammetry/<run>/`; the layers in `outputs.layers` and any layer `<run>-ortho/-dsm/-dtm/-cloud/-mesh` (a failed commit may not have listed them); `outputs.tilesets` and `tilesets.json` entries with `run` equal to it; its jobs (`params.run`) |
| any layer                 | change sets whose items or `layers[]` name it, and every layer with `derived.changeId` of such a set or `derived.source` containing it; tilesets with `from` equal to it; prepared surfaces whose source `layer` is it; detection files whose `layer` is it      |
| a change set              | `change/<id>.json`, `change/<id>/`, its derived layers                                                                                                                                                                                                           |
| a model layer (procmodel) | nothing more: the `procmodel.json` entry's `layer` is cleared, the procedural model stays                                                                                                                                                                        |

What is **kept and only loses its target** (counted in `touches`, named in the dialog as "2 issues
will show 'dataset removed'"):

- Issues in `issues.json` whose target names a removed layer: an issue is a person's record, so it
  stays with its text, position and photos; the issue card shows "Dataset removed" instead of a
  view button.
- Walk pins on a removed drawing: already handled ("Pin on a drawing that was later removed": the
  pin goes inactive and the quality drops).
- Survey measurements on a removed prepared surface: the existing `SurfaceNotFound` path
  (`packages/survey/src/engine/resolver.ts`) asks to prepare surfaces again.

Files of a layer come from one helper, `ownedPaths(layer)` in the same file, built on
`layerFiles` (`@aio/sync`): a `{ path }` ref whose parent folder is named after the layer id
(`rasters/<id>/tiles.json`, `walks/<id>/walk.json`) owns that whole folder; otherwise the file
itself, plus its poster and flight file. Photos layers own `photos/<item id>.jpg` and the
matching `photos/thumbs/` files. A path that another remaining layer also names is not moved.
`sources/<id>.json` goes with the run's raster of the same id.

**Refusals** (the plan carries `refused`, and nothing moves):

- The project is a package (`packageRefusal` in `main/index.ts`) or the person is a view-only
  reviewer (`useAnnotateReadOnly` in the renderer; main refuses as it does for other manifest
  writes).
- A job is live (`starting|running|cancelling`) for this project whose `params.run` is a removed
  run, or whose params name a removed layer id anywhere (a deep scan of `params` values; change
  jobs carry `layerFrom` and `layerTo`). The reason names the job: "Creating maps for run 3 is
  still running. Cancel it first."
- A target id that does not exist.

## Removing (`packages/project/src/builder/remove.ts`)

`removeItems(root, targets, now?, o?): Promise<{ manifest; plan; trash: string }>`:

1. `planRemoval` again from disk (the dialog's plan may be stale); refuse if `refused`.
2. Move every path in `plan.files` into `.trash/<stamp>-<slug>/<same path>` with
   `renameWhenFree` (as `moveToTrash` in `walkRemove.ts` does, now shared as
   `builder/trash.ts`). If any move is refused, move back the ones already moved and stop: nothing
   changed.
3. Rewrite the side files that named removed things: `tilesets.json`, `procmodel.json`, the
   package plan's `excludedLayers`. Each keeps a copy in the trash folder first.
4. Save the manifest once with `updateManifestFile`: layers out, dates out, nothing else. When the
   save fails, put the side files back and move the files back (best effort, as `removeWalk` does)
   and rethrow.
5. Write `removed.json`.

`removeWalk` becomes `removeItems(root, [{ layer }])` with the walk folder as the owned path; its
tests keep passing unchanged.

Main then, after a successful save (`apps/desktop/src/main/removal.ts`, new):

- `JobStore.delete(id)` (new, `main/jobs/store.ts`) for each job in `plan.jobs`, then `flush()`.
  The job folders already moved to the trash in step 2 (they are inside the project). A job that
  is not in the store any more is skipped.
- The journal reconciles `manifest.json` and the side files it rewrote, as it does for
  `walks:remove` (`main/journal.ts`).

### Empty project trash

`trashSize(root): Promise<{ bytes; entries }>` and `emptyTrash(root): Promise<{ freed }>` in
`builder/trash.ts`; `emptyTrash` is `sweepTrash` with a keep time of zero (an entry held open is
left and reported).

## IPC (all in `packages/schema/src/ipc.ts`)

| Channel              | Request                                  | Response                                               |
| -------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `builder:removePlan` | `{ projectId, targets: RemoveTarget[] }` | `{ ok: true, plan } \| { ok: false, error }`           |
| `builder:remove`     | `{ projectId, targets: RemoveTarget[] }` | `{ ok: true, manifest, plan } \| { ok: false, error }` |
| `builder:trash`      | `{ projectId }`                          | `{ bytes, entries }`                                   |
| `builder:emptyTrash` | `{ projectId }`                          | `{ ok: true, freed } \| { ok: false, error }`          |

`walks:remove` stays (the walk row calls it) and calls `removeItems`. `builder:remove` and
`builder:emptyTrash` are added to the preload allow-list and to the journal's manifest-writer list.
After `builder:remove` the renderer reloads `photo:runs` and `jobs:list`.

## The interface

### Datasets tree

- **Delete…** in every layer row's menu (`LayerDateMenu`, `apps/desktop/src/renderer/shell/DateMenus.tsx`,
  and the row actions of `packages/ui/src/tree/DatasetTree.tsx`), on every group header (Models,
  Video, Photos…: all its rows), and in the survey-date folder menu (`DateFolderMenu`: the date
  and everything filed under it). Annotation rows and retired `legacy` layers get no Delete.
- **Multi-select.** `DatasetTree` and `DateTree` gain `marked: ReadonlySet<string>` beside
  `selectedId`: Ctrl+click toggles a row, Shift+click marks the range in display order, Esc clears.
  With rows marked, the Datasets header shows "3 selected · Delete…" and the Delete key opens the
  same dialog. Clicking without a modifier keeps today's single selection and clears the marks.
- Offered only when `canEdit` (`Sidebar.tsx`: not a package, not a view-only reviewer).
- The walk row's inline confirm (`walk-remove-confirm`) is replaced by the dialog, so a walk
  shows its dependents like everything else.

### Processing drawer (`apps/desktop/src/renderer/photogrammetry/PhotoRuns.tsx`)

- **Delete run** on every run row, beside **Delete work files**, opening the same dialog with
  `[{ run }]`. Disabled with the reason as the tooltip while a job of the run is live.
- **Start over…** on runs with status `failed` or `cancelled`, next to **Resume** in `RunPanel.tsx`
  and on the row. It opens the wizard filled in from `run.json`:
  - `store.ts`: `view: { kind: 'wizard'; initial?: WizardInitial }`, `openWizard(initial?)`.
  - `WizardInitial = { source: PhotoSource; preset; gnss; crs?; products; capture?; replaces: run }`
    taken from `photos.source`, `preset`, `crs`, `settings.gnss`, `settings.products` and
    `capture`. `ProcessWizard.tsx` seeds its `useState` values from it; a photos layer that is
    gone, or a folder that no longer exists, leaves that step empty with a line saying why.
  - The wizard's title reads "Start run 3 over"; **Start** (`go()`) creates a new run id as today
    (`newRunId`). Once `startAlign` answers `ok`, it calls `builder:remove` with
    `[{ run: replaces }]`. When that removal fails, the new run goes on and a note says the old
    run is still there and why.
- The photogrammetry renderer has its English inline (no `useT`), so its new text is inline too;
  the tree and dialog strings go to `packages/ui/src/i18n/en.ts`.

### The confirm dialog (`packages/ui/src/tree/RemoveDialog.tsx`, new)

An `alertdialog` on the pattern of the project delete dialog (`screens/ProjectMenu.tsx`):

- Title: "Delete 3 datasets?" / "Delete run 3?" / "Delete everything from 12 Oct?"
- What was asked for, then **Also removes:** grouped lines from the plan: "Run 3 and its 4 map
  layers", "1 comparison (12 Oct to 26 Oct)", "1 prepared surface", "2 job folders".
- **Keeps:** "2 issues will show 'Dataset removed'"; "The survey date stays: a volume uses it".
  Photos read from folders outside the project: "Your original photos are not touched."
- **Space freed:** from `plan.bytes`, freed for good when the trash is emptied.
- The note: "Everything goes to the project trash and is deleted for good after seven days."
- Buttons: Cancel (default focus), **Delete** (danger). A `refused` plan shows its reason and
  only a Close button.

### Empty project trash

There is no per-project settings screen yet. The action lives in two places: the Datasets footer
line "Trash 2.3 GB · Empty" (shown only when the trash is not empty, via `builder:trash` on open
and after each removal), and the project's menu in the library (`ProjectMenu.tsx`, beside Show in
folder). Its confirm: "Delete the project trash for good? 2.3 GB, 4 removals. This cannot be
undone."

## Contract (minor)

- New IPC `builder:removePlan`, `builder:remove`, `builder:trash`, `builder:emptyTrash`; new
  schema types `RemoveTarget`, `RemovalPlan`, and the file schema `aio.trash/1`
  (`.trash/<entry>/removed.json`), registered in `versions.ts`.
- `walks:remove` keeps its shape; its trash entry gains `removed.json`.
- The manifest schema does not change; only entries leave it. Older builds open a project after a
  removal unchanged.
- One row in `docs/architecture/contract-changes.md`, marked **Minor**, added with the schema task.

## Failures

| Case                                            | Behaviour                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A file is held open (viewer, antivirus)         | `renameWhenFree` waits; if it gives up, everything moves back, the reason names the file |
| The manifest save fails                         | Side files and files move back; the error is shown; nothing changed                      |
| Moving back fails too                           | Files stay in `.trash/` with `removed.json`; the error says so and where                 |
| A job starts on the run between plan and remove | Step 1 replans and refuses                                                               |
| A layer's files are already gone                | The layer still goes (as `removeWalk` does today)                                        |
| A run folder without a readable `run.json`      | Listed as a run by folder name; removing it moves the folder                             |
| `JobStore.delete` fails after the save          | Logged; the record shows as a job whose run no longer exists                             |
| Start over: the photos layer was removed since  | The wizard opens with the photos step empty and says why                                 |
| Emptying the trash while a file is held         | That entry stays; the note says "1 removal could not be deleted yet"                     |

## Testing

- **Unit (`@aio/project`)**, `removePlan.test.ts` on fixture projects: a date folder, a photos
  layer with two runs, a run that failed before commit (layers only by id convention), a change
  set naming a removed layer, a tileset by `run` and by `from`, a prepared surface, a detection
  file, a run read from outside folders (never in `files`), a shared path kept, a live job
  refusal, a package refusal, a date kept because a volume names it. `remove.test.ts`: the trash
  layout and `removed.json`; rollback when the third move fails (the first two come back); rollback
  when the save fails (side files and files back); a path outside the root refused. The
  `walkRemove` tests unchanged. `trash.test.ts`: size, empty, held entry.
- **Unit (main)**: `JobStore.delete`; the `builder:remove` handler deletes job records only after
  the save; the journal reconciles the rewritten files.
- **Unit (renderer and `@aio/ui`)**: marks (Ctrl, Shift range, Esc, plain click clears); the dialog
  text from a plan; `WizardInitial` from a `run.json` (missing layer, missing folder).
- **e2e** `apps/desktop/e2e/delete-and-start-over.spec.ts` (new, off-screen as all specs): a
  synthetic project with a photos layer, a seeded failed run (`run.json`, a `<run>-ortho` layer
  and a job folder) and a video group. (1) Delete the Video group: the dialog lists its rows,
  confirm, the rows are gone and `.trash/` holds them. (2) Delete the photos layer: the dialog
  lists run 3 and its map layer under Also removes. (3) The footer shows the trash size; Empty
  clears it and `.trash/` is empty. (4) On a second seeded failed run, Start over opens the wizard
  with the same photos and preset; Start runs the fake pipeline (`e2e/photo-fake`) and the old run
  leaves the drawer and lands in `.trash/`. Part 4 needs the pipeline Python and is skipped
  without it, as the other photo specs are. `walk-place.spec.ts`'s remove test moves to the
  dialog's test ids.

## Decisions taken (founder to confirm)

1. **Issues are kept**, not taken along, when their dataset goes: they show "Dataset removed".
   They are a person's records, and decision 2 is about computed things. Walk pins and survey
   measurements likewise keep their existing missing-target behaviour.
2. **Deleting a survey date removes the date too**, unless a volume or survey record still names
   it; then the empty date stays and the dialog says why.
3. **Dependents are found by scanning the project's own files** (run.json, tilesets.json, change
   sets, prepared surfaces, detection files), not by a new index. A run's layers are found by
   `outputs.layers` and by the `<run>-*` id convention, so a run that failed mid-commit is caught.
4. **Live jobs are checked by `params.run` and by a deep scan of `params` for removed layer ids.**
5. **One trash folder per removal**, holding paths in their project layout with `removed.json`, so
   a restore by hand is "copy the folder's contents back and restore the manifest backup it names".
6. **Hash assets and files another remaining layer names are never moved.**
7. **Job records leave `userData/jobs.json` only after the manifest save** (they cannot come back
   from the trash; the job folders can).
8. **Start over removes the old run only after the new run's first job started**, and a failed
   removal there does not stop the new run.
9. **Empty project trash lives in the Datasets footer and the library's project menu**: the
   founder said "project settings", and no per-project settings screen exists yet.
10. **Delete work files keeps using the recycle bin** (`shell.trashItem`), unchanged.
11. **Hub peers**: the removal syncs as a manifest edit; the files on peers are left to the sync
    layer's own clean-up. Worth a look when hubs are in daily use.

## Follow-ups

- **Restore** from `.trash/` in the app (reads `removed.json`).
- Removing single photos from a photos layer.
- A per-project settings screen to hold the trash action and other project settings.
