# Quadrion AI: design critique (shell, scene and screens)

Evidence: 83 screenshots from `main` @ d13e6a6b9 (30 Oct 2026), 1280 x 800 plus the 1100 x 720 CI size, four demo projects. This is an independent design-director review (Assessment A only, no detector run). Screenshot names are in brackets.

## Verdict in one paragraph

This is not AI slop. It is a real tool built by people who know the domain. It uses IBM Plex, mono for figures and codes, UTM readouts, signed volume deltas, a chainage histogram and a tool card that tells you the next click. The problem is accretion: every feature has added its own surface, and the 3D stage, the hero of the Mission direction, has become the leftover space between them. On open, the model gets about 44% of the window width at 1280 px and 35% at 1100 px. Then a floating video, a toast, a tooltip, a hint card and clipped labels sit on top of it [10-scene-default, 10-scene-default-1100x720]. There are at least four tool catalogues (island, Project tab accordions, armed-tool chip cloud, island "All tools"), and the palette indexes none of them [18-command-palette-query]. The single biggest opportunity is to make the shell structurally quieter: fixed right-panel tabs, one tool home, the video docked, the global CTA demoted. Do that before adding another feature.

## AI slop verdict

**Pass, with two tells.** On the product slop test (would a Linear, Figma or Pix4D user trust it?), most surfaces pass. Type, density, table alignment and semantic colour are those of a working tool. The tells:

- **Globe** [36-globe]: a starfield and a glowing cyan atmosphere rim. This is consumer earth-viewer decoration and contradicts the "decorative neon" anti-reference.
- **Teal everywhere it is not earned**: the always-on teal "Create maps from photos" block, the teal-bordered welcome card, and teal tool chips. Accent should mean current selection or primary action on this screen, not brand presence.
- The KPI tile row in Volumes (Volume / Tonnes / vs 2 Mar) is the hero-metric pattern, but here it is justified: those are the three numbers a surveyor reports. Keep it.

## Design health score (Nielsen)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 2 | Footer shows a green "Cloud AI" while no AI can run [33-analytics-custom, 25-agent-pane-off]. Job progress arrives as a toast over the video [10-scene-default]. Good: tool card, island tool chip, "Saved" in Issues, jobs chip. |
| 2 | Match system / real world | 3 | Survey language is right (UTM, toe, chainage, PCI, km). App-invented terms leak: "Every date", "bench", "island", "File them". |
| 3 | User control and freedom | 3 | Undo/Redo in Issues, Undo/Stop/Save with keys in the tool card, Esc on hints, collapsible panels. Gap: the right panel reshuffles tabs on its own and there is no "back to how it was". |
| 4 | Consistency and standards | 2 | The tool list has two forms (accordion, chip cloud). The right panel is 470 px on Volumes and 360 px elsewhere. The Show control appears only with Volumes. Icons are reused for different things in Settings (key for Identity and Keyboard; diamond for Severity, Classes and Issues). One toggle is placed below its text [40-settings-06]. |
| 5 | Error prevention | 3 | Disabled Next with a stated reason ("Give the project a name"), Rename disabled with a hint, blocked AI runs are disabled. Gap: "Delete run" sits inline next to "Delete work files" [71-processing-panel]. |
| 6 | Recognition rather than recall | 2 | Island groups are icon-only [13-island-view]. Issues, Volumes and Changes hide behind "··· 3" [15-wb-more-tabs]. Tools are not findable in the palette [18-command-palette-query]. |
| 7 | Flexibility and efficiency | 3 | 126 shortcuts, Ctrl+K, right-click everywhere, tab pinning, bulk issue edits. Held back from 4 by the palette's tool blind spot. |
| 8 | Aesthetic and minimalist design | 1 | The stage competes with 8 to 10 overlays. A global CTA, a permanent welcome card and stacked filter rows put chrome ahead of content on every screen. |
| 9 | Error recognition and recovery | 3 | Blocked states name the reason and link the fix ("Processing cannot run yet" plus Update; "Cannot run yet" plus Open AI settings). Good pattern; apply it to the Globe and map no-pack notices too. |
| 10 | Help and documentation | 3 | A searchable F1 guide with 19+ task chapters, "?" on settings pages, inline step hints in tool cards. The guide is a modal over the work rather than a side panel next to it. |
| **Total** | | **25/40** | **Acceptable**: a solid foundation, with significant work needed on hierarchy and consistency. |

## Cognitive load

Checklist failures (5 of 8, so the load is **high**): single focus, visual hierarchy, one thing at a time, minimal choices and chunking all fail on the scene. Grouping, working memory and progressive disclosure mostly pass (accordions, the tool card).

Decision points with more than 4 visible options:

| Where | Count | Note |
|---|---|---|
| Scene on open [10-scene-default] | ~14 separate controls on the stage alone (view modes, date, Show 3 + 2, Streets, compass, video 3 buttons, timeline 10) | Nothing says "start here". |
| Island tool row [13-island-view] | 7 icon groups + 10 actions | Two layers of choice in a drop-down panel. |
| Project tab tools [14-bench-measure] | Favourites 4 + 10 accordions | Workable, but it is the third tool catalogue. |
| Armed tool chips [23-measure-distance-tool] | 18 ungrouped chips | The worst list. |
| Changes tab [52-compare-dates] | 6 run buttons + 4 dropdowns + search + checkbox | 6 near-equal primary actions. |
| Issues filters [30-issues] | ~11 controls in two rows | Before the first row. |
| Road defects [60-road-scene] | 14 filter chips | 11 of them are defect types. |
| Layer context menu [16-context-menu-layer] | 15 items | Window height. |
| New project type [04-new-project] | 7 types | Acceptable: a one-time choice with good descriptions. |

## Emotional journey

- **First start** [01-first-start]: reassuring copy ("never goes online by itself") but heavy. Four amber and green status rows feel like a pre-flight checklist before you have seen anything, and the projects are below the fold.
- **Opening the demo** [10-scene-default]: the peak should be "here is my site in 3D". Instead the first impression is clutter: video, toast, lingering tooltip, clipped labels. This is the emotional low point and it comes at the most important moment.
- **Measuring** [23-measure-distance-tool]: a high point. The tool card guides calmly and confirms state in two places.
- **Issues and Inspect** [30-issues, 31-inspect]: competent and trustworthy. Evidence photos with boxes and "Jump to 0:03.0" deliver the "contextual evidence" promise.
- **Trying AI** [33-analytics-custom]: a dent. The status bar says Cloud AI is on and the panel says nothing can run. Small contradictions like this erode trust in a precision tool.
- **End** (Reports and export [34-reports, 35-package-export]): calm and explicit, with sizes, policies and free disk space. A good ending; the Reports screen just needs its preview area to do something before the first export.

## What is working

1. **The tool card and armed-tool feedback** [23-measure-distance-tool]: the step instruction, live values, Undo/Stop/Save with keys, and an island chip. This is the best interaction in the app; it should be the template for every mode.
2. **Domain-true data presentation**: the Volumes table (right-aligned mono, signed coloured deltas, material grouping), the issue rows (mono codes, severity badges with number and colour), the road chainage histogram with click and drag. These are the screens that say "precise".
3. **Honest blocked states**: "Processing cannot run yet" plus the fix button, and "Cannot run yet" plus a link to settings, with Run disabled. They name the cause, offer the fix and prevent the error.

## Priority issues

### 1. [P1] The stage is not the hero
- **What**: At 1280 x 800 the stage is about 570 px of 1292 (44%). At 1100 x 720 it is 390 px (35%). The default state then adds a floating video window (280 x 190 px), the Show control, a Streets button, a toast, hints and labels clipped by the right panel edge [10-scene-default, 10-scene-default-1100x720, 21-split-view, 52-compare-dates-1100x720].
- **Why it matters**: The product's first principle is that the spatial view is central, and the anti-references say "controls must not displace the model". Users review geometry; every covered pixel is evidence they cannot see. At laptop sizes, split and compare become unusable (190 px panes).
- **Fix**: (a) Video is closed by default. When open it docks as a 16:9 tile on the left end of the bottom strip, and it floats only when popped out. (b) Below 1440 px wide, the left sidebar opens as the 52 px rail by default and the right panel opens at 320 px. Remember per-user widths. (c) Stage overlays get fixed slots: top-centre is the island only; top-right holds map style and zoom; bottom-left holds hints and toasts (one at a time); bottom-right holds the compass. (d) Clamp labels to the stage and collapse off-stage labels to edge dots.

### 2. [P1] Four tool catalogues, none in the palette
- **What**: The same tools appear in the island quick rows [13-island-*], the Project tab "Tools" accordions [14-bench-measure], the 18-chip cloud once a tool is armed [23-measure-distance-tool] and island "All tools". Ctrl+K "measure" finds only exports [18-command-palette-query].
- **Why it matters**: The user has to learn four maps of the same space, and power users cannot use the one accelerator that should cover everything.
- **Fix**: Keep one tool registry, rendered two ways only: the island (favourites and recent, plus a label for each group) and a fixed **Tools** tab with the same groups in the same order. The armed state replaces the list with the tool card and a "Back to tools" link, never a chip cloud. Index every tool, right-panel tab and island group in the palette with its shortcut.

### 3. [P1] The right panel reshuffles itself
- **What**: Tabs change by context: Project / Selection / Issues / Volumes / Changes in one state, then Annotate (pinned, closable) / Project / Selection plus "··· 3" in another. The width jumps between 470 and 360 px, and the stage resizes with it [15-wb-more-tabs, 14-bench-*, 10-scene-default].
- **Why it matters**: Spatial memory is how experts work fast. If Issues is sometimes a tab and sometimes in an overflow menu, every visit starts with a search. A changing width also moves the model under the cursor.
- **Fix**: Use four fixed tabs: **Selection · Layers & display · Tools · Project** (Issues, Volumes, Changes and Road live as sections of Project, or as tabs only for project types that have them, never in overflow). Tool groups opened from the island open inside the Tools tab. Use one width that the user can resize. Remove pin and close from tabs.

### 4. [P1] Status that does not tell the truth
- **What**: A green dot "Cloud AI" in the footer while Inspect says "No AI can look at this" and the agent says "Agent is off" [33-analytics-custom, 25-agent-pane-off, 31-inspect]. Lingering tooltips ("Collapse the timeline", "Search projects…", "Hide the timeline") persist in captures [10-scene-default, 24-issue-card, 53-compare-dates-island].
- **Why it matters**: In a precision tool every indicator must be literal. A green dot that means "permitted" instead of "working" teaches users to ignore status.
- **Fix**: Show a three-state AI chip: **AI ready** (green), **AI off · no key** (amber, click to open Settings > AI providers), **Local model** (neutral). Merge it with the "Agent off · Turn on" footer of the right panel so there is one AI status, not two. Dismiss tooltips on pointer leave and on any click.

### 5. [P1] A global primary CTA for an occasional job
- **What**: "Create maps from photos" is a full-width teal block under the project switcher on every screen: Settings, Issues, Reports, already processed projects. It appears again in the Processing panel [10-scene-default, 30-issues, 40-settings-*, 71-processing-panel].
- **Why it matters**: It is the highest-contrast element in the app, so it wins the eye over the model, the issues and the selection. Mission's hierarchy is stage first; this is marketing placement.
- **Fix**: Remove it from the sidebar. Put it as the primary action in the Processing panel and on project cards that have unprocessed photos, and as an empty-state action in the scene when a project has photos but no maps [70-photo-processing-scene]. Keep the palette command.

### 6. [P1] Visible polish defects that undermine "precise"
- **What**: Project switcher names cut to one letter [17-project-switch-menu]. The Globe cluster dot is drawn over "3 sites" [36-globe]. A missing space ("opensRuns") [40-settings-06]. Truncated "Class: Pick at acc" and "Severity: Pick at a" [33-analytics-custom]. "3…" pane headers and a clipped island in compare at 1100 px [52-compare-dates-1100x720]. Truncated footage clock "09:20:0…" [22-bottom-strip-footage, 50-change-scene-1100x720]. The map notice is hidden behind the video [20-map-view].
- **Why it matters**: Each one is small, but the brand promise is "precise". Clipping in a measuring tool reads as imprecision.
- **Fix**: Fix each one as noted in the annotations. Then add a 1100 x 720 and a 1366 x 768 visual-regression pass over the scene, compare, footage and switcher states to the e2e suite.

### 7. [P2] The left sidebar does five jobs
- **What**: Wordmark, search, project switcher, global CTA, 6 nav items, dataset tree with a 6-icon toolbar, an inline hint card, a status line, Settings, help and Collapse. The dataset tree, the scene's most-used list, gets about 180 px of height at 800 px and less at 720 [10-scene-default, 28-video-row-open].
- **Why it matters**: The tree is the scene's layer manager. Squeezing it while the nav takes 200 px for screens the user switches to rarely gets priorities backwards.
- **Fix**: See "Proposed layout": nav becomes a 52 px rail that is always present; the tree gets a full-height column that can be collapsed independently.

### 8. [P2] Map framing and empty map stages
- **What**: The road opens as a thin strip in the top-left of a black void [60-road-scene, 62-road-map]. The change site is small in a large dark map with overlapping vector labels [55-change-map]. The "No map pack" notice repeats in every map view.
- **Why it matters**: The first frame of a project is its first impression. A wrong fit says "nothing loaded".
- **Fix**: Fit to the union of project layer extents with 8% padding on open and on Map or Split switches. For corridors, rotate so the long axis is horizontal. Without a map pack, draw a faint 100 m grid. Show the no-pack notice once per session as a dismissible line, not in every pane.

### 9. [P2] Decision walls in secondary panels
- **What**: The Changes tab has six run buttons of equal weight [52-compare-dates]. Issues has about 11 filter controls [30-issues]. Road has 14 defect chips [60-road-scene]. The layer menu has 15 items [16-context-menu-layer]. The library welcome card is permanent [37-projects-with-open].
- **Why it matters**: More than 4 equal options causes analysis paralysis, and here the defaults are obvious ("Find changes", "All", "Worst first").
- **Fix**: Make one primary action with a split menu for variants ("Find changes ▾ imagery / surface / cloud / model / matched frames"). Show three filters plus a "Filters (n)" button. Make severity chips and put type in a dropdown. In context menus use submenus for "Position ▸" and "File under ▸". Collapse the welcome card to a one-line "Workstation setup 2 of 4" strip once a project exists.

### 10. [P3] Decoration and icon reuse
- **What**: The Globe starfield and glow [36-globe]. The same key icon for Identity and Keyboard, and the same diamond for Severity models, Classes and Issues [40-settings-*]. "Share" in the header of Settings and Globe.
- **Fix**: Use a flat globe with a hairline limb. Give each settings item a distinct icon. Show header actions only where they apply.

## Persona red flags

**Alex (power user)**
- Ctrl+K "measure" returns no tools [18-command-palette-query]; tools have single-letter keys (M, A, X), but the palette does not show or find them.
- The right-panel tabs move, so muscle memory for "Issues tab" fails the moment a tool group was opened [15-wb-more-tabs].
- Island quick rows open on hover, so they appear unasked when the pointer travels to the top of the stage, the most common place to orbit from [13-island-*].
- Good for Alex: 126 shortcuts, a searchable shortcut list, bulk issue edits with Shift range, and right-click everywhere.

**Jordan (first-timer)**
- The first screen is a 4-row setup checklist with amber warnings ("Not installed", "No map pack installed") before anything has been seen [01-first-start]. It reads as "you are not ready".
- On opening the demo, nothing says where to look or what to do. The hint "Click a pile to see its outline" sits behind the video window [10-scene-default].
- The island group icons (layers, scatter dots, mountain) have no labels [13-island-view].
- The app's own vocabulary is unexplained: "Every date", "File them / Not now", "bench", "EDL", "Triangulated toe".
- Good for Jordan: the tool card's "Click on the site", the guided New project steps with a reason on the disabled Next, and the searchable F1 guide.

**Site surveyor on a laptop at 1366 x 768 (project persona)**
*Profile*: a field or site-office surveyor on a 14 to 15 inch laptop at 100 to 125% scale, often on battery, checking today's stockpile volumes against last month and exporting a report before leaving site. *Behaviours*: works in the Scene and Volumes almost exclusively, uses trackpad orbiting, compares two dates, exports CSV or PDF. *Red flags*:
- At 1366 x 768 (and 1100 x 720 at 125% scale) the stage is under 450 px wide with both sidebars open. The video window alone covers more than half of it [10-scene-default-1100x720].
- Compare dates gives two panes of about 190 px with a clipped island and "3…" headers, which is unusable for the persona's main task [52-compare-dates-1100x720].
- The dataset tree gets about 100 px of height under the nav and the hint card, so they scroll a 100 px window to toggle a DSM.
- The volume chart's tooltip covers the newest data point, which is the one they came to read [10-scene-default].
- The footage clock is truncated ("09:20:…") [50-change-scene-1100x720].
- What would make them stay: a "Survey" layout preset (rail nav, right panel at 320 px on Volumes, timeline showing volume over time, video closed), the KPI tiles they already like, and a one-click PDF.

## Minor observations

- Hint cards appear in three different places (inside the tree, mid-stage, bottom-right). Pick one slot.
- "Agent" and "Share" in the right-panel header look like tabs but are actions; style them as icon buttons.
- The Selection tab shows the project as the selection when nothing is selected; label it "Project (nothing selected)" or show an empty state.
- In Issues, the F02 and F05 code colour (orange) has no legend; the severity filter chips "■1 ■3 ■2" read as counts without units.
- Reports: the 70% empty preview pane beside a cramped options column; show a live table-of-contents preview or a thumbnail strip of report pages.
- Processing panel: "Delete run" with an outlined red border is the most prominent button in its row.
- The Settings > Keyboard search placeholder is cut ("Type a key, an action c…").
- Map attribution and the "No map pack" notice stack at the bottom of every map pane.
- At 1100 px in Inspect, "Findings (0)" replaces the column, which is a good responsive pattern; reuse it for the right panel.
- The library sort control "Recent | Name" and "Open package" / "Add project folder" / folder icon form a 5-control toolbar ahead of "New project", which sits alone on a second row; put New project on the first row.

## Provocative questions

1. If the stage had to be at least 60% of the window at 1366 x 768, which panels would you remove rather than shrink, and does that answer show what the product is really for?
2. Is the island a toolbar, a menu or a mode switcher? Today it is all three, and the right panel is also all three. What if the island only switched modes (View, Measure, Annotate, Volumes, Compare) and the right panel only showed the current mode's detail?
3. Should "the video" be a window at all, or a track? In Mission the timeline is the spine; a docked frame-accurate video tile on the timeline might serve inspection better than a floating picture-in-picture.
4. What would the app look like if each project type (Survey, Road, Tank, Telecom) opened with its own layout preset (panels, tabs, overlays) instead of one shell showing everything for every type?

## Proposed layout

The goal is to give the stage at least 60% of the window at 1366 x 768 and 65% at 1920 x 1080, so that every control has one home and one job.

```
┌──┬──────────────────────────────────────────────┬─────────────────┐
│R │ Title bar 40px: Project ▾ · Customer › Site › Date ▾ · ⌘K search · AI chip · Jobs chip │
│A ├──────────┬───────────────────────────────────┤  Right panel    │
│I │ Layers   │        STAGE (3D / Map / Split)   │  320-420px,     │
│L │ 240px,   │   island (top-centre, modes)      │  resizable      │
│  │ own      │                                   │  ───────────    │
│52│ collapse │   [hints/toasts bottom-left]      │  Selection      │
│px│ (Ctrl+L) │              [compass bottom-right]│  Tools          │
│  │          │                                   │  Layers&display │
│  │          ├───────────────────────────────────┤  Project        │
│  │          │ Bottom strip: [video tile] timeline / chart / chainage │  ─ Agent (dock) │
└──┴──────────┴───────────────────────────────────┴─────────────────┘
```

**Left: a permanent 52 px rail (screens) plus a separate Layers column.**
- Rail, always visible and icon-labelled on hover: Projects, Globe, Scene, Issues, Inspect, Reports, then a spacer, then Processing (with a badge when jobs run), Help, Settings. The status dots move to the title bar.
- The project switcher moves to the title bar breadcrumb ("Demo customer › Demo tank farm ▾ › 13 Apr ▾"), as DIRECTION.md already specifies. Full names, with the customer as a second line in the menu.
- **Layers** (the dataset tree) is its own 240 px column, collapsible with its own shortcut. It is shown only on Scene. It gets the full height, with the date folders, the eye toggles and the import toolbar. The hint cards leave the tree.
- Why: the nav is used a few times an hour and the layers many times a minute. A rail costs 52 px; the current combined sidebar costs 252 px and still starves the tree.

**Right panel: four fixed tabs, one width.**
1. **Selection**: what you clicked (asset, issue, pile, photo, measurement), with coordinates, evidence, actions. An empty state teaches "click something".
2. **Tools**: the single tool catalogue (Measure, Annotate, Volumes, Clouds, Video, Road and so on as groups). An armed tool replaces the list with the tool card; Esc returns to the list.
3. **Layers & display**: labels, pins, point-cloud colouring, map style, section planes. Everything about how the scene looks, now spread across Display, Clouds and the Streets button.
4. **Project**: summary, plus the type-specific registers as sections or sub-tabs: Issues, Volumes (KPI tiles and table), Changes, Road defects, Measurements.
- The Agent docks at the bottom of the panel, collapsed to one line. It expands upward on Ctrl+J.
- One width, resizable from 320 to 520 px and remembered. Opening a tab never changes it. There is no pinning, closing or overflow.
- Why: four nouns a user can learn in a day. The modes stay put, so muscle memory works, and nothing important hides behind "···".

**Island (top-centre notch): modes and view, not a second toolbox.**
- Collapsed: 3D | Map | Split · ‹ date › · the active tool chip (as today; it works).
- Expanded on click, not on hover: a single 44 px row of labelled mode buttons: View · Measure · Annotate · Volumes · Compare · Video. Choosing one opens the matching group in the Tools tab and shows that group's top 4 to 5 tools as a second slim row. "All tools" goes to the Tools tab.
- It never covers more than 100 px of the stage. It is always centred on the whole stage, including in compare.
- Why: it keeps the quick access the founder likes, while the depth lives in one place.

**Bottom strip: time and evidence.**
- A left slot holds the docked video tile (16:9, about 200 px wide) when a clip is open; it pops out to float on demand. The telemetry stays as an overlay on the tile.
- The main area is context-switched by mode: dates timeline (default), footage tracks (Video), volume over time (Volumes), chainage histogram (Road).
- Height 120 to 180 px, collapsible to a 32 px scrubber. The tooltip anchors above the playhead and never over the newest point.
- Why: the timeline is the Mission spine. Docking the video there frees the stage and links the clip to time.

**Stage overlay slots (only these):** top-centre is the island; top-right is the map style and zoom; bottom-left is one hint or toast at a time; bottom-right is the compass and scale. The Show segmented control (Photo / Elevation / Cut & fill) moves into Layers & display, with a one-key toggle.

**Responsive rule:** below 1440 px, Layers opens collapsed and the right panel opens at 320 px. Below 1200 px, the right panel overlays the stage (as the Processing panel already does) instead of pushing it. In Inspect, the "Findings (0)" pattern becomes the general collapse pattern.
