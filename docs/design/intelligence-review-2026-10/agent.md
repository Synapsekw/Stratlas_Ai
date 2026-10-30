# In-app agent: how intelligent is it, and how to make it smarter

Audit of worktree `.claude/worktrees/intelligence-review` (30 Oct 2026). Read-only. Paths are relative to the repo root.

## Verdict

The agent is a well-engineered **tool router with a thin brain**. The plumbing is good: typed tools, risk gates, undo, offline guards, sanitised errors, a small-model profile and a real-model eval harness. It is not yet an intelligent assistant, for four reasons:

1. It forgets what it did. Earlier tool calls and results are removed from the history.
2. It sees little of the product. About 55 tools cover camera, issues and modelling, but most of what the app has added since mid-October has no tool: survey dates, measurements, volumes, thermal, walks, detections, jobs and reports.
3. It has no reasoning budget, a step cap of 8 and no prompt caching.
4. Its quality is measured by 22 single-turn requests on one synthetic demo, run by hand.

None of the top-10 gaps listed on 15 Oct has closed since.

## 1. Architecture

**Loop.** The loop is `createAgentRuntime` in `packages/ai/src/main.ts:437`. It runs on the Vercel AI SDK `streamText` (`main.ts:720-746`), with `stopWhen: stepCountIs(limit)`, `MAX_STEPS = 8` (`main.ts:339`) and `COMPACT_MAX_STEPS = 6` for small models (`local.ts:21`). Output is capped at 16k tokens on cloud (`main.ts:733`). Retries are set to 2. The runtime emits text deltas, tool calls and usage per step.

**Where tools run.** Tool executors run in the renderer. Main emits `tool-call` and waits for `ai:toolResult` (`main.ts:465-495`). The renderer side is `define`/`registerRendererTool` in `packages/ai/src/tool-kit.ts`.

**Providers.** Anthropic, OpenAI and Google are built in, plus `local`, an OpenAI-compatible server such as Ollama, LM Studio or llama.cpp (`providers.ts:195-253`). A local server on a non-loopback address counts as cloud (`providers.ts:236`). Offline-only mode is enforced at fetch level (`providers.ts:178-187`) and again on every step (`main.ts:727-730`).

**Routing.** Each task has its own route (`routes.ts:75-83`):

| Task | Default provider and model |
|---|---|
| chat | Anthropic `claude-sonnet-5-5` |
| vision | Anthropic `claude-opus-5-5` |
| report | Anthropic `claude-sonnet-5-5` |
| build | Anthropic `claude-opus-5-5` |
| extract | OpenAI `gpt-6-luna` |
| engineer | follows vision (`routes.ts:142`) |

The "Offline agent" preset moves every task to the local model (`routes.ts:89`). The default local model is `llama3.2-vision` on Ollama (`routes.ts:10-14`).

**Two local model stacks.** The bundled Analytics pack runs `llama-server` with Qwen-VL (`apps/desktop/src/main/analytics/ask.ts`, `models.ts`). It serves only the custom photo requests and detection. The chat agent never uses it: it needs the person's own Ollama ("decision 1: nothing bundled", `apps/desktop/src/main/localModels.ts:2`). So a fresh offline install has a capable vision model on disk but no offline agent.

**System prompt.** There are three profiles in `packages/ai/src/prompt.ts`:

- `BASE` (`prompt.ts:24-72`): about 50 lines. Almost all of it is navigation and issues: `find_places` then `fly_to`, `show_issue`, `show_photos`, severity naming.
- `COMPACT` (`prompt.ts:75-86`).
- `ANSWER_ONLY` (`prompt.ts:89-99`), for local models without tool calling.

The prompt never mentions survey dates, volumes, measurements, thermal, walks, detections, jobs, reports, GCPs or the timeline.

**Context per turn.** Every turn sends a JSON `<window_context>` block in front of the newest user message (`main.ts:1897-1916`, `prompt.ts:120`). It is built in `session.ts:287-291` from three sources:

- `assembleContext` (`context.ts:67-123`): project, clock, active clip, selection, up to 40 visible layers, counts and severity levels.
- `spatialContext` (`site.ts:60-143`): CRS, origin, extent, named groups, camera pose, places in view and stage mode.
- `viewContext` (`view-context.ts:47-65`): screen, filters and the selected asset.

Missing from the context:

- the focused survey date and the date lanes
- measurements, piles and their volumes
- running jobs
- open walk or panorama state
- thermal layers
- the active tool or right-panel state

**Memory and persistence.** Conversations are saved to the project (`session.ts:1-8`). Only text reaches the model, though. `session.history()` (`session.ts:597-610`) keeps user text and assistant text and **drops every tool call and result**. `ChatMessage` is `{role, content: string}` (`packages/schema/src/ipc.ts:805-808`). On turn 2 the model cannot see the ids, positions or figures it fetched on turn 1, so "now fly to the second one" fails or forces a re-query.

There is no cross-session memory and no project notes. On local models, older turns are trimmed to a summary of at most `SUMMARY_MAX` characters (`local.ts:415-440`).

**Cost and tokens.** Usage is counted per step and charged to the project (`main.ts:752-765`), with pricing in `pricing.ts:22-29`.

Prompt caching is not used. There is no `cacheControl` or `providerOptions.anthropic` anywhere in `main.ts`; the only "cache" hits are the engineer step's file cache. The comment at `prompt.ts:107` says the prompt is "Stable per window, so it caches well", but no cache breakpoint is ever set. Each step resends the system prompt, about 55 tool schemas and the full context. The eval header estimates about 500k input tokens for 22 requests (`apps/desktop/e2e/agent-eval.spec.ts:26-29`).

## 2. Tool surface

The registry is in `packages/ai/src/tools.ts:373-611`, plus specs registered later. There are about 58 tools.

| Group | Tools |
|---|---|
| Camera | `find_places`, `fly_to`, `set_view`, `orbit`, `zoom`, `look_at`, `frame_all` |
| Time | `set_time`, `play_clip`, `list_clips`, `find_clips_near` |
| Layers | `list_layers`, `set_layer_visible`, `select`, `capture_frame` (send risk) |
| Findings | `list_issues`, `create_issue_draft`, `place_on_model`, `add_sighting`, `propose_class`, `summarize_issues`, `summarize_by_zone`, `summarize_by_class`, `find_issues_near`, `measure_distance`, `export_issues` |
| Show (`show-tool-specs.ts`) | `show_issue`, `show_issues`, `show_photos`, `open_screen` (scene, issues, inspect, media, detections, reports only, `show-tool-specs.ts:64`), `list_assets` |
| Change | `compare_captures` (includes per-pile volumes), `list_changes`, `show_change`, `run_change_detection` |
| Team | `list_my_work`, `show_thread`, `add_comment`, `request_approval` |
| Globe | `list_sites`, `show_on_globe` |
| Photos | `process_photos`, `accuracy_summary` |
| Modelling (`modelling-tools.ts:239-290`) | `list_model_parts`, `propose_model_parts`, `fit_primitives`, `edit_model_part`, `build_model`, `view_plan`, `list_components`, `edit_component`, `set_count`, `set_levels`, `add_component`, `remove_component` |
| Corrections | `list_model_corrections`, `propose_model_correction`, `view_model_correction_evidence` |

**What the agent cannot reach.** A grep for each planned name in `apps/` and `packages/` found none of the following:

- `rank_locations`
- survey dates and the timeline: `list_surveys`, `set_survey_date`
- issue editing: `update_issue`, `merge_issues`
- detections: `list_detections`, `run_detection`, `review_detections`
- reports: `export_report`
- jobs: `list_jobs`, `cancel_job`
- `show_spot_history`
- display settings: `set_display`
- measurements and volumes: `list_measurements`
- projects: `list_projects`, `open_project`
- `query_audit`

Further gaps:

- **Areas with no tool at all:** walks and 360 views, thermal analysis, GCP marking and checkpoint review (`accuracy_summary` only reads), custom analytics (Ask AI) and RF/antenna analysis.
- **Read-only volumes:** volumes are reachable only through `compare_captures`. There is no "volume of pile X", no base choice and no re-measure.
- **Context gap:** `toolsForWindow` filters by window only (`tools.ts:685-692`), and the window enum has no walk, thermal or timeline kind (`packages/schema/src/agent.ts:5-13`).

The 15 Oct note counted 165 user actions: 46 covered, 27 partial, 92 gap (`docs/plans/2026-10-15-agent-coverage-gaps.md`, "Counts"). The coverage gaps today:

- **Since 15 Oct:** the only new agent tools are `place_on_model`, `add_sighting` and the engineering/correction tools (git log of `tools.ts` and `show-tool-specs.ts`). The volumetric report, thermal M1, walk compare, antenna and RF actions, measurement dates, custom analytics and pinned media all landed without agent tools.
- **Action registry not wired to the agent:** the right-click registry recommended there now exists (`apps/desktop/src/renderer/shell/actions/index.ts:17-33`, 13 action groups including measure, thermal, report, RF and date). None of its actions are exposed to the agent: no `agent` flag, and no bridge to `registerToolSpec`.

## 3. Quality gaps

**Prompt.**

- **Narrow scope:** the prompt is precise about navigation and severity but silent on most product areas (`prompt.ts:24-72`). It offers no domain primer: what a survey date, a pile base, a checkpoint RMSE or a delta-T mean, or when to compare dates.
- **No planning guidance:** nothing like "for analysis questions, gather with read tools, then answer with numbers and offer to show".
- **No re-check after acting:** the only verification instruction is "say where the camera is, from the result" (`prompt.ts:46`).

**Grounding.** The agent gets a text snapshot of the view (camera pose, places in view: `site.ts:127-137`), which is good. It sees pixels only when the person attaches a frame (`session.ts:293`) or approves `capture_frame` (send risk, every time: `tools.ts:530-537`). It cannot read on-screen panels such as a volume card, a thermal histogram or a report preview. Tool results that carry images do reach it (`main.ts:1920-1932`).

**Multi-step work.**

- **Short budget:** 8 steps (`main.ts:339`) is short for a chain like "compare volumes across all dates, find the biggest change, fly there, draft an issue".
- **Hard stop:** when the cap is hit, the model is cut off and told to send another message (`main.ts:787-789`).
- **No reasoning:** no extended thinking or reasoning effort is requested for any provider (no `thinking` or `reasoning` in `main.ts`).
- **No parallel calls:** they are disabled only for local models (`main.ts:738`). Cloud runs allow them, but the renderer executes calls one by one through `waitForRenderer`.

**Checking its own actions.** Navigation tools return the new camera report, which is good. Write tools return a summary, but nothing ever re-reads state to confirm. Because history drops tool results, a later turn cannot check earlier work either.

**Error handling.**

- **Fallbacks and messages:** a local server that refuses tools falls back to answer-only mode (`main.ts:640-646`). Provider errors are mapped and sanitised (`errors.ts`), and a silence watchdog covers local models (`main.ts:390-431`).
- **Tool errors:** these go back to the model as `error-text` (`main.ts:1922`), so it can retry.
- **Declines:** "do not try it again" (`main.ts:362`).

**Undo and confirmation.**

- **What works:** approval is enforced for write and send risk (`packages/schema/src/agent.ts:43`; unknown tools default to write, `tools.ts:694-701`). Navigation steps are undoable (`session.ts:430-435`).
- **What is missing:** write steps (issue drafts, model edits) have no matching undo in the agent pane. Approval is per call, so a ten-item bulk action means ten cards. There is no "plan preview, approve once".

**Evals.**

- **What exists:** `apps/desktop/e2e/agent-eval.spec.ts` with `agent-eval.cases.ts`: 22 requests on the tank-farm demo, a pass bar of 90%, scored on app state, not wording. That is a good design.
- **Limits:** it is manual only, never in CI (`agent-eval.spec.ts:51-52`), runs on Anthropic only, and is single-turn (each case starts a new conversation, `agent-eval.spec.ts:55-57`). It covers only navigation and issues: no volumes, dates, thermal or multi-turn follow-ups, and no local-model eval.
- **Other agent specs:** all other agent specs use the keyword `scripted.ts` model (`scripted.ts:1-8`). They prove the plumbing, not the intelligence.

**Offline behaviour.** Offline-only mode is strict and correct. Offline intelligence depends on the person installing Ollama with a tool-capable model. The compact profile cuts the tool list to about 30 short descriptions (`tools.ts:641-682`). The bundled Qwen model is never offered for chat.

**Tool list bloat.** Every scene, map or pointcloud turn carries all 15 modelling and correction tools (`modelling-tools.ts:21`, `correction-tool-specs.ts:11`), even in projects with no model. That costs tokens and dilutes tool choice.

## 4. Improvements ranked by impact and effort

1. **Keep tool calls and results in history.** Impact: high. Effort: small to medium.
   - Change `session.history()` (`session.ts:597-610`) and `ChatMessage` (`ipc.ts:805`) to carry the `tool-call` and `tool-result` parts, compacted (for example, cut each result to about 2 KB and keep ids, positions and numbers).
   - This is the single biggest jump in perceived intelligence: follow-ups, "the second one", "do the same for tank 4".
   - It is a contract change, so it needs a row in `contract-changes.md`.
2. **Turn on prompt caching and reasoning.** Impact: high. Effort: small.
   - Add an Anthropic cache breakpoint after the system prompt and tools, and after older history. Pass `providerOptions.anthropic.thinking` with a modest budget, and the equivalent reasoning effort for OpenAI and Google, on the chat route (`main.ts:720-746`).
   - Caching should cut input cost by roughly 70-90% on multi-step runs, which pays for the thinking tokens. Thinking improves tool choice and planning.
3. **Raise the step cap and add a plan step.** Impact: medium to high. Effort: small.
   - Raise `MAX_STEPS` from 8 to about 20 on cloud (`main.ts:339`).
   - Add a prompt section: plan, gather with read tools, act, re-read to check, then report numbers.
   - When the cap is hit, have the model summarise what is left instead of cutting it off (`main.ts:787`).
4. **Bridge the action registry to the agent.** Impact: very high. Effort: medium.
   - Add `agent?: {risk, description, input}` to the sidebar action records (`apps/desktop/src/renderer/shell/actions/*`) and register them through `registerToolSpec` and `registerRendererTool`, as `docs/plans/2026-10-15-agent-coverage-gaps.md` ("Recommendation") proposes.
   - This closes measurement, thermal, report, date, RF and antenna gaps in one mechanism and stops new features landing without agent coverage.
   - Add a parity test next to the existing `shell/actions/parity.test.ts`.
5. **Add first-class read tools for the newer data.** Impact: very high. Effort: medium.
   - `list_surveys` and `set_survey_date`, with the focused date added to `assembleContext`.
   - `list_measurements` (distances, areas, piles with base and volume per date) and `get_volume`.
   - `rank_locations`.
   - `list_detections` and `review_detections`.
   - `list_jobs` and `job_status`.
   - `thermal_summary` (hot spots, delta-T per asset).
   - `list_walks` and `show_spot_history`.
   - Each needs a matching prompt paragraph in `prompt.ts`.
6. **Make the tool list depend on what the project has.** Impact: medium. Effort: small.
   - Filter `toolsForWindow` (`tools.ts:685`) by project facts, as `suggestions.ts:42` already does: drop the modelling tools when there is no model, the change tools with only one date, and so on.
   - This cuts tokens and confusion, and helps local models most.
7. **Grow the eval into a regression suite.** Impact: high, because it enables everything above. Effort: medium.
   - Extend `agent-eval.cases.ts` with multi-turn cases, dates and volumes on the change and volumetric demos, and wrong-premise cases ("delete all issues": it must refuse or ask).
   - Run it on a schedule or on demand with a cheap model, and add a local-model profile.
   - Record tool-call traces so prompt or tool changes can be compared before and after.
8. **Offer the bundled Analytics model as the offline agent.** Impact: medium to high for offline users. Effort: medium.
   - Expose the pack's `llama-server` (`apps/desktop/src/main/analytics/server.ts`) as a `local` provider option in Settings, in the compact profile.
   - Check first that the Qwen3.5 variant calls tools reliably; it shares GPU leasing with detection (`ask.ts:1-5`).
9. **Batch approvals.** Impact: medium. Effort: medium.
   - Add a `propose_plan` (or bulk) tool that groups several write steps into one approval card, with an undo per write where the store allows it (issue draft delete, model edit revert).
10. **Add a small project memory.** Impact: medium. Effort: medium.
    - Keep per-project notes the agent can read and write (for example "tank 3 is called T-3 by the client", preferred units, the last report scope).
    - Store them with the conversation in the project and inject them as a short context block.
11. **Use cheap, consented vision more often.** Impact: medium. Effort: small to medium.
    - Allow a per-project "let the agent look at the view" consent, so `capture_frame` does not ask every time once the person opts in. Keep the send preview for the first use (AI-6 rules, `session.ts:294`).
