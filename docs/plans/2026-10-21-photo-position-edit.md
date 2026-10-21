# Photo position edit: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is test first: write the failing test, run it and see it fail for the stated reason, then make it pass.

**Goal:** Select one or many photos (Media screen, map and 3D photo markers; right-click) and choose **Edit position**. A small panel shows **X (east), Y (north), Z (height) in metres**. With one photo it shows the current position and takes new values; with several it takes a shift (for example Z -100) that moves every selected photo by the same amount, keeping their spacing. Photo files and the photo records are never rewritten: the correction is stored next to the original, an "Edited" mark shows, and **Reset to original** puts the imported position back. The map, the 3D scene and processing (ODM) all use the corrected position. The same branch fixes an import bug that puts DJI Zenmuse XT2 photos (thermal and visual) at the wrong height, adds a **Re-read photo positions** action per photo dataset that repairs projects imported before the fix, and on import gives a thermal photo without DJI metadata the place and view direction of its visual twin (stored as a correction, so it shows "Edited" and Reset works).

**Base:** rebased onto `origin/main` `ba2352f67` (measurement dates) on 21 Oct. That merge touches `packages/ui/src/i18n/en.ts` (new `measure.*` keys), `docs/architecture/contract-changes.md` and `data-conventions.md` (one row, one paragraph) and the sidebar and measurement files; no file this plan changes was restructured, so T4 and T12 only append. Rebase again before batch 3 and before T12.

**Architecture:** No new storage. "Align photo to map" already keeps a hand correction per photo in `orientation.json` (`PhotoCorrection { yawDeg, pitchDeg, rollDeg, offsetM?: Vec3 }`, `packages/schema/src/orientation.ts:56-69`), and every view already draws photos through one accessor, `correctedPhoto` (`packages/geo/src/photo.ts:55`). Edit position writes only `offsetM` (rotations untouched); the photo record's `pos` stays the imported original, so Reset is "drop `offsetM`" and "Edited" is "`offsetM` is not zero". The missing pieces are a panel and actions in the renderer, multi-select on Media tiles, the few readers that still read raw `pos`, and processing: the Python align step and the pose swap after ODM ignore `orientation.json` today.

**Tech Stack:** TypeScript strict, zod (`@aio/schema`), React 19 + zustand, MapLibre via `@aio/maps`, Vitest, Playwright with Electron, Python 3 (`aio_pipelines`, pytest).

**Worktree:** `E:\Dev\AIO Software\.claude\worktrees\photo-position-edit`, branch `feat/photo-position-edit`. Every path below is relative to it. Never edit the main checkout or another worktree. Read `CONTRIBUTING.md` and `CLAUDE.md` before any task.

## Global Constraints

- Local frame (`docs/architecture/data-conventions.md` section 1): x east, y up, z south; `E = origin[0] + x`, `N = origin[1] - z`, `H = origin[2] + y`. The panel's **X = x**, **Y = -z** (site metres east and north of the site origin) and **Z = H**, the project height in the project's height system (the vertical datum or take-off rule of data-conventions section 3a; not raw GPS, not converted to ellipsoid). A shift `[dX, dY, dZ]` is the offset `[dX, dZ, -dY]` in the local frame. All conversions go through the T3 helpers, nowhere else.
- Date line-up: positions are stored unshifted (`pins/pinFrame.ts` `toStore`/`toDraw`). The panel shows and takes stored site metres; views keep applying the date shift when drawing.
- Pinned photos (`PhotoRef.pin` set) are excluded: `correctedPhoto` ignores corrections for them on purpose (the pin is their hand placement). Edit position is greyed with the reason "Pinned: use Move pin." Photos without `pos` ("Not placed") are greyed with "Not placed: use Place on site." 360s are out of scope (they have no correction record).
- Value range: absolute X, Y within 100 km of the origin, Z within -1000 to 10000 m; a shift component within +-10000 m. Out of range or not a number: the field shows `aria-invalid`, Save stays disabled. Offsets under 0.5 mm count as zero (same rule as `correctionTo`).
- Writes go through `orientation:write` with a change function applied to the file as it stands at write time (the `alignToStore.ts` `save(change)` pattern), one write per Save. A photo whose correction has zero rotations and a zero offset after the change is removed from the file, not saved as zeros.
- UI uses `@aio/ui` parts (`Button`, `IconButton`, `Popover`, `Row`, `Chip`, `Tip`), tokens `--sp-*`, `--z-*`, `--el-*`; all strings in `packages/ui/src/i18n/en.ts` (dotted keys, `_one`/`_other` plurals, no em or en dashes); the CSS guard (`packages/ui/src/cssGuard.test.ts`) forbids `title=` tooltips and raw spacing, z-index and shadow values.
- TypeScript strict; no `any`, no non-null assertions. Renderer code never imports `electron` or `node:*`. Python: run `ruff format` and `ruff check` yourself; python tests via the main checkout's venv (`E:\Dev\AIO Software\python\.venv\Scripts\python.exe -m pytest`), check afterwards that `aio_pipelines` still imports from the main checkout (memory: never junction the main venv).
- No client, site, tester or person names anywhere (code, tests, commit messages, docs). The founder's XT2 sample set stays outside the repo; tests build synthetic JPEGs. Run `node tools/agent/check-public-text.mjs <files>` on every doc added or changed.
- Electron e2e windows stay off-screen (fixtures do this); e2e with `--workers=1`, CI way: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp`, one Playwright run at a time.
- Commits: conventional, stage by path (never `git add -A`), never a bare `git stash`, message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## The altitude bug (found while planning)

Evidence: the app's own reader (`packages/project/src/builder/exif.ts` `readPhotoMeta`, run under Node on the founder's 108-file XT2 set, 54 thermal `_R.JPG` + 54 visual twins) and a segment dump in Python.

1. **The app never reads the DJI XMP of XT2 photos, thermal or visual.** `readPhotoMeta` parses XMP only from a standalone APP1 segment that starts `http://ns.adobe.com/xap/1.0/` (`exif.ts:221-224`). The XT2 writes its `<x:xmpmeta>` packet inside the Exif APP1 (byte ~800 of the file, no standalone XMP segment, no TIFF `XMLPacket` tag). So `dji.absAlt`, `dji.relAlt` and the gimbal angles are all undefined for every XT2 photo. Consequences: under the relative rule the height falls back to EXIF `GPSAltitude` (the barometric absolute altitude, -46.2 m off on this flight, so the photos sit tens of metres underground); no photo gets a view direction (`q`); `builder:photoGps` sets an origin at a camera's altitude instead of the take-off point. The Python reader (`aio_pipelines/aik/cameras.py` `read_meta`) regex-scans the first 300 KB for `<x:xmpmeta` and does read it, so app and pipeline disagree on the same file.
2. **Unsigned wrap of negative `GPSAltitude`.** DJI-written files store `GPSAltitude` as SRATIONAL (type 10), so -31.501 reads as -31.501 (ref 0 is wrong but harmless). The 5 thermal files written by the FLIR core (Make `FLIR Systems`) have no DJI XMP at all and store `GPSAltitude` as RATIONAL (type 5). One of them holds numerator `0xffffee6a` / 1000, which is -4.502 written as unsigned: both readers return **+4,294,962.794 m**. Its visual twin reads -4.501. The other four read the same altitude as their twins (11.6 to 28.7 m); their lat/lon are rounded to about 0.0001 degree (up to ~10 m off their twins).
3. **Why thermal looked "completely wrong" and visual did not.** Through the app's import path thermal and visual twins get identical heights except that one wrapped thermal, which lands 4,295 km up. Layer bounds (`shell/layerBounds.ts:86`, `project/src/builder/extents.ts:140`) include it, so the thermal layer's frame-to-fit, fly-to and scene extent are thrown into space. Both kinds also share fault 1 (absolute baro height, no direction), which the founder may not have noticed on the visual set.

Fix (T1, T2): read an XMP packet found anywhere in the head (standalone segment first, then a `<x:xmpmeta ... </x:xmpmeta>` scan of the Exif payload), and read a type-5 `GPSAltitude` whose numerator has the top bit set as a signed 32-bit value; drop an altitude whose magnitude is over 20 km as unreadable, and flag wrapped and dropped values (`gps.altWrapped`, `gps.altDropped`) so the import row can warn about a photo that has no twin. Same wrap rule in Python. New imports then get take-off + relative heights and view directions; projects imported before the fix are repaired by **Re-read photo positions** (T14); a thermal without DJI metadata takes its twin's place (T15).

**The fix does not make XT2 heights right by itself (founder, 21 Oct).** The XT2 `AbsoluteAltitude` is itself about 46 m off on this flight (a bad barometric home altitude: absolute minus relative is -46.2 m everywhere, on a site near sea level). Under the absolute rule the photos stay 46 m low; under the relative rule they are right relative to the take-off point but only as right as the take-off height the project uses. So these photos still need **Edit position** (select all, shift Z) after the reader fix; the How to test walkthrough covers it.

## Contract changes

No change to stored shapes. `orientation.json` (`aio.orientation/1`) and `PhotoCorrection` keep their shape; the manifest stays `aio.project/1`; no migration. One additive IPC, `builder:rereadPhotos` (T14, `packages/schema/src/ipc.ts`): request `{ projectId, layerId, folder?: string, dryRun?: boolean }` (strict); response `{ ok: true, manifest, reread: number, kept: number, twins: number, notFound: number, refined: boolean }` (a dry run writes nothing and returns the counts it would give) | { ok: false, needsFolder: true, missing: number } | { ok: false, error }`. The behaviour of existing contracts changes in a few places, so T12 adds this row to `docs/architecture/contract-changes.md`, exact text:

```
| 2026-10-21 | No stored shape change. Additive IPC `builder:rereadPhotos` `{ projectId, layerId, folder?, dryRun? }`: re-reads the photos of one photos layer from their files with the fixed XMP reader and rewrites each item's imported `pos` (height by the project's height rule) and `q` (gimbal angles); pinned items are left alone; a photo with a hand correction keeps its corrected place (its `offsetM` is re-anchored to the new `pos`); returns `{ ok, manifest, reread, kept, twins, notFound, refined }` (`refined`: processing had given the layer refined poses, which a re-read replaces), or `{ ok: false, needsFolder, missing }` when the review copies carry no metadata and no folder of originals was given. A raw import and a re-read give a thermal `_R` photo without DJI XMP the place of its visual twin (number plus one, then minus one, capture times within 3 s) as an `offsetM` correction in `orientation.json`, and its twin's `q` on the item. `PhotoCorrection.offsetM` in `orientation.json` is now also written by "Edit position" (one photo: offset = typed position minus the imported `pos`; several: the typed shift added to each photo's offset; Reset removes `offsetM` and the entry when no rotation is left). The photo align job (`photo.align`, pack) now reads `orientation.json` and the photos layer's `pin`: a photo with a non-zero `offsetM` or a pin goes to ODM at its corrected or pinned place (`geo.txt`) instead of its EXIF GPS. `photo:applyPoses` removes the corrections of the photos it gives refined poses (the refined pose already includes them) and keeps them in its poses backup. Builds without this change draw the same corrected positions (they already apply `offsetM`) but send EXIF GPS to ODM. | Edit position of photos (`docs/plans/2026-10-21-photo-position-edit.md`) | @aio/geo, @aio/project, @aio/maps, @aio/ui, desktop, pipelines | Founder, photo position edit of 2026-10-21; sign-off at merge |
```

And one paragraph in `docs/architecture/data-conventions.md` (photos section, where `orientation.json` is described): what `offsetM` means for Edit position, that `pos` stays the imported original, and the X/Y/Z mapping above.

## Readers of photo position (audit)

Already through `correctedPhoto` (nothing to do): 3D frusta `renderer/builder/photoPoses.ts`, map `packages/maps/src/mediaMarkers.ts:172` and `photoPins.ts:69`, spot history `workspace/spot/spotEntries.ts`, bounds `shell/layerBounds.ts` and `project/src/builder/extents.ts`, `workspace/SelectionCard.tsx`, `workspace/FramesPane.tsx`, `annotate` crossview camera and `PhotoViewer.tsx`, `video/src/pairing.ts`, `change/src/detections.ts`, `ai/src/places.ts`.

Raw `pos`, fixed in this plan: `workspace/framesModel.ts:65,182`, `workspace/compareWith.ts:133`, `builder/photoAlignStore.ts:133` (T11); `main/photogrammetry.ts:741` `poseMoves`, `:1190` located set and `:1341` `photo:applyPoses` (T10); Python `photo/align.py` `photo_list`/`layer_meta` (T9).

Raw, left as they are (noted for a follow-up, not on the feature's path): `project/src/builder/recentre.ts:169` (moves the stored `pos`, which is right: the offset is relative), Python `change/frames.py:203`, `inspection/pipeline.py:160-185`, `inspection/frame.py:220`, 360 readers (no correction exists for 360s).

## Package ownership

| Package / area                | Tasks    |
| ----------------------------- | -------- |
| `@aio/project` (exif)         | T1       |
| `@aio/project` (twin, reread) | T15, T14 |
| `@aio/schema` (one IPC)       | T14      |
| desktop main (import, reread) | T15, T14 |
| `python` (aik cameras, photo) | T2, T9   |
| `@aio/geo`                    | T3       |
| `@aio/ui` (strings)           | T4       |
| desktop main                  | T10      |
| desktop renderer workspace    | T11      |
| desktop renderer builder      | T5, T6   |
| desktop renderer screens      | T7       |
| `@aio/maps`                   | T8       |
| e2e, docs                     | T12      |

## Execution DAG

```
T1 exif fix (TS) ──┬─> T15 thermal twin (import) ─> T14 re-read (IPC, main) ─┐
                   └───────────────────────────────────────────────────────────┤
T2 exif fix (Python) ────────────────────────────────────────────────────────┤
T9 ODM uses corrections (Python) ────────────────────────────────────────────┤
T10 applyPoses + poseMoves (main) ───────────────────────────────────────────┤
T11 raw readers -> correctedPhoto ───────────────────────────────────────────┤
T3 geo maths ──┬─> T5 edit store ──┐                                         ├─> T12 e2e + docs ─> T13 verify
T4 strings ────┼─> T5              ├─> T6 panel, actions, menus, mount ──────┤
               ├─> T7 Media multi-select + Edited badge ─────────────────────┤
T3 ────────────┴─> T8 map Edited mark ───────────────────────────────────────┘
```

| Task | Depends on                                          |
| ---- | --------------------------------------------------- |
| T1   | none                                                |
| T2   | none                                                |
| T3   | none                                                |
| T4   | none                                                |
| T9   | none                                                |
| T10  | none                                                |
| T11  | none                                                |
| T5   | T3, T4                                              |
| T7   | T3, T4                                              |
| T8   | T3                                                  |
| T15  | T1, T3                                              |
| T14  | T1, T3, T15                                         |
| T6   | T5 (and T14's export name, fixed below; same batch) |
| T12  | T1 to T15                                           |
| T13  | T12                                                 |

**Parallel batches** (each dispatched in one message; tasks in a batch share no file):

| Batch | Tasks                        | Files they own (no overlap)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | T1, T2, T3, T4, T9, T10, T11 | T1 `packages/project/src/builder/exif*`; T2 `python/src/aio_pipelines/aik/cameras.py`, `python/tests/test_aik_cameras.py`; T3 `packages/geo/src/positionEdit*`, geo `index.ts`; T4 `packages/ui/src/i18n/en.ts`, `i18n.test.ts`; T9 `python/src/aio_pipelines/photo/align.py`, new `photo/corrections.py`, their tests; T10 `apps/desktop/src/main/photogrammetry*`; T11 `workspace/framesModel*`, `workspace/compareWith*`, `builder/photoAlignStore*`                                                 |
| 2     | T5, T7, T8, T15              | T5 `builder/positionEditStore*` (new); T7 `screens/Media.tsx`, `screens/MediaPins.tsx`, `screens/mediaModel*`, `screens/mediaSelect*` (new); T8 `packages/maps/src/mediaMarkers*`, maps `styles` file it uses; T15 `packages/project/src/builder/thermalTwin*` (new), `builder/raw.ts`, `builder/raw.test.ts`, `apps/desktop/src/main/builder.ts` (import deps), `main/builder.test.ts`                                                                                                                 |
| 3     | T6, T14                      | T6 `builder/EditPositionPanel*` (new), `builder/EditPositionNotice.tsx` (new), `shell/actions/positionActions*` (new), `shell/actions/index.ts`, `builder/PhotoMenu.tsx`, `builder/BuilderLayer.tsx`, the panel's css file; T14 `packages/schema/src/ipc.ts` (+ test), `packages/project/src/builder/reread*` (new), project `builder/index.ts`, `apps/desktop/src/main/reread*` (new), main `index.ts` (handler registration), `main/journal.ts`, preload bridge, `shell/actions/rereadActions*` (new) |
| 4     | T12                          | `apps/desktop/e2e/photo-position-edit.spec.ts` (new), `apps/desktop/e2e/positionFixture.ts` (new), `docs/architecture/contract-changes.md`, `docs/architecture/data-conventions.md`, the user guide page for photos                                                                                                                                                                                                                                                                                     |
| 5     | T13                          | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Batch 1 is wide on purpose: seven small, independent tasks. Run their test suites one at a time (light local load; the shared lock runner from memory), not seven Vitest runs at once.

**Critical path:** T1 -> T15 -> T14 -> T12 -> T13 (T14 is the heaviest task: IPC, main, journal, project writer, action). The UI path T3 -> T5 -> T6 -> T12 runs beside it. T9 (Python plus a pack bump) is the longest task of batch 1.

**Shared seam in batch 3.** T6 owns `shell/actions/index.ts` and adds both registrations; T14 creates `shell/actions/rereadActions.tsx` exporting exactly `registerRereadActions(): void`. Typecheck after the batch, not per task. T14 does not touch `en.ts` (T4 adds its strings in batch 1).

## e2e specs

| Spec                                           | Change | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/e2e/photo-position-edit.spec.ts` | new    | (a) Media: right-click one GPS photo, Edit position, the panel shows its X/Y/Z; type Z + 5, Save; `orientation.json` holds `offsetM [0, 5, 0]`, the manifest `pos` is unchanged, the tile shows "Edited". (b) Ctrl-click a second photo, right-click, Edit position: the panel says "Shift 2 photos"; type Y 10; both offsets gain `[0, 0, -10]`; Undo in the notice restores both exactly, Redo puts them back. (c) Map: right-click a photo marker, Reset to original; the entry is gone, the marker moves back (its lon/lat equals the imported one). (d) A pinned photo's menu shows Edit position greyed with the pinned reason. (e) Re-read: the fixture's photos layer holds two items whose stored `pos`/`q` are stale and whose review copies carry synthetic XT2-style EXIF with XMP inside the Exif block (one with an Edit position offset); right-click the dataset, Re-read photo positions, confirm: the unedited item's `pos` height and `q` match the file, the edited one keeps its corrected place (its offset re-anchored), the notice counts both. (f) Import a synthetic thermal pair (visual `X_0006.jpg` with XMP, thermal `X_0005_R.JPG` without XMP and a wrapped altitude): the thermal tile shows "Edited", its corrected `pos` equals the twin's, Reset puts it at its own (fixed-reader) place. |
| `apps/desktop/e2e/sidebar-menus.spec.ts`       | change | The photo menu on the map lists Edit position (one assertion beside the existing photo-pin menu test, `:245`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`positionFixture.ts` writes its own small project (two GPS photos, one pinned photo, offline basemap) as `pinFixture.ts` does, so the pinned-media specs keep their counts. Neither spec needs the change demo or the pipeline Python; run `pnpm demo:change --quick` before the CI-way run anyway (T13).

## Founder decisions (21 Oct 2026)

- **Z is project height H** (not height above the origin, not ellipsoidal).
- **Pinned photos are excluded**: they already have Move pin.
- **360s are out of scope**; Edit position for 360s is a follow-up (it needs a correction record for `PanoRef`, a contract change).
- **Existing projects**: a one-time **Re-read photo positions** action per photos dataset refreshes heights, view directions and gimbal angles from the files with the fixed reader, keeping manual corrections (T14).
- **Thermal twins**: on import, every thermal `_R` photo without DJI XMP whose twin passes the capture-time check takes its visual twin's position and view direction, stored as a correction ("Edited", Reset works) (T15).
- **XT2 absolute altitude is itself 46 m off**: these photos still need Edit position after the reader fix.

## Decisions made here

- One photo: the panel shows the corrected position; Save sets offset = typed - imported. Several: Save adds the shift to each photo's current offset (a photo with an earlier edit keeps it plus the shift).
- Reset to original removes the position offset only; a direction set with Align photo to map stays.
- "One-time" Re-read: the action stays on every photos dataset's menu (running it twice changes nothing), so no "already re-read" flag is stored and the schema stays as it is.
- **Twin candidate, exactly** (founder, 21 Oct; T15 `needsTwin`): the file name ends `_R` before `.jpg`/`.jpeg` (any case) **and** the head has no DJI XMP (`meta.dji` undefined after T1). The altitude does not matter: all five FLIR-written thermals of the sample qualify. Lat/lon must be present (the correction needs the photo's own place as its base). A candidate with no twin keeps its own place; when its altitude is `altWrapped` or `altDropped` its import row says so (`position.twin.none`).
- **Twin, exactly** (T15 `findTwin`): among the visual photos of the same import, or already in the project's photos layers, with a placed `pos` and not themselves twin candidates: by name: same prefix, same zero padding, number `N + 1`, then `N - 1`, taking the first that exists and whose capture time is within 3 s of the thermal's (both must have a time). Note: the founder said "number minus one", but the sample numbers each thermal before its visual (`..._0005_R.JPG` pairs with `..._0006.jpg`), so `N + 1` is tried first and `N - 1` second; the time gate keeps a wrong neighbour out. Nothing else counts as a twin. No twin: the photo stays at its own place and its import row says "No visual twin found; check its position."
- What a twin gives: `offsetM = twin.pos - own.pos` in `orientation.json` (rotations 0), and the twin's `q` written on the item as its imported `q` (the thermal has no gimbal angles of its own, and a rotation correction needs a base `q`). Reset puts the position back; the direction stays (it is the best one known).

---

### Task 1: XT2 altitude fix in the TS reader (`@aio/project`)

**Files:** `packages/project/src/builder/exif.ts`, `packages/project/src/builder/exif.test.ts`

- [ ] Failing tests (synthetic JPEGs, extend the file's `withExif` / `jpegWith` helpers):
  - an XMP packet with `<drone-dji:AbsoluteAltitude>-31.501320</drone-dji:AbsoluteAltitude>`, `RelativeAltitude` 14.7 and gimbal yaw/pitch/roll placed **inside the Exif APP1 payload** after the TIFF data, no standalone XMP segment: `meta.dji` has `absAlt -31.50132`, `relAlt 14.7`, `gimbal`;
  - a standalone XMP segment still wins over a packet inside Exif when both exist;
  - `GPSAltitude` type 5 with numerator `0xffffee6a`, denominator 1000, ref 0: `gps.alt` is `-4.502`;
  - `GPSAltitude` type 10 `-31.501` with ref 0 stays `-31.501` (regression);
  - `GPSAltitude` over 20,000 m in magnitude after the rule: `gps.alt` undefined, lat/lon kept;
  - `photoRef` for the first case under the relative rule (`photos.test.ts` or here): height = take-off H + 14.7, source `relative`, `q` set.
- [ ] Implement: remember whether a standalone XMP segment was parsed; if not, after the segment loop, search the Exif payload bytes for `<x:xmpmeta` ... `</x:xmpmeta>` (decode only that slice) and run `parseXmp`. In `readIfd` or at the GPS read, a type-5 GPS altitude whose numerator is `>= 2^31` is read as `getInt32` and sets `gps.altWrapped = true` (new optional field on `PhotoMeta.gps`, with a test). Plausibility clamp at the GPS altitude only; a dropped altitude sets `gps.altDropped = true`.
- [ ] `pnpm --filter @aio/project test exif photos` green; `pnpm typecheck`.

### Task 2: unsigned wrap in the Python reader

**Files:** `python/src/aio_pipelines/aik/cameras.py`, `python/tests/test_aik_cameras.py`

- [ ] Failing test: a JPEG written with piexif whose GPS altitude is the RATIONAL `(0xffffee6a, 1000)`, ref 0: `read_meta(path)["altitude"] == pytest.approx(-4.502)`; one over 20 km is left out; a type-10 negative is unchanged. A JPEG with the XMP packet inside the Exif block reads `AbsoluteAltitude` (proves the Python side already works; it must pass straight away, keep it as a guard).
- [ ] Implement in `read_meta`: when the altitude numerator (`IFDRational.numerator`) is `>= 2**31`, subtract `2**32` before dividing; drop `abs(alt) > 20000`.
- [ ] `ruff format`, `ruff check`, `pytest python/tests/test_aik_cameras.py`.

### Task 3: position edit maths (`@aio/geo`)

**Files:** `packages/geo/src/positionEdit.ts` (new), `packages/geo/src/positionEdit.test.ts` (new), `packages/geo/src/index.ts` (export)

- [ ] Failing tests, then implement:
  - `siteXYZ(pos: Vec3, origin: Vec3): { x, y, z }` = `{ x: pos[0], y: -pos[2], z: origin[2] + pos[1] }`; `localFromSite(xyz, origin): Vec3` is its inverse (round trip test);
  - `shiftToOffset({ x, y, z }): Vec3` = `[x, z, -y]`;
  - `offsetForPosition(imported: Vec3, origin: Vec3, xyz): Vec3` = `localFromSite(xyz) - imported`, rounded to 0.1 mm;
  - `withPositionOffset(cur: PhotoCorrection | undefined, offsetM: Vec3 | null): PhotoCorrection | null` keeps rotations, sets or removes `offsetM`, returns null when nothing is left (zero rotations and an offset under 0.5 mm, or null);
  - `isPositionEdited(c)`: `offsetM` present and any component `>= 5e-4`;
  - `parseMetres(text, kind: 'x' | 'y' | 'z' | 'shift'): number | null` with the ranges of the global constraints (accepts `-`, `+`, comma or dot decimal; empty is null).
- [ ] `pnpm --filter @aio/geo test positionEdit`.

### Task 4: strings (`@aio/ui`)

**Files:** `packages/ui/src/i18n/en.ts`, `packages/ui/src/i18n/i18n.test.ts`

- [ ] Add, in a `position.` group (no dashes): `position.edit` "Edit position", `position.reset` "Reset to original", `position.title_one` "Position", `position.title_other` "Shift {count} photos", `position.x` "X east", `position.y` "Y north", `position.z` "Z height", `position.unit` "m", `position.hint.one` "Site metres from the origin; height in the project's height system.", `position.hint.many` "Every selected photo moves by this amount and keeps its spacing.", `position.original` "Original: {x}, {y}, {z}", `position.save` "Save", `position.cancel` "Cancel", `position.edited` "Edited", `position.say.saved_one` "Moved 1 photo.", `position.say.saved_other` "Moved {count} photos.", `position.say.reset_other` "Put {count} photos back where they were imported.", `position.say.undone`, `position.say.redone`, `position.why.pinned` "Pinned: use Move pin.", `position.why.unplaced` "Not placed: use Place on site.", `position.why.notEdited` "Not edited.", `position.invalid` "Enter a number in range.". Re-read (T14): `position.reread` "Re-read photo positions", `position.reread.confirm` "Read heights and view directions again from the photo files. Photos you moved by hand stay where you put them.", `position.reread.refined` "Processing refined these photos' positions; re-reading replaces them.", `position.reread.pickFolder_other` "{count} photos have no metadata in the project. Choose the folder with the original files.", `position.say.reread_other` "Re-read {count} photos.", `position.say.rereadKept_other` "{count} moved by hand kept their place.", `position.say.rereadMissing_other` "{count} not found in that folder.". Twins (T15): `position.twin.used` "Thermal photo without position data: placed at its visual twin {name}.", `position.twin.none` "Thermal photo without position data and no visual twin found: check its position.", `position.say.twins_other` "{count} thermal photos placed at their visual twins.".
- [ ] Test: the keys exist and the catalogue check passes (`i18n.test.ts` pattern at line 109).

### Task 5: edit store (renderer)

**Files:** `apps/desktop/src/renderer/builder/positionEditStore.ts` (new), `positionEditStore.test.ts` (new)

Modelled on `builder/alignToStore.ts` (deps `workspace`, `save(change)`, `reload`; one write at a time; one-step Undo/Redo notice; refuses when `orientationLoaded` is false or the project is a package).

- [ ] Failing tests with a fake `save`:
  - `open(picks)` with one placed, unpinned photo gives `{ mode: 'one', current: siteXYZ(corrected), original: siteXYZ(imported) }`; with several, `{ mode: 'many', count }`; pinned and unplaced picks are left out and counted in `skipped`; none left: `open` refuses with the reason;
  - Save one: writes `offsetForPosition`, keeps the photo's rotations; typing the imported values back removes the entry;
  - Save many: each photo's offset gains `shiftToOffset(shift)`; a zero shift writes nothing;
  - `reset(picks)`: removes `offsetM` (entry removed when no rotation);
  - Undo after Save many restores each photo's previous correction exactly (including "no entry"), Redo re-applies; a notice raised for another project writes nothing;
  - a write error shows its text and leaves the notice without Undo.
- [ ] Export a singleton `positionEdit` created in the same place `alignTo` is created (find it with grep in `bootstrap.ts`; if that file must change, add the one line there and list it in the commit).

### Task 6: panel, actions, menus and mount

**Files:** `apps/desktop/src/renderer/builder/EditPositionPanel.tsx` (new) + test, `EditPositionNotice.tsx` (new), `apps/desktop/src/renderer/shell/actions/positionActions.tsx` (new) + test, `shell/actions/index.ts`, `builder/PhotoMenu.tsx`, `builder/BuilderLayer.tsx`

- [ ] Actions (`defineAction<'photos'>`, `section: 'edit'`, `targets: ['photos']`, `multi: true`, as `photos.alignTo` in `kindActions.tsx:429-460`):
  - `photos.editPosition` (icon `crosshair`, label `position.edit`): `disabled` returns `editBlocked(ctx)`, else `position.why.pinned` / `position.why.unplaced` when no pick is editable; `run` calls `positionEdit.getState().open(picks, at)`;
  - `photos.resetPosition` (label `position.reset`): `appliesTo` when any pick `isPositionEdited`; `run` calls `reset`.
  - Register from `registerSidebarActions()`; tests on `actionsFor` with one, several, pinned and unplaced picks, and read-only.
- [ ] `PhotoMenu.tsx`: add both ids to the single-photo list beside `PIN_ACTIONS`, and to the several-picked menu beside Align to (`:296-309`).
- [ ] Panel: `Popover` anchored to a zero-size opener placed at the menu point (Popover needs an opener ref, `packages/ui/src/Popover.tsx:15-55`). Three labelled number inputs (`position-input-x|y|z`), the hint, "Original" line for one photo, Save (disabled while a field is invalid; Enter saves), Cancel (Escape). Many: inputs start empty and mean a shift; empty counts as 0. Test ids: `position-panel`, `position-save`, `position-cancel`, `position-reset` (single, when edited).
- [ ] Notice: same look as `AlignToNotice.tsx`, Undo/Redo buttons `position-undo` / `position-redo`.
- [ ] One-line mounts of panel and notice in `BuilderLayer.tsx`.
- [ ] `shell/actions/index.ts`: call `registerPositionActions()` and `registerRereadActions()` (the latter from T14's `rereadActions.tsx`).
- [ ] Component tests: values shown for one photo; invalid input disables Save; Save calls the store with parsed numbers; many mode shows "Shift 2 photos".

### Task 7: Media multi-select and Edited badge

**Files:** `apps/desktop/src/renderer/screens/Media.tsx`, `screens/MediaPins.tsx`, `screens/mediaModel.ts` + test, `screens/mediaSelect.ts` (new) + test

- [ ] `mediaSelect.ts`: a small zustand store of picked photo tiles (`PhotoPick[]`) with `nextPicks` semantics reused from `builder/photoPicks.ts` (Ctrl toggles, Shift adds the range in tile order, a plain click picks one and also sets the workspace selection as today). Tests for each.
- [ ] `MediaPins.tsx` `targetOf`: when the right-clicked tile is among the picks, the target holds every pick; else only that tile (and the picks reset to it). Test.
- [ ] `mediaModel.ts`: each photo entry gets `edited: boolean` from `isPositionEdited(photoCorrection(...))`; test. `Media.tsx`: a `Chip` "Edited" on the tile (`media-tile-edited`), picked tiles show the selected style.

### Task 8: Edited mark on the map (`@aio/maps`)

**Files:** `packages/maps/src/mediaMarkers.ts` + test

- [ ] Failing test: the photo feature carries `edited: true` when its correction has an offset; the marker layer paints a ring for `edited` (style expression test as the file's existing ones).

### Task 9: ODM uses corrected and pinned positions (Python)

**Files:** `python/src/aio_pipelines/photo/corrections.py` (new), `python/src/aio_pipelines/photo/align.py`, `python/tests/test_photo_corrections.py` (new), the existing align test file that covers `layer_meta`/`needs_geo`

- [ ] `corrections.py`: `read_offsets(project) -> dict[(layer, photo), (dx, dy, dz)]` from `orientation.json` (missing or unreadable file: `{}`; schema other than `aio.orientation/1`: `{}` plus a warning), and `corrected_pos(item, offset) -> list[float] | None` (pinned items: their `pos` as is).
- [ ] `photo_list` passes each item with its corrected `pos` and a flag `placed_by_hand` (non-zero offset or `pin`). `layer_meta` uses the layer pose when the file has no GPS **or** `placed_by_hand`: lat/lon from the corrected `pos`, `layer_h`, `from_layer = True`, so `needs_geo` writes `geo.txt`.
- [ ] Failing tests: a GPS photo with `offsetM [0, -100, 0]` gets a geo row 100 m lower than its EXIF height and the same lat/lon; a shift north moves lat; a pinned GPS photo goes at its pin; no `orientation.json` changes nothing; rotations in the file are ignored here (directions still come from the photo's gimbal angles).
- [ ] Pack: bump the pipeline pack minor version and its manifest the way `CONTRIBUTING.md` describes (the app needs this pack for ODM to honour corrections); `ruff`, pytest.

### Task 10: pose swap and moved-poses check (main)

**Files:** `apps/desktop/src/main/photogrammetry.ts`, `apps/desktop/src/main/photogrammetry.test.ts`

- [ ] Failing tests: `poseMoves` measures refined poses against `correctedPhoto(p, correction)` (a photo corrected 100 m down and refined near the corrected place reports a small move, not 100 m); `photo:applyPoses` with `apply` removes the corrections of the refined photos from `orientation.json` (via the same atomic write the `orientation:write` handler uses, `main/orientation.ts`), writes them into `POSES_BACKUP` beside the poses, and leaves corrections of photos it did not refine.
- [ ] Read `orientation.json` in the plan step so preview and apply agree.

### Task 11: raw readers through `correctedPhoto`

**Files:** `apps/desktop/src/renderer/workspace/framesModel.ts`, `workspace/compareWith.ts`, `builder/photoAlignStore.ts`, their tests

- [ ] Failing test per file: a photo with `offsetM` is found or measured at its corrected place (frames near a point, compare-with nearest photo, align neighbours). Use the orientation file already in the workspace store (`orientationLoaded`).

### Task 15: thermal twin on import (`@aio/project`, main)

**Files:** `packages/project/src/builder/thermalTwin.ts` (new) + test, `packages/project/src/builder/raw.ts`, `raw.test.ts`, `apps/desktop/src/main/builder.ts`, `main/builder.test.ts`

- [ ] `thermalTwin.ts`, pure, failing tests first:
  - `needsTwin(name, meta)` exactly as "Decisions made here": true for `X_0005_R.JPG` with no `dji` (with a plausible, wrapped, dropped or missing altitude alike); false with DJI XMP; false for a name without `_R`; false without lat/lon;
  - `findTwin(thermal, candidates)`: `N + 1` by name within 3 s; `N - 1` when `N + 1` is missing or more than 3 s apart; a twin without a capture time is refused; a candidate that itself needs a twin, or is unplaced, is skipped; none gives null;
  - `twinFix(own: PhotoRef, twin: PhotoRef)` gives `{ offsetM: twin.pos - own.pos, q: twin.q }` (offset rounded to 0.1 mm; no `q` when the twin has none).
- [ ] `raw.ts`: keep each photo's name and meta from the loop; after the loop run the twin pass over the new photos plus the project's existing photos (by id and `takenAt`), set the thermal item's `q`, add the row message `position.twin.used` / `.none` text (English, as the other row messages), and return `twins: { layerId, photoId, offsetM }[]` to the caller through a new optional dep `deps.saveCorrections?(fixes)` called once after the manifest is written. Tests in `raw.test.ts` with two synthetic JPEGs (T1's helpers).
- [ ] `main/builder.ts`: pass `saveCorrections` that merges the fixes into `orientation.json` with `writeOrientation` (`main/orientation.ts:62`), keeping other entries and rotations; a failed write turns into the import's warning, never a failed import. Test with a temp project.

### Task 14: Re-read photo positions (schema IPC, project, main, action)

**Files:** `packages/schema/src/ipc.ts` (+ its test), `packages/project/src/builder/reread.ts` (new) + test, project `builder/index.ts`, `apps/desktop/src/main/reread.ts` (new) + test, main `index.ts` (register), `main/journal.ts` (record the step), the preload bridge file that lists IPC channels, `apps/desktop/src/renderer/shell/actions/rereadActions.tsx` (new) + test

- [ ] IPC `builder:rereadPhotos` as in "Contract changes"; zod test (strict request, all three response forms).
- [ ] `reread.ts` `rereadPhotoLayer(root, layerId, { folder?, orientation })`, failing tests first:
  - source per item: the review copy `photos/<id>.jpg` when its head has EXIF GPS (copied-as-is files keep it), else in `folder` the file whose `slug(basename)` equals the item id (or the id minus a `-<n>` uniqueness suffix), accepted only when its `takenAt` matches the item's to the second (when both have one); none: counted in `missing` and left as it is;
  - with `missing > 0` and no folder: returns `needsFolder` and writes nothing;
  - per found item, with the project's current height rule (`resolveHeights(m)`) and frame: new `pos` and `q` from `photoRef` (T1 reader); `lens` kept; pinned items skipped;
  - hand corrections kept: a photo with `offsetM` gets `offsetM' = oldPos + offsetM - newPos` so its corrected place does not move; rotations unchanged; a twin fix (T15) is recomputed for thermals that need one and replaces their offset;
  - one manifest write (`updateManifestFile`) and one orientation write; counts `reread`, `kept`, `twins`, `notFound`;
  - a layer that processing gave refined poses (a poses backup for this layer in a run folder, `photogrammetry.ts` `POSES_BACKUP`) sets `refined: true` in a dry-run answer so the confirm can say so (add `dryRun?: boolean` to the request in the same IPC; include it in the contract row).
- [ ] `main/reread.ts` handler: refuses packages and read-only projects; journal entry so the step can be undone like other manifest steps (`main/journal.ts` pattern at 1042-1068) including `orientation.json`.
- [ ] `rereadActions.tsx`: `layers.rereadPhotos` on `layers` targets of kind `photos`, section `edit`, `disabled` via `editBlocked`; run: dry run, confirm dialog with `position.reread.confirm` (+ `.refined`), folder picker when `needsFolder`, then the real call and a toast with the counts. Export `registerRereadActions`. Tests on `actionsFor` and the flow with a fake bridge.

### Task 12: end to end specs and docs

**Files:** `apps/desktop/e2e/photo-position-edit.spec.ts` (new), `apps/desktop/e2e/positionFixture.ts` (new), `apps/desktop/e2e/sidebar-menus.spec.ts`, `docs/architecture/contract-changes.md`, `docs/architecture/data-conventions.md`, the photos page of the user guide

- [ ] Specs as in "e2e specs" above; read `orientation.json` and the manifest from disk to assert.
- [ ] Contract row (exact text above), data-conventions paragraph, guide paragraph "Edit a photo's position" with the How to test steps. `check-public-text.mjs` on each doc.

### Task 13: verification

- [ ] `pnpm check` green; python suite the CI way (`pytest` from `python/`).
- [ ] `pnpm demo:change --quick`, then both specs CI way (`QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp`, `--workers=1`), plus `pinned-media.spec.ts` and `align-to.spec.ts` (shared menus and the orientation file).
- [ ] Manual check on the founder's XT2 sample (outside the repo, not copied): import into a scratch project; every DJI-written photo has a view direction; no photo is km up; the one wrapped thermal shows "Edited" at its twin's place; heights are still about 46 m off under the absolute rule (expected), fixed with Edit position. Run Processing on a small subset and confirm `geo.txt` carries the shifted heights. Re-read photo positions on a project imported with the old build.

## How to test (founder walkthrough, also for the closing message and session note)

1. Open a project made with an older build from the XT2 photos. In the sidebar, right-click the photos dataset and choose **Re-read photo positions**. If it asks, choose the folder with the original photos. The notice says how many photos were re-read; the photos now point where the camera looked (view cones in 3D), and the thermal photo that was thousands of kilometres up sits beside its visual twin with an "Edited" mark.
2. Or start fresh: create a project and add the XT2 folder. Same result as step 1 without the re-read.
3. The photos still sit about 46 m too low (the drone's absolute altitude is off on this flight). In Media, click the first photo, Shift-click the last, right-click, **Edit position**. The panel says "Shift N photos". Type the height difference in Z (for example 46) and Save. All photos rise together and keep their spacing; each tile shows "Edited". Undo in the notice puts them back; Redo again.
4. Right-click one photo, **Edit position**: the panel shows its X, Y, Z and its original values. Type a new Z, Save. The marker on the map and the camera in 3D move.
5. Right-click a photo marker on the map, **Reset to original**: it goes back to where it was imported; the "Edited" mark goes.
6. Right-click a pinned photo: Edit position is greyed and says to use Move pin.
7. Run Processing (ODM) on a few edited photos: the run uses the edited positions (the georeferenced result sits at the corrected height).

- [ ] Independent review (strongest model) before hand-off; "How to test" walkthrough in the closing message and the session note.

## Open questions for the founder

1. The twin number: the sample pairs `N_R` with `N + 1`, not `N - 1`. The plan tries `N + 1` first, then `N - 1`, with a 3 s capture-time gate. Is that right for your other XT2 sets?

## Follow-ups (not in this plan)

- Edit position for 360s (a `PanoRef` correction record, a contract change).
- The Python readers left on raw `pos` (`change/frames.py`, `inspection/*`).
