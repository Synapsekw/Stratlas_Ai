# Agent brain (A1): memory of tool work, caching, thinking, longer runs, project-fit tools

Item A1 of the intelligence review roadmap (study items 4.1, 4.2, 4.3, 4.6). Founder decision: thinking and prompt caching are on by default for the cloud agent, with one switch to turn them off.

## Goal

The in-app agent remembers what its tools returned on earlier turns ("now fly to the second one"), reuses the unchanged start of each request (prompt caching), thinks before it acts, gets 20 steps on cloud and summarises instead of stopping cold at the cap, and is offered only the tools the open project can use.

## Decisions (made here, no founder question needed)

1. **History shape.** `ChatMessage` becomes a union on `role`: `user` and `assistant` keep `{ role, content: string }` (so every older caller and stored message still parses), `assistant` gains optional `toolCalls` (`{ callId, name, input }`), and a new `tool` role carries `results` (`{ callId, name, status: ok | error | declined, output: string }`). The renderer builds it from the conversation's turns and steps; main turns it into AI SDK messages.
2. **Compaction.** A tool result is stored and resent as compact JSON text of at most about 2 KB: data URLs become `[image]`, long strings are cut, long arrays keep their first items and say how many were left out, and the cut gets tighter until the text fits. Ids, names, positions and numbers survive because they are short scalars. Inputs are kept as objects (Anthropic needs an object), cut the same way when large.
3. **Where results live.** `ConversationStep` gains optional `result` (the compact text). Older conversations have no `result`: their steps are read back with the step's `summary` (or its status in words) as the result, so a resumed older conversation still sends valid, paired tool history. That is the backward-compatible read.
4. **Pairing.** Main repairs the history before it goes out: a call without a result gets "No result recorded", a result without its call is dropped, and an assistant turn that ended on tool calls gets a short closing text, so Anthropic (with thinking on) always sees complete earlier turns.
5. **Local models** get the history flattened to text ("Called fly_to {...}: result ..."), then trimmed as before: small context windows and models without tool calling cannot take structured history.
6. **Thinking.** The AI SDK's provider-neutral `reasoning` call option: `medium` when on, `none` when off, on cloud routes only. The SDK maps it per model (Claude 5.x: adaptive thinking with effort; Sonnet 5.5 off is `between_tools`; Opus 5.5 off is effort `low` since it cannot turn thinking off; OpenAI `reasoningEffort`; Google `thinkingConfig`). This follows the current Claude API facts (budget_tokens is rejected on Claude 5.x models).
7. **Caching.** Anthropic only (OpenAI and Google cache on their own): `cacheControl: { type: 'ephemeral' }` on the system message (tools render before system, so this caches tools plus prompt), on the last message of the older history, and in `prepareStep` on the newest message of each step, so steps 2 to 20 read the whole earlier run from cache. Three breakpoints, under the limit of four.
8. **One switch.** `Settings.agentThinking` (absent means on). Settings, AI providers, below Model routing: "Thinking and prompt caching". Off sends `reasoning: 'none'` and no cache breakpoints.
9. **Steps.** `MAX_STEPS` 8 to 20 on cloud; the compact profile stays at 6. At the cap, one more model call with `toolChoice: 'none'` and a short instruction writes what was done and what is left; if it says nothing, the old "I stopped after N steps" line is shown.
10. **Prompt.** A "How to work" section in the full prompt: plan, gather with read tools, act, re-read to check, report numbers with units and where they came from.
11. **Tool filter.** `ai:send` gains optional `facts` (`captures`, `photos`, `clips`, `pointClouds`, `models?`). `toolsForWindow` drops the change tools with fewer than two survey dates, the clip tools without clips, the photo tools without photos, and the modelling and correction tools without a model (unless the Model builder's `build` route is in use). No facts (an older renderer) means no filtering. `models` is unknown (kept) unless the desktop host reports it.

## Tasks

| Task | What                                                                                                                                                                    | Tests                                                                                                                 | Packages           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------ |
| T1   | Schema: `ChatMessage` union, `ChatToolCall`, `ChatToolResult`, `AgentFacts`, `ai:send.facts`, `ConversationStep.result`, `Settings.agentThinking`; contract-changes row | schema tests (parse old and new shapes; settings key list)                                                            | schema             |
| T2   | `packages/ai/src/history.ts`: `compactValue`, `historyFromConversation`, `flattenHistory`, `pairToolHistory`                                                            | history.test.ts (compaction keeps ids and numbers under 2 KB, older steps without result, pairing repair, flattening) | ai                 |
| T3   | session.ts: store compact result on each step, send structured history and facts                                                                                        | session.test.ts                                                                                                       | ai                 |
| T4   | tools.ts filter by facts                                                                                                                                                | tools.test.ts                                                                                                         | ai                 |
| T5   | main.ts: structured messages, caching, reasoning, 20 steps, cap summary; prompt section                                                                                 | main.test.ts, prompt.test.ts                                                                                          | ai                 |
| T6   | Desktop: host `agentThinking`, Settings switch, facts `models` from the modeller                                                                                        | Settings test where present, typecheck                                                                                | desktop, ui (i18n) |
| T7   | e2e: run the scripted agent specs the CI way; fix any that break                                                                                                        | agent*.spec.ts (not agent-eval*)                                                                                      | desktop e2e        |

## Execution DAG

- Batch 1: T1 (everything depends on the schema).
- Batch 2 (parallel, no shared files): T2, T4.
- Batch 3: T3 (needs T2), T5 (needs T2, T4), T6 (needs T1).
- Batch 4: T7, then `pnpm check`.
- Critical path: T1, T2, T5, T7.

Built by one agent in order (the pieces are small and share the `packages/ai` tests).

## E2E specs

No new spec. The scripted-model agent specs (`apps/desktop/e2e/agent*.spec.ts` except `agent-eval*`, owned by another branch) are run the CI way; any that break on the new history shape are updated.

## Contract change

Yes: `ChatMessage`, `ai:send`, `ConversationStep`, `Settings` (all additive or a widened union; older data parses). Row in `docs/architecture/contract-changes.md`.
