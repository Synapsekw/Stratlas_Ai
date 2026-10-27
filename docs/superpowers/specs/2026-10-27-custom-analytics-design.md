# Custom analytics: ask the vision model for what you need

Date: 27 Oct 2026. Status: approved (the founder delegated the remaining decisions on 27 Oct and asked for it to be built overnight). Part of the analysis frame (`2026-10-26-analysis-structure-design.md`), where it plugs into the photo viewer, the one findings list and the report.

## Why

Every new inspection need today means a new detector or a new feature built by us. The founder wants a flexible way of getting analytics done: an inspector writes what they want in plain words ("find all gauges", "read all gauges", "what changed on this spot between these two dates"), shapes what comes back, and gets boxes with explanations and values that go straight into the report. A request that works is saved and reused. The vision model also has to answer well in text, not only draw boxes.

Today the Analytics pack runs Qwen2.5-VL-7B on llama.cpp (`tools/analytics-pack/`, `apps/desktop/src/main/analytics/`, `python/src/aio_pipelines/detect/engine.py`) for fixed detectors only: a "looks like" and an "ignore" prompt per detector, tiling, a yes/no check per box, one image per request, one shipped detector (metal corrosion, experimental). Open requests failed with this model in the spike ("find the defects" gave one box over the whole photo). The planned detector builder (merge 3, shareable `.aiodet` recipes) is the closest existing piece.

## What the model tests showed (27 Oct 2026)

A private benchmark on this workstation (RTX 5070 Ti, 16 GB) compared local and cloud models on five tasks: find gauges, read gauges, two-date changes on photo pairs and on aligned ortho crops, metal corrosion, and text answers (describe, follow up, write a report finding). Gauge photos were public (no project photo shows a gauge); the change pairs and corrosion photos came from projects. Scores for change and text were judged by eye by a Claude model, so they may lean toward the Claude models; samples are small.

| Model                       | Gauges read within 5% (of 12) | Ortho changes found (of 14) | Photo-pair changes (of 18) | Text (of 5)          | Cost per image |
| --------------------------- | ----------------------------- | --------------------------- | -------------------------- | -------------------- | -------------- |
| Claude Opus 5.5             | 12                            | 11                          | 11 (15 at medium effort)   | 4.9                  | $0.025         |
| Claude Sonnet 5.5           | 12                            | 10                          | 14                         | 4.6                  | $0.011         |
| GPT-6.1 sol                 | 10                            | 11                          | 14                         | 4.4                  | $0.009         |
| Claude Haiku 5.5            | 11                            | 7                           | 9                          | 3.9                  | $0.0007        |
| GPT-6 luna                  | 10                            | 6                           | 6                          | 3.4                  | $0.0005        |
| Qwen3.5-9B (local, 6.8 GB)  | 9                             | 2                           | 4                          | 3.0                  | free           |
| Gemma 4 12B (local, 9.1 GB) | 3                             | 7                           | 11                         | 3.25                 | free           |
| Qwen3-VL-4B (local, 5.2 GB) | 8                             | 4                           | –                          | weaker, invents more | free           |
| Qwen2.5-VL-7B (today)       | 3                             | 0                           | 0                          | 2.1                  | free           |

Finding gauges was equal everywhere (F1 0.93 to 1.0). Local models can find and count, and read reasonably; they are not reliable at changes or report text (repeated boxes, invented changes, everything "Critical"). Corrosion was weak for every model (cloud best F1 0.34, local at most 0.10). Kimi-VL was unusable; Kimi K3.1 Pro needs a paid subscription and was not tested; MBZUAI's vision models are medical or older and were not tested.

## Goals

1. **A request in plain words.** The inspector types what they want. The request is free text; the app adds the box and output format instructions for the chosen model.
2. **Customisable output.** A request defines fields per found item (for gauges: reading, unit, gauge type, in normal range; for changes: kind of change, what, note), with a type per field (number, text, yes/no/unknown, a list of choices). Every item also has a box and a short explanation.
3. **Scopes:** this photo, a selection, a whole dataset, and **two dates of the same spot** (two photos, or two ortho crops of the same area). Two-date requests send both images in one request.
4. **Results are suggestions.** They arrive dashed in Inspect's style with their fields shown, and a person accepts, fixes or dismisses each one. Accepted items become findings with their fields and text. Text answers are drafts too.
5. **Into the report.** Fields become table columns and the explanation becomes the finding's text, in our templates and in a client's Word template.
6. **Saved use cases.** A request that works is saved with its fields, scope and model choice, run again with one click and shared. The detector builder (merge 3) grows into this: fixed detectors and custom requests are the same kind of thing.
7. **Ask and follow up.** A free question about a photo, with follow-ups in the same thread ("which is most urgent and why?", "write this as a report finding"). The answer can be turned into a finding.

## Non-goals

- Training or fine-tuning models.
- Video.
- Arabic output (AIN was not tested; revisit if a client needs it).
- Replacing the 3D change detection or volume tools; this is image-level.

## Anti-goals

- **Model output reaching a report unaccepted.** Boxes, fields and text all wait for a person.
- **Client images leaving the PC against the project's wish.** A project switched to "keep images on this PC" never sends to the cloud, and every cloud run is confirmed.
- **A model or backend question on every request.** Routing picks the model; the inspector can override.
- **A second place for findings.** Results join the one findings list from the frame.

## Decided by the founder

- Inspectors type free requests, and what comes back is customisable; the intent is a flexible way of getting analytics done.
- Two photos of the same spot on different dates is the change use case; orthos are fine to use.
- The model must answer well in text.
- Direction (27 Oct): Qwen3.5-9B on the PC as the default for offline work and find-and-count requests; the cloud, Haiku 5.5 for bulk and Sonnet 5.5 for change explanations and report text. Cloud is on by default and a client can have it turned off per project (27 Oct).

## Models and routing

- **Local default:** Qwen3.5-9B Q4_K_M, thinking off, replacing Qwen2.5-VL-7B in the Analytics pack. _My call:_ on cards with less than about 9 GB free the app uses Qwen3-VL-4B instead, so the 8 GB minimum stays. Both run on the pack's llama.cpp build. Gemma 4 12B is better at changes locally but needs 9 GB and is slow; not shipped.
- **Cloud, on by default, off per project** (founder, 27 Oct: "cloud should be on by default and customer can turn it off if they want"): today's rules stay. The app-wide cloud setting is on, and a project the client wants kept local is switched off through its existing policy (`aiPolicy: forbid`), surfaced as a plain "Keep this project's images on this PC" switch in the project's settings. Providers use the keys the app already keeps in Windows Credential Manager. Models: Claude Haiku 5.5 (bulk), Claude Sonnet 5.5 (changes and text), and _my call_ Claude Opus 5.5 as "best quality" and OpenAI (GPT-6.1 sol, GPT-6 luna) as a second provider. Inspect's confirm-before-sending step stays for every cloud run.
- **Routing** (_my call_): with the cloud off, everything runs locally and the app says plainly that two-date comparison and report text are weaker offline. With the cloud on, a saved use case carries a default model; free requests go by kind: find and count locally, changes and text to Sonnet, bulk over a dataset to Haiku. The inspector can override per run.
- **Model notes from the bench, for the builder:** Qwen3 models return 0 to 1000 relative boxes and list runaway repeats; Qwen2.5-VL returns pixels; Gemma returns `[y1,x1,y2,x2]` in 0 to 1000; Claude models are asked for pixel boxes on an image resized to at most 1568 px on the long edge. Send the full image for gauges (2x2 tiling halved precision). Thinking on Qwen3.5 used its whole budget and left answers empty; keep it off. Claude Opus 5.5 cannot turn thinking off; use effort low (medium for changes). Gemma 4 12B on llama-server needs `-ub 2048`.

## How it fits what exists (_my calls_ after the builder check)

- **It extends Inspect's Ask AI, not a new path.** Ask AI (`renderer/inspect/askAi/`) already has a Settings default (Automatic, Local only, Cloud), the person's own local model server, the cloud providers in `@aio/ai` and `CloudConfirm`. Custom requests become what Ask AI sends; the Analytics pack becomes its local backend; the routing above replaces Automatic's order.
- **First release ships on today's Issues register and reports.** Accepted items become issues with their custom fields, and the existing report shows the fields as a table. Client Word templates wait for the report centre (frame section 8); the one findings list follows the frame. Follow-up questions ship in the first release (a thread on one photo). Two-date requests start with photo pairs from spot history; ortho crops follow once the timeline gives aligned extents.
- **Class and severity at accept.** The person picks them when accepting, with the use case's defaults (or the last choice) filled in, as Inspect does today. Custom fields are stored on the finding as a typed extension (name, type, value): a contract change with a row in `docs/architecture/contract-changes.md`.
- **If the corrosion re-tune fails,** custom requests still switch to Qwen3.5-9B; the corrosion detector stays marked experimental (it was weak on every model) and is retuned later. The model switch does not wait on it.
- **The 4B fallback downloads on demand,** only on cards that need it, so it does not add to the pack.

## Guards

Whatever model answers:

- duplicate boxes are merged and the box count is capped per image;
- whole-frame boxes are dropped unless the request asks for the whole image;
- invalid JSON is retried once, then reported, never dropped silently (the earlier `}}` parser bug lost answers without a word);
- severity comes from the project's one scale, set by the person, not from the model's wording;
- text answers are labelled as drafts until accepted.

## Before switching the default model

The corrosion detector is re-tuned on Qwen3.5-9B: the newer models return 3 to 10 times more boxes on today's prompt. The detector bench (`tools/detectors/bench.py`) is the go/no-go.

## Left to the builder

- The request editor's layout and the field type list beyond the ones above.
- How saved use cases are stored and shared (extending `.aiodet` is the expected route).
- How two-date pairs are found (spot history and the timeline match photos by place; ortho crops by extent).
- Prompt wording per model family.
- Where cloud spend is shown.

## Open points

- The Analytics pack size grows with Qwen3.5-9B plus the 4B fallback; the 7 to 8 GB budget is still to be confirmed by the founder.
- Whether bulk cloud runs go through each provider's batch API (half price, slower) when the inspector is not waiting.
