# A2: action registry bridge and read tools for the agent

Roadmap item A2 (`docs/plans/2026-10-30-intelligence-review.md`), study `docs/design/intelligence-review-2026-10/agent.md` items 4.4 and 4.5. Measured by the E1 eval suite. No UI work.

## Decisions (made alone, as the build rules ask)

1. **One generic pair of tools for the registry, not one tool per action.** `list_actions { target }` (read) answers what a person's right-click menu offers on that target: id, label, greyed reason, picks. `run_action { action, target, pick? }` runs one. 103 actions as separate tools would swamp the compact profile; two tools cost two schemas.
2. **Per-call risk.** `ToolSpec` gains an optional `riskFor(input)`; `riskOf(name, input)` uses it, and main sends that risk with the tool call. `run_action` takes the risk of the action it names from one table, `AGENT_ACTIONS` in `packages/ai/src/action-tool-specs.ts`: view actions are `navigate` (no card), anything that changes data or writes a file is `write` (the approval card, as every write tool). An unknown id is `write`.
3. **Coverage table in `packages/ai`.** Main must know the risk, so the table lives beside the tool. Every registry action is either covered (`risk`) or excluded with a reason (`exclude`). Excluded: file pickers and name fields the person fills in, hand work in the view (placing, dragging, editing boundaries and angles), folding a list, closing the project, and two confirmations that live in the Datasets row (empty trash, remove a walk placement).
4. **Enabled state is the menu's.** The bridge resolves the target with `actionsFor` on a context built like the Datasets list's (manifest, hidden, package and look-only, dates, focus, tags, date folders from the capture index), refuses a greyed action with its reason, refuses an action the target does not offer, and checks a pick against the offered picks. Notes the action writes come back in the result.
5. **Parity test** (`apps/desktop/src/renderer/agent/actionParity.test.ts`): every action registered by `registerSidebarActions` has an entry; every entry names a registered action; every covered action takes a target the agent can name. A new right-click action without an entry fails the test.
6. **Registry export.** `registeredActions()` added to `packages/ui/src/actions/registry.ts` (the `@aio/ui` registry, not `shell/actions/index.ts`).
7. **Read tools.** Specs in `packages/ai/src/survey-tool-specs.ts`. `list_measurements`, `get_volume` and `rank_locations` run in `packages/ai` (they reuse the compare_captures volume path and the issue list); the rest run in the desktop renderer (`agent/dataTools.ts`) on the existing stores: timeline (`focusSurvey`), detections (`acceptByIds`, `rejectAll`, `undoReview`), jobs, the thermal file, walks.
8. **`review_detections`** accepts (draft issues, as `place_on_model` already does), rejects or reopens; `write` risk, so a card every time; undoable through the review's own undo. Decision 6 (the agent never approves) is about sign-off of findings; an accepted detection is a draft issue a person still reviews.
9. **Facts.** `AgentFacts` gains optional `measurements`, `volumes`, `detections`, `thermal`, `walks` (absent: unknown, the tool stays). The desktop answers them through a new `agentFacts` app hook. Contract change, row in `contract-changes.md`.
10. **Compact profile** gains short descriptions for `list_surveys`, `set_survey_date`, `get_volume`, `list_actions`, `run_action` only.
11. **Prompt.** One short paragraph in the full prompt on survey dates, volumes, detections and the menu actions.

## Tasks

| #   | Task                                                   | Files                                                                                                   | Tests                                                                     |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| T1  | Registry export                                        | `packages/ui/src/actions/registry.ts`                                                                   | `registry.test.ts`                                                        |
| T2  | Per-call risk, facts schema, fitsProject rules, prompt | `packages/schema/src/agent.ts`, `packages/ai/src/tools.ts`, `main.ts`, `session.ts`, `prompt.ts`        | `tools.test.ts`, `session.test.ts`                                        |
| T3  | Action tool specs and coverage table                   | `packages/ai/src/action-tool-specs.ts`                                                                  | `action-tool-specs.test.ts`                                               |
| T4  | Read tool specs and the packages/ai executors          | `packages/ai/src/survey-tool-specs.ts`, `survey-tools.ts`, `analysis-tools.ts` (export the pile loader) | `survey-tools.test.ts`                                                    |
| T5  | Bridge executor and parity test                        | `apps/desktop/src/renderer/agent/actionBridge.ts`                                                       | `actionBridge.test.ts`, `actionParity.test.ts`                            |
| T6  | Desktop read tool executors and facts hook             | `apps/desktop/src/renderer/agent/dataTools.ts`, `hooks.ts`                                              | `dataTools.test.ts`                                                       |
| T7  | Eval cases and scripted keywords                       | `apps/desktop/e2e/agent-eval.suites.ts`, `agent-eval.cases.ts`, `packages/ai/src/scripted.ts`           | `tools/agent/agent-eval.test.mjs`, the eval run with the scripted profile |

E2e: no product spec changes; the eval spec's suites gain cases (run with `QUADRION_EVAL_PROFILE=scripted` through the runner with `--e2e`).

Contract: `AgentFacts` optional fields, `ToolSpec.riskFor` (internal to `@aio/ai`).

Packages: `@aio/ui`, `@aio/schema`, `@aio/ai`, `apps/desktop`.

## Execution DAG

- Batch 1 (parallel): T1, T2, T3, T4 (different files; T3 and T4 only add files plus one line each in `tools.ts`, done after T2).
- Batch 2 (parallel): T5 (needs T1, T3), T6 (needs T2, T4).
- Batch 3: T7 (needs T5, T6).
- Critical path: T2 → T4 → T6 → T7.
