---
type: session
date: 2026-10-30-1945
branch: feat/auto-qa-after-date
status: complete
related: [../plans/2026-10-30-auto-qa-after-date.md]
---

# Checks after a new date, and a report narrative without AI

## What changed

- This PR chains the survey QA and the change compute to a new date (intelligence review I1, study item 5.1). When a surface preparation job ends done, each date it prepared that has a date before it gets, quietly and one at a time, the survey QA against the previous survey at the site QA level (a quiet job in Jobs with Cancel) and the in-app change compute for the pair (shown in the Changes panel with Cancel). Never repeated for a date already checked or a pair already computed, never on a one-date project or for the earliest date. It waits while a job runs on the project or a person runs QA or a compute, and a cancel stops it until the project is opened again.
- A date prepared again gets a fresh check and change set; the QA compares with the nearest earlier date that has a surface. The automatic run uses no checkpoints: a processing run's GCPs built the surface, so they would overstate accuracy, and the report's method line says those checks were measured against the previous survey without checkpoints (a hand run with checkpoints keeps its wording). A compute of another pair shows in the Changes panel as "Finding what changed on a new survey date" and leaves the panel's own error and refused run alone.
- Settings, Processing tools: a new switch "Check a new survey date when its surface is ready", on by default, under the automatic surface preparation switch (`Settings.autoCheckNewDates`).
- The QA runs at the site's QA level exactly as the panel does; at level Off (a new site's default) it measures the change against the previous survey without a verdict, so holds come once a site has a level.
- The house report narrative written without AI (study item 5.3) now tells the stockpile count, the piles that moved most, piles left out of the latest total and the survey QA verdicts (holds named), and copes with projects without dates or data. The AI draft stays optional polish on top.
- An e2e run starts with the chain off (`--quadrion-newdatechecks=0`, the `autoFold` precedent) so specs on multi-date demos keep their state; `new-date-checks.spec.ts` turns it on.
- Contract rows added (setting, preload flag, narrative facts).

## Why

The numbers existed, but a new date never made the app check them: the hold banner and the change register only appeared after a click, and the report summary was thin without a cloud model.

## How to test

1. Settings > Processing tools: under "Prepare survey surfaces when a project opens" there is "Check a new survey date when its surface is ready", switched on.
2. Open a survey project with two or more dates whose surfaces are not prepared yet (for example a fresh copy of the quarry demo). Jobs shows the quiet surface preparation, then a quiet survey QA job per later date, one after the other.
3. When they end, open the Survey QA panel: the later dates have a result checked against the date before, at the site's QA level. Set a level such as Moderate first to get a pass or hold verdict and the hold banner.
4. Open Changes and pick the pair of the last two dates: its change sets are there without pressing compute.
5. Cancel the QA job in Jobs while it runs: no further checks start until the project is opened again.
6. Switch the setting off, add a date and prepare it: nothing runs after the preparation.
7. Export the house report of a stockpile project with cloud AI off: the summary names the pile count, the largest moves since the date before, piles left out of the total and any survey on hold.

## Open threads

- Dates whose surfaces are made from kit DSM grids (no job) are not chained.
- The site digest (I2) will read these QA verdicts and change sets.
