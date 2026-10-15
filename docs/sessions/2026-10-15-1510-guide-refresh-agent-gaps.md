---
type: session
date: 2026-10-15-1510
branch: docs/guide-refresh, docs/wrapup-guide-refresh
status: complete
related: [../plans/2026-10-15-agent-coverage-gaps.md, ../guide/07-ai-agent.md]
---

# User guide refresh and agent coverage gaps

## What changed

- **#136** (`docs/guide-refresh`, main `2d514e90`): ten guide chapters brought up to date with main. Chapter 07 now lists what the agent can do in four groups (move the camera, show me, find and summarise, changes that need approval) with example requests; maps and the Globe describe the shared Map menu and online maps; the scene covers dataset delete, far-data placing and date lanes; survey dates covers Compare, Delete and File under. Six `<!-- screenshot: ... -->` markers wait for a screenshot pass. Chapters 05 and 08, photo processing and the project library were left to the branches rewriting them.
- `docs/plans/2026-10-15-agent-coverage-gaps.md`: 165 user actions mapped to the 48 agent tools (46 covered, 27 partial, 92 gaps, about 20 of them deliberately out of reach). The in-app agent needs no MCP: it is a typed tool registry in `packages/ai`; MCP would only matter for driving the app from an outside client.

## Why

The founder wants the built-in agent to do anything a user can ("show me the most severe photos", "fly me to the worst area"), and the guide had fallen behind the app.

## How to test

Nothing in the app changed. Open the in-app guide, chapter "AI agent", and try a few of its example requests in the agent panel.

## Open threads

- Founder examples: "most severe photos" works (`show_photos {severity:"highest"}`); "most affected location of this asset" and "fly me to the worst area" are partial (no tool ranks places by severity and count, and none works without tagged assets).
- Top gaps: `rank_locations`, survey dates as tool input, editing findings in bulk, detections, reports and other exports. Library organising and the ODM engine card have no agent tools.
- App fixes: Map sources has no help mapping (`help/store.ts`); Settings > Keyboard lacks the dataset row-marking keys.
- Guide final pass: photo processing (ODM) and project library sections, then the screenshots.

## Next session entry point

`rank_locations` via `/develop`, or the guide final pass with screenshots (off-screen, CI window size).
