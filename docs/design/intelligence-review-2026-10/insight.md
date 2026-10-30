# Insight layer audit: volumetrics, change, QA, reports, data model

Worktree: `E:\Dev\AIO Software\.claude\worktrees\intelligence-review` (read-only). Paths below are relative to it. Scope: intelligence that turns data into answers without the user asking. The chat agent and vision detectors are out of scope except where they consume this layer.

## 1. Where the app already computes insight on its own

The deterministic layer is strong, more so than most drone tools at this stage. Almost all of it is computed **on request** rather than pushed, though.

| Area | What is computed | Evidence | Triggered by |
|---|---|---|---|
| Survey surfaces | Background preparation of every date's surface on project open | `apps/desktop/src/renderer/survey/surfacesWatch.ts:31` (`shouldAutoPrepare`), `:42` settle delay | **Automatic** (setting, default on) |
| Survey QA | Checkpoint RMSE, mean, max dz; compare-to-previous changed share; pass / hold / unchecked by level; hold journaled, only a person releases | `python/src/aio_pipelines/survey/qa.py:1-25`, `docs/architecture/data-conventions.md:822-829`, `apps/desktop/src/main/surveyQa.ts:12,153` | **Manual**: `runQa` in `apps/desktop/src/renderer/survey/qaStore.ts:270` |
| Photogrammetry accuracy | Control and check RMSE, mean reprojection px, GSD, camera residuals, overlap raster, typed warnings (`gcp-outlier`, `few-marks`, `gnss-height`, `low-overlap`, `disconnected`, ...) | `packages/schema/src/photogrammetry.ts:133,345-390` | Written by `photo.align` / `photo.georef`; read on demand by the agent (`packages/ai/src/photo-tools.ts:184`) |
| Volumes over time | One result per capture (`series`), change per date, base spread "± across bases" as an uncertainty proxy | `packages/survey/src/engine/series.ts:1-14,23-28`, `packages/survey/src/calc/timeline.ts:1-30`, `packages/schema/src/survey.ts:582-586` | On run / surfaces stamp change |
| Design compliance | Tolerance bands cut / in / fill and in-tolerance share of an area | `packages/survey/src/designs/compliance.ts:1-60` | Manual comparison preset |
| Change detection | Issue, detection and vector change per date pair; verdicts `new`, `resolved`, `not-seen`, `grown`, `worsened`, ... as proposals; staleness when a line-up shifts | `packages/change/src/issues.ts:15-27`, `packages/change/src/detections.ts:13-20`, `packages/change/src/stale.ts:42` | **Manual**: `compute()` in `packages/change/src/store.ts:201-224` |
| Report text | Deterministic "In short" sentence (site total change, top movers, opposite mover over 5 %) | `packages/project/src/export/volumetric.ts:489-506` | On report build |
| Report narrative | LLM draft of summary / method / findings from typed `NarrativeFacts`, shown before sending, "never invent numbers" | `packages/ai/src/narrative.ts:29-50`, `packages/project/src/export/house.ts:499-549` | Manual, cloud |

Takeaway: the numbers exist; the **events** do not. There is no point in the app where "a new date arrived" or "a job finished" causes the app to evaluate those numbers and tell the person what matters.

## 2. Where the user still interprets raw data

- **QA verdicts need a click.** After a new survey date is prepared automatically (`surfacesWatch.ts`), QA is not chained. The hold banner, the best safety net in the product, only appears if someone opens the QA panel and runs it (`qaStore.ts:270-293`).
- **Photogrammetry warnings are a list, not a verdict.** `AccuracyReport.warnings` (`photogrammetry.ts:345-360`) is typed and good, but nothing maps it to "fit for volumes: yes/no", and nothing links a low-overlap cell to the piles or measurements that sit on it, even though the `overlap` raster path is stored (`photogrammetry.ts:388`).
- **Change detection is a register to read.** Verdicts are proposals by design (`issues.ts:27`), which is right, but they are computed only when a person opens a pair and presses compute (`store.ts:211`). A new date never yields "3 new findings, 1 grown, 2 not seen" by itself.
- **Volume series is a chart.** `TimeRow` gives `valueM3` and `changeM3` per date (`timeline.ts:25-30`) but no rate (m³ per day), no "largest move since last survey", no outlier flag when one date jumps against the others, and the base spread is shown but never turned into "this pile's figure is base-sensitive, check the toe".
- **Measurements carry history but no comparison.** `SurveyMeasurement` has `series`, `previousResults` and per-date `outlines` (`survey.ts:558-592`), so "this figure moved 12 % on recompute" is answerable from stored data, yet nothing surfaces it.
- **Agent prompts are static.** `suggestionsFor` (`packages/ai/src/suggestions.ts:55-68`) filters three hard-coded strings by `hasPhotos/hasIssues/hasAssets/hasClips`. It never looks at holds, stale change sets, unreviewed AI suggestions or pile movement, so it cannot suggest "Survey of 12 Oct is on hold" as a first action.

## 3. Proactive intelligence that is missing

1. **Anomaly / threshold alerts.** No forecast, trend, anomaly or alert concept exists anywhere in `packages/` or `python/src` (searched `forecast|trend|anomal|alert`; only RF extrapolation warnings and ARIA `role="alert"`).
2. **Automatic QA on arrival.** Survey QA and photo accuracy exist but are not chained to the events that make them relevant.
3. **Trend and forecast.** Volume series per pile and per site exist; a linear or robust (Theil-Sen, already used in `python/src/aio_pipelines/telecom/crown.py:210`) rate with days-to-empty / days-to-capacity is trivial on top.
4. **Auto narrative without the cloud.** "In short" proves deterministic text works; the house report still depends on an LLM call for its summary (`narrative.ts`). A template narrative from `NarrativeFacts` would cover offline use and the "Keep images on this PC" projects.
5. **Site memory / knowledge graph.** Facts are spread over many typed JSON files (`survey/qa/<capture>.json`, `photogrammetry/<run>/report/accuracy.json`, change sets, measurements, issues, designs, antennas) plus the journal. The agent sees a compact spatial summary built per window (`packages/ai/src/site.ts:64`), asset boxes (`asset-index.ts`) and a few aggregate tools (`analysis-tools.ts:312,433,463`). There is no single dated fact store it can query ("what happened at pile 7 since July", "which dates failed QA"), and no agent tool reads volumes series or survey QA directly.
6. **Semantic search.** No embedding index, FTS or SQLite over project content (searched `semantic|embedding|sqlite|fts5|minisearch`; only the SAM crop embedding cache in `ipc.ts:4180`). Issue titles, notes, custom-request values (`annotation.ts:154`), measurement descriptions and session text are unsearchable except by list filters.
7. **Suggested next actions.** None computed from state. The analysis frame spec (`docs/superpowers/specs/2026-10-26-analysis-structure-design.md:25-27,79,98`) plans one findings list and a report centre but does not mention alerts, digests or next actions; this is the right moment to add them to that frame.

## 4. Is the data model ready?

Mostly yes. This is the main good news.

- **Typed:** everything is zod with versioned schema ids (`aio.survey-qa/1`, `aio.photo-accuracy/1`, `aio.designs/1`); loose objects allow additive fields (`photogrammetry.ts:133`).
- **Dated:** `Capture.date` (`packages/schema/src/manifest.ts:23-26`), `Issue.capture/track/resolvedIn` (`annotation.ts:145-152`), measurement `series` and per-date `outlines`, change sets keyed by date pair with line-up stamps (`stale.ts`).
- **Provenance:** `Issue.source` human / agent / import (`annotation.ts:142`), measurement `source`, `createdBy`, `origin`, `previousResults` (`survey.ts:567,585-589`), derived-layer provenance with job id and sources (`packages/schema/src/layers.ts:107-125`), and a signed, hash-chained journal with `opsOf` / audit queries (`packages/journal/src/query.ts:18`).
- **Gaps:** (a) not **queryable across kinds**: each family lives in its own file with its own reader, with no index joining facts by place, date and subject; (b) **no stable subject ids across kinds**: a pile is a measurement id, an asset is a mesh tag, an issue has a code and a track, an antenna has its own id, and nothing links "this issue is on this pile"; (c) QA and accuracy results are **not in the journal** as facts (only the hold op), so "when did this site last pass QA" needs file scans; (d) no **confidence** field on computed figures beyond base spread and antenna fit quality.

## 5. Ranked improvements (impact / effort)

**1. Insight events: "After a date arrives" chain (high impact, low effort).** When `survey.prepare` finishes for a new capture (the hook already exists in `surfacesWatch.ts:19-21`), queue quiet `survey.qa` at the site level and in-app `change:compute` for (previous, new). Both are already pure or pipeline jobs; this is wiring plus a Settings switch. It turns the hold banner into a real safety net.

**2. A rules-based "Site digest" card (high impact, low to medium effort).** A pure function `siteInsights(project) -> Insight[]` in a new small package (or `@aio/survey`), each insight typed `{ id, kind, severity, subject, capture, evidence: path[], text, action }`. First rules, all from data that already exists: survey on hold or unchecked; accuracy warnings mapped to a verdict (check RMSE over the QA limit, `low-overlap`, `gcp-outlier`); a stale change set (`changeSetStale`); a pile whose base spread exceeds N %; a pile whose change since the last date exceeds X % or the site's usual rate; unreviewed AI suggestions; issues with `not-seen` for two dates. Show in the Project tab and feed `suggestionsFor` with it.

**3. Deterministic report narrative (high impact, low effort).** Extend the "In short" approach (`volumetric.ts:489`) to the house report: sentence templates over `NarrativeFacts` (`house.ts:508-547`). The LLM becomes an optional polish, never a requirement; works offline and for local-only projects.

**4. Volume trend and forecast (medium to high impact, low effort).** Add `rateM3PerDay`, a robust slope over the last k dates, and days to empty or to capacity per pile and site, in `packages/survey/src/calc/timeline.ts` with a Python twin for parity. Flag dates whose change departs from the trend (a robust z-score), which catches both real events and bad surfaces. Put them in the dates strip and the report.

**5. QA fitness verdict linked to measurements (medium-high impact, medium effort).** Sample the stored `overlap` raster and the survey QA status under each pile outline and measurement; record `qaFlags` on the result (`low overlap under 30 % of the toe`, `survey on hold`, `checkpoint RMSE over limit`). Reports and the digest then say which figures to trust. Needs a contract row.

**6. Project fact index / site memory (high impact, medium-high effort).** A derived, rebuildable index (SQLite with FTS5 in main, or a JSONL fact table) of typed facts `{ subject, kind, capture, at, value, unit, source, evidencePath, journalOpId }`, built from the existing files and kept fresh on journal ops. Add stable cross-kind subject links (issue on pile, antenna on asset) via spatial joins at index time. Expose two agent tools, `query_facts` and `history_of(subject)`, so the agent answers "what changed at the north stockpile since July" from facts, not screenshots. Never the source of truth; deleting it loses nothing.

**7. Local semantic search (medium impact, medium effort).** On top of 6: FTS5 first (cheap, exact), then local text embeddings on issue titles, notes, request values, measurement descriptions and report write-ups, using the runtime already shipped in the Analytics pack. One search box over the whole project.

**8. Suggested next actions (medium impact, low effort once 2 exists).** Each insight carries an `action` id from the shared action registry (the right-click registry); the empty agent panel and the Project tab list the top three.

**9. Change confidence and cross-date tracks (medium impact, medium effort).** Propose `track` links automatically when the issue matcher finds a match above a confidence, still person-confirmed (`annotation.ts:146`); journal QA and accuracy outcomes as facts so history is auditable.

**10. Scheduled anomaly checks across projects (lower impact now, higher later).** On the projects list, flag projects whose last date has an unreleased hold or an unreviewed change set. Wait until 1 and 2 exist.

## 6. Risks

- Keep the existing rule that AI and change verdicts are proposals; insights should say "check" and never change data.
- Every rule needs a fixture test and a parity test where Python repeats it (as `series.parity.test.ts` does).
- Auto jobs must respect the "light local load" rule: quiet, cancellable, one at a time, behind a Settings switch like `autoPrepareSurfaces`.
