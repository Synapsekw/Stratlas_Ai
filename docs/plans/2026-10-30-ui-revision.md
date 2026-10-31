# UI revision: implementation plan and project tracker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each workstream task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is test first: write the failing test, run it and see it fail for the stated reason, then make it pass.

**Approval:** founder decisions of 30 Oct 2026 (design, "Founder decisions"). Waves 1 and 3 and the Wave 2 spike build from this plan without a review of it. The Wave 2 build (W7 to W13) starts when the founder approves the spike (gate **G1**); after that, no further plan-approval waits.

**Goal:** Make the shell structurally quieter (four fixed right-panel tabs, one tool registry, video docked in the bottom strip, fixed stage overlay slots, one truthful AI status, layout presets per project type, Settings by topic) and consolidate the design system so it stays that way.

**Spec:** `docs/plans/2026-10-30-ui-revision-design.md` (sections 1 to 12 are referred to as D1 to D12). Evidence: `docs/design/ui-review-2026-10/` (critique, code audit, annotated screenshots).

**Architecture:** Everything is renderer work in `apps/desktop/src/renderer` (R below) and `packages/ui`, with small edits in `packages/annotate`, `packages/maps` and `packages/globe`. Presets are code (`R/layout/presets.ts`), user layout choices live in localStorage like today's panel prefs, and the spike sits behind a localStorage dev flag. No `@aio/schema` change is planned.

**Tech stack:** TypeScript strict, React 19, zustand, `@aio/ui` (tokens, `useFocusTrap`, `Menu`, `Tabs`, `CommandPalette`, `shortcuts.ts`), Vitest, Playwright with Electron.

## Tracker

Status: todo / in progress / handed over / landed. Owner: the session that holds the branch. Update this table on the workstream's own branch when its status changes (one row edit, no other lines), so the tracker rides with the work.

| Id   | Title                                                                           | Wave | Branch                     | Depends on                                               | Status                               | Owner   |
| ---- | ------------------------------------------------------------------------------- | ---- | -------------------------- | -------------------------------------------------------- | ------------------------------------ | ------- |
| W0   | Split `en.ts` into area modules (mechanical, no key changes)                    | 0    | `chore/i18n-split`         | none                                                     | landed cb12bf3c9                     |         |
| W1a  | Polish: shell, library, compare, processing                                     | 1    | `fix/ui-polish-shell`      | W0                                                       | landed 563195b04                     |         |
| W1b  | Polish: stage, timeline, tooltips, island label                                 | 1    | `fix/ui-polish-stage`      | W0                                                       | landed a9adde2e4                     |         |
| W1c  | Polish: map framing and labels, Globe                                           | 1    | `fix/ui-polish-maps`       | W0                                                       | landed ee13d2b2f                     |         |
| W1d  | Layout guards at 1100 x 720 and 1366 x 768                                      | 1    | `test/ui-layout-guards`    | W1a, W1b, W1c                                            | todo                                 |         |
| W2   | One truthful AI status chip and one AI name                                     | 1    | `feat/ai-status-chip`      | W0                                                       | landed b904e8b26                     |         |
| W3   | `@aio/ui` Dialog, toast host, Menu hardening (no call sites)                    | 3    | `feat/ui-primitives`       | W0                                                       | landed 7f1c54591                     |         |
| W4   | Wave 2 layout spike behind a dev flag                                           | 2    | `feat/layout-spike`        | W0                                                       | landed 8b7b513cd (behind Ctrl+Alt+L) |         |
| W5   | Palette indexes tools, tabs, modes and Settings                                 | 1    | `feat/palette-tools`       | W0                                                       | landed adb36dc1b                     |         |
| W6   | Settings by topic, Project settings, AI page split                              | 2    | `feat/settings-reorg`      | W0                                                       | landed 8bcc3cb9e                     |         |
| G1   | Founder approves the spike                                                      | 2    | none                       | W4                                                       | awaiting founder verdict             | founder |
| W7   | Right panel: four fixed tabs, sections, one width                               | 2    | `feat/right-panel-tabs`    | G1                                                       | todo                                 |         |
| W8   | One tool registry: Tools tab, island modes, palette source                      | 2    | `feat/tool-registry`       | W7, W5                                                   | todo                                 |         |
| W9   | Video docked tile and pop-out window                                            | 2    | `feat/video-dock`          | G1                                                       | todo                                 |         |
| W10  | Fixed stage overlay slots, one hint or toast, labels clamped                    | 2    | `feat/stage-slots`         | W7, W9, W3                                               | todo                                 |         |
| W11  | Rail, Layers column, title bar breadcrumb                                       | 2    | `feat/shell-rail`          | G1, W2, W6                                               | todo                                 |         |
| W12  | Responsive bands; spike removed                                                 | 2    | `feat/responsive-bands`    | W7, W11                                                  | todo                                 |         |
| W13  | Layout presets per project type                                                 | 2    | `feat/layout-presets`      | W8, W9, W10, W12                                         | todo                                 |         |
| W14  | Decision walls: Changes split button, Issues filters, road chips, menu submenus | 2    | `feat/decision-walls`      | W0                                                       | todo                                 |         |
| W15a | Shell dialogs and menus onto `Dialog` and `Menu`                                | 3    | `refactor/shell-dialogs`   | W3, W11, W12                                             | todo                                 |         |
| W15b | Feature dialogs onto `Dialog` (incl. PictureProgress focus trap)                | 3    | `refactor/feature-dialogs` | W3                                                       | todo                                 |         |
| W16  | Toasts onto the toast host                                                      | 3    | `refactor/toasts`          | W3, W6                                                   | todo                                 |         |
| W17  | Feature menus onto `Menu`                                                       | 3    | `refactor/feature-menus`   | W3, W2                                                   | todo                                 |         |
| W18  | Token ratchet and anti-patterns                                                 | 3    | `chore/token-ratchet`      | W1a, W12, W15a, W16, W17                                 | todo                                 |         |
| W19  | Accessibility fixes                                                             | 3    | `fix/ui-a11y`              | W8, W14                                                  | todo                                 |         |
| W20  | Naming glossary and copy sweep                                                  | 3    | `docs/ui-glossary`         | W13 (all string work landed)                             | todo                                 |         |
| W21  | Lazy-mount the always-mounted overlays in `App.tsx`                             | 3    | `perf/lazy-overlays`       | W12; heap-snapshot evidence from the engineering session | todo                                 |         |

Each workstream is one branch of a few days at most, cut with `node tools/agent/start-task.mjs <name> --type <type>` and rebased at once onto the **local** `main` while a batch is open. It ends with `pnpm check`, its e2e specs the CI way, `/wrapup`, `node tools/agent/finish-task.mjs` and a hand-over to the merge coordinator (CLAUDE.md). Out of scope here, owned by the engineering session: minification and moving three.js and pdfjs out of the entry chunk (`electron.vite.config.ts`).

## Follow-ups found in Batch A

- Compare at 1100 px still clips the resting island (`island.css` `--isl-aside-w`): W1d or W7.
- Faint grid shows when there is no map pack: W1d or a polish pass.
- Corridor rotation of the map is not done (map rotation is disabled, so north-up stays).
- The new Settings pages have no guide shots yet.
- The agent panel's accessible name is still "Agent" (about 10 e2e specs locate it by name): rename once in W20.
- W2's "project off" state opens Privacy and cloud until W6's Project settings is wired to it.
- Can start without G1: W1d, W14, W15b, W16, W17. W7 onward waits for G1.

## Global Constraints

- TypeScript strict, no `any`, no non-null assertions; the renderer never imports `electron` or `node:*`.
- No `@aio/schema` change is planned. A workstream that finds it needs one stops, adds a row to `docs/architecture/contract-changes.md` (`| Date | Change | Why | Streams affected | Approved by |`) and tells the coordinator before building on it.
- Strings: after W0, new keys go in the area module of their prefix (`packages/ui/src/i18n/en/<area>.ts`), never in `en.ts` itself. Each workstream's key prefixes are listed in its block; keys under another workstream's prefix are not added in the same batch. Plurals `_one`/`_other`, `{name}` placeholders, no em or en dashes, no `title=` tooltips.
- CSS: spacing, radius, z-index, shadow and colour from tokens (`--sp-*`, `--z-*`, `--el-*`); the CSS guard (`packages/ui/src/cssGuard.allow.json`) only shrinks. New CSS goes in a file owned by the workstream (named in its block). `R/styles.css` is edited by at most one branch per batch (named below). Migrations (W15 to W17) leave dead rules in `styles.css` for W18 to delete.
- No feature is gated by project type (D7). Any test that touches presets asserts reachability, not only defaults.
- Load the `impeccable` and `frontend-design` skills before a UI task; a new floating control is checked with `document.elementFromPoint` at 1100 x 700 (`small-window.spec.ts` pattern).
- e2e: specs in `apps/desktop/e2e/`, `--workers=1`, one Playwright run at a time, windows off-screen through the fixtures; run every changed spec the CI way: `pnpm demo:build --quick` (and `pnpm demo:change --quick`), then `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/<spec>.spec.ts --workers=1` from `apps/desktop`; the log must print `[e2e] window 1100 x 720 px at display scale 1`. In a worktree point `QUADRION_E2E_PYTHON` at the main checkout's venv.
- Button migration is a standing rule: a file touched for any other reason moves its raw `<button className="btn ...">` to `<Button>` / `<IconButton>` in the same commit.
- Public repo: no client, site or tester names; run `node tools/agent/check-public-text.mjs <files>` on every doc added or changed. Commits conventional, staged by path (never `git add -A`, never a bare `git stash`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A project with data its type does not expect.** Input: a survey project with video and a road; a road project with piles. Expected: the video docks, Tools lists the Road and Volumes groups, Project shows Road and Volumes sections, the palette finds every tool. Test: W13 `presets.test.ts` "reachable tools are the same for every preset" and `layout-presets.spec.ts` "survey project with video docks the tile".
2. **A saved layout that no longer fits the data.** Input: a project reopened after its only video was removed, with `quadrion.layout.<id>` saying footage strip and tile docked. Expected: Dates strip, no tile, no error, the saved choice kept for when video returns. Test: W13 `applyPreset` with stale overrides.
3. **Old localStorage and deep links.** Input: `quadrion.workbench` pins from today's build; `openSettingsPage('tools')` aimed at the Analytics pack. Expected: pins dropped once, the last front tab mapped to its new tab and section; the Settings call lands on the page that now holds the section. Tests: W7 `tabsModel.test.ts` "migrates old front tab", W6 `settingsPages.test.ts` "old page ids resolve".
4. **The smallest window with everything open.** Input: 1100 x 700, Split, compare dates, the video popped out, a tool armed. Expected: the island fits and stays centred, the pop-out never covers the island slot, pane headers ellipsise without clipping the date, clicks reach the view. Tests: W1d `layout-guards.spec.ts`, W9 `video-dock.spec.ts`, W12 `responsive-bands.spec.ts`.
5. **AI status under every source combination.** Input: cloud setting on but no key; offline only; project policy forbid; local model running with cloud off; key present but agent session disabled. Expected: the state table in D6, and never green unless a request would run. Test: W2 `aiStatus.test.ts` (one case per row plus the five combinations above).

---

## Execution DAG

```
W0 -> W1a, W1b, W1c -> W1d
W0 -> W2, W3, W5, W6, W14, W4
W3 -> W15b;  W3 + W6 -> W16;  W3 + W2 -> W17
W4 -> G1 (founder) -> W7, W9, W11 (W11 also needs W2, W6)
W7 + W5 -> W8;  W7 + W9 + W3 -> W10;  W7 + W11 -> W12
W8 + W9 + W10 + W12 -> W13 -> W20
W3 + W11 + W12 -> W15a;  W8 + W14 -> W19
W1a + W12 + W15a + W16 + W17 -> W18
W12 + engineering heap evidence -> W21
```

### Batches (no file shared inside a batch; dispatch each batch in one message)

| Batch | Starts when                                | Workstreams                       | Notes                                                                                                                                          |
| ----- | ------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | now                                        | W0                                | Lands first, alone; every later branch is cut after it. A few hours.                                                                           |
| A     | W0 on local `main`                         | W1a, W1b, W1c, W2, W3, W4, W5, W6 | Eight branches at once; the coordinator lands them in two merge batches (A1: W0, W1a, W1b, W1c, W3; A2: W2, W5, W6, W4). File ownership below. |
| B     | its own dependencies landed; G1 not needed | W1d, W14, W15b, W16, W17          | Runs while the founder reviews the spike.                                                                                                      |
| C     | G1 approved                                | W7, W9, W11                       | The three shell branches; see shared-spec rule below.                                                                                          |
| D     | Batch C dependencies                       | W8, W10, W12                      |                                                                                                                                                |
| E     | Batch D                                    | W13, W15a, W19                    |                                                                                                                                                |
| F     | Batch E                                    | W18, W20, W21                     | W21 also waits for the engineering session's heap evidence.                                                                                    |

**Critical path:** W0 → W4 → G1 (founder) → W7 → W8 → W13 → W20. A second near-critical path is W11 → W12 → W15a → W18. Founder review time at G1 is the biggest unknown; Batch B fills it.

### Batch A file ownership (verified disjoint)

| Workstream | Files it may edit (R = `apps/desktop/src/renderer`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | String prefixes                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| W1a        | `R/shell/SidebarTop.tsx`, `R/shell/CreateMapsButton.tsx` (deleted), `R/styles.css` (the only Batch A owner), `R/workspace/CompareControls.tsx`, `R/workspace/SplitPanes.tsx`, `R/workspace/LayerPlaceholder.tsx`, `R/processing/DrawerList.tsx`, `R/photogrammetry/PhotoRuns.tsx`, `R/screens/Projects.tsx`, `R/screens/Welcome.tsx`, `R/screens/FirstStart.tsx`, `R/package.css`, `R/inspect/ReviewQueue.tsx`, `R/detections/detections.css`; e2e `ui-polish-shell.spec.ts` (new), `library.spec.ts`, `first-start.spec.ts`, `compare.spec.ts`, `processing-drawer.spec.ts` | `library.*`, `processing.*`, `compare.*`, `det.*`                                                                                |
| W1b        | `packages/ui/src/Tip.tsx`, `packages/ui/src/mission.css`, `packages/ui/src/parts/tabs.css`, `packages/ui/src/timeline/parts.tsx`, `R/workspace/island/IslandTools.tsx`, `R/workspace/island/Island.tsx`, `R/workspace/pileFigures.ts`, `packages/engine/src/overlay/Overlay.ts` (label clamp, if the labels are drawn there), the volume chart tooltip in `R/charts/` (anchoring); e2e `ui-polish-stage.spec.ts` (new), `island.spec.ts`                                                                                                                                     | none expected                                                                                                                    |
| W1c        | `packages/maps/src/vector.ts`, `packages/maps/src/controller.ts`, `R/workspace/siteBasemap.ts`, `packages/globe/src/view/pins.ts`, `packages/globe/src/chips.ts`, `packages/globe/src/view/controller.ts`, `packages/globe/src/view/aura.ts`, `R/globe/GlobeScreen.tsx`, `R/globe/globe.css`, `R/globe/globe-map-menu.css`, `R/globe/globe-search.css`; e2e `globe.spec.ts`, `basemap-picker.spec.ts`, `ui-polish-maps.spec.ts` (new)                                                                                                                                        | `globe.*`, `maps.*`, `stage.streetMap.*`                                                                                         |
| W2         | `R/shell/aiStatus.ts` (new), `R/shell/AiStatusChip.tsx` (new), `R/shell/aiStatus.css` (new), `R/shell/ConnectionStatus.tsx`, `R/shell/connection.ts`, `R/shell/SidebarStatus.tsx`, `R/agent/AgentPane.tsx`, `R/agent/AgentToggle.tsx`, `R/inspect/askAi/AskAiBar.tsx`; e2e `agent-pane.spec.ts`, `offline-cloud-ai.spec.ts`, `ai-status.spec.ts` (new)                                                                                                                                                                                                                       | `titlebar.cloud*`, `connection.*`, `agent.*`, `askAi.button`, `askAi.settings.title`, `island.tile.askAgent`, `aiStatus.*` (new) |
| W3         | `packages/ui/src/Dialog.tsx` (new), `packages/ui/src/toast/*` (new), `packages/ui/src/Menu.tsx`, `packages/ui/src/focus.ts` (only if `useFocusTrap` needs a return-focus option), `packages/ui/src/parts/dialog.css` (new), `packages/ui/src/parts/toast.css` (new), `packages/ui/src/index.ts`                                                                                                                                                                                                                                                                              | `dialog.*`, `toast.*` (new)                                                                                                      |
| W4         | `R/layoutSpike/*` (new folder), `R/App.tsx` (one conditional mount), `R/shell/Sidebar.tsx` (export `Datasets` only)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `layoutSpike.*` (new)                                                                                                            |
| W5         | `R/shell/Palette.tsx`, `R/shell/paletteIndex.ts` (new), `packages/ui/src/palette/CommandPalette.tsx`, `packages/ui/src/palette/rank.ts`; e2e `palette-tools.spec.ts` (new)                                                                                                                                                                                                                                                                                                                                                                                                   | `palette.*`                                                                                                                      |
| W6         | `R/screens/Settings.tsx`, `R/store.ts` (Settings types and `FOCUS_PAGE` only), `R/screens/settings/settingsPages.ts` (new), `R/screens/settings/ModelsDetection.tsx` (new), `Datums.tsx` (new), `ProjectSettings.tsx` (new), `ProcessingTools.tsx`, `ProcessingEngine.tsx`, `processingEngine.css`, `MapPacks.tsx`, `ProjectPrivacy.tsx`, `Keyboard.tsx`; e2e `processing-tools.spec.ts`, `analytics-settings.spec.ts`, `project-maps.spec.ts`, `settings-pages.spec.ts` (new)                                                                                               | `settings.*`, `keys.search*`                                                                                                     |

W2 and W6 both edit Settings-adjacent text, but different prefixes (`agent.*`, `askAi.*` against `settings.*`), so after W0 they sit in different area modules. W4 does not touch any island, workbench, stage or store file: the spike composes existing components by import. W5 reads `survey/measureCatalogue.ts`, `island/islandBench.ts`, `workbench/tabsModel.ts` and `shortcuts.ts` without editing them.

### Later batches: shared files

- **Batch B:** W14 owns `R/change/ChangesTab.tsx`, `packages/annotate/src/components/IssueRegister.tsx`, the road defect filter under `R/road/`, `packages/ui/src/actions/ContextMenu.tsx`, `R/shell/actions/*Actions.tsx`. W15b, W16 and W17 own the call-site files listed in their blocks; those lists are disjoint (checked: `lineup/LineUpDialog` in W15b, `lineup/LineUpNotice` and `LineUpOffer` in W16; `team/Modal` in W15b, `team/SyncNotices` in W16; `builder/*Notice` in W16, `builder/*Menu` and `PlaceModel` in W17). None edits `styles.css`.
- **Batch C:** W7 owns `R/workspace/workbench/*`, `R/workspace/island/islandBench.ts`, `R/shell/RightHeader.tsx`; W9 owns `R/workspace/FloatingVideo.tsx`, `videoWindow.ts`, `R/workspace/video/*` (new), `R/workspace/Stage.tsx`, `R/workspace/WorkspaceScreen.tsx`, `BottomSwitch.tsx`, `timelinePref.ts`; W11 owns `R/App.tsx`, `R/shell/Sidebar.tsx`, `SidebarTop.tsx`, `TitleBar.tsx` (new), `autoFold.ts`, `SidebarStatus.tsx`, `R/store.ts`, `R/styles.css`. **Shared specs:** W7 owns `small-window.spec.ts`, `workbench.spec.ts`, `panels.spec.ts`, `bench-scroll.spec.ts`, `drawer.spec.ts` and every spec that opens a workbench tab by name; W9 owns `stage-overlays.spec.ts`, `video-proxy.spec.ts` and the other specs that open the video window (grep `vwin` in `e2e/`); W11 owns `shell.spec.ts`, `sidebar-autofold.spec.ts`, `video-first.spec.ts`. A branch that breaks a spec owned by another branch in its batch lands after that branch and fixes the spec in its rebase.
- **Batch D:** W8 owns `R/workspace/island/*` (except `islandBench.ts` already moved by W7), `R/survey/measureCatalogue.ts`, `R/tools/*` (new), `R/workspace/workbench/tabs/ToolsTab.tsx`, `R/workspace/workbench/benches/MeasureBench.tsx`, `R/shell/paletteIndex.ts`; W10 owns `R/workspace/Stage.tsx`, `overlaySlots.ts`, `StageHint.tsx`, `StageShow.tsx`, `packages/ui/src/parts/toast.css`; W12 owns `R/App.tsx`, `R/workspace/workbench/RightSidebar.tsx`, `R/shell/layoutBands.ts` (new), `R/styles.css`, `R/layoutSpike/*` (deleted).
- **Batch E:** W13 owns `R/layout/*` (new), `R/workspace/WorkspaceScreen.tsx`, `R/workspace/workbench/tabs/LayersDisplayTab.tsx`, `R/shell/paletteIndex.ts`; W15a owns the shell and screens dialog and menu files; W19 owns `R/workspace/island/Island.tsx`, `R/survey/volumes/InventoryPane.tsx`, `packages/annotate/src/components/IssueRegister.tsx`.
- **Batch F:** W18 owns every `.css` file and `cssGuard.*`; W20 owns `packages/ui/src/i18n/en/*` value edits and `docs/design/glossary.md`; W21 owns `R/App.tsx`. W18 and W21 are disjoint (W21 touches no CSS).

### Strings after W0 (how `en.ts` stops conflicting)

`en.ts` (6,824 lines, 371 commits since 30 Sep) is the top conflict hotspot. W0 splits it once, mechanically: every key moves unchanged into an area module under `packages/ui/src/i18n/en/`, and `en.ts` becomes imports plus one spread object. The existing `enAsk*.ts` modules move into the same folder. Rules from then on:

- A new key goes into the module of its prefix; a workstream with a new prefix creates its own module and adds one import and one spread line to `en.ts` (the only `en.ts` edit allowed; one line each, rebase conflicts there are trivial: keep both lines).
- An existing value is edited in its area module only by the workstream that lists that prefix.
- Rebase onto local `main` each time the coordinator announces that `main` moved.

---

## W0: split `en.ts` into area modules

**Files:** Modify `packages/ui/src/i18n/en.ts`; create `packages/ui/src/i18n/en/*.ts` (about 25 modules, grouped by top-level prefix: e.g. `shell.ts` for `titlebar`, `nav`, `connection`, `status`; `agent.ts`; `askAi*.ts` (the moved `enAsk*`); `settings.ts` for `settings`, `identity`, `classes`, `graphics`, `mapSources`; `keys.ts`; `island.ts`; `workbench.ts` for `wb`, `bench`, `measureBench`, `measureCat`, `section`, `tabs`, `panel`; `stage.ts` for `stage`, `show`, `strip`, `timeline`, `timelapse`, `datebar`, `split`, `hover`; `survey.ts` for `vol`, `mcard`, `pile`, `cutfill`, `materials`, `chart`, `surface`, `base`, `stockpiles`, `volumes`; `library.ts` for `library`, `project`, `package`, `remove`, `trash`, `gate`; `processing.ts` for `processing`, `jobs`, `engine`, `builder`, `align`, `calibrate`, `photo`, `drop`; `globe.ts` and `maps.ts` (`maps`, `mapMenu`); `palette.ts`; `rf.ts`; `telecom.ts`; `house.ts`; `vreport.ts`; `eng.ts`; `review.ts`; `audit.ts`; `change.ts` (`change`, `compare`, `imgChange`, `cloudChange`); `road.ts`; `team.ts`; `common.ts` for the rest). Test: `packages/ui/src/i18n/i18n.test.ts`, `packages/ui/src/i18n/split.test.ts` (new).

**Produces:** `export const en` with the same keys and values as before; the `./i18n/en` export in `packages/ui/package.json` unchanged; the `CatalogueKey` type unchanged. A comment block at the top of `en.ts` lists prefix to module.

- [ ] Step 1: before moving anything, snapshot the catalogue: a script in the scratchpad writes `Object.entries(en)` sorted to a JSON file outside the repo.
- [ ] Step 2: test `split.test.ts`: "every prefix lives in exactly one module" (no key prefix appears in two modules) and "no module redefines a key" (the spread has no duplicate keys: sum of module key counts equals `Object.keys(en).length`). Run `pnpm vitest run packages/ui/src/i18n`; expect FAIL (no `en/` folder).
- [ ] Step 3: move keys with a script (not by hand), keep their order inside each module; `en.ts` spreads the modules.
- [ ] Step 4: compare `Object.entries(en)` sorted with the snapshot: identical. Run `pnpm vitest run packages/ui/src/i18n` and `pnpm typecheck`; expect PASS.
- [ ] Step 5: commit `chore(i18n): split en.ts into area modules with no key changes`. Hand over at once; the coordinator lands it before any Batch A branch.

## W1a: polish, shell, library, compare, processing

Defects (review checklist numbers): 1 switcher names, 4 compare at 1100 px, 7 "Class" and "Severity" truncation, plus "Create maps from photos" placement (D10), "Delete run", the welcome card.

- [ ] Switcher: `styles.css:796-805` `.proj-menu .pm-n { flex: 1 1 auto; min-width: 0 }`, `.proj-menu .mono { flex: none; max-width: 45% }` with ellipsis. Test (e2e, `ui-polish-shell.spec.ts`): "switcher menu shows full demo project names" (each `.pm-n` has `scrollWidth <= clientWidth` at 1100 x 720).
- [ ] Compare at 1100 px: `.pane-date` gets `min-width: 0` and ellipsis (`styles.css:2068-2100`), the pane header keeps the date and drops the mode text first (`SplitPanes.tsx:206-216`); `CompareControls.tsx:116-160` wraps its "how" row below 1280 px. Test: "compare at 1100 x 700 keeps both pane dates readable" (header text not "3…"; both `.pane-date` fully in view).
- [ ] "Class" and "Severity" selects: `.ann-select { width: 100%; min-width: 0 }` in `detections.css`, label above the select in `ReviewQueue.tsx:511-540`. Test: "custom request selects show their full placeholder" at 1100 x 720.
- [ ] Create maps: delete `CreateMapsButton.tsx` and its mount (`SidebarTop.tsx:170`); `DrawerList.tsx:83-91` button becomes the drawer's primary (`btn primary`); `ProjectCard` (`Projects.tsx:90`) shows "Create maps from photos" when the library entry has photos and no maps (if the library entry does not carry layer kinds, the action goes in the card menu only: no IPC change); `LayerPlaceholder.tsx` offers it for a photo-only project. Tests: `processing-drawer.spec.ts` "Create maps is the drawer's primary action"; `ui-polish-shell.spec.ts` "sidebar has no Create maps button", "photo-only demo scene offers Create maps".
- [ ] "Delete run": `PhotoRuns.tsx:208-254` keeps one "Delete work files" and moves "Delete run" into a `···` menu with a confirm. Test: e2e "Delete run asks before deleting" in `ui-polish-shell.spec.ts`.
- [ ] Welcome card: `FirstStart.tsx` / `Projects.tsx:573` collapse to a one-line "Workstation setup {done} of {total}" strip once a project exists; `Welcome.tsx` stacks to one column under 1100 px (`package.css:215-221`). Tests: vitest `FirstStart.test.tsx` "collapses to the setup strip when a project exists"; `first-start.spec.ts` updated.
- [ ] Commit per fix (`fix(shell): ...`, `fix(library): ...`), then the hand-over.

## W1b: polish, stage, timeline, tooltips, island

Defects 7 (footage clock, "Cut & fill", tooltip), 8 pile labels, 9 sticky tooltips, 12 island label; the volume chart tooltip over the newest point.

- [ ] Sticky tooltips: `Tip.tsx:145-160` hides on `pointerleave`, `pointerdown` and `blur`; the CSS `.tool:hover .tip` rule (`mission.css:340-341`) shows only while hovered or `:focus-visible`, and `HideButton` (`timeline/parts.tsx:350-359`) drops the tip on click. Test: vitest `Tip.test.tsx` "hides on pointer down and on pointer leave"; e2e `ui-polish-stage.spec.ts` "timeline collapse tip is gone after the click".
- [ ] Footage clock: `.tc` min-width fits `00:00:00.0` in Plex Mono (`mission.css:398-403`; use `ch` units). Test: e2e "footage clock is not truncated at 1100 x 720".
- [ ] "Cut & fill": `.seg button { white-space: nowrap }` (`parts/tabs.css:8-19`). Test: e2e "Show control buttons are one line".
- [ ] Island label: the label follows the previewed group (`IslandTools.tsx:118,167`, `Island.tsx:154`). Test: `island.spec.ts` "previewing Annotate names Annotate".
- [ ] Pile labels: find where pile and measurement labels are placed (start with `R/workspace/pileFigures.ts` and `packages/engine/src/overlay/Overlay.ts`), clamp each to the stage or pane rectangle, edge dot when the anchor is off-stage. Test: vitest for the pure clamp, `clampLabel(rect: Rect, at: Point, size: Size): { at: Point; edge: boolean }`, "inside stays, outside snaps to the edge and flags it"; e2e "pile labels stay inside the pane in Split".
- [ ] Volume chart tooltip anchors above the playhead and flips left of the newest point. Test: vitest in the chart's test file, "tooltip never covers the last point".

## W1c: polish, maps and Globe

Defects 2 Globe cluster dot, 6 map labels and first fit, plus the "No map pack" notice once per session, a faint 100 m grid without a pack, the Globe starfield, glow and blur.

- [ ] Fit to data: `packages/maps/src/controller.ts:1413-1441` fits the union of project layer extents with 8 % padding; corridors (aspect over 4:1) rotate the bearing so the long axis is horizontal. Test: vitest `fitView.test.ts` (new, pure `fitFor(extents: Bbox[], view: Size): { center, zoom, bearing }`): "pads by 8 %", "rotates a north-south corridor".
- [ ] Labels: `vector.ts:100-109` adds `text-padding` and `symbol-spacing`, `text-allow-overlap: false`. Test: e2e `ui-polish-maps.spec.ts` "change demo map labels do not overlap" (query rendered features' boxes).
- [ ] Notice and grid: `siteBasemap.ts:254` shows the notice once per session (session flag), the map draws a 100 m grid layer when no pack is installed. Tests: vitest "notice shows once per session"; `basemap-picker.spec.ts` updated.
- [ ] Globe cluster chip: a no-dot layout for cluster chips (`chips.ts` `chipMetrics`, `pins.ts:198-256`, globe `controller.ts:1128-1137`). Test: vitest `chips.test.ts` "cluster chip label starts after the dot".
- [ ] Globe decoration: remove the starfield and the glowing rim (`aura.ts`: hairline limb only) and the `backdrop-filter` blur (`globe.css:37`, `globe-map-menu.css:10,15`, `globe-search.css:13`). Test: `globe.spec.ts` still green; CSS guard count for blur lower.

## W1d: layout guards

**Files:** create `apps/desktop/e2e/layout-guards.spec.ts`, `apps/desktop/e2e/layoutGuards.ts` (helper `expectNoClippedText(page, selectors)`).

- [ ] Two describes, `test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720' } })` and `'1366x768'`: scene default, compare dates, footage strip, project switcher, Settings > Processing tools and Keyboard. Each asserts no listed element has `scrollWidth > clientWidth + 1` and that the island's box lies inside the stage. No pixel snapshots (WARP renders differ).
- [ ] Run the CI way at both sizes, `--repeat-each=3`.

## W2: one truthful AI status and one AI name

**Interfaces (produces):**

- `type AiState = 'ready' | 'local' | 'no-key' | 'offline' | 'project-off'`.
- `aiStatus(input: { settings: Settings; agent: AgentAvailability; askBackend: AskBackend | null; projectPolicy: AiPolicy | undefined; localModel: 'running' | 'stopped' | 'absent' }): { state: AiState; fix: SettingsTarget | null }` in `R/shell/aiStatus.ts`; `useAiStatus()` hook reading the three sources.
- `<AiStatusChip />` (`R/shell/AiStatusChip.tsx`), mounted in `SidebarStatus.tsx` in place of the Cloud AI chip; W11 moves it to the title bar.

- [ ] Test `aiStatus.test.ts`: one case per D6 row, plus "cloud on, no key is no-key, not ready", "project forbid beats a key", "local model running with cloud off is local", "offline only beats a key". Run, FAIL; implement; PASS.
- [ ] `ConnectionStatus.tsx` drops `CloudChip`; `AgentPane.tsx:221-231` footer and `AskAiBar.tsx:508` read `useAiStatus()` and offer the same fix link.
- [ ] Names: "Ask AI" for `agent.dock.name`, `agent.dock.label`, `island.tile.askAgent`; `askAi.settings.title` becomes "Ask AI"; `titlebar.cloud*` and `connection.cloud` texts say "AI" states from D6. Test: vitest `aiNames.test.ts` "no UI string says Agent, Ask agent or AI for Ask AI" over the `agent`, `askAi*`, `island`, `shell` modules.
- [ ] e2e `ai-status.spec.ts` (new): no key shows amber "AI off: no key" and its click opens AI providers; `offline-cloud-ai.spec.ts` and `agent-pane.spec.ts` updated for the new names.

## W3: `@aio/ui` primitives, no call sites

**Interfaces (produces):**

- `<Dialog open onClose title describedBy? size?: 'sm' | 'md' | 'lg' initialFocus? children footer? />`: portal, one scrim, `role="dialog"`, `aria-modal`, `useFocusTrap`, Escape and scrim click call `onClose` (scrim click off when `dismissable={false}`), focus returns to the opener.
- `toast(message: string, opts?: { tone?: 'info' | 'ok' | 'warn' | 'error'; action?: { label: string; run: () => void }; id?: string; ttlMs?: number }): string`, `dismissToast(id: string)`, `<ToastHost placement="stage" | "window" />`: one queue, one visible toast per host, `role="status"` (`alert` for error), a toast with the same `id` replaces the earlier one.
- `Menu`: roving focus, typeahead, Home/End, submenus (`items: MenuItem[]` with `children?: MenuItem[]`), `aria-haspopup`.

- [ ] Tests (vitest, jsdom): `Dialog.test.tsx` "traps focus", "Escape closes", "returns focus to the opener", "labelled by its title"; `toast.test.tsx` "one visible, rest queued", "same id replaces", "error uses role alert"; `Menu.test.tsx` "arrow keys rove", "typeahead jumps", "right arrow opens a submenu, left closes it".
- [ ] Export from `packages/ui/src/index.ts`. No renderer file changes.

## W4: Wave 2 layout spike (gate G1)

**Goal:** the founder sees the D1 layout in the real app on the demo projects, at the three bands, and approves or redirects it.

**Files:** `R/layoutSpike/flag.ts` (reads `localStorage['quadrion.flags.layoutV2']`; Ctrl+Alt+L toggles it and reloads the window; works in `pnpm dev` and packaged builds), `R/layoutSpike/SpikeShell.tsx`, `SpikeRail.tsx`, `SpikeTitleBar.tsx`, `SpikeRightPanel.tsx`, `SpikeBottomStrip.tsx`, `spike.css`; `R/App.tsx` (render `SpikeShell` for the Scene screen when the flag is on); `R/shell/Sidebar.tsx` (export `Datasets`).

- [ ] The spike composes existing components by import (Stage, `Datasets`, the bench components, `IssueRegister` summary stub, `DatesStrip`, a video tile made from `FloatingVideo`'s player) into: rail, title bar, Layers column, four right tabs with the D2 sections, a bottom strip with the docked tile and a pop-out, the island modes row (static), the overlay slots. A preset picker in the title bar switches the seven D7 presets so the founder can see each.
- [ ] Behaviour may be shallow (no persistence, tools start through their existing functions), but sizes are real at 1440, 1280 and 1100 widths.
- [ ] Tests: vitest `flag.test.ts` "off by default, on with the key"; e2e `layout-spike.spec.ts` (new) "flag off renders today's shell", "flag on renders four tabs and the rail at 1100 x 720".
- [ ] Hand-over: screenshots at the three bands for each of survey, road and the change demo, plus "How to test" (press Ctrl+Alt+L on Scene). The founder approves, or lists changes that go back into this design before W7.

## W5: palette indexes tools, tabs, modes and Settings

**Interfaces (produces):** `paletteIndex(ctx: { tabs: readonly TabId[]; groups: readonly GroupId[]; tools: readonly CatalogueTool[]; shortcuts: readonly Shortcut[]; settingsPages: readonly { id: string; label: string }[] }): PaletteCommand[]` in `R/shell/paletteIndex.ts`, with `keywords` and `shortcut` per command; W8 swaps its tool input for the registry.

- [ ] Test `paletteIndex.test.ts`: "measure finds Measure distance, Measure area and the Measure group", "each tool shows its shortcut", "a tool not available says why and stays listed", "Settings pages are listed".
- [ ] `CommandPalette.tsx` shows the shortcut on the right of a row; `rank.ts` ranks keywords below the label. Test: `rank.test.ts` "label match beats keyword match".
- [ ] e2e `palette-tools.spec.ts`: Ctrl+K, type "measure", Enter starts Measure distance on the demo tank farm and the tool card shows.

## W6: Settings by topic

**Interfaces (produces):** `SETTINGS_PAGES` (`R/screens/settings/settingsPages.ts`): `{ id, group: 'intelligence' | 'data' | 'app' | 'project', labelKey, icon }[]` per D9; `resolveSettingsTarget(pageOrFocus: string): { page: SettingsPage; focus?: SettingsFocus }` that maps old ids to new pages.

- [ ] Test `settingsPages.test.ts`: "every page has a distinct icon", "old `tools` with focus `analytics-pack` resolves to Models and detection", "old `maps` with focus `geoid` resolves to Datums", "`project` group only with a project open".
- [ ] Move sections: `DetectionModels` (from the AI page), `DetectorLibrary` and `AnalyticsPack` (`ProcessingTools.tsx:342-343`) into `ModelsDetection.tsx`; `GeoidPacks` (`MapPacks.tsx:616`) into `Datums.tsx`; `ProjectMaps` (`MapPacks.tsx:420`) and `ProjectPrivacy` into `ProjectSettings.tsx`; `AskAiSettings` into the AI providers page; the "Providers ... supported" heading through i18n (`Settings.tsx:901-902`).
- [ ] Processing tools: the "Prepare surfaces when a project opens" row moves inside `section.processing-engine` with its toggle at the right (`ProcessingEngine.tsx:406`, `processingEngine.css:51-75`); Keyboard search input fills its row (`Keyboard.tsx:56-62`).
- [ ] e2e: `settings-pages.spec.ts` (new) walks every page at 1100 x 720 and checks headings; `analytics-settings.spec.ts`, `processing-tools.spec.ts`, `project-maps.spec.ts` follow their sections.

## W7: right panel, four fixed tabs (after G1)

**Interfaces (produces):** `type PanelTab = 'selection' | 'tools' | 'layers' | 'project'`; `type SectionId` (every D2 home, e.g. `'project.volumes'`, `'tools.measure'`, `'layers.show'`); `sectionFor(oldTab: TabId): { tab: PanelTab; section: SectionId }` (the D2 table, pure); workbench store actions `show(tab: PanelTab, section?: SectionId)`, `expand(on: boolean)`; one width per band via `splitPrefs`; tab components `tabs/SelectionTab.tsx`, `tabs/ToolsTab.tsx` (renders today's catalogue until W8), `tabs/LayersDisplayTab.tsx`, `tabs/ProjectTab.tsx`, `project/IssuesSummary.tsx`.

- [ ] Tests: `tabsModel.test.ts` "every one of the 20 old ids maps to a tab and section", "migrates the old front tab once and drops pins", "opening a section never changes the width"; `IssuesSummary.test.tsx` "five most severe open issues, counts by severity".
- [ ] Remove `WIDE_TAB_PX`, `isWide`, pin and close; `TabBar.tsx` renders four fixed tabs without overflow; `RightHeader.tsx` Agent and Share as icon buttons; `MeasureBench.tsx` splits (`ProjectList` to `ProjectTab`).
- [ ] e2e: helper `e2e/panel.ts` `openSection(page, tab, section)`; update every spec that clicks a workbench tab by name (`workbench`, `small-window`, `panels`, `bench-scroll`, `drawer`, `stage-display`, `measure-tools`, `project-list-*`, `pile-panel`, `rf-*`, `survey-qa`, `hydro`, `designs`, `haul`, `a11y`, `compliance`, `thermal-bench`) to the helper; new `right-panel.spec.ts` "four tabs, no overflow, width unchanged across tabs at 1100 x 720".

## W8: one tool registry

**Interfaces (produces):** `ToolDef { id: string; group: ToolGroup; labelKey: MessageKey; icon: IconName; shortcutId?: string; available(ctx: ToolCtx): true | { reason: MessageKey }; start(ctx: ToolCtx): void }`, `TOOL_GROUPS: readonly ToolGroup[]` (D3 order), `toolsFor(ctx, order?: readonly ToolGroup[]): { group: ToolGroup; tools: ToolDef[] }[]` in `R/tools/registry.ts`.

- [ ] Tests `registry.test.ts`: "every catalogue tool and island quick-row tool is registered once", "availability depends on data, never on purpose" (same data, every purpose, same result), "order puts preset groups first and keeps the rest".
- [ ] `ToolsTab.tsx` renders `toolsFor`; armed state shows `LiveCard` and "Back to tools"; the `Strip` chip list and island "All tools" go; island opens on click, shows labelled modes and the group's top 4 or 5 tools; `paletteIndex.ts` takes tools from the registry.
- [ ] e2e: `island.spec.ts` (hover-open tests become click-open), `measure-tools.spec.ts`, `palette-tools.spec.ts`; new `tools-tab.spec.ts` "Escape returns from the tool card to the list".

## W9: video docked tile and pop-out

**Interfaces (produces):** `useVideoDock()` store in `R/workspace/video/videoDockStore.ts`: `{ mode: 'docked' | 'floating' | 'closed'; rect: Rect | null; popOut(); popIn(); close(); reopen() }`, per project; `<VideoTile />` in the bottom strip; the floating window from `FloatingVideo.tsx` with resize handles.

- [ ] Tests `videoDockStore.test.ts`: "no video means closed and no tile", "pop out then pop in returns to docked", "floating rect is clamped to 320 x 180 up to 80 % of the stage", "a closed tile stays closed on reopen of the project until the user reopens it".
- [ ] e2e `video-dock.spec.ts` (new): demo tank farm opens with the tile docked in the bottom strip and nothing over the stage (elementFromPoint at the stage centre reaches the canvas); pop out, drag, resize, pop in; at 1100 x 700 the floating window never covers the island. `stage-overlays.spec.ts`, `video-proxy.spec.ts` and the other specs that open the video window (grep `vwin` in `e2e/`) updated.

## W10: fixed stage overlay slots

- [ ] `overlaySlots.ts` defines exactly the D5 slots; `Stage.tsx` places every overlay through it; `StageShow` leaves the stage (it lives in Layers & display since W7); `<ToastHost placement="stage" />` in the bottom-left slot shares it with hints (one at a time); job progress goes to the Jobs chip.
- [ ] Tests: `overlaySlots.test.ts` "only five slots", "hint and toast share bottom-left, newest wins"; e2e `stage-overlays.spec.ts` "nothing in the top-left at open", "the island slot holds only the island".

## W11: rail, Layers column, title bar

- [ ] `App.tsx` grid: rail, title bar row, Layers column (Scene only), main, right panel; `Sidebar.tsx` splits into `Rail.tsx` and `LayersColumn.tsx` (the `Datasets` tree); `SidebarTop.tsx` becomes `TitleBar.tsx` with the breadcrumb, Ctrl+K, `AiStatusChip`, the Jobs chip; the project menu gets Project settings (W6) and Audit trail; Ctrl+L toggles Layers.
- [ ] Tests: vitest `TitleBar.test.tsx` "breadcrumb shows the full project name and customer"; e2e `shell.spec.ts`, `sidebar-autofold.spec.ts` (now Layers), `video-first.spec.ts`; new `shell-layout.spec.ts` "rail always present", "Ctrl+L toggles Layers", "title bar clears the window buttons".

## W12: responsive bands; spike removed

**Interfaces (produces):** `bandOf(width: number): 'wide' | 'mid' | 'narrow'`, `bandDefaults(band): { layersOpen: boolean; layersOverlay: boolean; rightPx: number; rightMin: number; rightMax: number; stripPx: number }` (D1 table) in `R/shell/layoutBands.ts`; replaces `autoFold.ts`.

- [ ] Tests `layoutBands.test.ts`: the D1 table row by row; "a hand-set width survives a band change back and forth".
- [ ] e2e `responsive-bands.spec.ts` (new): at 1100 x 720 the stage is at least 60 % of the window with Layers closed, Layers opens as an overlay and Escape closes it; at 1440 x 900 Layers is open.
- [ ] Delete `R/layoutSpike/` and its spec.

## W13: layout presets per project type

**Interfaces (produces):** `type Preset = { rightTab: PanelTab; projectSections: SectionId[]; strip: 'dates' | 'footage' | 'volume' | 'chainage'; islandMode: IslandMode; stage: '3d' | 'map'; layersOpenWide: boolean; toolOrder: ToolGroup[] }`; `PRESETS: Record<ProjectPurpose, Preset>`; `presetFor(manifest): Preset` (purpose, else `ProjectType` fallback, D7); `projectData(manifest, stores): ProjectData`; `applyPreset(preset, data, overrides): LayoutState` (pure: fallbacks, then user overrides that the data can honour); `useApplyPreset()` mounted in `WorkspaceScreen.tsx`; overrides in `localStorage['quadrion.layout.<projectId>']`; "Reset layout to project defaults" in the palette and at the foot of Layers & display.

- [ ] Tests `presets.test.ts`: "every purpose has a preset", "a project without purpose falls back by type", "reachable tools are the same for every preset" (for three data sets), "volume strip without piles falls back to dates", "footage without video falls back to dates", "stale overrides are ignored but kept", "adding the first video docks the tile and keeps the tab".
- [ ] e2e `layout-presets.spec.ts` (new): demo tank farm opens on Project > Volumes with the volume strip; demo road opens on chainage and Map; a survey project with video docks the tile; Reset layout restores the defaults.

## W14: decision walls

- [ ] `ChangesTab.tsx`: one "Find changes" split button with imagery, surface, point cloud, model and matched frames in its menu. Test: `change-core.spec.ts` updated; vitest for the menu items.
- [ ] `IssueRegister.tsx`: three filters plus "Filters (n)". Test: annotate vitest "Filters (n) counts the active hidden filters".
- [ ] Road defects: severity chips, type in a dropdown. Test: `road-builder.spec.ts` and the road defect specs updated.
- [ ] Layer context menu: "Position >" and "File under >" submenus through `ContextMenu.tsx`. Test: `sidebar-menus.spec.ts` updated.

## W15a and W15b: dialogs onto `Dialog`

- **W15b (feature dialogs, Batch B):** `audit/AuditScreen`, `diagnostics/ReportProblem`, `engineer/SetupDialog`, `lineup/LineUpDialog`, `panos/PanoImportDialog`, `processing/PipelineDialog`, `report/NarrativeEditor`, `report/volumetric/PictureProgress` (first: it has no focus trap or Escape today), `rf/AutoplanDialog`, `rf/CataloguePicker`, `rf/CsvImport`, `survey/SiteSettings`, `team/Modal`, and the `sv-dialog`, `b-scrim`, `surface-dlg` and native `<dialog>` variants outside `shell/` and `screens/`.
- **W15a (shell, Batch E):** `shell/ConfirmDialog`, `LayerProperties`, `PackageExport`, `RemoveHost`, `UnlockDialog`, `shell/actions/rereadActions`, `screens/CoverDialog`, `DeleteDialog`, `LibraryFolders`, `MoveToFolderDialog`, `ProjectMenu`, `settings/Classes`, `packages/ui/src/tree/RemoveDialog.tsx`; plus the shell menus onto `Menu` (`screens/LibraryFolders`, `screens/ProjectMenu`, the title bar project menu).
- Tests: each migrated dialog keeps its e2e; new `dialogs-a11y.spec.ts` (W15b) "PictureProgress closes on Escape and traps focus"; W15a adds the same check for ConfirmDialog and DeleteDialog.

## W16: toasts onto the host

Files: `builder/AlignNotice`, `AlignToNotice`, `DropNotice`, `EditPositionNotice`, `FarContentNotice`, `PhotoAlignNotice`, `DiskChangedNotice`, `exports/Toasts.tsx` (renders `<ToastHost placement="window" />`, so `App.tsx` is not edited), `GraphicsNotice`, `lineup/LineUpNotice`, `LineUpOffer`, `mapCoverage/ProjectMapNotice`, `placement/PlaceOnModelNotice`, `ProcessingToolsNotice`, `settings/AnalyticsPack`, `settings/ProcessingEngine`, `settings/ProcessingTools`, `survey/MeasureUndoNotice`, `team/SyncNotices`, `packages/volumetric` `VolumetricStage.tsx`. Test: vitest per notice where one exists; e2e `toasts.spec.ts` (new) "two notices show one at a time with role status".

## W17: feature menus onto `Menu`

Files: `builder/DroneMenu`, `PhotoMenu`, `PlaceModel`, `charts/SurfaceChips`, `detections/detectors/RejectReasonMenu`, `exports/ExportMenu`, `inspect/askAi/AskAiBar`, `pointcloud/CleanupHost`, `screens/Inspect`, `survey/card/BasePicker`, `packages/annotate` `IssueRowMenu.tsx`. Test: `a11y.spec.ts` gains "menus rove with arrow keys" for three of them.

## W18: token ratchet and anti-patterns

- [ ] `cssGuard.test.ts` gains metrics `spacingPx`, `radiusOffScale`, `outlineNone`, `transitionLayout`; the allow file is regenerated (`CSS_GUARD_WRITE=1`) and then lowered by the fixes below.
- [ ] Remove the side-stripe accents (`help.css:277`, `askAi.css:128,186`, `findingsPanel.css:46`, `package.css:247`, `road.css:148,351`, `styles.css:2623,4621`, `mission.css:1130`), width and padding transitions (`builder.css:440`, `askAi.css:213`, `package.css:192`, `styles.css:741,4174,4716`), dead rules left by W2 and W15 to W17 (`.conn-cloud`, `.dlg-scrim`, `.toast` copies), off-scale radii to tokens.
- [ ] Test: `pnpm vitest run packages/ui/src/cssGuard.test.ts` PASS with lower counts; `a11y.spec.ts` green.

## W19: accessibility fixes

- [ ] `IssueRegister.tsx:372` select toggle becomes a checkbox button; `Island.tsx:643` and `InventoryPane.tsx:274` clicks get buttons or `onKeyDown` with Enter and Space; the remaining `outline: none` rules get a `:focus-visible` style. Tests: annotate vitest "select toggle works with Space"; `a11y.spec.ts` axe run on Scene, Issues and Volumes.

## W20: naming glossary and copy sweep

- [ ] `docs/design/glossary.md`: one AI name, "point cloud" (never "cloud" for it), "online" for the network, the plain words for "Every date", "bench", "island", "File them / Not now", "EDL", "Triangulated toe".
- [ ] Value edits across `packages/ui/src/i18n/en/*`; test `glossary.test.ts` "no UI string uses a retired term" (list from the glossary).

## W21: lazy-mount the overlays in `App.tsx`

- [ ] Waits for the engineering session's heap snapshots on the red nightly `soak.spec.ts:113` (renderer heap +85 MB over 200 open cycles); proceed only if they point at the always-mounted overlays (Palette, ProcessingDrawer, Builder, Modeller, Engineer and Rf layers, HelpPanel and the rest of the about 25 in `App.tsx`).
- [ ] Each overlay mounts on open through `React.lazy` and `Suspense`, and unmounts on close where its state is not needed. Tests: vitest "overlay modules are not loaded until opened" (mock dynamic import); `soak.spec.ts` heap delta reported before and after; every overlay's own e2e still green.

---

## Contract changes

None planned. W0 changes no key. Presets, layout overrides, the spike flag and band widths are renderer code and localStorage. If the founder wants presets editable per project (stored in the manifest), that is a later additive `ProjectManifest` field with a row in `docs/architecture/contract-changes.md`.

## e2e specs

New: `ui-polish-shell`, `ui-polish-stage`, `ui-polish-maps`, `layout-guards`, `ai-status`, `palette-tools`, `settings-pages`, `layout-spike` (removed in W12), `right-panel`, `tools-tab`, `video-dock`, `shell-layout`, `responsive-bands`, `layout-presets`, `dialogs-a11y`, `toasts`. Changed: listed in each workstream. All run the CI way at 1100 x 720 (and the guards at 1366 x 768); `small-window.spec.ts` stays the 1100 x 700 gate.

## How to test (founder, per wave)

- **Wave 1:** open the demo tank farm at 1280 x 800: no "Create maps from photos" in the sidebar; the AI chip says "AI off: no key" in amber without a key and opens AI providers; Ctrl+K "measure" lists the measure tools with their keys and Enter starts one; the project switcher shows full names; Compare dates at a 1100 px window keeps both dates readable; the Globe shows "3 sites" clear of its dot and no starfield.
- **Spike (G1):** on Scene press Ctrl+Alt+L: rail, title bar, Layers column, four tabs, the docked video tile and the preset picker; resize the window to 1440, 1280 and 1100 px; press Ctrl+Alt+L again for today's shell.
- **Wave 2:** open each demo: it lands on its preset (tank farm on Volumes, road on chainage and Map); add a video to the survey demo and the tile docks; pop it out, move and resize it, pop it in; the right panel width stays put across tabs; Settings shows Models and detection, Datums and, with a project open, Project settings.
- **Wave 3:** every dialog closes on Escape and returns focus; two notices show one at a time; nothing visible changes otherwise.
