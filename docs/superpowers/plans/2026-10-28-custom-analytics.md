# Custom Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An inspector types a request in plain words in Inspect, shapes the fields that come back, runs it on this PC (Qwen3.5-9B in the Analytics pack) or in the cloud (Claude, OpenAI), reviews dashed suggestions with their fields, and accepted items become issues whose fields reach the report; requests are saved and reused, a photo can be asked about with follow-ups, and two dates of the same spot can be compared.

**Architecture:** Custom requests extend Ask AI, not a new path. One new IPC call, `ai:ask`, carries one request (one image, or two for a date pair) to either the Analytics pack's `llama-server` (new `main/analytics/ask.ts`, through the existing `VlmServer`) or a cloud provider (new `AgentRuntime.ask` in `@aio/ai`, behind the same gates as `ai:detect`). Prompts, the reply parser (with the `}}` repair), the box guards and the routing table are pure code in `@aio/ai` (`ask.ts`), ported from the 27 Oct bench scripts. Answers become draft detections in the existing review (`ai-<run>.json` passes), so the dashed look, Accept, Change and Dismiss are reused; fields ride on detections and issues as a typed extension and the two existing reports print them.

**Tech Stack:** TypeScript (Electron main, React renderer, zustand), zod contracts in `@aio/schema`, AI SDK 7 (`ai`, `@ai-sdk/anthropic` 4.0.71, `@ai-sdk/openai` 4.0.83), llama.cpp b11489 `llama-server`, Python 3.13 detector engine, Vitest, Playwright with Electron, pytest.

**Spec:** `docs/superpowers/specs/2026-10-27-custom-analytics-design.md` (frame context: `docs/superpowers/specs/2026-10-26-analysis-structure-design.md`, which this plan does not build).

## Calls made in planning

The founder delegated every remaining decision. These are the calls this plan makes; each task follows them.

1. **Three request kinds:** `find` (boxes, optionally with fields: covers "find all gauges" and "read all gauges"), `change` (two dates, boxes on the newer image) and `ask` (a text answer with follow-ups). A "read" is a find with fields.
2. **Routing** (`routeAsk`, Task 4), with the cloud usable: `change` and `ask` go to Claude Sonnet 5.5; a find over all photos goes to Claude Haiku 5.5 (bulk); a find on this photo or a selection goes to this PC when the Analytics pack can run, else Haiku. With no Anthropic key but an OpenAI key, Sonnet maps to `gpt-6.1-sol` and Haiku to `gpt-6-luna`. With the cloud not usable everything runs on this PC, and `change` and `ask` show "weaker on this PC". The inspector can override per run (On this PC, Haiku, Sonnet, Opus "best quality", GPT-6.1 sol, GPT-6 luna). Google is not offered for custom requests.
3. **Severity is never asked of the model.** Drafts carry the saved request's default class and severity, else none; Accept fills a missing class or severity from the project's last choice, as today.
4. **Change requests get two built-in fields** prepended to the request's own: `change_type` (choice: new, removed, moved, progress, damage) and `what` (text), as the bench prompt asked. The item's label is `what`.
5. **Fields are typed values on detections and issues** (`FieldValue`: key, label, type, value, unit), a contract change. Types tonight: number (with unit), text, yes/no/unknown, choice.
6. **Images:** the renderer prepares every image (as Ask AI does). Cloud: long edge at most 1568 px. This PC: long edge at most 1344 px (the bench's send size). `ai:ask` images carry their sent pixel size; items come back normalised 0 to 1 of the last image.
7. **Box frames by model:** Qwen3 family (Qwen3.5, Qwen3-VL) answers `bbox_2d` in 0 to 1000; Qwen2.5-VL in sent pixels; cloud models are asked for integer pixels of the image as sent (prompt says its size). One table in main (`localVlmModel`, Task 10) maps the pack's model id to its family, server arguments and VRAM floor.
8. **Guards** (Task 4): repair `}}` and cut-off lists, keep the items before a cut with a warning; merge boxes that share at least 60 % of the smaller one (the engine's `MERGE_SHARE`); keep at most 30 items per image (the bench's `MAX_BOXES`) and say how many were dropped; drop boxes covering at least 90 % of the image unless the request asks for the whole image; drop boxes under 3 sent pixels; retry a reply that cannot be read once, then fail with the model's words.
9. **Thinking:** Qwen3.5 runs with `--reasoning off` and `chat_template_kwargs.enable_thinking: false`. Claude: `effort: 'low'` (Opus on a change request: `'medium'`), no temperature, no top_p, no prefill; `finishReason` checked (`length` keeps what was read with a warning, a refusal is an error). OpenAI: `reasoningEffort: 'low'`.
10. **Keep this project's images on this PC** is the existing `aiPolicy: 'forbid'`. The manifest schema gains an optional `aiPolicy` so the app's own manifest saves stop stripping it (today any save drops a hand-written top-level `aiPolicy`). The switch sits in Settings, Privacy and cloud, under "This project". Main reads the policy from disk on every request, so a switch flipped mid-run stops the next request.
11. **Cloud confirm:** every cloud run shows today's `CloudConfirm` (and honours the project's existing "Don't ask again"). A thread confirms on its first question; its follow-ups resend the same image without a second confirm.
12. **Saved use cases** are `aio.ai-request/1` JSON files: `<project>/requests/<id>.json` (travels with the project) and `<userData>/requests/<id>.json` (this computer's library). Shared as a single `.aioreq` JSON file (Export, Import). Not inside `.aiodet` tonight: a request has no sample images, so it needs no archive, and the detector archive code stays untouched (merging the two kinds is follow-up F7).
13. **Threads** live in memory per photo for the session. "Make a finding" turns an answer into a whole-image draft whose note is the answer, accepted through the normal flow.
14. **Two dates** start from spot history (`useSpotHistory`): the panel lists the other survey dates whose best match is a photo; Image 1 is the older date, Image 2 the newer; the drafts land on Image 2's photo.
15. **The 4B fallback is cut** (follow-up F1). Tonight the Qwen3.5-9B needs 7400 MB free (the bench's 6.8 GB peak plus margin); a card with less free memory gets today's "card is busy" answer naming the cloud, and the model table already holds the Qwen3-VL-4B entry for F1.
16. **The detector engine reads both box frames**, chosen from the run's `model` param (already sent by the gate). Every `detect.vlm` run then needs the new pipeline pack: `DETECT_MIN_PACK` becomes that pack's number, so an old engine never misreads 0 to 1000 boxes as pixels.
17. **Analytics pack 0.2.0** (number from the merge coordinator) swaps Qwen2.5-VL-7B for Qwen3.5-9B Q4_K_M. Its `appRange` floor is this app's version (`apps/desktop/package.json`, 0.27.0 at planning). No app code names analytics pack 0.1.0 (checked: no minimum-pack check exists for it). The founder installs both new packs from Settings, Processing tools, Choose file.
18. **Cloud AI is on by default for new installs** (founder, 27 Oct: "cloud should be on by default and customer can turn it off if they want"; Task 19). Only a first start with no `settings.json` gets `cloudAi: true`. An existing install keeps its saved value; a `settings.json` that exists but has no valid `cloudAi` stays off (an upgrade never turns the cloud on by itself). The renderer's pre-load placeholder stays off until main's settings arrive. Offline-only, the project's keep-local switch, the key and the per-run confirm still apply, so nothing is sent without a key and a yes.
19. **One local ask at a time,** never beside a GPU photo job: a local ask while a detector run or a GPU job is at work answers "busy"; a photo job may not start while a local ask holds the card (same rule as detector runs).
20. **Strings:** the new UI strings go in five new catalogue files spread into `en` (Task 1), one per UI task, so parallel tasks never edit `en.ts`.

## Global Constraints

- Work only in `E:\Dev\AIO Software\.claude\worktrees\custom-analytics` on `feat/custom-analytics`. Never edit the main checkout. Never junction or symlink the main venv into the worktree; after any Python tooling run, check `python -c "import aio_pipelines; print(aio_pipelines.__file__)"` with the main venv still points at `E:\Dev\AIO Software\python\src`.
- Parallel agents share this one worktree on disjoint files: each stages only its own paths and commits with `git commit -F <msg> -- <paths>`; one heavy run (checks, e2e, GPU) at a time. Keep any `.superpowers/` workspace outside the worktree (it fails `pnpm format:check`).
- TypeScript strict, no `any`, no non-null assertions. Renderer never imports `electron` or `node:*`. New environment variables are `QUADRION_*`.
- No em or en dashes in user-facing text. No client, site or person names anywhere (code, docs, commit messages, test data). Run `node tools/agent/check-public-text.mjs <files>` on every doc touched.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every `@aio/schema` change has a row in `docs/architecture/contract-changes.md` (Task 1 writes them; Task 3 writes the pack row).
- Model ids exactly: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `gpt-6.1-sol`, `gpt-6-luna`; local `qwen3.5-9b-q4_k_m`.
- Analytics pack version `0.2.0` (coordinator, 29 Oct). Pipeline pack `0.27.0` for the engine change (Task 2, Task 10; coordinator, 29 Oct): `python/pyproject.toml`, `uv.lock` and the `__init__.py` history note.
- e2e never needs a GPU or a cloud key: cloud through the scripted provider (`QUADRION_AI_TEST_PROVIDER=1` with an isolated profile and `QUADRION_TEST_VAULT=1`), this PC through `fake-llm.ts` (`QUADRION_VLM_SERVER_URL`). Python for e2e from a worktree: a scratch venv with a `.pth` putting this worktree's `python/src` first (reference: the branch changes `python/`), passed as `QUADRION_E2E_PYTHON`.
- Pytest from the worktree: main venv read-only, `PYTHONPATH=python/src;python/tests`, `PYTHONDONTWRITEBYTECODE=1`.
- UI tasks load the `impeccable` and `frontend-design` skills first.

## Review Focus

1. **A project switched to "keep on this PC" while a cloud run or thread is open.** Expect the next request to be refused in main with the project's reason, the run to stop with its items left, and nothing sent. Test in Task 12 (`ask refuses a cloud request once the project forbids it, read from disk per request`).
2. **Field values in the wrong shape** ("4,2 bar", "Yes.", a choice not offered, a number as text, a missing key). Expect a coerced value or `null` with a warning, never a dropped item or a crash. Test in Task 4 (`coerceField` cases).
3. **A dataset run stopped or failing half way** (300 photos, the local server dies, a provider 529). Expect the drafts already made to stay, the strip to say stopped or failed with the items left, and Try again to send only those. Test in Task 13 (`a custom run that fails on item 3 keeps items 1 and 2 and lists the rest`).
4. **Compare dates on a photo with no position or no other date.** Expect the date list to be empty with the reason, and Run off. Test in Task 16 (`compare dates says why when spot history has no other date`).
5. **Only an OpenAI key, or no key and no pack.** Expect OpenAI equivalents in the first case; in the second, Run off with the reason and a way to Settings. Tests in Task 4 (routing table) and Task 16 (`nothing can run`).

---

## File map

| Area                | Files (C = create, M = modify)                                                                                                                                                                                                                                                                                                                                      | Task |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Contracts           | C `packages/schema/src/aiRequest.ts`, `aiRequest.test.ts`; M `annotation.ts`, `detections.ts`, `manifest.ts`, `ipc.ts`, `index.ts`; M `apps/desktop/src/preload/index.ts`; C `packages/ui/src/i18n/enAskRun.ts`, `enAskPanel.ts`, `enAskFields.ts`, `enAskSettings.ts`, `enAskReport.ts`; M `packages/ui/src/i18n/en.ts`; M `docs/architecture/contract-changes.md` | 1    |
| Detector engine     | M `python/src/aio_pipelines/detect/engine.py`, `pipeline.py`, `python/tests/test_detect_engine.py`, `test_detect_pipeline.py`, `tools/detectors/bench.py`, `test_bench.py`, `README.md`, `python/pyproject.toml`                                                                                                                                                    | 2    |
| Pack pins           | M `tools/analytics-pack/lock.json`, `README.md`, `package.json`, `build.mjs`, `build.test.mjs`, `smoke.py`, `test_smoke.py`; M `docs/architecture/contract-changes.md` (after Task 1)                                                                                                                                                                               | 3    |
| Ask core            | C `packages/ai/src/ask.ts`, `ask.test.ts`; M `packages/ai/src/index.ts`, `pricing.ts`, `pricing.test.ts`, `packages/ai/README.md`                                                                                                                                                                                                                                   | 4    |
| Review fields       | M `packages/annotate/src/detections/model.ts`, `accept.ts`, `review.ts`, `packages/annotate/src/model/editor.ts` and their tests                                                                                                                                                                                                                                    | 5    |
| Policy handler      | M `apps/desktop/src/main/evidencePolicy.ts`, `evidencePolicy.test.ts`                                                                                                                                                                                                                                                                                               | 6    |
| Policy switch       | M `apps/desktop/src/renderer/screens/Settings.tsx`; C `screens/settings/ProjectPrivacy.tsx`, `ProjectPrivacy.test.tsx`; M `enAskSettings.ts`                                                                                                                                                                                                                        | 7    |
| Saved requests      | C `apps/desktop/src/main/analytics/requests.ts`, `requests.test.ts`, `requestsIpc.ts`, `requestsIpc.test.ts`                                                                                                                                                                                                                                                        | 8    |
| Report fields       | M `packages/project/src/export/report.ts` (+ test), `apps/desktop/src/renderer/reportPage/layout.ts` (+ test), `reportPage/house/sections.ts` (+ test), `report.css`, `house/house.css`; M `enAskReport.ts`                                                                                                                                                         | 9    |
| Local model table   | C `apps/desktop/src/main/analytics/models.ts`, `models.test.ts`; M `server.ts`, `server.test.ts`, `hardware.ts`, `hardware.test.ts`, `gate.ts`, `gate.test.ts`, `detectPack.ts`, `apps/desktop/src/main/index.ts` (hardware wiring line only)                                                                                                                       | 10   |
| Local ask           | C `apps/desktop/src/main/analytics/ask.ts`, `ask.test.ts`                                                                                                                                                                                                                                                                                                           | 11   |
| Cloud ask           | C `packages/ai/src/askRun.ts`, `askRun.test.ts`; M `packages/ai/src/main.ts`, `scripted.ts`, `main.test.ts`                                                                                                                                                                                                                                                         | 12   |
| Renderer runs       | C `apps/desktop/src/renderer/inspect/askAi/custom.ts`, `custom.test.ts`, `thread.ts`, `thread.test.ts`; M `runs.ts`, `runs.test.ts`, `backend.ts`, `detections/prepare.ts`; M `enAskRun.ts`                                                                                                                                                                         | 13   |
| Fields UI           | C `apps/desktop/src/renderer/inspect/FieldsForm.tsx`, `FieldsForm.test.tsx`, `fields.css`; M `inspect/FindingsPanel.tsx`, `ChangePicker.tsx`, `ReviewQueue.tsx`, `renderer/issueCard/IssueCard.tsx` and tests; M `enAskFields.ts`                                                                                                                                   | 14   |
| Main wiring         | M `apps/desktop/src/main/index.ts`, `analytics/gate.ts`, `gate.test.ts`                                                                                                                                                                                                                                                                                             | 15   |
| Ask panel           | C `inspect/askAi/AskPanel.tsx`, `AskPanel.test.tsx`, `RequestEditor.tsx`, `FieldsEditor.tsx`, `FieldsEditor.test.tsx`, `ThreadView.tsx`, `ThreadView.test.tsx`, `DatePairPicker.tsx`, `askPanel.css`; M `AskAiBar.tsx`, `AskAiBar.test.tsx`, `screens/Inspect.tsx`; M `enAskPanel.ts`                                                                               | 16   |
| e2e                 | C `apps/desktop/e2e/custom-analytics.spec.ts`; M `apps/desktop/e2e/fake-llm.ts`                                                                                                                                                                                                                                                                                     | 17   |
| GPU night task      | M `tools/analytics-pack/detectors/plant/corrosion-metal/detector.json` (only on a go), `tools/analytics-pack/README.md`                                                                                                                                                                                                                                             | 18   |
| Cloud on by default | M `apps/desktop/src/main/settings.ts`, `settings.test.ts`; M `apps/desktop/e2e/smoke.spec.ts`, `agent-local.spec.ts`, `detections.spec.ts`, `offline-cloud-ai.spec.ts`                                                                                                                                                                                              | 19   |

## Execution DAG

```
Batch 1:  T1 contracts ─────────────┐     T2 engine (python)     T3 pack pins
                                    │          │                      │
Batch 2:  T4 ask core   T5 review fields   T6 policy handler   T7 policy switch   T8 saved requests   T9 report fields   T10 model table (needs T2's pack number)   T19 cloud on by default
             │   │          │                                                          │                      │
Batch 3:  T11 local ask (T4,T10)   T12 cloud ask (T4)   T13 renderer runs (T4,T5)   T14 fields UI (T5)
             │                        │                    │
Batch 4:  T15 main wiring (T8,T10,T11,T12)            T16 ask panel (T13,T14)
             │                                            │
Batch 5:  T17 e2e (all)
Batch 6:  T18 GPU night task (T2,T3; optional, cuttable)
```

| Batch | Tasks (run at once, disjoint files) | Depends on                                                                                              |
| ----- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1     | T1, T2, T3                          | none (T3's contract row is written after T1 commits, last step of T3)                                   |
| 2     | T4, T5, T6, T7, T8, T9, T10, T19    | T1; T10 also needs the pipeline pack number; T19 needs nothing (its files are touched by no other task) |
| 3     | T11, T12, T13, T14                  | T11: T4, T10. T12: T4. T13: T4, T5. T14: T5                                                             |
| 4     | T15, T16                            | T15: T8, T10, T11, T12. T16: T13, T14                                                                   |
| 5     | T17                                 | all of 1 to 4                                                                                           |
| 6     | T18                                 | T2, T3 (GPU, real data read-only, timeboxed)                                                            |

**Critical path:** T1, T4, T13, T16, T17 (five batches). T4 and T13 are the longest tasks; start them first in their batches.

**What each batch delivers on its own:** after 1, detectors read Qwen3 boxes and the `}}` bug no longer loses answers silently; after 2, "Keep this project's images on this PC" works end to end (the handler registers through the existing evidence policy module), reports print fields, the GPU floor follows the model, and new installs start with cloud AI on; after 3, every piece is unit tested; after 4, the feature is usable in the app; 5 proves it the way CI runs; 6 ships the pack.

**Contract changes** (rows in `docs/architecture/contract-changes.md`): (a) new `aio.ai-request/1` file (`AiRequest`, `FieldSpec`, `FieldValue`, `AskKind`, `AskScope`, `AskModelChoice`, `AskItem`, `AskTurn`); (b) `Issue.fields`, `Detection.fields`, `DetectionOrigin.request` (custom fields on issues); (c) `ProjectManifest.aiPolicy`; (d) IPC `ai:ask`, `ai:askStatus`, `ai:setProjectPolicy`, `requests:list|save|remove|export|import`; (e) Analytics pack 0.2.0 model switch and the `detect.vlm` box frame (no shape change).

**e2e specs:** added `custom-analytics.spec.ts`; changed `fake-llm.ts` (an ask reply); changed for cloud on by default (Task 19): `smoke.spec.ts`, `agent-local.spec.ts`, `detections.spec.ts`, `offline-cloud-ai.spec.ts`. Re-run unchanged specs over changed code: `inspect.spec.ts`, `detectors-local.spec.ts`, `detections.spec.ts`, `house-report.spec.ts`, `offline-cloud-ai.spec.ts`, `a11y.spec.ts`, `small-window.spec.ts`.

---

### Task 1: Contracts

**Packages:** `@aio/schema`, `@aio/ui` (catalogue files only), `apps/desktop` (preload allowlist), docs.

**Files:**

- Create: `packages/schema/src/aiRequest.ts`, `packages/schema/src/aiRequest.test.ts`
- Modify: `packages/schema/src/annotation.ts` (Issue), `detections.ts` (Detection, DetectionOrigin), `manifest.ts` (ProjectManifest), `ipc.ts` (channels), `index.ts` (exports)
- Modify: `apps/desktop/src/preload/index.ts` (allowlist, `satisfies Record<IpcChannel, true>`)
- Create: `packages/ui/src/i18n/enAskRun.ts`, `enAskPanel.ts`, `enAskFields.ts`, `enAskSettings.ts`, `enAskReport.ts`, each `export const enAskX = {} as const satisfies Record<string, string>;` with a header comment naming its owning task; Modify `packages/ui/src/i18n/en.ts` to spread the five at the end of the `en` literal
- Modify: `docs/architecture/contract-changes.md` (rows a to d)

**Interfaces (Produces):**

- `aiRequest.ts`: `AI_REQUEST_SCHEMA = 'aio.ai-request/1'`, `AI_REQUEST_FILE_EXTENSION = '.aioreq'`, `FieldType = z.enum(['number','text','yesno','choice'])`, `FieldKey = /^[a-z][a-z0-9_]{0,39}$/`, `FieldSpec` (strict: `key`, `label` 1..60, `type`, `choices?` 2..20 strings of 1..40, present exactly when `type === 'choice'`, `unit?` max 20), `FieldValue` (strict: `key`, `label`, `type`, `value: number | string | null`, `unit?`; refine: number type holds a finite number or null, yesno holds `'yes'|'no'|'unknown'|null`, text and choice a string max 200 or null), `AskKind = z.enum(['find','change','ask'])`, `AskScope = z.enum(['photo','selected','all','dates'])`, `AskCloudModel` (strict `{ provider: 'anthropic'|'openai', model: string 1..80 }`), `AskModelChoice = 'auto' | 'local' | AskCloudModel`, `AiRequestId = /^[a-z0-9][a-z0-9-]{1,60}$/`, `AiRequest` (strict: `schema`, `id`, `name` 1..80, `kind`, `prompt` 1..2000, `fields: FieldSpec[]` max 12 with unique keys, `scope`, `model: AskModelChoice`, `defaults?: { classId?: string 1..120; severity?: int | 'uncertain' }`, `wholeImage?: boolean`, `author` max 120, `createdAt`, `updatedAt` IsoTime), `AskItem` (strict: `box: [x0,y0,x1,y1]` each 0..1 with x1 > x0, y1 > y0; `label` max 80; `note` max 500; `fields: FieldValue[]` max 14), `AskTurn` (strict `{ role: 'user'|'assistant', text: 1..8000 }`). Types exported for each.
- `Issue.fields?: FieldValue[]` (max 14); `Detection.fields?: FieldValue[]`; `DetectionOrigin.request?: string` (an `AiRequestId`); `ProjectManifest.aiPolicy?: 'forbid' | 'allow'` (reuse `AiPolicy` from `package.ts` when that adds no import cycle, else an equal inline `z.enum`; doc comment: absent means allow for a folder project; `readAiPolicyDetail` still reads the raw file and also accepts `package.aiPolicy`).
- IPC in `ipc.ts` (beside `ai:detect`), each with a doc comment:
  - `'ai:ask'`: request strict `{ runId, projectId, backend: { kind: 'local' } | { kind: 'cloud'; provider: 'anthropic'|'openai'; model }, kind: AskKind, prompt: 1..2000, fields: FieldSpec[] max 14, images: AskImage[] 1..2, turns?: AskTurn[] max 20, wholeImage?: boolean, requestId?: AiRequestId }` with a refine: `change` has exactly 2 images, the others exactly 1. `AskImage = DetectImage` fields plus `label?: string max 80`, and its doc says `width`/`height` are the **sent** pixel size of `dataUrl`. Response: `{ ok: true, provider, model, promptVersion, items: AskItem[], text?: string, inputTokens, outputTokens, costUsd?, warnings: string[] } | { ok: false, error, status?, stopped?, code?: 'busy'|'no-pack'|'no-card'|'refused'|'format'|'forbidden' }`.
  - `'ai:askStatus'`: `{ projectId }` to `{ cloud: { usable: boolean; reason?: 'offline-only'|'cloud-off'|'forbidden'; message?: string; providers: ('anthropic'|'openai')[] }, keepLocal: boolean, local: { ready: boolean; model?: string; problem?: string } }`.
  - `'ai:setProjectPolicy'`: `{ projectId, keepLocal: boolean }` to `OkOrFailure` (failure may carry `code: 'read-only'`).
  - `'requests:list'`: `{ projectId?: string }` to `{ items: { where: 'project'|'library'; request: AiRequest }[]; problems: { file: string; error: string }[] }`.
  - `'requests:save'`: `{ projectId?, where, request: AiRequest }` to `OkOrFailure`. `'requests:remove'`: `{ projectId?, where, id }` to `OkOrFailure`.
  - `'requests:export'`: `{ projectId?, where, id }` to `{ ok: true; path?: string }` (no path: the dialog was closed) or `Failure`. `'requests:import'`: `{ projectId?, where }` to `{ ok: true; request?: AiRequest }` or `Failure`.

- [ ] **Step 1: Write the failing tests** in `aiRequest.test.ts`: `FieldSpec` refuses `choice` without `choices` and `number` with `choices`; `FieldValue` refuses `{type:'yesno', value:'maybe'}` and `{type:'number', value:'4'}`; `AiRequest` refuses duplicate field keys and 13 fields, accepts a full gauge example (`kind:'find'`, fields reading number unit bar, in_normal_range yesno, gauge_type choice); `Issue.parse` keeps `fields`; `Detection` keeps `fields` and `origin.request`; `parseManifest` keeps `aiPolicy: 'forbid'`; `ipcChannels['ai:ask'].request` refuses `kind:'change'` with one image and `kind:'find'` with two.
- [ ] **Step 2: Run** `pnpm vitest run packages/schema/src/aiRequest.test.ts` and expect FAIL (module missing).
- [ ] **Step 3: Implement** the schema, exports, IPC entries and preload allowlist lines; spread the catalogue files.
- [ ] **Step 4: Run** `pnpm vitest run packages/schema` and `pnpm typecheck`; expect PASS.
- [ ] **Step 5: Write the four contract rows** (a to d above), dated 2026-10-29, each saying it is additive and what an older build does (ignores `fields`, `aiPolicy`; the new files and channels do not exist there).
- [ ] **Step 6: Run** `pnpm check`; expect green. **Commit** `feat(schema): custom analytics contracts` with only these paths.

### Task 2: Detector engine reads Qwen3 boxes and repairs `}}`

**Packages:** `python/` (pipeline pack), `tools/detectors`.

**Files:** Modify `python/src/aio_pipelines/detect/engine.py`, `pipeline.py`, `python/tests/test_detect_engine.py`, `test_detect_pipeline.py`, `tools/detectors/bench.py`, `tools/detectors/test_bench.py`, `tools/detectors/README.md`, `python/pyproject.toml` (version `0.27.0`).

**Interfaces (Produces):**

- `box_frame(model_id: str) -> Literal["pixels", "rel1000"]`: `rel1000` when the id matches `qwen3` (`qwen3.5-...`, `qwen3-vl-...`), else `pixels`.
- `parse_boxes(text) -> list[tuple[list[float], str]] | None` now strips `<think>...</think>`, applies the bench repairs (a `}}` before `]` or `,` becomes `}`; a trailing `}}` becomes `}]`; a cut-off list is cut back to its last complete object) and returns a third value through a new `parse_boxes_ex(text) -> tuple[list | None, bool]` whose bool says a repair was needed.
- `run_detector(client, image, det, frame="pixels")`: `rel1000` boxes are scaled by `send_w / 1000`, `send_h / 1000` before the existing clamping; a repaired reply adds the warning `"reply repaired"`; the `FRACTIONS_WARNING` path stays for `pixels`.
- `pipeline.py` passes `frame=box_frame(params["model"])`.
- `bench.py` gains `--model <id>` (default from `GET /v1/models` of `--server`, else `pixels`) and passes the frame.

- [ ] **Step 1: The pipeline pack number is `0.27.0`** (Global Constraints): bump `python/pyproject.toml`, `uv.lock` and the `__init__.py` history note to it in Step 6.
- [ ] **Step 2: Write failing tests** in `test_detect_engine.py`: `test_parse_boxes_repairs_double_brace` (`'[{"bbox_2d":[1,2,30,40],"note":"n"}}]'` parses to one box, repaired True); `test_parse_boxes_cut_back` (a list cut mid second object keeps the first); `test_parse_boxes_strips_think`; `test_rel1000_boxes_scale_to_send_frame` (a fake client answering `[{"bbox_2d":[500,500,750,750]}]` on a 1344 x 1008 single tile gives a source box at half to three quarters of the image); `test_box_frame` (`qwen3.5-9b-q4_k_m` is rel1000, `qwen2.5-vl-7b-instruct-q4_k_m` pixels). In `test_detect_pipeline.py`: the job passes the frame from `params.model`. In `tools/detectors/test_bench.py`: `--model` reaches `run_detector`.
- [ ] **Step 3: Run** `"E:/Dev/AIO Software/python/.venv/Scripts/python.exe" -m pytest python/tests/test_detect_engine.py python/tests/test_detect_pipeline.py tools/detectors/test_bench.py` with `PYTHONPATH=python/src;python/tests` and `PYTHONDONTWRITEBYTECODE=1`; expect FAIL.
- [ ] **Step 4: Implement**; update the engine docstring (Qwen3 frame) and `tools/detectors/README.md` (`--model`).
- [ ] **Step 5: Run** the same tests and `ruff format` / `ruff check` on the touched files (the main venv's ruff); expect PASS. Check the main venv's import path still points at the main checkout.
- [ ] **Step 6: Set** `python/pyproject.toml` version to `0.27.0` once known. **Commit** `fix(detect): read Qwen3 boxes and repair broken replies` (body names the pipeline pack number).

### Task 3: Analytics pack 0.2.0 pins for Qwen3.5-9B

**Packages:** `tools/analytics-pack` (not a workspace package), docs.

**Files:** Modify `tools/analytics-pack/lock.json`, `README.md`, `package.json` (`"version": "0.2.0"`), `build.mjs` (`APP_RANGE` floor and header comment), `build.test.mjs`, `smoke.py`, `test_smoke.py`; after Task 1 commits, `docs/architecture/contract-changes.md` (row e).

**Interfaces (Produces):** `lock.json.model = { id: 'qwen3.5-9b-q4_k_m', licence: 'Apache-2.0', gguf: { url, sha256, size, file: 'model/qwen3.5-9b-q4_k_m.gguf' }, mmproj: { url, sha256, size, file: 'model/mmproj-qwen3.5-9b-f16.gguf' } }`; the Qwen licence entry replaced by Qwen3.5's; `APP_RANGE = '>=<app version> <2.0.0'` with `<app version>` read from `apps/desktop/package.json` (0.27.0 at planning). `smoke.py` gains `--model-id` and checks the box in the model's frame (`rel1000` for Qwen3: the red square at `[900,300,1100,500]` in a 1344 x 1008 image is about `[670,298,818,496]`; 3 % tolerance) and starts the server with `--reasoning off` for Qwen3.5.

- [ ] **Step 1: Find the pinned source.** The bench's files are `Qwen3.5-9B-Q4_K_M.gguf` and `mmproj-F16.gguf` under the earlier bench download folder (`...\vlm-bench\downloads\qwen35-9b\`). Hash them (`sha256`, size) and find the Hugging Face repo whose LFS `oid` matches through `https://huggingface.co/api/models/<repo>/tree/main` (try `unsloth/Qwen3.5-9B-GGUF`, `ggml-org/Qwen3.5-9B-GGUF`, `Qwen/Qwen3.5-9B-GGUF`, `lmstudio-community/Qwen3.5-9B-GGUF`). Pin the URL to the repo's commit (`/resolve/<commit sha>/...`, commit from `/api/models/<repo>/revision/main`). If no repo matches the bench file, pin the matching Q4_K_M file of the first repo that has both files and note that the bench used a different upload. Licence: the repo's LICENSE if it has one, else the Apache-2.0 text from the official Qwen GitHub repository at a pinned commit; pin by URL, size, sha256.
- [ ] **Step 2: Write failing tests:** `build.test.mjs` expects version `0.2.0`, the new model id and file names in the manifest and an `appRange` starting `>=0.27.0` (or the app version read at run time); `test_smoke.py` gains `test_rel1000_box_check` against the stub server answering `[{"bbox_2d":[670,298,818,496]}]`.
- [ ] **Step 3: Run** `node --test tools/analytics-pack/build.test.mjs` and the smoke pytest (main venv); expect FAIL.
- [ ] **Step 4: Implement**; update `README.md` (pins, licence, smoke result to be filled by Task 18, server notes: `--reasoning off`, thinking off per request, VRAM 6.8 GB at 8k context, no `--image-min-tokens` needed at 1344 px).
- [ ] **Step 5: Run** the tests; expect PASS. `node tools/analytics-pack/build.mjs --out <scratch> --no-model` must succeed (a check build, no download).
- [ ] **Step 6: After Task 1's commit,** add row (e): Analytics pack 0.2.0 ships Qwen3.5-9B; its boxes are 0 to 1000; the `detect.vlm` engine picks the frame from `params.model`; no `@aio/schema` shape change; an older pipeline pack is refused for detectors (Task 10). **Commit** `chore(analytics-pack): pin Qwen3.5-9B for pack 0.2.0`.

### Task 4: Ask core in `@aio/ai` (prompts, parser, guards, routing, estimate)

**Packages:** `@aio/ai` (pure module, renderer-safe: no provider SDK imports).

**Files:** Create `packages/ai/src/ask.ts`, `ask.test.ts`; Modify `packages/ai/src/index.ts` (export), `pricing.ts` (+ test), `packages/ai/README.md` (price source).

**Interfaces:**

- Consumes: `FieldSpec`, `FieldValue`, `AskKind`, `AskScope`, `AskModelChoice`, `AskItem` from `@aio/schema` (Task 1); `imageTokens`, `DetectEstimate` from `./detect`; `estimateCostUsd` from `./pricing`.
- Produces:
  - `ASK_PROMPT_VERSION = 'ask-v1'`, `ASK_MARKER = '<aio-ask>'`, `MAX_ASK_ITEMS = 30`, `ASK_SEND_MAX_PX = { cloud: 1568, local: 1344 } as const`, `CHANGE_FIELDS: FieldSpec[]` (`change_type` choice of new, removed, moved, progress, damage; `what` text).
  - `type AskFamily = 'qwen25' | 'qwen3' | 'cloud'`.
  - `askPrompt(i: { family: AskFamily; kind: AskKind; prompt: string; fields: readonly FieldSpec[]; images: readonly { width: number; height: number; label?: string }[] }): string` (sizes are the sent sizes).
  - `parseAskReply(text: string, i: { family: AskFamily; kind: AskKind; sent: { width: number; height: number }; fields: readonly FieldSpec[]; wholeImage?: boolean }): { items: AskItem[]; warnings: string[] } | { error: string }`.
  - `readJsonList(text: string): { list: unknown[]; repaired: boolean; cut: boolean } | null` (the bench's `parse_list`).
  - `coerceField(spec: FieldSpec, raw: unknown): { value: FieldValue; warning?: string }`.
  - `guardItems(items: AskItem[], o: { wholeImage?: boolean; sent: { width: number; height: number } }): { items: AskItem[]; warnings: string[] }`.
  - `type AskRoute = { kind: 'local' } | { kind: 'cloud'; provider: 'anthropic' | 'openai'; model: string }`.
  - `routeAsk(i: { kind: AskKind; scope: AskScope; choice: AskModelChoice; cloud: { usable: boolean; providers: readonly ('anthropic'|'openai')[] }; local: { ready: boolean } }): { route: AskRoute; weakOffline: boolean } | { none: 'nothing' | 'cloud' | 'local' }`.
  - `ASK_MODELS: readonly { provider: 'anthropic'|'openai'; model: string; best?: true }[]` (Haiku, Sonnet, Opus with `best`, GPT-6.1 sol, GPT-6 luna).
  - `askProviderOptions(provider: string, model: string, kind: AskKind): Record<string, Record<string, string>>`.
  - `askMaxTokens(kind: AskKind, where: 'cloud' | 'local'): number` (cloud: find 8000, change 12000, ask 6000; local: find 2048, change 2048, ask 700).
  - `estimateAsk(o: { provider: string; model: string; kind: AskKind; images: readonly { width: number; height: number }[]; prompt: string; fields: readonly FieldSpec[]; requests: number }): DetectEstimate` (output tokens per request: find 600, change 800, ask 500).

Prompt text (ported from the bench; `K` is `"bbox_2d": [x1, y1, x2, y2]`; `C` is ` with bbox_2d coordinates normalised to 0-1000` for `qwen3`, empty otherwise; `F` is the fields part below; `PX` is the cloud pixel note, empty for local):

- find: `<prompt>\nGive each item its own tight box. Output JSON only: [{K, "label": "<short name>", "note": "<what and where, max 20 words>"F}]C. Output [] if there is none.PX`
- change: `Image 1 was taken on <label 1> and Image 2 on <label 2>, from about the same spot. <prompt>\nList every real change between them; ignore lighting, shadows, water glare and small camera shifts. For each change output one object: {K, "change_type": "new|removed|moved|progress|damage", "what": "<the object>", "note": "<what changed, max 20 words>"F}, where the box marks the change on Image 2C. Output a JSON list only, at most 10 items. Output [] if nothing changed.PX`
- ask: `You help an inspection engineer review drone inspection photos. Answer in plain text, briefly and concretely. Say when something cannot be seen clearly. Do not grade severity; the engineer sets it.\n<prompt>`
- `F` per field, in order: number `, "<key>": <<label>[ in <unit>] as a number, or null if you cannot read it>`; text `, "<key>": "<<label>, max 10 words>"`; yesno `, "<key>": "yes|no|unknown"`; choice `, "<key>": "<c1>|<c2>|..."`.
- `PX` (cloud): ` Box coordinates are integer pixels of the image (it is <w> x <h> pixels as sent), x to the right, y down.`; for change: `of each image (both are <w> x <h> pixels as sent)` using Image 2's size.
- Cloud prompts start with the line `ASK_MARKER` (the scripted test model keys on it); local prompts do not.

- [ ] **Step 1: Write failing tests** (`ask.test.ts`), with exact values:
  - `readJsonList`: bare list; fenced; `<think>` stripped; `'[{"a":1}}]'` repaired; a list cut inside its third object keeps two with `cut: true`; a lone object becomes a one item list; prose gives null.
  - `parseAskReply` qwen3: `[{"bbox_2d":[100,200,300,500],"label":"gauge","note":"n"}]` on 1344 x 1008 gives box `[0.1, 0.2, 0.3, 0.5]`; qwen25 (pixels) `[134.4,201.6,403.2,504]` gives the same; cloud pixels on 1568 x 1176 likewise; swapped corners are sorted; a box under 3 sent px is dropped with a warning; prose answers `{ error }` starting `The model did not answer in the format asked for`.
  - `coerceField`: number from `4.2`, `"4.2"`, `"4,2 bar"` (4.2), `"n/a"` (null + warning); yesno from `"Yes."`, `true`, `"no"`, `"maybe"` (unknown + warning); choice outside the list gives null + warning, case-insensitive match keeps the spec's spelling; text trimmed to 200; a missing key gives null without a warning.
  - `guardItems`: 50 copies of one box become 1; 40 distinct small boxes are capped to 30 with warning `The model listed 40 items; the first 30 are kept.`; a `[0.01,0.01,0.99,0.99]` box is dropped unless `wholeImage`; two boxes sharing 70 % of the smaller merge to the larger.
  - `routeAsk`: the table of call 2, every row (cloud usable with Anthropic: change to Sonnet, ask to Sonnet, find all to Haiku, find photo with local ready to local, find photo without local to Haiku; only OpenAI: Sonnet to `gpt-6.1-sol`, Haiku to `gpt-6-luna`; cloud not usable: local for all with `weakOffline` true for change and ask; nothing ready: `{ none: 'nothing' }`; choice `local` without local: `{ none: 'local' }`; choice cloud with that provider missing: `{ none: 'cloud' }`).
  - `askProviderOptions`: Sonnet find `{ anthropic: { effort: 'low' } }`; Opus change `{ anthropic: { effort: 'medium' } }`; `gpt-6-luna` `{ openai: { reasoningEffort: 'low' } }`.
  - `askPrompt` snapshots for find with three fields (qwen3 and cloud) and for change (the built-in fields first).
  - `estimateAsk` for Haiku with one 1568 x 1176 image is above 0 and below $0.01.
  - pricing: `priceFor('claude-haiku-5-5')` is defined.
- [ ] **Step 2: Run** `pnpm vitest run packages/ai/src/ask.test.ts packages/ai/src/pricing.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** `guardItems` dedupe is the engine's merge (largest first, drop a box whose overlap is at least 0.6 of the smaller kept one), then the cap, then the whole-frame rule (area at least 0.9). Labels: `label`, else `what`, else `item`. The Haiku price row: the bench used input 0.10 and output 0.50 USD per million tokens; check the current published price with the `claude-api` skill and write the published figure, bump `PRICES_AS_OF`, add the source line to the README.
- [ ] **Step 4: Run** the tests and `pnpm typecheck`; expect PASS. **Commit** `feat(ai): prompts, parser, guards and routing for custom requests`.

### Task 5: Fields through the review

**Packages:** `@aio/annotate`.

**Files:** Modify `packages/annotate/src/detections/model.ts`, `accept.ts`, `review.ts`, `packages/annotate/src/model/editor.ts`, and `detections.test.ts`, `review.test.ts`, the editor test.

**Interfaces:**

- Consumes: `FieldValue`, `Detection.fields`, `DetectionOrigin.request`, `Issue.fields` (Task 1).
- Produces: annotate `Detection.fields?: FieldValue[]`; the `ai` origin gains `request?: string`; `readPasses` and `writePass` carry both; `DetectionPatch` accepts `fields`; `AcceptAsNew.fields?: FieldValue[]` filled by `newIssueInput` when the draft has fields; `CreateInput.fields?: FieldValue[]` written to the new issue. Linking a draft to an existing issue adds the sighting only and leaves that issue's fields alone.

- [ ] **Step 1: Write failing tests:** a pass file with `fields` and `origin.request` reads and writes back unchanged; a patch of `fields` on a draft is undoable; `newIssueInput` copies two fields; `issueEditor.create` with `fields` gives an issue whose `fields` validate against `Issue`; linking does not change the target's fields.
- [ ] **Step 2: Run** `pnpm vitest run packages/annotate`; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run packages/annotate` and `pnpm typecheck`; expect PASS. **Commit** `feat(annotate): carry custom fields from draft to issue`.

### Task 6: "Keep on this PC" handler

**Packages:** `apps/desktop` main.

**Files:** Modify `apps/desktop/src/main/evidencePolicy.ts`, `evidencePolicy.test.ts`.

**Interfaces:** Consumes `'ai:setProjectPolicy'` and `ProjectManifest.aiPolicy` (Task 1). Produces the handler inside `registerEvidencePolicyIpc` (already registered in `main/index.ts`, so no wiring edit): a package answers `READ_ONLY`; `keepLocal: true` sets `aiPolicy: 'forbid'`, `false` deletes the key; through `updateManifestFile` (backed up, in the project's save turn).

- [ ] **Step 1: Write failing tests** with `collectHandlers`: `keepLocal: true` writes `"aiPolicy": "forbid"` to `manifest.json` and `readAiPolicy(root)` answers `forbid`; a later unrelated `updateManifestFile` save keeps it; `false` removes it and `readAiPolicy` answers `allow`; a package is refused with `code: 'read-only'`; an unknown project id answers not open.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/evidencePolicy.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**; expect PASS. **Commit** `feat(ai): keep a project's images on this PC`.

### Task 7: The switch in Settings, Privacy and cloud

**Packages:** `apps/desktop` renderer, `@aio/ui` (`enAskSettings.ts` only).

**Files:** Create `apps/desktop/src/renderer/screens/settings/ProjectPrivacy.tsx`, `ProjectPrivacy.test.tsx`; Modify `screens/Settings.tsx` (render `<ProjectPrivacy />` in `Privacy()` after `<OfflineOnly />`), `packages/ui/src/i18n/enAskSettings.ts`.

**Interfaces:** Consumes `'ai:setProjectPolicy'` and the open project's `manifest.aiPolicy`. Produces `ProjectPrivacy(): ReactElement | null`: nothing when no project is open; a block "This project" with the switch `data-testid="keep-local"` labelled "Keep this project's images on this PC"; help when on: "Nothing from this project is sent to a cloud AI provider. Ask AI uses the model on this PC."; when off: "Cloud runs still ask before anything is sent."; a package shows it disabled with "A package's AI sharing is set by whoever made it."; an error from the call shows in a `role="alert"` line. After a successful call the manifest is read again the way `ai:setCloudEvidence`'s caller does it (`renderer/engineer/runStore.ts`).

- [ ] **Step 1: Write failing tests:** renders nothing without a project; the switch reflects `aiPolicy: 'forbid'`; toggling calls the bridge with `{ projectId, keepLocal: true }`; a package shows it disabled; a failure shows the alert.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/screens/settings/ProjectPrivacy.test.tsx`; expect FAIL.
- [ ] **Step 3: Implement** (load `impeccable` and `frontend-design` first; reuse the page's `sblock` and `Switch`).
- [ ] **Step 4: Run**; expect PASS. **Commit** `feat(settings): keep this project's images on this PC`.

### Task 8: Saved requests

**Packages:** `apps/desktop` main.

**Files:** Create `apps/desktop/src/main/analytics/requests.ts`, `requests.test.ts`, `requestsIpc.ts`, `requestsIpc.test.ts`.

**Interfaces:**

- Consumes: `AiRequest`, `AI_REQUEST_FILE_EXTENSION`, `requests:*` channels (Task 1); `readJson`, `writeJsonAtomic` from `../fsutil`.
- Produces:
  - `requestDirs(o: { userData: string; projectDir?: string }): { library: string; project: string | null }` (`<userData>/requests`, `<project>/requests`).
  - `listRequests(o): Promise<{ items: { where: 'project'|'library'; request: AiRequest }[]; problems: { file: string; error: string }[] }>` (project first, then library, each by name).
  - `saveRequest(o, where, r: AiRequest): Promise<void>` (validates, `<dir>/<id>.json`, atomic).
  - `removeRequest(o, where, id): Promise<void>`.
  - `exportRequest(o, where, id, file: string): Promise<void>`; `importRequest(o, where, file: string): Promise<AiRequest>` (at most 64 KB, validated; an id already there gets `-2`, `-3`, ...).
  - `registerRequestsIpc(d: { handle; userData: () => string; projectDir: (projectId: string) => string | null; isPackage: (projectId: string) => boolean; chooseOpen: () => Promise<string | null>; chooseSave: (defaultName: string) => Promise<string | null>; assertWritable?: (path: string, op: string) => void }): void`. Saving to or removing from a package's project answers the read-only failure.

- [ ] **Step 1: Write failing tests:** save then list returns it with `where`; an invalid file in the folder appears under `problems`, not `items`; remove deletes; export then import into the library gives an equal request with id `<id>-2` when the id exists; a 70 KB file is refused; IPC: project save on a package refused; export with the dialog closed answers `{ ok: true }` without `path`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/analytics/requests`; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**; expect PASS. **Commit** `feat(analytics): save, share and reuse custom requests`.

### Task 9: Fields in the reports

**Packages:** `@aio/project` (export), `apps/desktop` renderer report pages, `@aio/ui` (`enAskReport.ts` only).

**Files:** Modify `packages/project/src/export/report.ts` (+ its test), `apps/desktop/src/renderer/reportPage/layout.ts` (+ `layout.test.ts`), `reportPage/house/sections.ts` (+ `sections.test.ts`), `reportPage/report.css`, `reportPage/house/house.css`, `packages/ui/src/i18n/enAskReport.ts`.

**Interfaces:**

- Consumes: `Issue.fields`, `FieldValue` (Task 1).
- Produces: `ReportRow.fields: FieldValue[]` (from `issue.fields`, else empty); `fieldTables(rows: readonly ReportRow[]): FieldTable[]` with `FieldTable = { columns: { key: string; label: string; unit?: string }[]; rows: { code: string; title: string; values: FieldValue[] }[] }`, one table per distinct ordered key list, in register order; `formatFieldValue(v: FieldValue, words: { yes: string; no: string; unknown: string; none: string }): string` (number with its unit, `4.2 bar`; null as `none`).
- Register report (`layout.ts`, English literals like the rest of that file): after the register table, one table per `FieldTable` headed "Recorded values" (columns Code, Title, then the field labels with units); each issue page lists its fields in the `meta` list.
- House report: `layoutRegister` adds the same tables (`tableMaker('grid fields', ...)`, heading key `house.fields.title` "Recorded values"); `issuePageHtml` adds one meta row per field. Keys in `enAskReport.ts`: `house.fields.title`, `house.fields.code`, `house.fields.finding` ("Finding"), `report.fields.yes` "Yes", `report.fields.no` "No", `report.fields.unknown` "Unknown", `report.fields.none` "Not read".

- [ ] **Step 1: Write failing tests:** `fieldTables` groups two gauge issues into one table and a change issue into another; `formatFieldValue` cases; `reportHtml` with a gauge issue contains `Recorded values` and `4.2 bar`; the house register with no fields renders exactly as before (snapshot unchanged) and with fields adds the table; `issuePageHtml` lists the fields.
- [ ] **Step 2: Run** `pnpm vitest run packages/project/src/export apps/desktop/src/renderer/reportPage`; expect FAIL.
- [ ] **Step 3: Implement** (tables break across pages like the register: reuse its pager calls).
- [ ] **Step 4: Run**; expect PASS. **Commit** `feat(report): print custom fields as tables`.

### Task 10: Local model table, server arguments, VRAM floor, detector pack floor

**Packages:** `apps/desktop` main.

**Files:** Create `apps/desktop/src/main/analytics/models.ts`, `models.test.ts`; Modify `server.ts`, `server.test.ts`, `hardware.ts`, `hardware.test.ts`, `gate.ts`, `gate.test.ts`, `detectPack.ts` (+ test), `apps/desktop/src/main/index.ts` (the two `checkHardware` call sites only).

**Interfaces:**

- Produces:
  - `interface LocalVlmModel { family: 'qwen25' | 'qwen3'; serverArgs: readonly string[]; minFreeMb: number; thinkingOff: boolean }`; `localVlmModel(id: string): LocalVlmModel`: ids starting `qwen3.5-` give `{ qwen3, ['--reasoning','off'], 7400, true }`; `qwen3-vl-` give `{ qwen3, [], 5600, false }` (for follow-up F1); anything else `{ qwen25, [], VLM_MIN_FREE_VRAM_MB, false }`.
  - `VlmServer.launch` appends `localVlmModel(pack.manifest.model.id).serverArgs`.
  - `VlmServer.lease(): () => void`; `idle()` while a lease is held only marks a stop as wanted; the last release stops then. `stopSync` ignores leases.
  - `checkHardware(d: HardwareDeps & { minFreeMb?: number })`: the free memory check uses `Math.max(VLM_MIN_FREE_VRAM_MB, minFreeMb ?? 0)`.
  - `GateDeps.hardware(minFreeMb: number): Promise<HardwareCheck>`; the gate passes `localVlmModel(pack.manifest.model.id).minFreeMb`. `main/index.ts` passes it on to `checkHardware`.
  - `DETECT_MIN_PACK = '0.27.0'` (call 16); the refusal text stays the existing one.

- [ ] **Step 1: Write failing tests:** `localVlmModel` cases; a launch from a pack with model id `qwen3.5-9b-q4_k_m` passes `--reasoning off` and one with `qwen2.5-vl-7b-instruct-q4_k_m` does not; `idle()` during a lease does not kill, the release does; the hardware check refuses 7000 MB free with `minFreeMb: 7400` (`tooBusy`) and accepts it without; the gate hands the model's floor to `hardware`; `detectPackRefusal('detect.vlm', '0.26.0')` refuses when `0.27.0` is newer.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/analytics`; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the folder's tests and `pnpm typecheck`; expect PASS. **Commit** `feat(analytics): model table for the local vision model`.

### Task 11: Local ask on the Analytics pack

**Packages:** `apps/desktop` main.

**Files:** Create `apps/desktop/src/main/analytics/ask.ts`, `ask.test.ts`.

**Interfaces:**

- Consumes: `askPrompt`, `parseAskReply`, `guardItems`, `askMaxTokens`, `CHANGE_FIELDS`, `ASK_PROMPT_VERSION` (Task 4); `localVlmModel`, `VlmServer.lease` (Task 10); `findAnalyticsPack`, `unusablePacks`; `ai:ask` types (Task 1).
- Produces:
  - `interface LocalAskDeps { env: Record<string, string | undefined>; findPack(): Promise<AnalyticsPack | null>; unusable(): Promise<UnusablePack[]>; hardware(minFreeMb: number): Promise<HardwareCheck>; server: Pick<VlmServer, 'ensure' | 'attach' | 'serves' | 'lease'>; gpuBusy(): string | null; idleIfUnused(): void; fetch: typeof fetch; now(): number }`.
  - `interface LocalAsk { run(req: IpcRequest<'ai:ask'>): Promise<IpcResponse<'ai:ask'>>; cancel(runId: string): boolean; active(): boolean; status(): Promise<{ ready: boolean; model?: string; problem?: string }> }`; `createLocalAsk(d: LocalAskDeps): LocalAsk`.
  - Test seam: with `QUADRION_VLM_SERVER_URL` set, `attach(url, 'a'.repeat(64))` stands in for the pack, card and spawn; the model id is `QUADRION_VLM_MODEL` or `qwen3.5-9b-q4_k_m`; `status()` answers ready.
- Behaviour: one run at a time (a second answers `code: 'busy'` "The model on this PC is answering another request."); `gpuBusy()` non-null answers `busy` with that text; no pack answers `no-pack` with the newest unusable reason or the existing missing-pack text; a refused card answers `no-card` with its reason; then `ensure`, `lease`, one POST to `<url>/v1/chat/completions` with `Authorization: Bearer <key>`, body `{ messages, temperature: 0, max_tokens: askMaxTokens(kind,'local'), chat_template_kwargs: { enable_thinking: false } }` (the last only when `thinkingOff`). Messages: the first user message holds, per image, a text part (`Image n:` or `Image n (<label>):`) then an `image_url` part, then the `askPrompt` text; `turns` follow as alternating messages and the new `prompt` closes as a user message. Timeout 180 s; `cancel` aborts and answers `{ ok: false, error: 'Stopped.', stopped: true }`. `ask` returns `text` (think blocks stripped); `find` and `change` parse with the model's family (for `change`, `fields = CHANGE_FIELDS + req.fields`), then `guardItems`; an unreadable reply is asked once more, then answers `code: 'format'`. `finish_reason: 'length'` keeps what was read with the warning "The answer was cut short." Tokens from `usage`, cost 0. `finally`: release the lease, `idleIfUnused()`.

- [ ] **Step 1: Write failing tests** with a fake fetch and a fake server: request body (key header, thinking off for Qwen3.5 and absent for Qwen2.5, two images labelled for change); a qwen3 reply gives normalised boxes; an unreadable first reply then a good one gives items (two calls); two unreadable replies give `format`; `busy` while running and when `gpuBusy` says so; cancel; seam attaches without `findPack`; the lease is released after a failure.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/analytics/ask.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**; expect PASS. **Commit** `feat(analytics): custom requests on the model on this PC`.

### Task 12: Cloud ask in the AI runtime

**Packages:** `@aio/ai` (main entry).

**Files:** Create `packages/ai/src/askRun.ts`, `askRun.test.ts`; Modify `packages/ai/src/main.ts` (runtime methods, gate refactor), `scripted.ts`, `main.test.ts`.

**Interfaces:**

- Consumes: Task 4 exports; `ai:ask`, `ai:askStatus` types (Task 1).
- Produces:
  - In `main.ts`: the gates after the route lookup move into `gateRoute(route: ModelRoute, task: AiTask, projectId: string | undefined): Promise<Check>`; `check(task, projectId)` becomes `routeFor` plus `gateRoute` (behaviour unchanged, existing tests pass).
  - `AgentRuntime.ask(req: IpcRequest<'ai:ask'>): Promise<IpcResponse<'ai:ask'>>`: refuses `backend.kind === 'local'` ("Local requests run in the app."); route `{ task: 'vision', provider, model }` through `gateRoute` (a policy `forbid` answers `code: 'forbidden'` with `MESSAGES.forbidden`); registered in `runs` so `cancel(runId)` stops it; then `runAsk`.
  - `AgentRuntime.askStatus(projectId: string): Promise<Omit<IpcResponse<'ai:askStatus'>, 'local'>>`: `usable` false with `offline-only`, `cloud-off` or `forbidden` in that order; `keepLocal` from the policy; `providers` are `anthropic` and `openai` when registered and either keyless or keyed.
  - `askRun.ts`: `runAsk(o: { req: IpcRequest<'ai:ask'>; route: ModelRoute; provider: ModelProvider; key: string | null; signal: AbortSignal; maxRetries: number; recordUsage: (u: StepUsage) => void }): Promise<IpcResponse<'ai:ask'>>`. Messages as in Task 11 (image parts as AI SDK `file` parts from the data URLs, the existing `parseDataUrl`), `askPrompt` with family `cloud`, `generateText({ model, messages, maxOutputTokens: askMaxTokens(kind,'cloud'), providerOptions: askProviderOptions(...), maxRetries, abortSignal })`. No `temperature`, no `topP`, no assistant prefill. `finishReason === 'length'`: parse what came (warning "The answer was cut short."); `'content-filter'`: `{ ok: false, code: 'refused', error: '<label>, <model>: the model declined this request.' }`. Unreadable reply: one more call, then `code: 'format'`. Usage of every call metered (summed in the answer). Timeout 180 s.
  - `scripted.ts`: a user text starting with `ASK_MARKER` is answered by `askReply(text)`: containing `garbage` gives `I could not do that.`; containing `Output JSON only` or `Output a JSON list only` gives two items in pixels of the size named in `(it is W x H` or `(both are W x H` (`[0.1W,0.2H,0.3W,0.5H]` and `[0.6W,0.4H,0.8W,0.7H]`, rounded), label `scripted item`, note `Scripted item n.`, change items with `change_type: "new"` and `what: "scripted object"`, and each field key found in the prompt filled (`<... as a number` gives 42.5, `"yes|no|unknown"` gives `yes`, a choice list its first entry, else `scripted`); anything else gives `Scripted answer: <first 80 characters of the newest user text>`.

- [ ] **Step 1: Write failing tests** (`askRun.test.ts` with the scripted provider, `main.test.ts` for gates): items normalised from scripted pixels; text answer; follow-up turns appear in the request in order; `garbage` twice gives `format` and usage of two calls is recorded; a `length` finish keeps items with the warning; a refusal; offline-only, cloud off and policy forbid each refuse before any call (the provider records no call); `ask refuses a cloud request once the project forbids it, read from disk per request` (policy host flips between two calls); `askStatus` providers with and without keys; existing `check` tests unchanged.
- [ ] **Step 2: Run** `pnpm vitest run packages/ai/src/askRun.test.ts packages/ai/src/main.test.ts packages/ai/src/scripted.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Check the option names against the installed `@ai-sdk/anthropic` (`effort`) and `@ai-sdk/openai` (`reasoningEffort`) type definitions in `node_modules/@ai-sdk/*/dist/index.d.ts`.
- [ ] **Step 4: Run** `pnpm vitest run packages/ai` and `pnpm typecheck`; expect PASS. **Commit** `feat(ai): custom requests on cloud models`.

### Task 13: Renderer runs and threads

**Packages:** `apps/desktop` renderer, `@aio/ui` (`enAskRun.ts` only).

**Files:** Create `apps/desktop/src/renderer/inspect/askAi/custom.ts`, `custom.test.ts`, `thread.ts`, `thread.test.ts`; Modify `inspect/askAi/runs.ts`, `runs.test.ts`, `inspect/askAi/backend.ts`, `renderer/detections/prepare.ts`, `packages/ui/src/i18n/enAskRun.ts`.

**Interfaces:**

- Consumes: Task 4 (`routeAsk`, `estimateAsk`, `ASK_SEND_MAX_PX`, `CHANGE_FIELDS`, `ASK_PROMPT_VERSION`, `sendSize`), Task 5 (annotate `Detection.fields`, origin `request`), `ai:ask`, `ai:askStatus` (Task 1).
- Produces:
  - `prepareItem(projectId, layers, item, maxPx = SEND_MAX_PX)` (new optional parameter).
  - `custom.ts`: `type AskDraftRequest = Pick<AiRequest, 'kind' | 'prompt' | 'fields' | 'defaults' | 'wholeImage'> & { id?: string; name: string }`; `askItemsToDrafts(o: { items: readonly AskItem[]; item: DetectItem; size: { width: number; height: number }; request: AskDraftRequest; classes: readonly { id: string; label: string }[]; runId: string; pass: string; provider: string; model: string; now: string; newId: () => string }): Detection[]` (box times the original size; class from `defaults.classId`, else a class whose label equals the item label case-insensitively, else empty with `label`; severity from `defaults.severity` else null; note = the item note; `fields`; origin ai with `promptVersion: 'ask-v1'` and `request`); `askConfirmInfo(o: { route: Extract<AskRoute, { kind: 'cloud' }>; items: readonly DetectItem[]; request: AskDraftRequest; requests: number }): CloudConfirm` (the existing type from `backend.ts`; `instructions` empty, `userText` the exact prompt sent for the first image); `useAskStatus(projectId: string): IpcResponse<'ai:askStatus'> | null` (a `useCall` keyed like `AskAiBar`'s `statusKey`).
  - `runs.ts`: `AskRunInput.custom?: { request: AskDraftRequest; route: AskRoute; pair?: { before: DetectItem & { kind: 'photo' }; after: DetectItem & { kind: 'photo' }; labels: [string, string] } }`. With `custom`, `begin` runs `runCustom`: `backend` is `'cloud'` or `'local'`, `what` is the request name; one `ai:ask` per item (ids `<runId>-<n>`, the current one cancelled by Stop), or one for the pair (drafts on `after`); images prepared at `ASK_SEND_MAX_PX[cloud|local]` and sent with their sent sizes; drafts added with `dispatch({ type: 'add', ... , run })` into `aiPassName(runId)`; `noteAssessed`; on failure the run keeps its drafts and lists the items left. `retryAskRun` on a custom cloud run skips the vision route comparison (its route is explicit). A cloud custom run without `confirmed` (and without "Don't ask again") throws as today.
  - `thread.ts`: `askThread: StoreApi<{ key: string | null; turns: { role: 'user' | 'assistant'; text: string }[]; pending: boolean; error: string | null; route: AskRoute | null; confirmed: boolean }>`; `askInThread(o: { projectId: string; manifest: ProjectManifest; item: DetectItem & { kind: 'photo' }; text: string; route: AskRoute; confirmed?: boolean }): Promise<void>` (a new item key resets the thread; the first cloud question needs `confirmed`; follow-ups send `turns`); `answerToDraft(o: { projectId: string; manifest: ProjectManifest; item: DetectItem & { kind: 'photo' }; turn: number }): Promise<string>` (a whole-image draft, note the answer, label `AI answer`, returns its id); `resetThread(): void`.
  - `enAskRun.ts` keys: `askAi.custom.what` "{name}", `askAi.custom.busy`, `askAi.custom.failed` "The request did not finish: {error}", `askAi.thread.draft` "Draft", `askAi.thread.answerLabel` "AI answer", `askAi.custom.untitled` "Custom request".

- [ ] **Step 1: Write failing tests:** `askItemsToDrafts` (scaling on a 4000 x 3000 original, class by default, class by label, fields kept, origin request); `runCustom` with a fake bridge: local run over three photos adds drafts per answer and progresses; a cloud run without confirm throws; `a custom run that fails on item 3 keeps items 1 and 2 and lists the rest`; Stop cancels the current request id; a pair run sends two images labelled with the dates and puts drafts on `after`; retry sends only what is left; thread: first cloud question without confirm throws, a follow-up sends the earlier turns, another photo resets, `answerToDraft` adds a whole-image draft with the answer as note.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/inspect/askAi`; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the folder's tests and `pnpm typecheck`; expect PASS. **Commit** `feat(inspect): run custom requests and threads`.

### Task 14: Fields on suggestions and issues

**Packages:** `apps/desktop` renderer, `@aio/ui` (`enAskFields.ts` only).

**Files:** Create `apps/desktop/src/renderer/inspect/FieldsForm.tsx`, `FieldsForm.test.tsx`, `inspect/fields.css`; Modify `inspect/FindingsPanel.tsx`, `ChangePicker.tsx`, `ReviewQueue.tsx`, `renderer/issueCard/IssueCard.tsx` and their tests; `packages/ui/src/i18n/enAskFields.ts`.

**Interfaces:**

- Consumes: annotate `Detection.fields`, `Issue.fields`, `dispatch` patch of `fields` (Task 5); `formatFieldValue` (Task 9; import from `@aio/project/export` if the renderer may, else a local copy of the same rule in `FieldsForm.tsx`).
- Produces: `FieldsList({ fields }: { fields: readonly FieldValue[] }): ReactElement` (a compact `dl`, label then value with unit) and `FieldsForm({ fields, onChange, readOnly }: { fields: readonly FieldValue[]; onChange: (f: FieldValue[]) => void; readOnly?: boolean }): ReactElement` (number input, text input, yes/no/unknown segmented control, choice select; `data-testid="field-<key>"`). The AI row in `FindingsPanel` shows `FieldsList` and the note under its label; `ChangePicker` shows `FieldsForm` above its lists when the draft has fields and its confirm patches the edited fields before accepting; the review queue card shows `FieldsList`; `IssueCard` shows the issue's fields read-only.
- Keys in `enAskFields.ts`: `fields.title` "Values", `fields.yes` "Yes", `fields.no` "No", `fields.unknown` "Unknown", `fields.none` "Not read", `fields.edit` "Fix the values before you accept".

- [ ] **Step 1: Write failing tests:** `FieldsForm` edits each type and reports the new list; a bad number keeps the old value; `FindingsPanel` AI row shows `Reading 42.5 bar`; ChangePicker confirm with an edited reading creates an issue whose `fields` carry the edit; `IssueCard` lists fields; a read-only package shows them without inputs.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/inspect apps/desktop/src/renderer/issueCard`; expect FAIL.
- [ ] **Step 3: Implement** (load `impeccable` and `frontend-design` first; Inspect's dashed draft style stays).
- [ ] **Step 4: Run**; expect PASS. **Commit** `feat(inspect): show and fix custom fields before accepting`.

### Task 15: Main wiring

**Packages:** `apps/desktop` main.

**Files:** Modify `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/analytics/gate.ts`, `gate.test.ts`.

**Interfaces:**

- Consumes: `createLocalAsk` (Task 11), `agent.ask`, `agent.askStatus` (Task 12), `registerRequestsIpc` (Task 8).
- Produces:
  - `detectLane(...)` gains `othersOnCard?: () => boolean` (a local ask holds the card: photo GPU jobs are refused like during a detector run, and waiting detector runs wait) and returns `idleIfUnused(): void` (stop the server when no detector run is at work, passing or waiting).
  - In `index.ts`: `const localAsk = createLocalAsk({...})` (pack lookup as the gate does, `hardware: (minFreeMb) => checkHardware({ platform: process.platform, exec: execNvidiaSmi, minFreeMb })`, `gpuBusy` true while a GPU pipeline job or a `detect.vlm` job is at work or a detector start is passing the gate), `detectQueue` given `othersOnCard: () => localAsk.active()`; `handle('ai:ask', (req) => req.backend.kind === 'local' ? localAsk.run(req) : agent.ask(req))`; `handle('ai:askStatus', async ({ projectId }) => ({ ...(await agent.askStatus(projectId)), local: await localAsk.status() }))`; `ai:cancel` also calls `localAsk.cancel(runId)`; `registerRequestsIpc` with native dialogs filtered to `.aioreq` (name "Quadrion request" taken from `@aio/brand` the way the `.aiodet` dialogs name theirs).

- [ ] **Step 1: Write failing tests** in `gate.test.ts`: `gpuBusy('photo.process')` refuses while `othersOnCard()` is true; `idleIfUnused()` stops the server only when nothing is at work or waiting.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/analytics/gate.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the lane change and the wiring.
- [ ] **Step 4: Run** `pnpm check`; expect green. Start the app once with `pnpm dev` (off-screen profile as the e2e fixtures do, or a 30 second `electron` smoke via `pnpm --filter desktop exec playwright test e2e/smoke.spec.ts --workers=1`) to see that main starts. **Commit** `feat(analytics): wire custom requests into the app`.

### Task 16: The Ask panel in Inspect

**Packages:** `apps/desktop` renderer, `@aio/ui` (`enAskPanel.ts` only).

**Files:** Create `apps/desktop/src/renderer/inspect/askAi/AskPanel.tsx`, `AskPanel.test.tsx`, `RequestEditor.tsx`, `FieldsEditor.tsx`, `FieldsEditor.test.tsx`, `ThreadView.tsx`, `ThreadView.test.tsx`, `DatePairPicker.tsx`, `askPanel.css`; Modify `AskAiBar.tsx`, `AskAiBar.test.tsx`, `apps/desktop/src/renderer/screens/Inspect.tsx`, `packages/ui/src/i18n/enAskPanel.ts`.

**Interfaces:**

- Consumes: Task 13 (`startAskRun` with `custom`, `askConfirmInfo`, `useAskStatus`, `askThread`, `askInThread`, `answerToDraft`), Task 4 (`routeAsk`, `ASK_MODELS`, `modelLabel`), `requests:*`, `CloudConfirm` component, `useSpotHistory`, `ClassSeverityForm` or the project's class and severity lists.
- Produces:
  - `AskAiBar` gains prop `onCustom: () => void` and a menu item `data-testid="ask-ai-custom"` "Custom request..." after the checks.
  - `Inspect.tsx`: the right panel gains mode `'ask'` rendering `<AskPanel projectId projectRoot manifest current selected all onClose />`; `onCustom` opens it (and opens the panel in a narrow window, as the findings toggle does).
  - `AskPanel(props: { projectId: string; projectRoot: string; manifest: ProjectManifest; current: PhotoPick | null; selected: readonly PhotoPick[]; all: readonly PhotoPick[]; onClose: () => void }): ReactElement`, top to bottom: saved use cases (`data-testid="ask-usecase"` select of project then library entries; New, Save, Save to library, Export, Import, Delete; Save asks for a name inline); kind segmented control Find / Compare dates / Ask (`ask-kind-find|change|ask`); the request textarea (`ask-prompt`, placeholder "find all gauges"); `FieldsEditor` (find and change only); scope (find: This photo, Selected (n), All photos (n); change: `DatePairPicker`; ask: this photo); defaults for accept (class and severity, optional); the model line (`ask-model`: "Runs on Claude Sonnet 5.5" or "Runs on this PC", with an override select listing Auto, This PC, then `ASK_MODELS`, unavailable entries disabled with why); notes: weak offline ("Comparing dates and written answers are weaker on this PC than in the cloud."), keep local ("This project keeps its images on this PC."), nothing can run with a link to Settings; Run (`ask-run`), which shows `CloudConfirm` for a cloud route (honouring "Don't ask again") and otherwise starts at once; for Ask, `ThreadView` replaces Run.
  - `FieldsEditor({ fields, onChange }: { fields: readonly FieldSpec[]; onChange: (f: FieldSpec[]) => void })`: rows of label, type select, choices (comma separated, for choice), unit (for number), remove; Add value (max 12); keys made from labels (`reading`, `in_normal_range`), unique with `_2`.
  - `ThreadView({ projectId, manifest, item, route, onNeedConfirm })`: turns, each answer with a "Draft" chip and "Make a finding" (`thread-make-finding`), a question box (`thread-input`), Send (`thread-send`).
  - `DatePairPicker({ open, onPick })`: from `useSpotHistory(open, true)`, the other survey dates whose first match is a photo, each with its date label and distance; empty with the reason (no position, or no other date).
  - Keys in `enAskPanel.ts` for every visible string above.

- [ ] **Step 1: Write failing tests:** the bar's menu item calls `onCustom`; the panel builds the request from the editor (a reading field gives key `reading`); auto routing shows "Runs on this PC" for a find on this photo when `local.ready`, and Claude Haiku 5.5 for All photos; a cloud run shows the confirm and Send starts `startAskRun` with `custom`; keep-local disables cloud entries; `nothing can run` shows the reason and the Settings link with Run off; `compare dates says why when spot history has no other date`; Save calls `requests:save` with a valid `AiRequest`; picking a saved request fills the editor; ThreadView sends a follow-up and Make a finding calls `answerToDraft`; read-only package: Run, Save and Make a finding off.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/inspect/askAi apps/desktop/src/renderer/screens`; expect FAIL.
- [ ] **Step 3: Implement** (load `impeccable` and `frontend-design` first). The panel must fit the 1100 x 720 window's right column and the narrow drawer; no floating control over the photo view.
- [ ] **Step 4: Run** the tests, `pnpm typecheck` and `pnpm lint`; expect PASS. **Commit** `feat(inspect): custom requests panel`.

### Task 17: End to end, the way CI runs it

**Packages:** `apps/desktop/e2e`.

**Files:** Create `apps/desktop/e2e/custom-analytics.spec.ts`; Modify `apps/desktop/e2e/fake-llm.ts`.

**Interfaces:** Consumes everything above. `fake-llm.ts`: a chat request whose text contains `bbox_2d coordinates normalised to 0-1000` gets `[{"bbox_2d":[100,200,300,500],"label":"item","note":"Fake item.",<fields>}}]` (the `}}` on purpose, so the repair runs end to end) with fields filled by the same rules as the scripted model; one whose text starts with `You help an inspection engineer` gets `Fake answer.`. Export `ASK_BOX_REL = [0.1, 0.2, 0.3, 0.5]`.

Spec header comment says what it proves and its stand-ins. Runs on the change demo (`demoProject`), cloud via the scripted provider, this PC via the fake server, `@realdata` never.

- [ ] **Step 1: Write the tests:**
  - `a find request with a reading runs in the cloud, one suggestion is fixed and accepted, and the issue keeps its values`: Inspect, photo p01, Custom request, prompt "find all patches", a value "Reading" (number, bar), model Claude Haiku 5.5, Run, Send in the confirm, two dashed suggestions with `Reading 42.5 bar`, Change on one, set 40, pick a class, confirm; `issues.json` has an issue with `fields[0].value === 40`; the issue card shows it.
  - `the same request runs on this PC`: `QUADRION_VLM_SERVER_URL` at the fake, override This PC, Run (no confirm), one suggestion whose pass file box is `ASK_BOX_REL` times the photo size within 1 px, and the fake saw `enable_thinking: false` and the bearer key.
  - `comparing two dates sends both photos in one request`: Compare dates, pick the other date, Run on Claude Sonnet 5.5, Send; drafts land on the newer date's photo; the scripted model received two images.
  - `ask, follow up, and make a finding from the answer`: Ask, "Describe the condition", Send, the answer shows with Draft, a follow-up shows the second answer, Make a finding adds a suggestion whose note is the answer.
  - `a project kept on this PC offers no cloud model`: Settings, Privacy and cloud, switch on; back in Inspect the cloud entries are disabled; `window.aio` `ai:ask` with a cloud backend answers `code: 'forbidden'`.
  - `a saved request runs again with one click`: Save as "Patch readings", reload the project, pick it, Run gives the same suggestions.
- [ ] **Step 2: Build demos and run the spec the CI way** from `apps/desktop`:

```powershell
pnpm demo:build --quick --python "<scratch venv>\Scripts\python.exe"
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
$env:QUADRION_E2E_PYTHON = '<scratch venv>\Scripts\python.exe'
npx playwright test e2e/custom-analytics.spec.ts --workers=1 --repeat-each=3
```

Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`; all pass three times.

- [ ] **Step 3: Re-run, the same way, once each:** `smoke.spec.ts`, `agent-local.spec.ts`, `inspect.spec.ts`, `detectors-local.spec.ts`, `detections.spec.ts`, `house-report.spec.ts`, `offline-cloud-ai.spec.ts`, `a11y.spec.ts`, `small-window.spec.ts`. Expected: pass (or skip for the same reason as on `main`).
- [ ] **Step 4: Run** `pnpm check`; expect green. **Commit** `test(e2e): custom analytics end to end`.

### Task 18 (optional, GPU, timebox 2 hours): build the pack, smoke it, re-tune corrosion

**Packages:** `tools/analytics-pack`, `tools/detectors`. Runs only when the graphics card is free (the founder is away tonight) and after Task 17's heavy runs are done.

**Files:** Modify `tools/analytics-pack/README.md` (smoke result); on a go only, `tools/analytics-pack/detectors/plant/corrosion-metal/detector.json`.

- [ ] **Step 1: Build** `node tools/analytics-pack/build.mjs --out apps/desktop/dist --cache <scratch>\analytics-cache` (downloads about 7 GB, every hash checked). Expected: `apps/desktop/dist/analytics-pack-0.2.0-win-x64.tar.gz`.
- [ ] **Step 2: Smoke** `python tools/analytics-pack/smoke.py --server <pack>\llama\llama-server.exe --model <pack>\model\qwen3.5-9b-q4_k_m.gguf --mmproj <pack>\model\mmproj-qwen3.5-9b-f16.gguf --model-id qwen3.5-9b-q4_k_m`. Expected: `SMOKE OK`; write the numbers into the README as the 21 Oct entry does.
- [ ] **Step 3: Re-tune** with `tools/detectors/bench.py` on the reference project listed in `tools/detectors/README.md` (read only, `--split tune` to adjust `looksLike`, `ignore`, `question`, `threshold`; then `--split bench` once). Go: recall at least 0.70 and at most 1 false draft per photo on `bench`. On a go, update the detector (text, threshold, `tunedOn` = new id and sha256, `version` + 1, `updatedAt`), rebuild the pack (Step 1). On a no-go, change nothing: the detector stays experimental, tuned on the old model; write the numbers in the session note.
- [ ] **Step 4: Commit** `chore(analytics-pack): smoke result for 0.2.0` (and the detector on a go).

### Task 19: Cloud AI on by default for new installs

**Packages:** `apps/desktop` main, `apps/desktop/e2e`. Batch 2: no other task touches these files.

**Files:** Modify `apps/desktop/src/main/settings.ts`, `settings.test.ts`, `apps/desktop/e2e/smoke.spec.ts`, `agent-local.spec.ts`, `detections.spec.ts`, `offline-cloud-ai.spec.ts`.

**Interfaces (Produces):** `defaultSettings(dataRoot).cloudAi === true`. `merge(defaults, raw)`: when a stored file exists (`raw` is an object) and has no valid `cloudAi`, the result has `cloudAi: false` (call 18); a stored valid value is kept as today. Only a first start with no `settings.json` gets `true`. The renderer store's placeholder (`renderer/store.ts`, before main's settings arrive) stays `false`.

- [ ] **Step 1: Write failing tests** in `settings.test.ts`: a first start (no file) reads `cloudAi: true`; a stored `cloudAi: false` stays false; a stored file without `cloudAi` (or with `"cloudAi": "yes"`) reads false; a stored `true` stays true.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/main/settings.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Then update the four specs by setting the value explicitly in their setup, never by loosening what they check:
  - `smoke.spec.ts`: the fresh-install check asserts the new default (`expect(settings.cloudAi).toBe(true)`); the zero-network assertions stay as they are (no key is stored, so nothing may leave).
  - `agent-local.spec.ts`: before the local-agent steps, set `cloudAi: false` through `settings:set` (or a pre-written `settings.json` in the spec's data root, as the spec's setup builds its profile), so the existing `toBe(false)` keeps proving the offline preset path.
  - `detections.spec.ts`: set `cloudAi: false` at the start of every test that relies on it being off before line 127's explicit `true` (read the spec; keep its explicit switches).
  - `offline-cloud-ai.spec.ts`: set `cloudAi` explicitly in setup to the value each test's first assertion expects; keep every offline-only assertion.
  - Search the other specs for an assumed default: `rg "cloudAi|cloud-ai-state|Allow cloud AI" apps/desktop/e2e` and fix any further one the same way.
- [ ] **Step 4: Run** `pnpm vitest run apps/desktop/src` (unit tests that build settings from `defaultSettings` may need an explicit `cloudAi`), then the four specs the CI way (`QUADRION_WINDOW_SIZE=1100x720`, `QUADRION_E2E_SCALE=1`, `QUADRION_E2E_SWGL=warp`, `--workers=1`, demos built). Expected: pass.
- [ ] **Step 5: Commit** `feat(settings): cloud AI on by default for new installs`.

## Finish (after Task 17, or Task 18 when it ran)

- [ ] Whole-branch review by a fresh reviewer on the strongest model (correctness of gates and the policy path first, then Review Focus items).
- [ ] `/wrapup` on this branch: session note in `docs/sessions/` ("this PR"), north star section 3; `node tools/agent/check-public-text.mjs` on both.
- [ ] `node tools/agent/finish-task.mjs` (rebases onto local `main` while a batch is open, runs the checks, scans commit messages).
- [ ] SendMessage the coordinator: branch, head SHA, contents, check and e2e results, the two pack numbers (Analytics 0.2.0, pipeline `0.27.0`), which archives sit in `apps/desktop/dist`, and How to test:
  1. Install the new processing tools and the Analytics pack 0.2.0 from Settings, Processing tools, Choose file (both archives in `apps/desktop/dist`), then restart the app.
  2. Open a project with photos, go to Inspect, open a photo with a gauge or a visible defect, open the Ask AI menu and choose Custom request.
  3. Type "find all gauges", add a value "Reading" (number, unit bar) and "In normal range" (yes/no). The model line says it runs on this PC. Run: dashed suggestions appear with their readings.
  4. Change one suggestion, fix its reading, pick a class and severity, confirm. Open the issue: its values are listed. Make a report: a "Recorded values" table lists them.
  5. Choose Compare dates, pick the other survey date, Run: the confirm names Anthropic and a cost; Send; changes appear on the newer photo.
  6. Choose Ask, ask "Describe the condition of the equipment", then "Which is most urgent and why?". Answers are marked Draft. Make a finding from one.
  7. Save the request, reopen the project, run it again from the saved list. Export it and import it into the library.
  8. Settings, Privacy and cloud: turn on "Keep this project's images on this PC". Back in Inspect, cloud models are off and everything runs on this PC.

## Follow-ups (cut from tonight)

- **F1** Qwen3-VL-4B downloaded on demand for cards with less than about 9 GB free (the model table entry exists; needs a pinned download, a progress UI and a chooser).
- **F2** Client Word templates and the report centre (frame section 8).
- **F3** Two-date requests on aligned ortho crops (needs the timeline's aligned extents).
- **F4** Batch APIs for bulk cloud runs and more than one request in flight; cloud spend shown per run after it ends.
- **F5** Saved threads; editing fields on accepted issues; fields in CSV and GeoJSON exports.
- **F7** Fixed detectors and custom requests as one kind; `.aiodet` carrying requests.
- **F8** Google Gemini and Gemma 4 12B for custom requests.

## Risks for the overnight build

- The pipeline pack number is being requested from the coordinator and is filled in before Tasks 2 and 10 start; if it is late, only those two wait.
- The Hugging Face repo for the bench's Qwen3.5 files may not match by hash (Task 3 Step 1 has the fallback); Task 18 downloads about 7 GB.
- `Inspect.tsx`, `runs.ts` and `main.ts` in `@aio/ai` are large shared files; each is owned by one task per batch above, keep edits small.
- The AI SDK option names (`effort`, `reasoningEffort`) and the Haiku 5.5 price are checked at build time, not assumed.
- WARP e2e on the change demo is slow; `--repeat-each=3` on the new spec may take long; run it after the unit work is green, with `--workers=1`.
