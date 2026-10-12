# Walks 360 `walk.process` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pipeline `walk.process` that turns an imported 360 walk into a levelled playback copy, per-frame orientation, a raw SfM path (or a pins-only record), sparse points and map stills in `walks/<id>/`, with ffmpeg shipped in the pipeline pack.

**Architecture:** Python package `python/src/aio_pipelines/walk/` with small units (trailer reader, motion filter, fisheye map and stitcher, SfM, pipeline assembly) run as four resumable job steps. Contracts live in a new `packages/schema/src/walkProcess.ts` plus `walk.process` in `jobs.ts`; the app gains a status, a **Process walk** action, auto-start after import and a **Level horizon** toggle. ffmpeg comes from conda-forge into `<pack>/tools/ffmpeg` through the PDAL lock machinery.

**Tech Stack:** Python 3.13, numpy, OpenCV headless (`cv2.remap`), pycolmap 4.2.1 (`EQUIRECTANGULAR`), ffmpeg (pipes), TypeScript/zod, React, Vitest, pytest, Playwright.

**Spec:** `docs/plans/2026-10-12-walk-process-pipeline-design.md` (read it first; decisions 1 to 15 are referenced by number below).

## Global Constraints

- Pack Python is CPython 3.13 (`requires-python = ">=3.13,<3.14"`); no new Python dependency (telemetry-parser has no cp313 wheel; our own reader).
- No source-built natives; prebuilt binaries only; licences listed in the notices and `tools/release/native-libs.json`.
- This branch never writes the manifest or `walk.json`; it writes only into `walks/<id>/`. `packages/schema/src/walks.ts` and the layer union belong to `feat/walk-layer-and-placing`.
- No real footage, file name of a real clip, client, site or tester name in git, commit messages or docs. CI uses synthetic walks only; the reference walk is local (`QUADRION_WALK_REFERENCE`).
- Environment variables are `QUADRION_*` (`QUADRION_FFMPEG`, `QUADRION_WALK_REFERENCE`, `QUADRION_WALK_BENCH`).
- No em or en dashes in user-facing text. Conventional commits ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Python tests sit directly in `python/tests/` (`tools/ci/pytest-parts.test.mjs`); timeouts under 300 s each.
- Electron runs stay off-screen (the e2e fixtures); e2e with `--workers=1`, one Playwright run at a time.
- The benchmark is never started by an agent: only in a window the founder gives.
- Default values: stills 2 per second, `maskBottom` 0.25, `strideM` 0.7, chunk 300 stills with 40 overlap, sequential overlap 10, pins-only under 60 % registered, imu.bin 200 Hz, map stills JPEG quality 88 at most 3840 x 1920.

## Review Focus

1. **A walk that starts or ends in motion (no standing stretch)**: gyro bias falls back to the median rate over the whole walk, no crash; test in Task 3.
2. **A clip whose trailer has motion samples but no frame timestamps, or samples that start before the first frame**: times aligned from the first frame, samples before t = 0 dropped; test in Task 2.
3. **Very short walks (under 10 s, fewer than 20 stills)**: SfM skipped straight to pins-only with the warning "Too short for a path", job green; test in Task 7.
4. **The original moved or replaced between import and processing**: refused at validate with the file name and size check; test in Task 7.
5. **A second `walk.process` on a walk that already has outputs**: outputs replaced together at `finish` (staged, then committed), `process.json` written last; a reader never sees a mix; test in Task 7.

## Contract changes (rows for `docs/architecture/contract-changes.md`, written in Task 1)

| Date       | Change                                                                                                                                                                                                                                                                                                                                    | Why                                                                | Packages                                      | Approval                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- | ---------------------------- |
| 2026-10-12 | Additive: `PipelineName` gains `walk.process` with `WalkProcessParams` (`walk` id, optional `src[]` absolute, `stillsPerS`, `maskBottom`, `strideM`, `stabilize`, `sfm`, `chunk`). Older builds' job index skips jobs of a pipeline they do not know (as M10, M11)                                                                        | Walks 360 W1 rest and W2 path computation                          | `@aio/schema`, pipeline pack, main, renderer  | pending founder review       |
| 2026-10-12 | Additive: new file families `aio.walk-process/1` (`walks/<id>/process.json`) and `aio.walk-path/1` (`walks/<id>/raw-path.json`), and binary files `orientation.bin`, `imu.bin`, `sparse.ply`, `stills/`, `stabilized.mp4` beside them; `versions.ts` rows, `home: project`; data-conventions section 32. Older builds never read `walks/` | Hand-over to placing (`feat/walk-layer-and-placing`) and W3        | `@aio/schema`, pipeline pack                  | pending founder review       |
| 2026-10-12 | IPC additive: `walks:list` response gains optional `processed` (`Record<walkId, WalkProcessSummary>`); `WalkFile` unchanged                                                                                                                                                                                                               | The list and pane show processing state and play the levelled copy | `@aio/schema`, `@aio/project`, main, renderer | pending founder review       |
| 2026-10-12 | Pipeline pack layout gains `tools/ffmpeg/` (conda-forge ffmpeg, GPL build) with `conda-packages.json`; pack manifest `tools.ffmpeg`; data-conventions section 1                                                                                                                                                                           | Founder decision 3 (12 Oct): ffmpeg ships in the pack              | pipeline pack tooling, main                   | founder decision 12 Oct 2026 |

## Package ownership per task

| Task | Packages / folders                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `packages/schema`, `tools/compat`, `docs/architecture`                                                                                                                     |
| T2   | `python/src/aio_pipelines/walk/{trailer,protobuf,calib}.py`, `python/tests/`                                                                                               |
| T3   | `python/src/aio_pipelines/walk/motion.py`, `python/tests/`                                                                                                                 |
| T4   | `python/src/aio_pipelines/walk/{lens,stitch,ffmpeg}.py`, `python/src/aio_pipelines/photo/native.py` (TOOLS row only), `python/tests/`                                      |
| T5   | `python/src/aio_pipelines/walk/sfm.py`, `python/tests/`                                                                                                                    |
| T6   | `python/tests/walk_synth.py`, `python/tests/test_walk_synth.py`                                                                                                            |
| T7   | `python/src/aio_pipelines/walk/{pipeline,stills,outputs}.py`, `python/src/aio_pipelines/pipelines.py`, `python/tests/`                                                     |
| T8   | `tools/pipeline-pack/`, `tools/release/native-libs.json`, `.github/workflows/ci.yml` (python job), `docs/architecture/data-conventions.md` section 1                       |
| T9   | `apps/desktop/src/main/{jobs/pack.ts,walks.ts,builder.ts,index.ts}`, `packages/project/src/builder/walkProcess.ts` (new), `packages/project/src/builder/index.ts` (export) |
| T10  | `apps/desktop/src/renderer/walks/`                                                                                                                                         |
| T11  | `apps/desktop/e2e/walk-360.spec.ts`, `apps/desktop/e2e/walkSynth.ts` (new)                                                                                                 |
| T12  | `python/scripts/walk_bench.py`, `python/tests/test_walk_reference.py`, root `package.json` (script `bench:walk`)                                                           |

## Execution DAG

```
T1 contracts ─────────────┬──────────────► T9 main ──► T10 renderer ──┐
                          │                                            │
T2 trailer ──┬─► T4 stitch ┐                                           ▼
             └─► T6 synth ─┼─► T7 pipeline ─────────────────────────► T11 e2e
T3 motion ─────────────────┤          └──────────► T12 bench + reference
T5 sfm ────────────────────┘
T8 ffmpeg in pack ────────────────────────────────────────────────────► T11
```

| Batch | Tasks (run at once, one message) | Depends on                | Shared files |
| ----- | -------------------------------- | ------------------------- | ------------ |
| B1    | T1, T2, T3, T5, T8               | none                      | none         |
| B2    | T4, T6, T9                       | T4, T6: T2; T9: T1        | none         |
| B3    | T7, T10                          | T7: T1 to T6; T10: T1, T9 | none         |
| B4    | T11, T12                         | T11: T7, T8, T10; T12: T7 | none         |

**Critical path:** T2 → T6 → T7 → T11 (T4 runs beside T6 and also feeds T7). T7 is the largest task; start B3 as soon as T4 and T6 pass review.

Size: 12 tasks; S = under half a day, M = about a day, L = two days. T1 M, T2 M, T3 S, T4 L, T5 M, T6 M, T7 L, T8 M, T9 S, T10 M, T11 S, T12 S. Roughly 10 agent-days of work, about 4 to 5 days elapsed with the batches.

## Spikes folded into tasks (results recorded back into this plan by the task)

- **T2:** the exact trailer record ids, encodings and units, and the `offset` field layout, read on the reference X4 file locally (the file is never copied into the repo; only an anonymised trailer fixture is).
- **T4:** whether the equidistant model fits the X4 or needs a polynomial term (seam check on 5 s of the reference walk, founder looks at one frame).
- **T8:** whether conda-forge's Windows `ffmpeg` GPL build has `libx264`, `v360` and the HEVC decoder; else the BtbN fallback.

---

### Task 1: Contracts

**Files:**

- Create: `packages/schema/src/walkProcess.ts`, `packages/schema/src/walkProcess.test.ts`
- Modify: `packages/schema/src/jobs.ts` (enum, `PIPELINES`, params, `PARAMS`), `packages/schema/src/versions.ts` (two rows), `packages/schema/src/ipc.ts` (`walks:list` response), `packages/schema/src/index.ts` (export), `tools/compat/` additive test (a new `walk-process-additive.test.mjs` modelled on `m11-additive.test.mjs`), `docs/architecture/contract-changes.md` (the four rows above), `docs/architecture/data-conventions.md` section 32 (the new files)

**Interfaces:**

- Produces (TypeScript, exported from `@aio/schema`):

```ts
export const WALK_PROCESS_SCHEMA = 'aio.walk-process/1';
export const WALK_PATH_SCHEMA = 'aio.walk-path/1';
export const WALK_ORIENTATION_COLUMNS = ['t', 'qw', 'qx', 'qy', 'qz'] as const;
export const WALK_IMU_COLUMNS = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'] as const;
export const WALK_IMU_RATE_HZ = 200;

export const WalkPathStill = z.object({
  n: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  steps: z.number().nonnegative(),
  registered: z.boolean(),
  pos: z.tuple([z.number(), z.number(), z.number()]).optional(),
  q: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  segment: z.number().int().nonnegative().optional(),
  map: z.string().optional(), // 'stills/00012.jpg'
});
export const WalkPathFile = z.object({
  schema: z.literal(WALK_PATH_SCHEMA),
  walk: z.string(),
  source: z.enum(['sfm', 'pins-only']),
  up: z.tuple([z.number(), z.number(), z.number()]).optional(),
  scale: z.literal('arbitrary'),
  segments: z.array(z.object({ id: z.number().int(), fromT: z.number(), toT: z.number() })),
  standing: z.array(z.object({ fromT: z.number(), toT: z.number() })),
  stills: z.array(WalkPathStill),
});
export const WalkProcessFile = z.object({
  schema: z.literal(WALK_PROCESS_SCHEMA),
  walk: z.string(),
  createdAt: IsoTime,
  engine: z.object({
    version: z.string(),
    pycolmap: z.string().optional(),
    ffmpeg: z.string().optional(),
  }),
  input: z.object({
    file: z.string().optional(),
    layout: WalkLayout,
    calibration: z.enum(['trailer', 'default', 'none']),
    lenses: z
      .array(
        z.object({
          cx: z.number(),
          cy: z.number(),
          radius: z.number(),
          fovDeg: z.number(),
          yawDeg: z.number(),
          pitchDeg: z.number(),
          rollDeg: z.number(),
        }),
      )
      .max(2)
      .optional(),
    imu: z.boolean(),
    camera: z.string().optional(),
  }),
  outputs: z.object({
    rawPath: WalkProcessPath.optional(),
    orientation: WalkProcessPath.optional(),
    imu: WalkProcessPath.optional(),
    sparse: WalkProcessPath.optional(),
    stills: WalkProcessPath.optional(),
    stabilized: WalkProcessPath.optional(),
  }),
  stabilize: z.object({ levelled: z.boolean(), keptYaw: z.literal(true) }),
  stills: z.object({ sfm: z.number().int(), map: z.number().int() }),
  path: z.object({
    source: z.enum(['sfm', 'pins-only']),
    registeredFraction: z.number().min(0).max(1),
    segments: z.number().int(),
  }),
  timings: z.record(z.string(), z.number().nonnegative()),
  warnings: z.array(z.string().max(400)).max(50),
});
export const WalkProcessSummary = z.object({
  createdAt: IsoTime,
  stabilized: z.string().optional(),
  source: z.enum(['sfm', 'pins-only']),
  warnings: z.number().int().nonnegative(),
});
```

`WalkProcessPath` is the same project-relative path rule as `WalkPath` in `walks.ts`, redeclared locally (do not edit `walks.ts`). `WalkLayout` is imported from `./walks`.

```ts
// jobs.ts
export const WalkProcessParams = z
  .object({
    walk: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .max(80),
    src: z.array(z.string().min(1).max(MAX_PATH)).min(1).max(20).optional(),
    stillsPerS: z.number().min(0.5).max(4).optional(),
    maskBottom: z.number().min(0).max(0.5).optional(),
    strideM: z.number().min(0.3).max(1.5).optional(),
    stabilize: z.boolean().optional(),
    sfm: z.boolean().optional(),
    chunk: z.number().int().min(50).max(2000).optional(),
  })
  .strict();
// PIPELINES entry: { name: 'walk.process', title: 'Process 360 walk',
//   description: 'Levelled playback copy, camera orientation, path from the video, sparse points and map stills for a 360 walk.' }
// ipc walks:list response: z.object({ walks: z.array(WalkFile), processed: z.record(z.string(), WalkProcessSummary).optional() })
```

- [ ] **Step 1: Failing tests** in `walkProcess.test.ts`: a golden `process.json` and `raw-path.json` parse; `pins-only` without `up` parses; a path with `..` is refused; `WalkProcessParams` refuses an unknown key, `maskBottom: 0.6`, a walk id with upper case; `pipelineParams('walk.process')` returns it; `versions.ts` has both schemas with `home: 'project'`.

```ts
it('refuses a walk id the import would never write', () => {
  expect(WalkProcessParams.safeParse({ walk: 'VID_1' }).success).toBe(false);
  expect(WalkProcessParams.safeParse({ walk: 'vid-20260101-120000-00-001' }).success).toBe(true);
});
```

- [ ] **Step 2:** `pnpm --filter @aio/schema test` fails (module missing).
- [ ] **Step 3:** Write `walkProcess.ts`, the `jobs.ts`, `versions.ts`, `ipc.ts` and `index.ts` edits.
- [ ] **Step 4:** Tests pass; the compat test proves 0.10's schemas still parse every corpus file and that a job index entry for `walk.process` is skipped by 0.10, not refused (copy the M11 note's approach).
- [ ] **Step 5:** Contract rows and data-conventions section 32 text (file list and the two schemas, field by field as in the spec "Files written"). `pnpm check` for schema and compat green. Commit `feat(schema): walk.process pipeline and its output files`.

### Task 2: Trailer reader

**Files:**

- Create: `python/src/aio_pipelines/walk/__init__.py`, `walk/trailer.py`, `walk/protobuf.py`, `walk/calib.py`, `python/tests/walk_trailer_synth.py` (writer of synthetic trailers, used by T6), `python/tests/test_walk_trailer.py`, `python/tests/fixtures/walk/x4-trailer.bin` (anonymised, under 64 KB)

**Interfaces:**

- Produces:

```python
# walk/calib.py
@dataclass(frozen=True)
class Lens:
    cx: float; cy: float; radius: float      # pixels in the lens stream
    fov_deg: float                           # full field of view
    yaw_deg: float = 0.0; pitch_deg: float = 0.0; roll_deg: float = 0.0
DEFAULT_FOV_DEG = 195.0
def default_lenses(width: int, height: int) -> tuple[Lens, Lens]: ...
def parse_offset(text: str, width: int, height: int) -> tuple[Lens, Lens] | None: ...

# walk/trailer.py
INSTA360_MARK = b"8db42d694ccc418790edff439fe026bf"
@dataclass
class Imu:
    t: np.ndarray        # float64 seconds from the first video frame, shape (n,)
    acc: np.ndarray      # float64 g, shape (n, 3), camera frame (x right, y down, z forward)
    gyro: np.ndarray     # float64 rad/s, shape (n, 3), same frame
@dataclass
class Trailer:
    camera: str | None; serial_hash: str | None; firmware: str | None
    offset: str | None
    imu: Imu | None
    frame_times: np.ndarray | None
    warnings: list[str]
def read_trailer(path: str | Path) -> Trailer | None   # None when no mark
# tests/walk_trailer_synth.py
def write_trailer(f: BinaryIO, *, camera: str, offset: str, imu: Imu, frame_times: np.ndarray | None,
                  encoding: Literal["float64", "int16"] = "float64") -> None
def synth_imu(seconds: float, rate: int, seed: int = 0) -> Imu
SYNTH_OFFSET: str
```

- [ ] **Step 1 (spike, local):** read the reference X4 file's trailer with a throwaway script in the scratch folder; record ids, sample encoding, units and the axis mapping to the camera frame here in the plan under "Spike results". Extract the trailer to the fixture, replacing the serial and anything identifying with zeros (keep lengths).
- [ ] **Step 2: Failing tests:** fixture reads (camera `X4`, an `offset` with two lenses, at least 200 motion samples, gyro magnitude below 20 rad/s, acc magnitude median within 0.1 of 1 g); `write_trailer` then `read_trailer` round-trips exactly (both encodings); a file without the mark answers `None`; a truncated trailer and a record length past the start answer a `Trailer` with `imu=None` and a warning; samples with t before the first frame are dropped; no frame-time record means times from the first sample; `parse_offset` on the fixture's string gives centres within 5 % of the stream centre; a garbage offset answers `None`.

```python
def test_round_trip_both_encodings(tmp_path):
    imu = synth_imu(seconds=2.0, rate=1000)
    for enc in ("float64", "int16"):
        p = tmp_path / f"{enc}.bin"
        with p.open("wb") as f:
            write_trailer(f, camera="X4", offset=SYNTH_OFFSET, imu=imu, frame_times=None, encoding=enc)
        tr = read_trailer(p)
        assert tr is not None and tr.imu is not None
        np.testing.assert_allclose(tr.imu.gyro, imu.gyro, atol=1e-3 if enc == "int16" else 1e-12)
```

- [ ] **Step 3:** Implement: read the footer from the end, walk records backwards with bounds checks on every length, the protobuf walker (varint, length-delimited, fixed32/64; unknown fields skipped), the metadata fields used, the two motion encodings. Hash the serial (sha256, first 12 hex) rather than keep it.
- [ ] **Step 4:** `uv run pytest tests/test_walk_trailer.py` passes; `uv run ruff check`.
- [ ] **Step 5:** Commit `feat(pipelines): read the Insta360 trailer for walk.process`.

### Task 3: Motion

**Files:** Create `walk/motion.py`, `python/tests/test_walk_motion.py`

**Interfaces:**

- Consumes: plain arrays (`t`, `acc`, `gyro`) shaped as `Imu` in T2 (no import from trailer.py).
- Produces:

```python
def gyro_bias(t, gyro, standing: list[tuple[float, float]]) -> np.ndarray          # (3,)
def standing_stretches(t, acc, min_s: float = 1.5, thresh_g: float = 0.03) -> list[tuple[float, float]]
def step_times(t, acc) -> np.ndarray          # peaks of band-passed magnitude, 1.2 to 3 Hz
def orientation(t, acc, gyro, out_t: np.ndarray, gain: float = 0.02) -> np.ndarray  # (len(out_t), 4) wxyz, camera to gravity frame, yaw from first sample
def level_rotation(q: np.ndarray) -> np.ndarray   # (n, 3, 3): removes pitch and roll, keeps yaw
def decimate(t, acc, gyro, rate_hz: int = 200) -> np.ndarray   # (m, 7) float32 rows t, ax..gz
def write_rows(path: Path, rows: np.ndarray) -> None            # float32 little endian
```

- [ ] **Step 1: Failing tests:** constant rotation rate integrates to the right angle within 0.2 degree over 10 s; a gyro bias of 0.01 rad/s is removed when a standing stretch exists, and with none the median-rate fallback keeps drift under 3 degrees over 10 s (Review Focus 1); tilt recovered from gravity within 0.5 degree under walking-like acceleration noise; `level_rotation` applied to a frame tilted 10 degrees gives a level horizon and the same yaw; standing detection finds a 3 s stop in a synthetic walk within 0.3 s; step cadence of 1.8 Hz counted within 2 %; `decimate` output is 200 Hz float32 with 7 columns.
- [ ] **Step 2:** Run, fail. **Step 3:** Implement (quaternion maths in numpy, vectorised where it can be; the filter loop at 1 kHz in plain numpy is acceptable: 900 k samples for 15 min, measure under 10 s, else integrate in blocks).
- [ ] **Step 4:** Pass. **Step 5:** Commit `feat(pipelines): orientation, standing and steps from walk motion data`.

### Task 4: Fisheye map, stitcher and ffmpeg

**Files:** Create `walk/lens.py`, `walk/stitch.py`, `walk/ffmpeg.py`, `python/tests/test_walk_stitch.py`. Modify `python/src/aio_pipelines/photo/native.py` (add `"ffmpeg": ("QUADRION_FFMPEG", "ffmpeg")` to `TOOLS` and the `Library/bin` candidate conda uses on Windows).

**Interfaces:**

- Consumes: `Lens`, `default_lenses` (T2); `level_rotation` output shape (T3) as plain `(n, 3, 3)` arrays.
- Produces:

```python
# walk/lens.py
def equirect_dirs(width: int, height: int) -> np.ndarray       # (h, w, 3) unit vectors, camera frame
def dual_fisheye_map(lenses: tuple[Lens, Lens], lens_size: int, out_w: int, out_h: int,
                     rotation: np.ndarray | None = None, map_scale: int = 4) -> tuple[np.ndarray, np.ndarray, np.ndarray]
    # map_x, map_y (float32, out_h x out_w, into the side-by-side frame) and blend weight of lens 0
def equirect_rotate_map(out_w: int, out_h: int, rotation: np.ndarray, map_scale: int = 4) -> tuple[np.ndarray, np.ndarray]

# walk/ffmpeg.py
def find_ffmpeg() -> str | None
FFMPEG_MISSING: str
def probe(path: str) -> dict        # streams, durations, fps (ffprobe beside ffmpeg, or ffmpeg -i parse)
def decode_args(src: str, layout: str, fps: float, limit_s: float | None) -> list[str]   # rawvideo bgr24 on stdout
def encode_args(out: str, w: int, h: int, fps: float, audio_src: str | None) -> list[str]  # the playback copy's settings
def version(exe: str) -> str

# walk/stitch.py
@dataclass
class FrameSink:   # called per output frame index i and time t with the stitched BGR frame
    on_frame: Callable[[int, float, np.ndarray], None]
def run_frames(src: list[str], layout: str, lenses: tuple[Lens, Lens] | None, fps: float,
               rotations: Callable[[float], np.ndarray] | None, out_mp4: Path | None,
               sinks: list[FrameSink], check: Callable[[], None], progress: Callable[[float], None]) -> dict
```

`run_frames` decodes with one ffmpeg (two lens streams `hstack`ed, or the equirect source), maps each frame (cached map when `rotations` is None; per-frame map otherwise, computed at `1/map_scale` size and upsampled with `cv2.resize`), writes to the encoder ffmpeg when `out_mp4` is given, and calls the sinks (still pickers). Chapters: decoded in turn into one output with continuous times. Both processes run through `native.run_tool`-style tree kill on cancel.

- [ ] **Step 1: Failing tests:** `equirect_dirs` centre pixel is (0, 0, 1) and the top row is up (y = -1); a direction at the lens axis maps to the lens centre; a direction at 97.5 degrees off axis lands on the 195 degree circle; the seam weight is 0.5 on the 90 degree meridian and feathered over 4 degrees; `dual_fisheye_map` at `map_scale=4` matches `map_scale=1` within 0.25 px; a rotation of 10 degrees roll moves a known point as expected; `encode_args` includes `-pix_fmt yuv420p`, `+faststart`, a keyframe every 0.5 s; `find_ffmpeg` honours `QUADRION_FFMPEG`, then `tools/ffmpeg/Library/bin/ffmpeg.exe` beside the pack, then the PATH (monkeypatched).
- [ ] **Step 2:** Fail. **Step 3:** Implement. **Step 4:** Pass, plus a timed check that one 3840 x 1920 per-frame map plus remap runs under 60 ms on the CI runner (soft: warn, not fail, above).
- [ ] **Step 5 (spike, local):** stitch 5 s of the reference walk with the trailer calibration and with 195 degrees; save one frame of each to the scratch folder for the founder; record which model is kept under "Spike results". Commit `feat(pipelines): calibrated dual fisheye stitch and levelling`.

### Task 5: SfM on equirect stills

**Files:** Create `walk/sfm.py`, `python/tests/test_walk_sfm.py`

**Interfaces:**

- Produces:

```python
@dataclass
class StillPose:
    n: int; registered: bool
    pos: tuple[float, float, float] | None; q: tuple[float, float, float, float] | None  # camera to SfM frame, wxyz
    segment: int | None
@dataclass
class SfmResult:
    poses: list[StillPose]; segments: int; registered_fraction: float
    points: np.ndarray        # (k, 3) float32
    colors: np.ndarray        # (k, 3) uint8
    up: tuple[float, float, float] | None
    timings: dict[str, float]
def run_sfm(stills: list[Path], work: Path, *, mask_bottom: float, chunk: int, overlap: int = 40,
            gravity: list[np.ndarray | None] | None, check: Callable[[], None],
            progress: Callable[[float], None]) -> SfmResult
def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]   # s, R, t
def up_from_gravity(qs: list[np.ndarray], gravity_cam: list[np.ndarray]) -> np.ndarray
def up_from_cameras(qs: list[np.ndarray]) -> np.ndarray
def write_ply(path: Path, points: np.ndarray, colors: np.ndarray) -> None
```

Uses pycolmap's own API as `photo/align.py` does (reuse its thread and memory helpers from `photo/native.py`): one `EQUIRECTANGULAR` camera shared by all images with refinement off, mask images written with the bottom fraction black, `match_sequential` with overlap 10 and loop detection off, incremental mapping. The first run's flaky exit noted in the Walks design is retried once with the log kept.

- [ ] **Step 1: Failing tests:** `umeyama` recovers a known similarity exactly; two overlapping chunks of a synthetic camera line are joined within 1e-6; a chunk with fewer than 5 shared registered stills starts a new segment; `up_from_gravity` and `up_from_cameras` recover a tilted up within 0.5 degree; `write_ply` reads back with the header `element vertex k`. A slow test (marked, still in CI, under 120 s) runs `run_sfm` on 24 equirect stills rendered by a small local helper (a textured box seen from a line of positions) and asserts at least 90 % registered.
- [ ] **Step 2:** Fail. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `feat(pipelines): equirectangular SfM in chunks for walks`.

### Task 6: Synthetic walk

**Files:** Create `python/tests/walk_synth.py`, `python/tests/test_walk_synth.py`

**Interfaces:**

- Consumes: `write_trailer`, `Imu` (T2). Does **not** import `walk/lens.py`: the renderer has its own fisheye projection, so a shared bug cannot hide.
- Produces:

```python
@dataclass
class SynthWalk:
    path: Path                     # the two-stream .insv-like MP4 with trailer
    truth_t: np.ndarray            # frame times
    truth_pos: np.ndarray          # (n, 3) metres
    truth_q: np.ndarray            # (n, 4) camera to world wxyz
    lens: tuple[float, float, float]   # cx, cy, radius used
    offset: str                    # the offset string written
def make_synth_walk(out_dir: Path, *, seconds: float = 12.0, fps: int = 15, lens_px: int = 640,
                    textured: bool = True, standing_s: float = 2.0, trailer: bool = True,
                    seed: int = 7) -> SynthWalk
```

Scene: a 12 x 8 x 3 m box, walls and floor with seeded value-noise texture plus a few dark boxes; path: stand `standing_s`, walk an L with a 90 degree turn at 1.2 m/s; orientation: yaw follows the path, pitch and roll wobble 4 degrees at 1.8 Hz. Each frame: ray-cast both equidistant 195 degree lenses (numpy, analytic box intersections), `hstack`ed into a raw pipe to ffmpeg writing two video streams (`-map` twice, libx264, so CI needs no HEVC encoder), then the synthetic trailer appended with motion samples at 1 kHz from the true orientation plus noise and a 0.01 rad/s gyro bias. Generation cached under `.pytest_cache/d/walk-synth` keyed by the parameters (as `photo-synth` is).

- [ ] **Step 1: Failing tests:** the file has two video streams of `lens_px` square and the Insta360 mark at the end; `read_trailer` gives back the samples; the generator is deterministic for a seed; `textured=False` renders flat walls; 12 s at 15 fps builds in under 60 s.
- [ ] **Step 2:** Fail. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `test(pipelines): synthetic 360 walk with a known path`.

### Task 7: The pipeline

**Files:** Create `walk/pipeline.py` (class `WalkProcess`), `walk/stills.py`, `walk/outputs.py`, `python/tests/test_walk_process.py`. Modify `python/src/aio_pipelines/pipelines.py` (import and register `WalkProcess()` under a `# Walks 360` comment).

**Interfaces:**

- Consumes: everything from T2 to T6; parameter names exactly as `WalkProcessParams` (T1).
- Produces: pipeline `walk.process`; files exactly as `aio.walk-process/1` and `aio.walk-path/1`.

```python
# walk/stills.py
def pick_sfm_times(duration: float, per_s: float, standing: list[tuple[float, float]]) -> list[float]
def pick_map_stills(times: list[float], steps_at: Callable[[float], float], stride_m: float) -> list[int]
# walk/outputs.py
def write_raw_path(path: Path, walk: str, sfm: SfmResult | None, times: list[float], steps: list[float],
                   standing, map_files: dict[int, str]) -> dict
def write_process(path: Path, record: dict) -> None   # validated against a Python copy of the field list
```

Steps (`Step(name, title, run, weight)`): `read` (0.05: walk.json, `src` checks of name and size against `walk.json.source`, trailer, calibration, motion, orientation at the playback frame rate, disk check), `frames` (0.45: `run_frames` with the levelled copy when IMU is present and `stabilize` is not false, SfM stills at half size into the stage folder, map still candidates at full size), `sfm` (0.45: `run_sfm`, or pins-only when `sfm` is false, under 20 stills, or under 60 % registered), `finish` (0.05: stage everything under `walks/<id>/.process-staging/`, then `commit_files` into place, `process.json` last). `inputs()` lists `walks/<id>/walk.json`, `walks/<id>/playback.mp4` and the `src` files, so a resumed job refuses changed inputs.

- [ ] **Step 1: Failing tests** on the synthetic walk (T6): job runs through the runtime as other pipeline tests do; `process.json` and `raw-path.json` validate against golden field lists (and a vitest in T1 parses a copy of this output, so both sides agree); orientation within 1 degree of truth after removing the first-frame yaw; the levelled copy's horizon within 1.5 degrees (sample the rendered floor/wall edge at four known yaws); at least 90 % registered and path shape error under 2 % of length after `umeyama` to truth; map stills about `strideM * steps` apart; standing stills dropped except first and last.
      Review Focus tests: under 10 s walk answers pins-only with "Too short for a path" (3); `src` of another size refused with the file name (4); a second run replaces outputs together and `process.json` is written last (5); `textured=False` gives pins-only, job green (decision 10); no trailer gives no levelled copy and calibration `default` (spec Inputs); no `src` works from `playback.mp4`.
- [ ] **Step 2:** Fail. **Step 3:** Implement. **Step 4:** `uv run pytest tests/test_walk_*.py` passes, and `tests/test_m11_params.py`-style param mirror test for `walk.process` keys matches `WalkProcessParams` (copy the M11 pattern).
- [ ] **Step 5:** Commit `feat(pipelines): walk.process`.

### Task 8: ffmpeg in the pipeline pack

**Files:** Create `tools/pipeline-pack/ffmpeg.mjs`, `tools/pipeline-pack/ffmpeg-lock.json`, `tools/pipeline-pack/ffmpeg.test.mjs`. Modify `tools/pipeline-pack/pdal.mjs` (export the micromamba install as `installCondaTool({ spec, lock, dest, prune })`; PDAL keeps its behaviour), `tools/pipeline-pack/build.mjs` (`--no-ffmpeg`, install into `tools/ffmpeg`, check, manifest `tools.ffmpeg`), `tools/pipeline-pack/build.test.mjs`, `tools/release/native-libs.json` (ffmpeg and its codec libraries with licences), `.github/workflows/ci.yml` (python job: cache and install the pack's ffmpeg like PDAL, export `QUADRION_FFMPEG`), `docs/architecture/data-conventions.md` section 1 (pack layout).

**Interfaces:**

- Produces: `<pack>/tools/ffmpeg/Library/bin/ffmpeg.exe` (Windows) and `ffprobe.exe`; `checkFfmpegTool(dir) -> { version, missing: string[] }` checking `v360` in `-filters`, `libx264` in `-encoders`, `hevc` in `-decoders`.

- [ ] **Step 1: Failing tests:** lock file entries all have SHA-256 and a licence; prune keeps `ffmpeg`, `ffprobe` and their DLLs, drops headers and static libs; `checkFfmpegTool` parses sample outputs and names what is missing; `build.test.mjs` expects `tools.ffmpeg` in the manifest; `native-licences.test.mjs` covers the new files.
- [ ] **Step 2:** Fail. **Step 3 (spike):** `node tools/pipeline-pack/ffmpeg.mjs --lock` solves conda-forge `ffmpeg` (GPL build string) for win-64; `--out <scratch>` installs; `checkFfmpegTool` must report nothing missing. If `libx264` is missing, switch to BtbN's pinned `win64-gpl-shared` zip (URL plus SHA-256 in the lock) and record it under "Spike results". Note the installed size for the founder.
- [ ] **Step 4:** Tests pass; `node tools/pipeline-pack/build.mjs --out <scratch> --no-sam` builds a pack with `tools/ffmpeg` (not committed).
- [ ] **Step 5:** Commit `feat(pack): ffmpeg ships in the pipeline pack`.

### Task 9: Main

**Files:** Create `packages/project/src/builder/walkProcess.ts`, `walkProcess.test.ts`. Modify `packages/project/src/builder/index.ts` (export), `apps/desktop/src/main/jobs/pack.ts` (`findFfmpeg` beside `findPdal`, tests in `pack.test.ts`), `apps/desktop/src/main/walks.ts` (`walkTools.check` and `copy` get the found `FfmpegBin`), `apps/desktop/src/main/builder.ts` and `images.ts` (review copies use the same bin), `apps/desktop/src/main/index.ts` (`walks:list` adds `processed`).

**Interfaces:**

- Consumes: `WalkProcessFile`, `WalkProcessSummary` (T1).
- Produces:

```ts
export async function readProcessSummaries(
  root: string,
  ids: readonly string[],
): Promise<Record<string, WalkProcessSummary>>;
export async function findFfmpeg(
  pack: string | null,
  env: NodeJS.ProcessEnv,
): Promise<FfmpegBin | null>; // QUADRION_FFMPEG, pack tools/ffmpeg, PATH
```

- [ ] **Step 1: Failing tests:** summaries read only from `process.json` files that parse and whose `walk` equals the folder; a file over 256 KB is skipped; a walk without one is absent; `findFfmpeg` order (env, pack `Library/bin`, `bin`, PATH, null); the walk import uses the pack's ffmpeg when the PATH has none.
- [ ] **Step 2:** Fail. **Step 3:** Implement. **Step 4:** `pnpm --filter @aio/project test`, `pnpm --filter desktop test` for the touched files. **Step 5:** Commit `feat(desktop): pack ffmpeg for walks and review copies, processed walks in walks:list`.

### Task 10: Renderer

Load `impeccable` and `frontend-design` before the visual work.

**Files:** Modify `apps/desktop/src/renderer/walks/walkStore.ts` (keep `processed`), `walkModel.ts` (status and source choice), `WalkList.tsx` (status line, **Process walk**), `Walk360Pane.tsx` (**Level horizon** toggle, source choice), `walks.ts` (auto-start after import, job progress follow); tests in `walkModel.test.ts`, `walkStore.test.ts`.

**Interfaces:**

- Consumes: `walks:list` with `processed` (T1, T9); `jobs:start` with `{ pipeline: 'walk.process', params: WalkProcessParams }`; the jobs store's progress per job.
- Produces:

```ts
export type WalkStatus =
  | { kind: 'not-processed' }
  | { kind: 'processing'; pct: number; jobId: string }
  | { kind: 'processed'; source: 'sfm' | 'pins-only' }
  | { kind: 'failed'; message: string };
export function walkStatus(
  walk: WalkFile,
  processed: WalkProcessSummary | undefined,
  job: JobLike | undefined,
): WalkStatus;
export function playbackSrc(
  walk: WalkFile,
  processed: WalkProcessSummary | undefined,
  level: boolean,
): string;
export function autoStartParams(row: ImportRow, walk: WalkFile): WalkProcessParams | null; // null for a skipped row or a pack without walk.process
```

Copy (exact): status lines "Not processed", "Processing 42 %", "Processed", "Processed, path from pins only", "Processing failed: <message>"; action **Process walk**; dialog title "Locate the original of <name>" with buttons **Locate...** and **Without the original**; toggle **Level horizon**; greyed hint "Needs a newer pipeline pack" when the pack does not list `walk.process`.

- [ ] **Step 1: Failing tests:** each status case; `playbackSrc` prefers `stabilized` only with `level` true; auto-start params carry the import's source path and the walk id, none for an `.lrv` proxy row or a skipped row; the toggle's state is per walk and survives a list refresh.
- [ ] **Step 2:** Fail. **Step 3:** Implement, check at 1100 x 700 that the list line and toggle do not cover the view (`elementFromPoint` rule in CONTRIBUTING). **Step 4:** Pass. **Step 5:** Commit `feat(desktop): process walks and play the levelled copy`.

### Task 11: End to end

**Files:** Modify `apps/desktop/e2e/walk-360.spec.ts`; create `apps/desktop/e2e/walkSynth.ts` (calls `python -m tests.walk_synth`-equivalent through `QUADRION_E2E_PYTHON`, or a small ffmpeg-only clip with an appended synthetic trailer written in TypeScript: 4 s, 320 px lenses).

- [ ] **Step 1:** New test "processes an imported walk and plays the levelled copy": import the synthetic two-stream clip through the file dialog, the jobs panel shows **Process 360 walk**, it finishes within 180 s, the list reads "Processed" (or "Processed, path from pins only" for a texture-poor clip; accept both), the pane's video `src` ends in `stabilized.mp4`, toggling **Level horizon** switches it to `playback.mp4`. Skipped when the pipeline Python or ffmpeg is missing, as the job specs are.
- [ ] **Step 2:** Run the CI way from `apps/desktop`: `pnpm demo:build --quick`, then `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=1 npx playwright test e2e/walk-360.spec.ts --workers=1`; the log prints `[e2e] window 1100 x 720 px at display scale 1`. `--repeat-each=3` once.
- [ ] **Step 3:** Commit `test(e2e): walk processing in the 360 video flow`.

### Task 12: Benchmark and reference run

**Files:** Create `python/scripts/walk_bench.py`, `python/tests/test_walk_reference.py`. Modify root `package.json` (`"bench:walk": "uv run --project python python python/scripts/walk_bench.py"`).

- [ ] **Step 1:** `test_walk_reference.py`: skipped unless `QUADRION_WALK_REFERENCE` names a file; runs `walk.process` on the first 10 s into a temp project; asserts every SfM still registered, orientation finite, a levelled copy written. Marked `local`.
- [ ] **Step 2:** `walk_bench.py <file> [--limit-s N]`: runs the job into a temp project, prints and writes `bench.json` (seconds per stage, real-time factor, peak memory, CPU threads, ffmpeg encoder used). Pytest marker `bench`, skipped unless `QUADRION_WALK_BENCH` is set; never in CI.
- [ ] **Step 3:** Commit `chore(pipelines): walk benchmark and local reference check`.
- [ ] **Step 4 (founder window only):** run on a 15 minute walk; if over 30 minutes, try in order: hardware decode (`-hwaccel d3d11va`), NVENC for the levelled copy, `mapper: global`, fewer SfM stills (1.5 per second); record results here.

## Spike results

Built 12 Oct 2026; the reference X4 walk was read locally and read only, nothing of it is in git
but an anonymised trailer of 10.9 KB (`python/tests/fixtures/walk/x4-trailer.bin`).

**T2, the trailer (X4, version 3).**

- Footer: the last 72 bytes are 32 zero bytes, a u32 trailer length (from the trailer start to the end of the file), a u32 version and the 32 character mark.
- Records: payload, then a 6-byte descriptor `u8 format, u8 id, u32 size` (format 0 binary, 1 protobuf). The record before the footer is an index (id 0): 10-byte entries `u8 id, u8 format, u32 size, u32 offset`. The X4 leaves gaps between records, so the index is read first and the backward walk is only a fallback.
- Ids kept: 1 metadata (protobuf), 3 motion, 4 frame times; the rest (thumbnail, exposure, 3A, highlights, editor) are skipped.
- Metadata fields used: 1 serial (kept as a sha256 prefix only), 2 camera, 3 firmware, 5 offset, 24 first frame time (us), 27 window crop (5760 x 5760), 28 gyro time offset (ms), 62 raw gyro flag, 65 sensor ranges (32 g, 2000 deg/s).
- Motion: raw X4 encoding 20 bytes (u64 us, six u16 scaled by the ranges), 1 kHz; the older 56-byte float64 encoding is read too. Samples start about 0.1 s before the first frame; those are dropped.
- Frame times: 16-byte entries (u64 time, f64 exposure), eight pre-roll entries before the first frame.
- Offset string: `N_(radius_cx_cy_yaw_pitch_roll) x N_sensorW_sensorH_extra` in sensor pixels; each stream is a centred crop of its lens, scaled.
- Axes: camera (x right, y down, z forward) = (sz, sx, sy) of the X4 sensor. The first reading from the telemetry-parser orientation string had x and z the other way round; the levelling check in T4 showed the horizon tilting the wrong way, and this mapping levels it.

**T4, the stitch.**

- Both lens streams are upright; the calibration's roll of about 90 degrees is the sensor mount, so only the rest past the nearest quarter turn is applied, as `Ry(-yaw) Rx(pitch) Rz(-roll)`.
- Seam fit on 708 matches across six frames: median ray mismatch 0.15 degree with the trailer calibration (0.80 with the angles as written, 0.46 without them; a free fit of every parameter reaches 0.095).
- Equidistant fits (a polynomial term came out at zero). The calibrated radius means a 193.5 degree lens (`CALIBRATED_FOV_DEG`); at the old 195 degrees the seam was off by about 1.5 degrees and a pillar on it was doubled.
- Lens 0 is the walking direction and the picture centre; the operator is in lens 1.
- Time on this workstation, 3840 x 1920 from two 2880 px HEVC streams: decode about 82 ms per output frame (the bottleneck), stitch 21 ms cached or 61 to 75 ms levelled, encode 2.5 ms; the frames step of an 82 s walk takes about 4 to 5 minutes. Hardware HEVC decode is the first lever for the benchmark.

**T8, ffmpeg in the pack.** conda-forge's GPL `ffmpeg` 9.0.2 for win-64 has libx264, `v360` and the HEVC decoder, so the BtbN fallback is not needed. Pruned to what ffmpeg and ffprobe load: about 141 MB, which takes the Windows pack to about 1,245 MB; the founder approved a 1,300 MB budget (12 Oct 2026). FFmpeg 9 prints two flag columns in `-filters`; the check reads both forms.

## Verification before hand-off

- `pnpm check` green; `uv sync --frozen` then `uv run pytest tests/test_walk_*.py` in `python/`.
- The e2e spec the CI way (Task 11 step 2), plus `jobs.spec.ts` unchanged and green.
- `node tools/agent/check-public-text.mjs docs/plans/2026-10-12-walk-process-pipeline*.md` and the session note.

## How to test (for the founder, after the build)

1. Install the new pipeline pack (Settings, Pipeline pack) built from this branch; it now has its own ffmpeg, so remove ffmpeg from the PATH first if you want to prove that.
2. Open a project, choose **Add 360 video** in the command palette and pick your reference `.insv` walk.
3. The import stitches as before; when it finishes, the jobs panel shows **Process 360 walk** running. The 360 video list under the dataset tree says "Processing ... %".
4. Wait until it says "Processed" (about 10 minutes for an 80 s clip on a laptop CPU).
5. Open the walk: it plays the levelled copy. The horizon stays level while the stick swings; seams at the sides of the picture are fainter than before.
6. Click **Level horizon** off: the original wobbling copy plays; on again: levelled.
7. In the project folder, `walks/<id>/` now holds `process.json`, `raw-path.json`, `orientation.bin`, `imu.bin`, `sparse.ply`, `stills/` and `stabilized.mp4`. Open `sparse.ply` in any point viewer: the walk's surroundings in points.
8. A walk imported before this build: open its menu in the 360 video list, **Process walk**, locate the original `.insv` (or **Without the original**: no levelled copy, path from the playback copy).
9. Placing the walk on a map is not in this branch (it comes with `feat/walk-layer-and-placing`).
