---
type: session
date: 2026-11-22-1420
branch: fix/report-open-points
status: complete
related: [../plans/2026-11-22-report-open-points.md, 2026-11-20-1910-volumetric-report-layout.md]
---

# The volumetric report's open points, and its owed test steps driven

## What changed

- **Flat pile.** A pile with no relief above its base kept the opened pile's lift, 22 % of its span (a unit test reproduces the 11 m box on a 50 m pile). A report picture now takes a 6 % floor; the opened pile in the app is unchanged. The pictures' fingerprint is `v3`, so every report retakes its pictures once.
- **Offline view.** Badges that would sit on each other are moved apart with the printed pages' rule (`viewer/spread.ts`), laid out again when the window changes size. The CSV leaves a pile's tonnes empty at or under zero; material and total rows and the app's own inventory CSV are unchanged.
- **Caption and packages.** The photo caption reads "Outline and profile line, <date>" on one line. A package says above the preview and after the export when its pictures may not match, and one without pictures is refused at once instead of failing after taking them.
- **Found by the runs and fixed.** With an offline street map pack installed, the dark street map showed all around the survey in the top-down pictures of a real project; it is now left out of those renders (black share 0.144 before, 0.000 after, paper 0.143). An independent review found two defects in the badge spreading (badges that just touch, wide badges); both fixed with tests.
- **Hygiene.** The unused `measuredShown` plumbing is gone; two test fixtures have neutral project names.
- **Decisions.** The founder delegated the seven calls of the plan on 22 Nov 2026; they are recorded as decided in its section 3.

## Why

The rebuilt report shipped in installer 0.32.0 with six open points. The founder also asked that the owed test steps be driven by the session instead of handed to him.

## Evidence

- `pnpm check` is run by `finish-task` before the hand-over; its totals are in the hand-over message. End to end the CI way (1100 x 720, scale 1, WARP, one worker, every demo built): `volumetric-report`, `volumetric-report-edit`, `volumetric-report-layout`, `dialogs-a11y` and `package`, 11 passed. The layout spec now proves one-line captions and that the offline view's six badges do not sit on each other at 1280 px and at 700 px.
- **Owed steps of `2026-11-20-1910-volumetric-report-layout.md`, driven on a temporary copy of the real two-date stockpile project** (scratch spec, not committed): step 2 the preview with 7 pages and the line "The data changed since the pictures were taken." (the project holds pictures from an older version); step 3 the card counted 31 pictures, "Writing the PDF", 30 s; step 4 seven pages, "Not computed" rows, the overlap warning, 24 captions each on one line, no black in the site photo and elevation; step 5 a second export in 1.2 s with nothing retaken; step 6 a base change (Custom to Lowest point, saved figures changed) made the line appear and the next export retook the pictures; step 8 the HTML file opened offline with no request, 7 pages, 46 of 46 pictures drawn, 8 badges with none on another and 2 leaders, the CSV read. Step 7 (an outline moved by a corner drag, then Stop: the message, no dialog, no file, the saved pictures untouched) was driven on the generated quarry demo.
- **Proof runs on the quarry demo:** a 50 m flat pile under its base has a low box, whole in the frame, and a normal pile's picture is as before (both looked at); its CSV row has empty tonnes while its material row keeps them; a package made after a base change shows the notice, exports, and says it again; a package made before any export is refused in 28 ms with no picture taken.
- **The real-data stockpile spec:** 3 of 3 passed after a fix to the spec. Its first run timed out waiting for the label of a pile filed under another date than the one in focus; the view draws only the piles of the date in focus (1 of 8 on this project), so that pile had no label to click. The spec now clicks a pile that is drawn.
- **The pile tile after a base change (found by these runs, fixed):** a pile filed under one date shows a figure of its series on the date in focus. Only Project, Volumes and the Measure card worked that series out, so with the pile panel alone on screen the tile kept the old figure and read "Up to date". The panel now runs the series for its pile (`survey/volumes/seriesRun.ts`, used by `PilePanel.tsx`); on the real copy the tile follows in under half a second.
- **The PDF itself:** two pages of the real export were rendered with the app's own Chromium and looked at: paper around the survey, the two overlapping piles' numbers side by side, every caption on one line.

## How to test

On your own two-date stockpile project, with `pnpm dev`. Only what needs your eye is left.

1. Open the project, then Reports, Customer reports, Open volumetric report, and click Export PDF. The pictures are retaken once. Open the PDF and look at the 3D picture of a pile that is flat or under its base: its box is low, 6 % of the pile's size. Say if that height looks right; it is a look, and the only real flat pile is yours. (The route was driven on the real copy; the low box was looked at on a synthetic flat pile.)
2. Optional. Open a pile from Project, Volumes, switch its base to Lowest point and save the measurements; do not export the report. Reports, Export package, save; open the package, open its volumetric report and click Export PDF. The line above the preview and a message after the export say the pictures may not match; the "saved to" message waits behind it ("1 more"). Say if you want that order turned. (Driven on the quarry demo.)

## Open threads

- The real-data volume check (site totals within 1 %, each pile within 5 %) was not run: it needs reference figures for the project's eight piles as they are drawn now, and the only figures on the PC are the old kit's 19 piles, none of which shares a name or an outline with them. The app's figures per pile and date were recorded by the spec.
- The site's 3D overview picture has the dark stage around the survey; only the top-down pictures are on paper. Not changed: it is the approved look.
- The real project has no densities, so the tonnes rule of the CSV was proven on the demo only.

## Next session entry point

The merge coordinator lands this PR; the founder looks at the two steps above, then approves the volumetrics section or names what is left.
