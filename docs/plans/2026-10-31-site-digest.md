---
type: plan
date: 2026-10-31
branch: feat/site-digest
status: built
related: [2026-10-30-intelligence-review.md, ../design/intelligence-review-2026-10/insight.md]
---

# Site digest (intelligence review I2)

Study items 5.2 (rules-based digest), 5.4 (volume rate and forecast), 5.5 (QA fitness flags on
measurement results) and 5.8 (suggested next actions). Builds on I1 (`newDatesWatch.ts`), which
writes the QA verdicts and change sets the digest reads.

## Decisions (made alone, founder away)

1. **New package `@aio/insights`**, depending on `@aio/schema` only. `siteInsights(snapshot)` is
   pure and rules-based: no AI, no I/O, never writes. The renderer builds the snapshot from the
   stores it already has (QA, measurements, change summaries and sets, captures).
2. **Insight shape**: `{ id, rule, severity: 'critical' | 'warning' | 'info', text: { key, params },
evidence: EvidenceRef[], actions: InsightAction[] }`. Text is an i18n key of the new `insights`
   area plus parameters, so the package stays language-free and a test proves every key exists.
   Evidence refs are typed (`measurement`, `capture`, `qa`, `changeSet`).
3. **Actions**: `{ id, target? , sub? }`. Registry ids where one fits (`measure.flyTo` on a
   measurement target, `date.compare` on a date with the other date as `sub`); the digest's own ids
   for what the registry has no action for: `insights.openQa` (Survey QA tab on that date) and
   `insights.openChanges` (Changes tab on that pair). Insights propose; a click runs the action or
   focuses the evidence, never changes data.
4. **Rules** (one fixture test each): survey on hold; latest later date not checked; checked without
   checkpoints; checkpoint RMSE over the site limit; change items to review on the latest pair;
   change set out of date after a line-up; pile moved more than 20 % (and 5 m3) since the date
   before; pile change departs from its trend (robust z over 3.5); pile empties within 60 days at
   its current rate. Sorted critical, warning, info; at most one insight per rule and subject.
5. **Trend** (`volumeTrend`): least-squares rate in m3 per day over the last 5 dates with a figure,
   R squared, days to empty when falling, and a robust z of the last change against the earlier
   changes (needs 3 earlier changes; MAD 0 gives none). Fewer than 3 dates: status
   `not-enough-dates` (with 2 the rate between them is still given, no forecast). Python twin
   `aio_pipelines/survey/trend.py`; both read `packages/schema/src/__fixtures__/survey/trend.json`.
6. **QA fitness flags** (`qa-hold`, `qa-released`, `qa-unchecked`, `no-checkpoints`,
   `rmse-over-limit`) are a view worked out when read (`qaFlagsFor`, `resultQaFlags`), never stored
   on a result (review decision: a stored flag goes stale and made Save light up on open). The
   earliest date is never `qa-unchecked`. No contract change.
7. **UI**: `renderer/insights/SiteDigest.tsx` + `siteDigest.css` + `en/insights.ts`, mounted with
   one line at the top of the Project tab (`MeasureBench`, before `ProjectList`). It reads the
   stores reactively, so it refreshes when I1's QA job and change compute land (both reload the
   QA and change stores). The move to W7's `project.digest` section is pending until W7 lands.
8. **Agent suggestions** (`suggestionsFor`) stay as they are; feeding them from the digest is a
   follow-up.

## Tasks

| Task | What                                                              | Tests                                                           | Packages                          |
| ---- | ----------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------- |
| T1   | `@aio/insights` package skeleton, types                           | -                                                               | insights (new)                    |
| T2   | `volumeTrend` + fixture + Python twin                             | `trend.test.ts`, `trend.parity.test.ts`, `test_survey_trend.py` | insights, schema fixtures, python |
| T3   | `qaFlagsFor`, `resultQaFlags` (read-time view)                    | `qaFlags.test.ts`                                               | insights                          |
| T4   | `siteInsights` rules                                              | `rules.test.ts` (one fixture per rule)                          | insights                          |
| T5   | Figures from the inventory rows (`figuresFromRows`), units        | `digestModel.test.ts` (digest figure equals the card's)         | insights, desktop renderer        |
| T6   | `SiteDigest` component, CSS, `insights` i18n area, one mount line | `SiteDigest.test.tsx`, `runInsight.test.ts`; keys typed         | desktop renderer, ui              |
| T7   | E2e `site-digest.spec.ts` on the change demo                      | itself                                                          | desktop e2e                       |
| T8   | Session note                                                      | `check-public-text`                                             | docs                              |

E2e added: `apps/desktop/e2e/site-digest.spec.ts`. None changed.

Contract change: none (flags are derived at read time; `QaState.loadedFor` is app state).

## Execution DAG

```
T1 --> T2 --+
     \--> T3 --> T4 --> T6 --> T7 --> T8
            \--> T5 ----^
```

- Batch 1: T1.
- Batch 2 (parallel, no shared files): T2, T3.
- Batch 3 (parallel): T4, T5.
- Batch 4: T6. Batch 5: T7. Batch 6: T8.
- Critical path: T1, T3, T4, T6, T7, T8.

Built by one agent in order; the batches mark what could run at once.

## Review round (31 Oct)

The independent review asked for: flags never persisted (done, see 6); figures from the volume
card's rule (`inventorySeries` through `useInventory`, `figuresFromRows`); quantities in the site's
units; the forecast read against today ("At this rate, empty by", or "would already be empty" as a
warning); only the latest held date critical, earlier holds in one note; the menu's own refusal of
a date to compare with; a note when evidence is gone; the Python twin refusing non-ISO dates and
booleans (two fixture cases); an accessible count; token spacing. The e2e spec also covers Compare
dates through the registry and Save staying off.
