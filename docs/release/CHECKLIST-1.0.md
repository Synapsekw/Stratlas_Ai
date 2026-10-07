# 1.0 checklist

Living document for the M9 release, owned by stream T8. Every row must be **Done** before the tag `v1.0.0`. Gates come from the "1.0 checklist" in `docs/plans/2026-10-07-m9-team-and-1.0.md`; the per-release steps (build, sign, publish) stay in [CHECKLIST.md](CHECKLIST.md).

Status values: **Done**, **Partly** (some of it is in place), **Open** (not started), **Blocked** (waiting for a founder decision or an outside party). Owners are streams (T1 to T8), the integration lead (IL) or the founder (F).

_Last updated: 7 Oct 2026 (T8 part 1; M9 integration fixes and docs)._

## Founder blockers

These need the founder before release candidate 1 (RC1). Each has a default the team works to meanwhile.

| #   | What                                                                                                                                    | Needed by           | Default meanwhile                                                                            | Status  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- | ------- |
| B1  | Final product name in `packages/brand/brand.json` (decision 10): Store listing, installers, file associations, docs                     | RC1                 | "Stratlas" (temporary). No file format carries the name (`aio-hub.json`, `.aio`, `.aiosync`) | Blocked |
| B2  | Windows OV code-signing certificate in a cloud HSM and `WIN_SIGN_COMMAND` (or Azure Trusted Signing) in GitHub secrets (decision 13)    | RC1                 | Unsigned test builds; TESTING stage M7 still says "Waiting for signing"                      | Blocked |
| B3  | Partner Center company account and the reserved Store name (decision 13)                                                                | RC1                 | MSIX built with placeholder identity, not submitted                                          | Blocked |
| B4  | Apple Developer organisation (D-U-N-S number), Developer ID certificate and notarisation credentials (decision 13)                      | RC1 (macOS)         | Ad-hoc signed DMG for testing                                                                | Blocked |
| B5  | Cosign key for the Team Server image (decision 13)                                                                                      | Team Server preview | Image unsigned, preview only                                                                 | Blocked |
| B6  | External penetration test of the Team Server, booked with a date (decision 14)                                                          | Leaving preview     | `HostingModel.server` stays `preview`; the security note says so                             | Blocked |
| B7  | Arabic scope for 1.0 (decision 11): confirm "Arabic text and right-to-left panels, full Arabic interface after 1.0", or name the tender | RC1                 | Arabic text in comments, names and reports, RTL panels; no Arabic UI                         | Blocked |
| B8  | Dates for B2 to B6, and sign-off of ADRs 0005 and 0006 and of the support policy draft                                                  | RC1                 | Drafts as written                                                                            | Blocked |
| B9  | Sign-off of ADR 0004 (sync architecture: file-first sharing, team server as a preview)                                                  | M9                  | Accepted 7 Oct 2026 (founder)                                                                | Done    |

## Stability

| Gate                                                                        | Owner  | Status | Evidence or next step                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No open P1 or P2 bugs                                                       | IL     | Open   | Triage after all streams merge                                                                                                                                                                                                                                                                                                                                                                         |
| Three consecutive green nightly runs, Windows and macOS, zero flaky retries | IL     | Open   | CI already fails on a flaky test (`failOnFlakyTests`)                                                                                                                                                                                                                                                                                                                                                  |
| Soak test flat (200 open cycles, heap and handles within 10 %)              | T8, IL | Open   | `apps/desktop/e2e/soak.spec.ts` (`QUADRION_SOAK=1`) finds a leak: the renderer heap grows about 6 MB a cycle (see "Soak findings"). P2 for the maps owner; then a nightly job with the full 200 cycles                                                                                                                                                                                                 |
| Kill-during-write test for every writer (journal and atomic JSON)           | T8, T1 | Done   | `tools/compat/kill-write.test.mjs`: `writeJsonAtomic` never leaves a half file, and its `.bak` is now copied to a temp file and renamed (`apps/desktop/src/main/fsutil.ts`), so a kill leaves the old or the new `.bak`, never a torn one (longer run with `QUADRION_KILL_BAK=1`). The journal appender is killed mid-append too (`kill-journal-writer.mjs`): every earlier op stays whole and chained |
| Fuzzing of every JSON and exchange reader                                   | T8, T5 | Partly | `tools/compat/fuzz.test.mjs`: the project loaders (manifest, issues, volumes, boundaries, narrative, change sets, detections, conversations) and the pure parsers answer every malformed input and never write. Exchange (`.aiosync`) readers: T5. fast-check would widen it (not a dependency yet)                                                                                                    |
| Founder test window of five working days on RC builds with no crash notice  | F      | Open   | After RC1                                                                                                                                                                                                                                                                                                                                                                                              |

## Data migration and upgrade

| Gate                                                                                                                             | Owner  | Status | Evidence or next step                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version registry for every file schema                                                                                           | T8     | Done   | `packages/schema/src/versions.ts` (`SCHEMA_REGISTRY`, 49 families with the build that introduced each); a test fails on any `aio.*` id in the code without a row                                                                                                                                                                                                                                                                                                                    |
| "Saved by a newer Stratlas" for every reader                                                                                     | T8, IL | Done   | `readVersioned` and `newerRefusal` refuse a newer file and change nothing (tested for every corpus file). Manifest, package header and road refused already; the six readers that could overwrite a newer file (`ai-projects.json`, `change/*.json`, `report/narrative.json`, `detections/*.json`, `updates/journal.json`, `library.json`) refuse it through `apps/desktop/src/main/newer.ts` since the M9 integration, see [UPGRADE-POLICY.md](UPGRADE-POLICY.md), "Reader wiring" |
| Compatibility corpus 0.4 to 0.9 opens in 1.0 with nothing lost                                                                   | T8     | Done   | `tools/compat/corpus/` built from each milestone's own schema; `tools/compat/corpus.test.mjs`                                                                                                                                                                                                                                                                                                                                                                                       |
| 1.0 output parses with the 0.8 schema                                                                                            | T8     | Done   | `tools/compat/schema-0.8/` (extracted from 0.8.0); every corpus file this build writes parses with it, nothing lost; `upgrade.spec.ts` checks a project edited in the app                                                                                                                                                                                                                                                                                                           |
| Settings migration tested (an 0.8 build reads 0.9 settings)                                                                      | T8     | Done   | Later report sections are kept in `reportSectionsExtra`; `tools/compat/settings-0.8.test.mjs`. Contract row proposed                                                                                                                                                                                                                                                                                                                                                                |
| Library and identity migrations tested                                                                                           | T8, T2 | Open   | Identity: T2's `identity:set` `migrateFrom`. Library: `library.json` is `aio.library/1` since 0.9 (a file without an id reads as /1; a newer one is refused)                                                                                                                                                                                                                                                                                                                        |
| Written policy: 1.x reads every `/1` file; a `/2` comes with a migrator, a one-time Upgrade project with a backup, and a warning | T8     | Done   | [UPGRADE-POLICY.md](UPGRADE-POLICY.md); the migrator chain is in `versions.ts` (`MIGRATIONS`, empty in 1.0)                                                                                                                                                                                                                                                                                                                                                                         |
| Pipeline pack `appRange` enforced                                                                                                | T8, IL | Done   | The pack reports `appRange` (`>=0.9.0 <2.0.0`) in `--version`, the `version` method and its `manifest.json`; `main/jobs/pack.ts` refuses a pack outside the range with `packRangeRefusal`                                                                                                                                                                                                                                                                                           |

## Docs

| Gate                                                                          | Owner       | Status | Evidence or next step                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User guide chapters 14 to 17; 01, 11, 12 and 13 updated, with e2e screenshots | T8 (part 2) | Partly | Chapters 21 to 27 (identity and team, history and audit, review workflow, exchange files and shared folders, large files, team server, conflicts) and 12 written; screenshots and updates to 01, 11 and 13 to come |
| Team Server admin guide (install, TLS, backup, restore, upgrade, revoke)      | T7, T8      | Done   | [docs/server/README.md](../server/README.md)                                                                                                                                                                       |
| Security and data-handling note for procurement                               | T8          | Partly | [SECURITY-AND-DATA.md](SECURITY-AND-DATA.md), draft; final pass in part 2                                                                                                                                          |
| 1.0 release notes                                                             | T8          | Partly | [RELEASE-NOTES-1.0.md](RELEASE-NOTES-1.0.md), draft                                                                                                                                                                |
| `SUPPORT.md`                                                                  | T8, F       | Partly | [SUPPORT.md](SUPPORT.md), draft for founder sign-off (B8)                                                                                                                                                          |
| KNOWN-LIMITS refreshed; PRD statuses; SPEC and ADRs 0004 to 0006 accepted     | IL, F       | Open   | ADR 0004 accepted 7 Oct 2026 (B9); 0005 and 0006 are drafts; KNOWN-LIMITS has the M9 section                                                                                                                       |
| Licence inventory                                                             | T8          | Done   | [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), `node tools/release/notices.mjs`                                                                                                                                 |

## Signing

| Gate                                                                                             | Owner  | Status  | Evidence or next step                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Windows: OV certificate in a cloud HSM; every exe and DLL signed and timestamped; fuses verified | IL, F  | Blocked | B2                                                                                                                                    |
| macOS: Developer ID, notarised and stapled, universal                                            | IL, F  | Blocked | B4                                                                                                                                    |
| `.aio`, `.aiosync` and `.aioid` file associations                                                | T5, IL | Partly  | In `tools/release/brand-config.mjs`; a double-clicked `.aiosync` opens the import dialog. Check on signed installers (Windows, macOS) |
| Team Server image signed with cosign, with an SBOM                                               | T7, F  | Blocked | B5                                                                                                                                    |

## Store

| Gate                                                                          | Owner | Status  | Evidence or next step                                                                      |
| ----------------------------------------------------------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------ |
| MSIX with the final identity; Windows App Certification Kit passes            | IL    | Blocked | B1, B3                                                                                     |
| Listing updated: 1.0 screenshots, team features, privacy policy covering sync | T8, F | Open    | Part 2; privacy policy draft in `store-listing/privacy-policy.md` needs the sync paragraph |
| Certified, and installed from the Store on a clean machine                    | F     | Blocked | B3                                                                                         |

## Support

| Gate                                                                               | Owner  | Status | Evidence or next step                           |
| ---------------------------------------------------------------------------------- | ------ | ------ | ----------------------------------------------- |
| Support window and response times (decision 12)                                    | T8, F  | Partly | [SUPPORT.md](SUPPORT.md), draft                 |
| 1.0.x hotfix branch and procedure                                                  | T8, IL | Partly | Described in SUPPORT.md; branch made at the tag |
| Stable and beta update feed channels (ADR 0003 feed, two files)                    | IL     | Open   |                                                 |
| Diagnostics bundle: sync and journal status, device id, server version, never keys | IL, T5 | Open   | Integration follow-up D5                        |
| Known-issues page; Team onboarding checklist (hub folder or server)                | T8     | Open   | Part 2                                          |

## Performance pass

| Gate                                                                                | Owner  | Status | Evidence or next step                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M7 tier budgets re-run on 1.0 with the journal on; startup to first frame under 5 s | IL     | Open   | `apps/desktop/e2e/perf.spec.ts`                                                                                                                                                                                    |
| Journal: append under 5 ms at p95                                                   | T1, T8 | Partly | `tools/release/budgets.mjs` with `QUADRION_BUDGETS=1`. The reference bench passes with the segment kept open; reopening the file per op measured about 6 ms on Windows, so T1's appender must keep its handle open |
| 100k-op open under 1 s extra; merge of 10k ops under 3 s; Verify of 100k under 10 s | T1, T4 | Open   | Plug in by exporting `journalBench` from `packages/journal/src/bench.ts`; the tests turn on by themselves                                                                                                          |
| 500 GB project from a hub with on-demand binaries                                   | T6     | Open   |                                                                                                                                                                                                                    |
| Installer within the M7 budget plus at most 5 MB                                    | IL     | Open   | `BUDGETS.installerExtraBytes`                                                                                                                                                                                      |

## Security

| Gate                                                          | Owner  | Status  | Evidence or next step                       |
| ------------------------------------------------------------- | ------ | ------- | ------------------------------------------- |
| STRIDE threat model for sync (ADR appendix)                   | IL     | Open    |                                             |
| IPC validation for every new channel                          | all    | Partly  | Contracts validate every request (`ipc.ts`) |
| Exchange parser fuzzing (traversal, bombs)                    | T5     | Open    |                                             |
| Signature verification mandatory on import                    | T5     | Open    |                                             |
| Vault-only secrets checked by a log and diagnostics scan test | T2, IL | Open    |                                             |
| Server external test before it leaves preview                 | F      | Blocked | B6                                          |

## Licences

| Gate                                                                   | Owner | Status | Evidence or next step                                                                   |
| ---------------------------------------------------------------------- | ----- | ------ | --------------------------------------------------------------------------------------- |
| `app:licenses` lists every new dependency                              | IL    | Done   | Built from the same pnpm report at build time                                           |
| No GPL or AGPL in the app, pipeline pack or server image (scans in CI) | IL    | Done   | `pnpm license:check` (all workspaces, server included); `python/tests/test_licences.py` |

## Brand and accessibility

| Gate                                                                                             | Owner    | Status  | Evidence or next step    |
| ------------------------------------------------------------------------------------------------ | -------- | ------- | ------------------------ |
| Final product name in `brand.json`                                                               | F        | Blocked | B1                       |
| axe passes on Audit, History, My work, Conflicts, Share, Exchange, Files and Team server screens | T1 to T7 | Open    | Integration follow-up D6 |
| Approve, assign and comment work from the keyboard                                               | T3       | Open    |                          |

## Soak findings (7 Oct 2026)

An 80-cycle run of `soak.spec.ts` on the development workstation (Windows, hardware GPU, demo built with `--quick`), opening the three demo projects in turn each cycle, after a forced garbage collection at each sample:

| Measure                                  | Cycle 0 | Cycle 40 | Cycle 79 |
| ---------------------------------------- | ------- | -------- | -------- |
| Main process heap                        | 15 MB   | 16 MB    | 16 MB    |
| Main process active handles and requests | 2       | 1        | 2        |
| Renderer JS heap                         | 34 MB   | 275 MB   | 516 MB   |
| Renderer process working set             | 295 MB  | 1.3 GB   | 2.1 GB   |
| GPU process working set                  | 216 MB  | 275 MB   | 265 MB   |

The main process is flat; the renderer leaks about 6 MB a cycle (2 MB a project switch) without levelling off. A heap snapshot diff over 6 cycles (`HeapProfiler`, production build) shows the growth in MapLibre style objects (expression evaluators and paint property values, a few hundred per project opened), detached SVG elements (about 30 `<svg>` roots per project opened) and array buffers. The likely cause is a map instance, or its style, kept after the project closes (`packages/maps`). This is a P2 bug to fix before RC1; the soak test fails until it is fixed. Measure with `--enable-precise-memory-info` (the spec sets it): without it Chromium reports a rounded renderer heap that hides the growth.
