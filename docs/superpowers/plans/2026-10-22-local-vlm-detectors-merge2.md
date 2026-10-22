# Local Vision-Model Detectors (Merge 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can install the Analytics pack from Settings and see whether this computer can run detectors. From the Detections screen they can choose detectors and start a run. They can then review its drafts with scores, a threshold slider and reject reasons. Every review decision goes into the local ledger, and each detector shows its hit rate in Settings.

**Architecture:**

- **Fixes first.** The Merge 1 items left for Merge 2 (Ruling Y, Q and R of the Merge 1 ledger) come first. They harden main and the pipeline before the UI exposes them:
  - the GPU and driver check, and the server's own output
  - the pack re-check and a minimum processing pack
  - timeouts
  - photo jobs held while a detector run uses the card
  - a visible queue that can be cancelled
  - the install progress event, and licence texts in the pack
- **Model layer.** `packages/annotate` carries the detector fields into the renderer's `Detection` and adds a per-pass threshold to the review state.
- **UI.** Three groups of self-contained components:
  - `renderer/detections/detectors/*`: the run dialog mode, the queue strip, the pass strip, the score badge and the reject reason menu
  - `renderer/screens/settings/AnalyticsPack.tsx` and `DetectorLibrary.tsx`
  - `renderer/detections/detectors/ledgerLog.ts`, which turns review actions into ledger lines

**Tech Stack:** React 19, zustand (vanilla stores), `@aio/ui` parts, zod v4 (`@aio/schema`), Electron main, Python 3.13 (pytest), vitest (jsdom, `createRoot` + `act`, no testing-library), Playwright Electron.

**Spec:** `docs/superpowers/specs/2026-10-17-local-vlm-detectors-design.md`. § numbers refer to it, and Delivery item 2 is this merge. Merge 1 plan: `docs/superpowers/plans/2026-10-17-local-vlm-detectors-merge1.md`.

**Before Task 1:** rebase onto `main` after PR #215 (security hardening) lands. It changes:

- `packInstall.ts`: both pack kinds go through a signature / unsigned-confirm gate.
- the hardware and server code: `nvidia-smi`, `tasklist` and `ps` run by full path, and `llama-server` starts with `jobBaseEnv`.

Tasks 1, 4 and 5 build on that version. First check that `LLAMA_API_KEY`, `CUDA_VISIBLE_DEVICES` and `CUDA_DEVICE_ORDER` still reach the server (`server.test.ts`). The "typed model corrections" and antenna flagging specs (#216) were checked on 22 Oct: they have no overlap with detector reject reasons or the ledger.

**Deviations from the spec's wording (reported to the founder):**

- **No "Open in builder" in the detector library.** The builder is Merge 3.
- **Python job errors stay English** (reverses Merge 1 Ruling H). Every pipeline's job errors are English text from Python, shown as they are, and moving three strings would need a code path no other pipeline has.
- **Detector toggles are `Button pressed`, not `Chip`.** `@aio/ui` `Chip` is display-only and has no pressed state. `Button` has `pressed`.
- **The Detect dialog is not an `actions` command.** The `actions` registry holds right-click menus, not palette commands. The dialog keeps the Detections header button, and the palette already reaches the Detections screen.
- **"Run the remaining" is the job's Resume, relabelled for `detect.vlm`.** A resume skips the photos already done (Merge 1), which is exactly what the spec asks for.

## Global Constraints

- **Hardware minimum:** NVIDIA, total VRAM ≥ 8192 MB, free ≥ 6656 MB at start (Merge 1). New in Merge 2: compute capability ≥ 7.5 and driver ≥ 580. CUDA 13 dropped older cards. The founder's driver 591.86 (CUDA 13.1) ran the CUDA 13.4 build, so 580, the CUDA 13.0 driver floor, is the line.
- **Minimum processing pack for `detect.vlm`:** `0.23.0`. Pack 0.22.0 is the current one and was cut before Merge 1, so it has no `detect.vlm`. The release cuts 0.23.0; no pyproject bump on this branch (Merge 1 Ruling E).
- **Engine timeouts:** a detect (tile) request 120 s, a check request 60 s (were 300 s).
- **Thresholds:**
  - The run dialog slider runs 0.50 to 0.95 in 0.05 steps.
  - The review slider runs 0.30 to 0.95 in 0.05 steps, and defaults to the pass origin's `threshold`.
  - A suggested threshold is shown with a "Use" button and never applied silently (§7).
- **Time estimate:** 7 s per photo per detector (`VLM_SECONDS_PER_PHOTO = 7`, spike: 5–8 s on an RTX 5070 Ti). Shown rounded up to whole minutes.
- **Unscored drafts are never hidden by a threshold.** A model reply with neither yes nor no is a failure to show, not a low score (anti-goal "silent failure").
- **Strings:** every new string goes in the `en.ts` block `// ---- local detectors (Analytics pack) ----`, keys `detect.preset.*`, in sentence case. The exact copy given in a task is to be used verbatim.
- **UI rules (spec Constraints):**
  - `@aio/ui` parts.
  - No DOM `title=` (use `Tip`).
  - Tokens for colour, font size, shadow and z-index (`cssGuard`), logical CSS properties.
  - Settings groups are sections (`.sblock`), not cards.
  - A started job never opens the sidebar or drawer (I-R39).
  - Feature CSS is a plain `.css` beside the component, scoped by a root class (`.det-vlm-*`, `.ap-*`, `.dl-*`).
- **Review components are self-contained** under `renderer/detections/detectors/` with props in, callbacks out. UI project 4 will move them.
- **No data leaves the machine.** No client, site or person names in code, tests, fixtures, docs or commits (`node tools/agent/check-public-text.mjs`).
- **Contracts:** every new or changed IPC channel, event, schema field or file gets a row in `docs/architecture/contract-changes.md`, in the task that makes the change, in the existing row format.
- **Pipeline pack behaviour stays the same.** The existing `packInstall`, `processingToolsStore` and `ProcessingEngine` tests pass unchanged.
- **Stage-island freeze is over.** Stages 2 and 3 landed on 18 Oct (`docs/sessions/2026-10-18-0255-stage-island-stages-2-3.md`). Task 11 changes only the job-title call in `JobsBench.tsx`, `JobDetail.tsx` and the island live line.

## Review Focus

1. **A selection that spans two photo layers, or mixes photos with video frames.** The person expects one run per layer, a note that frames are skipped, and a disabled Start with a reason when only frames are selected. Test: Task 10 `splits the selection into one job per layer and skips frames`.
2. **A detector whose class is not in the project's catalogue.** Its drafts must show with a "Create class" suggestion, not as unclassified drafts the person cannot accept. Test: Task 2 `test_class_missing_from_project_suggests_new`.
3. **A draft reviewed, undone and reviewed again.** The ledger counts only the latest verdict for that draft, so the hit rate is not inflated. Test: Task 8 `stats count the latest line per detection`.
4. **Unscored drafts under a raised threshold.** They stay visible with "No score". Test: Task 7 `unscored drafts are never hidden by a pass threshold`.
5. **An installed Analytics pack that no longer fits the app** (app updated past its `appRange`, or a damaged model file). Settings names the reason and a run refuses with it, rather than finding no pack and saying nothing. Tests:
   - Task 1 `an out-of-range pack is reported as unusable with its reason`
   - Task 5 `shows why an installed pack cannot be used`

---

### Task 1: Main hardening (GPU and driver, server output, pack re-check, minimum processing pack)

**Files:**

- Modify: `apps/desktop/src/main/analytics/hardware.ts`, `server.ts`, `pack.ts`, `packIpc.ts`; `apps/desktop/src/main/jobs/packInstall.ts` (`readKindPack` for `ANALYTICS_PACK`); `apps/desktop/src/main/index.ts` (pack refusal chain at the `jobs:start` gate, about :1573); `packages/schema/src/analytics.ts`, `ipc.ts`; `packages/ui/src/i18n/en.ts`
- Test: `hardware.test.ts`, `server.test.ts`, `pack.test.ts`, `packInstall.test.ts`, a new `apps/desktop/src/main/analytics/detectPack.test.ts`

**Interfaces:**

- Produces:
  - `Gpu` gains `driver: string` and `computeCap: number | null`.
  - `checkHardware` adds the two refusals below. `HardwareCheck` is unchanged.
  - `analyticsPack:status` response gains `unusable: { version: string; reason: string }[]`.
  - `DETECT_MIN_PACK = '0.23.0'` and `detectPackRefusal(pipeline, packVersion): string | null`, exported from `apps/desktop/src/main/analytics/detectPack.ts`.
  - `server.lastOutput(): string[]` (the last lines of the current or most recent launch).

- [ ] **Step 1: Write the failing tests**
  - `hardware.test.ts`:
    - `refuses a card older than compute 7.5`: a csv row with compute_cap `6.1` → `{ok:false, reason: en['detect.preset.hw.oldGpu'] with {gpu}}`.
    - `refuses a driver older than 580`: driver `572.16` → `hw.oldDriver` with `{version: '572.16'}`.
    - `falls back when compute_cap is not a query field`: the first exec throws "Field "compute_cap" is not a valid field", and the second query (without it) succeeds with driver `591.86` → ok, `computeCap: null`.
  - `server.test.ts`:
    - `a server that exits before ready reports its last output`: the fake process writes `"ggml_cuda_init: failed\nCUDA error: no kernel image"` to stderr and exits with 1. The `ensure` refusal contains `no kernel image`.
    - `a missing executable says so`: spawn emits ENOENT. The reason is `en['detect.preset.server.noExe']`, not "exit code null".
  - `pack.test.ts`:
    - `an out-of-range pack is reported as unusable with its reason`: the manifest `appRange` is `>=9.0.0`. `findAnalyticsPack` returns null and `unusablePacks` lists `{version, reason}` naming the range.
    - `a pack missing its mmproj is unusable`: same shape.
  - `packInstall.test.ts`: `analytics listPacks marks a pack without its gguf invalid`. Every existing test stays unchanged.
  - `detectPack.test.ts`: `detect.vlm needs processing tools 0.23.0` gives pack `0.22.0` → `"Detectors need processing tools 0.23.0 or later (these are 0.22.0). Update them in Settings, Processing tools."`; `0.23.0` → null; any other pipeline → null.

- [ ] **Step 2: Run them to verify they fail**

  Run: `pnpm --filter @aio/desktop exec vitest run src/main/analytics src/main/jobs/packInstall.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement**
  - **hardware.ts:**
    - Query `index,name,memory.total,memory.free,driver_version,compute_cap`. If `nvidia-smi` rejects the field, query again without `compute_cap`.
    - Order of refusals: no GPU → driver (`< 580`, compare the major number) → compute (`< 7.5` when known) → total → free.
    - Pick among cards that pass all of these.
  - **server.ts:**
    - Spawn with stdout and stderr piped to `<logs>/analytics-server.log`, truncated at each launch, in the folder that holds `main.log`.
    - Keep the last 20 lines in memory.
    - A launch that exits before it is healthy gets `server.failed` with the last 3 non-empty lines (at most 300 characters) as `{reason}`.
    - ENOENT gives `server.noExe`.
  - **pack.ts:**
    - `findAnalyticsPack` skips packs whose manifest `appRange` excludes `app.getVersion()` or whose platform does not match. Reuse the installer's range and alias checks; do not copy them.
    - `unusablePacks({dataRoot, appVersion})` lists the skipped packs and the reason for each.
    - `analyticsPack:status` returns them.
  - **packInstall.ts:** `readKindPack` for `ANALYTICS_PACK` requires the gguf and the mmproj as well as the server. The pipeline kind is unchanged.
  - **index.ts:** add `detectPackRefusal` to the pack refusal chain and `'detect.vlm'` to the gate condition.
  - **en.ts** (verbatim):

    ```
    'detect.preset.hw.oldGpu': 'This graphics card ({gpu}) is too old for detectors. They need an NVIDIA card from the RTX 20 series or newer.',
    'detect.preset.hw.oldDriver': 'The NVIDIA driver is version {version}; detectors need 580 or later. Update the driver from nvidia.com and check again.',
    'detect.preset.server.noExe': 'The detector model program is missing from the Analytics pack. Install the pack again.',
    'detect.preset.pack.outOfRange': 'Analytics pack {version} does not work with this version of AIO ({range}).',
    'detect.preset.pack.damaged': 'Analytics pack {version} is missing {file}. Install it again.',
    ```

  - **Contract row:** `analyticsPack:status.unusable`, the server log file, and the `detect.vlm` minimum pack.

- [ ] **Step 4: Run the tests and verify they pass**, plus `pnpm --filter @aio/desktop exec tsc --noEmit`.
- [ ] **Step 5: Commit** `fix(analytics): check driver and card age, keep server output, re-check packs, need pack 0.23.0 for detectors`

### Task 2: Pipeline fixes (timeouts, class missing from the project)

**Files:**

- Modify: `python/src/aio_pipelines/detect/engine.py`, `pipeline.py`
- Test: `python/tests/test_detect_engine.py`, `test_detect_pipeline.py`

**Interfaces:**

- Produces: in a pass, a draft whose detector `classId` is not a class in the project's catalogues has `class: ""`, `label: <detector name>` and `suggestedNew: true`. This is the same shape AI Detect writes for a `new:<name>` answer; find it in `packages/annotate/src/detections/model.ts` (`fromPass`, line ~183) and match it.

- [ ] **Step 1: Write the failing tests**
  - `test_detect_and_check_use_their_own_timeouts`: the fake client records the timeout of each call: 120 for detect, 60 for check.
  - `test_class_missing_from_project_suggests_new`: the project manifest has a catalogue without `corrosion`. The drafts carry `class == ""`, `label == "Corrosion on metal"` and `suggestedNew is True`.
  - `test_class_in_project_is_kept`: `class == "corrosion"` and no `suggestedNew`.
- [ ] **Step 2: Run** `uv run pytest python/tests/test_detect_engine.py python/tests/test_detect_pipeline.py -q` (from `python/`). Expected: the new tests FAIL.
- [ ] **Step 3: Implement**
  - `VlmClient` takes per-call timeouts: `DETECT_TIMEOUT_S = 120`, `CHECK_TIMEOUT_S = 60`.
  - In the prepare step, the pipeline reads the class ids of every catalogue in `manifest.classCatalogues`.
- [ ] **Step 4: Run the tests and `uv run ruff check src tests`.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(detect): shorter model timeouts; suggest a new class when the project lacks the detector's`

### Task 3: GPU lane both ways and a visible detector queue

**Files:**

- Modify: `apps/desktop/src/main/analytics/gate.ts`, `apps/desktop/src/main/index.ts`, `packages/schema/src/analytics.ts`, `ipc.ts`, `apps/desktop/src/preload/index.ts` (CHANNELS, EVENTS), `packages/ui/src/i18n/en.ts`
- Test: `gate.test.ts`, `packages/schema/src/analytics.test.ts`

**Interfaces:**

- Produces:
  - `DetectQueued = { run: string; layer: Id; photos: number; detectors: string[] /* names */; queuedAt: string }` in `analytics.ts`.
  - IPC `detect:queue` `{}` → `{ items: DetectQueued[] }`.
  - IPC `detect:queueCancel` `{ run }` → `Ok`. An unknown run is `{ok:false, error}`.
  - Event `detect:queue` with payload `{ items: DetectQueued[]; failed?: { run: string; error: string } }`, sent on every change.
  - `jobs:start` for `photo.align`, `photo.georef` or `photo.products` while a `detect.vlm` job is `starting|running|cancelling` → `{ok:false, error: en['detect.preset.gpuBusy']}`. Queued detector runs do not block photo jobs.
- Consumes: `detectLane` (gate.ts:132), `GPU_PIPELINES`.

- [ ] **Step 1: Write the failing tests** (gate.test.ts):
  - `a queued run is listed and can be cancelled`: start two runs while a photo job runs; `waiting()` lists both. Cancel the first; the event payload lists one.
  - `a queued start of the same run is not queued twice`: the dedup key is `params.run`.
  - `a waiting run that fails to start is reported`: the drained gate refuses, and the event carries `failed: {run, error}`.
  - `a photo job is refused while a detector run uses the card`.
  - `a photo job may start while detector runs only wait`.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/main/analytics/gate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - The lane keeps `{req, item: DetectQueued, …}`.
  - `detectLane` gains `list()`, `cancel(run)` and an `onChange(cb)` that main broadcasts as `detect:queue`.
  - The photo-job refusal goes in main's `jobs:start` path, beside `photoBusyRefusal`.
  - **en.ts** (verbatim):

    ```
    'detect.preset.gpuBusy': 'A detector run is using the graphics card. Start this when it finishes, or cancel the detector run.',
    ```

  - Contract rows for the two channels, the event and the photo-job refusal.
- [ ] **Step 4: Run the tests and verify they pass.**
- [ ] **Step 5: Commit** `feat(analytics): list and cancel waiting detector runs; hold photo jobs while a detector run uses the card`

### Task 4: Analytics pack install progress and licence texts in the pack

**Files:**

- Modify: `apps/desktop/src/main/analytics/packIpc.ts`, `apps/desktop/src/main/index.ts` (`emit` for the analytics registrar, `broadcast` type union), `packages/schema/src/ipc.ts` (`ipcEvents`), `apps/desktop/src/preload/index.ts` (EVENTS), `tools/analytics-pack/build.mjs`, `lock.json`, `README.md`
- Test: `apps/desktop/src/main/analytics/pack.test.ts` (or a new `packIpc.test.ts`), `tools/analytics-pack/build.test.mjs`

**Interfaces:**

- Produces:
  - Event `analyticsPack:progress` with the `PackInstallProgress` payload (the same as `pipelinePack:progress`).
  - The pack contains `licences/llama.cpp-LICENSE.txt` and `licences/Qwen2.5-VL-7B-Instruct-LICENSE.txt`, each listed in the manifest `files` with size and sha256.

- [ ] **Step 1: Write the failing tests**
  - `install sends analyticsPack:progress`: the fake archive install calls `emit` with phases ending in `done`.
  - `build.test.mjs` `the pack carries both licence texts`: with the fixture lock, the staged pack has both files and the manifest lists them.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `lock.json` pins:
    - llama.cpp `LICENSE` at the release tag already pinned
    - Qwen's `LICENSE` at the Hugging Face revision already pinned
    - each with URL, size and sha256 (download once to measure)
  - `build.mjs` downloads them like the other pins into `licences/`.
  - The README section lists them.
  - A contract row for the event.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(analytics-pack): install progress event; licence texts in the pack`

### Task 5: Settings: Analytics pack section with the hardware check

**Files:**

- Create: `apps/desktop/src/renderer/analyticsPackStore.ts`, `apps/desktop/src/renderer/analyticsPack.ts` (app instance and hook, like `processingTools.ts`), `apps/desktop/src/renderer/screens/settings/AnalyticsPack.tsx`, `analyticsPack.css`
- Modify: `apps/desktop/src/renderer/screens/settings/ProcessingTools.tsx`: render `<AnalyticsPack/>` after the pipeline pack `.sblock` and before `<OtherPacks/>`. Also `packages/ui/src/i18n/en.ts`.
- Test: `analyticsPackStore.test.ts`, `screens/settings/AnalyticsPack.test.tsx`

**Interfaces:**

- Consumes:
  - `analyticsPack:status|find|choose|install|cancel|remove`, `analyticsPack:progress` (Task 4), `analytics:hardware`.
  - `status.unusable` (Task 1).
  - The unsigned-confirm flow, exactly as the pipeline section handles it after #215.
- Produces:
  - `createAnalyticsPackStore(bridge, on)` with state `{status, offer, progress, installing, error, note, replace, hardware: HardwareCheck | null, checking}` and actions `load(), choose(), install(path, replace?), cancel(), remove(version), keepInstalled(), checkHardware()`.
  - The `analyticsPack` instance and `useAnalyticsPack(selector)`.

- [ ] **Step 1: Write the failing tests**
  - Store tests:
    - `load reads status and hardware`
    - `progress events update progress`
    - `an exists answer asks to replace`
    - `remove refreshes status`
  - Component tests:
    - `not installed shows the offer and Install` (testids `ap-offer`, `ap-install`)
    - `installed shows the version and Remove with an inline confirm` (`ap-remove`, `ap-remove-yes`)
    - `shows why an installed pack cannot be used`: `unusable` renders its reason in `ap-unusable`
    - `the hardware line shows the card and free memory`: ok → "NVIDIA GeForce RTX 5070 Ti · 16 GB · 13.2 GB free", testid `ap-hw`
    - `the hardware line shows the refusal reason and Check again`: testid `ap-hw-recheck` calls `checkHardware`
    - `on a Mac the section says it is not available` (`hw.mac` reason, no install button)
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/analyticsPackStore.test.ts src/renderer/screens/settings/AnalyticsPack.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Mirror `ProcessingTools.tsx`'s `Status`, `Install` and `OtherPack` patterns (offer card, progress row with `toast-bar`, `notice` replies, inline remove confirm). Reuse `progressText` from `ProcessingTools.tsx`.
  - Heading "Analytics pack". Help text (verbatim): "Runs detectors on this computer, with no internet. It needs an NVIDIA graphics card with 8 GB of memory and takes about 7 GB of disk."
  - Keys `detect.preset.settings.*`. Licence line: "Includes llama.cpp (MIT) and Qwen2.5-VL-7B-Instruct (Apache-2.0)."
- [ ] **Step 4: Run the tests** and `pnpm --filter @aio/desktop exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): Analytics pack section with the hardware check`

### Task 6: Settings: detector library with hit rates

**Files:**

- Create: `apps/desktop/src/renderer/screens/settings/DetectorLibrary.tsx`, `detectorLibrary.css`
- Modify:
  - `ProcessingTools.tsx`: render `<DetectorLibrary/>` after `<AnalyticsPack/>`.
  - `apps/desktop/src/main/analytics/ledgerIpc.ts`, `packages/schema/src/ipc.ts`, preload CHANNELS (new `ledger:clear`).
  - `packages/ui/src/i18n/en.ts`.
- Test: `DetectorLibrary.test.tsx`, `ledgerIpc.test.ts`

**Interfaces:**

- Consumes:
  - `detectors:list {projectId?}`, `detectors:import`, `detectors:export`, `detectors:remove`, `ledger:stats {detectorId}`.
  - The open project id, from the shell store the other Settings sections use.
- Produces:
  - IPC `ledger:clear {detectorId}` → `Ok`, calling `clearLedger`.
  - `hitRate(stats): number | null` = accepted / (accepted + rejected), null when both are 0.

- [ ] **Step 1: Write the failing tests**
  - `lists shipped, library and project detectors in groups`: group headings "Shipped", "My library", "This project".
  - `an experimental detector is labelled` (`Chip kind="status" tone="warn"`, "Experimental").
  - `a model mismatch shows the warning` (`detect.preset.modelMismatch` in a `Tip`).
  - `shows the hit rate, misses and suggested threshold`: stats `{accepted: 9, rejected: 3, misses: 2, suggestedThreshold: 0.85}` → "75% hit rate · 12 reviewed · 2 missed · suggested threshold 0.85".
  - `no reviews shows "No reviews yet"`.
  - `import with a conflict offers update or keep both`: the first answer has a `conflict` → two buttons; Keep both re-invokes with `onConflict: 'keep-both'`.
  - `export asks whether to leave out sample photos`: the checkbox "Leave out sample photos (client-confidential)" sends `includeSamples: false`.
  - `shipped detectors cannot be removed` (no remove button).
  - `clear review history asks first and calls ledger:clear`.
  - `ledgerIpc.test.ts`: `ledger:clear refuses a bad id and clears a good one`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Rows use `@aio/ui` `Row` or a `tbl` table like `OtherPacks`.
  - Import goes into "My library".
  - With no pack installed, shipped detectors are absent and the section shows the library and project groups only.
  - A contract row for `ledger:clear`.
- [ ] **Step 4: Run** the tests and `tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): detector library with hit rates, import, export and clear history`

### Task 7: Detector fields in the review model and a per-pass threshold

**Files:**

- Modify: `packages/annotate/src/detections/model.ts` (`Detection`, `fromPass`, `toPass`), `packages/annotate/src/detections/review.ts` (`ReviewState`, actions, `inQueue`), `packages/schema/src/detections.ts` (`proposedBox`)
- Test: `packages/annotate/src/detections/model.test.ts`, `review.test.ts`, `packages/schema/src/detections.test.ts`

**Interfaces:**

- Produces:
  - Renderer `Detection` gains:
    - `belowThreshold?: boolean`
    - `unscored?: boolean`
    - `rejectReason?: RejectReason`
    - `rejectNote?: string`
    - `proposedBox?: [number, number, number, number]`
  - The `origin` kind `'model'` gains `detector?: { id: string; version: number; modelSha256: string; threshold: number }`, filled from the pass origin's detector fields.
  - Schema `Detection.proposedBox` (Box4, source px): the box the detector proposed, written on the first box edit of a detector draft.
  - `ReviewState.passThreshold: Record<string /* pass */, number>`.
  - Review actions:
    - `{type:'passThreshold', pass, value}`
    - `{type:'reject', id, by, now, reason?: RejectReason, note?: string}`
  - `isDetectorDraft(d): boolean`.
  - `detectorThreshold(state, d): number | null`: the pass value, else the origin threshold, else null.
  - `inQueue` hides a detector draft when `!d.unscored && d.confidence < detectorThreshold`. That replaces `belowThreshold` for visibility, so raising or lowering the threshold works both ways.

- [ ] **Step 1: Write the failing tests**
  - `fromPass carries detector fields and toPass writes them back unchanged` (round trip of a `vlm-run-a.json` fixture).
  - `a draft under the pass threshold is hidden and shown when the threshold drops`.
  - `unscored drafts are never hidden by a pass threshold`.
  - `the first edit of a detector draft keeps the proposed box; later edits do not move it`.
  - `reject keeps the reason and note`.
  - `human and cloud AI drafts ignore pass thresholds`.
  - Schema: `proposedBox accepts four finite numbers`.
- [ ] **Step 2: Run** `pnpm --filter @aio/annotate exec vitest run src/detections` and `pnpm --filter @aio/schema exec vitest run src/detections.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** A contract row for `proposedBox`.
- [ ] **Step 4: Run** the tests plus `pnpm --filter @aio/desktop exec vitest run src/renderer/detections` (the store must still pass). Expected: PASS.
- [ ] **Step 5: Commit** `feat(annotate): detector fields, per-pass threshold and reject reasons in the review model`

### Task 8: Review decisions into the ledger

**Files:**

- Create: `apps/desktop/src/renderer/detections/detectors/ledgerLog.ts`, `crop.ts`
- Modify:
  - `apps/desktop/src/renderer/detections/store.ts`: call the logger after `accepted`, `reject` and `rejectMany`, and after a human `create`.
  - `packages/schema/src/analytics.ts` (`LedgerEntry` gains `detectionId?: string`, `crop?: string`).
  - `apps/desktop/src/main/analytics/ledger.ts`: `appendLedger` records the crop file name in `crop`; `ledgerStats` and `suggestThreshold` keep the latest line per `detectionId`.
- Test: `ledgerLog.test.ts`, `crop.test.ts`, `ledger.test.ts`

**Interfaces:**

- Consumes: Task 7 fields and `ledger:append {entry, cropJpegBase64}`.
- Produces:
  - `logReview(d: Detection, verdict: 'accepted' | 'rejected', ctx: {projectId, layer}): Promise<void>`. It does nothing for non-detector drafts.
  - `logMiss(d: Detection, passes, ctx): Promise<void>`. A person-drawn detection on a photo listed in a `vlm-*` pass's `assessed`, whose class equals a detector's `classId` in that pass, becomes one `miss` line per such detector.
  - `cropJpeg(photoUrl, box, maxSide = 512, pad = 0.15): Promise<string /* base64 */>`.
  - A ledger failure is logged and never blocks the review.

- [ ] **Step 1: Write the failing tests**
  - `ledgerLog.test.ts`:
    - `accepting a detector draft appends one accepted line with score and box`
    - `rejecting with a reason sends reason and note`
    - `an edited then accepted draft sends box = proposedBox and corrected = the new box`
    - `a batch reject logs every detector draft`
    - `a cloud AI draft logs nothing`
    - `a hand-drawn finding of the detector's class on an assessed photo logs a miss`
    - `on another class or an unassessed photo logs nothing`
  - `crop.test.ts`: `crops with padding, clamps at the photo edge and fits within 512 px`. Use a canvas stub; follow how other renderer tests stub canvas, or inject the draw function.
  - `ledger.test.ts`:
    - `the entry records its crop file`
    - `stats count the latest line per detection`: accepted, then rejected, for the same `detectionId` → `{accepted: 0, rejected: 1}`
    - `lines without detectionId all count`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `crop.ts` loads the photo through the URL the review already uses for full photos (`Editor.tsx`), so it needs no new IPC.
  - Contract rows for `LedgerEntry.detectionId` and `crop`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(detections): log detector review decisions and misses to the local ledger`

### Task 9: Review components (score badge, pass strip with threshold, reject reason menu)

**Files:**

- Create, in `apps/desktop/src/renderer/detections/detectors/`: `ScoreBadge.tsx`, `ThresholdSlider.tsx`, `DetectorPasses.tsx`, `RejectReasonMenu.tsx`, `detectors.css`
- Modify:
  - `Inspector.tsx`: `ScoreBadge` beside `OriginLine` for detector drafts. Reject on a detector draft opens `RejectReasonMenu`, anchored to the reject button.
  - `screens/Detections.tsx`: `DetectorPasses` under the header when at least one `vlm-*` pass is loaded.
  - `en.ts`
- Test: `ScoreBadge.test.tsx`, `DetectorPasses.test.tsx`, `RejectReasonMenu.test.tsx`, `Inspector.test.tsx` (new cases)

**Interfaces:**

- Consumes: Task 7 `detectorThreshold` and the `passThreshold` action; the `reject` action with its reason.
- Produces:
  - `ScoreBadge({score, threshold, unscored})`
  - `ThresholdSlider({value, min = 0.3, max = 0.95, step = 0.05, label, onChange})`, a native `input[type=range]` styled with tokens
  - `DetectorPasses({passes: {pass, detectorName, runAt, threshold, shown, hidden}[], onThreshold(pass, value)})`
  - `RejectReasonMenu({open, opener, onPick(reason | null, note?), onClose})`

- [ ] **Step 1: Write the failing tests**
  - `ScoreBadge`: `0.93` at threshold `0.8` → "0.93" with the accent tone; `0.62` → "0.62 · under threshold"; `unscored` → "No score" with the warn tone and a `Tip` (verbatim: "The model gave no clear yes or no for this box.").
  - `DetectorPasses`: `shows each pass with shown and hidden counts`. Moving a slider calls `onThreshold('vlm-run-a.json', 0.6)`.
  - `RejectReasonMenu`:
    - Items, verbatim: "Looks like it but is not…", "Not a defect", "Wrong class", "Box is wrong", "Other reason", "Reject without a reason".
    - "Looks like it but is not…" reveals a one-line input (placeholder "What is it? For example, a painted band"). Enter sends `('looks-like-but-is-not', text)`.
  - `Inspector`:
    - `reject on a detector draft opens the reason menu; Reject without a reason rejects with no reason`.
    - `the R key still rejects at once`.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/detections`. Expected: FAIL.
- [ ] **Step 3: Implement.** The components take props only and read no stores. `Detections.tsx` and `Inspector.tsx` wire them.
- [ ] **Step 4: Run** the tests and `tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(detections): detector scores, per-run threshold and reject reasons in the review`

### Task 10: Run dialog: "Detectors (on this computer)"

**Files:**

- Create: `apps/desktop/src/renderer/detections/detectors/DetectorRunDialog.tsx`, `runPlan.ts`
- Modify: `AiDetectDialog.tsx` and `LocalDetect.tsx` (`DetectMode` adds `'detectors'`; `ModeSwitch` gets a third option with testid `det-mode-detectors` and label "Detectors (on this computer)"), `en.ts`
- Test: `runPlan.test.ts`, `DetectorRunDialog.test.tsx`

**Interfaces:**

- Consumes:
  - `detectors:list {projectId}`, `ledger:stats`, `analyticsPack:status`, `analytics:hardware`.
  - `jobs.start(req)` from `../../shell`.
  - `detect:queue` (Task 3).
  - The project manifest's `classCatalogues[].assetType`.
- Produces:
  - `planRuns(items: DetectItem[], detectors: Chosen[]): { runs: { layer: Id; photos: Id[] }[]; skippedFrames: number }`.
  - `estimateMinutes(photos, detectorCount): number` = ceil(photos × detectorCount × 7 / 60).
  - `orderForProject(list, assetTypes)`: detectors matching the project's asset types first, then the rest under "All detectors".
  - Start sends, per run, `{pipeline: 'detect.vlm', project, params: {run: 'run-<uuid8>', layer, photos, detectors: [{where, detector, threshold}]}}`, the same shape as `apps/desktop/e2e/detectors-local.spec.ts`. The gate fills the server, model and stored detector.

- [ ] **Step 1: Write the failing tests**
  - `runPlan.test.ts`:
    - `splits the selection into one job per layer and skips frames`
    - `estimateMinutes rounds up`: 240 photos × 1 detector → 28
    - `orders the project's asset type first`
  - `DetectorRunDialog.test.tsx`:
    - `Start is disabled without the pack` (disabledReason = `detect.preset.pack.missing`)
    - `Start is disabled on a hardware refusal except too busy`: `tooBusy` shows a warn notice with the free memory and "Check again", and Start stays enabled. `noGpu`, `tooSmall`, `oldGpu`, `oldDriver` and `mac` disable it with their reason.
    - `only video frames selected disables Start`: reason, verbatim: "Detectors run on photos. Select photos, not video frames."
    - `no detector chosen disables Start` ("Choose at least one detector.")
    - `an experimental detector and a model mismatch are labelled`
    - `the suggested threshold shows with Use and is not applied until clicked`
    - `shows the estimate`: "About 28 min for 240 photos"
    - `starting one run closes the dialog`: `jobs.start` was called once with the shape above
    - `a queued answer says it will start when the card is free`: `jobs.start` returns an error and `detect:queue` lists the run → the notice `detect.preset.queued`, and the dialog closes on OK
    - `a detector whose class is missing says it will suggest the class`: verbatim "{class} isn't a class in this project yet. Its findings will offer to add it."
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Any reason that keeps Start disabled is also shown as a line next to Start (testid `det-vlm-blocker`), not only in the `disabledReason` tip. The founder could not see why a Send button was greyed out in the model corrections flow (`2026-10-22-engineering-model-typed-corrections-design.md`); Start must never look dead with no reason on screen. Add the test `the blocker reason is visible next to Start`.
  - Dialog chrome as `LocalDetectDialog` (`.dlg-scrim > .dlg.wide.det-ai`, `useFocusTrap`).
  - Detector toggles are `Button pressed` in two groups: the project's asset type, then "All detectors".
  - A `ThresholdSlider` (Task 9) per chosen detector, min 0.5.
  - The `ModeSwitch` choice persists in localStorage `stratlas.detect.mode`, as today.
- [ ] **Step 4: Run** the tests and `tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(detections): run detectors on this computer from the Detect dialog`

### Task 11: Waiting runs, job titles and "Run the remaining"

**Files:**

- Create: `apps/desktop/src/renderer/detections/detectors/DetectorQueue.tsx`
- Modify:
  - `apps/desktop/src/renderer/processing/pipelines.ts`: add `jobTitleFor(job: Pick<JobRecord, 'pipeline' | 'params'>): string`.
  - Swap the title call in `JobDetail.tsx`, `workspace/workbench/benches/JobsBench.tsx` and the island live line to `jobTitleFor(job)`.
  - `JobDetail.tsx`: Resume reads "Run the remaining" for `detect.vlm`.
  - `screens/Detections.tsx`: `DetectorQueue` above `DetectorPasses`.
  - `en.ts`.
- Test: `pipelines.test.ts`, `DetectorQueue.test.tsx`, `JobDetail.test.tsx`

**Interfaces:**

- Consumes: the `detect:queue` event, `detect:queue` and `detect:queueCancel` (Task 3).
- Produces: `jobTitleFor` returns `jobTitle(pipeline)` for every pipeline other than `detect.vlm`.

- [ ] **Step 1: Write the failing tests**
  - `pipelines.test.ts`:
    - `one detector: Finding corrosion on metal in 240 photos`: verbatim key `detect.preset.job.one` = "Finding {name} in {count} photos". `{name}` is the detector name in lower case.
    - `several: Running 3 detectors on 240 photos`: `detect.preset.job.many` = "Running {n} detectors on {count} photos".
    - `missing params fall back to Running detectors`.
  - `DetectorQueue.test.tsx`:
    - `lists waiting runs with Cancel`: "Waiting for the graphics card: Corrosion on metal, 240 photos". Cancel calls `detect:queueCancel`.
    - `a failed waiting run shows its error until dismissed`.
    - `renders nothing when empty`.
  - `JobDetail.test.tsx`: `a resumable detector job offers Run the remaining`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(detections): show and cancel waiting detector runs; detector job titles`

### Task 12: End-to-end through the UI and visual evidence

**Files:**

- Modify: `apps/desktop/e2e/detectors-local.spec.ts` (a new test beside the IPC test, which is kept)
- Create: `apps/desktop/e2e/analytics-settings.spec.ts`

**Interfaces:**

- Consumes:
  - The `QUADRION_VLM_SERVER_URL` fake seam, `startFakeLlm` with `VLM_BOXES/HIGH/LOW`, `openChangeDemo`.
  - Every testid above.

- [ ] **Step 1: Write the tests**
  - `detectors-local.spec.ts` `runs a detector from the Detect dialog and reviews its drafts`. Flow:
    1. Save a library detector through IPC (as the existing test does) and open Detections.
    2. Select photos and open `det-ai-open`, then `det-mode-detectors`.
    3. Toggle the detector, Start, and wait for the job.
    4. Check the drafts show `ScoreBadge` values from the fake (HIGH and LOW).
    5. Raise the pass threshold above HIGH: the count drops. Lower it: they return.
    6. Reject one draft with "Not a defect": `<userData>/detector-ledger/<id>.jsonl` gains a line with `verdict: 'rejected'` and `reason: 'not-a-defect'`.
    7. Take screenshots of the dialog, the review with the strip, and the reason menu into `test-results/`.
  - `analytics-settings.spec.ts` `the Analytics pack section shows the hardware check and the detector library`: Settings → Processing tools. `ap-hw` shows a reason (CI has no NVIDIA card) or a card. The detector library shows the saved library detector with "No reviews yet". Take a screenshot.
- [ ] **Step 2: Run them the CI way** (CONTRIBUTING "End to end the way CI runs it": 1100 × 720, display scale 1, WARP, demos built with `pnpm demo:change --quick`):

  ```
  pnpm --filter @aio/desktop test:e2e -- detectors-local.spec.ts analytics-settings.spec.ts
  ```

  Expected: PASS, three runs in a row.

- [ ] **Step 3: Run `pnpm check`.** Expected: green.
- [ ] **Step 4: Commit** `test(e2e): detectors from the Detect dialog, review, ledger and Settings`

### After the last task (controller)

- [ ] Real-hardware acceptance on the RTX 5070 Ti with the built pack (`scratchpad/pack-out`):
  1. Install it through Settings.
  2. Run corrosion-metal on the 8 spike photos from the Detect dialog.
  3. Review a few drafts with reasons and confirm the ledger lines and hit rate.
  4. Screenshots for the founder.
- [ ] Run `/wrapup`. The session note says what the founder will see in the app (Settings, Processing tools: Analytics pack and Detector library; Detections: Detect, then "Detectors (on this computer)"), and that the run needs processing tools 0.23.0 or later.
- [ ] Update `docs/KNOWN-LIMITS.md`. Still not in the app: the custom detector builder, `.aiodet` sharing beyond import/export in Settings, learning suggestions and dataset export (Merge 3).
