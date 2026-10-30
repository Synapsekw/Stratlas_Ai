---
type: session
date: 2026-10-30-1914
branch: chore/analytics-pack-budget
status: complete
related: [plans/2026-10-30-ui-revision.md]
---

# Engineering review of the back end, and a larger Analytics pack budget

## What changed

- A read-only review of `main` at `d13e6a6b9` covered the main process and IPC, jobs and the Python pipeline, structure and the data layer, build and CI, and the 3D runtime. It scored 27/40 and is a private report artifact the founder holds. No source files changed.
- The scope was split with the UI revision session: that session owns layout, CSS, components, accessibility and copy, and splits `en.ts` as its W0. The AI study session owns the agent, vision and detectors.
- In this PR: the Analytics pack budget goes from 7 GB to 8.5 GB archived and from 8 GB to 9.5 GB unpacked (founder, 30 Oct). Pack 0.2.0 sat within 2% of the old archive limit. The budget comment no longer names a model.

## Why

The founder asked for the back end to be polished alongside the UI revision. Pack 0.2.0's model swap left 114 MB of headroom, so the next model change would have failed the release gate.

## How to test

No user-facing behaviour to test. `tools/release/budgets.test.mjs` covers the new budget.

## Open threads

- P0: the nightly `soak.spec.ts:113` has been red since 21 Oct. Renderer heap grows from about 125 MB to about 215 MB over 200 open cycles; bisect from 18 Oct. Snapshot evidence about the always-mounted overlays goes to the UI revision session.
- Client and site names remain in e2e specs and Python code, and the public-text checker does not scan code. The founder accepts a history rewrite or a fresh repository. It needs every open branch landed first.
- Pull-request CI is red about 30% of the time. A failure ledger and a quarantine shard are needed, and the pytest "rest" job is the critical path at 23 to 31 min.
- The founder has not yet decided whether to minify the renderer (with hidden source maps). The installer has 4.5 MB of headroom.
- Waves 2 and 3, which build on performance batch B, are listed in the North Star.

## Next session entry point

Start with the soak leak: take heap snapshots across open cycles and bisect the commits from 18 to 21 Oct.
