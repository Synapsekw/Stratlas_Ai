# Telecom measurements implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the feature implementation and review. Follow the checkboxes below.

**Goal:** Add three simple tools in the right sidebar: Azimuth, Antenna tilt and Clearance.

**Follow-up approved during implementation:** Add Show all / Hide all to the measurements sidebar for all measurement types, including existing linear measurements.

**Architecture:** Extend the existing survey measurement model, store, 3D picking, labels and persistence. Keep the controls in the existing context sidebar and the saved measurements in the existing measurement list. No asset registry or automatic object recognition.

**Tech stack:** Existing TypeScript, React, Zustand, three.js, Zod, Vitest and Playwright/Electron. No new dependencies.

**Spec:** The approved description in this document, based on the conversation of 16 October 2026. The user approved building the three tools with manual picking and requested an isolated worktree.

## Approved behavior

- Azimuth: pick three non-collinear points across the antenna front face. Compute its plane normal projected into the horizontal plane. Preview the facing arrow and offer Flip direction to choose the outward normal. Show degrees clockwise from project/grid north, explicitly labeled. Do not label grid north as true north. A local project must describe the reference as project north, without claiming surveyed orientation.
- Antenna tilt: pick bottom and top on the same straight antenna edge. Compute the unsigned angle from project vertical, 0 degrees upright and 90 degrees horizontal. Describe this as physical inclination, not electrical tilt or signed downtilt.
- Clearance: pick two endpoints. Show direct 3D distance, horizontal separation and absolute vertical gap. It measures the chosen gap, not automatic obstacle-free volume.
- Draw using actual 3D picks on point clouds or meshes; preserve picked height. These tools do not use terrain draping, typed bearing or plan-angle snapping. Prevent ground-plane fallback from creating a measurement without a geometry hit.
- Two points finish tilt/clearance; three finish azimuth. Degenerate points produce helpful feedback instead of NaN or a misleading zero. Support cancel, undo last draft point, editing endpoints, save, reopen, and visible scene labels. Reuse existing explicit Save measurements behavior.
- Fixed-size tools keep their required vertex count during editing. Reordering azimuth points or an explicit saved flag may represent the flipped normal, but it must survive saving/reopening.
- New controls are compact, accessible, consistent with Mission tokens and fit the right panel at 1100 x 720. Show a clear explanation when drawing is unavailable in map-only or read-only mode. One active drawing tool at a time; switching project or leaving 3D ends a draft.
- Show all / Hide all changes the visibility of saved measurement geometry and labels in 3D and Map. It covers all types regardless of list filtering, preserves survey-date scope and saved data, works in read-only projects and resets on project switch. New drawing or endpoint editing restores visibility. Hidden measurements must not remain selectable or snap targets.

## Global constraints

- Work only in `E:/Dev/AIO Software/.claude/worktrees/telecom-measurements`, branch `feat/telecom-measurements`.
- TypeScript strict, no `any`, no non-null assertions; no new dependencies.
- Reuse existing saved measurement files and read-only protections; no client data in fixtures or git.
- Contract additions must be recorded in `docs/architecture/contract-changes.md` with truthful backward compatibility notes.
- Existing survey tools, templates, map drawing and units must continue to work.
- No product redesign or asset-specific plugin framework. Use `docs/design/DIRECTION.md` for design context.

## Review focus

1. Arbitrary point order and flipped antenna face: facing arrow and number agree after save/reopen.
2. Nearly collinear, coincident, and horizontal-plane face points: invalid azimuth produces a useful message.
3. Vertical antenna/clearance segments: height is preserved, tilt is zero, vertical gap is positive in either click order.
4. Lifecycle: read-only package, map-only mode, project switch and competing drawing tools cannot leave active input behind.
5. Vertex editing: cannot insert/delete vertices for the fixed-size tools; numbers and scene labels update on movement.

## Execution DAG

T1 (schema, measurement mathematics, renderer integration and unit tests) -> T2 (end-to-end validation and corrections) -> final review and verification.
T1 is intentionally one cohesive task because the tool identifiers, drawing lifecycle and readouts share contracts. Existing-baseline checks and fixture exploration may run while it is implemented. Critical path: T1 -> T2 -> review.

The follow-up adds T3 (bulk visibility) after T1/T2, with its own focused regressions and extensions to both e2e specs, followed by final review and verification. Production and unit files belong to the implementation agent; root owns e2e and documentation.

## Task 1: Implement the three measurement tools

**Files:** `packages/schema/src/survey.ts`, `packages/survey/src/tools/telecom.ts` (new) and its tests; existing `tools/readout.ts`, `templates/model.ts`, `src/index.ts` as necessary; `apps/desktop/src/renderer/survey/measureStore.ts`, `measureScene.ts`, `MeasureToolbar.tsx`, `MeasurementPanel.tsx`; a small new `TelecomTools.tsx` and CSS in that folder; `workspace/WorkspaceScreen.tsx`; focused renderer tests; contract change record.

**Interfaces:** Add measurement tool identifiers `azimuth`, `antenna-tilt`, `clearance`. Azimuth uses three points, tilt and clearance two. Store in existing SurveyMeasurement records and derive values through existing measurementReadout/formatRow so list, scene and exports share calculations. Choose and document the smallest representation for normal flip. Export pure helpers through `@aio/survey` when the renderer needs them.

- [x] Write focused failing tests for cardinal azimuths and flip, non-collinear tilted faces, invalid faces, vertical and known-angle tilt, 3-4-5 clearance, reverse click order, translated large coordinates, and fixed-count interaction/save lifecycle.
- [x] Run the focused tests and record the expected failures.
- [x] Implement schema and numerical helpers, shared readouts and labels, then guided 3D drawing and sidebar controls. Keep helpers separated from React and three.js.
- [x] Run focused tests, formatting, typecheck and inspect the diff. Record any design rulings and test commands in the task report.
- [x] Review spec compliance and code quality before Task 2.

## Task 2: Verify in the real app

**Files:** `apps/desktop/e2e/telecom-measurements.spec.ts` (new), synthetic fixture helper only if needed, task-owned fixes and a session note.

**Interfaces:** Drive the sidebar controls, real 3D canvas, drawing buttons and saved list in Electron. Use synthetic known geometry; never modify real projects. Verify persisted records via the existing test project's files.

- [x] Add an end-to-end test with real canvas picking for all three tools, readable values and arrow direction, endpoint adjustment, cancellation, Save measurements and reopen; include 1100 x 720/sidebar layout and read-only or map-only availability assertions.
- [x] Build demos with `pnpm demo:build --quick`. Run the new spec and changed existing specs at `QUADRION_WINDOW_SIZE=1100x720`, `QUADRION_E2E_SCALE=1`, `QUADRION_E2E_SWGL=warp`, one worker.
- [x] Inspect an app screenshot and fix layout/interaction defects found by the checks.
- [x] Run `pnpm check`, then an independent whole-branch review; address important findings and rerun only the relevant checks after changes.
- [x] Commit verified work on this branch and report where the tools are, how to try them and any remaining limitations. Keep the worktree for the user.

## Task 3: Show all / Hide all

**Files:** `MeasurementList.tsx`, `measureStore.ts`, `measureScene.ts`, their focused tests, and the two existing e2e specs in Task 2. No new persisted contract.

- [x] Add view-only visibility state and the two sidebar controls, including keyboard activation.
- [x] Verify geometry, labels, selection, snapping, editing and project lifecycle across existing and telecom tools.
- [x] Verify all measurements hide while the list is filtered, return when shown, and leave the saved file untouched. Run the app tests and inspect the updated sidebar.

## Final evidence

- `pnpm check` with four test workers passed: lint, formatting, typecheck, **9,843 tests passed and 14 skipped**.
- Both app specs passed: **5 tests**, synthetic mesh/cloud fixtures, 1100 x 720, display scale 1, WARP, one worker, all demos built.
- Screenshots inspected; independent reviews approved the tools and bulk visibility after corrections.
- Public-text scan passed for all added lines. The founder subsequently authorized a local-only merge into main, without a remote push. No installer was requested.
