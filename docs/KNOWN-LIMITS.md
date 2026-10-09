# Known limits

What Quadrion AI does not do yet, or does differently on purpose. Testing steps are in [TESTING.md](TESTING.md).

Current limits only; each is removed from this list when fixed.

## Data and positions

- HCl position on the map is approximate (the source has no survey position); flight start times are nominal, relative timing is exact.
- DAMAC origin height is approximate (no survey control in the source).
- Video calibration is one constant offset per clip (orientation, position, time, lens): no bias that changes along a clip. On Al-Zour, **Refine automatically** is weak (the edges rarely agree clearly on the plant); point pairs work.
- One take-off height per import batch: import flights that took off from different heights separately.
- Al-Zour sea level (93.56 m) is marked indicative; adjust it in the sun popover if the waterline looks high. A few light surf patches near the west breakwater read as land and show as flat patches on the water.
- Al-Zour clip DJI_0668 is 31.5 s long and DJI_0669 starts 60 s after it, so between them the video window shows "No footage at this time". That is correct.

## Viewer

- Issue labels hidden behind the building can lag the camera by about a tenth of a second while orbiting.
- At night the point cloud keeps its daylight colours and takes no shadows.
- Point size cannot go below 1 px, so shrinking has no visible effect where points are already 1 px (Al-Zour overview, HCl from far out). At the Al-Zour overview, larger points merge into a coarser mosaic rather than separate dots.
- **Compare dates**: measure, drawing, the AI agent, video and pile bodies work in the left (main) view only. On the **Low** graphics tier you get two maps or the swipe instead of two 3D views.
- With the right panel open on a 1440 px screen, the Labels and layers buttons move into the **More** menu.
- No Arabic translation yet; **Right to left** mirrors the panels only.
- Opening projects again and again from the project list grows the app's window process by about 4 MB per open for the first 80 or so opens, then by under 1 MB per open (one demo project: about 360 MB to 590 MB after 120 opens). The app's own memory, its 3D resources and its WebGL contexts stay flat; the growth is in Chromium's native memory (likely worker heaps or Blink caches) and is not traced further yet. Restarting the app frees it.

## Reports, packages and maps

- Report branding is one setting for all projects (no per-project override yet).
- Road project reports default to issue pages for all but the lowest level (a page per Ring Road defect would be over 2,000 pages); pick **Every graded issue** to print them all.
- The street map under the Masafi site is soft up close (one 5 km image at about 2.4 m per pixel).

## Builder

- The pipeline pack is not in the installer; it lives in `E:\Stratlas Data\runtime` (now `pipeline-pack-0.2.0`) and must match the build. The app uses the newest pack there.
- **Outline** (mask assist) needs a mask model file in the pipeline pack; none ships yet (licences).
- The HCl sample's GPS and gimbal tags are written from the delivered camera poses (the Elios 3 logs no GPS in the tank) around the approximate HCl origin; a real photo set brings its own tags.
- Cloud AI detection needs Cloud AI on and your own key; cost is an estimate from list prices.

## Release

- Unsigned build: SmartScreen warns on install. No automatic updates: install over the previous version. Store submission waits for M7.
- Old video files are kept in `projects\hcl\video.before-1080` and `projects\alzour\video.before-1080` (about 0.6 GB): delete them once you are happy with M5.

## Change, modelling and local AI (M8)

### Change between dates

- Change is found only where both dates have data; outside the overlap nothing is reported.
- Change on dates that are not registered is refused: more than 2 px (orthos, surfaces), 5 cm (point clouds) or a 5 cm height offset (surfaces) apart. Align the layers first; there is no setting in the app for a larger tolerance.
- The change thresholds are the defaults (`Settings.change`); there is no Settings page for them yet.
- Issues marked only on photos or frames (no 3D sighting) are not matched across dates, so they are never **Resolved** or **Grown**.
- An issue is **Resolved** only when photos of the later date cover its place; other later layers do not count, so it shows **Not seen**.
- **Make issue** is not offered on issue changes; **Confirm** links the two issues instead.
- Imagery change does not read PMTiles orthos, and very large orthos are compared on a coarser cell.
- Imagery change areas are always **Changed**: they are not split into added and removed.
- Surface change from COPC point clouds (through PDAL) is untested on real data.
- Surface change reports a height offset between the dates under 5 cm but does not correct it.
- A change heat map layer counts for both dates until it is given a survey date (**Belongs to date...**).
- Nearest-neighbour distance overstates change on sparse clouds, and between clouds of very different density.
- Surface change from a sparse point cloud (a few points per square metre) averages roof and wall points into ground cells at object edges: on the demo change site its volumes are up to a third off, against a few per cent from the height grids. Use a DSM when there is one.
- On sparse clouds, cloud change misses small low changes (the demo's new excavation) and reports small extra regions where the later survey sees faces the earlier one did not.
- Detections count per place on the ground only on posed photos and assume flat ground at the project origin height; on sloping sites one thing may count as two places.
- A model part counts as changed when 1 m2 of its surface, or 1% of it, deviates by more than the threshold (5 cm); the 1 m2 rule is a working default.
- A horizontal shift on flat ground is invisible to cloud change: the points still lie on the same plane.
- A moved object shows as two cloud change regions (new where it is, gone where it was), not as one move.
- The cloud registration check reads only a 40 m square at the centre of the overlap.
- Model change samples 50,000 points of each model; on large models it is slow.
- The cloud change distance under the pointer shows in the main 3D view only.
- The Frames pane assumes flat ground: **Line up the ground** does not line up tall objects.
- Video frames are not compared by **Find changes in matched frames** (`change.frames`): photos only.
- While a clip plays, the Frames pane shows still frames of the other date, not a second video.
- The video of the demo change site is small (384 x 216 pixels, 2 frames per second).

### Models from drawings and point clouds

- DXF only: no DWG. Save DWG drawings as DXF first.
- Parts are edited by numbers only: no drag handles, no overlay of the fit residual on the cloud.
- Straight pipes only; tank roofs are flat or cone.
- Arcs in DXF polylines (bulges) are drawn straight, and block arrays bring in only their first copy.
- Built models are not checked with a glTF validator.
- Fitting parts to point clouds is untested on real scans.

### Local detection

- onnxruntime-node ships a macOS binary for Apple silicon (darwin arm64) only, so Intel Macs have no local detection.
- Local detection checks photos only, not video frames.
- The licence box is ticked before the model card is shown.
- The memory the model runtime uses is not capped.

### Local AI agent

- Local model quality and speed depend on the person's hardware; without a graphics card an answer can take tens of seconds.
- Vision support of a local model is guessed from its name.
- Token counts for local models are estimates (characters divided by 4).
- Ollama may serve a smaller context window than the model's maximum; pick **Compact** for small contexts.
- Tested against a simulated server only; real Ollama, LM Studio and llama.cpp servers are not yet tested.

## Team, history and sync (M9)

### History and audit

- History shows only inside **Edit issue** on the issue card; packages opened in the player show no History, and change items, detections and model parts have no History tab yet (their changes are in the **Audit trail**).
- **Restore** in History puts back issue fields only, and the entry it writes reads "Edit F01" rather than "Restore".
- Edits made outside the app (an older build, a hand edit in Notepad) are found at the next write of that file or the next open of the project, not the moment they happen.
- The journal cache (userData `journal-cache/`) keeps a snapshot of every journaled file, so those JSON files take about twice their size on disk.
- When the credential store (Windows Credential Manager, macOS Keychain) cannot be used, changes are recorded without a signature. **Verify** says so, and in a shared project the other copies hold those changes in quarantine until an owner applies them anyway.
- Signed checkpoints are written every 500 changes and at each audit export, not yet at every sync or exchange file.
- Fork detection is proven on the golden fixtures only; a copied folder that kept writing in an unusual way may be reported as a gap or an order problem rather than a fork.
- The history of a private project cannot be switched off from the app yet (`journal:setEnabled` exists, with no button).
- Notes saved in the four legacy viewers (through their own storage shim) are not journaled.
- Customer packages do not yet carry the signed audit summary, and the package export has no **Include full history** choice (`PackageHeader.journal` is in the contract only). Packages carry no member list.

### Identity and members

- The Credential Manager entry of the device key is named after the app id (service `ai.synapse-solutions.stratlas...`, account `device-signing`), not "Quadrion AI device key" (the app id still ends in `stratlas`, so entries made before the rename keep working).
- Identities are self-asserted by default ("Unverified"); an owner certifies a card after checking it with the person. There are no accounts until M10.
- One device key per profile and computer: a lost computer means revoking its device and adding the person's new one. History before the revocation stays valid.

### Review workflow

- The review area (assign, comments, approvals) is inside **Edit issue** on the issue card, and on change items in the Changes panel. Detections, model parts and the register have no review columns yet, and there are no bulk approvals.
- Approvals need a shared project; a private project keeps the status buttons as in 0.8.
- A local edit that makes an approval out of date returns the issue to **Reviewed** while the issue is open in **Edit issue**; after a merge the status is set from the approvals at once.
- The status after a merge is not checked again against the order of statuses (`canTransition`).
- No email or push notifications: **My work** is in the app only.
- No real-time co-editing: people see each other's changes after a sync, not as they type.

### Merging and conflicts

- Roles in exchange-file and shared-folder mode are tamper-evident, not enforced: a change beyond a person's role is held in quarantine on every other copy, but anyone with write access to the folder can still edit its files (seen as "Changed outside Quadrion AI" in History). Only the team server enforces roles.
- Detections without ids (passes made before M9) merge per pass: the last writer of the whole pass wins.
- Manifest entries (layers, captures) are merged in the history but not yet written back to `manifest.json`.
- Two issues made from one change item on two copies are not offered for merging; merge them by hand in the issue register.
- The merge runs in the main process, not in the data process or a worker; 10,000 incoming changes on a 5,000-issue project take about a second.

### Exchange files and shared folders

- Exchange files are limited to 2 GB (store-mode ZIP, no ZIP64). Send changes only and move large files through a shared folder or a USB copy of the project.
- **Export changes** offers all changes or changes since a date (from midnight on this computer); there is no "since what I last sent to this person" choice yet. The other copy skips what it already has.
- Encryption is by passphrase only (scrypt, AES-256-GCM); encryption to the recipients' keys comes after 1.0. Hashing and scrypt run in the main process.
- Reply files from the free player (client comments and acceptance from a customer package) are not written yet.
- Cloud-drive folders (OneDrive, Dropbox) as a hub: files the client keeps online only (files on demand) delay reads until they are downloaded; a read slower than 20 seconds counts as "Folder offline" and the next sync tries again.
- Automatic sync runs every 15 minutes and when the window gets focus; it does not run right after each save, and the interval has no Settings page yet.
- The library shows no team badge (mode, unread, conflicts) on a shared project.
- Compare-before-write is a check, then a rename: a save that lands between the two can still be replaced, there is no lease file, and the edit refused with "... was changed by someone else since you opened it" is lost when you click **Reload**.
- `.aio` packages keep their existing encryption (WinZip AES, PBKDF2-SHA1 with 1,000 rounds); exchange files use scrypt.

### Large files

- Hashing of project files runs in the main process (paced to 100 MB/s), not in a worker; indexing a 20 GB folder during playback has not been measured yet.
- The download cache cap (50 GB by default) has no Settings page, and there is no **Free space** button yet.
- Potree 2 clouds and kit image pyramids register only their entry file.
- A layer whose file is not on this computer can still log "could not be loaded" in the developer console; the layer itself shows the "Not on this computer" card.

### Team server (preview)

- A preview: not covered by the 1.0 support policy, and no external security test yet.
- No S3-compatible blob store (files stay on the server's disk), no web interface (command line only), one server process per database.
- The Postgres store is tested in CI only, not run on the development workstation.
- Files are not kept apart per project on the server, and clients cannot download shared packages from it yet.
- The app shows no live server status. Connecting needs the credential store: without it this computer has no device key.
- A server certificate renewed by a CA the computer trusts is not accepted on its own yet: forget the server and connect again with a new invite code.

## Photogrammetry, Globe and 3D Tiles (M10)

### Processing photos

- Processing runs on the CPU only (no GPU acceleration in this release), so dense matching is slower than GPU products. Windows x64 and Apple silicon Macs only; Intel Macs and Windows on Arm cannot process photos.
- The photo pipelines need pipeline pack 0.4.0, which carries prebuilt COLMAP (pycolmap), OpenCV and MeshLab wheels from PyPI and conda-forge's PDAL. The macOS packs (PDAL's copy step and the Apple silicon wheels) are proven in CI only.
- The pipeline pack contains GPL components (CHOLMOD and SPQR in pycolmap, MeshLab, OpenCV's FFmpeg build on macOS): a distributed pack is under the GNU GPL version 3, and whoever receives it may ask for its source, our pipeline code included (founder decision of 8 Oct 2026). The app and the Team Server are not affected.
- The mesh's screened Poisson runs at a depth that fits the memory budget (about 10 KB per mesh vertex, measured: depth 11 on the synthetic mini flight needed 20 GB); on a 16 GB laptop meshes of large sites are coarser than the preset's depth.
- Large flights need memory: aligning about 1,000 photos with the global mapper peaked at about 13 GB. Plan on 300 photos per run on a 16 GB laptop.
- Matching uses the photos' GPS positions; photos without GPS can only be matched exhaustively in small sets (no vocabulary tree).
- Heights from the drone's GNSS follow its altitude datum unless a geoid grid is installed (no EGM2008 or EGM96 grid ships yet); use ground control for absolute heights.
- No automatic target detection: every ground control mark is placed or confirmed by a person. The marker's own predictions use a pinhole lens without distortion (a few pixels off); the predictions the alignment writes take precedence.
- TIFF photos in folder runs cannot be shown in the marker (JPEG and PNG can).
- The real alignment pipeline runs wherever `uv sync` ran, and CI's pipelines job runs it on the synthetic sets; the photo e2e specs keep their stand-in pipelines. The real-engine e2e (`photo-real.spec.ts`) is opt-in (`QUADRION_E2E_PHOTO_REAL=1`): with the real alignment the marker predicts one ground control point in two photos, not the three its script confirms.
- Without ground control, a small block of nadir photos at one height can carry a uniform height bias of about a metre (focal length and height trade off); add ground control or oblique photos.
- **Processing accuracy report (PDF)** shows in the Exports menu of every project; without a processed run it answers with a message instead of a file.
- The bundled photo demo is a small 13-photo block: only three of its nine surveyed points are in enough photos to mark, and it has no oblique photos.
- Fisheye and spherical cameras are not supported; oblique close-range sets are untested.
- Texturing drapes the orthophoto or projects one photo per face: there is no seam-levelled texturing (`texrecon` is deferred). The Fast preset is weak on buildings and has no true-ortho on tall structures.
- No LiDAR processing from raw scans.

### OPF

- Import reads cameras, calibration, control points, the sparse cloud and products, but no meshes. Uncalibrated photos bring their positions only.
- Export writes the sparse model, not the dense cloud. Tested against the specification's examples and our own exports, not yet against Pix4D itself.
- Vertical CRS heights are taken as they are, without conversion.

### Globe

- The Globe is for overview and navigation: no editing tools, only a distance and area read-out on the ellipsoid.
- No geoid grid ships, so terrain heights on the Globe are not corrected to the geoid.
- Processed orthophotos do not show on the Globe yet, sites have no footprints and there is no date filter.
- The agent's **show_on_globe** ends the agent's reply: the agent panel belongs to the project view and closes when the Globe opens. The Globe tools are not in the compact tool profile.

### Imagery, terrain and 3D Tiles

- No world imagery or terrain ships in the installer and there are no pack downloads yet: imagery and terrain come from packs you build or import.
- The bundled region imagery is 10 m (Sentinel-2 class), not sub-metre, unless you import your own.
- Customer-licensed imagery stays out of packages; ticking it into a package is not built yet.
- 3D Tiles are written as uncompressed glTF (no Draco, KTX2 or Meshopt), and are not checked by the official validator.
- Converting a point cloud to 3D Tiles holds the whole cloud in memory; compressed COPC input needs PDAL.
- A tileset has no visibility toggle in the layer list, and an issue placed on a tileset may not resolve after the project is reopened.
- An imported tileset in a local frame (or placed only by a region bounding volume) stays hidden: placing it on the map is not built yet. Imported tilesets are not recorded in the project history.
- The Globe has its own copy of the Terrarium height decode (about 40 lines) rather than sharing the site view's.

## Surveying (M11)

### Coordinates, geoids and calibration

- The global EGM96 and EGM2008 geoid grids are not bundled in pipeline pack 0.5.0 yet. Until they are, orthometric heights need a geoid pack; a height that needs a missing grid is refused with the pack's name ("Showing heights on this site needs the ... geoid pack, which is not installed."), never shown on the ellipsoid and never downloaded.
- Regional geoid grids (AUSGeoid2020, GEOID18, OSGM15 with OSTN15, NZGeoid2016, CGG2013a) come only as optional geoid packs, built from PROJ-data files with `tools/maps/geoid-packs.mjs`. Settings has no page to import, list or remove geoid packs yet; the **Heights** list shows what is installed.
- Calibrations are imported from Trimble JobXML (`.jxl`) and from 12d parameters typed into a small key and value text file. Trimble `.dc` is refused (no public specification of its records); Trimble `.cal` is not read (closed). **Compute from point pairs** runs in the pipeline, but the app has no screen for entering pairs yet.
- JobXML sign conventions (rotation, and which coordinates the inclined plane uses) are checked against synthetic files only; the importer keeps the reading that reproduces the file's own residuals. Check it against a real controller job (TESTING, stage M11).
- A design cannot be given its own CRS in the app yet (neither the Designs panel nor **Jobs**, **Import design** asks for one): it is placed in the project CRS, the CRS the file states, or through the site calibration.
- Contour intervals, overlay ranges and station fields are typed in metres whatever the site's units.

### Formats and interop

- No DWG, IFC, TTM or Trimble machine-control files (`.vcl`, `.dsz`, `.svd`, `.svl`): none has a public specification or an agreement with the vendor (M11 decisions 1 and 2). Save DWG as ASCII DXF. The path to machine control is LandXML (or DXF) into Trimble Business Center, which writes the machine files.
- 12da is read and written from 12d's public description of the format ("12d A File Format"); it is tested against our own files, not yet against files from 12d Model itself.
- Alignments: horizontal geometry (lines, arcs, clothoid spirals) with station equations is read and written; vertical alignments (profiles) are not.
- The Designs panel's **Import design** has no options: a DXF without drawing units is refused there, and the units, format and calibration placement are set in **Jobs**, **New job**, **Import design**.

### Volumes, designs and views

- The stockpile kit's `tin` base (a smooth membrane over the toe) differs from the survey engine's `smart` base (a triangulation of the toe line), so the two give different figures. The kit's four bases and their numbers are unchanged; the engine's bases are offered as extra choices under **More bases (survey engine)**, and the register and totals keep the kit's bases. Which one the kit should show is a founder decision still open.
- Terrain overlays (contours, gradient, elevation, shaded relief) draw on the 2D map only, not in the 3D view. Design surfaces and linework are not drawn in either view: they show in sections, snapping, the station readout, comparisons and exports.
- The **Compliance to design** buttons (**Cut/Fill to design**, **Remaining to design**) only point to the comparisons ("Open Volumes and comparisons to compute it."); set up the design comparison in a polygon's **Comparisons**. The share of the area within tolerance is in the survey report, not in the panel.
- Hydrology results show on the 2D map only.
- Packages (player mode) do not show survey measurements, sections or terrain overlays yet; the QA hold banner, saved hydrology runs and haul-road results show read-only.
- The DTM filter presets for point clouds (equipment, vegetation, structures) run in the pipeline but have no button in the app yet.
- The local AI helpers (M11 G12: **Suggest boundaries** and the AI cut and fill breakdown) are not built; they wait for the founder's go-ahead. **Whole site cut and fill** suggests rule-based regions as drafts.

### Hydrology and haul road

- Direct rainfall is a simplified model: a local-inertial 2D solver on a regular grid (2, 1 or 0.5 m) with one Manning's n and one constant infiltration rate for the whole area; no pipes, culverts or buildings.
- Hydrology runs refuse areas above their cell limits: flood to level 25 million cells, runoff and catchment 4 million, direct rainfall 4 million. The refusal asks for a region, but the app has no control to draw one yet, so a larger site has to be run on a coarser surface.
- Hydrology is checked against analytic truths (a bowl, a V-shaped catchment, a tilted plane); WhiteboxTools is not used as a second opinion.
- A haul-road centreline is a design alignment, a design polyline or a drawn line; proposing one from the surface is not built.
