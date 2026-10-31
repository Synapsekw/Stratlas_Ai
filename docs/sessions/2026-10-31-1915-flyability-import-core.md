---
type: session
date: 2026-10-31-1915
branch: feat/flyability-inspector-import
status: complete
related:
  [
    superpowers/specs/2026-10-31-flyability-inspector-import-design.md,
    superpowers/plans/2026-10-31-flyability-inspector-import-phase-1.md,
  ]
---

# Flyability Inspector import, phase 1 core

## What changed

- Research and an approved spec for native confined-space inspections: read Flyability Inspector 5 exports (2024 `.bag` and 2025 `.mcap` generations), point clouds first, the app replaces Inspector for review and the PDF report. Measured on real exports: the camera lever arm (0.30 m forward), the pitch convention, and that Inspector stores an alignment `transform` for unrelocalised flights without applying it.
- Schema: spaces (several local frames per project, an older project reads as one space `main`), a `local` crs, `layer.space`, the `flightline` layer kind, `Issue.external`; data conventions section 40; contract rows; a compat test against the 0.21 schema.
- The `flyability.import` pipeline job (pack 0.31.0): reader, frames and ray cast, findings (one per POI, worst severity, category from tags, invalid poses flagged, not placed), merge that keeps edits, COPC per flight with its transform (checked on real PDAL), flight pose files, photos. A TS test parses the Python output with the schemas.
- Main process: export detection and scan, routing through Add data and the library, the 0.31.0 pack refusal. All of it is off for users (`FLYABILITY_IMPORT_UI = false`) until the picker branch.
- Built task by task with an independent review per task and a final whole-branch review; all in this PR.

## Why

Confined-space jobs were only in the app through a one-off converter for one tank. The core lands ahead of its UI, at the coordinator's suggestion, to cut rebase risk over UI Wave 2.

## How to test

No user-facing behaviour to test; covered by the test suite (the import is switched off until its picker lands).

## Open threads

- UI branch after Wave 2: space switcher in the breadcrumb (`mapAvailable` false for local spaces), flightline section in the right panel, picker dialog from Add data, Move point in the shared action registry (plus `action-tool-specs.ts` if the agent actions branch has landed), the e2e spec, then flip the flag.
- Before the flip: half-made project folder if creation fails, a second drop of the same export, OS files listed as skipped, `altitudePlan` for local projects, map consumers of a local crs, a plainer message for non-export files in a local project, IPC parse tests.
- Watch the first CI run: the Python output fixture is compared byte for byte after rounding to 3 decimals.
- A real-export run of the job is still to do (heavy, needs a window on the founder's PC).
- `compareStore.test.ts` timed out once under full `pnpm check` load (known flake, passes alone).

## Next session entry point

Wait for W7, W11 and W8 on local `main`, cut the UI branch from this one, and build plan Tasks 12 to 14.
