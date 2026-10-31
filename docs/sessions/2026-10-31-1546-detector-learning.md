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
- The examples are picked in main when a run starts (`main/analytics/fewShot.ts`, from the `detect.vlm` gate), first the detector's own curated `examples`, then the local review ledger, lines of the detector's current version and of the run's model only: an accepted candidate whose box was not corrected is an "is" crop, a rejected one is an "is not" crop when its reason says it is not the thing (looks like but is not, not a defect, wrong class, or no reason; "box wrong" and "other" are left out). Crops from the open project's folder come first (matched by its absolute path), then the newest. The same ledger always gives the same set. So a rejection is used as an "is not" example on the next run.
- Examples go only to processing tools from `DETECT_EXAMPLES_MIN_PACK` (0.33.0, one constant in `detectPack.ts`); an older pack runs exactly as before, and `DETECT_MIN_PACK` stays 0.28.0. They are on by default.
- Each run that sends examples is recorded in the ledger folder (`runs/<run>.json`), and main stamps each review line with `fewShot` (from the reviewed draft's pass) and the project's folder. The suggested threshold uses reviews of runs like the next one (with examples when examples will be sent) once there are 20 scored ones, and every review until then, saying so in the status. `estimateMinutes` allows 1.5 times as long for a detector with examples.
- The job (`detect/fewshot.py`) checks the list (absolute files, at most 2 per verdict), reads each crop once per run at no more than 448 px, logs "the yes/no check shows the model 1 is, 1 is not example crops", and leaves out a crop it cannot read with a warning. Examples go first in the message, so the model server can reuse them across the checks of a run. Edits to `engine.py` and `pipeline.py` are a few lines (a `parts` option on the client, an `examples` argument through `run_detector`).
- Settings > Models and detection > Detector library, in each row's reviews cell:
  - a status: "Applied threshold 0.85 in use" whenever one is applied (even with no reviews), then "6 more scored reviews before a threshold is suggested" (main's count of scored reviews), "Suggested threshold 0.85, in use 0.80" (with "from all reviews" when it is the fallback), "Suggested threshold 0.85 is in use" or "Learning from reviews is off";
  - **Apply suggested threshold** when the suggestion differs: main works it out again (`ledger:applyThreshold`) and keeps it per detector id on this computer (`<userData>/detector-thresholds.json`); `detectors:list` reports the detector with it, so the next run and the review use it, shipped detectors too;
  - **Use the detector's own threshold** (`ledger:resetThreshold`) whenever one is applied; clearing the review history and removing the detector drop it as well;
  - a **Learn from my reviews** switch (`ledger:setLearn`, on by default, kept in the same file): off means no example crops in the detector's runs and no suggestion.
  - A file that cannot be read is moved aside to `.bak-<time>` with a warning in the app log, never overwritten silently. New error messages come from the `detect.learn.err.*` keys.
- `tools/detectors/bench.py` takes `--example is=<crop>` / `--example is-not=<crop>` and reports `examples`.
- Contract row: `DetectVlmParams.detectors[].examples?`; `LedgerEntry.pass`, `fewShot` and `projectDir`; the new `ledger:stats` fields; the `ledger:applyThreshold`, `ledger:resetThreshold` and `ledger:setLearn` channels; the applied threshold in `detectors:list`. Pipeline pack 0.33.0 in the last commit (pack files only), so the number can change with `DETECT_EXAMPLES_MIN_PACK`.

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

1. With an older pipeline pack installed (0.32.0 or earlier), run the corrosion detector in Inspect: it runs as before, and the job log has no line about example crops.
2. Install pipeline pack 0.33.0 (Settings > Processing tools > Choose file).
3. In Inspect, run the corrosion detector on a few photos, then reject two drafts as "Looks like but is not" and accept two.
4. Run the detector again on other photos. In the job log, the detect step says "the yes/no check shows the model 2 is, 2 is not example crops". Drafts that look like the rejected ones may now score lower (not measured on the real model yet).
5. Open Settings > Models and detection. In the Detector library, the corrosion row shows "16 more scored reviews before a threshold is suggested" and **Learn from my reviews**, ticked.
6. Review until at least 20 scored drafts are accepted or rejected. The row shows "Suggested threshold X, in use 0.80" (perhaps with "from all reviews") and **Apply suggested threshold**.
7. Click it. A note says "Threshold X applied. The next run uses it."; the status reads "Applied threshold X in use", and **Use the detector's own threshold** appears. The next run marks drafts under X as below the threshold.
8. Click **Use the detector's own threshold**. The note says the detector's own threshold is back, and the button goes.
9. Untick **Learn from my reviews**. The status reads "Learning from reviews is off", the apply button goes, and the next run's job log has no example-crop line. Tick it again to turn learning back on.

## Open threads

- Real-model check: bench corrosion (or a small-object detector) on Qwen3.5 with and without `--example` once there is reviewed truth.
- The regime of the next run in `ledger:stats` is an estimate (learning on, a new enough pack and any reviewed crop that could be an example); the gate's exact pick also checks the detector version, the model and the files.
- `estimateMinutes` has the examples factor, but the Detect dialog shows no time estimate yet.
- Examples are crops of the box the model proposed; an accepted draft whose box was corrected is not used, since its crop shows the wrong box.

## Next session entry point

The merge coordinator lands this branch; the pack number may change to 0.32.0 in the last commit (pack files and `DETECT_EXAMPLES_MIN_PACK`).
