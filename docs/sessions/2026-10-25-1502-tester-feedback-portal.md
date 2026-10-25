---
type: session
date: 2026-10-25-1502
branch: feat/tester-feedback-portal
status: complete
related:
  [
    ../plans/2026-10-25-tester-feedback-portal-design.md,
    ../plans/2026-10-25-tester-feedback-portal.md,
  ]
---

# Tester feedback portal: tests behind the website login, one fix-and-retest loop

## What changed

- This PR (app side): `tools/test-board/build.mjs --json` writes the private test content as `dist/test-content.json` for the website upload, and `tools/test-board/export-artifact.mjs` turns an Artifact store export into per-tester results files. The app's existing "Report a problem" dialog gains **Send to Quadrion**, which opens `https://quadrion.ai/portal/report/?build=<version>&screen=<screen>` in the browser; nothing else leaves the app, no new IPC.
- Website branch `feat/tester-feedback` (in its own repo, pushed by the founder): five new Supabase migrations (feedback tables, test answers, items and owner actions, attachments, a private `quadrion-feedback` bucket), a tester endpoint, owner actions in the admin API, the tester pages (`/portal/tests/`: Waiting for you, My tests, My reports, Request a feature; `/portal/report/`), the owner pages (`/admin/feedback/`: inbox, priority, ask, park, decline, merge, mark fixed, Copy for AI, Copy message for testers, Progress, Test content upload and import) and a tester flag in Users. 261 website tests, including a whole-loop test through the real handlers on PGlite.
- Test content and tester names never enter either repo: they are uploaded from the private folder into the database. Notifications are in the portal only (founder: no email).

## Why

The founder wants the two testers' test runs and comments in one place behind the login, with an owner view to clear bugs faster: a failed test or a feature request goes fixed, then back to the tester to confirm, and open bugs copy in one click for an AI agent.

## How to test

1. Deploy first (founder, by hand): in the Supabase SQL editor run `202610250001` to `202610250005` in order, then push `feat/tester-feedback` from `E:\Dev\quadrion-web-tester-feedback` and merge it. The SQL must be live before the deploy.
2. Admin, Users, Manage, "Test feedback": tick Tester, Save tester access, for each tester and for yourself.
3. Build `node tools/test-board/build.mjs --private "<private folder>" --json`; Feedback, Test content, Upload test content with `tools/test-board/dist/test-content.json`. It reads "Uploaded version 1 with <n> lines".
4. As a tester: Tests, enter build 0.25.0, fail a line with a comment and a pasted screenshot. The line shows "Failed on 0.25.0" with a "#1 Bug" link.
5. As owner: Feedback shows the badge; open #1, set High, Ask a question; the tester answers from Waiting for you. Copy for AI pastes #1 with its line, steps, comment, thread and a working screenshot link.
6. Mark #1 fixed in 0.26.0, Copy message for testers ("1 fix in 0.26.0 is ready to re-check: ..."). The tester chooses Confirm it works and the line shows Pass on 0.26.0; Send back instead returns it at its old priority.
7. In the app (after this PR lands): Ctrl+K, Report a problem, Save report, Send to Quadrion: the portal form opens with the build and screen filled in; attach the saved ZIP and send.
8. The full 15-step walkthrough and the import of the old board's answers are in the website's `docs/portal-operations.md`, section "Tester feedback, 25 October 2026".

## Follow-ups

- Not checked in a real browser: the report-thread file picker and the single Mark fixed notice (fake-DOM tests only). Copy for AI signs links one at a time. No owner override when one merged reporter cannot confirm. Thread Confirm with a blank build records the fixed-in build.
