# @aio/insights

The site digest (intelligence review I2, study items 5.2, 5.4, 5.5 and 5.8). Pure and rules-based:
no AI, no I/O, and nothing here changes data. Depends on `@aio/schema` only.

- `siteInsights(snapshot)` (`rules.ts`): typed insights, each with a severity, a short text (an
  `insights.*` i18n key and its parameters), evidence references (measurements, dates, QA results,
  change sets) and suggested actions (right-click registry ids where one fits, else the digest's
  own `insights.openQa` and `insights.openChanges`). The renderer builds the snapshot from its
  stores and shows the list in the Project tab (`apps/desktop/src/renderer/insights/`).
- `volumeTrend(points)` (`trend.ts`): the rate in m³ per day across survey dates, a linear
  forecast (days to empty) and a robust z of the last rate, with an honest `not-enough-dates`
  state. Its Python twin is `python/src/aio_pipelines/survey/trend.py`; both reproduce
  `packages/schema/src/__fixtures__/survey/trend.json`.
- `qaFlagsFor(capture, ctx)` (`qaFlags.ts`): the fitness flags of a result's date
  (`ComparisonResult.qaFlags`), which the app stamps on measurement results.
