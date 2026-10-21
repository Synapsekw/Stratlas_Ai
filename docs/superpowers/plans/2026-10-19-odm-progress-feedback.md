# Progress feedback while photos are aligned Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The run panel shows, during "Align the photos" and the ground control re-run, a bar that moves within each OpenSfM sub-step, the sub-step in plain words with "N of M", elapsed time, a cautious estimate, "Last activity N s ago", and a "may be stuck" notice after 15 minutes without any activity.

**Architecture:** Python measures everything: a pure parser (`photo/odm/sfm_progress.py`) turns ODM's printed lines into sub-steps, counts and a bar fraction; a liveness meter (`photo/odm/liveness.py`) folds lines, counts, work-folder writes and a short-window CPU reading into `lastActivityAt`. `run_odm` sends both as an optional `live` object on the existing `progress` notification. Main stores it on the job record (`JobRecord.live`, `JobRecord.startedAt`); the renderer formats it and decides when to show the notice (15 minutes is a renderer constant).

**Tech Stack:** Python 3.13 (pytest, ruff), TypeScript (zod in `@aio/schema`, Electron main, React renderer, vitest), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-19-odm-progress-feedback-design.md`

## Global Constraints

- Windows only; ODM 3.6.2 as shipped. Never patch ODM's files: parse what it prints and writes.
- New contract fields are optional: an older pack with this app, and this pack with an older app, both keep working. No `APP_RANGE` change, no pack version bump in this branch (releases bump it).
- Contract change gets a row in `docs/architecture/contract-changes.md` (columns: Date | Change | Why | Streams affected | Approved by; "Pending founder review").
- Progress emissions stay throttled by the existing `PROGRESS_MIN_INTERVAL_S = 0.2` in `runtime.py`; do not add another emit path.
- No raw engine log text or OpenSfM names in the UI (`opensfm`, `detect_features`, `match_features`, `create_tracks`, `reconstruct`, `SIFT`, `bundle`).
- The bar never goes backwards (Python fractions use `max`, as today).
- Show no estimate rather than a bad one. Never cancel a job because of the notice.
- Exact UI copy fixed by the spec: "Finding features: 212 of 500 photos", "Matching photos: 4,210 of 12,467 pairs", "Building the 3D model: 312 of 500 photos placed", "about 12 min left", "Last activity 8 s ago", "No progress for 15 minutes. The job may be stuck.", buttons "Cancel job" and "Keep waiting".
- Fixtures and docs are public: no project, site, client or person names, no coordinates, no user paths. Run `node tools/agent/check-public-text.mjs <files>` on every added fixture and doc.
- Repo rules (CLAUDE.md): work only in `.claude/worktrees/odm-progress-feedback`; conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `--no-verify`, never bare `git stash`. Parallel agents share this one worktree: stage only your own paths and commit with `git commit -F <msg> -- <paths>`.

**Running Python in this worktree** (it has no `python/.venv`): from `python/`, in PowerShell:
`$env:PYTHONPATH='src;tests'; $env:PYTHONDONTWRITEBYTECODE='1'; & 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe' -m pytest <tests> -q`
First check `python -c "import aio_pipelines; print(aio_pipelines.__file__)"` prints the worktree's `python\src`. Lint the same way with `-m ruff check .` and `-m ruff format --check .` (run `-m ruff format <files>` yourself before committing). Never `uv sync` against the main venv.

## Review Focus

1. **Line variants**: a line with ANSI colour codes, a `\r` ending, or an ODM folder path with spaces inside the quoted program path still counts and still starts its sub-step (test in Task 2).
2. **Photo count unknown** (`image_list.txt` missing when features start, e.g. an ODM that skipped setup): the detail shows a count without a total, no estimate, the bar stays at the sub-step start instead of jumping (test in Task 2).
3. **Reconstruction ends short of the photo count** (993 of 1,003 on 16 Oct): within-sub-step fraction is capped at 0.99 and the sub-step completes only on the next sub-step's line (test in Task 2).
4. **Renderer reload or panel reopened during a quiet stretch**: the notice comes back from the job record alone; "Keep waiting" is forgotten, which is allowed (test in Task 8: a fresh mount with a record quiet for 16 minutes shows the notice).
5. **Odd timestamps**: `lastActivityAt` slightly in the future (ms skew) or unparsable shows "Last activity 0 s ago" (never negative) and never raises the notice (test in Task 7).

---

## File Structure

| File                                                                                      | Responsibility                                                                     |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/schema/src/jobs.ts`                                                             | `JobLiveDetail`, `JobLive`; `JobRecord.startedAt`, `JobRecord.live`                |
| `python/src/aio_pipelines/photo/odm/sfm_progress.py` (new)                                | Pure: OpenSfM sub-step table, line parser, counts, fraction, estimate              |
| `python/src/aio_pipelines/photo/odm/liveness.py` (new)                                    | Activity meter: lines, counts, folder writes, CPU busy now → `last_at`             |
| `python/tests/fixtures/odm_log/first-run.log`, `resumed-run.log` (new)                    | Sanitised excerpts of the 16 Oct log                                               |
| `python/src/aio_pipelines/runtime.py`                                                     | `progress(..., live=)` carried on the `progress` notification                      |
| `python/src/aio_pipelines/photo/odm/flags.py`, `runner.py`                                | Stage rebalance, wiring parser + liveness into `run_odm`, watchdog failure code    |
| `python/tests/fake_odm/fake_odm.py`                                                       | Prints OpenSfM-shaped lines in its opensfm stage                                   |
| `apps/desktop/src/main/jobs/runner.ts`, `store.ts`                                        | Store `live` and `startedAt`; clear `live` when a job ends or is loaded as stopped |
| `apps/desktop/src/renderer/photogrammetry/liveStatus.ts` (new)                            | Pure formatting and the notice rule                                                |
| `apps/desktop/src/renderer/photogrammetry/JobLive.tsx` (new), `RunPanel.tsx`, `photo.css` | Status line, notice, watchdog message                                              |
| `apps/desktop/e2e/photo-process.spec.ts`                                                  | The live line on the real run panel                                                |

## Execution DAG

| Task | Depends on  | Packages / areas                                              |
| ---- | ----------- | ------------------------------------------------------------- |
| 1    | none        | `@aio/schema`, docs                                           |
| 2    | none        | python (`photo/odm/sfm_progress.py`, fixtures)                |
| 3    | 2 (fixture) | python (`photo/odm/liveness.py`)                              |
| 4    | none        | python (`runtime.py`, `photo/products.py`)                    |
| 5    | 2, 3, 4     | python (`photo/odm/runner.py`, `flags.py`, fake ODM)          |
| 6    | 1           | desktop main (`main/jobs`)                                    |
| 7    | 1           | desktop renderer (`photogrammetry/liveStatus.ts`, `store.ts`) |
| 8    | 7           | desktop renderer (`JobLive.tsx`, `RunPanel.tsx`, `photo.css`) |
| 9    | 5, 6, 8     | desktop e2e                                                   |

Parallel batches (no shared files inside a batch; dispatch each batch in one message):

- **Batch A:** Tasks 1, 2, 4
- **Batch B:** Tasks 3, 6, 7
- **Batch C:** Tasks 5, 8
- **Batch D:** Task 9, then final verification

**Critical path:** 2 → 3 → 5 → 9. Task 4's only consumer is 5; Tasks 1 → 7 → 8 run beside it.

E2E specs changed: `apps/desktop/e2e/photo-process.spec.ts` (and re-run unchanged `gcp-marking.spec.ts`, which also reads `photo-job`). Contract change: Task 1.

---

### Task 1: Contract: live progress fields

**Files:**

- Modify: `packages/schema/src/jobs.ts` (beside `JobFailure`, `JobRecord` at ~1340-1369)
- Modify: `docs/architecture/contract-changes.md` (append a row)
- Test: `packages/schema/src/jobs.test.ts`

**Interfaces:**

- Produces (exported from `@aio/schema`):
  - `JobLiveDetail = z.object({ label: z.string().min(1).max(80), done: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(), unit: z.string().min(1).max(40).optional() })`
  - `JobLive = z.object({ detail: JobLiveDetail.optional(), stepStartedAt: z.string().optional(), lastActivityAt: z.string().optional(), etaSeconds: z.number().nonnegative().finite().optional() })`
  - `JobRecord` gains `startedAt: z.string().optional()` (when the current attempt started; set on start and on resume) and `live: JobLive.optional()` (only while a step that measures activity runs).
  - Types `JobLive`, `JobLiveDetail`.

- [ ] **Step 1: Write the failing tests** in `jobs.test.ts`:
  - `it('a job record carries live progress and its start, both optional')`: `JobRecord.parse({...record, startedAt: '2026-10-19T10:00:00.000Z', live: { detail: { label: 'Matching photos', done: 4210, total: 12467, unit: 'pairs' }, stepStartedAt: '…', lastActivityAt: '…', etaSeconds: 720 } })` keeps `live.detail.total === 12467`; `JobRecord.parse(record).live` is `undefined`.
  - `it('refuses a bad live object')`: `JobLive.safeParse({ etaSeconds: -1 }).success === false`, `JobLive.safeParse({ detail: { label: '' } }).success === false`, `JobLive.safeParse({ detail: { label: 'x', done: 1.5 } }).success === false`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm vitest run packages/schema/src/jobs.test.ts` (JobLive not exported).
- [ ] **Step 3: Implement** the schemas above with one-line doc comments (who sends it, that it is optional for older packs).
- [ ] **Step 4: Run, expect PASS**; then `pnpm typecheck`.
- [ ] **Step 5: Add the contract row**: `| 2026-10-19 | Additive, optional: JobRecord.startedAt and JobRecord.live (JobLive: detail {label, done, total, unit}, stepStartedAt, lastActivityAt, etaSeconds); the pipelines' progress notification may carry the same object as "live". A pack without it and an app without it both keep working; failure code "odm-stalled" (data.minutes) names the ODM watchdog stop | Progress feedback while photos are aligned (this PR) | @aio/schema, desktop (main, renderer), python (photo/odm) | Pending founder review |`. Run `npx prettier --write docs/architecture/contract-changes.md`.
- [ ] **Step 6: Commit** `feat(schema): optional live progress on job records` (the three files).

---

### Task 2: OpenSfM sub-step parser and the log fixtures

**Files:**

- Create: `python/src/aio_pipelines/photo/odm/sfm_progress.py`
- Create: `python/tests/fixtures/odm_log/first-run.log`, `python/tests/fixtures/odm_log/resumed-run.log`
- Test: `python/tests/test_odm_sfm_progress.py`

**Interfaces:**

- Produces:
  - `@dataclass(frozen=True) class SubStep: key: str; label: str; unit: str | None; weight: float; eta: bool`
  - `SUBSTEPS: tuple[SubStep, ...]`, in this order, weights summing to 100 (16 Oct minutes, rounded):

    | key           | label                             | unit            | weight | eta   |
    | ------------- | --------------------------------- | --------------- | ------ | ----- |
    | `setup`       | Getting the photos ready          | None            | 2      | False |
    | `features`    | Finding features                  | `photos`        | 4      | True  |
    | `matching`    | Matching photos                   | `pairs`         | 25     | True  |
    | `tracks`      | Linking the matches               | None            | 3      | False |
    | `reconstruct` | Building the 3D model             | `photos placed` | 52     | False |
    | `statistics`  | Checking the model                | None            | 5      | False |
    | `geocoords`   | Placing the model on the map      | None            | 1      | False |
    | `undistort`   | Preparing the photos for the maps | `photos`        | 8      | True  |

    No estimate for the reconstruction: its pace is not steady (long silent adjustments between bursts).

  - `def photo_count(project_dir: Path) -> int | None` — non-empty lines of `opensfm/image_list.txt`; None when missing.
  - `class SfmProgress(photo_count: Callable[[], int | None], clock: Callable[[], float] = time.time)` with:
    - `current: str | None` (a `SubStep.key`), `step_started_at: float | None` (wall clock, `clock()`)
    - `feed(line: str) -> bool` — True when the line started or completed a sub-step or moved a count. Lines arrive ANSI-stripped.
    - `set_undistorted(n: int) -> bool` — the `.tif` count in `opensfm/undistorted/images` (True when it rose).
    - `fraction() -> float` — 0..1 of the opensfm stage, never lower than before.
    - `detail() -> dict[str, Any] | None` — `{"label", "done"?, "total"?, "unit"?}` for `current`; `done`/`total` only for sub-steps with a unit; None when `current` is None.
    - `eta_seconds() -> float | None`
    - `finish() -> None` — "Finished opensfm stage": fraction 1.0, `current` None.

Line rules (all from the 16 Oct log and ODM 3.6.2's `opendm/osfm.py`, read-only):

| Meaning                   | Pattern (regex, searched)                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| setup starts              | `Running opensfm stage`                                                                                                                                                                                                                                                                                                                    |
| sub-step starts           | `running\s+"[^"]*"\s+(detect_features\|match_features\|create_tracks\|reconstruct\|export_geocoords)\b` → features, matching, tracks, reconstruct, geocoords; `Export reconstruction stats` → statistics; `Undistorting .+ \.\.\.` → undistort                                                                                             |
| sub-step already done     | `already exists, not rerunning OpenSfM setup` → setup; `Detect features already done` → features; `Match features already done` → matching; `Found a valid OpenSfM tracks file` → tracks; `Found a valid OpenSfM reconstruction file` → reconstruct; `Found existing reconstruction stats` → statistics; `Already undistorted` → undistort |
| features count            | distinct names from `Extracting \S+ features for image (\S+)`; total `photo_count()`                                                                                                                                                                                                                                                       |
| matching total / one pair | `INFO: Matching (\d+) image pairs` / `DEBUG: Matching \S+ and \S+\.\s+Matcher:`                                                                                                                                                                                                                                                            |
| reconstruction count      | distinct names from `Starting reconstruction with (\S+) and (\S+)` and `Adding (\S+) to the reconstruction`; total `photo_count()`                                                                                                                                                                                                         |

Semantics: starting sub-step k marks every earlier one complete and resets k's count to zero (a re-run counts from zero). An "already done" line marks that sub-step and every earlier one complete and makes the next sub-step `current` (so the status names the first sub-step that really runs, and the bar jumps to its start). `fraction() = max(previous, (Σ weights of complete + weight(current) × within) / 100)`, `within = min(done / total, 0.99)` for a counted sub-step with a total, else 0. The photo count is read once it is not None and then cached.

Estimate (only for `eta=True` sub-steps): keep `(t, done)` samples of the current sub-step. Return None unless total is known, `done < total`, at least 60 s since the first counted sample, and `done − done_first ≥ max(20, 0.05 × total)`. `rate_all` = growth since the first sample per second; `rate_recent` = growth over the samples of the last 60 s (needs samples spanning ≥ 20 s). Steady when `0.75 ≤ rate_recent / rate_all ≤ 1.33`; then `round((total − done) / rate_all)`, else None.

- [ ] **Step 1: Make the fixtures.** With a throwaway Node script in your scratch folder (not committed), copy from the 16 Oct log, `E:\Stratlas Data\projects\<the 16 Oct project>\photogrammetry\20261016-1408\odm-logs\20261016-140833-photo-align-un4p-sfm\odm.log` (the session lead has the project folder name; it stays out of the repo), these 1-based line ranges:
  - `first-run.log`: 96-117, 119-160, 2126-2170, 14590-14640, 17000-17069 (the first ODM run; its last line is `15:12:25 … naive 3D-3D alignment.`). Line 118 is the long config dump: leave it out.
  - `resumed-run.log`: 17165-17220, 20060-20284 (the run that starts at 16:07; it holds the "already exists"/"already done"/"Found a valid … tracks" lines, the 6.4-minute gap between `16:46:13,380` and `16:52:39,944`, statistics, geocoords, `Undistorting`, `Finished opensfm stage`).
  - Replace `C:\Users\D\AppData\Local\QuadrionODM\odm-work\<hex>` with `C:\odm-work\project`, `C:\Users\D\AppData\Local\QuadrionODM\odm-3.6.2` with `C:\odm`, and the `export_geocoords` arguments `--proj "…" --offset-x <n> --offset-y <n>` with `--proj "+proj=utm +zone=1 +datum=WGS84 +units=m +no_defs +type=crs" --offset-x 0.0 --offset-y 0.0`.
  - Check: no line matches `Users|zone=39|209202|3255098`; each file is about 22 KB; `node tools/agent/check-public-text.mjs python/tests/fixtures/odm_log/*.log` passes. Expected contents (the tests below rely on them): first run — 20 distinct feature photos, `Matching 12467 image pairs` then 48 pair lines, seed `00430.jpg and 00431.jpg` plus 28 `Adding` lines (30 placed). Resumed run — no feature or pair lines, seed plus 73 `Adding` lines (75 placed).
- [ ] **Step 2: Write the failing tests** (`photo_count` stubbed as `lambda: 1003`; a helper `feed_until(sp, lines, needle)` feeds lines up to, not including, the first line containing `needle`):
  - `test_first_run_counts_features_pairs_and_placed_photos`: before `match_features`: `detail() == {"label": "Finding features", "done": 20, "total": 1003, "unit": "photos"}`; before `create_tracks`: `{"label": "Matching photos", "done": 48, "total": 12467, "unit": "pairs"}`; at the end: `current == "reconstruct"`, `detail() == {"label": "Building the 3D model", "done": 30, "total": 1003, "unit": "photos placed"}`.
  - `test_fraction_moves_with_the_counts_and_never_back`: fractions after each line are non-decreasing; right after the `reconstruct` running line `fraction() == pytest.approx(0.34)`.
  - `test_a_resumed_run_counts_done_sub_steps_and_restarts_the_count`: after the `Found a valid OpenSfM tracks file` line: `current == "reconstruct"`, `fraction() == pytest.approx(0.34)`, `detail()["done"] == 0`, label "Building the 3D model"; after the seed line `done == 2`; just before `Export reconstruction stats`: `done == 75`; after `Undistorting`: `current == "undistort"`, `fraction() == pytest.approx(0.92)`; after `finish()`: `fraction() == 1.0`, `detail() is None`.
  - `test_a_photo_added_twice_counts_once`: seed line, then `Adding 00432.jpg to the reconstruction` twice → `done == 3`.
  - `test_reconstruction_short_of_the_photo_count_waits_for_the_next_step` (Review Focus 3): photo count 3, seed + `Adding c.jpg` → within capped: `fraction() == pytest.approx((34 + 52 * 0.99) / 100)`; `Export reconstruction stats` → `fraction() == pytest.approx(0.86)`.
  - `test_line_variants_still_count` (Review Focus 1): `\x1b[32m`-wrapped lines are fed after ANSI stripping by the caller, so test the parser with a `running "C:\Program Files\odm\opensfm" detect_features "C:\odm-work\my project\opensfm"` line (starts features) and a line with a trailing `\r` stripped (`str.strip()` inside `feed`).
  - `test_an_unknown_photo_count_shows_a_count_without_a_total` (Review Focus 2): `photo_count` returns None; after two feature lines `detail() == {"label": "Finding features", "done": 2, "unit": "photos"}`, `eta_seconds() is None`, `fraction() == pytest.approx(0.02)` (setup complete, features at its start).
  - `test_undistort_counts_tif_files`: in undistort, `set_undistorted(250)` with 1003 photos → `detail()["done"] == 250`; `set_undistorted(100)` returns False and keeps 250.
  - `test_estimate_only_with_a_steady_rate` (fake clock): features, 1003 photos, one new photo every 0.15 s: None at 59 s; at 70 s `eta_seconds() == pytest.approx((1003 - 467) / (1 / 0.15), abs=2)`; then the rate drops to one photo every 0.6 s for 60 s → None; no estimate ever in `reconstruct`.
- [ ] **Step 3: Run, expect FAIL** — `… -m pytest tests/test_odm_sfm_progress.py -q` (module missing).
- [ ] **Step 4: Implement** `sfm_progress.py` per the interfaces and tables above (module docstring names ODM 3.6.2 and the 16 Oct log as the source of the patterns and weights).
- [ ] **Step 5: Run, expect PASS**; ruff check and format.
- [ ] **Step 6: Commit** `feat(photo): count OpenSfM sub-steps from ODM's lines` (module, fixtures, test).

---

### Task 3: Activity meter

**Files:**

- Create: `python/src/aio_pipelines/photo/odm/liveness.py`
- Test: `python/tests/test_odm_liveness.py`

**Interfaces:**

- Consumes: `python/tests/fixtures/odm_log/resumed-run.log` (Task 2); `proctree.TreeCpu().sample(pid) -> float` (CPU seconds of the tree, existing).
- Produces:
  - `BUSY_EVERY_S = 5.0`; `BUSY_NOW_SHARE = 0.25` (share of one core over the last sample that counts as busy now)
  - `WATCH_DIRS = ("", "opensfm", "opensfm/features", "opensfm/matches", "opensfm/undistorted", "opensfm/undistorted/images")` (relative to the ODM project folder; a folder's mtime changes when a file is created in it)
  - `class Liveness(work_dir: Path, *, clock: Callable[[], float] = time.time, cpu: Callable[[int], float] | None = None, mtime: Callable[[Path], float | None] | None = None, every: float = BUSY_EVERY_S)` with `last_at: float` (wall clock, starts at `clock()`), `touch(at: float | None = None) -> None`, `poll(pid: int) -> None` (does work at most once per `every`: touches when CPU growth since the previous sample ≥ `BUSY_NOW_SHARE × elapsed`, or when any watched folder's mtime is newer than seen before; the first sample is only a baseline).
  - `def iso_at(t: float) -> str` — UTC ISO with milliseconds and `Z` (`2026-10-16T16:46:13.380Z`).

- [ ] **Step 1: Write the failing tests** (fake clock, `cpu` and `mtime` injected; a helper parses `YYYY-MM-DD HH:MM:SS,mmm` timestamps from the fixture):
  - `test_a_busy_silent_stretch_stays_alive` (the anti-false-alarm test): clock runs from the fixture's `16:46:13,380` line to its `16:52:39,944` line in 1 s steps, `touch` at the first line, no lines in between, `cpu` grows 4 CPU-seconds per 5 s, `poll` every step → `max(now − last_at)` over the stretch `≤ BUSY_EVERY_S + 1`.
  - `test_an_idle_silent_stretch_is_reported_as_quiet`: same stretch, `cpu` flat, mtimes unchanged → at the end `now − last_at == pytest.approx(386.564, abs=0.01)`.
  - `test_a_new_file_in_the_work_folder_counts`: flat CPU; at t+40 the mtime of `opensfm/matches` rises → `last_at` is within `every` of t+40.
  - `test_a_line_or_count_touches`: `touch()` sets `last_at = clock()`; `touch(at)` never moves `last_at` backwards.
  - `test_iso_at`: `iso_at(0) == "1970-01-01T00:00:00.000Z"`.
- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement** `liveness.py`; the default `cpu` is a `proctree.TreeCpu().sample`, the default `mtime` is `Path.stat().st_mtime` with `OSError → None`.
- [ ] **Step 4: Run, expect PASS**; ruff.
- [ ] **Step 5: Commit** `feat(photo): measure ODM activity from lines, files and CPU`.

---

### Task 4: `live` on the progress notification

**Files:**

- Modify: `python/src/aio_pipelines/runtime.py:244-254` (`StepContext.progress`), `:332-346` (`Job.emit_progress`)
- Modify: `python/src/aio_pipelines/photo/products.py:135-148` (`_Within.progress` forwards `live`)
- Test: `python/tests/test_runtime.py`

**Interfaces:**

- Produces: `StepContext.progress(fraction: float, message: str | None = None, *, live: dict[str, Any] | None = None) -> None`; `Job.emit_progress(index, state, step_fraction, message=None, live=None)` adds `"live": live` to the notification when given. Throttle unchanged (a live-only update goes out on the next call after 0.2 s). `_Within.progress(fraction, message=None, *, live=None)` passes `live` on.

- [ ] **Step 1: Write the failing tests** with the file's emit recorder: `test_progress_carries_live_when_given`: a step calling `ctx.progress(0.5, "x", live={"lastActivityAt": "2026-10-19T10:00:00.000Z"})` emits a `progress` with `params["live"] == {"lastActivityAt": …}`; one calling `ctx.progress(0.6)` after 0.2 s emits no `live` key.
- [ ] **Step 2: Run, expect FAIL** (unexpected keyword `live`).
- [ ] **Step 3: Implement** the two signatures and the `_Within` forward.
- [ ] **Step 4: Run** `tests/test_runtime.py tests/test_photo_products.py -q`, expect PASS; ruff.
- [ ] **Step 5: Commit** `feat(pipelines): progress may carry live activity`.

---

### Task 5: Wire it into `run_odm`

**Files:**

- Modify: `python/src/aio_pipelines/photo/odm/flags.py` (after `stage_window`)
- Modify: `python/src/aio_pipelines/photo/odm/runner.py` (`StageProgress` 228-263, `OdmStalled` raise 405-410, `run_odm` 533-598)
- Modify: `python/tests/fake_odm/fake_odm.py` (`stage_opensfm`, `main`)
- Test: `python/tests/test_odm_runner.py`, `python/tests/test_odm_flags.py`

**Interfaces:**

- Consumes: `SfmProgress`, `photo_count`, `SUBSTEPS` (Task 2); `Liveness`, `iso_at` (Task 3); `ctx.progress(..., live=)` (Task 4).
- Produces:
  - `flags.STAGE_WEIGHT: dict[str, float]` = each stage's ODM percent span (`STAGE_END[s] − stage_start(s)`), except `"dataset": 0.5` (reading the photos takes seconds; today it holds 20 % of the align step, which is why opensfm starts at 21 %).
  - `flags.stage_span(first: str, last: str, stage: str) -> tuple[float, float]` — the stage's share of the step window by `STAGE_WEIGHT`. Windows without `dataset` (products, georef) map exactly as today.
  - `StageProgress(first, last, sfm: SfmProgress | None = None)`: stage lines map through `stage_span`; while `stage == "opensfm"` every line, ANSI-stripped (`ANSI.sub("", line)`), also goes to `sfm.feed`, and the opensfm fraction is `lo + (hi − lo) × max(sfm.fraction(), udp_within)`; `Finished opensfm stage` calls `sfm.finish()`. New attribute `stage_started_at: float | None` (wall clock). UDP stays a backup.
  - `OdmStalled(..., code="odm-stalled", data={"minutes": stall_seconds() / 60})` (message text unchanged).
  - `run_odm` sends on every bar update: `live = {"lastActivityAt": iso_at(liveness.last_at)}`, plus `"stepStartedAt"` (`sfm.step_started_at` inside opensfm, else `sp.stage_started_at`), `"detail": sfm.detail()` and `"etaSeconds"` when not None. The message becomes the sub-step label inside opensfm. Each line and each count rise calls `liveness.touch()`. `on_poll` becomes one callable: `liveness.poll(proc.pid)`; in `undistort`, every 2 s `sfm.set_undistorted(<count of *.tif in opensfm/undistorted/images>)`; then the existing `Watchdog`. A sub-step start writes one plain job-log line: the label, plus `: {total:,} {unit}` when the total is known (`Matching photos: 12,467 pairs`).
  - Fake ODM: when its opensfm stage runs, it prints OpenSfM-shaped lines over its own photos (`running "<fake>\opensfm" detect_features "<sfm>"`, `Extracting SIFT features for image <name>` each, `match_features`, `INFO: Matching <n−1> image pairs`, one `DEBUG: Matching a and b.  Matcher: FLANN` per neighbouring pair, `create_tracks`, `reconstruct`, `Starting reconstruction with <first> and <second>`, `Adding <name> to the reconstruction` for the rest, `[INFO]    Export reconstruction stats`, `export_geocoords`), sleeping `FAKE_ODM_LINE_S` (default 0) after each.

- [ ] **Step 1: Write the failing tests:**
  - `test_odm_flags.py::test_reading_the_photos_holds_a_small_share_of_the_align_step`: `F.stage_span("dataset", "opensfm", "dataset") == pytest.approx((0.0, 0.5 / 20.5))`; `F.stage_span("openmvs", "odm_filterpoints", "openmvs") == pytest.approx((0.0, 25 / 27))`.
  - `test_odm_runner.py::test_align_names_its_sub_steps_with_counts_while_the_port_is_taken`: bind the UDP port first (no datagrams); `FAKE_ODM_LINE_S=0.05`; fresh opensfm; the `Ctx` double records `live`. Assert: the labels seen include "Finding features", "Matching photos", "Building the 3D model"; some detail equals `{"label": "Matching photos", "done": k, "total": n − 1, "unit": "pairs"}` for the fake's photo count n; every `live` has an ISO `lastActivityAt`; no label or message matches `opensfm|detect_features|create_tracks|reconstruct\b`; fractions are non-decreasing with at least five distinct values below 1.0; `("Matching photos: <n−1> pairs", "info")` is in the job log.
  - Extend `test_a_stalled_odm_is_stopped_with_a_plain_message`: the raised error has `code == "odm-stalled"` and `data == {"minutes": 0.05}`.
  - `test_stage_progress_maps_odm_percent_onto_the_step_and_never_steps_back` and the UDP test must pass unchanged.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**; update both `Ctx` doubles in `test_odm_runner.py` (lines ~26 and ~187) to `progress(self, f, m=None, *, live=None)` and record `live`.
- [ ] **Step 4: Run** `tests/test_odm_runner.py tests/test_odm_flags.py tests/test_fake_odm.py tests/test_odm_sfm_progress.py tests/test_odm_liveness.py tests/test_photo_align.py tests/test_photo_georef.py tests/test_photo_products.py -q`, expect PASS; ruff check and format.
- [ ] **Step 5: Commit** `feat(photo): plain sub-steps, counts and activity while ODM aligns`.

---

### Task 6: Main keeps `live` and `startedAt` on the job record

**Files:**

- Modify: `apps/desktop/src/main/jobs/runner.ts` (`start` ~150-200, `finish` 338-350, `onNotification` `progress` case 491-531)
- Modify: `apps/desktop/src/main/jobs/store.ts:33-38` (loaded as interrupted)
- Modify: `apps/desktop/src/main/jobs/__fixtures__/fake-runtime.mjs` (new `FAKE_MODE=live`)
- Test: `apps/desktop/src/main/jobs/runner.test.ts`, `store.test.ts`

**Interfaces:**

- Consumes: `JobLive`, `JobRecord` (Task 1).
- Produces: `JobRecord.startedAt` = `this.iso()` on every start and resume. A running-step `progress` notification replaces `job.live` with `JobLive.safeParse(params.live).data` when valid and deletes it when absent or invalid; a `done`/`skipped` step notification deletes it. `finish()` and a resume delete `live`; the store's interrupted-on-load path deletes it.

- [ ] **Step 1: Write the failing tests:**
  - `it('keeps live progress while a step runs and drops it when the job ends')`: `FAKE_MODE=live` sends one progress with a valid `live` (detail Matching photos 10 of 20 pairs, `lastActivityAt`, `stepStartedAt`, `etaSeconds: 30`), then one with `live: { etaSeconds: -1 }`, then finishes. Assert an `update` event whose `job.live.detail` equals the sent detail, a later update with no `live`, final record without `live`, `startedAt` defined; a resume sets a new `startedAt`.
  - `store.test.ts`: a saved running job with `live` loads as `interrupted` without `live`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm vitest run apps/desktop/src/main/jobs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(desktop): keep live job progress in the job record`.

---

### Task 7: Renderer: formatting and the notice rule

**Files:**

- Create: `apps/desktop/src/renderer/photogrammetry/liveStatus.ts`
- Modify: `apps/desktop/src/renderer/photogrammetry/store.ts` (photo UI store)
- Test: `apps/desktop/src/renderer/photogrammetry/liveStatus.test.ts`, `store.test.ts`

**Interfaces:**

- Consumes: `JobRecord`, `JobLiveDetail` (Task 1); `isActive` from `../jobs`.
- Produces:
  - `STALL_NOTICE_MS = 15 * 60_000`
  - `formatDuration(ms: number): string` — `< 60 s` → `"8 s"`; `< 60 min` → `"4 min"` (floor); else `"1 h 05 min"`; negative or NaN → `"0 s"`.
  - `detailLine(d: JobLiveDetail): string` — `"Matching photos: 4,210 of 12,467 pairs"`; without total `"Finding features: 212 photos"`; without unit `"Linking the matches"`. Numbers via `toLocaleString('en-GB')`.
  - `etaWords(seconds: number): string` — `"about 12 min left"` (minutes rounded up), under 60 s `"less than a minute left"`.
  - `interface LiveStatus { line: string | null; stepElapsed: string | null; eta: string | null; jobElapsed: string; activity: string; quietMs: number }`
  - `liveStatus(job: JobRecord, now: number): LiveStatus` — `jobElapsed` from `startedAt ?? createdAt`; `activity` = `"Last activity 8 s ago"` from `live.lastActivityAt ?? updatedAt`, clamped at 0, unparsable → `now`.
  - `showStuck(job: JobRecord, now: number, keptWaitingAt?: number): boolean` — true only when `isActive(job)`, status is not `cancelling`, `job.live?.lastActivityAt` parses, and `now − max(lastActivity, keptWaitingAt ?? 0) ≥ STALL_NOTICE_MS`.
  - `watchdogWords(job: JobRecord): string | null` — for `failure.code === 'odm-stalled'`: `"The processing engine was stopped after 60 minutes with no activity. The work so far is kept; press Resume to try again."` (minutes from `failure.data.minutes`, default 60, shown without trailing zeros); otherwise null.
  - Photo UI store: `keptWaiting: Record<string, number>` and `keepWaiting(jobId: string, at: number): void` (memory only, never persisted).

- [ ] **Step 1: Write the failing tests:** the formatting examples above verbatim; `showStuck` at 14 min 59 s → false, at 15 min → true; Keep waiting pressed at 15 min → false at 29 min 59 s, true at 30 min; activity after Keep waiting restarts the 15 minutes; a record whose `lastActivityAt` stays fresh while the engine log is silent for 6.4 minutes → false (anti-false-alarm on the UI side); no `live` → false; `cancelling` → false; `lastActivityAt` 500 ms in the future → activity `"Last activity 0 s ago"` and false; unparsable → false (Review Focus 5); `watchdogWords` with `{ code: 'odm-stalled', data: { minutes: 60 } }` and with another code; `keepWaiting` stores per job.
- [ ] **Step 2: Run, expect FAIL** — `pnpm vitest run apps/desktop/src/renderer/photogrammetry/liveStatus.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(desktop): words for live job progress and the stuck rule`.

---

### Task 8: Run panel: status line, notice, watchdog message

**Load the `impeccable` design skill (and `frontend-design`) before touching the UI.** Layout and spacing are yours within `photo.css`'s existing tokens; the copy is fixed by Task 7 and the spec. One status line plus the notice: no log area.

**Files:**

- Create: `apps/desktop/src/renderer/photogrammetry/JobLive.tsx`
- Modify: `apps/desktop/src/renderer/photogrammetry/RunPanel.tsx:355-392` (under the bar) and its `job.error` block
- Modify: `apps/desktop/src/renderer/photogrammetry/photo.css`
- Test: `apps/desktop/src/renderer/photogrammetry/JobLive.test.tsx` (the `createRoot` + `act` style of `ProcessWizard.test.tsx`)

**Interfaces:**

- Consumes: `liveStatus`, `showStuck`, `watchdogWords`, `STALL_NOTICE_MS` (Task 7); `photoUi.getState().keepWaiting`, `keptWaiting`; `cancelRun(run, jobId)` from `./actions` (the existing cancel path: `jobs:cancel`, then the run is marked cancelled).
- Produces: `export function JobLive(props: { job: JobRecord; now: number; fallback: string | null; keptWaitingAt?: number; onCancel: () => void; onKeepWaiting: () => void }): JSX.Element | null`
  - Active job: `data-testid="photo-job-live"` line = `detailLine(live.detail)` or `fallback` (the run view headline), the step's elapsed (`"6 min on this step"`) when `stepStartedAt` is set, the estimate when set, `"<jobElapsed> in all"`, and `activity`. Not an `aria-live` region (it ticks every second).
  - `showStuck` → `data-testid="photo-job-stuck"`, `role="alert"`: "No progress for 15 minutes. The job may be stuck." with buttons **Cancel job** and **Keep waiting**.
  - Stopped by the watchdog → `data-testid="photo-job-stopped"` with `watchdogWords(job)`; RunPanel then hides the generic `job.error` notice.
  - RunPanel ticks `now` once a second only while the job is active (clear the interval otherwise) and passes `onCancel={() => void act(cancelRun(run, job.id))}`, `onKeepWaiting={() => photoUi.getState().keepWaiting(job.id, Date.now())}`. Works for `photo.georef` jobs too (same panel).

- [ ] **Step 1: Write the failing tests** (`now` fixed; records built with `JobRecord.parse`):
  - normal: `live.detail` Matching photos 4,210 of 12,467 pairs, activity 8 s ago, eta 720 → text contains `Matching photos: 4,210 of 12,467 pairs`, `about 12 min left`, `Last activity 8 s ago`, `in all`; no notice.
  - quiet with counter: activity 5 min ago → `Last activity 5 min ago`, no notice.
  - stuck: activity 15 min ago → notice text exact; clicking **Cancel job** calls `onCancel` once; clicking **Keep waiting** calls `onKeepWaiting` once.
  - kept waiting: same record with `keptWaitingAt = now` → no notice.
  - reload (Review Focus 4): a fresh mount of a record quiet for 16 min with no `keptWaitingAt` shows the notice.
  - watchdog stop: failed job with `failure: { code: 'odm-stalled', data: { minutes: 60 } }` → `photo-job-stopped` holds the Task 7 sentence; no `photo-job-live`.
  - no jargon: rendered text never matches `/opensfm|detect_features|reconstruct\b|SIFT/i`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm vitest run apps/desktop/src/renderer/photogrammetry/JobLive.test.tsx`.
- [ ] **Step 3: Implement** `JobLive.tsx`, wire it into RunPanel, style it.
- [ ] **Step 4: Run, expect PASS**; `pnpm lint && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(desktop): run panel shows live progress and a stuck notice`.

---

### Task 9: End to end, the way CI runs it

**Files:**

- Modify: `apps/desktop/e2e/photo-process.spec.ts` (test "choose photos and start…", right after the match phase is `running`, before Pause)

**Interfaces:**

- Consumes: `photo-job-live`, `photo-job-stuck` (Task 8); the fake ODM's OpenSfM lines (Task 5).

- [ ] **Step 1: Add the assertions:**

```ts
const live = panel.getByTestId('photo-job-live');
await expect(live).toContainText(/Last activity \d+ (s|min) ago/);
await expect(live).toContainText(/\d+ (s|min) in all/);
await expect(live).not.toContainText(
  /opensfm|detect_features|match_features|create_tracks|reconstruct\b|SIFT/i,
);
await expect(panel.getByTestId('photo-job-stuck')).toHaveCount(0);
```

The existing `expectAccessible(win, 'photo run, starting', …)` now covers the new line.

- [ ] **Step 2: Make a Python for the branch.** The branch changes `python/`, so the main venv alone runs the main checkout's code. Create a scratch venv from the main venv's base interpreter outside the worktree, add a `.pth` with the worktree's `python\src` first, and point `QUADRION_E2E_PYTHON` at it. Check `import aio_pipelines` resolves to the worktree.
- [ ] **Step 3: Build what CI builds:** `pnpm demo:change --quick` (with `--python` pointing at that venv if asked).
- [ ] **Step 4: Run the specs the CI way**, one Playwright run at a time, from `apps/desktop` in PowerShell: `$env:QUADRION_WINDOW_SIZE='1100x720'; $env:QUADRION_E2E_SCALE='1'; $env:QUADRION_E2E_SWGL='warp'; $env:QUADRION_E2E_PYTHON='<scratch venv python>'; pnpm exec electron-vite build; npx playwright test e2e/photo-process.spec.ts e2e/gcp-marking.spec.ts --workers=1`. Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`; all tests pass, none skipped for a missing Python. Look at the `create-maps-running` screenshot.
- [ ] **Step 5: Commit** `test(e2e): the run panel shows live progress`.

---

## Final verification

- [ ] `pnpm check` green in the worktree.
- [ ] The Python files and tests touched by this plan, the way CI runs them (`-m ruff check .`, `-m ruff format --check .`, `-m pytest -vv -rfEs` over `tests/test_odm_*.py tests/test_fake_odm.py tests/test_runtime.py tests/test_photo_align.py tests/test_photo_georef.py tests/test_photo_products.py`), green.
- [ ] Task 9's specs green the CI way.
- [ ] `node tools/agent/check-public-text.mjs` on the fixtures, this plan, the contract row and the session note.
- [ ] How to test, for the founder: (1) Open a project with photos, Create maps, Standard. (2) While "Matching photos" runs, the line under the bar names the sub-step ("Finding features: N of M photos", then "Matching photos: … pairs", "Building the 3D model: … photos placed"), the time on this step and in all, and "Last activity N s ago" counting from 0 again whenever the engine works. (3) The bar keeps moving within each sub-step; it no longer sits at 21 %. (4) For a large flight, "about N min left" appears during features and matching once the pace is steady. (5) Close the app mid-run and resume: the bar jumps past the finished sub-steps and counts the re-run one from zero.
