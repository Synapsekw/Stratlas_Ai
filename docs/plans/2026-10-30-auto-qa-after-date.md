# Plan: checks after a new date, and a report narrative without AI (I1)

Roadmap item I1 of the platform intelligence review (study items 5.1 and 5.3). Founder decision:
the automatic work is on by default, behind a Settings switch next to "Prepare survey surfaces
when a project opens".

## Goal

1. **After-a-date chain.** When a `survey.prepare` job on the open project ends done, each date it
   prepared that has an earlier date gets, quietly and one at a time, the site-level survey QA run
   (`survey.qa`, compare to the previous survey at the site QA level) and the in-app change compute
   for the pair (previous date, new date). A new date then brings its QA verdict (and hold banner)
   and a "what changed" set without a click.
2. **Deterministic house report narrative.** The template narrative (`narrativeTemplate.ts`) grows
   sentences over `NarrativeFacts` in the "In short" style: pile count (zero, one, several), the
   piles that moved most, piles left out of the latest total, and the survey QA verdicts (holds
   named). The AI draft stays optional polish over it.

## Decisions (made here, founder delegated)

- Setting `Settings.autoCheckNewDates` (absent means on), a switch under the existing
  automatic-preparation switch in Settings, Processing tools, same card and look.
- Trigger is a prepare job that **ended done** on the open project (whoever started it), not
  project open: an older project whose dates were never checked does not get a burst of jobs.
  Dates made from kit DSM grids (no job) are not chained.
- "Never repeated": a date whose `survey/qa/<capture>.json` is newer than its surface
  (`checkedAt` against `preparedAt`) gets no QA; a pair with a change set newer than the new
  date's surface gets no compute; within one open each step is tried once, and a new prepare of a
  date clears its steps from the tried set (a re-prepared date is checked again). A compute that
  did not start because a person's compute was running is not counted as tried.
- The QA compares with the nearest earlier date that has a prepared surface (as `runQa` does). The
  change pair is always (date before, new date).
- Decision (31 Oct, parent session): the automatic run uses **no checkpoints**. A processing run's
  GCPs built the surface, so they are not independent checkpoints and would overstate accuracy.
  The report's method line says so: checks without checkpoints were "measured against the previous
  survey without checkpoints"; a hand run that had checkpoints keeps the checkpoints wording
  (`NarrativeFacts.qa.withCheckpoints`).
- Known limit: a date inserted later with an earlier date than existing ones gets its own pair
  (date before, inserted date) but not the pair (inserted date, the date after it), which only a
  person's compute makes.
- Review fixes (31 Oct): `changeStore.compute` returns its own outcome (null when it did not
  start); a run carries its pair, so a compute of another pair leaves the panel's refused run and
  error line alone and shows as "Finding what changed on a new survey date"; waits for a job end
  give up when the job leaves the list, the project closes or the watch stops; a throwing step
  counts as tried and the loop goes on; stop cancels the chain's compute in flight.
- The QA runs at the site's QA level exactly as the panel's own run does; at level `off` (the
  default for a new site) it measures the change against the previous survey without a verdict,
  so a hold appears only once the site has a level.
- Single-date projects, the earliest date, a previous date without a
  prepared surface (QA would only say "unchecked"), read-only projects, no pipeline Python, the
  setting off: no QA job. Change compute needs only the earlier date.
- Light load: waits for no job active on the project and for the QA panel and the Changes panel
  to be idle, settles 2 s first, runs one step at a time. The QA job is a quiet job in Jobs with
  Cancel; the compute shows in the Changes panel with its Cancel (the store's single run slot). A
  cancel of either stops the chain until the project is opened again.
- Nothing beyond what the two jobs write by hand (a QA file with its journaled hold; change sets
  whose verdicts are proposals).
- e2e: an e2e run starts with the chain off through a preload flag (`aio.flags.newDateChecks`,
  `--quadrion-newdatechecks=0` unless `QUADRION_E2E_NEWDATECHECKS=1`), the `autoFold` precedent,
  so existing specs on multi-date demos keep their state; the new spec turns it on.
- `NarrativeFacts` gains `volumes.movers`, `volumes.notCounted` and `qa` (additive; the AI prompt
  shows them too).

## Tasks

| #   | Task                                                                                                                                             | Files                                                                                                                                                                                                                | Tests                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| T1  | Setting + flag: `autoCheckNewDates` in Settings, redact `keep`, preload flag, main arg, switch in ProcessingEngine, strings in `enAutoChecks.ts` | `packages/schema/src/ipc.ts`, `apps/desktop/src/main/{index.ts,diagnostics/redact.ts}`, `apps/desktop/src/preload/index.ts`, `screens/settings/ProcessingEngine.tsx`, `packages/ui/src/i18n/{en.ts,enAutoChecks.ts}` | i18n test (existing)                                                                                                    |
| T2  | `newDatesWatch.ts`: pure `newDateSteps()` + `connectNewDatesWatch(deps)`; `changeStore.compute(kinds, pair?)`; wiring in App.tsx                 | `apps/desktop/src/renderer/survey/newDatesWatch.ts`, `packages/change/src/store.ts`, `App.tsx`                                                                                                                       | `newDatesWatch.test.ts`: new date, repeat, single date, switch off, earliest date, level off, cancel stops, busy waits  |
| T3  | Narrative facts + templates                                                                                                                      | `packages/project/src/export/house.ts`, `reportPage/house/{survey.tsx,main.ts}`, `report/narrativeTemplate.ts`, i18n                                                                                                 | `narrativeTemplate.test.ts` (zero, one, several piles, movers, missing data, holds, no captures); `house.test.ts` facts |
| T4  | e2e `new-date-checks.spec.ts` on a multi-date demo with pipeline Python                                                                          | `apps/desktop/e2e/`                                                                                                                                                                                                  | the spec, CI way                                                                                                        |
| T5  | Contract rows, session note                                                                                                                      | docs                                                                                                                                                                                                                 | `check-public-text`                                                                                                     |

## Execution DAG

- Batch A (parallel, no shared files): T2 core (`newDatesWatch.ts` + test, change store), T3
  (`house.ts`, narrative template + test).
- Batch B: T1 (touches en.ts, ProcessingEngine, App.tsx wiring for T2).
- Batch C: T4 (needs A and B built), then T5.
- Critical path: T2 → T1 wiring → T4.

Built in one session (the pieces are small); `pnpm check` and the e2e through the shared runner.

## Contract changes

`Settings.autoCheckNewDates` (optional boolean), `AioBridge.flags.newDateChecks` (optional),
`NarrativeFacts` additive fields. Rows in `docs/architecture/contract-changes.md`.
