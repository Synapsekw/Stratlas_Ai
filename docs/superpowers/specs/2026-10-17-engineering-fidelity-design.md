# Engineering model fidelity and visible review

## Intent and decisions

The user authorized implementing the measured modelling approach demonstrated on the private benchmark, including individually selectable parts, matching the source point cloud's position, orientation and height, and an intuitive start and review experience. They chose one approval of the permitted inputs and spending limit per run, followed by model review. This is one connected workflow across local measurement, AI interpretation, procedural geometry and the desktop viewport.

Keep the existing Electron/React/TypeScript/Python architecture and Mission visual system. The user already approved implementation of the preceding pipeline recommendations; this document makes those decisions concrete rather than requesting that authorization again. Implementation details and numerical acceptance tolerances below are engineering choices, not quotations of user requirements.

## What success means

- An ordinary run from the benchmark's original cloud, photos and DXF produces the model. Importing the hand-built reference or its fitted component JSON does not count as generation.
- Antennas, radios, mounting pipes, structural supports, platforms, cables and compound equipment are independent selectable components with stable IDs and evidence provenance.
- Placement derives from the source coordinate frame. No auto-centering, guessed north, fitting the camera independently for each comparison, or applying the cloud height offset twice.
- Review opens with the generated model visible and framed. Selection works both from the model and the component list; evidence explains each selected component.
- The user approves the inputs/provider/budget once. Work then proceeds within that authorization and reports concrete progress. Approval of the model is a separate decision.
- Improvements are reusable for other assets. No site names, magic sheet coordinates, per-site geometry, private source data or credentials are embedded in production code.

The reference model contains inferred cable routes, backs and small hardware. Matching its appearance is a visual benchmark, not proof of surveyed geometry. Unobserved details remain labelled inferred. Other families retain their existing workflows; detailed telecom modelling is the first fidelity acceptance case.

## Sources and coordinate contract

Use cloud coordinates as spatial authority, calibrated original photos for identity/appearance/occluded observations, and DXF dimensions and plan/elevation entities as measured drawing evidence. Conflicts remain explicit. Do not silently resize an already metric cloud to a rounded user estimate of 31 m.

Setup offers cloud/model/photo sources plus DXF files and optional calibrated camera-pose XML. Photos can be a project set or chosen originals. Inventory all 560 benchmark photos, then select bounded, diverse views; report counts rather than silently dropping everything after 400. Changes in selected sources invalidate dependent evidence and approval.

Maintain a single source-frame record: CRS, project origin, each cloud's effective transform and height offset, model origin, units and mapping to x-east/y-up/z-south. Source offset is applied exactly once before local measurement. Drawing registration has its own matrix and residuals. Drawing plan heading, true north and grid north are distinct; only an explicit conversion changes them. Store source signatures and frame signatures with the run. A later project-origin change re-expresses placement without changing the physical asset.

The benchmark's CRS, height offset, ground anchor and measured dimensions belong only to its private external configuration, never production defaults or public documentation. Validation compares the source and model in that shared adjusted height frame. The full cloud extent includes surroundings and is not tower height.

## Measurement and modelling architecture

1. **Inspect locally.** Read source inventory, units, bounds, calibration and DXF entities. Detect incompatible frames, missing files and ambiguous scale before paid requests. Keep existing cancellation and resumable stages.
2. **Build an evidence inventory.** Retain every plausible component candidate with ID, kind hypotheses, position, orientation, dimensions, supporting points, residual/coverage, source references and per-field provenance. Distinguish an antenna face normal from its radial bearing around the mast. Store shaft cross-section centres as well as radii, retaining taper and observed lean.
3. **Interpret the drawing.** Reuse the local DXF reader to expose bounded entity/text/dimension inventories and rendered views. Identify plan/elevation/schedule groups by entities and labels, not fixed sheet rectangles. Explicit associations connect schedule IDs, plan footprints, elevation levels and mounting pipes. Uncertain associations are review items. Register the plan using multiple matched anchors and reject ambiguous/reflected/ill-conditioned fits. Do not treat arbitrary drawing text as instructions.
4. **Fit locally.** Component observations seed plane/cylinder/oriented-box and level fits against local cloud crops. Robust fitting rejects clutter; accepted fits carry residual, support and visible-face coverage. A fit cannot claim a hidden depth was measured. Separate crowded devices using drawing/photo identity and individual crops instead of merging an entire crown into one connected cluster. Retain measured platforms for monopoles.
5. **Bounded AI interpretation.** The model chooses component types, associations, evidence queries and corrections. It may request a crop, a candidate fit, a drawing view or a comparison through allowlisted local tools. The host executes and validates those tools; no arbitrary code or filesystem access is exposed. Refer to measured candidate IDs rather than asking the model to invent exact coordinates. Return a validated per-component proposal, retaining the existing group format as a compatibility fallback.
6. **Build deterministic geometry.** Feed measured pose and width/height/depth directly into reusable builders. Add rounded radomes, radio fins/ports, shared mounting tubes and clamps, open grating, support frames and cable bundles at bounded detail. Compound equipment uses observed positions and dimensions. Decorative detail remains inferred. Do not move measured platforms merely because their height overlaps antennas; test actual spatial clearance.
7. **Compare and refine.** Render source and draft in the same frame, camera and scale. Assess major components individually: pose/dimensions, point-to-surface residual, observed support, missing/duplicate components and selected multi-view comparisons. Keep file validity separate from geometric fit. A richer-looking mesh or global silhouette alone cannot establish fidelity. Refinement targets unresolved components and keeps the best verified result, preserving user edits and accepted components.

The component record is the bridge between local fitting, AI proposals, builders and review. Extend existing schema contracts with optional versioned measurement records and source associations so old saved runs still load. Cache keys include algorithm/schema versions and source/frame signatures, preventing stale checkpoints from appearing current.

## Run authorization

Replace repetitive send dialogs with an explicit run approval showing selected source sets and their counts, permitted data categories (photos, scan views, drawings), provider/model, maximum spend, pass/time/tool limits and examples of the evidence to be sent. Original files remain local; sanitized crops, views and bounded summaries are eligible. Show that later passes may choose other images from the approved source inventory, so the first batch is not presented as the entire authorization.

Persist authorization against run ID, provider/model, source/content signatures, allowed categories and budget in the host. Every actual request checks it in the main process, along with existing offline and project policies. Never turn run approval into blanket project permission. If inputs, route, categories or limits expand, pause for a revised approval. Budget and usage persist across restart. Unknown pricing cannot promise a dollar cap; require an explicitly confirmed bounded request/token budget and label the dollar estimate unavailable. Cancellation revokes ongoing execution, not the saved model.

## Desktop interaction

The physical scene is an engineer at a desktop comparing a surveyed asset with a reconstructed model, needing a large unobstructed 3D view and readable evidence. Use the existing dark-first Mission tokens and locally bundled fonts; preserve theme/accessibility settings.

### Sources

Use a compact guided setup with three steps: Sources, Modelling options, Review inputs. Show a summary of selected scans, drawings and original photos, with source problems beside the affected row. Place family/scope/detail together. Keep manual placement and known dimensions under advanced options; default to matching the selected point cloud. Show the current height offset and coordinate source read-only. A single primary action, **Analyse sources**, starts local work. No competing Preview and Start buttons that initiate indistinguishable paths.

### Analyse and build

Show local inspection progress and then the run-approval screen. After approval, keep the scene visible with a compact progress panel: current action, components found, pass and spend/limit, Cancel, and expandable details. If a draft exists, make it available immediately. Before a draft exists, clearly show the source cloud and say that model generation is still in progress. A data-sharing review must not be labelled model review.

### Review model

Explicitly refresh the workspace manifest after build/accept, ensure the correct generated layer is loaded, switch to the scene and frame its bounds when entering review. Wait for layer readiness before focusing; show loading or a recoverable error if the file cannot be drawn. Never display a successful model-review state for a nonexistent or failed layer.

Keep the component tree and selected component inspector docked beside the viewport. Hide unrelated general-builder controls while reviewing an engineering run. Provide **Model / Point cloud / Overlay**, **Fit model**, and useful full/head/base views where available. Preserve the shared camera across view toggles. Model-only is the first review view so dense points cannot obscure the generated result; Overlay is one click away.

Clicking a component in either place highlights the same ID, reveals its row and shows its dimensions, orientation, measured/observed/inferred fields, fit evidence, and source thumbnails that open large enough to inspect. Fit selected is explicit rather than flying the camera on every click. Selection after rebuild resolves stable IDs or explains removal. Unresolved/missing components are visible beside the model. Accepted/rejected/draft status remains separate from fit quality.

The primary action is **Add accepted parts to project**, with the accepted count and any unresolved issues visible. Export remains accepted parts only. Keep a separate **Accept all drafts** action so publication cannot silently accept unknown geometry. Close/reopen restores the run and review state. New run must not discard an unaccepted draft without a recoverable saved run.

## Benchmark and acceptance

Keep source files, intermediate crops, calibrated poses, reference GLB and visual reports outside Git. A configurable local benchmark command takes their paths; the repository contains only code, synthetic cases and non-sensitive assertions. Pin source fingerprints and reference GLB hash in the local report.

Acceptance has independent gates:

1. **Regeneration:** run the shipping application path from sources without consuming reference fit/mesh files. Record versions, actual provider/model, selected inputs, tool actions and cost. Replay saved proposals for deterministic regression, and run at least one live authorized generation to establish the actual AI integration.
2. **Placement:** apply production import/placement code at two different project origins. Source and model control points agree within 0.02 m; repeated import/reopen does not reapply offsets. Synthetic cases exercise nonzero heading, differing origins, positive/negative offsets and scale mistakes. Benchmark ground-to-tip differs from observed cloud by at most 0.10 m, with base/tip/shaft-top reported separately.
3. **Components:** match the reference's major observed inventory (12 panel antennas, 18 radios, 14 mounting tubes, 2 platforms, equipment/compound categories) by spatial association and source identity; report differences explicitly. Exactly 201 nodes is not a target: hardware grouping can differ. Every exported mesh primitive must resolve through the app's actual picker to one valid component. IDs survive rebuild, acceptance and export/reimport.
4. **Fit and appearance:** fixed-frame full/head/base/top/reverse views plus source overlays. Evaluate observed panel faces and mounting axes against cloud support, reporting median/p95 and coverage; do not average inferred cables into an accuracy claim. Initial engineering targets for well-supported parts: centre discrepancy <=0.10 m, face orientation <=5 degrees, dimensions <=max(0.05 m, 5%). Mark low-coverage cases for review rather than fabricating a pass. Compare rendering detail to the reference visually before claiming equal fidelity.
5. **File and performance:** valid GLB, finite transforms/normals/indices, no orphan selection IDs, bounded triangle/file budgets, no accidental merging of selectable identities. Reuse materials/geometry where feasible; profile actual viewport loading rather than claiming a universal frame-rate target.
6. **Interaction:** Electron tests prove start/approval/progress/review/selection/overlay/accept/reopen, cancellation during a request, unknown-price handling, source change reapproval and error recovery. Capture actual review screens at 1440x900 and 1100x720; model remains visible with the panels open. Keyboard actions, focus and controls remain usable.

Do not claim the requested fidelity is achieved until the source-driven benchmark and visual review pass. If an input association cannot be automated reliably, expose a precise correction in the review workflow and report the intervention in the benchmark; never hide a manually supplied answer in production defaults.

## Delivery order

1. Reproduce and repair missing draft display, selection synchronisation and explicit review entry.
2. Establish source-frame, component-measurement and benchmark contracts.
3. Add source intake, drawing/camera evidence and local component fitting.
4. Wire bounded per-component interpretation and richer reusable builders.
5. Introduce run-scoped authorization and guided setup/review, preserving existing security and cancellation checks.
6. Run source-driven private benchmark validation, resolve fit/visual defects and finish the regression/interaction checks.

No deployment or merging is implied by the implementation request. Deliver tested changes and benchmark results for review, including unresolved limitations.
