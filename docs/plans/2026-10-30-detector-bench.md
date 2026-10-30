# Honest detector bench (E2)

Roadmap item E2 of the intelligence review (vision study, items 3.2 and 3.5). `tools/detectors/bench.py`
counted a hit when a draft box contained the centre of a truth item, which rewards huge boxes, and it
reported recall and false drafts only. Make it honest, give every shipped detector a stored reference
result and a pre-release check, and flag a stale `tunedOn`.

Out of scope (founder): re-tuning the corrosion detector or changing its text. The detect engine
(`python/src/aio_pipelines/detect/engine.py`) is edited by another branch at the same time and is not
touched here.

## Decisions

- **Matching:** IoU, default at least 0.3 (`--iou`). One-to-one greedy in score order (the COCO way):
  drafts sorted by score, each takes the unmatched truth item on its photo with the highest IoU at or
  above the bar. Because the order is the score order, one matching pass gives the matches for every
  threshold, so the PR curve is consistent with the headline numbers.
- **Old rule kept** as a secondary `centreRule` block (found, recall, precision, unmatched drafts) so
  old and new numbers can be compared.
- **Per class:** truth carries its class. A matched draft counts for the class of the truth it matched;
  an unmatched draft is a false draft of the detector's own `classId`. Precision, recall and F1 per class
  follow from that.
- **PR curve:** thresholds 0.00 to 1.00 in steps of 0.05, written as `pr.csv` and `pr.json`.
- **Several projects:** `--project` may repeat; the limit is per project, the split still hashes the raw
  photo id.
- **Dataset hash:** sha256 over the sorted photo keys and their rounded truth boxes and classes, so a
  reference says which data it was measured on.
- **Reference file:** `tools/detectors/references/<detector-id>.json` (`aio.detector-bench-ref/1`):
  detector id and version, model id, date, dataset hash, split, threshold, IoU bar, truth classes and
  metrics. `--write-reference` writes one from a run. No real model is run in this branch, so the
  corrosion reference is committed with `metrics: null` and a note: the 29 Oct Qwen3.5 run had too little
  truth to measure. A null reference is reported as "no reference yet", never as a pass.
- **Comparison:** `--compare <ref>` flags a drop in precision, recall or F1 beyond `--tolerance`
  (default 0.05, absolute) and exits 1. A different dataset hash is warned about but still compared, so a
  regression cannot hide behind new data; refresh the reference when the change is expected.
- **Stale `tunedOn`:** a warning (never a failure) when a detector's `tunedOn.model` differs from the
  model the Analytics pack ships (`tools/analytics-pack/lock.json` `model.id`), or when the reference was
  measured on another model than the pack's.
- **Pre-release script** in Python (`tools/detectors/prerelease.py`), so it reuses the bench and runs
  through `uv run --project python`. Without a dataset (`--dataset` or `QUADRION_DETECTOR_BENCH_DATA`)
  it prints `skipped: no dataset` per detector and exits 0, after the `tunedOn` checks, which need no data.
  With a dataset but no server it exits 2 with a clear message. Regressions exit 1.

## Tasks

1. `tools/detectors/metrics.py`: `iou`, `match`, `evaluate`, `pr_curve`, `centre_rule`, `dataset_hash`,
   `compare`, `stale_tuned_on`. Tests: `tools/detectors/test_metrics.py` with synthetic boxes (perfect
   match, huge box passes centre rule but fails IoU, one-to-one with two drafts on one truth, score order,
   per class, PR curve monotone recall, compare regression and tolerance, dataset mismatch warning, stale
   tunedOn).
2. `tools/detectors/bench.py`: truth with classes, repeatable `--project`, `--iou`, report fields, `pr.csv`
   and `pr.json`, `model` in the report, `--compare`, `--tolerance`, `--write-reference`. Tests: update
   `tools/detectors/test_bench.py` (the fake llama-server, no real model).
3. `tools/detectors/prerelease.py` and `tools/detectors/references/corrosion-metal.json`. Tests:
   `tools/detectors/test_prerelease.py` (skip without dataset, stale warning, exit codes with a stubbed
   bench).
4. Docs: `tools/detectors/README.md`, a pre-release line in `tools/analytics-pack/README.md`, session note.

No e2e specs are added or changed (nothing user-facing). No contract change (dev tool only). Packages
touched: `@aio/schema` only to list `aio.detector-bench-ref/1` in `NOT_FILE_SCHEMAS` (a tool-only
format the app never reads; the registry test requires every `aio.*` id to be listed); otherwise
`tools/detectors`, `tools/analytics-pack/README.md`, docs.

## Execution DAG

- Batch 1: task 1 (metrics module and its tests).
- Batch 2 (after 1, can run in parallel, no shared files): task 2 (bench) and task 3 (pre-release; it
  calls `bench.main` and stubs it in tests).
- Batch 3: task 4 docs.

Critical path: 1, 2, 4. Built by one agent in sequence; the batches are small.
