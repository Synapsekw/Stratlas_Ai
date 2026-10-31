---
type: session
date: 2026-10-31-1555
branch: feat/multiview-thermal
status: complete
related:
  [
    ../plans/2026-10-31-multiview-thermal.md,
    ../plans/2026-10-30-intelligence-review.md,
    ../plans/2026-10-21-thermal-analysis.md,
  ]
---

# Multi-view vote and the thermal hot-spot finder

## What changed

- This PR adds a multi-view vote to `detect.vlm`. Before the pass is written, each draft on a posed photo is placed in 3D the way the inspection pipeline places findings (the median hit of a 5 x 5 ray grid in the box on the meshes), else on the point clouds, else where the box-centre rays of other photos cross. Drafts of one class within 0.5 m (or the detector's `objectSizeM`), one per photo, become one draft: the best-scored one, with `vote` (`views`, `seenBy`, `score`, `point`, `placedOn` and the other photos' boxes as `sightings`). Its confidence becomes the noisy-or of the agreeing views times `0.7 + 0.3 x views / seenBy`. A box found in one photo while two or more see the spot is kept and flagged `singleView`. Nothing is dropped, and a draft that cannot be placed is left as it was. The logic lives in `python/src/aio_pipelines/multiview/`; `detect/pipeline.py` has a three-line hook.
- New job `thermal.hotspots` (thermal M3 task 3.3). It looks for regions hotter than their surroundings (or above a temperature) in a layer's decoded rasters, with the reference from a ring around each region and sky left out. It writes `thermal/candidates.json` and a draft pass `detections/thermal-<layer>.json`: class `hot-spot`, with peak, ΔT, surroundings and mean as fields. Inspect shows them like any draft, and Accept makes an issue. A re-run keeps reviewed detections. New hot-spot drafts go through the same vote.
- `Detection.vote` is in `@aio/schema` and is carried through the review. Inspect's findings row shows "Seen in N photos", or "Only 1 of N photos" as a warning. The Thermal bench has a Find hot spots button (ΔT 4 °C) with the result line. `THERMAL_HOTSPOTS_MIN_PACK` is 0.32.0, and there is a contract row. Pipeline pack 0.32.0.
- `tools/detectors/vote_bench.py` measures the vote with the E2 metrics on a synthetic multi-view fixture. Over 10 fixtures at threshold 0.8:

  | Run                | Drafts to review | False drafts | Objects covered | E2 F1 |
  | ------------------ | ---------------- | ------------ | --------------- | ----- |
  | Before             | 510              | 31           | 139 of 150      | 0.462 |
  | After, on the mesh | 145              | 1            | 144 of 150      | 0.851 |
  | After, rays only   | 142              | 0            | 142 of 150      | 0.849 |

- Review fixes in this PR:
  - `seenBy` counts only the photos the run looked at for that class: for `detect.vlm`, the photos each detector actually ran on; for `thermal.hotspots`, the searched photos and those of earlier searches.
  - A ray no other photo's ray crosses never merges. Its depth is a guess, used only for `seenBy`.
  - Sightings keep their own space, size, note and fields. A merged hot spot reports its hottest view, and members past the 200 cap are counted in `sightingsOmitted`.
  - A thermal re-run votes the new drafts together with the kept detections, and treats a reviewed detection's sightings as reviewed. A run on photo B alone therefore adds B to the kept draft of photo A, and never revives a reviewed object.
  - The vote can be cancelled, reports progress, and scales:
    - a sampled KD-tree prefilter for ray crossings;
    - a grid of cluster centres;
    - one projection per camera for `seenBy`;
    - batched surface rays;
    - a vectorised cloud march whose step never exceeds its tolerance.
  - On 2000 photos with 57,728 drafts, the vote takes about 6 s on a flat surface and 15 s with rays only (test bound 120 s).

## Why

Vision audit items 3.6 and 3.14 (intelligence review, 30 Oct). The same defect in 8 photos meant 8 drafts to review, and a lone false box looked as good as one every photo agreed on. Thermal stopped at decoding: nothing found hot spots.

## How to test

1. Install pipeline pack 0.32.0 (Settings > Processing tools > Choose file). Settings lists "Thermal hot spots 0.32.0".
2. Open a project with a thermal photo set. Right-click the dataset > Analyse thermal. Once the temperatures are read, press **Find hot spots** above the filmstrip. "Looking for hot spots" shows, then "N possible hot spots. Review them in Inspect."
3. Open Inspect. The hot spots are AI drafts with class "Hot spot" (Create class the first time), a note "Peak ... °C, ... °C above its surroundings", and Peak, ΔT, Surroundings and Mean values. Accept one: it becomes an issue.
4. Press Find hot spots again: the accepted one stays as it is, no new draft appears on top of it, and the other drafts are found again.
5. In a project with posed photos (a mapping or orbit flight) and a model or point cloud, run a detector over several photos of the same spot. Inspect shows one draft with "Seen in N photos" where there used to be one per photo. A box found in only one of several photos shows "Only 1 of N photos" and usually falls under the threshold.

## Open threads

- The vote has only been run on synthetic fixtures (exact poses, flat objects). It needs a bench on a reference project with posed photos. GPS and gimbal error may need a larger radius than 0.5 m.
- Visibility uses the mesh (occlusion is tested) or the cloud. With rays only, seenBy counts every looked-at photo whose frame holds the point.
- A kept draft that a re-run adds to is voted again: one sighting per photo (a new box from a photo already listed replaces the old one), views, seenBy and singleView from scratch, and its confidence from every score it holds. A reviewed detection never changes.
- The crossing prefilter samples each ray between a quarter and four times the median crossing depth of neighbouring photos; crossings far outside that band are not found. One depth window serves the whole pass, so a pass that mixes nadir mapping photos with a close orbit (very different depths) can miss crossings of the group that is far from the median; a window per photo group is a follow-up. The prefilter reach is capped at 5 m and each sample takes at most 48 neighbours, so a dense pass can drop a few candidate pairs.
- There is no thermal orthomosaic yet, so the finder works per photo. The vote merges the same hot spot across overlapping posed thermal photos.
- The hot-spot thresholds are tuned on synthetic rasters only. The thermal plan's real-data check (task 3.9: sun glints, sky) is still to do. Severity stays `uncertain`: the "Thermal ΔT" grading and the hot-spot list of M3 tasks 3.6 and 3.7 are not built.
- The bench reads the found count from the job's commit step file (`jobs/<id>/steps/02-commit.json`). If that file cannot be read, it says "Done".

## Next session entry point

Run `vote_bench`-style scoring on a real posed reference project (`tools/detectors/bench.py` with the vote on), then the thermal M3 hot-spot list and grading on `detections/thermal-<layer>.json`.
