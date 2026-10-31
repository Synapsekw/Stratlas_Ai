---
type: plan
date: 2026-10-31
branch: feat/multiview-thermal
status: built
related:
  [
    2026-10-30-intelligence-review.md,
    2026-10-21-thermal-analysis.md,
    ../design/intelligence-review-2026-10/vision.md,
  ]
---

# V3: multi-view vote and thermal hot-spot finder

Vision audit items 3.6 (multi-view vote before review) and 3.14 (thermal M2 hot-spot finder; it is
M3 task 3.3 of the thermal plan, the detection half only). The founder approved the item; the calls
below are decided, not open.

## Decisions

1. **Where the vote runs.** At the end of `detect.vlm` (its commit step), through one call into a new
   package `aio_pipelines/multiview/`. The detect files get a three-line hook only (a parallel branch
   edits the verifier). The same call runs on hot-spot drafts, so a hot spot seen in three
   overlapping thermal photos is one draft too.
2. **How a draft is placed in 3D.** The "place in 3D" path of the inspection pipeline: photo poses as
   that job reads them (date line-up applied, `inspection/frame.py`), and the median hit of a 5 x 5
   ray grid in the central half of the box (`aik/project.py`, `camera_rays` and `cast` reused) on the
   project's meshes. No mesh: the point cloud (sampled, rays marched against a KD tree). Neither: the
   box-centre rays are triangulated pairwise (closest approach). Photos without a position or an
   orientation (`q`) are not voted: their drafts pass through untouched.
3. **Clustering.** Per class, greedy in score order: a draft joins the nearest cluster whose centre is
   within the radius (0.5 m, or the detector's `objectSizeM` when larger) and that has no draft from
   the same photo yet; otherwise it starts its own. Pairwise triangulation uses the same radius on the
   rays' closest approach.
4. **One draft per cluster.** The best-scored member stays, with `vote`: `views` (photos that agree),
   `seenBy` (posed photos of the pass that look at the 3D point, inside the frame and in front),
   `score` (its own detector score), `point` and `placedOn`, and `sightings` (the other members'
   photo, box, score and id). The other members leave the file; their boxes live on in `sightings`.
5. **Confidence from agreement.** `confidence = (1 - prod(1 - s)) x (0.7 + 0.3 x views / seenBy)`
   over the member scores: agreeing views raise it, photos that see the point and found nothing lower
   it; a box found in one of six photos loses about a quarter. `belowThreshold` is recomputed against
   the detector threshold. Picked on the vote bench (D1) over the mean member score and the best
   member score, and over a 0.5 floor, which all lost objects at the 0.8 threshold.
6. **Outliers are kept and flagged.** `singleView: true` when `views` is 1 and `seenBy` is 2 or more.
   Nothing is dropped. A draft that could not be placed keeps no `vote`.
7. **Hot spots** (`thermal.hotspots`, the planned `ThermalHotspotsParams`): connected regions over the
   threshold (rule `delta`: ΔT over the median of a ring around the region, the ring's coldest 10 %
   ignored so sky does not pull the reference down; rule `absolute`: above a temperature), at least
   `minAreaPx`, regions within 6 px merged, at most `maxPerPhoto` (20) by ΔT. NaN ignored. Defaults
   from the thermal plan task 3.3.
8. **Hot spots reuse what the app shows.** The job writes `thermal/candidates.json`
   (`aio.thermalCandidates/1`, already in the schema) and an `aio.detections/1` draft pass
   `detections/thermal-<layerId>.json`, class `hot-spot` (label "Hot spot" and `suggestedNew` when
   the project has no such class), severity `uncertain`, `fields` peak, mean, reference and ΔT in °C,
   a note. Inspect lists them like any draft (the fields show without UI change); Accept makes an
   issue. A re-run replaces the pass's drafts of the photos it ran and keeps every reviewed detection
   (accepted, rejected or linked to an issue); a new candidate over a reviewed one (IoU 0.3) is
   dropped. The thermal plan's own hot-spot list (M3 task 3.7) can come later on the same file.
9. **UI (minimal).** Inspect findings row: a chip "Seen in N photos" or, flagged, "Only 1 of N photos".
   Thermal bench: a Find hot spots button where the plan keeps room for the hot-spot list, with the
   result line. No shell, right panel, island, palette, toast or dialog file is touched.
10. **Pack.** Pipeline pack 0.29.0 in one last commit. `THERMAL_HOTSPOTS_MIN_PACK = '0.29.0'` gates
    `thermal.hotspots`. `DETECT_MIN_PACK` stays 0.28.0: an older pack simply writes drafts without
    `vote`, which the app reads as before.
11. **Thermal ortho.** There is no thermal orthomosaic in the app yet, so the finder works on the
    per-photo rasters; an ortho is a follow-up.
12. **Review fixes (independent review, 31 Oct).**
    - `seenBy` counts only the photos the run looked at for the class.
    - A guessed ray depth never merges.
    - Sightings keep their own space, size, note and fields, plus `sightingsOmitted`.
    - Hot spots are led by the highest ΔT.
    - A thermal re-run votes the new drafts with the kept detections: new drafts of reviewed
      objects are dropped, and those of kept drafts are added to them.
    - The vote can be cancelled and scales (prefiltered ray pairs, a centre grid, batched
      projections and rays).
    - The cloud march never steps past its tolerance.

## Tasks

| Task | What                                                                                                         | Tests                                                                                                                                                                                                              | Packages                        |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| A1   | `multiview/vote.py`: clustering, `seenBy`, confidence, flags (pure, takes placed drafts and cameras)         | `test_multiview_vote.py`: 3 objects x 5 views give 3 drafts with views 5; a lone false box seen by 5 is kept, flagged; two classes at one point stay apart; same photo never joins twice; unplaced passes through  | pipelines                       |
| A2   | `multiview/scene.py`: cameras from the manifest, mesh, cloud and ray surfaces, `vote_pass(ctx, layer, dets)` | `test_multiview_scene.py`: synthetic box mesh + posed cameras place a box at the right point; ray triangulation without a mesh; photos without `q` skipped; any failure leaves the drafts untouched with a warning | pipelines                       |
| A3   | Hook in `detect/pipeline.py` commit step                                                                     | extend `test_detect_pipeline.py` (pass with poses gets `vote`)                                                                                                                                                     | pipelines                       |
| B1   | `thermal/hotspots.py` `find_hotspots`                                                                        | `test_thermal_hotspots.py`: thermal plan 3.3 cases                                                                                                                                                                 | pipelines                       |
| B2   | `thermal/hotspots_pipeline.py` job, registered                                                               | job writes both files, keeps reviewed detections, skips photos without raster                                                                                                                                      | pipelines                       |
| C1   | Schema: `Detection.vote`; `thermal.hotspots` in jobs; `THERMAL_HOTSPOTS_MIN_PACK`                            | `detections.test.ts`, `jobs.test.ts`, `thermal.test.ts`                                                                                                                                                            | @aio/schema                     |
| C2   | Main: pack refusal for `thermal.hotspots`                                                                    | `thermalPack.test.ts`                                                                                                                                                                                              | desktop                         |
| C3   | Renderer: `vote` through `annotate` detections model; vote chip; Find hot spots button                       | component tests                                                                                                                                                                                                    | @aio/annotate, desktop, @aio/ui |
| D1   | Bench `tools/detectors/vote_bench.py` (synthetic multi-view fixture, E2 metrics before and after)            | `test_vote_bench.py`                                                                                                                                                                                               | tools                           |
| E1   | Docs: contract row, data-conventions, session note                                                           | `check-public-text`                                                                                                                                                                                                | docs                            |
| F1   | Pack 0.29.0 (last commit)                                                                                    | `test_app_range`, `packVersions.test.ts`                                                                                                                                                                           | pipelines, desktop              |

e2e: none added. The button starts a job and prints its count; the job is covered by the Python tests
and the button by a component test. `thermal-bench.spec.ts` is not changed.

Contract changes: `Detection.vote` (additive, optional, strict inside); `PipelineName` gains
`thermal.hotspots`; new pass file `detections/thermal-<layerId>.json`; `thermal/candidates.json`
written for the first time.

## Execution DAG

```
A1 ──> A2 ──> A3 ─┐
B1 ──> B2 ────────┼──> D1 ──> E1 ──> F1
C1 ──> C2, C3 ────┘
```

- Batch 1 (parallel, no shared files): A1, B1, C1.
- Batch 2: A2, B2, C2, C3.
- Batch 3: A3, D1.
- Batch 4: E1, then F1.

Critical path: A1 -> A2 -> A3 -> D1 -> E1 -> F1.
