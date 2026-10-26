# Analysis: how the sections fit together

Date: 26 Oct 2026. Status: draft for founder approval.

This is the umbrella design for the analysis work. It settles where each kind of analysis lives, how a person moves between them, how project types pick the tools, and how every finding reaches one report. The sections themselves (thermal, point cloud segmentation, the industry tools, the report centre) each get their own design and plan after this one; this document fixes the frame they plug into.

## Why

The app's users are inspectors and surveyors working on oil and gas sites, solar farms, telecom towers and construction sites. At the end of a job they hand the client a report and exports. The founder's goal: **every job finishes in this app**, from the raw data to the client's report, with no other program.

Today analysis is spread out, and each part was built on its own:

- **Inspect** (`apps/desktop/src/renderer/screens/Inspect.tsx`, landed 24 Oct) is a left-navigation screen for photos, 360s and clips: drawing findings, Ask AI and the review queue.
- **Thermal** (M1, #213) is a workbench tab (`workspace/workbench/benches/ThermalBench.tsx`) opened from a photo set or from Inspect. It works on single thermal photos with per-pixel temperatures, parameters and palettes. M2 to M4 (readings, hot spots, report) are planned in `docs/plans/2026-10-21-thermal-analysis.md` and not started. There is no thermal ortho.
- **Point cloud classes** can be viewed by colour and edited by hand in cleanup (box or lasso, Set class, undo; `renderer/pointcloud/CleanupHost.tsx`). Ground classification is rule-based (PDAL SMRF/CSF). There is no AI segmentation and no PyTorch runtime.
- **Volumes, change detection, the engineering model and antenna flagging** live in the 3D scene.
- **Reports** have a per-project template (`main/reportTemplate.ts`, `aio.report-template/1`) built for the volumetric report.

## Goals

1. **Start from the place.** A job starts on a spatial view: the ortho map for a solar farm, the point cloud for a telecom tower. Construction and oil and gas use whichever fits the site.
2. **Click a spot and the evidence opens.** Clicking a spot on the map, the thermal ortho or the cloud (a warm patch, an antenna) opens the photos that see that spot, thermal and visual together.
3. **One photo viewer.** Inspect's viewer and the Thermal bench become one viewer, with a thermal mode (palettes, temperature span, emissivity and the other parameters, spot, line and area readings, hot spots) and a visual mode. Going from the visual photo to its thermal twin, or the other way, never changes screens.
4. **Analysis on the map and the cloud too.** Thermal readings and hot spots work on the thermal ortho as well as on single photos (solar needs both; towers, flare stacks and other vertical assets are analysed on single photos). Segmentation and hand correction of classes work on the cloud. These are tools in the scene, not separate screens.
5. **Every finding lands back on the place.** Wherever it was made (a photo, the ortho, the cloud, a measurement), a finding shows as a pin on the map and in 3D, and sits in one findings list.
6. **Project types pick the tools.** A project has one or more industry types (solar farm, telecom tower, oil and gas, construction, plus the existing survey and others). The ticked types decide which tools sit up front, which AI and segmentation classes are used, and which report sections are offered. Everything else stays reachable.
7. **One report, ours or the client's.** One findings list feeds every report. Each project type has a built-in report template; a client's own Word template (their layout and logo) can be filled from the same findings and exported as Word and PDF. Exports (classified LAZ, DXF, shapefile/GeoJSON, CSV) are chosen in the same place.

## Non-goals

- Building the sections themselves. Thermal M2 to M4 and the thermal ortho, point cloud segmentation, the solar layout, the telecom tower audit, oil and gas integrity, construction against design and the report centre each get their own design. This document sets the frame they share.
- New AI models or training in the app.
- Marking assets by place. Mixed projects are handled by ticking several types (below), not by drawing asset regions.
- macOS.

## Anti-goals (a failure even if it works)

- **Another separate screen per data type.** Thermal, segmentation and the industry tools must not each become their own island with their own findings and their own report.
- **Leaving the app to finish a job.** If a normal job for one of the four industries still needs Excel, Word editing or a GIS program to produce the deliverable, the frame has failed.
- **Losing Inspect's photo-list workflow.** Working through every photo in order and reviewing AI results in bulk stays, as a second way in.
- **AI results counting before a person accepts them.** Suggestions from any section (Inspect AI, thermal hot spots, segmentation) stay drafts until accepted, as Inspect does today. _Builder's note:_ segmentation is the exception in kind. Its result is a class per point, not a finding, and it is fixed by hand rather than accepted one by one (see Segmentation below).
- **Hiding tools behind menus or a project type.** A tool the type doesn't put up front is still reachable (the founder's 24 Oct rule for the right sidebar).

## Decided by the founder

- Users are inspectors and surveyors, in oil and gas, solar, telecom and construction. They deliver reports and exports.
- Solar: the inspector starts on the ortho, goes to the thermal photos, then the visual photos. Clicking a spot on the map opens the photos covering it.
- Telecom: the work starts on the point cloud.
- Thermal analysis on solar is done on the ortho and on single images; on other vertical assets it is done on single images.
- A thermal ortho is needed and must show as a layer.
- Thermal tools needed: emissivity and the other parameters, palettes, lines giving the average temperature, hot spots, a report.
- Point cloud segmentation like Pointcept, used for a clean ground model, measuring assets, and as-built against design. **Hand correction of classes is needed from day one.**
- All of these are wanted: thermal, segmentation, telecom tower audit, solar defects tied to the panel layout, oil and gas integrity, construction against design, one report and export centre.
- The project type covers most projects; a project can have several types ticked, and that is enough for mixed sites (no per-place sections).
- Clients sometimes have their own report template, as a Word document with their layout and logo; otherwise our report is sent.

## The frame

### Ways in

- **Map and scene first.** Opening a project lands on the scene: the ortho map or the cloud, whichever the project type leads with (solar and construction: the map; telecom: the cloud; oil and gas: the map, _my call_).
- **From a spot to the photos.** Clicking a point on the map, the thermal ortho, the mesh or the cloud lists the photos whose footprint or view covers that point, best views first, and opens the first in the photo viewer with its thermal or visual twin beside it. This reuses the photo positions and orientations we already store (pinned media, posed photos).
- **Inspect's photo list** stays as the second way in: all photos in order, filter chips, Ask AI on a selection, the review queue.

### The photo viewer

One viewer for visual and thermal photos. It is Inspect's `PhotoViewer` with the Thermal bench's tools moved into it as a thermal mode:

- visual mode: today's drawing tools and Ask AI;
- thermal mode: palettes, temperature span, parameters (per photo or applied to many), hover temperature, and the M2 readings (spot, line, box, polygon, isotherm);
- a view switch for Thermal / Visual / Blend / Side by side, from the M2 plan (`thermalTwin.ts`).

The Thermal bench's other uses (opening from a photo set, the filmstrip) map onto the viewer and Inspect's photo column. _Builder's call_ whether the bench tab survives as a wrapper during the move, as long as it does not end as a second viewer.

### Tools in the scene

- **Thermal ortho** as a map layer with real temperatures per pixel, the same palettes and span, and the same readings and hot spots as on a photo.
- **Point cloud classes:** AI segmentation suggests a class per point. Hand correction (box, lasso, brush, Set class, undo) works from day one, extending today's cleanup tools.
- Volumes, change detection, the engineering model and antenna tools stay where they are, and their results join the findings list.

### Findings

One list for the project, fed by every section: drawn or accepted findings on photos, thermal hot spots and readings, measurements, volumes, segmentation-derived findings (for example a pipe or tank measured from its class), and the industry tools' results. Each finding has a place (a pin on the map and in 3D), a class, a severity, the evidence it came from, and the date. _Builder's note:_ today's Issues register is the natural base; the section designs say which of their outputs become findings.

### Project types

- The project gets **industry types**: solar farm, telecom tower, oil and gas, construction, plus the existing survey and the others the wizard offers. One or more can be ticked, at creation or later.
- Today the manifest has one closed `type` and one optional `purpose` (`packages/schema/src/builder.ts`, `ProjectPurpose` includes telecom and construction but not solar or oil and gas). Multiple types need a contract change: an additive list field, with `purpose` and `type` still written so older builds keep working. _Builder's call_ on the field's shape; it needs a row in `docs/architecture/contract-changes.md`.
- Each type brings a **profile**: which tools sit up front, which way-in it leads with, the AI classes and segmentation classes, the severity model, and its report sections. Ticking two types merges their profiles.
- **Types and today's fields** (_my call_): `purpose` gains `solar` and `oil-gas` and becomes the first ticked type; the new list holds all of them. Solar and oil and gas write `type: inspection`, as telecom does. Profiles only add (which tools come first, classes, report sections); they never change what `type` decides today.
- **Merging** (_my call_): the first ticked type is the primary; its way-in leads. Classes and report sections are the union.
- **One severity scale per project** (founder, 26 Oct): however many types are ticked, every finding uses the project's one severity model, as today. The primary type's profile suggests the default scale at creation.
- **Tools follow the data, not the type** (from the founder's rule that tools are never hidden): thermal mode appears on any photo with thermal data, and the cloud tools on any cloud, whatever the types. A type only decides what is up front and the order.
- **Existing projects** (_my call_): their types are read from `purpose` (or from `type` when there is no purpose), and they land on the scene like new ones.

### Report and exports

- **One report centre.** It picks findings from the one list, and lays them out with either a built-in template or a client template.
- **Built-in templates per type:** solar (hot spots per block, defect types, thermal and visual pairs), telecom (tower and antenna table), oil and gas (integrity findings), construction (progress and deviation), survey (today's volumetric report). A mixed project gets the sections of each ticked type.
- **Client Word templates.** The client's `.docx` with their layout and logo is set up once per client with simple placeholders (project name, site map, findings table and so on), saved in the app, and reused on every job for that client. Output as Word and PDF. _My call:_ placeholders typed into the Word file, with a list of available ones shown in the app.
- **Client severity scales.** A client template can bring its own severity names, mapped from ours. _My call; the founder agreed the overall report shape._
- **Exports** from the same place: classified LAZ, DXF, shapefile/GeoJSON, CSV.

## What the frame itself ships

_My call._ The frame's own plan builds what every section needs, and nothing a section owns:

- the industry types, their profiles and the contract change;
- landing on the scene, led by the primary type's way-in;
- "from a spot to the photos" on the map, mesh and cloud;
- the one findings list, with today's findings (Inspect, antenna flags, measurements, volumes) and pins on the map and in 3D.

The merged photo viewer ships with Thermal (section 2), since thermal mode is what it adds. The report centre's built-in templates and Word templates ship as section 8, growing with each section.

## Order of the section designs

Each section is brainstormed, designed and planned on its own, in this order (founder agreed 26 Oct):

1. This frame.
2. Thermal: M2 to M4 and the thermal ortho, built into the one photo viewer and the scene.
3. Point cloud segmentation: the AI runtime (likely in the Analytics pack, which already ships CUDA) and hand correction from day one.
4. Solar defects tied to the panel layout (needs 2).
5. Telecom tower audit (needs 3 and the antenna work).
6. Oil and gas integrity (needs 2, 3 and Inspect).
7. Construction against design (needs 3 and change detection).
8. The report and export centre: its shape is fixed here, and it grows with each section.

## Left to the builder

- How the merged viewer is split into components and how the Thermal bench is retired.
- The ranking used for "photos that see this spot".
- The shape of the project types field and the profile data.
- How the findings list extends the Issues register.
- The placeholder syntax for Word templates and the library that fills them.

## Open points

- Which way-in leads for oil and gas sites (map assumed).
- Whether a client template is stored per client across projects, or copied into each project folder so it travels in `.aio` exports (both are likely needed).
