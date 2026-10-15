---
type: session
date: 2026-10-15-0937
branch: feat/timeline-date-lanes
status: complete
related:
  [plans/2026-10-14-timeline-date-lanes-design.md, plans/2026-10-14-timeline-date-lanes-l1-plan.md]
---

# Timeline date lanes (L1)

## What changed

- The clip timeline under the Stage is now one lane per survey date on a shared time-of-day axis in site time (`round(lon / 15)` from the project origin, `siteUtcOffsetMin` in `@aio/geo`; "UTC" without a position). The focused date plus two either side show; the rest fold into "+N earlier / +N later". Other dates show a ghost playhead; overlapping clips stack in sub-rows; dates without video keep a thin lane with their marks.
- Video projects lose the DateBar: its calendar opens from the date in the timeline's corner, `T` collapses the timeline to a one-line date row, Alt+Left / Alt+Right still step dates. Road projects and projects without video are unchanged.
- Clicking a clip selects and seeks without playing (old timeline too); focusing a date keeps the time of day. Shared timeline parts and a `Popover` (portal anchor) moved into `@aio/ui`.
- Landed as #130 (`main` at `590e8aa4`), built subagent-driven from the plan with task reviews and a whole-branch review; new `timeline-lanes.spec.ts` 8/8 (24/24 repeated) the CI way. No app rebuild yet: the founder waits for other sessions.

## Why

With many videos over many dates the old single UTC axis turned flights into slivers and ignored the focused date. The founder picked date lanes (option A) with ghost playheads and the DateBar merged into the timeline.

## How to test

1. Open a project with videos on two or more survey dates, go to Scene: the bottom bar shows one row per date, the focused one bright; same-morning flights line up.
2. Click another date's label: the sidebar switches date and the playhead sits at the same time of day.
3. Click a clip: it is selected but does not play. Press Space: it plays and continues to the next clip on that date only.
4. Click the date in the bar's top-left corner: the calendar opens fully visible; picking a day switches date.
5. Press `T`: the bar shrinks to a date row; Alt+Left steps back a date; `T` again restores it.
6. Open a road project and a project without video: both look as before, DateBar at the top.

## Open threads

- Founder review of the choices: the date sits in the corner (not the header) because 1100 px is too narrow; the "2 of 6" date count is gone in video projects; the calendar opens under the date button; an issue click on a dimmed date focuses it first; the axis widens to cover photo and issue marks.
- Two @realdata tests on the founder's data fail in untouched areas (no "More tools" at 1440 px; the eye-button count now includes main's Add buttons); not confirmed on main.
- Deferred minors: hard-coded English titles; onStep duplicated in WorkspaceLanes and WorkspaceScreen; in a gap the previous active clip stays; popover style not reset on close; a thin-lane keyframe diamond can poke 1 to 2 px.
- The empty folder `.claude/worktrees/timeline-date-lanes` stays until this session closes (Windows lock); an untracked `docs/design/landing-options/` in the main checkout belongs to another session.

## Next session entry point

L2 Sync dates (a `video` pane kind and `compareWith({ kind: 'video' })`, a contract change) and L3 walks in lanes are designed in the spec but not planned.
