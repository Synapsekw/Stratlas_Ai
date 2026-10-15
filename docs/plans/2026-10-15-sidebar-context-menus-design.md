# Right-click menus across the sidebar, and Align to

Date: 15 Oct 2026. Branch: `feat/sidebar-context-menus`. Status: design approved in brainstorming, spec under review.

## Why

Every action in the left sidebar should be reachable by right-click, not only through buttons, and photos placed far off by phone GPS (91 km in one project) need a quick way back. Today only two hand-rolled menus exist (`DateFolderMenu`, `LayerDateMenu` in `apps/desktop/src/renderer/shell/DateMenus.tsx`); empty space, basemaps and the Annotations rows have none, multi-marks only feed the Delete key, and no layer has Rename, Zoom to, Export, Reveal or Properties anywhere.

## Decisions (founder, 15 Oct)

1. Build all five missing layer actions: Rename, Zoom to, Export, Reveal in folder, Properties.
2. Export copies the layer's own files unchanged, plus a CRS sidecar for local-frame layers.
3. Properties is a read-only modal dialog with Rename and Reveal buttons.
4. Align to works on whole photo sets from the sidebar and on individual photo pins picked on the map or in 3D.
5. Align to moves the block in plan onto the target's centre and fixes height only when it is implausible (see Align to).
6. Actions live in a shared registry in `packages/ui`; features register their own actions.

## 1. Action registry

`packages/ui/src/actions/`:

```ts
type MenuTarget =
  | { kind: 'project' }
  | { kind: 'date'; captureId: string | null }          // null = "Every date"
  | { kind: 'group'; group: GroupKind; layerIds: string[]; captureId?: string | null }
  | { kind: 'layers'; layerIds: string[] }              // one row or the marked set
  | { kind: 'photos'; picks: { layerId: string; photoId: string }[] };

interface Action<T extends MenuTarget = MenuTarget> {
  id: string;                       // 'layer.rename', 'photos.alignTo'
  label: I18nKey | ((t: T) => string);
  section: 'open' | 'view' | 'edit' | 'compare' | 'file' | 'danger';
  targets: T['kind'][];
  multi?: boolean;                  // offered when the target holds several items
  appliesTo?(t: T, ctx: ActionCtx): boolean;   // must hold for every targeted layer
  disabled?(t: T, ctx: ActionCtx): string | false;  // reason shown as tooltip
  shortcut?: ShortcutId;            // shown in the menu, from shortcuts.ts
  submenu?(t: T, ctx: ActionCtx): SubItem[];   // Move to date, Compare with, Align to, Colour by
  run(t: T, ctx: ActionCtx, sub?: string): void | Promise<void>;
  // reserved for the agent-coverage plan; optional now
  risk?: ToolRisk; input?: ZodType; surfaces?: ('menu' | 'palette' | 'agent')[];
}
registerActions(actions: Action[]): () => void;
actionsFor(target: MenuTarget, ctx: ActionCtx): ResolvedItem[];   // sorted by section, then registration order
```

`ActionCtx` carries what the predicates need (manifest layers, `canEdit`, processing state, dates) and the services the runs call; the desktop app builds it once. Features register from their own modules: `shell/projectActions.ts`, `shell/layerActions.ts` (common set), `walks/`, `drawings/`, point cloud, video, photos, panos. Mixed-kind targets show an action only when `appliesTo` holds for every layer. A disabled action is greyed with its reason, not hidden.

## 2. Context menu component

`packages/ui/src/actions/ContextMenu.tsx`, portalled to `document.body`, built from `actionsFor`. Folds in the helpers now in `DateMenus.tsx` (`useMenu`, `usePlace`, `menuKeys`) and `packages/ui/src/focus.ts`. Sections separated in fixed order: open, view, edit, compare, file, danger. A header names multi targets ("3 layers"). Items show their shortcut. Keyboard: arrows, Home/End, Enter, Escape, type-ahead; Right/Left open and close submenus; focus returns to the invoker on close.

Opening: `contextmenu` on rows, headings, folders and empty tree space; Shift+F10 and the Menu key on the focused element (explicit keydown handler, placed under the element). Empty space opens the project menu.

`DateFolderMenu` and `LayerDateMenu` are rebuilt on it, keeping their test ids (`date-menu`, `date-menu-<id>`, `date-more-<id>`, `move-menu`, `move-to-<id>`, `move-compare`, `menu-delete`). New ids: `ctx-menu`, `ctx-item-<actionId>`.

## 3. Multi-select

Marks keep today's input (Ctrl/Shift click, Ctrl+Space, Shift+arrows, Escape). Right-click on a marked row targets the marked set; on an unmarked row, that row alone, marks untouched. Multi targets offer only `multi` actions: Show/Hide, Zoom to, Move to date, Align to (photo sets only), Export, Compare with, Delete. On the map and in 3D, Ctrl/Shift click and box select pick several photo pins; the photo menu acts on the picks.

## 4. Actions per target

Project: Add data, Add drone panoramas, Add drawing, Add survey date; Show all / Hide all; Import flight folder, Import 360 video, Import tiles; Check placement; Exports...; Empty trash; Project properties; Close project.

Date folder: today's items (View this date, Expand/Collapse, Show/Hide all, Compare with, Rename, Colour, Icon, Reset, Delete) plus Zoom to, Export, Add data to this date. "Every date" keeps its reduced set.

Group heading: Expand/Collapse, Show/Hide, the group's add action (Add drawing, Add 360 video), Zoom to, Move to date, Compare with, Export, Delete.

Every layer row: Show/Hide, Zoom to, Rename, Move to date, Compare with, Export..., Reveal in folder, Properties..., Delete... Per kind:

| Kind                       | Extra                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Point cloud                | Settings, Colour by (submenu); cleanup items from `feat/pointcloud-cleanup` are ported in at rebase |
| Mesh                       | Georeference by point pairs (any mesh)                                                              |
| Drawing                    | Settings, Side by side, Place on site / Place again, On top                                         |
| 360 walk                   | Open, Place / Edit placement, Remove placement                                                      |
| Video clip / flight        | Calibrate video, Align camera to map, Show flight path                                              |
| Photos                     | Align to..., Create maps from photos..., Open first photo                                           |
| Panoramas                  | Open, Stitch (unstitched only)                                                                      |
| Ortho, DSM, raster, vector | common set                                                                                          |
| Basemap                    | Show/Hide, Properties only                                                                          |
| Issues, Drafts             | Open, Show/Hide                                                                                     |

Photo pins (map, 3D): today's photo menu plus Align to..., with a header when several are picked.

## 5. New layer actions

- **Rename**: inline edit on the row (menu or F2), saved via `builder:updateLayers` with a new `LayerPatch` variant `{ name: string }`.
- **Zoom to**: `layerBounds(layer, ctx)` in the renderer returns a local-frame box: mesh and cloud from scene objects tagged `userData.layerId`; photos from corrected positions; rasters from corners or the COG/PMTiles georeference; drawings and designs from `designsStore.layerBounds`; vectors from GeoJSON bounds; walks from their placed path. Frames the union for multi targets. Also fixes `Stage.ts:1217` so F / fly-to frames layer selections.
- **Export**: folder picker, then main-process `layer:export { layerIds, dir }` copies each layer's files into `<dir>/<layer name>/`, writing `<layer name>.crs.json` (`crs`, `origin`, layer `transform`) for local-frame layers. Progress notice for large sets; cancellable; refuses to overwrite.
- **Reveal in folder**: `shell.showItemInFolder` on the layer's main file.
- **Properties**: modal, read-only. Name, kind, survey date, files and size on disk, item or point count, extent and centre (local metres and WGS84), CRS, import time; Rename and Reveal buttons. Data from main-process `layer:info { layerId }`. Project properties uses the same dialog with project fields.

## 6. Align to

Submenu lists target layers with a known position (any kind with `layerBounds`), grouped by date, excluding the selection's own layers. Choosing one applies at once.

In the local metre frame (X east, Y up, Z south):

1. Source: corrected positions of the selected photos that have one. Photos without a position are skipped and counted.
2. Plan shift: target bounds centre (X, Z) minus source centre (X, Z).
3. Height: target ground `g` = DSM value at the target centre when the project has a DSM covering it, else the target bounds' minimum Y. Let `lo` = the source's lowest photo Y after the plan shift. If `lo < g` or `lo > g + 300`, shift Y by `g + 1.6 - lo` (the lowest photo lands at eye height above the target ground); otherwise leave Y alone. Relative heights inside the block never change.
4. If the total shift is under 1 m: notice "Already in place", no write.
5. Each selected photo's `PhotoCorrection.offsetM` in `orientation.json` gains the shift (created with zero yaw, pitch, roll if absent). Manifest `pos`, GPS and rotation corrections are untouched. One `orientation:write`, journalled with `.bak` as today.

Notice: "Aligned 214 photos to Site model (moved 91.2 km)" with Undo. Undo writes back each photo's previous `offsetM` (or removes the correction it created) in one write; Redo reapplies. Ctrl+Z / Ctrl+Y act on it while the notice shows. The far-content notice gains an "Align to..." button. Disabled for read-only reviewers and packages.

Readers switched to corrected positions so moved photos are consistent everywhere: `packages/ai/src/places.ts` (photo boxes and eyes), `packages/project/src/builder/extents.ts` (photos), `spotEntries.ts`, `framesModel.ts`.

## 7. Contract changes (additive, rows in `docs/architecture/contract-changes.md`)

- `LayerPatch` gains `{ name: string }`.
- New IPC `layer:export { layerIds, dir } -> { written: number; skipped: string[] }` with progress events.
- New IPC `layer:info { layerId } -> LayerInfo` (files, sizes, counts, extent, crs, importedAt).
- `builder:layerExtents` photos extents read corrected positions (behaviour, no shape change).

## 8. Strings

All new labels in `packages/ui/src/i18n/en.ts`: `actions.*` for registry items (`actions.layer.rename`, `actions.photos.alignTo`, ...), `actions.section.*` not shown, `align.*` for the notice, `layerProps.*` for the dialog. Existing `tree.dates.*` keys stay. The hard-coded row strings (gear labels, Show/Hide, "N more") move into `en.ts` while touched.

## 9. Testing

Unit (vitest): registry (`actionsFor` filtering by target, multi, mixed kinds, disabled reasons, section order); ContextMenu (keyboard incl. Shift+F10 and Menu key, submenus, type-ahead, focus return, portal); align maths (plan shift, height rule both branches, skip no-GPS, under 1 m, undo inverse restores exactly); `layerBounds` per kind; main `layer:export` and `layer:info` against a fixture project; `LayerPatch { name }` handler.

E2E (Playwright, `apps/desktop/e2e`), run the CI way (1100x720, scale 1, WARP, `--workers=1`, demos built):

- `sidebar-menus.spec.ts`: one test per menu kind (empty space, date folder, group heading, row of each kind present in the demo, photo pin), each opened by right-click and by Shift+F10; checks expected items and runs one action each (Add survey date dialog opens, Rename persists, Zoom to moves the camera, Properties shows the layer's file, Hide hides).
- `sidebar-multi.spec.ts`: mark three rows, right-click, only multi items shown; Hide all three; Move to date moves all three.
- `align-to.spec.ts`: a photo set offset far away, Align to a target, photos land in the target box, GPS in the manifest unchanged, Undo restores the exact previous positions, Redo reapplies.
- `layer-export.spec.ts`: Export a photo set and a mesh to a temp dir; files and sidecar present.
- Existing `timeline`, `delete-and-start-over`, `compare`, `pano-compare`, `survey-dates-add` specs stay green unchanged.

## Out of scope

Moving the palette, shortcuts table and agent tools onto the registry (later, per the agent-coverage plan); format conversion on export; editable properties; point matching; expanding photo sets into per-photo rows in the sidebar.
