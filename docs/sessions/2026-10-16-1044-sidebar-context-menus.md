---
type: session
date: 2026-10-16-1044
branch: feat/sidebar-context-menus
status: complete
related:
  [plans/2026-10-15-sidebar-context-menus-design.md, plans/2026-10-15-sidebar-context-menus.md]
---

# Right-click menus and Align to

## What changed

- **One shared right-click menu for the left sidebar**, built from a new shared action registry (`packages/ui/src/actions`: registry, ContextMenu; actions registered per feature in `apps/desktop/src/renderer/shell/actions/`). It opens on empty space (project actions), date folders, group headings, every row (including the basemap and Issues/Drafts) and the marked set (Ctrl/Shift click; only multi actions, header "N datasets"). Shift+F10 and the Menu key open the focused element's menu. Disabled items are greyed with a reason.
- **New layer actions:** Rename (inline, F2), Zoom to (F now frames a layer selection), Export (copies the dataset's own files plus a `<name>.crs.json` sidecar), Reveal in folder, Properties (read-only dialog). Per-kind actions moved in from the old menus, including the point cloud cleanup and engineering model items.
- **Align to** (photo sets from the sidebar; picked photo pins on the map or 3D via Ctrl/Shift click or Alt+drag, with picked pins ringed on the map; also a button on the far-content notice): moves the selection as one block onto the target's centre through `PhotoCorrection.offsetM` in `orientation.json` (GPS untouched). Heights shift only when implausible (below ground or more than 300 m above it; photo and panorama targets take ground only from a DSM). One undo, from the notice or Ctrl+Z on the scene. Readers (agent places, layer extents, spot history) now use corrected photo positions.
- **Contract rows (pending founder review):** `LayerPatch {name}`, `layer:info`, `layer:export`, `layer:reveal`, `layerExtents` using corrected photos; a new file family `aio.layer-crs/1`.
- Also fixed: the real-data compare e2e spec sets its own survey dates (the local sample project now dates every layer).

## Why

The sidebar had scattered per-kind menus and no way to act on empty space or a marked set. A photo set far from the site needed a way to land on the model without editing GPS, and the registry is the base for the palette, shortcuts and agent tools to share one action list.

## Rulings for the founder to review

- Read-only and package projects grey items out instead of hiding them.
- Delete on a marked set acts on the deletable rows only, as the header button does.
- Photo and panorama Align to targets keep heights when there is no DSM.
- Redo uses the undo icon (the icon set has no redo icon).
- The far-content Align to is greyed for packages and look-only projects.

## How to test

1. Open a project with several datasets. Right-click empty space in the Datasets list (or the Datasets heading): the project menu lists Add data, Add drone panoramas, Add drawing, Add survey date, Show all / Hide all, imports, Check placement, Exports, Empty trash, Project properties, Close project.
2. Right-click a date folder: View this date, Show/Hide all, Compare with, Rename, Colour, Icon, Zoom to, Export, Add data to this date, Delete.
3. Right-click a group heading and then a dataset of each kind: a point cloud shows Settings, Colour by and Clean up...; a mesh shows Georeference, Place model, Create engineering model; a walk shows Open and Place; a photo set shows Align to and Create maps from photos.
4. On a dataset: Rename (or F2) and Enter keeps the new name; Zoom to (or F) frames it; Properties shows its files, size, extent and coordinate system; Reveal in folder opens Explorer; Export... into an empty folder copies the files plus a .crs.json.
5. Keyboard: Tab to a row and press Shift+F10 or the Menu key: the row's menu opens; arrows move, Enter runs, Escape closes.
6. Ctrl-click three rows, right-click one of them: the header says 3 datasets and only items for all three show; Hide hides all three; Move to date moves all three.
7. Align to: in a project whose phone photos sit far away (the far-content notice shows), click Align to... in the notice, or right-click the photo set > Align to > pick the model or ortho. The photos move onto the site and a notice says how far; Undo (or Ctrl+Z while it shows) puts them back.
8. Part of a set: on the map, Ctrl-click or Alt+drag over photo pins (they get a ring), right-click one > Align to.

## Open threads

- 3D picked photos are not highlighted (map ring only); merged 3D markers cannot be Ctrl/Shift picked (box select works).
- Design layers (survey designs) are not in Zoom to or Align to targets; walks need a placed path to be targets.
- An Align to notice can reappear briefly if the project switches mid-save (its Undo refuses). Ctrl+Z right after an issue edit with focus back on 3D goes to Align to while its notice shows.
- Layer export cancels only between files and fails whole on a missing source file.
- The palette, shortcuts and agent tools are not yet moved onto the registry (agent-coverage plan). Deferred minors are listed in the plan's review.

## Next session entry point

Move the command palette and shortcuts onto the action registry, then the agent tools (`plans/2026-10-15-agent-coverage-gaps.md`); first fix the 3D pick highlight and add design layers to Zoom to.
