# Testing Stratlas

Only what still needs testing. Each stage lists what to click and what you should see, and each line describes current behaviour. Stages you pass are removed; new stages are added when they are built. Things that work differently on purpose are in [KNOWN-LIMITS.md](KNOWN-LIMITS.md).

## How to use this document

### Install

- Close Stratlas first. The installer refuses while it runs: "Stratlas is running. Close it and click Retry."
- Run `E:\Dev\AIO Software\apps\desktop\dist\Stratlas-0.9.0-win-x64-setup.exe` and install over the previous version.
- No install: `Stratlas-0.9.0-win-x64-portable.exe` in the same folder.
- 0.9.0 contains every earlier fix, so all stages below are tested on it too.
- The build is unsigned. SmartScreen shows "Windows protected your PC": choose **More info**, then **Run anyway**.

### Check the build first

- **Settings, About and updates** shows "Build <date>, <time> (<commit>)".
- The **Projects** screen shows "built <date> <time>" at the bottom of the right panel.
- Both must match the build named in the status table or in my message. If they do not, the old version is still installed.

### Data

- Projects, map packs and the pipeline pack live in `E:\Stratlas Data` (`projects`, `packs`, `runtime`). Change it in **Settings, Data folder**.
- Everything runs offline; the title bar shows **Offline**. The app goes online only when you start a map region download or use cloud AI.

### Reporting

- Tick each line that works.
- For anything else, write what you did, what you saw and what you expected, plus the stage and section (for example "M6, Detections").
- Add a screenshot, and the time on the timeline (video projects) or the issue code or photo name.

## Status

| Stage | What it covers                                                                                                                                                                                                   | Build it needs                                                                                                                | Status                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| M5    | Fixes from the M4 feedback: Masafi, DAMAC, video, layers, cut-away, split, sky and water, report branding                                                                                                        | The M5 installer, built 4 Oct 2026 after the sky and water merge (commit `862c9df`) or later                                  | Not yet tested (skipped for now)                     |
| M6    | Builder completion: pipelines from raw data, detection review, AI detection, report text and project report, video calibration, packages and map packs                                                           | The M6 installer, built 4 Oct 2026 from main at commit `4624bf2` or later, and pipeline pack 0.2.0 (see M6, Before you start) | In progress: founder testing; feedback fixed in M6.1 |
| M6.1  | Your M6 feedback: point size, issue and photo opening, Media highlights, HCl flicker and nadir photos, dark maps, Al-Zour drone trace and photo icons, agent camera moves, Masafi piles and ramps, compare dates | The installer built 5 Oct 2026, 18:00, from main at commit `a8e7b43` or later                                                 | All nine fixes merged; not yet tested by the founder |
| M7    | Signed builds and updates only (the rest of M7 passed on 6 Oct 2026)                                                                                                                                             | Needs the signing secrets in GitHub and a second version                                                                      | Waiting for signing                                  |
| M8    | Change and modelling: changes between survey dates, imagery, surface, cloud and model change, same view on the other date, model builder, local detection, offline agent                                         | Version 0.8.0, built 7 Oct 2026 from main at commit `7faf945`, and pipeline pack 0.3.0 (see M8, Before you start)             | Built; not yet tested by the founder                 |
| M9    | Team and audit: identity and roles, exchange files, shared folder, conflicts, review workflow, history and audit trail, large files on demand, team server (preview)                                             | Version 0.9.0, built 7 Oct 2026 from main at commit `91770f2`                                                                 | Built; not yet tested by the founder                 |

## Stage M5: your M4 feedback, fixed

Build: the M5 installer, 4 Oct 2026, or later. Below is what changed after your M4 feedback.

### Masafi

- [ ] Toolbar: **Photo | Elevation | Cut / fill** switch, always visible. Elevation colours the terrain with its legend.
- [ ] **Section** tool: click the first point, move the mouse: the camera stays still. Click the second point: the profile appears.
- [ ] Your boundary edit on P08 (31 Dec) is still there.

### DAMAC

- [ ] Issue labels and count badges show only on the faces you can see, not through the building. Badges count only visible issues.
- [ ] No timeline: a thin **Timeline** bar at the bottom ("No video in this project"). Click it or press **T** to show it; remembered per project.
- [ ] Toolbar **pin** button (or **I**) turns issue tags off and back on; the severity heat map stays. The Layers popover agrees.

### HCl (and every project with video)

- [ ] Each flight is **one continuous clip** (Flight 101 is 6:26), 1920×1080, sharper. Flight 102 is the right way up (the old pieces had it upside down for the first 5 minutes).
- [ ] A click on a clip bar plays from the clicked point.
- [ ] Video window: drag it by the title bar; resize from edges and corners (keeps 16:9); double-click the title to reset; remembered per project.
- [ ] Layers: an **eye at the top** shows or hides everything; one eye per group (Models, Point clouds, Maps, Video). Half-filled eye: some are hidden.
- [ ] The tank is **not cut automatically** when the drone goes inside. Toolbar tool **Inside the asset**: **Off**, **Cut**, **Transparent** with an **Opacity** slider. Point clouds hide while a mode is on. Remembered per project.
- [ ] **Split**: each side has a selector (3D view, Map, Video, Photos, Ortho and plans, Report: only what the project has). Try Video on the right, Photos on the left. The 3D view appears on one side only (except Compare dates, M6.1).

### Al-Zour

- [ ] Videos are 1920 px (same lengths as before: they were already full length).
- [ ] Full-resolution point cloud, **Elevation**: ground blue to green, tanks yellow to red; legend about 90 to 166 m. In the point cloud popover, **Elevation range** sliders stretch the ramp; **Auto** resets.
- [ ] Opens under a **sky** with **animated water** that stays off the land, and sun shadows on the plant, the ortho and the water.
- [ ] Toolbar **sun** button (right end): **Time of day** slider (morning sun from the east, evening from the west, moonlight at night), **Date**, **Capture time** (13:22, 21 Feb 2023) and **Now**, **Water** on or off and its **Level**, **Sky** or **Studio**, **Project defaults**. Remembered per project.
- [ ] HCl opens in **Studio** (the dark look as before); you can switch it to **Sky**.
- [ ] **Settings, Graphics quality**: **Water** and **Shadow edges** per tier.

### Reports and Media

- [ ] **Settings, Report branding**: company name, logo (PNG, JPG, SVG), accent colour, cover preview.
- [ ] Without branding, a generated issue register (Issues, Export, PDF) has no logo and says "Made with Stratlas". With branding, your logo and name. The delivered EBSM and DAMAC PDFs are unchanged (the e& in them is the client's own document).
- [ ] EBSM, **Media**: opens at once and scrolls smoothly (thumbnails instead of 2560 px originals).

## Stage M6: builder completion

Goal: build a complete deliverable inside Stratlas, from raw data to a reviewed, reported and packaged project. Everything below is merged: P1, P2, P3, R1, R2, R3, R4, A1, X1 and X2. Each builder step uses one of the sample datasets in `E:\Stratlas Data\samples` (each has a README with the same steps and the numbers to expect).

### Before you start

- [ ] The build stamp shows commit `4624bf2` or later (4 Oct 2026).
- [ ] **Jobs** shows "Pipeline pack 0.2.0" at the top. The pack is `E:\Stratlas Data\runtime\pipeline-pack-0.2.0`; the app takes the newest pack in that folder, so the old `pipeline-pack-0.1.0` can stay. If a job stops at once with "There is no pipeline called ...", the app is using an older pack.
- [ ] The samples are in `E:\Stratlas Data\samples`: `inspection-hcl-mini` (6 MB), `volumetric-masafi-mini` (29 MB), `road-ringroad-mini` (104 MB). They are copies and crops; your projects and sources were not changed. Pick their files from there; the app only reads them.
- [ ] Work on new projects or copies. Pipelines and accepted detections write into the open project (always with a backup, never dropping your own issues).

### P1 Inspection from raw data (sample `inspection-hcl-mini`)

Places detections (boxes on posed photos) on the model, groups them into issues, makes contact sheets and the stats for the report. The sample is 20 HCl tank photos with GPS and gimbal tags, the tank model and one AI pass with 8 accepted and 9 waiting boxes.

- [ ] Projects, **New project**: name `HCl sample`, type **Inspection** (the default), **Next**.
- [ ] Origin: **Typed coordinate** `29.0769043, 48.0838033, 0`. The CRS list selects **WGS 84 / UTM zone 39N**, EPSG:32639, "site zone". **Next**.
- [ ] Severity model: **HCl lining** (From HCl Tank 710-D-130335). **Next**, **Create project**. The project opens empty.
- [ ] **Import files**: the 20 photos in `photos\` and `HCl-Tank-710-D-130335.glb`. "Imported 21 of 21 files", no Camera heights card (these photos carry absolute altitude only), **Close**. The cameras sit inside the tank.
- [ ] Copy `detections\hcl-ai-pass.json` into `E:\Stratlas Data\projects\hcl-sample\detections\` (make the folder). Detection passes always live in `<project>\detections\`.
- [ ] **Jobs**, **New job**: **Pipeline** is already **Inspection: detections to issues**; **Unreviewed AI detections** is **Leave out until a person accepts them**. **Start job**.
- [ ] Six steps: Read the project, Contact sheets, Read detections, Place detections on the model, Group into issues and stats, Write to the project. Then **Done**. The log says "Not counted: 9 draft, not reviewed" and "Issues: 4 new".
- [ ] **Issues**: D01 Coating blister, D02 Corrosion, D03 Patch damage (severity 4), D04 Coating blister, all "Lining Roof", pinned on the tank roof where the delivered HCl findings F04, F05, F02 and F06 are.
- [ ] Run the job again: "Issues: 0 new, 0 updated, 4 unchanged". Nothing duplicated. Contact sheets are in `<project>\inspection\contact\`.

### R1 Detections review (same project)

One detections contract: every pass (yours, AI, model) is a file in `<project>\detections\`; the review writes its decisions back into that file; `inspection.run` places reviewed boxes on the issue the review made and never makes a second issue for them.

- [ ] Sidebar **Detections**: "9 waiting · 8 accepted · 0 rejected". **Photos shown**: **With detections** or **All photos**.
- [ ] Pick photo 101-0007. The 41% box in the top-left corner is the false alarm ("Shadow on the lining"): **Reject** (**X**), then **Reopen** it and reject it again.
- [ ] Inspector: **Class** (**C**), **Severity** (**1** to **5** on HCl lining), **Uncertain (U)**, **Note (N)**. **J** and **K** step through detections.
- [ ] **Accept** (**A** or **Enter**) a waiting box: "Accepted as issue <code>." **Open in Issues** shows it as a draft issue with this photo.
- [ ] A second box on the same spot: **Link** (**L**), find the issue by code or title: the box becomes a sighting of it.
- [ ] Accept or link the rest: "0 waiting · 16 accepted · 1 rejected" (when you accept each box on its own). The save state reads **Saved**; `hcl-ai-pass.json` now holds your decisions.
- [ ] **Ctrl+Z** and **Ctrl+Y** undo and redo review changes. **Ctrl**+click selects several tiles; **Clear selection** empties it. The confidence slider hides proposals under "Confidence N% and up".
- [ ] Run the inspection job again: the log says "Not counted: 1 rejected" and "8 accepted in the review (8 placed on the model)", "0 new ... 4 unchanged". The issues you accepted get their pin on the shell joints; none is made twice.
- [ ] **Outline** (**M**): "No mask model is installed in the pipeline pack." (none ships yet).
- [ ] EBSM (299 photos): the contact sheet scrolls smoothly. In a package opened in the player the screen says **Read only**.

### R2 Detect with AI

Needs Cloud AI on and a key with a vision model (Settings, AI providers). Use the HCl sample project.

- [ ] **Ctrl**+click 2 to 4 tiles (**All photos**), then **Detect with AI (4 photos)**.
- [ ] **What to send**: the selected photos, the photo in the editor, all photos without detections, or **Video frames** (a **Clip** and **One frame every** N **seconds**). **Images per request**. **What to look for (optional)**.
- [ ] **Estimate**: "4 images in one request, about ... tokens in and ... out: about $..." and "An estimate from list prices. The provider's invoice is authoritative."
- [ ] **What leaves this workstation**: thumbnails of exactly those images. Open **Instructions and request text** to read the full request.
- [ ] **Send 4 images**: progress, **Stop** works, then **Done** with tokens and cost. The results land as a new pass file in `<project>\detections\`.
- [ ] Proposals are **Waiting** with "Proposed by <model>, prompt <version>." and "Confidence N%". Nothing is in Issues until you accept it. A label the project does not know: "The model called it "...". Pick a class."
- [ ] Cloud AI off: the dialog says so and Send is greyed out. A wrong key: the provider's exact error, nothing added. **Settings, Usage and cost** includes the detection tokens.

### P2 Volumetric survey from raw data (sample `volumetric-masafi-mini`)

Two survey dates (DSM and ortho GeoTIFFs) of a corner of the Masafi yard with two piles.

- [ ] Projects, **New project**: name `Masafi sample`, type **Volumetric**, **Next**.
- [ ] Origin: **Typed coordinate** `28.9106819, 48.0532713, 51`; the CRS list selects **WGS 84 / UTM zone 39N**. **Next**, **Next**.
- [ ] **Survey data**: **Survey date** `2020-12-31`, **DSM GeoTIFF** `2020-12-31_dsm.tif`, **Pick orthomosaic** `2020-12-31_ortho.tif`.
- [ ] **Add a second survey date** without a surface: "Every survey needs a DSM or a point cloud." and **Create project** stays greyed out. The same date twice: "Two surveys have the same date."
- [ ] Second date `2021-01-10` with `2021-01-10_dsm.tif` and `2021-01-10_ortho.tif`. The summary reads "2 survey dates, built in Jobs after creating". **Create project**.
- [ ] **Jobs** runs **Volumetric survey** (about 20 s): Read the surveys and set the grid, DSM of survey 1 and 2, Ortho tiles of survey 1 and 2, Detect piles, toe lines, bases and volumes, Package the kit grids, Terrain meshes, ortho pyramids and volumes, Write to the project. **Done**.
- [ ] **Scene**: two textured terrains and the **Volumes** register with 2 piles (P06 and P07 of the delivered Masafi, numbered P01 and P02 here). Triangulated toe: P01 1,612.6 m³ (31 Dec) and 1,446.7 m³ (10 Jan), P02 262.4 and 309.7 m³; change -342.3 and +89.2 m³. These are the delivered Masafi figures; the README lists all four bases.
- [ ] Switch dates and bases, click a pile, **Swipe** between the dates.
- [ ] Quit Stratlas during a run and reopen: the job shows **Interrupted** with **Resume**; Resume carries on from the next step.

### P3 Road survey from raw data (sample `road-ringroad-mini`)

The 1st Ring Road from km 3.00 to 3.25: ortho, centreline, defect polygons and the delivered pavement footprint.

- [ ] Projects, **New project**: name `Ring Road sample`, type **Road**, **Next**.
- [ ] Origin: **Typed coordinate** `29.3589992, 47.9750289, 0`; the CRS list selects **WGS 84 / UTM zone 38N**, EPSG:32638. **Next**.
- [ ] The severity step preselects **Road distress (ASTM D6433)**. **Next**, **Create project**. The project opens in **Road setup**: "This road survey has no road model yet ...".
- [ ] **Import files**: `ringroad-km3.00-3.25-ortho.tif`. "Imported 1 of 1 files".
- [ ] Optional: **Draw centreline**: the stage switches to the map; click along the road; **Backspace** removes the last point; **Finish**: "Centreline saved as road/centreline-drawn.geojson." **Run the road builder** opens Jobs with it filled in.
- [ ] **Jobs**, **New job**, **Road survey**: **Centreline** `centreline.geojson` (the delivered chainage 3.00 to 3.25 km), **Orthomosaic GeoTIFF** the ortho, **Defect polygons** `defects.geojson`, **Sample units** **Square grid (as delivered for the 1st Ring Road)**, **Pavement raster** `pavement.tif`. **Start job**.
- [ ] **Done** in about 20 s. The log: "78 defects: 52 Transverse cracking, 10 Longitudinal cracking, 8 Raveling, 6 Bleeding, 1 Rutting, 1 Block cracking" and "73 sample units (grid), network PCI 95.6 / 88.3 / 77.4".
- [ ] The 50 grid units wholly inside the stretch have exactly the PCI of the delivered 1st Ring Road (click one in the PCI grid and compare with the same cell in the 1st Ring Road project).
- [ ] **Scene**: the road workspace as on 1st Ring Road: chainage ruler, "78 of 78 defects", **P** for the PCI grid with its legend, click a defect row for its **Close-up**.
- [ ] Variant: **Sample units** **Along the road** (default 31 m units): 8 units, network PCI 97.3 / 91.2 / 81.8.

### R3 Report text and R4 project report

Do this on each sample project, and on HCl, EBSM and 1st Ring Road.

- [ ] **Reports**, **Report text**, **Edit report text**: executive summary, method and findings overview. With Cloud AI off, **Fill from template**: "Cloud AI is off, so the text was filled from a template. Replace the parts in [brackets]."
- [ ] With Cloud AI on, **Draft with AI**: the first time a preview shows exactly what is sent (the instructions and the statistics, no photos, positions or notes); **Send**. Edit the text, **Save version**. **Versions** lists AI draft, Template and Edited versions; **Restore this version** brings one back. **Back to the reports**.
- [ ] **Project report**: **Sections**, **Issue pages** (**Every graded issue**, **All but the lowest level**, **None, register only**), **Export project report PDF**. The PDF: cover with your branding (or "Made with Stratlas"), contents, executive summary (your saved text), scope and method, site and data with a locator map, statistics, findings register, one page per issue, appendices.
- [ ] Volumetric sample: the stockpile map and the volume table. Road sample: the road ratings; road surveys default to **All but the lowest level**.
- [ ] A project with no issues (a new empty one) still prints.

### A1 Calibrate video (Al-Zour)

The Al-Zour project already carries the A1 calibration: one 70.9 degree lens and an orientation and position offset per clip for all 25 clips, fitted on the corrected camera heights. The 8 degree pitch error of M5 is gone.

- [ ] Al-Zour, play **DJI_0665**: the live frame drapes onto the tanks and pipe racks without the old pitch offset; the drone-eye view lines up with the model.
- [ ] **Calibrate video**: **Time offset**, **Field of view**, **Orientation** (**Pitch**, **Yaw**, **Roll** offset), **Position** (**East**, **North**, **Up**, metres), each with a live preview.
- [ ] **Point pairs**: click a sharp feature in the frame, then the same feature on the model (or type its coordinate), **Add pair**; three to six pairs across the frame; **Values to fit**; **Fit**: "Fitted from N pairs: ..." with **Before fit**, **Error now** and **Held out** errors.
- [ ] **Refine automatically** lines the frame up with the model by their edges; on Al-Zour it often says the edges do not agree clearly (see [KNOWN-LIMITS.md](KNOWN-LIMITS.md)): use point pairs.
- [ ] **Save calibration**, optionally "Use this orientation and position for all N clips of this flight": "Saved: offset ..., field of view ..., orientation ..., position ...". **Reset** goes back to the saved values.

### Video, models and point clouds in Import

Use the HCl sample project or a new empty one.

- [ ] Drag in a DJI video with its `.SRT`: a clip with its flight path appears and plays in sync.
- [ ] Drag in a GLB, then **Georeference** it by clicking 3 point pairs; residuals show.
- [ ] Drag in a small LAS or LAZ: a **Jobs** entry converts it (progress, log); the cloud appears when done.

### Camera heights in Import

- [ ] In a project made from a typed origin, import DJI photos or a video with its `.SRT` that logged relative altitude: the **Camera heights** card asks **Relative altitude + take-off height** (**Take-off height H (m)**, proposed from the model under the take-off point, or the origin height with a warning) or **Absolute altitude + datum offset** (**Offset (m)**, saved as the project's vertical datum).
- [ ] After the import the panel says which altitude was used and with which number. A project made from a photo origin imports without asking.

### X1 Packages and map packs

- [ ] HCl, **Reports**, **Export package** (`.aio`): optionally set a passphrase; leave out the point clouds to keep it small. Switch on **Include the map region for this site**, set **Detail up to zoom** and **Margin**. A line reads "From <pack>: N tiles, size" and the package size grows.
- [ ] Switch on **Allow the customer to extract an editable copy**. **Export**: "Package written."
- [ ] Double-click the `.aio` (or Projects, Add): it opens in player mode: welcome screen, "Read-only package" chip, no annotation tools, cloud AI off.
- [ ] **Start exploring**, press **2** for the map: streets draw. **Settings, Offline maps** lists the region as **In open package**. Best check: on a PC or data folder without the Kuwait pack, the map still draws from the package.
- [ ] **Reports**, **Edit a copy**, **Extract to edit**: progress, then a new project opens with "Copy of <file>.aio" in the title bar and no "Read-only package" chip. Annotate the copy: the issue is saved in the new project; the `.aio` file is unchanged.
- [ ] A package exported without the allow switch: "The sender did not allow editing this package ...".
- [ ] Resumable download (only if you agree to a download from build.protomaps.com): **Settings, Offline maps**, **Add a region**, a small country, start, quit Stratlas mid-download. Reopen: **Interrupted**, "The download stopped at ... Resume continues from there ...". **Resume**: it finishes and the pack shows as downloaded.

### X2 Point cloud streaming smoothness

Measured on this PC: the recorded Al-Zour fly-through holds 60 fps with a p95 frame time of 16.8 ms in 5 of 5 runs (M4: 53 to 55 fps, p95 flipping between 16.8 and 33.3 ms).

- [ ] Al-Zour, full-resolution cloud on, **Ctrl+Shift+F** for the performance overlay.
- [ ] Fly from the overview down to a tank, then along the pipe racks: detail streams in without the regular stutter of M4; frame time mostly under 20 ms.
- [ ] No freezes of a few hundred ms when the ortho loads new tiles. Turn and zoom quickly: coarse detail first, finer after, no holes left behind.
- [ ] HCl with its LiDAR on: just as smooth.

### End to end (the M6 exit)

- [ ] One project of each type from the samples (inspection, volumetric, road): built, reviewed (inspection), report text saved, project report exported, and exported as a package that opens in the player.

## Stage M6.1: your M6 feedback, fixed

Build: the M6.1 installer, 5 Oct 2026, from main at commit `c0fda90` or later. All nine fixes are merged.

### Point clouds

- [ ] HCl and Al-Zour, toolbar **Point cloud**, **Point size**: 1x looks as before; at 2x the points are at least 2 px, at 4x at least 4 px. The colours do not change.

### Issue card

- [ ] Pick an issue anywhere: a pin or code label in 3D, a count badge list, a map marker, a timeline mark, a row in **Issues**, a 1st Ring Road defect row, or **Ctrl+K**. The right panel unfolds if it is folded and shows the issue card.
- [ ] The card shows code, title, severity, status, class, **Zone**, its place in the list ("N of M"), **Recommended action** and **Note**. The best photo is cropped around the defect with its box drawn; the other photos sit in a strip.
- [ ] An issue seen in a video shows the frame with **Jump to m:ss**: the clip plays from there.
- [ ] **Previous issue**, **Next issue** and **Fly to the issue** work. The edit form is folded under **Edit issue**; a read-only package has no **Edit issue**.
- [ ] Click the photo: it opens full size over the app. **Fit**, wheel to zoom, drag to pan; **M** turns the markings off and on; Left and Right step through the issue's photos; **Open in Media**; **Esc** closes.

### Evidence in split

- [ ] HCl, pick an issue in the 3D view: the stage switches to **Split** with the issue's photo on the other side, and the 3D view flies to the issue. **Esc** or **×** restores the layout.
- [ ] Switch off **Open evidence in split** on the card (on by default): picking in 3D now opens only the card.

### Media

- [ ] HCl, **Media**: a photo with findings has a count badge in its worst severity colour, a tinted border and the boxes drawn on the thumbnail. The bar reads "N photos with findings".
- [ ] **Only with findings** hides the other photos. **Order**: **As captured**, **Worst first**, **Most findings first**.

### HCl

- [ ] Orbit around the tank: the concrete ring around the base does not flicker.
- [ ] Every photo in **Media** and in the viewer is upright (they were turned 180 degrees, not only the straight-down ones). F13's box still sits on the blister.

### Maps

- [ ] Every street map is dark, also in the light app theme: the **Map** view, a map side of **Split**, the ground under a 3D site, 1st Ring Road, the map pickers in **New project** and the road builder, **Settings, Offline maps**, and packages. Zoom buttons, scale and popups are dark too.
- [ ] Delivered map rasters (orthos, plot plans) look as before.

### Drone telemetry (Al-Zour and HCl)

- [ ] Play or scrub a clip: the flown path is solid teal up to the playhead, the rest dashed. A shadow track on the ground with drop lines, and amber distance ticks ("250 m", "1.25 km") from START.
- [ ] The HUD plate reads DIST, T+, AGL, EL, GS, HDG and GMB.
- [ ] **D**, the toolbar button or **Ctrl+K** turns it off and on. On by default; remembered per project.

### Photo and panorama markers

- [ ] Al-Zour: the 12 photos show as 5 places, one of them with a "4". Photos within 1.5 m share one marker.
- [ ] Markers that overlap on screen merge with a count and split as you zoom in; at most 36 icons per layer.
- [ ] Hover a marker: the count and the time span. Click a merged marker: a small list with thumbnails.
- [ ] Icons are smaller: a photo is a rounded square with a camera, a panorama a circle. A click still opens them.

### AI agent

- [ ] In any window, also after clicking the video, ask the agent to move the camera. Al-Zour: "fly to tank 3", "show the jetty", "where the drone was at 13:25". HCl: "go to issue F05", "go to 29.0769043, 48.0838033". Anywhere: "top view", "orbit", "zoom in", "frame everything".
- [ ] After each move the agent says where the camera is; **Undo** on the step in the panel goes back.
- [ ] An ambiguous name: the agent lists the candidates and asks which one.
- [ ] Only if you remove the Workspace ID to try it: the "not scoped to a workspace" error shows a **Workspace ID needed** card in the agent panel with **Anthropic workspace ID**, **Test and retry** (sends your last message again, once) and **Open AI settings**.

### Masafi

- [ ] No frame around the orthos in 3D; the Al-Zour ortho and the 1st Ring Road edges are clean too.
- [ ] One survey date at a time: turn on the other date's ortho or terrain and the view switches to that date.
- [ ] The piles are hidden when the project opens, with the hint "Click a pile to see its outline and volume. Esc hides it."
- [ ] Click a pile on the terrain or in **Volumes**: the camera flies to it and shows its outline, body and a callout like "11,379 m³ · 18,206 t · 11.3 m high". Hover a pile: only its name. **Esc** or a click on empty ground hides it.
- [ ] The eye on a row keeps that pile visible; the eye at the top shows every pile (remembered per project). The pile's detail shows **Fill**, **Cut**, **Net**, the base and **Last edit**.
- [ ] **Elevation**: **Colour ramp** Turbo (the default), Spectral, Viridis, Terrain, Inferno, Greyscale; **Low** and **High** sliders in metres and **Auto**; **Hillshade** (on by default). The legend reads in metres.
- [ ] The street map lies under the site in 3D. **Layers and issue pins**, **Street map under the site** turns it off; on by default for stockpile projects.

### Compare dates (Masafi)

- [ ] **Compare dates** sits next to **3D**, **Map** and **Split**. From 3D or Split it opens two 3D views, from **Map** two maps: the first date on the left, the last on the right. Remembered per project; **Stop comparing dates** leaves it.
- [ ] Each side has a date selector; picking the other side's date swaps the two. With **Link the two views** on, orbit, pan and zoom move both sides.
- [ ] Click P05 on one side: P05 is outlined on both.
- [ ] **Split** with **Ortho and plans** on both sides shows two orthos side by side.

### Dates and report branding

- [ ] 1st Ring Road, open a defect: **Recorded** shows 2 Apr 2024 (the local day), not 1 Apr.
- [ ] **Settings, Report branding**: type a company name, press **Enter**, then pick a logo straight away: the report keeps both.

## Stage M7 (later): signed builds and updates

The rest of M7 passed on 6 Oct 2026. These need the signing secrets in GitHub (`docs/release/SECRETS.md`) and a second version, so they wait:

- [ ] Online update from 0.7.0 to a newer version, **Return to 0.7.0**, and the "did not start correctly" offer after a failed first start.
- [ ] Signed installer showing Synapse Solutions.
- [ ] macOS dmg (Apple silicon and Intel), `.aio` double-click and `stratlas://` links.
- [ ] The Store submission checklist (`docs/release/STORE-SUBMISSION.md`).

## Stage M8: change and modelling

Everything here runs offline on the new bundled demo **Demo change site (2 dates)**: a made-up site flown on 2 Mar 2026 and 13 Apr 2026, with known changes planted on purpose. Opening it makes a working copy, so the bundled demo is never changed.

### Before you start

- [ ] Install `Stratlas-0.9.0-win-x64-setup.exe`. **Settings, About and updates** shows version 0.8.0.
- [ ] Copy the folder `E:\Dev\AIO Software\apps\desktop\dist\pipeline-pack-0.3.0` into `E:\Stratlas Data\runtime\`. **Jobs** then shows "Pipeline pack 0.3.0" at the top. The change, drawing and fitting jobs need it.
- [ ] **Projects** shows three demo cards, one named **Demo change site (2 dates)**. The first-start welcome still opens the 0.7.0 demo.

### The change demo

- [ ] Open **Demo change site (2 dates)**: it has two survey dates. The later ortho shows a new shelter, a missing blue container, a moved yellow skid, a pit, a new track and a dark cloud shadow.
- [ ] Play **Drone video 2026-04-13**: a short, low-resolution orbit that plays and seeks.

### Changes panel

- [ ] Click **Compare dates**: two 3D views, first date left, last date right.
- [ ] Click **Show changes** (flag button next to Compare dates): the right panel opens on **Changes**, with Earlier and Later set to the two dates.
- [ ] Click **Find changes**:
  - issues: 1 New, 1 Grown, 1 Resolved, 3 Unchanged;
  - detections: one row per place on the ground (1 new, 1 resolved, 2 unchanged);
  - map layers: the fence reads "reshaped" and the track "added".
- [ ] Click the **New** issue row: both views fly to it, its pin is ringed on both dates and shows faint on the earlier date.
- [ ] Click the **Resolved** row, **Close as resolved**, **Yes, close it**: in **Issues** that issue is now closed. It was open before.
- [ ] Click the added track row, then **Make issue**: a new draft issue appears in **Issues**, dated to the later survey, and the row says Confirmed.
- [ ] Go to **Projects** and open the demo again: the **Changes** tab keeps your reviews.
- [ ] Click a layer in **Datasets**. On its Selection card, set **Belongs to date...** to the other survey: while comparing, the layer moves to that date's view.
- [ ] With cloud AI on, ask the agent "What changed between the two surveys?": it gives the same counts as the panel.

### Imagery and surface change

- [ ] In **Changes**, click **Run imagery change**. The job finishes in **Jobs**, and two layers appear: "Imagery change heat map ..." and "Imagery change areas". The new building and the removed container are outlined; the cloud shadow and the colour tint are not.
- [ ] Click **Run surface change**: the grown stockpile shows fill, the new pit shows cut, with site totals. Blue is cut, red is fill; the legend reads in metres.
- [ ] While comparing dates, open the compare bar from the stage toolbar (next to **Compare dates** and **Show changes**). **Swipe**: drag the divider across the site, earlier date left, later right. The arrow keys move it, and Shift+arrow moves it by 10%.
- [ ] **Blend**: the slider fades the later date in. **Side by side** restores the normal split.
- [ ] Pick the imagery heat map: its legend reads "Change score".

### Point cloud and model change

- [ ] In **Changes**, click **Run cloud change**: a layer "Cloud change ..." appears under Point clouds, and the clouds switch to **Colour by: Change** on their own. Moved and new objects are amber or red, the rest grey. The legend reads 0.00 m to 0.30 m.
- [ ] Drag **Hide changes under** to about 0.10 m: the grey points disappear. Point at a red point: "Under the pointer: 0.xx m".
- [ ] Click **Run volume change** in the legend: fill, cut and net volume appear in the legend.
- [ ] Click **Run model change**: parts are listed as moved, added, removed and changed (the dented tank). Clicking a row outlines the part on both dates. Switch on the hidden layer "Model change ...": the dent is amber to red.

### Same view on the other date

- [ ] Press **3** for Split and choose **Frames** in the right pane: a frame from one date next to the same view from the other, with how far apart they are ("1.3 m, 2 degrees apart").
- [ ] Play or drag the timeline: the other side stays on the same view.
- [ ] **Swipe** with **Line up the ground** on: roads and edges match across the handle. **Blend** halfway: new structures appear faintly over the old ground.
- [ ] In the video window title bar, click **Same view on the other date** (clock icon): the split opens with Frames on that clip.
- [ ] In the split's **Photo** pane, click **Same view on the other date**: the matching photo from the other date shows beside it; **Next photo** keeps the pairing.
- [ ] In **Changes**, click **Find changes in matched frames**, then open **Detections**: the changes show as draft boxes labelled "change" on the later photos.

### Model builder (models from drawings and scans)

- [ ] Press **Ctrl+K**, type "model", choose **Open the model builder**: the panel opens beside the 3D view.
- [ ] **Import drawing (DXF)**, choose the unitless plot plan in the demo's `sources` folder, **Import**: "... Set the drawing units ... and import again."
- [ ] Import the demo plot plan in metres: "The drawing is imported ..." and the plan lies on the ground.
- [ ] **Place by points**, with two pairs typed or clicked:
  - "960 1960" on the plan to "301665 2575038" on the site;
  - "1040 2040" on the plan to "23.27346421, 1.0617853" on the site.
    Then **Place the drawing**: the plan lies over the site.
- [ ] **From drawing**: tanks with their tags, and buildings, appear as drafts with heights.
- [ ] Select a tank, change **Height** and press Enter. Press **A** to accept it (or **Accept all drafts**), then **Build model**: "The model is built", and clicking tank **T-201** selects its tag.
- [ ] Choose the modelling scan **Point cloud 2026-04-13**, then **From point cloud**: "N draft parts fitted", each showing "Fitted, x.x cm off".
- [ ] Select one part, press **R** (rejected), accept the rest and **Build model**.
- [ ] With cloud AI on, ask the agent to build one of the drawing's tanks (for example "Build tank T-202 from the drawing"): a draft step waits for **Approve**. With **Allow cloud AI for drawings** off (the default), the agent's result names no tags or sizes.

### Local detection

- [ ] **Settings, AI providers, Detection models**: "onnxruntime 1.30.0 on DirectML (graphics card)" (or CPU).
- [ ] Tick the licence checkbox, **Import model**, and pick `model.json` in the demo's `sources\marker-detector` folder: "Imported Marker test detector." The card shows yolo-v8, 320 x 320, MIT.
- [ ] Import a broken model (any text file renamed `model.onnx` next to a `model.json`): a red "The model could not be loaded: ..." and the app stays up.
- [ ] In the demo, open **Detections**, choose **All photos**, select photos, then **Detect with AI**, **Local model**. It says "Runs on this computer ... Nothing leaves this computer. Free." Run it: "x of N photos checked", "Cost: free". Draft boxes sit on the magenta markers. Accept two with a number key, then **A**.
- [ ] Turn Wi-Fi off and run it again: the same.
- [ ] Start a run and press **Stop**: "Stopping after this photo", then **Stopped**. **Run the remaining N** finishes it.

### Offline agent

Install Ollama (or LM Studio) yourself and pull a model that supports tool calling.

- [ ] **Settings, AI providers, Local model**, **Find models**: your server and its models, with badges (Tools, Vision, context, size). Click a model: "In use". **Test**: "Tools yes, vision ... First answer in N s."
- [ ] Turn on **Offline agent**: "Every task runs on <model>. Nothing leaves this machine." The status line reads "Agent: local (offline) · <model> on this machine".
- [ ] Turn Wi-Fi off, open the change demo and ask "Fly to tank T-201": the steps run, the camera moves, there is no send preview and the meter shows $0.00.
- [ ] Choose a model without tool support and **Test**: "Tools no". Ask the agent to act: the panel says it can only answer in text, and shows no tool steps.
- [ ] Ask something and press **Stop** at once: "Stopped."
- [ ] Type a LAN address (for example `http://192.168.1.20:11434/v1`) and **Find models**: a warning that it is on another machine. With cloud AI off, it is refused.
- [ ] Turn **Offline agent** off: your earlier AI routes come back.

## Stage M9: team and audit

M9 adds a signed history of every change, identities and roles, a review workflow, and sharing between copies by exchange files, a shared folder, or a team server (preview). A project you never share works exactly as before.

**Two people on one PC.** Most steps need two people. Run a second copy as "Omar" with `Stratlas.exe --profile=reviewer-b`, started from the install folder (`%LOCALAPPDATA%\Programs\Stratlas`) in a terminal. Each copy needs its own copy of the project: copy the demo tank farm folder to two places, for example `E:\Team test\rana` and `E:\Team test\omar`. **Use the demo or a copy, never your client projects.**

### Before you start

- [ ] Install `Stratlas-0.9.0-win-x64-setup.exe`. **Settings, About and updates** shows version 0.9.0.
- [ ] Open one of your own projects (not shared): it looks and works as before, with **Share** in the title bar and no new cards.

### Identity and team

- [ ] **Settings, Identity and team**: your name (from the old "Your name on issues", or your Windows name) and initials made from it.
- [ ] Set **Initials** to `DR`, press Enter: no error. Type `X1Y`, Enter: "Initials are 1 to 3 letters, optionally followed by one digit."
- [ ] In Omar's copy, set **Your name** to `Omar Sample`: the initials become `OS`. Click **Export identity card** and save it: "Saved to ...\Omar Sample.aioid".
- [ ] In your copy, open your test project, click **Share** in the title bar, choose **Exchange files**, **Share**: Share adds you as Owner.
- [ ] **Settings, Identity and team**, **Add from card**, pick Omar's card: a panel "Omar Sample OS", **Add as** Reviewer, **Certify this card** ticked. Click **Add Omar Sample**: the members table shows you as Owner (you) and Omar as Reviewer, "Certified by you". Members also show in the Team dialog (title bar chip).
- [ ] Change Omar's role to **Viewer**, then back to **Reviewer**. There is no role select on your own row.
- [ ] Windows **Credential Manager**, Generic credentials: one Stratlas entry with `device-signing` per profile. **Export diagnostics**: the bundle has no key.

### Exchange files (USB or email)

- [ ] In your copy, change F01's title and press Enter. Open the title bar chip (Team dialog), **Export changes**: "Changes only" and a line such as "2 changes · 1 KB". **Export**, save: "Saved …aiosync".
- [ ] In Omar's copy, **Share**, **Import exchange file**, **Choose file**: From "<your name> (DR)", "Signed by their device", the new changes listed, and "Applying it makes this project part of the team project…". **Apply**: "Applied … changes", F01's new title in Issues.
- [ ] Import the same file again: "Already applied. Nothing in this file is new." and **Apply** greyed out.
- [ ] Export again with **Encrypt with a passphrase** (at least 8 characters, twice). In Omar's copy, import it: you are asked for the passphrase; a wrong one says "The passphrase does not open this exchange file."
- [ ] Double-click an `.aiosync` file in Explorer: Stratlas opens its import dialog.

### Shared folder

- [ ] Make a folder, for example `E:\Team test\hub` (or a NAS path). In your copy, open the chip, **Use a shared folder**, enter the path, keep automatic sync on, **Share**: "Synced just now", and `aio-hub.json` appears in the folder.
- [ ] In Omar's copy, **Share**, **Shared folder**, the same path, then choose the **Team project in this folder**: it joins with no exchange file.
- [ ] Change F02's severity in your copy, **Sync now**: "Synced: 0 received, 1 sent." In Omar's copy, **Sync now**: "1 received" and F02's new severity.
- [ ] Rename the hub folder away. Edit an issue, **Sync now**: the chip turns amber, "The shared folder cannot be reached…", "1 to send", and your work is kept. Rename it back, **Sync now**: the change is sent.
- [ ] Watch Resource Monitor (Network) during a sync: no network connections from Stratlas.
- [ ] **Stop syncing this copy**: the chip goes back to **Share**; your data and history stay.

### Conflicts

- [ ] Rename the hub away. Set F01's severity to 3 in your copy and 1 in Omar's. Rename it back and sync both, then sync yours again: both chips show "1 conflict". The Team dialog shows the Conflicts inbox: "F01 severity", your value and Omar's, with names and times.
- [ ] **Keep mine**, sync both: both copies show 3, the conflict is gone, and History lists the values.
- [ ] On another conflict, **Edit**, type a value, **Save**: it shows on both copies after sync. **Earlier values**, **Restore**: the older value on both.
- [ ] While apart, each of you makes a new issue, then sync: one gets the next code and a notice says the code changed (for example "F10 was F09 ..."). **OK** clears it.
- [ ] You delete an issue while Omar edits it, then sync: the issue is kept, with "You deleted ... while Omar Sample changed it. It was kept." **Delete again** removes it on both.
- [ ] Before Omar is added from his card, his changes show in your copy under **Quarantined** with **Apply anyway** (owners only).
- [ ] **Issues, My work** lists Conflicts and Quarantined changes.

### Review workflow

- [ ] In your copy, select F03, **Edit issue**, under Review **Assign**: Omar Sample (OS), due Friday, **Save**: "Assigned to Omar Sample", "Due Fri …". Issue chips and the register show initials.
- [ ] In the comment box type `@Om`, pick **Omar Sample**, type "please check the weld", tick **Attach view**, **Comment**: the comment shows "Go to the view".
- [ ] Open an issue you made, **Approvals**, **Approve**: "Another reviewer must approve this. You made it or last changed it." The status row has no Approve button in a team project.
- [ ] Sync. In Omar's copy, **Issues, My work**: F03 under Assigned to me, Mentions and Awaiting my approval. Click the mention: the camera flies to your view. **Mine** lists only F03.
- [ ] Omar approves your issue in **Approvals**: "Approved. The status is now Approved."
- [ ] Change that issue's severity in your copy and sync: the status goes back to Reviewed and the Approvals tab says "Approval out of date".
- [ ] **Reports**, export the project report PDF: a "Sign-off and approvals" page with prepared, reviewed and approved by, names, initials and dates.
- [ ] With cloud AI on, ask the agent "What is assigned to Omar?": it lists F03. Ask "Approve F03": it says only a person approves, and offers to request approval.

### History and audit trail

- [ ] Open F01, **Edit**: **History** lists each change with who, when, how ("By hand", "Synced from Omar Sample", "Change pipeline"), and before and after values. **Restore** an older value.
- [ ] **Reports, Open audit trail** (or the project menu in the sidebar): filter by person and by F01. **Verify**: "The history is intact. Every entry is signed."
- [ ] **Export audit (CSV)** and open it in Excel: names and any Arabic text intact.
- [ ] In the test copy, open `journal\ops\<folder>\000001.jsonl` in Notepad, change one letter, save. **Verify**: it names the file and line that was edited, and the project still opens and edits.
- [ ] With the app closed, change a severity in the copy's `issues.json` in Notepad, then reopen: History shows "Changed outside Stratlas".
- [ ] Export the project report PDF: every page footer reads "Audit head <16 characters>, N entries, verified", and an **Audit trail** section lists the changes.

### Large files on demand

- [ ] In Omar's copy (joined through the shared folder), if a layer's file is only in the hub folder, a card at the bottom left says "1 layer is not on this computer" with its size. **Download**: progress; **Cancel**: "Paused at ..."; **Resume**: the layer appears.
- [ ] **Files**, set a video layer to **Stream from shared folder**: "Streaming from the shared folder", and it plays.

### Shared project folder

- [ ] Open the same project folder in both copies at once. Save a change in one, then a change in the other: the second save is refused with a notice and **Reload**. Nothing is overwritten.

### Older and newer versions

- [ ] Open a test copy edited in 0.9 with 0.8.0: it opens, with the 0.9 edits.
- [ ] In a test copy, change `"schema": "aio.project/1"` in `manifest.json` to `aio.project/2` and open it: "Project was saved by a newer Stratlas ... Update the app to open it.", and the file is unchanged.
- [ ] Switch between projects twenty or thirty times, then open **Task Manager**: Stratlas's memory stays about level (it no longer grows by several MB with every switch).

### Team server (preview, optional, needs Docker)

Follow `docs/server/README.md` on a Linux machine or Docker Desktop. Then:

- [ ] **Settings, Data folder, Team server** shows a **Preview** label and "No team server is connected on this computer."
- [ ] Enter `https://<host>:8443` and the owner invite code, **Connect**: **Check the certificate** shows the fingerprint in groups of four. It matches the server's; **They match, connect**: "Connected to ...", "Enrolled as owner".
- [ ] Reusing the same code says "This invite code is not valid. It may be mistyped, used or expired."
- [ ] **Share** offers **Team server** once enrolled. Omar enrols with a reviewer code and sees the project after sync. A viewer's edits are refused.
- [ ] Stop the server: Stratlas keeps working, and sync says "The team server cannot be reached…".
