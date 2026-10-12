# Timeline T3: compare across dates

Status: design for founder review (12 Oct 2026). Part T3 of the timeline milestone
(`docs/plans/2026-10-07-timeline-design.md`). Written by a scoping session: the questions were
answered with the recommended option and are listed under "Decisions taken (founder to confirm)".
Plan: `docs/plans/2026-10-12-timeline-t3-compare.md`.

## Intent

A site is flown once a week or once a month. After T1 the app steps through the survey dates; what
it cannot do yet is put two dates side by side for the media people actually walk through:

- **Panoramas** are only viewed one at a time, inside the 3D view (click a marker, look around, Esc
  back). There is no way to stand at the same spot on 1 Nov and 6 Nov and look the same way.
- **Comparing is reached from the stage only** ("Compare dates" in the stage toolbar opens the first
  and last dates). The tree, where the dates now live, has no way to say "this date (or this
  layer) against that one".
- **The split's pane picker** lists pane kinds, with a second picker for the date. With T1's
  date-first tree the natural question is "which date, and what of it", not "which kind".

Success: from a date folder or a layer in the tree, "Compare with..." opens the right side by side
view on the two chosen dates in two clicks; two panoramas from different dates at the same spot
turn together; the split's picker reads by date; and a later part (T4 reporting, W5 walk compare)
can hook into the same pieces without rework.

Founder decisions carried over (7 Oct): free mixing of layers across dates (the 6 Nov and 1 Nov
panoramas both on), and jumping dates swaps the focused date's layers but keeps hand-picked extras.
T3 does not change either rule: comparing is a stage layout, not a visibility change.

## What exists

| Piece                                                                                                                | Where                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Split model, per-date panes `PER_CAPTURE = ['3d','map','raster']`, `chooseCapture`, `followsFocus`, `parseSplitPref` | `apps/desktop/src/renderer/workspace/splitModel.ts`        |
| Pane chooser (kind select + date select + link button), `EXTRA_PANES` mount point                                    | `workspace/SplitPanes.tsx` (`PaneChooser`)                 |
| "Compare dates" button, `COMPARE_TOOLS` mount point                                                                  | `workspace/CompareControls.tsx`                            |
| Ortho swipe and blend                                                                                                | `workspace/MapSwipe.tsx`                                   |
| Frames: video frame or photo beside the same view on another date, "Compare with" date select                        | `workspace/FramesPane.tsx`, `framesModel.ts`               |
| Left side follows the date bar's focus                                                                               | `workspace/Stage.tsx` (uses `followsFocus`)                |
| Saved split per project (localStorage `stratlas.stagePrefs`)                                                         | `workspace/stagePrefs.ts`                                  |
| Panorama immersive view in 3D, shader with partial coverage                                                          | `packages/engine/src/adapters/panoramas.ts`                |
| Look maths (`PanoLook`, `dragLook`, `zoomLook`, `startLook`, `parsePanoIndex`, `coverageFromImage`)                  | `packages/engine/src/adapters/panoMath.ts`                 |
| 360 walk player (video on a sphere, own look state)                                                                  | `walks/Walk360Pane.tsx`, `packages/video/src/panoVideo.ts` |
| Date folder and layer right-click menus                                                                              | `shell/DateMenus.tsx`, wired in `shell/Sidebar.tsx`        |
| `PanoRef { id, src, pos, headingDeg }` (manifest)                                                                    | `packages/schema/src/layers.ts`                            |

Note: the brief calls the split's picker `PaneSelect`; in the code it is `PaneChooser` in
`SplitPanes.tsx`.

## Decisions taken (founder to confirm)

1. **A new split pane kind, "Panoramas" (`pano`), drawn per date.** It joins `PER_CAPTURE`, so the
   split can show it twice, one date per side, with the existing date rules (left follows the date
   bar, right keeps its own date, never the same date twice). Offered when the project has a
   panoramas layer. The immersive view inside 3D stays as it is.
2. **Pairing by position, the left side leads.** The left pane shows a panorama of its date (the
   selected panorama, else the remembered one, else the first). The right pane shows the panorama
   of its date nearest on the ground (horizontal distance between `pos`). Within 25 m it is a
   match; beyond that the pane says "No panorama of 1 Nov within 25 m" and offers "Show the
   nearest (48 m)". The right side has no stepper of its own: stepping is done on the left and the
   right follows. Height is ignored (the same spot from a pole or a drone mast).
3. **Linked look in the world frame.** Panoramas carry `headingDeg`, so yaw is already a compass
   bearing. Linked panes share one look (yaw, pitch, zoom); dragging or zooming either moves both.
   The existing link button on the right chooser (`compare-link`, `unlinked` in the saved split)
   unlinks them, as for two 3D views or two maps. Each pane bar shows its bearing ("HDG 123°").
4. **Linked look is its own small module, built for walks too.** A `LookLink` store holding the
   shared look, and two pure functions (`toShared`, `fromShared`) that turn a member's own look into
   the shared one and back through that member's yaw offset. Whether two panes are linked stays
   with the caller (the split's `unlinked`), so the store has one job. Panoramas use offset 0. W5 (walk compare) can give each walk an offset, because a 360 video has
   no reliable heading, and reuse the store unchanged. It lives in the renderer
   (`workspace/lookLink.ts`), next to its two users, not in an engine package.
5. **The panorama pane draws with the engine's panorama shader, extracted, not copied.** The sphere
   material with partial coverage moves from `adapters/panoramas.ts` to an exported
   `panoSphereMaterial` in `@aio/engine`; the 3D adapter uses it unchanged. The pane builds a small
   three.js view of its own (one sphere, one camera, draws on demand), like the walk player.
   Coverage comes from `panoramas/panoramas.json` when present, else from the image size.
6. **"Compare with..." in the tree, one entry point.** A pure `planCompare(request, context)` turns
   `{ from, to, layer? }` into a split layout; `compareWith(request)` applies it and opens the
   split. Both menus call it; T4 calls it too.
   - **On a date folder:** "Compare with..." switches the menu to the list of the other dates
     (newest first, with their tags). Picking one opens the split with the folder's date on the left
     and the picked date on the right, on the kind the stage shows now (map from the map, the
     left kind from a per-date split, else 3D; Low graphics tier: maps, as "Compare dates" does).
   - **On a layer or a group:** "Compare with another date..." first, then the existing "File under"
     list (only in a project that can be edited). The kind follows the layer: panoramas to two
     Panoramas panes, an ortho or other raster to two Ortho panes (the layer's counterpart on the
     other date), a model, point cloud or tileset to two 3D views, a vector to two maps, video or
     photos to the Frames pane with that layer as the source and the picked date as the other.
     Dates with no matching layer are listed but disabled, with the reason ("No panoramas").
   - The menu also shows on read-only projects (comparing writes nothing).
7. **T4 hook.** `COMPARE_WITH_ACTIONS`, a mount point like `COMPARE_TOOLS`: extra rows a later part
   adds under each target date of the "Compare with" list (T4: "Progress against 1 Nov"). T3 ships
   it empty, with a unit test that a registered row shows and receives the request.
8. **The split's picker becomes one select, grouped by date.** Option groups, newest date first:
   each date lists what it has (3D view, Map, Ortho when it has a raster, Panoramas when it has
   panoramas), then a group "Any date" with the panes that do not follow a date (Video, Photos,
   Report, Frames, 360 video). Picking an option sets the kind and the date in one step; the
   separate date select goes. The date tag swatch stays before the select. The rules for what may
   show twice and the clash handling stay in `splitModel.ts`. Without two dates the select is
   today's flat list.
9. **No contract change.** The saved split is renderer-side localStorage (`stagePrefs.ts`), not
   `@aio/schema`. It gains `pano?: string` (`<layerId>/<panoId>`, the left panorama) beside `raster`
   and `report`; `parseSplitPref` accepts `pano` as a kind and the new field, and an older build
   reading it drops the side back to its default (the parser rejects unknown kinds). No manifest,
   IPC or file format change; `PanoRef` is read only.
10. **Selecting a panorama elsewhere** (a 3D marker, the Media screen) while the split shows
    Panoramas puts it on the left: its date becomes the left date (the right swaps date if it
    showed that one, as `chooseCapture` does) and the right re-pairs.
11. **Following a date.** When a side's date changes (date bar on the left, picker on either side),
    its panorama becomes the one of the new date nearest to the panorama it showed, so the spot is
    kept while the date changes.
12. **Low graphics tier:** two Panoramas panes are allowed on every tier (one sphere each, no
    scene). If WebGL fails the pane shows the existing "no graphics" message.

## Design

### Units

| Unit                       | Kind                      | Does                                                                                                                                                   |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace/panoPair.ts`    | pure                      | Panoramas of a date (`panosOf`), nearest by ground distance (`pairPano`), step on the left (`stepPano`), keep the spot on a date change (`followPano`) |
| `workspace/lookLink.ts`    | pure + vanilla store      | `LookLink` store (shared look), `toShared` / `fromShared` with yaw offsets                                                                             |
| `@aio/engine` `panoSphere` | three.js material factory | Partial-coverage panorama sphere material, used by the 3D adapter and the pane                                                                         |
| `workspace/panoView.ts`    | three.js, no React        | `createPanoImageView(host, { url, headingDeg, coverage }, look)`: draw on demand, `setLook`, `setImage`, `dispose`                                     |
| `workspace/PanoPane.tsx`   | React                     | One side: picks its panorama, drag and wheel to look, bar with stepper (left), pairing note (right), bearing                                           |
| `workspace/compareWith.ts` | pure + action             | `planCompare`, `compareWith`, `COMPARE_WITH_ACTIONS`, `compareTargets` (dates and why one is disabled)                                                 |
| `splitModel.ts` changes    | pure                      | `pano` kind in `PANE_KINDS`, `PER_CAPTURE`, `paneOptions`; `pano` field in `SplitPref` and the parser; `paneGroups` for the grouped picker             |
| `SplitPanes.tsx` changes   | React                     | Grouped `PaneChooser`; `pano` built-in pane                                                                                                            |
| `DateMenus.tsx` changes    | React                     | "Compare with..." in both menus, inline date list, read-only aware                                                                                     |
| `Sidebar.tsx` change       | React (a few lines)       | Layer menu opens on read-only projects too (`canEdit` passed down instead of gating)                                                                   |

### Data flow

```
tree menu ─> compareWith({ from, to, layer? }) ─> planCompare ─> stagePrefs.update(split) + shell.setStageMode('split')
                                                               └> framesState (video/photos)
selection (pano) ─┐
date bar focus ───┼─> SplitPref (left/right kind, leftCapture/rightCapture, pano) ─> PanoPane left ─> pairPano ─> PanoPane right
side picker ──────┘
drag/wheel in either PanoPane ─> LookLink (linked) ─> both views setLook
```

### Panorama pane

```
┌ pane-bar ───────────────────────────────────────────────┐
│ [6 Nov] [<] P-0012  3 of 41 [>]          HDG 123°        │  left
└─────────────────────────────────────────────────────────┘
┌ pane-bar ───────────────────────────────────────────────┐
│ [1 Nov] P-0009  2.4 m away               HDG 123°        │  right
└─────────────────────────────────────────────────────────┘
```

The bar uses the existing `pane-bar`, `DateBadge`, ghost icon buttons and mono labels; the pane
chooser sits in its corner as on every split side. No new visual vocabulary: it should read as one
more split pane. Data attributes for tests: `data-testid="pane-pano"`, `data-pano`, `data-capture`,
`data-yaw`, `data-distance`.

Empty and failure states, each with a way forward:

- the side's date has no panoramas: "No panoramas on 4 Sep. Pick another date above.";
- no match within 25 m: "No panorama of 1 Nov within 25 m" and the button "Show the nearest (48 m)";
- image missing: "This panorama's image is missing" (the bar still steps);
- no WebGL: the walk player's "no graphics" message.

Keyboard: the pane takes focus on click; arrows turn (5 degrees), `+` and `-` zoom, Page Up and Page
Down step on the left. Accessible name: "Panorama P-0012, 6 Nov 2024".

### Grouped picker

`paneGroups(options, index, layers)` returns `{ label, capture | null, options: { kind, capture,
disabled }[] }[]`. The select value is `kind` for an undated pane and `kind@capture` for a dated
one; `chooseSide` and `chooseCapture` apply it. The option a side may not take (the other side's
undated pane, or the other side's exact kind and date) is disabled, as `blockedFor` does today.

### Edge cases

- One survey date: no grouping, no "Compare with..." (it needs another date), Panoramas pane shows
  once and steps through all panoramas.
- A date with panoramas in two layers: `panosOf` takes all panoramas layers of that date.
- Undated panoramas layer: shown on every date as candidates for both sides (same rule as undated
  rasters in `RasterPane`).
- Saved `pano` that no longer exists: falls back to the first panorama of the left date.
- Two dates on the same day: separate groups, labelled with the capture label as today.

## Testing

- Unit: `panoPair` (nearest, threshold, ties, undated layers, step wrap, follow on date change);
  `lookLink` (linked and unlinked, offsets, wrap at 360, pitch clamp); `splitModel` (`pano` in
  options, twin rules, parser round trip with `pano`, rejected malformed values, `paneGroups`
  ordering and disabled options); `compareWith` (`planCompare` per layer kind and per stage mode,
  disabled targets and reasons, Low tier, `COMPARE_WITH_ACTIONS` row); `DateMenus` (both menus show
  the date list, disabled reasons, read-only shows compare without "File under"); `panoSphere`
  material uniforms (engine).
- e2e (new `pano-compare.spec.ts`, synthetic `e2e-pano-dates` project written by the spec: three
  dates with three panoramas each, tiny generated equirect PNGs, positions 2 m apart between
  dates): Compare with from a layer and from a date folder; pairing ids; linked drag moves the
  other pane, unlinked does not; grouped picker changes the right date and re-pairs; date bar moves
  the left date and keeps the spot; reopening the project keeps the layout; nothing over the view at
  1100 x 700.
- Changed e2e: `compare.spec.ts` and `change-raster.spec.ts` pick panes through the grouped select.
- Docs: `docs/guide/04-compare-dates.md` gains panoramas and "Compare with..."; `docs/TESTING.md`
  founder steps.

## Out of scope

T4 progress reporting (only its hook), walk compare (W5; only the reusable linked look), a
panorama blend or swipe, pairing photos by position (the Frames pane pairs them by pose already),
editing a panorama's heading, the Ctrl+K palette (a parallel branch changes it).
