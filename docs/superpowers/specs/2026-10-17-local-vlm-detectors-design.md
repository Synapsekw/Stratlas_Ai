# Local vision-model detectors (Analytics pack) — design

Date: 2026-10-17. Branch: `docs/local-vlm-detectors`. Status: draft for founder review.

## Intent

Writing an inspection report takes a long time because someone has to go through every photo looking for defects. Detectors speed that up. A **detector** is a fixed, tested recipe for one kind of defect (corrosion, cladding damage, concrete spalling and so on). It runs on a local vision-language model, Qwen2.5-VL-7B-Instruct, on the user's own machine. It flags candidate observations as **drafts** in the existing Detections review, and a person accepts or rejects each one. Nothing counts until a person accepts it.

It is meant to work like a trained ML detector without training one. Each detector asks one fixed question and gives a box and a 0–1 score per candidate. The user chooses a threshold. Detectors come in packs per asset type, because telecom, chimneys and flares each have different defects. Users can also build their own detectors and share them.

The long-term payoff belongs to the user. Every accept, reject and correction they make while reviewing is kept as labelled data on their machine. It tunes their detectors now and becomes the training data for their own YOLO models later. Nothing is sent back to us.

## Evidence (spike, 2026-10-17)

A throwaway test ran Qwen2.5-VL-7B (Q4_K_M, 6 GB, through Ollama 0.40.5 on an RTX 5070 Ti 16 GB) on photos from the reference chimney project. That project has a reviewed Claude Opus `detect-v2` run: 23 drafts, 9 accepted. The scripts are not in the repo.

- **Open-ended prompts do not work at this model size.** "Find the defects" (and `detect-v2` as it stands) returned one box per photo, nearly always "corrosion", often covering the whole frame, always with 0.9 confidence. It never found the cladding damage the reviewer accepted.
- **`detect-v2` cannot be reused unchanged.** Asked for 0–1 fractions, Qwen returns absolute pixel corners of the image it was sent. Parsed as fractions, every box lands off the image and the run reports nothing, with no error.
- **The recipe below works as a first pass.** Results on 8 photos with a tuned corrosion prompt:
  - **Tiling** stopped the concrete shaft being boxed. The tiled pass found the rusty foreground pipe (accepted on the Claude run), loose steel on the ground and the chimney top.
  - **The yes/no check** cut false positives.
  - **Scores (P(yes))** sorted results into ranks: real corrosion at 0.97–0.99; painted chimney bands at 0.59 and a clean duct at 0.65 (false positives in the middle band); the concrete shaft at 0.16. A 0.8 threshold cut almost all false positives. One stayed: a duct box at 0.81.
  - **Wording matters.** Results were sensitive to the "ignore" text. Painted red bands are the main trap on chimneys.
- **Speed:** about 1 s per full-photo call, about 4–5 s for the four tiles and about 0.5 s per crop check. That is roughly 5–8 s per photo per detector on that GPU. The model uses about 5.7 GB of VRAM with an 8192-token context.
- **Not tested:** recall on a properly labelled set, other defect classes, Apple Silicon, and `llama-server` instead of Ollama.

## Goals

1. **Detectors, not questions.** Each detector is a fixed recipe for one class: a "looks like" prompt, an "ignore" prompt, tiling, a crop check and a default threshold. Users never type open-ended prompts to run detection.
2. **Packs per asset type.** Shipped detectors are grouped by asset type. v1 has chimney stack, flare stack, building facade and roads; telecom and others come later. The project's asset type picks which detectors are offered first, and the rest stay reachable.
3. **Run by a person, never automatically.** The user selects photos, picks detectors, sets the threshold and starts a job. Nothing runs on import or in the background on its own.
4. **Results are drafts in the existing review.** They land as an `aio.detections/1` pass with a score per draft and the detector and model versions in the origin. The existing accept and reject flow applies.
5. **Shipped offline in an Analytics pack.** The model and its runtime come in an optional `analytics-pack-<ver>-<platform>.tar.gz`, installed from a local archive exactly like the pipeline pack. AIO downloads nothing.
6. **Hardware check.** Before offering the feature, AIO checks NVIDIA GPU memory. If there isn't enough, or there is no NVIDIA GPU, it says so plainly and the feature does not run. There is no CPU fallback.
7. **Custom detectors.** A guided flow creates one: name, looks like, ignore, sample photos, test, adjust, save. Built-in examples and copies of shipped detectors are the starting points. When saving, the user chooses **this project**, **my library**, or **export** to a `.aiodet` file that colleagues can import.
8. **Learning from reviews, locally.** Every review decision on a detector draft is kept with the crop, verdict, optional reject reason, the corrected box and the score. That data drives:
   - a suggested threshold,
   - suggested prompt edits from reject reasons, tested against past reviews before a new version replaces the old one,
   - reference examples attached to a detector,
   - dataset export (COCO / YOLO) for training later.
9. **Quality visible.** Shipped detectors pass a quality bar before release. Each detector shows its live hit rate from real reviews.

## Non-goals (v1)

- **Using Qwen for the in-app agent.** This model has no tool calling in Ollama, and a 7B model cannot drive AIO's tool set reliably. The agent stays on cloud models or the person's own local server, as today.
- **Automatic runs** on import, schedules, or watching folders (founder: never automated).
- **Training models in AIO** (YOLO or a Qwen fine-tune). That is a later project once the app is nearly complete. v1 only makes sure the data for it is collected and exportable.
- **Sending data to Synapse.** There is no telemetry and no "contribute data" path (founder: the data is the user's).
- **Network download of the pack.** It is a local archive only, like the pipeline pack.
- **Open-ended "find anything" detection with Qwen.** The cloud `detect-v2` flow stays for that.
- **Mac (founder: no Mac in the first version).** On a Mac the feature shows "Not available on this computer yet". Apple Silicon follows as its own step (see Later).
- **AMD/Intel GPUs on Windows, and Linux.**

## Anti-goals (a failure even if it technically works)

- **Useful only at a very low threshold, or not accurate enough** (founder). The quality bar and the live hit rate exist so this is visible, not guessed.
- **Silent failure.** A run that reports nothing because of a parse or coordinate error must say it failed, not "no defects found".
- **Freezing the app.** Inference runs in a child process; the Electron main thread only coordinates.
- **Leaving GPU memory taken after a run.** The server stops as soon as the last detector run ends, and when the app quits (founder, 21 Oct: the 3D view and processing need the graphics card back).
- **A prompt edit that makes a detector worse on the user's own past reviews** replacing the old version without warning.
- **Client photos leaving the machine.** Sample photos inside an exported `.aiodet` are opt-out, with a warning.

## Constraints

- Repo rules in `CLAUDE.md` and `CONTRIBUTING.md`: own worktree, `pnpm check` green, e2e the CI way, no client or site names in public text, tests, fixtures or commits.
- **This reverses M8 decision 1** (`docs/plans/2026-10-06-m8-change-modelling.md`: "Nothing is bundled: no `llama-server` sidecar, no GGUF download"), for the Analytics pack only. The founder decided this on 2026-10-17. The person's own Ollama / LM Studio route (`packages/ai/src/local.ts`) stays as it is. Record the reversal in that plan and in `contract-changes.md`.
- **UI placement** (UI rework session, stage-island, 2026-10-17). The source of truth is `docs/superpowers/specs/2026-10-16-ui-foundation-design.md` (parts, tokens, surfaces, button sizes, type steps) and `docs/superpowers/specs/2026-10-16-stage-island-design.md` (workbench, tabs, following rules, island live line).
  - **Surfaces:**
    - Nothing in this feature touches workbench or island files. The Detections screen, Settings and `packages/ai` may merge before stages 2 and 3 land.
    - A run is a normal job registered in `renderer/jobs.ts` and `processing/pipelines.ts`. The Jobs workbench and the island live line pick it up with no edits there.
    - Starting a job does not open the sidebar or drawer (I-R39).
    - The Detections screen will be redesigned in UI project 4 (data screens, not designed yet), so review additions are self-contained components that can move cleanly.
  - **Parts:**
    - Use the `@aio/ui` parts: Button/IconButton (`disabledReason`), Tip, Popover, Menu, Tabs, Chip (for toggles and segmented choices), Row, EmptyState, ResizableSplit, the RemoveDialog pattern for dialogs, and `actions` for commands.
    - Not in `@aio/ui`: slider, progress row, card, and photo grid with boxes. Reuse the desktop code: the progress row from `workspace/workbench/benches/JobsBench.tsx`; the photo grid and boxes from `detections/ContactSheet.tsx` and `Editor.tsx`. Build the slider in the feature folder against the tokens.
    - "Space, not cards, to group": Settings groups are sections, not boxed cards.
  - **Rules:**
    - No DOM `title=` (use Tip).
    - Tokens only (`--sp-*`, `--z-*`, `--el-*`); the packages/ui CSS guard fails otherwise.
    - Logical CSS properties (RTL is tested).
    - en.ts strings go in one commented block under `detect.preset.*`, in sentence case.
    - Job titles are an -ing phrase saying what is happening: "Finding corrosion in 240 photos".
- **Pipeline pack budget:** 1.3 GB unpacked and 500 MB archived (`tools/release/budgets.mjs`). The Analytics pack is separate and has its own budget. It is about 6.5 GB, above the current installer's 6 GB unpack cap, so it needs its own limit.
- **Licences:** Qwen2.5-VL-7B-Instruct is Apache-2.0 and llama.cpp is MIT. Both pass `inference/licence.ts` and need entries in the generated third-party notices.

## How it works

### 1. The Analytics pack

- **Contents:**
  - `llama-server` from llama.cpp, a pinned CUDA release for win-x64 (the only v1 platform).
  - The Qwen2.5-VL-7B-Instruct GGUF (Q4_K_M) and its vision projector (`mmproj`) file.
  - The shipped detector sets.
  - `manifest.json`.
- **Manifest:** schema `aio.analytics-pack/1`: version, appRange, platform, runtime version, model id with sha256, and the `files` list with size and sha256 of each file. It mirrors `aio.pipeline-pack/1` (`packages/schema/src/jobs.ts`).
- **Build:** `tools/analytics-pack/build.mjs` downloads pinned URLs with size and sha256 (as `tools/pipeline-pack/sam.mjs` does), writes the manifest and tars the result. It runs in its own CI workflow, started by hand. The pack is too large for every release, and it only changes when the runtime, model or shipped detectors change.
- **Install:** reuse the `packInstall.ts` machinery with a pack kind parameter:
  - It searches for archives beside the exe, in Downloads and in `<data>/runtime`.
  - It reads the manifest without unpacking, unpacks to a temp folder and checks the platform, the appRange and every file's sha256.
  - It renames the result into `<data>/runtime/analytics-pack-<ver>/`, with its own size limit.
  - Settings shows a card for it, next to the pipeline pack card, with install, version and remove.
- **Coexistence:** the Analytics pack does not depend on the pipeline pack version and vice versa. Feature minimums use the same `packNeeds` mechanism.

### 2. Hardware check

- **Windows / NVIDIA:** read total and free VRAM through NVML (`nvml.dll`) or by parsing `nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits`. The app has no real VRAM figure today (`ProbeGpu.vramBytes` is never filled in), so this is new code.
- **Mac:** always "Not available on this computer yet" in v1.
- **Minimums (my call, to confirm with the founder):** NVIDIA with 8 GB VRAM total and at least 6.5 GB free at start.
- **Below the minimum,** Settings and the run dialog show the reason: "This computer has 4 GB of GPU memory; detectors need 8 GB." The run button stays disabled.
- **At start,** a detector job waits behind AIO's own GPU jobs (photo processing, local ONNX detection, SAM, other detector runs) rather than failing, and no detector run starts while one of them is running (founder, 21 Oct). If free VRAM is still too low once it starts, because another program is using the GPU, the job fails with that reason rather than spilling to the CPU.
- **Before a run (founder, 21 Oct),** the run dialog reads free VRAM. When it is under the minimum it says how much is free, that detectors need about 6.5 GB, and to close the 3D view or other programs that use the graphics card.

### 3. The model server

- **Ownership:** main starts `llama-server` as a child process, bound to `127.0.0.1` on a random free port, with `--model`, `--mmproj`, `--ctx-size 8192`, `-ngl 99`, `--parallel 1` and no web UI. It follows the ODM `killTree` / inference utility-host patterns, and its health is checked through `/health` before the first request.
- **Lifetime:** it starts on the first detector run. It stops as soon as no detector job is running or waiting (founder, 21 Oct: no idle hold, the next run pays a 10 to 20 s load), when the user removes the pack, and at app quit (`shutdownSync`). One server at a time serves one job queue.
- **API:** the OpenAI-compatible `/v1/chat/completions`, with an image as a data URL, `temperature: 0`, and `logprobs: true, top_logprobs: 10` for the crop check.
- **Verify first (risk):**
  - The spike used Ollama. The first build task repeats the spike's corrosion run through `llama-server` and confirms three things: boxes come back in the same pixel frame of the sent image (sizes a multiple of 28); `logprobs` / `top_logprobs` are returned for the first token; and the scores match Ollama's to within about ±0.05.
  - If `llama-server` falls short, the fallback is to bundle Ollama's binary instead. It is MIT-licensed and runs on its own port with its own models dir.

### 4. The detector recipe (the engine)

The engine is a TypeScript module in `packages/ai` (`detectors/engine.ts`), tested with a fake server. Steps for each photo and each detector:

1. **Tiles.** Split the source photo into an `n × n` grid with overlap. Defaults are `n = 2` and 20 % overlap; each detector can set them. Resize each tile to the send size (default 1344 × 1008, multiples of 28) so the model's pixel frame equals ours.
2. **Detect.** For each tile, send the image, then the detector's prompt: the "looks like" and "ignore" text inside a fixed template asking for `[{"bbox_2d":[x1,y1,x2,y2],"label":"<class>","note":"…"}]` or `[]`. Map the boxes back to source pixels. Drop boxes smaller than 8 px.
3. **Merge.** Sort by area, largest first. Drop a box whose intersection with a kept box is at least 60 % of the smaller one.
4. **Check.** For each box, crop it with 15 % padding, fit it within 896 px, and send it with the detector's yes/no question. The score is P(yes) / (P(yes) + P(no)), summing each over the case variants among the top logprobs. If the reply holds neither token, the score is 0 and the draft is flagged `unscored`.
5. **Reference examples (optional).** If the detector carries example crops (§7), send up to 2 accepted and 2 rejected examples with the check, labelled "is" and "is not". This costs more time, so the detector chooses.
6. **Output.** Every candidate is kept with its score. Drafts below the run's threshold are stored with `belowThreshold: true` and hidden in the review by default, so a reviewer can lower the threshold afterwards without running again.

**Speed:** put the image before the text in each request, so `llama-server`'s prompt cache can reuse the image tokens when several detectors run on the same tile. The builder measures whether this pays.

**Failures:**

- A reply that cannot be parsed for a tile is retried once, then recorded as a per-photo warning.
- A photo where every tile failed is counted as failed, not "no detections".
- The job summary reports photos done, failed and skipped.

### 5. Detector file (`aio.vlm-detector/1`, `.aiodet`)

A detector is `detector.json`, plus optional `samples/` (sample photos and their test result) and `examples/` (reference crops). A `.aiodet` file is a zip of that folder.

Fields:

- `id` (slug) and `name`
- `version` (integer, raised on each save)
- `classId`, mapped to the project's class catalogue: if the class is missing, the run offers to add it, as the `new:` class flow does today
- `assetTypes` (list)
- `looksLike` and `ignore` (text)
- `question` (the yes/no check; the default is generated from `looksLike` and `ignore`)
- `tiles` (`{ n, overlap, sendW, sendH }`)
- `threshold` (default)
- `tunedOn` (`{ model, modelSha256 }`)
- `author`, `createdAt`, `updatedAt`
- `source`: `shipped`, `user` or `imported`
- `status`: `verified` (passed the bar in §9) or `experimental`

Stored in:

- **Shipped:** `<analytics-pack>/detectors/<assetType>/<id>/`, read-only. Copying one makes a user detector.
- **Project:** `<project>/detectors/<id>/`. It travels with `.aio` packages and `.aiosync` exchange.
- **Library:** `<userData>/detectors/<id>/`.

Rules:

- **Different model:** if `tunedOn.modelSha256` differs from the installed model, the run dialog warns but does not block.
- **Import:** importing a detector whose id already exists with a different version offers update or keep both.
- **Samples on export:** included by default, with a "leave out sample photos (client-confidential)" checkbox on export. The checkbox also leaves out the `examples/` crops (my call).

### 6. Running and reviewing

- **Run dialog:**
  - A modal (`.surface-dlg`). It extends the existing `detections/AiDetectDialog.tsx` / `LocalDetect.tsx` with a third choice, "Detectors (on this computer)", rather than a new dialog.
  - It opens from the Detections screen and is registered as a command in the `actions` registry, so the palette finds it. It is not in the island.
  - Contents:
    - The selected photos (or a whole date or flight).
    - The detectors, picked with Chip toggles: the project's asset type first, then "All detectors" (shipped, project, library).
    - The threshold, set per detector from its default (or its suggested value, §7).
    - A time estimate from the photo count × detectors × a measured seconds-per-photo.
    - Start.
  - When the pack is missing or the hardware check fails, Start is disabled with a `disabledReason`.
- **Job:**
  - A normal job titled "Finding corrosion in 240 photos" (several detectors: "Running 3 detectors on 240 photos").
  - It shows in the Jobs workbench with progress ("photo 34 of 210, corrosion") and Cancel. The island live line shows it automatically.
  - Cancel keeps the photos already done. "Run the remaining" is an action on the job's own detail, as the local ONNX detection does.
- **Results:** one `aio.detections/1` pass per run: `detections/vlm-<runId>.json` with `source: 'model'`, or a new `'detector'` source — the builder decides, and it is a contract change either way.
  - Each draft carries `confidence` (the score), `bbox` in source pixels, `note`, and `belowThreshold` where it applies.
  - The origin carries `{ detectorId, detectorVersion, model, modelSha256, threshold, runId }`.
- **Review:** the existing Detections review, in its components (`detections/Inspector.tsx`, `ContactSheet.tsx`, `BatchConfirm.tsx`). The additions are three self-contained components, so they move when UI project 4 redesigns the screen:
  - **`ScoreBadge`:** the score on each draft.
  - **`ThresholdSlider`:** per pass; shows or hides `belowThreshold` drafts.
  - **`RejectReasonMenu`:** a Menu, offered on reject, optional, one click. Reasons: `looks-like-but-is-not` (with free text, such as "painted band"), `not-a-defect`, `wrong-class`, `box-wrong`, `other`.
- **Settings:** grouped sections in the existing Settings screen, not boxed cards:
  - **Analytics pack:** install, version, remove.
  - **Hardware check** and its message.
  - **Detector library:** shipped, library and project detectors, each with its hit rate, plus import, export, clear ledger and open in the builder.

### 7. Learning from reviews (local only)

**Ledger.** Each accept, reject or box edit on a detector draft appends one line to `<userData>/detectors/ledger/<detectorId>.jsonl`, with a crop of at most 512 px saved beside it. A line holds:

- the detector version and model sha
- the score, verdict and reason
- the original box and the corrected box
- a project-relative photo reference
- the time

Findings that a person draws by hand on a photo where a detector ran, for that detector's class, are logged as **misses**.

The ledger is in user data, so it covers every project. Deleting a project does not delete it. Settings has a clear-ledger action per detector.

Uses:

1. **Suggested threshold.** With at least 20 reviewed drafts, suggest the threshold that maximises F1 on the ledger (my call). The suggestion is shown, never applied silently.
2. **Prompt suggestions.** Group reject reasons. When one reason passes a share of rejects (for example 30 %), suggest adding it to `ignore`. The user edits and saves the change.
3. **Check before replacing.** Re-score the ledger crops with the edited detector's check step. Report how many past accepts still pass, how many past rejects are now cut, and the missed count. If the new version is worse on either the accepts or the rejects, the save warns and keeps both versions.
4. **Reference examples.** "Use as example" on any reviewed draft adds its crop to the detector's `examples/`.
5. **Dataset export.** "Export training data" in a project writes the accepted detector drafts and the person's own findings on those photos, as a YOLO (txt + yaml) or COCO (json) folder of the source photos. This is for the later training project, and it is useful on its own in the meantime.

### 8. Custom detector flow

This is a **full-screen sub-view of the Detections screen** (stage-island's call). A workbench Section at 360 px is too narrow for a photo grid with boxes, and a modal doesn't suit a multi-step flow with a test loop where the person wants to look at photos. Its steps show as a step header: template → describe → samples → test → save. The test grid reuses `ContactSheet` / `Editor` box drawing.

1. **Start from:** a built-in example template (corrosion on metal, crack in concrete, missing or loose part), a copy of a shipped or library detector, or blank.
2. **Name and class:** pick or create the project class.
3. **Looks like and ignore,** with examples of good wording shown alongside. The guidance is a short "how to write a detector" page: describe colour, texture and where it appears; always list the look-alikes to ignore; one defect per detector.
4. **Sample photos:** 3–5 from the project.
5. **Test:** run on the samples and show boxes and scores, with a threshold slider. If the samples have been reviewed, show hits and misses against them.
6. **Adjust and test again.**
7. **Save to** this project, my library, or export `.aiodet`.

### 9. Shipped detector sets and the quality bar

**v1 sets (founder, 2026-10-17):** chimney stack, flare stack, building facade and roads. They are built from the founder's own reference projects in the app's data root. Those projects are client data: they stay outside the repo, and no project name appears in public text.

| Set             | Reference project (data root) | Ground truth available                                                                                                                           | Candidate detectors                                                                            |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Building facade | facade project: 2,364 photos  | 656 reviewed findings, 1,476 photo boxes                                                                                                         | staining, soiling, cladding damage, sealant failure, corrosion                                 |
| Roads           | road project: close-up photos | 2,115 reviewed polygons on photos                                                                                                                | longitudinal, transverse, block and alligator cracking, bleeding, raveling, patching, potholes |
| Flare stack     | flare project: 598 photos     | 78 reviewed rust boxes (plus masks); reviewer notes already state the look-alikes (heat-affected tip is uncertain, yellow safety paint excluded) | corrosion on steel and fasteners, heat damage on the tip                                       |
| Chimney stack   | chimney project: 840 photos   | 10 reviewed findings plus a reviewed cloud AI run, too few to benchmark                                                                          | corrosion on metal, cladding/insulation damage, concrete cracking and spalling                 |

Process per set, using the dev harness in `tools/detectors/` (Merge 1):

1. **Split each project's reviewed photos:** a tuning part (about 30 %) to write and adjust the prompts on, and a held-out benchmark part the prompts never see. That way the bar measures the detector, not how well it was fitted to its examples.
2. **Measure recall** against the reviewed findings on the benchmark part. For roads, a detector box counts as a hit if it covers the reviewed polygon's centre.
3. **Measure false alarms** by a person reviewing the detector's drafts on about 50 benchmark photos. Past reviews were not exhaustive (a reviewer may not have marked every stain), so a draft with no matching finding is not automatically false.
4. **Chimney first gets a benchmark:** run the candidate detectors on about 50 photos, a person reviews every draft and adds what was missed, and that becomes the set.

**Bar (my call, founder to confirm):** at the default threshold, at least 70 % of the reviewed findings of that class are found, with an average of at most 1 false draft per photo. A detector under the bar ships labelled **Experimental**, which is shown in the run dialog and Settings and stored as `status: 'experimental' | 'verified'` in `aio.vlm-detector/1`, or is left out.

**Risk:** fine road cracks may be too small at tile scale for a 7B model. The road benchmark decides whether road detectors need a 3 × 3 grid, or ship as Experimental.

- **Live hit rate:** each detector shows it in Settings, computed from the ledger: accepted / (accepted + rejected) and misses.

## Testing

- **Engine unit tests** with a fake server, covering:
  - tile layout and mapping back to source coordinates
  - the merge rule
  - score computation from logprobs (case variants, missing tokens)
  - the failure paths (unparseable reply, every tile failed) that must not read as "no detections"
- **Pack tests:** manifest schema, the install checks (bad sha, wrong platform, appRange), and the size limit, reusing the `packInstall` tests.
- **Server lifecycle tests:** start, health, stop when the last run ends, kill on quit, and the port in use.
- **Hardware check tests:** parsing `nvidia-smi` output and the minimum messages.
- **Detector file tests:** schema, `.aiodet` zip round trip, the import conflict choice, and the model-mismatch warning.
- **Ledger tests:** threshold suggestion, the check-before-replacing comparison, and dataset export format.
- **e2e:** run a detector with a fake OpenAI-compatible server on the synthetic change demo (as `agent-local.spec.ts` does). Drafts appear with scores and the threshold slider hides and shows them. It does not need a GPU or the real model.
- **Manual acceptance on real hardware:** the spike's 8-photo corrosion run repeated through the pack on Windows / NVIDIA, with the scores within ±0.05 of the spike.

## Delivery (my call)

1. **Merge 1, no UI:**
   - the `llama-server` verification (§3)
   - pack schema, build script and install
   - hardware check
   - server lifecycle
   - engine
   - detector schema and storage
   - an IPC `detectors:run` that writes a pass
   - the ledger and review additions in the model layer
     It can be tested end to end from the IPC.
2. **Merge 2, the run and review UI.** It touches only the Detections screen, Settings, `renderer/jobs.ts` and `processing/pipelines.ts`, so it can merge before stages 2 and 3 of the UI rework (stage-island confirmed). It still takes its turn in the merge lock.
   - the run dialog and the job registration
   - the review components (scores, slider, reject reason)
   - the Settings sections (pack, hardware, detector library, hit rates)
3. **Merge 3:** the custom detector flow, `.aiodet` import and export, the learning features (suggestions, check before replacing, examples) and dataset export.
4. **Content track, in parallel from Merge 1 onwards:** the four v1 sets (§9), tuned and benchmarked with the `tools/detectors/` harness, which runs a detector over a reference project's photos and reports recall, false drafts and a contact sheet. Facade and flare go first, since their ground truth is ready. Chimney waits for its benchmark labelling. Detectors land in the pack build as they pass, or as Experimental.

## Later

- In-app training of the user's own YOLO model from the ledger and the dataset export (founder: once the app is nearly complete). Note the PRD BLD-10 scope and the Ultralytics AGPL point when that starts.
- Apple Silicon: a darwin-arm64 pack with a Metal `llama-server`, signed and notarised. Unpacked executables must pass Gatekeeper. The memory check must use what Metal can actually use, not `os.totalmem()`. It needs testing on a real Mac.
- Telecom detector set.
- A larger Qwen model for 24 GB+ GPUs, as a second model in the pack.
- An optional offline agent model, as a separate decision.

## Left to the builder

- `source: 'model'` with a detector origin, or a new `'detector'` source, and the contract-changes row.
- How a detector's `classId` maps when the project's catalogue uses a different id for the same thing.
- Whether reject reasons live on the detection (in the pass) or only in the ledger.
- Exact NVML or `nvidia-smi` approach and the free-VRAM margin.
- Whether the prompt cache across detectors (§4) pays for its complexity.
- The CI workflow shape for the pack build and where the archive is kept between releases.
