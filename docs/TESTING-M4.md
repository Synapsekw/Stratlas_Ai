# Testing Stratlas M4: Release A complete, Release B started

Build: `E:\Dev\AIO Software\apps\desktop\dist\Stratlas-0.1.0-win-x64-setup.exe` (or `...-portable.exe`). Unsigned: SmartScreen, **More info**, **Run anyway**. Install over the previous version. Data: `E:\Stratlas Data`.

Everything from `TESTING-M3.md` still applies. Below is only what is new. Tick each line or note what you saw (screenshot plus the time on the timeline).

## Native workspaces

### Masafi: volumes (new)

- [ ] Open Masafi: the terrain now shows its **photo texture**.
- [ ] Right panel **Volumes**: register of 19 piles with fill, cut, net and change; switch the date (31 Dec / 10 Jan) and the base (Triangulated toe, Best-fit plane, Average toe, Lowest toe).
- [ ] Click P02: red volume body, base plate, toe line; detail shows 11,379 m³ (10 Jan, triangulated toe), tonnage, footprint, height.
- [ ] **Swipe** between the two dates; **cut and fill** colours.
- [ ] **Section** tool: draw a line across a pile, profile chart of both dates.
- [ ] **Edit boundary**: drag a toe point, the volume recomputes; Save; reopen the project: the edit is kept.
- [ ] Export the register as CSV.

### 1st Ring Road: road mode (new)

- [ ] Opens map first, with the **chainage ruler** at the bottom (0 to 7.55 km, 250 m bars by severity, PCI strip). Click a bar to jump; drag to filter.
- [ ] Zoom in: defects as **polygons** on the 3.25 cm ortho, coloured by stage or type.
- [ ] **PCI grid** with Low / Medium / High; click a sample unit for its deducts.
- [ ] Density heat map; filters by stage, type, chainage; search a defect code.
- [ ] Open a defect: close-up with outline, previous / next.

## Issues at scale (new)

- [ ] DAMAC 3D: issues show as **count badges** coloured by worst severity; click a badge to fly in; codes appear on hover.
- [ ] Layers popover: Pins **All / Severity N and above / Off**; heat map option.
- [ ] Issues screen on Ring Road (2,115): instant search, group by severity / class / zone, bulk set status with undo.
- [ ] Imported EBSM and DAMAC findings show as **Reviewed**; uncertain ones as Draft.

## Reports and exports (new)

- [ ] **Reports**: open the EBSM report (88 pages) and the DAMAC report (206 pages) inside the app: thumbnails, zoom, search.
- [ ] **Issues, Export**: CSV, GeoJSON, COCO, kit JSON, masks ZIP; each asks where to save and shows progress; the app stays responsive.
- [ ] **3D snapshot** PNG with legend.
- [ ] **Issue register PDF**: cover, charts, register, one page per issue with photo crop and 3D view (try HCl first: small).

## Customer packages (new)

- [ ] Export HCl as a **package** (`.aio`), optionally with a passphrase; leave out the point clouds to keep it small.
- [ ] Double-click the `.aio` file (or Projects, Add): it opens in **read-only player mode**: welcome screen, "Read-only package" chip, no annotation tools, cloud AI off.

## AI (new; needs Cloud AI on and your key)

- [ ] First message in a project shows a **preview** of exactly what will be sent; "Always allow for this project".
- [ ] Conversation **history**: close and reopen the project, resume the conversation; export it as Markdown.
- [ ] A write action (e.g. "draft an issue for the roof nozzle") waits for **Approve**; restart the app: it is still waiting.
- [ ] **Settings, Usage and cost**: tokens and estimated cost per project.
- [ ] New tools: "compare the two Masafi surveys", "how many issues by zone", "find issues within 10 m of N5", "open the original review".

## Platform (new)

- [ ] **Settings, Appearance**: Dark / **Light** / System; check every screen in light.
- [ ] **Settings, Offline maps**: world coverage map of installed packs; add a region (country or drawn box) **only if you want a download** (it fetches from build.protomaps.com); import a `.pmtiles` file; remove a pack.
- [ ] **Settings, Graphics quality**: detected tier (this PC: Ultra); try High or Medium.
- [ ] **Settings, About**: version, folders, licences, export logs.
- [ ] Ctrl+Shift+F: performance overlay (fps, frame times, points, GPU memory).

## Full-resolution Al-Zour point cloud (new)

- [ ] Al-Zour, Point clouds: **Al-Zour full resolution (COPC, 841.7 M points)** is on; fly close to a tank or pipe rack: detail streams in (individual pipes, stairs).
- [ ] Colour by RGB / Elevation / **Classification** (legend with classes you can hide).
- [ ] Expect about 55 to 60 fps on this PC; occasional short hitches while new detail loads.

## Building projects (Release B, new)

- [ ] Projects, **New project**: name, customer, type, coordinate system (UTM zone search), origin (map click or typed), severity template, brand. The project opens empty.
- [ ] Drag in a few **drone photos** with GPS: they appear as posed cameras.
- [ ] Drag in a **DJI video with its .SRT**: a clip with its flight path appears and plays in sync.
- [ ] Drag in a **GLB**, then **Georeference** it by clicking 3 point pairs; residuals show.
- [ ] Drag in a small **LAS/LAZ**: a **Jobs** entry converts it (progress, log); the cloud appears when done.
- [ ] Al-Zour, play a clip, **Calibrate video**: time offset and field of view; the lens was corrected (72.2 and 65.6 degrees): projected video should double less on tank rims.

## Known limits in M4

- Al-Zour clips still sit about 8 degrees off in pitch against the model (lens fixed; orientation calibration is the next step).
- Al-Zour full-resolution cloud: about 1 % of frames hitch while streaming (up to a few hundred ms on the first fly-through).
- Map pack download cannot resume a partial file (restarts that region).
- Packages cannot be edited (no "extract to edit" yet); map packs are not included in packages.
- Unsigned build. Store submission deferred until the app is ready.
