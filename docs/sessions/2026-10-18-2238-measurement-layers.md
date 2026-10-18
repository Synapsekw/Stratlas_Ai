---
type: session
date: 2026-10-18-2238
branch: feat/measurement-layers
status: complete
related:
  - superpowers/specs/2026-10-18-measurement-layers-design.md
  - superpowers/plans/2026-10-18-measurement-layers.md
---

# Measurements as layers in the Datasets sidebar

## What changed

- Saved measurements are rows in a new Measurements group in the left Datasets tree (open by default, after Maps and rasters): folders, colour swatch, value, an eye per row, folder and group eyes with a mixed state; dimmed rows for survey measurements whose date is hidden; at most 9 rows per folder before "more".
- Right-click menu (founder order): Rename (inline, F2, 200 characters), Colour (8 presets), Hide/Show, Fly to, Move to folder (with New folder...), Delete. Same menu on the shape in the main 3D view and the main map; a left click there selects it. Pins, issue pins, photos and the drone keep priority; nothing picks while a tool draws or a vertex is edited.
- Hiding is personal view state in `localStorage` per project: it never marks `measurements.json` unsaved, never adds History, never hides for others; it works in read-only packages. No schema, IPC or contract change.
- "Saved in this project" left the Measure bench; a Saved footer keeps Autosave, Revert, the status line with Save, the load error and read-only notices and BulkTotals. Finishing a shape and the telecom Measurements button reveal the row in the tree.
- Every measurement Delete (key, header, tree, 3D and map menus, panel) shows "N deleted · Undo"; Undo restores them exactly and, with Autosave on, saves the restore. Marks of deleted measurements are dropped. A save still writing when another project opens no longer touches that project.
- A mixed layer and measurement Delete asks about the layers first and deletes nothing on Cancel; look-only reviewers get a read-only Selected panel too.
- New e2e `measurement-layers.spec.ts`; ten measurement specs moved off the old list; `bench-scroll` checks the tall catalogue's bottom edge.

## Why

The founder wants the left sidebar to hold everything the project contains and the right workbench the tools, with measurements as quick to hide, recolour and file as any layer. Visibility is per person (founder: "only for me").

## How to test

1. Open a project with a few saved measurements and go to Scene. In the left sidebar, open Measurements under Datasets: each measurement shows its colour, name and value.
2. Click a row's eye: the shape disappears from 3D and the map, and the Measure bench still says "All saved". Close and reopen the project: it is still hidden.
3. Right-click a row: the menu shows Rename, Colour, Hide, Fly to, Move to folder, Delete. Pick a colour, then Move to folder, New folder..., type a name: the row moves into the folder. Save in the Measure bench.
4. Hide one measurement in a folder: the folder's eye stays visible (mixed). Click the folder eye: everything in it hides.
5. In 3D, right-click a measurement's line or inside an area: the same menu opens. Left-click it: it is selected and the Measure tab comes forward. Click empty ground: the selection clears.
6. Start the Distance tool and right-click a shape: no menu, the click goes to drawing.
7. Select a measurement and press Delete: it disappears and "... deleted · Undo" appears bottom right; click Undo and it is back with its colour and folder.
8. Ctrl+click two measurement rows and right-click: Colour and Delete act on both ("Delete 2 measurements").

## Open threads

- Map: a click on a road PCI sample unit under a measurement opens the unit card and also selects the measurement (needs a map controller hook). 3D: issue areas and draped issue shapes over a measurement select both.
- Fly to uses `focusPoint`; switch to `flyToLocalBox` (`workspace/flyToBox.ts`, now on main).
- The old list's search, sort and field filters are not in the tree; the founder is deciding whether they come back.
- In the live Measure bench, Shift+Tab from the tool strip reaches Autosave before the card's Cancel.
- `Sidebar.tsx` `OPEN_GROUPS` copies DatasetTree's private `DEFAULT_OPEN`; `MeasureToolbar` and `BulkTotals` read only the file read-only flag; the dates-off Measurements heading has no menu (its Collapse entry went with the "0 datasets" menu).
- Drag of rows onto folders, folder rename and delete, and nested folders are not built.

## Next session entry point

Land this PR through the merge train, then the map overlay click hook and the `flyToLocalBox` switch.
