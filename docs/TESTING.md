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

| Stage               | What it covers                                                                                                     | Build it needs                                                                                                                        | Status                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| M1 to M4 (baseline) | The six projects, fusion scene, annotation, maps, AI, platform, reports and exports, packages, builder basics      | The current installer (M5 build, 4 Oct 2026) or later                                                                                 | Tested by the founder; the feedback was fixed in M5                       |
| M5                  | Fixes from the M4 feedback: Masafi, DAMAC, video, layers, cut-away, split, sky and water, report branding, AI keys | The M5 installer, built 4 Oct 2026 after the sky and water merge (commit `862c9df`) or later                                          | Not yet tested by the founder                                             |
| M6                  | Builder completion: pipelines from raw data, detection review, AI detection, report, packages and map packs        | A new build from main with the M6 merges (commit `5333987` or later), and a pipeline pack built after them (see M6, Before you start) | In progress: X2, P1, P2, R1, R2 merged; P3, X1 merging; R3, R4, A1 coming |
| M7                  | Release hardening and distribution                                                                                 | Not built yet                                                                                                                         | Planned                                                                   |
| M8                  | Change detection and modelling                                                                                     | Not built yet                                                                                                                         | Planned                                                                   |
| M9                  | Team features and release 1.0                                                                                      | Not built yet                                                                                                                         | Planned                                                                   |

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
- [ ] Play a clip, **Calibrate video**: time offset and field of view (lens 72.2 and 65.6 degrees).

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

## Stage M6: builder completion (in progress)

Goal: build a complete deliverable inside Stratlas, from raw data to a reviewed, reported and packaged project. Each part below says whether it is merged, merging now, or coming.

### Before you start

- [ ] The build stamp shows a commit at or after `5333987` (4 Oct 2026, 19:16).
- [ ] **Jobs** shows "Pipeline pack <version>" at the top.
- [ ] The pipeline pack must be built after the M6 merges. The one in `E:\Stratlas Data\runtime\pipeline-pack-0.1.0` (4 Oct, 08:51) is older. If a job stops at once with "There is no pipeline called ...", the pack is too old: ask me for a new one.
- [ ] Work on new projects or copies. Pipelines and accepted detections write into the open project (always with a backup, never dropping your own issues).

### X2 Point cloud streaming smoothness (merged)

- [ ] Al-Zour, full-resolution cloud on, **Ctrl+Shift+F** for the performance overlay.
- [ ] Fly from the overview down to a tank, then along the pipe racks: detail streams in without the regular stutter of M4.
- [ ] Frame time stays mostly under 20 ms, about 55 to 60 fps.
- [ ] No freezes of a few hundred ms when the ortho loads new tiles.
- [ ] Turn and zoom quickly: coarse detail first, finer detail after, no holes left behind.
- [ ] HCl with its LiDAR on: just as smooth.

### P2 Volumetric survey from raw data (merged)

You need one or two survey dates, each with a DSM GeoTIFF or a point cloud, and optionally an orthomosaic GeoTIFF for the photo texture.

- [ ] Projects, **New project**: name, type **Volumetric**, **Next**.
- [ ] Origin: click the map or **Typed coordinate**; **Next**, **Next**.
- [ ] **Survey data**: fill in **Survey date**, pick a **DSM GeoTIFF** (or **Point cloud**), then **Pick orthomosaic**.
- [ ] **Add a second survey date**, give it a date and no surface: "Every survey needs a DSM or a point cloud." and **Create project** stays greyed out.
- [ ] The same date twice: "Two surveys have the same date."
- [ ] Pick the second surface. The summary reads "2 survey dates, built in Jobs after creating". **Create project**.
- [ ] **Jobs** opens with **Volumetric survey** running. Steps tick off: Read the surveys and set the grid, DSM of survey 1 and 2, Ortho tiles of survey 1 and 2, Detect piles, toe lines, bases and volumes, Package the kit grids, Terrain meshes, ortho pyramids and volumes, Write to the project. Then **Done**.
- [ ] **Scene**: the terrain with its photo texture and the **Volumes** register, as on Masafi. Switch dates and bases, click a pile.
- [ ] Quit Stratlas during a run and reopen: the job shows **Interrupted** with **Resume**; Resume carries on from the next step.

### P1 Inspection pipeline (merged)

Places detections (boxes on posed photos) on the model, groups them into issues, makes contact sheets and the stats for the report.

- [ ] Projects, **New project**: name, type **Inspection** (the default), origin, **Create project**. The project opens empty.
- [ ] **Import files**: drone photos with GPS and a GLB model. "Imported N of N files", then **Close**.
- [ ] **Jobs**, **New job**: **Pipeline** is already **Inspection: detections to issues**. **Start job**.
- [ ] Six steps: Read the project, Contact sheets, Read detections, Place detections on the model, Group into issues and stats, Write to the project. Then **Done**.
- [ ] With no detections yet, the log says "No detections yet. Review the contact sheets or run a detection pass ...". Contact sheets are in `<project>\inspection\contact\`.
- [ ] Put a detections file (aio.detections/1, kit, COCO or YOLO) in `<project>\detections\`, or name it in the **Detections** field, and run again.
- [ ] **Issues** lists the new issues, titled like "Crack, Tower body", pinned on the model where the boxes are; their photos are sightings.
- [ ] Issues you made before the run are unchanged.
- [ ] Run the job again: the same issues, nothing duplicated.
- [ ] **Unreviewed AI detections**: **Leave out until a person accepts them** (default) does not count AI drafts; the log says how many were left out.
- [ ] Optional, on a copy of HCl: new issues land on the tank with the HCl lining severities; the 13 existing issues stay.

### R1 Detections screen (merged)

Use the inspection project from P1 (accepting adds draft issues to the open project). EBSM is fine for looking and scrolling.

- [ ] Sidebar **Detections**: contact sheet, counts "0 waiting · 0 accepted · 0 rejected".
- [ ] **Photos shown**: **With detections** or **All photos**. With none yet: "No photos with detections yet. Show all photos, draw a box, or detect with AI."
- [ ] EBSM (299 photos): the sheet scrolls smoothly.
- [ ] Pick a photo. **Drawing tools**: **Box**, then **Polygon**: draw over a defect; reshape it with **Select**.
- [ ] Inspector: **Class** (**C**), **Severity** (**1** to **9**), **Uncertain (U)**, **Note (N)**.
- [ ] **Accept** with no class: "Pick a class before accepting (C)."
- [ ] **Accept** (**A** or **Enter**): "Accepted as issue <code>." **Open in Issues** shows it as a draft issue with this photo.
- [ ] **Link** (**L**): find an issue by code or title, add the box as a sighting of it.
- [ ] **Reject** (**X**) a proposal, then **Reopen** it.
- [ ] **J** and **K** step through detections ("2 of 5").
- [ ] **Ctrl+Z** and **Ctrl+Y** undo and redo review changes; the save state reads **Saved**.
- [ ] **Ctrl**+click selects several tiles; **Clear selection** empties it.
- [ ] Confidence slider hides proposals under "Confidence N% and up".
- [ ] **Outline** (**M**): without a mask model in the pipeline pack it says "No mask model is installed in the pipeline pack." (none ships yet).
- [ ] In a package opened in the player, the screen says **Read only**.

### R2 Detect with AI (merged)

Needs Cloud AI on and a key with a vision model (Settings, AI providers).

- [ ] **Ctrl**+click 2 to 4 tiles, then **Detect with AI (4 photos)**.
- [ ] **What to send**: the selected photos, the photo or frame in the editor, all photos without detections, or **Video frames** (pick a **Clip** and **One frame every** N **seconds**). **Images per request**. **What to look for (optional)**.
- [ ] **Estimate**: "4 images in one request, about ... tokens in and ... out: about $..." and "An estimate from list prices. The provider's invoice is authoritative."
- [ ] **What leaves this workstation**: thumbnails of exactly those images, "These images go to <provider>, each scaled to at most N px ...". Open **Instructions and request text** to read the full request.
- [ ] **Send 4 images**: "N of 4 images sent, N proposals"; **Stop** works; then **Done** with tokens and cost.
- [ ] **Review the results**: proposals are **Waiting**, with "Proposed by <model>, prompt <version>." and "Confidence N%". Nothing is in Issues until you accept it.
- [ ] A label the project does not know: "The model called it "...". Pick a class."
- [ ] Turn Cloud AI off: the dialog says Cloud AI is off and Send is greyed out.
- [ ] A wrong key: the provider's exact error, nothing added.
- [ ] **Settings, Usage and cost** includes the detection tokens for this project.

### P3 Road survey from raw data (merging now)

Steps written from the branch; labels may still move once merged. You need an orthomosaic GeoTIFF and defect polygons (GeoJSON, a shapefile or a road review `defects.js`).

- [ ] Projects, **New project**: type **Road**. The severity step preselects **Road distress (ASTM D6433)**. **Create project**.
- [ ] The project opens in **Road setup**: "This road survey has no road model yet ...".
- [ ] **Import files**: the orthomosaic. "Imported 1 of 1 files".
- [ ] **Draw centreline**: the stage switches to the map. Click along the road from km 0; **Backspace** removes the last point; the counter shows points and length. **Finish**: "Centreline saved as road/centreline-drawn.geojson."
- [ ] **Run the road builder**: Jobs opens with **Road survey** and the **Centreline** filled in. Fill **Orthomosaic GeoTIFF** and **Defect polygons**; choose **Sample units** (**Along the road** or **Square grid**) and **Unit length (m)**. **Start job**.
- [ ] **Done**; the log shows the network PCI.
- [ ] **Scene**: the road workspace as on 1st Ring Road: chainage ruler, "N of N defects", **P** for the PCI grid with its legend, click a defect row for its **Close-up**.

### X1 Packages and map packs (merging now)

Steps written from the branch; labels may still move once merged.

- [ ] HCl, **Reports**, **Export package**: switch on **Include the map region for this site**, set **Detail up to zoom** and **Margin**. A line reads "From Kuwait streets: N tiles, size" and the package size grows.
- [ ] Switch on **Allow the customer to extract an editable copy**. **Export**: "Package written."
- [ ] Open the `.aio`: **Start exploring**, press **2** for the map: streets draw. **Settings, Offline maps** lists the region as **In open package**.
- [ ] Best check: on a PC (or data folder) without the Kuwait pack, the map still draws from the package.
- [ ] **Reports**, **Edit a copy**, **Extract to edit**: progress, then a new project opens with the chip "Copy of <file>.aio" and no "Read-only package" chip.
- [ ] Annotate the copy (**A**, **Pin** on the tank): the issue is saved in the new project. The `.aio` file is unchanged.
- [ ] A package exported without the allow switch: "The sender did not allow editing this package ...".
- [ ] Resumable download (only if you agree to a download from build.protomaps.com): **Settings, Offline maps**, **Add a region**, a small country, start. Quit Stratlas mid-download.
- [ ] Reopen: the job shows **Interrupted**, "The download stopped at ... Resume continues from there ...". **Resume**: it finishes and the pack shows as downloaded.

### Coming in M6

- **R3 Narrative** (coming): AI-drafted executive summary, method and findings text from the project statistics; edited in place; versioned.
- **R4 House-format report** (coming): PDF report for any project type in the house format (cover, method, statistics, register, one page per issue, appendices) with your branding.
- **A1 Al-Zour orientation** (coming): per-clip pitch, roll and yaw calibration against the model, next to time offset and lens; removes the 8 degree pitch error.
- **End to end** (coming, the M6 exit): one project of each type (inspection, volumetric, road) built from raw data, reviewed, reported and packaged on your machine.

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
- Al-Zour clips sit about 8 degrees off in pitch against the model. The lens is fixed; orientation calibration is A1 (coming in M6).
- Al-Zour sea level (93.56 m) is marked indicative; adjust it in the sun popover if the waterline looks high. A few light surf patches near the west breakwater read as land and show as flat patches on the water.

### Viewer

- Issue labels hidden behind the building can lag the camera by about a tenth of a second while orbiting.
- At night the point cloud keeps its daylight colours and takes no shadows.
- With the right panel open on a 1440 px screen, the Labels and layers buttons move into the **More** menu.
- No Arabic translation yet; **Right to left** mirrors the panels only.

### Reports, packages and maps

- Report branding is one setting for all projects (no per-project override yet).
- Narrative text and the house-format report for any project type are not built yet (R3, R4).
- Until X1 is merged: packages cannot be edited, map packs are not included in packages, and a map pack download cannot resume a partial file.

### Builder

- The pipeline pack is not in the installer; it lives in `E:\Stratlas Data\runtime` and must match the build.
- **Outline** (mask assist) needs a mask model in the pipeline pack; none ships yet (licences).
- Cloud AI detection needs Cloud AI on and your own key; cost is an estimate from list prices.

### Release

- Unsigned build: SmartScreen warns on install. No automatic updates: install over the previous version. Store submission waits for M7.
- Old video files are kept in `projects\hcl\video.before-1080` and `projects\alzour\video.before-1080` (about 0.6 GB): delete them once you are happy with M5.
