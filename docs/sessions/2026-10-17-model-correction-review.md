# Model correction review

Implemented a correction loop for generated engineering models. Reviewers can select a component or pin a real model/cloud surface, save a discrepancy with prepared evidence, and submit it to the AI agent. A proposal is shown as a same-camera Before/After comparison. Only the reviewer can accept it. Rejections, replies and requests persist with the modelling run.

Part requests change only the selected component. Location requests add components within the chosen radius. Model fingerprints reject stale proposals; acceptance retains the coordinate frame, scale and unaffected component records. Geometry-dependent validation results are cleared for a fresh check. Scoped correction tools expose only submitted requests and their attached evidence, subject to source permissions.

## How to test

1. Open an editable engineering run, choose **Review model**, then **Corrections**. Select a component in the scene or list. Alternatively, choose **Location pin**, show the source cloud, and click its surface.
2. Describe the discrepancy, attach relevant prepared evidence, and choose **Save request**. Choose **Send to AI** and review its send preview. Saving alone does not transmit data.
3. Select the proposed request and switch **Before** and **After**. The changed geometry is highlighted while the camera stays fixed. Acceptance is available only after the current proposal has rendered in After.
4. Choose **Accept correction**, or **Reject correction** and save a reply for a new proposal. Reopen the run to confirm requests and accepted geometry persist.

## Validation and limits

- All 124 focused tests across ten files passed. Coverage includes correction schemas, bounded geometry patches, scene transforms, pin picking, UI actions, scoped tools, persistence rollback and AI route selection. The 16 panel tests passed again after the final compatibility adjustment; desktop typechecking and production build also passed.
- A private manual browser benchmark exercised part selection, a source-cloud pin, Before/After, rejection, reply, re-proposal, two acceptances and reload. The exported result retained 149 individually selectable components, all 147 unrelated assemblies, and its original georeference and scale. GLB validation reported zero errors and warnings.
- The benchmark deliberately introduced two known discrepancies and used scripted local tool replies through the production correction handlers. It validates the correction mechanism, not fresh live AI interpretation. No paid AI request was made.
- This workflow requires the generated parametric model and component records; it does not directly repair an arbitrary imported GLB. Accepting a correction is a review decision, not a survey measurement.
- Native end-to-end automation was deferred under the concurrent UI session's machine-load constraint. Manual proof uses the production panel, scene and correction transactions in an isolated browser harness.
- The self-contained panel uses a temporary UI compatibility boundary on this older worktree. Integration into the shared right-sidebar workbench remains coordinated with its owner. No merge, rebase or push was performed.
