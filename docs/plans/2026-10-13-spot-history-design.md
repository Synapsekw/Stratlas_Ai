# Spot history: one place across survey dates

Status: design approved in conversation by the founder (13 Oct 2026); written spec awaiting review.
Follows Timeline T3 (`docs/plans/2026-10-12-timeline-t3-compare-design.md`) in the timeline milestone
(`docs/plans/2026-10-07-timeline-design.md`). Plan: to be written after this spec is approved.

## Intent

Progress monitoring means looking at the same place again and again. A site is surveyed every week
or month, with drone photos, ground photos, 360 panoramas, walks and drone videos. Today a user who
opens a photo cannot ask "what did this spot look like on the other dates?": they have to switch the
date, find the same place again and open whatever was taken there by hand.

Spot history answers that question in one click. Open any placed image (a photo, a 360, a walk
frame or a video frame) and the viewer shows, for every survey date, the best image of the same
spot, with the gaps visible. Two dates can then be put side by side or swiped over each other.
Later, a point clicked on the map, the ortho or the 3D view starts the same search.

Success:

- from any placed photo, 360, walk frame or video frame, the other dates' images of that spot are
  one click (or one arrow key) away;
- a date with no image of the spot is shown as a gap, not hidden;
- a video that passed the spot opens at the moment it was closest;
- two dates of one spot can be compared side by side or with a swipe in two clicks;
- the main view is not disturbed: stepping dates in the viewer does not change the date bar.

## Design chosen

Four layouts were drawn and clicked through (the "Spot History Designs" page shared on 13 Oct):
A, a date strip in the viewer; B, two dates side by side or swiped; C, a spot sheet with dates across
and kinds of capture down; D, a spot picked on the map with camera cones. The founder chose the
recommended mix:

- **A is the base.** Clicking any image opens the viewer with the date strip.
- **B is one click away** through **Compare…** in the viewer.
- **D is the way in from the map** (second part).
- **C waits for T4** (progress reporting), where picking shots for the monthly report belongs.

Founder decisions (13 Oct 2026):

1. ~~All kinds of capture take part.~~ Reversed on 14 Oct 2026: only the clicked kind takes part,
   and only nearby. A photo (ground or drone) is matched with photos, a 360 with 360s, a walk frame
   with walk frames and a video frame with video frames; an aerial match must also have its camera
   within 50 m (horizontal) of the clicked camera. A date with nothing of that kind near is empty
   rather than filled with another kind.
2. Stepping through dates in the viewer **does not change the main view's date**. The viewer is a
   side trip; the date bar, the focused date and the visible layers stay as they were.

## What exists

- `PhotoRef` (`packages/schema/src/layers.ts`) has `pos` (local frame, x east, y up, z south), an
  orientation quaternion `q` and an optional `lens`; photos without GPS have no `pos`. Each layer
  carries its survey date in `capture`.
- `PanoRef` has `pos` and `headingDeg`. `apps/desktop/src/renderer/workspace/panoPair.ts` already
  pairs a panorama with the nearest one on another date (horizontal distance, 25 m limit), and
  `lookLink.ts` turns two views together.
- Placed walks have per-frame positions and headings from the fit (`packages/schema/src/walks.ts`,
  `docs/plans/2026-10-12-walk-layer-and-placing-design.md` sections 7 and 8). Unplaced walks have
  none.
- Videos have a flight pose over time; `packages/video/src/pairing.ts` (`photoPose`, `matchView`,
  `groundHomography`) already works out what a frame looks at.
- T3 built the split view, its date-aware pane picker and "Compare with…"
  (`workspace/SplitPanes.tsx`, `compareWith.ts`).
- There is no general "nearby media" search yet.

## Part S1: the search, the date strip and compare

### The search

One pure module, the spot search, in the desktop renderer's workspace code next to `panoPair.ts`.
It takes a spot and the project's loaded layers and returns, for each survey date, a ranked list of
matches. It reads only what is already loaded and writes nothing, so **there is no contract change**
and nothing is stored on disk.

A **spot** has an optional camera position, an optional facing direction and a target point on the
ground:

- clicking a ground photo, 360 or walk frame gives all three; the target is where the centre line
  of the view meets the ground (flat ground at the camera's ground height when there is no surface);
- clicking a drone photo or a video frame gives the target from its centre line, and its camera;
- clicking the map (S2) gives a target only.

A **match** carries: the date, the kind, the layer and item (and, for a video, the moment in
seconds), the horizontal distance between cameras, the angle between facing directions, and a score
for ranking.

Rules (starting tolerances, constants in one place so they can be tuned later):

| Kind         | Counts as the same spot when                                         | Starting tolerance          | Opens at                                                                      |
| ------------ | -------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| Ground photo | camera within the distance and facing within the angle               | 15 m, 45°                   | the photo                                                                     |
| 360 panorama | camera within the distance; facing does not matter                   | 25 m (as `panoPair.ts`)     | turned to the spot's view direction                                           |
| Walk frame   | the nearest frame of a placed walk within the distance               | 15 m                        | that frame, turned to the view                                                |
| Drone photo  | its view on the ground covers the target point                       | target inside the footprint | the photo                                                                     |
| Video        | at some moment, sampled every second, the target is inside the frame | target inside the frame     | the moment with the target nearest the frame centre (ties: the closer camera) |

- Only entries of the clicked item's kind are searched (decision 1, 14 Oct); a ground photo and a
  drone photo are both photos.
- Ground-level kinds (ground photo, 360, walk frame) are split from aerial kinds (drone photo, video)
  by the camera's height above the target: above 10 m counts as aerial. A photo layer can hold both.
- An aerial match (drone photo, video moment) must also have its camera within 50 m, horizontal, of
  the spot's camera (of its target when it has none): a far-off oblique view that still sees the
  target is a different picture.
- When the spot has no camera (map click), ground-level kinds match on the target instead: the
  camera within the distance of the target and, for ground photos and walk frames, facing it within
  the angle.
- A drone photo's footprint comes from its pose and lens, projected onto flat ground at the target's
  height. Without a lens the photo is left out of aerial matching.
- Ranking within a date: aerial matches by how close the target is to the image centre, ground-level
  matches by distance plus a weighted angle. The best match of each date fills the strip; the others
  sit behind the "+n".
- Angles wrap at 360°. Distances are horizontal.
- Media without a position (photos without GPS, unplaced walks) cannot match. The result counts them
  per date so the viewer can say so.
- The clicked item itself is the match for its own date.

Scale: hundreds of photos per date and up to a few dozen dates. A linear pass over positioned items
per search is fast enough (well under 100 ms for 10,000 items); no index is built in S1. Video
sampling is done once per video layer per session and cached in memory.

### The viewer with the date strip (A)

The photo viewer that opens when an image is clicked gets a strip along its bottom whenever the
project has two or more survey dates:

- one slot per survey date, oldest on the left, each with its date colour, a thumbnail of the best
  match, a small kind label (photo, 360, walk, video, drone) and "+n" when there are more candidates;
- a date with no match shows an empty, hatched slot with "nothing within 15 m" (or "not seen" for
  aerial kinds);
- when unplaced items were skipped on a date, the slot's tooltip says how many;
- the header shows the item's name, the date, the kind, and the distance and angle from the clicked
  spot;
- **← / →** step to the previous or next date that has a match; **↑ / ↓** cycle candidates within the
  date; clicking a slot jumps to it;
- 360s and walk frames open turned to the spot's view direction; videos open paused at the matched
  moment and can be played from there;
- **the main view does not change** (founder decision 2): the date bar, the focused date and the
  layers stay as they were while the viewer is open and after it closes.

If the clicked item has no position, the strip is replaced by one line: "This photo has no position,
so other dates can't be matched." If the project has one date, there is no strip.

The plan decides which viewer surfaces get the strip; the aim is every place an image opens from the
stage (the Scene photo cards, the Frames pane and the Media screen), with one shared component.

### Compare (B)

**Compare…** in the viewer header opens the T3 split view with two panes: the current item on the
left and, on the right, the best match on another date (the date before by default; chips above each
pane change it). Zoom and pan are linked as T3 already does for panoramas.

New in S1: a **Swipe** mode next to **Side by side**. Swipe lays the left date over the right in one
pane, with a draggable divider and a keyboard-operable slider. Swipe suits 360s and drone photos from
nearly the same pose; for two shots from clearly different places it still works, and the header
shows their distance so the user can judge.

## Part S2: spot on the map (D)

- A **Spot history** tool on the map, the ortho and the 3D view. Clicking a point drops a pin and
  runs the search with a target-only spot.
- Every match is drawn as a camera cone at its position, in its date colour, pointing at its facing
  direction; the current one is drawn larger.
- The right panel lists the history, newest first, with a large preview of the current match and a
  **Play** button that steps through the dates about once a second.
- Opening an item in the list goes to the same viewer and strip as S1.

S2 builds on S1's search and viewer and starts after S1 has landed.

## Out of scope

- The spot sheet (C) and picking shots for reports: T4.
- Matching by image content (feature matching); S1 and S2 use stored positions and directions only.
- Placing unplaced photos or walks to make them searchable.
- Saving a spot or its history in the project.
- Changing the main view's date from the viewer.

## Error handling

- No position on the clicked item: the one-line message above, no search.
- One survey date: no strip.
- A layer that fails to load or a video whose flight pose cannot be read is skipped; the strip still
  shows the other dates and the item counts as skipped.
- A thumbnail that fails to load shows the slot with its labels and a plain placeholder.

## Testing

- **Unit tests** for the search, with made-up poses: each kind inside and outside its tolerance,
  angles that wrap past 360°, aerial versus ground-level split, a drone footprint that does and does
  not cover the target, a video whose best moment is in the middle of the flight, a target-only spot,
  dates with no match, skipped counts for unplaced items, and ranking within a date.
- **Component tests** for the strip: empty slots, "+n", keyboard stepping that skips empty dates, the
  no-position message, and no strip for one date.
- **One end to end spec** (S1): open a placed photo on the synthetic change demo (with a second survey
  date), check the strip, step dates with the arrow keys, check the date bar is unchanged, open
  Compare and switch to Swipe. Run locally the way CI runs it (`CONTRIBUTING.md`, "End to end the way
  CI runs it"). S2 adds its own spec.
- The demo may need a second date of ground photos and a placed 360 at the same spot; the plan says
  whether the synthetic change demo already has them.

## Open points for the plan

- Which viewer components exist today for each surface and how one strip component fits them.
- Whether the synthetic change demo needs extra fixtures for the e2e spec.
- Where the flat-ground height comes from when a surface (mesh or DEM) is loaded; S1 may use flat
  ground at the camera's ground height everywhere and leave surfaces for later.
