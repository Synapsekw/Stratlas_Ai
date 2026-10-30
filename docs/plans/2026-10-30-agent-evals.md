# Agent eval regression suite (E1)

Status: built on `test/agent-evals`, 30 Oct 2026. Source: the intelligence review, agent.md section 3 ("Evals") and item 4.7; roadmap item E1.

## Goal

Turn the hand-run, single-turn, Anthropic-only real-model check (`apps/desktop/e2e/agent-eval.spec.ts`, 22 requests on the tank farm) into a regression suite that the agent items (A1, A2, A3) are measured against before and after: multi-turn cases, survey dates and volumes, wrong-premise cases, a stored tool-call trace per run, a compare script, pass^k, a cheap model on demand and a local-model profile. CI stays as it is: no real-model call in CI.

## Decisions (made here, the founder delegated them)

1. **Profiles.** `QUADRION_EVAL_PROFILE` must be set and picks `anthropic` (a key alone starts nothing; `pnpm eval:agent` refuses without a profile), `local` (an OpenAI-compatible server on this machine, `QUADRION_EVAL_LOCAL_URL` and `QUADRION_EVAL_LOCAL_MODEL`) or `scripted` (the keyword stand-in model, no key, no network: proves the harness, says nothing about a model). With none of them the spec skips, as before; in CI it always skips.
2. **Model.** `QUADRION_EVAL_MODEL`, default `claude-haiku-5-5` (cheap; the app's default chat model, `claude-sonnet-5-5`, is one variable away). The chat route is set through `settings:set routes`, so no product code changes.
3. **Local profile is loopback only.** The zero-network guard admits only addresses on this machine, so a remote base URL is refused before the run starts.
4. **Known gaps.** A turn carries `gap: '<roadmap item>'` when today's agent is expected to fail it (a failure on any other turn of the case is a failure): follow-ups need tool results in history (A1); volume and survey-date questions need read tools (A2). A gap that fails is reported as `known gap` and left out of the pass rate; a gap that passes every attempt is reported as `gap closed` so the marker can be removed.
5. **Pass bar.** The 90 percent bar stays on the original tank farm requests only. The new suites (`tank-farm-more`, `change`, `quarry`) report without a bar until a baseline run exists; a later item sets their bar from that baseline.
6. **pass^k.** `QUADRION_EVAL_K` (default 1) repeats each case k times from a known start. The report gives pass@1 (mean over attempts), pass^k (every attempt passed) and tool-sequence consistency per case.
7. **Traces.** Each suite writes `<run>/<suite>.json` under `.agent-eval/` at the repo root (git-ignored; `QUADRION_EVAL_OUT` moves it). Not under `test-results/`, which Playwright empties at every run. A trace holds per case and attempt: verdict, reason, and per turn the request, every tool step (name, status, input) and the reply text. No key, no image.
8. **Grading stays code-based.** Tool names and arguments, the app state after the reply (screen, selection, filters, issue count) and plain checks on the reply (a number within a tolerance, a "not found" or "refuse or ask" phrase). No model judges a model.
9. **Quarry suite** needs the pipeline Python (surfaces are prepared on open) and builds the survey demos on first use; it skips with the reason when the Python is missing. `QUADRION_EVAL_SUITES` picks suites (`tank-farm,change,quarry`), `QUADRION_EVAL_CASES` filters cases by a text match.
10. **Where the pure logic lives.** Grading helpers (`e2e/agent-eval.grade.ts`) and trace, summary and compare logic (`e2e/agent-eval.trace.ts`) have no runtime imports, so the compare CLI (`tools/agent/agent-eval-compare.mjs`) loads the TypeScript directly with Node's type stripping, and the vitest file sits in the `tools` project (`tools/agent/agent-eval.test.mjs`), whose config already exists. `.gitignore` gains one line for `.agent-eval/`.

## Tasks

| Id  | Task                                                                                                                        | Files                                                | Tests                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| T1  | Grading helpers: numbers in a reply, near a value, refuse-or-ask, not-found, dates named, case id, multi-turn verdict, gaps | `apps/desktop/e2e/agent-eval.grade.ts`               | `tools/agent/agent-eval.test.mjs` (grade part)   |
| T2  | Trace schema, pass^k summary, run compare and text formatting                                                               | `apps/desktop/e2e/agent-eval.trace.ts`               | `tools/agent/agent-eval.test.mjs` (trace part)   |
| T3  | Compare CLI: two run folders or files, or the two newest runs                                                               | `tools/agent/agent-eval-compare.mjs`                 | CLI run in the vitest file on two synthetic runs |
| T4  | New cases: tank farm follow-ups and wrong premises, change demo dates and changes, quarry volumes                           | `apps/desktop/e2e/agent-eval.suites.ts`, `.cases.ts` | `checkDemo`-style pins checked at run start      |
| T5  | Spec: profiles, model by env, suites, multi-turn turns, per-turn steps with inputs, k repeats, trace files, report          | `apps/desktop/e2e/agent-eval.spec.ts`                | scripted run through the shared runner (`--e2e`) |
| T6  | Scripts and ignore: `pnpm eval:agent`, `pnpm eval:agent:compare`, `.agent-eval/`                                            | `package.json`, `.gitignore`                         | run both                                         |

No contract change. Packages touched: none (`apps/desktop/e2e`, `tools/agent`, root `package.json`, `.gitignore`). `packages/ai` is not edited (A1 changes it in parallel).

E2e specs changed: `apps/desktop/e2e/agent-eval.spec.ts` (still skipped in CI and without a profile). Proof run: the scripted profile on the tank farm and change demos, CI window settings, `--workers=1`.

## Execution DAG

```
Batch 1 (parallel, no shared files):  T1   T2   T4(cases only, imports T1 types)
Batch 2:                              T3 (needs T2)   T5 (needs T1, T2, T4)
Batch 3:                              T6 (needs T3, T5)  -> scripted e2e run, pnpm check
```

Critical path: T1 → T4 → T5 → scripted e2e run. Built in one session (the pieces are small and share types), test first for T1 to T3.
