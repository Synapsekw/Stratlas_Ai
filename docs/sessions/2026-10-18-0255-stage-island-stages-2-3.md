---
type: session
date: 2026-10-18-0255
branch: feat/stage-island-s2
status: complete
related: [plans/2026-10-16-stage-island.md]
---

# Stage island stages 2 and 3

## What changed

- This PR (#173) lands stages 2 and 3 of the UI rework together: 113 commits on `769cd2ee`. The plan is `plans/2026-10-16-stage-island.md`, and rulings I-R1 to I-R64 are in its ledger.
- Stage 2:
  - **Workbench tabs** in the right sidebar: a bench of collapsible sections for each tool, one live bench at a time, pinned tabs, an overflow menu, and Collapse all, Expand all and search.
  - **The island opens benches.** It now has quick entries for point colour and Annotate.
  - **A live drawer** beside the stage while a tool runs, with a dark backing behind the window buttons when the sidebar is folded.
  - **A resizable agent pane** that can be maximised and minimised.
- Stage 3:
  - **Overlay slots**: the HUD, notices, volumes hint, dates, Map menu chip and floating video each take a stage corner and no longer overlap. Under 640 px the video docks at the bottom.
  - **Shared split handles.** In Split, Alt+Arrow steps the focused pane's date.
  - **Detect antennas** runs from its bench, and the Jobs bench lists RF coverage.
  - **User guide** pages are updated for the island, the tabs, the drawer and the agent pane.
- Final review: ready after fixes, 0 Critical and 4 Important, all four fixed:
  - the open island stays clear of the window buttons with the right panel folded;
  - a tool's live state comes from the live tabs, so it survives leaving the Scene;
  - with the sidebar folded, a click on the island opens the drawer only;
  - a playing clip and running jobs are live tabs.
- Tests: `pnpm check` 11804 passed. The full e2e the CI way (1100 x 720, warp) gave 472 passed, 0 failed. `e2e-timings.json` was re-recorded for all 163 specs.

## Why

The old stage toolbar had no room for the tools coming next (telecom, RF coverage, correction review). Stages 2 and 3 land as one PR (I-R25) because stage 3 overlays only make sense once the drawer and the tabs exist. Built task by task, each task reviewed, then one whole-branch review and one fix round.

## How to test

1. Open a project in the Scene. Click the island at the top of the stage and pick Measure. The Measure tab opens in the right sidebar.
2. Start a distance measurement. The tab shows a live dot, and Space opens it while you draw.
3. Fold the right panel with the handle on its edge. Start a tool again: a drawer slides out beside the stage. Esc closes it in one press.
4. Open the island with the right panel folded. Its tools stay clear of the window buttons at the top right.
5. Play the drone video. A live "Video" tab appears without taking the front. Close it and the clip pauses.
6. Shrink the window under 640 px wide. The video docks at the bottom, and the corner items don't overlap.
7. Open Split and press Alt+Right Arrow. Only the focused pane steps to the next date.
8. Press Ctrl J. The agent pane opens. Drag its edge, maximise it, then minimise it.

## Open threads

- Land in order behind this PR: telecom UI, then the RF coverage UI, then `codex/engineering-fidelity`. Each rebases with `--onto <this PR's head> c44bcc7c`. Telecom and RF each get one marked block in `Stage.tsx` (I-R61).
- Known limits, recorded in KNOWN-LIMITS:
  - the coordinates readout hides beside the volumes hint in 3D panes under 640 px;
  - date steps drop on stages of 420 px or less;
  - the compass can draw over the hint in a 200 px split side.
- Skipped minors:
  - Enter on the folded island still opens its tools;
  - a one-shot drawing from QA or Overlays opens Measure from the island;
  - two "title bar" strings in `en.ts`;
  - three spacing values in `island.css` with no matching token.
- Corner-item registry for stage overlays: deferred until three or more overlays need it.

## Next session entry point

Land the three follow-up branches one at a time, then build the installer (handover section 4).
