all four|# Tools shown by project type

|          |                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | **Decided** by the founder, 18 Nov 2026 (section 7), and built on `feat/tools-by-project`.                                                   |
| Decision | Founder, 18 Nov 2026: "let the tools be shown based on the project, there is no point showing telecom tools in a confined space project".    |
| Replaces | Decision 2 of `docs/plans/2026-10-30-ui-revision-design.md` ("no feature is ever gated by project type") and its section 7 "No gating, ever" |
| Freeze   | This is a simplification. It removes things from view and adds no capability. The one new control is a list of switches in project settings. |

## What is wrong today

The rule of 30 Oct said a tool shows whenever the project holds data it could run on. For the niche tools that data test is far too wide:

- **Engineering** and **Coverage** show in every project with a point cloud or a mesh (`needs: model3d`). That is nearly every project.
- **Thermal** shows in every project with photos or 360 photos.
- The **Telecom** measuring family (Azimuth, Antenna tilt, Clearance, and "Find antennas") is in every project, always. In a read-only project its tools are greyed, never gone.
- The command palette lists every tool in every project.

The same data test is also written twice: once per right-panel section (`SECTIONS` in `tabsModel.ts`) and once per tool group (`GROUP_NEEDS` in `tools/registry.ts`). One place already goes by project type, and with its own table: the "In this project" list (`projectGroups.ts`) leaves the tower groups out of survey and construction projects.

## 1. The matrix

### Tool sets

Everything that is not core belongs to one of four **tool sets**. A set is either part of a project or it is not; there is no "More" menu and nothing is tucked away.

| Tool set   | What is in it                                                                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Earthworks | Tools: Volumes, Survey checks. Project: Volumes. Layers: Show (surface and pile overlays). Stage tools mode: Volumes. Bottom strip: volume over time.                                                                                                                                  |
| Road       | Tools: Road. Project: Road. Stage tools mode: Road. Bottom strip: chainage.                                                                                                                                                                                                            |
| Telecom    | Measure family Telecom (Azimuth, Antenna tilt, Clearance, Find antennas). Tools: Coverage. "In this project": Antennas, Sectors, Coverage plan. Right-click: every antenna action (fly to, hide, show, edit azimuth, edit downtilt, accept, reject, redraw, delete) and "RF coverage". |
| Thermal    | Tools: Thermal. Right-click on photos: "Analyse thermal".                                                                                                                                                                                                                              |

**Core, in every project:** View, Measure (the Point, Line, Polygon, Markup and Section families), Annotate, Terrain analysis, Engineering (the model review and "Create engineering model"), Environment, Compare and the dates, Issues, Search, Digest, Processing, Reports, every Layers and display section, and all six rail screens. Point cloud, Video, Terrain analysis and Engineering are core too: they keep showing only when the project holds a point cloud, a video, a model or raster, or a point cloud or mesh, as today.

### Which project gets which set

"on" means part of the project from the start. "data" means it joins by itself as soon as the project holds that set's own records (section 2). A blank cell means not shown, until someone switches it on in project settings (section 3).

| Tool set   | Survey | Construction | Vertical asset | Confined space | Data fusion | Road | Telecom towers | Today                                              |
| ---------- | ------ | ------------ | -------------- | -------------- | ----------- | ---- | -------------- | -------------------------------------------------- |
| Core       | on     | on           | on             | on             | on          | on   | on             | on everywhere                                      |
| Earthworks | on     | on           | data           | data           | on          | data | data           | every project with a model, a raster or piles      |
| Road       | data   | data         | data           | data           | on          | on   | data           | every project with a road model (unchanged)        |
| Telecom    | data   | data         | data           | data           | on          | data | on             | measure family everywhere; Coverage with any model |
| Thermal    | data   | data         | on             | data           | on          | data | data           | every project with photos                          |

### Every surface, row by row

Columns: Su survey, Co construction, VA vertical asset, CS confined space, DF data fusion, Ro road, Te telecom. "Y" is shown (still subject to the data condition in the last column), "." is not part of the project by default.

| Surface                    | Item                                                                                                                    | Su                     | Co  | VA  | CS  | DF  | Ro  | Te  | Today: shows when                                             | Data condition kept           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- | --- | --- | --- | --- | --- | --- | ------------------------------------------------------------- | ----------------------------- |
| Tools tab group            | View                                                                                                                    | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always                                                        | none                          |
| Tools tab group            | Measure                                                                                                                 | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always                                                        | none                          |
| Tools tab group            | Annotate                                                                                                                | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always                                                        | none                          |
| Tools tab group            | Volumes                                                                                                                 | Y                      | Y   | .   | .   | Y   | .   | .   | piles or stockpile kit                                        | piles or stockpile kit        |
| Tools tab group            | Point cloud                                                                                                             | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | a point cloud                                                 | a point cloud                 |
| Tools tab group            | Terrain analysis                                                                                                        | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | any model or raster                                           | a model or raster             |
| Tools tab group            | Survey checks                                                                                                           | Y                      | Y   | .   | .   | Y   | .   | .   | any model or raster                                           | a model or raster             |
| Tools tab group            | Video                                                                                                                   | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | a video                                                       | a video                       |
| Tools tab group            | Road                                                                                                                    | .                      | .   | .   | .   | Y   | Y   | .   | a road model                                                  | a road model                  |
| Tools tab group            | Engineering                                                                                                             | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | any point cloud or mesh                                       | a point cloud or mesh         |
| Tools tab group            | Coverage                                                                                                                | .                      | .   | .   | .   | Y   | .   | Y   | any point cloud or mesh                                       | a point cloud or mesh         |
| Tools tab group            | Thermal                                                                                                                 | .                      | .   | Y   | .   | Y   | .   | .   | any photos                                                    | photos                        |
| Tools tab group            | Environment                                                                                                             | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always                                                        | none                          |
| Selection tab              | Selected                                                                                                                | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always                                                        | none                          |
| Layers and display section | Display, Point clouds, Overlays, Cutaway, Flight lines                                                                  | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | their data                                                    | unchanged                     |
| Layers and display section | Show (surface and pile overlays)                                                                                        | Y                      | Y   | .   | .   | Y   | .   | .   | piles or stockpile kit                                        | piles or stockpile kit        |
| Project tab section        | Digest, In this project, Search, Changes, Issues, Processing                                                            | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always, or two dates                                          | unchanged                     |
| Project tab section        | Volumes                                                                                                                 | Y                      | Y   | .   | .   | Y   | .   | .   | piles or stockpile kit                                        | piles or stockpile kit        |
| Project tab section        | Road                                                                                                                    | .                      | .   | .   | .   | Y   | Y   | .   | a road model                                                  | a road model                  |
| Measure family             | Point, Line, Polygon, Markup, Section                                                                                   | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always                                                        | none                          |
| Measure family             | Telecom, with Find antennas                                                                                             | .                      | .   | .   | .   | Y   | .   | Y   | always (greyed when read-only)                                | none; tools still say why not |
| Stage tools mode           | View, Measure, Annotate                                                                                                 | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always                                                        | none                          |
| Stage tools mode           | Compare                                                                                                                 | Y                      | Y   | Y   | Y   | Y   | .   | Y   | two dates or a video, not a road                              | unchanged                     |
| Stage tools mode           | Video                                                                                                                   | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | a video                                                       | a video                       |
| Stage tools mode           | Volumes                                                                                                                 | Y                      | Y   | .   | .   | Y   | .   | .   | piles or stockpile kit                                        | piles or stockpile kit        |
| Stage tools mode           | Road                                                                                                                    | .                      | .   | .   | .   | Y   | Y   | .   | a road model, map in view                                     | unchanged                     |
| "In this project" group    | Measurements, Issues                                                                                                    | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always                                                        | none                          |
| "In this project" group    | Antennas                                                                                                                | .                      | .   | .   | .   | Y   | .   | Y   | a point cloud and an inventory, not in survey or construction | a point cloud                 |
| "In this project" group    | Sectors, Coverage plan                                                                                                  | .                      | .   | .   | .   | Y   | .   | Y   | an inventory or RF plan, not in survey or construction        | an inventory or plan          |
| Rail screen                | Projects, Globe, Scene, Issues, Inspect, Reports                                                                        | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | always                                                        | none                          |
| Right-click actions        | Project, dates, layers, point cloud, mesh, drawing, pins, photo position, measurements, reports, findings, area compare | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | by what was clicked                                           | unchanged                     |
| Right-click actions        | Antenna actions, "RF coverage"                                                                                          | .                      | .   | .   | .   | Y   | .   | Y   | an antenna row; an inventory                                  | unchanged                     |
| Right-click actions        | "Analyse thermal"                                                                                                       | .                      | .   | Y   | .   | Y   | .   | .   | a thermal photo was clicked                                   | unchanged                     |
| Right-click actions        | "Create engineering model"                                                                                              | Y                      | Y   | Y   | Y   | Y   | Y   | Y   | a point cloud or mesh was clicked                             | unchanged                     |
| Command palette            | Tools, tool groups and panel names                                                                                      | follows the rows above |     |     |     |     |     |     | every tool, in every project                                  | follows the rows above        |

What does not change: the six rail screens, the Settings pages (they are per computer, not per project), the space switcher in the title bar (it shows when the project has more than one space), the import toolbar (every data kind can still be added to every project) and the layout presets (they keep deciding what a project opens on).

Ask AI needs no work of its own for the right-click actions: its `list_actions` and `run_action` tools read the same action registry, so they follow the menus. Its question-answering tools (listing issues, reading the engineering model, planning coverage) are not UI tools and stay as they are.

Two things found while checking the code, for the record:

- The task brief says 45 tools. The registry holds 37 today: 22 in View, Annotate, Volumes, Point cloud, Video and Road, plus the 15 measuring tools. Terrain analysis, Survey checks, Engineering, Coverage, Thermal and Environment have no registry tools; each is a panel section.
- The "In this project" order table names Stockpiles, Changes and Photos groups that nobody has registered. They are not part of this work.

## 2. The rule

> **A tool, section, mode, group or action shows when its tool set is part of the project and the data it works on is there. Core things have no tool set and only the data test.**

A tool set is **part of the project** when any of these is true:

1. the project type includes it (the table in section 1), or
2. the project already holds that set's own records, or
3. someone switched it on for this project (section 3).

"Its own records" means things only that set makes, not data it could run on:

| Tool set   | Joins by itself when the project holds                                                              |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Earthworks | piles, volume measurements or the stockpile kit                                                     |
| Road       | a road model                                                                                        |
| Telecom    | an antenna inventory, an RF plan, or a saved Azimuth, Antenna tilt or Clearance measurement         |
| Thermal    | at least one thermal photo (the check the app already runs on every photo set when a project opens) |

A mesh alone no longer brings Coverage, and photos alone no longer bring Thermal. Importing thermal photos does bring Thermal, with no step for the user.

**How the two tests combine.** They are both required, and each answers a different question. The tool set answers "does this belong in this project at all": if not, the thing is absent everywhere, including the palette. The data test answers "is there anything to run it on yet": it stays exactly as today, including the tools that are greyed with a reason ("Needs the 3D view", "Read only"). So a telecom project with no point cloud yet still has no Coverage section, and a vertical asset project never has one unless it gains antennas or the switch.

**Right-click actions need no rule of their own.** Each action of a set already asks for that set's own record before it shows: an antenna row, an antenna inventory for "RF coverage", a thermal photo for "Analyse thermal". A project that holds the record has the set, so the menus already follow.

**One place in the code.** A new pure module, `apps/desktop/src/renderer/tools/toolSets.ts`, holds:

- the four set names and the type table (`PURPOSE_SETS`),
- one table saying which set each group, section, measure family, stage tools mode and "In this project" group belongs to (every id is listed, as core or in a set, so a new one cannot land without a decision),
- `toolSetsFor(project)`: the sets that are part of the project, from the three conditions above.

Everything else asks it: the panel sections (`sectionsOf`), the tool registry (`toolsFor`, `islandModes`, and through them the palette), the measure families (`familiesFor`), and the "In this project" list (`orderGroups`).

**What it replaces.** The data tests are real and stay, but they stop being asked to stand in for the project type:

- `GROUP_NEEDS` in the registry goes. It repeats the sections' `needs` line for line; the registry reads the section's.
- The tower rule inside `projectGroups.ts` (`TELECOM_GROUPS`, the "towerless" categories, "antennas only if any" for vertical assets) goes. The Telecom set says the same thing in one place.
- The type a project counts as comes from `purposeOf` in `layout/presets.ts`, which the presets already use. The second, slightly different mapping in `projectCategory` keeps only its job of ordering the list.
- The comments and the test that state "never the project type" (`registry.ts`, `tabsModel.ts`, `panelData.ts`, `measureCatalogue.ts`, `presets.ts`, and "reachable tools are the same for every preset" in `presets.test.ts`) are rewritten to the new rule.

## 3. Mixed and changing projects

**Adding a set to a project.** Settings, "This project", gets a short list titled **Tool sets**: four switches (Earthworks, Road, Telecom, Thermal), each with one line saying what it brings. The switches start as the project type gives them. Turning one on makes its tools part of the project at once, everywhere. This is a project setting, like the project's privacy switches on the same page, not a menu: nothing is hidden behind it while a set is on, and a set that is off is simply not part of the project. The palette already lists "This project (Settings)", so the list is one search away.

- A set whose records the project holds is shown on and locked, with the reason ("This project holds antennas"). It cannot be switched off, so no record can ever lose its tools.
- A switch that is turned off only removes the tools from view. It deletes nothing.
- The switches are saved in the project, so a colleague or a package opened on another computer shows the same tools. That is one new optional field in the project file (section 5, contract change). A read-only package shows the switches but cannot change them.

**Existing projects, first open after the update.** Nothing is migrated and nothing is written. On open, the app works out the sets from the project type plus the records the project holds:

- A project that already holds antennas, an RF plan or telecom measurements keeps every telecom tool, whatever its type.
- A project with piles keeps Volumes; one with thermal photos keeps Thermal; one with a road model keeps Road.
- What disappears is only the empty offer: Coverage on a survey that merely has a point cloud, Survey checks on an inspection, Thermal on a project whose photos are ordinary, the Telecom family where no antenna was ever measured.
- All data stays reachable in any case: layers, measurements and issues are core and never depend on a set.

**The five older project types.** Projects from before the seven wizard types have only the older type. They map the way the layout presets already map them (`purposeOf`), so a project's tools and its layout always agree:

| Older type          | Counts as      | Sets on    |
| ------------------- | -------------- | ---------- |
| volumetric          | Survey         | Earthworks |
| road                | Road           | Road       |
| inspection          | Vertical asset | Thermal    |
| fusion, twin        | Data fusion    | all four   |
| none (imported kit) | Vertical asset | Thermal    |

A fusion, twin or untyped project that holds piles counts as a Survey for its layout today; its Earthworks set comes on through its records either way. An older inspection project that was really a tower job keeps its telecom tools because it holds antennas.

**A type a later build adds.** A project whose type this build does not know falls back to its older type, as the layout does today.

## 4. Alternatives rejected

- **Keep every group, fold the niche ones under "More".** The founder ruled out hiding tools behind menus on 24 Oct, and it does not answer the complaint: the telecom tools would still be in a confined space project, one click further away.
- **Tighten the data tests only** (Thermal with thermal photos, Coverage with antennas, and so on), with no project type involved. It needs no setting and no new field, but it cannot offer a tool before its first use: a new telecom project has no antennas yet, so "Find antennas" would never appear. It would also leave the Telecom measuring family with no data to test. The proposal keeps the good half of this idea as condition 2.
- **Project type alone decides, and the user changes the type to get other tools.** One type per project cannot describe a site that is surveyed for volumes and also has a tower, and changing the type would also change the layout and the starter list. It would also strand the antennas in an older "inspection" project.
- **Remember the switches on the computer instead of in the project.** No contract change, but the same project would show different tools on two computers and in a package sent to a customer.

## 5. Execution DAG

Effort: about three to four working days for one session with subagents. One branch, `feat/tools-by-project`. No pipeline pack change, no Python.

### Tasks

| Task | What                                                                                                                                                                                                  | Depends on | Files (R = `apps/desktop/src/renderer`)                                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1   | Project field `toolSets` (optional list of set names, read leniently like `purpose`) and its reader; contract row                                                                                     | none       | `packages/schema/src/manifest.ts`, `packages/schema/src/index.ts`, `docs/architecture/contract-changes.md`                                                                                                               |
| T2   | The pure rule: set names, type table, membership table, `toolSetsFor`                                                                                                                                 | none       | `R/tools/toolSets.ts` (new) and its test                                                                                                                                                                                 |
| T3   | Wiring: a hook and a plain reader that gather the project's type, records and switches; the tool context carries the sets; sections, groups and stage tools modes ask the rule; `GROUP_NEEDS` removed | T1, T2     | `R/tools/useToolSets.ts` (new), `R/tools/useToolCtx.ts`, `R/tools/registry.ts`, `R/workspace/workbench/tabsModel.ts`, `tabs/PanelSections.tsx`, `tabs/ToolsTab.tsx`, `R/layout/presets.ts` (comments), `presets.test.ts` |
| T4   | "Tool sets" switches in Settings, "This project", with the locked state and its reason; saved through the project's existing save path                                                                | T1, T2     | `R/screens/settings/ProjectSettings.tsx`, the English catalogue in `packages/ui/src/i18n/en/`                                                                                                                            |
| T5   | Measure families follow the rule (Telecom family and Find antennas); starred telecom tools do not show where the set is off                                                                           | T3         | `R/survey/measureCatalogue.ts`, `R/workspace/workbench/benches/MeasureBench.tsx`                                                                                                                                         |
| T6   | Palette: tools, tool groups and panel names follow the rule                                                                                                                                           | T3         | `R/shell/paletteIndex.ts`, `R/shell/Palette.tsx`                                                                                                                                                                         |
| T7   | "In this project": tower groups ask the rule; the tower special cases removed                                                                                                                         | T3         | `R/workspace/workbench/project/projectGroups.ts`, `groupRegistry.ts`                                                                                                                                                     |
| T8   | Right-click: antenna, RF, thermal and engineering actions ask the rule; the import summary's engineering offer too                                                                                    | T3         | `R/shell/actions/antennaActions.tsx`, `rfActions.tsx`, `thermalActions.tsx`, `kindActions.tsx`, `R/builder/importSummary.ts`                                                                                             |
| T9   | End to end: fixtures name their project type, one new spec, changed specs run the CI way                                                                                                              | T4 to T8   | `apps/desktop/e2e/` (list below)                                                                                                                                                                                         |
| T10  | Words: the 30 Oct design marked as replaced on this point, glossary entry "tool set", user guide, `/wrapup` note and north star                                                                       | T9         | `docs/plans/2026-10-30-ui-revision-design.md`, `docs/design/glossary.md`, the user guide, `docs/sessions/`, `docs/NORTH-STAR.md`                                                                                         |

### Batches (no two tasks in a batch share a file)

| Batch | Tasks          | Run                              |
| ----- | -------------- | -------------------------------- |
| A     | T1, T2         | two agents at once               |
| B     | T3, T4         | two agents at once               |
| C     | T5, T6, T7, T8 | four agents at once              |
| D     | T9             | one agent, one e2e run at a time |
| E     | T10            | main session                     |

**Critical path:** T2, T3, T8 (the widest of batch C), T9, T10. T1 and T4 have slack.

### Tests per task

- **T1** (vitest, `packages/schema`): a project file without the field parses; a list with a name this build does not know keeps the names it does know; a malformed value reads as absent and does not refuse the project.
- **T2** (vitest): the type table, one case per project type; every older type; records bring a set on in every type; a switched-on set is on; a set with records cannot be off; every group, section, family, mode, group and domain action id in the app is either core or in exactly one set (so a new tool cannot land without a decision).
- **T3**: `tabsModel.test.ts` and `registry.test.ts` gain "a mesh alone does not show Engineering or Coverage", "photos alone do not show Thermal", "a set that is on still needs its data". `presets.test.ts`: "reachable tools are the same for every preset" becomes "a preset never changes what the rule shows, only the order".
- **T4**: the switches start from the type; a set with records is on and locked with its reason; a read-only project cannot change them; a change is saved and applies without reopening.
- **T5**: `measureCatalogue.test.ts` and `MeasureBench.test.tsx`: no Telecom family with the set off; all three tools and Find antennas with it on; a starred Azimuth is not offered with the set off and returns with it on.
- **T6**: `paletteIndex.test.ts`: no telecom tool, Coverage or Thermal entry with the sets off; present with them on.
- **T7**: `projectGroups.test.ts`: tower groups by set; a survey that holds antennas now lists them (today it leaves them out).
- **T8**: the action tests for the four files; `parity.test.ts` stays green (no action is added or removed, so the Ask AI table is unchanged).

### End to end specs

The telecom, RF, thermal and engineering fixtures write projects with no type at all (`telecomFixtures.ts`, `rfFixtures.ts`, `thermalFixture.ts`, `engineeringFlow.ts`). An untyped project counts as a vertical asset, so:

- **Need their type set** (`purpose: 'telecom'` in the fixture): `telecom-measurements.spec.ts`, `telecom-antennas.spec.ts`, `telecom-antenna-flag.spec.ts`, `antenna-box-handles.spec.ts`, `project-list-antennas.spec.ts`, `rf-coverage.spec.ts`, `rf-autoplan.spec.ts`. Some would pass on their records alone; setting the type keeps them honest about what they test.
- **Should keep passing, type set anyway** (`purpose: 'vertical-asset'`): `thermal-bench.spec.ts`, `engineering-flow.spec.ts`, `engineering-corrections.spec.ts`, `engineering-georef.spec.ts`, `engineering-inspect.spec.ts`.
- **To re-run and adjust if they look for a group that left**: `project-list-groups.spec.ts`, `project-types.spec.ts`, `palette-tools.spec.ts`, `environment.spec.ts`, `measurement-dates.spec.ts`, `photo-position-edit.spec.ts`, and any spec that opens a Tools section on the demo tank farm (a survey) or the change demo (older type fusion).
- **New:** `tools-by-project.spec.ts`: a confined space project with a point cloud and photos shows no Telecom family, Coverage, Engineering or Thermal in the Tools tab, the palette or a right-click; a telecom project shows them; switching Telecom on in a survey project brings the family in without a reload; a survey project that holds an antenna inventory shows the telecom tools and the locked switch.

All changed and new specs run the CI way before hand-over (1100 x 720, scale 1, WARP, every demo built, one worker).

### Contract change

One, additive: `ProjectManifest.toolSets?` in `@aio/schema`, a list of plain names. An older build ignores it and drops it when it saves the project; the project then falls back to its type and its records, so nothing becomes unreachable. It needs a row in `docs/architecture/contract-changes.md` (T1). No IPC channel is added if the switches save through the same call as the project's other settings; T4 confirms that first and, if a channel is needed, adds it to the same row.

### Packages touched

`@aio/schema` (T1), `@aio/ui` (strings only, T4), `apps/desktop` (everything else). Nothing in the pipeline, the engine or the other packages.

## 6. How to test (once built)

1. Open the demo tank farm (a survey). In the right panel, Tools tab: Volumes, Terrain analysis and Survey checks are there. Engineering, Coverage and Thermal are not. Open Measure: there is no Telecom family.
2. Press Ctrl+K and type "azimuth", then "coverage", then "thermal". None is listed.
3. Create a project, type "Confined space inspection", and add a point cloud and some ordinary photos. Tools shows View, Measure, Annotate, Point cloud and Environment only. Right-click the point cloud: there is no "Create engineering model".
4. Create a project, type "Telecom towers", and add a point cloud. Measure now has the Telecom family with "Find antennas"; Tools has Coverage and Engineering.
5. Back in the tank farm: Settings, This project, Tool sets. Switch Telecom on. Return to the scene: the Telecom family and Coverage are there, with no restart. Switch it off again: they are gone, and nothing else changed.
6. Open an existing project that already holds an antenna inventory but is not a telecom project. Its antennas, sectors and telecom tools are all there, and in Tool sets the Telecom switch is on and locked with "This project holds antennas".
7. Add thermal photos to the confined space project from step 3. The Thermal section appears by itself once the import finishes.
8. Open a read-only package: the tools match the project it was made from, and the Tool sets switches cannot be changed.

## 7. Founder decisions, 18 Nov 2026

1. **Data fusion gets every tool set** (Earthworks, Road, Telecom, Thermal). It is the type for a site with any mix of data, so nothing is left out of it. The older fusion and twin types count as Data fusion and get the same.
2. **Engineering is core.** The Engineering section (the engineering model, exported as GLB) and "Create engineering model" are in every project type, subject only to the data test (a point cloud or mesh). It is not a tool set and has no switch. That leaves four sets: Earthworks, Road, Telecom, Thermal.
3. **Terrain analysis is core.** It shows in every project that holds a model or a raster.
4. **A set that the project type includes may be switched off.** Only a set with records is locked on.

The resulting defaults: Survey and Construction have Earthworks; Vertical asset has Thermal; Confined space has none; Data fusion has all four; Road has Road; Telecom towers has Telecom.

### Assumption to confirm

- **Survey checks stays in Earthworks.** The founder moved Terrain analysis to core and did not mention Survey checks, so its section shows in survey, construction and data fusion projects, and elsewhere through the switch. Its other way in is unchanged in every project: Tools, Measure, Site data, "Survey QA and cleanup".

## 8. What the build changed from this plan

- **Four sets, not five** (decision 2), so there is no engineering record to look for and no engineering switch.
- **T8 (right-click actions) needed no code**, for the reason in section 2. The one piece of it that was built is the fact the Thermal set needs: the photo probe now says whether the project holds a thermal photo.
- **A new channel was needed** to save the switches, `project:setToolSets`: each project setting has its own channel, there is no shared one. It is in the contract row.
- **A section whose tool is open always shows**, whatever the sets. This rule was there before and is kept, so nothing that opens a panel (the site digest's "check the survey" action, a sector row) can lead nowhere.
- **The kit's Swipe tile** in the Compare mode belongs to Earthworks and leaves projects without the stockpile kit, where it could never start.
- **A survey or construction project that holds an antenna inventory now lists it** under "In this project". Before, those two types left the tower groups out even with antennas on disk.
