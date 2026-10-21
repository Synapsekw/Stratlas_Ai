---
type: session
date: 2026-10-21-0731
branch: feat/website-auto-updates
status: in-review
related:
  [
    ../architecture/adr/0003-updates-and-rollback.md,
    ../release/website-updates.md,
    ../superpowers/specs/2026-10-21-website-auto-updates.md,
  ]
---

# Automatic website app and processing kit updates

## What changed

- This PR adds website account sign-in, automatic checks/background transfers, verified local staging and user-controlled Restart and update; offline-only and manual update workflows remain available.
- Managed kits stay outside legacy discovery and are selected by app version; the main-process work gate protects restart, and previous app/kit recovery is retained. Additive IPC/settings contracts are recorded.
- The website companion is [draft PR14](https://github.com/Synapsekw/Quadrion_Web_Site/pull/14), stacked on upload-fix PR13: authenticated compatible release selection, draft metadata editing, tar.gz uploads and database publication guards.
- Website165 tests/build/public scan passed; desktop focused unit tests and five CI-style Electron scenarios passed with all demos built. Final desktop repository checks and backend review are pending.

## Why

The founder approved automatic downloads for both components, followed by a restart chosen by the user. Staging must not change processing tools while work is running or make rollback discover a newer incompatible kit.

## How to test

1. In a supported installed build, open Settings, About and updates; sign in with an active website account and enable Automatic website updates.
2. Publish a verified compatible kit and app through the updated website. Check for website updates; both downloads should progress without restarting or changing active tools.
3. When Updates ready appears, reopen About. Restart and update should refuse while processing is active and work when idle. Offline-only must stop requests while a locally ready update remains usable.

## Open threads

- No installer was built and production was not migrated/deployed. Deploy the website migration/functions first, then distribute one bootstrap desktop build manually. Windows x64 installed NSIS is the initial automatic-install target; live signed-installer acceptance remains a release check.

## Next session entry point

Use the publishing guide and attached PRs for integration/deployment ordering. Keep these worktrees for review; the integration owner handles the main merge.
