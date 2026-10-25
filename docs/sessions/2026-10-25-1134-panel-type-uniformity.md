---
type: session
date: 2026-10-25-1134
branch: fix/panel-type-uniformity
status: complete
related: []
---

# Panel spacing, one type scale and a smaller section window

## What changed

- Every right-panel view keeps the panel's 12 px side padding (an open pile and line cards had none, since `.vb-view.vb-open` zeroed it); the fold tab no longer covers tab text.
- The profile chart's "Elevation (m)" title sits inside the chart above the plot instead of 11 px left of it (it showed as "evation").
- One type scale across the left sidebar, the right panel and pop-ups: titles 15 px sans (new `--t-15`), section caps 11, body and buttons 13 (panels and pop-ups only; the stage toolbars keep theirs), figures 13 mono, KPI numbers 16 mono, chart labels and captions 11; sentences such as "Largest drop" in the UI font.
- The section window ("Open larger") docks bottom-left at most 880 px wide and 40 % of the stage high, exports in a footer that stays in view, the chart filling the body (`ProfileChart` `fill`, exaggeration shown, slider only in the dock); pile windows drop the road-only stations controls.
- Checks: `pnpm check` green apart from one unhandled rejection in an untouched file that passes alone; 26 e2e specs the CI way green, then 28 more runs after the chart round. Before and after screenshots were reviewed by the founder on a private page.

## Why

Founder report: text clipping into the right panel's left edge on a pile's Profile, uneven text sizes between panels, and an oversized profile pop-up. The founder approved the proposed scale and pop-up size from before screenshots.

## How to test

1. Quarry demo, click a pile, Profile tab: "Elevation (m)" is whole, nothing touches the panel's left edge, the fold arrow covers no tab.
2. Overview, History and Inventory: the same 12 px margin; title 15 px, body and buttons 13 px.
3. Profile, Open larger: the window sits bottom-left, leaves the pile visible, the chart fills it, PNG / DXF / CSV / Add to report stay visible, no "Stations" controls.
4. A road or line section's window still has its stations controls.

## Open threads

- At 1100 x 720 the window is about 216 px tall; the chart comes first and the rest scrolls.
- Left sidebar names are cut a little shorter at 1100 wide with the bigger figures.

## Next session entry point

Hand `fix/panel-type-uniformity` to the merge coordinator.
