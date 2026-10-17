# Pinned media: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 360 without GPS imports as an unplaced 360 (also Insta360 `.insp` stills), a photo can be turned into a 360 and back, and any photo or 360 can be pinned on the site, lined up by landmark pairs or a dragged arrow, opened from its pin, moved, re-aimed and unpinned.

**Architecture:** Positions go into the existing refs so every current reader keeps working: a pin writes `pos` (ground plus eye height), a photo's `q` or a 360's `headingDeg`, and records itself in an optional `pin` on the ref (the spec's `placement: 'pin'`), keeping any GPS place it replaced. `PanoRef.pos` becomes optional and every reader that assumed it is guarded. Pure maths (bearings, circular mean, click bearing) lives in `@aio/geo`; the placing session is a renderer store modelled on the walk placing (`walks/placeStore.ts`), with the date line-up conversions isolated in one module. Pins draw as their own scene layer and map layer, mounted with the strip and the pin menu from one host component that `builder/BuilderLayer.tsx` mounts in one line.

**Tech Stack:** TypeScript strict, zod (`@aio/schema`), React 19 + zustand, three.js via `@aio/engine`, MapLibre via `@aio/maps`, sharp in main, Vitest, Playwright with Electron.

**Spec:** `docs/plans/2026-10-17-pinned-media-design.md` (agreed with the founder, 17 Oct 2026). Read it, `CONTRIBUTING.md` and `CLAUDE.md` before any task.

**Worktree:** `E:\Dev\AIO Software\.claude\worktrees\pinned-media`, branch `feat/pinned-media`. Every path below is relative to it. Never edit the main checkout or another worktree.

## Global Constraints

- Do NOT edit: `apps/desktop/src/renderer/workspace/Stage.tsx`, `FloatingVideo.tsx`, `MapMenus.tsx`, `SceneCursor.tsx`, `workspace/tools/*` island files, the right-panel shell (RightHeader, workbench store), stage sections of `styles.css`, `packages/ui/src/shortcuts.ts`. Pins are their own scene-layer and map-layer components; the placement strip is its own file mounted with a single-line mount, bottom-centre (PlaceWalkStrip's spot), never top-centre. If a single-line mount must go into a forbidden file, say so explicitly and find the nearest allowed mount point instead. (Here: `PlaceWalkHere` and `WalkSceneMount` are mounted in `Stage.tsx`, which is forbidden, so the one-line mount goes into `builder/BuilderLayer.tsx`, mounted from `App.tsx`; see Task 13.)
- UI uses `@aio/ui` parts (`Button`/`IconButton`, `Tip`, `Row`, `Chip`, `EmptyState`, `Popover`/`Menu`), tokens `--sp-*`, `--z-*`, `--el-*`, `--d-*`, `--ease`, the existing icon set (`photo`, `pano`, `pin`, `crosshair`, `target` here); all strings in `packages/ui/src/i18n/en.ts`; the CSS guard test (`packages/ui/src/cssGuard.test.ts`) forbids `title=` tooltips and raw spacing, z-index and shadow values.
- Date line-up (branch `feat/date-line-up`, not on `main`): pick-to-store (unshift) and store-to-draw (shift) are isolated in one module each (`pins/pinFrame.ts`) with an identity implementation now; Task 16 swaps in `unshiftLocal`/`shiftLocal` (`@aio/schema` `dateShift.ts`) and `dateShiftOf` (`@aio/workspace` `dateShifts.ts`) after rebasing onto that branch, before merge. Task 16 depends on the branch having landed. No stub ships.
- Ground videos are out of scope; pin types are keyed by `{ layerId, itemId, kind }` with `kind: 'photo' | 'pano'` so video can join later.
- Electron e2e windows stay off-screen (the fixtures do this); e2e runs with `--workers=1` at 1100 x 720, display scale 1, WARP (`QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp`), one Playwright run at a time.
- Build and test against `main` plus PR #162 (stage island, `feat/stage-island`, open on 17 Oct). Rebase onto it as soon as it lands; do not merge this branch until session d-ba lifts their hold.
- TypeScript strict; no `any`, no non-null assertions. Renderer code never imports `electron` or `node:*`.
- No em or en dashes in user-facing text; no emoji. No client, site, tester or person names anywhere; run `node tools/agent/check-public-text.mjs <files>` on every doc added or changed.
- Eye height default `1.6` m (`DEFAULT_EYE_M`), range 0 to 10 m. Heading in degrees clockwise from grid north, wrapped to `[0, 360)`. Local frame: x east, y up, z south (`packages/geo/src/camera.ts:24`); azimuth `atan2(dx, -dz)` as `dirToAzEl` (`packages/engine/src/adapters/panoMath.ts:54`).
- Commits: conventional, stage by path (never `git add -A` / `git add .`), never a bare `git stash`, message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec implies but no headline test exercises, most likely to bite first. Each has its test in the owning task.

1. **An Insta360 `.insp` that is two unstitched fisheye circles** (what most cameras write before Insta360 Studio stitches it): it must not import as a 360 that looks like garbage. Skipped with reason `dual-fisheye` and a sentence saying to export an equirect from Insta360 Studio. Tests: T6 (`looksDualFisheye`, `groupPanoFrames` skip).
2. **A landmark clicked on or next to the pin** (horizontal distance under 0.5 m) gives no bearing: the click is ignored with a hint, the pair is not stored. Tests: T3 (`bearingDeg` null), T8 (`pickLandmark` keeps the step, sets `note`).
3. **Two landmark pairs that disagree by about 180 degrees** (the circular mean has no direction): keep the first pair's heading and say the landmarks disagree. Tests: T3 (`circularMeanDeg` null), T8.
4. **Remove pin on an item that came with GPS** after it was moved and aimed: `pos` and `q` come back exactly as they were. Tests: T5.
5. **Treat as 360 on a photo with marks on it, or in a package project**: refused before any write, with a reason; Treat as 360 then Treat as photo of a pinned item keeps the pin. Tests: T7.

## Contract changes

All in `@aio/schema`; old projects load unchanged (every new field is optional; `PanoRef.pos` only loosens). The manifest stays `aio.project/1` (no migration: `parseManifestTolerant` and the zod defaults cover it, `packages/schema/src/manifest.ts:7`).

| Where                                 | Change                                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layers.ts` `MediaPin` (new)          | `z.object({ ground: Vec3, eyeM: z.number().min(0).max(10).default(1.6), headingDeg: z.number().min(0).lt(360).optional(), gps: z.object({ pos: Vec3, q: Quat.optional() }).optional() })`, not strict |
| `layers.ts` `PhotoRef`                | `pin: MediaPin.optional()`                                                                                                                                                                            |
| `layers.ts` `PanoRef`                 | `pos: Vec3.optional()` (was required); `pin: MediaPin.optional()`                                                                                                                                     |
| `builder.ts` `LayerPatch`             | new member `z.object({ mediaPin: z.object({ itemId: Id, pin: MediaPin.nullable() }).strict() }).strict()`                                                                                             |
| `panoStitch.ts` `PanoScanReady`       | `lat`, `lon` optional                                                                                                                                                                                 |
| `panoStitch.ts` `PanoSkipReason`      | adds `'dual-fisheye'`                                                                                                                                                                                 |
| `ipc.ts` `builder:convertMedia` (new) | request `{ projectId, layerId, itemId, to: 'pano' \| 'photo' }` (strict); response `{ ok: true, manifest, layerId, itemId } \| { ok: false, error }`                                                  |

Row to add to `docs/architecture/contract-changes.md` (Task 1), exact text:

```
| 2026-10-17 | `PanoRef.pos` becomes optional: a 360 with no GPS imports unplaced ("Not placed") instead of turning into a photo. Additive `MediaPin` `{ ground: Vec3, eyeM (0 to 10, default 1.6), headingDeg?, gps?: { pos: Vec3, q?: Quat } }` as an optional `pin` on `PhotoRef` and `PanoRef`: a place the person pinned on the site. The writer sets `pos` to `ground` plus `eyeM` up, a pinned photo's `q` from `headingDeg` (level camera), a pinned 360's `headingDeg`, and keeps the GPS place it replaced in `gps`. Additive `LayerPatch` member `{ mediaPin: { itemId, pin: MediaPin \| null } }` for photos and panoramas layers; `null` puts the GPS place back, or leaves the item unplaced. `PanoScanReady.lat` and `.lon` become optional; `PanoSkipReason` adds `dual-fisheye`. Additive IPC `builder:convertMedia` `{ projectId, layerId, itemId, to: 'pano' \| 'photo' }` returns `{ ok, manifest, layerId, itemId }` or `{ ok: false, error }`: it moves one ready-made image between a photos layer and a panoramas layer of its date (created when missing), keeping its file; refused on a package and on a photo with image sightings. Builds without this change (0.19 and earlier) read a pinned item and drop `pin` when they save; they refuse a project that holds an unplaced 360 (its `pos` is missing). | Place ground photos and 360s that have no GPS (`docs/plans/2026-10-17-pinned-media-design.md`) | @aio/schema, @aio/project, @aio/engine, @aio/maps, @aio/ai, @aio/ui, desktop | Founder, pinned media design of 2026-10-17 (data shape left to the builder); sign-off at merge |
```

Also add one paragraph to `docs/architecture/data-conventions.md` section 34 (drone panoramas) and the photos section: `pos` may be absent on a 360 ("not placed"); `pin` and its fields as above.

## Pano reader audit (Task 2 owns every guard)

Readers that assume `PanoRef.pos`, from a full grep of TS and Python. Python reads no pano `pos` (`python/src/aio_pipelines/pano/*` only reads frames); `tools/compat/schema-0.*` are frozen history and stay as they are.

| Site                                                            | What it does                                      | Guard                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine/src/adapters/panoramas.ts:260`                 | `const items = layer.items` feeds the adapter     | `layer.items.filter(hasPos)`: covers the stems (269), marker sites (292), enter (406), bounds (620) with consistent indices     |
| `panoramas.ts:403-406`                                          | entering a sphere                                 | `panoOpenable(p) && hasPos(p)`, else return                                                                                     |
| `apps/desktop/src/renderer/panos/PanoSphereRows.tsx:84`         | fly to `item.pos`                                 | fly action disabled (no handler) without `pos`                                                                                  |
| `apps/desktop/src/renderer/panos/panos.ts:137`                  | `revealPanoLayer` bounds                          | `flatMap` drop undefined; the existing empty return covers it                                                                   |
| `apps/desktop/src/renderer/shell/layerBounds.ts:53,79`          | `knowsWhere` true for any panoramas layer; bounds | `l.items.some(hasPos)`; `flatMap` filter                                                                                        |
| `packages/project/src/builder/extents.ts:230`                   | project extent                                    | `flatMap` filter (copy `:135`)                                                                                                  |
| `packages/ai/src/places.ts:524,547-557`                         | layer box; pano place with `p` and `eye`          | `flatMap`; emit the place without `p`/`eye` when `pos` is absent (as photos at `:544`)                                          |
| `apps/desktop/src/renderer/workspace/panoPair.ts:28,54`         | `panosOf`, `groundDistance(from.pos, ...)`        | `panosOf` keeps only positioned panos (also hides the Panoramas pane for a project of only unplaced ones, `SplitPanes.tsx:165`) |
| `apps/desktop/src/renderer/workspace/spot/spotEntries.ts:48-54` | `PanoEntry.pos = p.pos`                           | add `hasPos` to the existing `.filter(panoOpenable)`; `PanoEntry.pos` stays required                                            |
| `apps/desktop/src/renderer/workspace/SelectionCard.tsx:226`     | `position: pano?.pos`                             | none (tolerates undefined); confirm by typecheck                                                                                |
| `packages/project/src/builder/panos.ts:170` (writer)            | `pos: cam.pos ?? [0, 0, 0]`                       | Task 6: omit `pos` instead of faking the origin (a sphere without a camera place was silently put at the origin)                |
| `packages/project/src/builder/panos.test.ts:142-144`            | `p1?.pos[0]`                                      | Task 6: `p1?.pos?.[0]`                                                                                                          |

`hasPos<T extends { pos?: Vec3 | undefined }>(p: T): p is T & { pos: Vec3 }` is added next to `panoOpenable` in `panoMath.ts:167` and exported from `@aio/engine`; desktop readers import it from there. The engine adapters for photos already skip unplaced photos (`posedPhotos`, `locatedPhotos`).

## Package ownership

| Task | Packages and areas touched                                                                                                                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `packages/schema` (`layers.ts`, `builder.ts`, `panoStitch.ts`, `ipc.ts`, tests); `tools/compat/pinned-media-additive.test.mjs` (new); docs `architecture/contract-changes.md`, `architecture/data-conventions.md`                                                                                        |
| T2   | `packages/engine` (`adapters/panoMath.ts`, `adapters/panoramas.ts`, `index.ts`); `packages/project` (`builder/extents.ts`); `packages/ai` (`places.ts`); desktop renderer `panos/PanoSphereRows.tsx`, `panos/panos.ts`, `shell/layerBounds.ts`, `workspace/panoPair.ts`, `workspace/spot/spotEntries.ts` |
| T3   | `packages/geo` (`src/mediaPin.ts` new, `src/index.ts`)                                                                                                                                                                                                                                                   |
| T4   | `packages/ui` (`actions/types.ts`, `i18n/en.ts`)                                                                                                                                                                                                                                                         |
| T5   | `packages/project` (`builder/mediaPin.ts` new, `builder/create.ts`)                                                                                                                                                                                                                                      |
| T6   | `packages/project` (`builder/panoGroups.ts`, `builder/panos.ts`); desktop main `panos.ts`, `fisheye.ts` (new); desktop renderer `builder/state.ts`, `builder/ImportPanel.tsx`                                                                                                                            |
| T7   | `packages/project` (`builder/convertMedia.ts` new, `builder/index.ts`); desktop main `convertMedia.ts` (new), `index.ts`; preload `index.ts`                                                                                                                                                             |
| T8   | desktop renderer `pins/pinModel.ts`, `pins/pinFrame.ts`, `pins/pinStore.ts` (all new)                                                                                                                                                                                                                    |
| T9   | desktop renderer `workspace/panoPickHook.ts` (new), `workspace/panoSurface.tsx`, `workspace/PanoPane.tsx`                                                                                                                                                                                                |
| T10  | desktop renderer `pins/placePin.ts`, `pins/PinStrip.tsx`, `pins/pins.css`, `pins/openBeside.ts` (all new)                                                                                                                                                                                                |
| T11  | desktop renderer `pins/pinScene.ts`, `pins/PinSceneMount.tsx` (new)                                                                                                                                                                                                                                      |
| T12  | `packages/maps` (`src/mediaPins.ts` new, `src/index.ts`); desktop renderer `pins/PinMapMount.tsx`, `pins/pinHover.css` (new)                                                                                                                                                                             |
| T13  | desktop renderer `pins/PinMediaHost.tsx`, `pins/PinMenu.tsx`, `shell/actions/pinActions.tsx` (new), `shell/actions/index.ts`, `screens/Media.tsx`, `screens/mediaModel.ts`, `builder/BuilderLayer.tsx` (one line)                                                                                        |
| T14  | `apps/desktop/e2e` (`pinFixture.ts`, `pinned-media.spec.ts`, `pinned-media-import.spec.ts`, all new); docs `docs/guide/` (photos and 360s chapter), `docs/TESTING.md`                                                                                                                                    |
| T15  | none (verification)                                                                                                                                                                                                                                                                                      |
| T16  | desktop renderer `pins/pinFrame.ts`, `pins/pinFrame.test.ts`                                                                                                                                                                                                                                             |

## Execution DAG

```
T1 schema ──┬─> T2 reader guards ─────────────────────────────────────────────┐
            ├─> T5 pin writer ──────────────┐                                 │
            ├─> T6 import 360s, .insp ──────┼─────────────────────────────────┤
            ├─> T7 treat as 360 ────────────┼──────────────> T13 host, menus, ├─> T14 e2e ─> T15 verify ─> T16 date line-up swap
            └─> T8 pin store ──┬─> T10 flow + strip ───────> Media, mount ────┘                              (after feat/date-line-up lands)
T3 geo maths ─┬─> T8           ├─> T11 scene layer ────────>
              └─> T9 pano hook ┘   T12 map layer ──────────>
T4 ui target + strings ───────────────────────────────────>  T13
```

| Task | Depends on                                |
| ---- | ----------------------------------------- |
| T1   | none                                      |
| T2   | T1                                        |
| T3   | none                                      |
| T4   | none                                      |
| T5   | T1, T3                                    |
| T6   | T1                                        |
| T7   | T1                                        |
| T8   | T1, T3                                    |
| T9   | T3                                        |
| T10  | T4, T5, T8, T9                            |
| T11  | T3, T8                                    |
| T12  | T8                                        |
| T13  | T4, T7, T10, T11, T12                     |
| T14  | T2, T6, T13 (test ids fixed in this plan) |
| T15  | all of T1 to T14                          |
| T16  | T15 and `feat/date-line-up` on `main`     |

**Parallel batches** (each dispatched in one message; tasks in a batch share no file):

| Batch | Tasks                  | Files they own (no overlap)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | T1, T3, T4             | schema `layers*`, `builder*`, `panoStitch*`, `ipc*`, compat test, two architecture docs; geo `mediaPin*`, `index.ts`; ui `actions/types.ts`, `en.ts`                                                                                                                                                                                                                                                                                                                                                     |
| 2     | T2, T5, T6, T7, T8, T9 | T2 engine `panoMath*`, `panoramas*`, engine `index.ts`, project `extents*`, ai `places*`, desktop `panos/*`, `layerBounds*`, `panoPair*`, `spotEntries*`; T5 project `mediaPin*`, `create*`; T6 project `panoGroups*`, `panos*`, main `panos*`, `fisheye*`, renderer `builder/state*`, `ImportPanel.tsx`; T7 project `convertMedia*`, `builder/index.ts`, main `convertMedia*`, main `index.ts`, preload; T8 `pins/pinModel*`, `pinFrame*`, `pinStore*`; T9 `panoPickHook*`, `panoSurface*`, `PanoPane*` |
| 3     | T10, T11, T12          | `pins/placePin*`, `PinStrip*`, `pins.css`, `openBeside*`; `pins/pinScene*`, `PinSceneMount*`; maps `mediaPins*`, maps `index.ts`, `pins/PinMapMount*`, `pinHover.css`                                                                                                                                                                                                                                                                                                                                    |
| 4     | T13                    | `pins/PinMediaHost*`, `PinMenu*`, `shell/actions/pinActions*`, `shell/actions/index.ts`, `screens/Media*`, `mediaModel*`, `BuilderLayer.tsx`                                                                                                                                                                                                                                                                                                                                                             |
| 5     | T14                    | `e2e/pinFixture.ts`, two specs, guide and TESTING docs                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6     | T15                    | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7     | T16                    | `pins/pinFrame*` (after rebasing onto `feat/date-line-up`)                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Critical path:** T1 -> T8 -> T10 -> T13 -> T14 -> T15 (-> T16 once date line-up lands). T3 is as short as T1 and runs beside it.

**Typecheck between batches.** Vitest does not typecheck. T1 makes `PanoRef.pos` optional, so `pnpm typecheck` fails in the readers T2 guards (and in `panos.ts`, T6) until batch 2 lands. Each task keeps its own files type-clean; batch 2 closes the gap and T15 proves the whole repo green.

**Stage island.** Before batch 3, check whether PR #162 is on `main`; if so, rebase the branch (no WIP left uncommitted) before dispatching. If not, build on `main` and re-check the strip's mount and position after the rebase in T15.

## e2e specs

| Spec                                           | Change | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/e2e/pinned-media.spec.ts`        | new    | Media shows "Not placed" on an unplaced 360 and photo; Place on site from the tile's right-click; the strip sits bottom-centre and clicks at the view centre reach the canvas (1100 x 720 and 1100 x 700); pin in 3D; line up with two landmark pairs; manifest `pos` = ground + 1.6 up, `headingDeg` 95 +-1; clicking the pin's marker enters the 360 facing `headingDeg`; a photo placed on the map opens beside the map; Remove pin brings "Not placed" back. |
| `apps/desktop/e2e/pinned-media-import.spec.ts` | new    | Add data with a 2:1 JPEG without GPS, an equirect `.insp` and a dual-fisheye `.insp`: the offer says two 360s will import as not placed and names the fisheye skip; after import the panoramas layer has two items without `pos`; Treat as 360 on a 2:1 photo moves it into the date's panoramas layer, Treat as photo moves it back.                                                                                                                            |

Neither needs the change demo nor the pipeline Python: the fixture writes the manifest directly (`e2e/panoFixtures.ts` `solidPng`, `sharp` JPEGs as in `photo-align.spec.ts`), and a ready-made-only pano import queues no `pano.stitch` job (`packages/project/src/builder/panos.ts`: only spheres queue jobs; the builder confirms and, if a job is queued after all, adds `test.skip(!hasPanoStitch(VENV_PYTHON))` as `drone-panoramas-photos.spec.ts` does). CI builds every demo anyway; run `pnpm demo:build --quick` before the local CI-way run (T15).

## Spec ambiguities resolved here

1. **Pin record.** The spec's `placement: 'pin'` is the presence of `pin` on the ref; `pin.eyeM` is the eye height, `pin.ground` the clicked surface point, `pin.gps` the GPS place it replaced.
2. **Which date shift.** The pin is stored in its media layer's frame: `toStore(p, manifest, mediaLayerId)` unshifts by the media layer's shift and `toDraw` shifts by the same, so a pin drops exactly where it was clicked and moves with its own date when that date is lined up later. On the date line-up branch the photo and 360 adapters already shift items by their own layer, so `pos` written in that frame draws in the same place.
3. **Two writes.** The pin's place is saved on the surface click (a pin appears at once); the line-up or aim saves the heading in a second write. The Panoramas pane only lists placed 360s (`panosOf`), so a 360 must be placed before it can be lined up in it. Cancel during the line-up keeps the pin, without a heading.
4. **Landmark pairs.** At most two. The pane reports the click's azimuth in the 360's own frame (`offsetDeg` = click compass bearing minus the `headingDeg` the pane draws with); the scene gives the world bearing from the pin; each pair gives `heading = wrap360(worldAz - offsetDeg)`, two pairs their circular mean. The heading saves after each pair and the session ends after the second; Set direction starts again with no pairs.
5. **Photo direction.** Optional: one click towards where the photo looks (map or scene) or the 3D arrow drag; `q = cameraQuatFromGimbal(heading, 0, 0)` (level camera). Without a heading a pinned photo keeps its GPS `q` if it had one, else has none (a marker without a frustum; it still opens).
6. **Arrow drag.** In 3D only (the pin scene layer owns its objects). On the map the arrow shows the heading and turns with the Set direction click.
7. **Icon, hover preview, click to open.** Once `pos` is written, the existing markers do this: photo markers and map photo pins open the photo beside the scene or map (`PhotoMenu.tsx:162-175`), 360 markers enter the 360 at `headingDeg` (`panoramas.ts:574-581`). The pin scene layer adds the ground ring, the stem to eye height and the heading arrow; the pin map layer adds 360 pins (the map shows none today), heading arrows, a hover card and the click for 360s.
8. **Orthophoto.** Picking on the orthophoto means the orthophoto as drawn on the map (`MapController.pickPoint`) or draped in 3D (`SceneHandle.raycast`); a raster split pane is not a pick surface.
9. **`.insp`.** The leading JPEG is read and copied as `pano.jpg` (the trailer is ignored by decoders and sharp). A dual-fisheye `.insp` is skipped (Review Focus 1).
10. **Treat as 360 / Treat as photo.** The file stays where it is (`src` unchanged, the thumbnail under `photos/thumbs/` is reused). The item joins the panoramas layer whose `capture` matches the photo's capture date (from `takenAt`, else the photo layer's `capture`), created as `panos-<date>` when missing; ids are kept unless taken. `pos`, `pin` and `takenAt` (as `capturedAt`) carry over; `lens` and `q` are dropped. A source layer left empty is removed. Treat as photo applies to a 360 without `stitch` and without `cov` and joins the date's photos layer (`photos-<date>` when missing). A stale `orientation.json` correction for the old photo id is left alone (readers ignore ids they do not find). Offered on any photo in the menu; a photo whose image is within 0.02 of 2:1 also shows a "Looks like a 360" chip on its Media tile with the action.
11. **Strip mount.** On `main`, `PlaceWalkHere` is a top row inside the pane, mounted from `Stage.tsx`. Per the constraint, the pin strip sits bottom-centre over the stage: a portal into the stage element that holds `.pane-3d` (and the map in Map mode), absolutely positioned bottom-centre with `--sp-*` offsets and a `--z-*` layer, like `AlignPhoto.tsx:542`'s portal.
12. **Menu target.** `@aio/ui` `MenuTarget` gains `{ kind: 'media'; picks: MediaPick[] }` for 360s and pins. Photos keep `'photos'`; the pin actions target both, so pinned photos get them in the existing photo menu too.
13. **Eye height.** Edited on the strip while a pin is the open session (after placing, Move, Set direction); it re-saves the pin without a new pick.
14. **Remove pin.** With `pin.gps`: `pos` and `q` (photos) come back from it. Without: `pos` (and a photo's `q`) are removed; a 360 keeps `headingDeg`.

---

### Task 1: Schema contracts

**Files:**

- Modify: `packages/schema/src/layers.ts:62-85` (`MediaPin`, `PhotoRef.pin`, `PanoRef.pos` optional, `PanoRef.pin`; export types)
- Modify: `packages/schema/src/builder.ts:206-255` (`LayerPatch` member)
- Modify: `packages/schema/src/panoStitch.ts:122-170` (`PanoSkipReason`, `PanoScanReady`)
- Modify: `packages/schema/src/ipc.ts` (`builder:convertMedia`, next to `builder:rotatePhoto` at `:1381`)
- Test: `packages/schema/src/layers.test.ts`, `packages/schema/src/schema.test.ts`
- Create: `tools/compat/pinned-media-additive.test.mjs`
- Modify: `docs/architecture/contract-changes.md` (append the row above), `docs/architecture/data-conventions.md` (section 34 and the photos section)

**Interfaces:**

- Produces: `MediaPin` (zod) and `type MediaPin`, `type MediaPinInput = z.input<typeof MediaPin>`; `PhotoRef.pin?`, `PanoRef.pos?`, `PanoRef.pin?`; `LayerPatch` member `{ mediaPin: { itemId: string; pin: MediaPin | null } }`; `PanoSkipReason` `'dual-fisheye'`; IPC channel `'builder:convertMedia'` in the `ipc` table (`ipc.ts:774`), typed through `IpcRequest<'builder:convertMedia'>` / `IpcResponse<'builder:convertMedia'>`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/schema/src/layers.test.ts
describe('pinned media', () => {
  it('reads a 360 without pos (not placed)', () => {
    const r = PanoRef.safeParse({ id: 'p1', src: { path: 'panoramas/a/p1/pano.jpg' } });
    expect(r.success).toBe(true);
    expect(r.data?.pos).toBeUndefined();
    expect(r.data?.headingDeg).toBe(0);
  });
  it('defaults the eye height to 1.6 m and bounds it to 0..10', () => {
    expect(MediaPin.parse({ ground: [1, 2, 3] }).eyeM).toBe(1.6);
    expect(MediaPin.safeParse({ ground: [0, 0, 0], eyeM: 10.5 }).success).toBe(false);
    expect(MediaPin.safeParse({ ground: [0, 0, 0], eyeM: -0.1 }).success).toBe(false);
  });
  it('keeps headingDeg in [0, 360)', () => {
    expect(MediaPin.safeParse({ ground: [0, 0, 0], headingDeg: 360 }).success).toBe(false);
    expect(MediaPin.safeParse({ ground: [0, 0, 0], headingDeg: 359.9 }).success).toBe(true);
  });
  it('a later field on a pin does not refuse the item (not strict)', () => {
    expect(
      PhotoRef.safeParse({
        id: 'a',
        src: { path: 'photos/a.jpg' },
        pin: { ground: [0, 0, 0], video: { t: 3 } },
      }).success,
    ).toBe(true);
  });
});

// packages/schema/src/schema.test.ts
it('LayerPatch takes a media pin and its removal', () => {
  expect(
    LayerPatch.safeParse({ mediaPin: { itemId: 'p1', pin: { ground: [1, 0, 2] } } }).success,
  ).toBe(true);
  expect(LayerPatch.safeParse({ mediaPin: { itemId: 'p1', pin: null } }).success).toBe(true);
  expect(LayerPatch.safeParse({ mediaPin: { itemId: 'p1', pin: null, extra: 1 } }).success).toBe(
    false,
  );
});
it('a ready-made 360 in a scan may have no lat and lon', () => {
  expect(PanoScanReady.safeParse({ key: 'r1', file: 'C:/a.jpg', bytes: 10 }).success).toBe(true);
});
it('builder:convertMedia is strict', () => {
  const req = ipc['builder:convertMedia'].request;
  expect(req.safeParse({ projectId: 'x', layerId: 'l', itemId: 'i', to: 'pano' }).success).toBe(
    true,
  );
  expect(req.safeParse({ projectId: 'x', layerId: 'l', itemId: 'i', to: 'video' }).success).toBe(
    false,
  );
});
```

```js
// tools/compat/pinned-media-additive.test.mjs (pattern: pano-stitch-additive.test.mjs)
it('0.11 reads a pinned photo and 360 and drops pin', () => {
  // item = { id, src, pos: [1, 1.6, 2], headingDeg: 95, pin: { ground: [1, 0, 2], eyeM: 1.6, headingDeg: 95 } }
  expect(v011.PanoRef.safeParse(item).data).toEqual({ id, src, pos: [1, 1.6, 2], headingDeg: 95 });
});
it('0.11 refuses an unplaced 360 (documented in contract-changes)', () => {
  expect(v011.PanoRef.safeParse({ id: 'p1', src }).success).toBe(false);
  expect(current.PanoRef.safeParse({ id: 'p1', src }).success).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail:** `pnpm --filter @aio/schema test -- layers schema` and `pnpm vitest run tools/compat/pinned-media-additive.test.mjs`. Expected: FAIL (`MediaPin` not exported; `pos` required).
- [ ] **Step 3: Implement** the schema changes in the table under "Contract changes". `PanoRef` stays a plain (non-strict) object.
- [ ] **Step 4: Run** the same commands plus `pnpm vitest run tools/compat`. Expected: PASS (the corpus `downgrade` drops a pos-less 360 element; if a corpus test fails on it, record the expected removal there, never loosen `downgrade.mjs`).
- [ ] **Step 5: Docs.** Append the contract row verbatim; add the data-conventions paragraph; `node tools/agent/check-public-text.mjs docs/architecture/contract-changes.md docs/architecture/data-conventions.md`.
- [ ] **Step 6: Commit** `feat(schema): optional 360 position, media pins and convertMedia`.

### Task 2: Guard every reader of a 360's position

**Files:** the reader table above (except `panos.ts` and `panos.test.ts`, Task 6). Tests next to each: `packages/engine/src/adapters/panoMath.test.ts`, `panoramas.test.ts`; `packages/project/src/builder/extents.test.ts`; `packages/ai/src/places.test.ts`; desktop `shell/layerBounds.test.ts`, `workspace/panoPair.test.ts`, `workspace/spot/spotEntries.test.ts`, `panos/panos.test.ts` (create where missing).

**Interfaces:**

- Consumes: `PanoRef.pos?` (T1).
- Produces: `hasPos<T extends { pos?: Vec3 | undefined }>(p: T): p is T & { pos: Vec3 }` exported from `@aio/engine`.

- [ ] **Step 1: Write the failing tests.** One per reader, each with a layer holding `{ id: 'a', pos: [10, 0, 0] }` and an unplaced `{ id: 'b' }`:
  - `hasPos`: true for `a`, false for `b`.
  - engine adapter: `createPanoramasAdapter` builds one marker site, not two, and its bounds are the point `[10, 0, 0]` (no NaN).
  - `layerBounds`: `knowsWhere` false for a layer of only `b`; bounds of `[a, b]` equal bounds of `[a]`.
  - `extents`: project extent unchanged by `b`.
  - `places`: `b` yields a place without `p` and `eye`; the layer box ignores it.
  - `panosOf`: lists `a` only; `pairPano` from `a` never returns `b` and returns null from an unplaced start.
  - `spotEntries`: no entry for `b`.
  - `revealPanoLayer`: a layer of only `b` does not fly (camera untouched).
- [ ] **Step 2: Run** `pnpm --filter @aio/engine test -- panoMath panoramas`, `pnpm --filter @aio/project test -- extents`, `pnpm --filter @aio/ai test -- places`, `pnpm --filter @aio/desktop test -- layerBounds panoPair spotEntries panos`. Expected: FAIL (type errors surface as runtime NaN or wrong counts).
- [ ] **Step 3: Implement** the guards in the reader table. `PanoSphereRows` hides the fly button for an unplaced item (no new string).
- [ ] **Step 4: Run** the same. Expected: PASS. Then `pnpm --filter @aio/engine typecheck` and `pnpm --filter @aio/ai typecheck` clean.
- [ ] **Step 5: Commit** `fix(desktop): every reader skips a 360 that is not placed yet`.

### Task 3: Pin maths (`@aio/geo`)

**Files:** Create `packages/geo/src/mediaPin.ts`, `packages/geo/src/mediaPin.test.ts`; modify `packages/geo/src/index.ts`.

**Interfaces (all exported from `@aio/geo`):**

- `DEFAULT_EYE_M = 1.6`, `MIN_BEARING_M = 0.5`
- `wrap360(deg: number): number`
- `bearingDeg(from: Vec3, to: Vec3): number | null` (null under `MIN_BEARING_M` horizontally)
- `bearingDiffDeg(a: number, b: number): number` in `(-180, 180]`
- `interface LandmarkPair { offsetDeg: number; worldDeg: number }`
- `headingFromPair(p: LandmarkPair): number`
- `circularMeanDeg(angles: readonly number[]): number | null`
- `headingFromPairs(pairs: readonly LandmarkPair[]): number | null`
- `eyePos(ground: Vec3, eyeM: number): Vec3`
- `photoQuatFromHeading(headingDeg: number): Quat` (= `cameraQuatFromGimbal(headingDeg, 0, 0)`)
- `interface LookLike { yawDeg: number; pitchDeg: number; fovDeg: number }`
- `lookClickBearingDeg(look: LookLike, x: number, y: number, w: number, h: number): number`

The heading maths, as the implementer writes it:

```ts
const D = Math.PI / 180;
wrap360 = (a) => ((a % 360) + 360) % 360;
bearingDeg: dx = to[0] - from[0]; dz = to[2] - from[2];
  if (Math.hypot(dx, dz) < MIN_BEARING_M) return null;
  return wrap360(Math.atan2(dx, -dz) / D);            // 0 north (-z), 90 east (+x)
bearingDiffDeg(a, b) = 180 - wrap360(180 - (a - b))    // (-180, 180]
headingFromPair({ offsetDeg, worldDeg }) = wrap360(worldDeg - offsetDeg);
circularMeanDeg(as): s = sum(sin(a*D)), c = sum(cos(a*D));
  if (as.length === 0 || Math.hypot(s, c) / as.length < 1e-6) return null;
  return wrap360(Math.atan2(s, c) / D);
lookClickBearingDeg: t = tan(fovDeg*D/2); nx = (2x/w - 1) * t * (w/h); ny = (1 - 2y/h) * t;
  camera ray (nx, ny, -1), rotated by pitch about +x then by -yaw about +y (three.js YXZ),
  azimuth via atan2(dx, -dz), wrapped.
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('bearingDeg', () => {
  it('is 0 north, 90 east, 180 south, 270 west (x east, z south)', () => {
    expect(bearingDeg([0, 0, 0], [0, 5, -1])).toBeCloseTo(0);
    expect(bearingDeg([0, 0, 0], [1, 0, 0])).toBeCloseTo(90);
    expect(bearingDeg([0, 0, 0], [0, 0, 1])).toBeCloseTo(180);
    expect(bearingDeg([0, 0, 0], [-1, 0, 0])).toBeCloseTo(270);
  });
  it('is null for a landmark within 0.5 m horizontally, whatever the height', () => {
    expect(bearingDeg([0, 0, 0], [0.3, 40, 0.3])).toBeNull();
  });
});
describe('heading from landmarks', () => {
  it('one pair: world minus offset, wrapped', () => {
    expect(headingFromPair({ offsetDeg: 10, worldDeg: 5 })).toBeCloseTo(355);
    expect(headingFromPair({ offsetDeg: 0, worldDeg: 90 })).toBeCloseTo(90);
  });
  it('two pairs: circular mean across 0/360', () => {
    expect(
      headingFromPairs([
        { offsetDeg: 0, worldDeg: 350 },
        { offsetDeg: 0, worldDeg: 10 },
      ]),
    ).toBeCloseTo(0);
    expect(
      headingFromPairs([
        { offsetDeg: 0, worldDeg: 90 },
        { offsetDeg: 0, worldDeg: 100 },
      ]),
    ).toBeCloseTo(95);
    expect(circularMeanDeg([359, 1])).toBeCloseTo(0);
  });
  it('opposite headings have no mean', () => {
    expect(circularMeanDeg([10, 190])).toBeNull();
    expect(circularMeanDeg([])).toBeNull();
  });
  it('bearingDiffDeg wraps', () => {
    expect(bearingDiffDeg(10, 350)).toBeCloseTo(20);
    expect(bearingDiffDeg(350, 10)).toBeCloseTo(-20);
    expect(bearingDiffDeg(0, 180)).toBeCloseTo(180);
  });
});
describe('eye and photo pose', () => {
  it('eyePos lifts y only', () => expect(eyePos([1, 2, 3], 1.6)).toEqual([1, 3.6, 3]));
  it('a photo aimed east looks along +x', () => {
    const d = rotateVec(photoQuatFromHeading(90), [0, 0, -1]);
    expect(d[0]).toBeCloseTo(1);
    expect(d[2]).toBeCloseTo(0);
  });
});
describe('lookClickBearingDeg', () => {
  it('the view centre is the look yaw', () => {
    expect(
      lookClickBearingDeg({ yawDeg: 30, pitchDeg: -10, fovDeg: 70 }, 400, 200, 800, 400),
    ).toBeCloseTo(30);
  });
  it('the right edge at pitch 0 is yaw + atan(tan(35 deg) * aspect)', () => {
    expect(
      lookClickBearingDeg({ yawDeg: 0, pitchDeg: 0, fovDeg: 70 }, 800, 200, 800, 400),
    ).toBeCloseTo(54.47, 1);
  });
  it('wraps left of north', () => {
    expect(
      lookClickBearingDeg({ yawDeg: 0, pitchDeg: 0, fovDeg: 70 }, 0, 200, 800, 400),
    ).toBeCloseTo(305.53, 1);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @aio/geo test -- mediaPin`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** in `packages/geo/src/mediaPin.ts` (reuse `rotateVec` from `walk/horizontal.ts` in the test, `cameraQuatFromGimbal` from `camera.ts`).
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(geo): bearings, landmark headings and pano click bearings for pinned media`.

### Task 4: Menu target and strings (`@aio/ui`)

**Files:** Modify `packages/ui/src/actions/types.ts`, `packages/ui/src/i18n/en.ts`; test `packages/ui/src/actions/registry.test.ts`.

**Interfaces:**

- Produces: `interface MediaPick { layerId: string; itemId: string; kind: 'photo' | 'pano' }`; `MenuTarget` member `{ kind: 'media'; picks: MediaPick[] }`; the keys below.

Strings (exact copy; `_one`/`_other` plural pairs as en.ts does):

| Key                         | Text                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `pin.notPlaced`             | Not placed                                                                               |
| `pin.place`                 | Place on site                                                                            |
| `pin.move`                  | Move pin                                                                                 |
| `pin.direction`             | Set direction                                                                            |
| `pin.remove`                | Remove pin                                                                               |
| `pin.as360`                 | Treat as 360                                                                             |
| `pin.asPhoto`               | Treat as photo                                                                           |
| `pin.looks360`              | Looks like a 360                                                                         |
| `pin.strip.pick`            | Click where {name} was taken: on the model, the point cloud or the map.                  |
| `pin.strip.pano`            | Line up: click a landmark in the 360.                                                    |
| `pin.strip.scene`           | Now click the same landmark in the view or on the map.                                   |
| `pin.strip.more`            | Lined up. Add a second landmark to refine, or Done.                                      |
| `pin.strip.aim`             | Click the direction the photo looks, or Done to leave it without one.                    |
| `pin.strip.tooClose`        | That point is too close to the pin. Click a landmark further away.                       |
| `pin.strip.disagree`        | The two landmarks disagree. The first one is kept.                                       |
| `pin.strip.heightUnknown`   | Height unknown here: the pin sits at 0 m.                                                |
| `pin.strip.saveFailed`      | The pin was not saved: {reason}                                                          |
| `pin.eyeHeight`             | Eye height (m)                                                                           |
| `pin.done`                  | Done                                                                                     |
| `pin.cancel`                | Cancel                                                                                   |
| `pin.notLinedUp`            | Not lined up yet                                                                         |
| `pin.convert.marks`         | This photo has marks on it. Remove them first.                                           |
| `pin.convert.package`       | A package cannot be changed.                                                             |
| `pin.convert.stitched`      | Only a single 360 image can become a photo.                                              |
| `pano.offer.unplaced_one`   | {count} 360 has no GPS: it imports as not placed, ready to pin on the site.              |
| `pano.offer.unplaced_other` | {count} 360s have no GPS: they import as not placed, ready to pin on the site.           |
| `pano.skip.dualFisheye`     | Two fisheye circles, not a 360 yet: export it as a 360 photo from Insta360 Studio first. |

- [ ] **Step 1: Failing test:** `registerActions([defineAction({ id: 't.media', targets: ['media'], ... })])` then `actionsFor({ kind: 'media', picks: [{ layerId: 'l', itemId: 'i', kind: 'pano' }] }, ctx)` returns it; `actionsFor({ kind: 'photos', picks: [] }, ctx)` does not.
- [ ] **Step 2: Run** `pnpm --filter @aio/ui test -- registry`. Expected: FAIL (type and missing kind).
- [ ] **Step 3: Implement**; add the strings (alphabetical placement as the file does).
- [ ] **Step 4: Run** `pnpm --filter @aio/ui test`. Expected: PASS (the i18n parity test, if any, included).
- [ ] **Step 5: Commit** `feat(ui): a media menu target and the pinned media strings`.

### Task 5: Pin writer (`@aio/project`)

**Files:** Create `packages/project/src/builder/mediaPin.ts`, `mediaPin.test.ts`; modify `packages/project/src/builder/create.ts` (`updateLayers` patch branches, ~199-271).

**Interfaces:**

- Consumes: `MediaPin`, `LayerPatch` (T1); `eyePos`, `photoQuatFromHeading` (T3).
- Produces: `applyMediaPin(layer: Layer, patch: { itemId: string; pin: MediaPin | null }): Layer` (throws `Error` with a sentence for a layer that is not photos or panoramas, or a missing item); `create.ts` calls it for `'mediaPin' in patch`.

Rules (each is a test):

- [ ] **Step 1: Write the failing tests**

```ts
const photo = { id: 'a', src: { path: 'photos/a.jpg' } };
const gpsPhoto = {
  id: 'g',
  src: { path: 'photos/g.jpg' },
  pos: [5, 30, 5],
  q: [0.1, 0.2, 0.3, 0.927],
};
it('pins an unplaced photo at ground plus eye height, without q when no heading', () => {
  const out = item(
    applyMediaPin(photos([photo]), { itemId: 'a', pin: { ground: [1, 2, 3], eyeM: 1.6 } }),
    'a',
  );
  expect(out.pos).toEqual([1, 3.6, 3]);
  expect(out.q).toBeUndefined();
  expect(out.pin?.gps).toBeUndefined();
});
it('a photo heading writes a level camera q', () => {
  const out = item(
    applyMediaPin(photos([photo]), {
      itemId: 'a',
      pin: { ground: [0, 0, 0], eyeM: 1.6, headingDeg: 90 },
    }),
    'a',
  );
  expect(out.q).toEqual(photoQuatFromHeading(90));
});
it('pinning a GPS photo keeps its GPS place in pin.gps, and Remove pin restores pos and q exactly', () => {
  const pinned = applyMediaPin(photos([gpsPhoto]), {
    itemId: 'g',
    pin: { ground: [9, 0, 9], eyeM: 1.6, headingDeg: 45 },
  });
  expect(item(pinned, 'g').pin?.gps).toEqual({ pos: [5, 30, 5], q: [0.1, 0.2, 0.3, 0.927] });
  const moved = applyMediaPin(pinned, { itemId: 'g', pin: { ground: [8, 0, 8], eyeM: 2 } });
  expect(item(moved, 'g').pin?.gps).toEqual({ pos: [5, 30, 5], q: [0.1, 0.2, 0.3, 0.927] }); // first gps kept
  const removed = item(applyMediaPin(moved, { itemId: 'g', pin: null }), 'g');
  expect(removed.pos).toEqual([5, 30, 5]);
  expect(removed.q).toEqual([0.1, 0.2, 0.3, 0.927]);
  expect(removed.pin).toBeUndefined();
});
it('Remove pin on an item without GPS leaves it unplaced', () => {
  const p = applyMediaPin(panos([{ id: 'p', src }]), {
    itemId: 'p',
    pin: { ground: [1, 0, 1], eyeM: 1.6, headingDeg: 95 },
  });
  expect(item(p, 'p').headingDeg).toBe(95);
  const back = item(applyMediaPin(p, { itemId: 'p', pin: null }), 'p');
  expect(back.pos).toBeUndefined();
  expect(back.pin).toBeUndefined();
  expect(back.headingDeg).toBe(95);
});
it('a 360 pin without heading keeps the stored headingDeg', () => {
  /* headingDeg 12 stays 12 */
});
it('a gps value sent by the renderer is ignored (the writer owns it)', () => {
  /* pin.gps from patch dropped for an unplaced item */
});
it('refuses another layer kind and a missing item', () => {
  expect(() => applyMediaPin(meshLayer, { itemId: 'a', pin: null })).toThrow(/photos or panoramas/);
  expect(() => applyMediaPin(photos([photo]), { itemId: 'zz', pin: null })).toThrow(/zz/);
});
```

Plus one `create.test.ts` (or the existing `updateLayers` test file) case: `updateLayers(root, ['photos-1'], { mediaPin: ... })` writes the manifest and a backup, as the `heightOffsetM` case does.

- [ ] **Step 2: Run** `pnpm --filter @aio/project test -- mediaPin create`. Expected: FAIL.
- [ ] **Step 3: Implement** `applyMediaPin` and the `create.ts` branch (one `layerIds` entry only; more than one is refused with "Pin one item at a time.").
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): write and remove media pins on photos and 360s`.

### Task 6: Import 360s without GPS and `.insp` stills

**Files:**

- Modify: `packages/project/src/builder/panoGroups.ts:175-190` (a ready-made 360 without `lat`/`lon` goes to `ready`), `packages/project/src/builder/panos.ts:36-45` (`keyGrouping` keeps unplaced ready ones; `KeyedGrouping.ready` lat/lon optional), `:170` (omit `pos`), the ready import (no `pos` without lat/lon), `panos.test.ts:142-144`
- Create: `apps/desktop/src/main/fisheye.ts`, `fisheye.test.ts` (pure; lives in main so `packages/project/src/builder/index.ts` stays T7's alone)
- Modify: `apps/desktop/src/main/panos.ts:85` (accept `.insp` in the filter and the `JPEG` test; for each `.insp`, a 64 x 32 greyscale via sharp into `looksDualFisheye`; such files are skipped with `dual-fisheye`)
- Modify: `apps/desktop/src/renderer/builder/state.ts` (`IMPORT_FILTERS` adds `insp`; `panoOfferCopy` returns an `unplaced` sentence when some `scan.ready` have no `lat`), `builder/ImportPanel.tsx:267` (renders `unplaced` and the `dual-fisheye` skip sentence beside `extra`)
- Tests: `panoGroups.test.ts`, `panos.test.ts`, `apps/desktop/src/main/fisheye.test.ts`, `apps/desktop/src/main/panos.test.ts`, `apps/desktop/src/renderer/builder/state.test.ts` (or the existing pano offer test file)

**Interfaces:**

- Consumes: `PanoScanReady` optional lat/lon, `'dual-fisheye'` (T1); strings `pano.offer.unplaced_*`, `pano.skip.dualFisheye` (T4).
- Produces: `looksDualFisheye(grey: Uint8Array, w: number, h: number): boolean`; `panoOfferCopy(o)` returns `{ body, extra, skip, unplaced: string | null }`.

`looksDualFisheye` rule: on a 64 x 32 grey image, two circles of radius 16 centred at (16, 16) and (48, 16); dual-fisheye when the mean of pixels farther than 16.5 px from both centres is under 12 and the mean inside is over 30.

- [ ] **Step 1: Write the failing tests**
  - `groupPanoFrames([{ file: 'g.jpg', width: 2560, height: 1280 }])` gives `ready` length 1, `skipped` empty (was `no-position`).
  - `keyGrouping` keeps it as `r1` with `lat` undefined.
  - the ready import of an unplaced `r1` writes a `PanoRef` with no `pos` and `headingDeg` 0; a placed one still gets its `pos`.
  - a sphere whose camera has no `pos` is written without `pos` (not `[0, 0, 0]`).
  - `looksDualFisheye`: true for two bright discs on black; false for a uniform grey 128 image and for a sky-over-ground gradient.
  - main `scanPanoPaths` with `a.insp` (equirect JPEG bytes + `Buffer.from('INSTA360-TRAILER')`) lists it in `ready`; with a dual-fisheye `.insp`, `skipped` has `{ reason: 'dual-fisheye' }`.
  - `panoOfferCopy` with two ready, one without `lat`: `unplaced` is `"1 360 has no GPS: it imports as not placed, ready to pin on the site."`.
- [ ] **Step 2: Run** `pnpm --filter @aio/project test -- panoGroups panos` and `pnpm --filter @aio/desktop test -- main/fisheye main/panos builder/state`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): 360s without GPS and Insta360 stills import as unplaced 360s`.

### Task 7: Treat as 360, Treat as photo

**Files:**

- Create: `packages/project/src/builder/convertMedia.ts`, `convertMedia.test.ts`; modify `packages/project/src/builder/index.ts` (export)
- Create: `apps/desktop/src/main/convertMedia.ts`, `convertMedia.test.ts` (pattern: `main/rotatePhoto.ts`: package refusal, sightings check, backup, validated write)
- Modify: `apps/desktop/src/main/index.ts` (channel list next to `'builder:rotatePhoto'` at `:1461` and the handler), `apps/desktop/src/preload/index.ts:104` (allowlist)

**Interfaces:**

- Consumes: IPC `builder:convertMedia` (T1).
- Produces: `convertMediaManifest(m: ProjectManifest, req: { layerId: string; itemId: string; to: 'pano' | 'photo' }): { manifest: ProjectManifest; layerId: string; itemId: string } | { error: 'stitched' | 'missing' | 'kind' }` (pure); main `convertMedia(projectId, req): Promise<IpcResponse<'builder:convertMedia'>>`, which maps errors and refusals to `pin.convert.*` sentences in English (main has no i18n; use the same wording).

- [ ] **Step 1: Write the failing tests** (pure, rules from ambiguity 10):
  - a photo `{ id: 'ph', takenAt: '2026-10-01T09:00:00+02:00', pos, pin, lens, q }` in `photos-1` (capture `c1`, date 2026-10-01) becomes a `PanoRef` `{ id: 'ph', src: same, pos, pin, capturedAt: takenAt, headingDeg: 0 }` in a new layer `panos-2026-10-01` with `capture: 'c1'`; no `lens`, no `q`.
  - with an existing panoramas layer on capture `c1`, the item joins it; an id clash becomes `ph-2`.
  - the source photos layer left empty is removed; one with other photos stays.
  - a photo without `takenAt` uses the photo layer's capture.
  - Treat as photo of that 360 gives back a `PhotoRef` `{ id, src, takenAt, pos, pin }` in the date's photos layer; round trip keeps `pin` and `pos`.
  - a 360 with `stitch` or `cov` gives `{ error: 'stitched' }`.
  - main: a package project and a photo with an image sighting are refused before any write (manifest file bytes unchanged).
- [ ] **Step 2: Run** `pnpm --filter @aio/project test -- convertMedia`, `pnpm --filter @aio/desktop test -- main/convertMedia`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): turn a photo into a 360 and back without re-importing`.

### Task 8: Pin model, frame and session store

**Files:** Create `apps/desktop/src/renderer/pins/pinModel.ts`, `pinFrame.ts`, `pinStore.ts` and a test for each.

**Interfaces:**

- Consumes: `MediaPin`, `LayerPatchInput` (T1); `bearingDeg`, `headingFromPairs`, `circularMeanDeg`, `eyePos`, `DEFAULT_EYE_M`, `LandmarkPair` (T3).
- Produces:
  - `pinFrame.ts`: `toStore(p: Vec3, m: ProjectManifest, mediaLayerId: string): Vec3` and `toDraw(p: Vec3, m: ProjectManifest, mediaLayerId: string): Vec3`, identity now; a file comment says Task 16 replaces them.
  - `pinModel.ts`: `type MediaKey = MediaPick` (from `@aio/ui`); `keyString(k: MediaKey): string` (`${kind}:${layerId}:${itemId}`); `mediaItem(m: ProjectManifest, k: MediaKey): PhotoRef | PanoRef | null`; `isPlaced(item): boolean`; `interface DrawnPin { key: MediaKey; name: string; ground: Vec3; eye: Vec3; headingDeg: number | undefined; linedUp: boolean }`; `drawnPins(m: ProjectManifest, hidden: ReadonlySet<string>): DrawnPin[]` (pinned items of visible photos and panoramas layers, through `toDraw`; a 360's `headingDeg` shows only when `pin.headingDeg` is set); `pinsAt(points: readonly { key: MediaKey; x: number; y: number }[], x: number, y: number, radiusPx?: number): MediaKey | null` (nearest within 14 px).
  - `pinStore.ts`: `type PinStep = 'pick' | 'pano' | 'scene' | 'more' | 'aim'`; `type PinMode = 'place' | 'move' | 'direction'`; `interface PinState { target: MediaKey | null; mode: PinMode; step: PinStep; ground: Vec3 | null; eyeM: number; pairs: LandmarkPair[]; pendingOffsetDeg: number | null; heightUnknown: boolean; note: MessageKey | null; saving: boolean; error: string | null }`; `interface PinDeps { manifest(): ProjectManifest | null; save(layerId: string, patch: LayerPatchInput): Promise<string | null>; openPanoBeside(layerId: string, panoId: string): void }`; `createPinStore(deps: PinDeps): StoreApi<PinState & PinActions>` with actions `begin(k: MediaKey, mode: PinMode): void`, `pickSurface(drawn: Vec3, heightKnown: boolean): Promise<void>`, `pickPano(offsetDeg: number): void`, `pickLandmark(drawn: Vec3): Promise<void>`, `aim(drawn: Vec3): Promise<void>`, `setHeading(deg: number): Promise<void>`, `setEyeM(m: number): Promise<void>`, `done(): void`, `cancel(): void`.

- [ ] **Step 1: Write the failing tests** (`pinStore.test.ts` with a fake `save` recording patches):
  - `begin(pano, 'place')` gives step `pick`, `eyeM` 1.6; `pickSurface([1, 0, 2], true)` saves `{ mediaPin: { itemId, pin: { ground: [1, 0, 2], eyeM: 1.6 } } }` on the pano's layer, calls `openPanoBeside`, step `pano`.
  - `pickSurface(p, false)` sets `heightUnknown` and `note: 'pin.strip.heightUnknown'` (the map pick with no model gives `y` 0).
  - photo: after `pickSurface` the step is `aim`; `aim([1, 0, -10])` from ground `[1, 0, 0]` saves `headingDeg: 0`; `done()` ends with no heading saved when no aim was given.
  - line-up: `pickPano(0)` step `scene`; `pickLandmark([11, 0, 2])` (east of `[1, 0, 2]`) saves `headingDeg` 90, step `more`; `pickPano(0)` + `pickLandmark` at bearing 100 saves 95 and ends the session; `begin(p, 'direction')` afterwards starts with `pairs` empty.
  - `pickLandmark([1.2, 0, 2.2])` (0.28 m) keeps step `scene`, `note: 'pin.strip.tooClose'`, saves nothing.
  - pairs at 10 and 190: keeps 10, `note: 'pin.strip.disagree'`.
  - `setEyeM(2)` with a pin re-saves `ground` unchanged and `eyeM: 2`; values outside 0..10 are clamped.
  - `move` keeps `headingDeg`: the saved pin after `pickSurface` carries the item's current `pin.headingDeg`.
  - `direction` on a placed 360 starts at step `pano` without a surface pick; on a photo at `aim`.
  - a `save` returning an error string sets `error` and keeps the step; `cancel()` resets to `target: null` without saving.
  - an item that disappears from `manifest()` ends the session on the next action.
  - `pinModel`: `drawnPins` skips hidden layers and unpinned GPS items; `pinsAt` picks the nearest within 14 px and null beyond.
  - `pinFrame`: `toStore(toDraw(p))` equals `p`; identity for any layer today.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop test -- pins/`. Expected: FAIL.
- [ ] **Step 3: Implement.** The store converts every drawn point with `toStore(p, manifest, target.layerId)` before saving or computing a bearing against the stored ground (bearings use drawn points on both sides: `toDraw(ground)` and the clicked drawn point).
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): the pinned media session, its model and its date frame`.

### Task 9: Landmark click in the 360 pane

**Files:** Create `apps/desktop/src/renderer/workspace/panoPickHook.ts` (+ test); modify `workspace/panoSurface.tsx` (opt-in prop), `workspace/PanoPane.tsx` (one hook read and one prop); test `workspace/panoSurface.test.tsx`.

**Interfaces:**

- Consumes: `lookClickBearingDeg`, `wrap360` (T3).
- Produces: `type PanoPick = (p: { layerId: string; panoId: string; offsetDeg: number }) => void`; `setPanoPick(fn: PanoPick | null): void`; `usePanoPick(): PanoPick | null`; `PanoSurface` prop `onPickBearing?: (compassDeg: number) => void`, fired on a pointer up within 4 px of its down (a drag still turns the view, never picks). `PanoPane` passes `onPickBearing` only while `usePanoPick()` is set, calling it with `offsetDeg = wrap360(compassDeg - frame.headingDeg)` and the pane's current pano; while set, the surface root has `data-picking="true"` (crosshair cursor through an existing class or attribute rule outside the stage sections of `styles.css`).

- [ ] **Step 1: Failing tests:** a click at the surface centre with look yaw 30 reports 30; a 20 px drag reports nothing and still changes the look; without `onPickBearing` a click does nothing new. `PanoPane` with a hook set and `headingDeg` 40 reports `offsetDeg` 350 for a centre click at yaw 30.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop test -- panoSurface panoPickHook PanoPane`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): the 360 pane reports a landmark click while a line-up asks for one`.

### Task 10: Placement flow and strip

**Files:** Create `apps/desktop/src/renderer/pins/placePin.ts`, `pins/openBeside.ts`, `pins/PinStrip.tsx`, `pins/pins.css`, with `placePin.test.ts`, `PinStrip.test.tsx`.

**Interfaces:**

- Consumes: `createPinStore`, `PinState` (T8); `setPanoPick` (T9); `useStagePick`, `groundHit`, `terrainHeightAt` (`builder/pick.ts`, `builder/droneHits.ts`); `getActiveMap`, `onActiveMap`, `MapController.pickPoint` (`@aio/maps`); `builder.getState().saveLayers` (`builder/state.ts`); strings (T4).
- Produces: `pinSession: StoreApi<PinState & PinActions>` (singleton, deps wired to the builder and `openPanoBeside`); `openPanoBeside(layerId: string, panoId: string, beside?: '3d' | 'map'): void` (split with the Panoramas pane on the other side, as `openPhoto` does, then `select({ kind: 'pano', id, layer })`); `usePinPicking(): void` (arms the 3D pick while the step is `pick`, `scene` or `aim`; arms `pickPoint` on the active map and re-arms after each click; sets `setPanoPick` while the step is `pano`; a map pick takes `terrainHeightAt(x, z) ?? 0` and `heightKnown = terrainHeightAt(...) !== null`; Escape calls `cancel()`); `PinStrip(): JSX.Element | null` (`data-testid="pin-strip"`, portal into the stage element, bottom-centre).

Strip content: the step's sentence (`pin.strip.*` with `{name}`), the `note` when set, an eye height number field (`data-testid="pin-eye-height"`, step 0.1, 0 to 10) once a pin exists, `Done` (`pin-done`) and `Cancel` (`pin-cancel`) as `Button`s, the `error` sentence. `Row` layout, `--sp-*` gaps, `--z-*` layer, `--el-*` elevation; no `title=`.

- [ ] **Step 1: Failing tests:**
  - `placePin.test.ts`: with a fake scene handle, a click in `pick` calls `pickSurface` with the hit point and `heightKnown` true; a drag does not; a map pick at a spot without a model calls `pickSurface([x, 0, z], false)`; `setPanoPick` is set only in step `pano` and cleared on `cancel`; `openPanoBeside('panos-1', 'p1')` sets the split to include `pano` and selects the 360.
  - `PinStrip.test.tsx`: renders nothing without a target; shows `pin.strip.pick` with the item's name; the eye field appears after the pick and calls `setEyeM(2)`; Escape and Cancel call `cancel`; the root carries no `title` attribute.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop test -- pins/placePin pins/PinStrip`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again plus `pnpm --filter @aio/ui test -- cssGuard`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): place a photo or 360 on the site from a bottom strip`.

### Task 11: Pin scene layer

**Files:** Create `apps/desktop/src/renderer/pins/pinScene.ts`, `pinScene.test.ts`, `pins/PinSceneMount.tsx`.

**Interfaces:**

- Consumes: `drawnPins`, `DrawnPin`, `keyString` (T8); `bearingDeg` (T3); `getActiveScene` (`@aio/engine`).
- Produces: `attachPinScene(scene: SceneHandle, cb: { onArrowDrop(key: MediaKey, headingDeg: number): void }): { update(pins: readonly DrawnPin[], selected: string | null): void; dispose(): void }`; `PinSceneMount(): null` (reads the manifest and `hidden` from the workspace store, calls `update`, and on drop runs `pinSession.getState().begin(key, 'direction')` then `setHeading(deg)`).

Objects in one named group `aio-media-pins`: per pin a ground ring (0.3 m), a stem line from `ground` to `eye`, and when `headingDeg` is set a flat arrow at the ground, 1.2 m, pointing along the heading (`linedUp` false: the arrow is not drawn). Arrow drag: pointer down on an arrow turns orbit controls off (as `walks/walkScene.ts` does), pointer move takes the ground hit and shows `bearingDeg(ground, hit)`, pointer up anywhere (window listener) drops and turns orbit back on.

- [ ] **Step 1: Failing tests:** `update` with two pins makes two rings, two stems, one arrow (one pin without heading); the arrow's world direction for heading 90 is +x; `update([])` empties the group; `dispose` removes it from the scene; a drag simulated through the handlers calls `onArrowDrop` with 90 for a hit east of the ground point and re-enables controls on window `pointerup`.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop test -- pins/pinScene`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): pins in the 3D scene with a heading arrow to drag`.

### Task 12: Pin map layer

**Files:** Create `packages/maps/src/mediaPins.ts`, `mediaPins.test.ts`; modify `packages/maps/src/index.ts`; create `apps/desktop/src/renderer/pins/PinMapMount.tsx`, `pins/pinHover.css`.

**Interfaces:**

- Consumes: `drawnPins`, `pinsAt` (T8); `FrameProjection.toLonLat` (`packages/maps/src/geo.ts:128`); `openPano` (`@aio/workspace`).
- Produces: `interface MapPin { id: string; kind: 'photo' | 'pano'; ground: Vec3; headingDeg?: number; name: string }`; `MEDIA_PIN_LAYERS = ['aio-media-pin-arrow', 'aio-media-pin-pano'] as const`; `mediaPinData(pins: readonly MapPin[], toLonLat: (p: Vec3) => [number, number]): FeatureCollection<Point>` (one feature per pin: `kind`, `id`, `name`, `heading` or no `heading`); `setMediaPins(map: MaplibreMap, data: FeatureCollection<Point>): void` (adds the source and layers once, then `setData`); `removeMediaPins(map: MaplibreMap): void`; `PinMapMount(): JSX.Element | null`: draws, shows a hover card (`data-testid="pin-hover-card"`: `MediaThumb`, the name, `pin.notLinedUp` for a 360 without heading) next to the pin, opens a 360 on click (`openPano(layerId, id)`); photo dots stay `photoPins.ts`'s (a pinned photo has `pos`, so it already shows and opens beside the map).

- [ ] **Step 1: Failing tests:** `mediaPinData` keeps `heading` only when set and projects through `toLonLat`; `setMediaPins` twice adds the source once (fake map with `addSource`/`getSource`/`addLayer` spies); `removeMediaPins` removes both layers and the source.
- [ ] **Step 2: Run** `pnpm --filter @aio/maps test -- mediaPins`. Expected: FAIL.
- [ ] **Step 3: Implement.** The arrow is a symbol layer with `icon-rotate` from `heading` and `icon-rotation-alignment: map`, its image drawn once on a canvas; the 360 pin is a circle layer styled like the 3D 360 marker (round). Hover card position and look are the builder's call within the tokens.
- [ ] **Step 4: Run** again plus `pnpm --filter @aio/ui test -- cssGuard`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(maps): 360 pins and heading arrows on the map`.

### Task 13: Host, menus, Media list and the mount

**Files:** Create `apps/desktop/src/renderer/pins/PinMediaHost.tsx`, `pins/PinMenu.tsx`, `shell/actions/pinActions.tsx` (+ `pinActions.test.ts`); modify `shell/actions/index.ts` (register), `screens/Media.tsx` (chips and tile right-click), `screens/mediaModel.ts` (`isNear2to1`), `builder/BuilderLayer.tsx` (one line).

**Interfaces:**

- Consumes: `pinSession`, `usePinPicking`, `PinStrip` (T10); `PinSceneMount` (T11); `PinMapMount` (T12); `MediaPick`, strings (T4); `builder:convertMedia` (T7); `pinsAt`, `drawnPins` (T8).
- Produces:
  - Actions (ids, targets `['photos', 'media']`, single pick): `media.place` (`pin.place`, section `edit`, applies when the item has no `pos`), `media.move` (`pin.move`, when it has `pos`), `media.direction` (`pin.direction`, when it has `pos`), `media.remove` (`pin.remove`, `danger`, when it has `pin`), `media.as360` (`pin.as360`, photos only), `media.asPhoto` (`pin.asPhoto`, 360s without `stitch`/`cov`). All `disabled` with `pin.convert.package` on a package. `run` calls `pinSession.getState().begin(...)`, `saveLayers([layerId], { mediaPin: { itemId, pin: null } })` or `bridge.call('builder:convertMedia', ...)` then `workspace.replaceManifest`.
  - `isNear2to1(w: number, h: number): boolean` (within 0.02, the importer's tolerance).
  - `PinMenu()`: on right-click in `.pane-3d` (projected `eye` points through `pinsAt`) or on the map's 360 pins, opens `Menu` with `actionsFor({ kind: 'media', picks: [key] }, ctx)`; a photo under the cursor is left to `PhotoMenu` (it already lists the `photos` actions).
  - `PinMediaHost()`: `usePinPicking()` plus `<PinStrip />`, `<PinSceneMount />`, `<PinMapMount />`, `<PinMenu />`.
  - `BuilderLayer.tsx`, one line next to `<PhotoMenu />`: `{screen === 'scene' && projectId && <PinMediaHost />}`.
  - Media tiles: an unplaced photo or 360 shows `Chip` "Not placed" (`data-testid="media-not-placed"`, `data-item="<itemId>"`); a photo whose size is near 2:1 shows `Chip` "Looks like a 360" with a `Button` "Treat as 360"; right-click on a tile opens `Menu` with the same actions (target `photos` for photos, `media` for 360s). Place on site from Media switches to the scene first (`shell.go('scene')`).
- [ ] **Step 1: Failing tests:** `pinActions.test.ts`: for an unplaced 360, `actionsFor` lists Place on site and Treat as photo, not Move or Remove; for a GPS photo, Move pin and Set direction, not Remove pin; for a pinned photo, Remove pin too; on a package every action is disabled with the package sentence; `media.remove.run` saves `{ mediaPin: { itemId, pin: null } }`. A `Media.split.test.tsx` case: an unplaced 360 tile shows "Not placed"; a 2560 x 1280 photo tile shows "Looks like a 360". `isNear2to1(2560, 1280)` true, `(4000, 3000)` false.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop test -- pinActions Media mediaModel`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again plus `pnpm --filter @aio/ui test -- cssGuard` and `pnpm --filter @aio/desktop typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): pin actions on photos, 360s and pins, and Not placed in Media`.

### Task 14: End to end specs and docs

**Files:** Create `apps/desktop/e2e/pinFixture.ts`, `apps/desktop/e2e/pinned-media.spec.ts`, `apps/desktop/e2e/pinned-media-import.spec.ts`; modify the guide chapter on photos and 360s under `docs/guide/` and `docs/TESTING.md` (spec list).

**Interfaces:**

- Consumes: test ids `pin-strip`, `pin-eye-height`, `pin-done`, `pin-cancel`, `media-not-placed`, `pin-hover-card`; menu items by role `menuitem` and the strings of T4; `window.__stratlas.workspace` and `.stage()` hooks; `scenePoint` and `lookDown` as in `walk-place-3d.spec.ts:49-74`; `el.__aioMap.project` as in `photo-align.spec.ts:190-205`; `nextOpenDialog` (a local helper in `builder.spec.ts:10`; copy it into `pinFixture.ts` and export it).
- Produces: `createPinProject(root: string, opts?: { crs?: 'local' | 'utm'; basemap?: boolean }): Promise<string>` writing one survey date with `panos-2026-10-01` (`p1`, unplaced, 64 x 32 `solidPng`), `photos-2026-10-01` (`ph1` unplaced 4:3 JPEG; `ph2` 256 x 128 JPEG for Treat as 360), and for `basemap` the pmtiles pack of `photo-align.spec.ts`.

- [ ] **Step 1: Write `pinned-media.spec.ts`:**
  1. Open the project; Media shows two `media-not-placed` chips (`p1`, `ph1`).
  2. Right-click the `p1` tile, Place on site: the scene shows, `pin-strip` is visible; its box is in the lower half of the stage and horizontally centred within 8 px; `document.elementFromPoint` at the view centre is the scene canvas (also with `test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } })` in a second test).
  3. `lookDown`, click `scenePoint(0, 0, 0)`: manifest `p1.pos` is `[0, 1.6, 0]` within 0.05 and `p1.pin.eyeM` 1.6; the Panoramas pane opens.
  4. Click the pano pane centre, then `scenePoint(10, 0, 0)`: `headingDeg` 90 +-1. Click the pane centre again, then the point at bearing 100 from the pin (`[10 * sin 100, 0, -10 * cos 100]`): `headingDeg` 95 +-1; the strip closes.
  5. Hover `p1`'s eye point: the 360 marker's tooltip shows. Click it: the immersive camera's azimuth (`atan2(dir.x, -dir.z)`) is 95 +-2.
  6. Right-click the pin's eye point: Remove pin: `p1.pos` absent, Media shows "Not placed" on `p1` again.
  7. Second test (`basemap: true`, `crs: 'utm'`): Place on site for `ph1`, click the map at a projected point: `ph1.pos` set, `pin.strip.heightUnknown` shown (no model); click the photo's map pin: the Photo pane opens beside the map (`pane-photo`).
- [ ] **Step 2: Write `pinned-media-import.spec.ts`:** Add data with `ground360.jpg` (2560 x 1280 via sharp, no EXIF), `still.insp` (same JPEG plus a 64 byte trailer), `fisheye.insp` (black with two bright discs): `pano-offer` mentions "2 360s have no GPS" and the fisheye skip sentence; import: a panoramas layer with two items without `pos`; Media shows them "Not placed". Then on `ph2`: "Looks like a 360", Treat as 360: `ph2` is in `panos-2026-10-01` and `photos-2026-10-01` still holds `ph1`; right-click its tile, Treat as photo: back in the photos layer.
- [ ] **Step 3: Run each spec the CI way** (from `apps/desktop`, after `pnpm demo:build --quick` and an `electron-vite build`): `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/pinned-media.spec.ts e2e/pinned-media-import.spec.ts --workers=1 --repeat-each=3`. Expected: all pass; the log prints `[e2e] window 1100 x 720 px at display scale 1`.
- [ ] **Step 4: Docs.** Guide: Place on site, line up with landmarks, the arrow, Remove pin, Treat as 360, `.insp` (with the Insta360 Studio note). TESTING.md: the two specs. `node tools/agent/check-public-text.mjs <the docs>`; `pnpm format:check`.
- [ ] **Step 5: Commit** `test(desktop): end to end for pinned photos and 360s` and `docs(guide): place photos and 360s that have no GPS`.

### Task 15: Verification

- [ ] **Step 1:** `pnpm check` from the worktree root. Expected: lint, format, typecheck and every unit test green (including `tools/compat` and `cssGuard`).
- [ ] **Step 2:** If PR #162 landed during the build, confirm the branch is rebased on it and re-run Task 14 Step 3; check the strip still sits bottom-centre over the stage with the island showing.
- [ ] **Step 3:** Re-run the two specs the CI way plus the reader-adjacent specs `drone-panoramas.spec.ts`, `spot-history.spec.ts`, `pano-compare.spec.ts`, `walk-place-3d.spec.ts`, `photo-align.spec.ts` (`--workers=1`). Expected: green.
- [ ] **Step 4:** Independent review of the whole branch (strongest model): spec coverage, the forbidden-file list (`git diff --stat main...` touches none of them), every pano reader guarded.
- [ ] **Step 5:** Write the "How to test" walkthrough for the founder into the hand-off.

### Task 16: Swap in the date line-up (after `feat/date-line-up` lands on `main`)

**Files:** Modify `apps/desktop/src/renderer/pins/pinFrame.ts`, `pinFrame.test.ts`.

**Interfaces:** Consumes `shiftLocal(p: Vec3, s: DateShift | null): Vec3`, `unshiftLocal(p: Vec3, s: DateShift | null): Vec3` (`@aio/schema` `dateShift.ts`), `dateShiftOf(m, layerId): DateShift | null` (`@aio/workspace` `dateShifts.ts`). Read both files on `main` first; the signatures above are from the branch as of 17 Oct.

- [ ] **Step 1:** Rebase onto `origin/main` (with date line-up landed); resolve conflicts in readers T2 touched (the date line-up branch also edited pano fly-to: keep both its shift and the `hasPos` guard).
- [ ] **Step 2: Failing tests:** for a manifest whose capture of `panos-1` has a line-up shift `s`, `toDraw(g, m, 'panos-1')` equals `shiftLocal(g, s)` and `toStore(toDraw(g))` equals `g`; an undated layer is identity.
- [ ] **Step 3: Implement** `toStore = unshiftLocal(p, dateShiftOf(m, mediaLayerId))`, `toDraw = shiftLocal(p, dateShiftOf(m, mediaLayerId))`; remove the "Task 16" comment.
- [ ] **Step 4:** `pnpm check`; re-run `pinned-media.spec.ts` the CI way; on a lined-up date, a pin placed on the shifted cloud draws where it was clicked (one added e2e step using the date line-up fixture if one exists, else a unit test on `drawnPins`).
- [ ] **Step 5: Commit** `feat(desktop): pins follow their date's line-up`.
