# 360 walks: view cone, draped track and walk compare (design)

Status: decided by the founder on 24 Oct 2026, from an in-app spike (`feat/walk-compare`, spike commit `3eb11d5b4`). Builds on the walks design (`2026-10-07-walks-360-design.md`): this closes the W3 "map view cone that follows the look" and "3D view marker" items and the core of W5 (compare two walks).

## Why

The founder walks roughly the same route with a 360 camera on different survey dates and compares them by eye to spot what changed. Two walks are never the same path or pace, so a compare has to pair them by place, not by time. While playing, the founder needs to see where they are looking on the map and in 3D. And in the 3D view the walk track floated above the ortho, which made the walk look misplaced.

## What was decided

### 1. The track sits on the ground in 3D (fix)

- A walk has no GPS height; its height came from the placement pins, and a walk placed on the map stored ground 0 while the ortho quad sits at another height (DSM median minus origin). So the line floated.
- The 3D line is draped at draw time: for each sample (about every 1 m) the ground is the DSM straight down, else the visible ortho / mesh / cloud under it, else the stored pin height. Resampled when layers load or the date changes.
- The line is depth tested (things in front hide it), 3 px with a dark halo.
- The same ground feeds the pose heights (`packages/geo/src/walk/pose.ts`) and the spot history track (`workspace/spot/spotWalk.ts`), which carried the same error.
- Large models: sampling has a budget so draping never stalls the frame (my call: cap and spread the work over frames, fall back to the pin height for the rest).

### 2. The marker shows where you look (founder picked design A, "Beam")

- One marker per playing walk: a filled dot in the walk's date colour with a light ring, a soft fan that fades out in the look direction, and a small tick for the way the walk is moving.
- The fan turns with the 360 look (drag) and its width is the 360's horizontal field of view (zoom narrows it).
- The fan has a constant on-screen size on the map (it does not shrink when zoomed out) and fades smoothly (no banding).
- Same marker on drawings (sheets) and in 3D, where it lies flat on the draped ground with a short stem and dot so it reads from any angle.
- The spike's other designs (Compass, Rays) and the Ctrl+Alt+M / `stratlas.walkMarkerStyle` switch are removed.

### 3. Compare two walks (founder: "the comparisons look good")

- Two 360 panes side by side in the Split, a different walk on each. Start from the split (360 video on both sides) or right-click a walk › Compare with walk › the other walk.
- One walk is the **lead** and plays; the other **follows by nearest place** (default) or By time. Swap lead flips them.
- **Link look** (on by default): both panes look at the same world bearing, each corrected by its own walk's heading. The pane under the pointer steers.
- Routes that drift apart are normal (a team member may take a significantly different route), so nothing dims or blocks the picture (founder, 24 Oct, replacing the spike's dimmed pane):
  - The follower always shows its closest frame.
  - A small chip in the follower's corner gives the distance: neutral under 5 m ("2.1 m apart"), amber past it ("Routes apart · 18 m").
  - Each walk's scrubber shades the stretches where the other walk has no frame within 5 m (detours). Clicking or dragging into a shaded stretch plays that walk on its own; compare picks up again when the routes rejoin or the lead plays.
- A small corner map in the lead pane shows both tracks and both markers; map and 3D show both markers in their date colours.
- Pairing prefers the pass going the same direction when a walk crosses a spot twice.

## Constraints

- No contract change expected; if compare state is saved it lives in renderer prefs, not the project file. Starting a compare must not write layer visibility into the project.
- Strings go through `packages/ui/src/i18n/en.ts`; right-click entries through the shared action registry.
- CI: Windows only, 1100 x 720 at scale 1 on WARP; the new e2e must pass there.

## Left to the builder

- How the follower plays smoothly (playback rate matched to the lead's speed with occasional resync, or seeks with a debounce), as long as it does not stutter visibly.
- Whether compare state survives a restart (my call: remember per project for the session, not across restarts).
