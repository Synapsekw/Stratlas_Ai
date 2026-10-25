# Tester feedback portal: design

Date: 25 Oct 2026. Status: draft for founder approval.

## Intent

The team test board (`tools/test-board`, design in `docs/plans/2026-10-10-team-test-board-design.md`) is today a claude.ai Artifact for the founder and a standalone HTML file for the two testers, who email a results JSON back. Results arrive late and in pieces, and nothing tracks a bug from "failed" to "fixed and confirmed".

Now that the website has a portal with logins, the test board moves behind that login, and around it grows one loop for everything a tester raises:

1. A tester raises an item: a failed test line (with a comment) or a feature request (attached to a test line, or written from scratch).
2. The owner sees it in one inbox, triages it and works on it, often by handing a batch of bugs to an AI agent.
3. The owner marks it fixed in a given build.
4. The tester who raised it is notified, re-tests on that build and confirms it or sends it back with a comment.

Success: the founder clears bugs faster, because every report lands in one place, in a form an agent can act on, and nothing is "fixed" until the tester who found it says so.

## Goals

- Test lists served from the portal to logged-in testers only; answers saved live.
- One owner inbox for failed tests and feature requests from every tester.
- A fix-and-retest loop with in-portal notifications, for bugs and for feature requests.
- One-click "Copy for AI" of the open bugs.
- The app's "Report a problem…" dialog reaches the same form.

## Non-goals

- A general-purpose issue tracker (no labels, assignees, sprints, boards). Two testers and one owner.
- Syncing to GitHub issues.
- Automated tests or crash reporting from the app.
- Replacing `docs/TESTING.md` as the source of test lines; it stays the source.

## Anti-goals (failure even if it works)

- Any client, site or tester name in either public repo (AIO and website are both **public**), in a built website asset, or in a commit message. The test content names client projects; it must only exist in the private folder and in the database.
- A tester able to read another tester's private items or the owner inbox, or anyone not logged in seeing any test content.
- A "fixed" item that silently closes without the tester confirming it.
- Losing the answers testers already gave on the Artifact board.

## Constraints

- Website: repo `Synapsekw/Quadrion_Web_Site` (local `E:\Dev\Quadrion Web Site`, work from its `main`; the local checkout sits on a stale branch). Plain JS ES modules in `portal/src/*.mjs` bundled by `scripts/build-portal.mjs`; Netlify functions in `netlify/functions/`, libraries in `netlify/lib/portal/`.
- Auth and roles: Supabase email + password; `portal_members` (role member/admin/owner, tier, status). The browser has no table access: grants revoked, RLS forced, all access through `security definer` RPCs called by Netlify functions with the service key after validating the JWT (`netlify/lib/portal/policy.mjs`, `supabase.mjs`). New tables follow the same pattern.
- Migrations are applied by hand in production (do not replay old ones); new SQL goes in `supabase/migrations/` and the founder applies it.
- Uploads: signed upload URLs to private buckets, tus resumable, server-side SHA-256 check; downloads by signed URLs that expire within 5 minutes.
- Supabase secrets are Production-only, so deploy previews return 503; testing happens against production or locally with secrets.
- `check:public` in the website build scans published assets; extend it so no test content or names can ship in `directions/`.
- The AIO merge-guard hook blocks pushes to the website repo from sessions; the founder runs those pushes (`!`). AIO repo work lands through the merge coordinator as usual.
- Test line ids are `<section id>:<hash of plain text>` (`-n` suffix for duplicates); rewording a line makes a new line. Keep these ids as keys so old answers carry over.

## Decided with the founder

- **Where:** behind the portal login. Testers get their own page; the owner page lives in the existing admin area.
- **Two kinds of item:** a bug (from a failed test line) and a feature request. A feature request can be attached to a test line or written from scratch.
- **Notifications:** in the portal only, no email (founder, 25 Oct); a copy-a-message button for chat.
- **Loop:** fixed → the tester(s) who raised it are notified → re-test → confirm, or send back with a comment. Same loop for features ("built in 0.26.0").
- **Owner actions:** set priority; reply with a question (item goes back to the tester until answered); park or decline with a reason the tester sees; merge duplicates (everyone who raised either is notified on the fix); mark fixed / built in a build.
- **Copy for AI:** one click copies all open bugs (or the current filter) as one text block for an AI agent.
- **Screenshots:** optional on failures and feature requests; testers can send without.
- **In the app:** the existing "Report a problem…" dialog gets a "Send to Quadrion" button that opens the portal report form, with the build filled in and the diagnostics bundle attachable. There is no second entry.

## The shape (Claude's calls, unless the founder changes them)

### Roles

A tester is a `portal_members` row with a new boolean `tester` flag (a flag rather than a new role, so a tester keeps their normal member downloads and tier). Owner and admin can see the inbox; the decision actions (priority, decline, merge, mark fixed) are owner and admin. The owner can also act as a tester (the flag works on an owner row too).

Claude's call: every tester sees every test line. The private config lists testers only as ids and names and has no tester-to-vertical assignment, so there is nothing to scope by; verticals stay a grouping. The owner sets the `tester` flag on members in the admin Users page. For the one-off import (below), the owner maps each config tester id to a portal member in a picker. Scoping that matters for security is on items and answers: a tester reads only their own answers and the items they raised or were merged into.

### Test content

The private build (`node tools/test-board/build.mjs --private "E:\Stratlas Data\test-board"`) gains a `--json` output: the model (stages/verticals, groups, lines `{id, html, sub[], plain}`, per-tester assignment, setup and extra documents). A new owner-only admin action "Upload test content" takes that JSON and stores it as a versioned row (`test_content`, one current version). Testers' pages fetch their slice through an RPC. Nothing of it is in either repo or in built assets. Re-uploading after a `TESTING.md` change keeps answers by line id; answers whose line no longer exists are kept and shown to the owner as "retired line".

### Data (new tables, same no-grant + RPC pattern)

- `test_answers`: tester, line id, status (pass / fail / skip), comment (required on fail), build, updated at. One row per tester per line; history kept in `feedback_events`.
- `feedback_items`: kind (bug / feature), title, body, line id (nullable), build seen in, priority (high / normal / low, default normal), status, `merged_into` (nullable), created by, timestamps. A fail answer creates a bug item automatically from its comment; the tester can edit its title.
- `feedback_reporters`: item ↔ tester (so a merged item notifies everyone who raised it).
- `feedback_events`: the thread and audit trail per item: comment, question, answer, status change, priority change, merge, fixed-in-build, confirm, reopen; who and when.
- `feedback_attachments`: item or event, storage path, type, size, hash. New private bucket `quadrion-feedback`, images (PNG/JPG/WebP) up to 10 MB and short screen recordings (MP4/WebM) up to 100 MB (builder may tune the caps).

### Statuses

`new` → `triaged` (has priority) → `question` (waiting on the tester) → back to `triaged` when answered → `fixed` (with build) → `confirmed` (tester says it works; closed) or `reopened` (tester says no, with comment; back in the inbox at its old priority). Side exits: `parked`, `declined` (reason shown to the tester), `merged` (points at the kept item). Confirming a `fixed` bug also sets the linked test line to pass for that tester on that build.

### Tester page (`/portal/tests`)

- **Waiting for you** at the top: items marked fixed to re-check (with the build), and questions to answer. Count shown as a badge in the portal nav.
- **My tests:** the assigned test list, grouped as today, with pass / fail / skip, comment, optional screenshot, and the build tested on. Claude's call: the build is a free-text version string, with the portal's releases offered as suggestions (latest preselected), so builds handed out outside the portal can still be recorded; "fixed in build" works the same way. Imported answers get build `unknown`, and the retest flow and Progress page show that as "build not recorded". Progress per group.
- **My reports:** every item they raised or were merged into, with its status and thread.
- **Request a feature:** a form (title, description, optional screenshot), optionally from a test line ("request a feature about this").

### Owner page (`/admin/feedback`)

- **Inbox:** all items, filter by tester, kind, status, priority, build; sorted by priority then age. Each item opens to its thread, test line text, attachments and the actions listed above. Merge: pick the item to keep; the other's thread and reporters fold into it.
- **Progress:** per tester and per vertical, how many lines are answered, passed, failed; which build they last tested.
- **Copy for AI:** a button over the inbox that copies the open bugs in the current filter as Markdown: a short header (product, how to report back by item id), then per item: id, title, priority, build, tester role (not a name), test line text and its sub-steps, what the tester saw, the thread so far, and attachment links. Attachment links are signed URLs that last 24 hours (longer than the normal 5 minutes, only in this export) so an agent can open them. The founder marks items fixed by id afterwards.
- **Upload test content** (see above).

### Notifications

Portal only, no email (founder, 25 Oct 2026: the website has no mail service, and the founder messages testers directly anyway). Testers see the "Waiting for you" list and a count badge in the portal nav; the owner sees a badge on the inbox for new, answered and reopened items. Next to "Mark fixed" (single or bulk), a "Copy message for testers" button copies a short note for chat, such as "3 fixes in 0.26.0 are ready to re-check: <link to Waiting for you>". The note has no test content or project names. Email digests are a possible later addition.

### In the app

The app keeps its single existing "Report a problem…" entry (founder, 25 Oct: no second look-alike button). It is reached from the command palette and Settings, since the Windows menu bar is removed; source in `apps/desktop/src/main/menuTemplate.ts` and `renderer/diagnostics/ReportProblem.tsx`. Today it only saves a local diagnostics bundle. It keeps doing that and gains a "Send to Quadrion" button that opens `https://quadrion.ai/portal/report?build=<app version>&screen=<current screen id>` in the system browser. The portal's login runs if needed and keeps the deep link (today login sends owner/admin to `/admin/` and members to `/portal/`; the builder adds a return-to so `/portal/report?…` survives login for every role), then the report form opens prefilled (kind bug, build, screen). The app has no screen id today; the builder defines one from the current workspace view and open panel (a short stable string, never a project name). No credentials or project data leave the app. Optional for the builder if cheap: the app copies a screenshot of its window to the clipboard first, and the form says "paste a screenshot" (Ctrl+V into the form attaches it).

### Migration of current answers

A one-off owner action imports the existing answers: from the Artifact's store (`results/<tester>/items/<line id>`, exported by Claude through ArtifactData into a JSON file) and from any results JSON files testers emailed. Fails become bug items. After import the Artifact board and the standalone HTML file are retired (the build keeps producing them until the founder says to drop them).

## Left to the builder

- Exact SQL, RPC names, function routes and module split, following the existing portal patterns.
- Visual design, following the portal's existing look (load the `impeccable` / `frontend-design` skills).
- Upload size caps, the screenshot-paste helper in the app.
- Tests: unit tests for the status machine, merge, permission checks (a tester cannot read another tester's items, the owner inbox, or other testers' lines; a logged-out request gets nothing), the content upload by line id, and the Copy for AI format; an e2e path through report → fix → notify → confirm on a local Supabase.

## Work split (for the plan)

Mostly the website repo; two small pieces in the AIO repo:

- AIO: `build.mjs --json`, the Artifact export helper, and the "Send to Quadrion" button in "Report a problem…" (its i18n string, and an e2e that it opens the right URL).
- Website: schema + RPCs, functions, tester page, owner page, in-portal notifications, `check:public` rule, import.
