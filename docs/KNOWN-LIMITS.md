# Known limits

What Stratlas does not do yet, or does differently on purpose. Testing steps are in [TESTING.md](TESTING.md).

Current limits only; each is removed from this list when fixed.

## Data and positions

- HCl position on the map is approximate (the source has no survey position); flight start times are nominal, relative timing is exact.
- DAMAC origin height is approximate (no survey control in the source).
- Video calibration is one constant offset per clip (orientation, position, time, lens): no bias that changes along a clip. On Al-Zour, **Refine automatically** is weak (the edges rarely agree clearly on the plant); point pairs work.
- No geoid model: camera heights are the drone's absolute or relative altitude plus the offset or take-off height you give; a project's vertical datum is one offset.
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
