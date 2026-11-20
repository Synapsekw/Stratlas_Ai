---
type: session
date: 2026-11-20-1910
branch: feat/volumetric-report-layout
status: complete
related: [../plans/2026-11-20-volumetric-report-layout.md, ../architecture/contract-changes.md]
---

# The volumetric report rebuilt to the approved layout

## What changed

- **Pages.** The summary page lists every pile ("N piles, M measured"; a pile without a volume reads "Not computed"; a warning when two outlines overlap). A site overview page follows (photo, elevation, 3D, each with the pile numbers), then pile pages with two full cards per page: the photo with the outline and the profile line, a 3D view on the latest survey (the pile look can now be pinned to a survey date), the earlier survey's photo, the app's own elevation profile with both surveys and the base, and a strip of figures. Then the change page. The method note prints once at the end, on a closing-only page when the last page already holds two cards.
- **Pictures.** The export takes them itself, under a progress card with a count, a bar and Stop; "Take them now" sits in a line above the preview. Pictures count as stale by a fingerprint (now v2, which includes each pile's base). A report stores up to 512 pictures (was 64). The offline HTML file follows the same rules and keeps its 15 MB limit.
- **Decisions recorded** (plan section 2 and its questions): uncomputed piles are listed, never dropped; the overlap warning is raised at half of the smaller outline; a negative pile stays in the site total, and a pile at or under zero prints no tonnes and no percentage; a stale set is retaken whole, never in part; the HTML limit stays.
- **How it was built.** Parallel agents along the plan's DAG, then an independent review whose six findings are all fixed in this PR: the closing block overflowing its page, a base change not retaking the pictures, the offline view's share of stock, the "new" label, the wrong reason given for a missing picture, and the method note's inputs.
- **Evidence.** `pnpm check` green on the final code (18,515 passed). End to end the CI way (1100 x 720, scale 1, WARP, one worker): `volumetric-report-layout`, `volumetric-report`, `volumetric-report-edit` and `dialogs-a11y`, 9 passed; earlier on the branch `pile-panel` 14, `volumes-finalize` 6, `kit-migration` 9, `volumetric-build` 1. The layout spec proves on pixels: paper, not black, outside the photo; the 3D picture on the latest date; the progress card and Stop; "Not computed"; the overlap warning. A proof export on a private two-date project copy: 7 pages, 31 pictures, 25 s to take them, 28 s for the export, a second export under 2 s with nothing retaken, PDF 3.2 MB, HTML 4.4 MB, every page looked at.
- **Not run:** the `@realdata` tests and the full e2e suite. One contract row (20 Nov 2026 in `contract-changes.md`), no pack change.

## Why

After the founder's first volumetrics test the report was marked "improvement needed": no pictures of the piles, no profiles, and a weak structure. A mock-up made on a private copy of real data was approved on 20 Nov 2026; this PR builds it.

## How to test

On your own two-date stockpile project (the generated demos are not on the dev app's Projects screen).

1. Run `pnpm dev` and open the project.
2. Go to Reports, Customer reports, Open volumetric report. The preview shows the new pages with "No picture yet" in place of each picture, and a line above it: "Pictures are taken when you export." with Take them now.
3. Click Export PDF. A card "Taking the report pictures" shows what is pictured, "Picture n of N", a bar and Stop taking pictures, then "Writing the PDF". In under a minute the save dialog appears. Save and open the PDF.
4. Page 1: "N piles, M measured" under the title (8 and 3 on the proof copy), "Not computed" rows, and the overlap warning if two outlines lie on each other. Page 2: site photo, elevation and 3D view with the pile numbers, no black areas. Pile pages: two piles per page, three pictures and a profile each, the 3D picture dated the latest survey.
5. Click Export PDF again: no pictures are retaken and it finishes in seconds.
6. Change one pile's base, open the report again: the line above the preview reads "The data changed since the pictures were taken." Export PDF: the pictures are retaken and that pile's 3D picture stands on the new base.
7. Move a pile's outline, open the report, click Export PDF and press Stop taking pictures while the card counts: a message says "Taking them was stopped.", no save dialog appears, nothing is saved, and the app looks as before.
8. Click Export HTML, save, and open the file with the network off: the same figures and pictures.

What backs each step: 2, 3, 5 and 8 are driven by `e2e/volumetric-report.spec.ts` on the generated quarry demo (the "No picture yet" wording by unit tests only), and 3 to 5 and 8 by the proof export. Step 4 is driven by `e2e/volumetric-report-layout.spec.ts` on the demo and was looked at page by page in the proof export. Step 6 is not driven in the running app: a base change making the pictures stale is covered by a unit test of the fingerprint only, and the retaken 3D picture on a new base was not looked at. Step 7's Stop (no dialog, no file, the saved pictures untouched, the view back) is driven by the layout spec, but there the pictures are made stale by rewriting the saved fingerprint, not by moving an outline by hand.

## Open threads

- The "Latest t" column stays in the summary table when no pile has tonnes.
- A nearly flat negative pile draws as a tall box in its 3D picture.
- In the offline view, badges of overlapping piles can sit on each other.
- The offline view's CSV still carries tonnes for piles at or under zero (a known limit, in the guide).
- The photo caption on a pile card wraps to two lines.
- A package exports with the pictures it carries, even when they are stale (it cannot save new ones).
- `check-public-text` flags a token in `packages/schema/src/report.test.ts` that was there before this branch.

## Next session entry point

The coordinator lands this PR on local `main`; the founder runs the eight steps, and with the report passed, approves the volumetrics section or names what is left. Telecom starts after that approval.
