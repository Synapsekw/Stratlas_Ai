/**
 * The site digest (intelligence review I2): at the top of the Project tab, what is worth a look on
 * the site now, most pressing first. Read from the stores the app keeps for the open project (the
 * survey QA files, the measurements and their figures over time, the change sets), so it follows
 * them as they change: when the checks after a new date (I1) land their QA verdict and change set,
 * the digest says so without a click. Rules, not AI (`@aio/insights`); it proposes, never changes
 * data. Each line shows its evidence on a click; its buttons run the right-click registry's item
 * or open the panel that answers it.
 *
 * Self-contained: one mount line in the Project tab. Shown only on a project with two or more
 * survey dates.
 */
import { changeSetStale, useChange } from '@aio/change';
import { siteInsights, type Insight } from '@aio/insights';
import { inventoryPiles } from '@aio/survey';
import { Button, Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useId, useMemo, useState, type ReactElement } from 'react';
import { useMeasure } from '../survey/measureStore';
import { toastHost } from '../shell/actions/toastHost';
import { useInventory } from '../survey/useInventory';
import { useQa } from '../survey/qaStore';
import {
  ACTION_LABEL,
  digestSnapshot,
  figureCount,
  FOLDED_ROWS,
  insightLine,
  localToday,
} from './digestModel';
import { focusInsight, runInsightAction } from './runInsight';
import './siteDigest.css';

/** The open project's insights, kept in step with its stores; null without two survey dates. */
export function useSiteInsights(today = localToday()): Insight[] | null {
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  // the open project's id (a working copy's may differ from its manifest's)
  const id = useWorkspace((s) => s.project?.id ?? null);
  // each store's data only once it is of the open project (a store still on the last one is left out)
  const qaOf = useQa((s) => s.loadedFor);
  const qa = useQa((s) => s.qa);
  const measuresOf = useMeasure((s) => s.projectId);
  const settings = useMeasure((s) => s.settings);
  const measurements = useMeasure((s) => s.file.measurements);
  const changesOf = useChange((s) => s.projectId);
  const summaries = useChange((s) => s.summaries);
  const sets = useChange((s) => s.sets);
  // the volume measurements and their counted figures per date: the card's and the totals' rule
  const piles = useMemo(
    () => (measuresOf === id ? inventoryPiles(measurements) : []),
    [measuresOf, id, measurements],
  );
  const rows = useInventory(piles);
  return useMemo(() => {
    const mine = (of: string | null) => of === id;
    // no digest until the project's QA files are read: a date is never called unchecked early
    if (!manifest || manifest.captures.length < 2 || !mine(qaOf)) return null;
    return siteInsights(
      digestSnapshot({
        manifest,
        qa,
        settings,
        piles,
        rows,
        summaries: mine(changesOf) ? summaries : [],
        sets: mine(changesOf) ? sets : {},
        isStale: (set) => changeSetStale(set, manifest),
        today,
      }),
    );
  }, [manifest, id, qaOf, qa, settings, piles, rows, changesOf, summaries, sets, today]);
}

function Row({ insight }: { insight: Insight }): ReactElement {
  const t = useT();
  const units = useMeasure((s) => s.settings);
  const figures = figureCount(insight);
  const showFigures = insight.rule === 'survey-held' && figures > 0;
  return (
    <li
      className="sd-row"
      data-severity={insight.severity}
      data-rule={insight.rule}
      data-testid="site-digest-item"
    >
      <span className="sd-mark" aria-hidden="true">
        {insight.severity === 'info' ? <span className="sd-dot" /> : <Icon name="warn" size={12} />}
      </span>
      <div className="sd-body">
        <button
          type="button"
          className="sd-line"
          onClick={() => {
            // evidence that is gone (a measurement deleted, a set recomputed) says so
            if (!focusInsight(insight))
              toastHost(t('insights.title')).note(t('insights.notFound'), true);
          }}
        >
          <span className="sr-only">{t(`insights.severity.${insight.severity}`)}: </span>
          {insightLine(insight, t, units)}
        </button>
        {showFigures && (
          <span className="sd-sub">{t('insights.evidence.figures', { count: figures })}</span>
        )}
        {insight.actions.length > 0 && (
          <div className="sd-actions">
            {insight.actions.map((a) => (
              <Button
                key={`${a.id}:${a.measurement ?? a.capture ?? a.pair?.to ?? ''}`}
                variant="quiet"
                data-testid={`site-digest-action-${a.id}`}
                onClick={() => {
                  runInsightAction(a);
                }}
              >
                {t(ACTION_LABEL[a.id])}
              </Button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

export function SiteDigest(): ReactElement | null {
  const t = useT();
  const insights = useSiteInsights();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  if (insights === null) return null;
  const rows = open ? insights : insights.slice(0, FOLDED_ROWS);
  const hidden = insights.length - rows.length;
  const pressing = insights.filter((i) => i.severity !== 'info').length;
  return (
    <section
      className="sd"
      data-testid="site-digest"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-hint`}
    >
      <p className="sr-only" id={`${titleId}-hint`}>
        {t('insights.hint')}
      </p>
      <h3 className="sd-caption" id={titleId}>
        <span className="caps">{t('insights.title')}</span>
        {insights.length > 0 && (
          <span className="sd-count" data-pressing={pressing > 0} data-testid="site-digest-count">
            <span aria-hidden="true">{insights.length}</span>
            <span className="sr-only">{t('insights.count', { count: insights.length })}</span>
          </span>
        )}
      </h3>
      {insights.length === 0 ? (
        <p className="sd-clear" data-testid="site-digest-clear">
          <Icon name="check" size={12} />
          {t('insights.clear')}
        </p>
      ) : (
        <ul className="sd-list">
          {rows.map((i) => (
            <Row key={i.id} insight={i} />
          ))}
        </ul>
      )}
      {(hidden > 0 || open) && insights.length > FOLDED_ROWS && (
        <button
          type="button"
          className="sd-more"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? t('insights.less') : t('insights.more', { count: hidden })}
        </button>
      )}
    </section>
  );
}
