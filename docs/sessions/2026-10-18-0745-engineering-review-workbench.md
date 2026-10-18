---
type: session
date: 2026-10-18-0745
branch: codex/engineering-fidelity
status: integration
related: [2026-10-17-model-correction-review.md, 2026-10-18-0255-stage-island-stages-2-3.md]
---

# Engineering review workbench integration

## What changed

- This PR integrates source-driven modelling and human correction review with the landed sidebar, telecom and RF interfaces. Model review is a workbench tab using shared UI parts and a single scroll surface.
- Review keeps selection, camera and source placement intact. Unsaved comments and pins survive tab changes; in-flight correction actions cannot be resubmitted on remount. Only one review controls comparison visibility during drawer transitions.
- A completed run opens a normal review tab, preserves other panels and waits behind an issue edit. Correction controls use shared translations and number formatting; the saved-measurement compatibility row is labelled explicitly.
- Pipeline pack 0.16.0 is required for new component runs and enhanced resumes. Saved legacy measurement compatibility remains 0.13.1; RF remains 0.15.0. The landed telecom detector is preserved.

## Why

The new workbench must keep the generated model visible and preserve reviewers' feedback while they inspect other evidence. Private benchmark inputs and reports remain outside Git.

## How to test

1. Open a saved engineering run, choose **Review model**, select a part and toggle model/cloud/overlay and labels. The model stays visible beside **Model review**.
2. In **Corrections**, type feedback or place a pin. Switch tabs and return; the draft remains. Send a saved request and check the agent is visible.
3. Compare **Before** and **After**, fold and unfold the sidebar, then accept or reject. Only one model comparison is drawn; reopening retains saved requests and the accepted geometry.

## Open threads

Full checks and CI-style desktop tests gate the handoff. No new live AI correction run was made during integration; existing source-only inventory and hidden-geometry limitations remain. The UI integration owner alone merges and pushes main after reviewing the green PR head.

## Next session entry point

Use the branch checks and the private coordination acknowledgement for the exact handoff head; retain the current main UI and the telecom/RF registration blocks.
