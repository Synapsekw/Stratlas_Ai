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
- **Compare dates**: both sides show the surface colours, pile bodies, toe lines, legends and saved survey measurements of their own date. Measuring, drawing, editing a pile boundary, picking a section line, the swipe, the AI agent and video still work in the left (main) view only, and designs, the haul road and terrain overlays are drawn there only. If the graphics memory of the tier cannot hold the surface colours for the right view, that view keeps the photo and says so. On the **Low** graphics tier you get two maps or the swipe instead of two 3D views.
- **Split** with the 3D view beside the map: the map has no elevation or cut and fill colours of its own. It shows them only as a terrain overlay you computed (**Survey measurements**, **Terrain overlays**).
- With the right panel open on a 1440 px screen, the Labels and layers buttons move into the **More** menu.
- No Arabic translation yet; **Right to left** mirrors the panels only.
- Opening projects again and again from the project list grows the app's window process by about 4 MB per open for the first 80 or so opens, then by under 1 MB per open (one demo project: about 360 MB to 590 MB after 120 opens). The app's own memory, its 3D resources and its WebGL contexts stay flat; the growth is in Chromium's native memory (likely worker heaps or Blink caches) and is not traced further yet. Restarting the app frees it.
- The 3D view prepares the shaders of a new 3D Tiles tile, and of the view with the section or the cutaway switched on or off, before drawing them, so the view does not freeze. The tile, or the cut, therefore appears a moment later: a few frames with a graphics card; on a computer without one (software rendering) the picture can hold still for up to a few seconds while the rest of the window keeps responding. Opening a project and showing a layer for the first time still prepare their shaders while drawing: without a graphics card the whole window can stop responding for a moment then.

## Reports, packages and maps

- Report branding is one setting for all projects (no per-project override yet).
- Road project reports default to issue pages for all but the lowest level (a page per Ring Road defect would be over 2,000 pages); pick **Every graded issue** to print them all.
- The street map under a site in 3D is flat: it lies just under the lowest model and does not follow the terrain (turn on **Terrain around the site** for a landscape that does). It is drawn as up to three nested pictures, so street names can be cut where two of them meet, and far from the site it is coarser.

## Builder

- The pipeline pack is not in the installer and updating the app does not update it: it is installed from its file (`pipeline-pack-<version>-<arch>.tar.gz`) in **Settings**, **Processing tools**, into `runtime` in the data folder, and must match the build. The app uses the newest pack there. The pack is not signed: the install checks every file against the checksums in the pack's own manifest, which catches a damaged file, not a forged one.
- **Outline** (mask assist) on a photo detection uses the pipeline pack's boundary model (MobileSAM, pack 0.5.1 or later); with an older pack the button does not show.
- The HCl sample's GPS and gimbal tags are written from the delivered camera poses (the Elios 3 logs no GPS in the tank) around the approximate HCl origin; a real photo set brings its own tags.
- Cloud AI detection needs Cloud AI on and your own key; cost is an estimate from list prices.
- **A large GeoTIFF cannot be imported yet.** An ortho or DSM over 300 MB, over 12,000 x 12,000 pixels, or saved as a BigTIFF is refused with "This GeoTIFF is too large to import yet"; no tiling job exists for it. Reduce or split it in other software and import the parts. A smaller GeoTIFF is read whole and drawn as one picture of at most 4096 px on its long side.
- **360 video and ffmpeg.** A 360 camera file (`.insv`, `.lrv`) is stitched by ffmpeg. The pipeline pack brings its own (pack 0.6.0 and later) and the app uses it first; with an older pack or none, ffmpeg has to be on the PATH (on Windows `winget install Gyan.FFmpeg`, then restart the app) with the `v360` filter (ffmpeg 4.3 or later, a full build). Without either the import says so and adds nothing. A stitched H.264 MP4 up to 3840 wide is added without ffmpeg.
- **360 video: cameras.** Verified on Insta360 X4 files (one `.insv` with a video track per lens, and its `.lrv`). The X3 and X5 are expected to write the same layout, but no file of theirs has been tested. Clips that a camera splits over two files (X2 and older), GoPro Max `.360` and Ricoh Theta raw files are skipped with a message: export a stitched MP4 and use **Add 360 video**.
- **360 walks: a walk not processed yet is placed between its pins.** Until **Process walk** (`walk.process`) has worked out the camera's path from the video, a walk is placed straight between its pins in time, and after Save its row reads **Path not computed**. Chapter files of one long recording import as separate videos.
- **360 walks: where a walk is placed.** A walk is placed on a drawing or on the map (with a coordinate system). The 3D view is not a **Place on** surface yet. Pins show only for the walk being placed; other placed walks show their path and stills, fainter.
- **360 walks: map pins cannot be dragged.** On a drawing a pin is dragged to move it; on the map, remove the pin with its cross in the strip and pin again.
- **360 walks are not on the project clock.** The 360 video plays on its own: the timeline, the other video pane and the position on the map do not follow it, and there is no compare of two walks yet.
- **Drone panoramas: stitching needs pipeline pack 0.7.0.** Spheres of a drone's own panorama mode are stitched by the processing tools; with an older pack the frames wait and **Stitch** says why. The GPU add-on for the stitch needs its 0.1.1 build next to pack 0.7.0; an older add-on is not used and the stitch runs on the processor.
- **Drone panoramas: no overlays yet.** Drawings, measurements, annotations and issues are not drawn on a panorama in this version.
- **Drone panoramas: placement is 1 to 3 m.** Without RTK a sphere sits where the drone's GPS says, so it can be off by 1 to 3 m on the map and against the 3D view.
- **Drone panoramas: sky above the top row is filled.** A sphere that does not reach straight up has the missing sky filled in, not photographed.
- **Drone panoramas: 16K needs a capable graphics card.** **High (16K)** is offered only where the graphics card can hold it; elsewhere **Standard (8K)** is used.
- **Drone panoramas: waiting stitches are lost on quit.** A panorama that is waiting to stitch when the app closes stays **Not stitched yet**; click **Stitch** on its row to start it again.
- **Drone panoramas: stitching again from a row is Standard.** **Stitch** on a row always makes a Standard (8K) panorama, whatever quality the import chose.
- **360 walks: a walk removed elsewhere can come back once.** A removed walk stays removed because its folder holds a `.layer` marker, and that marker does not sync. A computer that only received the walk by sync, and sees it removed on another copy before it opens the project, can make it a layer again once.
- **360 walks: a walk put back from `.trash/` by hand stays hidden.** Its folder still holds the `.layer` marker, so the app does not make it a layer again.
- **360 video: stitch.** The import's own playback copy takes the lenses as 195 degrees each, so faint seams show at the quarter lines, and it is not levelled. **Process walk** (`walk.process`, started by itself after the import when the pipeline pack offers it) writes a second copy stitched with the camera's own calibration and levelled from its gyro data; the pane plays that one while **Level horizon** is on. A walk cannot be renamed from the app yet.
- **360 video: processing.** `walk.process` is checked on a synthetic walk and on one Insta360 X4 walk of 82 seconds. Levelling removes pitch and roll only; the picture turns with the walker. In long, gentle turns the horizon can lean by up to about 3 degrees: the gyro and the accelerometer are blended so that the push of a turn is not taken for a tilt, and a slow turn sits between the two. It is won back at the next stop. A clip without the camera's motion data (a stitched MP4, or processing without the original) gets no levelled copy. On a laptop CPU decoding the two HEVC lens streams is the slowest part (about 4 to 5 minutes for the frames of an 82 second walk); whether a 15 minute walk stays within the 30 minute target is not measured yet. Under 60 % of the stills finding their place, or a walk under about 10 seconds, gives a path from pins only. Loops are not closed: a long walk that returns to its start may not meet itself.
- **Cancelling an import.** **Cancel** in the import panel stops the import as a whole, not one file. A 360 video being stitched stops at once and nothing of it is kept; a photo, drone clip or model that is in hand is finished first; files whose turn had not come are listed as skipped; what was already imported stays. A drawing whose pages had not been drawn yet is not added. A conversion already handed to the processing tools is cancelled in **Processing**, not here. Photos and models of an import that also holds a 360 video are saved before the stitch starts but show only when the import has ended. If the `ffmpeg` on the PATH is a package manager's shim and not the program itself, Cancel may only take effect when the stitch ends; the install the guide names (`winget install Gyan.FFmpeg`) is not a shim. While an import runs, a second import is not started and no message says so: wait for the first or cancel it.
- **360 video is not synced.** A walk travels inside a package, but its folder (the video, its stills, path and pose) does not reach team mates through a shared folder or the Team Server (hubs) yet.
- **Processing history stays on the computer.** The **Processing** drawer lists what this computer ran for a project's folder. A project that is moved or opened on another computer starts with an empty list. Its maps, runs and reports are unaffected.
- **A processing job files its results outside the app's turn taking.** A job that adds its results to the project (a converted point cloud, a DXF plan, an OPF project, maps from photos, among others) writes the project from its own process, outside the turn taking of the app's own saves. A change saved while a job is filing its results can replace them, or be replaced by them. For a point cloud or a plan the filing is an instant. For an OPF project and for maps from photos it lasts as long as their files take to move into the project, and whatever is saved in that time is replaced when the job writes. That includes the save at the end of an import: everything that import added to the project (photos, models, survey dates) is then missing from it, although the files are on disk. If a change or a layer is missing afterwards, make the change again, or import the files again. The project as it was just before the last save is in `manifest.json.bak` until the next save. History (the **Audit trail**) shows which job changed the project.
- **Deleting datasets and runs.** **Delete…** on a dataset, a group, a survey date or marked rows, and **Delete run** in Processing, move the files to the project trash (`.trash` in the project folder) with everything made from them; they are deleted for good after seven days or with **Empty project trash**. There is no Restore in the app yet: within the seven days, copy the entry's folders back into the project folder and replace `manifest.json` with the entry's `manifest.before.json` (data-conventions section 33).
- **Deleting on a shared project.** Other computers of a hub or Team Server receive a deletion as a change to the project only; their copies of the files stay until a later version cleans them up.
- **A deletion that could not be put back leaves a `held-` folder.** When a deletion fails and some of its files cannot be moved back (a file held open), they stay in a `.trash/held-...` folder, listed in its `removed.json`, and the message names it. The app never deletes such a folder, nor counts it in the trash size: move its files back into the project folder by hand, then delete it.
- Single photos cannot be removed from a photos layer; delete the layer and import the photos you want again.

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
- A layer a pipeline job writes (maps from photos, a converted point cloud, a DXF plan, the pages of a PDF, SVG or WebP drawing and the like) is not dated when it arrives: give it a date with **Belongs to date...**.
- Files of several days in one import all go under one survey date, the day most of them carry. Import them in separate batches to get one date per day.
- When two windows import flights of the same day at the same moment, both pick the same photos layer id, so the second flight's photos join the first flight's layer. Nothing is lost, but the two flights' photos cannot be re-dated separately in the import card.
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

### Drawings

- Drawings come in as PDF, PNG, JPEG, WebP, SVG, TIFF and DXF. No DWG and no IFC: both need a converter from another company. Save a DWG as DXF or PDF, or as a PNG picture.
- A PDF, a picture or a scan is a picture of the drawing: it has no line work to snap to and no parts for the model builder. Only DXF drawings have those.
- A picture drawing has no position until you place it, so it starts hidden in the 3D view and on the map and marked "not placed". It opens side by side straight away.
- PDF pages keep their white paper. Over the site, use the opacity slider to see through it.
- A PDF with several pages asks which pages to bring in and proposes the first one. One import takes at most 20 pages; import the file again for more.
- Pictures above 8192 pixels on the long side are scaled down to it. A picture above 144 megapixels or 300 MB is refused, as a plain raster import refuses it, and so is a picture whose size cannot be read from its file; save it again, smaller, first. A PDF page too detailed to hand over at full size is drawn at 70, 50 or 35 percent, and refused with a message when even that is too heavy.
- A site point for placing comes from a click in the 3D view, a click on the small map in the place strip, or a typed coordinate. Clicking the main map does not work for it.
- Side by side, the drawing pans and zooms by itself: it does not follow the 3D view or the map.
- Opacity and **On top in 3D** are remembered on this computer per project. They do not travel with the project or a package.
- Until you move the opacity slider, a drawing is solid in the 3D view and at 75 percent on the map; after that one value applies to both.
- **A PNG used as a model's texture is not a drawing.** A PNG picked together with an OBJ model that uses it as a texture is left out of Drawings for that reason.
- Drawings do not show on the Globe. On the map a drawing always lies over the orthos; among themselves drawings lie in the order they were first shown, and that order cannot be changed.
- **On top in 3D** draws a drawing over models, point clouds and the ground imagery. The selection highlight, outlines, camera symbols, measurement lines and labels still draw over it.
- A drawing that is hidden is not loaded: its picture is fetched the first time it is shown in the 3D view or on the map, so it appears a moment after its eye is clicked.
- Importing the same picture or PDF again adds a second drawing; importing a DXF again replaces it. A DXF with the name of a picture drawing comes in under the next free name (`site-2`) through **Add data**; the model builder refuses it and asks for another file name.
- Closing the app while the pages of a PDF are being drawn leaves the copy of the PDF in the project folder under `drawings/`, without a drawing. Cancelling the page question, or a file that cannot be drawn, leaves nothing.
- A phone photo brought in as a drawing ignores the rotation its camera recorded, so it can come in on its side.

### Models from drawings and point clouds

- Parts come from DXF drawings only. A DWG has to be saved as DXF first; a PDF or a picture is a drawing to look at and place, without parts.
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
- A model server on this computer (`localhost`, a `127.` address or `::1`) is trusted as local, also on an offline-only workstation. The app does not check what that server does with a request: one that forwards to another machine sends the data there.
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
- No automatic target detection: every ground control mark is placed or confirmed by a person. The marker's own predictions use a pinhole lens without distortion (a few pixels off).
- Before ground control adjusts a run, its cameras follow the drone's GNSS: without RTK they sit tens of metres off the survey's height datum. The marker therefore places a point by its own marks once it has two (the ring is then on the target), and before that by the marks of the other points or, with no mark at all, by the model's ground level under the photos that look down: a search ring of 80 pixels, with the target usually inside it but not at its centre. A site whose ground control is far above or below most of the ground in the photos gets poorer first rings.
- Predictions that `photo.align` itself writes into `gcp.json` (only when the ground control was imported while the alignment was still running) take precedence until a point has two marks. They are placed on the model's own ground, so every photo that sees a point is offered; with a flight without RTK the ring is wide, and the target sits beside its centre by the flight's GNSS error.
- TIFF photos in folder runs cannot be shown in the marker (JPEG and PNG can).
- The real alignment pipeline runs wherever `uv sync` ran, and CI's pipelines job runs it on the synthetic sets; the photo e2e specs keep their stand-in pipelines. The real-engine e2e (`photo-real.spec.ts`) passes but stays opt-in (`QUADRION_E2E_PHOTO_REAL=1`): it takes 4 to 7 minutes on a 24-core workstation, about what the tests of a whole Windows e2e shard take in CI. On its mini flight (22 photos aligned, three marks a point, all four control points in the adjustment) the pipelines measure the checkpoints at 4 to 7 cm horizontally and 6 to 12 cm vertically (about one ground sample distance), inside both targets; the spec itself only asserts the horizontal one.
- A control point is left out as an outlier only when the other points can tell. A wrong position in plan is named from five control points on; with four it stays in. A wrong height alone is named only on larger sets (about ten points), because a model that has not seen ground control has heights that are bent by decimetres. A point that is not named stays in the adjustment and shows in the residuals of the control points: read them.
- With ground control, a block of nadir photos from one height and without RTK still leaves the focal length 2 to 3 % loose: the ground is right (checkpoints within about one ground sample distance), but a height above the control (a roof, the top of a stockpile) can be off by that share of it.
- Without ground control, a small block of nadir photos at one height can carry a uniform height bias of about a metre (focal length and height trade off); add ground control or oblique photos.
- **Processing accuracy report (PDF)** shows in the Exports menu of every project; without a processed run it answers with a message instead of a file.
- The bundled photo demo is a small 13-photo block: only three of its nine surveyed points are in enough photos to mark, and it has no oblique photos.
- Fisheye and spherical cameras are not supported; oblique close-range sets are untested.
- Texturing drapes the orthophoto or projects one photo per face: there is no seam-levelled texturing (`texrecon` is deferred). The Fast preset is weak on buildings and has no true-ortho on tall structures.
- No LiDAR processing from raw scans.
- The agent's **process_photos** reads a photos layer only (no folders), takes the project's coordinate system and picks the survey date as the dialog does by itself.

### OPF

- Import reads cameras, calibration, control points, the sparse cloud and products, but no meshes. Uncalibrated photos bring their positions only.
- Export writes the sparse model, not the dense cloud. Tested against the specification's examples and our own exports, not yet against Pix4D itself.
- Vertical CRS heights are taken as they are, without conversion.

### Globe

- The Globe is for overview and navigation: no editing tools, only a distance and area read-out on the ellipsoid.
- No geoid grid ships, so terrain heights on the Globe are not corrected to the geoid.
- Processed maps (orthophotos, shaded surfaces and change heat maps) show for the open project and the site you pick, not for every site at once. COG-only and plain-image rasters and the cloud change result are not drawn on the Globe. Sites have no footprints and there is no date filter.
- A new orthophoto or change heat map made by a job while the Globe is open shows only after the sites are read again: leave the Globe and open it again.
- Cloud change (`change.cloud`) on photo-processed surveys needs the Standard preset or higher. The Fast preset makes only a sparse cloud, so cloud change finds no regions on it. A grid that adapts to the cloud density would lift this.
- The agent's **show_on_globe** ends the agent's reply: the agent panel belongs to the project view and closes when the Globe opens.

### Imagery, terrain and 3D Tiles

- No world imagery or terrain ships in the installer and there are no pack downloads yet: imagery and terrain come from packs you build or import.
- The bundled region imagery is 10 m (Sentinel-2 class), not sub-metre, unless you import your own.
- Customer-licensed imagery and terrain travel in a package only when you tick them, cut to the site.
- 3D Tiles are written as uncompressed glTF (no Draco, KTX2 or Meshopt), and are not checked by the official validator.
- Converting a point cloud to 3D Tiles holds the whole cloud in memory; compressed COPC input needs PDAL.
- A tileset has no visibility toggle in the layer list, and an issue placed on a tileset may not resolve after the project is reopened.
- An imported tileset in a local frame (or placed only by a region bounding volume) stays hidden: placing it on the map is not built yet.
- The Globe has its own copy of the Terrarium height decode (about 40 lines) rather than sharing the site view's.

## Surveying (M11)

### Coordinates, geoids and calibration

- The global EGM96 and EGM2008 geoid grids are not bundled in the pipeline pack yet (0.5.4). Until they are, orthometric heights need a geoid pack; a height that needs a missing grid is refused with the pack's name ("Showing heights on this site needs the ... geoid pack, which is not installed."), never shown on the ellipsoid and never downloaded.
- Regional geoid grids (AUSGeoid2020, GEOID18, OSGM15 with OSTN15, NZGeoid2016, CGG2013a) come only as optional geoid packs, built from PROJ-data files with `tools/maps/geoid-packs.mjs`, or imported by you (**Settings**, **Offline maps**, **Geoid packs**, **Import geoid grid**). An imported grid must be a classic GeoTIFF or a GTX in longitude and latitude; BigTIFF is refused. Its licence and attribution are what you state; the app does not check them.
- Calibrations are imported from Trimble JobXML (`.jxl`) and from 12d parameters typed into a small key and value text file, or computed from point pairs. Trimble `.dc` is refused (no public specification of its records); Trimble `.cal` is not read (closed). Point pairs share one kind of global position (all WGS84 or all grid); a mix needs two files.
- JobXML sign conventions (rotation, and which coordinates the inclined plane uses) are checked against synthetic files only; the importer keeps the reading that reproduces the file's own residuals. Check it against a real controller job (TESTING, stage M11).
- Contour intervals, overlay ranges and station fields are typed in metres whatever the site's units.

### Formats and interop

- No DWG, IFC, TTM or Trimble machine-control files (`.vcl`, `.dsz`, `.svd`, `.svl`): none has a public specification or an agreement with the vendor (M11 decisions 1 and 2). Save DWG as ASCII DXF. The path to machine control is LandXML (or DXF) into Trimble Business Center, which writes the machine files.
- 12da is read and written from 12d's public description of the format ("12d A File Format"); it is tested against our own files, not yet against files from 12d Model itself.
- Alignments: horizontal geometry (lines, arcs, clothoid spirals) with station equations is read and written; vertical alignments (profiles) are not.
- **Import design** lists a file's layers from a quick look at it (files up to 64 MB; for a larger one the layer names are typed). Units the file states are always used; a units choice applies only to a file that states none.

### Volumes, designs and views

- The stockpile kit's `tin` base (a smooth membrane over the toe) differs from the survey engine's `smart` base (a triangulation of the toe line), so the two give different figures. The kit's four bases and their numbers are unchanged; the engine's bases are offered as extra choices under **More bases (survey engine)**, and the register and totals keep the kit's bases. Which one the kit should show is a founder decision still open.
- Terrain overlays (contours, gradient, elevation, shaded relief) draw on the 2D map only, not in the 3D view.
- Designs in the views: alignments have no vertical geometry, so they are drawn on the terrain; the 3D view labels at most 300 stations of an alignment (every few at a short interval). A surface layer shows on the map as its outline only.
- Hydrology results show on the 2D map only.
- If the comparison engine stops (an error inside it, or an answer it cannot hand over), the measurement says why and **Recompute** starts a new engine with the same project; no restart is needed. Running out of memory on a very large comparison has not been tested: it may close the window instead.
- Packages (player mode) show the survey measurements, sections, overlays, comparison results, designs, QA status, hydrology runs and haul-road results read only. Nothing is computed or saved there: a section cannot be downloaded, a stale result stays stale, and the survey exports are not offered.
- The DTM filter presets (equipment, vegetation, structures, everything) need a point cloud layer and PDAL in the pipeline pack; without either, the button in **Cleanup and crop** is greyed out with the reason.
- **Suggest boundaries** and **Snap to ortho edges** need the pipeline pack with its boundary model (MobileSAM: pack 0.5.1, or a 0.5.0 built after 10 Oct 2026); an older pack has none and the buttons say so. The app never downloads the model.
- The outline comes from the ortho alone (not the DSM): shadows and vehicles on a pile can pull it off the toe, and where two piles touch the first draft often runs around both (one **Remove area** click on the other pile usually fixes it). It is checked on synthetic piles only; your real orthos are the next check. Treat every draft as a suggestion.
- **Suggest boundaries** reads tiled and image orthos (`kit-pyramid`, `image`); a COG or PMTiles ortho is refused with the reason. One outline per draft, without holes; **Add area** and **Remove area** clicks steer it, and there is no undo of a single such click (**New outline** starts again).
- The AI cut and fill breakdown is the rule-based regions of **Whole site cut and fill** with their boundaries snapped by the model; the model does not find regions by itself.

### Hydrology and haul road

- Direct rainfall is a simplified model: a local-inertial 2D solver on a regular grid (2, 1 or 0.5 m) with one Manning's n and one constant infiltration rate for the whole area; no pipes, culverts or buildings.
- Hydrology runs read at most a bounded number of cells: flood to level 25 million, runoff and catchment 4 million, direct rainfall 4 million. A larger surface needs a **Region** (an area or volume measurement); the region is its bounding box clipped to the surface, so cells outside the polygon but inside its box count too.
- Hydrology is checked against analytic truths (a bowl, a V-shaped catchment, a tilted plane); WhiteboxTools is not used as a second opinion.
- A haul-road centreline is a design alignment, a design polyline or a drawn line; proposing one from the surface is not built.
