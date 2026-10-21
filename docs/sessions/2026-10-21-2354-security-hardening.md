---
type: session
date: 2026-10-21-2354
branch: fix/sec-hardening
status: complete
related:
  [
    architecture/adr/0014-team-trust-genesis-pin.md,
    architecture/contract-changes.md,
    release/SECURITY-AND-DATA.md,
    server/README.md,
  ]
---

# Security hardening: every audit finding fixed

## What changed

- This PR (`fix/sec-hardening`, 43 commits) fixes every finding of the security audit of 21 Oct 2026 (Electron shell, untrusted files and processes, Team Server, journal and identity, AI, dependencies).
- Team Server: the actor is bound at enrolment (Critical: any invitee could enrol as the owner); journal-revoked devices cannot read; per-chain monotonic clocks; pushes judged with the journal's `judgeOp`/`orderForTeam`/`teamFences` (parity test over 25 arrival orders); the client pins the server's Ed25519 key and verifies receipts; auth before body parse (8 MB cap); per-project blobs with quotas and partial-upload expiry; non-superuser `aio_app` role (migrations 002, 003); `AIO_TRUSTED_PROXIES`; persisted nonces; re-enrolment keeps role and actor.
- Journal trust (ADR 0014): an owner-signed genesis pin in `team.json` closes the backdated bootstrap-owner takeover (older projects pinned on first sync, Verify says `team-unpinned` until then); clock-back ops held; revoke, remove and demote record `seen` heads; device records bound to their id; `.aiosync` checks membership before writing; Verify counts only owner revokes; strict JSON; AI policy fails closed; prototype-key hardening in merge and journal.
- Desktop shell: data folder only from main's dialog (local directory only), `showFolder` opens folders only; pack install path from main only, Ed25519-checked once `signing.pipelinePackKey` is set, else an unsigned-code confirmation; updates https only with an exact `signing.windowsPublisher` match (empty, so no auto-install yet), optional feed signature, macOS codesign/spctl, private copy before verifying; dev switches scrubbed when packaged; IPC sender frame checked; CSP `frame-src`/`object-src 'none'`; openExternal host allowlist; UNC `file:` blocked; fuse check (`tools/release/check-fuses.mjs`); deep-link package open confirms.
- Data inputs: `AssetRef` containment and shared `resolveInside`/`requireInside` (`@aio/project/fs`; fixes the mask-export arbitrary file read); CSV formula guard (`csvText`, Python `csvsafe`); volumetric pickle replaced by npz; inflate caps; `programPath`/`systemProgram` (no current-folder lookups); stricter `.aio` member names; sidecar env allowlist; review-board Host/Origin checks; kit import containment; Python `safe_project_path` resolves links, haul, OPF and thermal readers contained; pillow 13.0.0, certifi 2026.10.19, vite 8.3.5.
- Verified: `pnpm check` green (14311 tests; one load timeout passes alone), Python 2516 passed (one ODM cancel timing flake passes alone), e2e the CI way 31 specs, 73 tests passed.

## Why

The audit found an owner takeover on the Team Server and in the journal, an arbitrary file read through mask export, and several paths from untrusted files or links to code execution. Each fix stays additive on the wire (`aio.sync/1` unchanged).

## How to test

1. Settings, Processing tools, Install or update from file, Choose file: pick a pack. A dialog "Install processing tools <version>? They are not signed." appears with Cancel as the default button.
2. Settings, Data folder, Change folder: the folder dialog is the only way in; pick a folder and the library reloads; Cancel leaves it unchanged.
3. Issues, Export, Masks ZIP on a project with masks: the ZIP holds only the project's masks and overlays under `masks/` plus `masks.json`, nothing from outside the project folder.
4. Create an issue titled `=1+1`, then Issues, Export, Issues CSV, and open the file in Excel: the cell shows `=1+1` as text, not 2.
5. Share a project (Make this a team project, Share), then open the Audit trail and press Verify: no "does not record which change made the first owner" problem on the owner's computer.
6. Open an older shared project: it opens normally; after one sync, Verify no longer shows that problem.
7. Click a web link to a package: a dialog "A link asks Quadrion AI to open a package." asks Open or Cancel.

## Open threads

- Founder: set `signing.windowsPublisher` after buying the Authenticode certificate (checklist row added) and `signing.macTeamId` with an Apple account; generate the update-feed and pipeline-pack Ed25519 keys (`node tools/release/ed25519.mjs keygen`), keep them offline, put the public keys in `brand.json`.
- Rebuild the pipeline pack (pillow 13, the pickle fix, Python CSV guard); re-lock conda ca-certificates (still 2026.7.22) in `tools/pipeline-pack/*-lock.json`.
- Existing Team Server installs: manual `CREATE ROLE aio_app` plus `APP_DB_PASSWORD` (`server/README.md`); switch on `AIO_REQUIRE_SIGNED_HEADERS` once every app is updated.
- Parked: a server route to upload the signed `team.json`; the genesis in the invite and identity-card flow; the server running `@aio/merge` gate rules; a Settings field error for an http update URL; website-delivered kits unconfirmed until the pack key exists; the `readAiPolicyDetail` reason in the AI panel; electron-builder's http-cache-semantics and sprintf-js (build tools only) have no patch yet.
- User-visible: held offline ops after a revoke or demotion (owner can release), held pre-share edits from a never-member device, a project whose asset path leaves its folder fails to load, links to other hosts do not open, no self-installed update until the publisher is set.

## Next session entry point

Hand this PR to the stage-island train with `finish-task`; then the founder key and certificate steps above and the pack rebuild.
