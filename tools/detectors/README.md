# Detector bench

Developer command that runs one vision-model detector (`aio.vlm-detector/1`) over reference projects'
photos with the real engine, and measures precision, recall and F1 against the projects' reviewed
findings. It decides which detectors ship as "verified".

```
uv run --project python python tools/detectors/bench.py \
  --project <dir> [--project <dir>...] --detector <detector.json> --server <url> \
  --split tune|bench [--truth-class <id>...] [--threshold 0.8] [--iou 0.3] [--limit 50] \
  [--model <id>] [--api-key <key>] [--compare <ref.json>] [--tolerance 0.05] \
  [--write-reference <ref.json>] --out <dir>
```

- `--server` is a running `llama-server` (loopback). `--api-key` defaults to the `LLAMA_API_KEY`
  environment variable.
- `--model` is the model id and picks the box frame: a Qwen3 model (`qwen3.5-...`, `qwen3-vl-...`)
  answers `bbox_2d` in 0 to 1000 of the sent image, anything else (Qwen2.5-VL) in sent pixels. Without it
  the bench asks `GET /v1/models` of `--server` and falls back to pixels. The model id goes into the
  report and the reference.
- `--project` may repeat. `--limit` caps the photos per project, read in id order. With several
  projects a photo key is `<project folder>/<photo id>`, so two projects with the same folder name are
  refused.
- Split: a photo is in `tune` when `int(sha1(photo_id).hexdigest(), 16) % 10 < 3`, otherwise in
  `bench`. Tune the detector text on `tune`; measure on `bench`.
- Truth: image sightings of issues (box, rotated box or polygon bounds) and accepted detections in
  `detections/*.json`, filtered by `--truth-class`, each with its class (`unclassified` when it has
  none). An accepted detection that overlaps an issue of the same class with an IoU of at least 0.5 is
  the same finding and counts once; two issues, or items of different classes, are never merged. Truth
  on photos outside the split is skipped.

## Matching

`metrics.py` holds the maths, tested on synthetic boxes in `test_metrics.py`.

- A draft at or above `--threshold` is a true positive when it takes a truth item on its photo with an
  IoU of at least `--iou` (default 0.3). Matching is one to one and greedy in score order: drafts are
  taken from the highest score down, and each takes the free truth item with the highest IoU. A second
  draft on the same truth item is a false draft.
- Because the order is the score order, one matching pass serves every threshold, so the PR curve
  agrees with the headline numbers.
- Per class: a matched draft counts for the class of the truth item it matched; an unmatched draft is a
  false draft of the detector's own `classId`.
- The old rule (a draft whose box contains a truth item's centre) is kept as `centreRule` for
  comparison. It rewards huge boxes: one box over the whole photo finds everything under it.

## Output

- `report.json`: detector id and version, model, split, threshold, `iouMin`, truth classes, `photos`,
  `truth`, `tp`, `fp`, `fn`, `precision`, `recall`, `f1`, `found` (same as `tp`), `drafts`,
  `draftsPerPhoto`, `unmatchedDrafts` (same as `fp`), `perClass`, `centreRule` (`found`, `recall`,
  `precision`, `unmatchedDrafts`), `failedPhotos`, `reviewGridMismatch` and `datasetHash`. `drafts`
  counts drafts at or above the threshold. A ratio with nothing to divide by is `null`.
- `pr.csv` and `pr.json`: one row per threshold from 0.00 to 1.00 in steps of 0.05 (`threshold`,
  `drafts`, `tp`, `fp`, `fn`, `precision`, `recall`, `f1`).
- `drafts.json`: every draft with photo, box, score, note, `matched` (by IoU), `iou` (its match, or the
  best overlap it had) and `centreMatched` (the old rule), for the person's false-alarm review.
- `sheet-<n>.jpg`: contact sheets. Truth in green, drafts with their scores; drafts under the
  threshold are dimmer.
- `compare.json` with `--compare`.
- Truth is recorded in the app's review copies (long edge 2560 px), so `reviewGridMismatch` counts
  photos whose long edge is not 2560 px, and the bench warns on stderr when there are any: numbers on
  those photos may be off.
- `datasetHash` is a sha256 over the photo keys run and their truth (class and box rounded to 0.1 px),
  so a reference says which data it was measured on.

## References and regressions

Each shipped detector has a stored reference in `references/<detector id>.json`
(`aio.detector-bench-ref/1`): detector id and version, the model it was measured with, the date, the
dataset hash, split, threshold, IoU bar, truth classes, the headline metrics and the old-rule numbers.
`--write-reference <file>` writes one from a run.

`--compare <file>` flags a drop in precision, recall or F1 of more than `--tolerance` (absolute, default
0.05), writes `compare.json` and exits 1. A metric the run could not measure (`null`, for example no
truth at all) while the reference has it is a regression too, so an empty run never passes. A reference
measured on another dataset or another model is warned about but still compared, so a regression cannot
hide behind new data: when the change is expected, refresh the reference. A run whose threshold, IoU
bar, split or truth classes differ from the reference's is refused as not comparable (exit 2). A
reference whose `metrics` is `null` has nothing to compare and is reported as "no reference yet".

`--write-reference` is skipped when the comparison in the same run failed (regression or other
settings), so a regression never becomes the baseline; `--force-reference` writes it anyway.

The corrosion reference has no metrics yet: the 29 Oct 2026 run on Qwen3.5-9B had no reviewed corrosion
truth in the bench split, and re-tuning the detector waits for the asset inspection work.

## Pre-release check

`prerelease.py` runs the bench for every shipped detector
(`tools/analytics-pack/detectors/**/detector.json`) on the `bench` split and compares each with its
reference:

```
uv run --project python python tools/detectors/prerelease.py \
  [--dataset <dir>] [--server <url>] [--model <id>] [--tolerance 0.05] [--limit 50] \
  [--update-references] [--out <dir>]
```

- It always checks each detector's `tunedOn.model` (and the reference's model) against the model the
  Analytics pack ships (`tools/analytics-pack/lock.json`, `model.id`) and prints a warning when they
  differ. A stale `tunedOn` is a warning, never a failure.
- `--dataset` (or `QUADRION_DETECTOR_BENCH_DATA`) is a folder of reference projects, each with a
  `manifest.json`, or one project. Without it every detector prints `skipped: no dataset` and the check
  exits 0, so the release flow can call it on any machine.
- With a dataset it needs `--server` (or `QUADRION_DETECTOR_BENCH_SERVER`). Truth classes, threshold
  and IoU bar come from the reference, else from the detector.
- `--update-references` writes each run as the new reference (commit only the JSON), except after a
  failed comparison; add `--force-references` to write it anyway. Truth classes, threshold and IoU bar
  set in a reference are used as they are, including `[]` (every class) and `0`.
- `--out` defaults to a folder in the system temp directory, never inside the repository.
- Exit codes: 0 fine (warnings allowed), 1 a regression beyond the tolerance, 2 a usage problem or a
  failure (missing dataset folder, no server, server unreachable, settings that differ from the
  reference, an unreadable reference or a bench crash).

## The bar

A detector ships as "verified" when, measured on `bench` only with IoU matching, recall is at least 0.70
and it makes at most 1 false draft per photo on average. Never read the bar off `tune`: the text was
fitted to it.

## Tests

```
uv run --project python pytest tools/detectors
```

`test_metrics.py` (matching and metrics on synthetic boxes), `test_bench.py` (a synthetic project and
the fake llama-server from `python/tests/fake_vlm.py`) and `test_prerelease.py` (the bench stubbed). No
real model runs and nothing is downloaded.

## Reference projects

Reference projects are read only, from the path given on the command line. They are never copied
into the repository, and no reference data, names or outputs are committed. Only the small reference
JSON files in `references/` are.
