# Engineering Fidelity Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task in this session. Track results in the plan ledger. The user has explicitly authorized implementation.

**Goal:** Reproduce the private benchmark's modelling fidelity through the application, with measured selectable parts, correct cloud placement and visible review.

**Architecture:** Extend the existing local evidence pipeline and deterministic builders with individual observations and source associations. Use bounded AI interpretation/refinement, a main-process run authorization, and a review experience integrated with the existing scene.

**Tech Stack:** Electron, React, Zustand, TypeScript, Zod, Three.js, Python, NumPy/SciPy, local DXF processing.

**Spec:** docs/superpowers/specs/2026-10-17-engineering-fidelity-design.md

## Global constraints

- Preserve cloud coordinates, heading and height offset exactly once; model axes are x-east/y-up/z-south.
- Source data and reference geometry remain outside Git. Benchmark-specific dimensions are never production defaults.
- Old saved runs remain readable; source/schema/algorithm changes invalidate affected caches.
- Run approval is scoped to inputs, provider/model, categories and limits; every outbound call is checked in main.
- Fit quality and file validity are separate. Do not claim reference fidelity until source-driven and visual checks pass.
- Keep existing Mission tokens, keyboard behaviour, stable component IDs and accepted/user edits.

## Review focus

- A project closes or changes while a draft builds: never install or focus its layer in another project (Task 1).
- A dense crown merges neighbouring radios or obscures a rear face: report unresolved associations/coverage rather than successful fabricated measurements (Tasks 3 and 4).
- A cloud offset or project origin changes after measurement: invalidate/refit or re-express a frame, never double-shift (Tasks 2 and 7).
- A resumed run changes provider or source contents: require new authorization and preserve cumulative spend (Task 6).
- A partial build or rejected component leaves empty geometry: retain inspectable successful parts, disclose failure and disable misleading acceptance (Tasks 1 and 7).

## Task 1: Visible draft review and selection

Files: renderer/engineer/runStore.ts, host.ts, review.ts, EngineerLayer.tsx and adjacent tests; renderer/modeller/ModellerLayer.tsx as needed.

Interface: refresh project state through the app's existing refresh path after modelBuild/accept; explicit review entry takes the active run's draft layer, makes it visible and frames it. Selection is shared by workspace and engineering inspector.

- [ ] Write regression tests: building a draft updates the active manifest; review entry shows and focuses the run's layer even if previously hidden; a different displayed procedural model cannot hide the active engineering run; viewport selection updates inspector and list selection updates workspace.
- [ ] Run the focused tests and observe failure for missing refresh/focus/selection behaviour.
- [ ] Implement refresh, guarded scene entry, readiness/failure messaging and bidirectional stable-ID selection. Keep the scene unobstructed and add explicit Model/Cloud/Overlay and Fit controls.
- [ ] Run focused tests, typecheck and existing engineering UI tests. Capture real UI in Task 7.
- [ ] Commit the working review changes.

## Task 2: Individual measurements and frame contracts

Files: packages/schema/src/modelEvidence.ts, engineer.ts, assemblies.ts; renderer/engineer/summary.ts; Python evidence dataclasses and serialization; new adjacent tests.

Interface: EvidencePack optionally carries component observations with stable ID, proposed kind, centre, width/height/depth, face orientation, parent, source IDs and field-level provenance/fit statistics. ModelEvidenceParams accepts drawing files and optional camera poses. Frame signature records effective source transforms. Additive contracts default absent legacy values safely.

- [ ] Add failing roundtrip/validation tests for independent widths/depths/azimuths, all members beyond 16, malformed measurements, old packs and nonzero offsets.
- [ ] Extend schemas and Python serialization, keep full bounded inventory locally and referenced summary IDs in AI payloads.
- [ ] Add named frame conversion/control-point tests with literal independently derived coordinates, two project origins and repeated import.
- [ ] Verify schema/Python/summary/geo tests and commit.

## Task 3: Source intake and robust local fitting

Files: Python engineer pipeline.py, members.py, new drawings.py and components.py; renderer SetupDialog.tsx; processing job parameter plumbing and tests.

Interface: local drawing inventory associates labels/schedules/footprints/elevations; robust registration and component fits return the Task 2 observations with evidence. Source intake retains the complete photo inventory and bounded selected image sets.

- [ ] Add failing synthetic tests for translated/rotated drawing sheets, unequal devices, separated close radios, tilted shaft sections, retained monopole platforms, ambiguous registration and hidden depths.
- [ ] Implement drawing association using existing DXF support and geometric/text structure, calibrated photo selection, plane/cylinder/box fits, per-device crops and full component inventory.
- [ ] Port reusable mathematics from the external benchmark scripts, eliminating site paths, sheet-coordinate gates and hard-coded component positions.
- [ ] Exercise the original benchmark DXF/cloud/photos locally; record fits and unresolved associations outside Git.
- [ ] Verify Python/schema/job tests, bump the processing-tools contract/version as needed and commit.

## Task 4: Measurement-driven assembly and richer geometry

Files: packages/modelling/src/engineer/assemble/telecom.ts, builders/telecom.ts, access.ts, geometry helpers, schema/assemblies.ts and adjacent tests.

Interface: per-observation assemblies use independently measured poses/dimensions and stable source-derived IDs. Geometry builders preserve IDs through multiple mesh primitives. Legacy group proposals remain a fallback.

- [ ] Add failing geometry/assembly tests for unequal widths/depths, independent face vs radial bearings, shared pipes, shaft lean, platform clearance, grating openings and node ownership.
- [ ] Feed observations into assembly, preserving overrides/accepted parts and measured platform heights.
- [ ] Implement rounded panels, radio fins/ports, pipes/clamps/frames, grating and bounded cable/compound builders with per-field provenance.
- [ ] Verify mesh validity, triangle budgets and all component raycast ownership using the app's real adapter; commit.

## Task 5: Bounded interpretation and fixed-frame feedback

Files: packages/ai/src/engineer.ts, engineerPrompt.ts; renderer/engineer/views.ts and runStore.ts; Python local evidence query handlers; IPC schema/main handler and tests.

Interface: allowlisted tools request local evidence/crops/fits/comparisons by validated IDs and bounded parameters. The final proposal references individual observations. Comparison shares source-frame view bounds and does not normalize each model independently.

- [ ] Add failing tests for tool argument bounds, invalid IDs, iteration/time limits, translated/scaled drafts incorrectly passing comparison, missing/duplicate observed components and preserved accepted components.
- [ ] Add the tool execution loop, validate local responses/proposals and keep file paths/GPS metadata out of outbound payloads.
- [ ] Implement fixed-frame comparison and per-part metrics, retain best validated draft and target unresolved parts.
- [ ] Verify AI/router/views/run-store tests and commit.

## Task 6: One run approval and guided setup

Files: schema/engineer.ts, AI request schema/main handlers/spend controls; renderer/engineer/SetupDialog.tsx, EvidencePreview.tsx, StageList.tsx, EngineerLayer.tsx, CSS and UI messages/tests.

Interface: persisted authorization tied to run, content inventory signatures, categories, route and cumulative limits. Every request checked by main. Review-input UI explains later evidence selections and sends only within those bounds.

- [ ] Add failing tests for one approval covering subsequent permitted passes, source/provider/category expansion, content changes at the same path, offline mode, restart spend, unknown prices and cancellation.
- [ ] Implement main-process authorization checks and persisted audit records, retaining project privacy restrictions without granting blanket permissions.
- [ ] Implement Sources / Modelling options / Review inputs with a single Analyse sources entry, local-progress state and clear run approval. Distinguish evidence-sharing review from model review.
- [ ] Verify focused unit and interaction tests and commit.

## Task 7: Source-driven benchmark and end-to-end review

Files: tools/agent/engineering-compare.mjs and a configurable benchmark driver; Electron engineering E2E tests; documentation and processing-pack version notes.

Interface: local benchmark configuration provides input paths, source signatures, expected placement/control points and reference path. Reports are written outside Git, identifying live vs replay generation and any manual correction.

- [ ] Add failing tests that detect wrong offsets/origins/headings, missing components, orphan mesh IDs and comparison frames that conceal displacement.
- [ ] Run the shipping generation path from original private benchmark sources; never load reference fit JSON as a production input. Resolve actual benchmark fit/visual failures.
- [ ] Validate GLB and picking, ground-to-tip <=0.10 m discrepancy, placement <=0.02 m and per-part targets from the spec. Capture full/head/base/top/reverse/overlay at identical cameras.
- [ ] Run Electron start/approval/progress/review/selection/overlay/accept/reopen and failure/cancel scenarios, with screenshots at 1440x900 and 1100x720.
- [ ] Run relevant broader tests, typecheck/lint, inspect all failures, update guide/session notes and commit.
- [ ] Fresh whole-branch review, resolve important findings with reproducing tests, then report measured results and any limitations. Do not merge or publish without separate authorization.
