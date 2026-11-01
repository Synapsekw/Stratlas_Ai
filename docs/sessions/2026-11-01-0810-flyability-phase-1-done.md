---
type: session
date: 2026-11-01-0810
branch: feat/flyability-ui-2
status: complete
related:
  [
    superpowers/specs/2026-10-31-flyability-inspector-import-design.md,
    superpowers/plans/2026-10-31-flyability-inspector-import-phase-1-ui.md,
  ]
---

# Flyability Inspector import, phase 1 done

## What changed

- UI Wave 2 hook-ups: the Space crumb in the title bar (hidden with one space), a Flight lines section in the right panel (width, colour by flight, selected flight only with a hint), Map and Split greyed with a reason in a space with only local coordinates (island, keys and command palette; a split without the map stays usable).
- The import is switched on (`FLYABILITY_IMPORT_UI = true`); Move point is offered on any finding with a cloud point; the remaining pre-flip fixes are in.
- `apps/desktop/e2e/flyability-import.spec.ts`: a synthetic export through the picker, Move point surviving a re-import, a second inspection as a second space, and a `@realdata` case that skips without data.
- Fixes the e2e and the final review found: the Layers column follows the active space with survey dates on; a space's clouds are read against the space's own origin (renderer readouts and pipelines); jobs that work only in the project frame (volume, surface and cloud change, survey surfaces, DTM filter, exports, engineering pack, telecom, 3D Tiles) refuse a local-space cloud in plain words; an old PDAL monkeypatch leak between Python tests is fixed. Contract row and data conventions section 40 updated.

## Why

Phase 1 waited on UI Wave 2; once it landed the hook-ups, the switch-on and the end-to-end test could follow.

## How to test

1. Run `pnpm dev`. On the library, drop a Flyability Inspector export folder (or open a project and use Add data > Add Inspector data).
2. The picker lists the inspections, their flights and finding counts; leave them ticked and choose Import. The Processing drawer shows "Flyability Inspector import", then done.
3. In 3D the flight clouds and the merged cloud are separate layers; flight lines run through them; the right panel's Layers and display tab has a Flight lines section.
4. Open Issues: one finding per Inspector point of interest with severity, photo and annotated photo; the finding card shows a location line, with a warning when the wall distance disagrees.
5. Right-click a finding, Move point, click the cloud: the point moves, Undo is offered. Import the same folder again: the moved point stays.
6. Import a second chamber's export into the same project: a space name appears in the title bar; switching hides the other chamber; Map and Split are greyed with a reason.

## Open threads

- Measurements are not tied to a space yet; a measurement drawn in one chamber may show in another.
- Survey, volume and change tools refuse clouds in a chamber with only local coordinates; supporting them is a follow-up.
- A run on a real Inspector export (the e2e `@realdata` case and a manual run) is still owed.

## Next session entry point

Hand-off is with the merge coordinator; after founder testing, phase 2 (video projected on the cloud).
