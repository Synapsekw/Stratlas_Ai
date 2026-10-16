# Stage island and right-sidebar workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stage toolbar, the date strips and the title bar with a top-centre dynamic island, and turn the right sidebar into a context-following workbench with a resizable agent dock, so every tool has one stable home and the 3D view gets the room.

**Architecture:** Pure models first (island state and live priority, workbench tab order, follow and overflow, section state, overlay slots), each unit tested, then thin React components that read them from the existing zustand stores (`shell`, `workspace`, `measureStore`, the processing and connection state). The work lands in three stages, each a separate merge that leaves `main` usable: island and title bar, then workbenches and agent dock, then stage overlays and Split. Every part is built from the foundation's primitives; nothing here ships its own button, tab, popover or splitter.

**Tech Stack:** React 19, zustand, TypeScript, CSS in `apps/desktop/src/renderer/styles.css` and per-area CSS files, vitest with jsdom (`createRoot` + `act`, as in `workspace/StageTools.test.tsx`), Playwright Electron e2e (`apps/desktop/e2e/`), Electron main (`apps/desktop/src/main/index.ts`).

**Spec:** `docs/superpowers/specs/2026-10-16-stage-island-design.md` (decisions are cited as D1 to D32). Foundation spec: `docs/superpowers/specs/2026-10-16-ui-foundation-design.md` on `feat/ui-foundation` (cited as F-decision n).

## Global Constraints

- Work in `E:\Dev\AIO Software\.claude\worktrees\stage-island` on `feat/stage-island`, never in the main checkout (CLAUDE.md).
- **Before Task 2:** foundation Merge A has landed on `main` (tokens, guard, `ResizableSplit`/`useResizableSplit`, `Tip`, `Button`/`IconButton`, `Menu`, `Popover`, `Tabs`, `Chip`, `Row`, `EmptyState`, `PortalRoot`, focus and motion fixes). Rebase this branch onto `origin/main` after Merge A lands and confirm those exports exist in `packages/ui/src/index.ts`. Foundation Merge B (class migrations) is not required. Tasks 1, 3 and 9 (no foundation parts) may run before.
- Foundation parts consumed (exact names and props from the foundation plan; if Merge A named them differently, use its names, never add a variant): `Button` / `IconButton` (`size: 'sm'|'md'|'lg'`, `variant: 'primary'|'secondary'|'quiet'|'danger'|'icon'|'link'`, `pressed?`, `busy?`, `disabledReason?`, `icon?`, `shortcut?: ShortcutId`, `tip?`; `IconButton` requires `label`), `Tabs<K>` (`items`, `value`, `onChange`, `label`, `idPrefix`), `Chip` (`kind: 'tag'|'status'|'sev'`, `tone`, `color`), `Row` (`kind: 'nav'|'tree'|'menu'|'palette'`, `label`, `icon`, `count`, `selected`, `actions`, `as`), `EmptyState` (`icon`, `title`, `body`, `action`), `Menu` (`open`, `onClose`, `opener`, `label`, `items`, `anchor`, `testId`; `onSelect` runs after close), `Popover` (`title`, `footer`, `closeLabel`; box class `.surface-pop`), `Tip` (`content`, `shortcut`, `placement`, `repeatsName`), `PortalRoot` / `portalSurfaceAttrs`, `ResizableSplit` + `useResizableSplit` (props `id`, `orientation`, `sized`, `unit`, `defaultSize`, `min`, `max`, `otherMin`, `collapsedSize`, `collapsed`, `onCollapsedChange`, `label`, `start`, `end`), all exported from `@aio/ui` (`packages/ui/src/index.ts`). Build with these components, not raw classes. The foundation defines no segmented-control component, so the island keeps the `.seg` class (moved to `packages/ui/src/parts/tabs.css`). Tokens (foundation plan is authoritative): `--sp-1..8`, `--el-1..3`, `--z-stage-ui|panel|pop|drawer|toast|modal`, `--d-1..3`, `--ease`, `--t-title`, `--fw-title`. The renderer already exports its own `SplitPane` and `useSplit` (`workspace/SplitPanes.tsx`, the Split view's panes): leave them alone; import the shared divider as `import { ResizableSplit, useResizableSplit } from '@aio/ui'`, no aliases. Split ids follow the foundation's `<area>.<name>` ids: `scene.right` and `scene.ctxAgent` already exist from foundation Task 7 (reuse, do not redefine).
- Island motion is this project's own value: `--d-island: 400ms` and `--ease-island: cubic-bezier(0.32, 0.72, 0, 1)` in `workspace/island/island.css`; instant under `prefers-reduced-motion` and `[data-motion='reduce']`.
- The stage stays `data-surface="dark"` in every theme (D1); portals opened from the stage inherit it (F-decision 3).
- Keep every shortcut except T (D9): H, G, F, M, X, L, A, W, P, D, I, C, 1/2/3, Space, Enter, Backspace, Esc, Ctrl+Alt+B, road P/D/M/C. T = `scene.tools`; `scene.timeline` has no key; Ctrl+J = `global.agent`.
- Keep every `data-testid` on the same control: `survey-tools`, `cloud-panel`, `path-panel`, `cleanup-tool`, `env-panel`, `help-open`, `date-row` (follows the date control, D2), `date-bar`, `date-bar-count`, `readonly-chip`, `origin-chip`, `sidebar-toggle`, `tab-changes`, `compare-notice`. Keep accessible names that specs click: "3D", "Map", "Split", "Measure a distance", "Section plane", "Cut / fill", "Close the measurements list", "Show the right panel" / "Hide the right panel".
- e2e selector rule (F Constraints): a spec may change how it finds a control, never what it does or asserts the user sees. Controls now behind the island are reached through the shared helper `e2e/island.ts` (Task 8), not per-spec code.
- Copy: no em or en dashes in UI text; strings in `packages/ui/src/i18n/en.ts`; dates as `formatDate` ("13 Apr 2026"); labels exactly as D2, D16, D22, D24, D31 and the spec's Copy section.
- Preferences (sidebar width, section states, favourites, agent height, pins) are per computer, renderer storage through the `stagePrefs.ts` pattern (`createStagePrefStore` + `browserStorage()` in try/catch), never in the project (D17). No IPC or file format change; no row in `contract-changes.md` unless a task moves a pref to main.
- Logical CSS properties only (`inset-inline-end`); no `width`/`grid-template-columns` transitions on panes that hold a canvas (F-decision 8).
- Verification per task: `pnpm --filter @aio/desktop test <file>` (or `pnpm --filter @aio/ui test <file>`), then before each stage merge `pnpm check` green and the stage's e2e specs run the CI way from `apps/desktop`: `pnpm demo:build --quick` then `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/<spec>.spec.ts --workers=1`, printing `[e2e] window 1100 x 720 px at display scale 1`.
- Conventional commits, one per task step group; no client, site or person names (`node tools/agent/check-public-text.mjs`).

## Review Focus

1. **A project with no or one survey date** (drone video, telecom, road, a package): the island rests as three dots with no date control, or as a date pill with no arrows, and Alt+Left/Right do nothing harmful. Test: Task 3 `islandRest`.
2. **Typing while the island listens:** T, M and the arrows pressed inside the workbench search, the agent input, an issue form or the island calendar must type, not open tools or start a tool. Test: Task 6 `stage keys ignore typing targets`.
3. **An issue edit in progress when a tool starts** keeps its unsaved text and stays in front; only a dot and "Show it" appear; stopping the tool leaves the issue in front. Test: Task 9 `follow never takes over an issue edit` and Task 10 `IssueCard reports its edit state`.
4. **The smallest window, 1100 × 700, with Volumes in front** (470 px minimum) and the left rail: the stage keeps at least 360 px, chrome gives way first, the tab bar stays one row with ⋯. Test: Task 9 `width clamps to keep the stage` and Task 22 `small-window` assertions.
5. **A read-only package:** M still measures a distance with no Save and nothing written; Annotate and the saving survey tools are hidden; the island live line works. Test: Task 13 `read-only package measures without saving`.

---

## File Structure

New (renderer, `apps/desktop/src/renderer/`):

- `workspace/island/islandModel.ts` (+ `.test.ts`): pure island state machine, rest variant, live priority, group visibility. Replaces `workspace/toolbarFit.ts`.
- `workspace/island/useIslandLive.ts` (+ `.test.ts`): reads the live sources into `LiveItem[]`.
- `workspace/island/Island.tsx`, `IslandDate.tsx`, `IslandTools.tsx`, `IslandLive.tsx`, `island.css` (+ `Island.test.tsx`): the capsule.
- `workspace/island/groups.tsx`: per-group quick rows (reuses `StageTools.tsx` parts).
- `shell/SidebarTop.tsx`, `shell/SidebarStatus.tsx`, `shell/PageHeader.tsx`, `shell/RightHeader.tsx`, `shell/caption.ts` (+ tests): title bar replacements.
- `workspace/workbench/tabsModel.ts` (+ `.test.ts`): tab order, follow, pins, overflow, minimum widths.
- `workspace/workbench/workbenchStore.ts` (+ `.test.ts`): open tabs, pins, front tab, follow state.
- `workspace/workbench/RightSidebar.tsx`, `TabBar.tsx`, `Section.tsx`, `sectionState.ts`, `Drawer.tsx`, `workbench.css` (+ tests).
- `workspace/workbench/benches/*.tsx`: `MeasureBench`, `DisplayBench`, `CloudBench`, `VolumesBench`, `VideoBench`, `RoadBench`, `AnnotateBench`, `JobsBench`.
- `survey/measureCatalogue.ts` (+ `.test.ts`): families, tools, hints, keys, favourites.
- `agent/AgentPane.tsx` (+ test): the dock inside the sidebar (maximise, minimise, off row).
- `workspace/overlaySlots.ts` (+ `.test.ts`): corner slot layout.
- `e2e/island.ts`: helpers; `e2e/island.spec.ts`, `e2e/workbench.spec.ts`, `e2e/agent-dock.spec.ts`, `e2e/drawer.spec.ts`.
- `docs/design/stage-island/`: the prototype.

Modified: `workspace/Stage.tsx` (toolbar out, island in), `workspace/StageTools.tsx` (parts re-homed), `workspace/WorkspaceScreen.tsx` (right aside, DateBar/DateRow/TimelineBar out), `shell/Sidebar.tsx`, `App.tsx` (no `TitleBar`), `survey/MeasureToolbar.tsx` (popover goes, parts re-homed), `survey/measureStore.ts` (transient Distance), `issueCard/IssueCard.tsx` + `issueCard/state.ts` (edit state), `workspace/FloatingVideo.tsx`, `workspace/SplitPanes.tsx`, `workspace/CompareControls.tsx`, `packages/ui/src/shortcuts.ts`, `packages/ui/src/i18n/en.ts`, `apps/desktop/src/main/index.ts`, `styles.css`.

Deleted: `shell/TitleBar.tsx`, `workspace/toolbarFit.ts` + test, `workspace/DateRow.tsx` + test, `workspace/DateBar.tsx` + test (content moves to `IslandDate`), the `.stbar`, `.titlebar`, `.dbar`, `.tl-bar`, `.ovf` CSS, `.ws-vol { --rp-w: 400px }` (`styles.css:2043`).

---

## Stage 1: island and title bar (merge 1)

### Task 1: Keep the prototype in the repo

**Files:** Create `docs/design/stage-island/` (`index.html`, `fonts/`, `stage.jpg`, `clip.jpg`, `shot-*.png`, `README.md`).
**Interfaces:** Produces the visual spec path every later task cites. Packages: none. Tests: none. e2e: none. Contract: none.

- [ ] **Step 1:** Copy everything from `C:\Users\D\AppData\Local\Temp\claude\C--Users-D\67f34414-2dff-4e4d-a0c1-a09341872ee9\scratchpad\stage-island\` into `docs/design/stage-island/`. `README.md` says: throwaway prototype, open `index.html` directly, Demo chip lists states, the spec wins where they differ.
- [ ] **Step 2:** Run `node tools/agent/check-public-text.mjs docs/design/stage-island/index.html docs/design/stage-island/README.md` and `pnpm format:check`. Expected: no findings (add the folder to `.prettierignore` if prettier rejects the prototype's HTML).
- [ ] **Step 3:** Commit `docs(design): keep the stage island prototype`.

### Task 2: Shortcuts T, timeline and Ctrl+J

**Files:** Modify `packages/ui/src/shortcuts.ts:124` (`scene.timeline`), add entries; `packages/ui/src/i18n/en.ts`; Test `packages/ui/src/shortcuts.test.ts`.
**Interfaces:** Produces `ShortcutId` `'scene.tools'` (scope `scene`, keys `['T']`, label `keys.scene.tools`), `'global.agent'` (scope `global`, keys `['Ctrl+J']`, label `keys.global.agent`); `'scene.timeline'` keeps its id with `keys: []`. Settings → Keyboard (`screens/settings/Keyboard.tsx`) lists rows from `SHORTCUTS`, so no change there unless an empty `keys` breaks it (then it shows "No key"). Packages: `@aio/ui`. e2e: none yet. Contract: none.

- [ ] **Step 1: Failing tests** in `shortcuts.test.ts`: `it('T opens the island tools')` asserts `matchShortcut('scene', {key:'t'})` is `'scene.tools'`; `it('the timeline has no key')` asserts `shortcut('scene.timeline').keys` equals `[]` and no scene key matches it; `it('Ctrl+J opens the agent')` asserts `matchShortcut('global', {key:'j', ctrlKey:true})` is `'global.agent'`; `shortcutConflicts()` stays `[]`.
- [ ] **Step 2:** Run `pnpm --filter @aio/ui test shortcuts`. Expected: FAIL on the three new cases.
- [ ] **Step 3:** Edit the registry. Add **every new string of this project** to `en.ts` here, so later tasks (which run in parallel) never edit `en.ts`: `keys.scene.tools` "Open the tools", `keys.global.agent` "Ask the agent", `island.tools` "Tools", `island.allTools` "All tools", `island.toRightPanel` "Right panel", `island.swap` "Swap", `island.compareDates` "Compare the two dates", `island.offline` "Offline", `island.reconnecting` "Reconnecting…", `island.backOnline` "Back online", `island.tNotice` "T now opens the tools; the timeline is in View", `island.timeline` "Timeline", `island.askAgent` "Ask the agent", `wb.showIt` "Show it", `wb.collapseAll` "Collapse all", `wb.expandAll` "Expand all", `wb.moreTabs` "More tabs", `wb.pin` "Pin", `wb.unpin` "Unpin", `wb.search` "Search tools", `wb.favourites` "Favourites and recent", `wb.saved` "Saved in this project", `wb.showAll` "Show all", `wb.hideAll` "Hide all", `wb.jobs` "Jobs", `agent.offRow` "Agent off · Turn on", `agent.askAbout` "Ask about {context}", `agent.maximise` "Maximise", `agent.restore` "Restore", `agent.minimise` "Minimise", `compare.how` "How compare works", `status.online` "Online", `status.jobs` "{count} job" / "{count} jobs", and the D12 family, tool and hint labels for `measureCatalogue` (Task 13). If a later task finds a missing string it adds it in its own commit after its batch, never in parallel. Make `ariaKeys`/`shortcutHint` return `''` for an empty `keys`; adjust `Keyboard.tsx` only if its test fails.
- [ ] **Step 4:** Run `pnpm --filter @aio/ui test` and `pnpm --filter @aio/desktop test Keyboard`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ui): T opens the stage tools, Ctrl+J the agent`.

### Task 3: Island model

**Files:** Create `workspace/island/islandModel.ts`, `islandModel.test.ts`. Move `GroupId` and `GROUP_LABEL` here from `toolbarFit.ts` (Task 6 deletes it).
**Interfaces:**

- Produces `type GroupId = 'view'|'measure'|'display'|'clouds'|'volumes'|'video'|'road'|'annotate'`.
- `type LiveItem = { kind: 'tool'; label: string; reading: string | null } | { kind: 'playback'; clip: string; progress: number; telemetry: string | null } | { kind: 'job'; id: string; label: string; progress: number; more: number } | { kind: 'connection'; state: 'offline'|'reconnecting'|'back' }`.
- `pickLive(items: readonly LiveItem[]): { primary: LiveItem | null; secondary: LiveItem | null }`: priority tool > playback > job > connection (D3); jobs collapse to the newest with `more = count - 1`.
- `type IslandRest = 'dots' | 'date' | 'dateSteps'`; `islandRest(dateCount: number): IslandRest` (0 → dots, 1 → date, ≥2 → dateSteps; D2).
- `islandGroups(input: { map: boolean; mode: StageMode; clouds: boolean; volumes: boolean; video: boolean; road: boolean; pkg: boolean }): GroupId[]`: View, Measure, Display always; Point cloud with clouds; Volumes with volumes; Video with video; Road with road data in map or split; Annotate unless `pkg`. Order fixed: view, measure, display, clouds, volumes, video, road, annotate (D6).
- `type IslandState = { open: 'rest'|'ready'|'tools'|'date'; group: GroupId; preview: GroupId | null; swapped: boolean }`; `islandReducer(s: IslandState, e: IslandEvent): IslandState` with events `near`, `leave`, `toggleTools`, `openDate`, `hoverGroup(g)`, `pickGroup(g)`, `swap`, `escape`.
  Packages: desktop. Tests: this file. e2e: none. Contract: none.

- [ ] **Step 1: Failing tests:** `islandRest(0)==='dots'`, `islandRest(1)==='date'`, `islandRest(2)==='dateSteps'`; `pickLive([job a, tool, job b])` gives `primary.kind==='tool'`, `secondary` a job with `more===1` and the newest job (last started); `pickLive([connection offline])` gives it as primary; `pickLive([])` gives nulls; `islandGroups({... pkg:true})` excludes `'annotate'`; with `road:true, mode:'3d'` excludes `'road'`; with every flag the order equals the fixed order; reducer: `rest + toggleTools → tools`, `tools + escape → rest`, `hoverGroup('display')` sets `preview` and keeps `group`, `pickGroup('display')` sets `group` and returns to `rest`, `leave` from `ready` → `rest` but not from `tools`, `swap` flips `swapped`.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test islandModel`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the functions above (no React).
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): island state and live priority model`.

### Task 4: Live sources

**Files:** Create `workspace/island/useIslandLive.ts`, `useIslandLive.test.ts`.
**Interfaces:** Consumes `LiveItem` (Task 3), `measureStore` (`tool`, `draw`), `useEngineStage()` (`tool === 'measure'` until Task 13 merges it), `workspace` (`activeClip`, `playing`, `nowMs`), processing jobs (`processing/model.ts` `projectJobs`), connection (`shell/connection.ts` `connectionStatus`, `useNetworkUp`). Produces `liveItems(input: LiveInput): LiveItem[]` (pure) and `useIslandLive(): LiveItem[]`. `connection` appears only when not healthy; `back` lasts 2000 ms (D3). Telemetry string "ALT 31 m · SPD 3.2 m/s" from the playing clip (D30). Packages: desktop. e2e: none. Contract: none.

- [ ] **Step 1: Failing tests** on `liveItems`: a running survey Distance with a reading gives `{kind:'tool', label:'Distance', reading:'12.40 m'}`; a playing clip at 30% gives `progress 0.3`; two running jobs give two `job` items ordered by start; network down gives `connection offline`; after it comes back, `back` then nothing after 2000 ms (fake timers).
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test useIslandLive`. Expected: FAIL.
- [ ] **Step 3:** Implement `liveItems` and the hook (subscribe with existing selectors; format readings with the survey's `unitLabel`).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): island live sources`.

### Task 5: Island component

**Files:** Create `workspace/island/Island.tsx`, `IslandDate.tsx`, `IslandTools.tsx`, `IslandLive.tsx`, `groups.tsx`, `island.css`, `Island.test.tsx`.
**Interfaces:**

- Consumes Tasks 2 to 4, `Button`, `IconButton`, `Popover`, `Tip`, `PortalRoot`, `.seg` (no component exists for it); the stage-mode switch (`MODES` from `Stage.tsx:134`, moved to `groups.tsx`); `DatePicker` internals (`workspace/DatePicker.tsx`) for the calendar; `global.prevSurvey`/`nextSurvey`.
- Produces `<Island stage={EngineStage|null} mode={StageMode} tools={StageMode} compare={ReactNode} />` rendering `role="toolbar"` `aria-label="Stage tools"` (kept so specs' toolbar scoping holds), `data-surface="dark"`, `data-state` = rest | ready | tools | date, `data-linked` when the sidebar front tab is the primary live item (D10; reads a `linked: boolean` prop until Task 11 supplies it).
- `groups.tsx` exports `quickRow(g: GroupId, ctx): ReactNode` with the D5 tiles; in stage 1 a group's full content (today's `render(g)` from `Stage.tsx:278`) opens in a `Popover` anchored under the island (D-Risks: stage 1 keeps today's popovers).
- `IslandDate` keeps `data-testid="date-row"` on its root and `date-bar-count` on the "2 of 2" text; ‹ › carry `aria-keyshortcuts` of `global.prevSurvey`/`nextSurvey`; the calendar has "Compare the two dates".
- A polite live region announces live changes at most once a second.
  Packages: desktop. e2e: covered in Task 8. Contract: none.

- [ ] **Step 1: Failing tests** in `Island.test.tsx` (jsdom, `createRoot` + `act`): rest with two dates renders "● 13 Apr" and no tiles; pointer `near` shows "‹", "2 of 2", "3D", "Tools"; click opens tools with `aria-label` "3D", "Map", "Split" buttons and the group tabs; hovering "Display" shows its quick row while "View" stays selected (`aria-selected`); ArrowRight moves focus between tiles; Esc returns to rest and focus to the island; a live Distance shows "13 Apr" and "Distance 12.40 m" together; two live items render a bubble button "Swap" whose click swaps them; under `matchMedia('(prefers-reduced-motion: reduce)')` the root has `data-motion="reduce"`; a project without dates renders three dots and no `date-row`.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test Island`. Expected: FAIL.
- [ ] **Step 3:** Implement. Size morph: CSS on `width`/`height` of the capsule only (it holds no canvas) with `var(--d-island) var(--ease-island)`, content crossfade by `opacity`; radius pill at rest, 16 px open (D1). Focus trap while `tools` or `date` is open.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): the stage island`.

### Task 6: Island on the stage, toolbar and date strips out

**Files:** Modify `workspace/Stage.tsx` (`StageToolbar` 193-409 removed, `<Island>` at 898, `keepOut` selector at 647, key handler 772-808), `workspace/WorkspaceScreen.tsx` (`DateBar` 241, `DateRow`/`TimelineBar` 252-257), `workspace/StageTools.tsx` (View gets the Timeline toggle tile and Ask the agent tile), `styles.css`; Delete `workspace/toolbarFit.ts` + test, `workspace/DateRow.tsx` + test, `workspace/DateBar.tsx` + test (move `isTypingTarget` to `keys.ts` if still used); Test `workspace/Stage.keys.test.tsx` (new).
**Interfaces:** Consumes `<Island>`. Produces the stage without `.stbar`; the Timeline tile (`aria-label` `t('timeline.show')` / `t('timeline.hide')`, `aria-pressed`, `data-testid="timeline-toggle"`); T toggles the island tools; the one-time T notice (shown once, stored with `stagePrefs`). The right-panel toggle stays a button at the stage's top right with its current accessible names (D17). Packages: desktop. e2e: Task 8. Contract: none.

- [ ] **Step 1: Failing tests** in `Stage.keys.test.tsx`: `it('T opens the tools')`; `it('stage keys ignore typing targets')` dispatches T and M on an `<input>`, a `[contenteditable]` and the agent textarea and asserts the island stays at rest and no tool starts; `it('M still starts Measure a distance')`; `it('the timeline toggles from View')`.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test Stage.keys`. Expected: FAIL.
- [ ] **Step 3:** Swap the toolbar for the island, add the `scene.tools` branch and drop `scene.timeline` from the key handler, remove DateBar/DateRow/TimelineBar mounts. Split `StageTools.tsx` by group into `workspace/tools/view.tsx`, `measure.tsx`, `display.tsx`, `cloud.tsx`, `video.tsx`, `annotate.tsx` (keeping `Tool`, `PopTool`, `useEngineStage` in `StageTools.tsx`; update imports, no re-exports), and route M through `toggleMeasure(three: EngineStage)` exported from `tools/measure.tsx`, so Tasks 13 to 16 own disjoint files and never edit `Stage.tsx`'s key handler. Update `keepOut` to `.island, .stage-under > *, .vwin:not(.docked), .cursor-ro, .surface-pop, .elev-legend, .pane-chooser, .vol-legend`, delete the dead CSS.
- [ ] **Step 4:** Run `pnpm --filter @aio/desktop test` (whole app; fix tests that imported the deleted modules). Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): the island replaces the stage toolbar and date strips`.

### Task 7: No title bar

**Files:** Delete `shell/TitleBar.tsx`; Create `shell/SidebarTop.tsx`, `shell/SidebarStatus.tsx`, `shell/PageHeader.tsx`, `shell/RightHeader.tsx`, `shell/caption.ts` + tests; Modify `App.tsx:447`, `shell/Sidebar.tsx` (905-967: pinned nav, `Datasets` only on `screen === 'scene'`, help beside Settings), each non-Scene screen root (`screens/Projects.tsx`, `globe/GlobeScreen.tsx`, `screens/Issues*`, `screens/Media.tsx`, Detections, Reports, `screens/Settings.tsx`, Help) to render `<PageHeader>`, `apps/desktop/src/main/index.ts:1997-2000`, `styles.css` (`.titlebar` out, drag regions).
**Interfaces:**

- `caption.ts`: `captionInset(platform: NodeJS.Platform | 'web'): { inlineEnd: number; inlineStart: number }` → win32 `{138, 0}`, darwin `{0, 72}`, else `{0, 0}`; exposed as CSS vars `--caption-end` / `--caption-start` on `.app`.
- `SidebarTop`: logo, `ProjectSwitcher` (moved from `Sidebar.tsx:120`, reading "client / project"), search `IconButton` (`label` `t('titlebar.search')`, `shortcut` the palette's `ShortcutId`) that opens the palette; `app-region: drag` row with `no-drag` buttons.
- `SidebarStatus` (foot): "● Online · 1 job" opening the existing connection menu (`ConnectionStatus`) and processing drawer; holds `readonly-chip` and `origin-chip` (each a `Chip kind="tag"`, `tone` as today) (_lead's call: the title bar's package chips need a home; the foot is where the project's state already sits_).
- `RightHeader`: `AgentToggle` and `SyncStatus` (the Share control, both `Button`/`IconButton` with `Tip`), 40 px, `padding-inline-end: var(--caption-end)`, drag region.
- `PageHeader({ title: MessageKey, actions?: ReactNode })`: 40 px, drag on empty space, inset for captions.
- main: `trafficLightPosition: { x: 16, y: 12 }` on darwin; Windows options unchanged.
  Packages: desktop (renderer and main). e2e: Task 8. Contract: none (window options unchanged on Windows).

- [ ] **Step 1: Failing tests:** `caption.test.ts` for the three platforms; `Sidebar.test.tsx` gains `it('shows the dataset tree only on the Scene')`, `it('keeps the nav out of the scrolling tree')` (nav is not inside `.sb-scroll`), `it('has help beside Settings')` (`data-testid="help-open"`); `PageHeader.test.tsx` renders the title and actions; `SidebarStatus.test.tsx` shows `readonly-chip` for a read-only package.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test Sidebar caption PageHeader SidebarStatus`. Expected: FAIL.
- [ ] **Step 3:** Implement; remove `<TitleBar />`; the stage top is not a drag region.
- [ ] **Step 4:** Run the desktop tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): remove the title bar`.

### Task 8: e2e for stage 1

**Files:** Create `apps/desktop/e2e/island.ts`, `apps/desktop/e2e/island.spec.ts`; Modify the specs found by `git grep -lE "More tools|Stage tools|stbar|date-row|date-bar|titlebar|search-btn|timeline-bar|Survey measurements|Show the right panel" apps/desktop/e2e` (38 files at plan time: a11y, agent-show, basemap-picker, compare, compliance, connection, csp, date-annotations, designs, drawings, environment, globe, haul, hydro, magic-polygon, materials, measure-tools, online-map-sources, online-satellite, overlays, pano-compare, pointcloud-clean-export, sections, small-window, smoke, stage-display, stockpile-date, street-map-3d, survey-export, survey-gaps, survey-qa, survey-reports, telecom-measurements, templates, timeline-lanes, volumes-general, volumetric-build, walk-place-3d, plus one road-demo spec named after its sample site, which the grep finds).
**Interfaces:** `island.ts` exports `openIslandTools(win: Page): Promise<Locator>`, `islandGroup(win: Page, g: GroupId): Promise<Locator>` (opens tools, clicks the group tab, returns its row or popover), `stageMode(win: Page, m: '3D'|'Map'|'Split'): Promise<void>` (clicks inside `toolbar[name="Stage tools"]`, waits for `aria-pressed`), `islandDate(win: Page): Locator`. Packages: desktop e2e. Contract: none.

- [ ] **Step 1:** Write `island.spec.ts`: rest shows the date; T opens tools and Esc closes; group tabs switch on click; a live Distance shows the reading next to the date; a project with one date has no arrows; at 1100 × 720 the island never covers a click at the stage centre (`document.elementFromPoint`).
- [ ] **Step 2:** Replace "More tools"/toolbar walks in each listed spec with the helpers; `date-bar`/`date-row` locators keep their ids; `timeline-bar` becomes `timeline-toggle` reached through `islandGroup(win, 'view')`; title-bar search and help locators keep their names. No assertion changes.
- [ ] **Step 3:** Run `pnpm check`, then every listed spec plus `island.spec.ts` the CI way (Global Constraints). Expected: all pass; log shows `[e2e] window 1100 x 720 px at display scale 1`.
- [ ] **Step 4:** Commit `test(e2e): reach stage tools through the island`. **Stage 1 merges here** (CLAUDE.md merge flow).

## Stage 2: workbenches and agent dock (merge 2)

### Task 9: Workbench tab model

**Files:** Create `workspace/workbench/tabsModel.ts`, `tabsModel.test.ts`.
**Interfaces:**

- `type TabId = 'measure'|'display'|'clouds'|'volumes'|'video'|'road'|'annotate'|'jobs'|'selection'|'issues'|'changes'|'qa'|'overlays'|'hydro'|'cleanup'|'measurements'`.
- `interface Tab { id: TabId; live: boolean; pinned: boolean; fixed: boolean; minWidth?: number }` (`volumes` and `changes` `minWidth: 470`, D17).
- `orderTabs(tabs: readonly Tab[]): Tab[]`: live tabs in island priority, then panels, then fixed `selection, issues, volumes, changes` at the end (D11).
- `openPanel(tabs, id, { pinned }): Tab[]`: a new unpinned panel replaces the previous unpinned one (D15).
- `onToolStart(state: { tabs: Tab[]; front: TabId; issueEditing: boolean }, id: TabId): { tabs: Tab[]; front: TabId; attention: TabId | null }`: unpinned panels close; front becomes `id` unless `issueEditing` (then `attention = id`, D14).
- `onToolStop(state, id, { openedByTool: boolean }): {...}`: tab closes and front → `selection` when the tool opened it, else the bench stays (D13).
- `fitTabs(widths: ReadonlyMap<TabId, number>, ordered: readonly Tab[], front: TabId, available: number): { shown: TabId[]; overflow: TabId[] }`: one row; fixed leave first, then panels, then `selection`, live last, the front never (D11).
- `paneWidth(pref: number, front: Tab, stageMin: number, available: number): number`: max of pref and `front.minWidth`, clamped so the stage keeps `stageMin` (360).

- [ ] **Step 1: Failing tests:** `orderTabs` with live video and measure gives `measure, video, ...`; `openPanel` twice unpinned keeps one; pinned survives `onToolStart`; `follow never takes over an issue edit` (front stays `issues`, `attention==='measure'`); `onToolStop` with `openedByTool` → front `selection`; `fitTabs` at 240 px keeps the live and front tabs and overflows fixed first; `width clamps to keep the stage` (`paneWidth(360, volumes, 360, 1100-52-360)` returns ≥ 470 only if the stage keeps 360, otherwise the clamp).
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test tabsModel`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): workbench tab model`.

### Task 10: Workbench store and issue edit state

**Files:** Create `workspace/workbench/workbenchStore.ts` + test; Modify `issueCard/state.ts` (add `issueEdit` store), `issueCard/IssueCard.tsx:349` (report `edit`).
**Interfaces:** Consumes Task 9. Produces `workbench` zustand store `{ tabs: Tab[]; front: TabId; attention: TabId|null; openedByTool: Set<TabId> }` with actions `open(id, opts?)`, `pin(id, on)`, `close(id)`, `front(id)`, `toolStarted(id)`, `toolStopped(id)`, reset on project change; `useWorkbench(selector)`. `issueEdit`: `setIssueEditing(id: string | null)`, `useIssueEditing(): boolean`. Pins persist per computer via `createStagePrefStore` key `quadrion.workbench`.

- [ ] **Step 1: Failing tests:** `IssueCard reports its edit state` (opening the card's edit form sets `useIssueEditing()` true, closing sets false); store `toolStarted('measure')` while editing keeps `front==='issues'`; project change resets tabs to the fixed set.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test workbenchStore IssueCard`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): workbench store, issue edit state`.

### Task 11: Right sidebar shell

**Files:** Create `workspace/workbench/RightSidebar.tsx`, `TabBar.tsx`, `workbench.css` + tests; Modify `workspace/WorkspaceScreen.tsx` (`ContextPanel` 125-216 folds into the tab model; `aside.right` 266-285 becomes `<RightSidebar>`), `styles.css` (`.ws-vol` rule at 2043 out).
**Interfaces:** Consumes Tasks 9, 10, 7 (`RightHeader`), `ResizableSplit` (the foundation's `scene.right` from its Task 7: stage | sidebar, default 360, min 280, max 50%, collapse = today's `rightCollapsed`, Ctrl+Alt+B; reuse, do not add `ws.right`), `Tabs<TabId>` as the whole tab bar (`label` "Workbench", `idPrefix` `wb`, `overflow="menu"`, `overflowOrder` from Task 9's `fitTabs` order: fixed leave first, then panels, then `selection`, live last; per item `live`, `pinned`/`onPinChange`, `onClose`; the foundation's overflow `Menu` is labelled "More tabs"). `TabBar.tsx` is a thin wrapper mapping `Tab` to `TabItem`; it adds no tab, dot, pin or overflow code of its own. `Tip` for hints. Produces `<RightSidebar>` with tab bar (`role="tablist"`, `data-testid="tab-changes"` kept on Changes), `data-front` on the body, the ⋯ menu button (from `Tabs`, accent while a live tab is inside), and `linked` for the island (`front` equals the primary live item's tab). Fixed tabs keep today's content: `SelectionCard`, `IssueRegister`/`IssueCard`, `VolumesPanel`, `ChangesTab`; `TelecomTools`, `RoadPanel`, `RoadSetupCard` keep rendering where they do today inside the body.

- [ ] **Step 1: Failing tests** (`RightSidebar.test.tsx`): tabs render in model order; ⋯ appears at 300 px with five tabs and lists the overflow; Volumes in front sets the pane width to 470; the island receives `linked` when Measure ● is in front; Ctrl+Alt+B still collapses.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test RightSidebar`. Expected: FAIL.
- [ ] **Step 3:** Implement; pass `linked` to `<Island>`.
- [ ] **Step 4:** Run the desktop tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): the right sidebar as workbench`.

### Task 12: Collapsible sections

**Files:** Create `workspace/workbench/Section.tsx`, `sectionState.ts` + tests.
**Interfaces:** `<Section id: string; bench: TabId; title: string; count?: number; defaultOpen?: boolean; forceOpen?: boolean>` (header `button` with `aria-expanded`, chevron, count; height animates with `--d-2`/`--ease`, instant under reduced motion). `useSections(bench: TabId)` → `{ isOpen(id), toggle(id), collapseAll(), expandAll() }` persisted per bench (`quadrion.sections`). `filterSections<T>(sections: readonly { id: string; items: readonly T[] }[], match: (t: T) => boolean): { id: string; items: T[] }[]` drops empty sections; while a query is active every remaining section is open; clearing restores the saved state (D16).

- [ ] **Step 1: Failing tests:** Enter and Space toggle; state survives a remount; `collapseAll` then `expandAll`; `filterSections` hides empty ones; `forceOpen` keeps the live family open after `collapseAll`.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test Section sectionState`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): collapsible workbench sections`.

### Task 13: Measure workbench and one Distance tool

**Files:** Create `survey/measureCatalogue.ts` + test, `workspace/workbench/benches/MeasureBench.tsx` + test; Modify `survey/measureStore.ts` (`startTool` 431, transient option), `survey/MeasureToolbar.tsx` (the `PopTool` at 90-345 goes; `MeasurementList`, `MeasurementPanel`, `SurveyQaTool`, `OverlaysPanel`, `HydroTool`, `HaulRoadTool`, `DesignsTool`, `ExportTool`, `TemplateEditor` become sections or tabs), `workspace/tools/measure.tsx` (from Task 6: "Measure a distance" and `toggleMeasure` start the survey Distance), `survey/TelecomTools.tsx`.
**Interfaces:**

- `measureCatalogue`: `FAMILIES: readonly { id: 'point'|'line'|'polygon'|'telecom'|'markup'|'section'; label: string; tools: readonly { tool: MeasurementTool | 'section'; label: string; hint: string; key?: ShortcutId; saves: boolean }[] }[]` with the D12 list; `favourites` pref (`quadrion.measure.favourites`, default Distance, Elevation, Area, Volume).
- `startTool(tool, opts?: { transient?: boolean })`: transient Distance never calls `addMeasurement` and shows no Save; read-only packages always start transient (`readOnly || pkg !== null`, `MeasureToolbar.tsx:98`).
- `MeasureBench`: search, Favourites and recent, families as `<Section>`s, Site data (Designs, Survey QA and cleanup, Terrain overlays, Hydrology, Haul road, Export survey data), Drawing aids, Templates, "Saved in this project" with Show all / Hide all (`setMeasurementsVisible`) and an eye per row; keeps `data-testid="survey-tools"` on its catalogue root; live morph (D13): live card (reading, points, Undo Backspace, Stop Esc, Save Enter), catalogue shrinks to a strip of text-labelled tool buttons (`Button variant="quiet" size="sm" pressed`); catalogue and saved rows are `Row kind="tree"` (`actions` for the eye and ⋯), an empty search shows `EmptyState`; workbench tab `measure` opens on M and tool start via `workbench.toolStarted('measure')`.
- Survey QA, Terrain overlays and Hydrology open as their own tabs (`qa`, `overlays`, `hydro`); the floating "Measurements" list becomes the `measurements` section and keeps the accessible name "Close the measurements list" on its close.

- [ ] **Step 1: Failing tests:** catalogue has the 15 tools in D12 families; `read-only package measures without saving` (pkg set, M starts Distance, two points produce a reading, no Save button, `file.measurements` unchanged); M in a normal project starts Distance and Enter saves to "Saved in this project"; search "slope" leaves only Line with Grade and slope; the live strip shows text labels; stopping a tool that opened the tab returns the front to Selection.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test measureCatalogue MeasureBench measureStore`. Expected: FAIL.
- [ ] **Step 3:** Implement; the engine's own `measure` tool is no longer reachable from the UI (engine API unchanged).
- [ ] **Step 4:** Run the desktop tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): the Measure workbench and one Distance tool`.

### Task 14: Display and Point cloud workbenches

**Files:** Create `benches/DisplayBench.tsx`, `benches/CloudBench.tsx` + tests; Modify `workspace/tools/display.tsx` and `tools/cloud.tsx` (from Task 6: `DisplayTools`, `PinToggle`, `CloudTools`), `workspace/StreetMapTool.tsx`, `pointcloud/CleanupHost.tsx` (cleanup as tab `cleanup`).
**Interfaces:** Benches compose the existing controls (as `Button`/`Row`/`EmptyState`/`Chip`) inside `<Section>`s: Display = Labels, Pins (severity filter, heat map), Layers by kind with eyes, Street map (D12; default open Labels and Pins). Cloud = show, colour with legend, size and EDL, clouds list, Clean up, Survey QA. Keep `data-testid="cloud-panel"` and `cleanup-tool`. `shell.setCloudPanel(true)` now opens the `clouds` tab.

- [ ] **Step 1: Failing tests:** each bench renders its sections; `setCloudPanel(true)` brings `clouds` to front; Clean up opens the `cleanup` tab.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test DisplayBench CloudBench`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): Display and Point cloud workbenches`.

### Task 15: Video, Annotate and Jobs workbenches

**Files:** Create `benches/VideoBench.tsx`, `benches/AnnotateBench.tsx`, `benches/JobsBench.tsx` + tests; Modify `workspace/tools/video.tsx` and `tools/annotate.tsx` (from Task 6: `FlightPathTool`, `TelemetryTool`, `VideoTools`, `AnnotateToggle`), `workspace/Stage.tsx` (annotation sub-bar 906-919 moves into AnnotateBench; the only `Stage.tsx` edit in batch H), `processing/` (reuse `JobList`, `JobDetail`; no edits).
**Interfaces:** VideoBench: player card (`Button`/`IconButton` controls; poster thumbnail + scrubber driving the one floating window via `workspace.setTime`, no second decoder, D12), clip list, camera mode, flight paths (`data-testid="path-panel"` kept), telemetry. AnnotateBench: model, cloud and map tools (`AnnotationToolbar`, `MapDrawTools`) and drafts; "Close the annotation tools" name kept. JobsBench: tab `jobs` listing running jobs as `Row kind="tree"` with ring, steps, log, Cancel (`Button variant="danger"`), "Open the job"; `EmptyState` when none.

- [ ] **Step 1: Failing tests:** dragging the scrubber calls `setTime`; no `<video>` element renders in the bench; A opens `annotate`; two running jobs show two rows in one tab.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test VideoBench AnnotateBench JobsBench`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): Video, Annotate and Jobs workbenches`.

### Task 16: Road, Volumes and environment benches

**Files:** Create `benches/RoadBench.tsx`, `benches/VolumesBench.tsx` + tests; Modify `road/RoadTools.tsx` (`RoadToolGroup` 175, `RoadLegend` 277), `workspace/VolumeTools.tsx`, `environment/EnvironmentTool.tsx` (opens as a View tab panel, `data-testid="env-panel"` kept), `workspace/CutawayTool.tsx`.
**Interfaces:** RoadBench: overlay with legend, close-up, layers, measure on the map; road keys unchanged (`useRoadKeys`). VolumesBench is the fixed `volumes` tab: date, Swipe, surface, bodies, section line above `VolumesPanel`; switch names ("Cut / fill" and the rest) kept.

- [ ] **Step 1: Failing tests:** RoadBench renders road layers; VolumesBench keeps "Cut / fill" and opens at 470 px; Environment opens as a panel tab with `env-panel`.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test RoadBench VolumesBench`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): Road, Volumes and environment benches`.

### Task 17: Island tiles open the workbench

**Files:** Modify `workspace/island/groups.tsx`, `IslandTools.tsx`; Test `Island.test.tsx`.
**Interfaces:** Consumes Tasks 11 to 16. Stage 1's popovers go: a group tab click calls `workbench.open(groupTab)`; caret tiles open their panel tab and the island returns to rest; "→ right panel" tile per row; quick rows trimmed to D5.

- [ ] **Step 1: Failing tests:** clicking the Measure tab opens `measure` and closes the island; "All tools" does the same; a caret tile (Environment) opens `env-panel` as an unpinned tab.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test Island`. Expected: FAIL.
- [ ] **Step 3:** Implement; delete the stage-1 popover path.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): island groups open their workbench`.

### Task 18: Agent pane

**Files:** Create `agent/AgentPane.tsx` + test; Modify `workspace/workbench/RightSidebar.tsx` (the agent slot, which Task 11 moved there from `WorkspaceScreen.tsx` 282-284), `agent/AgentHost.tsx` (header gets Cloud AI status from the old title bar), `App.tsx` (Ctrl+J).
**Interfaces:** `ResizableSplit` vertical (the foundation's `scene.ctxAgent`; the bench is the sized start pane, default fraction 0.6, `otherMin` 96 px for the agent, double-click resets to 60/40; change only `defaultSize` there). `agentPane` store `{ mode: 'normal'|'max'|'min'; userSized: boolean }`; tool start → `min` unless `userSized`, stop restores (D23). AI off → one row "Agent off · Turn on" (D24). Minimised line "Ask about ‹context› · Ctrl J". Ctrl+J focuses the input (opens the right sidebar if collapsed).

- [ ] **Step 1: Failing tests:** maximise hides the bench body but keeps the tab bar; a tool start minimises; after a manual resize a tool start does not; AI off renders one row; Ctrl+J focuses the input.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test AgentPane`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): resizable agent pane`.

### Task 19: Drawer when the sidebar is hidden

**Files:** Create `workspace/workbench/Drawer.tsx` + test; Modify `workspace/WorkspaceScreen.tsx` (mounts the drawer; `RightSidebar.tsx` is Task 18's in this batch), `shell/RightHeader.tsx` (caption buttons over the stage on a dark backing when collapsed, D28).
**Interfaces:** With `rightCollapsed`, a live start or an island click slides the same front bench in over the stage edge (`--z-drawer`, transform only); no agent; Esc or the live item ending slides it out; focus trapped and returned to the island.

- [ ] **Step 1: Failing tests:** collapsed + tool start shows the drawer with `measure`; no agent pane inside; Esc closes and focus returns to the island.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test Drawer`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): workbench drawer over the stage`.

### Task 20: e2e for stage 2

**Files:** Create `e2e/workbench.spec.ts`, `e2e/agent-dock.spec.ts`, `e2e/drawer.spec.ts`; Modify specs that open survey, cloud, path, env, cleanup, QA, hydro, overlays, haul, designs, telecom, measure, volumes panels (from the Task 8 list) to use `islandGroup` plus a new helper `openBench(win, id: TabId)` in `e2e/island.ts`.
**Interfaces:** Selector-only changes. Packages: desktop e2e.

- [ ] **Step 1:** Write specs: following with the issue-edit exception; pin survives a tool start; sections and search; sidebar drag width remembered across relaunch; agent maximise/minimise/resize; drawer with the sidebar hidden.
- [ ] **Step 2:** Update the panel specs.
- [ ] **Step 3:** `pnpm check`, then all changed and new specs the CI way. Expected: pass.
- [ ] **Step 4:** Commit `test(e2e): workbench, agent pane and drawer`. **Stage 2 merges here.**

## Stage 3: stage room and Split (merge 3)

### Task 21: Overlay slots, telemetry and video dock

**Files:** Create `workspace/overlaySlots.ts` + test; Modify `workspace/Stage.tsx` (`StageStatus` 462, `stage-under` 905-930, `DatesOnScreen` 931), `workspace/FloatingVideo.tsx` (resizable; docked = `ResizableSplit` side or bottom split, id `scene.video`), `workspace/MapMenus.tsx` (one basemap chip per stage), `workspace/SceneCursor.tsx` (scrim), `styles.css`.
**Interfaces:** `assignSlots(items: readonly { id: string; want: Corner[] }[]): Map<string, Corner | 'hidden'>` with `Corner = 'tl'|'tr'|'bl'|'br'`, never two in one corner. Telemetry leaves the model (island live line and VideoBench); the PAUSED chip goes.

- [ ] **Step 1: Failing tests:** `assignSlots` gives distinct corners and hides the overflow; with a docked video the dock has a divider `role="separator"`; no element with text "PAUSED" renders on the stage.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test overlaySlots FloatingVideo`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): stage overlays take slots, video docks with a divider`.

### Task 22: Split and Compare, then e2e for stage 3

**Files:** Modify `workspace/SplitPanes.tsx` (pane header strip: date chip, view name, link toggle; divider = `ResizableSplit` id `scene.split`, fraction (the existing `SplitPane`/`useSplit` of this file stay for the panes)), `workspace/CompareControls.tsx` ("How compare works" link replaces "?"), `workspace/island/IslandDate.tsx` (follows the last focused pane), `e2e/compare.spec.ts`, `e2e/pano-compare.spec.ts`, `e2e/small-window.spec.ts`.
**Interfaces:** `focusedSide` from `splitModel.ts` drives the island date; ‹ › and Alt+Left/Right step that pane (D7).

- [ ] **Step 1: Failing tests:** `SplitPanes.test.tsx` (new) asserts each pane has its header and the island date shows the focused pane's date; the divider moves with arrow keys.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop test SplitPanes`. Expected: FAIL.
- [ ] **Step 3:** Implement; extend `small-window.spec.ts` at 1100 × 720 and 1100 × 700: the stage centre is clickable with Volumes in front, the tab bar is one row, the island fits.
- [ ] **Step 4:** `pnpm check`, then `compare`, `pano-compare`, `small-window` and every spec touched in this stage the CI way. Expected: pass.
- [ ] **Step 5:** Commit `feat(desktop): Split and Compare pane headers and divider`. **Stage 3 merges here.**

---

## Execution DAG

Dependencies (→ means "needs"): T1 → nothing. T2 → foundation Merge A. T3 → nothing. T4 → T3. T5 → T2, T4. T6 → T5. T7 → T2. T8 → T6, T7. T9 → nothing. T10 → T9. T11 → T6, T7, T10. T12 → T2. T13, T14, T15, T16 → T11, T12. T17 → T13, T14, T15, T16. T18, T19 → T11. T20 → T17, T18, T19. T21 → T20 (stage 2 merged). T22 → T21.

Stage 2 tasks T9, T10 and T12 are pure modules with no UI mount, so they are built during stage 1 and merge with it unused; T11 onwards is stage 2.

Parallel batches (each dispatched in one message; no shared files inside a batch; `en.ts` is written only by T2):

| Stage | Batch | Tasks              | Files that keep them apart                                                                                                                                                                            |
| ----- | ----- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | A     | T1, T2, T3, T9     | `docs/design/` / `packages/ui` / `island/islandModel` / `workbench/tabsModel`                                                                                                                         |
| 1     | B     | T4, T7, T10, T12   | `island/useIslandLive` / shell + main + screen roots / `workbench/workbenchStore` + `issueCard` / `workbench/Section`                                                                                 |
| 1     | C     | T5                 | `island/` components                                                                                                                                                                                  |
| 1     | D     | T6                 | `Stage.tsx`, `WorkspaceScreen.tsx`, `StageTools.tsx` split into `workspace/tools/`                                                                                                                    |
| 1     | E     | T8                 | e2e; **merge 1**                                                                                                                                                                                      |
| 2     | F     | T11                | `workbench/RightSidebar`, `WorkspaceScreen.tsx`                                                                                                                                                       |
| 2     | G     | T13, T14, T15, T16 | `survey/` + `tools/measure` / `tools/display`, `tools/cloud` / `tools/video`, `tools/annotate`, `Stage.tsx` sub-bar / `road/`, `VolumeTools`, `environment/`, `CutawayTool`; each its own `benches/*` |
| 2     | H     | T17, T18, T19      | `island/groups`, `IslandTools` / `agent/`, `RightSidebar.tsx`, `App.tsx` / `Drawer`, `WorkspaceScreen.tsx`, `RightHeader`                                                                             |
| 2     | I     | T20                | e2e; **merge 2**                                                                                                                                                                                      |
| 3     | J     | T21                | overlays, `FloatingVideo`, `MapMenus`, `SceneCursor`                                                                                                                                                  |
| 3     | K     | T22                | Split, Compare, e2e; **merge 3**                                                                                                                                                                      |

Critical path: foundation Merge A → T2 → T5 (after T3 → T4) → T6 → T8 (merge 1) → T11 → T13 → T17 → T20 (merge 2) → T21 → T22 (merge 3). T13 (Measure workbench and the one Distance tool) is the longest task on it.

Packages per task: `packages/ui` T2; `apps/desktop` main T7; `apps/desktop` renderer every task except T1; `apps/desktop/e2e` T8, T20, T22. Contract changes: none planned.
