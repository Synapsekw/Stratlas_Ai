---
type: session
date: 2026-10-21-1628
branch: docs/local-vlm-detectors
status: complete
related:
  [
    ../superpowers/specs/2026-10-17-local-vlm-detectors-design.md,
    ../superpowers/plans/2026-10-17-local-vlm-detectors-merge1.md,
  ]
---

# Local vision-model detectors: design and merge 1 plan

## What changed

- Spike: Qwen2.5-VL-7B (Q4, about 6 GB of video memory) on the reference chimney project. Open-ended anomaly prompts were not useful; a fixed per-class prompt with 2 x 2 overlapping tiles, a box merge and a yes/no crop check scored from token probabilities gave usable first-pass drafts at about 5 to 8 s per photo per detector.
- Spec (this PR): an Analytics pack installed from an archive like the pipeline pack, a local `llama-server` on 127.0.0.1, detectors as `aio.vlm-detector/1` files (shipped, project, library, shareable `.aiodet`), runs started only by a person, drafts reviewed like AI detections, a local accept/reject ledger, NVIDIA with 8 GB or more only in v1 (no Mac).
- Merge 1 plan (this PR): schema, Python engine and `detect.vlm` job, pack builder, pack install, hardware check, server lifecycle, detector storage, ledger, bench harness, e2e and docs; no UI.
- Found: the model returns absolute pixels of the sent image even when asked for 0 to 1 fractions, so the cloud `detect-v2` prompt cannot be reused as is.

## Why

The founder wants offline detector presets (a corrosion detector, for example) that flag first findings for a person to verify, to cut time to report. This reverses the "nothing bundled" M8 decision for the Analytics pack only.

## How to test

No user-facing behaviour to test; covered by the test suite.

## Open threads

- Not scheduled: the founder said it is not needed for the current builds.
- The plan's Task 4 names pipeline pack 0.16.0, which is taken; use the next free version.
- Built-in detector sets (facade and flare first, then chimney and roads) need benchmarks from the founder's reference projects, which stay outside the repository.

## Next session entry point

When scheduled, start merge 1 at Task 1 (the `llama-server` check on an NVIDIA card) in a fresh worktree from `main`.
