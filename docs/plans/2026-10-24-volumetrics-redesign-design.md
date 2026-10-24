# Volumetrics redesign: design

Date: 2026-10-24. Branch `feat/volumetrics-redesign`. Approved by the founder up front (24 Oct 2026): build without waiting for plan approval.

Plan: `docs/plans/2026-10-24-volumetrics-redesign.md`.

## Intent

Volumetric parity wave 1 (`docs/superpowers/specs/2026-10-20-volumetric-parity-design.md`, ADR 0013) gave the app one volume engine, one profile chart and volume over time. A review on the founder's two-date stockpile project on 24 Oct found that it still does not read like a stockpile product: converted piles float 51 m below the ground, cards say "No survey data" until someone finds Prepare surfaces, a pile click does nothing useful, the date lives in three places, pile figures do not follow the date, and the Volumes tab mixes kit controls with engine figures. This redesign fixes the two bugs first, then rebuilds the volumes experience around a pile panel, a linked chart and scene, one date control with a dates chart strip, and a Volumes tab with Inventory, Cut and fill and Materials.

## Source of truth for the look

The founder-approved Design canvas "Volumetrics redesign" (private artifact `DB5QCSDcq6xE7NakdnVADk`, 11 boards). Board numbers below are the canvas numbers. Every figure on the boards (piles, materials, densities, volumes, tonnes) is mock-up data from the founder's two-date stockpile project and is illustrative only; material names such as "Aggregate 20 mm" are examples, not product data or defaults.

## Founder decisions

1. **Build order:** heights fix, surfaces prepared automatically, pile panel and profile, linked hover, timeline strip, Volumes tab with materials and density.
2. **Linked hover** works both ways between chart and line, shows one dot per survey with the gap between them, works for pile profiles, line cards, the larger section window and both Split panes; click pins, double-click flies.
3. **The timeline is a chart strip**, not a simple bar (the founder rejected the bar).
4. **Converted old-kit piles show the standard-base engine figure by default once surfaces exist** (as in the mock-ups), and the kit figure is kept as "was" in History. Decided 24 Oct 2026. This amends ADR 0013 point 4 ("never replaces a project's kit figures without asking"): the replacement happens on its own, once per pile, and the kit figure stays visible as "was".
5. **Nothing between surveys is estimated.** Playback blends imagery but figures change only at survey dates.
6. **Calibrate from weighbridge is later.** It is out of scope here and is not shown.

## Layout frame (board 1)

- Window grid: sidebar 252 px, stage, right panel 400 px (board widths at 1600 px; the real app keeps its resizable widths).
- The stage is the view plus a **160 px dates chart strip** along its bottom (stage rows `1fr 160px`).
- The notch (top centre, landed 23 Oct) carries 3D | Map | Split, the date with arrows and "2 of 2", and More (⋯). It is the one date control.
- Floating stage controls sit 14 px in from the stage corners on a scrim: top-left **Show**, top-right **Streets** chip, bottom-left a hint or a legend, bottom-right a legend.
- Right panel tabs: Agent, Share; then Selection, Issues, **Volumes** (with pile count), Changes.

## 1. Heights fix

### Problem

`kitToSite` (`packages/survey/src/calc/kitPiles.ts:360`) returns `[E, N, 0]` on purpose, so every converted kit pile is stored at Z 0. The 3D scene draws stored Z (`measureScene.ts` `frameOf`, `toLocal`, y = h minus origin height), so with an origin height of 51 m the outlines sit 51 m below the ground. Volumes are right (the smart base samples the surface along the perimeter), but a Custom base and a Reference level seed from vertex Z (`pickers.ts` `customBase` :192, `sideFor` :204) and get 0. The map has a latent copy of the bug: `site(lng, lat)` gives `clampZ(e, n) ?? 0` (`measureScene.ts:846-849`).

### Behaviour

- **At conversion** every vertex gets a real height: the kit DSM of the epoch the outline belongs to (`legacy/data/dsm_<epoch>.js`, `decodeDsm` and `sampleDsm` from `@aio/volumetric`), with a vertex over a hole taking the previous vertex's height (as the kit's own `drape` does). When that epoch has no kit DSM, the prepared surface of the matching survey date (`groundAt`). When neither has a height for any vertex, the pile keeps Z 0 and is not marked repaired.
- **One-time repair on load** for projects converted before this fix: a measurement with `origin.kind === 'kit-pile'` whose vertices are all Z 0, in a project whose `origin[2]` is not 0, and whose id is not in `MeasurementsFile.kitHeightsRepaired`, gets the same heights. The repair is written quietly like the conversion (`writeConversion`: a migration, no unsaved mark) and lists the id in `kitHeightsRepaired`, so it runs once. It never touches a pile that has any non-zero vertex (a person edited it), never sets `updatedAt` or `pickedOn`, and is not acceptance in the ADR 0013 sense.
- When surfaces finish preparing (section 2), the repair runs again for piles still unrepaired.
- Read-only opens (a package, the report page) repair in memory only and write nothing.
- **Map picks never fall back to 0.** On a raycast miss a map vertex takes the height of the prepared surface of the date in view (from a warmed tile cache), else the previous vertex of the same drawing, else the origin height.

## 2. Surfaces prepared automatically (board 7)

### Problem

Cards list only dates with prepared height tiles (`useDatedSurfaces`, `slots.tsx:277-288`), so a project where nobody ran Prepare surfaces shows "No survey data". Prepare surfaces is manual (`Sidebar.tsx:1073`, `VolumeDetail.tsx:314-343`) and, after it runs, the cards' store (`qaStore`) is not refreshed until the project reopens.

### Behaviour

- **On open, and when a survey date is added,** a writable project whose dated surveys lack a prepared surface starts one quiet `survey.prepare` job for all of them (a DSM where the date has one, else its point cloud), the way the line-up check starts its background job (`lineUpWatch.ts`, `jobs.startQuiet`). It is listed in Jobs with progress and Cancel, never selected or announced.
- **Consent and load.** A new setting, Settings > Processing tools, "Prepare survey surfaces when a project opens", on by default. Off: nothing starts; cards offer Prepare. A job the person cancels is not restarted for that project until it is reopened. Nothing starts without the pipeline Python, for a read-only project, or for a date that has no DSM or cloud.
- **Stage card (board 7),** bottom-left while a prepare job runs: title "Preparing survey surfaces", right "Preparing 1 of 2", one row per date with "ready" or a percentage and a thin bar, and the line "Started on its own when the project opened. You can keep working." It closes 2 s after the job ends; Cancel is in Jobs.
- **Sidebar Survey dates rows** show "ready" or "preparing 62 %" while a job runs; the status bar shows "1 job".
- **Cards list every survey date as a chip.** A chip's state is one of: ready (as today); preparing (percentage, chip dimmed, not toggleable); missing (chip with a "Prepare" action that starts the job for that date); none (no DSM or cloud for that date; chip disabled, reason on focus "No elevation for this date"). The charts draw the ready dates at once and add the others as they finish; in the pile profile the placeholder reads "Building the height surface for 31 Dec 2020…" and "The 10 Jan line is ready; 31 Dec and the cut/fill shading appear when it finishes." (board 7, dates are the example's).
- "No survey data" is replaced by the specific reason: "Surface preparing", "No elevation for this date" or "Not measured on this date".
- After the job ends, both `compareStore.surfaces` and `qaStore.surfaces` refresh.
- Once surfaces exist, converted kit piles take the standard-base figure (decision 4): the confirmed bulk path `recomputeCarried` runs on its own for every converted pile with a carried result, keeping the kit figure in `previousResults` as "was". It runs once per pile (a pile without a carried result is skipped) and only in a writable project.

## 3. Pile panel (boards 2, 3)

### Opening it

A click on a pile body or outline in 3D (any body mode, not only Lifted), on its outline on the Map, on its sidebar Stockpiles row or on its Inventory row opens the pile panel in the Volumes tab and selects the pile. It does not switch to the Measure tab (`measureFollow.ts`). A kit pile click maps to its converted measurement through `origin.pile`. Esc clears the pile and returns to the Inventory; the stage hint reads "Esc clears the selection".

### Panel (right panel, Volumes tab)

- Top line: "‹ Inventory" back link; right "Pile 2 of 19" with previous and next arrows (order of the Inventory table).
- Title row: pile name (large, mono), material chip with a ▾ menu (the site materials plus "No material"), "Density [1.60] t/m³" input (writes the material's density from the date in focus, see section 6; with no material the field is disabled with "Pick a material first").
- KPI row of three tiles: **Volume** "11 378.7 m³" with the date "10 Jan 2021"; **Tonnes** "18 206 t" with "at 1.60 t/m³"; **vs 31 Dec** "−3 308.0 m³ · −22.5 %" (red for a loss, green for a gain; "first survey" when there is no earlier date; "preparing 62 %" while the earlier surface prepares, board 7).
- Facts row: Footprint "2 621.9 m²", Max height "11.32 m" (highest surface point above the base inside the pile), Base "Triangulated toe ▾" (the base picker).
- A carried, stale, partial or refused result shows its status line under the KPI row ("From an earlier version (kit …)", "Stale, recompute", the refusal reason). Figures never show without their status.
- Tabs: **Overview | Profile | History**.

### Overview tab

Status and method line, the cut and fill split, and a **More** disclosure holding the heat map controls, the swell figures (loose, compacted) and Weighed tonnage (today's `Calculators` and `HeatControls`). The tab keeps the panel short; nothing else from today's card shows by default.

### Profile tab (board 2)

- Chips: one per survey date shown ("31 Dec 2020 ×", "10 Jan 2021 ×", with the section 2 states) and "+ Date or design".
- Under the chips: "Shade cut & fill vs [31 Dec]" toggle on the left, "Line: long axis · 108.9 m" on the right.
- The shared `ProfileChart` (series per date, A and B ends, "Distance along the line (m)", "Elevation (m)", shading between the two dates).
- Facts under the chart: "Cut (whole pile) 4 403.1 m³", "Fill 19.6 m³", "Largest drop −2.96 m at 49 m".
- Actions: Open larger (the section window), Export PNG, Add to report.
- **The line** is the pile's long axis through its centroid, from edge to edge plus 5 % each side. In the scene it is a dashed line with A and B handles and a ↻ handle at the centre; the stage hint reads "Profile line · Drag A or B to move it · drag ↻ to turn it about the pile". The angle and ends are kept for the session, per pile; Add to report uses the current line.

### History tab (board 3)

- "Volume and tonnes over time" with a segmented m³ | t | Both.
- Bar chart, one bar per survey date with its value and the change in % over the later bar; axes "Volume (m³)" or "Tonnes (t)", "Survey date".
- Table: Date, Volume m³, Density, Tonnes, Change ("first" on the earliest). A pile whose kit figure was replaced shows the kit figure in a second line "was 14 690.2 · earlier version" (decision 4).
- Note: "Density 1.60 t/m³ for Aggregate 20 mm applies from 31 Dec 2020. A new density takes effect from the date you choose in Materials; earlier dates keep the tonnes they had."
- Actions: Export CSV, Add to report.

### Strip

While a pile is selected the dates strip shows that pile (section 5) with a "Pile 02 ×" chip that clears it.

## 4. Linked hover between chart and scene (boards 8 to 11)

### What is linked

A profile chart and the line it was drawn along: the pile profile, the line cards (distance, grade, vertex table, berm check, section), the cross-section dock and window, and the kit's section line panel. In Split, both panes take part.

### Chart to scene (board 8)

Hovering the chart moves a marker on the line in 3D and on the Map:

- one dot per shown survey on that survey's surface at the chainage, in the survey's chart colour (the earlier survey a hollow ring, the date in view a filled dot);
- a dashed vertical gap between the dots when they differ by more than 0.05 m;
- a soft ellipse on the ground under the dot of the date in view;
- the stretch of line from A to the point highlighted in the accent colour;
- a tag "42.3 m · −1.63" (chainage, then the difference later minus earlier in m, red for cut, blue for fill, none with one survey).
- A stage hint at bottom-left: "Following the chart" with a legend "10 Jan surface · where 31 Dec was · A to here".

The chart readout shows "Chainage 42.3 m", each date's elevation and "Δ −1.63 m cut" (or "fill").

### Scene to chart (board 9)

Moving the pointer within 12 px of the line in 3D or on the Map snaps to the line, shows the same marker and drives the chart crosshair. Stage hint: "Pointer on the line · snapped to 64.0 m" with "10 Jan · 31 Dec · the chart follows on the right". Card footer: "Hover the chart or the line: the point follows in both. Click to pin, double-click to fly there."

### Pin and fly (board 10)

- A click on the chart or on the snapped line pins the point: the chart shows a solid accent crosshair with a pin badge and "71.0 m · pinned", the scene shows a pin above the marker. The pin holds while the pointer moves away.
- Esc, or a click on the chart or line elsewhere, clears the pin (a click elsewhere pins the new point).
- Double-click on the chart or the line flies the camera (3D) and the map to the point.
- Near the toe both dots meet and the tag reads "+0.02".

### Split (board 11)

3D and Map panes and the chart move together: "One point, three places: 3D, Map and the chart move together". Each pane keeps its own date when the panes differ; the dots follow the chips.

### The larger section window

The section window no longer covers the stage with a scrim: it is a non-modal panel over the lower part of the stage (Esc closes it), so the marker stays visible above it. The section dock closes when its measurement is unfocused or deleted and has a visible close button (today it can stay stuck over the stage).

## 5. One date control and the dates chart strip (boards 1, 6)

### One date control

The notch date (`IslandDate.tsx`) is the only date control. The Volumes tab's kit controls (31 Dec / 10 Jan / Swipe, Surface colours, bodies and the section line button, `VolumesBench.tsx:30-37`) are removed, and the notch's Volumes row (`groups.tsx` `KitVolumeRow`) loses its date and Surface choices. That row keeps the rest: a Swipe toggle, the volume bodies (Lifted, In place, Hidden) and "Section line between the surveys". The boards' ⋯ is the notch chevron that opens these tools. The strip's playhead, markers and arrows also move the notch date; Split keeps its per-pane dates.

### The strip

Shown under the stage for a project with two or more survey dates. Bar (30 px), left to right:

- Play (aria "Play through the survey dates") or Pause; ‹ "Previous survey", › "Next survey"; speed "1×" (cycles 0.5×, 1×, 2×, 4×); Loop toggle;
- mode segmented **Volume | Tonnes | Cut & fill**; legend by material colour (Volume and Tonnes) or "Fill above zero · Cut below zero · inside piles" (Cut & fill);
- right: **Compare** toggle, Fit ("Fit to the compare range", or "Fit to all surveys" during playback), Collapse ("Collapse the timeline").

Chart (130 px):

- x is true time; month gridlines labelled "Dec 2020"; a vertical marker per survey labelled with its date; the date in focus highlighted.
- **Volume** and **Tonnes**: stacked area by material, in material colours, straight between survey points. **Cut & fill**: diverging bars between consecutive surveys, fill up and cut down, labelled "+1 227 fill" and "−22 598 cut", using the Cut & fill tab's area rule and threshold.
- Y axis with three ticks ("80k", "40k", "0") and a title "Volume (m³)", "Tonnes (t)" or "Change (m³)".
- **Playhead** on the date in focus, draggable; it snaps to the nearest survey on release. Its readout card: "10 Jan 2021", "63 402 m³ · 100 255 t", "Δ −12 797 m³ · −16.8 %", "vs 31 Dec 2020".
- **Compare band**, when Compare is on: a shaded band from the compare From date to To with brackets at both ends (drag a bracket to another survey) and its label "31 Dec → 10 Jan · −12 797 m³". From and To are the same pair as the Cut & fill tab's.
- **A selected pile**: the pile's line on its own scale over the site total faded on its own scale ("site total (own scale)"), a "Pile 02 ×" chip and "Site total, faded" in the bar.
- **Dates still preparing**: a hatched marker "preparing · 62 %" and "Change: waiting for 31 Dec" in the readout (board 7).
- **Collapsed**: only the 30 px bar, remembered per project.
- **Material draft preview** (board 5): while a density edit is unsaved, the Tonnes figures use it and the bar says "· preview, unsaved".

### Coexistence with the video timeline

The strip and the footage timeline (`WorkspaceTimeline`, `WorkspaceLanes`) share the bottom slot (`.tl-wrap`).

- No video: the strip is the bottom timeline when the project has two or more dates. The View tile's timeline toggle shows and hides it.
- Video and two or more dates: a two-way switch at the left of the bar, "Dates | Footage", remembered per project. The default is Dates when the project has volume measurements and Footage otherwise. The footage timeline keeps its own clock and player; the strip's player is separate and only moves the date in focus.
- The strip's region is labelled "Survey dates chart", never "Timeline", so specs that look for the footage timeline are not confused.

### Timelapse (board 6)

- Play steps the playhead through the surveys; each gap between consecutive surveys takes 2 s at 1×. Loop restarts from the first survey.
- The notch shows "Playing · 5 Jan 2021" (the playhead's calendar date) and no arrows.
- A float at the bottom-left of the stage: the two dates with a blend bar ("31 Dec" and "10 Jan blend 55 %") and "Between surveys" segmented **Crossfade | Swipe | Hold**.
  - Crossfade: the Map shows both orthos with opacities 1 − f and f (f is the fraction of the gap); the 3D view swaps surfaces at the midpoint.
  - Swipe: a vertical swipe at f (the kit's swipe; offered only where the kit's swipe exists, else the choice is hidden).
  - Hold: the earlier date until the playhead reaches the next survey.
- A float at the bottom-right: "Site total", one row per survey with its volume, and "Figures change only at survey dates".
- The sidebar Survey dates rows read "fading out" and "fading in"; the Stockpiles rows and the Volumes tab show the last survey passed, with the header "31 Dec 2020 · last survey passed", a "Next survey −12 797 m³ on 10 Jan" tile and the note "During playback the panel shows the last survey the playhead passed. Nothing is interpolated between surveys."
- Any manual date change, a pile click or Esc stops playback.

### Pile figures follow the date in focus

**Cause found:** sidebar rows (`measureRows.ts:75` `primaryText`), Volumes pile cards (`cardModel`) and the scene labels (`measureScene.ts:168,187` `labelText`) all read `m.results[0]`, the single stored result, whatever the date. For converted kit piles that is the last epoch's carried figure (`kitPiles.ts:298-345`), and `computeSeries` skips carried items, so every date shows the same number. The per-date figures exist (`pileSeries`, `bulk.ts:153-174`) and the inventory uses them, which is why totals differ. `BulkTotals` is given `stack.at(-1)` (`VolumesView.tsx:286`), so it always shows the latest date.

**Fix:** one helper gives a pile's figure on a date (the stored result when it is that date's, else the series row, else none), and rows, labels, cards, the panel and the totals all use the date in focus.

### Stockpiles in the sidebar

Piles no longer sit under "Needs a date". Site-scoped volume measurements (kit piles included) go in a project-level group **Stockpiles** placed after the survey dates: header "Stockpiles 19 · 10 Jan" (count, date in focus); rows "Pile 02 · 11 378.7 m³" sorted by volume on that date, largest first; the first ten shown, then "+ 9 more". In Cut & fill the header reads "Stockpiles 19 · net change" and rows show the net change, most lost first; in Materials the header is "Stockpiles by material 10 Jan" with one row per material and its pile count. "Needs a date" keeps only measurements that truly have no date.

## 6. Volumes tab (boards 1, 4, 5)

### Header (board 1)

"Stockpile inventory", under it "10 Jan 2021 · drone survey" (date in focus and its source), Export on the right. KPI tiles (1.25fr 1fr 1fr): **Volume** "63 402.1 m³" with "19 piles"; **Tonnes** "100 255 t" with "by material"; **vs 31 Dec** "−12 797 m³ · −16.8 %". Then the segmented **Inventory | Cut & fill | Materials**.

### Inventory (board 1)

- Caption "Grouped by material · standard base" and on the right "Δ vs 31 Dec 2020".
- Columns: Pile, Volume m³, Tonnes, Δ m³.
- One group per material (largest volume first), its row shows the colour swatch, name, density "1.60 t/m³" and subtotals; then its piles, largest first, up to four, then "+ 2 more" which expands. Piles with no material form "No material" (tonnes "-").
- Last row "Site total".
- A row click opens the pile panel.

### Cut & fill (board 4)

- From "31 Dec 2020 ▾" → To "10 Jan 2021 ▾" (defaults: the survey before the date in focus, and the date in focus), Export.
- Segmented **Inside piles | Whole site**; "Ignore under [0.10] m" (aria "Ignore height changes smaller than, in metres").
- KPI tiles: **Cut** "22 597.7 m³ removed", **Fill** "1 226.9 m³ added", **Net** "−21 370.8 m³ · 19 piles".
- With Inside piles, a line "Whole site: cut 24 297.1 · fill 2 098.8 · net −22 198.3 m³".
- "By pile" diverging bars, header "cut ◂ │ ▸ fill · net m³", sorted by net (most cut first), pile label "P05" and net value; up to 13 bars, the rest folded into "+ 6 piles within ±35 m³" (the largest folded |net|, rounded up).
- Note: "Surface to surface between the two surveys. The inventory change (−12 797 m³) is smaller because each date measures its piles above their own base."
- Stage: Show switches to Cut & fill, the heat map draws for the pair; bottom-left legend "Height change 10 Jan minus 31 Dec", ramp "−2.0 m cut", "±0.10 m ignored", "+2.0 m fill"; bottom-right hint "Click a pile to see its change"; pile labels "P02 −4 384". The notch shows "31 Dec → 10 Jan 2021"; the sidebar date rows read "compare · from" and "compare · to".
- Figures: inside piles, one surface-to-surface comparison per pile ring with the threshold as deadband; whole site, the engine's site comparison with the same threshold.

### Materials (board 5)

- "Materials and density" with "+ Material".
- Table columns: Material (colour swatch, name), t/m³ (input), Swell (input, the loose factor), Piles, m³, Tonnes; "All materials" totals row.
- Selecting a row opens its editor below the table:
  - title "Aggregate 20 mm" and "Unsaved change" while edited;
  - "Density 1.60 → [1.62] t/m³ from [10 Jan 2021 ▾]";
  - History: "from 10 Jan 2021 · 1.62 t/m³ · new", "from 31 Dec 2020 · 1.60 t/m³ · kept for 31 Dec";
  - impact: "Tonnes on 10 Jan go from 63 910 to 64 709 t. 31 Dec stays at 75 358 t. Volumes do not change.";
  - "Piles of this material" chips with × (unassign), "Assign piles…" (a checklist of piles; a pile has one material);
  - Cancel, Save.
- Import CSV and Export CSV (today's materials dialog columns) move here; the dialog is retired.
- Stage: "Colour piles by" segmented **Material | Change | None** at top-left; legend by material bottom-right; piles tinted by material colour.
- A density "from" a date applies to that survey date and every later one until the next entry; earlier dates keep their density. The first edit of a material that had one density keeps it as the entry from the earliest survey date.
- Colours: a material without a colour takes the next colour of a fixed categorical palette of eight design tokens.

### One Show control (board 1)

Top-left of the stage while the Volumes tab is open: caption "Show", segmented **Photo | Elevation | Cut & fill**, and a second segmented **Outlines | Labels** (independent toggles; Outlines has the material swatch). It replaces the Surface colours group in the Volumes bench and in the notch's Volumes row. On the Materials pane it reads "Colour piles by" **Material | Change | None** instead. Elevation shows the date's DSM colour ramp; Cut & fill shows the heat map for the compare pair. Without the Volumes tab open the stage shows no Show control.

### Fixes folded in

- **Charts:** the y-axis title no longer runs off the left (title drawn above the axis inside the padding, padding sized to the widest tick label); x labels are thinned to at least 56 px apart; the chart sizes to its container (no scrollbars). Inventory stacks use material colours.
- **"Total" means one thing:** a pile's headline is its net volume everywhere. The card row that showed `totalM3` (fill plus cut) is relabelled "Cut + fill"; `BulkTotals` sums net.
- **Base names:** the kit's `tin` base reads "Triangulated toe", as the engine's smart base does.
- **Headline honesty:** the headline readout (`readout.ts:280-285`) shows the status of carried, stale, partial and refused results; live cards show the status chip (`MeasureCard.tsx:87`).
- **Kit legend** uses the project's units and the survey heat map colours (`VolumetricStage.tsx:95-98`, `dsm.ts:81-88`).
- **Area cards** show material, swell and weighed tonnage only for volume measurements.
- **i18n:** "Swipe" (`VolumeTools.tsx:66`), "Section line between the surveys" (:209), "Swipe between surveys" (`VolumetricStage.tsx:68`) and every string in touched files go through `packages/ui/src/i18n/en.ts`.

## Contracts

- `MeasurementsFile.kitHeightsRepaired?: string[]` (ids, max 5000).
- `Settings.autoPrepareSurfaces?: boolean` (absent means on).
- `SiteMaterial.colour?: string` (`#rrggbb`) and `SiteMaterial.densityHistory?: { fromCapture: SurveyId; tPerM3: number }[]` (max 100, unique `fromCapture`). `densityTPerM3` stays and is written as the latest entry's value, so older builds show the current density.
- No other schema change. The hover and pin store, the strip's player and the pile line are renderer state.

## Non-goals

- Calibrate from weighbridge, live machine data, estimating figures between surveys.
- A new volume method or base. The standard base is today's smart base.
- Persisting the pile profile line's angle in the project.
- Changing the footage timeline or its lanes.

## Anti-goals

- A figure shown without its status, or a date's figure shown on another date.
- A heavy job started without the setting, without a way to cancel it, or in a read-only project.
- The repair touching a pile a person edited, or writing in a read-only project.
- A floating control covering the view at 1100 x 700.

## Tests (expected)

- Unit: heights at conversion and repair (all-zero rule, origin 0, edited piles, flag, idempotence, holes); map fallback order; surface states per date; auto-prepare start rules (setting, cancel, read-only, no Python, no source); acceptance runs once and keeps "was"; pile long axis and rotation; hover store and chainage snapping; ProfileChart controlled crosshair, pin, fly; figure on a date; density on a date; inventory by material; cut and fill per pile with threshold and folding; strip scales, ticks, playhead snapping, compare band, playback timing and blend fraction.
- e2e: kit heights on a converted project; surfaces prepared on open; pile panel from 3D, Map and list; linked hover both ways, pin, fly, Split; dates strip and timelapse; Volumes tab Inventory, Cut & fill, Materials with a dated density. Existing specs updated where the Volumes bench, Surface colours group and materials dialog moved. All run the CI way (1100 x 720, scale 1, WARP, off-screen windows, one worker).
