---
type: session
date: 2026-10-22-0703
branch: docs/ai-corrections-design
status: complete
related:
  [
    ../superpowers/specs/2026-10-22-antenna-manual-flagging-design.md,
    ../superpowers/specs/2026-10-22-engineering-model-typed-corrections-design.md,
    ../superpowers/specs/2026-10-17-telecom-antenna-detection-design.md,
    2026-10-17-model-correction-review.md,
  ]
---

# AI corrections design: flag missed antennas, type model fixes

## What changed

- This PR adds two design specs from a brainstorming session with the founder, with a builder check applied ("Decisions after review" in each).
- Antenna manual flagging: draw an outline on the 3D point cloud to add an antenna the detector missed, measured by the existing telecom code and kept across re-runs; fix a wrong one by redrawing its outline or typing values. No dragging boxes in 3D.
- Engineering model typed corrections: one "tell the AI what is wrong" box with an optional part or pin; Send turns on with text; blockers shown before the click; the Before/After review stays.
- Root cause of Send to AI staying greyed out: a request must be saved first, "Add something" needs a pin, and pins are refused on provisional-scale models, which is the normal state of a fresh model. Answered requests cannot be resent without Save reply, a stuck busy flag can lock the panel, and no e2e drives the panel on a real model.

## Why

The founder hit both in use: no way to add a missed antenna, and no way to get a correction to the AI.

## How to test

No user-facing behaviour to test; design docs only.

## Open threads

- Founder: read both specs and overturn any "our call" before planning.
- Both specs carry a contract change (antenna `origin` and optional measured values; a model-wide correction target); rows in `docs/architecture/contract-changes.md` at build time.

## Next session entry point

Once the founder has read the specs, write a plan for each; they are independent and can be built in parallel.
