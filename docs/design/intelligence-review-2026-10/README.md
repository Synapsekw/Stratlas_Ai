# Platform intelligence review, October 2026

How smart is Quadrion AI today, and what would make it substantially smarter? This review covers the in-app agent, image and 3D interpretation, and the insight layer that turns data into answers. It was a read-only study on 30 Oct 2026, done alongside two other reviews that split the work:

| Review | Scope |
| --- | --- |
| UI revision (`docs/ui-revision`) | Layout and presentation, including the AI status chip, the AI's name, the agent dock and the "Models and detection" Settings page |
| Engineering review | Performance, IPC, jobs, storage, build, pack sizes, CI |
| **This review** | How good the AI is and what it can do: the agent, detectors, analytics, proactive insight |

The evidence is in four studies in this folder, each with file:line references:

- [`agent.md`](agent.md): the in-app agent
- [`vision.md`](vision.md): vision models, detectors and the 3D interpretation rules
- [`insight.md`](insight.md): volumetrics, change, QA, reports and the data model
- [`research.md`](research.md): competitors, open models and agent patterns, with sources

## Verdict

The platform computes a great deal and understands little of it. The plumbing is well engineered: typed tools, approval gates, undo, offline guards, typed and dated project files with provenance, a hash-chained journal, a review ledger. The intelligence on top is thin, and **none of it learns or checks itself**.

| Area | Today | Grade |
| --- | --- | --- |
| In-app agent | A tool router. It drops its own tool results from history, has no reasoning budget or caching, stops after 8 steps, and can't reach anything built since mid-October (volumes, survey dates, thermal, walks, detections, jobs, the right-click actions). Its eval is 22 single-turn cases, run by hand. | C |
| Vision | Three learned paths: the Qwen3.5-9B detector, custom analytics asks and a user-imported 360 YOLO model. Everything else (antennas, change, road, thermal, cloud cleanup) uses hand-tuned rules. The one shipped detector (corrosion) was tuned on the previous model and its last bench was a "no go". No detector is measured in the build. | D+ |
| Insight | Plenty is computed (survey QA, accuracy warnings, volume over time, design tolerances, change verdicts, report narrative), but almost all of it waits for a click. A new survey date produces no QA hold, change summary, trend or alert by itself. | C |
| Learning | The review ledger records every accept and reject, but only produces a suggested threshold that is never applied. The is / is-not examples saved with each detector never reach the model. | F |

## What the market says

From [`research.md`](research.md): customers pay for **numbers they can measure, export into their own systems and trace back to the source photo**, not for "digital twin plus generative AI" or a chat box that can neither act nor cite. The leader ships AI that fills schedule actuals and ranks inspection findings into maintenance systems, and exposes its data to outside agents over MCP. **No competitor advertises AI that runs offline.** That is our lane: offline, cited, measurable intelligence on the user's own GPU, with cloud models as an option.

## Five moves

1. **Measure first.** Grow the agent eval into a regression suite (multi-turn, dates, volumes, wrong-premise cases, a local-model profile) and make the detector bench honest (IoU matching, precision and recall, stored reference results, run before every pack release). Every move below is judged by these.
2. **Give the agent memory and reach.**
   - Keep compacted tool results in history.
   - Turn on prompt caching and thinking.
   - Raise the step cap to about 20 and add a plan, act, check instruction.
   - Send only the tools the project can use.
   - Connect the right-click action registry to the agent so new features can't land without agent coverage.
   - Add read tools for survey dates, measurements, volumes, detections, jobs, thermal and walks.
3. **Close the learning loop.**
   - Few-shot the saved is / is-not crops into the detect and verify prompts.
   - Turn rejected crops into is-not examples automatically.
   - Offer "apply suggested threshold" once there are 20+ reviews.
   - Cap boxes per photo and fix the merge rule.
   - Group the same defect seen in several photos into one 3D draft (multi-view vote).

   None of this needs a new model.
4. **Make the app speak first.**
   - When a new date's surface is ready, run survey QA and change compute quietly, behind a Settings switch.
   - Add a rules-based site digest: typed insights, each with evidence and a next action.
   - Add volume rate, days to empty or capacity, and outlier dates.
   - Add a QA fitness flag on every figure.
   - Write the report narrative from deterministic sentence rules, with the LLM only as polish.

   Insights propose, they never change data.
5. **Build a site memory.**
   - A rebuildable project fact index (SQLite with FTS5) of typed, dated, sourced facts with links across kinds (issue on pile, antenna on asset).
   - Agent tools `query_facts` and `history_of`.
   - Tracks across survey dates for antennas, change regions and thermal readings.
   - Then one local search box over the whole project.

New models come after these, outside the full Analytics pack (6,886 of 7,000 MB): a road YOLO model trained on the 2,115 reviewed defects (download on demand), an optional Segmentation add-on (SAM 3 masks lifted into the cloud through the ODM camera poses), a PDAL ground classifier (already in the pipeline pack), and rule-based thermal hot spots. Gemma 4 E4B only ever replaces Qwen3.5, and only after a bench win. Semantic splats and native open-vocabulary 3D are parked.

## Where it shows in the UI

New surfaces use the homes the UI revision defines:

| Recommendation | UI home |
| --- | --- |
| Site digest, suggested next actions, trend and QA flags | Project tab |
| Suggested prompts from the digest, plan and approval cards | Agent dock |
| Detector bench results, learning status, apply threshold, add-on packs | Models and detection page |
| Bundled model as the offline agent, caching and thinking switches | AI page |
| "Offline agent ready" state | AI status chip |
| Auto QA and change after a new date | Settings switch next to automatic surface preparation |

The plan with waves, the execution DAG and the decisions for the founder is in [`../../plans/2026-10-30-intelligence-review.md`](../../plans/2026-10-30-intelligence-review.md).
