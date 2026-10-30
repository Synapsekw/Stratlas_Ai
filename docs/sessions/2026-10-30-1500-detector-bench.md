---
type: session
date: 2026-10-30-1500
branch: feat/detector-bench
status: complete
related:
  - plans/2026-10-30-detector-bench.md
---

# An honest detector bench

## What changed

- This PR makes `tools/detectors/bench.py` match drafts to truth by IoU (at least 0.3 by default, `--iou`), one to one and greedy in score order, and report precision, recall and F1 per detector and per class. The old centre-contains rule, which rewards huge boxes, stays as a `centreRule` block for comparison.
- Every run writes a PR curve over score thresholds (`pr.csv`, `pr.json`, 0.00 to 1.00 in steps of 0.05), the model id it ran with and a dataset hash. `--project` may repeat to bench several reference projects at once.
- Stored references: `tools/detectors/references/<detector id>.json` (`aio.detector-bench-ref/1`: detector id and version, model, date, dataset hash, metrics). `--write-reference` writes one, `--compare` flags a drop in precision, recall or F1 beyond `--tolerance` (0.05) and exits 1.
- `tools/detectors/prerelease.py` benches every shipped detector against its reference when a dataset is given, prints `skipped: no dataset` and exits 0 when not, and always warns about a stale `tunedOn` (the corrosion detector still names Qwen2.5-VL while the pack ships Qwen3.5-9B). Documented in `tools/detectors/README.md` and the Analytics pack README.
- The corrosion reference is committed with `metrics: null`: the 29 Oct run had no reviewed corrosion truth in the bench split, so there is no honest number to store yet. The detector itself is unchanged (re-tuning waits for the asset inspection work). The detect engine is not touched.
- Checks: `pytest tools/detectors` 46 passed (metric tests on synthetic boxes, bench tests on the fake llama-server, pre-release tests with the bench stubbed); an independent review's eight findings are fixed (unmeasured metrics regress, no baseline from a failed compare, settings must match the reference, stricter truth dedup, explicit `unclassified`, duplicate project names refused, crashes exit 2); `pnpm check` green. No real model ran and nothing was downloaded. No e2e, contract or pack change; the new reference id is listed in `NOT_FILE_SCHEMAS` (`packages/schema/src/versions.ts`) as a tool-only format.

## Why

The bench decides which detectors ship as verified, and a rule that counts a box over the whole photo as finding everything under it cannot make that call. The study (vision, items 3.2 and 3.5) asked for honest metrics and a pre-release check with stored results.

## How to test

Nothing is user-facing. For a developer check:

1. `uv run --project python pytest tools/detectors`: all pass.
2. `uv run --project python python tools/detectors/prerelease.py`: prints the stale `tunedOn` warning for `corrosion-metal`, "the stored reference has no metrics yet" and `corrosion-metal: skipped: no dataset`, and exits 0.

## Open threads

- Write the first real corrosion reference (`prerelease.py --dataset ... --server ... --update-references`) once there is enough reviewed corrosion truth, after the detector is re-tuned on Qwen3.5.
- The pre-release check is documented for the release flow but not wired into `tools/analytics-pack/build.mjs` (the build runs in CI, which has no reference data).

## Next session entry point

The merge coordinator lands this branch on local `main`.
