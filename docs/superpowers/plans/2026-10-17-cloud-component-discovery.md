# Cloud Component Discovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the independent tasks and review each result. Existing agents are reused. No commits or integration operations in this task.

**Goal:** Build and validate independently selectable engineering equipment without a drawing input.

**Architecture:** A Python adapter converts pure telecom face/box detections into the existing observation contract. The TypeScript assembler consumes those observations without replacing their measured poses or duplicating coarse fallback equipment. An isolated fresh run and independent baseline comparison provide visual and numeric evidence.

**Tech stack:** Existing Python, NumPy/SciPy, TypeScript, deterministic GLB builders, Electron desktop and native desktop verification.

**Spec:** `docs/superpowers/specs/2026-10-17-cloud-component-discovery-design.md`

## Global constraints

- Worktree only; no main writes, merge, rebase, push, lock acquisition or Playwright E2E.
- Real assets, benchmark names and images remain in ignored private artifacts.
- Detector inputs exclude drawings, previous models, saved proposals and external camera-pose files.
- Preserve source frame, effective height offsets, metres and individually selectable nodes.
- No paid benchmark requests until its concrete prepared inputs and budget are approved.

## Execution DAG

Task 1 (Python discovery) and Task 2 (assembler/freshness) run independently after agreeing the existing observation interface. Task 3 freezes the baseline and prepares a clean runtime independently. Tasks 1+2 feed combined checks and Task 4's fresh run. An independent reviewer checks discovery and integration before Task 4's final proof. The critical path is discovery -> fresh evidence -> evaluation -> corrective iteration -> native proof.

## Review focus

- Partial fronts/no backs: retain inferred-depth/centre provenance; do not report false measurement accuracy.
- Small radios versus short panels: keep uncertain classification visible rather than fabricate identity.
- Dense crowns or cancellation: bound working points and stop between costly phases.
- Reordered/translated/rotated clouds: stable geometry and preserved source frame, no benchmark coordinates.
- Partial detections: report omissions and avoid duplicate fallback equipment.

## Task 1: Cloud observation adapter

Files: new `python/src/aio_pipelines/engineer/discovery.py`, reused pure `telecom/faces.py` and `telecom/boxes.py` plus required package initializer, `engineer/pipeline.py`, `engineer/observations.py`, related Python tests.

Interface: `discover_components(xyz, axis, profile, sources, check=None)` returns `(observations, warnings)`. `axis` is the existing Axis; `profile` is its axial-height/radius samples. Observations use existing project-local coordinates and quality/source fields. The adapter owns bounded region selection and stable IDs.

- [x] Write/run failing synthetic tests for independent devices without a drawing, duplicate rejection, sparse surfaces and inferred depth; add frame/order invariance checks.
- [x] Reuse pinned pure detector functions without importing its standalone pipeline. Implement the adapter and wire the no-drawing monopole members path. Preserve drawing-assisted fitting.
- [x] Initially bump the component algorithm to `components/5` and update Python checkpoint expectations. Add a pipeline test proving the drawing-free adapter is invoked and warnings are retained. The support-fitting extension below advances this to version 6.
- [x] Run focused engineering and imported detector tests; record limits found by the private real-cloud run. The broader long-running suite is not claimed complete.

## Task 2: Assembly and freshness

Files: `packages/modelling/src/engineer/assemble/telecom.ts`, observation assembly/tests as needed, `packages/schema/src/modelEvidence.ts`, desktop freshness tests and documentation.

Interface: consumes existing evidence observations, including `equipment-box` for unknown small enclosures. Add optional cabinet `tiltDeg` with backward-compatible zero default so unknown enclosures do not lose measured inclination; record this contract change for later integration approval.

- [x] Write/run regressions showing separate unknown boxes keep their measured geometry and suppress duplicate coarse fallback equipment; retain warnings/uncertainty and selection IDs.
- [x] Implement the smallest assembly correction. Keep fallback when no independent equipment observations exist.
- [x] Preserve inclination for equipment-box observations in the cabinet builder and test old models without `tiltDeg`. Original-photo-backed AI classification may refine an unknown enclosure to panel/radio while preserving measured geometry and ID; generated render evidence alone must not permit that refinement.
- [x] Set TypeScript component algorithm expectation to `components/6` and update freshness tests so old evidence cannot silently pass.
- [x] Run relevant modelling/schema/desktop tests, typecheck and scoped lint. Update the user guide with actual supported no-drawing behavior and remaining classification limits.

## Task 3: Independent benchmark preparation

Files: ignored `.superpowers/no-drawing-flow/` only.

- [x] Freeze baseline GLB/model/evidence by copy and content hash; do not expose baseline geometry to detector inputs.
- [x] Prepare a clean project/profile with original cloud layers and original photo paths only, retaining frame metadata. Keep all caches/temp inside this worktree.
- [x] Prepare comparison code using geometric assignment independent of IDs; output unmatched/extra equipment and per-pair centre/size/bearing differences, bounds, source frame and GLB validation.

## Corrective iteration: source-only supports and provenance

The first actual desktop run completed local measurement and assembly with AI deliberately declined. Its valid GLB retained the source frame, but lacked measured mount pipes/platforms and therefore associated hardware. This diagnostic is not the final fidelity result.

- [x] Add bounded upright circular-support and horizontal platform-outline fits from source points, with synthetic positive/negative, frame and partial-support tests. Assign only unique geometry-supported device parents. Advance Python freshness/checkpoints to `components/6`.
- [x] Preserve parent links for unknown boxes without guessing hardware. Allow photo-classified devices to use existing inferred hardware rules; explicitly mark attachment positions inferred.
- [x] Correct generated crop consent grouping and labels: cloud crops belong to scan views, and cannot satisfy original-photo classification evidence.
- [ ] Independently review the support/hardware changes, run focused checks and repeat the fresh desktop flow from original sources. Keep the frozen reference evaluator-only.

The corrected fresh desktop run, focused Python checks and GLB validation have passed. Independent clamp provenance review completed; the support fitter's final independent review was interrupted by reviewer availability and remains outstanding. The cloud overlay and review screenshots are private artifacts. The approved photo continuation completed through the production run controller and provider in the background, at the user's request to leave desktop input free. It retains missing and unclassified equipment and does not establish reference parity.

## Task 4: Fresh run, review and proof

- [x] Build the isolated desktop, run local source measurement from the clean inputs, and inspect detected records before AI use. The corrected fresh run completed; its approved AI continuation ran in the background after the user requested no desktop input.
- [x] Produce a concrete evidence preview if cloud interpretation is required, obtain the per-run input/budget approval, and preserve cumulative accounting.
- [x] Generate/check the drawing-free GLB through app code. Compare with the frozen baseline and cloud; fix supported defects and rerun relevant tests. Missing component recall, unresolved classifications and obscured hardware remain disclosed limits.
- [x] Capture genuine native model/review and same-camera baseline/new-model comparisons, including selective parts and labels on/off. Publish private local proof with clear measured/inferred/missing findings. Native captures show the fresh local stage; the final photo continuation is shown in the interactive comparison and is not misrepresented as another native UI run.
- [x] Send UI Fix the final status/head through the existing acknowledgment channel. No merge readiness claim unless all required work is actually complete. Final status explicitly records remaining recall/fidelity gaps and outstanding independent support review.

## Source-only platform and mount correction

- [x] Separate nearby horizontal surface layers before fitting deck envelopes; retain observed upper surfaces and flag possible undersides rather than duplicating physical platforms. Preserve the bounded contour and edge-support checks.
- [x] Correct the close-mount bridge span threshold to compare with observable free space, retaining the existing support, pose and ambiguity checks.
- [x] Advance measurement freshness to `components/7`; old support measurements require recomputation.
- [ ] Equipment recall remains pending the shared detector owner's grouping fix. Denser and multiscale source-only diagnostics did not establish a reliable inventory improvement; no unsupported equipment was added.

The correction is verified by focused regressions and private source replay. Updated artifact comparison remains background-only; no native desktop input or integration operations are performed.
