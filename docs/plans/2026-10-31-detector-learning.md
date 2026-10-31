# Detector learning loop (roadmap V2)

Source: `docs/design/intelligence-review-2026-10/vision.md`, items 3.3 and 3.4 (3.2, re-tuning corrosion, is out of scope: deferred to the asset inspection focus). Branch `feat/detector-learning`.

## Goal

Reviews turn into accuracy without new weights:

1. The yes/no check of a `detect.vlm` run shows the model a few "is" and "is not" example crops before the crop it judges.
2. A rejected candidate's crop (already kept by the review ledger) becomes an "is not" example on the next run.
3. After 20 or more scored reviews the ledger's suggested threshold can be applied by the user, never silently.

## Decisions (made here, no questions asked)

- **Where examples come from.** The app picks them when a run starts (the `detect.vlm` gate in main), from two sources, in this order:
  1. the detector's own curated `examples` (`examples/<file>` in its folder, file order);
  2. the local review ledger of that detector id: an accepted candidate whose box was not corrected is an "is" crop; a rejected one is an "is not" crop when its reason says the object is not the thing (`looks-like-but-is-not`, `not-a-defect`, `wrong-class`, or no reason). `box-wrong` and `other` are not examples. Only the latest verdict per candidate counts (as for the threshold).
- **Bounded and deterministic.** At most 2 "is" and 2 "is not" crops per detector (vision: 2 to 4). Ledger crops of the open project come first, then the newest (`at`, then the crop number), so the same ledger always gives the same set. The job refuses more than 2 per verdict, scales each crop to at most 448 px and skips (with a warning) a file it cannot read.
- **Only the yes/no check gets examples.** The detect prompt is unchanged (brief). With no examples the check call is byte for byte what it was. With examples one user message carries: the "yes" crops, the "no" crops, then the crop to judge and the question. Examples go first so llama-server's prompt cache reuses them across a photo's checks.
- **Params.** Each `detect.vlm` detector item may carry `examples: [{file, verdict}]` (absolute paths). Main fills it; the renderer never sends it. Pipeline pack 0.33.0 accepts it; an older pack refuses the key, so main sends it only to 0.33.0 or newer (`DETECT_EXAMPLES_MIN_PACK`; `DETECT_MIN_PACK` stays 0.28.0).
- **Applying the threshold.** A per-computer applied threshold, keyed by detector id (the ledger's own scope), stored in `<userData>/detector-thresholds.json`. `ledger:applyThreshold {detectorId}` recomputes the suggestion in main (never trusts a number from the window) and stores it; `detectors:list` reports a detector's threshold with the applied one in place, so every run, the review queue and the Detect dialog use it. Shipped detectors cannot be edited inside the pack, so one mechanism serves all three groups. Clearing review history keeps an applied threshold.
- **UI.** Settings > Models and detection > Detector library: each row's review cell gets a small learning status ("12 of 20 reviews before a threshold is suggested", or "Suggested threshold 0.85, now 0.80") and an **Apply suggested threshold** button when the suggestion differs from the threshold in use. The suggestion leaves the old stats line. New CSS in `detectorLearning.css`.

## Tasks

| #   | Task                                                                                                                                                 | Tests                                                             | Packages                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------- |
| 1   | Python `detect/fewshot.py`: validate the `examples` param, load and shrink crops, build the check message parts                                      | `python/tests/test_detect_fewshot.py`                             | python                        |
| 2   | Engine and pipeline wiring: `VlmClient.chat(parts=...)`, `run_detector(examples=...)`, item key `examples`, loaded once per detector per run, logged | `test_detect_fewshot.py` (engine + job with the fake server)      | python                        |
| 3   | Bench: `--example VERDICT=PATH` in `tools/detectors/bench.py`; before/after run on a synthetic set with a fake server                                | `tools/detectors/test_bench.py`                                   | tools                         |
| 4   | Main `analytics/fewShot.ts`: pick examples from the detector folder and the ledger; gate fills `examples` per item                                   | `fewShot.test.ts`, `gate.test.ts`                                 | desktop main, schema          |
| 5   | Main applied thresholds: `analytics/thresholds.ts`, `ledger:applyThreshold`, `detectors:list` applies it                                             | `thresholds.test.ts`, `ledgerIpc.test.ts`, `detectorsIpc.test.ts` | desktop main, schema, preload |
| 6   | UI `DetectorLearning.tsx` in the library row; i18n keys in `detect` area                                                                             | `DetectorLibrary.test.tsx` (learning cases)                       | desktop renderer, ui i18n     |
| 7   | Pack bump 0.33.0, pack files only (last, separate commit)                                                                                            | `detectPack.test.ts`, `jobsStart.test.ts`                         | python, desktop main          |

No e2e spec: the new UI is one status line and a button inside an existing section, covered by component tests; a run with examples needs the model server, which e2e fakes only for the whole job.

Contract changes: `DetectVlmParams.detectors[].examples?`, IPC `ledger:applyThreshold`, `detectors:list` threshold now reflects an applied threshold. One row in `docs/architecture/contract-changes.md`.

## Execution DAG

- Batch A (parallel, no shared files): 1, 4, 5.
- Batch B: 2 (after 1), 6 (after 5).
- Batch C: 3 (after 2).
- Batch D: 7 (after all).

Critical path: 1 → 2 → 3 → 7.

## Review follow-ups (decided by the merge coordinator)

- An applied threshold can be undone (`ledger:resetThreshold`, **Use the detector's own threshold**); `ledger:clear` and removing the detector drop it too. The status says when one is in use, with or without reviews.
- Calibration: main records which runs sent examples (`detector-ledger/runs/<run>.json`) and stamps each review line with `fewShot` and the project's folder. The suggestion uses reviews of runs like the next one once there are 20, else all reviews, and the status says which. The count toward 20 is main's scored count. `estimateMinutes` has an examples factor (1.5).
- A per-detector **Learn from my reviews** switch (on by default) turns off the examples and the suggestion; stored in `detector-thresholds.json` (`learnOff`).
- `DETECT_MIN_PACK` stays 0.28.0. Examples go only to processing tools from `DETECT_EXAMPLES_MIN_PACK` (0.33.0); older packs run as before. The pack bump commit holds only the pack files.
- An unreadable `detector-thresholds.json` is moved aside to `.bak-<time>` with a warning before a write.
- Few-shot picks use only ledger lines of the detector's current version and the run's model; "open project first" compares absolute folders. New main error messages are `detect.learn.err.*` keys.
