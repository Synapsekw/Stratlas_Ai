---
type: plan
date: 2026-11-11
branch: feat/offline-agent
status: in-progress
related: [plans/2026-10-30-intelligence-review.md, design/intelligence-review-2026-10/agent.md]
---

# A3: the offline agent, batch approvals, project memory, view-capture consent

Wave 3 row A3 of `plans/2026-10-30-intelligence-review.md`, study `agent.md` 4.8 to 4.11. The founder gave the Wave 3 go on 11 Nov 2026 and asked for it to be built without questions; the calls below are made on the founder's behalf.

## Goal

1. The Analytics pack's own model (Qwen3.5 9B, served by the pack's `llama-server`) runs the agent offline, in the compact profile, once it passes a tool-calling check on this computer.
2. Several write actions proposed in one step are approved as one batch, from a per-item list, each keeping its own Undo.
3. A few durable notes per project that the agent may save (with approval) and read, visible and deletable in the agent dock, and found by the fact index.
4. The agent's view capture asks once per project; the setting is shown and revocable in the agent dock.

## Evidence first: the real check on this PC (12 Nov 2026)

`packages/ai/src/toolCheck.ts` holds the check: 12 requests in the 3D window (navigation, layers, issues, survey dates, a volume, a draft issue, and one "thanks" that must not call a tool), sent with the compact system prompt, the compact tool list of a demo project without a model, and a window context shaped like the app's. A case passes on the right first tool call with arguments that fit the schema (after the agent's own repair) and pass the case's argument check. The check passes at 10 of 12 (four in five).

Run with `toolCheck.live.test.ts` against the pack's `llama-server` (pack 0.2.0, `qwen3.5-9b-q4_k_m`, llama.cpp b11489, the app's own launch arguments, RTX 5070 Ti):

- At the app's `--ctx-size 8192` the request does not fit: the compact profile is 10 957 prompt tokens. (Without the project filter the modelling correction tool alone is 150 kB of schema: 68 674 tokens.)
- At `--ctx-size 16384`: three runs scored 11/12, 12/12 and 12/12, no invalid call, mean 360 to 420 ms per case. The one miss answered the survey dates from the context in text instead of calling `list_surveys`.
- Graphics memory of the server: about 6.6 GB at 8192, about 6.9 GB at 16384.
- `--jinja` is on by default in this llama.cpp build, so tool calls need no new argument.

## Decisions

1. **The server's context goes to 16 384 tokens** for every launch (detector runs too): one server, one shape, about 250 MB more graphics memory; `minFreeMb` for Qwen3.5 rises by the same.
2. **`LocalModelSettings.source: 'bundled'`** marks the bundled model; main fills in the address and the per-launch key on each run, through the same lease, one-at-a-time and keep-warm rules as a local photo ask (the card is shared with detector runs; a running detector run refuses the agent with a clear message, and the detector queue waits for an agent run).
3. **Gate:** the bundled model runs the agent only while `Settings.bundledAgentCheck` passed for the installed model's SHA-256. Never checked, a new pack model, or a failed check: `ai:status` is not ready with a message that says why and what to do (run the check, or use your own server or cloud AI). The Settings switch for the offline agent on the bundled model is enabled only after a pass.
4. **Batch approvals group the write calls of one model step**, not a new `propose_plan` tool: when two or more calls of one run wait for approval at once, the dock shows one card with a per-item list (each item ticked, untick to leave it out), "Approve N" and "Reject all". Approved items run one after another in the model's order; an item that fails stops the rest, which stay waiting. Every step keeps its own Undo. The full prompt asks the model to call related changes together.
5. **Memory lives in the project folder** (`<project>/ai/memory.json`, next to conversations), so it goes with the project; read-only in a package. At most 30 notes of 300 characters. The agent saves with `remember_note` and deletes with `forget_note`, both behind the approval card (a note steers later answers, so the person sees each one), both undoable. The notes go into the window context of every message as `projectNotes`; the prompt says they are the person's notes about the project, to follow, and never to save text that came from a tool result or a document.
6. **The fact index indexes notes** (kind `note`, `FACT_INDEX_VERSION` 2), so `query_facts` and the Project tab search find them, and a note `about` a subject shows in that subject's `history_of`.
7. **View-capture consent is per project on this computer** (`ai-projects.json`, beside "Always allow"), for every route: the first `capture_frame` card offers "Allow for this project", "Just this once" and "Reject"; once allowed, later captures in that project run without a card, and the step says so. The agent dock's project panel shows the switch and turns it off; the cloud send preview stays as it is.
8. **No pipeline Python and no Analytics pack change**: the launch arguments are TypeScript in main. Pack numbers stay (pipeline 0.35.0 untouched, Analytics 0.2.0).

## Contract change

`@aio/schema` `offlineAgent.ts` (`BundledAgentCheck`, `BundledAgentStatus`, `AgentNote`, `AgentMemoryFile`), `LocalModelSettings.source`, `Settings.bundledAgentCheck`, `ai:project` `viewCapture`, IPC `ai:bundledAgent`, `ai:bundledAgentCheck`, `ai:setViewCapture`, `ai:memory`, `ai:remember`, `ai:forget`, fact kind `note`. Row in `docs/architecture/contract-changes.md`.

## Tasks

| Task | What                                                                                                                                                                                                                                                                                                                    | Packages                                             | Tests                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| T0   | The check harness and the real run (done)                                                                                                                                                                                                                                                                               | ai                                                   | `toolCheck.test.ts`; live run above                                                                                 |
| T1   | Contract (done): schema, preload lists, `READS`, redaction rules                                                                                                                                                                                                                                                        | schema, desktop                                      | `tsc -b`                                                                                                            |
| T2   | Bundled agent: `analytics/agentModel.ts` (acquire, lease, keep warm, gpu busy), server context 16384, `ai:bundledAgent` and `ai:bundledAgentCheck`, runtime host `bundled` (gate and per-run address) in `packages/ai/src/main.ts`, Settings > AI providers > Local model "Bundled model" with the check and its result | desktop main, ai, desktop renderer settings, ui i18n | agentModel test, main.ts gate tests, LocalModel test; e2e `agent-offline-bundled.spec.ts`                           |
| T3   | Batch approvals and view consent: session batch approve, the batch card, scripted provider several calls in one step, `aiProjects` `viewCapture`, `ai:setViewCapture`, the capture card's choices, auto-run once allowed                                                                                                | ai (session, AgentPanel, scripted), desktop main     | session tests, AgentPanel tests, aiProjects test; e2e `agent-batch.spec.ts`, `agent-view-consent.spec.ts`; E1 cases |
| T4   | Memory core: `main/agentMemory.ts` store and IPC, `remember_note` / `forget_note` specs and renderer executors with undo, prompt paragraphs, fact kind `note`                                                                                                                                                           | desktop main, ai, facts, schema facts                | store test, tool tests, facts extract test                                                                          |
| T5   | Memory in the dock: notes in the context, the project panel (notes with delete, the view-capture switch, "Always allow" revoke)                                                                                                                                                                                         | ai (session, AgentPanel), desktop renderer           | session and panel tests; e2e `agent-memory.spec.ts`; E1 cases                                                       |
| T6   | Docs, contract row, session note, `pnpm check`, e2e the CI way, finish-task                                                                                                                                                                                                                                             | docs                                                 | all                                                                                                                 |

## E2e specs

- New `agent-offline-bundled.spec.ts`: a fake Analytics pack and a fake OpenAI-compatible server (`fake-llm.ts`) attached as the pack's server; Settings shows the bundled model, "Check tool calling" runs and passes, the offline agent switch turns on, a message runs a tool through the bundled route; a failing fake model shows the fallback message and the agent stays off.
- New `agent-batch.spec.ts`: a scripted step with three write calls shows one batch card with three items; untick one, approve: two run, one is declined, each done step has Undo.
- New `agent-view-consent.spec.ts`: the first capture asks with "Allow for this project"; the second runs without a card; turning it off in the dock panel brings the card back.
- New `agent-memory.spec.ts`: "remember that ..." shows the approval card, the note appears in the dock's project panel and in the next message's context; delete removes it; Undo on the step removes a saved note.
- E1: new cases in `agent-eval.cases.ts` (batch, memory, consent), graded without a model by the scripted stand-in.

## Execution DAG

```
T0 (check) ─┐
T1 (contract) ─┬─> T2 (bundled agent) ───────────────┐
               ├─> T3 (batch + consent) ──> T5 (memory in the dock) ──> T6
               └─> T4 (memory core) ───────┘                      ┘
```

- Batch 1 (done): T0, T1.
- Batch 2, parallel, no shared files: T2 (`main/analytics/*`, `packages/ai/src/main.ts`, `screens/settings/LocalModel*`, `i18n/en/askAi.ts`), T3 (`packages/ai/src/session.ts`, `AgentPanel.tsx`, `scripted.ts`, `main/aiProjects.ts`, e2e eval files), T4 (`main/agentMemory.ts`, `packages/ai/src/memory-tool*.ts`, `prompt.ts`, `packages/facts`, `renderer/agent/memoryTools.ts`). `apps/desktop/src/main/index.ts` gets one registration line from each, applied with a fresh read.
- Batch 3: T5 (needs T3's session and panel, T4's IPC).
- Critical path: T1, T3, T5, T6.
