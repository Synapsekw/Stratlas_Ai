---
type: session
date: 2026-10-21-2326
branch: feat/vlm-detectors-m1
status: complete
related:
  [
    2026-10-21-1628-local-vlm-detectors-design.md,
    ../superpowers/specs/2026-10-17-local-vlm-detectors-design.md,
    ../superpowers/plans/2026-10-17-local-vlm-detectors-merge1.md,
  ]
---

# Local vision-model detectors, merge 1

## What changed

- This PR builds merge 1 of the plan: schema and contracts, the Python detector engine and the resumable `detect.vlm` job, the Analytics pack builder (llama.cpp b11489 with CUDA 13.4, Qwen2.5-VL-7B Q4_K_M), the pack installer for two kinds, the NVIDIA memory check, the model server and the `jobs:start` gate, the detector library with `.aiodet` import and export, the local review ledger, the bench and an e2e spec.
- Founder decisions of 21 Oct: the model unloads as soon as the last detector run ends, detector runs wait behind photo processing jobs, and a low-memory message names the 3D view.
- The model server listens on 127.0.0.1 only, gets a per-launch key in the environment (not on the command line), and a server left behind by a crash is cleaned up at the next start.
- A build fix: electron-vite's CommonJS shim was placed inside a string, and the main bundle came out empty with no error. A build plugin now places it after the imports and fails the build on an empty main chunk.
- One shipped detector, corrosion on metal, marked experimental. The pack measures 6.21 GB archived and 6.78 GB unpacked; the budget is 7 GB and 8 GB.

## Why

The founder wants offline detector presets that flag first findings for a person to verify. Merge 1 is the engine underneath; the screens come in merge 2.

## How to test

No user-facing behaviour to test yet; the Analytics pack section in Settings and the run dialog come in merge 2. Covered by unit tests, `apps/desktop/e2e/detectors-local.spec.ts` and the GPU smoke check in `tools/analytics-pack/README.md`.

## Open threads

- Release: python/ changed, so the next release needs a pipeline pack bump. The analytics schemas say since 0.25, while main's thermal schemas say since 0.26; align them at the release.
- Merge 2 first: the hardware check against what the CUDA 13.4 build can run, a minimum pipeline pack for `detect.vlm`, server timeouts, licence texts in the pack, a cancel for queued runs, and holding photo jobs while a detector run uses the card.
- Founder: review the corrosion detector's flare false alarms (bench sheets on the build machine). On the flare tune split it found 2 of 7 reviewed rust boxes, with 1.5 drafts per photo, mostly boxing the rust-brown flare tip.
- `tools/analytics-pack/test_smoke.py` and `tools/detectors/test_bench.py` are not collected by any CI job.

## Next session entry point

Plan merge 2 from the spec's UI sections. Start with the Analytics pack section in Settings next to Processing tools.
