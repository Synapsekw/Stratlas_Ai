---
type: session
date: 2026-10-25-1725
branch: feat/volumetric-report
status: complete
related:
  - superpowers/specs/2026-10-25-volumetric-report-design.md
  - superpowers/plans/2026-10-25-volumetric-report.md
  - architecture/adr/0013-one-volume-engine.md
---

# Volumetric customer report: PDF and offline HTML with editable write-ups

## What changed

- A customer volumetric report (this PR): Reports, Customer reports, Open volumetric report opens an editor with a live preview of the exported pages; Take pictures captures the app's own top-down photo, elevation, cut and fill and 3D views; Export PDF prints pages A (summary), B (pile cards with before and after crops) and C (what changed); Export HTML writes one offline file (all data, fonts and pictures inside, strict CSP, no network) with the interactive viewer D and the same pages for printing. Quadrion branding from the brand kit. A report-type seam leaves room for other project types.
- Editable write-ups saved per project in `report/volumetric.json` (`aio.report-text/1`): title, Prepared for and by, the generated In short summary with Reset to generated, intro, method note, per-pile notes, closing remarks, and pages A, B and C on or off.
- Volume engine fixes found on a real two-survey, 19-pile stockpile project: each survey date uses its own pile outline; the perimeter base leaves out edges shared with a neighbouring pile (both engines, ADR 0013); dates recompute once a kit figure is accepted; peak height per pile and date (`ComparisonResult.peakM`); whole-site cut and fill compares the overlap only (both engines); tonnes use the site density; kit piles come back only on positive evidence they were lost by accident. Site totals on that project now sit within 0.4 % of the survey kit (were 15 % low).
- UI fixes: map Cut and fill heat map on kit projects, map pile labels without glyph fonts, 3D label declutter (non-pile labels never hide), pile card chart dates and table width.
- Contract rows in `contract-changes.md`; checks: `pnpm check` green, 14 e2e specs green the CI way (incl. the new `volumetric-report` and `volumetric-report-edit`), survey pytest green; two independent reviews, findings fixed.

## Why

The founder asked for shareable volumetric reports (offline HTML with data inside, or PDF), tailored per project type, with clear visuals and editable write-ups. The four mock-ups were approved on the real app imagery; building them exposed the volume figures being wrong on real data, so those were fixed first.

## How to test

1. Open a stockpile project with two survey dates (the quarry demo works). Reports, Customer reports, Open volumetric report.
2. Take pictures: a progress card runs, then the preview shows the orthophoto with numbered markers that match the table badges.
3. Edit the title, Prepared for and the In short text: the preview follows as you type. Reset to generated brings the summary back.
4. Switch page B off: it leaves the preview. Switch it back on.
5. Export PDF: three branded pages (A, B, C) with the figures of the Volumes tab.
6. Export HTML, then open the file with Wi-Fi off: the viewer works (date, view and unit toggles, click a pile), Download CSV gives the inventory, Save as PDF prints the pages.
7. Close and reopen the project: the edits are still in the editor.

## Open threads

- Per-pile figures still differ from the old survey kit by a few percent (the kit pins its base on 0.5 m means inside the toe and drapes a smooth surface); totals agree within 0.4 %. Founder call whether to match the kit's raster method.
- A project whose kit piles were deleted by hand keeps them deleted; a "Restore survey kit piles" action is a founder call.
- 3D pile labels that collide now wait for hover; the founder may want all labels shown.
- Page pictures in the HTML are set by its script, so a viewer that blocks scripts prints empty boxes.
- `jobs.test.ts` lines 86 to 87 and `exportModel.test.ts` (on main) still hold a client tank name.

## Next session entry point

Hand `feat/volumetric-report` (this PR) to the merge coordinator, last in its batch (many shared files).
