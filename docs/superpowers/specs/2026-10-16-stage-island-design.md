# Stage island and right-sidebar workbench (design)

Written on 16 Oct 2026 from the founder's brief and a three-round clickable prototype. Not yet approved; the plan follows approval at `docs/superpowers/plans/2026-10-16-stage-island.md`.

This is project 2 of the UI programme agreed on 16 Oct 2026 (1 foundation, 2 shell and 3D view, 3 finding things, 4 data screens, 5 bug sweep). It builds on project 1, `docs/superpowers/specs/2026-10-16-ui-foundation-design.md` (branch `feat/ui-foundation`), and merges after it.

## Why

The app covers earthworks and survey, telecom towers, roads, industrial inspection and drone video. The founder's main pain is breadth: "it becomes hard to remember where is what very quickly." The stage toolbar makes this worse. It is a row of icon groups across the top of the 3D view whose contents move between the bar and an icon-only More grid depending on window width, project and view, so a tool's place changes when the window is 40 px narrower. At 1100 × 720 the stage is about 450 px wide and floating chrome (video window, telemetry box, PAUSED chip, basemap chip, survey panels) covers about 40% of it.

The change gives every tool one stable home and gives the data the room:

- **A dynamic island**: one capsule at the top centre of the stage. It is the launcher and the one line of live status.
- **The right sidebar as the workbench**: anything that needs room opens there as a tab, and the front tab follows what the person is doing.
- **No title bar**: the stage runs to the top of the window.

The founder picked the island over a Mac-style auto-hiding menu bar and over group capsules, then asked for the sidebar link "so we have more surface to work and not all is stuck in the dynamic island. The right sidebar can change based on what we are doing", and later asked to "utilize the dynamic right side bar as much as possible".

## Visual spec

The prototype is the visual reference. It uses the app's real tokens (`packages/ui/src/tokens.css`), `mission.css` components, IBM Plex fonts and the app's own icon set (`packages/ui/src/icons/paths.tsx`), over a render of the demo tank farm:

- `C:\Users\D\AppData\Local\Temp\claude\C--Users-D\67f34414-2dff-4e4d-a0c1-a09341872ee9\scratchpad\stage-island\index.html` (open directly; a Demo chip at the bottom left jumps between states)
- Its screenshots `shot-1440-*.png` and `shot-1100-*.png` in the same folder: 01 rest with date, 02 ready, 03 date picker, 04 Measure quick tiles, 05 View, 06 Measure workbench, 07 live distance in the Measure tab, 08 two at once, 09 tab overflow, 10 Display workbench with timeline, 11 hidden sidebar drawer, 11b hidden without drawer, 12 issue edit does not follow, 13 offline, 14 Measure search, 15 agent maximised, 16 palette.

The scratchpad is temporary. The plan's first task copies `index.html`, its assets and the screenshots into `docs/design/stage-island/` so the spec survives (the demo render and brand files are already ours; check them with `tools/agent/check-public-text.mjs`).

The founder's earlier Cursor canvases (`C:\Users\D\.cursor\projects\e-Dev-AIO-Software\canvases\stage-island-sidebar.canvas.tsx`, `stage-dynamic-island-detail.canvas.tsx`) are the original direction; where they differ from the prototype, the prototype and this document win.

## Decisions

### The island

1. **Place and shape.** One capsule at the top centre of the stage, a pill when small and 16 px rounded when open (the one new shape; the rest of the app keeps its 2 to 6 px radii). It is a `role="toolbar"`. The stage surface stays dark in every theme (`data-surface="dark"`).
2. **States.**
   - **Rest**: a date pill, "● 13 Apr", in the survey's colour. It replaces the brief's three dots, because the date tells you which survey you are looking at and should never be hidden.
   - **Ready** (pointer near the top of the stage): it grows to "‹ ● 13 Apr · 2 of 2 › | 3D | Tools ⌄ T".
   - **Live**: the date pill stays, and one line of status sits beside it: the live tool and its reading ("Distance 12.40 m"), the playing clip with its progress, a processing job with a progress ring, or the connection state. **The date stays visible next to a live reading** (founder, 16 Oct).
   - **Two at once**: the island plus a round bubble beside it. Clicking the bubble swaps them.
   - **Tools open**: see decision 4.
3. **Priority of live items**: live tool, then playback, then jobs, then connection. Connection is the lowest and shows only when not healthy: "Offline" with an amber ring dot, "Reconnecting…" with a spinner, then "Back online" for about 2 s before returning to rest. Sync status is not on the island (founder: connection yes, sync not asked for).
4. **Tools.** Opened by clicking the island or pressing **T**. Top row: the 3D / Map / Split switch (keys 1 / 2 / 3 stay) and the group tabs; hovering a tab previews its quick row, clicking it opens the group's workbench in the sidebar (decision 12). Second row: a few quick tiles (icon, label, shortcut) and inline switches, plus a "→ right panel" tile that opens the workbench. Tiles that open settings in the sidebar carry the app's existing corner caret (`.tool .caret`); the island then shrinks back.
5. **Quick rows per group** (the full set lives in the workbench):
   - **View**: Whole site (H), Centre on project (G), Fly to selection (F), presets Iso / Top / North, Environment and time of day, Compare dates, **Timeline** (toggle tile), Ask the agent, Right panel (Ctrl+Alt+B).
   - **Measure**: Distance, Elevation, Area, Volume, Section plane (X), All tools (M opens Measure; see decision 9 on M).
   - **Display**: Issue pins (I), Labels Off / Key / All (L), Street map, Layers →.
   - **Point cloud** (projects with clouds): show, colour RGB / Elevation / Intensity / Flight, Clean up →.
   - **Volumes** (projects with two surveys): survey date and Swipe, surface Photo / Elevation / Cut-fill, bodies Lifted / In place / Hidden.
   - **Video and camera** (projects with video): video window (W), flight paths All / Active / Off (P), telemetry (D), camera Free orbit / Follow / Drone eye, See inside (C).
   - **Road** (road data, map or split view): close-up (C), PCI grid (P), defect density (D), measure on the map (M).
   - **Annotate** (A; not in packages): 3D pin, line, area, cloud point, cloud box; map point, line, area.
6. **Which groups show.** Only the groups the project has data for (point cloud, volumes, video, road), as today. View, Measure, Display and Annotate always show (Annotate is hidden in a read-only package, and survey tools are hidden there as today). Within a project the order and contents of the island never change with window width: narrow widths drop group-tab labels to icons (the current tab keeps its name) and wrap tiles, they never move a tool somewhere else. _My call_, from the findability discussion; pinning an industry profile on top is project 3.
7. **The date in the island.** Clicking the date opens a calendar inside the island: the month with survey days marked, the survey list, and "Compare the two dates". ‹ › and Alt+Left / Alt+Right step between surveys (existing `global.prevSurvey` / next). This replaces `DateRow` and `DateSteps up` (`workspace/DateRow.tsx`, `DatePicker.tsx`). The left sidebar's date list stays as it is.
8. **Motion.** Size changes animate over 0.4 s with `cubic-bezier(0.32, 0.72, 0, 1)` (the foundation's motion token; see Dependencies); content crossfades. Instant under `prefers-reduced-motion`.
9. **Keys.**
   - **T opens the tools** (founder). T stops toggling the timeline: `scene.timeline` loses its key and the timeline becomes the View tile. A new `scene.tools` entry (`keys: ['T']`) gets a row in Settings → Keyboard. The `aria-keyshortcuts` on `DateRow.tsx:17` and `WorkspaceScreen.tsx:108` go with them.
   - Every other existing shortcut keeps working unchanged: H, G, F, M, X, L, A, W, P, D, I, C, 1 / 2 / 3, Space, Enter, Backspace, Esc, Ctrl+Alt+B, and the road scope P, D, M, C.
   - **M** keeps starting "Measure a distance" exactly as today, so muscle memory and e2e specs hold; Measure → All tools has no new key.
   - **Ctrl+J** opens and focuses the agent dock (checked free in `packages/ui/src/shortcuts.ts`). New `global.agent` entry and a Settings → Keyboard row.
   - In the open island, arrow keys move between tiles, Tab moves between the rows, Esc closes.
10. **Link indicator.** When the sidebar's front tab is the island's live item, the island's outline turns the accent colour. Clicking the island brings that tab back to the front.

### The right sidebar as workbench

11. **Tabs, in order**: one per live activity (with a dot, in island priority order), then the open workbench or tool panel, then the fixed tabs (Selection, Issues, plus Volumes and Changes where they exist today). The tab bar is one row; whatever does not fit goes into a "⋯ n" menu. Fixed tabs leave first, then panels, then Selection; live tabs leave last and the tab in front never does. The ⋯ turns accent when a live tab is inside it. The fixed tabs keep their position at the end of the row so contextual tabs do not shuffle them (_my call_, from the Scene audit P1-2).
12. **Workbenches.** Every big group has a full tab:
    - **Measure**: search; Favourites and recent (star any row); every tool as a row (icon, name, one-line hint, shortcut) in families: Point (Elevation, Elevation difference, Annotation), Line (Distance, Grade and slope, Vertex differences, Berm check, Cross-section), Polygon (Area, Volume), Telecom (Antenna azimuth, Physical tilt, Clearance), Markup (Freehand), Section plane (X). Then Site data (Designs, Survey QA and cleanup, Terrain overlays, Hydrology, Haul road, Export survey data), Drawing aids, Templates, and "Saved in this project" with Show all / Hide all and an eye per row. Read-only packages hide the survey tools, as today.
    - **Display**: labels, issue pins with severity filter and heat map, the full layer tree by kind with eyes, street map.
    - **Point cloud**: show, colour with legend, size and EDL, the clouds list, Clean up, Survey QA.
    - **Volumes**: the existing Volumes tab, with date, swipe, surface, bodies and the section line above the inventory.
    - **Video and camera**: the playing clip as a player card on top (preview, scrubber), then the clip list, camera mode, flight paths, telemetry.
    - **Road**: overlay with legend, close-up, layers, measure on the map.
    - **Annotate**: tools on the model, the cloud and the map, plus drafts.
13. **Live morph.** When a tool goes live its workbench changes in place: a live card on top (large reading, points with coordinates, Undo / Stop / Save with their keys) and the catalogue shrinks to a strip of tool buttons so the person can switch tools without leaving. The strip shows short text labels, not icons alone (several Line tools share a glyph). Stopping the tool: if the tool opened the tab, the tab closes and the sidebar returns to Selection; if the person had opened the workbench, it returns to the full catalogue.
14. **Following.** Starting a tool brings its tab to the front. Exception (founder): **never take over from an issue being edited**. While the Issues tab has an issue in edit, the new live tab only gets a pulsing dot and a small "Show it" note. Stopping a tool or closing a panel returns to Selection.
15. **Pins.** Workbenches and tool panels opened from the island are tabs with a pin. An unpinned one closes when a tool starts, and a new unpinned one replaces the previous unpinned one (like preview tabs).
16. **Collapsible sections** in every workbench: a header row with chevron, title and count; click, Enter or Space toggles; the height animates with the motion token and is instant under reduced motion. State is remembered per tab. "Collapse all / Expand all" is one icon button in the workbench header. Defaults: Favourites and recent plus the live tool's family open, the rest collapsed (Display opens Labels and Pins). Search opens sections with matches and hides empty ones; clearing it restores the remembered state. The live tool's family stays open while it is live.
17. **Width.** A drag handle on the sidebar's left edge (the foundation's `ResizableSplit`), width remembered per computer. Tabs may declare a minimum: Volumes and Changes open at least 470 px wide and return to the person's width when left. The width no longer jumps between 400 and 360 px with the project (`.ws-vol { --rp-w: 400px }`, `styles.css:2043`, goes).
18. **Former floating panels become tabs**: the measurement list, Survey QA, Terrain overlays, Hydrology and Point cloud cleanup. The survey draw bar and the two stacked floating panels ("Measurements", "Distance 1") go; their content lives in the Measure workbench and the island's live line.
19. **One measuring system.** "Measure a distance" (view tools) and "Survey measurements → Distance" become one Distance tool. A result stays on the canvas, and Save (Enter) puts it in "Saved in this project". The plan decides how the two code paths merge (`StageTools.tsx` `MeasureTools` and `survey/MeasureToolbar.tsx`); the saved-measurement data model of the survey system is the one kept.
20. **Sidebar hidden** (Ctrl+Alt+B): the same content slides in as a drawer over the right edge of the stage when something goes live or the island is clicked, and slides out when it ends or on Esc. The drawer has no agent dock.

### The agent dock

21. **Resizable**: a horizontal drag bar between the workbench and the agent (`ResizableSplit`, vertical), height remembered, double-click resets to about 60 / 40 workbench / agent.
22. **Maximise** gives the agent the whole sidebar below the tab bar; clicking a tab or Restore brings the workbench back. **Minimise** folds it to one line, "Ask about ‹context› · Ctrl J".
23. **When a tool goes live** the agent drops to its one line, unless the person resized it, and comes back when the tool stops.
24. **AI off.** The "agent is off" message collapses to one row ("Agent off · Turn on") until clicked, instead of taking half the column. Cloud AI status ("Cloud AI off") moves from the title bar into the agent header.
25. **Ways in**: Ctrl+J, the Agent button in the sidebar header, and the "Ask the agent" tile in View.

### No title bar

26. **The title bar goes** (founder, overriding the brief's "it stays"). The stage runs to the top of the window. Its contents move:
    - Logo and project switcher (now reading "client / project") → top of the left sidebar, with a search icon that opens Ctrl+K.
    - Help (?) → beside Settings at the foot of the left sidebar.
    - Processing chip → gone; jobs are an island live item and a sidebar tab. Online chip → gone from the top; connection is an island live item and a compact status row at the foot of the left sidebar ("● Online · 1 job") that opens the existing connection menu and processing drawer.
    - Cloud AI status → agent header.
    - Share and Agent → the right sidebar's header row.
    - Breadcrumbs → gone; the left sidebar's active item and the project switcher say where you are.
27. **Window controls.** Electron keeps `titleBarStyle: 'hidden'` with `titleBarOverlay` height 40 (`apps/desktop/src/main/index.ts:1998`). The right sidebar's 40 px header row reserves about 138 px on its right for the native caption buttons. That row and the left sidebar's logo row are the window drag regions (`app-region: drag`, with `no-drag` on their buttons); the stage top is not draggable.
28. **Right sidebar hidden**: only the window controls remain, floating top-right over the stage on a small dark backing so they read on a light ground, with the panel toggle to their left. **The agent and Share are not shown** (founder); Ctrl+J and Ctrl+K still reach them. The overlay colours come from `chrome()` as today.
29. **Screens other than the Scene** (Projects, Globe, Issues, Media, Detections, Reports, Settings, Help) each get a 40 px page header row of their own: title on the left, the screen's actions on the right, 138 px inset for the caption buttons, drag region on the empty part. The dataset tree shows only on the Scene; on other screens the space under the nav is empty or holds that screen's own secondary nav. The left nav is pinned above a separately scrolling tree. (The Settings page list moving into the left sidebar is project 3; this project only removes the tree there.)

### Stage room at 1100 × 720

30. **Overlays dock instead of covering the model.** A stage overlay layout with four corner slots plus the top-centre island; an overlay takes a free slot and never stacks on another.
    - Telemetry becomes part of the island's live line ("ALT 31 m · SPD 3.2 m/s") and the Video workbench, not a box on the model.
    - The PAUSED chip goes; playback state is the island's live item.
    - One basemap chip per stage, never per pane.
    - The coordinates readout gets a scrim so it reads on a light ground.
    - The floating video window becomes resizable (it already remembers size per project), and docking means a side or bottom split with a draggable divider, not a corner with a black void under it.
31. **Split and Compare.** Each pane owns a header strip (date chip, view name, link toggle) that no global overlay covers. The split divider is the shared `ResizableSplit`. Compare's unlabelled "?" becomes a labelled "How compare works" link.
32. **Left sidebar at narrow widths.** Below about 1280 px wide the left sidebar collapses to its rail when the Scene opens; it stays expanded on other screens, where it is the navigation. _My call_, from the Scene audit P0-1.

## Dependencies on project 1 (foundation)

This project consumes, and does not build its own:

- Motion, spacing, shadow and z-index tokens (the island and drawer z-layers come from the z-index scale).
- The button set (sizes 24 / 28 / 32, variants, pressed and busy states), the one popover surface, the one tab style and the chip kinds.
- `ResizableSplit`: the sidebar edge, the agent splitter, Split view's divider and the docked video.
- The type scale (workbench section titles, the live reading).

If the foundation lands late, the plan may build against the foundation branch, but the island and workbench must not ship their own button, tab or splitter variants.

## What stays

- Every existing shortcut except T (decision 9) behaves as today.
- Every pop-out panel's behaviour moves intact into its tab; the panel components (`MeasureToolbar`, `VolumeTools`, `RoadToolGroup`, `EnvironmentTool`, `StreetMapTool`, `CutawayTool`, the cloud and flight-path tools) are re-homed, not rewritten.
- The e2e `data-testid`s stay on the same controls: `survey-tools`, `cloud-panel`, `path-panel`, `cleanup-tool`, `env-panel`, `help-open`, `date-row` (moves with the date into the island) and the rest. Accessible names that specs click stay the same ("3D", "Map", "Split", "Measure a distance", the Volumes switches such as "Cut / fill", "Close the measurements list" and so on).
- `AgentHost`, `ContextPanel` and `RoadPanel` keep their logic; their containers change.
- The left sidebar's date list, dataset tree and right-click menus are unchanged apart from where the tree shows.

## e2e specs touched

These specs click toolbar, title-bar or date-row controls and will need their locators checked or moved (a first pass found 22): `a11y`, `agent-show`, `change-cloud`, `compare`, `compliance`, `connection`, `designs`, `environment`, `globe`, `haul`, `hcl`, `help`, `hydro`, `ringroad`, `small-window`, `smoke`, `stage-display`, `street-map-3d`, `survey-gaps`, `survey-qa`, `timeline-lanes`, `volumetric-build`. Where a control now sits behind the island, specs open the island first through a shared fixture helper instead of each spec learning the island. New specs: island states and keys, sidebar following with the issue-edit exception, workbench sections and search, sidebar and agent resizing, the hidden-sidebar drawer, and the 1100 × 720 layout (`small-window`). All run the CI way (CONTRIBUTING.md, "End to end the way CI runs it").

## Accessibility

The island is a `role="toolbar"` with an accessible name; arrow keys move between tiles; Esc closes the tools, the date calendar and the drawer. Focus is trapped in the drawer and in the open island, and returns to the island on close. Sections are buttons with `aria-expanded`. Splitters are `role="separator"` with arrow-key resizing. Live status changes are announced through a polite live region (readings at most once a second). Reduced motion turns every morph and slide into an instant change.

## Copy

No em or en dashes in UI text. Labels as in the prototype: "Tools", "All tools", "Show it", "Collapse all", "Expand all", "Agent off · Turn on", "Ask about ‹context›", "Offline", "Reconnecting…", "Back online", "How compare works". Dates "13 Apr 2026", never a native date input.

## Left to the builder

- How the island's state machine and the sidebar's tab model are split into stores and components, and how existing tool state (survey session, measure session, playback, jobs, connection) feeds them.
- Exact pixel sizes within the prototype's look, as long as the 1100 × 720 window keeps the island and stage usable.
- Which internal components are merged when the two measuring paths become one (decision 19).
- The overlay slot layout's algorithm (decision 30).

## Out of scope (other projects)

- Ctrl+K indexing every tool, setting, layer, date and help topic, Settings regrouping and search, industry profiles, icon and verb cleanup, new wizard project types: project 3.
- Issues, Media, Detections and Reports layouts and their resizable splits: project 4.
- The audit's small bugs (date-prompt banner wrapping, "DATASETS10", duplicate "File under" value, clipped Cut / fill in More): project 5. Cut / fill disappears with More here anyway.
- Light-theme stage chrome: the stage stays dark (decision 1); the foundation scopes stage tokens so light values never leak in.

## Risks and open points

- **Size.** This is the largest of the five projects and touches most e2e specs. The plan should land it in stages behind no flags: island and title bar first, then workbenches, then overlays and Split.
- **T for the timeline.** People who use T for the timeline lose it. The View tile, the island's Tools hint and a one-time notice ("T now opens the tools; the timeline is in View") cover the change.
- **Hover to switch group tabs** can fire by accident while crossing the island; hover only previews, click commits.
