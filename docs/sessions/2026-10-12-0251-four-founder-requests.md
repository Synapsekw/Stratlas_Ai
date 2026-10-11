---
type: session
date: 2026-10-12-0251
branch: docs/wrapup-four-founder-requests
status: complete
related:
  - ../plans/2026-10-11-project-types-design.md
  - ../plans/2026-10-11-split-view-parity-design.md
  - ../plans/2026-10-11-drawings-dataset-design.md
  - ../plans/2026-10-11-insta360-native-design.md
---

# Four founder requests in one night: project types, split view parity, drawings and 360 camera files

## What changed

- **Project types** (round 78): the wizard offers Survey, Construction, Vertical asset inspection, Confined space inspection, Data fusion and Road, stored as an optional manifest `purpose` beside the unchanged `type`; an empty project names its type and lists what to add first. The wizard's example text names no real customer or place any more.
- **Split view parity** (round 81): in a two-date comparison both 3D views show surface colours, pile bodies and toe lines for their own date, the second view has a read-only legend, and saved survey measurements show on both 3D views and both maps. Pointer tools stay in the main view.
- **Drawings** (round 85): a Drawings group in the tree; PDF, PNG, JPEG, WebP, SVG and plain TIFF import as drawings (a plan raster under `drawings/`), open side by side, are placed by point pairs, and take an opacity and **On top in 3D**. A hidden drawing loads nothing until shown.
- **360 camera files** (round 89): `.insv`, `.lrv` and stitched 360 MP4s import into `walks/<id>/` (stitched by the system ffmpeg), play in a **360 video** split pane, and a running import can be cancelled. This is the front slice of Walks 360 part W1.
- Each branch was built by one agent in its own worktree, with one heavy run at a time across them, and went through an independent read-only review before its hand-off; three of the four went back for fixes first.

## Why

The founder asked for all four in one message and was away overnight, so every scope choice took the smaller, additive option and is listed below for review. None of the four changes anything older installers refuse.

## How to test

1. **Project types**: Projects, **New project**: six type cards. Pick **Confined space inspection**, finish the wizard; the empty project shows the type and an **Add first** list. **Survey** still has the survey data block on the last step.
2. **Split view**: a stockpile project with two dates, select a pile, **Compare dates**, **Elevation**: both views are coloured on their own survey, controls on the left legend, a read-only legend on the right. A saved measurement shows on both views and both maps.
3. **Drawings** (use a test project; a drawing cannot be removed yet): **Add drawing** beside **Add data**, pick a PNG or a PDF; on its row, settings, **Side by side**, then **Place on the site** with two point pairs; move **Opacity** and switch **On top in 3D**. Full steps: `docs/TESTING.md`, Stage D.
4. **360 video** (needs ffmpeg on the PATH): **Add data** with an `.insv` and its `.lrv`; the panel shows the playback copy percentage and **Cancel**; the clip appears under **360 video** and opens in the split, drag to look. Full steps at the end of `docs/TESTING.md`.

## Open threads

- Founder review of the choices made without them: Construction is stored as the old `fusion` type and Digital twin is no longer offered; a measurement of one survey shows only on the pane showing that date, also in the ordinary split; picture drawings are hidden until placed and cannot be removed; walks are a side folder (no sync to hubs, every walk in every package) and ffmpeg is not shipped. The four contract rows say "pending founder review".
- Founder decisions written up in the design notes: what else a project type should set up; an elevation switch on the map side of the default split (about two days); DWG and IFC drawings; ffmpeg in the pipeline pack; walks as a layer kind when placing lands.
- Not built: drawing or measuring in the second view (designed as phase 2), the type on the Projects card, removing a drawing or a walk.
- Real client, asset and site names remain in about 35 other tracked files (tests, importer sources, older docs); a wide cleanup with renames is still to do, and git history keeps the old text.
- The Stop hook drafts in the main checkout were left alone: several belong to other sessions.

## Next session entry point

Start from the founder's answers to the open threads above; the likely first build is phase 2 of split view (a focused pane for pointer tools) or the rest of Walks 360 part W1.
