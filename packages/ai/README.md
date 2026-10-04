# @aio/ai

AI providers (Anthropic, OpenAI, Gemini, a local OpenAI-compatible model), model routing, agent loop, tool registry, conversation history and the cost meter.

See `docs/architecture/SPEC.md` section 2 for ownership and dependencies. Public API: `src/index.ts` (renderer), `src/main.ts` (main process runtime), `src/routes.ts`.

## Pieces

| Module                    | What it does                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`                 | Agent runtime in the main process. Gates every call (route, provider, cloud switch, project AI policy, key), streams `ai:event`s, meters usage per project through the host.                                   |
| `providers.ts`            | Provider registry. Built in: Anthropic, OpenAI, Google. `localProvider` talks to an OpenAI-compatible server (Ollama); it is `cloud: false` only while its address is a loopback address.                      |
| `scripted.ts`             | Scripted model for end-to-end tests and demos. Registered by the desktop app only when an isolated profile sets `STRATLAS_AI_TEST_PROVIDER=1`. Never calls the network.                                        |
| `session.ts`              | One conversation in the renderer: send, tool steps, approvals, undo, save and resume (`ai/conversations/<id>.json`), restored approvals.                                                                       |
| `AgentPanel.tsx`          | The panel: history list, resume, Markdown export, send preview (AI-6), session and project meters.                                                                                                             |
| `tools.ts`, `tool-kit.ts` | Tool catalogue (shared by both processes) and the renderer registry and helpers.                                                                                                                               |
| `renderer-tools.ts`       | Navigation, issue and capture tools. Frame capture: video, 3D and point cloud from their canvases, photo through `photo-frame.ts` (photo, mask overlay, issue shapes), map through a source the app registers. |
| `analysis-tools.ts`       | `compare_captures`, `measure_distance`, `find_issues_near`, `summarize_by_zone`, `summarize_by_class`, `export_issues` (write, approval first), `open_original_review`.                                        |
| `pricing.ts`              | Price table and per-provider usage sums for the meter.                                                                                                                                                         |

## Approvals and restarts

Write and send steps always wait for a click. A conversation is saved after every change, so a step that was waiting when the app closed comes back waiting. It never runs on its own: approving it runs the tool in the app and records the outcome in the conversation, so the next message tells the model what happened.

## Prices

Estimates for the meter only; the provider's invoice is authoritative. USD per million tokens, standard tier, base context tier. Checked on 2026-10-04 (`PRICES_AS_OF`):

| Provider  | Source                                                   | Notes                                                                                                                                                                               |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic | https://platform.claude.com/docs/en/about-claude/pricing | Opus 5.5 $4 / $20 (cache read $0.20), Sonnet 5.5 $2 / $10 ($0.20), Haiku 4.5 $1 / $5, Fable 5.1 $10 / $50 ($0.25). 5 minute cache writes 1.25 times input.                          |
| OpenAI    | https://developers.openai.com/api/docs/pricing           | gpt-6.1-sol $2 / $10, gpt-6-luna $0.10 / $0.50, gpt-6-astra $10 / $50. Short context (up to 272K input).                                                                            |
| Google    | https://ai.google.dev/gemini-api/docs/pricing            | gemini-3.1-pro-preview $2 / $12, gemini-3.5-flash $1.50 / $9, gemini-3.1-flash-lite $0.25 / $1.50. Prompts up to 200k. gemini-3.8-flash has an introductory price until 2026-12-31. |

The OpenAI marketing page (openai.com/api/pricing) refused automated reads; the OpenAI rows come from the developer docs page above. A local model costs nothing per token.
