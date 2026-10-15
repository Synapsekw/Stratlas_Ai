# Agent coverage gaps

Date: 15 Oct 2026. Status: analysis, no code changes.

The founder wants the in-app agent to do anything a person can do in the app: "show me the most severe photos", "the most affected location of this asset", "fly me to the worst area". This note lists what a person can do today, which agent tool covers each action, and what is missing. It ends with a recommendation for one shared action registry so new features reach the agent without a separate tool project each time.

## How the agent works today

The agent is a fixed, typed tool registry, not MCP. The loop is in `packages/ai/src/main.ts`. Tools are declared as specs (zod input plus `ToolMeta`) in `packages/ai/src/tools.ts`, `show-tool-specs.ts`, `change-tool-specs.ts`, `collab-tool-specs.ts`, `photo-tool-specs.ts` and `modelling-tools.ts`. Executors run in the renderer through `packages/ai/src/tool-kit.ts` (`define`, `registerRendererTool`), and reach app screens through optional `AppHooks` (open a screen, set the Media and Issues filters, export, process photos, the Globe). Each tool has a risk level from `packages/schema/src/agent.ts`: `read` and `navigate` run at once, `write` and `send` ask the person first.

There are 48 tools today:

| Group     | Tools                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera    | `fly_to`, `set_view`, `orbit`, `zoom`, `look_at`, `frame_all`, `find_places`                                                                                |
| Time      | `set_time`, `play_clip`, `list_clips`, `find_clips_near`                                                                                                    |
| Layers    | `list_layers`, `set_layer_visible`, `select`, `capture_frame`                                                                                               |
| Findings  | `list_issues`, `create_issue_draft`, `summarize_issues`, `summarize_by_zone`, `summarize_by_class`, `find_issues_near`, `measure_distance`, `export_issues` |
| Show      | `show_issue`, `show_photos`, `show_issues`, `open_screen`, `list_assets`                                                                                    |
| Change    | `compare_captures`, `list_changes`, `show_change`, `run_change_detection`                                                                                   |
| Team      | `list_my_work`, `show_thread`, `add_comment`, `request_approval`                                                                                            |
| Globe     | `list_sites`, `show_on_globe`                                                                                                                               |
| Photos    | `process_photos`, `accuracy_summary`                                                                                                                        |
| Modelling | `list_model_parts`, `propose_model_parts`, `fit_primitives`, `edit_model_part`, `build_model`, `view_plan`                                                  |

The agent's context carries the project name, the clock and active clip, the selection, visible layers, issue counts and the severity levels, plus the open screen and the Media and Issues filters. It does not carry the focused survey date, the stage mode (3D, Map, Split) or anything about walks, panoramas, measurements or jobs.

## Inventory and coverage by area

Status: **covered** (a tool does it with the same inputs), **partial** (a tool does part of it, or with fewer inputs), **gap** (no tool). Rows marked "by design" are gaps the agent should probably keep, for safety or because they are personal settings; they are left out of the priority list.

### Navigation and shell

| Action                                                         | Where in UI               | Tool            | Status  | Note                                                         |
| -------------------------------------------------------------- | ------------------------- | --------------- | ------- | ------------------------------------------------------------ |
| Go to Scene, Issues, Media, Detections, Reports                | Sidebar nav               | `open_screen`   | covered |                                                              |
| Go to Projects (library)                                       | Sidebar nav               | none            | gap     | `open_screen` has no `projects` value                        |
| Go to Globe                                                    | Sidebar nav               | `show_on_globe` | covered | Closes the agent panel                                       |
| Open Settings or a Settings page                               | Sidebar, palette          | none            | gap     | Useful for "where do I set my map key"                       |
| Open the audit trail                                           | Project dropdown, Reports | none            | gap     |                                                              |
| Switch project, close project                                  | Project dropdown          | none            | gap     | `list_sites` lists projects but cannot open one              |
| Collapse sidebar, right panel, agent dock (Ctrl+B, Ctrl+Alt+B) | Anywhere                  | none            | gap     | Low value                                                    |
| Command search (Ctrl+K) and its commands                       | Title bar                 | none            | gap     | The palette is the closest thing to an action registry today |
| Open the user guide, search it, "Help on this" (F1)            | Title bar, links          | none            | gap     | Agent could open a guide page to answer "how do I"           |

### Camera and stage

| Action                                                                                         | Where in UI             | Tool                                   | Status  | Note                                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------- | ------- | -------------------------------------------------------------------- |
| Fly home, whole site, to selection (H, G, F)                                                   | Stage tools, keys       | `set_view home`, `frame_all`, `fly_to` | covered |                                                                      |
| Centre on project                                                                              | Stage tools             | `set_view home`                        | partial | Close enough; not the same framing                                   |
| View presets Iso, Top, North                                                                   | Stage tools             | `set_view`                             | covered | Tool also has south, east, west, front, side                         |
| Orbit, zoom, look at                                                                           | Mouse                   | `orbit`, `zoom`, `look_at`             | covered |                                                                      |
| Stage mode 3D, Map, Split (1, 2, 3)                                                            | Mode segment            | `fly_to open3d`                        | partial | Only switches Map to 3D; cannot pick Map or Split                    |
| Pick a split pane per side (3D, Map, Video, Photo, Ortho, Report, Panoramas, Frames, per date) | Pane chooser            | `show_issue evidence`                  | partial | Only opens a photo beside the 3D view                                |
| Measure a distance (M)                                                                         | Stage tools             | `measure_distance`                     | partial | Between known targets only; the person's own clicks are not readable |
| Section plane (X), cut direction                                                               | Stage tools             | none                                   | gap     |                                                                      |
| Labels Off, Key, All (L)                                                                       | Stage tools             | none                                   | gap     |                                                                      |
| Camera mode free orbit, follow the drone, drone eye                                            | Stage tools             | `fly_to` a clip                        | partial | `fly_to` a clip goes to the drone's eye once; no follow mode         |
| Inside the asset: cut, transparent, inside view (C)                                            | Cutaway tool            | none                                   | gap     |                                                                      |
| Point cloud colour, size, budget, EDL                                                          | Point cloud panel       | none                                   | gap     | "Colour the cloud by elevation" is a natural ask                     |
| Flight paths All, Active clip, Off (P); telemetry (D)                                          | Stage tools             | none                                   | gap     |                                                                      |
| Video window show, hide, dock (W)                                                              | Stage tools             | none                                   | gap     |                                                                      |
| Issue pins on or off (I), "Severity N and above", heat map                                     | Layers and pins popover | none                                   | gap     | The heat map is the UI answer to "most affected location"            |
| Street map under the site                                                                      | Stage tool              | none                                   | gap     |                                                                      |
| Environment: sky or studio, date and time, water level                                         | Environment popover     | none                                   | gap     | Low value                                                            |
| Annotate on the stage: map point, line, area (A)                                               | Stage tools             | `create_issue_draft`                   | partial | Draft at a point only; no line or area geometry                      |
| Selection card Fly to, Clear                                                                   | Selection card          | `fly_to`, `select clear`               | covered |                                                                      |
| Snapshot of the 3D view (PNG, with or without legend)                                          | Export menu, palette    | `capture_frame`                        | partial | Sends the image to the provider; does not save a file for the person |
| Copy position                                                                                  | Drone and photo menus   | `find_places`                          | partial | The agent can read positions; nothing copies to the clipboard        |

### Layers and datasets

| Action                                                             | Where in UI              | Tool                | Status  | Note                                                       |
| ------------------------------------------------------------------ | ------------------------ | ------------------- | ------- | ---------------------------------------------------------- |
| List layers                                                        | Sidebar tree             | `list_layers`       | covered |                                                            |
| Show or hide one layer                                             | Tree row eye             | `set_layer_visible` | covered | Only in 3D, map and point cloud windows                    |
| Show or hide all layers, or a whole group or date                  | Datasets eye, date menu  | none                | partial | One call per layer works but is slow and noisy             |
| Visibility by kind (models, clouds, photo cameras, rasters, video) | Layers and pins popover  | none                | gap     |                                                            |
| Select a layer                                                     | Tree row                 | `select layer`      | covered |                                                            |
| Layer settings (opacity and similar)                               | Tree row icon            | none                | gap     |                                                            |
| File a layer under a survey date (drag, Move to date)              | Date tree, right-click   | none                | gap     |                                                            |
| Rename, colour, icon, delete a survey date                         | Date folder right-click  | none                | gap     |                                                            |
| Delete marked layers, empty the trash                              | Tree, trash footer       | none                | gap     | Destructive; would need `write` risk                       |
| Add data, drawing, panoramas, 360 video, 3D Tiles, survey date     | Datasets header, palette | none                | gap     | Needs a file the person picks; agent could open the dialog |
| Check layer origins                                                | Palette                  | none                | gap     |                                                            |

### Timeline, dates and playback

| Action                                               | Where in UI             | Tool                      | Status  | Note                                                                          |
| ---------------------------------------------------- | ----------------------- | ------------------------- | ------- | ----------------------------------------------------------------------------- |
| Play or pause (Space)                                | Transport               | `play_clip`               | partial | Starts a clip; no pause tool                                                  |
| Previous or next clip                                | Transport               | `list_clips`, `play_clip` | covered |                                                                               |
| Playback rate 0.25 to 8x                             | Rate button             | none                      | gap     |                                                                               |
| Scrub, click an issue marker                         | Tracks                  | `set_time`, `show_issue`  | covered |                                                                               |
| Previous or next survey date (Alt+Left, Alt+Right)   | Date bar                | `set_time`                | partial | No tool knows the survey dates as such; the model has to guess a time         |
| Choose a survey date from the calendar, focus a lane | Date bar, lanes         | none                      | gap     | No `list_surveys` or `set_survey_date`; context does not say the focused date |
| View this date (date folder menu)                    | Date folder right-click | none                      | gap     |                                                                               |
| Expand earlier or later lanes, hide the timeline (T) | Lanes                   | none                      | gap     | Low value                                                                     |
| Find clips that pass near a place                    | none in UI              | `find_clips_near`         | covered | Agent-only                                                                    |

### Issues register and issue card

| Action                                                        | Where in UI                  | Tool                                      | Status  | Note                                                       |
| ------------------------------------------------------------- | ---------------------------- | ----------------------------------------- | ------- | ---------------------------------------------------------- |
| Filter by severity, class, status, text                       | Register header              | `show_issues`, `list_issues`              | covered |                                                            |
| Filter by dataset kind (mesh, image, video, cloud, map, pano) | Register header              | none                                      | gap     |                                                            |
| "Mine" filter, My work list                                   | Register header              | `list_my_work`                            | partial | Lists the work; does not set the register filter           |
| Filter to an asset or area                                    | none in UI (agent chip only) | `show_issues where`, `list_issues where`  | covered | Agent can do more than the UI here                         |
| Filter by survey date                                         | none                         | none                                      | gap     | Neither the UI nor the tools                               |
| Sort by code, severity, status, last change, class; reverse   | Register header              | `show_issues sort`                        | partial | No direction; `list_issues` sorts only by severity or code |
| Group by severity, class, zone, status                        | Register header              | `summarize_by_class`, `summarize_by_zone` | partial | Read-only counts; cannot set the grouping on screen        |
| Open an issue, previous or next, show in Scene                | Card header                  | `show_issue`, `select`                    | covered |                                                            |
| Open photo evidence, jump to a video frame                    | Card                         | `show_issue evidence`, `set_time`         | covered |                                                            |
| Create an issue                                               | Stage annotate, detections   | `create_issue_draft`                      | covered | Always a draft, asks first                                 |
| Edit title, note, class, severity                             | Edit form                    | none                                      | gap     | "Raise F05 to severity 4" is not possible                  |
| Change status (reviewed, closed, back)                        | Edit form, bulk bar          | none                                      | gap     | Approve stays human only (by design)                       |
| Bulk set status or class on ticked issues                     | Bulk bar                     | none                                      | gap     |                                                            |
| Merge issues ("same defect")                                  | Edit form, bulk bar          | none                                      | gap     |                                                            |
| Remove a sighting, delete an issue                            | Edit form                    | none                                      | gap     | Destructive                                                |
| Undo or redo edits                                            | Register                     | undo of view tools                        | partial | The agent's view changes undo; data edits have no tool     |
| Summaries: counts by severity, status, class, zone            | none (reports)               | `summarize_issues`, `summarize_by_*`      | covered | Agent-only                                                 |
| Findings near a place                                         | none                         | `find_issues_near`                        | covered | Agent-only                                                 |

### Media gallery

| Action                                     | Where in UI             | Tool                              | Status  | Note                                                         |
| ------------------------------------------ | ----------------------- | --------------------------------- | ------- | ------------------------------------------------------------ |
| Only photos with findings                  | Header button           | `show_photos onlyFindings`        | covered |                                                              |
| Sort by file, severity, finding count      | Header select           | `show_photos order`               | covered |                                                              |
| Filter by one severity level               | Header select           | `show_photos severity`            | covered | Also `"highest"`, which the UI does not have                 |
| Photos of an asset, area, finding or class | Scope chip (agent only) | `show_photos where/issue/classId` | covered |                                                              |
| Photos of one survey date or one photo set | none                    | none                              | gap     | Neither the UI nor the tool; dates are only in tile tooltips |
| Open a photo in the side viewer            | Photo tile              | `select photo`, `fly_to photo`    | partial | Selects and flies; does not open the Media viewer            |
| Play a flight or clip                      | Flight tile             | `play_clip`                       | covered |                                                              |
| Open a panorama in the Scene               | Pano tile               | `fly_to pano`, `select pano`      | covered |                                                              |
| Full-size lightbox, zoom, marks overlay    | Lightbox                | none                              | gap     | Low value                                                    |

### Detections

| Action                                                                                         | Where in UI | Tool                     | Status  | Note                                                           |
| ---------------------------------------------------------------------------------------------- | ----------- | ------------------------ | ------- | -------------------------------------------------------------- |
| Open the Detections screen                                                                     | Sidebar     | `open_screen detections` | covered |                                                                |
| Filter the queue (waiting, all, accepted, rejected), minimum confidence, tiles with detections | Header      | none                     | gap     | No `list_detections` and no filter hook                        |
| Detect with AI (cloud) or detect locally                                                       | Dialogs     | none                     | gap     | The engine exists (`runDetect` in `main.ts`) but is not a tool |
| Accept (makes a draft issue), link to an issue, reject, reopen, delete                         | Inspector   | none                     | gap     | Accepting by rule ("accept all above 80 %") is a strong ask    |
| Edit class, severity, uncertain, note; outline (mask)                                          | Inspector   | none                     | gap     |                                                                |
| Draw a new detection                                                                           | Editor      | none                     | gap     | Hand work; keep human                                          |
| Turn detections into issues (inspection pipeline)                                              | Header      | none                     | gap     |                                                                |

### Change review and comparing dates

| Action                                                       | Where in UI        | Tool                   | Status  | Note                                   |
| ------------------------------------------------------------ | ------------------ | ---------------------- | ------- | -------------------------------------- |
| Pick two dates, find changes                                 | Change panel       | `run_change_detection` | covered | Asks first                             |
| Filter by kind, verdict, status                              | Change panel       | `list_changes`         | covered | Lists; does not set the panel's filter |
| Sort by change, kind, strength, name; hide unchanged; search | Change panel       | `list_changes`         | partial | No sort or text input                  |
| Show one change                                              | Row                | `show_change`          | covered |                                        |
| Confirm, dismiss, review again, close as resolved            | Row buttons        | none                   | gap     |                                        |
| Make issue from a change, add a note                         | Row                | `create_issue_draft`   | partial | Not linked to the change item          |
| Compare dates on the stage: swipe, two maps, blend           | Compare controls   | none                   | gap     |                                        |
| Compare with another date (date menu)                        | Right-click        | `compare_captures`     | partial | Numbers only, no view                  |
| Set a layer's survey date                                    | Survey date select | none                   | gap     |                                        |

### Team

| Action                                                    | Where in UI    | Tool               | Status  | Note                                                               |
| --------------------------------------------------------- | -------------- | ------------------ | ------- | ------------------------------------------------------------------ |
| Read a thread                                             | Comments tab   | `show_thread`      | covered |                                                                    |
| Comment, reply with mentions                              | Comments tab   | `add_comment`      | covered | No reply-to, no visibility (team or client), no attached view      |
| Edit or delete a comment                                  | Comments tab   | none               | gap     |                                                                    |
| Assign with due date, unassign                            | Assign control | `request_approval` | partial | Assigns for approval only; no plain assign or unassign             |
| Approve, request changes, withdraw, sign off              | Approvals tab  | none               | gap     | By design: only a person approves                                  |
| My work                                                   | Register       | `list_my_work`     | covered |                                                                    |
| Share, sync, export or import changes, conflicts, members | Team screens   | none               | gap     | By design for members and certificates; "sync now" could be a tool |

### Reports, exports and audit

| Action                                                                   | Where in UI          | Tool            | Status  | Note                                                   |
| ------------------------------------------------------------------------ | -------------------- | --------------- | ------- | ------------------------------------------------------ |
| Export issues CSV                                                        | Export menu          | `export_issues` | covered | Filters by status, class, minimum severity             |
| Export GeoJSON, COCO, kit JSON, masks, stockpile CSV, survey CSV         | Export menu          | none            | gap     | `AppHooks.exportIssues` takes a format but only `csv`  |
| Export issue register PDF, project report PDF, survey or accuracy report | Export menu, Reports | none            | gap     | "Make me the report for this survey" is a strong ask   |
| Choose report sections, which issues get a page                          | Reports              | none            | gap     |                                                        |
| Draft report text with AI, save a version                                | Narrative editor     | none            | gap     | Separate AI path; the agent cannot start it            |
| Read a delivered PDF                                                     | PDF viewer           | none            | gap     |                                                        |
| Export or extract a customer package                                     | Reports              | none            | gap     |                                                        |
| Audit trail: filter by who, what, dates, how; export; verify             | Audit screen         | none            | gap     | "What did the agent change last week" is a natural ask |
| Redact an audit entry                                                    | Audit row            | none            | gap     | By design                                              |

### Measurements and survey

| Action                                                                   | Where in UI            | Tool               | Status  | Note                                                |
| ------------------------------------------------------------------------ | ---------------------- | ------------------ | ------- | --------------------------------------------------- |
| Distance between two places                                              | Measure tool           | `measure_distance` | covered | Straight, horizontal and height difference          |
| Elevation at a point, elevation difference, elevation history            | Measure popover        | none               | gap     | "How high is the ground here" has no tool           |
| Grade, slope, cross-section, berm check, vertex differences              | Measure popover        | none               | gap     |                                                     |
| Area and volume of a polygon, volume base                                | Measure popover        | none               | gap     |                                                     |
| Measurement list: search, filter, fly to, rename, delete, move to folder | Measurement list       | none               | gap     | Saved measurements are not places for `find_places` |
| Surface comparison, whole-site cut and fill                              | Comparison, Whole site | `compare_captures` | partial | Volumes for stockpile surveys only                  |
| Designs import, terrain overlays, hydrology, haul road, QA, crop         | Survey popovers        | none               | gap     |                                                     |
| Export survey data, materials                                            | Dialogs                | none               | gap     |                                                     |

### Stockpiles

| Action                                                   | Where in UI   | Tool                              | Status  | Note        |
| -------------------------------------------------------- | ------------- | --------------------------------- | ------- | ----------- |
| Pile volumes per date and change                         | Volumes panel | `compare_captures`                | covered | With `base` |
| Fly to a pile                                            | Pile register | `find_places kind pile`, `fly_to` | covered |             |
| Show or hide piles, export CSV, edit boundary, revert    | Volumes panel | none                              | gap     |             |
| Volume view: surface, bodies lifted or in place, section | Volume tools  | none                              | gap     |             |

### Walks, panoramas and spot history

| Action                                                        | Where in UI           | Tool                         | Status  | Note                                                  |
| ------------------------------------------------------------- | --------------------- | ---------------------------- | ------- | ----------------------------------------------------- |
| Open a 360 walk, play, scrub, look                            | Walk row, walk pane   | none                         | gap     | Walks are not a `find_places` kind or a `select` kind |
| Place a walk, fine-tune pins, remove placement, remove walk   | Walk strip            | none                         | gap     | Hand work; keep human                                 |
| Process a walk                                                | Walk process line     | none                         | gap     | A job; could follow `process_photos`                  |
| Import drone panoramas, stitch                                | Dialog, tree rows     | none                         | gap     |                                                       |
| Open a panorama, fly to it                                    | Tree rows, pano pane  | `fly_to pano`, `select pano` | covered |                                                       |
| Previous or next panorama, show the nearest                   | Pano pane             | `find_places near`           | partial | Can find the nearest; cannot drive the pane           |
| Spot history: other dates of the same spot, compare two dates | Selection card, Media | none                         | gap     | "Show me this spot last year" is a strong ask         |

### Photogrammetry, processing and jobs

| Action                                                   | Where in UI       | Tool                                           | Status  | Note                                               |
| -------------------------------------------------------- | ----------------- | ---------------------------------------------- | ------- | -------------------------------------------------- |
| Create maps from photos (GNSS, quality, products)        | Wizard            | `process_photos`                               | covered | No coordinate system, survey date or folder source |
| Accuracy report                                          | Run panel         | `accuracy_summary`                             | covered |                                                    |
| Ground control: import, roles, mark in photos            | GCP table, marker | none                                           | gap     | Marking is hand work                               |
| Pause, cancel, resume, start over a run                  | Run panel         | none                                           | gap     |                                                    |
| Refined poses, export OPF, delete work files, delete run | Runs              | none                                           | gap     |                                                    |
| Show a run's maps on the map or in 3D                    | Run panel         | `set_layer_visible`                            | partial |                                                    |
| Job list: what is running, cancel, resume, open log      | Processing drawer | none                                           | gap     | No `list_jobs`; "is my map done yet" has no answer |
| Run an advanced pipeline                                 | Pipeline form     | `run_change_detection` (change pipelines only) | partial |                                                    |
| Install or update processing tools                       | Settings, banner  | none                                           | gap     | By design: a file the person picks                 |

### Model builder, align and calibrate

| Action                                                   | Where in UI                       | Tool                                    | Status  | Note                          |
| -------------------------------------------------------- | --------------------------------- | --------------------------------------- | ------- | ----------------------------- |
| Propose parts from a drawing or a point cloud            | Model builder                     | `propose_model_parts`, `fit_primitives` | covered |                               |
| Accept or reject drafts, edit a part, build              | Model builder                     | `edit_model_part`, `build_model`        | covered |                               |
| Read a plan drawing                                      | Model builder                     | `view_plan`                             | covered | Sends the drawing; asks first |
| Open the model builder                                   | Palette                           | none                                    | gap     |                               |
| Import a DXF, place a drawing by point pairs             | Modeller layer                    | none                                    | gap     | Hand work                     |
| Georeference a model by point pairs                      | Align model                       | none                                    | gap     | Hand work                     |
| Align camera or photo to map, keyframes, calibrate video | Drone and photo right-click menus | none                                    | gap     | Hand work                     |
| Look through a drone or photo camera                     | Right-click menus                 | `fly_to photo`, `fly_to clip`           | covered |                               |
| Show or hide a camera footprint                          | Right-click menus                 | none                                    | gap     |                               |

### Road

| Action                                                     | Where in UI    | Tool                         | Status  | Note                                             |
| ---------------------------------------------------------- | -------------- | ---------------------------- | ------- | ------------------------------------------------ |
| Defect list: search, severity and type chips               | Road panel     | `list_issues`, `show_issues` | partial | Road defects are issues; type chips map to class |
| Sort worst first, chainage, largest area, code             | Road panel     | `list_issues sort`           | partial | No chainage or area sort                         |
| Jump to a chainage                                         | Chainage ruler | `fly_to` place "km 12.4"     | covered |                                                  |
| Defects per km                                             | none           | `summarize_by_zone kmBin`    | covered |                                                  |
| PCI grid, density layer, close-up, next or previous defect | Road tools     | none                         | gap     |                                                  |
| Draw a centreline, run the road builder                    | Road setup     | none                         | gap     |                                                  |

### Maps, Globe and environment

| Action                                                      | Where in UI     | Tool                          | Status  | Note                                                   |
| ----------------------------------------------------------- | --------------- | ----------------------------- | ------- | ------------------------------------------------------ |
| Choose the map base (offline streets, online satellite)     | Map menu        | none                          | gap     | "Show satellite" is a common ask                       |
| Map overlays: roads, terrain shading, imagery, issues       | Map menu        | none                          | gap     |                                                        |
| Work offline or go online                                   | Palette         | none                          | gap     | By design: the person decides what leaves the computer |
| Globe: list sites, fly to a site                            | Globe           | `list_sites`, `show_on_globe` | covered |                                                        |
| Globe: open a site, open an issue, measure on the ellipsoid | Globe site card | none                          | partial | `show_on_globe` flies, cannot open the project         |
| Globe terrain and imagery, site outputs                     | Globe menu      | none                          | gap     |                                                        |

### Projects, settings and help

| Action                                                         | Where in UI       | Tool | Status | Note                                               |
| -------------------------------------------------------------- | ----------------- | ---- | ------ | -------------------------------------------------- |
| Open, rename, show in folder, export package, delete a project | Project menu      | none | gap    | Open and rename are safe asks; delete stays human  |
| New project wizard                                             | Projects, palette | none | gap    | Could prefill and open the wizard                  |
| Add project folder, change data folder                         | Projects          | none | gap    | By design                                          |
| AI providers, privacy, map keys, identity, team server         | Settings          | none | gap    | By design                                          |
| Graphics quality, appearance, keyboard, language               | Settings          | none | gap    | By design: personal                                |
| Offline map packs and project maps download                    | Settings, notice  | none | gap    |                                                    |
| Check for updates, export logs, report a problem               | Settings          | none | gap    | "Report a problem" could be prefilled by the agent |

### Counts

Across the 18 tables there are 165 actions: 46 covered, 27 partial, 92 gap. Nine of the gaps are by design (approvals, redaction, team members, going online, data folder, providers and keys, personal settings, installing from a file). Hand work such as placing walks, drawing detections and aligning cameras is a further dozen gaps where the agent can at most open the right tool.

## The founder's three examples

**"Show me the most severe photos."** Covered today in one call: `show_photos { severity: "highest" }` (order defaults to severity, and `onlyFindings` turns on). It opens Media with the photos whose findings sit at the highest level present, worst first, and a chip the person can clear. "The most severe photos of tank 3" adds `where: "tank 3"`. What is missing: a survey date or photo set filter ("from the March flight") and a minimum level ("severity 3 and above"), since `severity` takes one level only.

**"The most affected location of this asset."** Partial. With the asset selected the agent can call `show_issue { where: "selection" }`, which flies to the single most severe open finding on that asset and opens its photo, or `list_issues { where: "selection", sort: "severity" }` to list them. That answers "the worst finding", not "the most affected location". There is no tool that ranks places within one asset: `summarize_by_zone` has no `where` input, sorts by count rather than severity, takes its zones from note text ("Location:", "Area:") or the layer name, and returns no position, so its result cannot be passed to `fly_to`. `list_assets { by: "area" }` ranks component groups across the project, not parts of one asset. The UI's answer is the severity heat map on the issue pins, which no tool can switch on. Needed: a `rank_locations` read tool (findings clustered by position or by zone within an asset, scored by severity and count, each with a position) and a `where` input on `summarize_by_zone`.

**"Fly me to the worst area."** Partial, two calls: `list_assets { by: "area", sort: "worst" }`, then `fly_to { target: { kind: "place", name: <first row> } }` (areas are `group` places in `find_places`). Or one call, `show_issue {}`, which flies to the most severe open finding in the project. Limits: it needs a tagged model (the asset index), so survey and road projects without tagged assets get an error and the model has to fall back to `summarize_by_zone` (on roads, `kmBin` plus `fly_to "km 12.4"` works); "worst" means the single worst open finding, so an area with ten severity 3 findings ranks below one with a single severity 4; and zones from `summarize_by_zone` have no position. The same `rank_locations` tool, returning a target per row, would make this one reliable call followed by `fly_to`.

## Features about to land on other branches

| Branch                         | What it adds for people                                       | Agent tools                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project library organise       | Remove, delete, folders and thumbnails in the project library | None planned. Add at least `list_projects` (with folders) and `open_project`; keep delete human                                                                       |
| Class editing                  | Add, rename and edit issue classes                            | Adds `propose_class` (write risk, asks first, returns an existing class of the same name) and an `AppHooks.createClass` hook. Renaming or merging classes has no tool |
| OpenDroneMap processing engine | Install the engine and choose it in processing settings       | No tool changes. `process_photos` should learn an `engine` input once there are two engines, or it silently uses the default                                          |
| Engineering model              | Parametric component models from scans                        | Tools planned: `list_components`, `edit_component`, `set_count`, `add_component`, `remove_component`, beside the modelling tools                                      |

Each of these repeats the pattern this note is about: the menu, right-click and palette entries are written in the feature branch, and the agent tool is either a separate later task or not planned.

## Top 10 gaps by user value

1. **Rank locations within an asset or the project** (`rank_locations`, plus `where` on `summarize_by_zone`): findings clustered by position or zone, scored by severity and count, each row with a `fly_to` target. Answers two of the three founder examples properly.
2. **Survey dates as a first-class input**: `list_surveys`, `set_survey_date` (the date bar and lanes), the focused date in the context, and a `survey` filter on `show_photos`, `show_issues` and `list_issues`. Most questions on multi-date projects are "on which date".
3. **Edit findings**: `update_issue` (title, note, class, severity, status up to reviewed or closed), `merge_issues`, and bulk status or class, all `write` risk. Approve stays human.
4. **Detections**: `list_detections` (state, confidence, class), `run_detection` (local or cloud, `send` risk for cloud), and `review_detections` (accept, link, reject by id or by rule). The engine already exists.
5. **Reports and exports**: `export_report` (issue register, project, survey, accuracy PDF with sections) and the other export formats through the existing `exportIssues` hook.
6. **Jobs**: `list_jobs`, `cancel_job`, `resume_job`. "Is my map done yet" has no answer today.
7. **Spot history**: `show_spot_history` (a photo, walk frame or place, across dates) and `compare_spot` (two dates side by side or swipe).
8. **Stage display**: stage mode (3D, Map, Split, with panes), issue pin filter and heat map, map base (offline or satellite, within the online rules), point cloud colour, labels, section plane. One `set_display` tool with an enum of options covers most of this.
9. **Survey measurements**: `measure` for elevation at a point, area and volume of a polygon given as targets, slope between two points, and `list_measurements` so saved measurements become places.
10. **Projects and screens**: `list_projects` and `open_project` (with library folders once they land), `open_screen` for projects, audit and a Settings page, and `query_audit` for "what changed last week and who did it".

## Recommendation: one shared action registry

Today an action is written up to five times: an `onClick` in a component, an entry in the command palette (`shell/Palette.tsx`), a right-click `item(...)` in a menu, a key in `packages/ui/src/shortcuts.ts`, and, sometimes and later, an agent tool spec plus a renderer executor. Each new feature adds UI entries and leaves the agent behind, which is how 92 gaps built up. The fix is to declare each action once and let every surface draw from the same declaration.

An action would be a record with an id, a label and description (the palette text and the tool description), a zod input schema (empty for plain commands), a risk level from `packages/schema/src/agent.ts`, an optional shortcut, the surfaces it appears on (palette, menu ids, toolbar, agent), an `enabled(state)` check and a `run(input, ctx)` function. This is almost exactly a `ToolSpec` plus a `RendererToolRun` today: `ToolMeta` already has a name, description, scope, risk and windows, and `define()` already pairs a typed input with a run function. The registry would live beside `tool-kit.ts` (or in `packages/ui` with `tool-kit` reading from it), and `registerToolSpec` and `registerRendererTool` would become what the registry calls for every action marked for the agent, so the main process still offers a fixed, typed list to the model and nothing about the approval cards, undo or the `read`/`navigate`/`write`/`send` gate changes.

The menus would stop holding their own closures: the palette lists registry actions by group, the date and drone menus list action ids with the right-click target as input (`{ date }`, `{ clip, at }`), and the shortcut map binds keys to action ids. The `AppHooks` interface shrinks over time, because a hook such as `openScreen` or `showPhotos` is really an action the app registers at start, with the store call as its `run`. Features register their actions in the module that owns them, the way `modeller/agentTools.ts` already does, so a feature branch that adds a right-click item adds an agent tool in the same line, and a review rule ("every new action has a description and a risk, or is marked person-only with a reason") keeps it honest.

Two cautions. Not every UI action should reach the model: hand work (placing pins, drawing boxes) and the by-design rows above stay person-only, so `agent: false` with a reason is part of the record. And the model's tool list must stay short for small local models, so the existing `COMPACT_TOOLS` profile should become a per-action flag, and related UI actions (the many display toggles) should be grouped behind one agent tool with an enum input rather than exposed one by one. A first step that proves the shape without a rewrite: move the command palette onto the registry, expose its navigation and display actions to the agent as `set_display` and `open_screen`, and measure how many gaps close.
