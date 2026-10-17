# Telecom antenna detection — design

Date: 2026-10-17. Branch: `feat/telecom-auto-detect`. Status: draft for founder review.

## Intent

A telecom engineer opens a tower project, clicks **Detect antennas** once, and gets the antenna inventory: every antenna boxed in 3D with its azimuth, downtilt, plumb, size, centre height and coordinates, the best photo of it, and a list to review, accept or reject. Today the same numbers take one manual Azimuth and one Antenna-tilt measurement per antenna (shipped 2026-10-16), and those picks are slow and error-prone.

The benchmark is Pix4Dinspect's automatic antenna recognition: an inventory grouped by type, a fitted box per antenna, "Automatic recognition data" (Type, Downtilt, Azimuth, Plumb, Width, Height, Depth, centreline altitude, coordinates), editable equipment fields (model, weight, frequencies, on/off) and a linked photo. We match that and go one better on trust: every number carries how it was measured and how good the fit is (`PRODUCT.md`: "Show how a measurement is known and what remains uncertain").

## Evidence it works (spike, 2026-10-17)

A throwaway script on the reference monopole site (a good photogrammetry point cloud, about 30 m, three tiers of equipment on a ring headframe) showed:

- The cloud alone separates and measures antennas. Method: per-point normals, keep upright planar points, grow planar regions (RANSAC split when rough), pair each front face with its back face, fit an oriented box.
- All 6 hand-placed azimuths matched a detected antenna within ±2.5°, mean 1.3°. The worst case is a weak manual reference (see "Related fix").
- Face plane residuals were 2–5 mm. Plumb was noisy (±2°) on 0.4 m-wide faces; azimuth was solid.
- 17 units were found against roughly 25–30 visible. Misses: small radio units on the inner ring, faces merged with neighbours, and one 1.5 m-wide unit rejected by a width filter.
- Type from size alone can't tell a radio unit from a short antenna.
- **The cloud's Z needs the layer's `heightOffsetM` applied** (`packages/schema/src/cloudFrame.ts` `cloudFrameOrigin`) to agree with project heights and measurements.
- Thresholds were hand-tuned for one site.

The spike script is not production code and is not in the repo. The builder re-implements the method properly, with tests.

## Goals

1. **One click.** A single action runs detection end to end as a background job. No parameters are required; an optional advanced popover may expose a few.
2. **Antennas measured** (v1 scope, founder's go-ahead with this as my call):
   - panel antennas (any height),
   - short/active antennas (about 0.6–1.2 m tall boxes, e.g. 5G units),
   - microwave dishes (circle fit: diameter, azimuth, elevation).
     Each gets Type, Azimuth, Downtilt, Plumb, W/H/D, centre altitude and centre coordinates, plus fit quality.
3. **Other equipment listed, not measured.** Radio units and other boxes found on the crown appear as "Other equipment" with size and centre only, and no azimuth or tilt claimed. Finding all of them is not a v1 goal.
4. **Review.** Results are drafts until a person accepts or rejects each one. Users can add model name, weight, frequencies and on/off.
5. **Photo link.** Each antenna lists the photos that see it best, and the details view opens the best one.
6. **Optional AI labelling.** With the user's consent, Claude or OpenAI labels each detected unit from photos (panel / short antenna / radio unit / dish / other). AI never produces a number.
7. **Offline by default.** Geometry runs locally with no network. With AI off, or the app offline-only, everything except labelling still works.
8. **Accuracy target.** Azimuth within ±2° of a careful reference on clean clouds. Every value carries residual and support so poor ones are visible.

## Non-goals (v1)

- Rooftop and water-tower sites with no tower axis. v1 needs a tower axis (monopole or lattice). Rooftop mode is the next step; see "Later".
- Magnetic north. Grid and true north only.
- Editing an antenna's geometry by dragging. Users reject and re-run, or use the manual tools.
- A trained local antenna detector, which needs labelled data. The design leaves a slot for it.
- A PDF report. A CSV export is in v1.
- Electrical tilt (inside the antenna). We measure mechanical tilt only, and the UI says so.

## Anti-goals (a failure even if it technically works)

- **A number without its basis.** Every measured value shows measured/inferred/user and its fit quality.
- **Running heavy work on the Electron main thread.** That freezes the app (pre-launch audit). Use the Python job runner.
- **A separate progress UI.** Progress goes through the existing jobs chip and island live line (UI rework session's ask).
- **Sending photos or scans anywhere without the existing consent path:** offline-only switch, `aiCloudPhotos` project flag, send preview.
- **Silently overwriting a person's review on re-run.**
- **AI-estimated angles.**

## Constraints

- Repo rules in `CLAUDE.md` and `CONTRIBUTING.md`: own worktree, `pnpm check` green, e2e run the CI way, no client or site names in public text, tests, fixtures or commits.
- **Files that are mid-change in other sessions. Don't touch them until they land:**
  - UI rework: `Stage.tsx`, `workspace/tools/*` island group files, the right-panel shell (`RightHeader`, workbench store), `styles.css` stage sections, `packages/ui/src/shortcuts.ts`.
  - Another session: the measurement panel (`MeasurementPanel.tsx`) and the builder placement tools.
  - Separate fix: `packages/survey/src/tools/telecom.ts` (see "Related fix").
- UI uses the `@aio/ui` foundation parts (Button/IconButton, `Row`, Chip, EmptyState, Tabs, Popover/Menu), the `--sp-*`/`--z-*`/`--t-title` tokens, and strings in `packages/ui/src/i18n/en.ts`.
- New schema or file formats need a row in `docs/architecture/contract-changes.md`.
- Coordinates: survey points are E,N,Z in the project CRS. The local frame is Y-up, X east, Z south (`docs/architecture/data-conventions.md`). Grid convergence comes from `gridConvergenceDeg` (`packages/geo/src/crs.ts`).

## How it works

### 1. Pipeline `telecom.antennas` (Python, job runner)

A new pipeline in `python/src/aio_pipelines/telecom/`, registered in `pipelines.py`, with its name added to `PipelineName` in `packages/schema/src/jobs.ts`. Steps:

1. **Locate the crown.**
   - Which cloud (my call): the cloud layer used by the newest engineering evidence, if there is one. Otherwise the newest visible point-cloud layer. The advanced popover lets the user pick another. v1 reads one cloud; meshes are not used. The layer id goes in the run metadata.
   - Tower axis and height: from that engineering evidence if present (`engineering/<run>/evidence.json` `axis`, `height`, `crop`).
   - Without evidence, find the tower automatically (my call; it keeps the common case one click): take the tallest slender upright structure in the cloud, from a coarse height grid. The tallest cell cluster is the seed; crop a 30 m radius around it like `model.evidence` does; then run `engineer/axis.py` `estimate_axis` with the same upright check.
   - If two candidates are within about 15% of the same height, or the axis fails the upright check, the job stops. The UI then asks the user to click the tower once, and re-runs with that point as the crop centre (`params.towerHint`).
   - Crown band: the top of the tower down to the lowest equipment, found from points outside the shaft envelope. Default floor: 70% of the height.
   - Read only that cylinder from the COPC (bounds query). Apply the layer's `heightOffsetM`.
   - If there's no axis, or the cloud is too sparse there, stop with a clear message rather than guess.
2. **Planar faces.**
   - Voxel downsample (about 1.5 cm) and estimate per-point normals.
   - Keep points on upright planar surfaces, then grow planar regions; split rough regions with RANSAC planes.
   - Drop the shaft (radius filter around the axis) and horizontal or ring structure.
3. **Boxes.**
   - Pair each front face with its parallel back face to build oriented boxes.
   - Merge duplicates, and drop boxes outside plausible sizes. Don't hard-cap width at 1 m: wide units exist.
4. **Classify by geometry:** panel, short antenna, dish (circle fit on round planar regions; RANSAC circle exists in `modelfit/ransac.py`) or other equipment.
5. **Measure** (conventions below), with quality per value: face plane RMS residual, point support, coverage.
6. **Best photos.**
   - For each unit, project its box into every posed photo with the existing pinhole model.
   - Score each photo on in-frame coverage, frontalness (angle between the view direction and the face normal), distance, and occlusion if cheap. Keep the top 3.
7. **Commit** `telecom/antennas.json` atomically (manifest-last pattern), merging with the previous run (see "Re-run").

Progress uses `ctx.progress()`. Target runtime: under 2 minutes for the reference site's crown on a normal workstation.

### 2. Measurement conventions

| Value       | Convention                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Azimuth     | Clockwise from north of the outward face normal, horizontal part. Outward = away from the tower axis. Stored as grid; true = grid + convergence. |
| Downtilt    | Angle of the face normal below horizontal. **Positive = beam points down** (Pix4D convention). Mechanical only.                                  |
| Plumb       | Sideways lean of the face's long axis from vertical, in the face plane. **Positive = top leans right, seen from the front.**                     |
| W / H / D   | Box extents: across the face, along the long axis, front to back. Metres.                                                                        |
| Altitude    | Centre of the box, project vertical datum.                                                                                                       |
| Coordinates | Box centre, project CRS (E, N).                                                                                                                  |
| Dish        | Azimuth and elevation of the dish axis, plus diameter.                                                                                           |

The UI shows true north first, with grid secondary, whenever the CRS is projected (convergence known). Otherwise it shows grid and labels it as grid. That's my call; the current manual tool shows grid only.

### 3. Data: `telecom/antennas.json` (`aio.antennas/1`)

A new schema in `packages/schema/src/antennas.ts`, read and written through main-process handlers (journaled like `survey:writeMeasurements`). It reuses `ValueBasis` and `ParamQuality` from `assemblies.ts` for provenance.

Per unit:

- `id`, `kind` (`panel | short | dish | other`), `kindBasis` (`geometry | ai | user`) and, when AI labelled it, the AI origin (provider, model, prompt version, run id).
- `status` (`draft | accepted | rejected`).
- `box` (centre E,N,Z, axes, extents).
- `azimuthGridDeg`, `convergenceDeg`, `downtiltDeg`, `plumbDeg`, `widthM`, `heightM`, `depthM`. Each value is `{ value, basis, quality }`; `other` units have no angles.
- `photos` (top 3 ids plus score), user fields (`model`, `weightKg`, `frequencies`, `active`), `runId`, `createdAt`.

Plus the run metadata: parameters, the source cloud layer id, the axis used, warnings, and counts.

Coordinates (my call): box centres and axes are stored as project E,N,Z, like survey measurements, with `heightOffsetM` applied. With no CRS, those are local metres from the project origin, convergence is null, and azimuth is labelled "project north" throughout.

**Relation to the engineering model (my call).** `antennas.json` is the source of truth for the telecom inventory. v1 does not change the engineering model, and its existing `find_antenna_candidates` and inferred `antenna` components stay as they are. The detection code is new, but may reuse `members.py` helpers such as the shaft envelope.

A follow-up (not v1) makes the engineering assembly read accepted units from `antennas.json` instead of inferring antennas. To keep that cheap, the kind set maps one-to-one: `panel→panel`, `short→panel`, `dish→dish`, `other→rru`. The guide says that, until then, the engineering model's antennas are approximate and the inventory is measured.

Why not survey measurements: one antenna carries ~10 values plus review state and equipment fields, and `SurveyMeasurement` has no provenance. A later step can export accepted antennas as survey Azimuth/Tilt measurements if users want them in the measurement list (not v1).

Contract change row required.

### 4. Optional AI labelling

After the geometry job, if the user ticked "Label with AI" (off by default). The choice is remembered per project as a local renderer preference, not in the manifest, so there's no contract change (my call):

- **Gates:** the existing `aiGates.ts` checks plus `aiCloudPhotos`. Before the first send, the send preview (`SendDialog`) shows exactly which crops will leave the machine.
- **What's sent:** for each unit, a crop of its best photo around the projected box. Batching and sizing reuse `packages/ai/src/detect.ts` limits.
- **Model:** the existing vision route (Claude by default, OpenAI selectable, as configured in AI settings). The provider must return one label from the fixed set, plus a short reason.
- **Results** update `kind` with `kindBasis: 'ai'`. They never touch angles or sizes. Cost is recorded the way detection passes record it.
- **Where it runs:** main process via a new IPC call or by extending `ai:detect`, whichever fits better (builder's call). Never in the renderer.
- **Later:** a local ONNX detector can fill the same slot through `main/inference/*`. Licence: permissive weights only; the app refuses Ultralytics/AGPL.

### 5. Re-run

A new run matches units to the previous file by box centre (within about 0.3 m) and kind.

- Matched **accepted** units keep their status and user fields; geometry updates only if the new fit has better support, else stays.
- Matched **rejected** units stay rejected.
- Unmatched old **drafts** are dropped. Unmatched old **accepted** units are kept and flagged "not found in latest run".
- New units arrive as drafts.

### 6. UI (standalone first, wired after the UI rework lands)

Built now as plain components with data and callbacks in props, no layout chrome of their own (the UI rework session's request):

- **`AntennaInventory`**:
  - rows grouped by kind as `Row kind="tree"`: name, azimuth, downtilt and a status mark;
  - row actions: eye (show/hide in 3D) and ⋯ (accept, reject, open details);
  - an `EmptyState` for "no run yet" and "nothing found";
  - a summary line ("12 antennas · 5 other equipment · 3 need review").
- **`AntennaDetails`**:
  - the recognition data block, with each value showing its basis and quality on hover/tip;
  - the editable equipment fields;
  - best-photo thumbnails that open the existing photo viewer;
  - Accept / Reject.
- **Scene layer**:
  - a translucent box per unit, coloured by kind with status shown by outline style, not colour alone;
  - a facing arrow per unit (reuse the measure scene's `addFacing` style);
  - a highlight for the selected unit;
  - visible only while the inventory is shown.
- **CSV export** of accepted units (and drafts if the user asks): one row per unit, all values, basis columns.

Wiring after the stage-island stage 2 workbench lands, reviewed with the UI rework session first:

- tile **Detect antennas** in the island's Measure group, next to the telecom tools;
- progress through the jobs chip and live line only;
- `AntennaInventory` inside `<Section id="telecom-antennas" bench="measure">` in `MeasureBench`;
- `AntennaDetails` hosted by the live card or the row's ⋯.
  Exact names: `docs/superpowers/plans/2026-10-16-stage-island.md` Tasks 12 and 14 (in the stage-island worktree until it lands).

### 7. Delivery in two merges (my call)

- **Merge 1, not blocked by the UI rework:**
  - the pipeline, schema and contract row;
  - the main-process handlers and the AI labelling call;
  - the standalone components with component tests;
  - the scene layer;
  - a temporary entry point outside the frozen files: a "Detect antennas" command in the existing telecom tools strip (`TelecomTools.tsx`), if the UI rework session agrees, else an item in the command palette. The e2e spec drives that entry point. The inventory and details show in a plain temporary panel.
- **Merge 2, after stage 2 lands:**
  - move the entry point to the island tile and the inventory into the Measure bench section, as above;
  - delete the temporary panel;
  - update the e2e spec.

The tile is enabled only when the project has a point cloud. Its tip explains why when it's disabled (`disabledReason`).

## Testing

- **Python, synthetic:**
  - A generator in `python/tests/` (like the existing `*_synth.py`) builds a monopole and a lattice crown: panels, short units and a dish at known azimuth/downtilt/plumb/size, with noise and partial occlusion.
  - Assert azimuth within 1°, downtilt and plumb within 1.5°, sizes within 3 cm.
  - Also assert the clear failures: no axis, sparse crown, empty band.
- **Schema:** round-trip and validation tests for `aio.antennas/1`. Also test the re-run merge rules.
- **Renderer:** component tests for the inventory and details: grouping, empty states, accept/reject callbacks, basis display.
- **e2e:** one spec on a synthetic demo project. Click the entry point (temporary in merge 1, the island tile in merge 2), wait for the job, see units listed, accept one, reload, still accepted. CI way, per `CONTRIBUTING.md`.
- **Local only, not in CI:**
  - Run on the reference site and compare against its manual azimuths (after the manual-tool fix) and the spike's numbers.
  - Record results in the session note without site names or coordinates.

## Related fix (separate session, already handed off)

The manual Azimuth tool computes a 3D cross product of three picks. Users pick them in a level line, so the normal rests on millimetres of height noise. The fix: take the perpendicular of the picks' plan-view line, keeping the facing side. It's independent of this feature but makes the manual references trustworthy.

## Later

- **Rooftop/water-tower mode:** no axis. Outward is chosen from the mount side (pipe or bracket behind the face) or the site centroid.
- A trained permissive-licence local detector, for labels offline and to find small radio units.
- Magnetic north (WMM offline table).
- Export accepted antennas as survey measurements; PDF report section.
- Geometry nudging in 3D.

## Left to the builder

- Exact thresholds and parameters, and their defaults per tower family.
- Whether AI labelling extends `ai:detect` or gets its own IPC call.
- Photo scoring weights; whether occlusion is checked.
- File layout inside `aio_pipelines/telecom/` and the renderer `telecom/` folder.
- Internal structure of the scene layer, provided it follows the measure scene's conventions.
