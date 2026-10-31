# Confined-space drone inspections from Flyability Inspector exports

Status: draft for founder review (31 Oct 2026). Confined-space inspection, part 1 of 2. Part 2 (QYSEA FIFISH ROV dives) gets its own design later.

## Why

Confined-space jobs (tanks, chambers, basins) are flown with a Flyability confined-space drone. Today the one tank project in the app came in through a one-off converter (a tank converter under `packages/project/src/import/`) that reads an earlier hand-built 3D report and hard-wires that tank's geometry, origin, flight times and severity model. Nothing in the normal import path can take Flyability data: video needs a DJI SRT next to it (`raw.ts`, `NO_SRT_MESSAGE`), and a point cloud or trajectory in a local frame has nowhere to go.

The founder wants Quadrion to do the review and the client report itself, so the only Flyability step left is Inspector's export. Success is: take an Inspector export folder, import it, review all flights together on the point clouds with the video painted on the asset, mark and edit findings, and export a PDF whose findings a client engineer can find on the real asset.

## Goals

1. **Import an Inspector 5 export folder** as a native project (or into an existing one), with no converter and no hand edits. Both export generations seen so far are supported: 2024 (ROS 1 `.bag` flight logs) and 2025 (ROS 2 `.mcap` flight logs).
2. **Several point clouds at once.** Every flight's cloud (`*_livemap.las`) and the inspection's merged cloud (`inspection_map1.las`, when present) load as separate layers that can be shown and hidden. They line up once each flight's alignment transform from `flight.json` is applied (below).
3. **Flight lines on the asset.** Each flight's path (`*_livetraj.csv`) is drawn in the cloud. Clicking the line seeks that flight's video; playing the video moves a camera marker along the line.
4. **Video projected onto the point cloud.** The current frame is painted onto the cloud points the camera can see, with occlusion (points behind nearer points are not painted).
5. **Findings.** Inspector's POIs and snapshots come in as findings (Issues) with their image, annotated image, severity, comment, time, wall distance and 3D location. The user can add new findings from a paused video frame or a photo, edit any finding, and move its 3D point.
6. **Asset reference.** Once per space (chamber, tank) the user sets the floor level and the vertical, and picks the shape:
   - **Round** (tank, silo): a centre axis and a 0° direction (north, a manhole, a nozzle). A finding reads "height, bearing, distance from the axis".
   - **Rectangular** (chamber, basin): walls named by the user (North wall, …) and a corner per wall to measure from. A finding reads "North wall, 3.2 m from the NW corner, 1.4 m up" (founder, 31 Oct).
     The app proposes floor and vertical automatically; the user confirms.
7. **Drawings and models, when available.** A customer drawing (plan or elevation) or a model can be added and aligned to the cloud by picking matching points. Findings then show as numbered markers on it.
8. **PDF report** built by the app's existing report system: overview (counts by severity and category, the drawing or an overview render with numbered findings), then one page per finding with the photo (and annotated version), a close 3D view with the finding marked, a wide 3D view showing where it sits in the asset, height above floor, direction (bearing from the asset reference), distance from the reference point, wall distance, severity, category, comment, flight and time.

## Non-goals (this design)

- Reading raw drone folders (founder, 31 Oct: Inspector export only). The 2023 Inspector 4 `.efly` project stays on its existing converter.
- Thermal (radiometric frames exist in `*_thermal.stn`) and ultrasonic thickness / radiation payload data: later.
- QYSEA ROV dives: part 2.
- Re-running SLAM or reprocessing raw LiDAR packets; aligning flights that Inspector did not align.
- Building a model from drawings automatically.

## Anti-goals

- Anything that only works for one tank shape (cylinder fits, hard-coded radii, named nozzles). The old review aligned flights by fitting that tank's cylinder; nothing like that goes in.
- A new special-case path beside the normal import. Flyability data goes through the same import, layer and finding machinery as everything else, extended where needed.
- Copying operator e-mail addresses or launch GPS from the export into the project (see Privacy).

## What an Inspector 5 export contains (measured on three local datasets)

Paths to the sample datasets are in the founder's private notes, not here (the folder names carry client names). The layout is a database dump with one UUID folder per record; every `X.json` may have `X.json.<epoch-ms>.backup` siblings, which are older revisions and are ignored.

| Folder                                                         | What we use                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets/<uuid>/asset.json`                                     | asset name; a small relocalisation `map_chunk` LAS (ignore)                                                                                                                                                                                                                                                                                                                                                                         |
| `inspections/<uuid>/`                                          | inspection record (name, date, flights)                                                                                                                                                                                                                                                                                                                                                                                             |
| `flights/<uuid>/flight.json`                                   | file manifest, flags (`lidar`, `thermal`, `relocalized`), launch GPS (strip), `time_sync` with `video_offset` and `phase_start/end_time` (µs since boot); `inspection_id`; `transform` (below)                                                                                                                                                                                                                                      |
| `flights/<uuid>/NNN_MMMM.MOV`                                  | main camera, 4K H.264 29.97 fps, split at about 4 GB into consecutive files of one recording                                                                                                                                                                                                                                                                                                                                        |
| `flights/<uuid>/*_obcbag.bag` (2024) or `*_obcbag.mcap` (2025) | flight log; we need `/sensors/servo_angle` (camera pitch, degrees, positive = down) and possibly `/sensors/tof`                                                                                                                                                                                                                                                                                                                     |
| `flights/<uuid>/*_starnet.stn`                                 | Flyability telemetry (self-describing binary); may also carry camera pitch (being checked)                                                                                                                                                                                                                                                                                                                                          |
| `flights/<uuid>/calib_files/`                                  | navigation-camera calibration only; no main-camera extrinsic                                                                                                                                                                                                                                                                                                                                                                        |
| `maps/<uuid>/map.json` + `*_livemap.las` + `*_livetraj.csv`    | per-flight cloud and trajectory; one map per inspection holds the merged `inspection_map1.las`                                                                                                                                                                                                                                                                                                                                      |
| `pois/<uuid>/poi.json`                                         | name ("POI-387-83"), tags, description; no position                                                                                                                                                                                                                                                                                                                                                                                 |
| `snapshots/<uuid>/snapshot.json` + images                      | the finding: `poi_id`, `flight_id`, `time` (µs since boot), `camera_pose` and `drone_pose` (position + quaternion in the shared frame), `camera_pitch`, `criticality` (Critical/High/Medium/Low), `comment`, `wall_distance` (m), `camera_image`, `picture` (original RGB `<id>_rgb.jpg` under the misspelt key `original_rbg`, annotated `result_annotated.jpg`, normalised point annotations with labels), `context_3d[]` renders |

Formats:

- LAS 1.4, point format 1 (XYZ, intensity, GPS time = seconds since boot, no RGB), scale 0.001, no CRS. Local metric frame, z up. Per-flight clouds hold 3 to 19 M points.
- `livetraj.csv`: space separated, header `timestamp[s] pos_x[m] pos_y[m] pos_z[m] rot_x rot_y rot_z rot_w quality`, 10 Hz, seconds since boot, quaternion x,y,z,w.
- One clock: trajectory, LAS GPS time, snapshot time, flight logs and `video_offset` all use seconds (or µs) since the drone's boot. Video time of a trajectory sample = t − `video_offset`, carried across the MOV split.
- Wall clock exists only in `flight.json`, EXIF and MOV `creation_time`.

## How it works (decided)

- **Detection and import.** A folder with `flights/`, `maps/`, `snapshots/` and `pois/` UUID folders is recognised as an Inspector export. Import reads it in place; the user picks which inspections/flights to bring in.
- **One project, several spaces (founder, 31 Oct).** A job with several chambers is one project. Each Inspector inspection becomes a **space** with its own local metric frame (no EPSG); spaces do not line up with each other and are never shown in one 3D scene together. The user switches space in the project; the report covers all spaces, grouped by space. Each further export of the same job is imported into the same project as another space (or merged into an existing space, below). This needs a project-frame contract change: a project holds several named local frames.
- **Local frame.** Clouds are converted to the app's streaming format without reprojection.
- **Re-import (builder's call, recorded).** Importing an updated export of a space merges by Inspector snapshot/POI id: new findings are added, existing ones keep the user's edits (same idea as `import/keep.ts`), nothing is deleted silently.
- **Layers per flight:** point cloud, flight line, video (with a flight pose file built from the trajectory plus camera pitch), finding photos. Plus the merged inspection cloud.
- **Flight alignment (measured).** A flight the drone did not relocalise carries a `transform` in `flight.json` (4 x 4, row-major, translation in the last column; null on relocalised flights). Inspector computes it but does not apply it to the flight's `*_livemap.las`, `*_livetraj.csv` or its snapshots' `drone_pose` and `camera_pose`. The importer applies it to all three to bring the flight into the inspection frame (seen: a yaw of a few degrees to tens of degrees and 0.2 to 2 m of shift, sometimes a slight tilt; applied, the flight's cloud lies within centimetres of the merged inspection cloud, unapplied it is metres off). Links: `flight.inspection_id`, `map.parent_type`/`parent_id` (`Flight` for a flight's cloud and trajectory, `Inspection` for the merged cloud, whose file name varies: `inspection_map1.las`, `inspection_map2.las`; `Asset` maps are the relocalisation map and are ignored), `snapshot.flight_id`, `snapshot.poi_id`.
- **Camera model (measured).** `drone_pose` equals the trajectory sample at the snapshot time (millimetres). Body frame: x forward, y left, z up. The camera sits at the body pose plus a fixed lever arm of (0.2986, 0.0077, -0.0202) m in the body frame, and `R_cam = R_body * Ry(-camera_pitch_deg)` (`camera_pitch` negative = looking down); the camera looks along its own +x. Imported snapshots use `camera_pose` directly; the model is for video frames (phase 2) and to check `camera_pose`. For video: equidistant fisheye (the existing `ftheta` lens), 114° horizontal field of view, 16:9, centred; camera pose = trajectory pose at the frame time with the pitch and lever arm above. Field of view and lever arm are per-project settings with these defaults so they can be tuned.
- **Wall distance** is the latest valid time-of-flight sample before the snapshot, or null when there is none; null means no check, not a disagreement.
- **Photos.** A snapshot's `<id>_rgb.jpg` is the camera still, or, when no still was taken, Inspector's 3840 x 2160 grab of the video frame; both are valid finding photos.
- **Projection onto points** with an occlusion test, fading with distance (the old review used up to 9 m). It paints the space's merged cloud when there is one, otherwise the flight's own cloud (builder's call, recorded).
- **Finding = one Inspector POI (builder's call, recorded).** In the samples every POI has exactly one snapshot; if a POI has several, the extra snapshots become extra photos (sightings) of the same finding and the worst severity wins.
- **Category (builder's call, recorded).** Starts from the POI's Inspector tags; the user can change it from the project's catalogue.
- **Finding location.** For imported snapshots: cast a ray from `camera_pose` along the view axis into the cloud; the hit is the finding point. Check it against `wall_distance` and flag findings where they disagree. For new findings: the same ray from the frame's or photo's camera pose through the clicked pixel. The user can drag the point.
- **Severity.** The drone's four levels (Critical, High, Medium, Low) as the default severity model for these projects, set up through the existing severity templates; a project can switch model.
- **Privacy.** Operator e-mail (`audit.last_updated_by`) and launch latitude/longitude are not copied into the project.

## Constraints

- Repo rules in `CLAUDE.md` and `CONTRIBUTING.md`: worktree branch, `pnpm check` green, e2e specs run the CI way, merge via the coordinator.
- Contract changes (layer kinds, project frame, flight pose source, job names) get a row in `docs/architecture/contract-changes.md`; a new pipeline job means a pipeline pack bump numbered by the coordinator.
- Exports are large (8 to 10 GB per flight, mostly video). Import must not copy video unless the user asks; proxies follow the existing video proxy path.
- No client, site or person names in code, tests, fixtures, docs or commit messages. Test fixtures are synthetic (a tiny generated export with the same layout), not the real datasets; real-data e2e follows the existing `realProjectDir` pattern and skips when absent.

## Delivery order (builder's call, recorded)

Phased branches, each landing through the coordinator:

1. Import, spaces/local frames, clouds, flight lines, findings (with photos and ray-cast points), editing.
2. Video on the flight line and projection onto the cloud.
3. Asset reference (round and rectangular) and the PDF report.
4. Drawings and models aligned to the cloud, findings on them.

## Left to the builder

- Where detection lives (`detectPackageKind`, `raw.ts`) and whether parsing is TypeScript or a Python pipeline job (reading `.bag`/`.mcap` likely wants Python: `rosbags`/`mcap`).
- How a local-frame project is represented, given that `kit-packed` local clouds cannot be recentred today and raw import assumes a project CRS (`layerFiles.ts` `isLocalFrame`).
- How video projection onto points is implemented (the existing projector and the f-theta lens in `packages/video`), and its performance budget.
- How the asset reference is stored and how floor and vertical are proposed.
- Drawing alignment: reuse of existing drawing layers and "Align to".
- Report page layout, following the existing report system and the design skills.
- Whether the 2023 converter is later retired onto this path (not in scope).

## Open points

- Whether `starnet.stn` carries camera pitch (the flight log's `/sensors/servo_angle` does); needed for video in phase 2 only.
- Whether a finding's 3D point should be the ray hit on the cloud (decided) or Inspector's own value if the export ever carries one (it does not today).
