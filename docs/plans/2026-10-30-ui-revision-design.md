# UI revision: design

Date: 2026-10-30. Branch `docs/ui-revision` (this design and its plan). Founder decisions taken 30 Oct 2026 (below). The Wave 2 layout is built only after the founder approves an in-app spike in the real UI (gate G1); once approved, the rest is built without further plan-approval waits.

Plan and tracker: `docs/plans/2026-10-30-ui-revision.md`. Evidence: `docs/design/ui-review-2026-10/` (visual critique, code audit, annotated screenshots).

## Intent

The review of `main` at `d13e6a6b9` found a domain-true tool whose shell has grown by accretion: every feature added its own surface, and the 3D stage, the product's first principle, is the space left between them (44 % of the window width at 1280 px, 35 % at 1100 px, then covered by a floating video, a toast, tooltips and clipped labels). There are four tool catalogues and the palette indexes none of them; the right panel has 20 tab ids that reshuffle and change width; the AI is named five ways and its status dot is green when no AI can run; Settings put things where nobody looks.

This project makes the shell structurally quieter: four fixed right-panel tabs, one tool registry, the video docked in the bottom strip, fixed overlay slots, one truthful AI status, layout presets per project type, Settings by topic, and a design system that keeps it that way. It ships in three waves tracked as one project.

## Founder decisions (30 Oct 2026, binding)

1. **All three waves**, tracked as one project and parallelised wherever files allow: Wave 1 quick polish, Wave 2 placement and information architecture, Wave 3 design-system consolidation.
2. **Layout presets per project type.** Each project type opens with its own preset: which right-panel sections lead, the bottom strip mode, the island mode and which panels show by default. Presets choose **defaults only**: any project can add any data kind and reach any tool (a survey project can add video). No feature is ever gated by project type, and presets react to the data the project actually holds.
3. **Video docked by default** as a tile in the bottom strip, with a pop-out button to a floating, resizable, movable window (the docked tile is too small to inspect) and a pop-in button back. No tile when the project has no video.
4. **Wave 2 needs an in-app spike** in the real UI, behind a dev flag, that the founder approves (gate G1). After approval, build without further plan-approval waits.

Earlier rules that still bind: tools are never hidden behind menus or a project type (24 Oct, right sidebar; restated in the analysis frame spec, `docs/superpowers/specs/2026-10-26-analysis-structure-design.md`); every sidebar action is on right-click through the shared action registry (15 Oct); approved mock-ups mean build now (24 Oct).

## 1. Shell regions

```
+------+----------+------------------------------------+-----------------+
| Rail | Title bar 40 px: Project v > Site > Date v | Ctrl+K | AI chip | Jobs chip | (window buttons) |
| 52px +----------+------------------------------------+-----------------+
|      | Layers   |  STAGE (3D / Map / Split)          | Right panel     |
|      | column   |  island top-centre                 | Selection       |
|      | (Scene   |  [map style, zoom]     top-right   | Tools           |
|      | only)    |  [hint or toast]       bottom-left | Layers & display|
|      |          |  [compass, scale, legend] bot-right| Project         |
|      |          +------------------------------------+                 |
|      |          | Bottom strip: [video tile] dates / footage / volume / chainage | Agent dock |
+------+----------+------------------------------------+-----------------+
```

- **Rail (52 px, always present):** Projects, Globe, Scene, Issues, Inspect, Reports; spacer; Processing (badge while jobs run), Help, Settings. Labels show on hover and focus. The status dots leave the sidebar foot (the AI chip and Jobs chip move to the title bar).
- **Title bar (40 px):** project breadcrumb "Customer > Project v > Date v" with full names (the customer as a second line in the menu), Ctrl+K search, the AI chip, the Jobs chip. It leaves room for the window buttons (the existing caption backing). The project menu holds Project settings and Audit trail.
- **Layers column:** today's dataset tree (`shell/Sidebar.tsx` `Datasets`) at full height with date folders, eye toggles and the import toolbar; its own collapse and shortcut (Ctrl+L); shown on Scene only. Hint cards leave the tree.
- **Stage:** the 3D, Map or Split view with the island and the fixed overlay slots (section 5).
- **Bottom strip:** the docked video tile at its left end (section 4) and a mode-switched main area: dates strip (default), footage tracks, volume over time, chainage ruler. Collapsible to a 32 px scrubber.
- **Right panel:** four fixed tabs (section 2), one user-resizable width, the agent docked at its foot.

### Widths per breakpoint (window width)

| Region                                                 | >= 1440 px                        | 1280 to 1440 px                   | 1100 to 1280 px                                                                  |
| ------------------------------------------------------ | --------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| Rail                                                   | 52                                | 52                                | 52                                                                               |
| Layers column                                          | 240, open                         | 240, collapsed by default         | collapsed; opens as an overlay over the stage, closes on Escape or outside click |
| Right panel                                            | 360 default, resizable 320 to 520 | 320 default, resizable 300 to 480 | 300 default, resizable 280 to 400; folds to a 13 px strip like today             |
| Bottom strip                                           | 160                               | 140                               | 120                                                                              |
| Stage at the smallest width of the band, Layers closed | 1028 of 1440 (71 %)               | 908 of 1280 (71 %)                | 748 of 1100 (68 %)                                                               |

- A width the user drags is remembered per band (localStorage, the `splitPrefs` pattern), and opening a tab never changes it. The 470 px "wide tab" rule (`workbenchStore.ts` `WIDE_TAB_PX`, `isWide`) goes; a wide tool (Coverage, Thermal) offers an "Expand panel" button that the user presses.
- Auto behaviour follows `shell/autoFold.ts` today: it applies when the window crosses a band, and stops for a region the user opened or closed by hand in that session.
- Inspect keeps its "Findings (0)" collapse; it is the pattern for any column that does not fit.

## 2. Right panel: four fixed tabs

Tabs, in this order, always present, never pinned, closed or moved to overflow: **Selection, Tools, Layers & display, Project.** Each tab is a scrolling list of **sections** (`workbench/Section.tsx`, collapsible, searchable as today). A section appears when the project holds its data or the user opened its tool, never because of the project type; the preset only decides which sections lead and which start open.

### Mapping the 20 tab ids (`workbench/tabsModel.ts` `TAB_IDS`)

| Tab id today  | Label today         | Component                                                          | New home                                                                                                                                                                                      |
| ------------- | ------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selection`   | Selection           | `road/RoadPanel`, `issueCard/IssueCard`, `workspace/SelectionCard` | **Selection** (unchanged content; empty state "Click something on the site" instead of the project)                                                                                           |
| `measure`     | Project             | `benches/MeasureBench`                                             | split: its "In this project" list (`project/ProjectList`) goes to **Project**, top section; its tool catalogue goes to **Tools > Measure**; its live tool card stays the armed state of Tools |
| `annotate`    | Annotate            | `benches/AnnotateBench`                                            | **Tools > Annotate**                                                                                                                                                                          |
| `volumes`     | Volumes             | `benches/VolumesBench`                                             | **Project > Volumes** (header, Inventory, Cut & fill, Materials and the pile panel as landed in the volumetrics redesign); its kit controls go to **Tools > Volumes**                         |
| `changes`     | Changes             | `change/ChangesTab`                                                | **Project > Changes**                                                                                                                                                                         |
| `issues`      | Issues              | `@aio/annotate` `IssueRegister`                                    | **Project > Issues**: a summary section (section 8); the full register is the Issues screen                                                                                                   |
| `road`        | Road                | `benches/RoadBench`                                                | **Project > Road** (defect register, condition) and **Tools > Road** (road tools)                                                                                                             |
| `jobs`        | Jobs                | `benches/JobsBench`                                                | **Project > Jobs** (the Jobs chip opens it)                                                                                                                                                   |
| `display`     | Display             | `benches/DisplayBench`                                             | **Layers & display > Display**                                                                                                                                                                |
| `clouds`      | Point cloud         | `benches/CloudBench`                                               | **Layers & display > Point cloud** (colouring, size, classes); cloud edit tools go to **Tools > Point cloud**                                                                                 |
| `overlays`    | Terrain overlays    | `survey/Overlays`                                                  | **Layers & display > Terrain overlays**                                                                                                                                                       |
| `cutaway`     | Cutaway             | `workspace/CutawayTool`                                            | **Layers & display > Section planes**                                                                                                                                                         |
| `video`       | Video               | `benches/VideoBench`                                               | **Tools > Video** (sync, playback, telemetry); the clips themselves are rows in the Layers column                                                                                             |
| `qa`          | Survey QA           | `survey/Qa` `QaSide`                                               | **Tools > Survey checks**                                                                                                                                                                     |
| `hydro`       | Hydrology           | `survey/Hydro` `HydroTab`                                          | **Tools > Terrain analysis**                                                                                                                                                                  |
| `cleanup`     | Point cloud cleanup | `pointcloud/CleanupTab`                                            | **Tools > Point cloud**                                                                                                                                                                       |
| `review`      | Model review        | `benches/ReviewBench`                                              | **Tools > Engineering**                                                                                                                                                                       |
| `environment` | Environment         | `environment/EnvironmentTool`                                      | **Tools > Environment**                                                                                                                                                                       |
| `rf`          | Coverage            | `benches/RfBench`                                                  | **Tools > Coverage** (with "Expand panel")                                                                                                                                                    |
| `thermal`     | Thermal             | `benches/ThermalBench`                                             | **Tools > Thermal** (with "Expand panel")                                                                                                                                                     |

- The Show control (Photo, Elevation, Cut & fill; `workspace/StageShow.tsx`) and the Streets button (`StreetMapTool.tsx`) leave the stage: Show becomes the first section of **Layers & display** with a one-key toggle (V cycles), Streets joins the map style control in the stage's top-right slot.
- "Agent" and "Share" in the right header (`shell/RightHeader.tsx`) are styled as icon buttons, not tab look-alikes.
- Saved pins (`quadrion.workbench` localStorage) are dropped on first run of the new panel; the old "front tab" maps to its new tab and section once, so a reopened project lands where the user was.

## 3. One tool registry

- **One registry** (`apps/desktop/src/renderer/tools/registry.ts`): each tool has an id, its group, a label key, an icon, its shortcut id (`packages/ui/src/shortcuts.ts`), `available(ctx)` (from the data the project holds and the current view, never the project type), and `start()`. It replaces `survey/measureCatalogue.ts` and the per-group lists in `workspace/island/groups.tsx`.
- **Groups**, one order everywhere: View, Measure, Annotate, Volumes, Point cloud, Terrain analysis, Survey checks, Video, Road, Engineering, Coverage, Thermal, Environment. A preset reorders groups; it never removes one.
- **Rendered two ways only:**
  - the **Tools tab**: every available group as a section, in registry order (preset order first). An armed tool replaces the list with the tool card (today's `LiveCard` with Undo, Stop, Save and keys) and a "Back to tools" link; Escape returns to the list. The 18-chip strip (`MeasureBench.tsx` `Strip`, `.meb-strip`) and the island "All tools" panel go.
  - the **island**: collapsed as today (3D | Map | Split, date, the live tool chip); expanded **on click, not on hover**, as one 44 px row of labelled modes: View, Measure, Annotate, Volumes, Compare, Video, and Road when the project has a road. A mode opens its group in the Tools tab and shows that group's top 4 or 5 tools (favourites, then recent) as a second slim row. It never covers more than 100 px of the stage and stays centred on the whole stage, in Split and compare too.
- **The palette** (`shell/Palette.tsx`) indexes the registry: every tool ("Measure distance D"), every tab and section ("Go to Project > Volumes"), every island mode, every Settings page, each with its shortcut shown and its keywords. Tools that are not available say why ("Needs a point cloud") instead of vanishing. Wave 1 indexes today's sources (catalogue, island groups, tab ids, shortcuts); the registry replaces that source in Wave 2.

## 4. Video: docked tile and pop-out

- **Docked (default when the project has video):** a 16:9 tile at the left end of the bottom strip, as tall as the strip minus 8 px (about 270 x 152 at a 160 px strip), with the telemetry overlay and three icon buttons: Play/Pause, Pop out, Close. It follows the playhead of the footage or dates strip.
- **Pop out:** a floating window over the stage, movable by its title bar, resizable from its corners (minimum 320 x 180, maximum 80 % of the stage), aspect kept; first placed top-left of the stage clear of the island and the top-right slot; position and size remembered per user. It has Pop in, which returns it to the tile. Escape does not close it (Escape belongs to tools).
- **Closed:** no tile when the project has no video. When the user closes a tile, it comes back from the video row in the Layers column, from the bottom strip's Footage mode, or from the palette ("Show video").
- The floating window replaces today's `workspace/FloatingVideo.tsx` default (280 to 400 px open over the stage at every open); its dock corners (`VideoDock`) and `videoWindow.ts` geometry are reused for the pop-out. State: `docked | floating | closed` per project, in a small store owned by the video module (not `store.ts` `shell.videoHidden`, which it replaces).

## 5. Fixed stage overlay slots

Only these slots exist (`workspace/overlaySlots.ts` becomes the single source):

| Slot         | Holds                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Top centre   | The island, nothing else                                                                                          |
| Top right    | Map style (incl. Streets) and zoom                                                                                |
| Bottom left  | One hint or one toast at a time (newest wins; older toasts wait in the queue, job progress goes to the Jobs chip) |
| Bottom right | Compass, scale bar, and the active legend stacked above them                                                      |
| Floating     | Only the popped-out video window and the tool card's on-stage handles                                             |

- Scene labels (pile names, measurement tags) clamp to the stage rectangle and collapse to an edge dot when their anchor is off-stage; in Split, each pane clamps to its own rectangle.
- The "No map pack" notice shows once per session as a dismissible line in the bottom-left slot, not in every pane; without a map pack the map draws a faint 100 m grid.
- Tooltips hide on pointer leave and on any pointer down, everywhere (`packages/ui/src/Tip.tsx` and the CSS `.tip` rule in `mission.css`).

## 6. One truthful AI status, one AI name

- **One state function** (`apps/desktop/src/renderer/shell/aiStatus.ts`) combines today's three sources: the shell settings (`shell/connection.ts`, `settings.cloudAi`, `offlineOnly`, `cloudAiBlocked()`), the agent session (`agent/session.ts`, `packages/ai/src/session.ts` availability) and the Ask AI backend (`inspect/askAi/backend.ts` `resolveBackend`), plus the open project's `aiPolicy`.
- **One chip**, in the sidebar foot during Wave 1 and in the title bar from Wave 2:

| State                   | Look                                 | Click                        |
| ----------------------- | ------------------------------------ | ---------------------------- |
| AI ready                | green dot, "AI ready"                | opens the agent dock         |
| Local model             | neutral dot, "Local model"           | opens the agent dock         |
| AI off: no key          | amber dot, "AI off: no key"          | Settings > AI providers      |
| AI off: offline only    | neutral dot, "AI off: offline"       | Settings > Privacy and cloud |
| AI off for this project | amber dot, "AI off for this project" | Project settings             |

Reserved (section 13, not built here): an "Offline agent ready" state for the bundled local model, between AI ready and Local model; `AiState` and the chip leave room for it.

Green means a request would run now, never "permitted". The agent pane's footer row ("Agent off, Turn on", `agent/AgentPane.tsx`) and Inspect's "No AI can look at this" read the same state and offer the same fix.

- **One name.** The feature is **Ask AI** everywhere: the agent dock ("Ask AI", Ctrl+J), the island tile, the photo button ("Ask AI about this photo"), the settings page section ("Ask AI" settings move into AI providers). "Agent", "Ask agent", "AI for Ask AI" and "Cloud AI" go from the UI; "cloud" alone means online, and the 3D data is always "point cloud". (Open decision 1 if the founder prefers another name.)

## 7. Layout presets per project type

- **Types are the wizard's purposes** (`packages/schema/src/builder.ts` `ProjectPurpose`): `survey`, `construction`, `vertical-asset`, `confined-space`, `data-fusion`, `road`, `telecom`; a project without a purpose falls back by `ProjectType` (`volumetric` to survey, `road` to road, `inspection` to vertical-asset, `fusion` and `twin` to data-fusion). The demo tank farm is a survey project. The analysis frame's new types (solar, oil and gas) add rows to the same table when that frame lands; a project with several ticked types uses its primary type's preset.
- **A preset is code, not data:** `apps/desktop/src/renderer/layout/presets.ts`. No manifest field, so no contract change. A preset sets only these defaults:

| Preset         | Right panel tab on open | Project sections, first  | Bottom strip                         | Island mode | Stage | Layers column (>= 1440) |
| -------------- | ----------------------- | ------------------------ | ------------------------------------ | ----------- | ----- | ----------------------- |
| survey         | Project                 | Volumes, Changes, Issues | Volume over time                     | Volumes     | 3D    | open                    |
| construction   | Project                 | Changes, Issues, Volumes | Dates                                | Compare     | Map   | open                    |
| vertical-asset | Selection               | Issues, In this project  | Footage if video, else Dates         | View        | 3D    | open                    |
| confined-space | Selection               | Issues, In this project  | Footage if video or walk, else Dates | Video       | 3D    | open                    |
| data-fusion    | Layers & display        | In this project, Issues  | Dates                                | View        | 3D    | open                    |
| road           | Project                 | Road, Issues             | Chainage                             | Road        | Map   | collapsed               |
| telecom        | Selection               | Issues, In this project  | Dates                                | Measure     | 3D    | open                    |

- **Data decides what exists, the preset only orders it.** A selector `projectData(manifest, stores)` (`layout/projectData.ts`) reports what the project holds: video, walks, panoramas, photos, point cloud, mesh, ortho, DSM, two or more survey dates, piles, road, antennas, thermal photos. A preset value that the data cannot honour falls back in a fixed order: Volume over time without piles becomes Dates; Footage without video becomes Dates; Chainage without a road becomes Dates; a Project section without data is not shown. The video tile follows the data (docked when there is video), whatever the preset.
- **No gating, ever.** Every tool, section, mode and import stays reachable in every project: the Tools tab lists every group whose data exists, the palette lists every tool, and the import toolbar accepts every data kind. A test asserts that the set of reachable tools for a given data set is identical across all seven presets.
- **The user's changes win.** Once the user moves away from a default (another tab, another strip mode, a closed tile), that choice is remembered per project in localStorage (`quadrion.layout.<projectId>`) and used on the next open. "Reset layout to project defaults" sits in the project menu and the palette.
- Presets apply on project open and when the project gains a new data kind (adding the first video docks the tile; it does not switch the tab).

## 8. One canonical Issues view

- The **Issues screen** (rail) is the full register (`screens/Issues.tsx` with `IssueRegister` and `IssueCard`), unchanged.
- **Project > Issues** is a summary section: counts by severity, the five most severe open issues (click selects it on the stage and shows its card in Selection), and "Open in Issues" which goes to the Issues screen with the same filter. It is a renderer component; `@aio/annotate` `IssueRegister` keeps one host.
- Issue filters on the Issues screen show three filters and a "Filters (n)" button (Wave 2, decision walls).

## 9. Settings reorganisation

Pages by topic (today `screens/Settings.tsx` `PAGES`, 15 pages in three groups):

| Group                                   | Pages                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intelligence                            | **AI providers** (providers, routing and the Ask AI settings; the hard-coded "Providers ... supported" heading through i18n), **Local model**, **Models and detection** (detection models from the AI page, the detector library and the Analytics pack from Processing tools), Usage and cost, Privacy and cloud (app-wide only) |
| Data                                    | Identity and team, Data folder, Processing tools (engine, tools, other packs, advanced pipelines), Offline maps (raster packs, downloads), Map sources, **Datums** (geoid packs from Offline maps, vertical datum notes), Severity models, Classes, Report branding                                                               |
| App                                     | Graphics quality, Appearance, Keyboard, About and updates                                                                                                                                                                                                                                                                         |
| This project (only with a project open) | **Project settings**: project privacy and AI policy (`settings/ProjectPrivacy.tsx`), project maps (`MapPacks.tsx` `ProjectMaps`)                                                                                                                                                                                                  |

- Old deep links keep working: `openSettingsPage('ai' | 'tools' | 'maps' | 'privacy')` land on the page that now holds the asked-for section, through the `FOCUS_PAGE` map in `store.ts` (new focus ids `detector-library`, `analytics-pack`, `geoid`, `project-privacy`, `project-maps`). Callers move to the new ids in Wave 3.
- Project settings is also reached from the project menu (title bar, Wave 2) and the palette.
- Each settings item gets its own icon (no shared key icon for Identity and Keyboard, no shared diamond for Severity, Classes and Issues). The Processing tools toggle row "Prepare surfaces when a project opens" sits inside its section with its toggle at the right (today `settings/ProcessingEngine.tsx` renders it outside `.processing-engine`). The Keyboard search placeholder fits.

## 10. "Create maps from photos"

- Leaves the sidebar (`shell/CreateMapsButton.tsx`, mounted in `shell/SidebarTop.tsx`).
- Is the primary action of the Processing panel (`processing/DrawerList.tsx`, `data-testid="create-maps"`).
- Appears on a library card (`screens/Projects.tsx` `ProjectCard`) when the project has photos and no maps, and as the empty-state action of the scene (`workspace/LayerPlaceholder.tsx`) for a photo-only project.
- Stays in the palette and in the photo layer's right-click menu (`shell/actions/kindActions.tsx`).
- Teal (accent) then means the current primary action on the screen, not brand presence; the welcome card collapses to a one-line "Workstation setup 2 of 4" strip once a project exists.

## 11. Polish (Wave 1)

The twelve defects of the review's checklist, each with its fix in the plan (W1a to W1c): switcher names cut to one letter; Globe cluster dot over its label; missing space and misplaced toggle in Processing tools; compare at 1100 px (clipped island, "3..." headers); video window over the stage, toasts and the map notice; overlapping map labels and a small first fit; truncated "Class" and "Severity" selects, footage clock, "Cut & fill" wrap, Keyboard placeholder; pile labels clipped at panel and pane edges; sticky tooltips; Ctrl+K "measure" finds no tools; the green "Cloud AI" dot; island label "View" while previewing Annotate. Plus: map fits the union of layer extents with 8 % padding (corridors rotated so the long axis is horizontal), "Delete run" moved into a menu with confirmation, the Globe starfield and glow and the decorative blur removed.

## 12. Design system (Wave 3)

- `@aio/ui` gains `Dialog` (on `useFocusTrap`, Escape, labelled, one scrim), a toast host (`toast()`, one queue, `role="status"`, the bottom-left stage slot or the window corner off-stage) and a hardened `Menu` (roving focus, typeahead, submenus for "Position >" and "File under >"). Then the 26 `dlg-scrim` copies, the 20 hand-built toasts and the 16 hand-rolled `role="menu"` move to them.
- The CSS guard (`packages/ui/src/cssGuard.test.ts`, `cssGuard.allow.json`) gains spacing px, off-scale radius and outline-none metrics and only shrinks. The eight side-stripe accents, the decorative globe blur, width and padding transitions and the dead `.conn-cloud` rules go.
- Accessibility: the issue select toggle (`IssueRegister.tsx:372`), the click handlers on a div (`Island.tsx:643`) and a table row (`InventoryPane.tsx:274`) become buttons or get keyboard handlers.
- Buttons move to `<Button>` / `<IconButton>` file by file as a file is touched for any other reason (a standing rule, not a workstream).
- Naming glossary (`docs/design/glossary.md`): one AI name, "point cloud", no app-invented terms in the UI ("Every date", "bench", "island", "File them").

## 13. Reserved homes for proposed AI surfaces (not built here)

The intelligence review (branch `docs/intelligence-review`, `docs/design/intelligence-review-2026-10/README.md`) proposes new AI surfaces. None is built and each waits on the founder's picks. This project plans **no build work** for them; it only keeps a place free so the layout does not need another reshuffle when they come:

| Surface                                                                                                                   | Reserved home                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site digest (typed insights, each with evidence and a next action), trends and days-to-empty, QA fitness flags on figures | **Project** tab: a "Digest" section slot at the top of the section list (above the preset's first section), and a flag slot on each figure row in Volumes and Changes |
| Suggested prompts, plan and batch-approval cards                                                                          | **Agent dock** at the foot of the right panel: a prompt row above the input and a card list inside the conversation                                                   |
| Detector bench results, learning status, "apply suggested threshold", optional add-on packs                               | **Settings > Models and detection**: sections after the detector library and the Analytics pack                                                                       |
| "Offline agent ready" for the bundled local model                                                                         | **AI chip**: one more state (section 6)                                                                                                                               |
| Automatic "survey QA and change compute after a new date" switch                                                          | **Settings > Processing tools**, in the same section as "Prepare surfaces when a project opens"                                                                       |

W7 (Project tab sections), W2 (`AiState`) and W6 (Settings page layout) keep these slots possible: section order is data, `AiState` is a union that can grow, and the Models and detection page is a list of sections.

## Non-goals

- New features. This project moves, merges and fixes surfaces; it adds no analysis.
- A redesign of the report pages, the Builder or the Modeller screens beyond shared components.
- macOS (parked).

## Open decisions for the founder

1. **The AI name.** Proposed "Ask AI" everywhere (section 6). Alternative: "Assistant" for the docked chat and "Ask AI" for photo questions.
2. **Below 1280 px, does the right panel push or overlay the stage?** Proposed push at 300 px (stage 68 % at 1100 px); overlay is the alternative if the spike shows the stage too narrow in Split.
3. **The pile panel's home.** Proposed: stays inside Project > Volumes as landed; alternative: a selected pile opens in Selection like every other selection.
4. **Preset table (section 7).** Confirm the defaults per type, especially construction (Map and Compare) and telecom (Measure).
5. **Island on hover.** Proposed click-only; keep hover-open as a setting for those who like it?
