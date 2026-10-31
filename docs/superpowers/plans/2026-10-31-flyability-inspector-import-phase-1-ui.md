# Flyability Inspector import, phase 1, UI half: Implementation Plan (addendum)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. UI tasks load the `impeccable` and `frontend-design` skills first.

**Goal:** Finish phase 1 of the Flyability Inspector import in the app: spaces in the renderer (active space, scoped scene and lists, `mapAvailable`), flight lines drawn in 3D, the inspection picker, "Move point" on a finding with undo, the location-check row on the finding card, every pre-flip fix owed by this branch, then the Wave 2 hook-ups, the flag flip and the end to end spec.

**Architecture:** This addendum replaces Tasks 12 and 13 of `docs/superpowers/plans/2026-10-31-flyability-inspector-import-phase-1.md` and details its Task 14. The import core (Tasks 1 to 11) is on local `main`. UI Wave 2's W7 (right panel tabs, `workbench/tabsModel.ts` SECTIONS), W8 (tool registry, island modes) and W11 (rail, Layers column, title-bar breadcrumb) have not landed, so the work splits in three: **Batch D1** builds everything that does not need them, on files that exist on local `main` today, with the feature flag still off; **Batch D2** is one small task per Wave 2 piece as it lands, then the flag flip; **Batch E** is the end to end spec. The space model lives in our own store (`renderer/spaces/`); Wave 2 surfaces only render from it (UI gate answer, 31 Oct).

**Tech Stack:** TypeScript, React, zustand, three.js, vitest (+ jsdom, Testing Library), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-31-flyability-inspector-import-design.md`. Data rules: `docs/architecture/data-conventions.md` section 40.

## Global Constraints

- Everything in the parent plan's Global Constraints holds: no client, site, tester or person names anywhere; synthetic fixtures only; `node tools/agent/check-public-text.mjs <files>` from the main checkout on every doc.
- Worktree `E:\Dev\AIO Software\.claude\worktrees\flyability-ui`, branch `feat/flyability-ui`, rebased onto **local** `main` (never `origin/main`) whenever the coordinator says `main` moved.
- `FLYABILITY_IMPORT_UI` (`packages/project/src/builder/flyability/flags.ts`) stays `false` through D1; every new entry point (Add data item, library hand-off to the picker, the folder tip) is gated on it. Code paths that run only on data a user already imported (spaces, flight lines, Move point, location row) are not gated: with the flag off no project has them, except through tests.
- Never edit the shell, island or palette files beyond the one-line touches named and flagged below. Before a D1 task edits a flagged file, the session SendMessages the UI Wave 2 session and the coordinator with the file list; an export added to `apps/desktop/src/renderer/shell/actions/index.ts` is also announced to the intelligence Wave 2 session (its agent-actions branch reads that registry).
- Strings live in our own i18n area module `packages/ui/src/i18n/en/flyability.ts`; no literal user text in components.
- Every notice goes through the one `@aio/ui` toast host (`packages/ui/src/toast/store.ts` `toast()`, `dismissToast()`; a store-driven notice uses `apps/desktop/src/renderer/exports/useToastNotice.ts`, as `apps/desktop/src/renderer/survey/MeasureUndoNotice.tsx` does). These landed on local `main` at `7f89d0df2` (refactor/toasts); rebase onto it before D1 starts.
- Dialogs use `@aio/ui` `Dialog` (`packages/ui/src/Dialog.tsx`, scrim on `--z-dialog` in `packages/ui/src/tokens.css`) as `apps/desktop/src/renderer/survey/SiteSettings.tsx` and `apps/desktop/src/renderer/engineer/SetupDialog.tsx` use it. New CSS uses tokens only (`--warn`, `--warn-ink`, `--warn-line`); the css guard (`packages/ui/src/cssGuard.test.ts`, allow list `packages/ui/src/cssGuard.allow.json`) must not grow.
- `pnpm check` green before each commit; e2e the CI way (CONTRIBUTING.md, "End to end the way CI runs it"); `--workers=1`, one Playwright run at a time.

## Settled by assumption (tell the founder in the hand-off)

1. **Scene scoping uses the layer switches.** Switching space hides the layers of the other spaces through `workspace.applyVisibility` and restores what the person had shown in the space they return to (remembered per space). Every view that already honours `hidden` (3D, map, pins, measurements) follows without edits. The Layers column still lists other spaces' layers (eyes off) until D2's W11 task filters the tree.
2. **Active space is a per-project view preference** kept in `localStorage` (`stratlas.activeSpace`, like `stratlas.flightPaths` in `apps/desktop/src/renderer/workspace/flightPaths.ts`), not in the manifest.
3. **Flight lines get their own Layers group** ("Flight lines", icon `path`) in `packages/ui/src/tree/model.ts`, as walks have theirs; Task 1 had parked them under Models.
4. **The issue list's right-click menu moves onto the shared registry.** `@aio/annotate`'s issue register gets an `issueMenu` hook; the desktop answers it with the registry menu for a new `MenuTarget` `{ kind: 'issues'; ids; clicked }`, which carries the existing "Place on model..." and the new "Move point". Without the hook the register keeps its current menu.
5. **Undo** is one `issueEditor.commitIssues` step (`packages/annotate/src/runtime.ts`) plus an Undo button on the toast; Ctrl+Z on the visible toast follows the toast host's own undo keys.
6. **`packages/ai/src/action-tool-specs.ts` does not exist on local `main`**, so no parity line now; D2 adds it if the agent-actions branch lands first (task T26 checks).
7. **The renderer reads the flag** through a new pure export `@aio/project/flags` (`packages/project/package.json` `exports`), never `@aio/project/builder` (node only).
8. **Library hand-off:** `library:add` returns only the entry, so the renderer, with the flag on, asks `builder:inspectorScan` for the dropped path after the add; an ok scan opens the new project and the picker on that path.
9. **INSPECTOR_LABEL** stays in `apps/desktop/src/main/library.ts` for main's error lines; the library screen names the kind in the Add project folder tip (`apps/desktop/src/renderer/screens/Projects.tsx`), flag-gated.
10. **Local-frame map audit:** renderer and main consumers of `m.crs` on local `main` already guard with `'epsg' in crs` or `frameProjection` (null for a local frame, `packages/maps/src/geo.ts`); `apps/desktop/src/main/packs/embed.ts` returns null. The only throw left is `epsgOf` in `packages/project/src/builder/raw.ts` reached from `planRawAltitudes` (T15).

---

## File Structure

| File                                                                                                                           | Task    | Responsibility                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------ |
| `packages/project/src/builder/create.ts`, `create.test.ts` (new)                                                               | T15     | no half-made folder when `createProject` fails               |
| `packages/project/src/builder/raw.ts`, `raw.test.ts`                                                                           | T15     | local-project message; `planRawAltitudes` on a local project |
| `apps/desktop/src/main/library.ts`, `library.test.ts`                                                                          | T15     | duplicate drop reuses the project; no `'dev'` pack default   |
| `apps/desktop/src/main/builder.ts`, `builder.test.ts`                                                                          | T15     | `otherChildren` skips OS clutter                             |
| `packages/schema/src/builder.test.ts`                                                                                          | T15     | IPC parse tests                                              |
| `packages/ui/src/i18n/en/flyability.ts` (new), `packages/ui/src/i18n/en.ts`, `i18n.test.ts`                                    | T16     | all strings of this addendum                                 |
| `packages/project/package.json`                                                                                                | T16     | `./flags` export                                             |
| `packages/ui/src/actions/types.ts`, `registry.test.ts`                                                                         | T16     | `MenuTarget` `issues`                                        |
| `packages/annotate/src/runtime.ts`, `components/IssueRegister.tsx`, `IssueRegister.test.tsx`                                   | T16     | `issueMenu` hook, `issueFilter` prop                         |
| `apps/desktop/src/renderer/spaces/spaceModel.ts`, `activeSpace.ts` (+ tests) (new)                                             | T17     | spaces model and store, `mapAvailable`                       |
| `apps/desktop/src/renderer/flyability/flightlineModel.ts`, `flightlineScene.ts` (+ tests) (new)                                | T18     | flight line geometry and drawer                              |
| `packages/ui/src/tree/model.ts`, `model.test.ts`; `apps/desktop/src/renderer/shell/layerBounds.ts`, `layerBounds.test.ts`      | T18     | Layers group, fly-to bounds                                  |
| `apps/desktop/src/renderer/spaces/SpacesMount.tsx`, `SpacesMount.test.tsx` (new)                                               | T19     | scope effect, map guard, flight line mount                   |
| `apps/desktop/src/renderer/flyability/{pickerModel.ts,pickerStore.ts,InspectorPicker.tsx,flyability.css}` (+ tests) (new)      | T20     | the picker                                                   |
| `apps/desktop/src/renderer/builder/state.ts`, `state.test.ts`; `builder/ImportPanel.tsx`                                       | T20     | `inspector` option, skipped item opens picker, picker host   |
| `apps/desktop/src/renderer/shell/actions/projectActions.ts`, `projectActions.test.ts`                                          | T20     | Add data menu item (flagged file)                            |
| `apps/desktop/src/renderer/store.ts`, `store.test.ts`; `screens/Projects.tsx`                                                  | T20     | library hand-off, folder tip                                 |
| `apps/desktop/src/renderer/flyability/{movePoint.ts,MovePointMount.tsx,LocationCheckRow.tsx,locationCheck.ts}` (+ tests) (new) | T21     | Move point session, location row                             |
| `apps/desktop/src/renderer/shell/actions/findingActions.tsx`, `findingActions.test.ts` (new); `shell/actions/index.ts`         | T21     | registry actions (flagged file)                              |
| `apps/desktop/src/renderer/issueCard/IssueCard.tsx`; `placement/index.ts`                                                      | T21     | row in the card; `issueMenu` answer                          |
| `apps/desktop/src/renderer/workspace/Stage.tsx`; `screens/Issues.tsx`                                                          | T22     | two mount lines; issue filter (Stage flagged)                |
| Wave 2 files (named when they land)                                                                                            | T23-T26 | breadcrumb, SECTIONS row, Map/Split greying                  |
| `packages/project/src/builder/flyability/flags.ts`                                                                             | T27     | flip                                                         |
| `apps/desktop/e2e/flyability-import.spec.ts` (new)                                                                             | T28     | end to end                                                   |

Paths checked on local `main` (`7f89d0df2`) on 31 Oct 2026; "(new)" files do not exist yet.

---

## Batch D1: now, independent of W7, W8 and W11

### Task 15: Pre-flip fixes in main and core

**Files:**

- Modify: `packages/project/src/builder/create.ts` (`createProject`), `packages/project/src/builder/raw.ts` (`epsgOf` line ~303, `planRawAltitudes` line ~1184), `apps/desktop/src/main/library.ts` (`projectForInspectorExport`, `addToLibrary`), `apps/desktop/src/main/builder.ts` (`otherChildren` line ~403), `apps/desktop/src/main/index.ts` only if the `addToLibrary` call site must pass `packVersion` explicitly
- Test: `packages/project/src/builder/create.test.ts` (new), `packages/project/src/builder/raw.test.ts`, `apps/desktop/src/main/library.test.ts`, `apps/desktop/src/main/builder.test.ts`, `packages/schema/src/builder.test.ts`

**Interfaces:**

- Consumes: `findInspectorExport`, `scanInspectorExport` (`packages/project/src/builder/flyability/scan.ts`), `spacesOf` (`packages/schema/src/spaces.ts`), `Space.source.inspectionId` (`packages/schema/src/manifest.ts`).
- Produces:
  - `createProject(...)` removes `<dataRoot>/projects/<id>/` again when anything after its `mkdir(root)` throws, then rethrows.
  - `projectForInspectorExport(dir, dataRoot, packVersion, registry)`: before creating, looks through the registry's listed projects for one whose `spaces[].source` has `kind: 'flyability'` and an `inspectionId` among the scan's inspections; when found returns `{ root }` of that project (no new folder).
  - `addToLibrary(path, store, registry, dataRoot, packVersion, flyabilityUi?)`: `packVersion` has no default (callers pass it; `apps/desktop/src/main/index.ts` already does or is made to).
  - `otherChildren` leaves out names matching `/^(thumbs\.db|desktop\.ini|\.ds_store|\._.*|\..*)$/i`.
  - `epsgOf(m)`: for a `{ local }` CRS throws `'Only Flyability Inspector exports can go into this project.'`; the EPSG message stays for the WKT case.
  - `planRawAltitudes` returns an empty plan (`altitudePlan` not called) for a `{ local }` CRS.
- [ ] **Step 1: Failing tests**
  - `create.test.ts`: `'a project that fails to write leaves no folder behind'` (mock `writeManifestFile` to reject; `readdir(<dataRoot>/projects)` is `[]`).
  - `library.test.ts`: `'the same export dropped twice adds no second project'` (two `addToLibrary` calls with `flyabilityUi: true`; one folder under `projects/`, both answers name the same entry id); `'an export project that cannot be made leaves no folder'` (createProject made to fail; `projects/` empty).
  - `builder.test.ts`: `'os clutter beside an export one level down is not listed'` (Thumbs.db, desktop.ini, .DS_Store beside the export; `items` holds only the real sibling).
  - `raw.test.ts`: `'a photo dropped on a local project says only inspector exports go there'`; `'heights of a local project plan nothing and do not throw'` (`planRawAltitudes` resolves `{ ... files: [] }` shape per `AltitudePlan`).
  - `packages/schema/src/builder.test.ts` in `describe('flyability import')`: `'inspectorScan request parses and refuses unknown keys'`; `'builder:import accepts an inspector selection and refuses an empty one'` (`inspections: []` fails `.min(1)`).
- [ ] **Step 2: Run** `pnpm vitest run packages/project/src/builder/create.test.ts packages/project/src/builder/raw.test.ts apps/desktop/src/main/library.test.ts apps/desktop/src/main/builder.test.ts packages/schema/src/builder.test.ts`. Expected: the new tests FAIL (the IPC parse tests may pass at once: they pin the contract).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(desktop): pre-flip fixes for the flyability import`.

### Task 16: Shared seams (strings, flag export, issue menu target)

**Files:**

- Create: `packages/ui/src/i18n/en/flyability.ts`
- Modify: `packages/ui/src/i18n/en.ts` (import `enFlyability`, header comment line), `packages/project/package.json` (`"./flags": "./src/builder/flyability/flags.ts"`), `packages/ui/src/actions/types.ts` (`MenuTarget` gains `| { kind: 'issues'; ids: string[]; clicked: string }`), `packages/annotate/src/runtime.ts` (`IssueListActions.issueMenu?`), `packages/annotate/src/components/IssueRegister.tsx` (right-click calls `issueMenu` when set; prop `issueFilter?: (issue: Issue) => boolean` applied before `filterInView`)
- Test: `packages/ui/src/i18n/i18n.test.ts`, `packages/ui/src/actions/registry.test.ts`, `packages/annotate/src/components/IssueRegister.test.tsx`

**Interfaces:**

- Produces:
  - Keys (exact): `fly.picker.title`, `fly.picker.description`, `fly.picker.flights`, `fly.picker.merged`, `fly.picker.noMerged`, `fly.picker.findings` (`{count}`), `fly.picker.imported` ("Already imported, will merge"), `fly.picker.aligned.relocalised`, `fly.picker.aligned.transform`, `fly.picker.aligned.reference`, `fly.picker.import`, `fly.picker.cancel`, `fly.picker.scanning`, `fly.picker.scanFailed`, `fly.picker.none`, `fly.queued` (`{count}`), `fly.addData` ("Flyability Inspector export..."), `fly.library.tip`, `fly.space.all`, `fly.map.local` ("No map: this space has its own frame"), `fly.move.action` ("Move point"), `fly.move.prompt` ("Click the point cloud where the finding is. Esc cancels."), `fly.move.done`, `fly.move.undo`, `fly.move.noHit`, `fly.check.wall` (`{wall}`, `{hit}`), `fly.check.disagrees`, `fly.check.noHit`, `fly.check.unchecked`, `fly.check.moved`, `wb.section.flightlines`.
  - `IssueListActions.issueMenu?: (at: { x: number; y: number }, ids: readonly string[], clicked: string) => void`.
- [ ] **Step 1: Failing tests**: `i18n.test.ts` `describe('the flyability strings')` `it('has the picker, move point and location check strings')` (every key above resolves, no key text left); `registry.test.ts` `it('an action can target issue rows')` (`actionsFor({ kind: 'issues', ids: ['a'], clicked: 'a' }, ctx)` returns the registered id; `targetCount` of two ids is 2); `IssueRegister.test.tsx` `it('a right-click asks the issue menu hook when one is set')` and `it('issueFilter leaves other issues out of the list')`.
- [ ] **Step 2: Run** `pnpm vitest run packages/ui/src/i18n/i18n.test.ts packages/ui/src/actions/registry.test.ts packages/annotate/src/components/IssueRegister.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** `targetCount` in `packages/ui/src/actions/registry.ts` counts `ids` for `issues` like `measurements` (that file is touched only if its switch is not generic).
- [ ] **Step 4: Run**, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): strings and seams for the flyability ui`.

### Task 17: Spaces model and active space store

**Files:**

- Create: `apps/desktop/src/renderer/spaces/spaceModel.ts`, `spaceModel.test.ts`, `activeSpace.ts`, `activeSpace.test.ts`

**Interfaces:**

- Consumes: `spacesOf`, `layersOfSpace`, `spaceOfLayer`, `spaceOfIssue`, `spaceFrame`, `DEFAULT_SPACE_ID` (`@aio/schema`); `frameProjection` (`@aio/maps`).
- Produces (`spaceModel.ts`, pure):
  - `activeSpaceOf(m: ProjectManifest, pref: string | undefined): string` (pref when it names a space, else the first of `spacesOf`).
  - `switcherShown(m: ProjectManifest): boolean` (two spaces or more).
  - `mapAvailable(m: ProjectManifest, spaceId: string): boolean` (false for a `{ local }` space frame or when `frameProjection` is null).
  - `offSpaceLayers(m: ProjectManifest, spaceId: string): string[]`.
  - `issuesInSpace(m: ProjectManifest, issues: readonly Issue[], spaceId: string): Issue[]`; `inSpace(m, spaceId): (issue: Issue) => boolean`.
  - `scopeChange(m, from: string | null, to: string, hidden: Readonly<Record<string, true>>, memory: SpaceMemory): { show: string[]; hide: string[]; memory: SpaceMemory }` where `SpaceMemory = Record<string, string[]>` (hidden layer ids per space).
- Produces (`activeSpace.ts`, zustand vanilla, per project, `localStorage` key `stratlas.activeSpace`, reads wrapped in try/catch like `flightPaths.ts`): `activeSpace` store, `setActiveSpace(projectId: string, spaceId: string): void`, `useActiveSpace(): { spaceId: string; mapAvailable: boolean; spaces: Space[] }` (reads the open project from `@aio/workspace`).
- [ ] **Step 1: Failing tests**: `spaceModel.test.ts`: `'one space hides the switcher'`; `'an older project is one main space'`; `'a pref naming a gone space falls back to the first'`; `'a local space has no map view'` (`mapAvailable` false for `{ local: 'flyability' }`, true for EPSG 32640); `'switching space hides the other space and restores what was shown'` (`scopeChange` both ways restores the remembered hidden set); `'issues follow the space of their first sighting'`. `activeSpace.test.ts`: `'the active space is kept per project'`; `'a broken stored value reads as none'`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/spaces`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): spaces model and active space`.

### Task 18: Flight lines: geometry, drawer, Layers group, fly-to

**Files:**

- Create: `apps/desktop/src/renderer/flyability/flightlineModel.ts`, `flightlineModel.test.ts`, `flightlineScene.ts`, `flightlineScene.test.ts`
- Modify: `packages/ui/src/tree/model.ts` (`TreeGroupKind` `'flightlines'`, `GROUPS` row "Flight lines" icon `path` after walks, `groupOf.flightline = 'flightlines'`, meta = sample duration m:ss when known), `apps/desktop/src/renderer/shell/layerBounds.ts` (`case 'flightline'` from the loaded polyline, as `walk`)
- Test: `packages/ui/src/tree/model.test.ts`, `apps/desktop/src/renderer/shell/layerBounds.test.ts`

**Interfaces:**

- Consumes: `flightline` layer (`packages/schema/src/layers.ts`), pose file `aio.flight/1` fetched with `assetUrl(projectId, layer.src)` (`@aio/workspace`, as `loadFlightPoses` in `packages/annotate/src/runtime.ts`), `DATE_COLOURS` (`@aio/workspace`).
- Produces:
  - `flightlinePoints(samples: readonly { t: number; pos: Vec3 }[]): Float32Array` (scene metres: file `(x, y, z)` east, north, up to scene `(x, z, -y)`, origin 0; samples closer than 5 cm merged).
  - `flightlineColour(layer, order: number): string` (`layer.color`, else the survey-date palette by flight order).
  - `loadFlightline(projectId: string, layer): Promise<Float32Array | null>` (cached by layer id and `src`).
  - `FLIGHTLINE_GROUP = 'aio-flightlines'`; `attachFlightlines(stage: EngineStage): { set(lines: { id: string; points: Float32Array; colour: string; visible: boolean }[]): void; dispose(): void }` drawing `Line2` polylines (as `apps/desktop/src/renderer/walks/walkScene.ts`), each root with `userData.layerId` so `hitLayer` (`builder/pick.ts`) and selection find it.
- [ ] **Step 1: Failing tests**: `flightlineModel.test.ts` `'a flight line builds a polyline from its pose file in scene metres'` (sample `[1, 2, 3]` lands at `[1, 3, -2]`); `'near-duplicate samples are merged'`; `'an unset colour follows the flight order'`. `flightlineScene.test.ts` `'set draws one line per visible flight line and tags its layer'`; `'dispose removes the group'`. `model.test.ts` `'flight lines have their own Layers group'`. `layerBounds.test.ts` `'a flight line fits its polyline'`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/flyability packages/ui/src/tree/model.test.ts apps/desktop/src/renderer/shell/layerBounds.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): draw flight lines in 3d`.

### Task 19: Spaces mount (scope, map guard, flight lines on the stage)

**Files:**

- Create: `apps/desktop/src/renderer/spaces/SpacesMount.tsx`, `SpacesMount.test.tsx`

**Interfaces:**

- Consumes: T17 (`useActiveSpace`, `scopeChange`, `mapAvailable`), T18 (`attachFlightlines`, `loadFlightline`, `flightlineColour`), `workspace.applyVisibility` and `hidden` (`@aio/workspace`), `useShell` `stageMode` / `setStageMode` (`apps/desktop/src/renderer/store.ts`).
- Produces: `SpacesMount({ stage }: { stage: EngineStage | null })`: (1) on active space change applies `scopeChange` once; (2) **minimum map guard**: while `mapAvailable` is false and `stageMode` is `'map'`, sets `'3d'` and shows `toast(t('fly.map.local'), { tone: 'info', id: 'fly-map-local' })` (a split keeps its 3D side; W8 greys the buttons in T25); (3) draws the active space's flight lines, eye from `hidden`.
- [ ] **Step 1: Failing tests** (jsdom, fake stage): `'switching space hides the other space layers'`; `'a local space never stays on the map view'`; `'a hidden flight line is not drawn'`; `'a project without flight lines draws nothing and loads nothing'`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/spaces/SpacesMount.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): scope the stage to the active space`.

### Task 20: Inspection picker

**Files:**

- Create: `apps/desktop/src/renderer/flyability/pickerModel.ts`, `pickerModel.test.ts`, `pickerStore.ts`, `pickerStore.test.ts`, `InspectorPicker.tsx`, `InspectorPicker.test.tsx`, `flyability.css`
- Modify: `apps/desktop/src/renderer/builder/state.ts` (`importFiles` `opts.inspector?: InspectorSelection` passed to `builder:import`; after the answer, an item `kind: 'flyability', status: 'skipped'` opens the picker on its path; `queued` items toast `fly.queued`), `apps/desktop/src/renderer/builder/ImportPanel.tsx` (`ImportLayer` renders `<InspectorPickerHost />`), `apps/desktop/src/renderer/shell/actions/projectActions.ts` (**flagged, shell**: `project.addInspector` after `project.addData`, `hidden` unless the flag; runs `dialog:openFolder` then `openInspectorPicker(path)`), `apps/desktop/src/renderer/store.ts` (`addProjectFolder`: flag on and the scan ok, open the new entry and `openInspectorPicker(path)`), `apps/desktop/src/renderer/screens/Projects.tsx` (Add project folder `title` = `fly.library.tip`, flag on)
- Test: `apps/desktop/src/renderer/builder/state.test.ts`, `apps/desktop/src/renderer/shell/actions/projectActions.test.ts`, `apps/desktop/src/renderer/store.test.ts`

**Interfaces:**

- Consumes: IPC `builder:inspectorScan`, `builder:import` `inspector` (`packages/schema/src/ipc.ts`), `InspectorScan`, `InspectorSelection` (`packages/schema/src/builder.ts`), `FLYABILITY_IMPORT_UI` via `@aio/project/flags` (T16), strings (T16), `Dialog` (`@aio/ui`), `toast` (`@aio/ui`).
- Produces:
  - `pickerModel.ts`: `initialChoice(scan: InspectorScan): Choice` (inspections without `importedAs` ticked, all their flights with a cloud or path ticked; imported ones unticked and marked), `toggleInspection`, `toggleFlight`, `selectionOf(choice): InspectorSelection | null` (null when nothing ticked; `flights` left out when all are ticked).
  - `pickerStore.ts`: `openInspectorPicker(path: string): Promise<void>` (scans with the open project id; failure toasts `fly.picker.scanFailed` with `tone: 'error'`), `closeInspectorPicker()`, `confirmInspectorPicker(): Promise<void>` (calls `builder.getState().importFiles([path], undefined, { inspector })`, closes on send).
  - `InspectorPicker.tsx`: `InspectorPickerHost()`; `Dialog` `size="lg"`, `testId="inspector-picker"`, footer Cancel / Import (`data-testid="inspector-import"`, disabled while `selectionOf` is null); rows `data-testid="inspector-row-<id>"`, flight ticks `inspector-flight-<id>`; alignment shown as text, merged cloud yes or no, findings count, "Already imported, will merge" in `--warn-ink`.
  - `isInspectorUiOn(): boolean` in `pickerStore.ts` (reads the flag; tests mock it).
- [ ] **Step 1: Failing tests**: `pickerModel.test.ts` `'the picker preselects new inspections and marks imported ones'`; `'unticking every flight unticks the inspection'`; `'all flights ticked sends no flight list'`. `pickerStore.test.ts` `'a failed scan shows an error toast and no dialog'`; `'import sends the choice with the path'`. `InspectorPicker.test.tsx` `'lists inspections with flights, merged cloud and findings'`; `'Import is off with nothing ticked'`; `'Escape closes without importing'`. `state.test.ts` `'an export without a choice opens the picker on its path'`; `'a queued flyability item says the import is running'`. `projectActions.test.ts` `'the Inspector item shows only with the flag on'`. `store.test.ts` `'an export added to the library opens its project and the picker'` (flag on; `library:add` then `builder:inspectorScan` ok) and `'with the flag off the library add does not scan'`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/flyability apps/desktop/src/renderer/builder/state.test.ts apps/desktop/src/renderer/shell/actions/projectActions.test.ts apps/desktop/src/renderer/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (`impeccable`, `frontend-design` first).
- [ ] **Step 4: Run**, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): pick the inspections of a flyability export`.

### Task 21: Move point and the location-check row

**Files:**

- Create: `apps/desktop/src/renderer/flyability/movePoint.ts`, `movePoint.test.ts`, `MovePointMount.tsx`, `MovePointMount.test.tsx`, `locationCheck.ts`, `locationCheck.test.ts`, `LocationCheckRow.tsx`, `LocationCheckRow.test.tsx`; `apps/desktop/src/renderer/shell/actions/findingActions.tsx`, `findingActions.test.ts`
- Modify: `apps/desktop/src/renderer/shell/actions/index.ts` (**flagged, shell; announce to UI Wave 2 and intelligence Wave 2**: `registerFindingActions()`), `apps/desktop/src/renderer/placement/index.ts` (sets `issueMenu` beside `placeOnModel`, opening `ContextMenu` from `@aio/ui` with `actionsFor({ kind: 'issues', ids, clicked }, makeActionCtx(...))`, as `apps/desktop/src/renderer/survey/MeasureMenu.tsx` does), `apps/desktop/src/renderer/issueCard/IssueCard.tsx` (renders `<LocationCheckRow issue={issue} />` under the fields when `issue.external`)
- Test: `apps/desktop/src/renderer/shell/actions/parity.test.ts` (unchanged items still offered)

**Interfaces:**

- Consumes: `moveFindingPoint`, `findingPoint` (`packages/annotate/src/model/findingPoint.ts`), `issueEditor` (`@aio/annotate`), `useStagePick`, `hitLayer` (`apps/desktop/src/renderer/builder/pick.ts`), `unshiftLocal` (`@aio/schema`), `dateShiftOf` (`@aio/workspace`), `toast` (`@aio/ui`), `useToastNotice` (`apps/desktop/src/renderer/exports/useToastNotice.ts`), `defineAction` (`@aio/ui`).
- Produces:
  - `movePoint.ts`: `moveSession` store `{ issueId: string | null }`; `startMovePoint(issueId: string): void`; `cancelMovePoint(): void`; `applyMovePoint(hit: { layerId: string; point: Vec3 } | null, now: string): 'moved' | 'no-hit' | 'not-cloud'` (only a `pointcloud` layer of the issue's space counts; point saved as `unshiftLocal(point, dateShiftOf(manifest, layerId))`; one `issueEditor.commitIssues([moved], label)` step; then `toast(t('fly.move.done'), { tone: 'ok', id: 'fly-move', action: { label: t('fly.move.undo'), run: undoIfLatest, testId: 'fly-move-undo' } })` where `undoIfLatest` undoes only while `issueEditor.state.undoLabel === label`).
  - `MovePointMount()`: while a session is open, `useStagePick(true, ...)`, Escape cancels (capture listener, stops propagation), and `useToastNotice('fly-move-prompt', { message: t('fly.move.prompt'), ttlMs: 0, onDismiss: cancelMovePoint, testId: 'fly-move-prompt' })`.
  - `findingActions.tsx`: `registerFindingActions()` with `issue.placeOnModel` (the existing placement run, so the register's old menu has a registry twin) and `issue.movePoint` (`targets: ['issues']`, section `edit`, available when the clicked issue has a cloud point or `external`, disabled when `!ctx.canEdit`).
  - `locationCheck.ts`: `locationLine(ext: ExternalFinding): { text: MessageKey; vars; tone: 'warn' | 'plain' }` (`disagrees`, `no-hit` warn; `agrees` plain with `fly.check.wall`; `unchecked`, `moved` plain).
  - `LocationCheckRow`: `data-testid="fly-location-check"`, `data-tone`, warning tone tokens, no side-stripe border.
- [ ] **Step 1: Failing tests**: `movePoint.test.ts` `'move point writes the moved issue'` (`commitIssues` called once with `locationCheck: 'moved'`); `'a click off the cloud keeps the point and says so'`; `'undo from the toast puts the point back'`; `'undo after a later edit does nothing'`. `MovePointMount.test.tsx` `'Escape cancels the move'`. `findingActions.test.ts` `'Move point is offered on a finding and greyed in a read-only project'`; `'Move point is not offered on an issue without a cloud point or import'`. `locationCheck.test.ts` `'a disagreeing finding shows the warning'`; `'an agreeing finding shows wall and point distances'`. `LocationCheckRow.test.tsx` `'no row for an issue that was not imported'`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/flyability apps/desktop/src/renderer/shell/actions`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): move a finding point and show its location check`.

### Task 22: Wire the mounts

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/Stage.tsx` (**flagged, stage; likely W8 overlap**: two lines next to `<WalkSceneMount stage={engine} />`: `<SpacesMount stage={engine} />`, `<MovePointMount />`), `apps/desktop/src/renderer/screens/Issues.tsx` (`issueFilter={inSpace(manifest, spaceId)}` on `IssueRegister`)
- Test: `apps/desktop/src/renderer/spaces/SpacesMount.test.tsx` (add `'the issue register shows only the active space'` rendering `Issues`)

- [ ] **Step 1: Failing test** as named. **Step 2: Run** it. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**, `pnpm check`. **Step 5: Commit** `feat(desktop): mount spaces and move point on the stage`.

---

## Batch D2: one task per Wave 2 piece, as each lands on local `main`

Each task starts with a rebase onto local `main`, reads the landed files and writes their exact paths into the task before editing. Files named "(W.. owned)" are edited only after messaging the UI Wave 2 session.

### Task 23: Space segment in the breadcrumb and the Layers column (after W11)

- Create: `apps/desktop/src/renderer/spaces/SpaceSegment.tsx`, `SpaceSegment.test.tsx`. Modify: W11's breadcrumb component (W11 owned) to render it; the Layers column's tree source (W11 owned, today `apps/desktop/src/renderer/shell/Sidebar.tsx` line ~336 `buildDatasetTree`) given `{ ...manifest, layers: layersOfSpace(manifest, spaceId) }`.
- Tests: `'the segment is hidden with one space'`; `'picking a space sets it for the project'`; `'the Layers column lists only the active space'`.
- Commit `feat(desktop): space switcher in the breadcrumb`.

### Task 24: Flight lines display row and the finding card (after W7)

- Create: `apps/desktop/src/renderer/flyability/FlightlineSection.tsx`, `FlightlineSection.test.tsx` (line width, colour by flight or one colour, show the active flight only). Modify: `apps/desktop/src/renderer/workspace/workbench/tabsModel.ts` SECTIONS (W7 owned): row `{ id: 'flightlines', label: 'wb.section.flightlines', needs: (d) => d.flightlines }`, and the data probe that sets `d.flightlines` (any `flightline` layer in the active space). If W7 moves `IssueCard` into the Selection tab under a new file, move the `LocationCheckRow` line with it.
- Tests: `tabsModel.test.ts` `'the flight lines row shows only with flight lines'`; `FlightlineSection.test.tsx` `'changing the colour mode redraws the lines'`.
- Commit `feat(desktop): flight line display options`.

### Task 25: Map, Split and island modes read `mapAvailable` (after W8)

- Modify: W8's tool registry and island mode files (W8 owned): Map and Split disabled with the `fly.map.local` reason tip when `useActiveSpace().mapAvailable` is false. The T19 guard stays as the backstop.
- Tests: in W8's island model test file, `'Map and Split are greyed with a reason in a local space'`.
- Commit `feat(desktop): grey the map in a local space`.

### Task 26: Agent parity line (only if the agent-actions branch has landed)

- If `packages/ai/src/action-tool-specs.ts` exists on local `main`: add the `issue.movePoint` line next to its peers; run its parity test. Otherwise skip and say so in the hand-off.

### Task 27: Turn the UI on

- Modify: `packages/project/src/builder/flyability/flags.ts` (`FLYABILITY_IMPORT_UI = true`).
- Tests (both states, through the existing seams `flyabilityUi` in `apps/desktop/src/main/builder.ts` and `library.ts`, `deps.flyabilityUi` in `packages/project/src/builder/raw.ts`, and a `vi.mock` of `isInspectorUiOn` in the renderer): `library.test.ts` keeps `'adds no project for an Inspector export while its picker is not shipped'` with `flyabilityUi: false` and adds `'with the flag on an export makes its project'` using the default; `raw.test.ts` `'with the flag on an export folder without a choice is never imported file by file'`; `projectActions.test.ts` `'the Inspector item shows by default'`; `apps/desktop/src/renderer/flyability/flag.test.ts` (new) `'the shipped flag is on'`.
- Commit `feat(desktop): turn on the flyability inspector import`.

---

## Batch E

### Task 28: End to end (parent plan Task 14)

**Files:**

- Create: `apps/desktop/e2e/flyability-import.spec.ts`

**Interfaces:**

- Consumes: `launchApp`, `createDataRoot`, `openProject`, `VENV_PYTHON`, `PIPELINE_ENV`, `hasPipelinePython`, `hasPdal` (`apps/desktop/e2e/fixtures.ts`); `REALDATA`, `hasRealData`, `realDataPath` (`apps/desktop/e2e/realData.ts`); the open dialog stub pattern of `apps/desktop/e2e/bentley-import.spec.ts`.
- `beforeAll`: `execFileSync(VENV_PYTHON, ['-I', 'python/tests/flyability_synth.py', <tmp>])` from the repo root; parse its JSON (`root`, `inspection_id`, `poi_ids`). Skip without pipeline Python or PDAL.
- [ ] **Step 1: Write the specs**:
  - `'imports a synthetic export as a space with clouds, paths and findings'`: fresh project, stub `dialog.showOpenDialog` with the export folder, project menu "Flyability Inspector export...", `inspector-picker` lists one inspection, `inspector-import`, wait for the Processing job to finish, the Layers column holds the clouds and the "Flight lines" group, the issue register shows three findings, the one with `disagrees` shows `fly-location-check` with `data-tone="warn"`, no breadcrumb space segment (one space).
  - `'moving a finding point survives a re-import'`: right-click a finding row, Move point, click the 3D view centre, `fly-move-undo` visible; import the same folder again (picker marks "Already imported, will merge"); the moved point and `locationCheck: 'moved'` are kept (read `issues.json` from disk).
  - `` `${REALDATA} imports a real export` ``: skips unless `hasRealData('flyability')`; the export path comes from `realDataPath('flyability')`, never a literal in the repo.
- [ ] **Step 2: Run the CI way** from `apps/desktop`: `pnpm demo:build --quick`, `pnpm demo:change --quick`, then in PowerShell `$env:QUADRION_WINDOW_SIZE='1100x720'; $env:QUADRION_E2E_SCALE='1'; $env:QUADRION_E2E_SWGL='warp'; $env:QUADRION_E2E_PYTHON='E:\Dev\AIO Software\python\.venv\Scripts\python.exe'; npx playwright test e2e/flyability-import.spec.ts --workers=1`. Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`; 2 passed, 1 skipped (3 passed with real data).
- [ ] **Step 3: Commit** `test(e2e): flyability inspector import`.
- [ ] **Step 4:** `/wrapup` on this branch, `node tools/agent/finish-task.mjs`, hand over to the coordinator with the "How to test" steps of the parent plan.

---

## Execution DAG

| Task | Depends on               | Packages / areas                                                               | Flagged files                               |
| ---- | ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------- |
| 15   | none                     | `@aio/project` builder, `@aio/schema` tests, `apps/desktop` main               | none                                        |
| 16   | none                     | `@aio/ui` i18n and actions, `@aio/annotate`, `@aio/project` package.json       | `packages/ui/src/actions/types.ts` (shared) |
| 17   | none                     | `apps/desktop` renderer spaces                                                 | none                                        |
| 18   | none                     | `apps/desktop` renderer flyability, `@aio/ui` tree, renderer shell/layerBounds | `shell/layerBounds.ts` (shell)              |
| 19   | 16, 17, 18               | renderer spaces                                                                | none                                        |
| 20   | 16                       | renderer flyability, builder, store, screens, shell/actions                    | `shell/actions/projectActions.ts`           |
| 21   | 16                       | renderer flyability, shell/actions, placement, issueCard                       | `shell/actions/index.ts`                    |
| 22   | 19, 21                   | renderer workspace, screens                                                    | `workspace/Stage.tsx`                       |
| 23   | 17, 22, W11 landed       | renderer spaces + W11 files                                                    | W11 breadcrumb, Layers column               |
| 24   | 18, 21, W7 landed        | renderer flyability + `workbench/tabsModel.ts`                                 | `tabsModel.ts`                              |
| 25   | 17, W8 landed            | W8 tool registry, island                                                       | island files                                |
| 26   | 21, agent-actions landed | `@aio/ai`                                                                      | none                                        |
| 27   | 15, 20, 23, 24, 25       | `@aio/project` flag, tests                                                     | none                                        |
| 28   | 27                       | `apps/desktop/e2e`                                                             | none                                        |

T20 and T21 share no file: T20 edits `projectActions.ts`, T21 edits `index.ts` and creates `findingActions.tsx`; both add files under `renderer/flyability/` with distinct names; strings are all written by T16.

**Parallel batches** (no shared files inside a batch; dispatch each in one message):

- **D1a:** T15, T16, T17, T18.
- **D1b:** T19, T20, T21.
- **D1c:** T22. Then hand D1 to the coordinator if the founder wants it on `main` before Wave 2 (flag off, nothing user-facing).
- **D2:** T23, T24, T25, T26 as each Wave 2 piece lands (each alone; they touch different Wave 2 files); then T27.
- **E:** T28.

**Critical path:** T16 → T21 → T22 → (W11 lands) → T23 → T27 → T28; the wait on W7, W8 and W11 dominates. Within D1 alone: T16 or T17/T18 → T19/T21 → T22.

## Tests per task, e2e and contracts at a glance

- Unit tests: named in each task (vitest).
- E2E added: `apps/desktop/e2e/flyability-import.spec.ts` (two synthetic cases, one `@realdata` that skips). No existing spec changes.
- Contract changes: one file schema. `flyability-source.json` (`aio.flyability-source/1`), the source note a library drop writes at a new project's root, is additive, local-only and never packed; it has a row in `docs/architecture/contract-changes.md`. `MenuTarget` `issues`, `IssueListActions.issueMenu`, `IssueRegister` `issueFilter`, `@aio/project/flags` and the `stratlas.activeSpace` preference are internal to the app (no IPC or manifest change).
- Pipeline pack: unchanged.

## How to test (for the founder, after Batch E)

Same as the parent plan's "How to test", plus: with one space, no space segment shows in the title bar; a finding moved with Move point shows "Moved" on its card and an Undo button on the toast; in a project with a Flyability space the Map button is greyed with a reason.
