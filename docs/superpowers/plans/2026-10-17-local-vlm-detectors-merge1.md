# Local Vision-Model Detectors (Merge 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Without new UI, a person can install an Analytics pack, pass a hardware check and start a `detect.vlm` job. The job runs shipped or saved detectors (Qwen2.5-VL-7B through a bundled `llama-server`) over photos and writes scored drafts that the existing Detections review shows. Detectors can be stored, imported and exported. Review decisions can be logged to a local ledger that suggests a threshold. A bench harness measures detectors against reference projects for the content work.

**Architecture:**

- **Engine and job.** The detector recipe (spec §4) is a Python module, `aio_pipelines/detect/engine.py`, used by both the new pipeline `detect.vlm` and the bench harness. The pipeline talks to `llama-server` over loopback HTTP and writes `detections/vlm-<run>.json` (`aio.detections/1`, `source: 'model'`).
- **Main process.** Main owns the model server (`main/analytics/server.ts`: spawn, health, state file, 10-minute idle stop, kill on quit). It also owns the hardware check, the Analytics pack (the pipeline-pack installer generalised with a `PackKind`), detector storage (`.aiodet` = gzipped tar), the ledger, and the `jobs:start` gate that resolves detectors and points the job at the server.
- **Renderer.** Only job-table lines (no new UI).

**Tech Stack:** Python 3.13 (Pillow, urllib, pytest), zod v4 (`@aio/schema`), Electron main (node:child_process, `tar`), vitest, Playwright Electron, llama.cpp `llama-server`, Qwen2.5-VL-7B-Instruct GGUF Q4_K_M.

**Spec:** `docs/superpowers/specs/2026-10-17-local-vlm-detectors-design.md` (§ numbers refer to it).

**Deviations from the spec's wording (agreed in this plan, reported to the founder):**

- **The engine is Python, not TypeScript (spec §4).** AIO jobs are Python pipelines, and the run must be a normal job (stage-island). The Python engine is also what the bench harness reuses.
- **`.aiodet` is a gzipped tar, not a zip (spec §5).** `tar` is already a desktop dependency and there is no zip library.
- **The job title is static ("Running detectors") in Merge 1.** `jobTitle(name)` takes no params today. The param-aware title ("Finding corrosion in 240 photos") is a Merge 2 item.
- **Spec §4 step 5 (reference examples) is not built in Merge 1.** It belongs to the learning features in Merge 3, so `examples` stays optional and the engine ignores it.

## Global Constraints

- **Model:** Qwen2.5-VL-7B-Instruct, GGUF Q4_K_M plus its `mmproj`, Apache-2.0. **Runtime:** llama.cpp `llama-server`, MIT, pinned release, win-x64 only in v1. No Mac (founder).
- **Server:** `127.0.0.1`, random free port. Args: `--ctx-size 8192`, `-ngl 99`, `--parallel 1`, `--no-webui`. Idle stop after 600 000 ms with no `detect.vlm` job running. Killed at quit (`will-quit`).
- **Hardware minimum:** an NVIDIA GPU with total VRAM ≥ 8192 MB and free VRAM ≥ 6656 MB at job start. No CPU fallback. Messages are exactly those in Task 2's `en.ts` block.
- **Recipe defaults:**
  - tiles `n = 2`, `overlap = 0.2`; send size 1344 × 1008
  - boxes under 8 px dropped
  - merge drops a box whose overlap with a kept box is ≥ 60 % of the smaller one
  - crop padding 15 %, crop fitted within 896 px
  - `temperature 0`; the check uses `logprobs: true, top_logprobs: 10, max_tokens: 1`
  - score = P(yes) / (P(yes) + P(no)), each summed over the case variants among the top logprobs (spaces trimmed)
  - default threshold 0.8
- **Pass file:**
  - `detections/vlm-<runId>.json`, `source: 'model'`, `severity: 'uncertain'`, `status: 'draft'`, `space: 'source'` with the photo's width and height.
  - Every candidate is kept; those under the threshold carry `belowThreshold: true`.
  - The origin carries `runId`, `model`, `detectorId`, `detectorVersion`, `modelSha256`, `threshold`.
- **Never automatic:** nothing starts a `detect.vlm` job except an explicit `jobs:start`.
- **No data leaves the machine:** the server binds loopback only and there is no telemetry.
- **No client, site or person names** in code, tests, fixtures, docs or commits (`node tools/agent/check-public-text.mjs`). Reference projects are read only by `tools/detectors/` at run time, from paths given on the command line.
- **Frozen files** (stage-island rule): no edits to `workspace/island/*`, `workspace/workbench/*`, `WorkspaceScreen.tsx`, `shell/RightHeader.tsx`, `agent/*`, `Stage.tsx` or its overlays, `FloatingVideo`, `MapMenus`, `SplitPanes`.
- **UI:** none in Merge 1. Strings added now in one commented `en.ts` block, namespaced `detect.preset.*` / `jobs.detect.vlm`, sentence case.
- **Pipeline pack behaviour stays byte-identical:** every existing `packInstall`, `pack`, `packVersions` test passes unchanged.

## Review Focus

1. **The model answers in the wrong coordinate frame** (fractions, or the frame of a resized image). The person expects drafts on the right spot or a clear warning, never an empty pass. Tests:
   - Task 3: `test_fraction_boxes_are_detected_and_warned`, `test_out_of_frame_boxes_are_clamped`.
   - Task 1: the smoke check of the pixel frame.
2. **The server dies mid-job, or the port changed by the time a job is resumed.** The job fails with "The detector model stopped. Run the remaining photos again.", and resuming re-starts the server and continues. Tests:
   - Task 4: `test_server_down_fails_with_message`, `test_resume_skips_done_photos`.
   - Task 8: `resume re-ensures the server and rewrites the state file`.
3. **A photo that is missing, unreadable or tiny.** The photo is skipped with a per-photo warning, the rest run, and the pass's `assessed` lists only the photos actually assessed. Tests: Task 4 `test_missing_photo_is_skipped_with_warning`, `test_tiny_photo_runs_without_tiles_upscaling`.
4. **No NVIDIA driver, `nvidia-smi` missing, several GPUs, or not enough free VRAM because a game is open.** The person sees the exact reason. With several GPUs, the one with the most free memory is chosen. Tests: Task 7 `parses two GPUs and picks the most free`, `no nvidia-smi is "No NVIDIA graphics card found"`, `free too low names both numbers`.
5. **A `.aiodet` with path tricks, an unknown schema or a detector tuned on another model.** Import refuses the first two with a message. The third imports and is flagged `modelMismatch`. Tests: Task 9 `refuses an archive entry outside the detector folder`, `refuses aio.vlm-detector/2`, `flags a different modelSha256`.

## Execution DAG

| Batch | Tasks (dispatch each batch in one message)      | Depends on                                                      | Files shared within the batch                                                                                                    |
| ----- | ----------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Task 1, Task 2                                  | none                                                            | none                                                                                                                             |
| 2     | Task 3, Task 5, Task 6, Task 7, Task 9, Task 10 | Task 2 (constants and schemas); Task 5 also needs Task 1's lock | none (Task 2 wrote every `ipc.ts`, preload, `en.ts`, job-table line; each task's IPC registrar is its own file, wired in Task 8) |
| 3     | Task 4, Task 8                                  | 4: Task 3; 8: Tasks 6, 7, 9, 10                                 | none                                                                                                                             |
| 4     | Task 11, Task 12                                | 11: Task 3; 12: Tasks 4, 8                                      | none                                                                                                                             |
| 5     | Task 13, Task 14                                | 13: Tasks 1, 5, 11; 14: Task 12                                 | none                                                                                                                             |

**Critical path:** Task 2 → Task 6 → Task 8 → Task 12 → Task 14. Task 1 is a gate: if `llama-server` fails it, stop and switch Tasks 1, 5 and 8 to bundling Ollama (spec §3 fallback) before Batch 3.

### Tests, e2e, contract and packages per task

| Task | Unit tests                                                                                                 | e2e                                                                                              | Contract                                                                                                                                | Packages                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | `tools/analytics-pack/smoke.py` (manual, on a GPU machine)                                                 | none                                                                                             | none                                                                                                                                    | tools                                                      |
| 2    | `packages/schema/src/analytics.test.ts`, `detections.test.ts` (new cases), `versions.test.ts`              | none                                                                                             | `aio.analytics-pack/1`, `aio.vlm-detector/1`, `detect.vlm` + `DetectVlmParams`, Detection/DetectionOrigin fields, 14 IPC channels: rows | schema, ui (en.ts), desktop (preload, renderer job tables) |
| 3    | `python/tests/test_detect_engine.py`                                                                       | none                                                                                             | none                                                                                                                                    | python                                                     |
| 4    | `python/tests/test_detect_pipeline.py`                                                                     | none                                                                                             | none (pack version bump)                                                                                                                | python                                                     |
| 5    | `tools/analytics-pack/build.test.mjs`                                                                      | none                                                                                             | none                                                                                                                                    | tools, CI                                                  |
| 6    | `apps/desktop/src/main/jobs/packInstall.test.ts` (new cases; old ones unchanged), `analytics/pack.test.ts` | none                                                                                             | none                                                                                                                                    | desktop (main)                                             |
| 7    | `apps/desktop/src/main/analytics/hardware.test.ts`                                                         | none                                                                                             | none                                                                                                                                    | desktop (main)                                             |
| 8    | `analytics/server.test.ts`, `analytics/gate.test.ts`                                                       | none                                                                                             | none                                                                                                                                    | desktop (main)                                             |
| 9    | `analytics/detectors.test.ts`                                                                              | none                                                                                             | none                                                                                                                                    | desktop (main)                                             |
| 10   | `analytics/ledger.test.ts`                                                                                 | none                                                                                             | none                                                                                                                                    | desktop (main)                                             |
| 11   | `tools/detectors/test_bench.py`                                                                            | none                                                                                             | none                                                                                                                                    | tools                                                      |
| 12   | none                                                                                                       | add `apps/desktop/e2e/detectors-local.spec.ts`; run `agent-local.spec.ts` (shared `fake-llm.ts`) | none                                                                                                                                    | desktop (e2e)                                              |
| 13   | bench reports (manual)                                                                                     | none                                                                                             | none                                                                                                                                    | tools (detector content)                                   |
| 14   | `pnpm format:check`                                                                                        | none                                                                                             | none                                                                                                                                    | docs                                                       |

---

## Task 1: `llama-server` smoke check and pins (gate)

**Files:**

- Create: `tools/analytics-pack/lock.json`, `tools/analytics-pack/smoke.py`, `tools/analytics-pack/README.md`

**Interfaces:**

- Produces: `lock.json`, read by Task 5:

```json
{
  "runtime": {
    "name": "llama.cpp",
    "release": "b<NNNN>",
    "assets": [{ "url": "...", "sha256": "...", "size": 0 }],
    "executable": "llama/llama-server.exe"
  },
  "model": {
    "id": "qwen2.5-vl-7b-instruct-q4_k_m",
    "licence": "Apache-2.0",
    "gguf": {
      "url": "...",
      "sha256": "...",
      "size": 0,
      "file": "model/qwen2.5-vl-7b-instruct-q4_k_m.gguf"
    },
    "mmproj": {
      "url": "...",
      "sha256": "...",
      "size": 0,
      "file": "model/mmproj-qwen2.5-vl-7b-instruct-f16.gguf"
    }
  }
}
```

- [ ] **Step 1: Pick the pins.** Use the newest llama.cpp release with a Windows CUDA build that runs on the RTX 50 series (CUDA 12.8 or later), plus its matching `cudart` asset. If none runs, use the Vulkan build and record why in the README. Use the model files from `ggml-org/Qwen2.5-VL-7B-Instruct-GGUF` at a fixed commit. Record URL, size and sha256 for each asset.
- [ ] **Step 2: Write `smoke.py`** (stdlib + Pillow; args `--server <exe> --model <gguf> --mmproj <gguf>`). It starts the server with the Global Constraints args, waits for `GET /health` to return `{"status":"ok"}` (120 s limit), then runs three checks:
  1. **Pixel frame.** A 1344 × 1008 grey image with a red square from (900, 300) to (1100, 500), asked "Locate the red square. Output JSON [{\"bbox_2d\":[x1,y1,x2,y2]}]". Pass if every corner is within 40 px.
  2. **Scores.** The same image asked "Is there a red square in this image? Answer yes or no." with `logprobs` gives P(yes) ≥ 0.9. A plain grey image gives P(yes) ≤ 0.1.
  3. **The logprobs shape.** `choices[0].logprobs.content[0].top_logprobs` is a list of `{token, logprob}`.

  It prints `SMOKE OK` or the failing check, and always kills the server.

- [ ] **Step 3: Run it** on the RTX 5070 Ti machine. Expected: `SMOKE OK`. If it fails, stop and report: Batch 3 switches to the Ollama fallback.
- [ ] **Step 4: Commit** `chore(analytics-pack): pin llama-server and Qwen2.5-VL, add smoke check`.

## Task 2: Schema, contracts, strings and job tables

**Files:**

- Create: `packages/schema/src/analytics.ts`, `packages/schema/src/analytics.test.ts`
- Modify:
  - `packages/schema/src/index.ts` (`export * from './analytics';`)
  - `packages/schema/src/detections.ts` (fields below)
  - `packages/schema/src/jobs.ts`: `PipelineName` += `'detect.vlm'`; `PIPELINES` entry `{ name: 'detect.vlm', title: 'Run detectors', description: 'Find defects in photos with the detectors of the Analytics pack, on this computer.' }`; `PARAMS['detect.vlm'] = DetectVlmParams`
  - `packages/schema/src/ipc.ts` (channels below)
  - `packages/schema/src/versions.ts`: `aio.vlm-detector` (version 1, home `project` and `user`, where `detectors/<id>/detector.json`, since `0.20`) and `aio.analytics-pack` (version 1, home `runtime`, since `0.20`)
  - `apps/desktop/src/preload/index.ts` (14 `CHANNELS` lines)
  - `apps/desktop/src/renderer/jobs.ts` (`FORMS['detect.vlm'] = []`)
  - `apps/desktop/src/renderer/processing/pipelines.ts` (`PIPELINE_GROUP` / `JOB_KIND` `'inspection'`; `TITLE_KEYS['detect.vlm'] = 'jobs.detect.vlm'`)
  - `packages/ui/src/i18n/en.ts`
  - `docs/architecture/contract-changes.md`
- Test: `packages/schema/src/analytics.test.ts`, new cases in `packages/schema/src/detections.test.ts`

**Interfaces — Produces (all from `@aio/schema`):**

```ts
export const ANALYTICS_PACK_SCHEMA = 'aio.analytics-pack/1';
export const ANALYTICS_PACK_PREFIX = 'analytics-pack';
export const VLM_DETECTOR_SCHEMA = 'aio.vlm-detector/1';
export const DETECTOR_FILE_EXTENSION = '.aiodet';
export const VLM_MIN_VRAM_MB = 8192;
export const VLM_MIN_FREE_VRAM_MB = 6656;
export const VLM_IDLE_STOP_MS = 600_000;
export const VLM_DEFAULT_THRESHOLD = 0.8;
export const VLM_DEFAULT_TILES = { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 } as const;
export const VLM_SERVER_STATE = 'runtime/analytics-server.json'; // under the data root
export const vlmPassName = (runId: string) => `vlm-${runId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}.json`;
export const RejectReason = z.enum(['looks-like-but-is-not', 'not-a-defect', 'wrong-class', 'box-wrong', 'other']);
export const DetectorWhere = z.enum(['shipped', 'project', 'library']);
export const VlmTiles;            // { n: int 1..4, overlap: 0..0.5, sendW, sendH: int multiples of 28, 280..2016 }, strict
export const VlmDetector;         // strict, fields below
export const AnalyticsPackManifest; // strict, fields below
export const DetectVlmParams;     // strict, fields below
export const VlmServerState;      // { url: http://127.0.0.1:<port>, pid: int, modelSha256, startedAt: IsoTime }
export const HardwareCheck;       // { ok: true, gpu: string, totalMb, freeMb } | { ok: false, reason: string }
export const LedgerEntry;         // fields in Task 10
export type /* each of the above */;
```

`VlmDetector`:

- `schema` (literal)
- `id`: `/^[a-z0-9][a-z0-9-]{1,60}$/`
- `name`: 1..80
- `version`: int ≥ 1
- `classId`: 1..120
- `assetTypes`: string[1..10]
- `looksLike`: 1..2000
- `ignore`: 0..2000
- `question`: 1..1000
- `tiles`: `VlmTiles`
- `threshold`: 0..1
- `tunedOn`: `{ model, modelSha256: /^[a-f0-9]{64}$/ }`
- `author`: ≤ 120
- `createdAt`, `updatedAt`: IsoTime
- `source`: `shipped | user | imported`
- `status`: `verified | experimental`
- `samples?`: `{ photo: string, file: string }[]` (≤ 10)
- `examples?`: `{ file: string, verdict: 'is' | 'is-not' }[]` (≤ 20)

`file` values are paths relative to the detector folder, matching `/^(samples|examples)\/[A-Za-z0-9._-]{1,100}$/`.

`AnalyticsPackManifest`: `schema`, `version`, `appRange`, `platform`, `createdAt`, `runtime: { name: 'llama.cpp', release, executable }`, `model: { id, licence, gguf, mmproj, sha256 }` (`sha256` is the gguf's), `detectors: { assetType, id, version, status }[]`, `files` (the same record shape as `PipelinePackManifest.files`).

`DetectVlmParams`:

- `run`: `/^run-[a-z0-9-]{1,60}$/`
- `layer`: Id
- `photos`: Id[1..5000]
- `detectors`: `{ detector: VlmDetector, threshold: 0..1 }[1..10]`
- `serverFile`: string, absolute
- `modelSha256`
- `model`: string

`detections.ts` additions:

- `DetectionOrigin` += `detectorId?`, `detectorVersion?: int`, `modelSha256?`, `threshold?: 0..1`.
- `Detection` += `belowThreshold?: boolean`, `unscored?: boolean`, `rejectReason?: RejectReason`, `rejectNote?: string ≤ 200`.

IPC channels (each `request` strict; `Failure` is `{ ok: false, error: string }`):

```ts
'analyticsPack:status':  { request: Empty, response: { installed: { version, dir } | null, offer: { path, version } | null } },
'analyticsPack:find':    { request: Empty, response: { archives: { path, version }[] } },
'analyticsPack:choose':  { request: Empty, response: { path: string | null } },   // native open dialog
'analyticsPack:install': { request: { path, replace?: boolean }, response: InstallResult },
'analyticsPack:cancel':  { request: Empty, response: Ok },
'analyticsPack:remove':  { request: { version }, response: Ok | Failure },
'analytics:hardware':    { request: Empty, response: HardwareCheck },
'detectors:list':        { request: { projectId?: string }, response: { items: { where: DetectorWhere, detector: VlmDetector, modelMismatch: boolean }[] } },
'detectors:save':        { request: { where: 'project' | 'library', projectId?: string, detector: VlmDetector }, response: { ok: true, version: number } | Failure },
'detectors:remove':      { request: { where: 'project' | 'library', projectId?: string, id: string }, response: Ok | Failure },
'detectors:export':      { request: { where: DetectorWhere, projectId?: string, id: string, includeSamples: boolean, path?: string }, response: { ok: true, path: string } | Failure },
'detectors:import':      { request: { path?: string, where: 'project' | 'library', projectId?: string, onConflict?: 'update' | 'keep-both' }, response: { ok: true, id: string } | { ok: false, error: string, conflict?: { id, have: number, incoming: number } } },
'ledger:append':         { request: { entry: LedgerEntry, cropJpegBase64: string }, response: Ok | Failure },
'ledger:stats':          { request: { detectorId: string }, response: { accepted: number, rejected: number, misses: number, suggestedThreshold: number | null } },
```

`en.ts` block (exact values):

```ts
// ---- local detectors (Analytics pack) ----
'jobs.detect.vlm': 'Running detectors',
'detect.preset.hw.noGpu': 'No NVIDIA graphics card found. Detectors need one with at least 8 GB of memory.',
'detect.preset.hw.tooSmall': 'This computer has {total} GB of graphics memory; detectors need 8 GB.',
'detect.preset.hw.tooBusy': 'Only {free} GB of graphics memory is free; detectors need 6.5 GB. Close other programs that use the graphics card and run again.',
'detect.preset.hw.mac': 'Not available on this computer yet.',
'detect.preset.pack.missing': 'Install the Analytics pack in Settings to run detectors.',
'detect.preset.server.stopped': 'The detector model stopped. Run the remaining photos again.',
'detect.preset.server.failed': 'The detector model did not start: {reason}',
'detect.preset.queued': 'Another detector run is going. This one starts when it finishes.',
'detect.preset.modelMismatch': 'This detector was tuned on a different model, so its results may differ.',
```

- [ ] **Step 1: Write the failing tests.**
  - `analytics.test.ts`:
    - `parses the spike corrosion detector` (a full `VlmDetector` literal)
    - `refuses a sample path outside samples/` (`'../x.jpg'` fails)
    - `refuses tiles not multiples of 28` (`sendW: 1300` fails)
    - `vlmPassName sanitises` (`vlmPassName('run-a/b')` → `'vlm-run-a-b.json'`)
    - `DetectVlmParams refuses a relative serverFile`
  - `detections.test.ts`:
    - `keeps detector origin fields` (round-trip of an origin with all four new fields)
    - `refuses an unknown key in origin` (still strict)
- [ ] **Step 2: Run** `pnpm vitest run packages/schema/src/analytics.test.ts packages/schema/src/detections.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the schemas, constants, channels, preload lines, job-table lines and the `en.ts` block above. Add the contract-changes rows: the two new file families, the `detect.vlm` pipeline, the Detection/DetectionOrigin fields and the 14 channels.
- [ ] **Step 4: Run** the same tests plus `pnpm typecheck`. Expected: PASS. (`FORMS` and `PIPELINE_GROUP` are `Record<PipelineName, …>`, so typecheck fails until both have the new line.)
- [ ] **Step 5: Commit** `feat(schema): analytics pack, vlm detectors and detect.vlm contracts`.

## Task 3: Detector engine (Python)

**Files:**

- Create: `python/src/aio_pipelines/detect/__init__.py`, `python/src/aio_pipelines/detect/engine.py`, `python/tests/test_detect_engine.py`, `python/tests/fake_vlm.py` (a threaded `http.server` that answers `/v1/chat/completions` from a script)

**Interfaces — Produces:**

```python
TILES_DEFAULT = {"n": 2, "overlap": 0.2, "sendW": 1344, "sendH": 1008}
MIN_BOX_PX = 8; MERGE_SHARE = 0.6; CROP_PAD = 0.15; CROP_MAX = 896

@dataclass
class Candidate:
    box: tuple[float, float, float, float]   # source px, x1<x2, y1<y2
    note: str
    score: float | None = None               # None = unscored

@dataclass
class PhotoResult:
    candidates: list[Candidate]
    warnings: list[str]
    failed: bool                              # every tile call failed

class VlmUnavailable(Exception): ...          # connection refused / reset

class VlmClient:
    def __init__(self, url: str, timeout: float = 300.0): ...
    def chat(self, jpeg: bytes, text: str, *, logprobs: bool = False, max_tokens: int = 1024) -> tuple[str, list[dict] | None]: ...

def tile_grid(w: int, h: int, n: int, overlap: float) -> list[tuple[int, int, int, int]]   # (x, y, tw, th)
def detect_prompt(det: dict) -> str
def check_prompt(det: dict) -> str
def parse_boxes(text: str) -> list[tuple[list[float], str]] | None   # None = unparseable
def merge(cands: list[Candidate], share: float = MERGE_SHARE) -> list[Candidate]
def score_from_top(top: list[dict]) -> float | None
def run_detector(client: VlmClient, image: "PIL.Image.Image", det: dict) -> PhotoResult
```

Fixed prompt templates (exact):

```python
DETECT = ("You are a detector for drone inspection photos. Find: {looksLike}\n"
          "Do NOT report: {ignore}\n"
          "Give each area its own tight box. Output JSON only: "
          '[{{"bbox_2d": [x1, y1, x2, y2], "label": "{classId}", "note": "<what and where, max 10 words>"}}]. '
          "Output [] if there is none.")
CHECK = "This is a crop from a drone inspection photo. {question} Answer yes or no."
```

When `ignore` is empty, the "Do NOT report" line is left out.

- [ ] **Step 1: Write the failing tests** in `test_detect_engine.py`:
  - `test_tile_grid_2x2_overlap` — `tile_grid(2560, 1920, 2, 0.2)` gives 4 tiles of `(1422, 1066)` at x ∈ {0, 1138}, y ∈ {0, 854}; the union covers the image.
  - `test_tile_grid_n1_is_whole_image`
  - `test_parse_fenced_and_bare_json`, and `test_parse_garbage_is_none` (`parse_boxes("I see rust")` is `None`; `"[]"` is `[]`)
  - `test_merge_drops_mostly_inside` — a box 70 % inside a larger one is dropped; at 50 % it is kept
  - `test_score_case_variants` — top `[Yes -0.01, No -4.5, yes -7.7]` gives ≈ 0.989; no yes/no tokens gives `None`
  - `test_run_detector_maps_tiles_to_source` — fake server returns `[[100,100,300,300]]` for each tile of a 2560 × 1920 image. The candidate in tile (1138, 854) maps to (1138 + 100·1422/1344, …), within 0.5 px.
  - `test_out_of_frame_boxes_are_clamped` — a box `[1200, 900, 1500, 1100]` in a 1344 × 1008 frame is clamped to the frame; one fully outside is dropped with a warning
  - `test_fraction_boxes_are_detected_and_warned` — every box value ≤ 1.0 on a tile means the model used fractions. The boxes are scaled by sendW and sendH, and `PhotoResult.warnings` contains `"model answered in fractions"`.
  - `test_unparseable_tile_retried_once_then_warned`, and `test_all_tiles_failed_marks_failed`
  - `test_connection_refused_raises_unavailable`
- [ ] **Step 2: Run** `cd python && uv run --frozen pytest tests/test_detect_engine.py -v`. Expected: FAIL (import error).
- [ ] **Step 3: Implement `engine.py`** per spec §4 and the Global Constraints values. `run_detector`:
  1. Tile.
  2. Resize each tile to (sendW, sendH) with LANCZOS, then JPEG at quality 92.
  3. Send the image, then the `DETECT` text.
  4. Parse, retrying once if unparseable.
  5. Map the boxes to source pixels and drop those under `MIN_BOX_PX`.
  6. Merge.
  7. For each candidate, crop with `CROP_PAD`, fit within `CROP_MAX`, and send `CHECK` with logprobs.
- [ ] **Step 4: Run** the tests. Expected: PASS. Also `uv run --frozen ruff check . && uv run --frozen ruff format --check .`.
- [ ] **Step 5: Commit** `feat(pipelines): vlm detector engine`.

## Task 4: Pipeline `detect.vlm`

**Files:**

- Create: `python/src/aio_pipelines/detect/pipeline.py`, `python/tests/test_detect_pipeline.py`
- Modify: `python/src/aio_pipelines/pipelines.py` (import and `DetectVlm()` in `all_pipelines`), `python/pyproject.toml` (version `0.16.0`), `python/src/aio_pipelines/__init__.py` if `APP_RANGE` needs it

**Interfaces:**

- Consumes: Task 3 `VlmClient`, `run_detector`, `VlmUnavailable`; Task 2 `DetectVlmParams` (mirrored in `validate`).
- Produces:
  - A pipeline `detect.vlm` with steps `prepare`, `detect`, `commit`.
  - The pass file `detections/vlm-<run>.json`:

```json
{
  "schema": "aio.detections/1",
  "source": "model",
  "producer": "<model> (local)",
  "layer": "<layer>",
  "assessed": ["<photo ids that ran>"],
  "createdAt": "<iso>",
  "run": {
    "id": "<run>",
    "at": "<iso>",
    "provider": "local",
    "model": "<model>",
    "promptVersion": "detectors",
    "images": 0,
    "detections": 0
  },
  "detections": [
    {
      "id": "<run>-<photo>-<detectorId>-<k>",
      "photo": "<id>",
      "class": "<classId>",
      "severity": "uncertain",
      "confidence": 0.93,
      "note": "...",
      "status": "draft",
      "bbox": [0, 0, 1, 1],
      "space": "source",
      "width": 2560,
      "height": 1920,
      "belowThreshold": true,
      "unscored": true,
      "origin": {
        "runId": "<run>",
        "model": "<model>",
        "detectorId": "...",
        "detectorVersion": 1,
        "modelSha256": "...",
        "threshold": 0.8
      }
    }
  ]
}
```

`belowThreshold` and `unscored` appear only when they are true.

- [ ] **Step 1: Write the failing tests** (a tmp project with a manifest photos layer of 3 small JPEGs, and `fake_vlm.py` serving):
  - `test_writes_pass_with_scores_and_threshold` — two candidates with scores 0.95 and 0.6 at threshold 0.8. Both are written, and only the second has `belowThreshold`.
  - `test_missing_photo_is_skipped_with_warning` — `assessed` leaves it out, and the job log has the warning
  - `test_tiny_photo_runs_without_tiles_upscaling` — a 200 × 150 photo uses `n = 1` and runs
  - `test_server_down_fails_with_message` — the state file points to a closed port. `JobError` with the exact `detect.preset.server.stopped` text; per-photo results already staged are kept.
  - `test_resume_skips_done_photos` — run 2 of 3, cancel, resume. The fake server sees only photo 3, and the pass has all 3.
  - `test_every_photo_failed_is_an_error` — never "no detections"
  - `test_two_detectors_one_pass` — ids are unique and both classes are present
- [ ] **Step 2: Run** `cd python && uv run --frozen pytest tests/test_detect_pipeline.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement `DetectVlm`.**
  - **`validate`** checks the params against Task 2's shape.
  - **`prepare`** resolves each photo's `src.path` from the manifest layer and reads its size. A missing photo becomes a warning.
  - **`detect`** reads `serverFile` (JSON `VlmServerState`) at step start. For each photo × detector, it skips a photo whose `stage("results/<photo>.json")` exists, otherwise runs and writes it. It calls `ctx.check()` between photos and reports `ctx.progress(i / n, "photo i of n, <detector name>")`. `VlmUnavailable` becomes a `JobError` with the stopped text.
  - **`commit`** assembles the pass and writes it with `commit_files`.
  - **`inputs(params)`** returns the photo paths, so a resumed job refuses changed photos.
- [ ] **Step 4: Run** the tests plus `uv run --frozen python -m aio_pipelines --list` (it lists `detect.vlm`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): detect.vlm job writes scored detector drafts`.

## Task 5: Analytics pack build

**Files:**

- Create: `tools/analytics-pack/build.mjs`, `tools/analytics-pack/build.test.mjs`, `.github/workflows/analytics-pack.yml` (`workflow_dispatch` only, windows-latest), `tools/analytics-pack/detectors/.gitkeep`
- Modify: `tools/release/budgets.mjs` (own entry: unpacked ≤ 7.5 GB, archived ≤ 6.5 GB), `package.json` (`"analytics-pack": "node tools/analytics-pack/build.mjs"`), the third-party notices generator (llama.cpp MIT; Qwen Apache-2.0; NVIDIA CUDA runtime redistributable terms)

**Interfaces:**

- Consumes: Task 1 `lock.json`; Task 2 `AnalyticsPackManifest` (its JSON shape).
- Produces:
  - **`node tools/analytics-pack/build.mjs --out <dir> [--cache <dir>] [--no-model]`** writes `<out>/analytics-pack-<ver>/` with `llama/`, `model/`, `detectors/<assetType>/<id>/`, `manifest.json`, and `<out>/analytics-pack-<ver>-win-x64.tar.gz`.
  - **Version:** `version` comes from `tools/analytics-pack/package.json`, starting at `0.1.0`. `appRange` is `>=0.20.0 <2.0.0`.

- [ ] **Step 1: Write the failing tests** (`node --test`):
  - `pinned download refuses a wrong sha256`
  - `manifest lists every file with size and sha256`
  - `detectors folder copied and listed in manifest.detectors`
  - `--no-model leaves model out and marks manifest.model.sha256 "none"`

  Downloads are injected as a fake `fetchTo(url, dest)`, as `sam.test.mjs` does.

- [ ] **Step 2: Run** `node --test tools/analytics-pack/build.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse the cache and pinned-download helpers of `tools/pipeline-pack/sam.mjs`; copy them only if they aren't exported. Write the tar the same way `release.yml` tars the pipeline pack.
- [ ] **Step 4: Run** the tests; then build once locally with `--no-model` and check that the archive lists `manifest.json` first. Expected: PASS.
- [ ] **Step 5: Commit** `build(analytics-pack): pinned builder, budget and manual CI workflow`.

## Task 6: Pack installer for two kinds

**Files:**

- Modify: `apps/desktop/src/main/jobs/packInstall.ts`, `apps/desktop/src/main/jobs/pack.ts` (only if `PACK_DIR` must move into the kind)
- Create: `apps/desktop/src/main/analytics/pack.ts`, `apps/desktop/src/main/analytics/pack.test.ts`, `apps/desktop/src/main/analytics/packIpc.ts`
- Test: new cases in `apps/desktop/src/main/jobs/packInstall.test.ts`

**Interfaces — Produces:**

```ts
// packInstall.ts
export interface PackKind {
  id: 'pipeline' | 'analytics';
  prefix: 'pipeline-pack' | 'analytics-pack';
  /** Words for messages: 'processing tools' | 'Analytics pack'. */
  label: string;
  parse(raw: unknown):
    | {
        ok: true;
        m: {
          version: string;
          platform: string;
          appRange?: string;
          files: Record<string, { size: number; sha256: string }>;
        };
      }
    | { ok: false; error: string };
  /** A file that must exist after unpacking (python executable | llama-server executable). */
  required(m: unknown): string;
  limits: PackLimits;
}
export const PIPELINE_PACK: PackKind; // today's behaviour exactly
export const ANALYTICS_PACK: PackKind; // limits: { maxEntries: 10_000, maxBytes: 12 * 2 ** 30, maxManifestBytes: 4 * 2 ** 20 }
// every existing export gains an optional trailing `kind: PackKind = PIPELINE_PACK`
// (packArchiveName, installPackArchive via InstallOptions.kind, listPacks, findPackArchives, peekPackManifest)

// analytics/pack.ts
export interface AnalyticsPack {
  version: string;
  dir: string;
  manifest: AnalyticsPackManifest;
  server: string;
  gguf: string;
  mmproj: string;
}
export async function findAnalyticsPack(o: {
  dataRoot: string;
  env: Record<string, string | undefined>;
}): Promise<AnalyticsPack | null>; // env QUADRION_ANALYTICS_PACK overrides
// analytics/packIpc.ts
export function registerAnalyticsPackIpc(d: PipelinePackIpcDeps): void; // the six analyticsPack:* channels
```

- [ ] **Step 1: Write the failing tests:**
  - `installs an analytics-pack archive into runtime/analytics-pack-<v>`
  - `refuses a pipeline-pack archive offered as analytics` (message names "Analytics pack")
  - `refuses an analytics manifest whose llama-server is missing`
  - `packArchiveName knows analytics-pack-0.1.0-win-x64.tar.gz`
  - `findAnalyticsPack picks the newest valid and honours QUADRION_ANALYTICS_PACK`

  Build the archives with `packArchive.fakes.ts`.

- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/jobs apps/desktop/src/main/analytics/pack.test.ts`. Expected: new cases FAIL, old ones PASS.
- [ ] **Step 3: Implement.** Thread `kind` through the installer: replace the literal `pipeline-pack`, `PipelinePackManifest`, the python check and the "processing tools" words with `kind.*`. Pipeline messages must stay character-identical.
- [ ] **Step 4: Run** the same tests. Expected: all PASS, including every pre-existing test unchanged.
- [ ] **Step 5: Commit** `feat(desktop): pack installer handles the Analytics pack`.

## Task 7: Hardware check

**Files:**

- Create: `apps/desktop/src/main/analytics/hardware.ts`, `apps/desktop/src/main/analytics/hardware.test.ts`

**Interfaces — Produces:**

```ts
export interface Gpu {
  name: string;
  totalMb: number;
  freeMb: number;
  index: number;
}
export function parseNvidiaSmi(csv: string): Gpu[]; // `--query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits`
export async function checkHardware(d: {
  platform: NodeJS.Platform;
  exec: (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;
}): Promise<HardwareCheck>; // HardwareCheck from Task 2; picks the GPU with most freeMb
export function pickedGpuIndex(check: HardwareCheck): number | null;
```

- [ ] **Step 1: Write the failing tests:**
  - `parses two GPUs and picks the most free`
  - `no nvidia-smi is "No NVIDIA graphics card found"` (exec rejects with ENOENT) — uses the exact `detect.preset.hw.noGpu` text
  - `total under 8192 MB uses tooSmall with whole GB`
  - `free too low names both numbers` (tooBusy, one decimal)
  - `darwin is the mac message`
  - `garbage output is noGpu`
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/analytics/hardware.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Run `nvidia-smi` from `PATH`, then from `%ProgramFiles%\NVIDIA Corporation\NVSMI\`, with a 5 s timeout. Messages come from `en.ts` through `t()` with params.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): NVIDIA memory check for detectors`.

## Task 8: Model server, `jobs:start` gate and wiring

**Files:**

- Create: `apps/desktop/src/main/analytics/server.ts`, `server.test.ts`, `apps/desktop/src/main/analytics/gate.ts`, `gate.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (the `jobs:start` gate branch for `detect.vlm`; register the IPC of Tasks 6, 7, 9 and 10; `vlmServer.stopSync()` in `will-quit`; subscribe to job events for idle and lane)

**Interfaces:**

- Consumes: Task 6 `findAnalyticsPack`; Task 7 `checkHardware`; Task 9 `resolveDetectors`; Task 2 `VLM_*` constants and `VlmServerState`.
- Produces:

```ts
// server.ts
export interface ServerDeps {
  spawn: (exe: string, args: string[], env: Record<string, string>) => ChildLike; // { pid, kill(), on('exit') }
  fetch: typeof fetch;
  freePort: () => Promise<number>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { clear(): void };
  writeState: (s: VlmServerState | null) => Promise<void>; // <dataRoot>/runtime/analytics-server.json; null deletes
}
export class VlmServer {
  constructor(d: ServerDeps);
  /** Start or reuse; waits for /health ok (120 s). */
  ensure(
    pack: AnalyticsPack,
    gpuIndex: number | null,
  ): Promise<{ ok: true; state: VlmServerState } | { ok: false; error: string }>;
  busy(): void; // a detect.vlm job started: cancel the idle timer
  idle(): void; // no detect.vlm job running: stop after VLM_IDLE_STOP_MS
  stop(): Promise<void>;
  stopSync(): void; // kill tree, delete state file
}
// gate.ts
export async function detectJobGate(
  req: JobsStartRequest,
  d: {
    env: Record<string, string | undefined>;
    dataRoot: string;
    projectDir: string;
    findPack: typeof findAnalyticsPack;
    hardware: () => Promise<HardwareCheck>;
    server: VlmServer;
    resolve: typeof resolveDetectors;
    running: () => boolean;
  },
): Promise<{ refuse: string } | { queue: true } | { req: JobsStartRequest }>;
```

**Gate rules:**

- **Order:** pack missing → `detect.preset.pack.missing`; then hardware not ok → its reason; then `ensure` fails → `detect.preset.server.failed`; then a `detect.vlm` job already running → queue.
- **The request it passes on:**
  - `params.serverFile` = absolute state path
  - `params.model` = `manifest.model.id`
  - `params.modelSha256` = `manifest.model.sha256`
  - each `params.detectors[].detector` replaced by the stored copy (`resolve`), so a renderer cannot inject prompt text for a shipped id
- **Resume:** it runs again and rewrites the state file.
- **Test seam:** `QUADRION_VLM_SERVER_URL` set → skip the pack, hardware and spawn steps, and write a state file with that URL (e2e only, as `QUADRION_PIPELINE_PACK`).
- **Spawn:** args are the Global Constraints args plus `--model`, `--mmproj`, `--port`, `--host 127.0.0.1`. When `gpuIndex !== null`, env sets `CUDA_VISIBLE_DEVICES=<gpuIndex>`.
- **Queue:** a FIFO in `index.ts`. When a `detect.vlm` job ends (`done | failed | cancelled`), the next queued request goes through the gate again. While queued, the request answers `{ ok: false, error: detect.preset.queued }` (as `PANO_QUEUED`).

- [ ] **Step 1: Write the failing tests:**
  - `server.test.ts` (fake spawn and fetch, fake timers):
    - `starts once and reuses`
    - `waits for health then writes state`
    - `health never ok kills and fails with reason`
    - `idle stops after 600000 ms and deletes state`
    - `busy cancels idle`
    - `stopSync kills the child`
    - `a crash clears state so the next ensure restarts`
  - `gate.test.ts`:
    - `missing pack refuses with pack.missing`
    - `hardware refusal passes its reason`
    - `injects serverFile, model and sha`
    - `replaces detector bodies with stored copies`
    - `queues while one runs`
    - `resume re-ensures the server and rewrites the state file`
    - `QUADRION_VLM_SERVER_URL skips pack, hardware and spawn`
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/analytics`. Expected: FAIL.
- [ ] **Step 3: Implement** `server.ts` and `gate.ts` and the wiring in `index.ts`: one branch in `jobs:start` before `jobs.start(req)`, plus the registrars, `will-quit` and the job event subscription. Kill the process tree with the helper ODM uses (`odm/system.ts`); move it to a shared spot only if it isn't exported.
- [ ] **Step 4: Run** the tests plus `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): llama-server lifecycle and detect.vlm start gate`.

## Task 9: Detector storage, import and export

**Files:**

- Create: `apps/desktop/src/main/analytics/detectors.ts`, `detectors.test.ts`, `detectorsIpc.ts`

**Interfaces — Produces:**

```ts
export function detectorDirs(o: { pack: AnalyticsPack | null; userData: string; projectDir?: string }):
  { shipped: string | null; library: string; project: string | null }; // <pack>/detectors, <userData>/detectors, <project>/detectors
export async function listDetectors(o: …): Promise<{ where: DetectorWhere; detector: VlmDetector; modelMismatch: boolean }[]>;
export async function saveDetector(o: …, where: 'project' | 'library', d: VlmDetector): Promise<number>; // bumps version, sets updatedAt, source 'user' unless 'imported'
export async function resolveDetectors(o: …, refs: { where: DetectorWhere; id: string }[]): Promise<VlmDetector[]>;
export async function exportDetector(o: …, where: DetectorWhere, id: string, dest: string, includeSamples: boolean): Promise<void>; // gzipped tar, top folder <id>/
export async function importDetector(o: …, archive: string, where: 'project' | 'library', onConflict?: 'update' | 'keep-both'): Promise<{ id: string } | { conflict: { id: string; have: number; incoming: number } }>;
export function registerDetectorsIpc(d: { … }): void;
```

`includeSamples: false` leaves out both `samples/` and `examples/` and drops those keys from the exported `detector.json`. Keep both on conflict = import as `<id>-2` (then `-3` and so on), with `name` + " (2)". `modelMismatch` = `detector.tunedOn.modelSha256 !== pack.manifest.model.sha256` (false without a pack).

- [ ] **Step 1: Write the failing tests:**
  - `lists shipped, library and project with where`
  - `save bumps version`
  - `export then import round-trips`
  - `export without samples drops samples and examples`
  - `refuses an archive entry outside the detector folder`
  - `refuses a link entry`
  - `refuses aio.vlm-detector/2`
  - `conflict reports versions; keep-both renames`
  - `flags a different modelSha256`
  - `resolveDetectors refuses an unknown id`
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/analytics/detectors.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the `tar` package with an entry filter. Reuse `archiveSegments` / `linkStaysInside` from `packInstall.ts` for path safety, and cap the archive at 50 MB unpacked.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): detector library, .aiodet import and export`.

## Task 10: Review ledger

**Files:**

- Create: `apps/desktop/src/main/analytics/ledger.ts`, `ledger.test.ts`, `ledgerIpc.ts`

**Interfaces — Produces:**

`LedgerEntry` (Task 2 schema, strict):

- `detectorId`, `detectorVersion`, `modelSha256`
- `score: number | null`
- `verdict: 'accepted' | 'rejected' | 'miss'`
- `reason?: RejectReason`, `note?: string ≤ 200`
- `box: [x1, y1, x2, y2]` (source px), `corrected?: [x1, y1, x2, y2]`
- `photo: { project: string /* folder name only */; layer: string; id: string }`
- `at: IsoTime`

```ts
export async function appendLedger(dir: string, e: LedgerEntry, cropJpeg: Buffer): Promise<void>; // <userData>/detectors/ledger/<id>.jsonl + crops/<id>/<n>.jpg (≤512 px, resized by caller)
export async function readLedger(dir: string, detectorId: string): Promise<LedgerEntry[]>;
export function suggestThreshold(entries: readonly LedgerEntry[]): number | null; // null under 20 scored accepts+rejects
export function ledgerStats(entries: readonly LedgerEntry[]): {
  accepted: number;
  rejected: number;
  misses: number;
};
export async function clearLedger(dir: string, detectorId: string): Promise<void>;
export function registerLedgerIpc(d: { userData: string }): void;
```

`suggestThreshold` tries every distinct score (and 0.5 to 0.95 in 0.05 steps). It returns the threshold with the highest F1, where accepted at or above = TP, rejected at or above = FP, and accepted below plus misses = FN. Ties go to the higher threshold.

- [ ] **Step 1: Write the failing tests:**
  - `append then read round-trips`
  - `stats counts misses separately`
  - `suggest is null under 20`
  - `suggest separates accepts above 0.9 from rejects near 0.6` (expects a value in [0.65, 0.9])
  - `ties pick the higher threshold`
  - `clear removes jsonl and crops`
  - `a torn last line is skipped, not fatal`
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/analytics/ledger.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with an append-only write (`appendFile`) per line.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): local review ledger with threshold suggestion`.

## Task 11: Bench harness

**Files:**

- Create: `tools/detectors/bench.py`, `tools/detectors/test_bench.py`, `tools/detectors/README.md`

**Interfaces:**

- Consumes: Task 3 engine (imported from `python/src`).
- Produces the command:

```
uv run --project python python tools/detectors/bench.py --project <dir> --detector <detector.json> --server <url>
  --split tune|bench [--truth-class <id>...] [--threshold 0.8] [--limit 50] --out <dir>
```

- **Split:** a photo is in `tune` when `int(sha1(photo_id).hexdigest(), 16) % 10 < 3`, else in `bench`.
- **Truth:** issue sightings `on: image` with a box, polygon or mask bounds, plus accepted detections from `detections/*.json`, filtered by `--truth-class`.
- **Hit:** a draft at or above the threshold whose box contains a truth item's centre.
- **Output:**
  - `report.json`: `{ photos, truth, found, recall, drafts, draftsPerPhoto, unmatchedDrafts }`
  - `sheet-<n>.jpg`: contact sheets with truth in green and drafts with scores
  - `drafts.json`: for the person's false-alarm review

- [ ] **Step 1: Write the failing tests** (a synthetic project in tmp: 10 photos, 4 truth boxes, fake server):
  - `test_split_is_stable_and_30_percent`
  - `test_recall_counts_centre_hits`
  - `test_polygon_truth_uses_bounds_centre`
  - `test_report_and_sheet_written`
- [ ] **Step 2: Run** `uv run --project python pytest tools/detectors/test_bench.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.** The README states the founder's bar (recall ≥ 0.70, ≤ 1 false draft per photo on average, measured on `bench` only) and that reference projects are never copied into the repo.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tools): detector bench harness`.

## Task 12: End-to-end through the existing review

**Files:**

- Create: `apps/desktop/e2e/detectors-local.spec.ts`
- Modify: `apps/desktop/e2e/fake-llm.ts` (a route answering `bbox_2d` JSON for detect prompts and `Yes`/`No` with `top_logprobs` for check prompts, keyed by a marker in the prompt)

**Interfaces:** Consumes Tasks 4 and 8. No new product interface.

- [ ] **Step 1: Write the spec.** On the synthetic change demo (working copy), with `QUADRION_VLM_SERVER_URL` set to the fake:
  1. Save a library detector through `window.aio.invoke('detectors:save', …)`.
  2. Start `jobs:start { pipeline: 'detect.vlm', … }` on 2 demo photos with threshold 0.8.
  3. Wait for the job to be `done`.
  4. Open **Detections**. The pass shows the drafts scored at or above 0.8 (the fake gives 0.95 and 0.6, so exactly one per photo is visible by default, or both if the existing review does not filter yet — assert the stored file's `belowThreshold` flags in either case).
  5. Assert the zero-network guard saw only the fake's origin.

  Also: `detectors:import` of a tampered `.aiodet` shows the refusal text.

- [ ] **Step 2: Run** it the CI way (CONTRIBUTING.md "End to end the way CI runs it"), and also `agent-local.spec.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `test(e2e): detect.vlm job on the demo through the review`.

## Task 13: First detector content (corrosion), then facade and flare

**Files:**

- Create: `tools/analytics-pack/detectors/plant/corrosion-metal/detector.json`; later `tools/analytics-pack/detectors/facade/<id>/detector.json` and `tools/analytics-pack/detectors/flare/<id>/detector.json`

**Interfaces:** Consumes Tasks 1, 5 and 11. Produces shipped detectors (spec §9).

- [ ] **Step 1: Write `corrosion-metal`** from the spike:
  - `looksLike`: `"corrosion on metal: orange-brown rust, rust streaks running down a surface, flaking or blistered paint with rust underneath, pitted or scaled steel"`
  - `ignore`: `"intact red or orange painted bands, dirt, sand, shadows, steam, or staining on concrete"`
  - `question`: `"Answer yes only if you can see rust on a METAL object (pipe, duct cladding, steel beam, plate, loose steel). Answer no for painted bands, a concrete chimney or wall, dirt or streak staining on concrete, steam, or clean metal."`
  - `classId` `corrosion`, `assetTypes` `["plant","chimney"]`, `status` `experimental`, default tiles, threshold 0.8.
- [ ] **Step 2: Acceptance run** with the pack's server: `bench.py --project <chimney reference> --detector … --split bench --truth-class corrosion`, plus the spike's 8 photos. Check that the scores are within ±0.05 of the spike's (0.98 pipe, 0.99 loose steel, 0.97 cap, 0.59 bands, 0.65 duct). Attach the sheet to the PR description only — no client imagery in the repo.
- [ ] **Step 3: Facade, then flare.** For each candidate class:
  1. Tune on `--split tune`.
  2. Measure on `--split bench`.
  3. The person reviews `drafts.json` for false alarms.
  4. Set `status: verified` only when recall ≥ 0.70 and ≤ 1 false draft per photo; otherwise `experimental` or left out.

  Commit each detector with its bench numbers in the commit body (numbers only, no project names).

- [ ] **Step 4: Rebuild the pack** (`pnpm analytics-pack --out <dir>`) and check that `manifest.detectors` lists them.

## Task 14: Docs and the decision reversal

**Files:**

- Modify:
  - `docs/plans/2026-10-06-m8-change-modelling.md`: under decision 1, add "Reversed for the Analytics pack only (founder, 2026-10-17): `llama-server` and the Qwen2.5-VL GGUF ship in `analytics-pack-<ver>`; the person's own server route is unchanged."
  - `docs/KNOWN-LIMITS.md`: detectors are NVIDIA/Windows only; open-ended detection stays cloud.
  - `docs/release/README.md`: building and handing over the Analytics pack.
- [ ] **Step 1: Write the edits.** Then run `node tools/agent/check-public-text.mjs` on each changed file and `pnpm format:check`. Expected: clean.
- [ ] **Step 2: Commit** `docs: analytics pack, detectors and the M8 decision 1 reversal`.

## Next plans (not in this merge)

- **Merge 2:**
  - The run dialog (third choice in `AiDetectDialog` / `LocalDetect`), with the command in `actions`.
  - The param-aware job title.
  - `ScoreBadge`, `ThresholdSlider` and `RejectReasonMenu` in `Inspector` / `ContactSheet` / `BatchConfirm`, writing `ledger:append` on accept, reject and box edit.
  - Settings sections (pack, hardware, library with hit rates).
- **Merge 3:**
  - The full-screen "build a detector" view.
  - `.aiodet` import and export UI.
  - Prompt suggestions from reject reasons.
  - Check-before-replacing using the ledger crops.
  - Reference examples in the engine's check step.
  - COCO / YOLO dataset export.
- **Content track continues:** roads (watch the tile-size risk), then chimney once its benchmark is labelled.
