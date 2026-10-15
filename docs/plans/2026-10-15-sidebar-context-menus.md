# Right-click menus across the sidebar, and Align to: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every action in the Datasets sidebar is reachable by right-click (and Shift+F10 or the Menu key) from one shared action registry, every layer gains Rename, Zoom to, Export, Reveal in folder and Properties, marked rows and picked photo pins take one menu together, and Align to moves a far-off photo set onto a chosen layer with Undo.

**Architecture:** `packages/ui/src/actions/` holds the registry (`registerActions`, `actionsFor`) and one portalled `ContextMenu` built from it; the desktop app registers its actions per feature under `apps/desktop/src/renderer/shell/actions/` and the sidebar opens the menu for a `MenuTarget` (project, date, group, layers, photos, annotations). New main-process channels `layer:info`, `layer:export` and `layer:reveal` read and copy a layer's own files; `LayerPatch` gains `{ name }`. Align to is a pure plan (`builder/alignTo.ts`) written as `PhotoCorrection.offsetM` in one `orientation:write`, with its own Undo/Redo store and notice; readers that still used raw photo positions switch to corrected ones.

**Tech Stack:** TypeScript strict, React 19, zustand (vanilla stores), zod contracts in `@aio/schema`, three.js (engine), MapLibre (maps), Electron main IPC, vitest (jsdom for components), Playwright with Electron.

**Spec:** `docs/plans/2026-10-15-sidebar-context-menus-design.md` (approved, the source of truth). Read it first; this plan argues from it.

## Global Constraints

- Work only in `.claude/worktrees/sidebar-context-menus`, branch `feat/sidebar-context-menus`. Never touch the main checkout; never `git stash`; commit by path (`git add <paths>`, never `git add -A`).
- TypeScript strict, no `any`, no non-null assertions (tests included). Renderer code never imports `electron` or `node:*`; it talks to main through `bridge.call` (`window.aio`).
- Every user-facing string lives in `packages/ui/src/i18n/en.ts` (Task 2 adds them all). Plain words, sentence case, **no emoji, no em or en dashes**. No client, site, tester or person names anywhere (code, tests, commit subjects).
- Package ownership: `@aio/ui` owns the registry, `ContextMenu` and the tree rows; `@aio/schema` the contracts; `@aio/project` reading and copying layer files; `apps/desktop` (main and renderer) everything that wires features. A task touches only the packages its "Packages" line names.
- Contracts change only as listed in "Contract changes" (all additive); each row goes into `docs/architecture/contract-changes.md` with "pending founder review".
- Kept test ids (spec section 2): `date-menu`, `date-menu-<id>`, `date-more-<id>`, `move-menu`, `move-to-<id>`, `move-compare`, `menu-delete`, `compare-to-<id>`, `date-rename`. New: `ctx-menu`, `ctx-item-<actionId>`, `ctx-back`, `layer-rename`, `layer-props`, `align-to-notice`, `photo-picks`.
- Align to numbers live only in `builder/alignTo.ts`: eye height `1.6` m, implausible above ground `300` m, "Already in place" under `1` m (spec section 6).
- Local frame: X east, Y up, Z south, metres from the project origin (`docs/architecture/data-conventions.md` section 1).
- Heavy commands (`pnpm check`, demo builds, Playwright, commits) go through the shared one-at-a-time runner; Playwright with `--workers=1`; Electron windows stay off-screen (the e2e fixtures give every app an isolated `QUADRION_USER_DATA` profile). Scratch files live outside the worktree.
- Unit tests run from the worktree root: `pnpm vitest run <file>`. `pnpm check` runs once per batch, after its last commit.

## Review Focus

1. **Renaming a layer whose survey date comes from its name** ("Quad 2024-09-04" with no `capture`). Expected: the layer stays under its date after the rename. The rename first pins `capture` to the date the name gave it, then writes the name. Pinned in Task 16 (`commitLayerRename pins the date a name gave before renaming`).
2. **The tallest menu in the smallest window** (a date folder with a picked colour, a row with four dates under "File under", 1100 x 700). Expected: the whole menu and its last item stay in view; the existing `timeline.spec.ts` "menus stay in view" test holds unchanged. Pinned in Task 9 (`placeMenu keeps a tall menu inside the window`) and run in Task 22.
3. **Ctrl+Z while the Align to notice shows and an issue edit is also undoable.** Expected: Ctrl+Z undoes the alignment only (the notice handler runs first in the capture phase and stops the key); with no notice, Ctrl+Z goes to whoever had it before. Pinned in Task 13 (`Ctrl+Z undoes the alignment and stops the key`).
4. **Export into a folder that already holds a folder of that layer's name, or two layers with the same name in one export.** Expected: nothing is overwritten; the existing one is skipped and named in the note; the second same-named layer goes to `<name> (<layer id>)`. Pinned in Task 12 (`refuses to overwrite and keeps same-named layers apart`).
5. **Align to with photos that have no position, or a target whose position is unknown.** Expected: photos without a position are skipped and counted in the notice; a target without bounds says so in a note and writes nothing; all photos without a position: the item is greyed with its reason. Pinned in Task 6 (`skips photos without a position`) and Task 13 (`a target without bounds writes nothing`).
6. **Right-click on an unmarked row while others are marked.** Expected: the menu acts on that row alone and the marks stay. Pinned in Task 18 (`rowTarget: an unmarked row alone, marks untouched`).

---

## Spec ambiguities resolved

- **Move to date stays an inline list** under a "File under" heading (as today), not a flyout: the kept tests click `move-to-<id>` straight after the menu opens. Compare with, Align to, Colour by and Exports are submenus that replace the menu's items with a Back item (`ctx-back`), as Compare with does today, so `menu.getByTestId('compare-to-...')` still finds them inside `move-menu`. Right opens a submenu, Left and Escape go back.
- **Colour and icon of a date** are rows of picks inside the menu (`present: 'picks'`); a pick keeps the menu open, as today.
- **Disabled items** use `aria-disabled="true"` with the reason as `title` (Playwright's `toBeDisabled` and screen readers both see it; a native `disabled` button shows no tooltip in Chromium).
- **`MenuTarget` gains `{ kind: 'annotations'; row: 'issues' | 'drafts' }`**: the spec's table gives Issues and Drafts rows Open and Show/Hide, but its union had no target for rows without a layer. Show/Hide there toggles the issue pins.
- **Multi header** says "3 datasets" (the sidebar's word) rather than "3 layers".
- **Reveal in folder needs a channel**: the renderer may not name paths, so a third new IPC `layer:reveal { projectId, layerId }` is added (main finds the main file).
- **Export progress and cancel reuse `export:progress` and `export:cancel`** with the job id the renderer sends (`layer:export` takes `projectId` and `jobId` too), so the existing toast shows progress and Cancel without a new event. A cancelled layer's half-written folder is removed; finished layers stay.
- **Packages** (`.aio`): Export and Reveal are greyed ("This is a package: its files stay inside it."); `layer:info` answers with a failure and Properties shows the manifest fields with "Not known" for files and size.
- **Import time** is the main file's creation time on disk (layers carry no import time).
- **Zoom to for COG and PMTiles rasters and GeoJSON vectors** reads their bounds in main (`layer:info.extent`): the GeoTIFF tags of the first directory (project CRS only), the PMTiles v3 header, the GeoJSON coordinates. `builder:layerExtents` keeps its kinds, so the far-content check sees what it always saw (photos aside, now corrected).
- **Drawings and walks**: a drawing's bounds are its plan raster's corners; a walk's are its pins set on the model (`@model`, `[x, z]` with `y`); pins on a drawing are not used. `designsStore.layerBounds` serves survey design layers, which have no sidebar row: not used here.
- **DSM height for Align to**: when a DSM layer's bounds cover the target centre, `g` is the first hit of a ray straight down at the target centre in the 3D scene; otherwise the target bounds' minimum Y.
- **Box select of photo pins is Alt+drag** in 3D and on the map (Shift+drag is the map's box zoom; Ctrl and Shift drags pan the 3D view). A drag under 5 px stays an Alt+click (map: move the 3D camera there).
- **framesModel and spotEntries already read corrected positions** (`photoPose` with the correction, `FramesPane.tsx` line 211, `useSpotEntries.ts` line 111). Task 8 pins that with a test and changes `packages/ai/src/places.ts` only.

## Infeasible or deferred

- Nothing in the spec is infeasible. Two narrowings: a COG in another CRS than the project's has no Zoom to bounds (greyed: "Where X lies is not known."), and video clips have no bounds (their flight file is not read in main), so Zoom to on a clip says the same.

---

## File map

| File                                                                                                                                                                    | Task | Responsibility                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/actions/types.ts`                                                                                                                                      | 1    | `MenuTarget`, `Action`, `ActionCtx`, `ActionHost`, `SubItem`, `ResolvedItem`, `SECTION_ORDER`                 |
| `packages/ui/src/actions/registry.ts` (+ test)                                                                                                                          | 1    | `registerActions`, `defineAction`, `actionsFor`, `targetCount`, `targetLayers`, `everyLayer`, `makeActionCtx` |
| `packages/ui/src/actions/index.ts`                                                                                                                                      | 1, 9 | barrel                                                                                                        |
| `packages/ui/src/i18n/en.ts`, `packages/ui/src/shortcuts.ts` (+ test)                                                                                                   | 2    | every new string; `tree` shortcut scope                                                                       |
| `packages/schema/src/layerInfo.ts` (+ test), `builder.ts`, `ipc.ts`, `index.ts`                                                                                         | 3    | `LayerInfo`, `LayerPatch { name }`, `layer:info`, `layer:export`, `layer:reveal`                              |
| `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/journal.ts`                                                                                                 | 3    | the new channels exist and are reads                                                                          |
| `docs/architecture/contract-changes.md`                                                                                                                                 | 3    | four rows                                                                                                     |
| `packages/project/src/builder/extents.ts`, `tiff.ts` (+ tests)                                                                                                          | 4    | corrected photo extents; `fullLayerExtent` for more kinds                                                     |
| `packages/workspace/src/index.ts`, `packages/engine/src/stage/layerBox.ts` (+ test), `Stage.ts` (+ test), `packages/maps/src/controller.ts`                             | 5    | camera frames a box and a layer selection                                                                     |
| `apps/desktop/src/renderer/builder/alignTo.ts` (+ test)                                                                                                                 | 6    | Align to maths                                                                                                |
| `apps/desktop/src/renderer/shell/layerBounds.ts`, `appBounds.ts` (+ tests)                                                                                              | 7    | `layerBounds`, app deps, ground at a point                                                                    |
| `packages/ai/src/places.ts`, `places.test.ts`; `workspace/spot/spotEntries.test.ts`                                                                                     | 8    | readers use corrected positions                                                                               |
| `packages/ui/src/actions/ContextMenu.tsx` (+ test)                                                                                                                      | 9    | the menu                                                                                                      |
| `packages/ui/src/tree/RenameField.tsx`, `DatasetTree.tsx`, `DateTree.tsx` (+ tests), `packages/ui/src/index.ts`                                                         | 10   | inline rename, menu keys, row strings                                                                         |
| `packages/project/src/builder/create.ts`, `rename.test.ts`                                                                                                              | 11   | the writer takes `{ name }`                                                                                   |
| `packages/project/src/builder/layerFiles.ts` (+ test), `builder/index.ts`; `apps/desktop/src/main/layers.ts` (+ test), `main/index.ts`                                  | 12   | info, export, reveal in main                                                                                  |
| `apps/desktop/src/renderer/builder/alignToStore.ts` (+ test), `AlignToNotice.tsx`, `alignSession.ts`, `exports/Toasts.tsx`                                              | 13   | Align to store, notice, Undo/Redo                                                                             |
| `apps/desktop/src/renderer/shell/LayerProperties.tsx` (+ test), `layerInfo.ts`, `renameRequest.ts`, `App.tsx`                                                           | 14   | Properties dialog                                                                                             |
| `apps/desktop/src/renderer/shell/actions/projectActions.ts`, `dateActions.tsx` (+ tests)                                                                                | 15   | project, date and group-add actions                                                                           |
| `apps/desktop/src/renderer/shell/actions/layerActions.tsx` (+ test)                                                                                                     | 16   | the common layer and group set                                                                                |
| `apps/desktop/src/renderer/shell/actions/kindActions.tsx` (+ test); `builder/PhotoMenu.tsx`, `panos/PanoSphereRows.tsx` (one export each)                               | 17   | per-kind actions                                                                                              |
| `apps/desktop/src/renderer/shell/Sidebar.tsx`, `DateMenus.tsx` (+ test), `menuTargets.ts` (+ test), `shell/actions/index.ts`, `builder/builder.css`, `Sidebar.test.tsx` | 18   | wiring, multi-select                                                                                          |
| `apps/desktop/src/renderer/builder/photoPicks.ts`, `photoBox.ts` (+ tests), `PhotoPickInput.tsx`, `PhotoMenu.tsx`, `BuilderLayer.tsx`, `exports/Toasts.tsx`             | 19   | photo pin multi-pick                                                                                          |
| `apps/desktop/src/renderer/builder/FarContentNotice.tsx`                                                                                                                | 20   | "Align to..." on the far-content notice                                                                       |
| `apps/desktop/e2e/sidebar-menus.spec.ts`, `sidebar-multi.spec.ts`                                                                                                       | 21   | e2e                                                                                                           |
| `apps/desktop/e2e/align-to.spec.ts`, `layer-export.spec.ts`                                                                                                             | 22   | e2e                                                                                                           |
| port of cleanup items (conditional)                                                                                                                                     | 23   |                                                                                                               |

## Execution DAG

```
A: T1 registry ─┬─────────────> B: T9 ContextMenu ─────────────┐
   T2 strings ──┼─> T9, T10 tree rows, T13, T14 ───────────────┤
   T3 contracts ┼─> T11 rename writer, T12 main IPC, T14 ──────┤
   T4 extents ──┴─> T12                                         ├─> C: T15 project+date ─┐
   T5 camera box ───────────────────────────────────────────────┤      T16 layer common ─┼─> D: T18 sidebar wiring ─┬─> E: T21 e2e menus ─┐
   T6 align maths ─> T13 align store + notice ──────────────────┤      T17 per kind ─────┘      T19 photo picks ───┼─> E: T22 e2e align/export ┼─> F: T24 verify
   T7 layerBounds ─> T13, T15, T16, T17 ────────────────────────┘                               T20 far notice ────┘   T23 cleanup port (if) ──┘
   T8 readers (places) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────> T24
```

| Batch | Tasks (dispatch together, one message) | Needs                                                                       | Packages touched                                                                                                                                                                                                                                               |
| ----- | -------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | T1, T2, T3, T4, T5, T6, T7, T8         | nothing                                                                     | T1, T2: `@aio/ui`; T3: `@aio/schema`, desktop preload and main `journal.ts`, docs; T4: `@aio/project`, desktop main `builder.ts`; T5: `@aio/workspace`, `@aio/engine`, `@aio/maps`; T6, T7: desktop renderer (new files); T8: `@aio/ai`, desktop renderer test |
| B     | T9, T10, T11, T12, T13, T14            | T9: T1, T2; T10: T2; T11: T3; T12: T3, T4; T13: T2, T6, T7; T14: T2, T3, T7 | T9: `@aio/ui` actions; T10: `@aio/ui` tree and index; T11: `@aio/project` `create.ts`; T12: `@aio/project` new file and index, desktop main; T13: desktop renderer `builder/`, `exports/Toasts.tsx`; T14: desktop renderer `shell/`, `App.tsx`                 |
| C     | T15, T16, T17                          | all: T1, T2, T7; T15: T5, T14; T16: T3, T5, T12, T14; T17: T13              | desktop renderer `shell/actions/` (one file each); T17 also one export line in `PhotoMenu.tsx` and `PanoSphereRows.tsx`                                                                                                                                        |
| D     | T18, T19, T20                          | T18: T9, T10, T11, T15, T16, T17; T19: T9, T13, T17; T20: T9, T13, T17      | T18: desktop renderer `shell/`, `builder/builder.css`; T19: desktop renderer `builder/` and `exports/Toasts.tsx`; T20: `builder/FarContentNotice.tsx`                                                                                                          |
| E     | T21, T22, T23                          | T21: T18; T22: T18, T19, T20; T23: T18 and the rebase                       | `apps/desktop/e2e`; T23: the files the cleanup branch added to                                                                                                                                                                                                 |
| F     | T24                                    | everything                                                                  | none (runs only)                                                                                                                                                                                                                                               |

No two tasks of a batch share a file. **Shared files and who owns them:** `en.ts` and `shortcuts.ts`: Task 2 only (every key of the plan, under one comment block at the end of the catalogue; Task 23 adds the ported cleanup keys after the rebase, alone in its batch for that file). `packages/ui/src/index.ts`: Task 1 adds `export * from './actions'` (batch A), Task 10 adds the tree exports (batch B); Task 9 exports through `actions/index.ts`. `ipc.ts`, preload, `journal.ts`, `contract-changes.md`: Task 3 only. `Sidebar.tsx`, `DateMenus.tsx`: Task 18 only. `exports/Toasts.tsx`: Task 13 (batch B) and Task 19 (batch D). `PhotoMenu.tsx`: Task 17 (one `export` keyword, batch C) and Task 19 (batch D). `alignSession.ts`: Task 13 only. `App.tsx`: Task 14 only.

**Critical path:** T2 (strings) or T1 (registry) → T9 ContextMenu and T14 Properties → T16 common layer actions → T18 sidebar wiring → T22 e2e → T24 verify: six batches. Sizes: S = T1, T5, T8, T11, T20, T23; M = T2, T3, T4, T6, T7, T9, T10, T13, T14, T15, T17, T19, T21; L = T12, T16, T18, T22, T24.

Subagents of a batch write and unit-test in parallel; each commits through the runner; `pnpm check` runs once after a batch's last commit. Tasks 21 and 22 are written in parallel and run one after the other.

## Tests and e2e at a glance

| Task | Unit and component tests                                                                | e2e                                                                                                                                             | Contract                          |
| ---- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1    | `actions/registry.test.ts`                                                              |                                                                                                                                                 | none                              |
| 2    | `shortcuts.test.ts`, existing `i18n.test.ts`                                            |                                                                                                                                                 | none                              |
| 3    | `schema/src/layerInfo.test.ts`                                                          |                                                                                                                                                 | rows 1 to 3                       |
| 4    | `extents.test.ts`, `tiff.test.ts`, `main/builder.test.ts`                               |                                                                                                                                                 | row 4                             |
| 5    | `engine/stage/layerBox.test.ts`, `Stage.test.ts`                                        |                                                                                                                                                 | none (workspace type, not schema) |
| 6    | `builder/alignTo.test.ts`                                                               |                                                                                                                                                 | none                              |
| 7    | `shell/layerBounds.test.ts`, `shell/appBounds.test.ts`                                  |                                                                                                                                                 | none                              |
| 8    | `ai/src/places.test.ts`, `spot/spotEntries.test.ts`                                     |                                                                                                                                                 | none                              |
| 9    | `actions/ContextMenu.test.tsx`                                                          |                                                                                                                                                 | none                              |
| 10   | `tree/RenameField.test.tsx`, `tree/menuKeys.test.tsx`, existing tree tests              |                                                                                                                                                 | none                              |
| 11   | `builder/rename.test.ts`                                                                |                                                                                                                                                 | row 1                             |
| 12   | `builder/layerFiles.test.ts`, `main/layers.test.ts`                                     |                                                                                                                                                 | rows 2, 3                         |
| 13   | `builder/alignToStore.test.ts`, `builder/AlignToNotice.test.tsx`                        |                                                                                                                                                 | none                              |
| 14   | `shell/LayerProperties.test.tsx`                                                        |                                                                                                                                                 | none                              |
| 15   | `shell/actions/projectActions.test.ts`, `dateActions.test.ts`                           |                                                                                                                                                 | none                              |
| 16   | `shell/actions/layerActions.test.ts`                                                    |                                                                                                                                                 | none                              |
| 17   | `shell/actions/kindActions.test.ts`                                                     |                                                                                                                                                 | none                              |
| 18   | `shell/menuTargets.test.ts`, `shell/DateMenus.test.tsx` (rewritten), `Sidebar.test.tsx` |                                                                                                                                                 | none                              |
| 19   | `builder/photoPicks.test.ts`, `builder/photoBox.test.ts`                                |                                                                                                                                                 | none                              |
| 20   | `builder/FarContentNotice.test.tsx`                                                     |                                                                                                                                                 | none                              |
| 21   |                                                                                         | new `sidebar-menus.spec.ts`, `sidebar-multi.spec.ts`                                                                                            |                                   |
| 22   |                                                                                         | new `align-to.spec.ts`, `layer-export.spec.ts`                                                                                                  |                                   |
| 24   | `pnpm check`                                                                            | the four new specs, plus `timeline`, `delete-and-start-over`, `compare`, `pano-compare`, `survey-dates-add`, `photo-align`, unchanged and green |                                   |

## Contract changes

Task 3 adds these rows to the end of the table in `docs/architecture/contract-changes.md` (columns `| Date | Change | Why | Streams affected | Approved by |`):

```markdown
| 2026-10-15 | `LayerPatch` gains `{ name: string }` (trimmed, 1 to 120 characters): `builder:updateLayers` renames any layer kind; the project writer changes `name` only, nothing else of the layer and no file | Rename a dataset from its right-click menu or F2 (sidebar context menus) | `@aio/schema`, `@aio/project`, desktop renderer | pending founder review |
| 2026-10-15 | New IPC `layer:export { projectId, jobId, layerIds, dir } -> { ok: true, written, skipped, cancelled }`: copies each layer's own files unchanged into `<dir>/<layer name>/`, plus `<layer name>.crs.json` (`schema: 'aio.layer-crs/1'`, `crs`, `origin`, the layer's `transform` or `corners`) for layers in the local frame; refuses to overwrite a folder that is already there (its layer is named in `skipped`); progress arrives on the existing `export:progress` event with the request's `jobId`, and the existing `export:cancel` cancels it; refused for a package | Export a dataset from its right-click menu | `@aio/schema`, `@aio/project`, desktop main and renderer | pending founder review |
| 2026-10-15 | New IPC `layer:info { projectId, layerId } -> { ok: true, info: LayerInfo }` (`files` with sizes, `bytes`, `count` and `countKind`, `extent` in the local frame, `crs`, `importedAt` from the main file's creation time, `mainFile`) and `layer:reveal { projectId, layerId } -> OkOrFailure` (main shows the layer's main file in the file manager; the renderer never names a path) | Properties dialog, Reveal in folder, Zoom to for rasters and vectors | `@aio/schema`, `@aio/project`, desktop main and renderer | pending founder review |
| 2026-10-15 | `builder:layerExtents`: a photos layer's extent reads each photo's position with its hand correction (`orientation.json` `offsetM`), as every view draws it. No shape change | Align to moves photos by corrections; the placement check must see them where they are drawn | `@aio/project`, desktop main | pending founder review |
```

---

## Tasks

### Task 1: Action registry

**Packages:** `@aio/ui`

**Files:**

- Create: `packages/ui/src/actions/types.ts`
- Create: `packages/ui/src/actions/registry.ts`
- Create: `packages/ui/src/actions/index.ts`
- Modify: `packages/ui/src/index.ts` (one line at the end: `export * from './actions';`)
- Test: `packages/ui/src/actions/registry.test.ts`

**Interfaces:**

- Consumes: `Layer`, `ProjectManifest`, `ToolRisk` (`@aio/schema`); `DateTag` (`@aio/workspace`); `t`, `MessageKey`, `Vars` (`../i18n`); `IconName`; `ShortcutId`, `shortcutHint` (`../shortcuts`); `TreeGroupKind` (`../tree/model`).
- Produces (later tasks rely on these exact names):
  - `type MenuTarget = { kind: 'project' } | { kind: 'date'; captureId: string | null } | { kind: 'group'; group: TreeGroupKind; layerIds: string[]; captureId?: string | null } | { kind: 'layers'; layerIds: string[] } | { kind: 'photos'; picks: PhotoPick[] } | { kind: 'annotations'; row: 'issues' | 'drafts' }`; `interface PhotoPick { layerId: string; photoId: string }`
  - `type ActionSection = 'open' | 'view' | 'edit' | 'compare' | 'file' | 'danger'`; `const SECTION_ORDER: readonly ActionSection[]`
  - `interface ActionHost { note(text: string, danger?: boolean): void; renameDate(captureId: string): void; moveLayers(layerIds: string[], capture: string | null): void; askUnplace(layerId: string): void; emptyTrash(): void; toggle?: (() => void) | undefined; expanded?: boolean | undefined; from?: string | undefined }`; `const NO_HOST: ActionHost`
  - `interface ActionCtx { manifest: ProjectManifest; hidden: Readonly<Record<string, true>>; canEdit: boolean; pkg: boolean; datesOn: boolean; focus: string | null; tags: Readonly<Record<string, DateTag>>; folderLayers: Readonly<Record<string, readonly string[]>>; trashEntries: number; drafts: number; host: ActionHost }`
  - `interface SubItem { id: string; label: string; disabled?: string | false; checked?: boolean; group?: string; swatch?: string; icon?: IconName; testId?: string; after?: (close: () => void) => ReactNode }`
  - `interface Action<T extends MenuTarget = MenuTarget>` (fields below)
  - `interface ResolvedItem { id: string; label: string; icon?: IconName; section: ActionSection; disabled: string | false; shortcut: string | null; testId: string; present: 'action' | 'submenu' | 'inline' | 'picks'; sub: SubItem[]; subTitle: string | null; run(sub?: string): void }`
  - `registerActions(actions: readonly Action[]): () => void` (same id replaces; returns the unregister)
  - `defineAction<K extends MenuTarget['kind']>(a: Action<Extract<MenuTarget, { kind: K }>> & { targets: readonly K[] }): Action`
  - `actionsFor(target: MenuTarget, ctx: ActionCtx): ResolvedItem[]` (sorted by section, then registration order)
  - `targetCount(t: MenuTarget): number`, `targetLayers(t: MenuTarget, ctx: ActionCtx): Layer[]`, `everyLayer(t: MenuTarget, ctx: ActionCtx, pred: (l: Layer) => boolean): boolean`
  - `makeActionCtx(input: { manifest: ProjectManifest } & Partial<ActionCtx>): ActionCtx`

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/actions/registry.test.ts
import type { ProjectManifest } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  actionsFor,
  defineAction,
  everyLayer,
  makeActionCtx,
  registerActions,
  targetCount,
  type Action,
} from '.';

const manifest = {
  captures: [{ id: 'c1', label: 'c1', date: '2026-01-01' }],
  layers: [
    { kind: 'mesh', id: 'm', name: 'Model', visible: true, src: { path: 'm.glb' }, transform: [] },
    { kind: 'photos', id: 'p', name: 'Photos', visible: true, items: [] },
    { kind: 'photos', id: 'q', name: 'More photos', visible: true, items: [] },
  ],
} as unknown as ProjectManifest;
const ctx = makeActionCtx({ manifest });

let off: (() => void)[] = [];
const reg = (...a: Action[]) => {
  off.push(registerActions(a));
};
afterEach(() => {
  for (const f of off) f();
  off = [];
});

const act = (id: string, over: Partial<Action> = {}): Action => ({
  id,
  label: () => id,
  section: 'view',
  targets: ['layers'],
  run: () => undefined,
  ...over,
});

describe('actionsFor', () => {
  it('offers an action only on the target kinds it names', () => {
    reg(
      act('a'),
      defineAction({
        id: 'b',
        label: () => 'b',
        section: 'view',
        targets: ['project'],
        run: () => undefined,
      }),
    );
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx).map((i) => i.id)).toEqual(['a']);
    expect(actionsFor({ kind: 'project' }, ctx).map((i) => i.id)).toEqual(['b']);
  });

  it('offers only multi actions when the target holds several items', () => {
    reg(act('one'), act('many', { multi: true }));
    expect(actionsFor({ kind: 'layers', layerIds: ['m', 'p'] }, ctx).map((i) => i.id)).toEqual([
      'many',
    ]);
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx).map((i) => i.id)).toEqual([
      'one',
      'many',
    ]);
    expect(
      targetCount({
        kind: 'photos',
        picks: [
          { layerId: 'p', photoId: 'a' },
          { layerId: 'p', photoId: 'a' },
        ],
      }),
    ).toBe(1);
  });

  it('shows an action on mixed kinds only when it applies to every layer', () => {
    reg(
      act('photosOnly', {
        multi: true,
        appliesTo: (t, c) => everyLayer(t, c, (l) => l.kind === 'photos'),
      }),
    );
    expect(actionsFor({ kind: 'layers', layerIds: ['p', 'q'] }, ctx)).toHaveLength(1);
    expect(actionsFor({ kind: 'layers', layerIds: ['p', 'm'] }, ctx)).toHaveLength(0);
  });

  it('greys a disabled action with its reason and does not run it', () => {
    const run = vi.fn();
    reg(act('d', { disabled: () => 'Not here.', run }));
    const [item] = actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx);
    expect(item?.disabled).toBe('Not here.');
    item?.run();
    expect(run).not.toHaveBeenCalled();
  });

  it('sorts by section, then by registration order', () => {
    reg(
      act('del', { section: 'danger' }),
      act('z', { section: 'view' }),
      act('o', { section: 'open' }),
      act('y', { section: 'view' }),
    );
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx).map((i) => i.id)).toEqual([
      'o',
      'z',
      'y',
      'del',
    ]);
  });

  it('replaces an action registered again under the same id, and unregisters', () => {
    reg(act('x', { label: () => 'first' }));
    const undo = registerActions([act('x', { label: () => 'second' })]);
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx).map((i) => i.label)).toEqual([
      'second',
    ]);
    undo();
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx)).toEqual([]);
  });

  it('runs with the target, the context and the picked sub item; a failed run notes', async () => {
    const note = vi.fn();
    const c = makeActionCtx({ manifest, host: { ...ctx.host, note } });
    const run = vi.fn((_t: unknown, _c: unknown, sub?: string) => {
      if (sub === 'bad') return Promise.reject(new Error('Broken.'));
      return undefined;
    });
    reg(
      act('s', {
        run,
        submenu: () => [
          { id: 'ok', label: 'OK' },
          { id: 'bad', label: 'Bad' },
        ],
      }),
    );
    const [item] = actionsFor({ kind: 'layers', layerIds: ['m'] }, c);
    expect(item?.present).toBe('submenu');
    item?.run('ok');
    expect(run).toHaveBeenCalledWith({ kind: 'layers', layerIds: ['m'] }, c, 'ok');
    item?.run('bad');
    await vi.waitFor(() => {
      expect(note).toHaveBeenCalledWith('Broken.', true);
    });
  });

  it('gives the default test id, or the kept one', () => {
    reg(act('k'), act('legacy', { testId: 'menu-delete' }));
    const [k, legacy] = actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx);
    expect(k?.testId).toBe('ctx-item-k');
    expect(k?.shortcut).toBeNull();
    expect(legacy?.testId).toBe('menu-delete');
  });

  it('runs at once (a pick saves before the menu redraws)', () => {
    const run = vi.fn();
    reg(act('now', { run }));
    actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx)[0]?.run();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
```

(The shortcut text of an item is checked in Task 16, where `layer.rename` carries `tree.rename` from Task 2.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/src/actions/registry.test.ts`
Expected: FAIL, cannot resolve `.` (no `actions/index.ts`).

- [ ] **Step 3: Write the types**

```ts
// packages/ui/src/actions/types.ts
import type { Layer, ProjectManifest, ToolRisk } from '@aio/schema';
import type { DateTag } from '@aio/workspace';
import type { ReactNode } from 'react';
import type { MessageKey } from '../i18n';
import type { IconName } from '../icons/Icon';
import type { ShortcutId } from '../shortcuts';
import type { TreeGroupKind } from '../tree/model';

/*
 * The right-click menus of the app as one registry (spec section 1): a feature registers what it
 * can do on a target, the menu asks `actionsFor` what to show. Palette and agent stay as they are
 * for now; `risk`, `input` and `surfaces` are reserved for the agent-coverage plan.
 */

export interface PhotoPick {
  layerId: string;
  photoId: string;
}

export type MenuTarget =
  | { kind: 'project' }
  /** null: the Every date folder. */
  | { kind: 'date'; captureId: string | null }
  | { kind: 'group'; group: TreeGroupKind; layerIds: string[]; captureId?: string | null }
  /** One row, or the marked rows. */
  | { kind: 'layers'; layerIds: string[] }
  | { kind: 'photos'; picks: PhotoPick[] }
  /** The Issues and Drafts rows of the Annotations group (they carry no layer). */
  | { kind: 'annotations'; row: 'issues' | 'drafts' };

export type ActionSection = 'open' | 'view' | 'edit' | 'compare' | 'file' | 'danger';
export const SECTION_ORDER: readonly ActionSection[] = [
  'open',
  'view',
  'edit',
  'compare',
  'file',
  'danger',
];

/** What the surface that opened the menu does for the actions (the Datasets list). */
export interface ActionHost {
  /** A short line where the surface shows notes (the Datasets note). */
  note(text: string, danger?: boolean): void;
  /** Show the name field of a survey date folder. */
  renameDate(captureId: string): void;
  /** File layers under a date (null: none), with the surface's notes and Undo. */
  moveLayers(layerIds: string[], capture: string | null): void;
  /** Ask in the row before a walk's placement is removed. */
  askUnplace(layerId: string): void;
  /** Ask before the project trash is emptied. */
  emptyTrash(): void;
  /** Open or close the folder or group the menu was opened on. */
  toggle?: (() => void) | undefined;
  expanded?: boolean | undefined;
  /** The folder the row or group sits in: `EVERY_DATE` or a capture id. */
  from?: string | undefined;
}

export const NO_HOST: ActionHost = {
  note: () => undefined,
  renameDate: () => undefined,
  moveLayers: () => undefined,
  askUnplace: () => undefined,
  emptyTrash: () => undefined,
};

/** What the predicates read and the runs call; the app builds it once per menu. */
export interface ActionCtx {
  manifest: ProjectManifest;
  hidden: Readonly<Record<string, true>>;
  /** False in a package and for a reviewer who may only look. */
  canEdit: boolean;
  /** A package (.aio): read-only, and its files stay inside it. */
  pkg: boolean;
  /** Survey dates are on (the sidebar shows date folders). */
  datesOn: boolean;
  /** The focused survey date. */
  focus: string | null;
  tags: Readonly<Record<string, DateTag>>;
  /** The layer ids of each date folder (`EVERY_DATE` and capture ids). */
  folderLayers: Readonly<Record<string, readonly string[]>>;
  /** Entries in the project trash. */
  trashEntries: number;
  drafts: number;
  host: ActionHost;
}

export interface SubItem {
  id: string;
  label: string;
  /** Why it cannot be picked; false or absent when it can. */
  disabled?: string | false;
  /** A pick or a radio item that is the current choice. */
  checked?: boolean;
  /** A heading drawn above this item when it differs from the item before. */
  group?: string;
  /** A CSS colour for a small square before the label (dates). */
  swatch?: string;
  icon?: IconName;
  testId?: string;
  /** Rows drawn under the item (Compare with: the rows other features add). */
  after?: (close: () => void) => ReactNode;
}

export interface Action<T extends MenuTarget = MenuTarget> {
  /** `layer.rename`, `photos.alignTo`. */
  id: string;
  label: MessageKey | ((t: T, ctx: ActionCtx) => string);
  icon?: IconName;
  section: ActionSection;
  targets: readonly T['kind'][];
  /** Offered when the target holds several items (marked rows, picked photos). */
  multi?: boolean;
  appliesTo?(t: T, ctx: ActionCtx): boolean;
  /** The reason shown as the tooltip of a greyed item, or false. */
  disabled?(t: T, ctx: ActionCtx): string | false;
  shortcut?: ShortcutId;
  /** How the sub items show: a view that replaces the items (default), a list under a heading, a row of picks. */
  present?: 'submenu' | 'inline' | 'picks';
  submenu?(t: T, ctx: ActionCtx): SubItem[];
  submenuTitle?(t: T, ctx: ActionCtx): string;
  /** A kept test id (`menu-delete`); default `ctx-item-<id>`. */
  testId?: string;
  run(t: T, ctx: ActionCtx, sub?: string): void | Promise<void>;
  risk?: ToolRisk;
  input?: { safeParse(value: unknown): { success: boolean } };
  surfaces?: readonly ('menu' | 'palette' | 'agent')[];
}

export interface ResolvedItem {
  id: string;
  label: string;
  icon?: IconName;
  section: ActionSection;
  disabled: string | false;
  /** The first combo of the action's shortcut as people read it, or null. */
  shortcut: string | null;
  testId: string;
  present: 'action' | 'submenu' | 'inline' | 'picks';
  sub: SubItem[];
  subTitle: string | null;
  run(sub?: string): void;
}

export type { Layer };
```

- [ ] **Step 4: Write the registry and the barrel**

```ts
// packages/ui/src/actions/registry.ts
import type { Layer, ProjectManifest } from '@aio/schema';
import { t as translate } from '../i18n';
import { shortcutHint } from '../shortcuts';
import {
  NO_HOST,
  SECTION_ORDER,
  type Action,
  type ActionCtx,
  type MenuTarget,
  type ResolvedItem,
} from './types';

const registered: Action[] = [];

/** Add actions (an id registered before is replaced in place); returns the unregister. */
export function registerActions(actions: readonly Action[]): () => void {
  for (const a of actions) {
    const at = registered.findIndex((r) => r.id === a.id);
    if (at >= 0) registered.splice(at, 1, a);
    else registered.push(a);
  }
  return () => {
    for (const a of actions) {
      const at = registered.indexOf(a);
      if (at >= 0) registered.splice(at, 1);
    }
  };
}

/** Type an action against the target kinds it names; the registry holds it as a plain `Action`. */
export function defineAction<K extends MenuTarget['kind']>(
  a: Action<Extract<MenuTarget, { kind: K }>> & { targets: readonly K[] },
): Action {
  return a as unknown as Action;
}

/** How many items a target holds: layers, distinct photos; one for anything else. */
export function targetCount(t: MenuTarget): number {
  if (t.kind === 'layers') return t.layerIds.length;
  if (t.kind === 'photos') return new Set(t.picks.map((p) => `${p.layerId}\n${p.photoId}`)).size;
  return 1;
}

/** The manifest layers a target names (a photos target: the sets its photos belong to). */
export function targetLayers(t: MenuTarget, ctx: ActionCtx): Layer[] {
  const ids =
    t.kind === 'layers' || t.kind === 'group'
      ? t.layerIds
      : t.kind === 'photos'
        ? [...new Set(t.picks.map((p) => p.layerId))]
        : [];
  return ids.flatMap((id) => {
    const l = ctx.manifest.layers.find((x) => x.id === id);
    return l ? [l] : [];
  });
}

/** True when the target names layers and `pred` holds for every one of them. */
export function everyLayer(t: MenuTarget, ctx: ActionCtx, pred: (l: Layer) => boolean): boolean {
  const ls = targetLayers(t, ctx);
  return ls.length > 0 && ls.every(pred);
}

/** The items of a menu on `target`: sorted by section, then by registration order. */
export function actionsFor(target: MenuTarget, ctx: ActionCtx): ResolvedItem[] {
  const many = targetCount(target) > 1;
  const order = new Map<ResolvedItem, number>();
  const out: ResolvedItem[] = [];
  registered.forEach((a, i) => {
    if (!a.targets.includes(target.kind)) return;
    if (many && a.multi !== true) return;
    if (a.appliesTo && !a.appliesTo(target, ctx)) return;
    const disabled = a.disabled?.(target, ctx) ?? false;
    const item: ResolvedItem = {
      id: a.id,
      label: typeof a.label === 'function' ? a.label(target, ctx) : translate(a.label),
      ...(a.icon ? { icon: a.icon } : {}),
      section: a.section,
      disabled,
      shortcut: a.shortcut ? shortcutHint(a.shortcut) : null,
      testId: a.testId ?? `ctx-item-${a.id}`,
      present: a.submenu ? (a.present ?? 'submenu') : 'action',
      sub: a.submenu?.(target, ctx) ?? [],
      subTitle: a.submenuTitle?.(target, ctx) ?? null,
      run: (sub) => {
        if (disabled !== false) return;
        const fail = (e: unknown) => {
          ctx.host.note(e instanceof Error ? e.message : String(e), true);
        };
        try {
          const r = a.run(target, ctx, sub);
          if (r instanceof Promise) r.catch(fail);
        } catch (e) {
          fail(e);
        }
      },
    };
    order.set(item, i);
    out.push(item);
  });
  const rank = (x: ResolvedItem) => SECTION_ORDER.indexOf(x.section);
  return out.sort((x, y) => rank(x) - rank(y) || (order.get(x) ?? 0) - (order.get(y) ?? 0));
}

/** A full context from the fields a caller knows; the rest take neutral defaults. */
export function makeActionCtx(
  input: { manifest: ProjectManifest } & Partial<ActionCtx>,
): ActionCtx {
  return {
    hidden: {},
    canEdit: true,
    pkg: false,
    datesOn: true,
    focus: null,
    tags: {},
    folderLayers: {},
    trashEntries: 0,
    drafts: 0,
    host: NO_HOST,
    ...input,
  };
}
```

```ts
// packages/ui/src/actions/index.ts
export * from './types';
export * from './registry';
```

Add at the end of `packages/ui/src/index.ts`:

```ts
export * from './actions';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/ui/src/actions/registry.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/actions/types.ts packages/ui/src/actions/registry.ts packages/ui/src/actions/index.ts packages/ui/src/actions/registry.test.ts packages/ui/src/index.ts
git commit -m "feat(ui): action registry for right-click menus" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Strings and the Datasets shortcuts

**Packages:** `@aio/ui`

**Files:**

- Modify: `packages/ui/src/i18n/en.ts` (one block before `} as const satisfies Record<string, string>;`)
- Modify: `packages/ui/src/shortcuts.ts` (`ShortcutScope`, `SHORTCUT_SCOPES`, `SHORTCUTS`, `NAMED`, `ARIA`)
- Test: `packages/ui/src/shortcuts.test.ts` (new case), existing `packages/ui/src/i18n/i18n.test.ts` stays green

**Interfaces:**

- Produces: every `MessageKey` below, used by Tasks 9 to 22 under exactly these names; `ShortcutId`s `tree.menu`, `tree.rename`, `tree.delete`, `tree.mark`, `tree.extend` in scope `tree`; named keys `F2`, `F10`, `Menu` (`ContextMenu`).

- [ ] **Step 1: Write the failing test** (append to `shortcuts.test.ts`)

```ts
describe('the Datasets list keys', () => {
  it('opens the row menu with Shift+F10 or the Menu key, renames with F2', () => {
    const ev = (key: string, shift = false) => ({
      key,
      shiftKey: shift,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    });
    expect(isShortcut('tree.menu', ev('F10', true))).toBe(true);
    expect(isShortcut('tree.menu', ev('ContextMenu'))).toBe(true);
    expect(isShortcut('tree.menu', ev('F10'))).toBe(false);
    expect(isShortcut('tree.rename', ev('F2'))).toBe(true);
    expect(shortcutHint('tree.rename', false)).toBe('F2');
    expect(ariaKeys('tree.menu', false)).toBe('Shift+F10 ContextMenu');
    expect(SHORTCUT_SCOPES.some((s) => s.scope === 'tree')).toBe(true);
    expect(shortcutConflicts()).toEqual([]);
  });
});
```

(Import `ariaKeys`, `isShortcut`, `shortcutConflicts`, `shortcutHint`, `SHORTCUT_SCOPES` at the top if the file does not already.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/src/shortcuts.test.ts`
Expected: FAIL, `Unknown shortcut tree.menu`.

- [ ] **Step 3: Add the scope and the keys**

In `shortcuts.ts`: add `| 'tree'` to `ShortcutScope`; add `{ scope: 'tree', label: 'keys.scope.tree' }` to `SHORTCUT_SCOPES` after `'issueList'`; add to `NAMED`: `F2: ['F2'], F10: ['F10'], Menu: ['ContextMenu'],`; add to `ARIA`: `Menu: 'ContextMenu',`; and in `SHORTCUTS` before `// a PDF report`:

```ts
  // the Datasets list (founder, 15 Oct 2026: every sidebar action on right-click)
  { id: 'tree.menu', scope: 'tree', keys: ['Shift+F10', 'Menu'], label: 'keys.tree.menu' },
  { id: 'tree.rename', scope: 'tree', keys: ['F2'], label: 'keys.tree.rename' },
  { id: 'tree.delete', scope: 'tree', keys: ['Delete'], label: 'keys.tree.delete' },
  { id: 'tree.mark', scope: 'tree', keys: ['Ctrl+Space'], label: 'keys.tree.mark' },
  { id: 'tree.extend', scope: 'tree', keys: ['Shift+Up', 'Shift+Down'], label: 'keys.tree.extend' },
```

- [ ] **Step 4: Add every string of the plan to `en.ts`**

Insert before `} as const satisfies Record<string, string>;` (no em or en dashes; the `…` in the existing `tree.delete` is an ellipsis and stays):

```ts
  // Right-click menus across the sidebar, Align to, dataset properties (15 Oct 2026)
  'keys.scope.tree': 'Datasets list',
  'keys.tree.menu': 'Open the menu of the focused row',
  'keys.tree.rename': 'Rename the focused dataset or survey date',
  'keys.tree.delete': 'Delete the focused or marked datasets',
  'keys.tree.mark': 'Mark or unmark the focused dataset',
  'keys.tree.extend': 'Mark the rows above or below',
  'actions.menu.label': '{name} menu',
  'actions.header.layers_one': '{count} dataset',
  'actions.header.layers_other': '{count} datasets',
  'actions.header.photos_one': '{count} photo',
  'actions.header.photos_other': '{count} photos',
  'actions.project.title': 'Project',
  'actions.project.addData': 'Add data...',
  'actions.project.addPanos': 'Add drone panoramas...',
  'actions.project.addDrawing': 'Add drawing...',
  'actions.project.showAll': 'Show all datasets',
  'actions.project.hideAll': 'Hide all datasets',
  'actions.project.import360': 'Import 360 video...',
  'actions.project.importTiles': 'Import 3D Tiles...',
  'actions.project.checkPlacement': 'Check placement',
  'actions.project.exports': 'Exports',
  'actions.project.properties': 'Project properties...',
  'actions.project.close': 'Close project',
  'actions.project.emptyTrash': 'Empty trash...',
  'actions.date.zoomTo': 'Zoom to',
  'actions.date.export': 'Export...',
  'actions.date.addData': 'Add data to this date...',
  'actions.group.add360': 'Add 360 video...',
  'actions.layer.show': 'Show',
  'actions.layer.hide': 'Hide',
  'actions.layer.zoomTo': 'Zoom to',
  'actions.layer.rename': 'Rename',
  'actions.layer.export': 'Export...',
  'actions.layer.reveal': 'Reveal in folder',
  'actions.layer.properties': 'Properties...',
  'actions.cloud.settings': 'Display settings...',
  'actions.cloud.colourBy': 'Colour by',
  'actions.mesh.georef': 'Georeference by point pairs...',
  'actions.drawing.settings': 'Display and placement',
  'actions.drawing.sideBySide': 'Side by side',
  'actions.drawing.place': 'Place on site',
  'actions.drawing.placeAgain': 'Place again',
  'actions.drawing.onTop': 'Draw on top in 3D',
  'actions.drawing.behind': 'Draw behind models in 3D',
  'actions.walk.open': 'Open',
  'actions.walk.place': 'Place walk...',
  'actions.walk.editPlacement': 'Edit placement...',
  'actions.walk.removePlacement': 'Remove placement...',
  'actions.video.calibrate': 'Calibrate video...',
  'actions.video.alignCamera': 'Align camera to map...',
  'actions.video.showPath': 'Show flight path',
  'actions.video.hidePath': 'Hide flight path',
  'actions.photos.alignTo': 'Align to...',
  'actions.photos.alignToTitle': 'Align {name} to',
  'actions.photos.createMaps': 'Create maps from photos...',
  'actions.photos.openFirst': 'Open first photo',
  'actions.pano.open': 'Open',
  'actions.pano.stitch': 'Stitch',
  'actions.annotations.open': 'Open',
  'actions.annotations.showPins': 'Show pins',
  'actions.annotations.hidePins': 'Hide pins',
  'actions.noDate': 'No date',
  'actions.reason.readOnly': 'This project can only be viewed.',
  'actions.reason.package': 'This is a package: its files stay inside it.',
  'actions.reason.basemap': 'A basemap lives in the map packs, not in the project.',
  'actions.reason.mixedDates': 'These datasets are on different survey dates.',
  'actions.reason.oneDate': 'The project has only one survey date.',
  'actions.reason.trashEmpty': 'The trash is empty.',
  'actions.reason.inView': 'This date is already in view.',
  'actions.reason.noPositions': 'None of these photos has a position.',
  'actions.reason.noTargets': 'No other dataset has a known position.',
  'actions.reason.noBounds': 'Where {name} lies is not known.',
  'align.to.notice': 'Align to',
  'align.to.done_one': 'Aligned {count} photo to {target} (moved {distance})',
  'align.to.done_other': 'Aligned {count} photos to {target} (moved {distance})',
  'align.to.skipped_one': '{count} photo has no position and stayed where it was.',
  'align.to.skipped_other': '{count} photos have no position and stayed where they were.',
  'align.to.inPlace': 'Already in place',
  'align.to.undone': 'Alignment undone.',
  'align.to.redone': 'Alignment done again.',
  'align.to.far': 'Align to...',
  'align.photoMenu.picked_one': '{count} photo picked',
  'align.photoMenu.picked_other': '{count} photos picked',
  'align.photoMenu.alignTo': 'Align to...',
  'align.photoMenu.clearPicks': 'Clear picked photos',
  'layerProps.title': 'Properties of {name}',
  'layerProps.projectTitle': 'Project properties',
  'layerProps.name': 'Name',
  'layerProps.kind': 'Kind',
  'layerProps.date': 'Survey date',
  'layerProps.files': 'Files',
  'layerProps.moreFiles': 'and {count} more',
  'layerProps.size': 'Size on disk',
  'layerProps.items': 'Items',
  'layerProps.points': 'Points',
  'layerProps.features': 'Features',
  'layerProps.extent': 'Extent',
  'layerProps.extentText': '{x} by {z} m, {y} m high',
  'layerProps.centre': 'Centre',
  'layerProps.local': '{x}, {y}, {z} m (local)',
  'layerProps.wgs84': '{lat}, {lon} (WGS84)',
  'layerProps.crs': 'Coordinate system',
  'layerProps.imported': 'Imported',
  'layerProps.unknown': 'Not known',
  'layerProps.reading': 'Reading the files...',
  'layerProps.folder': 'Folder',
  'layerProps.origin': 'Origin',
  'layerProps.datasets': 'Datasets',
  'layerProps.dates': 'Survey dates',
  'layerProps.rename': 'Rename',
  'layerProps.reveal': 'Reveal in folder',
  'layerProps.close': 'Close',
  'layerProps.kind.mesh': 'Model',
  'layerProps.kind.pointcloud': 'Point cloud',
  'layerProps.kind.basemap': 'Basemap',
  'layerProps.kind.raster': 'Raster',
  'layerProps.kind.vector': 'Vector map',
  'layerProps.kind.video': 'Video',
  'layerProps.kind.walk': '360 walk',
  'layerProps.kind.photos': 'Photos',
  'layerProps.kind.panoramas': 'Panoramas',
  'layerProps.kind.legacy': 'Retired viewer',
  'layerExport.pick': 'Export datasets to a folder',
  'layerExport.title': 'Exporting datasets',
  'layerExport.done_one': '{count} dataset exported to {dir}.',
  'layerExport.done_other': '{count} datasets exported to {dir}.',
  'layerExport.skipped': 'Not exported, a folder of that name is already there: {names}.',
  'layerExport.cancelled': 'Export cancelled.',
  'tree.renameLayer': 'Name of {name}',
  'tree.row.show': 'Show {name}',
  'tree.row.hide': 'Hide {name}',
  'tree.row.showTip': 'Show',
  'tree.row.hideTip': 'Hide',
  'tree.row.cloud': 'Point cloud colour and display: {name}',
  'tree.row.cloudTip': 'Colour by RGB, elevation, intensity or flight; size and budget',
  'tree.row.drawing': 'Drawing display and placement: {name}',
  'tree.row.drawingTip': 'Opacity, on top, place on the site, open side by side',
  'tree.row.more': '{count} more',
  'tree.row.fewer': 'Show fewer',
```

The `tree.row.*` texts equal today's hard-coded row strings in `DatasetTree.tsx`, so `aria-label` selectors in existing specs keep matching.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/ui/src/shortcuts.test.ts packages/ui/src/i18n/i18n.test.ts`
Expected: PASS (the catalogue test finds no dash and matching placeholders across plural forms).

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/i18n/en.ts packages/ui/src/shortcuts.ts packages/ui/src/shortcuts.test.ts
git commit -m "feat(ui): strings and Datasets shortcuts for right-click menus" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Contracts: rename, layer info, export, reveal

**Packages:** `@aio/schema`; desktop preload and main `journal.ts`; docs

**Files:**

- Create: `packages/schema/src/layerInfo.ts`
- Modify: `packages/schema/src/builder.ts:203-232` (`LayerPatch` union, last member)
- Modify: `packages/schema/src/ipc.ts` (three channels after `'builder:layerExtents'`, line ~1612; imports)
- Modify: `packages/schema/src/index.ts` (`export * from './layerInfo';`)
- Modify: `apps/desktop/src/preload/index.ts` (`CHANNELS`: three entries after `'builder:layerExtents': true`)
- Modify: `apps/desktop/src/main/journal.ts` (`READS`, after `'library:reveal'`)
- Modify: `docs/architecture/contract-changes.md` (the four rows of "Contract changes")
- Test: `packages/schema/src/layerInfo.test.ts`

**Interfaces:**

- Produces: `LayerInfo` (zod + type), `LayerExportResult` type; `LayerPatch` member `{ name: string }`; channels `'layer:info'`, `'layer:export'`, `'layer:reveal'` with the shapes below.

- [ ] **Step 1: Write the failing test**

```ts
// packages/schema/src/layerInfo.test.ts
import { describe, expect, it } from 'vitest';
import { LayerPatch } from './builder';
import { ipc } from './ipc';
import { LayerInfo } from './layerInfo';

describe('dataset menus contract', () => {
  it('renames a layer with a trimmed name of 1 to 120 characters', () => {
    expect(LayerPatch.parse({ name: '  Site model ' })).toEqual({ name: 'Site model' });
    expect(LayerPatch.safeParse({ name: '   ' }).success).toBe(false);
    expect(LayerPatch.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(LayerPatch.safeParse({ name: 'a', capture: null }).success).toBe(false);
  });

  it('reads layer info with files, sizes, count, extent and import time', () => {
    const info = {
      layerId: 'm',
      name: 'Model',
      kind: 'mesh',
      files: [{ path: 'models/m.glb', bytes: 2048 }],
      bytes: 2048,
      count: null,
      countKind: null,
      extent: { min: [0, 0, 0], max: [1, 2, 3] },
      crs: { epsg: 32639 },
      importedAt: '2026-10-15T09:00:00.000Z',
      mainFile: 'models/m.glb',
    };
    expect(LayerInfo.parse(info)).toEqual(info);
    expect(ipc['layer:info'].response.safeParse({ ok: true, info }).success).toBe(true);
    expect(ipc['layer:info'].request.safeParse({ projectId: 'p', layerId: 'm' }).success).toBe(
      true,
    );
  });

  it('exports layers by id into a folder under a job id, and reveals by layer id', () => {
    const req = { projectId: 'p', jobId: 'j1', layerIds: ['m'], dir: 'C:/out' };
    expect(ipc['layer:export'].request.safeParse(req).success).toBe(true);
    expect(ipc['layer:export'].request.safeParse({ ...req, layerIds: [] }).success).toBe(false);
    expect(
      ipc['layer:export'].response.safeParse({
        ok: true,
        written: 1,
        skipped: ['Model'],
        cancelled: false,
      }).success,
    ).toBe(true);
    expect(ipc['layer:reveal'].request.safeParse({ projectId: 'p', layerId: 'm' }).success).toBe(
      true,
    );
    expect(ipc['layer:reveal'].request.safeParse({ projectId: 'p', path: 'C:/x' }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/schema/src/layerInfo.test.ts`
Expected: FAIL, cannot resolve `./layerInfo`.

- [ ] **Step 3: Write the schema**

```ts
// packages/schema/src/layerInfo.ts
import { z } from 'zod';
import { Id, IsoTime, Vec3 } from './common';
import { Crs } from './manifest';

/**
 * What the Properties dialog of a dataset shows (`layer:info`), read by main from the layer's own
 * files: each file with its size, the total, how many items or points, where it lies in the local
 * frame (data-conventions section 1), the project CRS, and when its main file was written.
 */
export const LayerInfo = z.object({
  layerId: Id,
  name: z.string().min(1),
  kind: z.string().min(1),
  files: z.array(
    z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative().nullable() }),
  ),
  bytes: z.number().int().nonnegative().nullable(),
  count: z.number().int().nonnegative().nullable(),
  countKind: z.enum(['items', 'points', 'features']).nullable(),
  extent: z.object({ min: Vec3, max: Vec3 }).nullable(),
  crs: Crs,
  /** Creation time of the main file on disk (layers carry no import time). */
  importedAt: IsoTime.nullable(),
  /** Project-relative path of the file Reveal in folder shows. */
  mainFile: z.string().nullable(),
});

export const LayerExportResult = z.object({
  ok: z.literal(true),
  written: z.number().int().nonnegative(),
  /** Names of the layers not exported because their folder was already there. */
  skipped: z.array(z.string()),
  cancelled: z.boolean(),
});

export type LayerInfo = z.infer<typeof LayerInfo>;
export type LayerExportResult = z.infer<typeof LayerExportResult>;
```

In `builder.ts`, as the last member of the `LayerPatch` union:

```ts
  /** A new name for any layer kind (the Datasets menu's Rename, F2). Nothing else changes. */
  z.object({ name: z.string().trim().min(1).max(120) }).strict(),
```

In `ipc.ts`, import `LayerExportResult, LayerInfo` from `./layerInfo` and add after `'builder:layerExtents'`:

```ts
  /**
   * The Properties of one dataset, read from its files (`LayerInfo`). Reads only. A package
   * answers a failure: its files stay inside the `.aio`.
   */
  'layer:info': {
    request: z.object({ projectId: ProjectId, layerId: z.string().min(1) }).strict(),
    response: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), info: LayerInfo }), Failure]),
  },
  /**
   * Copy each layer's own files unchanged into `<dir>/<layer name>/`, with `<layer name>.crs.json`
   * for a layer in the local frame. A folder that is already there is never overwritten (the
   * layer is named in `skipped`). Progress arrives as `export:progress` with `jobId`;
   * `export:cancel` with the same id stops it. Refused for a package.
   */
  'layer:export': {
    request: z
      .object({
        projectId: ProjectId,
        jobId: z.string().min(1).max(64),
        layerIds: z.array(z.string().min(1)).min(1),
        dir: z.string().min(1),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [LayerExportResult, Failure]),
  },
  /** Show the layer's main file in the file manager; main finds the path. */
  'layer:reveal': {
    request: z.object({ projectId: ProjectId, layerId: z.string().min(1) }).strict(),
    response: OkOrFailure,
  },
```

In `index.ts`: `export * from './layerInfo';`. In `preload/index.ts` `CHANNELS`: `'layer:info': true, 'layer:export': true, 'layer:reveal': true,`. In `journal.ts` `READS`, after `'library:reveal',`:

```ts
  // dataset properties, reveal and export read the project; export writes outside it only
  'layer:info',
  'layer:reveal',
  'layer:export',
```

Add the four rows from "Contract changes" to `docs/architecture/contract-changes.md`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/schema/src/layerInfo.test.ts packages/schema/src/builder.test.ts apps/desktop/src/main/journal.test.ts`
Expected: PASS. Then `pnpm --filter @aio/desktop exec tsc --noEmit -p tsconfig.json` (or the package's `typecheck` script): the preload `CHANNELS` record type-checks with the three new channels.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/layerInfo.ts packages/schema/src/layerInfo.test.ts packages/schema/src/builder.ts packages/schema/src/ipc.ts packages/schema/src/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/journal.ts docs/architecture/contract-changes.md
git commit -m "feat(schema): rename patch and layer info, export and reveal channels" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Extents read corrected photos, and more kinds for Properties

**Packages:** `@aio/project`, desktop main `builder.ts`

**Files:**

- Modify: `packages/project/src/builder/extents.ts:90-136`
- Modify: `packages/project/src/builder/tiff.ts` (factor `geoOf(tags)` out of `decodeTiff` lines 310-324; add `readTiffGeo`)
- Modify: `packages/project/src/builder/index.ts:28` (export the new functions)
- Modify: `apps/desktop/src/main/builder.ts:465-482` (`builderLayerExtents` passes the orientation)
- Test: `packages/project/src/builder/extents.test.ts`, `packages/project/src/builder/tiff.test.ts`, `apps/desktop/src/main/builder.test.ts`

**Interfaces:**

- Consumes: `correctPos`, `photoCorrection`, `fromWgs84`, `projectToLocal` (`@aio/geo`); `OrientationFile` (`@aio/schema`); `readOrientation(root)` (`apps/desktop/src/main/orientation.ts:37`).
- Produces:
  - `layerExtent(root: string, m: ProjectManifest, l: Layer, orientation?: OrientationFile | null): Promise<LocalExtent | null>` (photos corrected)
  - `layerExtents(root: string, m: ProjectManifest, orientation?: OrientationFile | null): Promise<{ layerId: string; min: Vec3; max: Vec3 }[]>`
  - `fullLayerExtent(root: string, m: ProjectManifest, l: Layer, orientation: OrientationFile | null): Promise<LocalExtent | null>` (adds panoramas, walks on `@model` pins, kit pyramids, GeoTIFF COGs in the project CRS, PMTiles, GeoJSON)
  - `pmtilesBounds(head: Uint8Array): [number, number, number, number] | null` (min lon, min lat, max lon, max lat)
  - `geojsonLonLat(json: unknown): [number, number][]`
  - `readTiffGeo(b: Uint8Array): { width: number; height: number; geo: TiffGeo }`

- [ ] **Step 1: Write the failing tests** (append to `extents.test.ts`)

```ts
import { fullLayerExtent, geojsonLonLat, layerExtent, pmtilesBounds } from './extents';
import { readManifestFile } from './create';
import { emptyOrientation, type Layer, type OrientationFile } from '@aio/schema';
import { mkdir } from 'node:fs/promises';

const photosLayer = {
  kind: 'photos',
  id: 'ph',
  name: 'Photos',
  visible: true,
  items: [
    { id: 'a', src: { path: 'photos/ph/a.jpg' }, pos: [100, 10, -200] },
    { id: 'b', src: { path: 'photos/ph/b.jpg' }, pos: [102, 12, -198] },
    { id: 'c', src: { path: 'photos/ph/c.jpg' } },
  ],
} as unknown as Layer;

it('a photos extent reads positions with their hand corrections', async () => {
  const root = await project();
  const m = await readManifestFile(root);
  const o: OrientationFile = {
    ...emptyOrientation(),
    photos: { ph: { a: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [-100, 0, 200] } } },
  };
  expect(await layerExtent(root, m, photosLayer, null)).toEqual({
    min: [100, 10, -200],
    max: [102, 12, -198],
  });
  expect(await layerExtent(root, m, photosLayer, o)).toEqual({
    min: [0, 10, -198],
    max: [102, 12, 0],
  });
});

it('reads the bounds in a PMTiles v3 header', () => {
  const b = new Uint8Array(127);
  b.set(new TextEncoder().encode('PMTiles'), 0);
  b[7] = 3;
  const v = new DataView(b.buffer);
  [47.9, 29.3, 48.1, 29.5].forEach((d, i) => {
    v.setInt32(102 + i * 4, Math.round(d * 1e7), true);
  });
  expect(pmtilesBounds(b)).toEqual([47.9, 29.3, 48.1, 29.5]);
  expect(pmtilesBounds(new Uint8Array(127))).toBeNull();
});

it('collects lon/lat pairs from any GeoJSON geometry', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { geometry: { type: 'Point', coordinates: [1, 2] } },
      {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [3, 4],
              [5, 6, 7],
              [3, 4],
            ],
          ],
        },
      },
      { geometry: null },
    ],
  };
  expect(geojsonLonLat(fc)).toEqual([
    [1, 2],
    [3, 4],
    [5, 6],
    [3, 4],
  ]);
});

it('gives panoramas, kit pyramids and GeoJSON an extent for Properties only', async () => {
  const root = await project();
  const m = await readManifestFile(root);
  await mkdir(join(root, 'vectors'), { recursive: true });
  // 500 m east and 300 m north of the origin (EPSG 32639, origin 500000, 3200000, 20)
  const [lon, lat] = toWgs84Pair([500500, 3200300]);
  await writeFile(
    join(root, 'vectors', 'v.geojson'),
    JSON.stringify({
      type: 'FeatureCollection',
      features: [{ geometry: { type: 'Point', coordinates: [lon, lat] } }],
    }),
  );
  const vector = {
    kind: 'vector',
    id: 'v',
    name: 'V',
    visible: true,
    src: { path: 'vectors/v.geojson' },
    format: 'geojson',
  } as unknown as Layer;
  const e = await fullLayerExtent(root, m, vector, null);
  expect(e?.min[0]).toBeCloseTo(500, 1);
  expect(e?.min[2]).toBeCloseTo(-300, 1);
  const panos = {
    kind: 'panoramas',
    id: 'pn',
    name: 'P',
    visible: true,
    items: [{ id: 'x', src: { path: 'p.jpg' }, pos: [1, 2, 3], headingDeg: 0 }],
  } as unknown as Layer;
  expect(await fullLayerExtent(root, m, panos, null)).toEqual({ min: [1, 2, 3], max: [1, 2, 3] });
  // the far-content list is unchanged: no vector, no panoramas
  expect(await layerExtent(root, m, vector, null)).toBeNull();
});
```

(`toWgs84Pair` is a two-line helper in the test: `const [lon, lat] = toWgs84([e, n, 0], 32639); return [lon, lat];` with `toWgs84` from `@aio/geo`.)

In `tiff.test.ts`, add: `readTiffGeo` on a `makeTiff(...)` fixture with `pixelScale` and `tiepoint` returns the same `geo` that `decodeTiff` returns for that file, without decoding the strips (a file whose strip offset points past its end still answers).

In `apps/desktop/src/main/builder.test.ts`, add: write a project with a photos layer and an `orientation.json` correcting one photo by `[-100, 0, 200]`; `builderLayerExtents` answers the corrected box.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/project/src/builder/extents.test.ts packages/project/src/builder/tiff.test.ts`
Expected: FAIL, `fullLayerExtent`, `pmtilesBounds`, `geojsonLonLat`, `readTiffGeo` are not exported.

- [ ] **Step 3: Implement**

In `tiff.ts`, move lines 310-324 of `decodeTiff` into:

```ts
/** GeoTIFF placement from the tags of the first directory. */
function geoOf(tags: Tags): TiffGeo {
  const geo: TiffGeo = { pixelIsPoint: false };
  const scale = list(tags, 33550);
  if (scale.length >= 2) geo.pixelScale = [scale[0] ?? 1, scale[1] ?? 1];
  const tie = list(tags, 33922);
  if (tie.length >= 6) geo.tiepoint = [tie[0] ?? 0, tie[1] ?? 0, tie[3] ?? 0, tie[4] ?? 0];
  const tr = list(tags, 34264);
  if (tr.length === 16) geo.transform = tr;
  const keys = list(tags, 34735);
  for (let i = 4; i + 3 < keys.length; i += 4) {
    const id = keys[i];
    const value = keys[i + 3];
    if (keys[i + 1] !== 0) continue;
    if (value !== undefined && (id === 3072 || (id === 2048 && geo.epsg === undefined)))
      geo.epsg = value;
    if (id === 1025) geo.pixelIsPoint = value === 2;
  }
  return geo;
}

/** Size and GeoTIFF placement from the first directory (a COG keeps it at the start), no pixels. */
export function readTiffGeo(b: Uint8Array): { width: number; height: number; geo: TiffGeo } {
  const { tags } = readTags(b);
  return { width: first(tags, 256, 0) ?? 0, height: first(tags, 257, 0) ?? 0, geo: geoOf(tags) };
}
```

and call `const geo = geoOf(tags);` in `decodeTiff`.

In `extents.ts`:

```ts
import { correctPos, fromWgs84, photoCorrection, projectToLocal } from '@aio/geo';
import type { Layer, OrientationFile, ProjectManifest, Vec3 } from '@aio/schema';
import { readTiffGeo, tiffCorners } from './tiff';

// in layerExtent(root, m, l, orientation = null):
if (l.kind === 'photos')
  return boxOf(
    l.items.flatMap((p) =>
      p.pos ? [correctPos(p.pos, photoCorrection(orientation, l.id, p.id))] : [],
    ),
  );

// layerExtents(root, m, orientation = null) passes it on.

/** PMTiles v3 header bounds (degrees): min lon, min lat, max lon, max lat. */
export function pmtilesBounds(head: Uint8Array): [number, number, number, number] | null {
  if (
    head.length < 127 ||
    new TextDecoder().decode(head.subarray(0, 7)) !== 'PMTiles' ||
    head[7] !== 3
  )
    return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const d = (o: number) => v.getInt32(o, true) / 1e7;
  return [d(102), d(106), d(110), d(114)];
}

/** Every lon/lat pair of a GeoJSON object, in document order (heights dropped). */
export function geojsonLonLat(json: unknown): [number, number][] {
  const out: [number, number][] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) walk(x);
  };
  const visit = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    const g = o as {
      type?: string;
      coordinates?: unknown;
      features?: unknown[];
      geometry?: unknown;
      geometries?: unknown[];
    };
    if (Array.isArray(g.features)) for (const f of g.features) visit(f);
    if (g.geometry) visit(g.geometry);
    if (Array.isArray(g.geometries)) for (const x of g.geometries) visit(x);
    if (g.coordinates !== undefined) walk(g.coordinates);
  };
  visit(json);
  return out;
}

const epsgOf = (m: ProjectManifest) => ('epsg' in m.crs ? m.crs.epsg : null);

/**
 * The extent Properties and Zoom to show: what `layerExtent` reads, plus panoramas, walks placed
 * on the model, kit pyramids, GeoTIFFs in the project CRS, PMTiles and GeoJSON. `layerExtents`
 * does not use it, so the far-content check sees the kinds it always saw.
 */
export async function fullLayerExtent(
  root: string,
  m: ProjectManifest,
  l: Layer,
  orientation: OrientationFile | null,
): Promise<LocalExtent | null> {
  const known = await layerExtent(root, m, l, orientation);
  if (known) return known;
  const epsg = epsgOf(m);
  const fromLonLat = (pts: readonly [number, number][]) =>
    epsg === null
      ? null
      : boxOf(
          pts.map(([lon, lat]) =>
            projectToLocal(fromWgs84([lon, lat, m.origin[2]], epsg), m.origin),
          ),
        );
  try {
    if (l.kind === 'panoramas') return boxOf(l.items.map((p) => p.pos));
    if (l.kind === 'walk')
      return boxOf(
        (l.place?.pins ?? []).flatMap((p) =>
          p.surface === '@model' ? [[p.at[0], p.y ?? 0, p.at[1]] as Vec3] : [],
        ),
      );
    if (l.kind === 'vector' && 'path' in l.src)
      return fromLonLat(
        geojsonLonLat(JSON.parse(await readFile(join(root, l.src.path), 'utf8')) as unknown),
      );
    if (l.kind === 'raster' && 'path' in l.src) {
      const file = join(root, l.src.path);
      if (l.format === 'kit-pyramid') {
        const idx = JSON.parse(await readFile(file, 'utf8')) as {
          corners?: { tl: Vec3; tr: Vec3; bl: Vec3 };
        };
        if (!idx.corners) return null;
        const { tl, tr, bl } = idx.corners;
        return boxOf([
          tl,
          tr,
          bl,
          [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]],
        ]);
      }
      if (l.format === 'pmtiles') {
        const b = pmtilesBounds(await readHead(file, 127));
        return b
          ? fromLonLat([
              [b[0], b[1]],
              [b[2], b[3]],
            ])
          : null;
      }
      if (l.format === 'cog') {
        const t = readTiffGeo(await readHead(file, 64 * 1024));
        if (t.geo.epsg !== undefined && t.geo.epsg !== epsg) return null;
        const c = tiffCorners(t);
        const at = (p: [number, number]) => projectToLocal([p[0], p[1], m.origin[2]], m.origin);
        const br: [number, number] = [c.tr[0] + c.bl[0] - c.tl[0], c.tr[1] + c.bl[1] - c.tl[1]];
        return boxOf([at(c.tl), at(c.tr), at(c.bl), at(br)]);
      }
    }
  } catch {
    // a file that cannot be read has no extent
  }
  return null;
}
```

Export `fullLayerExtent`, `pmtilesBounds`, `geojsonLonLat` from `builder/index.ts` line 28, and `readTiffGeo` next to the other tiff exports.

In `apps/desktop/src/main/builder.ts` `builderLayerExtents`:

```ts
const o = await readOrientation(root);
const orientation = o.ok ? o.file : null;
return {
  ok: true,
  extents: await l.layerExtents(root, m, orientation),
  recentre: { blockers: await l.recentreBlockers(root, m) },
};
```

(import `readOrientation` from `./orientation`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/project/src/builder/extents.test.ts packages/project/src/builder/tiff.test.ts apps/desktop/src/main/builder.test.ts apps/desktop/src/renderer/builder/farContent.test.ts`
Expected: PASS (far-content tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/project/src/builder/extents.ts packages/project/src/builder/extents.test.ts packages/project/src/builder/tiff.ts packages/project/src/builder/tiff.test.ts packages/project/src/builder/index.ts apps/desktop/src/main/builder.ts apps/desktop/src/main/builder.test.ts
git commit -m "feat(project): corrected photo extents and full extents for more kinds" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The camera frames a box and a layer selection

**Packages:** `@aio/workspace`, `@aio/engine`, `@aio/maps`

**Files:**

- Modify: `packages/workspace/src/index.ts:31-51` (`CameraRequest.target` gains `{ kind: 'box'; min: Vec3; max: Vec3 }`)
- Create: `packages/engine/src/stage/layerBox.ts`
- Modify: `packages/engine/src/stage/Stage.ts:1196-1231` (`handleCamera`)
- Modify: `packages/maps/src/controller.ts:1264-1294` (`followCamera`)
- Test: `packages/engine/src/stage/layerBox.test.ts`, `packages/engine/src/stage/Stage.test.ts`

**Interfaces:**

- Produces: `workspace.getState().flyTo({ kind: 'box', min, max })`; F / fly-to on a `{ kind: 'layer' }` selection frames that layer; `layerBox(root: Object3D, layerId: string): Box3 | null` (exported from `@aio/engine`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/src/stage/layerBox.test.ts
import { BoxGeometry, Group, Mesh, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { layerBox } from './layerBox';

const cube = (x: number) => {
  const m = new Mesh(new BoxGeometry(2, 2, 2));
  m.position.set(x, 1, 0);
  m.updateMatrixWorld(true);
  return m;
};

describe('layerBox', () => {
  it('frames the visible scene objects tagged with the layer (mesh, cloud, tiles, photos)', () => {
    const scene = new Scene();
    const a = new Group();
    a.userData.layerId = 'm';
    a.add(cube(10));
    const photos = new Group();
    photos.userData.photosLayer = 'p';
    photos.add(cube(-10));
    const hidden = new Group();
    hidden.userData.layerId = 'm';
    hidden.visible = false;
    hidden.add(cube(100));
    scene.add(a, photos, hidden);
    scene.updateMatrixWorld(true);
    expect(layerBox(scene, 'm')?.min.toArray()).toEqual([9, 0, -1]);
    expect(layerBox(scene, 'm')?.max.toArray()).toEqual([11, 2, 1]);
    expect(layerBox(scene, 'p')?.min.x).toBe(-11);
    expect(layerBox(scene, 'none')).toBeNull();
  });
});
```

In `Stage.test.ts`, inside `describe('Stage')`, add:

```ts
it('flies to a box and frames a layer selection', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true })); // reduced motion: no animation
  const { stage, store, resize } = make();
  resize(800, 600);
  store.getState().openProject(project([meshLayer('plant')]));
  await flush();
  store.getState().flyTo({ kind: 'box', min: [100, 0, 100], max: [110, 10, 110] });
  expect(store.getState().camera).toBeNull();
  let v = stage.saveView();
  expect(v.target[0]).toBeCloseTo(105);
  expect(v.target[2]).toBeCloseTo(105);
  const id = store.getState().project?.manifest.layers[0]?.id ?? '';
  store.getState().flyTo({ kind: 'selection', selection: { kind: 'layer', id, layer: id } });
  expect(store.getState().camera).toBeNull();
  v = stage.saveView();
  expect(v.target[0]).toBeCloseTo(0);
  expect(v.target[2]).toBeCloseTo(0);
  stage.dispose();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/engine/src/stage/layerBox.test.ts packages/engine/src/stage/Stage.test.ts`
Expected: FAIL (`layerBox` missing; `kind: 'box'` is not a camera target).

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/stage/layerBox.ts
import { Box3, type Object3D } from 'three';

/** Tags a layer's scene objects carry: models and clouds `layerId`, photo sets `photosLayer`. */
const owns = (o: Object3D, id: string) =>
  o.userData.layerId === id || o.userData.photosLayer === id || o.userData.aioLayer === id;

/** The world box of the visible objects of one layer under `root`, or null when none is drawn. */
export function layerBox(root: Object3D, layerId: string): Box3 | null {
  const box = new Box3();
  const visit = (o: Object3D) => {
    if (!o.visible) return;
    if (owns(o, layerId)) {
      box.expandByObject(o);
      return;
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return box.isEmpty() ? null : box;
}
```

Export it from `packages/engine/src/index.ts` (`export { layerBox } from './stage/layerBox';`).

In `workspace/src/index.ts`, add to the `target` union:

```ts
    /** Frame a box in the local frame (Zoom to a dataset or a date). */
    | { kind: 'box'; min: Vec3; max: Vec3 }
```

In `Stage.handleCamera`, replace the final `else` branch:

```ts
    } else if (t.kind === 'box') {
      const box = new Box3(new Vector3(...t.min), new Vector3(...t.max));
      if (!box.isEmpty()) pose = frameBox(box, current, this.camera.fov, this.aspect);
    } else if (t.selection.kind === 'layer') {
      const box = layerBox(this.scene, t.selection.layer ?? t.selection.id);
      if (box) pose = frameBox(box, current, this.camera.fov, this.aspect);
    } else {
      const hit =
        t.selection.kind === 'asset' ? this.findNode(t.selection.id, t.selection.layer) : null;
      if (hit)
        pose = frameBox(new Box3().setFromObject(hit.node), current, this.camera.fov, this.aspect);
    }
```

(`this.scene` is the Stage's three.js scene; use the field the file already calls `scene`. The test assumes `frameBox` aims at the box centre; if it aims elsewhere, assert instead that the target lies inside the box.)

In `maps/src/controller.ts` `followCamera`, before the `selection.kind === 'issue'` branch:

```ts
    } else if (t.kind === 'box') {
      const a = proj.toLonLat(t.min);
      const b = proj.toLonLat(t.max);
      map.fitBounds(
        [
          [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
          [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
        ],
        { padding: 40, maxZoom: 19, duration: ms(500) },
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/engine/src/stage/layerBox.test.ts packages/engine/src/stage/Stage.test.ts packages/maps/src`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace/src/index.ts packages/engine/src/stage/layerBox.ts packages/engine/src/stage/layerBox.test.ts packages/engine/src/stage/Stage.ts packages/engine/src/stage/Stage.test.ts packages/engine/src/index.ts packages/maps/src/controller.ts
git commit -m "feat(engine): fly to a box and frame a layer selection" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Align to maths

**Packages:** desktop renderer

**Files:**

- Create: `apps/desktop/src/renderer/builder/alignTo.ts`
- Test: `apps/desktop/src/renderer/builder/alignTo.test.ts`

**Interfaces:**

- Consumes: `correctPos`, `photoCorrection` (`@aio/geo`); `OrientationFile`, `PhotoCorrection`, `ProjectManifest`, `Vec3` (`@aio/schema`).
- Produces:
  - `EYE_HEIGHT_M = 1.6`, `MAX_ABOVE_GROUND_M = 300`, `MIN_SHIFT_M = 1`
  - `interface AlignBox { min: Vec3; max: Vec3 }`
  - `interface AlignSource { layerId: string; photoId: string; pos: Vec3 | undefined; correction: PhotoCorrection | undefined }`
  - `type Fixes = Record<string, Record<string, PhotoCorrection | null>>` (layer id, photo id)
  - `interface AlignPlan { shift: Vec3; distance: number; moved: number; skipped: number; inPlace: boolean; fixes: Fixes; before: Fixes }`
  - `alignSources(m: ProjectManifest, o: OrientationFile | null, pick: { layerIds: readonly string[] } | { picks: readonly { layerId: string; photoId: string }[] }): AlignSource[]`
  - `planAlign(sources: readonly AlignSource[], target: AlignBox, ground: number | null): AlignPlan`
  - `formatDistance(m: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/builder/alignTo.test.ts
import type { ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { alignSources, formatDistance, planAlign, type AlignSource } from './alignTo';

const src = (
  photoId: string,
  pos?: [number, number, number],
  offsetM?: [number, number, number],
): AlignSource => ({
  layerId: 'ph',
  photoId,
  pos,
  correction: offsetM ? { yawDeg: 3, pitchDeg: 0, rollDeg: 0, offsetM } : undefined,
});
const target = {
  min: [-10, 0, -10] as [number, number, number],
  max: [10, 5, 10] as [number, number, number],
};

describe('planAlign', () => {
  it('moves the block in plan onto the target centre and keeps plausible heights', () => {
    const p = planAlign([src('a', [91000, 40, 2000]), src('b', [91010, 42, 2010])], target, null);
    expect(p.shift).toEqual([-91005, 0, -2005]);
    expect(p.moved).toBe(2);
    expect(p.inPlace).toBe(false);
    expect(p.fixes.ph?.a).toEqual({
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      offsetM: [-91005, 0, -2005],
    });
    expect(p.before.ph?.a).toBeNull();
  });

  it('lifts a block that lies under the ground to eye height, keeping relative heights', () => {
    const p = planAlign([src('a', [0, -50, 0]), src('b', [1, -48, 1])], target, 2);
    expect(p.shift[1]).toBeCloseTo(2 + 1.6 + 50);
    // every photo gets the same shift, so the 2 m between them stays
    expect(p.fixes.ph?.a?.offsetM?.[1]).toBe(p.fixes.ph?.b?.offsetM?.[1]);
  });

  it('lowers a block more than 300 m above the ground, uses the target minimum without a DSM', () => {
    const p = planAlign([src('a', [0, 900, 0])], target, null);
    expect(p.shift[1]).toBeCloseTo(0 + 1.6 - 900);
    expect(planAlign([src('a', [0, 299, 0])], target, null).shift[1]).toBe(0);
  });

  it('adds the shift to an existing correction and keeps its angles', () => {
    const p = planAlign([src('a', [500, 10, 0], [10, 0, 0])], target, null);
    // corrected at 510 east; the target centre is at 0: the offset goes from 10 to -500
    expect(p.fixes.ph?.a).toEqual({ yawDeg: 3, pitchDeg: 0, rollDeg: 0, offsetM: [-500, 0, 0] });
    expect(p.before.ph?.a).toEqual({ yawDeg: 3, pitchDeg: 0, rollDeg: 0, offsetM: [10, 0, 0] });
  });

  it('skips photos without a position and counts them', () => {
    const p = planAlign([src('a', [100, 1, 0]), src('b')], target, null);
    expect(p.moved).toBe(1);
    expect(p.skipped).toBe(1);
    expect(p.fixes.ph?.b).toBeUndefined();
  });

  it('writes nothing under 1 m', () => {
    const p = planAlign([src('a', [0.5, 1, 0.5])], target, null);
    expect(p.inPlace).toBe(true);
    expect(p.fixes).toEqual({});
  });

  it('undo restores exactly: before holds every value as it was', () => {
    const p = planAlign([src('a', [123.4567, 5, 9.87654], [0.001, 0, 0])], target, null);
    expect(p.before).toEqual({
      ph: { a: { yawDeg: 3, pitchDeg: 0, rollDeg: 0, offsetM: [0.001, 0, 0] } },
    });
  });

  it('formats a distance in metres or kilometres', () => {
    expect(formatDistance(91234)).toBe('91.2 km');
    expect(formatDistance(350.4)).toBe('350 m');
  });
});

describe('alignSources', () => {
  const m = {
    layers: [
      {
        kind: 'photos',
        id: 'ph',
        name: 'P',
        visible: true,
        items: [
          { id: 'a', src: { path: 'a' }, pos: [1, 2, 3] },
          { id: 'b', src: { path: 'b' } },
        ],
      },
      { kind: 'mesh', id: 'm', name: 'M', visible: true, src: { path: 'm' }, transform: [] },
    ],
  } as unknown as ProjectManifest;
  it('takes every photo of the sets, or only the picks', () => {
    expect(alignSources(m, null, { layerIds: ['ph', 'm'] }).map((s) => s.photoId)).toEqual([
      'a',
      'b',
    ]);
    expect(
      alignSources(m, null, { picks: [{ layerId: 'ph', photoId: 'b' }] }).map((s) => s.photoId),
    ).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/desktop/src/renderer/builder/alignTo.test.ts`
Expected: FAIL, cannot resolve `./alignTo`.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/renderer/builder/alignTo.ts
import { correctPos, photoCorrection } from '@aio/geo';
import type { OrientationFile, PhotoCorrection, ProjectManifest, Vec3 } from '@aio/schema';

/*
 * Align to (spec section 6): move a block of photos in plan onto a target's centre and fix its
 * height only when it is implausible. The move is written as each photo's hand correction
 * (`offsetM`); the manifest, the GPS and the rotation corrections never change.
 */

/** The lowest photo lands this high above the target ground (eye height). */
export const EYE_HEIGHT_M = 1.6;
/** A block more than this above the target ground is implausible. */
export const MAX_ABOVE_GROUND_M = 300;
/** A total move under this is "Already in place". */
export const MIN_SHIFT_M = 1;

export interface AlignBox {
  min: Vec3;
  max: Vec3;
}

export interface AlignSource {
  layerId: string;
  photoId: string;
  pos: Vec3 | undefined;
  correction: PhotoCorrection | undefined;
}

/** Corrections by photo set id and photo id; null removes one. */
export type Fixes = Record<string, Record<string, PhotoCorrection | null>>;

export interface AlignPlan {
  shift: Vec3;
  /** Length of the shift, metres. */
  distance: number;
  moved: number;
  skipped: number;
  inPlace: boolean;
  fixes: Fixes;
  /** Each moved photo's correction before (null: it had none): the Undo. */
  before: Fixes;
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

/** The photos Align to moves: every photo of the named sets, or the picked photos. */
export function alignSources(
  m: ProjectManifest,
  o: OrientationFile | null,
  pick:
    { layerIds: readonly string[] } | { picks: readonly { layerId: string; photoId: string }[] },
): AlignSource[] {
  const out: AlignSource[] = [];
  const wanted =
    'picks' in pick ? new Set(pick.picks.map((p) => `${p.layerId}\n${p.photoId}`)) : null;
  const sets = 'picks' in pick ? [...new Set(pick.picks.map((p) => p.layerId))] : pick.layerIds;
  for (const id of sets) {
    const l = m.layers.find((x) => x.id === id);
    if (l?.kind !== 'photos') continue;
    for (const p of l.items) {
      if (wanted && !wanted.has(`${l.id}\n${p.id}`)) continue;
      out.push({
        layerId: l.id,
        photoId: p.id,
        pos: p.pos,
        correction: photoCorrection(o, l.id, p.id),
      });
    }
  }
  return out;
}

export function planAlign(
  sources: readonly AlignSource[],
  target: AlignBox,
  ground: number | null,
): AlignPlan {
  const placed = sources.flatMap((s) =>
    s.pos ? [{ s, at: correctPos(s.pos, s.correction) }] : [],
  );
  const skipped = sources.length - placed.length;
  const empty: AlignPlan = {
    shift: [0, 0, 0],
    distance: 0,
    moved: 0,
    skipped,
    inPlace: true,
    fixes: {},
    before: {},
  };
  if (placed.length === 0) return empty;
  const lo = (k: 0 | 1 | 2) => Math.min(...placed.map((p) => p.at[k]));
  const hi = (k: 0 | 1 | 2) => Math.max(...placed.map((p) => p.at[k]));
  const tx = (target.min[0] + target.max[0]) / 2;
  const tz = (target.min[2] + target.max[2]) / 2;
  const dx = tx - (lo(0) + hi(0)) / 2;
  const dz = tz - (lo(2) + hi(2)) / 2;
  const g = ground ?? target.min[1];
  const low = lo(1);
  const dy = low < g || low > g + MAX_ABOVE_GROUND_M ? g + EYE_HEIGHT_M - low : 0;
  const shift: Vec3 = [mm(dx), mm(dy), mm(dz)];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < MIN_SHIFT_M) return { ...empty, shift, distance, moved: 0 };
  const fixes: Fixes = {};
  const before: Fixes = {};
  for (const { s } of placed) {
    const c = s.correction;
    const o = c?.offsetM ?? [0, 0, 0];
    (fixes[s.layerId] ??= {})[s.photoId] = {
      yawDeg: c?.yawDeg ?? 0,
      pitchDeg: c?.pitchDeg ?? 0,
      rollDeg: c?.rollDeg ?? 0,
      offsetM: [mm(o[0] + shift[0]), mm(o[1] + shift[1]), mm(o[2] + shift[2])],
    };
    (before[s.layerId] ??= {})[s.photoId] = c ?? null;
  }
  return { shift, distance, moved: placed.length, skipped, inPlace: false, fixes, before };
}

/** `91.2 km` from 1 km up, `350 m` below. */
export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${String(Math.round(m))} m`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/desktop/src/renderer/builder/alignTo.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/builder/alignTo.ts apps/desktop/src/renderer/builder/alignTo.test.ts
git commit -m "feat(desktop): Align to plan for photo sets" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Where a dataset lies (`layerBounds`)

**Packages:** desktop renderer

**Files:**

- Create: `apps/desktop/src/renderer/shell/layerBounds.ts`
- Create: `apps/desktop/src/renderer/shell/appBounds.ts`
- Test: `apps/desktop/src/renderer/shell/layerBounds.test.ts`, `apps/desktop/src/renderer/shell/appBounds.test.ts`

**Interfaces:**

- Consumes: `correctPos`, `photoCorrection` (`@aio/geo`); `getActiveScene` (`@aio/engine`); `workspace` (`@aio/workspace`); `layerBox` (Task 5, `@aio/engine`).
- Produces:
  - `interface Box { min: Vec3; max: Vec3 }`
  - `interface BoundsDeps { manifest: ProjectManifest; orientation: OrientationFile | null; sceneBox(layerId: string): Box | null; fileExtent(layerId: string): Promise<Box | null>; rayDown(x: number, z: number): number | null }`
  - `layerBounds(layerId: string, deps: BoundsDeps): Promise<Box | null>`
  - `boundsOf(layerIds: readonly string[], deps: BoundsDeps): Promise<Box | null>` (union)
  - `unionBox(boxes: readonly (Box | null)[]): Box | null`, `padBox(b: Box, half?: number): Box` (default half-size at least 5 m)
  - `knowsWhere(layer: Layer): boolean` (sync hint for submenus: mesh, pointcloud, photos with a position, panoramas, raster, vector, walk with pins)
  - `groundAt(x: number, z: number, deps: BoundsDeps): Promise<number | null>` (DSM rule of spec section 6)
  - `appBoundsDeps(): BoundsDeps` and `setFileExtentSource(fn: (layerId: string) => Promise<Box | null>): void` (Task 14 sets the `layer:info` source; until then `fileExtent` answers null)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/renderer/shell/layerBounds.test.ts
import { emptyOrientation, type ProjectManifest } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  boundsOf,
  groundAt,
  knowsWhere,
  layerBounds,
  padBox,
  unionBox,
  type BoundsDeps,
} from './layerBounds';

const manifest = {
  layers: [
    { kind: 'mesh', id: 'm', name: 'M', visible: true, src: { path: 'm.glb' }, transform: [] },
    {
      kind: 'photos',
      id: 'ph',
      name: 'P',
      visible: true,
      items: [
        { id: 'a', src: { path: 'a' }, pos: [10, 1, 10] },
        { id: 'b', src: { path: 'b' }, pos: [12, 3, 14] },
      ],
    },
    {
      kind: 'raster',
      id: 'img',
      name: 'I',
      visible: true,
      src: { path: 'i.png' },
      role: 'plan',
      format: 'image',
      corners: { tl: [0, 0, 0], tr: [4, 0, 0], bl: [0, 0, 2] },
    },
    {
      kind: 'raster',
      id: 'dsm',
      name: 'D',
      visible: true,
      src: { path: 'd.tif' },
      role: 'dsm',
      format: 'cog',
    },
    {
      kind: 'panoramas',
      id: 'pn',
      name: 'N',
      visible: true,
      items: [{ id: 'x', src: { path: 'x' }, pos: [5, 0, 5], headingDeg: 0 }],
    },
    { kind: 'basemap', id: 'bm', name: 'B', visible: true, pack: 'p', style: 'dark' },
  ],
} as unknown as ProjectManifest;

const deps = (over: Partial<BoundsDeps> = {}): BoundsDeps => ({
  manifest,
  orientation: null,
  sceneBox: (id) => (id === 'm' ? { min: [-1, 0, -1], max: [1, 2, 1] } : null),
  fileExtent: vi.fn((id: string) =>
    Promise.resolve(id === 'dsm' ? { min: [-50, 0, -50], max: [50, 9, 50] } : null),
  ),
  rayDown: () => 4,
  ...over,
});

describe('layerBounds', () => {
  it('reads models from the scene, photos from corrected positions, images from corners', async () => {
    expect(await layerBounds('m', deps())).toEqual({ min: [-1, 0, -1], max: [1, 2, 1] });
    expect(await layerBounds('ph', deps())).toEqual({ min: [10, 1, 10], max: [12, 3, 14] });
    const o = {
      ...emptyOrientation(),
      photos: {
        ph: {
          a: {
            yawDeg: 0,
            pitchDeg: 0,
            rollDeg: 0,
            offsetM: [-10, 0, -10] as [number, number, number],
          },
        },
      },
    };
    expect(await layerBounds('ph', deps({ orientation: o }))).toEqual({
      min: [0, 1, 0],
      max: [12, 3, 14],
    });
    expect(await layerBounds('img', deps())).toEqual({ min: [0, 0, 0], max: [4, 0, 2] });
    expect(await layerBounds('pn', deps())).toEqual({ min: [5, 0, 5], max: [5, 0, 5] });
  });

  it('asks main for COGs, and for a model the scene has not drawn', async () => {
    const d = deps({ sceneBox: () => null });
    expect(await layerBounds('dsm', d)).toEqual({ min: [-50, 0, -50], max: [50, 9, 50] });
    await layerBounds('m', d);
    expect(d.fileExtent).toHaveBeenCalledWith('m');
    expect(await layerBounds('bm', d)).toBeNull();
  });

  it('frames the union of several datasets and pads a single point', async () => {
    expect(await boundsOf(['m', 'pn'], deps())).toEqual({ min: [-1, 0, -1], max: [5, 2, 5] });
    expect(unionBox([null, null])).toBeNull();
    expect(padBox({ min: [5, 0, 5], max: [5, 0, 5] })).toEqual({
      min: [0, -5, 0],
      max: [10, 5, 10],
    });
  });

  it('knows which kinds can say where they lie without reading files', () => {
    const ls = manifest.layers;
    expect(ls.map((l) => knowsWhere(l))).toEqual([true, true, true, true, true, false]);
  });

  it('takes the ground from a ray only where a DSM covers the point', async () => {
    expect(await groundAt(0, 0, deps())).toBe(4);
    expect(await groundAt(500, 0, deps())).toBeNull();
    expect(await groundAt(0, 0, deps({ rayDown: () => null }))).toBeNull();
  });
});
```

```ts
// apps/desktop/src/renderer/shell/appBounds.test.ts
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { appBoundsDeps, setFileExtentSource } from './appBounds';

afterEach(() => {
  setFileExtentSource(() => Promise.resolve(null));
  workspace.setState({ project: null });
});

describe('appBoundsDeps', () => {
  it('reads the open project and asks the registered file extent source', async () => {
    workspace.setState({
      project: { id: 'p', root: 'C:/p', manifest: { layers: [] } },
    } as unknown as Partial<ReturnType<typeof workspace.getState>>);
    expect(await appBoundsDeps().fileExtent('x')).toBeNull();
    setFileExtentSource((id) =>
      Promise.resolve(id === 'x' ? { min: [0, 0, 0], max: [1, 1, 1] } : null),
    );
    expect(await appBoundsDeps().fileExtent('x')).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(appBoundsDeps().sceneBox('x')).toBeNull(); // no 3D view in the test
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/layerBounds.test.ts apps/desktop/src/renderer/shell/appBounds.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/renderer/shell/layerBounds.ts
import { correctPos, photoCorrection } from '@aio/geo';
import type { Layer, OrientationFile, ProjectManifest, Vec3 } from '@aio/schema';

/** An axis-aligned box in the local frame (x east, y up, z south), metres. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface BoundsDeps {
  manifest: ProjectManifest;
  orientation: OrientationFile | null;
  /** The box of the scene objects tagged with the layer, when the 3D view has drawn them. */
  sceneBox(layerId: string): Box | null;
  /** What main reads from the files (`layer:info` extent), or null. */
  fileExtent(layerId: string): Promise<Box | null>;
  /** Height of the first thing straight down at (x, z) in the 3D view, or null. */
  rayDown(x: number, z: number): number | null;
}

export function boxOfPoints(points: readonly Vec3[]): Box | null {
  if (points.length === 0) return null;
  const lo = (k: 0 | 1 | 2) => Math.min(...points.map((p) => p[k]));
  const hi = (k: 0 | 1 | 2) => Math.max(...points.map((p) => p[k]));
  return { min: [lo(0), lo(1), lo(2)], max: [hi(0), hi(1), hi(2)] };
}

export function unionBox(boxes: readonly (Box | null)[]): Box | null {
  return boxOfPoints(boxes.flatMap((b) => (b ? [b.min, b.max] : [])));
}

/** A box at least `2 * half` metres across on each axis, around the same centre. */
export function padBox(b: Box, half = 5): Box {
  const out: Box = { min: [...b.min], max: [...b.max] };
  for (const k of [0, 1, 2] as const) {
    const c = (b.min[k] + b.max[k]) / 2;
    const h = Math.max(half, (b.max[k] - b.min[k]) / 2);
    out.min[k] = c - h;
    out.max[k] = c + h;
  }
  return out;
}

const layerOf = (m: ProjectManifest, id: string) => m.layers.find((l) => l.id === id);

/** Whether a dataset can have a place (for submenus that must be built at once). */
export function knowsWhere(l: Layer): boolean {
  switch (l.kind) {
    case 'mesh':
    case 'pointcloud':
    case 'raster':
    case 'vector':
    case 'panoramas':
      return true;
    case 'photos':
      return l.items.some((p) => p.pos !== undefined);
    case 'walk':
      return (l.place?.pins.length ?? 0) > 0;
    default:
      return false;
  }
}

export async function layerBounds(layerId: string, deps: BoundsDeps): Promise<Box | null> {
  const l = layerOf(deps.manifest, layerId);
  if (!l) return null;
  switch (l.kind) {
    case 'mesh':
    case 'pointcloud':
      return deps.sceneBox(l.id) ?? deps.fileExtent(l.id);
    case 'photos':
      return boxOfPoints(
        l.items.flatMap((p) =>
          p.pos ? [correctPos(p.pos, photoCorrection(deps.orientation, l.id, p.id))] : [],
        ),
      );
    case 'panoramas':
      return boxOfPoints(l.items.map((p) => p.pos));
    case 'raster': {
      if (l.corners) {
        const { tl, tr, bl } = l.corners;
        return boxOfPoints([
          tl,
          tr,
          bl,
          [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]],
        ]);
      }
      return deps.fileExtent(l.id);
    }
    case 'vector':
    case 'walk':
      return deps.fileExtent(l.id);
    default:
      return null;
  }
}

export async function boundsOf(layerIds: readonly string[], deps: BoundsDeps): Promise<Box | null> {
  return unionBox(await Promise.all(layerIds.map((id) => layerBounds(id, deps))));
}

/**
 * The target ground of Align to: where a DSM covers (x, z), the first hit straight down in the
 * 3D view; else null (the caller then takes the target's lowest point).
 */
export async function groundAt(x: number, z: number, deps: BoundsDeps): Promise<number | null> {
  for (const l of deps.manifest.layers) {
    if (l.kind !== 'raster' || l.role !== 'dsm') continue;
    const b = await layerBounds(l.id, deps);
    if (!b || x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) continue;
    const y = deps.rayDown(x, z);
    if (y !== null) return y;
  }
  return null;
}
```

```ts
// apps/desktop/src/renderer/shell/appBounds.ts
import { getActiveScene, layerBox } from '@aio/engine';
import { workspace } from '@aio/workspace';
import { Vector3 } from 'three';
import type { BoundsDeps, Box } from './layerBounds';

let fileExtentSource: (layerId: string) => Promise<Box | null> = () => Promise.resolve(null);

/** Where main's file extents come from (Task 14: `layer:info`). */
export function setFileExtentSource(fn: (layerId: string) => Promise<Box | null>): void {
  fileExtentSource = fn;
}

/** `layerBounds` deps for the open project and the live 3D view. */
export function appBoundsDeps(): BoundsDeps {
  const ws = workspace.getState();
  const manifest = ws.project?.manifest ?? { layers: [] };
  return {
    manifest: manifest as BoundsDeps['manifest'],
    orientation: ws.orientation,
    sceneBox: (id) => {
      const h = getActiveScene();
      const b = h ? layerBox(h.scene, id) : null;
      return b ? { min: b.min.toArray(), max: b.max.toArray() } : null;
    },
    fileExtent: (id) => fileExtentSource(id),
    rayDown: (x, z) => {
      const h = getActiveScene();
      const hit = h?.raycastRay(new Vector3(x, 20_000, z), new Vector3(0, -1, 0));
      return hit ? hit.point.y : null;
    },
  };
}
```

(`h.raycastRay` is the call `packages/ai/src/places.ts:280` already uses.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/layerBounds.test.ts apps/desktop/src/renderer/shell/appBounds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/shell/layerBounds.ts apps/desktop/src/renderer/shell/layerBounds.test.ts apps/desktop/src/renderer/shell/appBounds.ts apps/desktop/src/renderer/shell/appBounds.test.ts
git commit -m "feat(desktop): where a dataset lies, for Zoom to and Align to" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Readers use corrected photo positions

**Packages:** `@aio/ai`; desktop renderer (a test only)

**Files:**

- Modify: `packages/ai/src/places.ts:510-535` (photo set box, photo places) and `:587-595` (`photoEye`)
- Create: `packages/ai/src/places.test.ts`
- Modify: `apps/desktop/src/renderer/workspace/spot/spotEntries.test.ts` (one case)

**Interfaces:**

- Consumes: `correctedPhoto`, `photoCorrection` (`@aio/geo`); `ctx.workspace.getState().orientation`.
- Produces: `placeIndex` photo boxes, photo places and eyes at corrected positions. No signature change.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ai/src/places.test.ts
import { emptyOrientation, type ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { placeIndex } from './places';
import type { RendererToolContext } from './tool-kit';

describe('placeIndex with moved photos', () => {
  it('puts photo sets, photos and their eyes where they are drawn', () => {
    const ws = createWorkspace();
    const manifest = {
      schema: 'aio.project/1',
      id: 'p',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [],
      layers: [
        {
          kind: 'photos',
          id: 'ph',
          name: 'Flight',
          visible: true,
          items: [{ id: 'a', src: { path: 'a.jpg' }, pos: [91000, 50, 2000] }],
        },
      ],
      severityModels: [],
      classCatalogues: [],
    } as unknown as ProjectManifest;
    ws.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    ws.getState().setOrientation({
      ...emptyOrientation(),
      photos: { ph: { a: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [-91000, 0, -2000] } } },
    });
    const ctx: RendererToolContext = {
      workspace: ws,
      window: 'scene3d',
      scene: () => null,
      fetchJson: () => Promise.resolve(null),
      captureFrame: () => Promise.resolve(null),
      now: () => new Date(0),
    };
    const places = placeIndex(ctx);
    expect(places.find((p) => p.id === 'layer:ph')?.p).toEqual([0, 50, 0]);
    expect(places.find((p) => p.id === 'photo:a')?.eye?.pos).toEqual([0, 50, 0]);
  });
});
```

(Use the `window` value and `openProject` call shape the other tests in `packages/ai/src` use; `asset-index.test.ts` lines 24-36 shows the context.)

In `spotEntries.test.ts` add: an entry for a photo with a correction `offsetM: [5, 0, 0]` has `pos` moved by 5 m east (pins what `useSpotEntries.ts:111` already passes).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/ai/src/places.test.ts apps/desktop/src/renderer/workspace/spot/spotEntries.test.ts`
Expected: `places.test.ts` FAILS (`p` is `[91000, 50, 2000]`); the spot case passes already.

- [ ] **Step 3: Implement** (in `places.ts`)

```ts
import { correctedPhoto, photoCorrection } from '@aio/geo';
// inside placeIndex, before the layer loop:
  const orientation = ctx.workspace.getState().orientation;
  const drawn = (layerId: string, p: PhotoRef) => correctedPhoto(p, photoCorrection(orientation, layerId, p.id));
// the photos box:
    } else if (l.kind === 'photos') {
      box = boxOfPoints(l.items.flatMap((i) => { const c = drawn(l.id, i); return c.pos ? [c.pos] : []; }));
// the photo places:
      for (const raw of l.items) {
        const i = drawn(l.id, raw);
        out.push({ id: `photo:${i.id}`, kind: 'photo', name: i.id, detail: `${l.name}${i.takenAt ? `, ${i.takenAt}` : ''}`, layer: l.id,
          ...(i.pos ? { p: i.pos, eye: { pos: i.pos, ...(i.q ? { q: i.q } : {}) } } : {}) });
      }
// photoEye:
    const raw = l.items.find((x) => x.id === id);
    const i = raw ? correctedPhoto(raw, photoCorrection(ctx.workspace.getState().orientation, l.id, raw.id)) : undefined;
    if (i?.pos) return { pos: i.pos, ...(i.q ? { q: i.q } : {}) };
```

(import `PhotoRef` type from `@aio/schema`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/ai/src`
Expected: PASS (the whole `@aio/ai` suite, so camera and photo tools still agree).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/places.ts packages/ai/src/places.test.ts apps/desktop/src/renderer/workspace/spot/spotEntries.test.ts
git commit -m "fix(ai): places read photo positions with their corrections" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The context menu component

**Packages:** `@aio/ui`

**Files:**

- Create: `packages/ui/src/actions/ContextMenu.tsx`
- Modify: `packages/ui/src/actions/index.ts` (`export * from './ContextMenu';`)
- Test: `packages/ui/src/actions/ContextMenu.test.tsx`

**Interfaces:**

- Consumes: `ResolvedItem`, `SECTION_ORDER` (Task 1); `arrowFocus`, `useFocusTrap` (`../focus`); `useT` (`../i18n`); `Icon`; strings `tree.dates.menu.back` (existing).
- Produces:
  - `MENU_WIDTH = 286`
  - `placeMenu(x: number, y: number, w: number, h: number, vw: number, vh: number): { left: number; top: number }`
  - `interface ContextMenuProps { items: readonly ResolvedItem[]; x: number; y: number; label: string; title?: string | undefined; testId?: string | undefined; initialSub?: string | undefined; onClose: () => void }`
  - `ContextMenu(props): ReactPortal | null` (classes `dmenu`, `dmenu-item`, `dmenu-sep`, `dmenu-h`, `dmenu-scroll`, `dmenu-row`, `dmenu-picks`, `dmenu-pick`, `dmenu-kbd`; root `data-testid` default `ctx-menu`; Back `ctx-back`)

- [ ] **Step 1: Write the failing test**

```tsx
// packages/ui/src/actions/ContextMenu.test.tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, placeMenu } from './ContextMenu';
import type { ResolvedItem } from './types';

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

const item = (id: string, over: Partial<ResolvedItem> = {}): ResolvedItem => ({
  id,
  label: id,
  section: 'view',
  disabled: false,
  shortcut: null,
  testId: `ctx-item-${id}`,
  present: 'action',
  sub: [],
  subTitle: null,
  run: vi.fn(),
  ...over,
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const key = (k: string, init: KeyboardEventInit = {}) => {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }),
    );
  });
};
function open(items: ResolvedItem[], over: { initialSub?: string; onClose?: () => void } = {}) {
  const onClose = over.onClose ?? vi.fn();
  root = createRoot(host);
  act(() =>
    root?.render(
      <ContextMenu
        items={items}
        x={10}
        y={10}
        label="Menu"
        title="Header"
        onClose={onClose}
        {...(over.initialSub ? { initialSub: over.initialSub } : {})}
      />,
    ),
  );
  return onClose;
}

describe('ContextMenu', () => {
  it('portals to the body with a header, sections in order and separators between them', () => {
    open([
      item('show', { section: 'view' }),
      item('open', { section: 'open' }),
      item('del', { section: 'danger' }),
    ]);
    const menu = q('ctx-menu');
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(menu?.textContent).toContain('Header');
    const order = [...(menu?.querySelectorAll('[data-testid^="ctx-item-"], .dmenu-sep') ?? [])].map(
      (e) => e.getAttribute('data-testid') ?? 'sep',
    );
    expect(order).toEqual(['ctx-item-open', 'sep', 'ctx-item-show', 'sep', 'ctx-item-del']);
  });

  it('walks with arrows, Home and End, and type-ahead finds an item by its first letters', () => {
    open([item('alpha'), item('beta'), item('gamma')]);
    expect(document.activeElement).toBe(q('ctx-item-alpha'));
    key('ArrowDown');
    expect(document.activeElement).toBe(q('ctx-item-beta'));
    key('End');
    expect(document.activeElement).toBe(q('ctx-item-gamma'));
    key('Home');
    key('g');
    expect(document.activeElement).toBe(q('ctx-item-gamma'));
  });

  it('opens a submenu with Right, goes back with Left or Escape, and Back', () => {
    const run = vi.fn();
    open([
      item('cmp', {
        present: 'submenu',
        subTitle: 'Compare with',
        sub: [{ id: 'oct', label: 'Oct', testId: 'compare-to-oct' }],
        run,
      }),
    ]);
    key('ArrowRight');
    expect(q('compare-to-oct')).not.toBeNull();
    expect(q('ctx-menu')?.textContent).toContain('Compare with');
    key('ArrowLeft');
    expect(q('compare-to-oct')).toBeNull();
    act(() => q('ctx-item-cmp')?.click());
    key('Escape');
    expect(q('ctx-item-cmp')).not.toBeNull();
    act(() => q('ctx-item-cmp')?.click());
    act(() => q('ctx-back')?.click());
    expect(q('ctx-item-cmp')).not.toBeNull();
  });

  it('runs an item after closing; a greyed item says why and does nothing', () => {
    const go = item('go');
    const no = item('no', { disabled: 'Not here.' });
    const onClose = open([go, no]);
    act(() => q('ctx-item-no')?.click());
    expect(no.run).not.toHaveBeenCalled();
    expect(q('ctx-item-no')?.getAttribute('aria-disabled')).toBe('true');
    expect(q('ctx-item-no')?.title).toBe('Not here.');
    act(() => q('ctx-item-go')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(go.run).toHaveBeenCalledWith();
  });

  it('runs an inline item with its id, and a pick keeps the menu open', () => {
    const move = item('move', {
      present: 'inline',
      sub: [
        { id: 'sep', label: 'Sep', testId: 'move-to-sep' },
        { id: 'every', label: 'Every', testId: 'move-to-every', disabled: 'Here.' },
      ],
    });
    const colour = item('colour', {
      present: 'picks',
      sub: [{ id: '5', label: 'Colour 5', testId: 'date-menu-colour-5', checked: true }],
    });
    const onClose = open([move, colour]);
    expect(q('move-to-every')?.getAttribute('aria-disabled')).toBe('true');
    act(() => q('date-menu-colour-5')?.click());
    expect(colour.run).toHaveBeenCalledWith('5');
    expect(onClose).not.toHaveBeenCalled();
    expect(q('date-menu-colour-5')?.getAttribute('aria-checked')).toBe('true');
    act(() => q('move-to-sep')?.click());
    expect(move.run).toHaveBeenCalledWith('sep');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens straight into a submenu, where Escape closes', () => {
    const onClose = open(
      [
        item('align', {
          present: 'submenu',
          sub: [{ id: 't', label: 'Target', testId: 'align-t' }],
        }),
      ],
      { initialSub: 'align' },
    );
    expect(q('align-t')).not.toBeNull();
    key('Escape');
    expect(onClose).toHaveBeenCalled();
  });

  it('gives focus back to the invoker on close', async () => {
    const invoker = document.createElement('button');
    document.body.append(invoker);
    invoker.focus();
    const onClose = vi.fn(() => {
      root?.render(<></>);
    });
    open([item('a')], { onClose });
    key('Escape');
    // the focus trap gives focus back in a microtask, after React removed the menu
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });
});

describe('placeMenu', () => {
  it('keeps a tall menu inside the window', () => {
    expect(placeMenu(1000, 650, 286, 520, 1100, 700)).toEqual({ left: 806, top: 172 });
    expect(placeMenu(-5, -5, 286, 100, 1100, 700)).toEqual({ left: 8, top: 8 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/src/actions/ContextMenu.test.tsx`
Expected: FAIL, cannot resolve `./ContextMenu`.

- [ ] **Step 3: Implement**

```tsx
// packages/ui/src/actions/ContextMenu.tsx
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { arrowFocus, useFocusTrap } from '../focus';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import { SECTION_ORDER, type ResolvedItem, type SubItem } from './types';

export const MENU_WIDTH = 286;
const TYPE_AHEAD_MS = 700;

/** Where a menu of `w` by `h` opened at (x, y) goes so that it stays inside the window. */
export function placeMenu(x: number, y: number, w: number, h: number, vw: number, vh: number) {
  return { left: Math.max(8, Math.min(x, vw - w - 8)), top: Math.max(8, Math.min(y, vh - h - 8)) };
}

export interface ContextMenuProps {
  items: readonly ResolvedItem[];
  x: number;
  y: number;
  /** The menu's accessible name. */
  label: string;
  /** The heading drawn at the top (a name, "3 datasets"). */
  title?: string | undefined;
  /** Default `ctx-menu`; the date and dataset menus keep `date-menu` and `move-menu`. */
  testId?: string | undefined;
  /** Open this item's submenu at once; Escape then closes the menu. */
  initialSub?: string | undefined;
  onClose: () => void;
}

/**
 * The right-click menu (spec section 2): sections in a fixed order with separators, a header,
 * shortcuts, greyed items with their reason; Up, Down, Home, End and type-ahead; Right opens a
 * submenu (its items replace the menu's, with Back), Left and Escape go back; focus returns to
 * the invoker on close.
 */
export function ContextMenu(props: ContextMenuProps) {
  const { items, onClose } = props;
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<string | null>(props.initialSub ?? null);
  const [height, setHeight] = useState<number | null>(null);
  const typed = useRef({ text: '', at: 0 });

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', away, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
    };
  }, [onClose]);
  useFocusTrap(list, true, {
    onEscape: () => {
      if (view !== null && props.initialSub === undefined) setView(null);
      else onClose();
    },
  });
  // measured height once drawn (a picked colour adds Reset; a submenu swaps the items)
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (el.offsetHeight > 0) setHeight(el.offsetHeight);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  // after a view switch the pressed button is gone: focus the first item of the new view
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    list.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [view]);

  const placed = placeMenu(
    props.x,
    props.y,
    MENU_WIDTH,
    height ?? 300,
    window.innerWidth,
    window.innerHeight,
  );
  const style: CSSProperties = { ...placed, width: MENU_WIDTH };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const root = e.currentTarget;
    const at = document.activeElement;
    if (!(at instanceof HTMLElement)) return;
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && at.classList.contains('dmenu-pick')) {
      const next = e.key === 'ArrowRight' ? at.nextElementSibling : at.previousElementSibling;
      if (next instanceof HTMLElement) next.focus();
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowRight' && at.dataset.sub) {
      e.preventDefault();
      setView(at.dataset.sub);
      return;
    }
    if (e.key === 'ArrowLeft' && view !== null && props.initialSub === undefined) {
      e.preventDefault();
      setView(null);
      return;
    }
    if (arrowFocus(root, e.key)) {
      e.preventDefault();
      return;
    }
    if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      const text =
        (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : '') + e.key.toLowerCase();
      typed.current = { text, at: now };
      const hit = [...root.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) =>
        (el.dataset.label ?? el.textContent ?? '').toLowerCase().startsWith(text),
      );
      if (hit) {
        hit.focus();
        e.preventDefault();
      }
    }
  };

  const subButton = (
    s: SubItem,
    onPick: () => void,
    role: 'menuitem' | 'menuitemradio' = 'menuitem',
  ): ReactNode => (
    <Fragment key={s.id}>
      <button
        type="button"
        role={role}
        className="dmenu-item"
        aria-disabled={s.disabled ? true : undefined}
        aria-checked={role === 'menuitemradio' ? s.checked === true : undefined}
        title={s.disabled || undefined}
        data-testid={s.testId}
        data-label={s.label}
        onClick={() => {
          if (!s.disabled) onPick();
        }}
      >
        {s.swatch !== undefined ? (
          <span className="sw" style={{ '--sw': s.swatch } as CSSProperties} />
        ) : s.icon ? (
          <Icon name={s.icon} size={14} />
        ) : null}
        <span>{s.label}</span>
        {s.disabled && <span className="faint">{s.disabled}</span>}
      </button>
      {s.after?.(onClose)}
    </Fragment>
  );

  const run = (it: ResolvedItem, sub?: string) => {
    onClose();
    it.run(sub);
  };

  const body = (): ReactNode => {
    const open = view === null ? null : items.find((i) => i.id === view);
    if (open) {
      let group: string | undefined;
      return (
        <>
          {props.initialSub === undefined && (
            <button
              type="button"
              role="menuitem"
              className="dmenu-item"
              data-testid="ctx-back"
              onClick={() => {
                setView(null);
              }}
            >
              <Icon name="back" size={14} />
              <span>{t('tree.dates.menu.back')}</span>
            </button>
          )}
          <div className="dmenu-h faint">{open.subTitle ?? open.label}</div>
          <div className="dmenu-scroll">
            {open.sub.map((s) => {
              const head =
                s.group !== undefined && s.group !== group ? (
                  <div key={`g-${s.group}`} className="dmenu-h faint">
                    {s.group}
                  </div>
                ) : null;
              group = s.group;
              return (
                <Fragment key={s.id}>
                  {head}
                  {subButton(s, () => {
                    run(open, s.id);
                  })}
                </Fragment>
              );
            })}
          </div>
        </>
      );
    }
    const out: ReactNode[] = [];
    let section: string | null = null;
    // sections in their fixed order whoever built the list (the sort is stable)
    const sorted = [...items].sort(
      (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
    );
    for (const it of sorted) {
      if (section !== null && it.section !== section)
        out.push(<div key={`sep-${it.id}`} className="dmenu-sep" role="separator" />);
      section = it.section;
      if (it.present === 'inline') {
        out.push(
          <Fragment key={it.id}>
            <div className="dmenu-h faint">{it.label}</div>
            <div className="dmenu-scroll">
              {it.sub.map((s) =>
                subButton(
                  s,
                  () => {
                    run(it, s.id);
                  },
                  'menuitemradio',
                ),
              )}
            </div>
          </Fragment>,
        );
      } else if (it.present === 'picks') {
        out.push(
          <div key={it.id} className="dmenu-row" role="group" aria-label={it.label}>
            <span>{it.label}</span>
            <div className="dmenu-picks">
              {it.sub.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s.checked === true}
                  className="dmenu-pick"
                  aria-label={s.label}
                  title={s.label}
                  data-testid={s.testId}
                  onClick={() => {
                    it.run(s.id);
                  }}
                >
                  {s.icon ? (
                    <Icon name={s.icon} size={14} />
                  ) : (
                    <span
                      className="sw"
                      style={
                        s.swatch !== undefined ? ({ '--sw': s.swatch } as CSSProperties) : undefined
                      }
                    />
                  )}
                </button>
              ))}
            </div>
          </div>,
        );
      } else {
        const sub = it.present === 'submenu';
        out.push(
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className={it.section === 'danger' ? 'dmenu-item danger' : 'dmenu-item'}
            aria-disabled={it.disabled ? true : undefined}
            aria-haspopup={sub ? 'menu' : undefined}
            title={it.disabled || undefined}
            data-testid={it.testId}
            data-label={it.label}
            data-sub={sub && !it.disabled ? it.id : undefined}
            onClick={() => {
              if (it.disabled) return;
              if (sub) setView(it.id);
              else run(it);
            }}
          >
            {it.icon && <Icon name={it.icon} size={14} />}
            <span>{it.label}</span>
            {it.shortcut && <span className="dmenu-kbd">{it.shortcut}</span>}
            {sub && <Icon name="chev-r" size={12} className="faint" />}
          </button>,
        );
      }
    }
    return out;
  };

  return createPortal(
    <div
      ref={list}
      className="dmenu"
      role="menu"
      aria-label={props.label}
      style={style}
      data-testid={props.testId ?? 'ctx-menu'}
      onKeyDown={onKey}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      {view === null && props.title && <div className="dmenu-h faint">{props.title}</div>}
      {body()}
    </div>,
    document.body,
  );
}
```

Add `export * from './ContextMenu';` to `actions/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/ui/src/actions`
Expected: PASS (registry and menu).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/actions/ContextMenu.tsx packages/ui/src/actions/ContextMenu.test.tsx packages/ui/src/actions/index.ts
git commit -m "feat(ui): context menu built from the action registry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Tree rows: inline rename, menu keys, every row has a menu

**Packages:** `@aio/ui`

**Files:**

- Create: `packages/ui/src/tree/RenameField.tsx` (moved out of `DateTree.tsx:73-120`, gains `testId`)
- Modify: `packages/ui/src/tree/DatasetTree.tsx` (props; `menuPoint` neighbours `isMenuKey`, `keyMenuPoint`; row keydown; group row keydown; rename field in a row; `unplaceRequest`; row strings from `en.ts`)
- Modify: `packages/ui/src/tree/DateTree.tsx` (use `RenameField`; folder row keydown and `stopPropagation`; forward `onItemMenu` for every row, also rows without date-able layers)
- Modify: `packages/ui/src/index.ts` (export `isMenuKey`, `keyMenuPoint`, `RenameField`)
- Test: `packages/ui/src/tree/RenameField.test.tsx`, `packages/ui/src/tree/menuKeys.test.tsx`; existing `DatasetTree.test.tsx`, `DateTree.test.tsx`, `walkRows.test.tsx`, `eyes.test.tsx` stay green

**Interfaces:**

- Consumes: strings `tree.renameLayer`, `tree.row.*` (Task 2).
- Produces:
  - `isMenuKey(e: { key: string; shiftKey: boolean }): boolean` (Shift+F10, ContextMenu)
  - `keyMenuPoint(el: HTMLElement): MenuPoint` (`{ x: left + 24, y: bottom }`)
  - `DatasetTreeProps` gains: `renamingLayer?: string | null`, `onRenameLayerStart?: (layerId: string) => void` (F2), `onRenameLayer?: (layerId: string, name: string) => void`, `onRenameLayerEnd?: () => void`, `unplaceRequest?: { id: string; seq: number } | null`. `DateTreeProps` passes them through unchanged.
  - `onItemMenu` now fires for every row (annotation rows and basemaps included); `DateTree` forwards `{ name, item, layerIds: datableLayerIds(item), from, x, y }` even when `layerIds` is empty.
  - `onGroupMenu` gains a fourth argument `fold: { expanded: boolean; toggle: () => void }` (the tree keeps the fold state); `DateItemMenuRequest` gains `fold?: { expanded: boolean; toggle: () => void } | undefined`, set for group headers, and `group?: TreeGroupKind | undefined`.
  - Rename field test id `layer-rename`; folder rename keeps `date-rename`.

- [ ] **Step 1: Write the failing tests**

```tsx
// packages/ui/src/tree/menuKeys.test.tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetTree, isMenuKey, type DatasetTreeProps } from './DatasetTree';
import type { TreeGroup } from './model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
});

const groups: TreeGroup[] = [
  {
    kind: 'models',
    label: 'Models',
    icon: 'scene',
    count: 1,
    items: [{ id: 'm', layerId: 'm', layerKind: 'mesh', name: 'Model' }],
  },
  {
    kind: 'annotations',
    label: 'Annotations',
    icon: 'anno',
    count: 1,
    items: [{ id: 'issues', name: 'Issues', meta: '3' }],
  },
];
const render = (over: Partial<DatasetTreeProps> = {}) => {
  const props: DatasetTreeProps = {
    groups,
    hidden: {},
    selectedId: null,
    activeClip: null,
    collapsed: false,
    onToggleVisible: vi.fn(),
    onSelect: vi.fn(),
    onItemMenu: vi.fn(),
    onGroupMenu: vi.fn(),
    dragGroupIds: (g) => g.items.flatMap((i) => (i.layerId ? [i.layerId] : [])),
    defaultOpen: ['models', 'annotations'],
    ...over,
  };
  root = createRoot(host);
  act(() => root?.render(<DatasetTree {...props} />));
  return props;
};
const press = (el: Element | null, key: string, shiftKey = false) => {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  });
};

describe('menu keys on the tree', () => {
  it('knows Shift+F10 and the Menu key', () => {
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
  });

  it('opens a row menu from the keyboard, under the row, and an annotation row has one too', () => {
    const p = render();
    press(host.querySelector('[data-testid="tree-row-m"]'), 'F10', true);
    expect(p.onItemMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'm' }), {
      x: 24,
      y: 0,
    });
    press(host.querySelector('.titem[title="Issues"]'), 'ContextMenu');
    expect(p.onItemMenu).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'issues' }),
      expect.anything(),
    );
  });

  it('opens a group header menu from the keyboard on its fold button', () => {
    const p = render();
    press(host.querySelector('[data-testid="tree-group-toggle-models"]'), 'F10', true);
    expect(p.onGroupMenu).toHaveBeenCalledWith(groups[0], ['m'], expect.anything(), {
      expanded: true,
      toggle: expect.any(Function),
    });
  });

  it('F2 starts a rename; the field saves on Enter and the row shows it in place', () => {
    const start = vi.fn();
    render({ onRenameLayerStart: start });
    press(host.querySelector('[data-testid="tree-row-m"]'), 'F2');
    expect(start).toHaveBeenCalledWith('m');
    const save = vi.fn();
    const end = vi.fn();
    act(() => root?.unmount());
    render({ renamingLayer: 'm', onRenameLayer: save, onRenameLayerEnd: end });
    const field = host.querySelector<HTMLInputElement>('[data-testid="layer-rename"]');
    expect(field?.getAttribute('aria-label')).toBe('Name of Model');
    if (field) field.value = 'Site model';
    press(field, 'Enter');
    expect(save).toHaveBeenCalledWith('m', 'Site model');
    expect(end).toHaveBeenCalled();
  });

  it('keeps the row strings people and tests read', () => {
    render({ hidden: { m: true } });
    expect(host.querySelector('[aria-label="Show Model"]')).not.toBeNull();
  });
});
```

```tsx
// packages/ui/src/tree/RenameField.test.tsx
// @vitest-environment jsdom
// Enter saves the trimmed text when it changed, Escape cancels, leaving the field saves, and
// onEnd runs exactly once (port of the folder rename cases in DateTree.test.tsx).
```

(Write the four cases in the same createRoot pattern: `Enter` with `'  New '` calls `onCommit('New')`; unchanged text calls no `onCommit`; `Escape` calls only `onEnd`; `blur` after `Enter` does not call `onEnd` twice.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/ui/src/tree/menuKeys.test.tsx packages/ui/src/tree/RenameField.test.tsx`
Expected: FAIL (`isMenuKey` and `RenameField` missing).

- [ ] **Step 3: Implement**

`RenameField.tsx`: the component of `DateTree.tsx:73-120` with one more prop `testId: string` (DateTree passes `'date-rename'`).

In `DatasetTree.tsx` next to `menuPoint`:

```ts
/** Shift+F10 and the Menu key: open the focused element's menu (spec section 2). */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return (e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu';
}

/** Where a menu opened from the keyboard goes: just inside the element, under it. */
export function keyMenuPoint(el: HTMLElement): MenuPoint {
  const r = el.getBoundingClientRect();
  return { x: r.left + 24, y: r.bottom };
}
```

In the row's `onKeyDown` (after the `e.target !== e.currentTarget` guard):

```ts
if (isMenuKey(e) && props.onItemMenu) {
  e.preventDefault();
  e.stopPropagation();
  props.onItemMenu(it, keyMenuPoint(e.currentTarget));
  return;
}
if (e.key === 'F2' && it.layerId && props.onRenameLayerStart) {
  e.preventDefault();
  props.onRenameLayerStart(it.layerId);
  return;
}
```

`moving(it)` attaches `onContextMenu` for every row whenever `props.onItemMenu` is set (it already does). In the row, when `props.renamingLayer === it.layerId`, draw `<RenameField testId="layer-rename" initial={it.name} label={t('tree.renameLayer', { name: it.name })} placeholder={it.name} onCommit={(n) => props.onRenameLayer?.(it.layerId ?? '', n)} onEnd={() => props.onRenameLayerEnd?.()} />` in place of `<span className="tn">`. Replace the hard-coded strings with `t('tree.row.show' | 'tree.row.hide', { name })`, `t('tree.row.showTip' | 'tree.row.hideTip')`, `t('tree.row.cloud', { name })`, `t('tree.row.cloudTip')`, `t('tree.row.drawing', { name })`, `t('tree.row.drawingTip')`, `t('tree.row.more', { count })`, `t('tree.row.fewer')`.

On `.tgroup-row` add `onKeyDown={(e) => { if (groupMenu && isMenuKey(e)) { e.preventDefault(); e.stopPropagation(); groupMenu(g, carried, keyMenuPoint(e.currentTarget), fold); } }}`, and pass the same `fold` from `onContextMenu`, where `const fold = { expanded, toggle: () => { setOpen((o) => ({ ...o, [g.kind]: !isOpen(g.kind) })); } };`. `DateTree`'s nested `onGroupMenu` puts `fold` and `group: g.kind` into the `DateItemMenuRequest` it forwards. The `unplaceRequest` prop: adjust during render, as the sidebar does elsewhere:

```ts
const [seenUnplace, setSeenUnplace] = useState(props.unplaceRequest?.seq ?? 0);
if (props.unplaceRequest && props.unplaceRequest.seq !== seenUnplace) {
  setSeenUnplace(props.unplaceRequest.seq);
  setUnplacing(props.unplaceRequest.id);
}
```

In `DateTree.tsx`: import `RenameField`, `isMenuKey`, `keyMenuPoint`; on `.dfolder-row` add `e.stopPropagation()` in `onContextMenu` (so empty space does not also open the project menu) and `onKeyDown` opening `onFolderMenu({ folder: f, expanded, toggle, ...keyMenuPoint(e.currentTarget) })` on a menu key; the nested `onItemMenu` forwards every row:

```ts
                onItemMenu={
                  onItemMenu
                    ? (item, at) => {
                        onItemMenu({ name: item.name, item, layerIds: datableLayerIds(item), from: f.id, ...at });
                      }
                    : undefined
                }
```

Export `isMenuKey`, `keyMenuPoint` from the `./tree/DatasetTree` line of `packages/ui/src/index.ts` and add `export { RenameField } from './tree/RenameField';`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/ui/src/tree`
Expected: PASS (new and existing tree tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/tree/RenameField.tsx packages/ui/src/tree/RenameField.test.tsx packages/ui/src/tree/menuKeys.test.tsx packages/ui/src/tree/DatasetTree.tsx packages/ui/src/tree/DateTree.tsx packages/ui/src/index.ts
git commit -m "feat(ui): tree rows rename in place and open their menu from the keyboard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The project writer renames a layer

**Packages:** `@aio/project`

**Files:**

- Modify: `packages/project/src/builder/create.ts:197-200` (`patchLayers`, first branch)
- Create: `packages/project/src/builder/rename.test.ts`

**Interfaces:**

- Consumes: `LayerPatch` `{ name }` (Task 3).
- Produces: `updateLayers(root, layerIds, { name })` writes the trimmed name, nothing else.

- [ ] **Step 1: Write the failing test**

```ts
// packages/project/src/builder/rename.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createProject, readManifestFile, updateLayers } from './create';
import { updateManifestFile } from './manifestFile';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-rename-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('renames a layer of any kind, keeping everything else, with a backup', async () => {
  const { root } = await createProject(dir, {
    name: 'Yard',
    type: 'inspection',
    epsg: 32639,
    origin: [500000, 3200000, 0],
    severityTemplate: null,
  });
  await updateManifestFile(root, (m) => ({
    manifest: {
      ...m,
      layers: [
        {
          kind: 'vector',
          id: 'v',
          name: 'Old',
          visible: true,
          capture: undefined,
          src: { path: 'vectors/v.geojson' },
          format: 'geojson',
        },
      ],
    },
  }));
  const before = await readManifestFile(root);
  const r = await updateLayers(root, ['v'], { name: '  Site outline ' });
  expect(r.manifest.layers[0]).toEqual({ ...before.layers[0], name: 'Site outline' });
  expect(await readFile(r.backup, 'utf8')).toContain('"Old"');
  await expect(updateLayers(root, ['nope'], { name: 'x' })).rejects.toThrow('not in this project');
});
```

(Use the `updateManifestFile` call shape `manifestFile.ts` exports; if it is named differently, the shape `create.ts:301` uses.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/project/src/builder/rename.test.ts`
Expected: FAIL (the patch falls through to the video branch: "is not a video").

- [ ] **Step 3: Implement** (first branch inside `layers.map` of `patchLayers`)

```ts
if ('name' in patch) return { ...l, name: patch.name.trim() };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/project/src/builder/rename.test.ts packages/project/src/builder/manifestFile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/project/src/builder/create.ts packages/project/src/builder/rename.test.ts
git commit -m "feat(project): rename any layer through updateLayers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Layer info, export and reveal in main

**Packages:** `@aio/project`, desktop main

**Files:**

- Create: `packages/project/src/builder/layerFiles.ts`
- Modify: `packages/project/src/builder/index.ts` (export block)
- Create: `apps/desktop/src/main/layers.ts`
- Modify: `apps/desktop/src/main/index.ts` (register next to `registerLibraryActionsIpc`, line ~904; `export:cancel` line 1322 also cancels layer jobs)
- Test: `packages/project/src/builder/layerFiles.test.ts`, `apps/desktop/src/main/layers.test.ts`

**Interfaces:**

- Consumes: `layerRefs(layer)` (`removePlan.ts:143`), `fullLayerExtent` (Task 4), `readManifestFile`, `LayerInfo`, `IpcEvent<'export:progress'>`, `Handle` (`main/notYet.ts:5`), `collectHandlers` (tests), `readOrientation` (`main/orientation.ts`).
- Produces:
  - `layerFolderName(name: string): string` (Windows-safe: `<>:"/\|?*` and control characters become `_`, trailing dots and spaces dropped, 1 to 100 characters, reserved names like `CON` get a `_` suffix)
  - `isLocalFrame(l: Layer): boolean` (mesh, non-COPC point cloud, photos, panoramas, raster with corners, walk)
  - `exportPlan(l: Layer): { from: string; to: string }[]` (`from` project-relative; `to` relative to the layer folder: the path below the files' common folder)
  - `crsSidecar(m: ProjectManifest, l: Layer): Record<string, unknown> | null`
  - `mainFile(l: Layer): string | null`
  - `readLayerInfo(root: string, m: ProjectManifest, l: Layer, orientation: OrientationFile | null): Promise<LayerInfo>`
  - `exportLayers(root: string, m: ProjectManifest, layerIds: readonly string[], dir: string, o?: { signal?: AbortSignal; progress?: (done: number, total: number, file: string) => void }): Promise<{ written: number; skipped: string[]; cancelled: boolean }>`
  - `registerLayerIpc(deps: { handle: Handle; projects: { root(id: string): string | undefined; package(id: string): unknown }; reveal(path: string): void; emit(e: IpcEvent<'export:progress'>): void }): { cancel(jobId: string): boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/project/src/builder/layerFiles.test.ts
import type { Layer, ProjectManifest } from '@aio/schema';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  crsSidecar,
  exportLayers,
  exportPlan,
  isLocalFrame,
  layerFolderName,
  mainFile,
  readLayerInfo,
} from './layerFiles';

let base: string;
let root: string;
let out: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-layerfiles-'));
  root = join(base, 'project');
  out = join(base, 'out');
  await mkdir(join(root, 'models'), { recursive: true });
  await mkdir(join(root, 'photos', 'ph'), { recursive: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(root, 'models', 'm.glb'), Buffer.alloc(2048, 1));
  await writeFile(join(root, 'photos', 'ph', 'a.jpg'), Buffer.alloc(10, 2));
  await writeFile(join(root, 'photos', 'ph', 'b.jpg'), Buffer.alloc(20, 3));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const mesh = {
  kind: 'mesh',
  id: 'm',
  name: 'Site: model?',
  visible: true,
  src: { path: 'models/m.glb' },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
} as unknown as Layer;
const photos = {
  kind: 'photos',
  id: 'ph',
  name: 'Flight A',
  visible: true,
  items: [
    { id: 'a', src: { path: 'photos/ph/a.jpg' }, pos: [0, 10, 0] },
    { id: 'b', src: { path: 'photos/ph/b.jpg' }, pos: [2, 12, -4] },
  ],
} as unknown as Layer;
const vector = {
  kind: 'vector',
  id: 'v',
  name: 'Flight A',
  visible: true,
  src: { path: 'vectors/v.geojson' },
  format: 'geojson',
} as unknown as Layer;
const m = {
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 20],
  layers: [mesh, photos, vector],
} as unknown as ProjectManifest;

describe('layer files', () => {
  it('names a folder safely on Windows', () => {
    expect(layerFolderName('Site: model?')).toBe('Site_ model_');
    expect(layerFolderName('CON')).toBe('CON_');
    expect(layerFolderName('trail. ')).toBe('trail');
    expect(layerFolderName('')).toBe('dataset');
  });

  it('plans the copy below the files common folder and finds the main file', () => {
    expect(exportPlan(photos)).toEqual([
      { from: 'photos/ph/a.jpg', to: 'a.jpg' },
      { from: 'photos/ph/b.jpg', to: 'b.jpg' },
    ]);
    expect(exportPlan(mesh)).toEqual([{ from: 'models/m.glb', to: 'm.glb' }]);
    expect(mainFile(photos)).toBe('photos/ph/a.jpg');
  });

  it('writes a CRS sidecar for local-frame layers only', () => {
    expect(isLocalFrame(mesh)).toBe(true);
    expect(isLocalFrame(vector)).toBe(false);
    expect(crsSidecar(m, mesh)).toMatchObject({
      schema: 'aio.layer-crs/1',
      crs: { epsg: 32639 },
      origin: [500000, 3200000, 20],
      transform: mesh.kind === 'mesh' ? mesh.transform : [],
    });
    expect(crsSidecar(m, vector)).toBeNull();
  });

  it('reads files, sizes, count and extent', async () => {
    const info = await readLayerInfo(root, m, photos, null);
    expect(info.files).toEqual([
      { path: 'photos/ph/a.jpg', bytes: 10 },
      { path: 'photos/ph/b.jpg', bytes: 20 },
    ]);
    expect(info.bytes).toBe(30);
    expect(info.count).toBe(2);
    expect(info.countKind).toBe('items');
    expect(info.extent).toEqual({ min: [0, 10, -4], max: [2, 12, 0] });
    expect(info.mainFile).toBe('photos/ph/a.jpg');
    expect(info.importedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('copies files unchanged with a sidecar, and reports progress', async () => {
    const seen: number[] = [];
    const r = await exportLayers(root, m, ['m', 'ph'], out, {
      progress: (done) => seen.push(done),
    });
    expect(r).toEqual({ written: 2, skipped: [], cancelled: false });
    expect(await readFile(join(out, 'Site_ model_', 'm.glb'))).toEqual(Buffer.alloc(2048, 1));
    expect(
      JSON.parse(await readFile(join(out, 'Site_ model_', 'Site_ model_.crs.json'), 'utf8')),
    ).toMatchObject({ origin: [500000, 3200000, 20] });
    expect((await readdir(join(out, 'Flight A'))).sort()).toEqual([
      'Flight A.crs.json',
      'a.jpg',
      'b.jpg',
    ]);
    expect(seen.at(-1)).toBe(5); // 1 + 2 files and two sidecars
  });

  it('refuses to overwrite and keeps same-named layers apart', async () => {
    await mkdir(join(out, 'Flight A'));
    const r = await exportLayers(root, m, ['ph'], out);
    expect(r).toEqual({ written: 0, skipped: ['Flight A'], cancelled: false });
    await rm(join(out, 'Flight A'), { recursive: true });
    await mkdir(join(root, 'vectors'));
    await writeFile(join(root, 'vectors', 'v.geojson'), '{}');
    const both = await exportLayers(root, m, ['ph', 'v'], out);
    expect(both.written).toBe(2);
    expect(await readdir(out)).toEqual(expect.arrayContaining(['Flight A', 'Flight A (v)']));
  });

  it('stops when cancelled and removes the half-written folder', async () => {
    const ac = new AbortController();
    const r = await exportLayers(root, m, ['ph'], out, {
      signal: ac.signal,
      progress: () => {
        ac.abort();
      },
    });
    expect(r.cancelled).toBe(true);
    expect(await readdir(out)).toEqual([]);
  });
});
```

```ts
// apps/desktop/src/main/layers.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLayerIpc } from './layers';
import { collectHandlers } from './notYet';
import { writeProject } from './testing';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-layers-main-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const manifest = {
  schema: 'aio.project/1',
  id: 'yard',
  name: 'Yard',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [],
  severityModels: [],
  classCatalogues: [],
  layers: [
    {
      kind: 'mesh',
      id: 'm',
      name: 'Model',
      visible: true,
      src: { path: 'models/m.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
};

describe('layer channels', () => {
  it('answers info, reveals the main file, exports with progress, refuses a package', async () => {
    const dir = await writeProject(join(base, 'p'), manifest, { 'models/m.glb': 'glb' });
    const reveal = vi.fn();
    const emit = vi.fn();
    const roots: Record<string, string> = { p1: dir };
    let jobs: { cancel(id: string): boolean } | undefined;
    const t = collectHandlers((handle) => {
      jobs = registerLayerIpc({
        handle,
        projects: { root: (id) => roots[id], package: (id) => (id === 'pkg' ? {} : undefined) },
        reveal,
        emit,
      });
    });
    expect(t.channels()).toEqual(['layer:export', 'layer:info', 'layer:reveal']);
    const info = await t.call('layer:info', { projectId: 'p1', layerId: 'm' });
    expect(info.ok && info.info.files).toEqual([{ path: 'models/m.glb', bytes: 3 }]);
    expect((await t.call('layer:reveal', { projectId: 'p1', layerId: 'm' })).ok).toBe(true);
    expect(reveal).toHaveBeenCalledWith(join(dir, 'models', 'm.glb'));
    const out = join(base, 'out');
    const r = await t.call('layer:export', {
      projectId: 'p1',
      jobId: 'j',
      layerIds: ['m'],
      dir: out,
    });
    expect(r).toEqual({ ok: true, written: 1, skipped: [], cancelled: false });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j', total: 2 })); // the file and its sidecar
    expect(jobs?.cancel('nothing')).toBe(false);
    const pkg = await t.call('layer:export', {
      projectId: 'pkg',
      jobId: 'k',
      layerIds: ['m'],
      dir: out,
    });
    expect(pkg.ok).toBe(false);
    expect((await t.call('layer:info', { projectId: 'nope', layerId: 'm' })).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/project/src/builder/layerFiles.test.ts apps/desktop/src/main/layers.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement `layerFiles.ts`**

```ts
// packages/project/src/builder/layerFiles.ts
import type { Layer, LayerInfo, OrientationFile, ProjectManifest } from '@aio/schema';
import { constants } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fullLayerExtent } from './extents';
import { layerRefs } from './removePlan';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A folder name Windows accepts for a layer name. */
export function layerFolderName(name: string): string {
  let s = [...name].map((c) => (/[<>:"/\\|?*]/.test(c) || c.charCodeAt(0) < 32 ? '_' : c)).join('');
  s = s.replace(/[. ]+$/, '').slice(0, 100);
  if (s === '') return 'dataset';
  return RESERVED.test(s) ? `${s}_` : s;
}

/** Layers whose files are in the local frame, which need the CRS sidecar to be placed elsewhere. */
export function isLocalFrame(l: Layer): boolean {
  if (l.kind === 'pointcloud') return l.format !== 'copc';
  if (l.kind === 'raster') return l.corners !== undefined;
  return l.kind === 'mesh' || l.kind === 'photos' || l.kind === 'panoramas' || l.kind === 'walk';
}

const commonDir = (paths: readonly string[]): string => {
  const parts = paths.map((p) => p.split('/').slice(0, -1));
  const first = parts[0] ?? [];
  let n = 0;
  while (n < first.length && parts.every((q) => q[n] === first[n])) n++;
  return first.slice(0, n).join('/');
};

/** Each file of a layer and where it goes inside the layer's export folder. */
export function exportPlan(l: Layer): { from: string; to: string }[] {
  const refs = layerRefs(l);
  const base = commonDir(refs);
  return refs.map((from) => ({ from, to: base ? from.slice(base.length + 1) : from }));
}

/** The file Reveal in folder shows: the layer's first file (a walk's playback copy). */
export function mainFile(l: Layer): string | null {
  if (l.kind === 'walk' && 'path' in l.src) return l.src.path;
  return layerRefs(l)[0] ?? null;
}

export function crsSidecar(m: ProjectManifest, l: Layer): Record<string, unknown> | null {
  if (!isLocalFrame(l)) return null;
  return {
    schema: 'aio.layer-crs/1',
    crs: m.crs,
    origin: m.origin,
    frame: 'local metres from origin: x east, y up, z south',
    ...(l.kind === 'mesh' ? { transform: l.transform } : {}),
    ...(l.kind === 'raster' && l.corners ? { corners: l.corners } : {}),
  };
}

const sizeOf = async (file: string) => {
  try {
    const s = await stat(file);
    return { bytes: s.size, born: s.birthtime };
  } catch {
    return null;
  }
};

export async function readLayerInfo(
  root: string,
  m: ProjectManifest,
  l: Layer,
  orientation: OrientationFile | null,
): Promise<LayerInfo> {
  const refs = layerRefs(l);
  const sizes = await Promise.all(refs.map((p) => sizeOf(join(root, p))));
  const known = sizes.filter((s) => s !== null);
  const main = mainFile(l);
  const mainStat = main ? await sizeOf(join(root, main)) : null;
  const count =
    l.kind === 'photos' || l.kind === 'panoramas'
      ? l.items.length
      : l.kind === 'pointcloud'
        ? (l.pointCount ?? null)
        : null;
  return {
    layerId: l.id,
    name: l.name,
    kind: l.kind,
    files: refs.map((path, i) => ({ path, bytes: sizes[i]?.bytes ?? null })),
    bytes: known.length > 0 ? known.reduce((a, s) => a + s.bytes, 0) : null,
    count,
    countKind: count === null ? null : l.kind === 'pointcloud' ? 'points' : 'items',
    extent: await fullLayerExtent(root, m, l, orientation),
    crs: m.crs,
    importedAt: mainStat ? mainStat.born.toISOString() : null,
    mainFile: main,
  };
}

export async function exportLayers(
  root: string,
  m: ProjectManifest,
  layerIds: readonly string[],
  dir: string,
  o: { signal?: AbortSignal; progress?: (done: number, total: number, file: string) => void } = {},
): Promise<{ written: number; skipped: string[]; cancelled: boolean }> {
  const layers = layerIds.flatMap((id) => {
    const l = m.layers.find((x) => x.id === id);
    return l ? [l] : [];
  });
  const plans = layers.map((l) => ({ l, files: exportPlan(l), side: crsSidecar(m, l) }));
  const total = plans.reduce((n, p) => n + p.files.length + (p.side ? 1 : 0), 0);
  const used = new Set<string>();
  let done = 0;
  let written = 0;
  const skipped: string[] = [];
  for (const { l, files, side } of plans) {
    let name = layerFolderName(l.name);
    if (used.has(name.toLowerCase())) name = layerFolderName(`${l.name} (${l.id})`);
    used.add(name.toLowerCase());
    const folder = join(dir, name);
    if (await sizeOf(folder)) {
      skipped.push(l.name);
      done += files.length + (side ? 1 : 0);
      continue;
    }
    await mkdir(folder, { recursive: true });
    try {
      for (const f of files) {
        if (o.signal?.aborted) throw new Error('cancelled');
        const to = join(folder, ...f.to.split('/'));
        await mkdir(dirname(to), { recursive: true });
        await copyFile(join(root, ...f.from.split('/')), to, constants.COPYFILE_EXCL);
        o.progress?.(++done, total, f.to);
      }
      if (side) {
        if (o.signal?.aborted) throw new Error('cancelled');
        await writeFile(join(folder, `${name}.crs.json`), `${JSON.stringify(side, null, 2)}\n`, {
          flag: 'wx',
        });
        o.progress?.(++done, total, `${name}.crs.json`);
      }
      written++;
    } catch (e) {
      await rm(folder, { recursive: true, force: true });
      if (o.signal?.aborted) return { written, skipped, cancelled: true };
      throw e;
    }
  }
  return { written, skipped, cancelled: false };
}
```

(The cancel test aborts inside `progress` after the first file: the next loop check throws, the folder goes, the result says cancelled.)

Export the seven functions from `builder/index.ts`.

- [ ] **Step 4: Implement `main/layers.ts` and register it**

```ts
// apps/desktop/src/main/layers.ts
import type { IpcEvent } from '@aio/schema';
import { join } from 'node:path';
import type { Handle } from './notYet';
import { readOrientation } from './orientation';

const lib = () => import('@aio/project/builder');
const PACKAGE = 'This is a package: its files stay inside it.';
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface LayerIpcDeps {
  handle: Handle;
  projects: { root(id: string): string | undefined; package(id: string): unknown };
  /** Electron `shell.showItemInFolder`. */
  reveal(path: string): void;
  emit(e: IpcEvent<'export:progress'>): void;
}

/** `layer:info`, `layer:reveal` and `layer:export`; the returned `cancel` serves `export:cancel`. */
export function registerLayerIpc(deps: LayerIpcDeps): { cancel(jobId: string): boolean } {
  const { handle, projects } = deps;
  const running = new Map<string, AbortController>();
  const open = async (projectId: string, layerId: string) => {
    if (projects.package(projectId) !== undefined) return { error: PACKAGE } as const;
    const root = projects.root(projectId);
    if (root === undefined) return { error: `Project "${projectId}" is not open.` } as const;
    const l = await lib();
    const m = await l.readManifestFile(root);
    const layer = m.layers.find((x) => x.id === layerId);
    if (!layer) return { error: `Dataset "${layerId}" is not in this project.` } as const;
    return { root, m, layer, l } as const;
  };

  handle('layer:info', async ({ projectId, layerId }) => {
    try {
      const o = await open(projectId, layerId);
      if ('error' in o) return { ok: false, error: o.error };
      const or = await readOrientation(o.root);
      return {
        ok: true,
        info: await o.l.readLayerInfo(o.root, o.m, o.layer, or.ok ? or.file : null),
      };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  });

  handle('layer:reveal', async ({ projectId, layerId }) => {
    const o = await open(projectId, layerId);
    if ('error' in o) return { ok: false, error: o.error };
    const file = o.l.mainFile(o.layer);
    if (!file) return { ok: false, error: `${o.layer.name} has no file in the project.` };
    deps.reveal(join(o.root, ...file.split('/')));
    return { ok: true };
  });

  handle('layer:export', async ({ projectId, jobId, layerIds, dir }) => {
    if (projects.package(projectId) !== undefined) return { ok: false, error: PACKAGE };
    const root = projects.root(projectId);
    if (root === undefined) return { ok: false, error: `Project "${projectId}" is not open.` };
    const ac = new AbortController();
    running.set(jobId, ac);
    try {
      const l = await lib();
      const m = await l.readManifestFile(root);
      const r = await l.exportLayers(root, m, layerIds, dir, {
        signal: ac.signal,
        progress: (done, total, file) => {
          deps.emit({ jobId, phase: file, done, total });
        },
      });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    } finally {
      running.delete(jobId);
    }
  });

  return {
    cancel: (jobId) => {
      const ac = running.get(jobId);
      ac?.abort();
      return ac !== undefined;
    },
  };
}
```

In `main/index.ts`, beside `registerLibraryActionsIpc(...)`:

```ts
const layerJobs = registerLayerIpc({
  handle,
  projects: registry,
  reveal: (path) => {
    shell.showItemInFolder(path);
  },
  emit: emitExportProgress,
});
```

and change line 1322 to `handle('export:cancel', ({ jobId }) => ({ ok: exportJobs.cancel(jobId) || layerJobs.cancel(jobId) }));` (declare `layerJobs` before that line runs).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/project/src/builder/layerFiles.test.ts apps/desktop/src/main/layers.test.ts apps/desktop/src/main/journal.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/project/src/builder/layerFiles.ts packages/project/src/builder/layerFiles.test.ts packages/project/src/builder/index.ts apps/desktop/src/main/layers.ts apps/desktop/src/main/layers.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): layer info, export and reveal in main" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Align to store, notice, Undo and Redo

**Packages:** desktop renderer

**Files:**

- Create: `apps/desktop/src/renderer/builder/alignToStore.ts`
- Create: `apps/desktop/src/renderer/builder/AlignToNotice.tsx`
- Modify: `apps/desktop/src/renderer/builder/alignSession.ts` (the app's `alignTo` store, next to `photoAlign`)
- Modify: `apps/desktop/src/renderer/exports/Toasts.tsx` (mount `<AlignToNotice />` after `<PhotoAlignNotice />`)
- Test: `apps/desktop/src/renderer/builder/alignToStore.test.ts`, `apps/desktop/src/renderer/builder/AlignToNotice.test.tsx`

**Interfaces:**

- Consumes: `alignSources`, `planAlign`, `formatDistance`, `Fixes`, `AlignBox` (Task 6); `boundsOf`, `groundAt`, `appBoundsDeps` (Task 7); `saveOrientationEdit`, `withPhotoFixes`, `retryOrientation` (`orientationFile.ts`); strings `align.to.*`, `actions.reason.noBounds`, `align.direction.undo`, `align.direction.redo`, `align.direction.say.notLoaded`.
- Produces:
  - `interface AlignToNoticeState { text: string; action: { kind: 'undo' | 'redo'; fixes: Fixes } | null }`
  - `createAlignToStore(deps: AlignToDeps): StoreApi<AlignToStore>` with `alignTo(source: { layerIds: string[] } | { picks: PhotoPick[] }, targetLayerId: string): Promise<void>`, `apply(): Promise<void>`, `dismiss(): void`, state `notice: AlignToNoticeState | null`
  - `interface AlignToDeps { workspace: StoreApi<Workspace>; save(fixes: Fixes): Promise<string | null>; bounds(layerId: string): Promise<AlignBox | null>; ground(x: number, z: number): Promise<number | null>; reload(): void }`
  - `alignTo` (app store in `alignSession.ts`), `useAlignTo(selector)`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/renderer/builder/alignToStore.test.ts
import { emptyOrientation, type ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { Fixes } from './alignTo';
import { createAlignToStore } from './alignToStore';

const manifest = {
  layers: [
    {
      kind: 'photos',
      id: 'ph',
      name: 'Flight',
      visible: true,
      items: [
        { id: 'a', src: { path: 'a' }, pos: [91000, 40, 2000] },
        { id: 'b', src: { path: 'b' }, pos: [91000.2, 41, 2000.2] },
        { id: 'c', src: { path: 'c' } },
      ],
    },
    { kind: 'mesh', id: 'm', name: 'Site model', visible: true, src: { path: 'm' }, transform: [] },
  ],
} as unknown as ProjectManifest;

function setup(
  bounds: { min: [number, number, number]; max: [number, number, number] } | null = {
    min: [-1, 0, -1],
    max: [1, 2, 1],
  },
) {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p', root: 'C:/p', manifest });
  ws.getState().setOrientation(emptyOrientation());
  const saved: Fixes[] = [];
  const save = vi.fn((f: Fixes) => {
    saved.push(f);
    return Promise.resolve(null);
  });
  const store = createAlignToStore({
    workspace: ws,
    save,
    bounds: () => Promise.resolve(bounds),
    ground: () => Promise.resolve(null),
    reload: vi.fn(),
  });
  return { store, save, saved };
}

describe('alignTo store', () => {
  it('moves the set in one write and says how far, counting skipped photos', async () => {
    const { store, saved } = setup();
    await store.getState().alignTo({ layerIds: ['ph'] }, 'm');
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]?.ph ?? {})).toEqual(['a', 'b']);
    expect(store.getState().notice?.text).toBe(
      'Aligned 2 photos to Site model (moved 91.0 km). 1 photo has no position and stayed where it was.',
    );
    expect(store.getState().notice?.action?.kind).toBe('undo');
  });

  it('undo writes back the previous corrections in one write, redo applies again', async () => {
    const { store, saved } = setup();
    await store.getState().alignTo({ layerIds: ['ph'] }, 'm');
    await store.getState().apply();
    expect(saved[1]).toEqual({ ph: { a: null, b: null } });
    expect(store.getState().notice?.action?.kind).toBe('redo');
    await store.getState().apply();
    expect(saved[2]).toEqual(saved[0]);
  });

  it('a target without bounds writes nothing and says so', async () => {
    const { store, save } = setup(null);
    await store.getState().alignTo({ layerIds: ['ph'] }, 'm');
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe('Where Site model lies is not known.');
  });

  it('already in place writes nothing', async () => {
    const { store, save } = setup({ min: [90999, 0, 1999], max: [91001, 2, 2001] });
    await store.getState().alignTo({ picks: [{ layerId: 'ph', photoId: 'a' }] }, 'm');
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().notice?.text).toBe('Already in place');
  });
});
```

```tsx
// apps/desktop/src/renderer/builder/AlignToNotice.test.tsx
// @vitest-environment jsdom
// Renders with the app store (`alignTo` from alignSession, `save` mocked via vi.mock of
// './orientationFile'): the notice shows text and Undo; Ctrl+Z on the window undoes the alignment
// and the key event is stopped (a second window listener added in capture after it does not see
// it); Ctrl+Y redoes; a key typed in an input is left alone; with no notice Ctrl+Z passes through.
```

Write that test with `window.addEventListener('keydown', spy)` registered after mounting and `dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))` on `document.body`; expect `spy` not called while the notice shows, called once after `dismiss()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/renderer/builder/alignToStore.test.ts apps/desktop/src/renderer/builder/AlignToNotice.test.tsx`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/renderer/builder/alignToStore.ts
import type { PhotoPick } from '@aio/ui';
import { t } from '@aio/ui';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { alignSources, formatDistance, planAlign, type AlignBox, type Fixes } from './alignTo';

export interface AlignToNoticeState {
  text: string;
  action: { kind: 'undo' | 'redo'; fixes: Fixes } | null;
}

export interface AlignToStore {
  notice: AlignToNoticeState | null;
  alignTo(
    source: { layerIds: string[] } | { picks: PhotoPick[] },
    targetLayerId: string,
  ): Promise<void>;
  /** The notice's Undo or Redo. */
  apply(): Promise<void>;
  dismiss(): void;
}

export interface AlignToDeps {
  workspace: StoreApi<Workspace>;
  /** One `orientation:write` of every set's corrections (null removes one); an error or null. */
  save(fixes: Fixes): Promise<string | null>;
  bounds(layerId: string): Promise<AlignBox | null>;
  ground(x: number, z: number): Promise<number | null>;
  reload(): void;
}

export function createAlignToStore(deps: AlignToDeps): StoreApi<AlignToStore> {
  return createStore<AlignToStore>()((set, get) => {
    const unread = () => {
      if (deps.workspace.getState().orientationLoaded) return false;
      deps.reload();
      set({ notice: { text: t('align.direction.say.notLoaded'), action: null } });
      return true;
    };
    return {
      notice: null,
      alignTo: async (source, targetId) => {
        const ws = deps.workspace.getState();
        const m = ws.project?.manifest;
        if (!m || unread()) return;
        const target = m.layers.find((l) => l.id === targetId);
        const box = await deps.bounds(targetId);
        if (!target || !box) {
          set({
            notice: {
              text: t('actions.reason.noBounds', { name: target?.name ?? targetId }),
              action: null,
            },
          });
          return;
        }
        const g = await deps.ground((box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2);
        const plan = planAlign(alignSources(m, ws.orientation, source), box, g);
        if (plan.moved === 0 && plan.skipped > 0 && plan.distance === 0) {
          set({ notice: { text: t('actions.reason.noPositions'), action: null } });
          return;
        }
        if (plan.inPlace) {
          set({ notice: { text: t('align.to.inPlace'), action: null } });
          return;
        }
        const err = await deps.save(plan.fixes);
        if (err) {
          set({ notice: { text: err, action: null } });
          return;
        }
        const done = t('align.to.done', {
          count: plan.moved,
          target: target.name,
          distance: formatDistance(plan.distance),
        });
        const skipped =
          plan.skipped > 0 ? ` ${t('align.to.skipped', { count: plan.skipped })}` : '';
        set({
          notice: { text: `${done}.${skipped}`, action: { kind: 'undo', fixes: plan.before } },
        });
      },
      apply: async () => {
        const a = get().notice?.action;
        if (!a || unread()) return;
        const o = deps.workspace.getState().orientation;
        const now: Fixes = {};
        for (const [layerId, photos] of Object.entries(a.fixes))
          for (const id of Object.keys(photos))
            (now[layerId] ??= {})[id] = o?.photos[layerId]?.[id] ?? null;
        const err = await deps.save(a.fixes);
        set({
          notice: err
            ? { text: err, action: null }
            : {
                text: t(a.kind === 'undo' ? 'align.to.undone' : 'align.to.redone'),
                action: { kind: a.kind === 'undo' ? 'redo' : 'undo', fixes: now },
              },
        });
      },
      dismiss: () => {
        set({ notice: null });
      },
    };
  });
}
```

(When no photo has a position, `planAlign` returns `moved: 0`, `distance: 0`; that case says "None of these photos has a position." The menu greys the item before it gets here, Task 17.)

In `alignSession.ts`:

```ts
import { appBoundsDeps } from '../shell/appBounds';
import { boundsOf, groundAt } from '../shell/layerBounds';
import { createAlignToStore, type AlignToStore } from './alignToStore';

/** Align to: one move of photo sets or picked photos onto another dataset, with Undo. */
export const alignTo = createAlignToStore({
  workspace,
  save: (fixes) =>
    saveOrientationEdit((file) =>
      Object.entries(fixes).reduce(
        (f, [layerId, fx]) => withPhotoFixes(f, layerId, fx),
        file ?? emptyOrientation(),
      ),
    ),
  bounds: (id) => boundsOf([id], appBoundsDeps()),
  ground: (x, z) => groundAt(x, z, appBoundsDeps()),
  reload: retryOrientation,
});

export function useAlignTo<T>(selector: (s: AlignToStore) => T): T {
  return useStore(alignTo, selector);
}
```

```tsx
// apps/desktop/src/renderer/builder/AlignToNotice.tsx
import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { alignTo, useAlignTo } from './alignSession';

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  el.closest('input, textarea, select, [contenteditable="true"]') !== null;

/** "Aligned 214 photos to Site model (moved 91.2 km)" with Undo; Ctrl+Z and Ctrl+Y while it shows. */
export function AlignToNotice() {
  const t = useT();
  const notice = useAlignTo((s) => s.notice);
  useEffect(() => {
    if (!notice?.action) return;
    const kind = notice.action.kind;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || editable(e.target)) return;
      const k = e.key.toLowerCase();
      const undo = k === 'z' && !e.shiftKey;
      const redo = k === 'y' || (k === 'z' && e.shiftKey);
      if ((undo && kind === 'undo') || (redo && kind === 'redo')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void alignTo.getState().apply();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [notice]);
  if (!notice) return null;
  return (
    <div className="toast" data-testid="align-to-notice">
      <div className="toast-h">
        <Icon name="target" size={14} />
        <b>{t('align.to.notice')}</b>
        <span className="toast-grow" />
        {notice.action && (
          <button
            type="button"
            className="btn ghost sm"
            data-testid={`align-to-${notice.action.kind}`}
            onClick={() => void alignTo.getState().apply()}
          >
            <Icon name="undo" size={12} />
            {notice.action.kind === 'undo' ? t('align.direction.undo') : t('align.direction.redo')}
          </button>
        )}
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('syncNotice.dismiss')}
          onClick={() => {
            alignTo.getState().dismiss();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="align-to-text">
        {notice.text}
      </div>
    </div>
  );
}
```

Mount `<AlignToNotice />` in `Toasts.tsx` after `<PhotoAlignNotice />`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/renderer/builder/alignToStore.test.ts apps/desktop/src/renderer/builder/AlignToNotice.test.tsx apps/desktop/src/renderer/builder/photoAlignStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/builder/alignToStore.ts apps/desktop/src/renderer/builder/alignToStore.test.ts apps/desktop/src/renderer/builder/AlignToNotice.tsx apps/desktop/src/renderer/builder/AlignToNotice.test.tsx apps/desktop/src/renderer/builder/alignSession.ts apps/desktop/src/renderer/exports/Toasts.tsx
git commit -m "feat(desktop): Align to with one write, Undo and Redo" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Properties dialog

**Packages:** desktop renderer

**Files:**

- Create: `apps/desktop/src/renderer/shell/layerInfo.ts` (cached `layer:info`, registers the file extent source of Task 7)
- Create: `apps/desktop/src/renderer/shell/renameRequest.ts` (a store the sidebar reads: which dataset shows its name field)
- Create: `apps/desktop/src/renderer/shell/LayerProperties.tsx` (dialog and its `layerProps` store)
- Modify: `apps/desktop/src/renderer/App.tsx` (mount `<LayerProperties />` after `<RemoveHost />`)
- Test: `apps/desktop/src/renderer/shell/LayerProperties.test.tsx`

**Interfaces:**

- Consumes: `bridge` (`../shell`); `LayerInfo`; `setFileExtentSource` (Task 7); `formatBytes`, `formatDate`, `useFocusTrap`, `useT` (`@aio/ui`); `toWgs84`, `localToProject` (`@aio/geo`); strings `layerProps.*`.
- Produces:
  - `readLayerInfo(layerId: string): Promise<LayerInfo | null>` (cache per project, dropped on manifest change)
  - `renameRequest` store `{ layerId: string | null; ask(id: string): void; done(): void }`, `useRenameRequest`
  - `layerProps` store `{ open: { kind: 'layer'; layerId: string } | { kind: 'project' } | null; openLayer(id: string): void; openProject(): void; close(): void }`
  - `revealLayer(layerId: string): Promise<string | null>`
  - `<LayerProperties />` (`data-testid="layer-props"`, buttons `layer-props-rename`, `layer-props-reveal`, `layer-props-close`)

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/renderer/shell/LayerProperties.test.tsx
// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerProperties, layerProps } from './LayerProperties';
import { renameRequest } from './renameRequest';

const call = vi.fn();
vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) },
  useShell: (f: (s: { pkg: null }) => unknown) => f({ pkg: null }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  workspace.setState({
    project: {
      id: 'p',
      root: 'C:/p',
      manifest: {
        name: 'Yard',
        crs: { epsg: 32639 },
        origin: [500000, 3200000, 0],
        captures: [{ id: 'c1', label: 'c1', date: '2026-03-02' }],
        layers: [
          {
            kind: 'mesh',
            id: 'm',
            name: 'Model',
            visible: true,
            capture: 'c1',
            src: { path: 'models/m.glb' },
            transform: [],
          },
        ],
      },
    },
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
  call.mockReset();
  call.mockResolvedValue({
    ok: true,
    value: {
      ok: true,
      info: {
        layerId: 'm',
        name: 'Model',
        kind: 'mesh',
        files: [{ path: 'models/m.glb', bytes: 2048 }],
        bytes: 2048,
        count: null,
        countKind: null,
        extent: { min: [0, 0, -4], max: [6, 2, 0] },
        crs: { epsg: 32639 },
        importedAt: '2026-10-15T09:00:00.000Z',
        mainFile: 'models/m.glb',
      },
    },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  layerProps.getState().close();
  host.remove();
});

describe('LayerProperties', () => {
  it('shows name, kind, date, files, size, extent and CRS, read only', async () => {
    root = createRoot(host);
    act(() => root?.render(<LayerProperties />));
    await act(async () => {
      layerProps.getState().openLayer('m');
      await Promise.resolve();
    });
    const d = document.querySelector('[data-testid="layer-props"]');
    expect(d?.getAttribute('role')).toBe('dialog');
    expect(d?.textContent).toContain('Properties of Model');
    expect(d?.textContent).toContain('Model'); // kind
    expect(d?.textContent).toContain('models/m.glb');
    expect(d?.textContent).toContain('2 KB');
    expect(d?.textContent).toContain('6 by 4 m, 2 m high');
    expect(d?.textContent).toContain('EPSG:32639');
    expect(d?.querySelector('input')).toBeNull();
    expect(call).toHaveBeenCalledWith('layer:info', { projectId: 'p', layerId: 'm' });
  });

  it('Rename closes the dialog and asks the sidebar for the name field; Reveal asks main', async () => {
    root = createRoot(host);
    act(() => root?.render(<LayerProperties />));
    await act(async () => {
      layerProps.getState().openLayer('m');
      await Promise.resolve();
    });
    act(() => document.querySelector<HTMLElement>('[data-testid="layer-props-reveal"]')?.click());
    expect(call).toHaveBeenCalledWith('layer:reveal', { projectId: 'p', layerId: 'm' });
    act(() => document.querySelector<HTMLElement>('[data-testid="layer-props-rename"]')?.click());
    expect(renameRequest.getState().layerId).toBe('m');
    expect(document.querySelector('[data-testid="layer-props"]')).toBeNull();
  });

  it('project properties show the project fields without asking main', () => {
    root = createRoot(host);
    act(() => root?.render(<LayerProperties />));
    act(() => layerProps.getState().openProject());
    expect(document.querySelector('[data-testid="layer-props"]')?.textContent).toContain(
      'Project properties',
    );
    expect(call).not.toHaveBeenCalled();
  });
});
```

(Match the `formatBytes` output for 2048 that `packages/ui/src/format.ts` gives; adjust the expected `2 KB` to it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/LayerProperties.test.tsx`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`layerInfo.ts`:

```ts
import type { LayerInfo } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { bridge } from '../shell';
import { setFileExtentSource } from './appBounds';

let cache = new Map<string, Promise<LayerInfo | null>>();
let cachedFor: unknown = null;

/** `layer:info` for a dataset of the open project, kept until the manifest changes. */
export function readLayerInfo(layerId: string): Promise<LayerInfo | null> {
  const p = workspace.getState().project;
  if (!p) return Promise.resolve(null);
  if (cachedFor !== p.manifest) {
    cache = new Map();
    cachedFor = p.manifest;
  }
  const hit = cache.get(layerId);
  if (hit) return hit;
  const ask = bridge
    .call('layer:info', { projectId: p.id, layerId })
    .then((r) => (r.ok && r.value.ok ? r.value.info : null));
  cache.set(layerId, ask);
  return ask;
}

/** Show a dataset's main file in the file manager; an error text or null. */
export async function revealLayer(layerId: string): Promise<string | null> {
  const p = workspace.getState().project;
  if (!p) return 'No project is open.';
  const r = await bridge.call('layer:reveal', { projectId: p.id, layerId });
  if (!r.ok) return r.error;
  return r.value.ok ? null : r.value.error;
}

setFileExtentSource((id) => readLayerInfo(id).then((i) => i?.extent ?? null));
```

`renameRequest.ts`: a zustand vanilla store with `layerId`, `ask(id)` (sets it), `done()` (null), and `useRenameRequest`.

`LayerProperties.tsx`: a modal `role="dialog"` `aria-modal="true"` with `useFocusTrap(ref, open !== null, { onEscape: close })`, a `<dl>` of rows. Layer rows: Name, Kind (`t(\`layerProps.kind.${kind}\`)`), Survey date (`formatDate`of the capture's date, else`t('actions.noDate')`), Files (first 8 paths, then `t('layerProps.moreFiles', { count })`), Size on disk (`formatBytes`), Items or Points (`formatCount`), Extent (`t('layerProps.extentText', { x, y, z })`, each `String(Math.round(v * 10) / 10)`, so 6 m reads `6`), Centre local (`t('layerProps.local', ...)`) and WGS84 (`toWgs84(localToProject(centre, origin), epsg)`, 7 decimals), Coordinate system (`EPSG:<n>` or the CRS's name), Imported (`formatDate`). While reading: `t('layerProps.reading')`; a failure (a package) shows the manifest rows and `t('layerProps.unknown')` for files and size. Buttons: Rename (`layer-props-rename`, hidden when the project cannot be edited: read `useShell((s) => s.pkg)`and`useAnnotateReadOnly()`), Reveal in folder (`layer-props-reveal`, hidden in a package), Close (`layer-props-close`). Project rows: Name, Folder (`project.root`), Coordinate system, Origin (E, N, H), Survey dates (count), Datasets (count of layers that are not `legacy`).

In `App.tsx` add `import { LayerProperties } from './shell/LayerProperties';` and `<LayerProperties />` after `<RemoveHost />`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/LayerProperties.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/shell/layerInfo.ts apps/desktop/src/renderer/shell/renameRequest.ts apps/desktop/src/renderer/shell/LayerProperties.tsx apps/desktop/src/renderer/shell/LayerProperties.test.tsx apps/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): Properties dialog for datasets and the project" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Project, date and group-add actions

**Packages:** desktop renderer

**Files:**

- Create: `apps/desktop/src/renderer/shell/actions/projectActions.ts`
- Create: `apps/desktop/src/renderer/shell/actions/dateActions.tsx` (`.tsx`: the compare items render the extra Compare with rows)
- Test: `apps/desktop/src/renderer/shell/actions/projectActions.test.ts`, `apps/desktop/src/renderer/shell/actions/dateActions.test.ts`

**Interfaces:**

- Consumes: `defineAction`, `registerActions`, `makeActionCtx`, `actionsFor`, `EVERY_DATE`, `DATE_ICONS`, `formatDate` (`@aio/ui`); `DATE_COLOURS`, `captureIndex`, `workspace` (`@aio/workspace`); `boundsOf`, `padBox`, `appBoundsDeps` (Task 7); `layerProps` (Task 14); `builder` (`../../builder/state`); `pickAndScanPanos`; `pickTileset`; `farNotice`; `addDateMenu`; `allowedActions`, `runExportAction`; `shell`; `timeline`; `updateCapture` (`../dateFolders`); `compareTargets`, `compareWith`, `COMPARE_WITH_ACTIONS`; `askRemove` (`../removal`). Task 16 writes `layer.export` in the same batch, so date Export does not import it: it runs the registered action, `actionsFor({ kind: 'layers', layerIds }, ctx).find((i) => i.id === 'layer.export')?.run()`.
- Produces: `registerProjectActions(): () => void`, `registerDateActions(): () => void`, `compareContextFor(m: ProjectManifest): CompareContext` (Task 16 keeps its own copy of these five lines rather than import across a batch).

Action ids, labels, sections, test ids:

| id                                    | target                                            | section | label                                 | test id                                              | runs                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------- | ------- | ------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.addData`                     | project                                           | edit    | `actions.project.addData`             | default                                              | `builder.getState().pickAndImport()`                                                                                                                                                                                       |
| `project.addPanos`                    | project                                           | edit    | `actions.project.addPanos`            | default                                              | `pickAndScanPanos()`                                                                                                                                                                                                       |
| `project.addDrawing`                  | project                                           | edit    | `actions.project.addDrawing`          | default                                              | `builder.getState().pickAndAddDrawing()`                                                                                                                                                                                   |
| `project.addSurveyDate`               | project                                           | edit    | `palette.addSurveyDate`               | default                                              | open the sidebar if collapsed, `addDateMenu.getState().set(true)`                                                                                                                                                          |
| `project.showAll` / `project.hideAll` | project                                           | view    | `actions.project.showAll` / `hideAll` | default                                              | `setLayersVisible(all non-legacy ids, true / false)`; applies when some are hidden / shown                                                                                                                                 |
| `project.importFolder`                | project                                           | file    | `palette.importFlightFolder`          | default                                              | `builder.getState().pickAndImportFolder()`                                                                                                                                                                                 |
| `project.import360`                   | project                                           | file    | `actions.project.import360`           | default                                              | `builder.getState().pickAndImport360()`                                                                                                                                                                                    |
| `project.importTiles`                 | project                                           | file    | `actions.project.importTiles`         | default                                              | `pickTileset()`                                                                                                                                                                                                            |
| `project.checkPlacement`              | project                                           | view    | `actions.project.checkPlacement`      | default                                              | `farNotice.getState().check(projectId, 'all')`                                                                                                                                                                             |
| `project.exports`                     | project                                           | file    | `actions.project.exports`             | default                                              | submenu `allowedActions(pkg)`: `runExportAction(id, { legend: true })`                                                                                                                                                     |
| `project.properties`                  | project                                           | file    | `actions.project.properties`          | default                                              | `layerProps.getState().openProject()`                                                                                                                                                                                      |
| `project.close`                       | project                                           | file    | `actions.project.close`               | default                                              | `shell.getState().closeProject()`                                                                                                                                                                                          |
| `project.emptyTrash`                  | project                                           | danger  | `actions.project.emptyTrash`          | default                                              | `ctx.host.emptyTrash()`; disabled `actions.reason.trashEmpty` when `trashEntries === 0`                                                                                                                                    |
| `date.view`                           | date (capture)                                    | open    | `tree.dates.menu.view`                | `date-menu-view`                                     | `timeline.getState().focusSurvey(id)`; disabled `actions.reason.inView` when `ctx.focus === id`                                                                                                                            |
| `date.toggle`                         | date                                              | view    | expand or collapse                    | `date-menu-toggle`                                   | `ctx.host.toggle?.()`                                                                                                                                                                                                      |
| `date.show` / `date.hide`             | date                                              | view    | `tree.dates.menu.showAll` / `hideAll` | `date-menu-show` / `date-menu-hide`                  | `setLayersVisible(folderLayers[id], ...)`; shown when the folder has layers, disabled when nothing changes                                                                                                                 |
| `date.zoomTo`                         | date (capture)                                    | view    | `actions.date.zoomTo`                 | default                                              | `boundsOf(folder layers)` then `flyTo({ kind: 'box', ...padBox(b) })`, else a note                                                                                                                                         |
| `date.compare`                        | date (capture), the project has two dates or more | compare | `tree.dates.menu.compare`             | `date-menu-compare`                                  | submenu: `compareTargets(capture, undefined, compareContextFor(ctx.manifest))` as `compare-to-<id>`, `after` = `COMPARE_WITH_ACTIONS` rows; title `tree.dates.menu.compareTitle`; picking runs `compareWith({ from, to })` |
| `date.rename`                         | date (capture, canEdit)                           | edit    | `tree.dates.menu.rename`              | `date-menu-rename`                                   | `ctx.host.renameDate(id)`                                                                                                                                                                                                  |
| `date.colour`                         | date (capture, canEdit)                           | edit    | `tree.dates.menu.colour`              | picks `date-menu-colour-<n>`                         | `updateCapture(id, { colour: n })`                                                                                                                                                                                         |
| `date.icon`                           | date (capture, canEdit)                           | edit    | `tree.dates.menu.icon`                | picks `date-menu-icon-none`, `date-menu-icon-<name>` | `updateCapture(id, { icon })`                                                                                                                                                                                              |
| `date.reset`                          | date (picked colour or icon)                      | edit    | `tree.dates.menu.reset`               | `date-menu-reset`                                    | `updateCapture(id, { colour: null, icon: null })`                                                                                                                                                                          |
| `date.addData`                        | date (capture, canEdit)                           | edit    | `actions.date.addData`                | default                                              | `importIntoDate(id)` below                                                                                                                                                                                                 |
| `date.export`                         | date (capture, not pkg)                           | file    | `actions.date.export`                 | default                                              | the `layer.export` action on the folder's layers                                                                                                                                                                           |
| `date.delete`                         | date (capture, canEdit)                           | danger  | `tree.delete`                         | `date-menu-delete`                                   | `askRemove([{ capture: id }])`                                                                                                                                                                                             |
| `group.addDrawing`                    | group `drawings` (not pkg)                        | edit    | `actions.project.addDrawing`          | default                                              | `builder.getState().pickAndAddDrawing()`                                                                                                                                                                                   |
| `group.add360`                        | group `walks` (not pkg)                           | edit    | `actions.group.add360`                | default                                              | `builder.getState().pickAndImport360()`                                                                                                                                                                                    |

`importIntoDate(capture)`: note the manifest's layer ids, `await builder.getState().pickAndImport()`, then `ctx.host.moveLayers(newIds, capture)` for the ids that were not there before (none: nothing).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/renderer/shell/actions/dateActions.test.ts
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx } from '@aio/ui';
import { dateTags } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateCapture } from '../dateFolders';
import { registerDateActions } from './dateActions';

vi.mock('../dateFolders', () => ({
  updateCapture: vi.fn(() => Promise.resolve(null)),
  moveLayersToDate: vi.fn(),
}));
vi.mock('../../workspace/compareWith', () => ({
  COMPARE_WITH_ACTIONS: [],
  compareWith: vi.fn(() => true),
  compareTargets: vi.fn(() => [
    { capture: 'oct', reason: null },
    { capture: 'sep', reason: 'compare.with.noRaster' },
  ]),
}));

const captures = [
  { id: 'sep', label: 'Survey', date: '2024-09-04' },
  { id: 'oct', label: 'Baseline', date: '2024-10-02', colour: 6, icon: 'flag' },
];
const manifest = { captures, layers: [] } as unknown as ProjectManifest;
let off: () => void;
beforeEach(() => {
  off = registerDateActions();
});
afterEach(() => {
  off();
});
const ids = (captureId: string | null, over = {}) =>
  actionsFor(
    { kind: 'date', captureId },
    makeActionCtx({
      manifest,
      tags: dateTags(captures),
      folderLayers: { sep: ['a', 'b'], every: ['c'] },
      ...over,
    }),
  ).map((i) => i.testId);

describe('date actions', () => {
  it('a date folder in an editable project offers today items plus Zoom to, Export, Add data', () => {
    expect(ids('sep')).toEqual([
      'date-menu-view',
      'date-menu-toggle',
      'date-menu-show',
      'date-menu-hide',
      'ctx-item-date.zoomTo',
      'date-menu-rename',
      'date-menu-colour',
      'date-menu-icon',
      'ctx-item-date.addData',
      'date-menu-compare',
      'ctx-item-date.export',
      'date-menu-delete',
    ]);
  });

  it('Every date keeps its reduced set', () => {
    expect(ids(null)).toEqual(['date-menu-toggle', 'date-menu-show', 'date-menu-hide']);
  });

  it('a read-only project gets no rename, colour, icon, add or delete', () => {
    expect(ids('sep', { canEdit: false })).not.toContain('date-menu-rename');
    expect(ids('sep', { canEdit: false })).not.toContain('date-menu-delete');
  });

  it('a colour pick saves the colour and Reset shows once one is picked', () => {
    const items = actionsFor(
      { kind: 'date', captureId: 'oct' },
      makeActionCtx({ manifest, tags: dateTags(captures) }),
    );
    const colour = items.find((i) => i.id === 'date.colour');
    expect(colour?.sub.find((s) => s.id === '6')?.checked).toBe(true);
    colour?.run('5');
    expect(updateCapture).toHaveBeenCalledWith('oct', { colour: 5 });
    expect(items.some((i) => i.testId === 'date-menu-reset')).toBe(true);
  });

  it('Compare with lists the dates with their reasons', () => {
    const cmp = actionsFor({ kind: 'date', captureId: 'sep' }, makeActionCtx({ manifest })).find(
      (i) => i.id === 'date.compare',
    );
    expect(cmp?.sub.map((s) => [s.testId, s.disabled ?? false])).toEqual([
      ['compare-to-oct', false],
      ['compare-to-sep', expect.any(String)],
    ]);
  });
});
```

(The colour and icon picks keep the item test ids `date-menu-colour` and `date-menu-icon` on the row; the picks carry the old per-pick ids.)

`projectActions.test.ts`: the project menu in an editable project lists, in order, `project.addData`, `project.addPanos`, `project.addDrawing`, `project.addSurveyDate`, `project.showAll` (only when something is hidden), `project.hideAll`, `project.checkPlacement`, `project.importFolder`, `project.import360`, `project.importTiles`, `project.exports`, `project.properties`, `project.close`, `project.emptyTrash`; in a package the add and import items and Empty trash are gone; Empty trash is greyed with "The trash is empty." when `trashEntries` is 0 and calls `host.emptyTrash` otherwise; `group.addDrawing` shows only on a `drawings` group.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/actions/dateActions.test.ts apps/desktop/src/renderer/shell/actions/projectActions.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement** both files from the table, each action with `defineAction({ ... })`, collected in an array and passed to `registerActions` by `registerDateActions()` / `registerProjectActions()`. The compare context for the submenus is built outside React, from the menu's manifest:

```ts
export function compareContextFor(m: ProjectManifest): CompareContext {
  const id = workspace.getState().project?.id;
  return {
    layers: m.layers,
    index: captureIndex(m, volumeHints(volumetric.getState())),
    stageMode: shell.getState().stageMode,
    split: (id ? stagePrefs.getState().byProject[id]?.split : undefined) ?? DEFAULT_SPLIT,
    tier: graphics().getState().tier,
  };
}
```

and `compare-to-<id>` items carry `swatch: ctx.tags[id]?.colour ?? 'var(--fg-3)'`, `disabled: reason ? t(reason) : false`, `after: reason ? undefined : (close) => COMPARE_WITH_ACTIONS.map((A, i) => <A key={i} request={req} close={close} />)`. The colour row is `present: 'picks'` with sub ids `'1'` to `String(DATE_COLOURS)` (`swatch: var(--date-<n>)`, `checked` when `tags[id]?.colourIndex === n`, test ids `date-menu-colour-<n>`); the icon row the same with `none` and `DATE_ICONS` (`icon` set, test ids `date-menu-icon-none`, `date-menu-icon-<name>`). If importing `builder/state` or `shell` in a test needs a DOM, mark the test file `// @vitest-environment jsdom`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/actions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/shell/actions/projectActions.ts apps/desktop/src/renderer/shell/actions/projectActions.test.ts apps/desktop/src/renderer/shell/actions/dateActions.tsx apps/desktop/src/renderer/shell/actions/dateActions.test.ts
git commit -m "feat(desktop): project and survey date menu actions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: The common dataset actions

**Packages:** desktop renderer

**Files:**

- Create: `apps/desktop/src/renderer/shell/actions/layerActions.tsx`
- Test: `apps/desktop/src/renderer/shell/actions/layerActions.test.ts`

**Interfaces:**

- Consumes: Task 1 registry; `boundsOf`, `padBox`, `appBoundsDeps` (Task 7); `readLayerInfo`, `revealLayer`, `layerProps`, `renameRequest` (Task 14); `builder.getState().saveLayers`; `layerCapture` (`../../workspace/framesModel`); `captureIndex`; `compareTargets`, `COMPARE_WITH_ACTIONS`; `askRemove`; `toasts` (`../../exports/exports`); `bridge`.
- Produces:
  - `registerLayerActions(): () => void`
  - `commitLayerRename(layerId: string, name: string): Promise<string | null>` (Task 18's rename field calls it)
  - `exportLayersFlow(layerIds: readonly string[]): Promise<void>`
  - `zoomToLayers(layerIds: readonly string[], note: (text: string) => void): Promise<void>`

Actions (targets `layers` and, where marked, `group`):

| id                 | targets       | multi | section                   | label                       | test id                               | applies / disabled                                                                       | runs                                                                                                 |
| ------------------ | ------------- | ----- | ------------------------- | --------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `layer.show`       | layers, group | yes   | view                      | `actions.layer.show`        | default                               | applies when some are hidden                                                             | `setLayersVisible(ids, true)`                                                                        |
| `layer.hide`       | layers, group | yes   | view                      | `actions.layer.hide`        | default                               | applies when some are shown                                                              | `setLayersVisible(ids, false)`                                                                       |
| `group.toggle`     | group         |       | view                      | expand or collapse          | default                               |                                                                                          | `ctx.host.toggle?.()`                                                                                |
| `layer.zoomTo`     | layers, group | yes   | view                      | `actions.layer.zoomTo`      | default                               | not basemap or legacy                                                                    | `zoomToLayers`                                                                                       |
| `layer.rename`     | layers        |       | edit                      | `actions.layer.rename`      | default, shortcut `tree.rename`       | not basemap; disabled `readOnly` unless `canEdit`                                        | `renameRequest.getState().ask(id)`                                                                   |
| `layer.moveToDate` | layers, group | yes   | edit, `present: 'inline'` | `tree.dates.move.fileUnder` | sub ids `move-to-<every or capture>`  | `canEdit && datesOn`, not basemap or legacy                                              | `ctx.host.moveLayers(ids, sub === EVERY_DATE ? null : sub)`; the item of `ctx.host.from` is disabled |
| `layer.compare`    | layers, group | yes   | compare                   | `tree.dates.move.compare`   | `move-compare`                        | not basemap or legacy, at least two dates; disabled `mixedDates` without one common date | submenu like `date.compare` with `layers` (its own `compareContextFor` copy)                         |
| `layer.export`     | layers, group | yes   | file                      | `actions.layer.export`      | default                               | not basemap or legacy; disabled `package` in a package                                   | `exportLayersFlow`                                                                                   |
| `layer.reveal`     | layers        |       | file                      | `actions.layer.reveal`      | default                               | not basemap or legacy; disabled `package`                                                | `revealLayer`, a failure as a note                                                                   |
| `layer.properties` | layers        |       | file                      | `actions.layer.properties`  | default                               |                                                                                          | `layerProps.getState().openLayer(id)`                                                                |
| `layer.delete`     | layers, group | yes   | danger                    | `tree.delete`               | `menu-delete`, shortcut `tree.delete` | `canEdit`, some deletable (not legacy, not basemap)                                      | `askRemove(deletable.map((layer) => ({ layer })))`                                                   |

The common date of `layer.compare`: `ctx.host.from` when it is a capture, else the one capture all the layers have through `layerCapture(layer, index)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/shell/actions/layerActions.test.ts
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, NO_HOST } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builder } from '../../builder/state';
import { askRemove } from '../removal';
import { renameRequest } from '../renameRequest';
import { commitLayerRename, registerLayerActions } from './layerActions';

vi.mock('../removal', () => ({ askRemove: vi.fn() }));
vi.mock('../../workspace/compareWith', () => ({
  COMPARE_WITH_ACTIONS: [],
  compareWith: vi.fn(),
  compareTargets: vi.fn(() => []),
}));

const manifest = {
  captures: [
    { id: 'sep', label: 'Survey', date: '2024-09-04' },
    { id: 'oct', label: 'Oct', date: '2024-10-02' },
  ],
  layers: [
    {
      kind: 'mesh',
      id: 'quad-sep',
      name: 'Quad 2024-09-04',
      visible: true,
      src: { path: 'm.glb' },
      transform: [],
    },
    {
      kind: 'vector',
      id: 'v',
      name: 'Outline',
      visible: true,
      capture: 'oct',
      src: { path: 'v.geojson' },
      format: 'geojson',
    },
    { kind: 'basemap', id: 'bm', name: 'Streets', visible: true, pack: 'p', style: 'dark' },
  ],
} as unknown as ProjectManifest;
let off: () => void;
beforeEach(() => {
  off = registerLayerActions();
  workspace.setState({ project: { id: 'p', root: 'C:/p', manifest } } as unknown as Partial<
    ReturnType<typeof workspace.getState>
  >);
});
afterEach(() => {
  off();
});
const items = (layerIds: string[], over = {}) =>
  actionsFor({ kind: 'layers', layerIds }, makeActionCtx({ manifest, ...over }));

describe('dataset actions', () => {
  it('every row gets Show or Hide, Zoom to, Rename, File under, Compare, Export, Reveal, Properties, Delete', () => {
    expect(items(['v'], { host: { ...NO_HOST, from: 'oct' } }).map((i) => i.id)).toEqual([
      'layer.hide',
      'layer.zoomTo',
      'layer.rename',
      'layer.moveToDate',
      'layer.compare',
      'layer.export',
      'layer.reveal',
      'layer.properties',
      'layer.delete',
    ]);
  });

  it('a basemap offers Show or Hide and Properties only', () => {
    expect(items(['bm']).map((i) => i.id)).toEqual(['layer.hide', 'layer.properties']);
  });

  it('marked rows get only the multi actions, and Compare is greyed across dates', () => {
    const many = items(['quad-sep', 'v']);
    expect(many.map((i) => i.id)).toEqual([
      'layer.hide',
      'layer.zoomTo',
      'layer.moveToDate',
      'layer.compare',
      'layer.export',
      'layer.delete',
    ]);
    expect(many.find((i) => i.id === 'layer.compare')?.disabled).toBe(
      'These datasets are on different survey dates.',
    );
  });

  it('File under lists every date, newest first, the current folder greyed', () => {
    const move = items(['v'], { host: { ...NO_HOST, from: 'oct' } }).find(
      (i) => i.id === 'layer.moveToDate',
    );
    expect(move?.present).toBe('inline');
    expect(move?.sub.map((s) => [s.testId, Boolean(s.disabled)])).toEqual([
      ['move-to-every', false],
      ['move-to-oct', true],
      ['move-to-sep', false],
    ]);
  });

  it('Rename asks the sidebar for the field and shows F2; a read-only project greys it', () => {
    expect(items(['v']).find((i) => i.id === 'layer.rename')?.shortcut).toBe('F2');
    items(['v'])
      .find((i) => i.id === 'layer.rename')
      ?.run();
    expect(renameRequest.getState().layerId).toBe('v');
    expect(items(['v'], { canEdit: false }).find((i) => i.id === 'layer.rename')?.disabled).toBe(
      'This project can only be viewed.',
    );
  });

  it('Delete goes through the shared removal dialog with the deletable layers', () => {
    items(['v'])
      .find((i) => i.id === 'layer.delete')
      ?.run();
    expect(askRemove).toHaveBeenCalledWith([{ layer: 'v' }]);
  });

  it('commitLayerRename pins the date a name gave before renaming', async () => {
    const save = vi.spyOn(builder.getState(), 'saveLayers').mockResolvedValue(null);
    expect(await commitLayerRename('quad-sep', 'Quad')).toBeNull();
    expect(save.mock.calls).toEqual([
      [['quad-sep'], { capture: 'sep' }],
      [['quad-sep'], { name: 'Quad' }],
    ]);
    save.mockClear();
    await commitLayerRename('v', 'Site outline');
    expect(save.mock.calls).toEqual([[['v'], { name: 'Site outline' }]]);
  });
});
```

(`builder.getState().saveLayers` is a store function; spy on it through `builder.setState({ saveLayers: vi.fn() })` if spying on the getter's object does not stick. If importing `builder/state` needs a DOM, mark the file `// @vitest-environment jsdom`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/actions/layerActions.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

The helpers:

```ts
/** Rename a dataset; a layer whose date comes from its name keeps that date first. */
export async function commitLayerRename(layerId: string, name: string): Promise<string | null> {
  const p = workspace.getState().project;
  const layer = p?.manifest.layers.find((l) => l.id === layerId);
  if (!p || !layer) return 'No project is open.';
  if (layer.capture === undefined) {
    const inferred = layerCapture(layer, captureIndex(p.manifest));
    if (inferred !== undefined) {
      const err = await builder.getState().saveLayers([layerId], { capture: inferred });
      if (err) return err;
    }
  }
  return builder.getState().saveLayers([layerId], { name });
}

export async function zoomToLayers(
  layerIds: readonly string[],
  note: (text: string) => void,
): Promise<void> {
  const box = await boundsOf(layerIds, appBoundsDeps());
  if (!box) {
    const first = workspace.getState().project?.manifest.layers.find((l) => l.id === layerIds[0]);
    note(t('actions.reason.noBounds', { name: first?.name ?? '' }));
    return;
  }
  const s = shell.getState();
  if (s.screen !== 'scene') s.go('scene');
  workspace.getState().flyTo({ kind: 'box', ...padBox(box) });
}

export async function exportLayersFlow(layerIds: readonly string[]): Promise<void> {
  const p = workspace.getState().project;
  if (!p) return;
  const pick = await bridge.call('dialog:openFolder', { title: t('layerExport.pick') });
  if (!pick.ok || !pick.value.path) return;
  const dir = pick.value.path;
  const jobId = `layers-${String(Date.now())}`;
  const ts = toasts.getState();
  ts.start(jobId, t('layerExport.title'));
  const r = await bridge.call('layer:export', {
    projectId: p.id,
    jobId,
    layerIds: [...layerIds],
    dir,
  });
  if (!r.ok) return ts.finish(jobId, 'error', r.error);
  if (!r.value.ok) return ts.finish(jobId, 'error', r.value.error);
  if (r.value.cancelled) return ts.finish(jobId, 'done', t('layerExport.cancelled'));
  const done = t('layerExport.done', { count: r.value.written, dir });
  const skipped = r.value.skipped.length
    ? ` ${t('layerExport.skipped', { names: r.value.skipped.join(', ') })}`
    : '';
  ts.finish(jobId, r.value.written > 0 ? 'done' : 'error', `${done}${skipped}`);
}
```

(`ts.finish` returns void; write the early exits as `{ ts.finish(...); return; }` blocks for the linter.) Then the actions from the table, `registerLayerActions()` registering them. `layer.moveToDate` sub items: `{ id: EVERY_DATE, label: t('tree.dates.move.none'), swatch: '', testId: 'move-to-every' }` then captures newest first with `formatDate(date)` plus ` · label` when they differ, `swatch` from `ctx.tags`, `testId: move-to-<id>`, `disabled` when the id equals `ctx.host.from` (the reason text is the folder's own label, kept short: `t('tree.dates.move.title')` is not a reason; use the date label itself so the tooltip reads where it already is).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/actions/layerActions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/shell/actions/layerActions.tsx apps/desktop/src/renderer/shell/actions/layerActions.test.ts
git commit -m "feat(desktop): Zoom to, Rename, Export, Reveal and Properties for every dataset" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Actions per kind

**Packages:** desktop renderer

**Files:**

- Create: `apps/desktop/src/renderer/shell/actions/kindActions.tsx`
- Modify: `apps/desktop/src/renderer/builder/PhotoMenu.tsx:79` (`function openPhoto` becomes `export function openPhoto`)
- Modify: `apps/desktop/src/renderer/panos/PanoSphereRows.tsx` (`shapeOf` exported)
- Test: `apps/desktop/src/renderer/shell/actions/kindActions.test.ts`

**Interfaces:**

- Consumes: Task 1 registry, `everyLayer`; `alignTo` (Task 13, `../../builder/alignSession`); `knowsWhere` (Task 7); `COLOUR_MODES`, `pointcloudSettings` (`@aio/pointcloud`); `builder.getState().startAlign`; `alignCamera`; `drawings`, `openSideBySide`, `startPlacing`; `withDrawingDisplay`, `stagePrefs`; `openWalk`, `placeWalk`; `flightGroups` (`@aio/ui`), `flightPathModel`, `updateFlightPaths`, `toggleFlightPath`, `flightPathShown`; `photoUi`; `openPhoto`; `jobs` (`../../jobs`), `shapeOf`; `pinDisplay` (`@aio/annotate`); `shell`.
- Produces: `registerKindActions(): () => void`; `alignTargets(ctx: ActionCtx, exclude: ReadonlySet<string>): SubItem[]` (grouped by date heading, then `t('actions.noDate')`; Task 19 and 20 reuse it through the action).

| id                     | applies to                                        | section       | label                                                         | runs                                                                                                                                                          |
| ---------------------- | ------------------------------------------------- | ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud.settings`       | one point cloud                                   | view          | `actions.cloud.settings`                                      | `shell.getState().openCloudPanel()`                                                                                                                           |
| `cloud.colourBy`       | point clouds                                      | view, submenu | `actions.cloud.colourBy`                                      | `pointcloudSettings.getState().setColourMode(id)`; RGB only with a png-packed cloud                                                                           |
| `mesh.georef`          | one mesh, canEdit                                 | edit          | `actions.mesh.georef`                                         | `builder.getState().startAlign({ kind: 'mesh', layerId })`                                                                                                    |
| `drawing.settings`     | a drawing plan                                    | view          | `actions.drawing.settings`                                    | `drawings.getState().toggleControls(id)`                                                                                                                      |
| `drawing.sideBySide`   | a drawing plan                                    | open          | `actions.drawing.sideBySide`                                  | `openSideBySide(id)`                                                                                                                                          |
| `drawing.place`        | a drawing plan with a placement record, canEdit   | edit          | `drawing.place` or `drawing.placeAgain` (provisional or not)  | `startPlacing(id)`                                                                                                                                            |
| `drawing.onTop`        | a drawing plan                                    | view          | `drawing.onTop` or `drawing.behind`                           | `stagePrefs.update(projectId, { drawings: withDrawingDisplay(all, id, { onTop: !onTop }) })`                                                                  |
| `walk.open`            | a walk                                            | open          | `actions.walk.open`                                           | `openWalk(id)`                                                                                                                                                |
| `walk.place`           | a walk, canEdit                                   | edit          | `walk.place` or `walk.editPlacement`                          | `placeWalk(id)`                                                                                                                                               |
| `walk.removePlacement` | a placed walk, canEdit                            | danger        | `actions.walk.removePlacement`                                | `ctx.host.askUnplace(id)`                                                                                                                                     |
| `video.calibrate`      | one clip, canEdit                                 | edit          | `actions.video.calibrate`                                     | `builder.getState().startAlign({ kind: 'video', layerId })`                                                                                                   |
| `video.alignCamera`    | one clip, canEdit                                 | edit          | `actions.video.alignCamera`                                   | `alignCamera.getState().start(id)`                                                                                                                            |
| `video.flightPath`     | clips of one flight (multi)                       | view          | `video.showPath` or `video.hidePath`                          | `updateFlightPaths((p, m) => toggleFlightPath(p, flightId, m.flights, m.activeFlight))`                                                                       |
| `photos.alignTo`       | photo sets (multi), or photos picks               | edit, submenu | `actions.photos.alignTo`, title `actions.photos.alignToTitle` | `alignTo.getState().alignTo(source, sub)`; disabled `readOnly` unless canEdit, `noPositions` when no photo has a position, `noTargets` when the list is empty |
| `photos.createMaps`    | one photo set, canEdit                            | file          | `actions.photos.createMaps`                                   | `photoUi.getState().openWizard()`                                                                                                                             |
| `photos.openFirst`     | one photo set                                     | open          | `actions.photos.openFirst`                                    | `openPhoto(id, first item id)`                                                                                                                                |
| `pano.open`            | one panoramas layer                               | open          | `actions.pano.open`                                           | `workspace.getState().openPano(id, first openable item)`                                                                                                      |
| `pano.stitch`          | panoramas with a queued or failed sphere, canEdit | edit          | `actions.pano.stitch`                                         | `jobs.getState().start({ pipeline: 'pano.stitch', project: root, params: { layer, pano, quality: 'standard', shape: shapeOf(item) } })` for each              |
| `annotations.open`     | annotations                                       | open          | `actions.annotations.open`                                    | `shell.getState().go('issues')`                                                                                                                               |
| `annotations.pins`     | annotations                                       | view          | `annotations.showPins` or `hidePins`                          | `pinDisplay.getState().togglePins()`                                                                                                                          |

`alignTargets`: every layer of the manifest that is not in `exclude`, is not `basemap` or `legacy`, and `knowsWhere(layer)`, sorted by date (newest first, undated last), each `{ id: layer.id, label: layer.name, group: <date label or No date>, testId: 'align-to-<layer id>' }`.

- [ ] **Step 1: Write the failing test** (`kindActions.test.ts`): with a manifest holding a point cloud (`png-packed`), a mesh, a photo set with two photos (one with a position), a second photo set without positions, a clip, a placed walk and panoramas with one queued sphere: (a) each kind's single-row menu contains its extras from the table (ids); (b) `photos.alignTo` on the first set lists the mesh, the cloud and the panoramas under their date headings and not the set itself, and running it with `sub: 'mesh-id'` calls `alignTo.getState().alignTo({ layerIds: [setId] }, 'mesh-id')` (mock `../../builder/alignSession`); (c) on the set without positions it is greyed with "None of these photos has a position."; (d) on two marked photo sets it is offered (multi), on a photo set and a mesh it is not; (e) on a `photos` picks target it uses `{ picks }`; (f) `walk.removePlacement` calls `host.askUnplace`; (g) `annotations.pins` toggles the pins.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/actions/kindActions.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement** the table with `defineAction` (single-layer actions read `const [l] = targetLayers(t, ctx)` and apply only when `targetLayers(t, ctx).length === 1` and the kind matches), and the two one-word exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/actions/kindActions.test.ts apps/desktop/src/renderer/builder apps/desktop/src/renderer/panos`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/shell/actions/kindActions.tsx apps/desktop/src/renderer/shell/actions/kindActions.test.ts apps/desktop/src/renderer/builder/PhotoMenu.tsx apps/desktop/src/renderer/panos/PanoSphereRows.tsx
git commit -m "feat(desktop): right-click actions per dataset kind, Align to for photo sets" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Sidebar wiring and multi-select

**Packages:** desktop renderer

**Files:**

- Create: `apps/desktop/src/renderer/shell/actions/index.ts` (`registerSidebarActions()` calls the four `register*` functions once)
- Create: `apps/desktop/src/renderer/shell/menuTargets.ts` (+ `menuTargets.test.ts`)
- Rewrite: `apps/desktop/src/renderer/shell/DateMenus.tsx` (exports `TreeMenu` and `TreeMenuRequest`; `DateFolderMenu` and `LayerDateMenu` go)
- Rewrite: `apps/desktop/src/renderer/shell/DateMenus.test.tsx` (every old case ported onto `TreeMenu` with the registered actions, same test ids)
- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx:242-788` (`Datasets`)
- Modify: `apps/desktop/src/renderer/builder/builder.css` (`.dmenu-kbd`, `.dmenu-item[aria-disabled='true']`)
- Modify: `apps/desktop/src/renderer/shell/Sidebar.test.tsx` (empty space and Shift+F10 open the project menu)

**Interfaces:**

- Consumes: everything of Tasks 1, 9, 10, 14 to 17.
- Produces:
  - `rowTarget(item: TreeItem, marked: ReadonlySet<string>): MenuTarget | null`
  - `menuTitle(target: MenuTarget, ctx: ActionCtx, name: string, groupLabel?: string): string`
  - `interface TreeMenuRequest { target: MenuTarget; x: number; y: number; title: string; label: string; testId: string; host: Partial<ActionHost>; initialSub?: string }`
  - `TreeMenu({ request, ctx, onClose }): ReactNode`

Root test ids: date target `date-menu`; layers and group targets `move-menu`; project, photos and annotations `ctx-menu`. Titles: date: the folder label plus ` · <sub>`; group: `t('tree.dates.move.group', { group, count })`; one row: `t('tree.dates.move.title') · <name>` when it can be filed under a date, else the name; marked rows: `t('actions.header.layers', { count })`; project: the project name.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/renderer/shell/menuTargets.test.ts
import { describe, expect, it } from 'vitest';
import { rowTarget } from './menuTargets';

describe('rowTarget', () => {
  const row = { id: 'a', layerId: 'a', layerKind: 'mesh' as const, name: 'A' };
  it('a marked row targets every marked row', () => {
    expect(rowTarget(row, new Set(['a', 'b', 'c']))).toEqual({
      kind: 'layers',
      layerIds: ['a', 'b', 'c'],
    });
  });
  it('an unmarked row alone, marks untouched', () => {
    const marked = new Set(['b', 'c']);
    expect(rowTarget(row, marked)).toEqual({ kind: 'layers', layerIds: ['a'] });
    expect([...marked]).toEqual(['b', 'c']);
  });
  it('one marked row is just that row; a flight row carries its clips; Issues is annotations', () => {
    expect(rowTarget(row, new Set(['a']))).toEqual({ kind: 'layers', layerIds: ['a'] });
    expect(
      rowTarget(
        {
          id: 'flight:f',
          name: 'F',
          children: [
            { id: 'c1', layerId: 'c1', name: 'c1' },
            { id: 'c2', layerId: 'c2', name: 'c2' },
          ],
        },
        new Set(),
      ),
    ).toEqual({ kind: 'layers', layerIds: ['c1', 'c2'] });
    expect(rowTarget({ id: 'issues', name: 'Issues' }, new Set())).toEqual({
      kind: 'annotations',
      row: 'issues',
    });
  });
});
```

`DateMenus.test.tsx` (rewritten, jsdom, mocks as today): renders `TreeMenu` for `{ kind: 'date', captureId: 'sep' }` and checks `aria-label` "Survey date 2024-09-04", `date-menu-view` focuses the date, `date-menu-toggle` calls `host.toggle`, show and hide call `setLayersVisible` with the folder's layers, `date-menu-view` greyed when focused, no show or hide without layers, `date-menu-colour-5` keeps the menu open and saves, `date-menu-compare` then `compare-to-oct` compares and closes, `ctx-back` returns; for `{ kind: 'layers', layerIds: ['design'] }` with `host.from: 'every'`: root `move-menu`, `move-to-every` greyed, `move-to-sep` moves through `host.moveLayers`, `move-compare` lists `compare-to-*` inside `move-menu`, `menu-delete` asks the removal dialog; read-only: no File under, no Delete.

`Sidebar.test.tsx`: right-click on the Datasets section outside any row opens `ctx-menu` with `ctx-item-project.addData`; Shift+F10 with focus on the section header does the same; right-click on a row does not open the project menu.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/renderer/shell/menuTargets.test.ts apps/desktop/src/renderer/shell/DateMenus.test.tsx apps/desktop/src/renderer/shell/Sidebar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`menuTargets.ts`:

```ts
import type { MenuTarget, TreeItem } from '@aio/ui';

/** What a right-click on a row acts on: the marked rows when it is one of them, else the row. */
export function rowTarget(item: TreeItem, marked: ReadonlySet<string>): MenuTarget | null {
  if (!item.layerId && !item.children && (item.id === 'issues' || item.id === 'drafts'))
    return { kind: 'annotations', row: item.id };
  const own = item.children
    ? item.children.flatMap((c) => (c.layerId ? [c.layerId] : []))
    : item.layerId
      ? [item.layerId]
      : [];
  if (own.length === 0) return null;
  const onMarked = marked.size > 1 && own.some((id) => marked.has(id));
  return { kind: 'layers', layerIds: onMarked ? [...marked] : own };
}
```

`DateMenus.tsx`:

```tsx
import { actionsFor, ContextMenu, type ActionCtx, type ActionHost, type MenuTarget } from '@aio/ui';
import '../builder/builder.css';

export interface TreeMenuRequest {
  target: MenuTarget;
  x: number;
  y: number;
  title: string;
  label: string;
  testId: string;
  host: Partial<ActionHost>;
  initialSub?: string | undefined;
}

/** A Datasets menu: the registered actions on its target, recomputed on every render. */
export function TreeMenu({
  request,
  ctx,
  onClose,
}: {
  request: TreeMenuRequest;
  ctx: ActionCtx;
  onClose: () => void;
}) {
  const items = actionsFor(request.target, { ...ctx, host: { ...ctx.host, ...request.host } });
  if (items.length === 0) return null;
  return (
    <ContextMenu
      items={items}
      x={request.x}
      y={request.y}
      label={request.label}
      title={request.title}
      testId={request.testId}
      initialSub={request.initialSub}
      onClose={onClose}
    />
  );
}
```

In `Sidebar.tsx`, `Datasets`:

- Module level: `registerSidebarActions();` next to `watchPanoStitches();`.
- State: replace `folderMenu` and `itemMenu` with `const [menu, setMenu] = useState<TreeMenuRequest | null>(null);` (reset with the project as today); `const renaming = useRenameRequest((s) => s.layerId);`; `const [unplace, setUnplace] = useState<{ id: string; seq: number } | null>(null);`.
- `ctx`: `makeActionCtx({ manifest: project.manifest, hidden, canEdit, pkg: readOnly, datesOn, focus, tags, folderLayers: Object.fromEntries(folders.map((f) => [f.id, f.layerIds])), trashEntries: trash?.entries ?? 0, drafts, host })`, where `host` is `{ note: (text, danger) => setNote({ text, danger: danger === true }), renameDate: setRenaming, moveLayers: onMove, askUnplace: (id) => setUnplace((u) => ({ id, seq: (u?.seq ?? 0) + 1 })), emptyTrash: () => { removal.setState({ held: 0 }); setEmptying(true); } }`.
- Openers: `onFolderMenu={(m) => setMenu({ target: { kind: 'date', captureId: m.folder.capture?.id ?? null }, x: m.x, y: m.y, title: m.folder.sub ? \`${m.folder.label} · ${m.folder.sub}\` : m.folder.label, label: t('tree.dates.menu.label', { date: m.folder.label }), testId: 'date-menu', host: { toggle: m.toggle, expanded: m.expanded, from: m.folder.id } })}`; the item menu (both trees) builds `rowTarget(m.item, marks.marked)`with`host.from: m.from`; a group header (a request with `fold`and`group`, Task 10) builds `{ kind: 'group', group, layerIds, captureId: from === EVERY_DATE ? null : from }`with`host: { toggle: fold.toggle, expanded: fold.expanded, from }`and the title`t('tree.dates.move.group', { group: label, count })`.
- Empty space: on the `.sb-sec.sb-tree` div, `onContextMenu={(e) => { if (e.defaultPrevented) return; e.preventDefault(); openProject(menuPoint(e)); }}` and in its `onKeyDown`, before the Delete branch: `if (isMenuKey(e)) { e.preventDefault(); openProject(keyMenuPoint(e.target as HTMLElement)); return; }` (rows, groups and folders stop the event first, Task 10).
- Rename: pass `renamingLayer={canEdit ? renaming : null}`, `onRenameLayerStart={canEdit ? (id) => renameRequest.getState().ask(id) : undefined}`, `onRenameLayer={(id, name) => void commitLayerRename(id, name).then(failed)}`, `onRenameLayerEnd={() => renameRequest.getState().done()}`, `unplaceRequest={unplace}` to both trees.
- Render: `{menu && <TreeMenu request={menu} ctx={ctx} onClose={() => setMenu(null)} />}` in place of the two old menus.
- Delete key keeps working (marked rows, else the focused row) through `askLayers`.

`builder.css`: `.dmenu-kbd { margin-left: auto; font: var(--mono-11); color: var(--fg-3); }` and `.dmenu-item[aria-disabled='true'] { opacity: 0.45; cursor: default; }` (use the token names `builder.css` already uses for `.dmenu-item:disabled`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/renderer/shell packages/ui/src`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/shell/actions/index.ts apps/desktop/src/renderer/shell/menuTargets.ts apps/desktop/src/renderer/shell/menuTargets.test.ts apps/desktop/src/renderer/shell/DateMenus.tsx apps/desktop/src/renderer/shell/DateMenus.test.tsx apps/desktop/src/renderer/shell/Sidebar.tsx apps/desktop/src/renderer/shell/Sidebar.test.tsx apps/desktop/src/renderer/builder/builder.css
git commit -m "feat(desktop): every Datasets row, folder, group and empty space opens one menu" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Pick several photo pins on the map and in 3D

**Packages:** desktop renderer

**Files:**

- Create: `apps/desktop/src/renderer/builder/photoPicks.ts` (+ `photoPicks.test.ts`)
- Create: `apps/desktop/src/renderer/builder/photoBox.ts` (+ `photoBox.test.ts`)
- Create: `apps/desktop/src/renderer/builder/PhotoPickInput.tsx`
- Modify: `apps/desktop/src/renderer/builder/PhotoMenu.tsx` (export `photosAt3d`; a picked photo's menu acts on the picks; "Align to..." item)
- Modify: `apps/desktop/src/renderer/builder/BuilderLayer.tsx:81` (mount `<PhotoPickInput />` beside `<PhotoMenu />`)
- Modify: `apps/desktop/src/renderer/exports/Toasts.tsx` (`<PhotoPicksNotice />`: "3 photos picked" with Clear, `data-testid="photo-picks"`)

**Interfaces:**

- Consumes: `PhotoPick` (`@aio/ui`); `ContextMenu`, `actionsFor`, `makeActionCtx`; `correctPos`, `photoCorrection`; `getActiveScene`, `getActiveMap`.
- Produces:
  - `photoPicks` store `{ picks: PhotoPick[]; toggle(p: PhotoPick): void; add(ps: readonly PhotoPick[]): void; clear(): void }` and `usePhotoPicks`
  - `nextPicks(picks: readonly PhotoPick[], hit: PhotoPick, mods: { ctrl: boolean; shift: boolean }): PhotoPick[]` (Ctrl toggles, Shift adds)
  - `photosInRect(points: readonly (PhotoPick & { x: number; y: number })[], r: { x0: number; y0: number; x1: number; y1: number }): PhotoPick[]`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/renderer/builder/photoPicks.test.ts
import { describe, expect, it } from 'vitest';
import { nextPicks, photoPicks } from './photoPicks';

const a = { layerId: 'ph', photoId: 'a' };
const b = { layerId: 'ph', photoId: 'b' };

describe('photo picks', () => {
  it('Ctrl toggles a photo, Shift adds without removing', () => {
    expect(nextPicks([a], b, { ctrl: true, shift: false })).toEqual([a, b]);
    expect(nextPicks([a, b], a, { ctrl: true, shift: false })).toEqual([b]);
    expect(nextPicks([a], a, { ctrl: false, shift: true })).toEqual([a]);
  });
  it('the store adds a box without doubles and clears', () => {
    photoPicks.getState().add([a, b]);
    photoPicks.getState().add([b]);
    expect(photoPicks.getState().picks).toEqual([a, b]);
    photoPicks.getState().clear();
    expect(photoPicks.getState().picks).toEqual([]);
  });
});
```

```ts
// apps/desktop/src/renderer/builder/photoBox.test.ts
import { describe, expect, it } from 'vitest';
import { photosInRect } from './photoBox';

it('picks the photos whose screen point lies in the box, whichever way it was dragged', () => {
  const pts = [
    { layerId: 'ph', photoId: 'a', x: 10, y: 10 },
    { layerId: 'ph', photoId: 'b', x: 50, y: 60 },
    { layerId: 'ph', photoId: 'c', x: 200, y: 5 },
  ];
  expect(photosInRect(pts, { x0: 100, y0: 100, x1: 0, y1: 0 }).map((p) => p.photoId)).toEqual([
    'a',
    'b',
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/desktop/src/renderer/builder/photoPicks.test.ts apps/desktop/src/renderer/builder/photoBox.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`photoPicks.ts` and `photoBox.ts` as the interfaces say (`photosInRect` normalises the rectangle with `Math.min`/`Math.max`). `PhotoPickInput.tsx` (renders nothing):

- 3D: on `.pane-3d`, `pointerup` with `button === 0` and `ctrlKey || metaKey || shiftKey` and a move under 5 px: `photosAt3d(scene, pane, x, y)` gives the hit; `photoPicks.setState({ picks: nextPicks(...) })`. Alt+drag: `pointerdown` with `altKey` in the capture phase calls `e.stopPropagation()` (the orbit does not turn) and draws a rubber band (`div.photo-band`, absolutely placed); on `pointerup` project every corrected photo position of the visible photo sets with `new Vector3(...pos).project(scene.camera)` to pane pixels and `photoPicks.getState().add(photosInRect(points, band))`.
- Map: `map.on('click', e)` with Ctrl or Shift: the `aio-photos-pt` feature under the point (as `PhotoMenu` queries) feeds `nextPicks`. Alt+drag: a capture-phase `pointerdown` on `map.getCanvasContainer()` with `altKey` disables `map.dragPan` until `pointerup`, draws the band and picks the photos with `map.project([lon, lat])` (pins carry `photoLayer`, `photoId` and their coordinates in the source `aio-photos`; read them with `map.querySourceFeatures`).
- A plain click (no modifier) clears the picks.

`PhotoMenu.tsx`: when the right-clicked photo is in `photoPicks` and there are two picks or more, the menu header reads `t('align.photoMenu.picked', { count })` and offers "Align to..." (`photo-menu-alignTo`) and "Clear picked photos" (`photo-menu-clearPicks`); with one photo, "Align to..." is added after "Align photo to map". "Align to..." closes the photo menu and opens `<ContextMenu items={actionsFor({ kind: 'photos', picks }, ctx)} initialSub="photos.alignTo" x y label testId="ctx-menu" />` at the same point (the `ctx` from `makeActionCtx({ manifest, canEdit: !pkg && !lookOnly, pkg: !!pkg })`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/desktop/src/renderer/builder`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/builder/photoPicks.ts apps/desktop/src/renderer/builder/photoPicks.test.ts apps/desktop/src/renderer/builder/photoBox.ts apps/desktop/src/renderer/builder/photoBox.test.ts apps/desktop/src/renderer/builder/PhotoPickInput.tsx apps/desktop/src/renderer/builder/PhotoMenu.tsx apps/desktop/src/renderer/builder/BuilderLayer.tsx apps/desktop/src/renderer/exports/Toasts.tsx
git commit -m "feat(desktop): pick several photo pins and align them together" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: "Align to..." on the far-content notice

**Packages:** desktop renderer

**Files:**

- Modify: `apps/desktop/src/renderer/builder/FarContentNotice.tsx`
- Test: `apps/desktop/src/renderer/builder/FarContentNotice.test.tsx`

**Interfaces:**

- Consumes: `farNotice` (`photoLayers`); `ContextMenu`, `actionsFor`, `makeActionCtx`; `photos.alignTo` (Task 17).
- Produces: a button `data-testid="far-align-to"` beside "Ignore their GPS" that opens the Align to list for `{ kind: 'layers', layerIds: n.photoLayers }` at the button (`initialSub: 'photos.alignTo'`).

- [ ] **Step 1: Write the failing test**: with `farNotice.setState({ notice: { ..., photoLayers: ['ph'] } })`, a registered `photos.alignTo` (call `registerKindActions()`; mock `alignSession`), the notice shows `far-align-to`; clicking it shows `ctx-menu` with the target list; picking `align-to-<mesh>` calls `alignTo.getState().alignTo({ layerIds: ['ph'] }, '<mesh>')`; without photo layers there is no button; in a package the button is not there.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/builder/FarContentNotice.test.tsx`; expected FAIL.
- [ ] **Step 3: Implement**: local state `const [at, setAt] = useState<{ x: number; y: number } | null>(null)`; the button `{t('align.to.far')}` sets it from `getBoundingClientRect()`; render `ContextMenu` when set.
- [ ] **Step 4: Run** the test again; expected PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/builder/FarContentNotice.tsx apps/desktop/src/renderer/builder/FarContentNotice.test.tsx
git commit -m "feat(desktop): Align to from the far-content notice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: End to end: menus and multi-select

**Packages:** `apps/desktop/e2e`

**Files:**

- Create: `apps/desktop/e2e/sidebar-menus.spec.ts`
- Create: `apps/desktop/e2e/sidebar-multi.spec.ts`

**Interfaces:**

- Consumes: fixtures `test`, `expect`, `openProject`, `threeDateProject`, `demoProject` (`e2e/fixtures.ts`); the test ids above.

- [ ] **Step 1: Write the specs**

```ts
// apps/desktop/e2e/sidebar-menus.spec.ts
/**
 * Right-click menus across the Datasets sidebar (15 Oct 2026): empty space, a date folder, a group
 * heading and a row of each kind the demo holds, each opened by right-click and by Shift+F10, show
 * their items and run one action each. Synthetic data only; off-screen; zero network.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test } from './fixtures';

interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        hidden: Record<string, true>;
        project: { manifest: { layers: { id: string; kind: string; name: string }[] } } | null;
      };
    };
    stage(): { saveView(): { position: number[]; target: number[] } } | null;
  };
}

async function openThreeDates(win: Page, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E three dates' }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
}

const hidden = (win: Page) =>
  win.evaluate(() =>
    Object.keys((window as unknown as Probe).__stratlas.workspace.getState().hidden),
  );

async function both(
  win: Page,
  el: ReturnType<Page['getByTestId']>,
  menuId: string,
  check: () => Promise<void>,
) {
  await el.click({ button: 'right' });
  await expect(win.getByTestId(menuId)).toBeVisible();
  await check();
  await win.keyboard.press('Escape');
  await expect(win.getByTestId(menuId)).toHaveCount(0);
  await el.focus();
  await win.keyboard.press('Shift+F10');
  await expect(win.getByTestId(menuId)).toBeVisible();
  await check();
  await win.keyboard.press('Escape');
}

test('empty space opens the project menu; Add survey date opens its dialog', async ({
  win,
  threeDateProject,
}) => {
  await openThreeDates(win, threeDateProject.id);
  const tree = win.locator('.sb-tree');
  const box = await tree.boundingBox();
  if (!box) throw new Error('no tree');
  await win.mouse.click(box.x + box.width / 2, box.y + box.height - 6, { button: 'right' });
  const menu = win.getByTestId('ctx-menu');
  await expect(menu.getByTestId('ctx-item-project.addData')).toBeVisible();
  await expect(menu).toBeInViewport({ ratio: 1 });
  await menu.getByTestId('ctx-item-project.addSurveyDate').click();
  await expect(win.getByTestId('add-date-menu')).toBeVisible();
});

test('a date folder menu has its items by mouse and keyboard; Zoom to moves the camera', async ({
  win,
  threeDateProject,
}) => {
  await openThreeDates(win, threeDateProject.id);
  // the folder's name button: focusable for Shift+F10, and a right-click on it reaches the row
  const row = win.getByTestId('date-name-oct');
  await both(win, row, 'date-menu', async () => {
    for (const id of [
      'date-menu-view',
      'date-menu-rename',
      'date-menu-compare',
      'ctx-item-date.zoomTo',
      'ctx-item-date.export',
    ])
      await expect(win.getByTestId(id)).toBeVisible();
  });
  const before = await win.evaluate(() =>
    (window as unknown as Probe).__stratlas.stage()?.saveView(),
  );
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-date.zoomTo').click();
  await expect
    .poll(() =>
      win.evaluate(() => (window as unknown as Probe).__stratlas.stage()?.saveView().target),
    )
    .not.toEqual(before?.target);
});

test('a group heading menu hides its group', async ({ win, threeDateProject }) => {
  await openThreeDates(win, threeDateProject.id);
  await win.getByTestId('date-name-nov').click();
  const header = win.getByTestId('date-folder-nov').getByTestId('tree-group-maps');
  await both(win, header.locator('.tgroup-btn'), 'move-menu', async () => {
    await expect(win.getByTestId('move-menu')).toContainText('Maps and rasters');
    await expect(win.getByTestId('ctx-item-group.toggle')).toBeVisible();
  });
  await header.click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.hide').click();
  await expect.poll(() => hidden(win)).toContain('site-nov');
});

test('a row: Rename persists, Properties shows its file, Hide hides', async ({
  win,
  dataRoot,
  threeDateProject,
}) => {
  await openThreeDates(win, threeDateProject.id);
  await win.getByTestId('date-name-sep').click();
  const row = win.getByTestId('tree-row-quad-sep');
  await both(win, row, 'move-menu', async () => {
    for (const id of [
      'ctx-item-layer.zoomTo',
      'ctx-item-layer.rename',
      'move-to-oct',
      'ctx-item-layer.properties',
      'menu-delete',
    ])
      await expect(win.getByTestId(id)).toBeVisible();
  });
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.rename').click();
  await win.getByTestId('layer-rename').fill('Quad survey');
  await win.keyboard.press('Enter');
  await expect(row).toContainText('Quad survey');
  const manifest = JSON.parse(
    await readFile(join(dataRoot.root, 'projects', threeDateProject.id, 'manifest.json'), 'utf8'),
  ) as { layers: { id: string; name: string; capture?: string }[] };
  expect(manifest.layers.find((l) => l.id === 'quad-sep')).toMatchObject({
    name: 'Quad survey',
    capture: 'sep',
  });
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.properties').click();
  await expect(win.getByTestId('layer-props')).toContainText('models/');
  await win.getByTestId('layer-props-close').click();
  await row.focus();
  await win.keyboard.press('F2');
  await expect(win.getByTestId('layer-rename')).toBeFocused();
  await win.keyboard.press('Escape');
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.hide').click();
  await expect.poll(() => hidden(win)).toContain('quad-sep');
});

test('a row of each kind in the change demo has its kind items', async ({ demoProject }) => {
  const { win } = demoProject;
  const layers = await win.evaluate(
    () =>
      (window as unknown as Probe).__stratlas.workspace.getState().project?.manifest.layers ?? [],
  );
  const extra: Record<string, string> = {
    mesh: 'ctx-item-mesh.georef',
    pointcloud: 'ctx-item-cloud.settings',
    photos: 'ctx-item-photos.alignTo',
    video: 'ctx-item-video.calibrate',
    raster: 'ctx-item-layer.export',
    vector: 'ctx-item-layer.export',
  };
  for (const kind of Object.keys(extra)) {
    const l = layers.find((x) => x.kind === kind);
    if (!l) continue;
    const row = win.getByTestId(`tree-row-${l.id}`).first();
    await row.scrollIntoViewIfNeeded();
    if (!(await row.isVisible())) continue; // in a closed group of a date folder: the menus above cover it
    await row.click({ button: 'right' });
    await expect(win.getByTestId('move-menu').getByTestId(extra[kind] ?? '')).toBeVisible();
    await expect(win.getByTestId('move-menu')).toBeInViewport({ ratio: 1 });
    await win.keyboard.press('Escape');
  }
});
```

(Open the date folders of the demo before the loop the way `compare.spec.ts` does, so every row is drawn; the guard then never skips on CI.)

```ts
// apps/desktop/e2e/sidebar-multi.spec.ts
/**
 * Multi-select in Datasets: mark three rows, right-click a marked one: only the actions for
 * several datasets show; Hide hides all three; Move to date moves all three. A right-click on an
 * unmarked row acts on that row alone and leaves the marks. Off-screen, zero network.
 */
```

with one test: open the three-date project, open every folder, Ctrl+click `tree-row-quad-sep`, `tree-row-site-sep`, `tree-row-quad-oct`; right-click `tree-row-site-sep`: `move-menu` contains `t('actions.header.layers', 3)` "3 datasets", has `ctx-item-layer.hide`, `move-to-nov`, `menu-delete`, and has no `ctx-item-layer.rename` and no `ctx-item-layer.properties`; Hide: `hidden()` contains all three; right-click again, Show, then `move-to-nov`: the manifest on disk files all three under `nov` (the two quads named with their dates are reported in `date-note`, as the timeline spec expects for named dates: assert the one that moved, and the note text for the others); right-click the unmarked `tree-row-design`: the menu header is "Move to date · Design" and `.titem.marked` still counts three.

- [ ] **Step 2: Build and run CI-style** (see Task 24 for the environment; from `apps/desktop`)

```bash
pnpm --filter @aio/desktop build
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/sidebar-menus.spec.ts e2e/sidebar-multi.spec.ts --workers=1
```

Expected: PASS; the log prints `[e2e] window 1100 x 720 px at display scale 1`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/sidebar-menus.spec.ts apps/desktop/e2e/sidebar-multi.spec.ts
git commit -m "test(desktop): end to end right-click menus and multi-select" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: End to end: Align to and Export

**Packages:** `apps/desktop/e2e`

**Files:**

- Create: `apps/desktop/e2e/align-to.spec.ts`
- Create: `apps/desktop/e2e/layer-export.spec.ts`

- [ ] **Step 1: Write the specs**

```ts
// apps/desktop/e2e/align-to.spec.ts
/**
 * Align to: a photo set 91 km off (a phone GPS) is aligned to the unit quad from its row menu.
 * The photos land on the quad's centre in plan, the manifest (GPS) is unchanged, Undo restores
 * the exact previous corrections (none), Redo applies again, Ctrl+Z works while the notice shows.
 * Synthetic data; off-screen; zero network.
 */
import { glbBounds } from '@aio/project/builder';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test as base, tinyGlb, tinyManifest } from './fixtures';

/** A 1 x 1 grey JPEG: copy the `JPEG` constant of `delete-and-start-over.spec.ts` (lines 44-48) as it is. */
declare const JPEG: Buffer;
const PHOTOS = [
  { id: 'a', src: { path: 'photos/far/a.jpg' }, pos: [91000, 50, -2000] },
  { id: 'b', src: { path: 'photos/far/b.jpg' }, pos: [91000.2, 50.5, -2000.2] },
  { id: 'c', src: { path: 'photos/far/c.jpg' }, pos: [91000.4, 51, -2000.4] },
];

const test = base.extend<{ farPhotos: { id: string; dir: string } }>({
  farPhotos: async ({ dataRoot }, use) => {
    const m = tinyManifest();
    const manifest = {
      ...m,
      layers: [
        ...m.layers,
        {
          kind: 'photos',
          id: 'far',
          name: 'Phone photos',
          visible: true,
          capture: 'capture-1',
          items: PHOTOS,
        },
      ],
    };
    await mkdir(join(dataRoot.projectDir, 'photos', 'far'), { recursive: true });
    for (const p of PHOTOS) await writeFile(join(dataRoot.projectDir, p.src.path), JPEG);
    await writeFile(join(dataRoot.projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await use({ id: dataRoot.projectId, dir: dataRoot.projectDir });
  },
});

/** The quad's box from the GLB's own accessors. */
function quadCentre(): [number, number] {
  const glb = tinyGlb();
  const len = glb.readUInt32LE(12);
  const b = glbBounds(JSON.parse(glb.subarray(20, 20 + len).toString('utf8')) as unknown);
  if (!b) throw new Error('no quad bounds');
  return [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
}

const orientation = async (dir: string) => {
  try {
    return JSON.parse(await readFile(join(dir, 'orientation.json'), 'utf8')) as {
      photos: Record<string, Record<string, { offsetM?: number[] }>>;
    };
  } catch {
    return { photos: {} };
  }
};

// `farPhotos` is listed before `win`, so the manifest is written before the app starts
test('a far photo set lands on the target; GPS unchanged; Undo and Redo exact', async ({
  farPhotos,
  win,
}) => {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect
    .poll(async () => (await openProject(win)).id, { timeout: 30_000 })
    .toBe(farPhotos.id);
  await win.locator('canvas').first().waitFor();
  const manifestBefore = await readFile(join(farPhotos.dir, 'manifest.json'), 'utf8');

  // the photo set sits in the date folder's Photos group, closed at first
  const folder = win.getByTestId('date-folder-capture-1');
  if ((await folder.getAttribute('aria-expanded')) !== 'true')
    await win.getByTestId('date-name-capture-1').click();
  const photos = folder.getByTestId('tree-group-toggle-photos');
  if ((await photos.getAttribute('aria-expanded')) !== 'true') await photos.click();
  const row = win.getByTestId('tree-row-far');
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-photos.alignTo').click();
  await win.getByTestId('align-to-quad').click();
  await expect(win.getByTestId('align-to-text')).toContainText(
    'Aligned 3 photos to Unit quad (moved 91.0 km)',
  );

  const o = await orientation(farPhotos.dir);
  const [cx, cz] = quadCentre();
  const at = PHOTOS.map((p) => {
    const off = o.photos.far?.[p.id]?.offsetM ?? [0, 0, 0];
    return [p.pos[0] + (off[0] ?? 0), p.pos[1] + (off[1] ?? 0), p.pos[2] + (off[2] ?? 0)];
  });
  const midX = (Math.min(...at.map((p) => p[0] ?? 0)) + Math.max(...at.map((p) => p[0] ?? 0))) / 2;
  const midZ = (Math.min(...at.map((p) => p[2] ?? 0)) + Math.max(...at.map((p) => p[2] ?? 0))) / 2;
  expect(midX).toBeCloseTo(cx, 2);
  expect(midZ).toBeCloseTo(cz, 2);
  expect(at.map((p) => p[1])).toEqual([50, 50.5, 51]); // plausible heights kept
  expect(await readFile(join(farPhotos.dir, 'manifest.json'), 'utf8')).toBe(manifestBefore);

  await win.getByTestId('align-to-undo').click();
  await expect(win.getByTestId('align-to-text')).toHaveText('Alignment undone.');
  await expect
    .poll(async () => Object.keys((await orientation(farPhotos.dir)).photos.far ?? {}))
    .toEqual([]);
  await win.getByTestId('align-to-redo').click();
  await expect
    .poll(async () => (await orientation(farPhotos.dir)).photos.far?.a?.offsetM)
    .toEqual(o.photos.far?.a?.offsetM);
  await win.locator('body').click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('Control+z');
  await expect(win.getByTestId('align-to-text')).toHaveText('Alignment undone.');
});
```

`layer-export.spec.ts`: the same fixture shape, listed before `win` (the tiny quad plus a photo set `ph` named "Photos" of two JPEGs at local positions near the origin, filed under `capture-1`; open the date folder and its Photos group as above); mark `tree-row-quad` and `tree-row-ph` with Ctrl+click; stub the folder dialog (`nextOpenDialog` as in `builder.spec.ts:10-17`) to a temp folder under `dataRoot.base`; right-click a marked row, `ctx-item-layer.export`; wait for `export-toast-message` "2 datasets exported to ..."; assert `<out>/Unit quad/quad.glb` equals the project's file byte for byte, `<out>/Unit quad/Unit quad.crs.json` has `crs.epsg` 32639 and `origin` `[500000, 3200000, 0]`, `<out>/Photos/a.jpg`, `b.jpg` and `Photos.crs.json` exist; export again: the toast says "Not exported, a folder of that name is already there: Unit quad, Photos." and nothing in `<out>` changed (compare the listing and the mtimes).

- [ ] **Step 2: Run CI-style** (as Task 21, Step 2, with these two files). Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/align-to.spec.ts apps/desktop/e2e/layer-export.spec.ts
git commit -m "test(desktop): end to end Align to and dataset export" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 23 (conditional): Port the point cloud cleanup items into the registry

**Only if `feat/pointcloud-cleanup` has landed on `main` before this branch's final rebase** (check: `git log origin/main --oneline -- apps/desktop/src/renderer/shell/DateMenus.tsx` shows its commit, or `git grep -n "Remove noise" origin/main -- apps/desktop/src/renderer`). Otherwise skip, and say so in the hand-off so that branch ports them when it rebases onto this one.

**Packages:** desktop renderer; `@aio/ui` (`en.ts`, only for keys that branch added under another name)

**Files:**

- Modify: `apps/desktop/src/renderer/shell/actions/kindActions.tsx` (four actions)
- Modify: `apps/desktop/src/renderer/shell/actions/kindActions.test.ts`
- Modify: whatever that branch added to `DateMenus.tsx` and `DateMenus.test.tsx` (its items go; the rebase conflict there resolves to this branch's `TreeMenu`)

- [ ] **Step 1: Rebase** onto `origin/main` (`node tools/agent/finish-task.mjs` does it). In the conflict in `DateMenus.tsx`, keep this branch's file; note the four items the other branch added to `LayerDateMenu` (labels "Clean up...", "Remove noise...", "Save cleaned copy...", "Reset cleanup"; COPC clouds only), their handlers, their test ids and their `en.ts` keys.
- [ ] **Step 2: Write the failing test** in `kindActions.test.ts`: a COPC point cloud row offers the four items with the other branch's test ids (in its order, section `edit`, Reset in `danger`), a `png-packed` cloud does not, and each runs the handler the other branch wrote (mock its module).
- [ ] **Step 3: Run** `pnpm vitest run apps/desktop/src/renderer/shell/actions/kindActions.test.ts`; expected FAIL.
- [ ] **Step 4: Implement** four `defineAction` entries calling the other branch's functions, `appliesTo` one layer with `kind === 'pointcloud' && format === 'copc'`, labels from its `en.ts` keys, `disabled` reasons it had (read-only, a running job).
- [ ] **Step 5: Run** the test and that branch's own e2e spec for cleanup CI-style; expected PASS.
- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/shell/actions/kindActions.tsx apps/desktop/src/renderer/shell/actions/kindActions.test.ts
git commit -m "feat(desktop): point cloud cleanup items in the dataset menu registry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 24: Verification

**Packages:** none (runs only)

- [ ] **Step 1: Checks green**

Run (worktree root): `pnpm check`
Expected: lint, format, typecheck and every unit test pass.

- [ ] **Step 2: Demos built the CI way** (the worktree has no `python/.venv`; point at the main checkout's venv; PowerShell shown, as the workstation runs it)

```powershell
$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
pnpm demo:change --quick
pnpm demo:build --quick --python 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
pnpm --filter @aio/desktop build
```

Expected: the change demo and every quick demo build; `electron-vite build` writes `apps/desktop/out`. After any Python tooling, check that the shared editable `aio-pipelines` install still points at the main checkout (memory: never junction the main venv).

- [ ] **Step 3: New and kept e2e specs, CI-style, one at a time** (from `apps/desktop`; windows stay off-screen through the fixtures; ask before a long run if the founder is using the PC)

```powershell
$env:QUADRION_WINDOW_SIZE = '1100x720'
$env:QUADRION_E2E_SCALE = '1'
$env:QUADRION_E2E_SWGL = 'warp'
$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
npx playwright test e2e/sidebar-menus.spec.ts e2e/sidebar-multi.spec.ts e2e/align-to.spec.ts e2e/layer-export.spec.ts --workers=1
npx playwright test e2e/timeline.spec.ts e2e/delete-and-start-over.spec.ts e2e/compare.spec.ts e2e/pano-compare.spec.ts e2e/survey-dates-add.spec.ts e2e/photo-align.spec.ts --workers=1
npx playwright test e2e/sidebar-menus.spec.ts e2e/align-to.spec.ts --workers=1 --repeat-each=3
```

Expected: all PASS, none skipped for a missing demo; the log prints `[e2e] window 1100 x 720 px at display scale 1`; zero network.

- [ ] **Step 4: Public text and screenshots**: `node tools/agent/check-public-text.mjs docs/plans/2026-10-15-sidebar-context-menus.md` and the same on any session note; look at any screenshot added. Then `node tools/agent/finish-task.mjs` (rebase, checks, commit-message scan).

---

## Self-review

- **Spec coverage:** section 1 registry: Tasks 1, 15 to 17; section 2 menu, keys, kept ids: Tasks 9, 10, 18; section 3 multi-select and photo picks: Tasks 18, 19; section 4 per target and kind: Tasks 15 to 17 (point cloud cleanup: Task 23); section 5 Rename (Tasks 3, 10, 11, 16), Zoom to and the F fix (Tasks 5, 7, 16), Export (Tasks 3, 12, 16), Reveal (Tasks 3, 12, 14), Properties and Project properties (Tasks 3, 12, 14); section 6 Align to (Tasks 6, 13, 17, 19, 20) and readers (Tasks 4, 8); section 7 contracts (Task 3 rows); section 8 strings (Task 2); section 9 tests (each task; e2e Tasks 21, 22, 24).
- **Names used across tasks:** `actionsFor`, `defineAction`, `makeActionCtx`, `everyLayer`, `targetLayers` (Task 1); `ContextMenu`, `placeMenu` (Task 9); `isMenuKey`, `keyMenuPoint`, `RenameField` (Task 10); `layerBounds`, `boundsOf`, `padBox`, `knowsWhere`, `groundAt`, `appBoundsDeps`, `setFileExtentSource` (Task 7); `planAlign`, `alignSources`, `formatDistance`, `Fixes` (Task 6); `alignTo`, `useAlignTo` (Task 13); `readLayerInfo`, `revealLayer`, `layerProps`, `renameRequest` (Task 14); `commitLayerRename`, `exportLayersFlow`, `zoomToLayers` (Task 16); `registerProjectActions`, `registerDateActions`, `registerLayerActions`, `registerKindActions`, `registerSidebarActions` (Tasks 15 to 18); `rowTarget`, `TreeMenu` (Task 18); `photoPicks`, `nextPicks`, `photosInRect` (Task 19).

## How to test (for the founder)

1. Open a project with survey dates. Right-click empty space under the Datasets list: the project menu shows Add data, Add survey date, Show all, imports, Check placement, Exports, Project properties, Close project, Empty trash.
2. Right-click a date folder: View this date, Expand, Show or Hide all, Zoom to, Rename, Colour, Icon, Add data to this date, Compare with, Export, Delete. Press Escape, Tab to a row and press Shift+F10 (or the Menu key): the same kind of menu opens under the row.
3. Right-click a dataset row: Show or Hide, Zoom to (the view flies to it), Rename (type a name, Enter), File under, Compare with, Export (pick a folder: the files and a `.crs.json` appear in a folder named after the dataset), Reveal in folder (Explorer opens on the file), Properties (files, size, extent, CRS), Delete. F2 on a row renames too.
4. Ctrl+click three rows, right-click one of them: the header says "3 datasets" and only Show or Hide, Zoom to, File under, Compare, Export and Delete show; Hide hides all three.
5. In a project with a photo set placed far off by phone GPS: right-click its row, Align to..., pick the site model. The notice says "Aligned N photos to Site model (moved X km)"; the pins move onto the model. Press Ctrl+Z: they go back; Redo brings them again.
6. On the map or in 3D, Ctrl+click two photo pins (or Alt+drag a box around several), right-click one: "N photos picked" with Align to....
