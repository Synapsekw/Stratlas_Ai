---
type: plan
date: 2026-11-11
branch: feat/fact-index
status: in-progress
related: [plans/2026-10-30-intelligence-review.md, design/intelligence-review-2026-10/insight.md]
---

# M1: the project fact index (site memory)

Wave 3 row M1 of `plans/2026-10-30-intelligence-review.md`, study `insight.md` 5.6 and 5.7. The founder gave the Wave 3 go on 11 Nov 2026 and asked for it to be built without questions; the calls below are made on the founder's behalf.

## Goal

A per-project fact index in SQLite with FTS5, derived from the project's files and journal and rebuildable at any time (deleting it and building again gives the same rows). Facts cover survey dates, layers, photos, measurements and volumes, detections and their reviews, issues, QA and accuracy results, change sets and items, thermal hot spots, walks and journal ops, with cross-kind links. The agent gets `query_facts` and `history_of`; the Project tab gets a search over the index. A3 (agent memory) and X1 (local MCP) build on the query API.

## Decisions

1. **Binding: `node:sqlite`.** The repo ships no SQLite binding. Electron 44 (Node 24.21, SQLite 3.53.4) and the Node 24 that runs Vitest both have `node:sqlite` built in, with FTS5 and the porter tokenizer (checked by running both). No native add-on, nothing source-built, nothing new to ship.
2. **Where the index lives: `userData/fact-index/<sha256 of the folder>.sqlite`.** Never in the project folder, so it is never synced, packed or journaled, and a read-only package is never written. Packages get no index (state `none`), so the tools are not offered there.
3. **Incremental update by diff.** On `journal:changed` (every journaled write, outside edit, merge and sync) main re-reads the project's sources, extracts the facts again and applies only the rows that differ (insert, update, delete by id and row hash), debounced 1.5 s. Cross-kind links (spatial joins) depend on several files at once, so a per-file update would be wrong; a whole-project extract is cheap next to a pipeline job and keeps the rule "the index equals a fresh build" true by construction.
4. **Build on open in the background**, after the journal's open check, one project at a time, never blocking the open. A version stamp (`FACT_INDEX_VERSION`) in the index rebuilds an older one.
5. **Subjects use the journal's record kinds** (`issue:I1`, `measurement:m-3`, `detection:d-7`, `change-set:cs-1`, `survey:<capture>`, `photo:<layer>/<photo>`), so a journal op's `target` maps to the subject it changed without a lookup.
6. **Positions are project CRS easting and northing.** Measurements already are; photo positions convert from the local frame (X east, Z south) with the manifest origin. Detections, issues on photos and hot spots take their photo's position.
7. **Links made at index time:** detection, issue and hot spot to photo, survey date and issue; change item to set and to the issue or detections it is about; volume to its date's QA; a point thing inside a measurement outline of the same date (`inside`, "an issue on a pile").
8. **Tools are read-only and offered only when the index is `ready`** (`AgentFacts.factIndex`). Absent facts keep every tool, as before.
9. **Search home: a "Search this project" section in the Project tab**, not the palette (the palette is shell, owned by the UI revision). A result opens its history inline. Rebuild is a small button in that section.
10. **No pipeline change, no pack bump.** Everything is TypeScript in main.

## Contract change

"Fact index schema (derived, not a source of truth)": `@aio/schema` `facts.ts` (`Fact`, `FactLink`, `FactQuery`, `FactHistory`, `FactIndexStatus`, `FACT_INDEX_VERSION`), IPC `facts:status`, `facts:query`, `facts:history`, `facts:rebuild`, event `facts:changed`, `AgentFacts.factIndex`. Row in `docs/architecture/contract-changes.md`.

## Tasks

| Task | What                                                                                                                                                                                                     | Packages                                   | Tests                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1   | Contract: `facts.ts`, IPC channels and event, `AgentFacts.factIndex`, preload lists, renderer `facts/factStore.ts`                                                                                       | schema, desktop preload, renderer          | typecheck; schema round-trip test                                                                                                                |
| T2   | `packages/facts`: `readProjectSources(root)`, `extractFacts(sources)` (facts and links), `openFactIndex(file)` with `sync`, `query`, `historyOf`, `linksOf`, `status`, `dump`; README with the query API | new `@aio/facts`                           | extract per kind, links, determinism (build twice, delete and rebuild: same dump), incremental diff, FTS prefix and ranking, near, history order |
| T3   | Main `facts.ts`: index lifecycle (build on open, debounce on `journal:changed`, rebuild, close), IPC handlers, `READS`, wiring in `index.ts`                                                             | desktop main                               | service test on a temp project: build, update after a file change, rebuild gives the same dump, package answers `none`                           |
| T4   | Agent tools `query_facts`, `history_of` (specs, executors over `window.aio`, `fitsProject`, compact descriptions, i18n summaries, `agentFacts.factIndex`), scripted rules, eval cases                    | ai, desktop renderer agent, e2e eval files | tools.test, survey-tools style fit test, executor tests, eval grader cases                                                                       |
| T5   | Project tab "Search this project" section (field, results, inline history, rebuild), `connectFactIndex` wiring, i18n area module                                                                         | desktop renderer, ui i18n                  | component test; e2e `facts-search.spec.ts`                                                                                                       |
| T6   | Docs: README, SPEC package row, contract row, session note; e2e run the CI way                                                                                                                           | docs                                       | `pnpm check`, e2e                                                                                                                                |

## E2e specs

- New `apps/desktop/e2e/facts-search.spec.ts`: open the change demo, the Project tab's search finds a measurement and an issue by a word, a result opens its history, Rebuild gives the same results.
- `agent-eval.cases.ts` / `agent-eval.suites.ts`: new cases (not run in CI; graded without a model).

## Execution DAG

```
T1 (contract) ──┬──> T2 (packages/facts) ──> T3 (main service) ──┐
                ├──> T4 (agent tools, evals) ─────────────────────┼──> T6 (docs, e2e, check)
                └──> T5 (Project tab search) ─────────────────────┘
```

- Batch 1: T1.
- Batch 2 (parallel, no shared files): T2 (`packages/facts`), T4 (`packages/ai`, `renderer/agent`, `e2e/agent-eval.*`, `i18n/en/agentTools.ts`), T5 (`renderer/facts/*` UI, Project tab section, new i18n area, `App.tsx` one line).
- Batch 3: T3 (needs T2's API).
- Batch 4: T6.
- Critical path: T1, T2, T3, T6.
