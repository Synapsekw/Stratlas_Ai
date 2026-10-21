# Thermal analysis: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is test first: write the failing test, run it and see it fail for the stated reason, then make it pass.

**Goal:** Read every pixel of a supported drone thermal photo as degrees Celsius, analyse it in a **Thermal bench** (readings, palettes, range, isotherm, visual twin), find hot spots on equipment automatically or by hand, turn each confirmed hot spot into an ordinary issue with a pin on the map and in 3D, and print them in a "Thermal hot spots" report section and a CSV.

**Spec:** `docs/superpowers/specs/2026-10-21-thermal-analysis-design.md` (the approved design). Read it before any task. This plan argues from it; where the plan departs from it, "Departures from the design" says why.

**Base and order.** Worktree `E:\Dev\AIO Software\.claude\worktrees\thermal-analysis`, branch `feat/thermal-analysis`, off `main`. Every path below is relative to it. The parallel branch `feat/photo-position-edit` (`docs/plans/2026-10-21-photo-position-edit.md`) adds the XMP-inside-Exif reader fix, `packages/project/src/builder/thermalTwin.ts` (`needsTwin`, `findTwin`, `twinFix`), the synthetic XT2 JPEG helpers `packages/project/src/builder/xt2Fixture.ts` (`xt2Visual`, `xt2Thermal`) and corrected photo positions through `correctedPhoto`. **This branch rebases onto `main` after photo position edit lands and before any M2 task starts** (M2 imports the twin code; M3 places pins at corrected positions). M1 does not touch any file that branch changes, so M1 can be built before it lands; rebase before M1's merge anyway.

**Architecture:** The physics lives once, in the pipeline pack: a `thermal.decode` job writes one float32 °C raster per photo plus a small JSON beside it, under a new top-level project folder `thermal/` that older builds ignore. The renderer reads those rasters over `aio://project/...` and does everything visual (palette lookup, range, isotherm, readings) in TypeScript with no job. All person-made thermal state (settings per photo, readings, hot spots, references, severity thresholds, alignment nudges) lives in one sidecar `thermal/thermal.json` (`aio.thermal/1`). A confirmed hot spot is also an ordinary `Issue` in `issues.json` with image sightings, class "Hot spot" and severity model "Thermal ΔT"; its temperatures stay in the sidecar, keyed by the issue id.

**Tech stack:** TypeScript strict, zod (`@aio/schema`), React 19 + zustand, canvas 2D, MapLibre via `@aio/maps`, Vitest, Playwright with Electron, Python 3.13 (`aio_pipelines`, numpy, scipy, pillow, ctypes), pytest; prebuilt ExifTool (Windows standalone) and DJI Thermal SDK 1.7 (Windows DLLs) bundled in the pack.

## Milestones (one PR each)

| PR  | Milestone             | Lands                                                                                                                                                                          | Pack   | App        |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------- |
| M1  | Decoders and settings | `aio.thermal/1` and raster contracts, FLIR and DJI decoders, ExifTool and TSDK in the pack with notices, `thermal.decode` job, bench shell with palette, hover °C and settings | 0.21.0 | next minor |
| M2  | Bench tools           | Spot, box, line (profile), polygon, isotherm, range drag, view switch with the visual twin, lens table and nudge                                                               | none   | next minor |
| M3  | Hot spots and issues  | `thermal.hotspots` job, list (confirm, dismiss, reference, add to existing), "Thermal ΔT" grading with editable levels, issues, map and 3D pins                                | 0.22.0 | next minor |
| M4  | Report and CSV        | `thermal` report section, `thermal-csv` export                                                                                                                                 | none   | next minor |

Pack numbers assume photo position edit takes 0.20.0 (it bumps for its ODM change); if `main` holds a later pack at merge time, take the next minor. App numbers: the next minor after `main` at merge time (0.25.0 is taken by the measurement-dates train). Each milestone is the bump rule of `docs/release/README.md:24-30`: version in `python/pyproject.toml`, then `uv lock` in `python/`; `APP_RANGE` (`python/src/aio_pipelines/__init__.py:24`, `>=0.22.0 <2.0.0`, pinned by `python/tests/test_app_range.py:28`) stays; `apps/desktop/src/main/jobs/packVersions.test.ts` must stay green.

**M4 can be built in parallel with M2 and M3** on its own branch (`feat/thermal-report`) once M1 lands, because M1 fixes every sidecar shape the report reads. It merges after M3 (it needs confirmed hot spots to show anything in the e2e).

## Global Constraints

- Windows only. Offline: nothing here calls a web service at run time. Prebuilt binaries only (ExifTool standalone Windows build, DJI TSDK 1.7 Windows DLLs, January 2025), pinned by URL and sha256 in a lock file, as ffmpeg is (`tools/pipeline-pack/ffmpeg-lock.json`).
- **Degrees Celsius only.** Temperatures stored and shown in °C, one decimal in the UI and CSV, full float in files.
- **Defaults (design):** emissivity 0.95; distance = the photo's height above take-off when known (`dji.relAlt`, or `pos` height minus the take-off height of the project's height rule), else 10 m; air 25 °C; humidity 50 %; reflected temperature = air temperature (stored as `null`).
- **Severity defaults (design):** model "Thermal ΔT", levels Watch (ΔT 4 to 15 °C), Serious (16 to 40 °C), Critical (above 40 °C). Below 4 °C detection proposes nothing; a hand-confirmed hot spot below 4 °C is Watch. Levels, names and thresholds editable per project.
- **Twin rule (shared, not rewritten):** XT2 `_R` photos pair by `findTwin` from `thermalTwin.ts` (number N + 1, then N - 1, within 3 s). DJI R-JPEG thermals (`_T`) pair with `_W`, `_Z` or `_V` of the same number within 3 s, added to the same file in M2.
- **No wrong temperature shown as right:** a photo whose decode fails the cross-check or the plausibility bounds gets no raster and no numbers, only the reason. Bounds: every finite value in -70 to 1000 °C, and the photo median in -40 to 80 °C.
- **Nothing becomes an issue unless a person confirms it.** Settings changes re-read numbers; they never delete a reading, hot spot or issue, and a person's title, note and status stay.
- Read-only projects and `.aio` packages: the bench opens read-only; it shows temperatures only where rasters already exist and otherwise says "Open the project folder to analyse thermal photos." No decode or sidecar write.
- UI: `@aio/ui` parts, tokens `--sp-*`, `--z-*`, `--el-*`; strings in `packages/ui/src/i18n/en.ts` under `thermal.*` (dotted keys, `_one`/`_other` plurals, no em or en dashes); the CSS guard forbids `title=` tooltips and raw spacing, z-index and shadow values. Load the `impeccable` and `frontend-design` skills before any UI task; the layout follows the thermal bench mockup (tool rail, stage with palette bar and view switch, settings line, hot-spot list, filmstrip).
- TypeScript strict, no `any`, no non-null assertions; renderer never imports `electron` or `node:*`. Python: `ruff format` and `ruff check` yourself; tests through the main checkout's venv (`E:\Dev\AIO Software\python\.venv\Scripts\python.exe -m pytest`), and afterwards check that `aio_pipelines` still imports from the main checkout (never junction the main venv).
- Public repo: no client, site, tester or person names, and never the private sample folder's name or path, in code, fixtures, docs or commit messages. Fixtures are synthetic or DJI SDK sample images whose licence allows CI use. Run `node tools/agent/check-public-text.mjs <files>` on every doc added or changed.
- e2e: off-screen windows, `--workers=1`, one Playwright run at a time, CI way (`QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp`), `pnpm demo:change --quick` first; pipeline specs need `QUADRION_E2E_PYTHON` pointing at the main checkout's venv.
- Commits: conventional, stage by path, never a bare `git stash`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Departures from the design (decided here)

1. **Temperatures are not `Measurement`s in `issues.json`.** `Measurement.kind` and `unit` are plain `z.enum`s (`packages/schema/src/annotation.ts:119-123`) and `apps/desktop/src/main/project.ts:29` parses the whole file: a `temperature` kind would make every older build refuse the whole `issues.json` ("issues.json is invalid at issues.N.measurements.M.kind"), which breaks the design's own back-compat rule. So peak, mean, reference and ΔT live in the sidecar's hot-spot record, keyed by `issueId`; the issue carries the class, severity, title, note and sightings, so older builds still list, pin (see 2) and report it as an ordinary issue. No schema family bump.
2. **Pins for image-only issues.** `issueAnchor` (`packages/maps/src/overlays.ts:147`) and the 3D anchors (`packages/annotate/src/tools/mesh.ts` `sightingAnchor`/`bestAnchor`, `packages/project/src/export/facts.ts:117`) skip image sightings, so a hot spot would get no pin. M3 adds a last fallback for every issue: the first image sighting's photo at its corrected position (`correctedPhoto`). This also gives existing image-only issues a pin; it is a behaviour change in the contract row. Casting the pixel onto a mesh is left out of this version (follow-up).
3. **Severity levels need one new IPC.** Only `builder:addSeverityModel` exists. M3 adds `builder:updateSeverityModel` (replace one model's levels; refused when it drops a level value an issue uses).
4. **Thermal detection runs from metadata in main, not at import.** A cheap TypeScript probe of the review copy's head (`thermal:probe`) marks thermal photos for the action and the filmstrip, so existing projects need no re-import. Review copies of thermal photos are byte-for-byte copies (640 x 512 and 1280 x 1024 are under the 2560 px resize limit, `packages/project/src/builder/raw.ts:545-549`), so the APP1/APP3 records survive and the decoder reads `photos/<id>.jpg`.
5. **Shipped FLIR decoder is a Python APP1 parser; ExifTool is bundled as the check.** `thermal.decode` cross-checks the raw values of the first photo of each camera model in a run against bundled ExifTool (`-b -RawThermalImage`, `-j` for the constants); any difference marks that model's photos `unverified` with no raster. This keeps the per-photo path fast and in-process while honouring "every decoder is checked against a known value".

## Contract changes

Three rows in `docs/architecture/contract-changes.md` (header `| Date | Change | Why | Streams affected | Approved by |`), one per milestone PR that changes contracts. Exact text:

M1 (task 1.10):

```
| 2026-10-21 | Thermal analysis, additive. New project folder `thermal/` (older builds ignore it): `thermal/thermal.json` (`aio.thermal/1`: `defaults` and per-photo `photos["<layerId>/<photoId>"].settings` {emissivity, distanceM, airC, humidityPct, reflectedC or null = air}; `readings[]`; `hotspots[]` {id, issueId?, state proposed, confirmed or dismissed, origin detection or manual, sightings[] {layer, photo, box, peakC, meanC}, reference {kind surroundings or reading, readingId?, valueC}, peakC, meanC, deltaC, severity, reviewedSeverity?, changedSinceReview?, leaveOut?, note}; `grading.levels[]` {value, minDeltaC}; `alignment[layerId]` {dx, dy, scale}), `thermal/rasters/<layerId>/<photoId>.f32` (little-endian float32 °C, row-major) with `<photoId>.json` (`aio.thermalRaster/1`: width, height, family flir or dji-tsdk, camera, constants?, settings used, clamped[], minC, maxC, medianC, decoder, settingsKey) and `thermal/rasters/<layerId>/index.json` (status per photo: ok, unsupported, unverified, implausible, with reason). `PipelineName` gains `thermal.decode` (`ThermalDecodeParams` {layerId, photos?, force?}; `THERMAL_MIN_PACK = '0.21.0'`). IPC `thermal:probe` {projectId, layerId} to {ok, photos: {photoId, family, make, model}[]}, `thermal:read` {projectId} to {ok, file or null}, `thermal:write` {projectId, file} (atomic, `.bak`, refused for packages and read-only projects). `versions.ts` lists both families. | Thermal analysis M1 (`docs/plans/2026-10-21-thermal-analysis.md`) | @aio/schema, @aio/project, desktop, pipelines, pipeline pack | Founder, thermal analysis design of 2026-10-21; sign-off at merge |
```

M3 (task 3.8):

```
| <merge date> | Thermal hot spots. `PipelineName` gains `thermal.hotspots` (`ThermalHotspotsParams` {layerId, photos?, rule absolute or delta, thresholdC, minAreaPx?, maxPerPhoto?}; writes `thermal/candidates.json`, `aio.thermalCandidates/1`, replaced per run; `THERMAL_HOTSPOTS_MIN_PACK = '0.22.0'`). New IPC `builder:updateSeverityModel` {projectId, model} (replace one model by id; refused when a level value used by an issue is dropped; backed up and journaled like `builder:addSeverityModel`). Behaviour: an issue with no map, mesh or point cloud sighting is pinned on the map and in 3D at its first image sighting's photo, at the photo's corrected position; older builds show no pin for such issues. A confirmed hot spot is an ordinary issue (class "Hot spot", model `thermal-dt`); its temperatures stay in `thermal/thermal.json`, not in `Issue.measurements` (whose closed enums would make older builds refuse `issues.json`). | Thermal analysis M3 | @aio/schema, @aio/project, @aio/maps, @aio/annotate, desktop, pipelines, pipeline pack | Founder; sign-off at merge |
```

M4 (task 4.4):

```
| <merge date> | Thermal report. `ReportSectionId` gains `thermal` (in `HOUSE_SECTIONS`; offered only when the project has confirmed hot spots not left out; settings saved with it toggled are kept in `reportSectionsExtra` by older builds, the M11 rule). `EXPORT_FORMATS` gains `thermal-csv`, mapped to the existing kind `files`. | Thermal analysis M4 | @aio/schema, @aio/project, desktop | Founder; sign-off at merge |
```

Each contract PR adds a compat test in `tools/compat/` against the newest frozen schema (`tools/compat/schema-0.21`, pattern `pano-stitch-additive.test.mjs`): the old schema still parses every file the new build writes into existing families (`issues.json` with a hot-spot issue, the manifest with the new class and model, settings with `thermal` toggled).

## Packages touched

| Package / area                       | M1         | M2       | M3       | M4       |
| ------------------------------------ | ---------- | -------- | -------- | -------- |
| `@aio/schema`                        | 1.1        |          | 3.1      | 4.1      |
| `@aio/project`                       | 1.6        | 2.2      | 3.4      | 4.1      |
| `@aio/ui` (strings)                  | 1.7        | 2.1      | 3.2      | 4.1      |
| `@aio/maps`                          |            |          | 3.5      |          |
| `@aio/annotate`                      |            |          | 3.5      |          |
| desktop main                         | 1.6        |          | 3.4      | 4.3      |
| desktop renderer `thermal/`, benches | 1.8, 1.9   | 2.3, 2.4 | 3.6, 3.7 | 4.2, 4.3 |
| `python` (`aio_pipelines/thermal`)   | 1.2 to 1.5 |          | 3.3      |          |
| pipeline pack build, release notices | 1.4        |          |          |          |
| e2e, docs                            | 1.10       | 2.5      | 3.8      | 4.4      |

---

# M1: Decoders and settings

## M1 Execution DAG

```
1.1 schema ───────────┬──────────────> 1.5 decode job ──┐
1.2 FLIR decoder ─────┤                                 │
1.3 DJI binding ──────┤                                 ├─> 1.10 e2e + docs ─> 1.11 verify
1.4 pack tools+notices┘                                 │
1.1 ─> 1.6 probe + IPC (main) ──┐                       │
1.7 strings ────────────────────┼─> 1.9 bench shell UI ─┘
1.1 ─> 1.8 renderer core ───────┘
```

| Batch | Tasks                   | Files they own (no overlap)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 1.1, 1.2, 1.3, 1.4, 1.7 | 1.1 `packages/schema/src/thermal*`, schema `index.ts`, `versions.ts`, `jobs.ts`, `jobs.test.ts`, `ipc.ts`; 1.2 `python/src/aio_pipelines/thermal/{__init__,flir,physics}.py`, `python/tests/thermal_fixtures.py`, `thermal_reference.py`, `test_thermal_flir.py`; 1.3 `thermal/dji_tsdk.py`, `test_thermal_dji.py`; 1.4 `tools/pipeline-pack/thermal-tools*`, `build.mjs`, `photo/native.py`, `test_native*.py`, `tools/release/native-libs.json`, `notices*`, `native-licences*`; 1.7 `packages/ui/src/i18n/en.ts`, `i18n.test.ts` |
| 2     | 1.5, 1.6, 1.8           | 1.5 `thermal/{pipeline,raster,crosscheck}.py`, `pipelines.py`, `test_thermal_decode.py`, `pyproject.toml`, `uv.lock`; 1.6 `packages/project/src/thermal/*` (new), project `index.ts`, `apps/desktop/src/main/thermal*` (new), main `index.ts`, preload bridge, `renderer/jobs.ts`, `renderer/processing/pipelines.ts`; 1.8 `apps/desktop/src/renderer/thermal/{raster,palettes,colourise,autoRange,settings,thermalStore}*` (new)                                                                                                   |
| 3     | 1.9                     | `workspace/workbench/tabsModel.ts`, `RightSidebar.tsx`, `workbenchStore.ts`, `workspace/island/groups.tsx`, `benches/ThermalBench*` (new), `renderer/thermal/{ThermalStage,PaletteBar,SettingsLine,SettingsEditor,Filmstrip}*` (new), `shell/actions/thermalActions*` (new), `shell/actions/index.ts`                                                                                                                                                                                                                               |
| 4     | 1.10                    | `apps/desktop/e2e/thermal-bench.spec.ts`, `e2e/thermalFixture.ts`, `e2e/thermal-fixture.py` (new), `tools/compat/thermal-additive.test.mjs`, `docs/architecture/contract-changes.md`, `data-conventions.md`, user guide page, `docs/plans/2026-10-21-thermal-analysis*.md`                                                                                                                                                                                                                                                          |
| 5     | 1.11                    | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Critical path:** 1.2 -> 1.5 -> 1.10 -> 1.11 (the FLIR parser and its reference are the riskiest work: getting the raw record offset right is exactly where `flyr` fails). The UI path 1.1 -> 1.8 -> 1.9 runs beside it. Batch 1's Python tasks run their pytest one at a time.

## M1 tasks

### Task 1.1: thermal contracts (`@aio/schema`)

**Files:** `packages/schema/src/thermal.ts` (new), `thermal.test.ts` (new), `index.ts`, `versions.ts`, `jobs.ts`, `jobs.test.ts`, `ipc.ts`

**Interfaces (produces):** `THERMAL_SCHEMA = 'aio.thermal/1'`, `THERMAL_RASTER_SCHEMA = 'aio.thermalRaster/1'`, `THERMAL_CANDIDATES_SCHEMA = 'aio.thermalCandidates/1'`; zod and types `ThermalSettings`, `ThermalFamily = 'flir' | 'dji-tsdk'`, `ThermalPhotoStatus = 'ok' | 'unsupported' | 'unverified' | 'implausible'`, `ThermalRasterMeta`, `ThermalRasterIndex`, `ThermalReading`, `HotSpot`, `HotSpotSighting`, `ThermalReference`, `ThermalGrading`, `ThermalFile`, `ThermalCandidate`, `ThermalCandidatesFile`; `thermalPhotoKey(layerId, photoId): string` (`"<layerId>/<photoId>"`); `DEFAULT_GRADING` (values 1, 2, 3 with `minDeltaC` 4, 16, 40.1; a hot spot takes the highest level whose `minDeltaC` its ΔT, rounded to 0.1 °C, reaches); `ThermalDecodeParams`, `ThermalHotspotsParams` (the latter used in M3); `THERMAL_MIN_PACK = '0.21.0'`; IPC `thermal:probe`, `thermal:read`, `thermal:write`.

- [ ] Failing tests in `thermal.test.ts`:
  - `ThermalSettings` accepts `{ emissivity: 0.95, distanceM: 18, airC: 32, humidityPct: 60, reflectedC: null }`; refuses emissivity 0 or above 1, humidity above 100, distance negative;
  - `ThermalReading.geom` is `point`, `box`, `polygon` (the `ImageGeom` shapes of `annotation.ts`) or `{ type: 'line', points: Vec2[] (min 2) }`; `stats { maxC, minC, meanC }`;
  - `HotSpot` with `state: 'confirmed'` and no `issueId` is refused (refine); `severity` is an int or null; `reference.kind: 'reading'` without `readingId` is refused;
  - `ThermalFile` round-trips a full example and an empty `{ schema, photos: {}, readings: [], hotspots: [] }` (grading and alignment optional; missing grading means `DEFAULT_GRADING`);
  - `ThermalRasterMeta` requires `width * height` positive ints, `settingsKey` a 64-hex string;
  - `DEFAULT_GRADING.levels` equals `[{ value: 1, minDeltaC: 4 }, { value: 2, minDeltaC: 16 }, { value: 3, minDeltaC: 40.1 }]` and the grading refine refuses non-ascending `minDeltaC`.
- [ ] Objects are plain `z.object` (not strict) so later additive fields pass older readers, as `Issue` does.
- [ ] `versions.ts`: rows `{ family: 'aio.thermal', version: 1, home: 'project', where: 'thermal/thermal.json', since: <M1 app version> }` and the same for `aio.thermalRaster` (`thermal/rasters/*/*.json`) and `aio.thermalCandidates` (`thermal/candidates.json`).
- [ ] `jobs.ts`: `thermal.decode` in `PipelineName` and `PIPELINES` (title "Decode thermal photos"), `ThermalDecodeParams` `{ layerId: Id, photos?: Id[], force?: boolean }` in the params map; `jobs.test.ts` name list.
- [ ] `ipc.ts`: the three channels as in the M1 contract row; `Failure` for errors.
- [ ] `pnpm --filter @aio/schema test thermal jobs`, `pnpm typecheck`.

### Task 1.2: FLIR record decoder and physics (Python)

**Files:** `python/src/aio_pipelines/thermal/__init__.py`, `flir.py`, `physics.py` (new); `python/tests/thermal_fixtures.py`, `thermal_reference.py`, `test_thermal_flir.py` (new)

**Interfaces (produces):** `read_flir(path: Path) -> FlirRecord | None` with `FlirRecord(raw: np.ndarray[uint16, (h, w)], planck: Planck(r1, r2, b, f, o), atmos: Atmos(alpha1, alpha2, beta1, beta2, x), make: str, model: str, stored: ThermalSettingsPy)`; `to_celsius(raw: np.ndarray, planck: Planck, atmos: Atmos, settings: ThermalSettingsPy) -> np.ndarray[float32]`; `ThermalSettingsPy` dataclass mirroring `ThermalSettings`.

- [ ] `thermal_fixtures.py`: `make_flir_jpeg(path, temps_c: np.ndarray, planck, atmos, settings, raw_format='tiff' | 'png', model='XT2')` builds a JPEG whose APP1 segments carry a FLIR FFF record split across several `FLIR\0` APP1 chunks (chunk index and count bytes as FLIR writes them), a CameraInfo record with the constants and stored settings, and a RawData record holding the raw image (16-bit TIFF, as the XT2 writes it; PNG variant with FLIR's byte-swapped words). Raw values come from the **inverse** of the reference formula, so the expected temperatures are known.
- [ ] `thermal_reference.py`: an independent, deliberately plain implementation of the standard FLIR formula (atmospheric transmission from distance, air temperature and humidity with Alpha1/2, Beta1/2, X; window omitted; reflected and atmospheric radiance subtracted; Planck inverse `B / ln(R1 / (R2 * (S + O)) + F) - 273.15`), pixel by pixel in plain Python floats. It must not import `physics.py`.
- [ ] Failing tests in `test_thermal_flir.py`:
  - `test_reads_split_app1_record`: `read_flir` on the TIFF fixture returns the exact raw array and constants;
  - `test_png_raw_byte_order`: PNG variant gives the same raw array;
  - `test_matches_reference_to_0_01c` (acceptance 1): over a 64 x 48 field from -20 to 120 °C and three settings sets (emissivity 0.95 / 0.7, distance 1 / 18 / 60 m, humidity 20 / 60 / 95 %), `abs(to_celsius - reference).max() <= 0.01`;
  - `test_round_trip_known_field`: decode of a fixture built from a known field returns it within 0.05 °C;
  - `test_not_flir_returns_none`: a plain JPEG, a truncated record, and a JPEG whose FLIR chunks are out of order or missing one return `None` (never partial numbers);
  - `test_settings_change_moves_values`: emissivity 0.95 to 0.80 raises a hot pixel above ambient and leaves a pixel at reflected temperature unchanged within 0.01 °C.
- [ ] Implement the parser over raw bytes (no third-party JPEG reader); `physics.py` vectorised with numpy float64, cast to float32 at the end.
- [ ] `ruff format`, `ruff check`, `pytest python/tests/test_thermal_flir.py`.

### Task 1.3: DJI Thermal SDK binding (Python)

**Files:** `python/src/aio_pipelines/thermal/dji_tsdk.py` (new), `python/tests/test_thermal_dji.py` (new)

**Interfaces (produces):** `is_dji_rjpeg(head: bytes) -> tuple[str, str] | None` (make, model when the head has DJI's thermal APP3 segments and the XMP model is in `TSDK_MODELS`); `TSDK_MODELS: frozenset[str]` (the TSDK 1.7 list: H20T, H20N, H30T, M30T, M2EA, M3T, M3TD, M4T and the rest of the 1.7 release notes); `TSDK_RANGES` (distance 1 to 25 m, humidity 20 to 100 %, emissivity 0.10 to 1.00, reflection -40 to 500 °C, ambient -40 to 80 °C; check against the 1.7 header `dirp_api.h`); `clamp_for_tsdk(s) -> tuple[ThermalSettingsPy, list[str]]`; `class Tsdk: __init__(dll_dir: Path)`, `measure(path: Path, settings) -> np.ndarray[float32]` (via `dirp_create_from_rjpeg`, `dirp_get_rjpeg_resolution`, `dirp_set_measurement_params`, `dirp_measure_ex`, `dirp_destroy`; raises `TsdkError(code)` on a non-zero return).

- [ ] Failing tests:
  - `clamp_for_tsdk` with distance 40 m returns 25 m and `["distanceM"]`; values inside the ranges come back unchanged with `[]`;
  - `Tsdk` against a fake library object (inject a ctypes-like stub through a `_load` seam) passes the clamped params and maps a non-zero return to `TsdkError`; the handle is destroyed on error;
  - `is_dji_rjpeg` on a synthetic head (APP3 marker plus XMP `drone-dji` with `Model="M30T"`) gives `("DJI", "M30T")`; an XT2 head gives `None` (the XT2 is not on DJI's list and always takes the FLIR route);
  - `test_tsdk_samples_match_sdk` (acceptance 2), skipped unless `find_tool("dji_tsdk")` is found: for each sample R-JPEG in the SDK's `dataset/` folder, our `measure` equals the SDK's own `dji_irp.exe -a measure --measurefmt float32` output byte for byte.
- [ ] `ruff`, pytest.

### Task 1.4: ExifTool and DJI TSDK in the pack, with notices

**Files:** `tools/pipeline-pack/thermal-tools.mjs` (new), `thermal-tools-lock.json` (new), `tools/pipeline-pack/build.mjs`, `python/src/aio_pipelines/photo/native.py`, its test, `tools/release/native-libs.json`, `tools/release/notices.mjs`, `notices.test.mjs`, `tools/release/native-licences.mjs` (if it needs to accept the DJI licence ref)

- [ ] Lock file entries `{ name, version, url, sha256, unpack, files }` for ExifTool (the standalone Windows 64-bit zip of the newest release at least two weeks old; unpack `exiftool(-k).exe` renamed to `exiftool.exe` plus its `exiftool_files/` folder into `tools/exiftool/`) and DJI Thermal SDK 1.7 (`dji_thermal_sdk_v1.7_20241205` or the January 2025 build the design names; unpack `utility/bin/windows/release_x64/*` into `tools/dji-tsdk/`, plus its `License.txt`). Builder pins the exact URLs and hashes.
- [ ] `installThermalTools(packDir, { offline })` in `thermal-tools.mjs` verifies sha256 before unpacking (fail the build on mismatch), modelled on `installFfmpeg` in `ffmpeg.mjs`; `build.mjs` calls it, with `--no-thermal-tools` to skip. Test: a `.test.mjs` with a fake download that has the wrong hash fails, the right one unpacks the listed files.
- [ ] `native.py` `TOOLS`: `"exiftool": ("QUADRION_EXIFTOOL", "exiftool")` and `"dji_tsdk": ("QUADRION_DJI_TSDK", "dji-tsdk")`; for `dji_tsdk` `find_tool` returns the folder holding `libdirp.dll` (test with a temp folder and the env var).
- [ ] Notices: two entries in `native-libs.json` in the ffmpeg entry's format: ExifTool (`"spdx": "Artistic-1.0-Perl OR GPL-1.0-or-later"`, `"includes": [{ "name": "Strawberry Perl runtime", "spdx": "Artistic-1.0-Perl OR GPL-1.0-or-later" }]`, `"files": ["tools/exiftool/**"]`, `"linkage": "separate-process"` or the file's existing word for a separate executable) and DJI Thermal SDK (`"spdx": "LicenseRef-DJI-Thermal-SDK"`, `"files": ["tools/dji-tsdk/**"]`, `"linkage": "shared"`, `"note"` quoting where the licence text sits; the generated notices include the full `License.txt`). `notices.test.mjs` asserts both sections appear; `native-licences.mjs` accepts the `LicenseRef`.
- [ ] CI: the Python job fetches the lock's two archives into an `actions/cache` keyed on the lock file's hash and sets `QUADRION_EXIFTOOL` and `QUADRION_DJI_TSDK`, so the cross-check and acceptance tests run in CI (if the DJI licence forbids CI download, the acceptance 2 test stays local; note it in the PR).

### Task 1.5: `thermal.decode` job (Python)

**Files:** `python/src/aio_pipelines/thermal/pipeline.py`, `raster.py`, `crosscheck.py` (new), `python/src/aio_pipelines/pipelines.py`, `python/tests/test_thermal_decode.py` (new), `python/pyproject.toml` (0.21.0), `python/uv.lock`

**Interfaces:** consumes 1.1 (`ThermalDecodeParams`, file shapes), 1.2, 1.3, 1.4 (`find_tool`). Produces the raster files, `index.json`, and the job result `{ decoded, skipped, unsupported, unverified, implausible }`.

- [ ] Failing tests (temp project with a photos layer of synthetic photos, sidecar settings):
  - `test_the_pack_lists_thermal_decode` and `test_params_follow_thermal_decode_params` (the `rf.coverage` test pattern);
  - FLIR photos decode to `thermal/rasters/<layer>/<id>.f32` (length `w*h*4`) and `.json` with `settingsKey = sha256(canonical settings JSON + decoder id + source size + mtime)`; per-photo settings from `thermal.json` win over `defaults`, which win over the design defaults (distance from the photo's height above take-off when the item has one);
  - a second run with nothing changed skips every photo; changing one photo's emissivity re-decodes only that photo; `force` re-decodes all;
  - a visual photo and a non-thermal JPEG give `unsupported` with a reason, no raster;
  - **cross-check:** with a fake ExifTool returning a raw image that differs in one pixel, every photo of that model is `unverified`, no raster, and the reason names ExifTool; with ExifTool missing, the photos decode and `index.json` records `crosscheck: "skipped"` (tests and dev runs) but the pack build's smoke test (task 1.11) requires it present;
  - **plausibility:** a fixture whose decoded median is 150 °C is `implausible` with no raster;
  - DJI photos go through `Tsdk` (stubbed) with clamped settings recorded in `clamped`;
  - output is staged and committed with `commit_tree`, paths through `safe_project_path`; a read-only project fails the job with a clear error.
- [ ] Register in `pipelines.py` `all_pipelines()`; bump `pyproject.toml` to 0.21.0; `uv lock` in `python/`.

### Task 1.6: probe, sidecar IPC and job wiring (`@aio/project`, main)

**Files:** `packages/project/src/thermal/probe.ts`, `probe.test.ts`, `packages/project/src/thermal/index.ts` (new), project `src/index.ts`, `apps/desktop/src/main/thermal.ts`, `thermal.test.ts`, `thermalPack.ts`, `thermalPack.test.ts` (new), main `index.ts`, the preload bridge file that lists IPC channels, `apps/desktop/src/renderer/jobs.ts`, `renderer/processing/pipelines.ts`

**Interfaces (produces):** `thermalFamily(head: Uint8Array): { family: ThermalFamily; make: string; model: string } | null` (FLIR: an APP1 starting `FLIR\0`; DJI: the TSDK marker and model list mirrored from 1.3 as `TSDK_MODELS` in TS, one test pins that both lists are equal by reading the Python file); handlers for `thermal:probe`, `thermal:read`, `thermal:write`; `thermalPackRefusal(runtime, pipeline): string | null`.

- [ ] Failing tests: probe on a synthetic head built in the test (SOI plus an APP1 starting `FLIR�`) gives `flir`; a plain JPEG with Exif only gives null (once photo position edit has landed, add cases on its `xt2Thermal` and `xt2Visual` helpers); on a synthetic DJI head gives `dji-tsdk`. `thermal:probe` reads only the first 256 KB of each `photos/<id>.jpg`; `thermal:write` writes atomically with `.bak`, refuses packages and read-only projects, and refuses a file that fails `ThermalFile`; `thermal:read` returns `file: null` when absent and the error text for a corrupt file. `jobs:start` with `thermal.decode` on a pack below 0.21.0 is refused with the update text (the `antennaPackRefusal` pattern).
- [ ] Register handlers and the refusal in main `index.ts`; `renderer/jobs.ts` and `processing/pipelines.ts` entries for `thermal.decode` (not listed in the Processing screen's user-facing groups; the bench starts it).

### Task 1.7: strings, M1 set (`@aio/ui`)

**Files:** `packages/ui/src/i18n/en.ts`, `i18n.test.ts`

- [ ] Add `wb.tab.thermal` "Thermal", `actions.thermal.analyse` "Analyse thermal", and a `thermal.` group: `palette.iron` "Iron", `palette.rainbow` "Rainbow", `palette.whiteHot` "White hot", `palette.blackHot` "Black hot", `palette.arctic` "Arctic", `range.auto` "Auto range", `hover` "{temp} °C", `settings.line` "Emissivity {e} · Distance {d} m · Air {a} °C · Humidity {h}%", `settings.edit` "Edit", `settings.emissivity`, `settings.distance`, `settings.air`, `settings.humidity`, `settings.reflected` "Reflected temperature", `settings.reflectedSameAsAir` "Same as air", `settings.applyPhoto` "This photo", `settings.applySelected_other` "{count} selected photos", `settings.applyAll` "Whole dataset", `settings.clamped` "The camera's SDK limits {field}; it used {value}.", `decoding_other` "Reading temperatures of {count} photos", `status.unsupported` "Not a supported thermal camera ({model}). Shown as an ordinary photo.", `status.unverified` "Temperatures held back: the reading did not match the reference tool.", `status.implausible` "Temperatures held back: the values are outside physical limits.", `readOnly` "Open the project folder to analyse thermal photos.", `none` "No thermal photos in this dataset.", `filmstrip` "Thermal photos".
- [ ] Catalogue test passes.

### Task 1.8: renderer thermal core (pure)

**Files:** `apps/desktop/src/renderer/thermal/raster.ts`, `palettes.ts`, `colourise.ts`, `autoRange.ts`, `settings.ts`, `thermalStore.ts` and a test for each (new)

**Interfaces (produces):** `loadRaster(projectId, layerId, photoId): Promise<ThermalRaster | null>` with `ThermalRaster { width; height; data: Float32Array; meta: ThermalRasterMeta }` (fetches `aio://project/<id>/thermal/rasters/...`; length or schema mismatch gives null); `PALETTES: Record<PaletteId, Uint8ClampedArray /* 256 x RGBA */>` for `iron | rainbow | whiteHot | blackHot | arctic`; `colourise(r, range: [number, number], palette, isotherm?: { aboveC: number; rgba: [number, number, number, number] }, out?: ImageData): ImageData`; `autoRange(r): [number, number]` (1st and 99th percentile of finite values); `tempAt(r, x, y): number | null` (nearest pixel; null outside or NaN); `effectiveSettings(file, layerId, photoId, item, takeoffH): ThermalSettings`; `applySettings(file, keys: string[], patch): ThermalFile`; `useThermal` zustand store (`open(projectId, layerId, photoId?)`, `file`, `index`, `probe`, `current`, `palette`, `range`, `saveSettings(keys, patch)` which writes `thermal:write` then starts `thermal.decode` for those photos and reloads their rasters when the job ends).

- [ ] Failing tests: palette LUTs have 256 entries and their ends (`whiteHot` 0 black, 255 white; `blackHot` reversed); `colourise` maps min to entry 0 and max to 255, clamps outside, paints isotherm pixels at or above `aboveC` and leaves NaN transparent; `autoRange` ignores NaN and a few extreme pixels; `effectiveSettings` precedence (photo, defaults, design defaults; distance from height above take-off, else 10 m); `applySettings` to selected keys leaves others alone; store: `saveSettings` writes once, starts one job with exactly those photo ids, and never clears readings or hot spots.

### Task 1.9: bench shell UI

**Files:** `workspace/workbench/tabsModel.ts`, `RightSidebar.tsx`, `workbenchStore.ts`, `workspace/island/groups.tsx`, `workspace/workbench/benches/ThermalBench.tsx` + test, `renderer/thermal/ThermalStage.tsx`, `PaletteBar.tsx`, `SettingsLine.tsx`, `SettingsEditor.tsx`, `Filmstrip.tsx` + tests (new), `shell/actions/thermalActions.tsx` + test (new), `shell/actions/index.ts`

- [ ] `thermal` added to `TAB_IDS`, `FrontBody` maps it to `ThermalBench`; wide like Volumes if `isWide` applies.
- [ ] Action `thermal.analyse` (`defineAction<'layers' | 'photos'>`, `section: 'open'`, `targets: ['layers', 'photos']`, `appliesTo` when the probe for that layer finds at least one thermal photo, else hidden; `run` calls `useThermal.getState().open(...)` and `workbench.getState().open('thermal')`). Registered from `registerSidebarActions()`. Tests on `actionsFor`.
- [ ] Bench (mockup layout): stage canvas with `colourise` output, palette bar with min and max labels, palette picker, Auto range, the hover temperature under the pointer (`thermal-hover`), the settings line (`thermal-settings-line`) with Edit opening `SettingsEditor` (`Popover`; scope This photo, selected, Whole dataset); filmstrip of thermal photos only (`thermal-filmstrip`, one `thermal-thumb-<photoId>` each); status notes from `index.json` (`thermal-status`); a "Reading temperatures" progress line while the job runs; read-only note for packages.
- [ ] Component tests: hover shows `tempAt` with one decimal; an `unverified` photo shows its note and no hover number; saving settings for the whole dataset calls `saveSettings` with every thermal photo key.

### Task 1.10: e2e, compat and docs (M1)

**Files:** `apps/desktop/e2e/thermal-bench.spec.ts`, `e2e/thermalFixture.ts`, `e2e/thermal-fixture.py` (new), `tools/compat/thermal-additive.test.mjs` (new), `docs/architecture/contract-changes.md`, `docs/architecture/data-conventions.md`, the photos page of the user guide, the spec and this plan (status updates)

- [ ] `thermal-fixture.py` (run with the pipeline Python, as `photo-fixture.py` is) writes three synthetic photos with `thermal_fixtures.make_flir_jpeg`: two thermals with a known 3 x 3 hot patch at 85.0 °C on a 30.0 °C background (settings stored in the record: emissivity 0.95, distance 10 m, air 25 °C, humidity 50 %), and one visual twin. `thermalFixture.ts` builds a project around them (pattern of `pinFixture.ts`).
- [ ] Spec (skips without `hasPipelinePython()`): right-click the photos dataset, Analyse thermal; the bench opens and decodes; hover the patch centre shows `85.0 °C` (within 0.1); Edit settings, emissivity 0.80, This photo: the hover reading at the patch rises and the background stays near 30 °C; the filmstrip lists the two thermals, not the visual.
- [ ] Compat test: the 0.21 schema still parses the manifest and every existing-family file of the fixture project after a decode.
- [ ] M1 contract row (exact text above); data-conventions: a `thermal/` paragraph in the folder list (lines 21-37) with the file names and that rasters are derived and can be deleted; guide paragraph "Analyse thermal photos". `check-public-text.mjs` on each doc.

### Task 1.11: verification (M1)

- [ ] `pnpm check`; python suite the CI way; `node tools/pipeline-pack/build.mjs` once locally (ask the founder for a window; it is heavy), then the pack's smoke run decodes the fixture with the bundled ExifTool cross-check `ok` and TSDK found.
- [ ] `pnpm demo:change --quick`, then `thermal-bench.spec.ts` CI way.
- [ ] Manual on the founder's XT2 sample (local only, never copied into the repo): every `_R` photo decodes `ok`; values within the bounds; a photo's range is near the spike's -13.2 to 109.1 °C with median near 25 °C.

---

# M2: Bench tools

Starts after photo position edit lands and this branch is rebased onto it.

## M2 Execution DAG

```
2.1 strings ───────┐
2.2 twin (DJI) ────┼─> 2.4 tools UI ─> 2.5 e2e + docs ─> 2.6 verify
2.3 readings maths ┘
```

| Batch | Tasks         | Files                                                                                                                                                                                                                     |
| ----- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 2.1, 2.2, 2.3 | 2.1 `en.ts`, `i18n.test.ts`; 2.2 `packages/project/src/builder/thermalTwin.ts`, `thermalTwin.test.ts`, project `index.ts` export; 2.3 `renderer/thermal/{readings,profile,lens,align}*` (new)                             |
| 2     | 2.4           | `renderer/thermal/{ThermalTools,ReadingOverlay,ReadingsList,ProfileChart,IsothermControl,ViewSwitch,RangeHandles,AlignNudge}*` (new), `ThermalStage.tsx`, `PaletteBar.tsx`, `benches/ThermalBench.tsx`, `thermalStore.ts` |
| 3     | 2.5           | `e2e/thermal-bench.spec.ts`, `thermalFixture.ts`, guide page                                                                                                                                                              |

**Critical path:** 2.3 -> 2.4 -> 2.5 -> 2.6. No contract change (readings and alignment shapes were fixed in 1.1).

### Task 2.1: strings, M2 set

- [ ] `thermal.tool.spot` "Spot", `.box` "Box", `.line` "Line", `.polygon` "Polygon", `.isotherm` "Isotherm", `.find` "Find hot spots"; `thermal.stat.max` "Max", `.min` "Min", `.mean` "Mean"; `thermal.view.thermal` "Thermal", `.visual` "Visual", `.blend` "Blend", `.side` "Side by side"; `thermal.blend.opacity` "Opacity"; `thermal.isotherm.above` "Above {temp} °C"; `thermal.noTwin` "No visual photo taken with this one."; `thermal.align.nudge` "Line up with the visual photo"; `thermal.reading.delete` "Delete reading".

### Task 2.2: visual twin for DJI R-JPEGs (shared twin code)

**Files:** `packages/project/src/builder/thermalTwin.ts`, `thermalTwin.test.ts`, `packages/project/src/index.ts` (export the twin functions if photo position edit did not)

**Interfaces (produces):** `findVisualTwin<T extends TwinCandidate>(thermal: { name: string; takenAt?: string }, candidates: readonly T[]): T | null`.

- [ ] Failing tests: `X_0005_R.JPG` delegates to the existing `findTwin` (same result); `IMG_0007_T.JPG` pairs with `IMG_0007_W.JPG`, else `_Z`, else `_V`, same number, within 3 s; a `_W` 5 s apart is refused; a name that is neither gives null. Existing `findTwin` tests untouched.
- [ ] Implement beside `findTwin`, reusing its `key`, `time` and `TWIN_GAP_MS`. Candidates are photo ids plus `takenAt` from every photos layer of the project (the bench passes them; the thermal and visual may sit in different layers).

### Task 2.3: readings, profile, lens table and alignment (pure)

**Files:** `apps/desktop/src/renderer/thermal/readings.ts`, `profile.ts`, `lens.ts`, `align.ts` + tests (new)

**Interfaces (produces):** `readingStats(r: ThermalRaster, geom: ThermalReading['geom']): { maxC; minC; meanC; maxAt: [number, number] } | null` (spot: the pixel; box: inclusive pixel rect clipped to the image; polygon: pixel centres inside, even-odd; line: samples one per pixel along the segments); `lineProfile(r, points): { distPx: number; c: number }[]`; `LENSES: Record<string, { thermalHfovDeg: number; visualHfovDeg: number; offsetPx: [number, number] }>` keyed by camera model (XT2 per thermal lens option, and each TSDK model), values from the manufacturers' published fields of view; `thermalToVisual(box, lens, nudge, sizes): Box` and its inverse, used by Blend, Side by side and (in M3) the twin sighting.

- [ ] Failing tests: stats on a known raster for each geometry, NaN pixels ignored, a geometry fully outside gives null; profile length equals the line's pixel length; `thermalToVisual` with a 1:1 lens and no nudge maps the centre to the centre scaled by size; a nudge `{ dx: 10, dy: -4, scale: 1.02 }` moves it accordingly; round trip within 0.5 px; an unknown model falls back to the proportional mapping with `lensKnown: false`.

### Task 2.4: tools UI

**Files:** as batch 2 above

- [ ] Tool rail (`thermal-tool-<id>`): Spot, Box, Line, Polygon, Isotherm (Find hot spots shows, disabled until M3). Readings drawn on the stage, listed with max, min, mean live (`thermal-reading-<id>`), line with `ProfileChart` (SVG), delete; stored in `thermal.json` `readings` through the store (one write per finished shape); recomputed from the raster after any decode, never removed by a settings change.
- [ ] Range: drag the palette bar ends (`thermal-range-min`, `-max`), Auto resets. Isotherm: a temperature field; pixels above it painted in the isotherm colour.
- [ ] View switch (`thermal-view`): Thermal, Visual, Blend (opacity slider), Side by side; Visual and Blend use the twin's review copy via `findVisualTwin`, mapped with `lens.ts`; "Line up" nudge (arrow keys and scale) saved per layer in `alignment`. No twin: Visual, Blend and Side by side disabled with `thermal.noTwin`.
- [ ] Component tests: drawing a box adds one reading with the stats of `readingStats`; isotherm paints the patch only; Blend at 0 shows only thermal.

### Task 2.5: e2e and docs (M2)

- [ ] Extend `thermal-bench.spec.ts`: Box around the patch reads max 85.0 and min near 30.0; Spot on the background reads near 30.0; Isotherm 60 colours the patch (pixel check on the canvas); Blend is enabled for the photo with a twin and Side by side shows two images; the reading survives a settings change (count unchanged, values change).
- [ ] Guide: the tools.

### Task 2.6: verification (M2): `pnpm check`, `pnpm demo:change --quick`, spec CI way.

---

# M3: Hot spots and issues

## M3 Execution DAG

```
3.1 schema (job, IPC) ──┬─> 3.3 detection job ────────────────┐
                        └─> 3.4 severity IPC (project, main) ─┤
3.2 strings ──────────────────────────────────────────────────┼─> 3.7 list UI + find ─> 3.8 e2e + docs ─> 3.9 verify
3.6 grading + issue bridge (pure, renderer) ──────────────────┤
3.5 image-sighting pins (maps, annotate, facts) ──────────────┘
```

| Batch | Tasks              | Files                                                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 3.1, 3.2, 3.5, 3.6 | 3.1 `packages/schema/src/jobs.ts`, `jobs.test.ts`, `ipc.ts`, `thermal.test.ts`; 3.2 `en.ts`, `i18n.test.ts`; 3.5 `packages/maps/src/overlays.ts` + test, `packages/annotate/src/tools/mesh.ts` + test, `packages/project/src/export/facts.ts` + test; 3.6 `renderer/thermal/{grading,hotspotIssues,candidates}*` (new)                  |
| 2     | 3.3, 3.4           | 3.3 `python/src/aio_pipelines/thermal/hotspots.py`, `hotspots_pipeline.py` (new), `pipelines.py`, `test_thermal_hotspots.py`, `pyproject.toml` (0.22.0), `uv.lock`; 3.4 `packages/project/src/builder/severityModels.ts` + test, `apps/desktop/src/main/builder.ts` (handler) + test, main `index.ts`, preload bridge, `thermalPack.ts` |
| 3     | 3.7                | `renderer/thermal/{HotspotList,HotspotRow,FindHotspots,GradingEditor}*` (new), `ThermalTools.tsx`, `Filmstrip.tsx`, `benches/ThermalBench.tsx`, `thermalStore.ts`                                                                                                                                                                       |
| 4     | 3.8                | `e2e/thermal-bench.spec.ts`, `e2e/thermal-hotspots.spec.ts` (new), `thermalFixture.ts`, `tools/compat/thermal-additive.test.mjs`, `contract-changes.md`, `data-conventions.md`, guide                                                                                                                                                   |

**Critical path:** 3.1 -> 3.3 -> 3.7 -> 3.8 -> 3.9 (the detection tuning on real data is the uncertain part).

### Task 3.1: hot-spot job and severity IPC contracts

- [ ] `thermal.hotspots` in `PipelineName` and `PIPELINES` ("Find thermal hot spots"), params `ThermalHotspotsParams` (defined in 1.1) in the map, `THERMAL_HOTSPOTS_MIN_PACK = '0.22.0'`; `builder:updateSeverityModel` `{ projectId, model: SeverityModel }` to `{ ok, manifest, backup } | { ok: false, error }`. Tests: names list, strict request.

### Task 3.2: strings, M3 set

- [ ] `thermal.hotspot.code` "{code}", `.peak` "Peak {temp} °C", `.delta` "ΔT {delta} °C", `.ref.surroundings` "against its surroundings", `.ref.reading` "against {name}", `.confirm` "Confirm", `.dismiss` "Dismiss", `.addToExisting` "Add to existing hot spot", `.compareWith` "Compare with", `.leaveOut` "Leave out of report", `.changed` "Changed since review", `.sort.delta` "ΔT", `.sort.peak` "Peak", `.sort.photo` "Photo", `thermal.find.scope.photo` "This photo", `.scope.dataset` "Whole dataset", `.rule.absolute` "Above a temperature", `.rule.delta` "Hotter than surroundings by", `thermal.find.found_other` "{count} possible hot spots found", `thermal.grading.title` "Severity by ΔT", `.addLevel` "Add level", `.removeLevel` "Remove level", `thermal.class` "Hot spot", `thermal.model` "Thermal ΔT", level defaults "Watch", "Serious", "Critical".

### Task 3.3: detection (Python)

**Files:** `python/src/aio_pipelines/thermal/hotspots.py`, `hotspots_pipeline.py`, `pipelines.py`, `python/tests/test_thermal_hotspots.py`, `pyproject.toml` (0.22.0), `uv.lock`

**Interfaces (produces):** `find_hotspots(c: np.ndarray, rule: Literal['absolute', 'delta'], threshold_c: float, min_area_px=4, ring_px=8, merge_px=6, max_per_photo=20) -> list[Candidate]` with `Candidate(box: (x, y, w, h), peak_c, mean_c, peak_at, reference_c, delta_c)`; `reference_c` is the median of a ring `ring_px` wide around the region's bounding box, excluding other regions.

- [ ] Failing tests on synthetic rasters: one 85 °C patch on 30 °C gives one candidate with `delta_c` 55 ± 0.1; two patches 4 px apart merge, 20 px apart stay two; a 2-pixel glint is dropped by `min_area_px`; 30 patches give the 20 with the highest ΔT; `delta` rule with threshold 4 proposes nothing for a patch 3 °C above its ring; a cold sky band (-30 °C) at the top does not make the ground under it a candidate under the `delta` rule (the ring median excludes pixels colder than the region's surroundings' 10th percentile; test pins the behaviour, not the trick); NaN pixels ignored. Job: reads only `ok` rasters, writes `thermal/candidates.json` with `{ jobId, photos, candidates[] }`, a photo with no raster is listed in `skipped`.
- [ ] Register, pack 0.22.0, `uv lock`, `ruff`, pytest. Real-data tuning (task 3.9) may change the defaults; the tests pin behaviour on synthetic data.

### Task 3.4: editable severity model (project, main)

- [ ] `updateSeverityModel(manifest, issues, model): Result<ProjectManifest>` in `severityModels.ts`: replaces the model with the same id; refuses when a level value used by any issue disappears, or the model is unknown; tests. Handler `builder:updateSeverityModel` backed up and journaled like `builder:addSeverityModel`; test with a temp project. `thermalPackRefusal` covers `thermal.hotspots` below 0.22.0.

### Task 3.5: pins for image-only issues (`@aio/maps`, `@aio/annotate`, `@aio/project`)

**Interfaces:** `issueAnchor(issue, proj, shiftOf, photoAt?: (layer: string, photo: string) => LonLat | null)`; 3D `bestAnchor(issue, ..., photoPos?: (layer, photo) => Vec3 | null)`; `issuePosition` in `facts.ts` gets the same optional resolver. Callers pass resolvers built on `correctedPhoto(item, photoCorrection(...))`.

- [ ] Failing tests: an issue with only an image sighting gets the photo's corrected place (a photo with an `offsetM` correction moves the pin); an issue with a map or mesh sighting is unchanged (precedence: map, mesh, point cloud, then image); no resolver passed: null as today; a pinned photo uses its pin place (as `correctedPhoto` does).
- [ ] Update the callers (grep `issueAnchor(`, `bestAnchor(`, `issuePosition(`) to pass the resolver; list each in the commit.

### Task 3.6: grading and the issue bridge (pure, renderer)

**Files:** `apps/desktop/src/renderer/thermal/grading.ts`, `hotspotIssues.ts`, `candidates.ts` + tests (new)

**Interfaces (produces):** `THERMAL_MODEL_ID = 'thermal-dt'`, `HOT_SPOT_CLASS_ID = 'hot-spot'`; `defaultThermalModel(): SeverityModel` (levels 1 Watch `#d9a400`, 2 Serious `#e8590c`, 3 Critical `#c92a2a`, criteria text "ΔT 4 to 15 °C" and so on); `gradeFor(deltaC: number, grading: ThermalGrading, manual: boolean): number | null` (below the first threshold: null for detection, the first level for manual); `regrade(file, grading): ThermalFile` (drafts follow; reviewed keep `reviewedSeverity`, set `changedSinceReview` when the new grade differs); `mergeCandidates(file, cand: ThermalCandidatesFile): ThermalFile` (replaces earlier `proposed` entries of those photos, never touches confirmed or dismissed, drops candidates overlapping a confirmed sighting by IoU 0.3 or more); `confirm(hotspot, ctx): { issue: Issue; hotspot: HotSpot }` (code `HS` + next free two-digit number; title "Hot spot {peak} °C"; `source: 'agent'` when `origin` is detection, else `'human'`; status `draft`; sightings: image on the thermal photo with the box, plus the twin photo's box through `thermalToVisual` when a twin exists); `addToExisting(hotspot, target, issue)`; `rereadHotspots(file, rasters): ThermalFile` (recomputes peak, mean, reference and ΔT from rasters after a decode; a reference of kind `reading` is re-read from that reading).

- [ ] Failing tests for each, with the design's numbers: ΔT 4 gives Watch, 15 Watch, 16 Serious, 40 Serious, 40.1 Critical; ΔT 3 with `manual` gives Watch; a three-to-four-level edit regrades drafts only; `confirm` output passes `Issue.parse` and `validateIssueAgainstModel`; peak of a hot spot with two sightings is the higher; a settings change re-read never removes a hot spot and keeps the issue's title, note and status.

### Task 3.7: hot-spot list, Find hot spots and grading editor

- [ ] Find hot spots tool (`thermal-find`): scope This photo or Whole dataset, rule and threshold (default `delta` 4 °C), runs `thermal.hotspots`, merges candidates on finish, says `thermal.find.found_other`.
- [ ] List (`thermal-hotspots`, rows `thermal-hotspot-<id>`): code, severity chip, peak, ΔT and reference, note; sort by ΔT, peak, photo; Confirm (`thermal-confirm`) writes the issue through the issues store the Annotate bench uses (the `project:writeIssues` path) and the sidecar in one step, ensuring first that the project has the "Hot spot" class and the "Thermal ΔT" model (`builder:addSeverityModel`, `builder:updateClasses`); Dismiss; edit note (syncs to the issue's note); Compare with (click a reading on the stage); Add to existing; Leave out of report (`thermal-leave-out`); a hand-drawn box can be made a hot spot (`origin: 'manual'`).
- [ ] Grading editor (bench settings): thresholds, number and names of levels; saves the model through `builder:updateSeverityModel` and `grading` in the sidecar, then `regrade`.
- [ ] Filmstrip: a red dot on photos with proposed or confirmed hot spots.
- [ ] Component tests: Confirm calls the store once with the issue from `confirm`; Dismiss removes the row from the list but keeps it in the file as `dismissed`; editing the grading regrades drafts.

### Task 3.8: e2e, compat and docs (M3)

- [ ] `thermal-hotspots.spec.ts` (pipeline Python): open the bench on the fixture, Find hot spots on the whole dataset, two candidates appear (one per thermal); confirm one; it shows in Issues with class Hot spot and severity Critical (ΔT 55); the map shows its pin at the photo's corrected position; the 3D scene shows it; dismiss the other, it leaves the list; change emissivity: the confirmed hot spot's peak changes, the issue keeps its title and note.
- [ ] Compat test: the 0.21 schema parses `issues.json` with the hot-spot issue and the manifest with the new class and model.
- [ ] M3 contract row; data-conventions: `candidates.json` and the hot-spot record; guide.

### Task 3.9: verification (M3)

- [ ] `pnpm check`, python suite, both thermal specs CI way plus `annotate*.spec.ts` and the issues map specs (pins changed).
- [ ] Manual on the founder's sample: Find hot spots on the whole dataset finds the hot terminals without flooding the list with sky and sun glints; tune `min_area_px`, `ring_px` and the cap if needed and pin any change with a synthetic test.

---

# M4: Report and CSV

Can be built on `feat/thermal-report` in parallel with M2 and M3 once M1 lands; merges after M3.

## M4 Execution DAG

```
4.1 schema + strings ─┬─> 4.2 report section ─┐
                      └─> 4.3 CSV export ─────┴─> 4.4 e2e + docs ─> 4.5 verify
```

| Batch | Tasks    | Files                                                                                                                                                                                                                                   |
| ----- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 4.1      | `packages/schema/src/report.ts`, `report.test.ts`, `ipc.ts` (`EXPORT_FORMATS`, `EXPORT_FORMAT_KIND`), `packages/project/src/export/house.ts` (`HOUSE_SECTIONS`), `en.ts`                                                                |
| 2     | 4.2, 4.3 | 4.2 `reportPage/house/thermal.ts` + test (new), `sections.ts`, `main.ts`, `screens/reportSections.ts`; 4.3 `renderer/thermal/thermalCsv.ts` + test (new), `main/exports/jobs.ts`, `reportWindow.ts`, `run.ts`, `exports/exportModel.ts` |
| 3     | 4.4      | `e2e/thermal-report.spec.ts` (new), `tools/compat/thermal-additive.test.mjs`, `contract-changes.md`, guide                                                                                                                              |

**Critical path:** 4.1 -> 4.2 -> 4.4 -> 4.5.

### Task 4.1: section id, export format, strings

- [ ] `ReportSectionId` gains `thermal` (comment "Thermal analysis M4; kept in `reportSectionsExtra` by older builds"); `HOUSE_SECTIONS` includes it after `issues`; `EXPORT_FORMATS` gains `thermal-csv`, kind `files`; strings `house.sec.thermal` "Thermal hot spots", `export.thermalCsv` "Thermal hot spots (CSV)", table headers. Tests: settings with `thermal: false` parse; the 0.21 schema keeps it in `reportSectionsExtra` (compat test).

### Task 4.2: report section

**Interfaces:** `thermalSectionOffered(file: ThermalFile | null, issues: Issue[]): boolean` (a confirmed hot spot whose issue exists and is not `leaveOut`); `layoutThermal(p: Pager, ctx: HouseContext, n: string): void`.

- [ ] Failing tests: offered rule (none, all left out, one in); summary table order by severity (highest first) then ΔT descending; per hot spot block contains the thermal crop with the box and palette bar (rendered with `colourise` at the photo's auto range), the visual twin beside it when present, peak, mean, reference and ΔT, severity, the note, and a small map with the pin (the existing per-issue map helper of `sections.ts`); a hot spot whose raster is missing prints the numbers with "Thermal image not available".

### Task 4.3: CSV

- [ ] `thermalCsv(file, issues, photos, origin): string`, columns exactly: `code,severity,peak_c,mean_c,reference_c,delta_c,reference,photo,latitude,longitude,height_m,emissivity,distance_m,air_c,humidity_pct,reflected_c,note` (one row per confirmed, not-left-out hot spot; lat/lon/height from the corrected photo position; one decimal for temperatures; RFC 4180 quoting; UTF-8 with BOM like the issue CSV). Test with a note holding a comma, a quote and a newline. Wire `thermal-csv` through the report window like `measurements-csv` (`main/exports/jobs.ts`, `reportWindow.ts` `isCsv`, `run.ts` suffix and filter).

### Task 4.4: e2e, compat and docs (M4)

- [ ] `thermal-report.spec.ts`: on the M3 fixture state (confirmed hot spot written directly by the fixture, so it needs no pipeline Python), Reports offers "Thermal hot spots"; the generated report has the section with the code and ΔT; Leave out of report removes it (and the section when it was the only one); the CSV export has the header above and one row.
- [ ] M4 contract row; guide.

### Task 4.5: verification (M4): `pnpm check`, all thermal specs CI way, the existing report specs.

---

## Review Focus

1. **A thermal photo whose APP1 record did not survive** (a review copy re-encoded by an older build or another tool, or a FLIR chunk missing): the photo must show `unsupported`, never numbers. Pinned by `test_not_flir_returns_none` (1.2) and the `unsupported` case in 1.5.
2. **Settings outside the DJI SDK's ranges** (an oblique shot at 40 m, humidity 10 %): the SDK silently refuses or clamps; we clamp, record `clamped` and say so on the settings line. Pinned in 1.3 and 1.5; the UI note in 1.9's component test.
3. **Sky, sun glints and NaN pixels** distort auto range, readings and detection: percentiles and NaN skipping in 1.8, `readingStats` NaN test in 2.3, sky and glint tests in 3.3.
4. **Thermal and visual photos in different layers, or a mixed layer**: the filmstrip lists thermals only and the twin is found across layers. Pinned in 1.9 (filmstrip) and 2.2 (candidates from every photos layer).
5. **Settings or thresholds changed after a person reviewed a hot spot**: numbers update, severity stays, "Changed since review" shows, nothing is deleted and the issue keeps title, note and status. Pinned in 3.6 and the M3 e2e.

## e2e specs

| Spec                                        | Change | Milestone | What it proves                                                                                                                             |
| ------------------------------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop/e2e/thermal-bench.spec.ts`    | new    | M1, M2    | Open the bench from the dataset menu, decode, hover °C, settings re-read; then box, spot, isotherm, view switch, readings survive settings |
| `apps/desktop/e2e/thermal-hotspots.spec.ts` | new    | M3        | Find hot spots, confirm, see it in Issues, on the map and in 3D; dismiss; settings change keeps the issue                                  |
| `apps/desktop/e2e/thermal-report.spec.ts`   | new    | M4        | Report section offered and printed, Leave out of report, CSV columns                                                                       |

The first two skip without the pipeline Python (`hasPipelinePython()`); run them with `QUADRION_E2E_PYTHON` at the main checkout's venv. Existing specs to rerun: annotate and issue-map specs (M3 pins), report specs (M4), `sidebar-menus.spec.ts` (the new action).

## How to test (founder walkthrough)

Install the new pipeline pack first (Settings > Processing tools > Choose file, the archive in `apps/desktop/dist`).

1. **M1.** Open a project with a thermal flight (or add the folder to a new project). In the sidebar, right-click the photos dataset and choose **Analyse thermal**. The Thermal bench opens, says it is reading temperatures, then shows the first thermal photo in the Iron palette with a palette bar and its min and max.
2. Move the pointer over the photo: the temperature under it shows in °C. Below the photo, the settings line shows emissivity, distance, air and humidity. Click **Edit**, change emissivity to 0.80 for **This photo**, save: the numbers update after a moment.
3. The filmstrip lists only the thermal photos. A visual photo of the same flight is not in it. A photo from an unsupported camera says so and shows no numbers.
4. **M2.** Pick **Box** and drag a box around a hot terminal: max, min and mean show. Draw a **Line** across it: a profile appears. Set **Isotherm** to a temperature: everything hotter is coloured. Drag the ends of the palette bar to narrow the range; **Auto range** puts it back.
5. Switch the view to **Visual**, **Blend** (move the opacity slider) and **Side by side**. If the two images do not line up, use **Line up** to nudge once for the dataset.
6. **M3.** Pick **Find hot spots**, choose Whole dataset and "Hotter than surroundings by 4 °C". Possible hot spots appear in the list, each with ΔT, peak and severity. Click one: the photo shows its box. **Confirm** it, **Dismiss** a false one, use **Compare with** on similar equipment to change the reference.
7. Open **Issues**: the confirmed hot spot is there with class Hot spot. On the map and in 3D it has a red pin at the photo's place.
8. In the bench settings, open **Severity by ΔT**, add a level or rename one: unreviewed hot spots regrade.
9. **M4.** Open **Reports**: "Thermal hot spots" is offered. Generate: each hot spot has thermal and visual images side by side, its temperatures, ΔT, severity, note and a small map. Toggle **Leave out of report** on one and generate again: it is gone. Export **Thermal hot spots (CSV)** and open it in a spreadsheet.

## Questions for the founder

1. **DJI Thermal SDK licence.** DJI's SDK licence restricts redistribution and use. The plan bundles the DLLs in the pipeline pack and records the licence in the notices (licences do not block, 8 Oct). Is shipping it inside the pack to testers acceptable, and may CI download it for the acceptance test, or should that test stay on this PC only?
2. **Pins for older image-only issues.** The pin fallback (photo position for issues with only image sightings) also gives pins to image-only issues that exist today (for example ones drawn on photos in Annotate). Keep that for all issues, or limit it to hot spots?

## Follow-ups (not in this plan)

- Pins cast onto the mesh or ground surface at the hot-spot pixel (`aik.project` ray casting).
- A reference reading to check absolute accuracy of both routes.
- Per-reading emissivity overrides; °F display; thermal orthomosaic from nadir flights; radiometric video.
