# Testing Stratlas

One document for every test round, one stage per milestone. Each stage lists what to click and what you should see. Earlier stages still apply unless a line says a behaviour changed.

## How to use this document

### Install

- Close Stratlas first. The installer refuses while it runs: "Stratlas is running. Close it and click Retry."
- Run `E:\Dev\AIO Software\apps\desktop\dist\Stratlas-0.1.0-win-x64-setup.exe` and install over the previous version.
- No install: `Stratlas-0.1.0-win-x64-portable.exe` in the same folder.
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

| Stage               | What it covers                                                                                                                                         | Build it needs                                                                                                                | Status                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| M1 to M4 (baseline) | The six projects, fusion scene, annotation, maps, AI, platform, reports and exports, packages, builder basics                                          | The current installer (M6 build, 4 Oct 2026) or later                                                                         | Tested by the founder; the feedback was fixed in M5                                       |
| M5                  | Fixes from the M4 feedback: Masafi, DAMAC, video, layers, cut-away, split, sky and water, report branding, AI keys                                     | The M5 installer, built 4 Oct 2026 after the sky and water merge (commit `862c9df`) or later                                  | Not yet tested by the founder                                                             |
| M6                  | Builder completion: pipelines from raw data, detection review, AI detection, report text and project report, video calibration, packages and map packs | The M6 installer, built 4 Oct 2026 from main at commit `4624bf2` or later, and pipeline pack 0.2.0 (see M6, Before you start) | Everything merged (P1, P2, P3, R1, R2, R3, R4, A1, X1, X2); not yet tested by the founder |
| M7                  | Release hardening and distribution                                                                                                                     | Not built yet                                                                                                                 | Planned                                                                                   |
| M8                  | Change detection and modelling                                                                                                                         | Not built yet                                                                                                                 | Planned                                                                                   |
| M9                  | Team features and release 1.0                                                                                                                          | Not built yet                                                                                                                 | Planned                                                                                   |

## Stage M1 to M4: baseline

Everything that was new in M1, M3 and M4 and still behaves the same. Lines that changed after your M4 feedback are in stage M5 and marked "Changed in M5" here.

### Projects and library

- [ ] **Projects** shows 6 projects with thumbnails, sizes and layer counts: HCl Tank 710-D-130335, KIPIC Al-Zour LNG terminal, EBSM flare stack, DAMAC Hills tower, Masafi stockpiles, 1st Ring Road.
- [ ] The map packs list shows GCC, Kuwait and World.
- [ ] **Ctrl+K** finds projects, layers, issues and actions. **Ctrl+B** collapses the sidebar.
- [ ] Each imported project opens its **Original review** (the delivered HTML report) inside Stratlas, offline: sidebar **Original review** or Ctrl+K.

### Fusion scene: HCl Tank 710-D-130335

- [ ] 3D: orbit (left drag), pan (right drag), zoom (wheel). Toolbar: Top, North and Iso views, measure, section cut, labels (**L**: Off, Key, All).
- [ ] Click a clip bar on the timeline or a clip under **Video** in the sidebar: the video window shows the live frame with altitude, speed, gimbal and heading. Changed in M5: one clip per flight, and a click plays from the clicked point.
- [ ] **Space** plays and pauses; **J K L** and the arrow keys step and shuttle in the video window.
- [ ] Inside the tank: **C** gives the inside view behind the drone. Changed in M5: the tank is no longer cut open automatically; use the **Inside the asset** tool.
- [ ] Point cloud colour by **Elevation** (RGB is disabled: this LiDAR has intensity only).
- [ ] **Issues**: select F05, the camera flies to it. Your 2 issues from the first test are still there (13 issues).
- [ ] Photos: **Media** screen, or click a photo camera in 3D.

### Fusion scene: KIPIC Al-Zour

- [ ] The plant sits on the drone ortho at the shoreline.
- [ ] Play **DJI_0665** (Flight 1, clip 3): the drone flies its path and its live frame drapes onto the tanks and ground.
- [ ] **P** cycles flight paths: All, Active clip, Off. The drone and its frustum stay visible. The eye on a sidebar flight row hides that flight's path only.
- [ ] Toolbar **Point cloud** button: show the cloud, colour by RGB, **Elevation**, Intensity, Flight or **Classification** (legend with classes you can hide); size, budget, EDL.
- [ ] **Al-Zour full resolution (COPC, 841.7 M points)** is on: fly close to a tank or pipe rack, detail streams in (pipes, stairs). Expect about 55 to 60 fps.
- [ ] Click a tank or building: asset tag and area. Labels (**L**) show area callouts.
- [ ] Mavic Cine photo **pins** over the plant; click one to open the photo.
- [ ] Drone-eye view (camera button) while playing: steady, no flicker.
- [ ] Click a panorama marker: drag to look, scroll to zoom, **Esc** returns to 3D.
- [ ] **Maps and rasters**: switch on Overall or Area plot plans; the red line art lines up with roads and tanks.
- [ ] Play a clip, **Calibrate video**: time offset and field of view. Changed in M6: one 70.9 degree lens for every clip, plus orientation and position (see M6, A1).

### The other four projects

- [ ] **EBSM flare stack**: stack model with issue pins, 299 photos; Issues lists F01 to F78 and 53 uncertain areas (U codes). Open a photo from an issue: corrosion mask overlay with opacity slider.
- [ ] **EBSM** original review: findings map, photo masks; downloads save through a Windows dialog.
- [ ] **DAMAC Hills tower**: photo cameras around the tower; Issues has 656 defects (D codes) and 45 uncertain; RGB and thermal photo layers. Open a thermal photo with its overlay.
- [ ] **DAMAC** 3D: issues show as **count badges** coloured by worst severity; click a badge to fly in; codes on hover. Changed in M5: only faces you can see.
- [ ] Imported EBSM and DAMAC findings show as **Reviewed**, uncertain ones as **Draft**.
- [ ] **Masafi stockpiles**: two terrains (31 Dec 2020, 10 Jan 2021) with photo texture and pile callouts (P03 10,237 m³).
- [ ] **Masafi**, right panel **Volumes**: register of 19 piles with fill, cut, net and change. Switch the date and the base (Triangulated toe, Best-fit plane, Average toe, Lowest toe).
- [ ] **Masafi**: click P02: red volume body, base plate, toe line; 11,379 m³ (10 Jan, triangulated toe), tonnage, footprint, height.
- [ ] **Masafi**: **Swipe** between the two dates. Changed in M5: cut and fill colours are on the **Photo | Elevation | Cut / fill** switch.
- [ ] **Masafi**: **Edit boundary**, drag a toe point, the volume recomputes; Save; reopen the project: the edit is kept. Export the register as CSV.
- [ ] **1st Ring Road** opens map first with the **chainage ruler** (0 to 7.55 km, 250 m bars by severity, PCI strip). Click a bar to jump; drag to filter.
- [ ] **1st Ring Road**: zoom in, defects as **polygons** on the 3.25 cm ortho, coloured by stage or type; **PCI grid** Low, Medium, High; click a sample unit for its deducts.
- [ ] **1st Ring Road**: density heat map; filters by stage, type and chainage; search a defect code; open a defect: close-up with outline, previous and next.

### Annotation

- [ ] **A** turns on Annotate mode.
- [ ] Video window or photo: **Box**, draw, pick class and severity: a new issue appears with a pin on the model.
- [ ] Mesh tools: **Pin**, **Line**, **Area** on the model; **Cloud point** and **Cloud box** on a point cloud.
- [ ] The issue is saved: close and reopen the project, it is still there.

### Issues at scale

- [ ] Layers popover: pins **All**, **Severity N and above**, **Off**; heat map option.
- [ ] **Issues** on 1st Ring Road (2,115): instant search, group by severity, class or zone, bulk set status with undo.

### Maps

- [ ] **Map** shows the offline street map with issue markers; **Split** shows 3D and map together. Changed in M5: each side of the split has its own selector.
- [ ] Al-Zour map: the plant, flight paths and the live footprint of the playing clip.
- [ ] 1st Ring Road: 2,115 defects on the Kuwait map with Arabic labels.

### AI (Cloud AI on and your own key)

- [ ] **Settings, AI providers**: add a key (Anthropic, OpenAI or Google). It is stored in Windows Credential Manager, never in files.
- [ ] Ask the agent "Which clips show F05?" or "Fly to the roof nozzles".
- [ ] First message in a project shows a **preview** of exactly what will be sent; "Always allow for this project".
- [ ] Close and reopen the project: the conversation resumes; export it as Markdown.
- [ ] A write action ("draft an issue for the roof nozzle") waits for **Approve**, also after an app restart.
- [ ] **Settings, Usage and cost**: tokens and estimated cost per project.
- [ ] Tools: "compare the two Masafi surveys", "how many issues by zone", "find issues within 10 m of N5", "open the original review".

### Platform

- [ ] **Settings, Appearance**: Dark, Light, System. Check every screen in Light.
- [ ] **Settings, Offline maps**: coverage map of installed packs; **Import pack file**; **Remove**. **Add a region** downloads from build.protomaps.com: only if you want a download.
- [ ] **Settings, Graphics quality**: detected tier (this PC: Ultra); try High or Medium.
- [ ] **Settings, About and updates**: version, folders, licences, **Export logs**.
- [ ] **Ctrl+Shift+F**: performance overlay (fps, frame times, points, GPU memory).

### Reports and exports

- [ ] **Reports**: open the EBSM report (88 pages) and the DAMAC report (206 pages) inside the app: thumbnails, zoom, search.
- [ ] **Issues, Export**: CSV, GeoJSON, COCO, kit JSON, masks ZIP. Each asks where to save and shows progress; the app stays responsive.
- [ ] **3D snapshot** PNG with legend.
- [ ] **Issue register PDF**: cover, charts, register, one page per issue with photo crop and 3D view (try HCl first: small).

### Customer packages

- [ ] Export HCl as a **package** (`.aio`), optionally with a passphrase; leave out the point clouds to keep it small.
- [ ] Double-click the `.aio` (or Projects, Add): it opens in player mode: welcome screen, "Read-only package" chip, no annotation tools, cloud AI off.

### Building projects (Release B basics)

- [ ] Projects, **New project**: name, customer, type, coordinate system (UTM zone search), origin (map click or **Typed coordinate**), severity template, brand. The project opens empty.
- [ ] Drag in a few drone photos with GPS: they appear as posed cameras.
- [ ] Drag in a DJI video with its `.SRT`: a clip with its flight path appears and plays in sync.
- [ ] Camera heights: in a project made from a typed origin, drag in DJI photos or a video with its `.SRT`. A **Camera heights** card asks for the take-off height (proposed from the model under the take-off point, or the origin height with a warning). After the import the panel says which altitude was used and with which number. A project made from a photo origin imports without asking (absolute altitude, offset 0).
- [ ] Drag in a GLB, then **Georeference** it by clicking 3 point pairs; residuals show.
- [ ] Drag in a small LAS or LAZ: a **Jobs** entry converts it (progress, log); the cloud appears when done.

## Stage M5: your M4 feedback, fixed

Build: the M5 installer, 4 Oct 2026, or later. Below is what changed after your feedback.

### Masafi

- [ ] Toolbar: **Photo | Elevation | Cut / fill** switch, always visible. Elevation colours the terrain with its legend.
- [ ] **Section** tool: click the first point, move the mouse: the camera stays still. Click the second point: the profile appears.
- [ ] Pile register: an **eye** per pile hides its volume, toe line and m³ label in 3D. The eye in the header hides or shows every pile; the footer counts hidden piles. A selected pile always shows.
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
- [ ] **Split**: each side has a selector (3D view, Map, Video, Photos, Ortho and plans, Report: only what the project has). Try Video on the right, Photos on the left. The 3D view exists only once.

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

### AI

- [ ] Anthropic organisation key: **Settings, AI providers**, Anthropic, enter the **Workspace ID** (starts with `wrkspc_`, from the Claude Console), or use a key created inside a workspace.
- [ ] **Test connection** next to each provider shows the exact answer or error.
- [ ] Agent errors show the provider's own message (never the key).

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
- [ ] **Refine automatically** lines the frame up with the model by their edges; on Al-Zour it often says the edges do not agree clearly (see Known limits): use point pairs.
- [ ] **Save calibration**, optionally "Use this orientation and position for all N clips of this flight": "Saved: offset ..., field of view ..., orientation ..., position ...". **Reset** goes back to the saved values.

### Camera heights in Import

- [ ] In a project made from a typed origin, import DJI photos or a video with its `.SRT` that logged relative altitude: the **Camera heights** card asks **Relative altitude + take-off height** (**Take-off height H (m)**, proposed from the model under the take-off point, or the origin height with a warning) or **Absolute altitude + datum offset** (**Offset (m)**, saved as the project's vertical datum).
- [ ] After the import the panel says which altitude was used and with which number. A project made from a photo origin imports without asking.

### X1 Packages and map packs

- [ ] HCl, **Reports**, **Export package**: switch on **Include the map region for this site**, set **Detail up to zoom** and **Margin**. A line reads "From <pack>: N tiles, size" and the package size grows.
- [ ] Switch on **Allow the customer to extract an editable copy**. **Export**: "Package written."
- [ ] Open the `.aio`: **Start exploring**, press **2** for the map: streets draw. **Settings, Offline maps** lists the region as **In open package**. Best check: on a PC or data folder without the Kuwait pack, the map still draws from the package.
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

## Stage M7: release hardening and distribution (planned)

Planned, steps added when built. Windows code signing (Azure Trusted Signing or a certificate) so SmartScreen stops warning, and a Microsoft Store submission with a demo project. A macOS build with notarisation. Offline auto-update. A crash and diagnostics bundle you can send in one click. An accessibility and keyboard pass over every screen. A performance budget checked on mid-range graphics cards, not only this PC. A user guide.

## Stage M8: change and modelling (planned)

Planned, steps added when built. Change detection between capture dates across every layer type: meshes, point clouds, orthos and issues. 3D models built from 2D drawings and plot plans, and from point clouds, AI-assisted (PRD BLD-11). Local ONNX detection that runs on this PC with no cloud AI (BLD-10).

## Stage M9: team and 1.0 (planned)

Planned, steps added when built. Optional team sync and project sharing. A multi-reviewer workflow: assign, comment, approve. An audit trail of who changed what. Release 1.0.

## Known limits

Current limits only; each is removed from this list when fixed.

### Data and positions

- HCl position on the map is approximate (the source has no survey position); flight start times are nominal, relative timing is exact.
- DAMAC origin height is approximate (no survey control in the source).
- Video calibration is one constant offset per clip (orientation, position, time, lens): no bias that changes along a clip. On Al-Zour, **Refine automatically** is weak (the edges rarely agree clearly on the plant); point pairs work.
- No geoid model: camera heights are the drone's absolute or relative altitude plus the offset or take-off height you give; a project's vertical datum is one offset.
- One take-off height per import batch: import flights that took off from different heights separately.
- Al-Zour sea level (93.56 m) is marked indicative; adjust it in the sun popover if the waterline looks high. A few light surf patches near the west breakwater read as land and show as flat patches on the water.

### Viewer

- Issue labels hidden behind the building can lag the camera by about a tenth of a second while orbiting.
- At night the point cloud keeps its daylight colours and takes no shadows.
- With the right panel open on a 1440 px screen, the Labels and layers buttons move into the **More** menu.
- No Arabic translation yet; **Right to left** mirrors the panels only.

### Reports, packages and maps

- Report branding is one setting for all projects (no per-project override yet).
- Road project reports default to issue pages for all but the lowest level (a page per Ring Road defect would be over 2,000 pages); pick **Every graded issue** to print them all.

### Builder

- The pipeline pack is not in the installer; it lives in `E:\Stratlas Data\runtime` (now `pipeline-pack-0.2.0`) and must match the build. The app uses the newest pack there.
- **Outline** (mask assist) needs a mask model file in the pipeline pack; none ships yet (licences).
- The HCl sample's GPS and gimbal tags are written from the delivered camera poses (the Elios 3 logs no GPS in the tank) around the approximate HCl origin; a real photo set brings its own tags.
- Cloud AI detection needs Cloud AI on and your own key; cost is an estimate from list prices.

### Release

- Unsigned build: SmartScreen warns on install. No automatic updates: install over the previous version. Store submission waits for M7.
- Old video files are kept in `projects\hcl\video.before-1080` and `projects\alzour\video.before-1080` (about 0.6 GB): delete them once you are happy with M5.
