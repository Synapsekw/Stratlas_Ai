---
type: session
date: 2026-10-24-1721
branch: feat/right-sidebar-ia
status: complete
related:
  - superpowers/specs/2026-10-24-right-sidebar-project-list-design.md
  - superpowers/plans/2026-10-24-right-sidebar-project-list.md
---

# The right sidebar's Project tab: an inventory above unchanged tools

## What changed

- The first right tab is now **Project** (tab id still `measure`). An "In this project" list of folding groups (Antennas, Sectors, Coverage plan, Measurements, Issues) sits above a Tools caption with the Measure tools unchanged. The project category orders the groups and only the first one starts open (founder pick C1 from mock-ups on the real UI).
- **Antenna inventory inline**: rows with editable azimuth and tilt, inline details (photos, values, Accept / Reject / Redraw / Delete), filters, a bulk bar acting on visible ticked rows, right-click on a row or the 3D unit (Edit azimuth, hide, solo), a 3D pick opens the row. The floating antenna card is gone.
- **Deleted detections stay gone** (founder): a confirmed delete writes `telecom/antenna-deletions.json` (`aio.antenna-deletions/1`) first, then the inventory, then the crop; re-detection drops any new find within 0.3 m of a deleted record. Pipeline pack **0.25.0** (`TELECOM_DELETE_MIN_PACK`); re-detection with deletions refuses an older pack. Contract row in `architecture/contract-changes.md`.
- New project wizard gains a **Telecom towers** card (purpose `telecom`). Delete is refused and greyed while a detection or flag job runs; bulk accept / reject is one write and one undo step.
- Checks: `pnpm check` green, full pytest green, e2e the CI way (1100 x 720, scale 1, WARP): new `project-list-antennas` and `project-list-groups`, plus 12 updated or affected specs, all passing.

## Why

The founder could not find an antenna inventory to delete wrong units and fix azimuth, and tools felt one click too far. Tools must stay where they are (no menus), so the inventory went on top of the same panel.

## How to test

Install pipeline pack 0.25.0 (Settings > Processing tools > Choose file) before re-detecting.

1. Open a telecom project with a point cloud and detected antennas. The right sidebar's first tab reads **Project**: Antennas open on top, Sectors, Coverage plan, Measurements, Issues folded, then Tools as before.
2. In Antennas, type a new azimuth in a row and press Enter: the unit turns in 3D. Click a row: its details open inline under it.
3. Click an antenna in 3D: its row opens and scrolls into view. Right-click it (or its row): the menu offers Edit azimuth, hide and solo.
4. Delete a wrong unit (row bin, details Delete or the Delete key): a dialog names it and its RF sector; confirm. Run antenna detection again: the deleted unit does not come back.
5. Tick two units, switch the filter so one is hidden: the bulk bar and the menu act only on the visible one.
6. Start a detection and try to delete: Delete is greyed until the job ends.
7. Open a survey project: Measurements is first and open; pick a measurement in 3D and its panel opens inline in the list.
8. Start a new project: the type step shows seven cards, including Telecom towers.

## Open threads

- Rulings for the founder to check: issues open the existing Issue card (no inline editor); per-unit hide and kind solo moved to right-click; the Project tab stays in front after a tool stops; 3D picks do not pop a folded drawer, explicit asks (Review antennas, Edit azimuth) do; antenna keys act whenever a unit is selected; the Telecom towers card icon is a placeholder.
- Left by the final review: the list-level hold ends only on a caption click; the Tools scroll runs once on mount; undo of a delete does not restore the crop; the Coverage plan group always counts 0; the delete fallback reason is plain English inside the translated message.

## Next session entry point

Founder testing on local `main` once the coordinator lands this branch (it goes last; pack 0.25.0 reserved for it). Stockpiles group for survey projects comes with volumetrics stage C.
