---
type: session
date: 2026-10-31-0454
branch: docs/wrapup-ui-revision-batch-a
status: complete
related: [../plans/2026-10-30-ui-revision.md]
---

# UI revision Batch A landed

## What changed

- W0 (`cb12bf3c9`) split `en.ts` by area first, then W1a polish (`563195b04`), W1b (`a9adde2e4`), W1c (`ee13d2b2f`), W2 AI status chip (`b904e8b26`), W3 `@aio/ui` primitives (`7f1c54591`), W5 palette tools (`adb36dc1b`), W6 Settings by topic (`8bcc3cb9e`) and W4 layout spike behind Ctrl+Alt+L (`8b7b513cd`) landed on local `main`, not yet pushed.
- Test fixes: `2f52333fa` drops the frozen i18n catalogue hash, `1a5e9d758` makes the public text check skip binaries, `e3bfd50c7` requires all four survey demos' files before the e2e cache is reused.
- Each branch had an independent review before hand-over; e2e ran the CI way.
- Report links: UI review https://claude.ai/artifact/5QLEhQNCADsgRkZWHRDvCb, before/after report (in progress) https://claude.ai/artifact/BPxgtdNDdeMcsEjNfv6cRk.

## Why

The UI review named `en.ts` the top conflict hotspot, so the split went first. Decisions: AI states are ready, local, no-key, offline, project-off and cloud-off (neutral "AI off") because a cloud switch that is off is not a missing key. The "Agent" accessible name waits for W20 (about 10 specs use it). The map notice gets an icon dismiss, per session; the map stays north-up. The split test lost its frozen count and hash. Key changes reach the chip through a bridge hook, not W6's files. G1 stays with the founder, since mock-ups are approved in the real UI before build.

## How to test

1. Open the demo tank farm at 1280 x 800: no "Create maps from photos" in the sidebar; the Create maps offer sits where the switcher and library now show it, with the new names.
2. The AI chip reads "AI off: no key" without a key and opens AI providers; with the cloud switch off it reads a neutral "AI off".
3. Press Ctrl+K, type "measure": tools, tabs and Settings pages are listed.
4. Open Settings: the new topic pages (Project settings, Models and detection, Datums) appear.
5. Dismiss the map pack note with its icon; it stays gone for the session.
6. On the Globe, zoom out: clusters show one chip anchored left, and issue pins hide while gathered.
7. In `pnpm dev` on Demo tank farm press Ctrl+Alt+L: rail, title bar, Layers column, four tabs, docked video tile, preset picker; resize to 1440, 1280, 1100 px; press it again to leave.

## Open threads

- Compare at 1100 px clips the resting island (`--isl-aside-w`); faint grid without a map pack; no corridor rotation; no guide shots for the new Settings pages.
- G1: the founder's verdict on the spike. Full list in the plan under "Follow-ups found in Batch A".

## Next session entry point

Wave 2 (W7 onward) once the founder gives the G1 verdict; W1d, W14, W15b, W16 and W17 can start now.
