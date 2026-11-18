---
type: session
date: 2026-11-19-0200
branch: feat/tools-by-project
status: complete
related:
  - docs/plans/2026-11-18-tools-by-project.md
  - docs/architecture/contract-changes.md
---

# Tools shown by project type

## What changed

- This PR shows tools by project type (founder, 18 Nov 2026), replacing the 30 Oct rule that no feature is gated by type. Four tool sets, Earthworks, Road, Telecom and Thermal, are part of a project or not; everything else, Terrain analysis and Engineering included, is in every project. Defaults: Survey and Construction have Earthworks, Vertical asset has Thermal, Confined space none, Data fusion all four, Road has Road, Telecom towers has Telecom.
- One rule in one place (`apps/desktop/src/renderer/tools/toolSets.ts`): a thing shows when its set is part of the project and the data it works on is there. The Tools tab, the panel sections, the measure families, the stage tools modes, the "In this project" list and the palette ask it. The duplicate `GROUP_NEEDS` and the tower special cases are gone.
- A project keeps the tools of what it holds: piles, a road model, antennas or an RF plan or a telecom measurement, thermal photos, or any of those files when it cannot be read. Such a set is locked on.
- Settings, Project settings, Tool sets: one switch per set, saved in the project (`ProjectManifest.toolSets?`, new channel `project:setToolSets`, contract row added). A set switched on shows where its first record is made (Volumes with its empty state). Road is offered only in a road project or with a road model.
- Guide chapters 8, 12 and 45 and the glossary follow; the plan records the founder's decisions and what the build changed.

## Why

Niche tools showed in almost every project, because "has a mesh" or "has photos" stood in for the project type. Under the feature freeze this is a simplification: it takes things out of view and adds one list of switches.

## How to test

The full list is section 6 of `docs/plans/2026-11-18-tools-by-project.md` (nine steps, each driven by a spec). In short:

1. Demo tank farm, Tools tab: Volumes, Measure, Terrain analysis, Survey checks lead; no Coverage or Thermal. Ctrl K "azimuth" lists nothing.
2. New project, Confined space inspection: Tools, Measure has no Telecom family. New project, Telecom towers: it has.
3. In a survey project with a 3D model: Settings, Project settings, Tool sets, turn Telecom on, back to Scene: Coverage and the Telecom family are there. Turn it off: gone.
4. In a confined space project: turn Earthworks on; Project, Volumes opens with Draw volume. There is no Road switch.
5. A project that holds antennas, or thermal photos, has those tools whatever its type, with the switch locked on and its reason.

## Open threads

- Road tools belong to road projects: no other project type can build a road, so its switch is not offered there. A way in for other types would be new capability.
- Data fusion and the older fusion and twin projects now show Volumes (empty) from the start, since they have Earthworks.
- A photo set that could not be looked at locks Thermal on with the "holds thermal photos" wording.
- Not driven end to end: the switches in a read-only package, the Road row in a road project, an unreadable record file. Unit tests cover them.
- The first thermal photos show the Thermal section after the photo sets are read on open: under a second for 1000 photos on a warm disk; a cold disk was not measured.

## Next session entry point

The founder tests section 6 of the plan together with the volumetrics list; telecom is the next section to finalize, and its tools now sit behind the Telecom set.
