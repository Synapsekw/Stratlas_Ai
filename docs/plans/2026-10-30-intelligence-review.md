# Platform intelligence: roadmap

Status: proposed, 30 Oct 2026. Evidence: `docs/design/intelligence-review-2026-10/`. Every item is sized and cites the study section that justifies it. Each item becomes its own branch through `/develop` once the founder picks it.

## Wave 1: measure, and the cheap big wins

| Id  | Item                                                                                                                                                                                                                                            | Packages                                                 | Size | Source                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---- | ----------------------- |
| E1  | Agent eval regression suite: multi-turn cases, survey dates and volumes on the change and volumetric demos, wrong-premise cases, tool-call traces stored for before and after comparison, a cheap-model run on demand and a local-model profile | `apps/desktop/e2e` (agent-eval)                          | M    | agent.md 4.7            |
| E2  | Honest detector bench: IoU ≥ 0.3 matching, precision, a PR curve, stored reference results, a pre-release script for every shipped detector                                                                                                     | `tools/detectors`                                        | S    | vision.md 3.5           |
| A1  | Agent brain: compacted tool results kept in history (contract row), Anthropic caching and thinking, step cap about 20 with a plan-act-check prompt and a summary when the cap is hit, tools filtered by what the project has                    | `packages/ai`, `apps/desktop` agent IPC                  | M    | agent.md 4.1-4.3, 4.6   |
| V1  | Detector fixes: cap boxes per tile and photo, keep the smaller or higher-scored box on containment, GSD-aware tiling                                                                                                                            | `python` detect                                          | S    | vision.md 3.1, 3.7, 3.8 |
| I1  | After-a-date chain (quiet survey QA and change compute when a new date's surface is ready, behind a Settings switch) and a deterministic house report narrative                                                                                 | `packages/survey`, report, `apps/desktop` surfaces watch | S-M  | insight.md 5.1, 5.3     |

## Wave 2: reach, learning, insight

| Id  | Item                                                                                                                                                                                                                                                  | Packages                                          | Size | Source                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---- | ----------------------------- |
| A2  | Action registry bridge to the agent, with a parity test, and read tools: `list_surveys`, `set_survey_date`, `list_measurements`, `get_volume`, `rank_locations`, `list_detections`, `review_detections`, `list_jobs`, `thermal_summary`, `list_walks` | `apps/desktop` shell/actions, `packages/ai` tools | M-L  | agent.md 4.4-4.5              |
| V2  | Learning loop: few-shot is / is-not crops in prompts, rejected crops become is-not examples, apply suggested threshold after 20+ reviews; then re-tune and re-bench corrosion on Qwen3.5 and fix `tunedOn`                                            | `python` detect, `packages/analytics` ledger      | S-M  | vision.md 3.2-3.4             |
| I2  | Site digest (`siteInsights(project)`, typed insights with evidence and action ids), volume rate and forecast with a Python parity twin, QA fitness flags on measurements (contract row)                                                               | `packages/survey`, new insights module            | M    | insight.md 5.2, 5.4, 5.5, 5.8 |
| V3  | Multi-view vote (one draft per 3D cluster) and thermal hot-spot finder (M2)                                                                                                                                                                           | `python` inspection, thermal                      | M    | vision.md 3.6, 3.14           |

## Wave 3: site memory and new perception

| Id  | Item                                                                                                                                                    | Packages                                  | Size | Source                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---- | ---------------------------------- |
| M1  | Project fact index (SQLite with FTS5, rebuildable from files and journal), cross-kind links, agent tools `query_facts` and `history_of`, project search | new `packages/facts`, `apps/desktop` main | L    | insight.md 5.6-5.7                 |
| M2  | Tracks across dates for antennas, change regions and thermal, with per-track trends                                                                     | `packages/change`, `python` telecom       | M    | vision.md 3.10                     |
| A3  | Bundled Qwen3.5 as the offline agent (after a tool-calling check), batch approvals, small per-project memory, per-project consent for view capture      | `packages/ai`, analytics server           | M    | agent.md 4.8-4.11                  |
| V4  | 360 detections placed and tracked across frames; change region labels through the Compare route                                                         | `python` inspection, `packages/ai` ask    | M    | vision.md 3.9, 3.16                |
| N1  | New models outside the Analytics pack: road YOLO (download on demand), Segmentation add-on (SAM 3, 2D-to-3D lifting), PDAL ground classifier            | `python`, pack tooling                    | L    | vision.md 3.11-3.13, research.md 2 |
| X1  | Local MCP server over the same tool registry, so outside agents can query a project                                                                     | `packages/ai`, `apps/desktop` main        | M    | research.md 3                      |

## Execution DAG

```
Wave 1 (parallel, no shared files):  E1   E2   A1   V1   I1
                                      |    |    |         |
Wave 2:                               +----|--> A2 (after A1, measured by E1)
                                           +--> V2 (after E2, V1)
                                                     I2 (after I1)
                                                     V3 (after V1)
Wave 3:   M1 (after I2) --> A3 memory part; M1 + A2 --> X1
          M2 (after V3)   V4 (after V3)   N1 (after E2, judged by the bench)
```

- **Critical path:** E1 → A1 → A2 → M1 → X1.
- **Shared-file risks:**
  - A1 and A2 both touch `packages/ai`, so they run in sequence.
  - I1 and I2 share `packages/survey`.
  - V1 and V2 share the `python` detect engine.

## Tests per item

- **Agent (A):** every A item adds eval cases to E1 and must not regress the stored traces.
- **Vision (V):** every V item is judged by the E2 bench before and after.
- **Insight (I) and memory (M):** fixture tests per rule, and a parity test wherever Python repeats a calculation.
- **E2e specs:**
  - Agent ones stay off the default CI path (they need a real model) apart from the scripted stand-in cases.
  - I1 and I2 add a spec on the change demo: open the digest after a date lands.

## Contract changes expected

| Item | Contract                                           |
| ---- | -------------------------------------------------- |
| A1   | `ChatMessage` carries tool-call parts              |
| I2   | `qaFlags` on measurement results                   |
| M1   | Fact index schema (derived, not a source of truth) |
| N1   | Add-on pack manifest                               |

## Decisions (founder, 30 Oct 2026)

1. **Cost.** Thinking and prompt caching are on by default for the cloud agent (A1).
2. **Automatic work after a new date.** Survey QA and change compute run by themselves when a new date's surface is ready, on by default behind a Settings switch next to automatic surface preparation (I1).
3. **Corrosion detector.** Left as it is (experimental). Re-tuning and re-benching waits for the asset inspection focus, so V2 keeps the learning loop and drops the corrosion re-bench.
4. **New models.** Founder delegated the choice and asked for what feels most polished. Chosen: download on demand from the Models and detection page (one click, progress, hash check, a size shown before download, removable), with a "Choose file" fallback for offline computers. Users never install a model pack by hand. The full Analytics pack stays as it is.
5. **MCP server.** Yes, where it adds value: local only, read-only first, on the same tool registry as the agent (X1, Wave 3).
6. **Where to start.** All five Wave 1 branches in parallel (E1, E2, A1, V1, I1).
