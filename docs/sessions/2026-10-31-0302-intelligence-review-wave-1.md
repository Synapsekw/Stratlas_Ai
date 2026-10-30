---
type: session
date: 2026-10-31-0302
branch: docs/intelligence-review
status: complete
related:
  [
    plans/2026-10-30-intelligence-review.md,
    design/intelligence-review-2026-10/README.md,
    sessions/2026-10-30-1500-detector-bench.md,
    sessions/2026-10-30-1930-detector-candidates.md,
    sessions/2026-10-30-2002-agent-brain.md,
    sessions/2026-10-30-1935-agent-evals.md,
    sessions/2026-10-30-1945-auto-qa-after-date.md,
  ]
---

# Platform intelligence review, and its Wave 1 built

## What changed

- This PR adds the review: four studies (agent, vision, insight, outside research) in `design/intelligence-review-2026-10/`, graded agent C, vision D+, insight C, learning F. It also adds the three-wave roadmap with its execution DAG and the founder's decisions in `plans/2026-10-30-intelligence-review.md`. The review was coordinated with the UI revision and the engineering review so that no area was covered twice.
- Founder decisions (30 Oct): thinking and caching on by default; automatic QA and change compute after a new date, on by default; the corrosion re-tune waits for the asset inspection focus; a local read-only MCP server where it adds value; all of Wave 1 in parallel. The founder left model delivery to the session: download on demand from the Models and detection page, with a Choose file fallback.
- Wave 1 was built as five branches, each with an independent review and a narrow re-review. Four are on local `main`: `feat/detector-bench` (E2), `fix/detector-candidates` (V1, pipeline pack 0.28.0), `feat/agent-brain` (A1) and `test/agent-evals` (E1). `feat/auto-qa-after-date` (I1) is in its final check and lands next. Each branch carries its own note.
- Decisions made on the founder's behalf:
  - Prompt caching stays on whatever the switch says; the switch ("Agent thinking") only turns thinking off.
  - Results from local-model steps, or from steps with an unknown provider, go to the cloud only as their summary (AI-6).
  - The automatic QA run uses no checkpoints, because processing GCPs are not independent checks.
  - `objectSizeM` gets its editor with the Models and detection page.
  - A fast hand-over route for clean rebases, agreed with the coordinator.

## Why

The founder asked for a study of how intelligent the platform is and how to improve it, then for Wave 1 to be built at once and finished without further questions.

## How to test

Each build's steps are in its own note. In short:

1. Settings > AI providers shows "Agent thinking", switched on.
2. In a tagged project, ask the agent "Which tanks are there?", then "Fly to the second one". It flies there, and the follow-up still works after a restart.
3. Settings > Processing tools shows "Check a new survey date when its surface is ready". A fresh quarry demo then gets a QA run and change sets for each later date without a click.
4. With pipeline pack 0.28.0, a detector run caps each photo at 30 candidates.

## Open threads

- I1 landing, then the combined before/after report section for the UI revision's artifact.
- A first real-model eval baseline: `QUADRION_EVAL_PROFILE=anthropic`, K=3. The A1 gap tags should show "GAP CLOSED".
- The first corrosion reference waits for reviewed truth.

## Next session entry point

Wave 2 of `plans/2026-10-30-intelligence-review.md`: A2 action registry bridge and read tools, V2 learning loop, I2 site digest and forecast, V3 multi-view vote and thermal hot spots.
