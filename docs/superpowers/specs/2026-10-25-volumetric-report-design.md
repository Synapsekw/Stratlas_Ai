# Volumetric customer report: design

**Status:** approved by the founder on 25 Oct 2026 from four mock-ups (A cover, B pile cards, C what changed, D interactive file), plus a follow-up the same day: the write-ups are edited in the app before export. Decisions marked _(builder's call)_ were made while writing this spec; everything else is the founder's.

**Plan:** `docs/superpowers/plans/2026-10-25-volumetric-report.md`.

The mock-ups were drawn on a copy of a real stockpile project and are not in git (they show customer imagery). This spec describes them in words; the plan's e2e specs run on the synthetic quarry demo.

## 1. What it is

A customer report for a stockpile project, exported from the Reports screen either as

- a **PDF**: pages A + B + C, or
- **one self-contained offline HTML file**: the interactive view D, with pages A, B and C inside it for printing. Everything is embedded (data, CSS, fonts and images as `data:` URIs, one inline script); the file opens with no network and asks for none.

Reports will later be tailored per project type. This build makes the volumetric one and a **report-type seam** (section 8) that the next types plug into; it builds no other type.

Before export the person edits the write-ups in an **editor** (section 6): title, Prepared for, Prepared by, the "In short" summary, an intro, the method note, a note per pile, closing remarks, and which pages print. The edits are saved with the project, per report, and every later export uses them.

## 2. The figures

- **The report prints the app's figures.** Every volume, tonne and change is the one the Volumes tab shows for the same pile and date: the same engine run, the same rule (`pileSeries`, `stockpileInventory`, ADR 0013 "one volume engine"). The report never recomputes in a way the app does not.
- **Change** is the difference of each pile's volume between the two dates (founder): `latest m³ − previous m³` per pile, and the sum over piles for the site. It is not the surface-to-surface comparison. The cut and fill heat map on page C is a picture of where the ground moved, explained as such; its numbers are not printed as the change.
- **Dates.** "Latest" is the newest survey date with figures; "compared" is the date before it with figures (default). The editor can pick another compared date _(builder's call)_. With one date only, the change KPI, the change column and page C are left out and the editor says why.
- **Tonnes** come from the pile's material density on that date (`densityOn`), else the site-wide density the old stockpile kit carried (`pileMaterial`). A pile with no density shows no tonnes; the KPI tile then says "tonnes for n of m piles".
- **Survey error.** When every counted pile's latest result carries `uncertainty.plusMinusM3`, the third KPI tile shows the sum (± m³ and % of stock); otherwise the tile is omitted, never shown empty.

These figures were wrong or missing in the app on a copy of a real 19-pile, two-survey project (25 Oct). The report depends on bugs 1 to 3 being fixed first (section 9).

## 3. Pages (PDF and print)

A4 portrait, fixed layout, printed with `printToPDF` (`preferCSSPageSize`, no margins: the pages draw their own frame like the house report). Fonts: IBM Plex Sans and Mono (the app's `@fontsource` files). Colours: ink `#11161C`, teal `#1A8C70` on light, mint `#5ED1B3` on dark; change uses the app's heat ramp (red lower or taken away, blue higher or added). No em or en dashes in any printed text.

### A. Cover and summary (one page, the table continues if needed)

- **Header band:** dark ink band with the official horizontal lockup on dark (`docs/brand/quadrion/kit/lockup/quadrion-horizontal-on-dark.svg`, drawn from `@aio/brand` `SYMBOL` and `WORDMARK`), a 4 px mint rule under it. In the band: the report title, "Prepared for <customer>", site, survey date, compared date and pile count. The person's company logo (Settings, Report branding) sits on the right of the band when set.
- **Orthophoto** of the latest survey, top down, pile outlines drawn by the app, with numbered pile markers placed by the report from each pile's centre (numbers follow the ranked table).
- **Three KPI tiles:** stock on hand (m³, and tonnes at density); change since the compared survey (m³ and %); survey error (± m³ and %, only when available).
- **"In short":** one plain-language sentence generated from the figures, e.g. "Stock on hand fell by 12,499 m³ (8 %) since 3 September, most of it from P04 (4,100 m³ less) and P11 (2,300 m³ less); P07 grew by 900 m³." Rules in section 5. The person can rewrite it.
- **Intro** (optional, from the editor): one short paragraph under the sentence.
- **Ranked table:** pile number and name, previous m³, latest m³, latest t, peak height, change m³ with a diverging bar (left red for less, right blue for more, scaled to the largest change). Sorted by latest volume, largest first. Rows that do not fit continue on "A, continued" pages.
- **Method footnote:** base (its standard name), DSM cell size, orthophoto ground sample distance, CRS, density (per material or site-wide). Editable in the editor; the generated text is the default.
- **Footer** on every page: "Prepared by <company> with Quadrion AI · Page n", and the brand symbol.

### B. Pile cards

- **Share of stock:** one horizontal bar split by pile (latest m³), the 8 largest named, the rest as "Others".
- **Cards for the 8 largest piles** (2 x 4 grid): before and after orthophoto crops of that pile with the same framing on both dates, a change chip (m³ and %), latest tonnes, footprint m², peak height m, and the pile's note when the person wrote one.
- **Smaller piles** in a compact list: name, latest m³, change, note mark.

### C. What changed

- Before and after orthophotos side by side (compared date, latest date), same framing.
- The app's cut and fill heat map between the two dates (top down, the app's own colours, legend and deadband), with the pile markers, and a plain-words key: "Red: lower than before (material taken away). Blue: higher (material added). Grey: changed less than <deadband> m."
- A bar chart of change per pile, sorted from the largest drawdown to the largest growth.
- **Closing remarks** (optional, from the editor) at the foot of page C, or of the last page printed when C is off.

The person turns A, B and C on or off in the editor. A is on unless the person turns it off; at least one page must stay on.

## 4. The interactive file (D)

One `.html` file, opened in any current browser, offline.

- Header band with the lockup, as on page A.
- **Toggles:** date (each survey date in the report), view (Photo, Cut & fill, Elevation, 3D), units (m³, tonnes).
- **Map:** the chosen date and view as a picture, with clickable numbered pile markers (SVG over the image, placed through the framing). Cut & fill is the compared pair; on 3D the markers sit where the 3D camera saw each pile's centre.
- **Selected pile card:** before and after crops (CSS crops of the date pictures, no extra bytes), change, tonnes, footprint, peak height, note.
- **Pile list:** all piles, sortable by volume and change, click selects.
- **Save as PDF:** `window.print()`; the print CSS hides D and prints the embedded A, B and C pages (the same markup as the PDF).
- **Download CSV:** a `Blob` from the embedded stockpile inventory CSV (the same text the app's Stockpile inventory CSV export writes for these dates).
- A strict CSP meta in the file: `default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'sha256-<hash of the one script>'`. A file that tried to reach the network would be refused by the browser, which also makes "no network" testable.
- **Size budget** _(builder's call)_: under **15 MB**. Pictures are JPEG: photo and 3D at quality 0.80, heat map and elevation at 0.88, longest side 2000 px. At most the 6 newest dates are embedded. If the file would pass the budget, the exporter steps the pictures down (2000, 1600, 1200 px) and refuses with a clear message only if 1200 px still does not fit.

## 5. "In short" rules

Pure function of the model (`inShortSentence`), tested with fixed figures:

1. Lead with the site total: "Stock on hand rose/fell by X m³ (p %) since <compared date>" or "held steady" when the change is under 1 % of stock.
2. Name up to two piles that moved most in the same direction as the total ("most of it from ..."), each with its change in words ("4,100 m³ less", "900 m³ more"), never with a minus sign or dash.
3. Then the largest pile that moved the other way, if its change is at least 5 % of the total change.
4. One date only: "Stock on hand is X m³ across n piles on <date>."
5. Numbers formatted as the app formats volumes (thousands separators, no decimals above 100 m³).

A generated summary follows the figures: if the data changes, the next export says the new figures. Once the person edits it, their text is kept as written until they press **Reset to generated**.

## 6. The editor

In the Reports screen: a new block **Customer reports** with **Volumetric report** (offered when the project has volume measurements). It opens the editor in the viewer area, as the house report's narrative editor does.

- **Left: the fields.** Title (default "Stockpile volume report"), Prepared for (default the project's `customer`), Prepared by (default Settings, Report branding, company name), Compare with (date), the "In short" summary (pre-filled, with **Reset to generated**), Intro (optional), Method note (pre-filled, with Reset), a note per pile (optional, short: at most 280 characters), Closing remarks (optional), and Pages: A, B, C on or off.
- **Right: the live preview.** The same page components the PDF prints, scaled to the pane, updated as the person types. Clicking a text in the preview focuses its field _(builder's call)_.
- **Pictures:** the preview uses the saved pictures. When none are saved, or the data changed since they were taken (fingerprint), a bar says so with **Take pictures** (section 7).
- **Export PDF** and **Export HTML** at the foot, through the usual save dialog and export toasts.
- **Saving:** edits save on their own (after a short pause, and on leaving the editor) to `report/volumetric.json`. A package opens the editor read only, with its saved edits, and exports.

### Saved edits: the report text file (contract change)

The narrative model in `packages/schema/src/report.ts` is reused: each text is a `NarrativePart` of `NarrativeVersion`s (`text`, `source` `ai | template | user`, `createdAt`, newest last, at most 50 kept). The file is a sibling of `report/narrative.json`, not part of it, because `NarrativeFile` is `.strict()` over a fixed part enum: older builds would refuse the whole narrative file if it gained parts, and narrative is one per project while these edits are per report.

```ts
export const REPORT_TEXT_SCHEMA = 'aio.report-text/1';
export const ReportTypeId = z.enum(['volumetric']); // one per project type, later more
export const VolumetricTextId = z.enum([
  'title',
  'preparedFor',
  'preparedBy',
  'summary',
  'intro',
  'method',
  'closing',
]);
export const ReportPageId = z.enum(['cover', 'piles', 'change']); // A, B, C
export const ReportTextFile = z.looseObject({
  schema: z.literal(REPORT_TEXT_SCHEMA),
  report: z.string().min(1).max(40), // a ReportTypeId; open, so a later type never breaks a read
  parts: z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/), NarrativePart),
  pileNotes: z.record(SurveyId, NarrativePart).optional(), // by measurement id
  pages: z.partialRecord(ReportPageId, z.boolean()).optional(),
  compareWith: z.string().min(1).max(128).optional(), // a capture id
});
// <project>/report/<report>.json, e.g. report/volumetric.json
```

- **Generated or written:** a part whose newest version has `source: 'template'` follows the figures (its text is regenerated at every preview and export; the saved text is the last generated one, for the record). `source: 'user'` is kept as written. **Reset to generated** adds a `template` version. A part with no versions is generated.
- Main reads and writes it like the narrative (`readJsonSeen`, `writeJsonSeen` with `.bak`, "changed on disk" check, newer-version check through `versions.ts`), journaled like `report:writeNarrative`. New IPC `report:readText` and `report:writeText` (`{ projectId, report, file }`).

## 7. Pictures from the app's own rendering

Never sketches. The pictures are taken from the live 3D stage of the open project, in the main window, when the person presses **Take pictures** (and offered again when stale):

- per date: **Photo** top down (the orthophoto, the app's pile outlines, no labels: the stage's labels are DOM and not in the render), **Elevation** top down;
- for the compared pair: **Cut & fill** top down (the app's whole-site heat map with its legend range and deadband);
- per date: **3D**, an angled view from the south-east at 35 degrees, the whole yard framed _(builder's call)_.

Top-down shots render the stage's scene through a temporary orthographic camera looking straight down over the piles' extent plus a margin, into an offscreen target at the budget size, so the framing is exact: `frame = { extent: [e0, n0, e1, n1] (project CRS), widthPx, heightPx, mPerPx }`, `px = (e − e0) / mPerPx`, `py = (n1 − n) / mPerPx`. The 3D shot records each pile centre's projected pixel. The person's date, Show surface, camera and selection are put back afterwards; while it runs, a progress card covers the stage.

Per-pile crops use the same box on both dates: the union of the pile's outlines on the two dates, plus 25 % margin, at least 20 m a side, squared.

Saved as `report/views/volumetric/<name>.jpg` with `frame.json` (`aio.report-views/1`: the frame, the 3D marker pixels, which dates, and a fingerprint of the inputs, to tell when they are stale). New IPC `report:saveViews`. A package keeps its pictures in memory for the session _(builder's call)_; its export uses them.

## 8. The report-type seam

`apps/desktop/src/renderer/reportPage/types/` holds one template per report type behind one interface:

```ts
interface ReportTemplate<Model> {
  id: ReportTypeId;
  offered(project: { manifest: ProjectManifest; survey: SurveyFiles | null }): boolean;
  textParts: readonly string[]; // the editable parts, in editor order
  pages: readonly ReportPageId[];
  model(input: ReportInput): Model; // pure, from the app's figures
  render(model: Model, text: ResolvedText, views: ReportViews): ReportPages; // A4 pages
  interactive?(model: Model, text: ResolvedText, views: ReportViews): ViewerData; // the HTML's D
}
export const REPORT_TEMPLATES = { volumetric: volumetricTemplate } as const;
```

The editor, the export plumbing (PDF, HTML), the text file and the pictures are written against this interface; adding a type is a new template and a new `ReportTypeId` value.

## 9. Bugs fixed first

Found on 25 Oct on a copy of a real 19-pile, two-survey stockpile project after its kit piles were converted to volume measurements and computed. Each fix starts with a failing test that reproduces it.

1. **One outline for both dates (blocking).** `convertKitPiles` keeps only the latest non-empty toe line as `points`, and `computeSeries` (and the report's `volumesOverTime`) send that one ring for every date. The recompute gave +7,342 m³ where the kit's figures say −12,499 m³. Fix: a measurement may carry an outline per date (`outlines`, contract change), the kit conversion writes each epoch's ring (draped on that epoch's DSM), projects converted earlier get them once from `volumes.json` when the measurement still has the kit's latest ring, and every series run uses the date's own outline (`outlineOn(m, capture)`, falling back to `points`).
2. **Volumes, Cut & fill, "Whole site" shows 0.0 / 0.0 / 0.0 (blocking)** while "Inside piles" works.
3. **Inventory Tonnes "-" with a site density set (blocking).** `inventoryModel` weighs piles by the site materials only; the kit's site-wide density (`pileMaterial`) is never used there.
4. **Map mode with Cut & fill draws no heat map, and pile labels do not show in Map mode** (polish).
5. **3D pile labels overlap** when piles are close (polish).
6. **Pile card:** the volume chart labels only the first date, and the narrow per-date table wraps (polish).

## 10. Out of scope

Other report types; AI drafting of the write-ups (the `ai` source stays possible later); interactive WebGL 3D in the HTML (D's 3D view is the captured picture); merging two people's edits of `report/volumetric.json` in team projects (last write wins with the changed-on-disk check, as today for one-off files); cloud sharing of the HTML.
