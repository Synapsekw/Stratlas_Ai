---
type: session
date: 2026-11-09-2228
branch: fix/inspector-export-root
status: complete
related:
  - 2026-11-09-1826-flyability-mission-folder.md
  - 2026-11-09-2030-flyability-short-paths.md
---

# A folder dropped on the Projects screen now adds it to the library

## What changed

- A folder dropped on the Projects screen is now added to the library, the same way Add project folder adds it. This covers a project folder, a package, an Inspector export, or a folder that holds several exports. An export makes its project, the project opens, and the Inspector picker asks what to bring in. Before, a drop with no project open went to the Add data drop. That drop only imports into an open project, so the founder saw "Open a project to import", then "Import failed: Open or create a project first, then import." While a file is dragged over the Projects screen, the drop overlay now says "Add to the library". (`addFolders` in `apps/desktop/src/renderer/store.ts`, the drop in `builder/ImportPanel.tsx`.)
- A plain file dropped on the library now says it is a file, not a project. Before, it said the file was not found (`addToLibrary`, `apps/desktop/src/main/library.ts`).
- Switching chambers (spaces) now frames the chamber you enter, as Home does (`SpacesMount.tsx`). The mission folder note promised this, but its open threads said it was not wired.
- New tests: two end to end cases in `e2e/flyability-import.spec.ts` drop a folder on the Projects screen the way the system does, with no project open, through to the picker. One folder is itself an export, the other holds two exports. Unit tests cover the drop routing, the library add order and the switch framing.
- Real-data check of the single-export folder the founder reported (2024 export generation, two inspections, 12 flights): dropped on the Projects screen, it made one project and opened the picker. The import gave 2 spaces, 14 point clouds, 384 photos and 192 findings in about 6.5 minutes. A second drop opened the same project. The four-chamber mission from 6 May still scans as 4 chambers.

## Why

The founder dropped a whole export folder on the library and nothing came in. The scan, the picker and the import all worked on that folder through Add project folder, both with the development pipeline and with processing tools 0.33.0. What failed was the drop itself. The library drop that both 9 Nov notes describe had only ever been reached through the Add project folder button, and no test drove a real drop.

## Corrections to the 9 Nov notes

These are checked against the code and corrected in those notes:

- Mission folder note, step 1: "drop a folder" on the library did not work before this PR. It works now.
- Mission folder note, step 4: switching chambers did not re-frame the view (its own open thread said so). It does now. The other parts of that step hold: only the merged cloud is on, the readout says Local frame, and there is no street map chip in a local space (seen in the real run).
- Mission folder notes, steps 5 and 6: these hold. A re-drop opens the same project with the chambers marked as already imported. A cancelled Inspector job removes the waiting chambers from the queue, marks them Not imported and tidies their empty spaces.
- Short-paths note, step 2: a re-drop through a junction, a `subst` drive letter or another letter case finds the same project, because the real path is used and checked. A mapped network drive was not tried, so the step no longer names it. Step 3, one chamber dropped alone, holds, because the note keeps a hash for each export folder.

## How to test

1. Run `pnpm dev`. Open the Projects screen with no project open.
2. Drag a Flyability Inspector export folder from File Explorer over the window. The drop overlay says "Add to the library".
3. Drop it. A project named after the export is made and opens, and the Inspector picker lists its inspections. Choose Import. The chambers come in as spaces.
4. Go back to the Projects screen and drop the same folder again. The same project opens, and its inspections are marked as already imported. No second project is made.
5. Drop a folder that holds several exports, such as a mission folder. One project is made for it, and the picker lists every chamber.
6. In a project with two or more chambers, switch chamber in the title bar. The view frames the chamber you entered.
7. Drop a single photo on the Projects screen. The library says it is a file, not a project.

## Open threads

- Several folders dropped at once are added in turn until one opens a project, so the folders after an export are not added. Drop them again after the picker closes.
- A drop with a project open still imports into that project (Add data), as before.

## Next session entry point

Hand this branch to the merge coordinator.
