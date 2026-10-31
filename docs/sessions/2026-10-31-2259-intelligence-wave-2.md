---
type: session
date: 2026-10-31-2259
branch: docs/intelligence-wave-2
status: complete
related:
  [
    plans/2026-10-30-intelligence-review.md,
    sessions/2026-10-31-0302-intelligence-review-wave-1.md,
    sessions/2026-10-31-1559-agent-actions.md,
    sessions/2026-10-31-1546-detector-learning.md,
    sessions/2026-10-31-1550-site-digest.md,
    sessions/2026-10-31-1555-multiview-thermal.md,
  ]
---

# Intelligence review Wave 2 built and landed

## What changed

- This PR records Wave 2 of `plans/2026-10-30-intelligence-review.md`. Four branches were built in parallel, each went through an independent review and a re-review, and all four are on local `main`. Each carries its own note.
  - `feat/agent-actions` (A2): the agent runs the right-click actions through `list_actions` and `run_action`, guarded by a parity test. It also gets ten tools for surveys, volumes, detections, jobs, thermal and walks.
  - `feat/site-digest` (I2): a rules-based site digest at the top of the Project tab, a volume trend and forecast with a Python twin, and QA flags derived at read time.
  - `feat/multiview-thermal` (V3, pipeline pack 0.32.0): one draft per object seen from several photos, and a thermal hot-spot finder.
  - `feat/detector-learning` (V2, pipeline pack 0.33.0): few-shot example crops from reviews, a suggested threshold with apply and reset, and a "Learn from my reviews" switch.
- Pack numbers 0.29.0 and 0.30.0 were reserved and stay unused.
- Decisions made on the founder's behalf:
  - Example crops are on by default, with a switch per detector.
  - Example crops go only to pipeline pack 0.33.0 and later. `DETECT_MIN_PACK` stays 0.28.0.
  - The threshold suggestion is calibrated on runs like the next one.
  - QA flags are never stored, so I2 has no contract change.
  - The forecast counts from today.
  - The vote counts only the photos a run looked at. A ray whose depth is only guessed never merges.
  - When the agent's target is ambiguous it refuses and lists the candidates. Deletes wait for the person's confirmation.
  - The site digest moves into W7's `project.digest` section. aio-software-16 owns that move.

## Why

The founder gave the Wave 2 go on 31 Oct and asked for it to be finished autonomously.

## How to test

Each branch note has its full steps. In short:

1. In a project with two dates, ask the agent "Bring the earliest survey into view", then "Hide all layers". The view and the layers change, and Undo on the step works.
2. Open the change demo. The Project tab starts with SITE DIGEST, and Save stays at "All saved".
3. With pipeline pack 0.32.0 or later, press "Find hot spots" on the thermal bench. Hot spots appear as drafts in Inspect, and a detector run over several photos shows "Seen in N photos".
4. With pipeline pack 0.33.0, review 20 detections. Settings > Models and detection > Detector library offers "Apply suggested threshold".

## Open threads

- No real-model run yet. A first `QUADRION_EVAL_PROFILE=anthropic` baseline should close the A1 and A2 gap tags.
- The vote has only been benched on synthetic data with exact poses. Check it on a real posed project.
- Follow-up nits are in each branch note.

## Next session entry point

Wave 3 of `plans/2026-10-30-intelligence-review.md`, after a founder go: M1 fact index, M2 tracks across dates, A3 offline agent, V4 360 detections, N1 new models, X1 local MCP.
