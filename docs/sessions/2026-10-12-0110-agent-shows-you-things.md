---
type: session
date: 2026-10-12-0110
branch: feat/ai-agent
status: complete
related:
  - docs/plans/2026-10-11-ai-agent-design.md
  - docs/plans/2026-10-11-ai-agent.md
  - docs/guide/07-ai-agent.md
---

# The agent can show you things: one conversation on every project screen

## What changed

- The agent keeps one conversation on every screen of an open project. On Scene it is where it was; on Issues, Media, Detections and Reports it is a folding column (an **Agent** button in the title bar, **Ctrl Alt B**), folded until asked for.
- Five new steps, all view changes with **Undo**: show a finding (select, fly, photo beside 3D), open Media filtered, open Issues filtered, open a screen, list assets with their findings. The agent now knows which findings sit on which tagged asset and area, the project's severity names, the screen and the filters that are on.
- Media has a **Severity** filter for everyone; the Issues filters now stay while a project is open. A filter the agent sets shows as a chip with an x.
- Tests: `agent-show.spec.ts` (11 tests, scripted model, the demo tank farm) and `agent-eval.spec.ts` (20 plain requests against a real model, opt-in, never in CI, not run yet).
- The guide's list of what is sent with a message was wrong before this work (it said no positions) and is now exact. The words typed into the Issues search are not sent.
- 27 commits on `feat/ai-agent`, handed to the Orchestrator. No contract change.

## Why

The founder tried the agent that already shipped and two requests failed: "take me to the most severe point on this asset" and "open up images with the highest level of severity". The agent had no way to open a screen or set a filter, lost its conversation on leaving Scene, and could not tie a finding to an asset.

## How to test

1. **Settings**, **AI providers**: a key is saved; **Privacy and cloud**: **Cloud AI** is on. Open the demo tank farm.
2. On **Scene**, with nothing selected, type "Take me to the most severe point on this asset". Finding F04 is selected, the 3D view flies to it and its photo opens beside the 3D view. The answer names it Severe and names its asset.
3. Type "Open up images with the highest level of severity". **Media** opens with **Severity** on Severe and one photo, and the conversation is still there in the column on the right. Choose **Any** to clear the level.
4. Type "Show me the findings in the Tank T-101 area". **Issues** opens with a chip "On Tank T-101"; its x clears it. Press **Undo** on a step: the screen and filters go back.
5. On **Issues**, press **Ctrl Alt B** twice: the column folds and unfolds. Go to **Settings** and back: the conversation is kept.
6. Optional, costs about one to two US dollars: the real-model check, run as its header in `apps/desktop/e2e/agent-eval.spec.ts` says.

## Open threads

- The two requests are verified on the scripted model only. The first real-model run is the founder's; a result under nine in ten is a finding about the prompt or the tools, not a broken build.
- Known limits are listed at the end of the design: several severity models in one project, a model that takes over a minute to load, tight room beside the open column at the smallest window.
- Not run locally: the survey, package, report and real-data specs outside the agent's area. CI runs them.

## Next session entry point

After the merge, the roadmap in the design ranks what the agent could do next; "Walk me through" (guided tours) reuses nearly all of this work and comes first.
