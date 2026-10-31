# Flyability Inspector import, phase 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a Flyability Inspector 5 export folder (2024 `.bag` and 2025 `.mcap` generations) into a project as one **space** per inspection, with per-flight and merged point clouds, flight lines, and findings (photos, severity, category, ray-cast 3D point) that the user can edit and move, and that a re-import merges without losing edits.

**Architecture:** The schema learns spaces (several named local frames in one project; an older project reads as one default space), a `local` CRS, a `space` field on layers, a `flightline` layer kind and an `external` record on issues. TypeScript detects an export, scans it for the inspection picker and queues one pipeline job, `flyability.import`, which does the heavy work in Python: it reads the export, applies each unrelocalised flight's alignment transform, converts clouds to COPC without reprojection (Flyability x, y, z is east, north, up of a space whose origin is 0), writes flight pose files, copies finding photos, ray-casts each snapshot into the space's cloud, merges findings into `issues.json` keeping user edits, and registers the space and its layers in the manifest. The UI (space switcher, flight lines in 3D, import picker, finding point drag) comes last, on top of UI Wave 2's registries.

**Tech Stack:** TypeScript (zod, vitest) in `@aio/schema`, `@aio/project`, `apps/desktop` main and renderer; Python 3 pipeline pack (numpy, scipy `cKDTree`, PDAL `filters.transformation` + untwine as in `pointcloud.py`, pytest); Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-31-flyability-inspector-import-design.md` (phase 1 of its Delivery order).

## Global Constraints

- No client, site, tester or person names anywhere (code, tests, fixtures, docs, commit messages). Say "Flyability" or "confined-space drone". Run `node tools/agent/check-public-text.mjs <files>` from the main checkout on every doc you add.
- Fixtures are a tiny synthetic export generated in tests (same layout, a few hundred points); never real data. A real-data e2e follows `apps/desktop/e2e/realData.ts` and skips when the data is absent.
- Privacy: never copy `audit.created_by` / `audit.last_updated_by` (operator e-mail) or `flight.location` (launch latitude, longitude, altitude) into the project.
- Ignore every `*.json.<epoch-ms>.backup` revision file.
- Clouds are converted without reprojection; the only transform applied is a flight's own `flight.json` `transform`.
- Video, flight logs (`.bag`, `.mcap`, `.stn`), thermal, asset reference, PDF report and drawings are out of phase 1. Phase 1 never copies a `.MOV`.
- Worktree branch `feat/flyability-inspector-import`; `pnpm check` green; changed e2e specs run the CI way (CONTRIBUTING.md "End to end the way CI runs it"). Worktrees have no `python/.venv`: run Python with `E:\Dev\AIO Software\python\.venv\Scripts\python.exe` and set `QUADRION_E2E_PYTHON` to it for e2e; never junction the venv.
- Pipeline pack version: the coordinator issues it. Write `<PACK_VERSION>` until then and ask the coordinator before Task 9 commits.
- Contract changes get rows in `docs/architecture/contract-changes.md` (Task 1 and Task 2 add them).

### Measured export facts the plan relies on (verified on the 2024 and 2025 samples)

- Links: `flight.inspection_id`; `maps/<uuid>/map.json` `parent_type` + `parent_id`: `Flight` (that flight's `*_livemap.las` + `*_livetraj.csv`), `Inspection` (the merged cloud; file name varies, `inspection_map1.las`, `inspection_map2.las`, so read `point_clouds[].file_path`, never guess), `Asset` (relocalisation map, ignore). `snapshot.flight_id`, `snapshot.poi_id`.
- `flight.json` `transform.v`: 16 numbers, row-major 4 x 4, translation in `v[3], v[7], v[11]`; `p' = M[:3,:3] p + M[:3,3]`. Null on relocalised flights and on the reference flight. Inspector does **not** apply it to the flight's livemap, livetraj or its snapshots' `drone_pose`/`camera_pose`; the importer applies it to all three. Applied, a flight cloud lies within about 6 cm (median nearest neighbour) of the merged cloud; unapplied, 2 to 10 m off.
- `drone_pose` equals the livetraj sample at the snapshot time (mm). Body frame x forward, y left, z up. Camera = body pose plus lever arm (0.2986, 0.0077, -0.0202) m in the body frame; `R_cam = R_body * Ry(-camera_pitch_deg)`; the camera looks along its own **+x** (`camera_pitch` negative = down). Imported snapshots use `camera_pose` directly.
- `wall_distance` is the latest valid ToF sample before the snapshot, or null (null = no check). `criticality` is `Critical|High|Medium|Low` or null (2024 samples: null). POI and snapshot `tags` may be empty.
- `picture.original_rbg` (misspelt key) is `<id>_rgb.jpg`: the camera still or, without one, a 3840 x 2160 video frame grab; `picture.result_annotated` is the annotated image; `picture.annotations.points[]` are normalised `{x, y}` with `text`; `picture.properties.image_size` gives the pixel size.
- Livetraj: space-separated, header `timestamp[s] pos_x[m] pos_y[m] pos_z[m] rot_x rot_y rot_z rot_w quality`, 10 Hz, seconds since boot. LAS 1.4 point format 1, scale 0.001, no CRS, z up.

## Review Focus

1. **An older build saving a project with spaces** drops `layer.space` (zod strips unknown keys) and would pull every space into one scene. Expected: the project still opens; Task 1 records it in the contract row and data conventions, and Task 1 tests that this build round-trips `space` unchanged.
2. **Unrelocalised flight imported without its transform**: cloud, flight line and finding points metres off the merged cloud. Expected: all three land transformed (Task 4, Task 9 test with a non-identity fixture transform).
3. **Re-import of the same export after the user moved a finding point or changed severity**: Expected: edits kept, untouched findings refreshed, findings missing from the new export kept and counted, never dropped (Task 8).
4. **A snapshot whose ray hits nothing (looking into an open hatch, empty cloud) or whose wall distance is null**: Expected: the finding still imports, placed at `camera position + 1 m` along the view axis with `locationCheck: 'no-hit'`, or `'unchecked'` for null wall distance; never a crash and never `'disagrees'` (Task 5, Task 8).
5. **An export folder dropped one level too high or too low** (the export inside a job folder, or a single UUID subfolder): Expected: the folder or a direct child is recognised; anything else falls through to the ordinary raw import with no Flyability item (Task 6).

---

## File Structure

| File                                                                       | Responsibility                                                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/schema/src/spaces.ts` (new)                                      | `Space` schema, `DEFAULT_SPACE_ID`, `spacesOf`, `spaceOfLayer`, `layersOfSpace`, `spaceOfIssue`            |
| `packages/schema/src/manifest.ts`                                          | `Crs` gains `{ local }`; `ProjectManifest.spaces?`                                                         |
| `packages/schema/src/layers.ts`                                            | `base.space?`; `flightline` layer kind                                                                     |
| `packages/schema/src/annotation.ts`                                        | `Issue.external?` (`ExternalFinding`)                                                                      |
| `packages/schema/src/builder.ts`, `ipc.ts`, `jobs.ts`                      | `ImportItem.kind 'flyability'`, `builder:inspectorScan`, `builder:import` `inspector`, `flyability.import` |
| `packages/project/src/builder/flyability/scan.ts` (new)                    | detect and scan an export (small JSON reads only)                                                          |
| `packages/project/src/builder/flyability/fixture.ts` (new)                 | TS test fixture writer (JSON layout only)                                                                  |
| `packages/project/src/builder/templates.ts`                                | `CONFINED_SPACE_TEMPLATE` (Critical/High/Medium/Low)                                                       |
| `packages/project/src/builder/raw.ts`                                      | route an export folder to the job                                                                          |
| `apps/desktop/src/main/builder.ts`, `library.ts`                           | IPC handler, new project from an export                                                                    |
| `python/src/aio_pipelines/flyability/{export,frames,findings,pipeline}.py` | reader, geometry and ray cast, findings and merge, the job                                                 |
| `python/src/aio_pipelines/pointcloud.py`                                   | `prepare_las(..., matrix=None)`                                                                            |
| `python/tests/flyability_synth.py` (new)                                   | synthetic export generator (both generations)                                                              |
| `docs/architecture/data-conventions.md` (§40 new), `contract-changes.md`   | the contracts                                                                                              |
| renderer files (Task 12, 13)                                               | placed after the UI Wave 2 check                                                                           |

---

## Task 1: Spaces, local CRS, flight line layer and external findings in the schema

**Files:**

- Create: `packages/schema/src/spaces.ts`, `packages/schema/src/spaces.test.ts`
- Modify: `packages/schema/src/manifest.ts:48-100`, `packages/schema/src/layers.ts:147-158` and the `Layer` union (`:194`), `packages/schema/src/annotation.ts:128-153`, `packages/schema/src/index.ts`
- Modify: `docs/architecture/data-conventions.md` (new section 40 "Spaces and Flyability Inspector imports"), `docs/architecture/contract-changes.md` (one row)

**Interfaces:**

- Produces:
  - `Crs` union gains `z.object({ local: z.string().min(1).max(64) }).strict()` (a named local metric frame, no EPSG; maps, basemaps, recentre and reprojection are off for it).
  - `Space = z.object({ id: Id, name: z.string().min(1), crs: Crs, origin: Vec3, source: SpaceSource.optional() })`, `SpaceSource = z.object({ kind: z.literal('flyability'), inspectionId: z.string().min(1), assetName: z.string().optional() })`.
  - `ProjectManifest.spaces: z.array(Space).optional()` with `uniqueIds('spaces')`; layer `base.space: Id.optional()`.
  - `DEFAULT_SPACE_ID = 'main'`; `spacesOf(m: ProjectManifest): Space[]` (the implicit `{ id: 'main', name: m.name, crs: m.crs, origin: m.origin }` first, unless `m.spaces` is non-empty and no layer lacks `space`, then `m.spaces` in order); `spaceOfLayer(l: Layer): string` (`l.space ?? 'main'`); `layersOfSpace(m, spaceId): Layer[]`; `spaceOfIssue(m, issue: Issue): string` (the space of its first sighting's layer, else `'main'`); `spaceFrame(m, spaceId): { crs: Crs; origin: Vec3 } | null`.
  - Layer kind `flightline`: `{ kind: 'flightline', ...base, src: AssetRef /* aio.flight/1 */, flight: z.string().min(1) /* Inspector flight id */, bootStartS: z.number().nonnegative(), color: HexColor.optional() }`.
  - `ExternalFinding = z.object({ source: z.literal('flyability'), poi: z.string().min(1), snapshots: z.array(z.string().min(1)).min(1), flight: z.string().optional(), capturedAt: IsoTime.optional(), wallDistanceM: z.number().nullable(), hitDistanceM: z.number().nullable(), locationCheck: z.enum(['agrees', 'disagrees', 'no-hit', 'unchecked', 'moved']) })`; `Issue.external: ExternalFinding.optional()`.

- [ ] **Step 1: Write the failing tests** in `spaces.test.ts`:

```ts
test('an older project reads as one default space', () => {
  const m = ProjectManifest.parse(oldFixtureManifest); // no spaces, no layer.space
  expect(spacesOf(m)).toEqual([{ id: 'main', name: m.name, crs: m.crs, origin: m.origin }]);
  expect(layersOfSpace(m, 'main')).toHaveLength(m.layers.length);
});
test('a project with spaces lists them and keeps layer.space on a round trip', () => {
  const m = ProjectManifest.parse(withSpaces); // spaces s-a, s-b; every layer has space
  expect(spacesOf(m).map((s) => s.id)).toEqual(['s-a', 's-b']);
  expect(ProjectManifest.parse(JSON.parse(JSON.stringify(m))).layers[0]!.space).toBe('s-a');
});
test('main stays listed while a layer has no space', () => {
  expect(spacesOf(withSpacesAndOneLooseLayer).map((s) => s.id)).toEqual(['main', 's-a', 's-b']);
});
test('a local CRS parses and duplicate space ids are refused', () => {
  expect(Crs.parse({ local: 'inspection' })).toEqual({ local: 'inspection' });
  expect(ProjectManifest.safeParse(dupSpaces).success).toBe(false);
});
test('a flightline layer parses and an issue keeps external', () => {
  expect(Layer.parse(flightlineLayer).kind).toBe('flightline');
  expect(Issue.parse(issueWithExternal).external?.locationCheck).toBe('no-hit');
});
test('spaceOfIssue follows the first sighting layer', () => {
  expect(spaceOfIssue(withSpaces, issueOnLayerInB)).toBe('s-b');
});
```

`oldFixtureManifest` is an existing fixture from `packages/schema/src/__fixtures__`.

- [ ] **Step 2: Run** `pnpm vitest run packages/schema/src/spaces.test.ts`. Expected: FAIL, `spacesOf` not exported.
- [ ] **Step 3: Implement** the schema changes and helpers above. `LAYER_KINDS` picks up `flightline` by itself. Check `isLocalFrame` (`packages/project/src/builder/layerFiles.ts:49`): a `flightline` is local frame (add it); a COPC in a space whose `crs` is `local` stays out of the CRS sidecar path unchanged.
- [ ] **Step 4: Write data-conventions §40**: spaces (implicit `main`; a layer without `space` is in `main`; spaces never share a scene), the local CRS (a Flyability space: `crs { local: 'flyability' }`, origin `[0, 0, 0]`, file x, y, z = east, north, up, so section 1 maps `(x, y, z)` to scene `(x, z, -y)`), the `flightline` layer and its pose file (section 3 format; `t` in ms from `bootStartS`, `q` the camera at pitch 0 until phase 2 adds the servo pitch, `startUtcMs` from `flight.datetime_utc`), `Issue.external`, the Flyability folder layout under `imports/flyability/<spaceId>/` (photos, pose files), and the older-build caveat (Review Focus 1). Add the contract rows: Task 2's contracts (`ImportItem.kind 'flyability'`, `builder:inspectorScan`, `builder:import.inspector`, job `flyability.import` needing pipeline pack `<PACK_VERSION>`), and this task's: date 2026-10-31, the fields above, "Additive; an older 1.x build keeps a `flightline` as an opaque layer but drops `layer.space`, `spaces` and `Issue.external` when it saves, and refuses a manifest whose `crs` is `local`."
- [ ] **Step 5: Run** `pnpm vitest run packages/schema && pnpm typecheck`. Expected: PASS (fix every exhaustive `switch` on `Layer['kind']` the typecheck names by treating `flightline` like `walk` paths: not exported as a file layer, no map footprint).
- [ ] **Step 6: Commit** `feat(schema): spaces, a local crs, flight line layers and external findings`.

## Task 2: Import, IPC and job contracts

**Files:**

- Modify: `packages/schema/src/builder.ts:165-184`, `packages/schema/src/ipc.ts`, `packages/schema/src/jobs.ts` (names list `:51`, descriptors `:141`, params near `:502`), `packages/schema/src/jobs.test.ts`, `packages/schema/src/builder.test.ts`
- Contract row: written by Task 1 (keeps Batch A free of shared files).

**Interfaces:**

- Produces:
  - `ImportItem.kind` gains `'flyability'` (`file` = the export folder, `jobId` set when queued).
  - `InspectorScan = z.object({ root: z.string(), generation: z.enum(['2024-bag', '2025-mcap', 'unknown']), asset: z.string().nullable(), inspections: z.array(z.object({ id: z.string(), name: z.string(), mergedCloud: z.boolean(), findings: z.number().int(), importedAs: z.string().nullable() /* space id */, flights: z.array(z.object({ id: z.string(), name: z.string(), cloud: z.boolean(), path: z.boolean(), aligned: z.enum(['relocalised', 'transform', 'reference']) })) })) })`.
  - IPC `builder:inspectorScan`: `{ projectId: string | null, path: string }` to `{ ok: true, scan: InspectorScan } | { ok: false, error: string }`.
  - `builder:import` request gains `inspector: z.object({ inspections: z.array(z.object({ id: z.string(), flights: z.array(z.string()).optional() })).min(1) }).optional()`.
  - Job `flyability.import`, `FlyabilityImportParams = z.object({ src: z.string().min(1), inspections: (as above), severityModel: SeverityModel, catalogueId: Id, spaces: z.record(z.string(), Id).optional() /* inspection id to existing space id */ }).strict()`; descriptor title "Flyability Inspector import", description "Clouds, flight lines and findings from an Inspector export, one space per inspection."
- [ ] **Step 1: Failing tests**: `jobs.test.ts` `'flyability.import params parse and refuse unknown keys'` (valid params parse; `{ ...valid, extra: 1 }` fails; `inspections: []` fails); `builder.test.ts` `'an import item can be a flyability export'` (`ImportItem.parse({ file: 'x', kind: 'flyability', status: 'queued', jobId: 'j1' })` ok).
- [ ] **Step 2: Run** `pnpm vitest run packages/schema/src/jobs.test.ts packages/schema/src/builder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schemas; register the job name and descriptor.
- [ ] **Step 4: Run** the same tests plus `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(schema): flyability import item, scan channel and job`.

## Task 3: Synthetic export generator (Python)

**Files:**

- Create: `python/tests/flyability_synth.py`, `python/tests/test_flyability_synth.py`

**Interfaces:**

- Produces: `make_export(root: Path, *, generation: Literal['2024', '2025'] = '2025', merged: bool = True, transform: list[float] | None = YAW_20_SHIFT, points: int = 400) -> SynthExport` where `SynthExport` (dataclass) holds `root`, `inspection_id`, `flight_ids: list[str]` (flight A relocalised, flight B with `transform`), `poi_ids`, `snapshot_ids`, `email = 'operator@example.invalid'`, `launch_lat = 12.3456789`, and `wall: dict[str, float]` (true distance from each snapshot camera to the wall). Geometry: a box room 10 x 6 x 4 m sampled as points in the inspection frame; flight B's cloud, livetraj and poses are written in its own frame (inverse of `transform` applied), flight A's in the inspection frame. Three POIs: P1 one snapshot (High, tags `['corrosion']`, wall distance true); P2 two snapshots (Low then Critical, wall distance off by 2 m on one); P3 one snapshot with `criticality: null`, `wall_distance: null`, aimed through a gap in the wall (no hit). Every JSON gets a `.json.<ms>.backup` sibling with different content. Images: 8 x 6 px JPGs (`<id>_rgb.jpg`, `result_annotated.jpg`). Log file names end `_obcbag.bag` (2024) or `_obcbag.mcap` (2025), 0 bytes; one empty `000_0001.MOV`. `YAW_20_SHIFT` is a row-major yaw of 20° plus (0.4, -0.3, 0.05) m. LAS: 1.4, format 1, scale 0.001, written with numpy (no laspy dependency in tests).
- [ ] **Step 1: Failing test** `test_synth_layout_and_links`: the five folders exist; `flights/*/flight.json` `inspection_id` equals the inspection id; one `map.json` has `parent_type == 'Inspection'`; the LAS header reads version 1.4, format 1, `points` records; flight B's `transform.v` has 16 numbers.
- [ ] **Step 2: Run** `"E:\Dev\AIO Software\python\.venv\Scripts\python.exe" -m pytest python/tests/test_flyability_synth.py -q` (from the worktree). Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `make_export`.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit** `test(pipelines): synthetic flyability inspector export`.

## Task 4: Export reader (Python)

**Files:**

- Create: `python/src/aio_pipelines/flyability/__init__.py`, `python/src/aio_pipelines/flyability/export.py`, `python/tests/test_flyability_export.py`

**Interfaces:**

- Consumes: Task 3 `make_export`.
- Produces (frozen dataclasses, no audit or location fields at all):
  - `read_export(root: Path) -> Export`; `Export(asset_name: str | None, generation: str, inspections: list[Inspection])`.
  - `Inspection(id, name, merged_cloud: Path | None, flights: list[Flight], pois: list[Poi])`.
  - `Flight(id, name, transform: np.ndarray | None /* 4x4, None for identity or absent */, cloud: Path | None, trajectory: Path | None, datetime_utc: int | None, relocalised: bool)`.
  - `Poi(id, name, description: str, tags: list[str], snapshots: list[Snapshot])`.
  - `Snapshot(id, flight_id, time_us: int, camera_pos: np.ndarray, camera_q: np.ndarray /* x,y,z,w */, drone_pos, drone_q, camera_pitch: float | None, criticality: str | None, comment: str, tags: list[str], wall_distance: float | None, photo: Path | None, annotated: Path | None, points: list[tuple[float, float, str]], image_size: tuple[int, int] | None, folder: Path)`.
  - `read_trajectory(path: Path) -> np.ndarray` (N x 8: t, x, y, z, qx, qy, qz, qw; `quality` dropped).
- [ ] **Step 1: Failing tests**:
  - `test_reads_links`: one inspection, two flights, three POIs; P2 has two snapshots; `merged_cloud.name == 'inspection_map1.las'`.
  - `test_ignores_backups`: values equal the live files, never the `.backup` content.
  - `test_transform_row_major`: flight B `transform[:3, 3]` equals `(0.4, -0.3, 0.05)`; flight A `transform is None`.
  - `test_no_private_fields`: `repr(export)` contains neither `operator@example.invalid` nor `12.3456789`.
  - `test_both_generations`: `read_export` on a `'2024'` synth gives `generation == '2024-bag'`, the same counts.
  - `test_trajectory_columns`: `read_trajectory(...).shape[1] == 8`, sorted by t.
  - `test_missing_parts`: a flight with no map gives `cloud is None` and `trajectory is None`; a snapshot whose `poi_id` names no POI is attached to a synthetic POI with `name = 'Snapshot <first 8 of id>'`.
- [ ] **Step 2: Run** `... -m pytest python/tests/test_flyability_export.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** with `json` + `pathlib`; take only `*/X.json` (exact name, so backups never match); generation from the log file suffix.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): read flyability inspector exports`.

## Task 5: Frames and ray cast (Python)

**Files:**

- Create: `python/src/aio_pipelines/flyability/frames.py`, `python/tests/test_flyability_frames.py`

**Interfaces:**

- Produces:
  - `apply(m: np.ndarray | None, pts: np.ndarray) -> np.ndarray` (N x 3; `None` returns `pts`).
  - `apply_pose(m, pos: np.ndarray, q: np.ndarray) -> tuple[np.ndarray, np.ndarray]` (position and x,y,z,w quaternion turned by `m[:3,:3]`).
  - `to_scene(p) -> p'`: `(x, y, z) -> (x, z, -y)` (data-conventions §1 with origin 0).
  - `view_axis(q) -> np.ndarray`: the camera's +x in the space frame.
  - `three_camera_q(q_fly_cam) -> list[float]`: the scene-frame three.js camera quaternion (looks along -Z, +Y up). Algorithm: `R = S · R_cam · C` with `S = [[1,0,0],[0,0,1],[0,-1,0]]` and `C` whose columns are three's X, Y, Z in the Flyability camera frame: `(0,-1,0)`, `(0,0,1)`, `(-1,0,0)`.
  - `camera_from_body(pos, q, pitch_deg, lever=LEVER_ARM) -> tuple[pos, q]` with `LEVER_ARM = (0.2986, 0.0077, -0.0202)` and `R_cam = R_body · Ry(-pitch_deg)`.
  - `cast(points: np.ndarray, origins: np.ndarray, dirs: np.ndarray, max_m: float = 30.0) -> np.ndarray` (K hit distances, `nan` for no hit). Algorithm: one `cKDTree` over the points; march each ray from 0.1 m in 0.02 m steps, query radius `0.03 + 0.005 * t`, first step with a point gives `t`; vectorise the steps per ray with `query_ball_point(..., return_length=True)`. Budget: 20 M points, 100 rays under 60 s on the founder PC (tree build dominates; subsample the cloud to a 1 cm grid first when over 5 M points).
  - `location_check(hit_m: float, wall_m: float | None) -> Literal['agrees', 'disagrees', 'no-hit', 'unchecked']`: `nan` hit gives `'no-hit'`; `None` wall gives `'unchecked'`; `'disagrees'` when `abs(hit - wall) > max(0.3, 0.25 * wall)`.
- [ ] **Step 1: Failing tests**:
  - `test_apply_matches_row_major`: yaw 90° with translation (1, 2, 3) maps (1, 0, 0) to (1, 3, 3).
  - `test_view_axis_is_plus_x`: identity q gives (1, 0, 0).
  - `test_camera_from_body_matches_snapshot`: body at origin, identity, pitch -24 gives position `LEVER_ARM` and a view axis with z = `-sin(24°)` (±1e-6).
  - `test_three_camera_q_looks_east`: identity Flyability camera gives a three quaternion that turns (0, 0, -1) into (1, 0, 0) and (0, 1, 0) into (0, 1, 0).
  - `test_to_scene`: (1, 2, 3) to (1, 3, -2).
  - `test_cast_hits_wall`: a plane of points at x = 5, a ray from origin along +x gives 5 ± 0.03; a ray along -x gives `nan`.
  - `test_location_check`: `(5.0, 5.2) == 'agrees'`, `(5.0, 2.0) == 'disagrees'`, `(nan, 3.0) == 'no-hit'`, `(5.0, None) == 'unchecked'`.
- [ ] **Step 2: Run** `... -m pytest python/tests/test_flyability_frames.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): flyability frames and ray cast`.

## Task 6: Detect and scan an export (TypeScript)

**Files:**

- Create: `packages/project/src/builder/flyability/scan.ts`, `scan.test.ts`, `fixture.ts` (JSON-only layout writer for TS tests, mirrors Task 3's ids and links)
- Modify: `packages/project/src/builder/index.ts` (exports)

**Interfaces:**

- Consumes: `InspectorScan` (Task 2), `spacesOf` (Task 1).
- Produces: `findInspectorExport(path: string): Promise<string | null>` (the folder itself or one direct child folder that holds `flights/`, `maps/`, `pois/` and `snapshots/` directories); `scanInspectorExport(root: string, manifest: ProjectManifest | null): Promise<InspectorScan>` (`importedAs` = the space whose `source.inspectionId` matches); `writeInspectorFixture(dir: string, opts?: { generation?: '2024' | '2025'; transform?: boolean }): Promise<FixtureIds>`.
- [ ] **Step 1: Failing tests**: `'finds the export in the folder or a direct child'`; `'a folder without pois/ is not an export'`; `'scan lists inspections, flights, alignment and finding counts'` (flight B `aligned: 'transform'`, finding count = POIs = 3); `'scan marks an inspection already imported as a space'`; `'scan skips backup files and holds no e-mail'` (`JSON.stringify(scan)` lacks the fixture e-mail).
- [ ] **Step 2: Run** `pnpm vitest run packages/project/src/builder/flyability`. Expected: FAIL.
- [ ] **Step 3: Implement** (reads only `inspection.json`, `flight.json`, `map.json`, `poi.json` and counts snapshot folders by `poi_id`; never opens LAS or video).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): detect and scan flyability inspector exports`.

## Task 7: Confined-space severity template and kept findings on re-import

**Files:**

- Modify: `packages/project/src/builder/templates.ts`, `templates.test.ts`, `packages/project/src/import/keep.ts`, `keep.test.ts`

**Interfaces:**

- Produces: `CONFINED_SPACE_TEMPLATE: SeverityTemplate` with model id `confined-space-4`, name "Confined-space inspection (Low to Critical)", levels `1 Low #78b3d6`, `2 Medium #ebc751`, `3 High #f0904f`, `4 Critical #f05653` (criteria one line each), `uncertain: { label: 'Not rated', color: '#9aa3ad' }`; catalogue `{ id: 'confined-space', name: 'Confined-space findings', assetType: 'confined-space', classes: [{ id: 'finding', label: 'Finding', severityModel: 'confined-space-4' }] }`; `severityTemplates` lists it after the general template. `mergeImportedIssues(existing, imported, opts?: { keepMissing?: boolean })`: with `keepMissing`, untouched imported issues missing from the new import stay (default unchanged so the three old converters behave as before).
- [ ] **Step 1: Failing tests**: `'the confined-space template is offered'`; `'keepMissing keeps untouched imports the source no longer has'`; `'default still drops them'` (existing behaviour pinned).
- [ ] **Step 2: Run** `pnpm vitest run packages/project/src/builder/templates.test.ts packages/project/src/import/keep.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): confined-space severity template and kept findings on re-import`.

## Task 8: Findings and their merge (Python)

**Files:**

- Create: `python/src/aio_pipelines/flyability/findings.py`, `python/tests/test_flyability_findings.py`

**Interfaces:**

- Consumes: Task 4 `Poi`, `Snapshot`; Task 5 `location_check`.
- Produces:
  - `SEVERITY = {'Low': 1, 'Medium': 2, 'High': 3, 'Critical': 4}`; `worst(snapshots) -> int | Literal['uncertain']` (null everywhere gives `'uncertain'`).
  - `category_classes(pois, catalogue: dict) -> tuple[dict, dict[str, str]]`: adds one class per distinct tag (POI tags first, else the snapshots' tags; id = slug of the tag, label = the tag) to the catalogue, returns the catalogue and POI id to class id (`'finding'` when untagged).
  - `build_issue(poi, ctx: FindingContext) -> dict`: id `fly-<poi id>`; `code` the next free `F##` (an existing issue with that id keeps its code); `source: 'import'`; `author: 'Flyability Inspector'`; `title` = first non-empty snapshot comment, else POI description, else POI name; `note` = POI name, description and every comment, one per line; `createdAt == updatedAt` = import time; sightings in order: (1) `{ on: 'pointcloud', layer: <hit layer>, geom: { type: 'point3', p: <scene point> } }`, (2) per snapshot `{ on: 'image', layer: <photos layer>, photo: <snapshot id>, geom: { type: 'point', x: nx * w, y: ny * h } }` for each annotation point (a whole-image `box` when there is none), (3) per snapshot with an annotated image `{ on: 'image', layer: <photos layer>, photo: '<snapshot id>-annotated', geom: <whole-image box> }`; `external` per Task 1 (snapshots = all ids, `flight`, `capturedAt` from `flight.datetime_utc` plus the snapshot's offset from `phase_start_time` when both exist, else absent; distances of the worst snapshot). `FindingContext` carries the hit per snapshot, the scene point per snapshot, layer ids, the severity model id and the existing codes.
  - `merge_issues(existing: list[dict], imported: list[dict]) -> tuple[list[dict], dict[str, int]]`: the rules of `mergeImportedIssues` with `keepMissing` (Task 7); counts `added`, `refreshed`, `kept_edited`, `kept_missing`.
- [ ] **Step 1: Failing tests**:
  - `test_one_finding_per_poi`: three issues for three POIs; P2 has two image sightings groups and `severity == 4` (Critical beats Low).
  - `test_null_criticality_is_uncertain`: P3 `severity == 'uncertain'`.
  - `test_category_from_tags`: P1 `classId == 'corrosion'` and the catalogue gained `{ id: 'corrosion', label: 'corrosion' }`; P3 `classId == 'finding'`.
  - `test_annotation_points_in_pixels`: normalised (0.5, 0.25) on a 4000 x 3000 image gives (2000, 750).
  - `test_external_checks`: P1 `'agrees'`, P2 `'disagrees'`, P3 `'no-hit'` with its point at camera + 1 m along the view axis.
  - `test_merge_keeps_edits_and_missing`: an existing `fly-<P1>` with `updatedAt` later than `createdAt` and a moved point is returned unchanged; an untouched `fly-<P2>` is refreshed; an untouched `fly-<gone>` stays; a human issue stays; counts match.
  - `test_issue_json_shape`: every built issue validates against the TS `Issue` schema through the shared fixture check the pipelines already use for issues (`python/tests/export_fixtures.py` pattern), or, if none exists, required keys and the code regex `^[A-Z]{1,3}\d{2,4}$`.
- [ ] **Step 2: Run** `... -m pytest python/tests/test_flyability_findings.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): flyability findings with worst severity and kept edits`.

## Task 9: The `flyability.import` job (Python)

**Files:**

- Create: `python/src/aio_pipelines/flyability/pipeline.py`, `python/tests/test_flyability_import.py`
- Modify: `python/src/aio_pipelines/pointcloud.py` (`prepare_las` gains `matrix: list[float] | None = None`, added as a PDAL `filters.transformation` stage with the row-major `matrix` before the writer; no `a_srs` and no reprojection when `epsg` is None), `python/tests/test_pointcloud_zpc.py` or a new `test_pointcloud_matrix.py`, `python/src/aio_pipelines/pipelines.py` (register), `python/pyproject.toml` (version `<PACK_VERSION>`)

**Interfaces:**

- Consumes: Tasks 4, 5, 8; `FlyabilityImportParams` (Task 2); `prepare_las`/`build_copc` (`pointcloud.py:228`, `:518`); `safe_project_path`, `atomic_write_json`.
- Produces: `FlyabilityImport` pipeline, steps `read`, `clouds`, `paths`, `photos`, `locate`, `findings`, `register`; result `{ spaces: [{ id, name, layers: [ids] }], findings: { added, refreshed, kept_edited, kept_missing, disagree, no_hit } }`. Per selected inspection:
  - space id: the `params.spaces` entry, else an existing space with `source.inspectionId`, else `fly-<first 8 of inspection id>`; `crs { local: 'flyability' }`, origin `[0, 0, 0]`, `source { kind: 'flyability', inspectionId, assetName }`.
  - clouds: `clouds/flyability/<spaceId>/<flight name slug>.copc.laz` per selected flight with the flight's `transform` as `matrix`; `merged.copc.laz` for the merged cloud without one. Layers `fly-<spaceId>-<flight 8>-cloud` "Flight #n cloud" and `fly-<spaceId>-merged` "Merged cloud", `format: 'copc'`, `space`. A layer whose COPC exists with the same source size is kept as is.
  - paths: `imports/flyability/<spaceId>/<flight 8>.flight.json` (`aio.flight/1`, samples from the livetraj after `apply_pose` and `to_scene`, `q` from `three_camera_q(camera_from_body(..., pitch 0))`, `lens { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 }`), layer `fly-<spaceId>-<flight 8>-path` "Flight #n path", `flight`, `bootStartS`, `space`.
  - photos: copy `<id>_rgb.jpg` to `imports/flyability/<spaceId>/photos/<snapshot id>.jpg` and `result_annotated.jpg` to `<snapshot id>-annotated.jpg`; one `photos` layer `fly-<spaceId>-photos` "Finding photos" with `PhotoRef` `pos`/`q` from the transformed `camera_pose` (scene frame, `three_camera_q`), lens `ftheta` 114°; never copies `.MOV`, `.bag`, `.mcap`, `.stn` or thermal files.
  - locate: transform each snapshot's camera pose by its flight's `transform`, cast into the merged cloud's points (read from the source LAS) or, without one, the union of the space's transformed flight clouds; hit layer = merged layer, else the snapshot's flight cloud layer.
  - findings: `merge_issues` on `issues.json` (`{ schema: 'aio.issues/1', issues }`), written atomically with the previous file kept as `issues.json.bak`.
  - register: one manifest write (spaces, layers, the `confined-space-4` model and catalogue from params when absent), `manifest.json.bak` kept, as `pointcloud.py:741-802` does.
- [ ] **Step 1: Failing tests** (synthetic export into a temp project made from the `newProjectManifest`-shaped fixture; PDAL tests skip when `find_pdal()` is None, as `test_pointcloud_zpc.py` does):
  - `test_prepare_las_applies_matrix`: a 3-point LAS through `prepare_las(..., matrix=YAW_20_SHIFT)` reads back transformed (±1 mm).
  - `test_import_one_space_per_inspection`: manifest gains one space with `crs == {'local': 'flyability'}`, layers: two flight clouds, merged cloud, two paths, one photos layer, all with `space`.
  - `test_transformed_flight_lands_aligned` (Review Focus 2): flight B's COPC bounds, its path samples and P1's scene point (P1 is on flight B) each lie within 0.05 m of where the synthetic room puts them; without the transform the test fixture would be 0.4 m and 20° off.
  - `test_privacy`: no file under the project contains `operator@example.invalid` or `12.3456789`, and no `.MOV`/`.bag`/`.mcap` was copied.
  - `test_reimport_keeps_edits` (Review Focus 3): run, edit `fly-<P1>` (move the point, set `updatedAt`), run again: P1 unchanged, no layer duplicated, result counts `kept_edited == 1`.
  - `test_without_merged_cloud`: `merged=False` synth: points hit the flight clouds; no merged layer.
  - `test_2024_generation`: the same counts on a `'2024'` synth.
- [ ] **Step 2: Run** `... -m pytest python/tests/test_flyability_import.py python/tests/test_pointcloud_matrix.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement**; ask the coordinator for `<PACK_VERSION>` and write it in `pyproject.toml`.
- [ ] **Step 4: Run** the two files, then the full Python suite the CI way (`... -m pytest python/tests -q -x`), and `ruff format` + `ruff check` on the new files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): flyability inspector import job`.

## Task 10: Route exports through the import (main process)

**Files:**

- Modify: `packages/project/src/builder/raw.ts` (before the extension ladder), `packages/project/src/builder/raw.test.ts`, `apps/desktop/src/main/builder.ts:376` (`builderImport`; new `builderInspectorScan`), its IPC registration, `apps/desktop/src/main/builder.test.ts`, `apps/desktop/src/main/library.ts:183` (label and new-project path), `apps/desktop/src/renderer/processing/pipelines.ts` (job title and icon mapping, data only)

**Interfaces:**

- Consumes: Task 2 contracts, Task 6 `findInspectorExport`/`scanInspectorExport`, Task 7 `CONFINED_SPACE_TEMPLATE`.
- Produces: `builderImport` checks each request path with `findInspectorExport` before `expandFor`; a hit is never expanded file by file. With `req.inspector` it queues `flyability.import` (`severityModel` from the project's `confined-space-4` model, else `CONFINED_SPACE_TEMPLATE.model`; `catalogueId: 'confined-space'`) and returns one item `{ kind: 'flyability', status: 'queued', jobId }`; without `req.inspector` it returns `{ kind: 'flyability', status: 'skipped', message: 'Choose the inspections to import.' }` so the renderer opens the picker; with no pipeline pack, `needs-pipeline`. `builderInspectorScan(req, d)` returns the scan. Library: an export folder dropped on the library creates a project `{ crs: { local: 'flyability' }, origin: [0, 0, 0], purpose: 'confined-space', severity template CONFINED_SPACE_TEMPLATE }` named after the asset (else the folder) and returns it for the picker; `library.ts` labels it "Flyability Inspector export".
- [ ] **Step 1: Failing tests**: `raw.test.ts` `'an inspector export folder is not imported file by file'`; `builder.test.ts` `'an inspector export queues one flyability job with the chosen inspections'` (fake jobs runner sees `flyability.import` with `inspections`, `severityModel.id == 'confined-space-4'`), `'without a choice it asks for the inspections'`, `'without the pipeline pack it says so'`, `'scan answers for an open project'`.
- [ ] **Step 2: Run** `pnpm vitest run packages/project/src/builder/raw.test.ts apps/desktop/src/main/builder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): import flyability inspector exports through add data`.

## Task 11: Moving a finding point (core)

**Files:**

- Create: `packages/annotate/src/findingPoint.ts`, `findingPoint.test.ts` (or the folder where `packages/annotate` keeps sighting edits; follow its layout)

**Interfaces:**

- Consumes: `Issue`, `ExternalFinding` (Task 1).
- Produces: `moveFindingPoint(issue: Issue, layer: string, p: Vec3, now: string): Issue` (replaces the first `pointcloud` `point3` sighting, adds one if none, sets `updatedAt = now`, and `external.locationCheck = 'moved'` when `external` exists); `findingPoint(issue: Issue): { layer: string; p: Vec3 } | null`.
- [ ] **Step 1: Failing tests**: `'moving replaces the point and marks the check moved'`; `'an issue without a cloud point gains one'`; `'a moved imported issue counts as edited for the merge'` (`updatedAt !== createdAt`).
- [ ] **Step 2: Run** `pnpm vitest run packages/annotate/src/findingPoint.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(annotate): move a finding's 3d point`.

## Gate before Batch D: confirm placement with the UI Wave 2 session via the coordinator

- [ ] SendMessage the coordinator: list the four UI pieces below and ask where UI Wave 2 wants them (its tools registry, the data-driven right-panel sections in `apps/desktop/src/renderer/workspace/workbench/tabsModel.ts`, the shared right-click action registry in `apps/desktop/src/renderer/shell/actions/`). Rebase onto local `main` after Wave 2 lands. Write the answer (exact files) into Tasks 12 and 13 before starting them. Never edit shell, island or palette files.

## Task 12: Space switcher and flight lines in 3D (renderer)

**Files:** decided at the gate. Expected: one new section in `tabsModel.ts`'s data (space list), a new `renderer/spaces/` folder (`activeSpace.ts` store + `SpaceSwitcher.tsx`), the scene layer filter, and a `flightline` drawer next to the walk path drawer.

**Interfaces:**

- Consumes: `spacesOf`, `layersOfSpace`, `spaceOfIssue` (Task 1); the `flightline` layer.
- Produces: `activeSpace` (per project, kept in the view state; default the first of `spacesOf`); the scene, layer tree, issue list and map show only the active space's layers and issues; the map and globe are hidden for a `local` CRS space; flight lines draw as polylines from the pose file with the layer colour (default the survey-date palette by flight order).
- [ ] **Step 1: Failing tests** (vitest, renderer models): `'one space hides the switcher'`; `'switching space filters layers and issues'`; `'a local space has no map view'`; `'a flight line builds a polyline from its pose file in scene metres'`.
- [ ] **Step 2: Run** the new test files. Expected: FAIL.
- [ ] **Step 3: Implement**; load the `impeccable` and `frontend-design` skills first.
- [ ] **Step 4: Run**, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): switch spaces and draw flight lines`.

## Task 13: Inspection picker and finding point editing (renderer)

**Files:** decided at the gate. Expected: the Add data flow's dialog host (picker dialog in a new `renderer/flyability/InspectorPicker.tsx`), a right-click action "Move point" in `shell/actions/` registry, and the finding panel row showing the location check.

**Interfaces:**

- Consumes: `builder:inspectorScan`, `builder:import` `inspector` (Task 2); `moveFindingPoint` (Task 11).
- Produces: the picker lists inspections (name, flights with ticks, merged cloud yes/no, findings count, "already imported, will merge" when `importedAs`); Import sends the choice. "Move point" on a finding: the next click on the cloud moves it (writes through `project:writeIssues`). The finding panel shows "Wall distance 3.1 m, point 3.2 m away" and a warning when `locationCheck` is `disagrees` or `no-hit`.
- [ ] **Step 1: Failing tests**: `'the picker preselects new inspections and marks imported ones'`; `'move point writes the moved issue'`; `'a disagreeing finding shows the warning'`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): pick inspections and move finding points`.

## Task 14: End to end

**Files:**

- Create: `apps/desktop/e2e/flyability-import.spec.ts`

**Interfaces:**

- Consumes: everything; the synthetic export is generated in `beforeAll` by running `python -I python/tests/flyability_synth.py <tmp>` with `QUADRION_E2E_PYTHON`.
- [ ] **Step 1: Write the specs**: `'imports a synthetic export as a space with clouds, paths and findings'` (open a fresh project, Add data with the export folder, the picker shows one inspection, Import, wait for the job, the space switcher is absent or shows the space, three findings in the list, one flagged); `'moving a finding point survives a re-import'`; `@realdata 'imports a real export'` that skips via `hasRealData('flyability')` (the env-configured real data root, no path in the repo).
- [ ] **Step 2: Run the CI way** from `apps/desktop`: `pnpm demo:build --quick`, `pnpm demo:change --quick`, then (PowerShell) `$env:QUADRION_WINDOW_SIZE='1100x720'; $env:QUADRION_E2E_SCALE='1'; $env:QUADRION_E2E_SWGL='warp'; $env:QUADRION_E2E_PYTHON='E:\Dev\AIO Software\python\.venv\Scripts\python.exe'; npx playwright test e2e/flyability-import.spec.ts --workers=1`. Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`; 2 passed, 1 skipped (or 3 passed with real data).
- [ ] **Step 3: Commit** `test(e2e): flyability inspector import`.
- [ ] **Step 4:** `/wrapup` on this branch, then `node tools/agent/finish-task.mjs` and hand over to the coordinator with the "How to test" steps.

---

## Execution DAG

| Task | Depends on         | Packages / areas                                               |
| ---- | ------------------ | -------------------------------------------------------------- |
| 1    | none               | `@aio/schema` (manifest, layers, annotation, spaces), docs     |
| 2    | none               | `@aio/schema` (builder, ipc, jobs), contract-changes           |
| 3    | none               | `python/tests`                                                 |
| 4    | 3                  | `python` flyability/export                                     |
| 5    | none               | `python` flyability/frames                                     |
| 6    | 1, 2               | `@aio/project` builder/flyability                              |
| 7    | none               | `@aio/project` templates, import/keep                          |
| 8    | 4, 5               | `python` flyability/findings                                   |
| 9    | 2, 4, 5, 8         | `python` flyability/pipeline, pointcloud, pipelines, pyproject |
| 10   | 1, 2, 6, 7         | `@aio/project` raw, `apps/desktop` main, renderer/processing   |
| 11   | 1                  | `@aio/annotate`                                                |
| 12   | 1, 10, UI gate     | `apps/desktop` renderer                                        |
| 13   | 2, 10, 11, UI gate | `apps/desktop` renderer                                        |
| 14   | 9, 12, 13          | `apps/desktop/e2e`                                             |

Tasks 1 and 2 share `contract-changes.md`: Task 2 adds its row after Task 1 commits (or both rows are written by Task 1 to keep the batch free of shared files). The plan takes the second: **Task 1 writes both contract rows.**

**Parallel batches** (no shared files inside a batch; dispatch each batch in one message):

- **Batch A:** Tasks 1, 2, 3, 5, 7.
- **Batch B:** Tasks 4, 6, 11.
- **Batch C:** Tasks 8, 10 (then Task 9 once Task 8 is in; Task 9 and Task 10 touch no common file, so Task 9 may run beside Task 10).
- **Gate:** confirm UI placement with UI Wave 2 via the coordinator (can be asked during Batch A; the answer is needed only for Batch D).
- **Batch D (last):** Tasks 12, 13 (separate renderer files per the gate answer; if the gate puts both in one file, run them in sequence).
- **Batch E:** Task 14.

**Critical path:** 3 → 4 → 8 → 9 → 14 on the Python side, joined by 1/2 → 6 → 10 → 12/13 → 14 on the app side; the longest is **3 → 4 → 8 → 9 → 14** (the job and its PDAL tests are the biggest pieces), with Batch D also waiting on the UI Wave 2 gate.

## Tests per task, e2e and contracts at a glance

- Unit tests: as named in each task (vitest for TS, pytest for Python).
- E2E added: `apps/desktop/e2e/flyability-import.spec.ts` (synthetic, plus a `@realdata` case that skips). No existing spec changes.
- Contract changes (one row each in `docs/architecture/contract-changes.md`, data-conventions §40): `Crs.local`; `ProjectManifest.spaces`; `Layer.space`; layer kind `flightline`; `Issue.external`; `ImportItem.kind 'flyability'`; IPC `builder:inspectorScan`; `builder:import.inspector`; job `flyability.import` (pipeline pack `<PACK_VERSION>` from the coordinator); `pointcloud.prepare_las` matrix (internal, no job param change).

## How to test (for the founder, after Batch E)

1. Run `pnpm dev`, open the library, choose Import and pick a Flyability Inspector export folder: a new project opens and the inspection picker lists its inspections and flights.
2. Leave all ticked and choose Import; the Processing drawer shows "Flyability Inspector import" running, then done.
3. In 3D: each flight's cloud and the merged cloud are separate layers that can be hidden; flight lines run through the cloud.
4. Open Findings: one finding per POI, with severity (Critical/High/Medium/Low, "Not rated" for older exports), category from the POI tags, the photo and the annotated photo; a finding whose wall distance disagrees with its cloud point shows a warning.
5. Right-click a finding, Move point, click the cloud: the marker moves. Import the same folder again into this project: the moved point and any edits stay.
6. Import a second export of another chamber into the same project: a space switcher appears; switching shows only that chamber.
