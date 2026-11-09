---
type: session
date: 2026-11-09-1430
branch: docs/ui-glossary
status: complete
related: [docs/plans/2026-10-30-ui-revision.md, docs/design/glossary.md]
---

# UI revision W20: naming glossary and copy sweep, W21 closed

## What changed

- This PR adds `docs/design/glossary.md`, one name per idea, and sweeps 54 catalogue values to it: point cloud, cloud AI, Ask AI and Offline AI, No date (it holds the layers with no capture date), File by date and Leave for now, Toe surface, stage tools, depth shading and offline.
- The agent panel's region is now "Ask AI chat"; the specs that found it as "Agent" follow.
- Island tiles keep the short "3D point" and "3D box", with the full words in their tooltips; the glossary allows that.
- `glossary.test.ts` fails when a retired name comes back into the English catalogue.
- The tracker now marks W10 to W13, W15a and W19 landed, this PR handed over, W18 last in batch E and W21 closed with no code.

## W21: closed with no code

- The soak (200 open and close cycles) passes: renderer heap median 85.1 to 89.6 MB against a limit of 97.6 MB.
- The growth is V8 compiled code; the counts of stages, WebGL renderers, React fibres and detached DOM nodes stay flat. The earlier 85 MB leak was the video rig, already fixed.
- Startup parses 15.0 MB of JS (the index chunk is 7.0 MB). Mounting the overlays on first open would defer about 3 MB; that is unscheduled.

## How to test

1. Open any project and click the AI chip: the panel is "Ask AI", and Settings offers "Use Offline AI for everything".
2. Open the Dates strip: undated layers sit under "No date".
3. Hover the island's 3D point and 3D box tiles: the tooltips spell the tool out.
4. Search the palette for "point cloud": the cloud tools come up under that name.

## Open threads

- Hardcoded copy outside the i18n catalogue is not swept yet.
- The startup lazy-mount (about 3 MB of parse) is unscheduled.

## Next session entry point

W18 (token ratchet) lands last in batch E; then the founder tests batches D and E together before the one push.
