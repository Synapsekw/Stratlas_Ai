# Coordination with Claude: UI Fix

The user requires coordination with the Claude session **UI Fix / d-ba** before any merge. On 17 October, Claude CLI ListAgents confirmed d-ba is running and SendMessage delivered the coordination message (message e506ac5d-5764-4a79-bfe1-244260e320da). Delivery and acknowledgement are confirmed. Claude recorded its integration constraints in `.superpowers/ui-fix-ack.md`: its UI branches land first, engineering review becomes a sidebar workbench tab after Stage 2, and the merge lock remains held. **No merge is authorized: the user explicitly requires all work to stay in this worktree and main to remain untouched.**

Branch: `codex/engineering-fidelity`

Worktree: `C:/Users/D/.codex/worktrees/engineering-fidelity/AIO Software`

Base: `c206618f8c2dd14d427860e6e5d5c136f75248ff`. Main has moved since then; do not cherry-pick blindly or overwrite current UI work. No merge, push, or main-checkout edits have been performed by this task.

## Interface changes to coordinate

- `apps/desktop/src/renderer/engineer/SetupDialog.tsx` and `engineer.css`: three steps, Sources → Options → Check and start. Adds DXF and calibrated camera input selection and an explicit run budget.
- `EvidencePreview.tsx`: approve the selected inputs and spending limit once per run. Changed source data, model/provider, or budget requires new approval.
- `EngineerLayer.tsx`, `EngineeringReview.tsx`, `review.ts`, `ui.ts`: automatically open the generated model beside its component inspector. Model / Cloud / Overlay, fit view, readiness/error/retry states. Add to project is available inside the actual visible review only.
- `runStore.ts` and `host.ts`: refresh the manifest after draft/accepted builds; guard stale project/run requests; retain the measured coordinate frame and scoped approval across passes.
- `apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx`: dock the engineering review in the right inspector so it cannot cover the model or agent controls.
- `packages/modelling/src/ComponentTree.tsx`: keep a scene-selected part visible and scroll it into the list, even when search would exclude it.
- `packages/ui/src/i18n/en.ts`: engineering workflow labels. Preserve UI Fix's wider language/layout changes when reconciling.
- Shared schema contracts and IPC have additive observation, coordinate-frame, source-stamp, run-approval and measurement-tool fields. Processing tools require the new pack version.

## Integration agreement

UI Fix identified WorkspaceScreen as high overlap; engineering lands after its Stage 2/3 work. Coordinate the rebase/conflict review when that interface is ready. Additional shared changes are the narrow inspector label fix in workspace/components.css and review display in packages/modelling/ComponentsSection.tsx and ComponentCard.tsx. Keep the application design system and UI Fix's screen work. Preserve the engineering behavior above, particularly showing the loaded model before acceptance and preserving the cloud transform. Re-run the engineering flow, component inspection and georeference E2E suites after integration.

This branch is still undergoing benchmark and final validation; it is not ready to merge merely because this note exists.

## Detail refinement update

The renewed message `a2be824f-1a18-44d5-bc8f-297a10a57965` reached live d-ba. Its acknowledgement
in `.superpowers/ui-fix-update-ack.md` confirms no integration of this branch, no geometry/schema
overlap, and continued self-contained engineering UI. Main advanced to `cd6941b3`; UI Fix's
suggestion to rebase is deferred under the user's worktree-only instruction. Stages 2/3 and other
queued UI work precede engineering integration, which requires renewed coordination. No main
edits, merge, push or rebase are part of this continuation.

The detail continuation also touches only the component inspector contracts: `assemblyEdit.ts`,
`ComponentCard.tsx`, and `en.ts` labels. Clamps identify themselves correctly; fitted roof heights
are read-only project-Y values; unused rung-spacing/cage and picket-rail controls are hidden.
These remain self-contained and do not alter workbench or workspace chrome.
Coverage wording now describes the sampled region; face occupancy never implies all-sided visibility.

Final narrow-inspector notice delivered to d-ba as `5979d44b-8da9-46de-81af-f9169607b7b7`.
It repeats the no-integration instruction and names the exact component-field files above.
