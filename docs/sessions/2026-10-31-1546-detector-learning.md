---
type: session
date: 2026-10-31-1546
branch: feat/detector-learning
status: complete
related: [../plans/2026-10-31-detector-learning.md, ../plans/2026-10-30-intelligence-review.md]
---

# Detector learning: few-shot crops and an applied threshold

## What changed

- This PR shows the local detector's yes/no check a few example crops before the crop it judges: at most 2 "is" and 2 "is not" per detector. With no examples the check is exactly as before. The detect prompt is unchanged.
- The examples are picked in main when a run starts (`main/analytics/fewShot.ts`, from the `detect.vlm` gate), first the detector's own curated `examples`, then the local review ledger: an accepted candidate whose box was not corrected is an "is" crop, a rejected one is an "is not" crop when its reason says it is not the thing (looks like but is not, not a defect, wrong class, or no reason; "box wrong" and "other" are left out). The open project's crops come first, then the newest. The same ledger always gives the same set. So a rejection is used as an "is not" example on the next run.
- The job (`detect/fewshot.py`) checks the list (absolute files, at most 2 per verdict), reads each crop once per run at no more than 448 px, logs "the yes/no check shows the model 1 is, 1 is not example crops", and leaves out a crop it cannot read with a warning. Examples go first in the message, so the model server can reuse them across the checks of a run. Edits to `engine.py` and `pipeline.py` are a few lines (a `parts` option on the client, an `examples` argument through `run_detector`).
- Settings > Models and detection > Detector library: each row with reviews gets a learning status under its stats ("7 of 20 reviews before a threshold is suggested", "Suggested threshold 0.85, in use 0.80" or "Suggested threshold 0.85 is in use") and **Apply suggested threshold** when the suggestion differs. Main works the suggestion out again (`ledger:applyThreshold`) and keeps it per detector id on this computer (`<userData>/detector-thresholds.json`); `detectors:list` reports the detector with it, so the next run and the review use it. It works for shipped detectors too. Nothing is applied without the click; clearing review history keeps an applied threshold. The suggestion moved out of the stats line into the status.
- `tools/detectors/bench.py` takes `--example is=<crop>` / `--example is-not=<crop>` and reports `examples`.
- Contract row: `DetectVlmParams.detectors[].examples?`, the `ledger:applyThreshold` channel and the applied threshold in `detectors:list`. Pipeline pack 0.30.0 and `DETECT_MIN_PACK` 0.30.0 (an older pack refuses the new key), in the last commit so the number can change.

## Bench, before and after (fake model server)

A synthetic set in the scratchpad: 24 bench photos, 16 true defects and 12 look-alike decoys. The fake detector finds every square; the fake verifier answers yes to all of them without examples and goes by the nearest example crop with them. One accepted crop and one rejected crop as examples:

| Run                    | Drafts | TP  | FP  | FN  | Precision | Recall | F1   |
| ---------------------- | ------ | --- | --- | --- | --------- | ------ | ---- |
| Before (no examples)   | 28     | 16  | 12  | 0   | 0.57      | 1.00   | 0.73 |
| After (1 is, 1 is not) | 16     | 16  | 0   | 0   | 1.00      | 1.00   | 1.00 |

This shows the crops reach the model and the bench sees the change. It says nothing about real accuracy: no real model ran. The corrosion detector was not re-tuned or re-benched (deferred to the asset inspection focus).

## Why

Intelligence review, vision items 3.3 and 3.4: reviews were logged but only fed a threshold that was shown and never used, and detector examples were stored but never sent to the model.

## How to test

1. Install pipeline pack 0.30.0 (Settings > Processing tools > Choose file).
2. In Inspect, run the corrosion detector on a few photos, then reject two drafts as "Looks like but is not" and accept two.
3. Run the detector again on other photos. In the job log, the detect step says "the yes/no check shows the model 2 is, 2 is not example crops". Drafts that look like the rejected ones may now score lower (not measured on the real model yet).
4. Open Settings > Models and detection. In the Detector library, the corrosion row shows "4 of 20 reviews before a threshold is suggested".
5. Review until at least 20 scored drafts are accepted or rejected. The row shows "Suggested threshold X, in use 0.80" and **Apply suggested threshold**.
6. Click it. A note says "Threshold X applied. The next run uses it."; the status reads "Suggested threshold X is in use" and the button goes. The next run marks drafts under X as below the threshold.

## Open threads

- Real-model check: bench corrosion (or a small-object detector) on Qwen3.5 with and without `--example` once there is reviewed truth.
- No way to undo an applied threshold from the UI yet (apply a newer suggestion, or delete `detector-thresholds.json`).
- Examples are crops of the box the model proposed; an accepted draft whose box was corrected is not used, since its crop shows the wrong box.

## Next session entry point

The merge coordinator lands this branch; the pack number may change to 0.29.0 in the last commit.
