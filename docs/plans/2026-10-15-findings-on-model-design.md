# Findings on a model: design

Date: 15 Oct 2026. Branch `feat/findings-on-model`. Status: approved in brainstorming, waiting for the plan.

## Goal

AI findings (accepted AI Detect detections, change "Make issue" results, assistant drafts) are attached to a 3D model layer the person picks, as a real area, not only a centre pin:

- on a mesh (GLB/OBJ layer) as an `spolygon` outline that follows the surface;
- on a point cloud as a `polygon3` prism, plus a `selection` of the loaded points inside it.

Success means:

1. Every placed finding is drawn as an outline or prism on the model; hovering highlights it, clicking opens the photos it was found in.
2. The area geometry is good enough to match the same defect across survey dates, and the app suggests those matches when a finding is placed.
3. The assistant can place findings and add sightings with named layers, behind the existing approval step.

## Decisions (founder, 15 Oct)

| Question                | Decision                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Purpose                 | Visible outlines on the model, with geometry fit for matching across dates                                                  |
| Point-cloud shape       | `polygon3` prism as the sighting's shape, plus a second sighting with a `selection` of the points inside                    |
| Mesh shape              | `spolygon` outline densified so it hugs the surface (no `spatch`)                                                           |
| When offered            | After accepting in the detection review, after change "Make issue", and on the issue list's right-click "Place on model..." |
| Tracking over time      | Suggest matches on placement; "Same" confirms a track                                                                       |
| Automatic crossview pin | The area replaces the pin on that layer; never-placed issues keep their pin                                                 |
| Click on a finding      | Opens the photos it was found in (the issue's own image and video sightings)                                                |
| Where projection runs   | In the renderer (approach A); a full-resolution recut in Python is a later follow-up                                        |

## What exists today

- `packages/annotate/src/crossview/derive.ts` adds one `on:'mesh'` pin from the centre of a photo shape when an image or video sighting is added to an issue without a mesh sighting.
- `backproject.ts` has `castRay` (via `SceneHandle.raycastRay`) and an unused `backProjectOutline` (one ray per vertex, no densifying, null on any miss).
- `Stage.raycastRay` (`packages/engine/src/stage/Stage.ts`) hits meshes, rasters, tiles and the ground; point clouds are only a cursor raycast provider (`pointcloud/src/pick.ts`, screen-space nearest point over loaded chunks).
- The schema (`packages/schema/src/annotation.ts`) already has `spolygon`, `polygon3 {points, height?}`, `box3`, `selection {src, count}`. The issue overlay (`annotate/src/tools/overlay.ts`) draws one pin per issue at `bestAnchor`; no 3D area is drawn as a shape.
- Cross-date matching lives in `packages/change/src/issues.ts`: confirmed `track` first, then same class within `max(0.5 m, 2% of site height)` of the 3D sighting. `issueOps.ts` `trackPair` links two issues.
- Assistant write tools (`packages/ai`, risk `write`) wait for Approve in `AgentPanel`. `create_issue_draft` writes through `ws.upsertIssue` with an implicit layer (`pointSighting`).
- Photo poses: `PhotoRef.pos/q/lens` in the project local frame, ODM refined poses applied by "Use refined poses"; ODM meshes have an identity transform, clouds are COPC. Lens model is pinhole or f-theta from field of view only.
- Change "Make issue" (`renderer/change/actions.ts`) may pick a point-cloud layer but always writes `on:'mesh'` (bug).

## Design

### 1. Contract (`@aio/schema`)

No new shape types. Two optional fields:

- `selection.lod?: number`: the octree depth the selection was cut at, so a later recut knows it is partial.
- On mesh and point-cloud sightings, `from?: { sighting: number }`: index of the image/video sighting in the same issue that the area was projected from. Used to open that photo first.

Both are optional, so old files stay valid. One row in `docs/architecture/contract-changes.md`.

### 2. Cloud ray query (`@aio/pointcloud`)

`raycastPoints(ray, chunks, { coneRad, maxDist })`: over loaded chunk positions (respecting section planes and class filters, as `pickPoint` does), return the nearest point along the ray whose perpendicular distance is within `coneRad * t` (with a small absolute floor). Registered with the stage as a ray target, so `Stage.raycastRay` returns cloud hits with `layer` set to the cloud's id. A helper `refineAround(frustum, timeoutMs)` asks the octree to load finer nodes inside a camera frustum and resolves when loading settles or the timeout (default 3 s) passes; it reports the deepest depth loaded there.

### 3. Projector (`@aio/annotate/src/crossview/place.ts`)

`placeOnLayer(issue, layer, scene) -> PlaceResult` where `PlaceResult` is `{ ok: true, sightings, from, hitRate } | { ok: false, reason: 'no-photo-shape' | 'missed' | 'layer-not-loaded' }`.

- Candidates: every image or video sighting of the issue with a box or polygon (masks skipped). Each is projected; the best hit rate wins, ties to the larger shape.
- Mesh: the outline is densified every 8 px; one ray per sample against that layer only. Misses are dropped. Needs at least 60 % hits and 3 points, else `missed`. Result: `spolygon` of the surface points in outline order.
- Cloud: `refineAround` the photo frustum first. Rays: a 7 x 7 grid inside the outline plus the densified outline samples. Hits farther than 3 MAD from the median depth are rejected (seen through a gap or background). The rest give the prism: plan-view (x, z) convex hull, base at the lowest y, `height` = highest minus lowest y. A hull thinner than 0.1 m is padded to 0.1 m, like the Cloud box tool. Needs at least 60 % of grid rays hitting and 3 hull points, else `missed`. Then `pointsInPolygon` over the loaded points gives the `selection` file (format as the existing `selection` asset) with `count` and `lod`.
- Writes go through the issue editor (`model/editor.ts`), not `upsertIssue`, so undo and the deriver work.

### 4. Replacing the automatic pin

The deriver marks the pins it makes (existing flag, or a new internal marker if none exists; decided in the plan after reading `derive.ts`). When an issue gains a placed area on layer L, an automatic pin on L is removed in the same edit. Issues never placed keep their pin. `bestAnchor` prefers an area's centroid.

### 5. Drawing and interaction (`@aio/annotate` overlay)

- `spolygon`: a line on the surface (small offset along the normal, depth-tested) in the issue's severity colour, with a faint fill.
- `polygon3`: wireframe prism with a translucent fill, same colours.
- The issue code as a small label at the area centre; no pin for placed issues.
- Hover: highlight the area and show the title (existing hover tooltip pattern). Click: open the issue's photos in the existing photo viewer, starting with the `from` sighting, with its box drawn.
- Areas follow the same date and layer visibility rules as pins (`issuesOnScreen`).

### 6. Offer bar (desktop renderer)

`PlaceOnModelNotice`, hosted in `renderer/exports/Toasts.tsx`, built like `PhotoAlignNotice`.

- Shown after accepting in the detection review and after change "Make issue": "Connect N findings to a model?", a layer picker (mesh and point-cloud layers of the project; layers of the same date as the photos first), "Place", "Not now".
- Result: "Placed 12 of 14 on Mesh 3 Mar. 2 missed the model." with Undo.
- Then match suggestions, one at a time: "AI-31 looks like AI-12 from 3 Mar" with "Same" (confirms a track via `trackPair`), "Different" and "Skip all".
- Right-click on one or many selected issues in the issue list: "Place on model..." opens the same picker.
- All strings in `en.ts`; no emoji, no em or en dashes.

### 7. Matching (`@aio/change/issues.ts`)

Add footprint overlap: the plan-view (x, z) polygons of two placed areas (`spolygon` points or the `polygon3` ring); overlap = intersection over the smaller area, at least 0.3; same class; different dates; neither already tracked. Ranked by overlap. Issues with only pins keep the distance rule. Exposed as `suggestMatches(issue, issues, dateIndex)` for the bar; the change view's verdicts use the same rule.

### 8. Assistant tools (`@aio/ai`)

All `write` risk, so they wait for Approve.

- `place_on_model({ ids, layer })`: ids are issue ids or detection ids; draft detections are accepted first (same path as the review), then placed. Returns, per id, the shapes placed or the reason it missed.
- `add_sighting({ issue, layer, at })`: adds a place to an existing issue. `at` is an existing `Target` (point, issue, cursor) or `{ photo, box }` to project from a named photo box.
- `create_issue_draft` gains optional `layer`; `pointSighting` uses it and writes the kind that layer needs.

### 9. Fix

Change "Make issue" writes `on:'pointcloud'` (`polygon3` from `outlineLocal`, else `point3`) when the picked layer is a cloud.

## Out of scope

AI Detect on rendered model views (`capture_frame`), 3D tiles, the full-resolution selection recut, lens principal point and distortion, `spatch`, the Python inspection pipeline's `spoint`-only output.

## Known limits

- ODM's principal point and distortion do not reach `PhotoRef`, so outlines can shift slightly near photo edges.
- A selection covers only the cloud detail loaded when it was cut (`lod` records it).
- A photo pose must exist; unposed photos report `no-photo-shape`.

## Testing

- Unit: cloud ray query (synthetic chunks, cone, filters), projector mesh and cloud paths with synthetic cameras and scenes (hit-rate threshold, depth rejection, padding), pin replacement, footprint overlap matcher, the three tools, change "Make issue" kind fix, schema round-trip.
- E2E: new `apps/desktop/e2e/findings-on-model.spec.ts` on the change demo: accept detections, place on the mesh then the cloud, outlines drawn, click opens the photo, a match suggestion on the second date and "Same" makes a track. Re-run `agent.spec.ts`, `detections.spec.ts`, `change-core.spec.ts`, `change-cloud.spec.ts` the way CI runs them.
