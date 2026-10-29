# Detector bench

Developer command that runs one vision-model detector (`aio.vlm-detector/1`) over a reference
project's photos with the real engine, and measures recall and false drafts against the project's
reviewed findings. It decides which detectors ship as "verified".

```
uv run --project python python tools/detectors/bench.py \
  --project <dir> --detector <detector.json> --server <url> \
  --split tune|bench [--truth-class <id>...] [--threshold 0.8] [--limit 50] \
  [--model <id>] [--api-key <key>] --out <dir>
```

- `--server` is a running `llama-server` (loopback). `--api-key` defaults to the `LLAMA_API_KEY`
  environment variable.
- `--model` is the model id and picks the box frame: a Qwen3 model (`qwen3.5-...`, `qwen3-vl-...`)
  answers `bbox_2d` in 0 to 1000 of the sent image, anything else (Qwen2.5-VL) in sent pixels. Without it
  the bench asks `GET /v1/models` of `--server` and falls back to pixels.
- Split: a photo is in `tune` when `int(sha1(photo_id).hexdigest(), 16) % 10 < 3`, otherwise in
  `bench`. Tune the detector text on `tune`; measure on `bench`.
- Truth: image sightings of issues (box, rotated box or polygon bounds) and accepted detections in
  `detections/*.json`, filtered by `--truth-class`. Truth on photos outside the split is skipped.
- Hit: a draft at or above `--threshold` whose box contains a truth item's centre.
- Photos are read in id order; `--limit` caps how many run.

## Output

- `report.json`: `photos, truth, found, recall, drafts, draftsPerPhoto, unmatchedDrafts,
failedPhotos, reviewGridMismatch` (`drafts` and `draftsPerPhoto` count drafts at or above the
  threshold). Truth is recorded in the app's review copies (long edge 2560 px), so
  `reviewGridMismatch` counts photos whose long edge is not 2560 px, and the bench warns on stderr
  when there are any: recall and false alarms on those photos may be off.
- `sheet-<n>.jpg`: contact sheets. Truth in green, drafts with their scores; drafts under the
  threshold are dimmer.
- `drafts.json`: every draft with photo, box, score, note and whether it matched, for the person's
  false-alarm review.

## The bar

A detector ships as "verified" when, measured on `bench` only, recall is at least 0.70 and it makes
at most 1 false draft per photo on average. Never read the bar off `tune`: the text was fitted to it.

## Reference projects

Reference projects are read only, from the path given on the command line. They are never copied
into the repository, and no reference data, names or outputs are committed.
