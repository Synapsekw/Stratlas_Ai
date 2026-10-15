---
type: session
date: 2026-10-15-2057
branch: feat/findings-on-model
status: complete
related: [plans/2026-10-15-findings-on-model-design.md, plans/2026-10-15-findings-on-model.md]
---

# Findings on a model

## What changed

- AI findings now land on a chosen 3D model as areas: a surface outline (`spolygon`) on a mesh, or a prism (`polygon3`) plus a point selection file (`selections/*.sel`) on a point cloud. The area replaces the automatic crossview pin on that layer.
- "Connect N findings to a model?" appears after accepting in the detection review and after change "Make issue"; right-click "Place on model..." in the issue list does the same. Placing opens the 3D view first.
- Areas are drawn, hover shows the title, and a click opens the issue's photos on the one the area came from. Cross-date matching now compares footprints, and the bar suggests "looks like ... from <date>" with Same (a shared track), Different and Skip all.
- New assistant tools `place_on_model` and `add_sighting`, and `create_issue_draft` takes a `layer`. Rays can now hit point clouds (`Stage.raycastRay` with a layer and ray providers). Change "Make issue" writes cloud sightings on cloud layers (a bug fix).
- Contract: `from?` on mesh and cloud sightings, `selection.lod?`, the selection file format and IPC `project:writeSelection` (contract-changes row "pending founder review"; data-conventions section 35).
- 14 planned tasks built by subagents, each reviewed; a final whole-branch review caught that placing from the review screen could not work without the 3D view, now fixed. `pnpm check` green; five e2e specs pass CI-style.

## Why

The founder wants AI findings tied to the model as real areas, so the same defect can be followed across survey dates and the assistant can place and reason about them.

## How to test

1. Open the "two dates" change demo (or any project with posed photos plus a mesh or point cloud).
2. Run AI Detect on a few photos, open the review and accept some findings. A bar asks "Connect N findings to a model?". Pick a mesh layer and press Place: the app switches to the 3D view, outlines appear on the model and the bar says "Placed X of N on <layer>" with Undo.
3. Hover an outline: it highlights and shows the title. Click it: the issue card opens on the photo the finding was found in.
4. In the issue list, right-click the same finding, choose "Place on model..." and pick a point cloud: a translucent prism appears.
5. Place a finding of the same class on the other date's model: the bar suggests "looks like ... from <date>". Press Same: both now share one track (the change view treats them as one finding).
6. In the assistant panel ask it to place a finding on a named layer: the approval card reads "Place 1 finding on <layer>"; Approve and the area appears.

## Open threads

- Founder review: the contract row, and the rulings: placing switches to the 3D view; e2e uses the demo's oil-stain decal because the demo meshes have no ground for the survey markers.
- Known limits: selection files are not carried by package export or hub sync, and Undo or re-placing leaves orphan selection files; cloud placement refines once per photo (up to 3 s each) and briefly coarsens the cloud around the camera; ODM principal point and distortion are not used, so outlines can shift near photo edges; a heavy mesh in a cold 3D view may exceed the 15 s load wait (the offer comes back); the assistant cannot list waiting detection ids.
- Minors left as follow-ups: per-pixel occlusion for areas when zoomed in, concave fill spill, prism sides not hittable, label hidden when the area centre is off screen, ring and corner helpers duplicated across packages.

## Next session entry point

Merge `feat/findings-on-model`, then try the steps above in the next build. Optional later: AI Detect on rendered model views (`capture_frame`), and reading the Bentley import's lens distortion in crossview.
