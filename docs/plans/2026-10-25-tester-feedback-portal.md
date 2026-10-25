# Tester Feedback Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the team test board behind the website portal login and build one loop around it: a tester raises a failed line or a feature request, the owner triages it in one inbox (and copies open bugs for an AI agent), marks it fixed in a build, and the tester who raised it confirms it or sends it back. The app's "Report a problem…" dialog opens the same report form.

**Architecture:** Almost all of it is in the website repo, in the existing portal pattern: new tables with no client grants and forced RLS, `security definer` RPCs reached only by Netlify functions with the service key after the JWT is checked, and plain ES module pages bundled by esbuild. A new endpoint `/api/portal-feedback` serves testers; the owner's actions join the existing `/api/portal-admin` handler. Test content comes from the AIO repo's private build as JSON and is uploaded through the admin page into the database, so it never sits in either repo or in a built asset. The AIO repo gains `build.mjs --json`, an Artifact export helper and one button.

**Tech Stack:** Website: Node 22+, plain JS ESM, `node --test`, PGlite (`@electric-sql/pglite`) for SQL tests, Supabase (Postgres, Auth, Storage, tus), Netlify functions, esbuild, `tus-js-client`, `hash-wasm`. AIO: Node ESM tools with Vitest, Electron + React renderer, Playwright e2e.

**Spec:** `docs/plans/2026-10-25-tester-feedback-portal-design.md` (approved by the founder, 25 Oct 2026).

## Global Constraints

- Both repos are public. No client, site, tester or person name in code, tests, fixtures, docs, built assets or commit messages. Fixtures use made-up lines ("Open the sample project and switch to Map"), made-up ids (`tester-1`) and `@example.com` addresses. AIO: `node tools/agent/check-public-text.mjs <files>` on every changed doc; website: `npm run check:public` after `npm run build:portal`.
- Test content and tester names exist only in the private folder (`E:\Stratlas Data\test-board`), in git-ignored `tools/test-board/dist/`, and in the database.
- Security pattern, copied exactly from `supabase/migrations/202610150002_portal_catalog.sql`: every new table `enable` and `force row level security`; `revoke all ... from public, anon, authenticated, service_role`; `grant select ... to service_role`; no RLS policies. Every function `security definer set search_path=''`; `revoke all on function ... from public, anon, authenticated, service_role`; `grant execute ... to service_role` only for the API RPCs, never for internal helpers. The actor is always `user.userId` from `identity()`; a body never names an actor (`keys()` rejects it).
- Migrations: never edit or replay old ones. New files, applied by hand by the founder in this order: `202610250001_feedback_schema.sql`, `202610250002_feedback_tests_api.sql`, `202610250003_feedback_items_api.sql`, `202610250004_feedback_attachments_api.sql`, `202610250005_feedback_bucket.sql`.
- Kinds: `bug`, `feature`. Priorities: `high`, `normal` (default), `low`. Statuses: `new`, `triaged`, `question`, `fixed`, `confirmed`, `reopened`, `parked`, `declined`, `merged`. Answer statuses: `pass`, `fail`, `skip`; a `fail` needs a comment.
- Line id pattern (from `tools/review-board/parse.mjs`): `^[a-z][a-z0-9-]*(:[a-z0-9-]+)+:[0-9a-f]{10}(-[0-9]+)?$`, at most 200 characters.
- Build string: trimmed free text, 1 to 80 characters, `^[0-9A-Za-z][0-9A-Za-z._+ -]*$`, or the literal `unknown` (imported answers; shown as "build not recorded").
- Attachments: private bucket `quadrion-feedback`; PNG/JPG/WebP up to 10,000,000 bytes; MP4/WebM up to 100,000,000 bytes; ZIP (the app's diagnostics bundle) up to 50,000,000 bytes; at most 10 per item. Signed upload URL + tus resumable + server-side SHA-256 check, as for releases.
- Signed download URLs last 300 s, except in the Copy for AI export: 86,400 s (24 hours), and only there.
- Notifications are in the portal only (no email). The "Copy message for testers" text holds no test content and no project names.
- Portal paths keep the trailing-slash style: `/portal/tests/`, `/portal/report/`, `/admin/feedback/`. `/portal/report` without the slash also works.
- The app opens exactly `https://quadrion.ai/portal/report/?build=<app version>&screen=<screen id>`; nothing else leaves the app.
- AIO: TypeScript strict, no `any`, no non-null assertions; user-facing strings in `packages/ui/src/i18n/en.ts`; no em or en dashes in user-facing text; conventional commits.
- Website code follows its existing compact style (see `netlify/lib/portal/admin-api.mjs`); no new dependencies.

## Review Focus

1. **Test content re-uploaded while a tester has the page open.** An answer posted for a line that the new version dropped must come back as a clear "this line was retired, reload" message, never a silent loss. Test: T5 `answer on a retired line is refused with conflict`; T11 shows the conflict notice and a Reload button.
2. **Double clicks and two tabs.** "Mark fixed", "Confirm" and "Send back" clicked twice, or acted on from a stale tab, must not double the thread or flip a status twice. Test: T6 `stale revision is refused and a repeated confirm changes nothing`.
3. **Deep link through login for the owner role.** The owner normally lands on `/admin/`; a `/portal/report/?build=…` link must survive sign-in for every role, and a foreign or `/admin/` return path must not be honoured from the query. Test: T11 `loginDestination keeps an allowed deep link for every role`.
4. **Paste of something that is not a screenshot** (text, a 40 MB PNG, a HEIC file). It must say why it was refused and start no upload. Test: T9 `attachmentKind refuses unsupported or oversized files`.
5. **Tester text that breaks Markdown, and an empty filter.** A comment with backticks, `#` lines or a fake "## #12" heading must not break the Copy for AI block, and a filter with no open bugs still copies a header and "No open bugs in this filter." Test: T8 `formatForAgent fences tester text and handles an empty list`.

---

## Workspaces

**Website.** Never touch `E:\Dev\Quadrion Web Site`'s working tree (it is on a stale branch). Cut a worktree from the latest `main`:

```bash
git -C "E:/Dev/Quadrion Web Site" fetch origin
git -C "E:/Dev/Quadrion Web Site" worktree add -b feat/tester-feedback "E:/Dev/quadrion-web-tester-feedback" origin/main
npm ci --prefix "E:/Dev/quadrion-web-tester-feedback"
```

Check that `origin/main` is at or after `afa59d4` (the 10 GB release limit). All website paths below are relative to `E:\Dev\quadrion-web-tester-feedback`. Website checks: `npm test`, `npm run build:portal`, `npm run check:public`, `git diff --check`. The founder pushes website branches (`!` command; the AIO merge-guard hook blocks it from sessions) and applies the SQL by hand.

**AIO.** This worktree, `E:\Dev\AIO Software\.claude\worktrees\tester-feedback-portal`, branch `docs/tester-feedback-portal` (rename to `feat/tester-feedback-portal` before hand-off with `git branch -m`; tell the coordinator the new name). It lands through the merge coordinator. AIO checks: `pnpm check`; the changed e2e spec the CI way (CONTRIBUTING.md, "End to end the way CI runs it").

Parallel agents in one worktree commit only their own files (`git add <paths>`, never `git add -A`) and one at a time.

## Execution DAG

| Task                                                          | Repo | Depends on          | Touches                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 Foundation: schema, helpers, tester flag, API contract     | web  | none                | `supabase/migrations/202610250001_feedback_schema.sql`, `tests/helpers/portal-db.mjs`, `tests/feedback-schema.test.mjs`, `netlify/lib/portal/http.mjs`, `netlify/lib/portal/policy.mjs`, `portal/src/api.mjs`, `tests/portal-policy.test.mjs`, `tests/portal-client.test.mjs`                                                                      |
| T2 `check:public` rule                                        | web  | none                | `scripts/check-quori-public.mjs`, `tests/check-public.test.mjs`                                                                                                                                                                                                                                                                                    |
| T3 `build.mjs --json` and the Artifact export helper          | aio  | none                | `tools/test-board/build.mjs`, `build.test.mjs`, `export-artifact.mjs`, `export-artifact.test.mjs`                                                                                                                                                                                                                                                  |
| T4 "Send to Quadrion" in Report a problem                     | aio  | none                | `apps/desktop/src/renderer/diagnostics/{portalReport.ts,portalReport.test.ts,ReportProblem.tsx,diagnostics.css}`, `packages/ui/src/i18n/en.ts`, `apps/desktop/e2e/diagnostics.spec.ts`                                                                                                                                                             |
| T5 Test content, answers, progress, import RPCs               | web  | T1                  | `supabase/migrations/202610250002_feedback_tests_api.sql`, `tests/feedback-tests-db.test.mjs`                                                                                                                                                                                                                                                      |
| T6 Items, threads, owner actions, merge, counts, export RPCs  | web  | T1                  | `supabase/migrations/202610250003_feedback_items_api.sql`, `tests/feedback-items-db.test.mjs`                                                                                                                                                                                                                                                      |
| T7 Attachments: RPCs, bucket, uploads, verifier, cleanup, CSP | web  | T1                  | `supabase/migrations/202610250004_feedback_attachments_api.sql`, `202610250005_feedback_bucket.sql`, `netlify/lib/portal/feedback-uploads.mjs`, `netlify/functions/portal-feedback-verify.mjs`, `netlify/functions/portal-cleanup.mjs`, `netlify.toml`, `tests/feedback-attachments-db.test.mjs`, `tests/netlify/portal-feedback-uploads.test.mjs` |
| T8 Owner API actions, content check, Copy for AI              | web  | T1                  | `netlify/lib/portal/{feedback-admin-api.mjs,feedback-export.mjs,test-content.mjs,admin-api.mjs}`, `netlify/functions/portal-admin.mjs`, `tests/netlify/portal-feedback-admin.test.mjs`, `tests/feedback-export.test.mjs`, `tests/test-content.test.mjs`                                                                                            |
| T9 Shared client helpers and preview fixtures                 | web  | T1                  | `portal/src/feedback-ui.mjs`, `tests/feedback-ui.test.mjs`, `scripts/portal-preview.mjs`                                                                                                                                                                                                                                                           |
| T10 Tester endpoint `/api/portal-feedback`                    | web  | T1, T7              | `netlify/lib/portal/feedback-api.mjs`, `netlify/functions/portal-feedback.mjs`, `tests/netlify/portal-feedback.test.mjs`, `tests/pwa.test.mjs`                                                                                                                                                                                                     |
| T11 Tester pages, nav badge, login return-to                  | web  | T1, T9              | `portal/src/{tests.mjs,tests.css,member.mjs,auth.mjs,routing.mjs}`, `tests/portal-routing.test.mjs`, `tests/portal-tests-client.test.mjs`                                                                                                                                                                                                          |
| T12 Owner pages and the Users tester toggle                   | web  | T1, T9              | `portal/src/{feedback-admin.mjs,feedback-admin.css,admin.mjs}`, `tests/portal-feedback-admin-client.test.mjs`                                                                                                                                                                                                                                      |
| T13 The whole loop on PGlite                                  | web  | T5, T6, T7, T8, T10 | `tests/helpers/pglite-backend.mjs`, `tests/feedback-loop.test.mjs`                                                                                                                                                                                                                                                                                 |
| T14 Operations doc, How to test, deploy steps                 | both | all                 | website `docs/portal-operations.md`; AIO session note via `/wrapup`                                                                                                                                                                                                                                                                                |

**Batches** (tasks in a batch share no files; dispatch each batch in one message):

- **B1:** T1, T2 (web) · T3, T4 (aio)
- **B2:** T5, T6, T7, T8, T9 (web)
- **B3:** T10, T11, T12 (web)
- **B4:** T13 (web)
- **B5:** T14 (both)

**Critical path:** T1 → T7 → T10 → T13 → T14. T3 and T4 can be handed to the coordinator as soon as they are green; they do not wait for the website.

**Contract changes:** none in `@aio/schema` (T4 opens the link through the existing `setWindowOpenHandler` → `popupAction` path; no new IPC channel). The website's API contract is the action list fixed in T1.

---

### Task 1: Foundation (web): schema, shared helpers, tester flag, API contract

**Files:**

- Create: `supabase/migrations/202610250001_feedback_schema.sql`, `tests/feedback-schema.test.mjs`
- Modify: `tests/helpers/portal-db.mjs`, `netlify/lib/portal/http.mjs`, `netlify/lib/portal/policy.mjs`, `portal/src/api.mjs`, `tests/portal-policy.test.mjs`, `tests/portal-client.test.mjs`

**Interfaces:**

- Produces (SQL, tables): `portal_members.tester boolean not null default false`; `test_content(id uuid pk, version integer unique, title text, model jsonb, testers jsonb, line_count integer, current boolean, uploaded_by uuid, created_at)` with a partial unique index on `current` where `current`; `test_lines(content_id, line_id, position, stage_id, stage_title, group_title, plain, html, sub jsonb, pk(content_id,line_id))`; `test_answers(tester_id → portal_members, line_id, status, comment, build, updated_at, pk(tester_id,line_id), check fail ⇒ comment)`; `feedback_items(id uuid pk, number bigint generated always as identity unique, kind, title 1..200, body ≤16000, line_id null, build_seen, screen null ≤80, priority, status, merged_into → feedback_items null, fixed_in null, reason null ≤2000, created_by, owner_attention boolean default true, revision integer default 1, created_at, updated_at)`; `feedback_reporters(item_id, tester_id, confirmed_build null, confirmed_at null, added_at, pk(item_id,tester_id))`; `feedback_events(id, item_id, actor_id, kind in (comment,question,answer,status,priority,merge,fixed,confirm,reopen,title,line_passed,import), body ≤16000, details jsonb object, created_at)`; `feedback_attachments(id, item_id, event_id null, uploader_id, bucket check = 'quadrion-feedback', object_path unique, filename, mime_type, bytes, sha256, state in (pending,verifying,verified,failed,abandoned), verified_bytes, hash_state, object_etag, lease_id, lease_until, attempts, error_code, expires_at default now()+24h, created_at, verified_at)`.
- Produces (SQL, internal, no grant): `portal_tester_active(p_actor uuid) returns public.portal_members` (active member with `tester`, else `portal:forbidden`); `portal_feedback_visible(p_actor uuid, p_item uuid) returns boolean` (active admin/owner, or a `feedback_reporters` row for the actor); `portal_feedback_next_status(p_from text, p_action text) returns text` (immutable; null when not allowed; table below); `portal_feedback_log(p_item uuid, p_actor uuid, p_kind text, p_body text, p_details jsonb) returns uuid`; `portal_feedback_open_bug(p_tester uuid, p_line text, p_comment text, p_build text, p_source text) returns uuid` (adds a comment event to the tester's open bug on that line, else creates one: title = first line of the comment cut to 120 characters, reporter row, event `comment` or `import`); `portal_feedback_confirm(p_item uuid, p_tester uuid, p_build text) returns public.feedback_items` (marks this reporter confirmed; when every reporter confirmed: status `confirmed`; a bug with a line sets that tester's answer to `pass` on `coalesce(p_build, fixed_in)`; a second call for the same reporter changes nothing).
- Produces (SQL, granted): `portal_member_tester(p_actor uuid, p_aal text, p_target uuid, p_revision integer, p_tester boolean) returns jsonb`: owner only, revision checked, bumps `revision`, audits `member_tester_changed` in `portal_events`.
- Produces (JS): `readJson(request, {maxBytes=32768}={})`; `memberDto(m)` adds `tester: m.tester===true`; `isTester(member, now)` in `policy.mjs` (`activeMember(member,now) && member.tester===true`); `createPortalApi({fetcher, getToken, onDenied, admin=false, scope})` with `scope` `'member'|'admin'|'feedback'` (`admin:true` stays as `scope:'admin'`), endpoint `/api/portal`, `/api/portal-admin`, `/api/portal-feedback`.
- Produces (action contract, used by T8, T10, T11, T12): feedback scope: GET `content`, `answers`, `mine`, `item`, `counts`; POST `answer`, `create`, `act`, `attachmentBegin`, `attachmentResume`, `attachmentFinalize`, `attachmentStatus`, `attachmentAbandon`, `attachmentUrl`. Admin scope adds GET `feedbackInbox`, `feedbackItem`, `feedbackProgress`, `feedbackExport`, `feedbackCounts`, `testContentStatus`; POST `feedbackAction`, `feedbackBulkFix`, `feedbackAttachmentUrl`, `testContentUpload`, `testImport`, `memberTester`.
- Produces (test helper): `portalDb({testers=false}={})` loads every `supabase/migrations/*.sql` in name order, skipping files that mention `storage.buckets`; with `testers:true` it adds `ids.testerA`, `ids.testerB` (T1 members, `tester=true`, `testerA@example.com`) and sets `tester=true` on nobody else. `ids.t1` stays a member without the flag (the "outsider").

Status table for `portal_feedback_next_status` (any pair not listed returns null):

| from             | triage  | ask      | answer  | fix   | confirm   | reopen   | park   | decline  | restore | merge  |
| ---------------- | ------- | -------- | ------- | ----- | --------- | -------- | ------ | -------- | ------- | ------ |
| new              | triaged | question |         | fixed |           |          | parked | declined |         | merged |
| triaged          |         | question |         | fixed |           |          | parked | declined |         | merged |
| question         |         |          | triaged | fixed |           |          | parked | declined |         | merged |
| fixed            |         |          |         | fixed | confirmed | reopened |        |          |         |        |
| reopened         | triaged | question |         | fixed |           |          | parked | declined |         | merged |
| parked, declined |         |          |         |       |           |          |        |          | triaged |        |

`confirmed` and `merged` are terminal. A priority change never changes status, except on `new`, where it triages.

- [ ] **Step 1: Cut the website worktree** (commands in Workspaces) and run `npm test` there. Expected: all existing tests pass.
- [ ] **Step 2: Write the failing tests** in `tests/feedback-schema.test.mjs` (PGlite, `portalDb({testers:true})`):

```js
test('new tables force RLS and give browser roles nothing', async () => {
  /* for each of test_content,test_lines,test_answers,feedback_items,feedback_reporters,feedback_events,feedback_attachments: relrowsecurity && relforcerowsecurity; has_table_privilege('anon'|'authenticated', t, 'select'|'insert'|'update'|'delete') all false */
});
test('only API functions are executable by service_role and none by browser roles', async () => {
  /* has_function_privilege('service_role', portal_member_tester(...), 'execute') true; for portal_tester_active, portal_feedback_visible, portal_feedback_log, portal_feedback_open_bug, portal_feedback_confirm: false; anon/authenticated false for all */
});
test('status machine allows exactly the listed moves', async () => {
  /* loop the table above, plus assert null for ('confirmed','reopen'), ('merged','restore'), ('fixed','merge'), ('new','confirm') */
});
test('only the owner sets the tester flag, revision checked and audited', async () => {
  /* admin -> portal:forbidden; owner with stale revision -> portal:conflict; owner ok -> tester true, revision+1, one portal_events row 'member_tester_changed' */
});
test('portal_tester_active refuses a member without the flag', async () => {
  /* ids.t1 -> portal:forbidden; ids.testerA -> row */
});
test("open_bug reuses the tester's open bug on the same line and confirm needs every reporter", async () => {
  /* two calls same line -> same id, 2 events; add testerB as reporter, set status fixed; confirm(testerA) -> still fixed; confirm(testerA) again -> no new event; confirm(testerB) -> confirmed and test_answers(testerA,line).status='pass' */
});
```

Add to `tests/portal-policy.test.mjs`: `isTester` true only for an active member with `tester:true` (also for an owner with the flag), false for expired, suspended or flagless. Add to `tests/portal-client.test.mjs`: `scope:'feedback'` calls `/api/portal-feedback?action=mine`, refuses an admin-only action name, and `admin:true` still reaches `/api/portal-admin`.

- [ ] **Step 3: Run** `node --test tests/feedback-schema.test.mjs tests/portal-policy.test.mjs tests/portal-client.test.mjs`. Expected: FAIL (missing relations and exports).
- [ ] **Step 4: Write the migration and JS changes.** One `begin; … commit;` file; tables first, then the grant `do` block in the style of `202610150002` listing the seven tables and the seven new functions (only `portal_member_tester` granted). `portal_feedback_open_bug` and `portal_feedback_confirm` take `for update` locks on the item row. Update `portalDb` and the JS exports listed in Interfaces.
- [ ] **Step 5: Run** the three test files, then `npm test`. Expected: PASS, existing tests unchanged.
- [ ] **Step 6: Commit** `feat(portal): feedback schema, tester flag and feedback API contract`.

### Task 2: `check:public` rule (web)

**Files:**

- Modify: `scripts/check-quori-public.mjs`
- Create: `tests/check-public.test.mjs`

**Interfaces:**

- Produces: `export function findPrivateContent(text, terms) → string[]` (reasons) in `scripts/check-quori-public.mjs`; the script's `visit()` fails on any reason. Rules: the format markers `quadrion-test-content/` and `quadrion-test-results/`; any string matching the line id pattern from Global Constraints with a `testing:`, `setup:` or `extra:` prefix; any term (case-insensitive, word-bounded) from the optional git-ignored `public-check-terms.local.json` (`{"terms":["…"]}`; `*.local.json` is already ignored) or the env var `PUBLIC_CHECK_TERMS_FILE`. Guard the top-level script run so the test can import the function.

- [ ] **Step 1: Write the failing tests:** `test('a built asset carrying a test line id fails')` (text `"id":"testing:stage-m1:0123456789"` gives one reason); `test('format markers fail')`; `test('a private term fails word-bounded and case-insensitive')` (terms `["Northwind"]`: `northwind yard` fails, `northwindy` passes); `test('ordinary portal bundles pass')` (run `findPrivateContent` over the current `directions/assets/portal/*.js` after `npm run build:portal`: no reasons).
- [ ] **Step 2: Run** `node --test tests/check-public.test.mjs`. Expected: FAIL (no export).
- [ ] **Step 3: Implement** `findPrivateContent` and wire it into `visit()` for every scanned text file.
- [ ] **Step 4: Run** the test, then `npm run build:portal && npm run check:public`. Expected: PASS, message unchanged.
- [ ] **Step 5: Commit** `feat(build): public check refuses test content and private terms`.

### Task 3: `build.mjs --json` and the Artifact export helper (aio)

**Files:**

- Modify: `tools/test-board/build.mjs`, `tools/test-board/build.test.mjs`
- Create: `tools/test-board/export-artifact.mjs`, `tools/test-board/export-artifact.test.mjs`

**Interfaces:**

- Produces: `buildModel(text, config, setupText, extraText, { keepPlain = false } = {})`; with `keepPlain`, each line keeps `plain` and gains `subPlain` (the sub-bullets' markdown). `export function contentJson(model, now) → object`: `{ format: 'quadrion-test-content/1', builtAt, title, source, owner, unit, guide, testers: [{id,name}], stages }`. CLI `--json` writes `tools/test-board/dist/test-content.json` (git-ignored by the root `dist/` rule) next to the HTML files and prints its line count.
- Produces: `export function toResultsFiles(exported, { board, now }) → Array<{ tester, file: object }>` in `export-artifact.mjs`. Input shape (what a session writes from ArtifactData listings): `{ "format": "artifact-db-export", "collections": { "results/<tester>/items": [ { "id": "<line id>", "data": { "s", "c", "t" } } ] } }`. Output per tester: the existing `quadrion-test-results/1` payload (`board, tester, name: '', savedAt, lines: 0, answered, results`). CLI: `node tools/test-board/export-artifact.mjs <export.json> --out <folder>` writes `quadrion-test-results-<tester>.json` per tester; refuses an `--out` inside the repo.

- [ ] **Step 1: Write the failing tests.** In `build.test.mjs`: `it('keeps plain text and sub-step text only when asked')` (default model has no `plain`; `keepPlain` model has `plain` and `subPlain` on every line and the same ids); `it('writes the content format with testers and every line once')` (`contentJson(...).format === 'quadrion-test-content/1'`, line ids unique). In `export-artifact.test.mjs` (made-up lines only): `it('turns each tester collection into one results file')`; `it('drops records without a status or comment and unknown collection names')`; `it('refuses an output folder inside the repository')`.
- [ ] **Step 2: Run** `pnpm vitest run tools/test-board`. Expected: FAIL.
- [ ] **Step 3: Implement** both. `--json` reuses the merged config already read by the CLI.
- [ ] **Step 4: Run** the tests; then `node tools/test-board/build.mjs --json` (defaults, no private folder) and check `git status` shows nothing new. Expected: PASS, `dist/test-content.json` ignored.
- [ ] **Step 5: Commit** `feat(test-board): content JSON for the portal and an Artifact answers export`.

### Task 4: "Send to Quadrion" in Report a problem (aio)

**Files:**

- Create: `apps/desktop/src/renderer/diagnostics/portalReport.ts`, `portalReport.test.ts`
- Modify: `ReportProblem.tsx`, `diagnostics.css` (only if a style is needed), `packages/ui/src/i18n/en.ts`, `apps/desktop/e2e/diagnostics.spec.ts`

**Interfaces:**

- Consumes: `build.version` (`apps/desktop/src/renderer/buildStamp.ts`); `shell.getState()` `screen`, `stageMode`, `settingsPage` (`apps/desktop/src/renderer/store.ts`).
- Produces: `screenId(s: { screen: Screen; stageMode: StageMode; settingsPage: SettingsPage | null }): string`: `scene:<stageMode>`, `settings:<page>` (or `settings`), else the screen name. `portalReportUrl(version: string, screen: string): string` → `https://quadrion.ai/portal/report/?build=<encoded version or "unknown">&screen=<encoded screen>`.
- i18n: `diag.problem.send`: `Send to Quadrion`; `diag.problem.sendHelp`: `Opens the report form on quadrion.ai in your browser. Save the report first to attach its file.`

- [ ] **Step 1: Write the failing unit tests:** `screenId` for scene in map mode (`scene:map`), Settings on privacy (`settings:privacy`), Projects (`projects`); `portalReportUrl('0.25.0','scene:map')` equals the exact string; an empty version gives `build=unknown`; the URL host passes `externalLinkAllowed` from `src/main/popup.ts`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/diagnostics/portalReport.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `portalReport.ts`; in `ReportProblem.tsx` add a ghost button `data-testid="problem-send"` left of the footer's `grow` spacer, shown before and after saving, that calls `window.open(portalReportUrl(build.version, screenId(shell.getState())), '_blank', 'noopener')`; the help line sits under the intro.
- [ ] **Step 4: Write the e2e** in `diagnostics.spec.ts`: `test('Send to Quadrion opens the portal report form with the build and screen')`: stub `shell.openExternal` through `app.evaluate` (as `library-remove.spec.ts` stubs `shell.trashItem`) to record URLs; open the dialog from the palette; click Send to Quadrion; expect one URL matching `^https://quadrion\.ai/portal/report/\?build=[^&]+&screen=[a-z:-]+$`; the dialog stays open.
- [ ] **Step 5: Run** the spec the CI way: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/diagnostics.spec.ts --workers=1` (after `pnpm demo:change --quick`). Expected: PASS, the zero-network test in the spec unchanged.
- [ ] **Step 6: Run** `pnpm check`. Expected: green.
- [ ] **Step 7: Commit** `feat(diagnostics): Send to Quadrion opens the portal report form`.

### Task 5: Test content, answers, progress and import RPCs (web)

**Files:**

- Create: `supabase/migrations/202610250002_feedback_tests_api.sql`, `tests/feedback-tests-db.test.mjs`

**Interfaces:**

- Consumes: T1 tables and helpers.
- Produces (all granted to `service_role`):
  - `portal_tests_content_upload(p_actor uuid, p_aal text, p_model jsonb) returns jsonb`: owner only; `format` must be `quadrion-test-content/1`; new `version` = max+1, `current` moves; fills `test_lines`; stores `testers` apart from `model` (the model is stored without `testers`); returns `{version, lines, kept, retired}` (answers whose line is or is not in the new version).
  - `portal_tests_content_status(p_actor uuid, p_aal text) returns jsonb`: admin; `{version, lines, uploadedAt, testers:[{id,name}], retiredAnswers}`.
  - `portal_tests_content(p_actor uuid) returns jsonb`: tester; `{version, title, unit, guide, stages}`, never `testers`.
  - `portal_tests_answers(p_actor uuid) returns jsonb`: tester; own answers `[{lineId, status, comment, build, updatedAt, itemId}]` (`itemId`: own open bug on that line).
  - `portal_tests_answer(p_actor uuid, p_line text, p_status text, p_comment text, p_build text) returns jsonb`: tester; line must be in the current version, else `portal:conflict`; `p_status` null clears the answer; `fail` without comment is `portal:invalid` and calls `portal_feedback_open_bug(..., 'answer')`; `pass` on a line whose own bug is `fixed` calls `portal_feedback_confirm`; `pass` on another open own bug logs `line_passed` and sets `owner_attention`. Returns `{answer, itemId}`.
  - `portal_tests_progress(p_actor uuid, p_aal text) returns jsonb`: admin; per tester (`userId`, display name) and per stage `{total, answered, pass, fail, skip, lastBuild}`, plus `retired: [{userId, lineId, status}]`.
  - `portal_tests_import(p_actor uuid, p_aal text, p_tester uuid, p_results jsonb) returns jsonb`: owner; target must be an active tester; `p_results` is the `results` map of a `quadrion-test-results/1` file; an entry overwrites only when there is no answer or the stored `updated_at` is older than its `t`; build `unknown`; each `fail` goes through `portal_feedback_open_bug(..., 'import')` (so a second import adds no items); unknown line ids are kept as retired answers; returns `{imported, skipped, bugs, retired}`.

- [ ] **Step 1: Write the failing tests** (made-up fixture model with two stages, three lines; PGlite `portalDb({testers:true})`): `upload is owner only and moves the current version`; `testers never receive tester names` (`JSON.stringify(content)` lacks the fixture names); `a member without the flag and an admin without it get forbidden from tester RPCs`; `a tester reads only their own answers`; `a fail needs a comment and opens one bug per line`; `answer on a retired line is refused with conflict` (Review Focus 1); `re-upload keeps answers by line id and counts retired ones`; `pass on a fixed own bug confirms it`; `import is idempotent, keeps newer answers and records build unknown`; `progress counts per tester and stage`.
- [ ] **Step 2: Run** `node --test tests/feedback-tests-db.test.mjs`. Expected: FAIL (functions missing).
- [ ] **Step 3: Write the migration** with its own grant `do` block for these seven functions.
- [ ] **Step 4: Run** the file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): test content, answers, progress and import`.

### Task 6: Items, threads, owner actions, merge, counts and export RPCs (web)

**Files:**

- Create: `supabase/migrations/202610250003_feedback_items_api.sql`, `tests/feedback-items-db.test.mjs`

**Interfaces:**

- Consumes: T1 tables and helpers (`portal_feedback_next_status`, `portal_feedback_log`, `portal_feedback_confirm`, `portal_feedback_visible`, `portal_require_admin`).
- Produces (all granted):
  - `portal_feedback_create(p_actor uuid, p_data jsonb) returns jsonb`: tester; keys `kind, title, body, lineId, build, screen`; a feature may name a line or not; a bug without a line is allowed (the app's report form); returns the item.
  - `portal_feedback_mine(p_actor uuid) returns jsonb`: tester; items with a reporter row for the actor, each with `waiting` (`question`, or `fixed` and this reporter not confirmed).
  - `portal_feedback_item(p_actor uuid, p_aal text, p_id uuid) returns jsonb`: `portal:not_found` unless visible; item, line text from the current version (or `retired: true`), events of this item and of items merged into it, verified attachments' metadata. Actor labels: for a tester `you`, `tester` or `quadrion`; for an admin the display name or email.
  - `portal_feedback_tester_action(p_actor uuid, p_id uuid, p_revision integer, p_action text, p_body text, p_build text) returns jsonb`: reporter only; `comment`, `answer` (status `question` → `triaged`), `confirm` (via `portal_feedback_confirm`), `reopen` (body required; clears all confirmations), `title` (creator only, while `new`, `triaged`, `question` or `reopened`). Each sets `owner_attention`.
  - `portal_feedback_counts(p_actor uuid) returns jsonb`: `{waiting}` for a tester, plus `{inbox}` (open items with `owner_attention`) for an admin.
  - `portal_feedback_inbox(p_actor uuid, p_aal text, p_filter jsonb) returns jsonb`: admin; filter keys `tester, kind, status (array), priority, build, offset`; order `high, normal, low`, then oldest first; 100 per page; `{items, total}`.
  - `portal_feedback_owner_action(p_actor uuid, p_aal text, p_id uuid, p_revision integer, p_action text, p_data jsonb) returns jsonb`: admin; `priority {priority}`, `triage`, `ask {body}`, `comment {body}`, `park {reason}`, `decline {reason}` (required), `restore`, `fix {build}`, `merge {into}`, `seen` (clears `owner_attention`, no revision bump). Status moves only through `portal_feedback_next_status`; others are `portal:invalid`. `merge`: the kept item must be open and not the same; reporters are unioned into it; the merged item points at it.
  - `portal_feedback_bulk_fix(p_actor uuid, p_aal text, p_ids uuid[], p_build text) returns jsonb`: admin; at most 200; all or nothing; `{fixed, bugs, features, testers}`.
  - `portal_feedback_export(p_actor uuid, p_aal text, p_filter jsonb) returns jsonb`: admin; open bugs (`new, triaged, question, reopened`) in the filter with line `plain` and `sub`, thread (`kind, body, role` where role is `tester` or `quadrion`), verified attachments (`id, bucket, object_path, filename, mime_type`). No names or emails.

- [ ] **Step 1: Write the failing tests** (PGlite, testers A and B, owner, admin, outsider `t1`): `a tester cannot read another tester's item or the inbox` (B reading A's item: `portal:not_found`; B calling inbox: `portal:forbidden`; outsider calling create: `portal:forbidden`); `owner and admin act, members cannot`; `every move follows the status table` (walk new → triaged → question → triaged → fixed → reopened → fixed → confirmed); `stale revision is refused and a repeated confirm changes nothing` (Review Focus 2); `merge folds reporters and thread and notifies both on fix` (after merge B into A and fix: `mine(A)` and `mine(B)` both show `waiting`; A's confirm alone leaves `fixed`); `decline needs a reason the tester sees`; `counts drop when the owner opens an item`; `inbox sorts by priority then age and filters by tester and build`; `export carries no names or emails` (string search for the fixture emails and display names).
- [ ] **Step 2: Run** `node --test tests/feedback-items-db.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Write the migration** with its grant block.
- [ ] **Step 4: Run** the file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): feedback items, owner actions and merge`.

### Task 7: Attachments (web): RPCs, bucket, uploads, verifier, cleanup, CSP

**Files:**

- Create: `supabase/migrations/202610250004_feedback_attachments_api.sql`, `supabase/migrations/202610250005_feedback_bucket.sql`, `netlify/lib/portal/feedback-uploads.mjs`, `netlify/functions/portal-feedback-verify.mjs`, `tests/feedback-attachments-db.test.mjs`, `tests/netlify/portal-feedback-uploads.test.mjs`
- Modify: `netlify/functions/portal-cleanup.mjs`, `netlify.toml`

**Interfaces:**

- Consumes: `verifySlice` (`netlify/lib/portal/verification.mjs`), `dispatchVerification`'s pattern (`uploads.mjs`), backend `service.storage`, `signDownload(file, ttl, download)`.
- Produces (SQL, granted): `portal_feedback_attachment_begin(p_actor uuid, p_aal text, p_data jsonb) returns jsonb` (item visible to the actor; keys `itemId, eventId, filename, bytes, sha256, mimeType, maxBytes`; object path `<item id>/<attachment id>/<filename>`; at most 10 non-abandoned per item); `portal_feedback_attachment_command(p_actor uuid, p_aal text, p_id uuid, p_action text) returns jsonb` (`status`, `resume`, `finalize`, `retry`, `abandon`; uploader only); `portal_feedback_attachment_get(p_actor uuid, p_aal text, p_id uuid) returns jsonb` (verified and item visible, else `portal:not_found`); `portal_feedback_verify_claim(p_id uuid)`, `portal_feedback_verify_checkpoint(p_id uuid, p_lease uuid, p_offset bigint, p_hash text, p_etag text, p_digest text)`, `portal_feedback_verify_release(p_id uuid, p_lease uuid, p_error text)`, `portal_feedback_verify_queue()`, `portal_feedback_cleanup(p_cleaned uuid default null)` (pending past `expires_at` + 7 days), each mirroring its `portal_verify_*` / `portal_cleanup` twin in `202610150005`.
- Produces (bucket migration, not loaded by PGlite): `quadrion-feedback`, private, `file_size_limit` 100000000, allowed types `image/png, image/jpeg, image/webp, video/mp4, video/webm, application/zip`, then a check that raises when the row is missing (as `202610240001` does).
- Produces (JS): `FEEDBACK_TYPES` (extension → `{mime, maxBytes}` for `png, jpg, jpeg, webp, mp4, webm, zip`) and `createFeedbackUploads({config, backend, dispatch}) → (action, body, user) => Promise<object>` for `attachmentBegin, attachmentResume, attachmentFinalize, attachmentStatus, attachmentAbandon, attachmentUrl` (`attachmentUrl` signs 300 s, inline). Returns the same session shape as `uploads.mjs` `signedSession` (endpoint, token, bucket, objectPath, contentType).
- Produces: `netlify/functions/portal-feedback-verify.mjs`, `config={path:'/api/portal-feedback-verify', background:true}`, the same `X-Portal-Verify` secret check as `portal-verify.mjs`. `portal-cleanup.mjs` also dispatches `portal_feedback_verify_queue()` jobs and removes `portal_feedback_cleanup()` objects.
- `netlify.toml`: both CSP lines gain `blob:` in `img-src` and a new `media-src 'self' blob: https://oxjrkodcmflxejdwsuac.supabase.co`.

- [ ] **Step 1: Write the failing tests.** DB: `only someone who can see the item may attach`; `an eleventh attachment is refused`; `the uploader alone finalizes or abandons`; `a pending attachment is never returned by get`; `functions are service-only`. Handler module (fake backend as in `tests/portal-uploads.test.mjs`): `types and caps follow FEEDBACK_TYPES` (a 10,000,001-byte PNG `too_large`, a `.heic` `invalid`, a 100,000,000-byte MP4 accepted); `filenames with paths or dot-dot are refused`; `finalize checks the stored size before verifying`; `attachmentUrl signs for 300 seconds`; `a resume with a different file is upload_file_mismatch`.
- [ ] **Step 2: Run** `node --test tests/feedback-attachments-db.test.mjs tests/netlify/portal-feedback-uploads.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the two migrations, the module, the background function, the cleanup addition and the CSP change.
- [ ] **Step 4: Run** both files, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): verified feedback attachments in a private bucket`.

### Task 8: Owner API actions, content check and Copy for AI (web)

**Files:**

- Create: `netlify/lib/portal/feedback-admin-api.mjs`, `netlify/lib/portal/feedback-export.mjs`, `netlify/lib/portal/test-content.mjs`, `tests/netlify/portal-feedback-admin.test.mjs`, `tests/feedback-export.test.mjs`, `tests/test-content.test.mjs`
- Modify: `netlify/lib/portal/admin-api.mjs`, `netlify/functions/portal-admin.mjs`

**Interfaces:**

- Consumes: T1 action contract and `readJson(request,{maxBytes})`; RPC names from T5, T6, T7 (`portal_feedback_attachment_get`); `backend.signDownload`.
- Produces: `validateTestContent(model) → { lines: number }` in `test-content.mjs`: throws `portal:invalid` unless `format` is `quadrion-test-content/1`, every line id matches the pattern and is unique, and every HTML string (`intro`, `notes`, `html`, `sub`, `guide[].html`) uses only `p, ul, ol, li, pre, b, i, code, h4, details, summary` and `<a href="https://…" target="_blank" rel="noreferrer">`.
- Produces: `formatForAgent(items, { origin, now, link: (attachment) => Promise<string> }) → Promise<string>` in `feedback-export.mjs`. Header: `# Quadrion open bugs (<n>)`, a line with the date, and `Report back by item number, for example: "#12 fixed in 0.26.0".` Per item: `## #<number> <title>`, then `Priority`, `Build`, `Reported by: tester` (role only), `Test line:` with `plain` and its sub-steps, `What the tester saw:`, `Thread:` (`role: text` per event), `Attachments:` with links. All tester text goes inside fenced blocks whose fence is longer than any backtick run in the text. No items: the header plus `No open bugs in this filter.`
- Produces: `createFeedbackAdminActions({config, backend, clock}) → (action, {request, url, user, member}) => Promise<object>`; `admin-api.mjs` takes an optional `feedback` option and routes the T1 admin feedback actions to it before its own `not_found`. Owner only: `testContentUpload` (`maxBytes` 4,000,000; `validateTestContent` before the RPC), `testImport` (`maxBytes` 1,000,000; body `{testerId, file}` where `file.format` is `quadrion-test-results/1`), `memberTester`. Admin: the rest. `feedbackExport` returns `{text, count, expiresIn: 86400}` and signs each attachment with ttl 86400; `feedbackAttachmentUrl` signs with 300.

- [ ] **Step 1: Write the failing tests.** `tests/test-content.test.mjs`: `accepts the made-up fixture model`; `refuses script, img, on* attributes and javascript: links`; `refuses duplicate or malformed line ids`. `tests/feedback-export.test.mjs`: `formatForAgent fences tester text and handles an empty list` (Review Focus 5: a body with three backticks and `## #99` stays inside a four-backtick fence; empty list gives the header and the sentence); `lists items in the given order with role labels only`. `tests/netlify/portal-feedback-admin.test.mjs` (fixture style of `tests/netlify/portal-admin.test.mjs`): `members get 403 and no RPC runs`; `admins triage but only owners upload content, import or set the tester flag`; `the actor comes from Auth and extra keys are refused`; `content over 4 MB is too_large and over 32 KB is fine for upload only`; `only the export signs links for 24 hours`.
- [ ] **Step 2: Run** `node --test tests/test-content.test.mjs tests/feedback-export.test.mjs tests/netlify/portal-feedback-admin.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules, the `feedback` hook in `admin-api.mjs` and its wiring in `netlify/functions/portal-admin.mjs`.
- [ ] **Step 4: Run** the three files, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): owner feedback actions and Copy for AI export`.

### Task 9: Shared client helpers and preview fixtures (web)

**Files:**

- Create: `portal/src/feedback-ui.mjs`, `tests/feedback-ui.test.mjs`
- Modify: `scripts/portal-preview.mjs`

**Interfaces:**

- Consumes: `el` from `portal/src/ui.mjs`; T1 action names.
- Produces (pure, unit tested): `STATUS_LABELS` (`new` "New", `triaged` "In the queue", `question` "Question for you" / "Waiting on tester", `fixed` "Fixed, re-check", `confirmed` "Confirmed", `reopened` "Sent back", `parked` "Parked", `declined` "Declined", `merged` "Merged"); `statusLabel(status, viewer)` with viewer `'tester'|'owner'`; `buildLabel(build)` (`unknown` → "build not recorded"); `prefillFromQuery(search) → {kind:'bug', build, screen}` (drops invalid values by the Global Constraints patterns); `buildSuggestions(releases) → string[]` (app releases, newest first, unique); `attachmentKind(file) → {ok:true, mime} | {ok:false, reason}` (types and caps of T7; reasons "PNG, JPG, WebP, MP4, WebM or ZIP only" and "Larger than <cap>"); `testerMessage({fixes, features, build, origin}) → string` (`3 fixes in 0.26.0 are ready to re-check: https://quadrion.ai/portal/tests/`; one item: `1 fix in 0.26.0 is ready to re-check: …`; features: `2 features built in 0.26.0 are ready to try: …`; both: joined with `; `).
- Produces (DOM): `threadView(events)`, `attachmentView({api, action, attachment})` (asks for a signed URL, checks `https:` and host `oxjrkodcmflxejdwsuac.supabase.co` as `member.mjs` does, renders `img` or `video controls`, or a download link for ZIP), `statusBadge(status, viewer)`.
- Preview: `scripts/portal-preview.mjs` answers `/api/portal-feedback` and the admin feedback actions with made-up fixture data (two stages, five lines, three items in different states) so T11 and T12 can be checked in a browser.

- [ ] **Step 1: Write the failing tests:** `attachmentKind refuses unsupported or oversized files` (Review Focus 4: `text/plain`, a 10,000,001-byte PNG, `.heic`; accepts a small PNG and a 90 MB MP4); `testerMessage words one, many, features and both`; `prefillFromQuery keeps a valid build and screen and drops the rest`; `buildLabel names unknown builds`.
- [ ] **Step 2: Run** `node --test tests/feedback-ui.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the module and the preview fixtures.
- [ ] **Step 4: Run** the test, `npm test`, `npm run build:portal`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): shared feedback client helpers and preview fixtures`.

### Task 10: Tester endpoint `/api/portal-feedback` (web)

**Files:**

- Create: `netlify/lib/portal/feedback-api.mjs`, `netlify/functions/portal-feedback.mjs`, `tests/netlify/portal-feedback.test.mjs`
- Modify: `tests/pwa.test.mjs`

**Interfaces:**

- Consumes: T1 (`isTester`, `memberDto`, `readJson`, action names), T7 `createFeedbackUploads`, RPC names of T5 and T6.
- Produces: `createFeedbackHandler({config, backend, clock = Date.now, attachments})`, same frame as `createMemberHandler`: `available`, `checkOrigin`, `identity`, `account`, then `isTester` or `forbidden`. GET `content` → `portal_tests_content`; `answers`; `mine`; `item?id=`; `counts`. POST `answer {lineId, status, comment, build}`; `create {kind, title, body, lineId, build, screen}`; `act {id, revision, action, body, build}`; attachment actions to `attachments`. Field checks use the Global Constraints patterns; comment ≤8000, body ≤16000, title ≤200. `netlify/functions/portal-feedback.mjs` wires it with `config={path:'/api/portal-feedback'}`.

- [ ] **Step 1: Write the failing tests** (fake backend, as `tests/netlify/portal-member.test.mjs`): `preview deploys return 503 and touch no provider`; `a logged-out request gets 401 and no data`; `a member without the tester flag gets 403 before any RPC`; `the actor comes from the token; p_actor or userId in a body is refused`; `invalid line ids, builds and screens are refused`; `item ids are uuids`. In `tests/pwa.test.mjs` add `['/api/portal-feedback']` to the bypass list.
- [ ] **Step 2: Run** `node --test tests/netlify/portal-feedback.test.mjs tests/pwa.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the handler and the function file.
- [ ] **Step 4: Run** both, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): tester feedback endpoint`.

### Task 11: Tester pages, nav badge and login return-to (web)

Load the `impeccable` and `frontend-design` skills first; follow the portal's existing look (`portal/src/portal.css`).

**Files:**

- Create: `portal/src/tests.mjs`, `portal/src/tests.css`, `tests/portal-tests-client.test.mjs`
- Modify: `portal/src/member.mjs`, `portal/src/auth.mjs`, `portal/src/routing.mjs`, `tests/portal-routing.test.mjs`

**Interfaces:**

- Consumes: T1 `createPortalApi({scope:'feedback'})`; T9 helpers.
- Produces: `loginDestination(role, path = '')`: when `path` (pathname plus search) starts with `/portal/report` or `/portal/tests/` it is returned unchanged for `member`, `admin` and `owner`; anything else (another origin, `//`, `/admin/…`) falls back to today's answer. `auth.mjs` `enterWorkspace` passes `location.pathname + location.search`.
- Produces: `renderTests(ctx)` and `renderReport(ctx)` exported from `tests.mjs`, `ctx = {content, api, member, releases, navigate, ticket, current}`; `member.mjs` routes `/portal/tests/` and `/portal/report/` (and `/portal/report`) to them, adds a "Tests" nav item with a count badge from `counts` for members with `tester`, and gives the feedback API its own `onDenied` that clears the workspace only on 401 or 403. Non-testers who open these paths see an empty state: "This area is for Quadrion testers."
- Page parts (design, "Tester page"): Waiting for you (fixed items with Confirm on a build and Send back with comment; questions with an answer box); My tests (stages and groups, pass/fail/skip, comment, build field with `buildSuggestions` in a `datalist`, latest preselected, attach or paste a screenshot, "Request a feature about this"); progress per group; My reports (status badge, thread, comment box); Request a feature (title, description, optional attachment). The report form: kind bug, build and screen prefilled from `prefillFromQuery`, title, what happened, steps, attachment (the diagnostics ZIP or a screenshot). Ctrl+V into either form attaches an image from the clipboard after `attachmentKind`. A `conflict` on an answer shows "This line was changed or retired. Reload the tests." with a Reload button.

- [ ] **Step 1: Write the failing tests.** `tests/portal-routing.test.mjs`: `loginDestination keeps an allowed deep link for every role` (Review Focus 3: owner with `/portal/report/?build=0.26.0&screen=scene:map` keeps it; `//evil.example/` and `/admin/users/` fall back; old cases unchanged). `tests/portal-tests-client.test.mjs` (the `compileFunction` approach of `tests/portal-admin-client.test.mjs`, or pure helpers exported from `tests.mjs`): `the waiting list puts fixed items before questions`; `a failed answer without a comment is not sent`; `an answer conflict shows the reload notice`.
- [ ] **Step 2: Run** `node --test tests/portal-routing.test.mjs tests/portal-tests-client.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the pages, routes, badge and return-to.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run build:portal`, `npm run check:public`. Expected: PASS.
- [ ] **Step 5: Check in a browser** with `node scripts/portal-preview.mjs` at 1280 px and 360 px wide: `/portal/tests/` and `/portal/report/?build=0.26.0&screen=scene:map` render, keyboard focus moves to the `h1`, no horizontal scroll. Expected: as described; screenshots looked at, not committed.
- [ ] **Step 6: Commit** `feat(portal): tester pages, report form and Waiting for you`.

### Task 12: Owner pages and the Users tester toggle (web)

Load the `impeccable` and `frontend-design` skills first; follow `portal/src/admin.css`.

**Files:**

- Create: `portal/src/feedback-admin.mjs`, `portal/src/feedback-admin.css`, `tests/portal-feedback-admin-client.test.mjs`
- Modify: `portal/src/admin.mjs`

**Interfaces:**

- Consumes: T1 admin actions; T9 helpers.
- Produces: `renderInbox(ctx)`, `renderProgress(ctx)`, `renderContent(ctx)` exported from `feedback-admin.mjs`; `admin.mjs` adds a "Feedback" nav item with a badge from `feedbackCounts` and routes `/admin/feedback/`, `/admin/feedback/progress/`, `/admin/feedback/content/`. The Manage user dialog gains a "Tester" checkbox for owners, saved through `memberTester` with the row's `revision`.
- Inbox: filters (tester, kind, status, priority, build) kept in the query string; rows sorted as returned; multi-select; item dialog with thread, line text (or "retired line"), attachments via `attachmentView`, and the actions Set priority, Ask a question, Comment, Park, Decline (reason required), Restore, Mark fixed in build, Merge into (pick an item number). Opening an item sends `seen`. Over the list: "Copy for AI" (`feedbackExport` with the current filter, `navigator.clipboard.writeText`, then "Copied <n> bugs. Links work for 24 hours."), "Mark fixed" for the selection (`feedbackBulkFix`), then "Copy message for testers" (`testerMessage`). Progress: per tester and per stage counts and last build (`buildLabel`), plus retired answers. Content: current version and line count, "Upload test content" (a `.json` file read in the browser, posted as is; the server validates), and "Import answers" (choose a results file, pick the member for its `tester` id from the list of members with the tester flag, show the returned counts).

- [ ] **Step 1: Write the failing tests:** `Copy for AI copies the export text for the current filter` (fake api records `feedbackExport` params equal to the parsed query); `bulk fix sends the selected ids and then offers the tester message`; `the tester checkbox shows for owners only`.
- [ ] **Step 2: Run** `node --test tests/portal-feedback-admin-client.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the pages and the toggle.
- [ ] **Step 4: Run** the tests, `npm test`, `npm run build:portal`, `npm run check:public`. Expected: PASS.
- [ ] **Step 5: Check in a browser** with `node scripts/portal-preview.mjs --admin` at 1280 px and 360 px: inbox, item dialog, progress and content pages render; Copy for AI fills the clipboard with the fixture text. Expected: as described.
- [ ] **Step 6: Commit** `feat(admin): feedback inbox, progress and test content pages`.

### Task 13: The whole loop on PGlite (web)

The design asks for an end to end path on a local Supabase. The website has no local Supabase stack, so this test runs the real handlers (T8, T10) against the real SQL in PGlite, with Auth and Storage faked at the backend edge. A browser-level run stays manual (T14).

**Files:**

- Create: `tests/helpers/pglite-backend.mjs`, `tests/feedback-loop.test.mjs`

**Interfaces:**

- Consumes: `portalDb({testers:true})`, `createFeedbackHandler`, `createAdminHandler` with `feedback`, `createFeedbackUploads`.
- Produces: `pgliteBackend(db, {tokens})`: `verifyUser(token)` maps a fixture token to `{userId, email, emailConfirmed:true, aal:'aal1'}`; `account(userId)` and `rpc(name, args)` run `select public.<name>(<key> => $n, …)` with the named arguments; `service.storage` is an in-memory fake whose `info` returns the uploaded size; `signDownload` returns `https://oxjrkodcmflxejdwsuac.supabase.co/storage/v1/object/sign/<path>?ttl=<ttl>`.

- [ ] **Step 1: Write the test** `report, fix, notify and confirm through the real handlers`: owner uploads the made-up content; tester A fails a line with a comment and the build `0.25.0`; owner `feedbackCounts.inbox` is 1, opens the item, sets `high`, marks fixed in `0.26.0`; tester A `counts.waiting` is 1; A confirms on `0.26.0`; the item is `confirmed` and A's answer is `pass` on `0.26.0`. Then `send back, merge and confirm by both`: B raises the same bug from the report form (`screen: 'scene:map'`); owner merges it into A's reopened item and fixes it; both see it waiting; A's confirm leaves it `fixed`; B's confirm closes it. Then `permissions hold end to end`: B reading A's first item gets 404; B calling `feedbackInbox` gets 403; the outsider calling `content` gets 403; no token gets 401 with no item text in the body.
- [ ] **Step 2: Run** `node --test tests/feedback-loop.test.mjs`. Expected: PASS on the first run if T5 to T10 are right; any failure is a bug in those tasks, fixed there with a test.
- [ ] **Step 3: Run** `npm test`, `npm run build:portal`, `npm run check:public`, `git diff --check`. Expected: all green.
- [ ] **Step 4: Commit** `test(portal): the feedback loop through real handlers and SQL`.

### Task 14: Operations doc, How to test and deploy steps (both)

**Files:**

- Modify: website `docs/portal-operations.md` (new section "Tester feedback, 25 October 2026")
- AIO: the session note and north-star refresh through `/wrapup` on this branch

- [ ] **Step 1: Write the website doc section:** what was added, the five migrations in order, the new bucket, the endpoints, the 24-hour export links, the caps, and the audit query below. Run `npm run check:public` and read the text for names.
- [ ] **Step 2: Run** `node tools/agent/check-public-text.mjs` on the AIO plan, design and session note. Expected: no findings.
- [ ] **Step 3: Commit** website `docs(portal): tester feedback operations`; AIO via `/wrapup`.
- [ ] **Step 4: Hand over.** AIO: `node tools/agent/finish-task.mjs`, then SendMessage the coordinator (branch, head SHA, T3 and T4 contents, check and e2e results, How to test steps 12 and 13). Website: tell the founder the branch is ready to push.

**Deploy steps (founder, by hand):**

1. Supabase SQL editor, project `oxjrkodcmflxejdwsuac`: run `202610250001` to `202610250005` in order, each as one script; each must end without error (the bucket script raises if the bucket is missing). Then check: the seven new tables show RLS enabled and forced, and `anon` and `authenticated` hold no grant on them or on any `portal_feedback_*` / `portal_tests_*` function.
2. Push the website branch: `! git -C "E:/Dev/quadrion-web-tester-feedback" push -u origin feat/tester-feedback`, open the pull request, merge it once its checks pass. The SQL must be live before the deploy publishes. Deploy previews answer 503 by design.
3. Admin → Users → Manage → tick **Tester** for each tester (and yourself, to try it).
4. Build the content: `node tools/test-board/build.mjs --private "E:\Stratlas Data\test-board" --json`, then Admin → Feedback → Content → **Upload test content** with `tools/test-board/dist/test-content.json`.
5. Import the old answers: a Claude session exports the Artifact store (`results/<tester>/items`) through ArtifactData into an `artifact-db-export` file in the private folder, then `node tools/test-board/export-artifact.mjs <file> --out "E:\Stratlas Data\test-board\results"`. For each results file (exported or emailed): Admin → Feedback → Content → **Import answers**, pick the member for its tester id, check the counts.
6. Tell the testers the new address (`https://quadrion.ai/portal/tests/`). Keep the Artifact board and standalone file until you say they can go.
7. The AIO branch lands through the merge coordinator; the button reaches testers with the next installer.

**How to test (founder):**

1. Sign in as owner at `https://quadrion.ai/portal/?login`. Admin opens. Users → Manage on a test member → tick Tester → Save. The row shows Tester.
2. Feedback → Content → Upload test content → choose the JSON. It reads "Version 1, <n> lines".
3. In a private window sign in as that tester. The sidebar shows **Tests**. Open it: the stages and groups match the old board.
4. Pick build 0.25.0, mark a line Fail with a comment, paste a screenshot (Ctrl+V). It reads "Bug #1 opened" and My reports lists it as New.
5. On another line choose "Request a feature about this", write a title, send. My reports shows the feature.
6. Owner window: Feedback shows a badge of 2. Open #1: line text, comment and screenshot show. Set High, then Ask a question. Tester: Waiting for you shows the question; answer it. Owner: #1 is back In the queue with the answer in its thread.
7. Owner: Copy for AI. Paste into a text editor: a header, then #1 with its line, sub-steps, comment, thread and a screenshot link that opens.
8. Owner: tick #1, Mark fixed in 0.26.0, then Copy message for testers. The text reads "1 fix in 0.26.0 is ready to re-check: https://quadrion.ai/portal/tests/".
9. Tester: the Tests badge shows 1. Waiting for you → Confirm on 0.26.0. #1 is Confirmed and its line shows Pass on 0.26.0.
10. Send back: fail another line, owner marks it fixed, tester chooses Send back with a comment. Owner: it is Sent back at its old priority.
11. Merge (needs a second tester): both fail the same line; owner opens one and Merge into the other; mark fixed. Both testers see it waiting; it closes only after both confirm.
12. Spot checks: as the tester, open `/admin/feedback/`: no access. Sign out, open `/portal/tests/`: the login shows, and after signing in you are back on `/portal/tests/`.
13. In the app (after the AIO branch lands): Ctrl+K → Report a problem → write a sentence → Save report → **Send to Quadrion**. The browser opens `/portal/report/?build=<version>&screen=<screen>`; sign in if asked; the form shows the build and screen. Attach the saved ZIP, send. It appears in the owner inbox.
14. Feedback → Progress: per tester and per vertical counts, last build; imported answers say "build not recorded".
15. After step 5 of the deploy: the imported fails appear as bugs with build not recorded, and a second import of the same file adds nothing.
