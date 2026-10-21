# Website automatic updates implementation plan

**Goal:** Background checks and downloads for app and processing kit, with user-controlled safe restart.
**Architecture:** Authenticated website manifest plus separate main-process staging coordinator, existing verified NSIS rollback, hidden managed kits and a shared renderer status store.
**Tech stack:** Electron/TypeScript/Zod/Vitest, React, Netlify JavaScript, Supabase PostgreSQL, Node tests/PGlite.
**Spec:** ../specs/2026-10-21-website-auto-updates.md

## Global constraints

- Implement the approved automatic check/download and explicit restart behavior for both components.
- Offline-only means no updater network. Sign-out/disable cancels pending work; stale completions cannot publish state.
- Credentials stay main-process/vault only; no tokens/signed URLs in persisted plans, renderer state or logs.
- Published, verified, compatible Windows x64 artifacts only. The API contract is exact as in the spec.
- No active kit changes during staging. Reverify before apply. Jobs and updater share a gate. Preserve app and kit recovery.
- No main checkout edits, no production mutations, no installer build, no main push. Only scoped commits, no hook bypass.
- TypeScript strict, no any/non-null assertions, additive IPC through @aio/schema, brand from @aio/brand, no em/en dash in user copy.

## Execution DAG

1 Website provider and admin metadata; independent repo.
2 Desktop contracts, auth, coordinator and main integration; consumes frozen website contract.
3 Desktop UI and Electron coverage; depends on task 2 schema becoming available, owns renderer/e2e only.
4 Integration validation, contract docs/ADR/session handoff and independent review; depends on all.

Parallel batch: tasks 1 and 2 have no shared files; task 3 may run once task 2 contracts are published with no shared file ownership. Critical path: 2 -> 3 -> 4. This repository explicitly requests independent parallel work; separate ownership prevents conflicts.

## Task 1: Website provider

Worktree E:/Dev/Quadrion-Auto-Updates; branch codex/desktop-auto-updates based on f70a791 (upload-fix PR dependency). Own all website files only. Implement exact spec API, migration + service-only candidates RPC, draft metadata create/edit and publish guards, admin form with established UI, tar.gz uploads, tests/docs. Use existing download grant unmodified. Support only explicit initial Windows x64 packages for auto updates. Keep historical releases manual. Add semver library if needed, proper lockfile. Tests must demonstrate unauthorized users cannot obtain metadata, archived/legacy/unverified releases excluded, numeric version order, no reservation during check, pair compatibility, draft edits/revision and malformed/publish rejection. Run npm test, npm run build:portal, npm run check:public. Commit scoped files; write report with commands/counts and migration deployment requirements. No live migration/deploy/push yet.

## Task 2: Desktop backend and contracts

Worktree C:/Users/D/.codex/worktrees/website-auto-updates/AIO Software; branch feat/website-auto-updates; base ecd64c7. Own packages/schema, apps/desktop/src/main, apps/desktop/src/preload only. Create additive contracts first and report their exact shape to controller before implementation, enabling task 3. Prefer dedicated `websiteUpdate:*` IPC to preserve existing updater/manual API. Status snapshot/event includes account email (no secret), phase, component versions/notes/progress, error, restart availability/reason and kit recovery availability. Commands account signIn/signOut, check/retry, restart and rollbackKit as needed; settings explicit websiteAutoUpdate boolean with true default, existing offlineOnly applies.

Implement main-only website client/auth with OS-vault refresh credential, isolated session fetch, fixed trusted website origin, strict response validation and current membership; refresh token rotation atomically. Downloads by artifact/digest with abort and bounded retries, grant validation, no bearer leak; reuse downloadVerified. Persistent state validates paths/digests and target versions on reload. Stage app and kit independently but advertise ready only complete. Managed kit namespace separate from legacy scan, compatible app-version selector. Preserve environment/manual kit behavior and prior selection on failed app install/rollback. Install kit-only on explicit restart and keep a recoverable prior selection. Integrate coordinator lifecycle and settings cancellation, scheduler, snapshot/event, active/pending-job/installation/work gate. All restart entry points involved in new flow use gate and actual live-work state, not just renderer job display. Existing rollback has priority on startup. No network in offline mode, ready stage can apply locally offline. Unit test injected network/storage/clock/installer, full transaction recovery, compatibility, gate races and policy changes. Run focused tests/typecheck and commit only owned files. No renderer edits and no docs beyond report.

## Task 3: Desktop interface

Own apps/desktop/src/renderer and apps/desktop/e2e only. Consume task 2's additive contracts; do not edit main/schema/preload. Existing product context and shared design components are binding. Build a shared status store, Settings About account/automatic-update panel and quiet global ready notice with details. Separate automatic background transfer from explicit Restart and update; errors actionable, accessible progress, offline policy and unsupported-build limitation shown. Preserve manual installer and old-feed features (advanced if necessary) and current rollback. Sign-in password is never persisted and cleared on completion. No external network from renderer. UI must remain useful when mounted mid-download and after navigation. Add meaningful store/component tests and synthetic Electron update flow in e2e/website-updates.spec.ts (account, progress, ready, explicit restart refusal while work runs, offline network blocked). Run in CI geometry/display scale/WARP with demos built; no real account/files or actual installer launch. Commit owned changes and report.

## Task 4: Review and handoff

Review each owned task diff then cross-repo contract and full branch. Fix important findings through implementers, rerun covering tests. Run desktop pnpm check and relevant Electron specs, website full tests/build/public scan. Update ADR0003 with new behavior, contract change row, session note and NORTH-STAR current state. Add deployment ordering (website migration/function first, new desktop bootstrap installation, then published eligible releases), app/kit release preparation metadata and honest limits. Verify docs public names check. Create draft PRs on feature branches, attach both, include dependency on website upload-fix PR13 if still unmerged; inspect CI. No production publish or main merge.
