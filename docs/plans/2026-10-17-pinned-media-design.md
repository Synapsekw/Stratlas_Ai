# Pinned media: place photos, 360s and videos that have no GPS

Status: design, agreed with the founder in brainstorming on 17 Oct 2026.
Branch: `feat/pinned-media`.

## Why

People use Quadrion for virtual site visits. Drone data shows the site from above; ground-level photos, 360s and short videos show it from where a person stands, which is a different and valuable perspective. Ground media is often shot on a phone or an Insta360 with no GPS, so today it drops out of the scene: photos are listed in Media but never placed, a 360 with no GPS is silently turned into an ordinary photo, and videos have no way to be placed at all. A virtual visitor never finds them.

The trigger was a project where a ground-level Insta360 360 (an exported 2:1 equirectangular JPEG, 2560 x 1280, no GPano XMP, no GPS) was imported as a plain photo.

## The bug, found

`packages/project/src/builder/panoGroups.ts` does recognise the file as a ready-made 360 (aspect within 0.02 of 2:1), but a ready-made 360 without `lat`/`lon` is skipped with reason `no-position` (around lines 184-187), because `PanoRef.pos` is required (`packages/schema/src/layers.ts`). The file then falls through to the photo importer and becomes a `photos` layer item with no `pos`. Nothing anywhere reads Insta360 `.insp` stills.

## Goals

1. A 360 with no GPS imports as a 360, marked "not placed yet", never as a photo.
2. A 360 that was already imported as a photo can be turned back into a 360 ("Treat as 360") without re-importing, so the existing project is fixed in place.
3. Insta360 `.insp` stills import as 360s (they are JPEGs with an Insta360 trailer).
4. Any photo or 360 without a position can be pinned: the user picks it, chooses "Place on site", and clicks a spot on the point cloud, a GLB model, the map or the orthophoto. A pin appears there.
5. A pinned 360 is lined up: after the pin is dropped, the user clicks a landmark in the panorama and the same landmark in the scene or map, which sets the 360's heading. A direction arrow on the pin shows the heading and can be dragged to fine-tune. A second landmark pair refines the heading.
6. A pinned photo can optionally get the same direction arrow (which way it was taken). Without it, it still opens fine.
7. Pins show in the 3D scene and on the map and orthophoto, with an icon per kind (photo, 360), a small preview on hover, and click to open: photo in the split view beside the scene (as other photos), 360 in the panorama viewer facing the right way.
8. Right-click a pin: Move, Set direction, Remove pin. Removing keeps the media; it goes back to "not placed yet" (or, for an item that came with GPS, back to its GPS position). Pins can be hidden like any other layer.

## Non-goals

- **Ground videos (founder, 17 Oct: option A).** A phone or flat Insta360 clip without a drone flight log is skipped at import today (`raw.ts`, `NO_SRT_MESSAGE`), and the `video` layer requires a flight. Importing and pinning ground videos is a follow-up branch. Keep the pin code kind-agnostic (a pin targets a layer id plus item id plus kind) so videos can join later without reshaping it.
- Walks. A walked video already has its own start-and-end placement; leave it.
- Auto-placing media by image matching against the cloud or ortho.
- Pitch and roll for 360s (Insta360 shots are self-levelled). Heading only.
- Re-placing media that already has GPS (its pin can be moved like any other, but no new GPS-correction workflow).
- Several items per pin. One pin, one item; several shots from one spot are several pins.

## Anti-goals

- A 360 that opens facing the wrong way with no way to fix it.
- Pins that drift when survey dates are lined up (see constraints).
- Breaking any reader that assumes panoramas always have a position.
- New UI that ignores the foundation parts and fails the CSS guard.

## How it behaves

- **Height.** The pin sits on the clicked surface. A 360 or photo is raised to eye height above it, default 1.6 m, editable on the pin. _(My call)_ The pin stores the ground point and the eye height separately; the ref's `pos` is written as ground plus eye height, so current readers draw the sphere or frustum at eye level and editing the height needs no re-pick. A map or ortho pick takes its height from the scene at that spot (`terrainHeightAt` / a downward raycast on cloud, mesh or DSM), falling back to 0 with a "height unknown" hint on the strip.
- **Landmark line-up.** Picking a point in the panorama gives a bearing in the panorama's own frame; picking the same landmark in the scene gives a world bearing from the pin. The difference is the heading. With two pairs, average (circular mean). The arrow drag writes the heading directly. _(My call)_ The panorama-side pick is a small opt-in click hook on the existing pano viewer (`PanoPane` / `panoSurface`, not on d-ba's do-not-touch list) that reports a bearing while a line-up session is active; no new viewer.
- **Opening.** Reuse today's entry points: `openPhoto` (`builder/photoOpen.ts`) and `workspace.openPano`. Apart from the line-up click hook, no changes to the panes.
- **Treat as 360.** _(My call)_ Offered on any photo, suggested first when the photo is close to 2:1. Undoable ("Treat as photo"). The item joins a panoramas layer for its capture date (from EXIF, else the photo layer's date), creating one if none exists, so date line-up keys on the right layer.
- **Remove pin on an item that had GPS.** _(My call)_ Keep the original GPS position; "Remove pin" on such an item resets it to GPS. Only items with no GPS go back to "not placed yet".
- **Not placed yet.** The Media list shows unplaced items with a clear "Not placed" state and the "Place on site" action, also on right-click via the shared action registry.

## Constraints

- **Surveys with date line-up.** The "Line up dates" work (`feat/date-line-up`, not yet on `main`) adds a per-date sideways shift. A pin picked on a dated layer is stored unshifted (`unshiftLocal(p, dateShiftOf(manifest, layerId))`) and drawn shifted (`shiftLocal`). Undated layers never shift. _(My call)_ Build on `main` plus PR #162. Isolate the pick-to-store and store-to-draw conversions in one place each; date line-up merges before this branch anyway (it is queued right after stage island), so rebase onto it before merging and wire the real helpers then. No stub ships.
- **UI rework in flight (session d-ba).** Do not edit `workspace/Stage.tsx`, `FloatingVideo.tsx`, `MapMenus.tsx`, `SceneCursor.tsx`, `workspace/tools/*` island files, the right-panel shell (RightHeader, workbench store), the stage sections of `styles.css`, or `packages/ui/src/shortcuts.ts`. Draw pins as their own scene layer and map layer components; mount the placement strip from its own file with a single-line mount, bottom-centre over the stage (where `PlaceWalkStrip` sits), never top-centre. Build and test against `main` plus PR #162 (stage island). Do not merge until d-ba lifts their hold.
- **Foundation UI.** Use `@aio/ui` parts (`Button`/`IconButton`, `Tip`, `Row`, `Chip`, `EmptyState`, `Popover`/`Menu`), tokens (`--sp-*`, `--z-*`, `--el-*`, `--d-*`, `--ease`), the existing icon set, and put every string in `packages/ui/src/i18n/en.ts`. No `title=` tooltips, no raw spacing, z-index or shadow values.
- **Picking.** Reuse the shared picks: `SceneHandle.raycast` (meshes and point clouds via raycast providers), `groundHit` / `useStagePick` in the builder, `MapController.pickPoint` for map and ortho. Model the placement flow on `walks/placeWalk.ts` + `placeStore.ts` + `PlaceWalkStrip.tsx`.
- **Contract.** Any `@aio/schema` change gets a row in `docs/architecture/contract-changes.md`, and old projects must still load.

## Data (my call, the builder may refine)

Write positions into the existing refs so every current reader (photo frusta, pano spheres, panes) just works once an item is pinned:

- `PhotoRef`: `pos` and `q` are already optional. A pin sets `pos` (and `q` from the heading if one is set).
- `PanoRef`: make `pos` optional so a 360 can exist unplaced. Every reader that assumes `pos` must skip unplaced items; the builder audits and lists them.
- Each pinned item records `placement: 'pin'` (absent means GPS or pipeline), plus the eye height, so the UI knows it may be moved or removed, and removing restores the unplaced state.

## Left to the builder

- Exact schema field names and whether the pin record lives on the ref or in a sibling store, as long as readers keep working and old projects load.
- Pin icon art (from the existing set), hover preview size, the arrow's look.
- How `.insp` is decoded (likely: read the leading JPEG, ignore the trailer).
- The "Treat as 360" migration mechanics (move the item from the photos layer into a panoramas layer, keep its file, regenerate the thumb if needed).

## Testing

- Unit: pano classification of an unplaced 2:1 JPEG and an `.insp`; heading from one and two landmark pairs (wrap-around at 0/360); shift on store and draw; schema load of old projects.
- e2e: import an unplaced 360, place it on the scene, line it up with a landmark pair, click the pin and see the panorama open facing the landmark; place a photo and open it beside the scene; remove a pin and see "Not placed" again. Run the CI way (1100 x 720, scale 1, WARP).
