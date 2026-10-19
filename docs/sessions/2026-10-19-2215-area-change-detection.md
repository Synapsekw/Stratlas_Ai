---
type: session
date: 2026-10-19-2215
branch: feat/area-change-detection
status: complete
related:
  [plans/2026-10-19-area-change-detection-design.md, plans/2026-10-19-area-change-detection.md]
---

# Area-scoped change detection: compare one polygon with the previous survey

## What changed

- Right-click a drawn polygon (map, 3D or Datasets row) and choose **Compare with previous survey**: a small box names the area and the two dates and offers **Include volumes (cut and fill)**, off by default and remembered per computer, disabled with the reason when either date has no DSM or point cloud.
- `change.raster` takes a `scope` and `change.surface` takes a `mask` and `scope` (contract row in `docs/architecture/contract-changes.md`): an area run writes its own set `<from>-<to>-<producer>-area-<id>`, its folder and layers, so it never replaces the whole-map set or its reviews; volume regions, heat map and totals are clipped to the polygon.
- The Changes tab lists Whole map plus one entry per area, named after the polygon; an area's entry keeps a lasting note when volumes were asked for but refused or failed. While an area is chosen the whole-map Run buttons are disabled; Run again and Line up dates on an area replay the area run, never a whole-map one.
- The assistant's change tools leave area sets out (no double counting).
- New e2e `apps/desktop/e2e/change-area.spec.ts` (area compare, and an area's Run again leaving the whole-map set byte for byte unchanged).

## Why

On a construction project the work sits in one part of a large site, so a whole-map comparison buries the progress under unrelated change. Volumes are opt-in because most change on a building site is structures, not ground moving (founder).

## How to test

1. Open a project with at least two surveys of the same site, lined up (Changes panel shows no line-up offer).
2. With the later date shown, draw a polygon around the construction area with the measure tools.
3. Right-click the polygon on the map and choose **Compare with previous survey**. The box shows the polygon name and the two dates; leave volumes off and click Compare.
4. The Changes tab opens with the area chosen in the picker; when the run ends, change outlines and the heat map appear only inside the polygon.
5. Pick **Whole map** in the picker: the whole-map result (if any) is unchanged. Pick the area again.
6. Repeat step 3 with **Include volumes** ticked: cut and fill appear only inside the polygon. On a survey without a DSM or point cloud the checkbox is greyed out with the reason.
7. Right-click a line or select two polygons: the action is not offered. Right-click a polygon on the oldest survey: the action is disabled with "No earlier survey".

## Open threads

- At 1100 px a survey-scoped measurement row's name is squeezed to zero width by its area and date text in the Datasets tree (older than this branch; the e2e right-clicks the row icon).
- Minors left: the "Misaligned by" volumes reason is plain English; when both area jobs are refused as misaligned only the last refusal is kept; the dialog's Close label is hard-coded English (as in the Units dialog); Escape still closes the box while a run is starting.
- Needs a pipeline pack built from this PR (raster scope, surface mask).

## Next session entry point

Founder tries the steps above in the next build; the row-name squeeze in the Datasets tree is the most visible follow-up.
