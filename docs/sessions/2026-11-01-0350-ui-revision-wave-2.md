---
type: session
date: 2026-11-01-0350
branch: feat/shell-rail
status: complete
related: [plans/2026-10-30-ui-revision.md, sessions/2026-10-31-1046-founder-test-round-1.md]
---

# UI revision Wave 2: the new shell

## What changed

- On local `main`: feature dialogs on the shared Dialog (W15b); every notice through one toast host (W16), with offers and undo kept in front of info toasts (`fix/toast-priority`); the right panel as four fixed tabs with sections, the site digest first in Project (W7); feature menus on the shared Menu (W17); the video docked in the bottom strip with a movable, resizable pop-out (W9); decision walls (W14: Position and File under submenus, one Find changes button, Filters (n), a Defect type checklist) with the fix that a project opens on Selection after one that followed onto Volumes; one tool registry for the Tools tab, island modes and palette (W8), with the antenna flag spec opening Project.
- In this PR (W11): a rail on every screen (screens, Processing with Create maps from photos, guide, Settings), a title bar with the Customer / Project / Date breadcrumb, search and status chips, and a Layers column on the Scene.
- Stage share with Layers folded: 68% at 1100 px and 71% at 1280 px (35% and 44% before the revision).
- Decided without the founder: the defect type filter keeps multiple types as a checkbox menu; a narrow strip shows one Pop out button instead of the tile; the rail foot keeps Processing and Create maps on every screen; the open island's tools stop above the stage middle at 1100 x 720; a finished detection run switches tab only while Tools > Measure is in front; inside an open island, hovering a mode previews its row (flagged for the founder: if rejected it becomes click-only).

## Why

The founder approved the layout spike (G1, 31 Oct) with conditions: both sidebars fold, Selection text never clips, the notch opens on click, and Processing stays visible on the left. Every branch had an independent review before hand-over.

## How to test

1. Open Demo tank farm at 1100 x 720: rail on the left, "Customer / Project / Date" in the title bar, the right panel 300 px on Selection; it will not drag narrower.
2. Ctrl+L, Ctrl+B and the title-bar toggle each fold Layers and bring it back; Ctrl+Alt+B folds the right panel.
3. The rail foot's Create maps from photos opens the wizard on any screen, Layers folded too.
4. Click a pile: it opens in Selection with all three figures readable. Pick a measurement, then Tools > Measure: its card sits above the tools.
5. Click the notch: labelled modes with their top tools; the tools stay above the stage middle. Ctrl+K, "pci": the road tool is greyed with its reason.
6. Pop out the video tile, drag and resize it, open the island: the window stays below it. Pop in, then W twice while popped out: it comes back popped out.
7. Delete a measurement, then run an export: only the export toast shows, with "1 more". Close it: Ctrl+Z restores the measurement.
8. Right-click a model in Datasets: Position > and File under > submenus. Changes tab: the Find changes arrow lists five comparisons.
9. Demo access road, Selection > Defects: tick two types, the button reads "2 types". It opened on Selection although the tank farm was on Volumes.
10. A two-date project: Project starts with Site digest. Open any dialog with the crash notice showing: the dialog's backdrop covers it.

## Open threads

- A real-data volumes spec expects every pile card while the inventory folds to four per group (predates W7, local only); a real-data video spec still looks for the old video window after W9 (local only).
- Known occasional failures: `compare.spec.ts:524` and the `compareStore` unit test under a loaded check.
- At 1100 px the Volumes inventory scrolls sideways inside its box (Expand panel helps).

## Next session entry point

W10 stage slots (revisit the island height cap) and W12 responsive bands with the spike removed, then W13 presets and Wave 3 (W15a, W18 to W21).
