# Detector candidates: cap, merge rule, GSD-aware tiles (V1)

Study items 3.1, 3.7 and 3.8 of the intelligence review (vision audit, 30 Oct 2026). Founder approved the item; the calls below are decided, not open.

## Goal

`detect.vlm` stops paying for runaway candidate lists, stops dropping a precise small box inside a large one, and can pick the tile count from the ground sample distance.

## Decisions

1. **Cap.** `MAX_CANDIDATES = 30`, the custom-analytics value (`packages/ai/src/ask.ts`, `MAX_ASK_ITEMS`). The detect prompt says "Report at most 30 areas, the clearest first." Each tile keeps the first 30 boxes of its reply (models list the clearest first). The photo cap must come before the yes/no check, since every candidate costs one verifier call: the candidates are deduplicated, then ordered by their place in their tile's reply (round robin across tiles, starting at a different tile for each photo so no tile always goes first) and cut to 30, then scored. After scoring the list is ordered by score, so the kept ones read highest-scored first. A hit cap sets `PhotoResult.capped`, adds the warning "more than 30 candidates; kept 30 (the first answers of each tile)", is staged with the photo's result, and the job result (`detect` and `commit` step outputs) counts the capped photo results (`capped`). The `aio.detections/1` file does not change.
2. **Merge rule.** Two passes:
   - before scoring, a cheap deduplication of overlap copies. A piece cut off at an inner tile edge (within 1 % of the sent frame of a tile edge that is not a photo edge) that lies 0.6 or more inside a larger box is dropped, so it cannot outscore the box that sees the whole object. Then IoU at least 0.5 keeps the earlier one in reply order;
   - after scoring, non-maximum suppression: order by score (unscored last), smaller area first on a tie; drop a box whose IoU with a kept box is at least `NMS_IOU = 0.5`, or which shares at least `MERGE_SHARE = 0.6` of the smaller box with a kept box (containment). So on containment the higher-scored box stays, and the smaller one on a tie.
3. **GSD-aware tiles.** An optional detector field `objectSizeM` (typical object size in metres, 0.01 to 100). With it, and a photo whose GSD is known, `choose_tiles` picks the smallest `n` from 1 to 4 that shows the object at least `MIN_OBJECT_SENT_PX = 64` px in the sent image. Tiles are never enlarged past native resolution: the first `n` whose tiles are sent at their own pixels or more is the last one tried, even when the object is still smaller than 64 px (4 if no `n` reaches native resolution). GSD is known only for a near-nadir photo: EXIF `FocalLengthIn35mmFilm`, XMP `RelativeAltitude` above 0 and XMP `GimbalPitchDegree` at -60 or steeper; `gsd = altitude * 36 mm / (focal35 * long side px)`, the same 35 mm convention as the camera poses (`FULL_FRAME_WIDTH_MM` in `aik/cameras.py`). The metadata is read only when a detector of the run sets `objectSizeM`, and any error reading it means no GSD. The detector bench (`tools/detectors/bench.py`) uses the job's `_fit_tiles`, so it measures the tile count used in production. Otherwise (oblique, no metadata, no `objectSizeM`) the detector's own `tiles` apply as before (the shipped default is `TILES_DEFAULT`). The shipped corrosion detector gets no `objectSizeM` (corrosion has no typical size; no bench evidence yet). No UI sets `objectSizeM` for now (parent decision): the editor field comes with the Models and detection page (UI revision Wave 2).
4. **Contract change.** `VlmDetector.objectSizeM?` in `@aio/schema` (strict object, so a build before this release refuses a detector file carrying it). Row in `docs/architecture/contract-changes.md`. `DETECT_MIN_PACK` rises to the pack that knows the field (number from the merge coordinator: 0.28.0), since an older pack refuses unknown detector keys.

## Tasks

| Task | What                                                                                                        | Tests                                                                                                                                                                                                                                                 | Packages             |
| ---- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| T1   | engine: cap, prompt line, dedupe, NMS, `choose_tiles`, `gsd_from_meta`                                      | `test_detect_engine.py`: cap per tile and per photo, prompt says the cap, NMS on IoU, containment keeps higher score, tie keeps smaller, unscored loses, tile choice for small/large objects and unknown GSD, GSD from meta (nadir, oblique, missing) | python               |
| T2   | pipeline: `objectSizeM` validated, GSD read in prepare, tiles chosen in detect, `capped` staged and counted | `test_detect_pipeline.py`: objectSizeM accepted and range-checked; capped counted in the job result                                                                                                                                                   | python               |
| T3   | schema `objectSizeM?` + contract row                                                                        | `packages/schema/src/analytics.test.ts`                                                                                                                                                                                                               | schema, docs         |
| T4   | pipeline pack 0.28.0 bump (own commit), `DETECT_MIN_PACK` 0.28.0                                            | `detectPack.test.ts`, `jobsStart.test.ts`                                                                                                                                                                                                             | python, desktop main |

E2e specs: none added or changed (no UI, no real model runs).

## Execution DAG

- Batch 1 (parallel, no shared files): T1, T3.
- Batch 2: T2 (needs T1's engine API).
- Batch 3: T4 (version files only).
- Critical path: T1 -> T2 -> T4. Small enough to build in one session without subagents.
