---
type: session
date: 2026-10-15-1509
branch: feat/library-organise
status: complete
related:
  [
    ../superpowers/specs/2026-10-15-library-organise-design.md,
    ../superpowers/plans/2026-10-15-library-organise.md,
  ]
---

# Project library: remove, delete, covers and folders

## What changed

- Every library card (native, received package, demo) can be removed from the library (files stay) or deleted to the recycle bin through `shell.trashItem`; main refuses the data folder, userData, home, drive roots and links. Delete is blocked while the project is open or a job runs.
- Thumbnails: the new project wizard pre-selects a built-in cover (Contours, Site grid, Ridge lines, Point cloud) or takes an upload; right-click Change thumbnail offers upload, the last 3D view, or the project's own picture (kept once as `thumbnail.original.jpg`).
- Folders: one level, one folder per project, a tile row with HTML5 drag and a Move to folder menu; rename and delete (projects go loose). New folder is an icon-only button so the header fits at 1100 px.
- New userData file `library-view.json` (`aio.library-view/1`) holds hidden cards, folders and placements; `library.json` stays `/1`. Contract row added. Merged as PR #138, `main` at `9538d017`.

## Why

The founder asked for four quick library fixes: remove anything, received packages included, choose a cover instead of a random one, and organise the page with folders.

## How to test

1. Library: right-click a demo, Remove from library; it stays gone after a restart.
2. Right-click a received .aio package, Delete; the confirm names the file and it goes to the recycle bin.
3. New project: on the first step pick a built-in cover or upload an image; the card shows it.
4. Open a project, look around in 3D, return; right-click the card, Change thumbnail, Use the last 3D view, Save.
5. On an imported project change the thumbnail, then Change thumbnail, Use the project's own picture to restore it.
6. Click the folder icon (New folder), drag a card onto it, open it, use the back link.
7. Right-click a card, Move to folder, in and out; search finds projects inside folders.
8. Right-click a folder, Delete folder: its projects return to the main list, no files touched.

## Open threads

- A card menu may close when cards reflow after a library reload (one CI failure; the e2e now retries the open). Watch for it in the app.
- The open-project Delete block is renderer-only (main has no "open" signal); a crafted IPC could trash the open project to the recycle bin.
- "Use the last 3D view" is a snapshot taken on leaving the scene; a capture button inside 3D may be wanted. No auto-scroll while dragging.
- `volumetric-build.spec.ts` was rerun once on PR #138 CI (not a listed flaky test; passed on rerun).
- Founder review: the icon-only New folder button, the contract row ("pending founder review").

## Next session entry point

Nothing left on this branch; the next build comes from the ODM session.
