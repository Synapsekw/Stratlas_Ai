---
type: session
date: 2026-10-19-2155
branch: fix/odm-install-check
status: complete
related: [2026-10-15-1154-odm-engine.md]
---

# ODM install check

## What changed

- The first-start check (`run.bat --help`) now has 10 minutes instead of 120 s, and reports a timeout distinctly from a crash.
- Every check logs its duration, exit code, timedOut flag and a 4 KB output tail to `main.log`; the Inno setup writes `<dataRoot>\runtime\logs\odm-setup-<version>.log` (`/LOG`), which survives the rollback.
- A diagnostic check for the VC++ x64 runtime DLLs: on a real failure with them missing the message names Visual C++ and gives the download link; on a timeout it adds a hint; it never blocks an install that starts.
- After a timeout ODM stays installed as `unverified` (`runtime/odm.json` `verified:false`). The Processing Engine card shows "Needs a start check" with Try again (reruns only the start check) and Remove; jobs and the wizard never use an unverified install.
- A watchdog closes the output streams 10 s after the kill; the output buffer is capped at 64 KB.
- Contract change (additive, row in `contract-changes.md`): `OdmState` gains `unverified`, `OdmInstallRecord` gains optional `verified`. An older app reads `verified:false` as installed.
- Files: `apps/desktop/src/main/odm/{system,install,detect,paths}.ts`, `packages/ui` `en.ts`, the ProcessingEngine UI. Commits 6c50c518, 94e8e1f1, d27a1bb4.

## Why

Testers on fresh Windows PCs got "ODM installed but does not start: exit code 1" after installing 0.22.0 and the pack. Most likely cause: the 120 s limit on a cold first start (Python compiles every module, Defender scans about 1 GB of DLLs; 26 s even on a warm PC). A timeout kill gives exit 1 with no output. Not confirmed on a tester PC, because nothing was logged and the failed install was deleted. A missing VC++ runtime was the second candidate.

## How to test

1. Settings > Processing Engine: uninstall ODM, then install it. You see "Starting ODM for the first time; this can take a few minutes", then ODM ready.
2. Open `%APPDATA%\Quadrion AI\logs\main.log`: a start-check line with its duration.
3. Check that `<data folder>\runtime\logs\odm-setup-3.6.2.log` exists.
4. On a fresh PC with a new installer build: if the check is slow, after up to 10 minutes it shows "Needs a start check" with Try again, which should then succeed quickly.

## Open threads

- Confirm the cause on a tester PC with the new log after a new installer build.
- An older-version unverified install shows update-available, which the wizard treats as ready while jobs get no ODM path.
- The progress text says "for the first time" even on Try again.
- Evidence: `pnpm check` green (12,927 passed, 14 skipped); independent review found nothing blocking, all six findings fixed; no e2e spec affected, none run.

## Next session entry point

After this lands, wait for the founder to ask for an installer build, then read the new log from a tester PC to confirm the cause.
