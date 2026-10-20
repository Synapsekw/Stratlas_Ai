# Volumetric surveying on par with Propeller and DroneDeploy (design)

Draft, 20 Oct 2026, for the founder's review. Branch `feat/volumetric-parity`. This came out of a brainstorming session that included:

- a code audit of volumes, surfaces, accuracy and reports
- web research on what Propeller Aero and DroneDeploy offer
- a UI audit of every volumes surface
- an audit of every measurement tool

Two mockups were approved in the session: profile chart option A and the shared measurement card. Both are described below so this document stands alone.

## Why

The founder wants Quadrion's volumetric surveying to be on par with Propeller and DroneDeploy, and wants the UI to feel as clean and clear as Propeller's. Their example: "a nice chart that shows the elevation, and in this chart I can also add other survey dates as well as design profiles."

The audits found that the **engine is close to parity and the experience is not**. We already have:

- two working volume engines with automatic pile detection
- cut/fill against designs, earlier surveys and five kinds of base
- LandXML, DXF, 12da and CSV design import
- density, tonnage and swell
- sections, contours and heat maps
- GCP and checkpoint accuracy
- haul-road checks, PDF and CSV reports, and survey exports

What holds us back:

1. **Four chart implementations, none of them good enough.**
   - Where they are: `survey/SectionChart.tsx`, `packages/volumetric/src/components/ProfileChart.tsx`, `sectionChart()` in `reportPage/house/survey.ts`, and the small SVG in `survey/ElevationHistory.tsx`.
   - What's wrong:
     - No hover readout, no legend in the app, and no axis units.
     - Colours follow the order surfaces were ticked (`SECTION_COLOURS`), so "design" or "previous" never has a fixed look.
     - Shading is chosen from an n×(n−1) dropdown.
     - The stockpile chart shows only the first and last date.
2. **Five result layouts for measurements.**
   - The layouts: the generic `MeasurementPanel.tsx`, the section dock, the telecom card, elevation history (hidden in Survey QA) and the volumes bench.
   - Four separate measure code paths:
     - the survey tools
     - `road/useRoadMap.ts`
     - `packages/globe/src/measure.ts`
     - a dormant `'measure'` tool in `packages/engine/src/stage/Stage.ts`
   - Several places format values themselves and skip `formatQuantity`.
   - Only polygons can be compared against another date or a design.
   - Saved style fields (fill, fill opacity, border width) are never drawn.
   - There is no "add to report" and no export of a single measurement.
3. **Two volume stacks that disagree.**
   - The stockpile kit (`packages/volumetric`, `python/src/aio_pipelines/volumetric/`) and the M11 survey engine (`packages/survey/src/engine/`, `python/src/aio_pipelines/survey/`).
   - They use different base names, different units handling and three different cut/fill colour sets.
   - The kit's `tin` base and the engine's `smart` base give different numbers for the same pile (`docs/KNOWN-LIMITS.md` ~:312).
4. **Jargon and debug output in front of users:**
   - In `Comparison.tsx`: "deadband", "Not covered", "Exact (triangulated)", and a raw "N ms" timer.
   - In `VolumesPanel.tsx`: "Survey error", "Spread across bases" and "Recomputed here".
   - In `Cleanup.tsx`: TIN and thin-plate.
5. **Volume over time** is limited to two dates for stockpiles, with no trend chart.
6. **Accuracy is what Propeller sells, and our story is thin.**
   - PPK accepts only a ready-made CSV of positions.
   - No geoid grid ships (`KNOWN-LIMITS.md` ~:297).
   - Volumes carry no ± figure.
7. **Smaller gaps** (TTM and IFC later dropped, see W7):
   - TTM and IFC design formats.
   - Reports that rebuild themselves for each new survey.
   - Automatic pile detection is checked on synthetic piles only.
   - The assistant reads only the kit's `volumes.json`.

## Goals

Three waves, in the order the founder set ("UI first, then accuracy"). Each wave is several branches. The plan sets the exact split and the dependency graph.

### Wave 1: what customers see

**W1. One profile chart, used everywhere.** This is approved mockup option A.

- **One component** replaces all four charts:
  - the cross-section dock and window
  - the pile detail in the volumes view
  - elevation over time
  - the PDF report, as a static SVG render of the same component
- **Surfaces are chips.**
  - The current survey is on by default.
  - "+ Add survey or design" adds any other survey date, any design surface, and a pile's base where one applies.
  - Clicking a chip turns it off; removing it takes it off the chart.
- **Fixed styles by kind, not by order:**
  - The current survey is a solid line in the accent colour.
  - Earlier dates are grey and get lighter the older they are.
  - Designs are dashed, in a distinct design colour.
  - The base is dotted.
  - The colours come from new chart and cut/fill tokens in `packages/ui/src/tokens.css`, with values for both the dark and the light theme. One cut/fill colour pair replaces the three in use today: `section.css`, `ProfileChart.tsx` and `packages/volumetric/src/components/styles.tsx`.
- **Shading:** a "Shade vs" segmented control lists only the surfaces currently shown (for example "05 Oct | Design"). It shades cut and fill between the current survey and the chosen one. Cut and fill section areas sit under the chart.
- **Hover:** a vertical crosshair, with a readout of:
  - chainage
  - each visible surface's elevation
  - the difference from the shading target
  - the local grade
- **Click-to-pin** stays.
- **Axes:**
  - elevation and chainage labels with units, through the project's units settings
  - an "A → B" direction label
  - a vertical exaggeration note (the existing 1:1 to 1:20 setting stays)
- **Export:** PNG, DXF and CSV, plus "Add to report". The five DXF variants in `sectionStore.ts` `FORMAT_LABELS` move into one export dialog with a format choice. The chart's toolbar shows only the three formats.
- **Later, not in W1:** B's difference strip and grade band, which were shown as option B. They can come back as an optional "Analysis" toggle for haul-road and design work, built on the same component.

**W2. One measurement family (the shared card).** This is the approved mockup.

- **Every measurement type** uses one card component, in three places:
  - the live card while drawing (header, primary value, secondary line)
  - the detail panel (everything)
  - the report (primary value, secondary line, chart)
- **The card's parts, in order:**
  1. **Header:** type icon (one per tool, not per family), editable name, date (scope) chip, colour swatch, overflow menu.
  2. **Primary value:** one large number. A per-tool primary key feeds the card, the Datasets tree row, the map and 3D labels and the island. Today two pickers decide this (`measureRowValue` and `liveReading`/`labelOf`); they become one.
  3. **Secondary line:** one compact line, for example "Horizontal 140.9 m · Height +21.4 m · Grade 15.2 %". The full readout table sits under "More".
  4. **Surface and date chips:** the same chip control as W1. They drive the comparison values: terrain length per surface, terrain area per date, Δ elevation to a chosen design or date, and from/to for volumes.
  5. **Chart slot:**

     | Measurement                                                      | Chart                                                                     |
     | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
     | Lines (distance, grade, berm, vertex differences, cross-section) | W1's profile chart                                                        |
     | Points                                                           | elevation over time; elevation history folds in here and leaves Survey QA |
     | Volumes                                                          | volume over time (W4)                                                     |
     | Area                                                             | none                                                                      |
     | Telecom and freehand                                             | none                                                                      |

  6. **Detail slot:** vertices, the vertex table, template fields, calculators and material.
  7. **Actions**, the same on every card: rename, colour (one palette), notes, hide, fly to, export (CSV, DXF, PNG where a chart exists), add to report, delete.
- **Chips by type:**

  | Type                                          | Chips                            | Chart                   | Extras                |
  | --------------------------------------------- | -------------------------------- | ----------------------- | --------------------- |
  | Elevation / elevation difference / annotation | yes (Δ to the chosen surface)    | elevation over time     | coordinates           |
  | Distance / grade                              | yes (terrain length per surface) | profile                 | vertices              |
  | Vertex differences                            | optional                         | profile                 | vertex table          |
  | Berm check                                    | yes                              | profile with berm marks | side table            |
  | Cross-section                                 | yes (several)                    | section chart           | pins                  |
  | Area                                          | yes (terrain area per date)      | none                    | perimeter             |
  | Volume                                        | from/to and base                 | volume over time        | calculators, material |
  | Azimuth / tilt / clearance                    | no                               | none                    | picks                 |
  | Freehand                                      | no                               | none                    | none                  |

- **Every value goes through `formatRow` / `formatQuantity`.** That includes:
  - live points
  - the section-plane offset
  - elevation history
  - the volumes view (`packages/volumetric/src/components/format.ts`)
  - the 3D cursor (`SceneCursor.tsx`)
  - vertex-table bearings
  - telecom angles

  Angles get an angle unit in the units settings. Today they are always 2-decimal degrees, and bearings always DMS.

- **One colour palette:**
  - The right-click swatches and the panel picker use the same palette.
  - The stored fill, fill opacity and border width are actually drawn on the map and in 3D (`survey/measureScene.ts`).
  - The map shows labels: name and primary value.
- **One measure code path:** _my call._
  - The road map measure and the globe measure are rebuilt on the survey tools' maths, formatter and card look.
  - In a project with surveys, a measurement taken on the road map can be saved like any other.
  - The globe has no project surfaces, so its measurements stay temporary: the card's header, value and secondary line, with no chips, chart or saving.
  - The dormant engine `'measure'` tool is deleted.
- **Builds on what exists:** the Datasets tree, folders and the right-click menu from `2026-10-18-measurement-layers-design.md` (the left sidebar holds what the project contains; the right workbench holds the tools). "Add to report" and "Export" join the measurement actions in the shared action registry.

**W3. One volumes engine, in plain language.**

- **The survey engine is the only engine** that computes volumes.
  - The stockpile kit's automatic pile detection and floor finding stay as a pipeline step. Their output becomes volume measurements that the survey engine computes, so a pile is just a volume measurement in the Datasets tree, with the W2 card.
  - The kit's own base computation and the kit volumes UI retire: `VolumesPanel.tsx`, `ProfileChart.tsx` and the kit register.
  - Inventory totals and the CSV register come from the engine (`BulkTotals`, `surveyCsv.ts`).
- **Default base: a triangulated surface through the pile's toe** ("Triangulated toe", the engine's `smart` base). _My call, at the founder's request ("pick what is best practice")._ It is the surveying norm for piles on uneven ground and the base Propeller recommends. One implementation, the engine's, so one pile always shows one number.
- **Each other base gets a one-line plain explanation** in the base picker:

  | Base                      | When to use it                                                   |
  | ------------------------- | ---------------------------------------------------------------- |
  | Lowest point              | bins, bunkers, piles against walls                               |
  | Best-fit plane            | a flat, level pad                                                |
  | Fixed level               | a known floor height                                             |
  | Previous survey or design | the measured ground underneath, the most accurate when it exists |
  | Custom                    | edit the base's points                                           |

- **The spread across bases** shrinks to one hint on the card ("±1.8 % across bases"), not a list of competing figures.
- **Plain words** replace the jargon. For example:
  - "deadband" → "Ignore changes smaller than"
  - "Not covered" → "No survey data"
  - "Exact (triangulated)" → "High precision"
  - TIN / thin-plate → "Fill gaps: straight / smooth"
  - The debug timer is removed.
- **Fewer, clearer messages.** The five kinds of status notice in `Comparison.tsx` become one clear status line.
- **Every empty state** in the survey and volumes views uses `@aio/ui` `EmptyState`.
- **The heat map gets a proper legend:** a colour bar with values and units, plus a small histogram. The colour-stop editor (`HeatmapStops.tsx`) moves behind an "Edit colours" action.
- **Volume tools' "Cut / fill" surface** (`workspace/VolumeTools.tsx`) uses the same from/to picks instead of always comparing the first and last survey.
- **Existing projects open with their numbers intact.** _My call._
  - Each old pile becomes an engine volume measurement. Its stored kit figure and base are carried over as a stored result labelled "From an earlier version (kit <base>)", so a package in player mode, or a project without height tiles, still shows exactly what it showed before.
  - Nothing is recomputed silently. Where the surfaces exist, the card offers "Recompute with the standard base". When the user accepts, the new figure replaces the old one, and the old figure is kept in the measurement's history ("was X m³").
  - The kit's membrane base has no engine equivalent, so it isn't carried forward as a live base, only as that stored result.

**W4. Volume over time.**

- A volume measurement, and any comparison, can be computed for **every survey date** in the project, not just two.
- **How it's computed and stored** (_my call_):
  - Computed on demand, when the chart or report needs a date, then stored per date with the existing input fingerprint, so a stale date shows "Stale, recompute".
  - Both executors must do it. TypeScript is needed for the app and the report; Python for the pipeline and the parity fixtures (ADR 0009).
  - The stored per-date results are a contract change.
- **The card's chart** shows volume per date, with the latest date highlighted.
- **A table** gives each date's volume, the change since the previous date and the tonnage.
- **Site inventory over time:**
  - all piles or a folder, as a stacked total
  - shown in the volumes view and in the report
- **Report and CSV:** a "Volume over time" section and an export with one row per measurement and date. This replaces the first-vs-current-only output in `surveyCsv.ts` ~:354.

### Wave 2: accuracy

**W5. PPK from raw files.**

- **Inputs:**
  - the drone's raw GNSS log and timestamps (DJI `.obs`/`.bin` and `.MRK` first)
  - a base station RINEX file, with base coordinates typed in or read from the RINEX header
- **The pipeline** works out corrected camera positions and feeds them into alignment, where `photo/align.py` ~:726 already accepts a positions CSV.
- **Engine:** a prebuilt RTKLIB (`rnx2rtkp`, or the demo5 fork) shipped in the pipeline pack. This is _my call_: RTKLIB is the standard open engine, and the founder's licence rule allows prebuilt binaries.
- **Results report:**
  - fix rate (fixed / float / single)
  - an estimated accuracy per photo
  - a warning when the fix rate is low
- **Folded into the W6 accuracy summary.**

**W6. Heights you can trust and a ± on every volume.**

- **Geoid:**
  - Ship EGM96 and EGM2008 grids in the pipeline pack, wired into the existing PROJ pipeline (`geodesy/site.py`).
  - The site's vertical datum is chosen once. Exports state it (they already state CRS, datum and units).
- **Accuracy summary per survey.** One card that says:
  - how the survey was positioned: RTK, PPK, GCPs or a mix
  - checkpoint RMSE (horizontal and vertical; it already exists in `photo/accuracy.py`)
  - the W5 PPK fix rate
  - the Survey QA verdict (`survey/qa.py`)

  It appears in the survey's properties and at the top of the report.

- **± on volumes.**
  - Each volume shows a ± figure computed from the survey's vertical accuracy. The vertical accuracy is taken from the first of these that exists (_my call_):
    1. checkpoint vertical RMSE
    2. the W5 PPK solution's per-photo vertical standard deviation
    3. the RTK standard deviations in the drone's metadata or `.MRK` file
    4. a value the user types in the survey's accuracy card
  - With none of these, no ± is shown. The card says "Add checkpoints or a stated accuracy to see ±". It never shows an assumed default.
  - This adds a survey-level vertical accuracy, with its source, to the survey record: a contract change.
  - It treats the vertical error as a systematic offset over the measured area, which is the conservative term that dominates for piles, plus a random term per cell.
  - The exact formula is the builder's, written up in an ADR. It must be the same in the Python and TypeScript executors (ADR 0009 parity fixtures).
  - The base-spread hint (W3) is shown separately from this ±.
- **Readiness for real-job validation:**
  - a small script or command that compares our volumes with figures from elsewhere (Propeller, a surveyor's numbers, weighbridge tonnes) and prints the differences
  - the founder runs it later on their own projects

### Wave 3: rounding out

**W7. Design formats: dropped for now** (founder, 20 Oct 2026). The M11 decision stands: no TTM or IFC, because neither has a public specification. Customers export LandXML or DXF from their design software. W7 is left empty so the numbering stays stable.

**W8. Repeat reports.**

- **A site report template:** a saved choice of sections, measurements, charts and order.
  - One per project, stored in the project file, so it travels in `.aio` exports (_my call_).
  - Its storage format, and the "Add to report" action that writes to it, land in Wave 1 with W1 and W2, so that action isn't held back. W8 adds the rebuild and the template editing.
- **When a new survey is added,** the report rebuilds for it from the template as a preview, offered as "Report for 20 Oct is ready". The user exports the PDF. Nothing is written or sent on its own.
- This is the desktop version of Propeller's scheduled reports.
- "Add to report" (W1, W2) adds to the site template.

**W9. AI.**

- **Check automatic pile detection and "Suggest boundaries" (MobileSAM) on real piles.** Today they are checked on synthetic piles only. Record the results and fix what fails.
- **Give the assistant survey-engine tools.** It can list measurements, read a measurement's values over time, run a volume with a chosen base and read a section profile. These are the planned `survey_volume`, `section_profile` and `list_measurements` tools, which were never built.

## Non-goals

- **Browser links, web sharing and integrations** (Procore, Autodesk, Trimble Connect). Clients receive the PDF report or the exported `.aio` project and open it on their side (founder).
- **Live machine data**, like Propeller's DirtMate. Later (founder).
- **Real-job validation runs.** The founder runs these later on their own projects. W6 only gets the tool ready.
- **Our own GCP hardware**, like Propeller's AeroPoints.
- **The analysis strips from mockup option B**: the difference strip and grade band. Possible later on the same chart.
- **New volume maths.** The engine's cut/fill, bases and coverage rules stay as they are. W3 changes which engine is used and how results are shown, not how they are computed.
- **DWG, TTM and IFC designs, and machine-control file export.**

## Anti-goals

These would make the work a failure even if it technically works:

- A pile showing two different volumes anywhere in the app or the report.
- A value on screen that ignores the project's units settings.
- Any of the four old charts or five old result layouts left alive beside the new ones.
- An existing project that opens with a missing or silently changed volume.
- New surfaces that look different from the rest of the app. The founder said: "make sure the design matches the rest of the UI".

## Constraints

- **Match the rest of the UI.** Build on the UI foundation work (`2026-10-16-ui-foundation-design.md`): its tokens, the `@aio/ui` parts (`EmptyState`, `Chip`, `Tabs`, `Popover`, `Menu`, `Row`, `Tip`, `Icon`), spacing and type scale, and the shell and stage layout (`2026-10-16-stage-island-design.md`).
  - New colours are tokens with values for both themes, and light-theme contrast meets the foundation's rules.
  - UI work loads the `impeccable` and `frontend-design` skills first (CLAUDE.md).
- **The measurement layers design** (`2026-10-18-measurement-layers-design.md`) stays the model for the tree, folders, visibility and right-click. W2 extends it and does not replace it.
- **Two executors, one spec (ADR 0009).** Anything that changes a computed figure has Python and TypeScript implementations held together by parity fixtures. That includes W3's switch to one engine, W4's multi-date run and W6's ±.
- **Offline desktop.** Nothing needs a network connection.
- **Contract changes** (project file formats, measurement and volume records, pipeline params) get a row in `docs/architecture/contract-changes.md`. A pipeline-pack change bumps the pack version and its `APP_RANGE`.
- **Windows only** for now (macOS parked).
- **Tests and e2e** follow CONTRIBUTING.md:
  - `pnpm check` must be green.
  - Changed e2e specs are run the way CI runs them.
  - Local runs are light: one Playwright run at a time, `--workers=1`, off-screen windows.
- **Public repo:** no client, site or tester names in docs, notes, fixtures or screenshots.

## Decided

**By the founder:**

- Everything found in the audits is in scope, except live machine data (later).
- Profile chart option A.
- The shared measurement card, as mocked up.
- Every other measurement is unified along with the profile chart.
- No browser link: the PDF report and the `.aio` export are enough.
- Positioning is a mix of RTK, PPK and GCPs, so all three are supported.
- Real-job validation comes later, on their own projects.
- UI first, then accuracy.
- The design must match the rest of the UI.

**My calls:**

- The default base is the triangulated toe, the engine's implementation.
- The kit's base computation and volumes UI retire, while pile detection stays.
- Option B's strips are deferred.
- RTKLIB is the PPK engine.
- (Founder) TTM and IFC stay out; W7 is dropped.
- EGM96 and EGM2008 are the geoid grids.
- The ± is based on checkpoint RMSE (or the stated RTK/PPK accuracy) and shown separately from the base spread.
- Repeat reports are rebuilt on a new survey, not on a timer.
- The plain-language wording examples in W3.

## Left to the builder

- The exact component API and file layout of the shared chart and card, and how the report renders the chart statically.
- The token names and values for chart series and cut/fill, within the foundation's rules.
- The plain-language wording beyond the W3 examples.
- The ± formula's details (in an ADR) and the PPK input formats beyond DJI.
- How the work splits into branches inside each wave, and the dependency graph. W3 should land with or before W2's volume card. W1 is the base for W2's charts.

## Plan depth

_My call._ The first plan covers Wave 1 (W1–W4, plus the report-template storage) in full. Waves 2 and 3 are planned in outline and get detailed plans when Wave 1 lands, after their research spikes (DJI raw log decoding, RTKLIB on Windows).

Wave 1's contracts are designed now with the later waves in mind, so nothing has to be undone:

- the volume record has room for a ± and its source
- per-date results are stored
- the survey record has room for its vertical accuracy
