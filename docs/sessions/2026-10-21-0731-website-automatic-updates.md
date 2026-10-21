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
- Website 165 tests, build and public scan passed. Desktop `pnpm check` passed with four test workers: 1,222 test files and 13,180 tests passed, with 14 existing skips. Desktop build and all five CI-style Electron update scenarios passed at 1100x720, scale 1, WARP, with all demos built.
- Independent task and integration reviews passed after regression fixes for restart races, corrupt-stage retry and recovery, and case-insensitive published package extensions. The final test run retained the usual assertions and time limits; four workers avoided load-related timeouts seen in the earlier highly parallel run.
- The later manual-install correction leaves managed metadata untouched when this app has no managed selection. It passed independent review, 69 focused tests and TypeScript, followed by a fresh desktop build and all 12 processing-tools and update Electron scenarios. The existing runtime-directory assertion passes unchanged.

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
