# Project types in the new project wizard: design

Status: built on `feat/project-types` as a proposal. The founder has not reviewed the scope; every choice below that is theirs to make is listed under "Decisions for the founder".

## Why

The founder wants to say what a project is when it is created: a survey project, a construction project, a vertical asset inspection, a confined space inspection or a data fusion project (a large site with many sensors). What a type should set up beyond that is still open.

## What exists today

- Step 1 of the new project wizard already has a type picker with five cards: Inspection, Volumetric, Road, Digital twin, Free fusion.
- The choice is stored as `type` in the project manifest, one of `inspection`, `volumetric`, `road`, `twin`, `fusion` (`ProjectType`).
- That list is closed. Every installed build refuses a whole project whose `type` it does not know, and the list is pinned by tests (`m11.test.ts`, `tools/compat`). So a new value there would lock testers out of new projects.
- Six places read `type`: the default severity model, the survey data block of the wizard, the road workspace, the "detections to issues" button, the default pipeline in the processing form and the report layout. Everything else follows what the project holds, and survey tools work in every project type.

## What is built

### The cards

Six cards, in this order, each with one line that says what it is for:

| Card                      | Hint                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| Survey                    | Stockpiles, earthworks and terrain by survey date, with volumes            |
| Construction              | A building site followed visit by visit, with drawings and designs         |
| Vertical asset inspection | A stack, tower, flare or facade: photos, video and a model, graded defects |
| Confined space inspection | Inside a tank, vessel or duct: photos and a model or scan, graded defects  |
| Data fusion               | A large site with many sensors: any mix of data in one scene               |
| Road                      | Corridor orthomosaic, distress mapping, PCI                                |

Road stays because the road workspace depends on it. Digital twin is no longer offered for new projects; projects that have it keep it and keep working.

### Storage

Purely additive. The manifest keeps `type` and gains one optional field, `purpose`, for the finer choice:

| Card                      | `purpose`        | `type` written (as before) |
| ------------------------- | ---------------- | -------------------------- |
| Survey                    | `survey`         | `volumetric`               |
| Construction              | `construction`   | `fusion`                   |
| Vertical asset inspection | `vertical-asset` | `inspection`               |
| Confined space inspection | `confined-space` | `inspection`               |
| Data fusion               | `data-fusion`    | `fusion`                   |
| Road                      | `road`           | `road`                     |

- `NewProjectRequest` gains the optional `purpose`. When it is given, the manifest's `type` is taken from the table, so the two can never disagree on disk.
- Behaviour keeps following `type`. Nothing reads `purpose` except the label and the starter list. No tool, tab or navigation entry is shown or hidden by type.
- The field is read tolerantly. In the manifest it is a short lower-case name, not a closed list, and `projectPurpose(manifest)` answers a value only when this build knows it. A value from a later build reads as "none" (the project then shows what its `type` says) and stays in the file when this build saves the manifest. A malformed value reads as absent. Either way the project opens.
- Builds already installed read the manifest by `type` as before. They do not know `purpose` and drop it the next time they save the manifest; the project then shows what its `type` says. Nothing else is lost.

### Projects without the field

Everything that exists today has no `purpose`. What to show comes from `type`:

| `type`       | Shown as     | Starter list                 |
| ------------ | ------------ | ---------------------------- |
| `volumetric` | Survey       | Survey                       |
| `road`       | Road         | Road                         |
| `fusion`     | Data fusion  | Data fusion                  |
| `inspection` | Inspection   | Vertical asset inspection    |
| `twin`       | Digital twin | Data fusion                  |
| none         | nothing      | none (the hint as it is now) |

An older inspection project could be either kind of inspection, so it is shown as plain "Inspection".

### What a type sets up, for now

1. The existing defaults, through the mapped `type`: the severity model, the survey data block for Survey, the road workspace for Road.
2. A starter list in the empty project: three lines that say which data to add first. It names only file kinds the app imports today (JPG photos, MP4 or MOV video with its DJI SRT log, GLB and OBJ models, GeoTIFF, LAS, LAZ, E57 and PLY point clouds, DXF drawings, LandXML and 12da designs).
3. The type is shown in the wizard's review step and above the heading of the empty project.

Nothing else changes by type.

### Where the type is not shown

The project card on the Projects screen shows the kind of folder (native project, kit export, package), which comes from the library entry, not from the manifest. Showing the type there needs a new field on the library entry, a second contract change. It is left out and listed below.

## What each type could set up next

A proposal to react to. None of it is built.

| Type                      | Default view                             | Processing offered first                    | Report layout                                     | Starter folders in the layer list   |
| ------------------------- | ---------------------------------------- | ------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| Survey                    | Map, newest survey date                  | Create maps from photos, then compare dates | Survey report: volumes, cut and fill              | One folder per survey date          |
| Construction              | Split: map beside 3D, design overlay on  | Create maps from photos, design comparison  | Progress report: change by visit, design check    | Visits, Drawings, Designs           |
| Vertical asset inspection | 3D, orbit around the asset               | AI inspection (detections to issues)        | Inspection report: issue register, contact sheets | Photos, Video, Model                |
| Confined space inspection | 3D inside the model, photo viewer docked | AI inspection (detections to issues)        | Inspection report with an entry log section       | Photos, Scan or model, Walkthroughs |
| Data fusion               | 3D, whole site                           | Point cloud conversion, maps from photos    | Site summary: layers by sensor and date           | One folder per sensor, then by date |
| Road                      | Map along the centreline                 | Road builder                                | Road report: PCI by section                       | Ortho, Centreline, Video            |

## Decisions for the founder

1. The six cards, their order, names and hints.
2. The mapping to the old `type`, above all Construction to `fusion` (so a construction project prints the general report and has no survey data block in the wizard) and both inspections to `inspection`.
3. Digital twin is no longer offered for new projects.
4. Vertical asset inspection is the card selected when the wizard opens. It writes `inspection`, the default until now, so nothing changes for someone who clicks straight through.
5. The name of the new field, `purpose`, and its six values.
6. A value from a later build is kept in the file and shown as the old `type` says, instead of being removed.
7. Older projects of type `inspection` show "Inspection", not one of the two new kinds.
8. The starter list wording, per type.
9. The type on the Projects screen card is left out (needs a second contract change).
10. The table "What each type could set up next".

## Tests

- `@aio/schema`: the manifest takes `purpose`, keeps an unknown value, reads a malformed one as absent, and stays valid without it; the request takes only known values; every purpose maps to an existing `type`; the compat tests in `tools/compat` stay green without a change.
- `@aio/project`: `newProjectManifest` writes `purpose` and the mapped `type`, and neither when the request has none.
- Desktop renderer: the six cards and their mapped types, the default severity model per card, what a manifest shows (with a purpose, without, with an unknown one), the starter lists name only importable file kinds, and the empty project hint renders the type and the list.
- End to end: a new spec `project-types.spec.ts`; `inspection.spec.ts`, `volumetric-build.spec.ts` and `samples.spec.ts` select the cards by their new names.

## Docs

The guide page "Building projects", `docs/TESTING.md`, `docs/PRD.md` (BLD-1) and a row in `docs/architecture/contract-changes.md` with "pending founder review".
