/**
 * Survey surfaces preparing (volumetrics redesign, spec section 2, board 7): a card at the foot of
 * the stage while a `survey.prepare` job is at work, one row per date that job (or one before it
 * in the same run) prepares, "ready" or its percentage with a thin bar. It closes 2 s after the
 * last date stops preparing; Cancel is in Jobs. The sidebar's survey date rows read the same
 * per-date status (`useSurfacePrepareStatus`): only the dates a job prepared since the project
 * opened say anything.
 */
import { formatDate, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { isActive, sameFolder, type JobEntry } from '../jobs';
import { useJobs } from '../shell';
import { useSurfaceStates, type SurfaceState } from './surfaceStates';
import './measure.css';

/** Time the card stays once nothing prepares any more, ms. */
export const CLOSE_AFTER_MS = 2000;

const NONE: ReadonlySet<string> = new Set();

/**
 * The dates seen preparing since `key` last changed, kept as they finish (a new key starts
 * afresh). Grows during render, so a date's first preparing frame already counts.
 */
function useSeenPreparing(
  states: ReadonlyMap<string, SurfaceState>,
  key: string,
): ReadonlySet<string> {
  const [seen, setSeen] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key,
    ids: NONE,
  });
  let ids = seen.key === key ? seen.ids : NONE;
  const added = [...states].filter(([id, s]) => s.kind === 'preparing' && !ids.has(id));
  if (added.length > 0 || seen.key !== key) {
    ids = new Set([...ids, ...added.map(([id]) => id)]);
    setSeen({ key, ids });
  }
  return ids;
}

/**
 * The status of each date a prepare job worked on since the project opened: preparing (with its
 * percentage) or ready. Dates no job touched, or that did not end ready, are left out.
 */
export function useSurfacePrepareStatus(): ReadonlyMap<string, SurfaceState> {
  const project = useWorkspace((s) => s.project);
  const states = useSurfaceStates();
  const seen = useSeenPreparing(states, project?.id ?? '');
  return useMemo(() => {
    const out = new Map<string, SurfaceState>();
    for (const id of seen) {
      const s = states.get(id);
      if (s && (s.kind === 'ready' || s.kind === 'preparing')) out.set(id, s);
    }
    return out;
  }, [seen, states]);
}

export interface PreparingRow {
  capture: string;
  label: string;
  state: SurfaceState | undefined;
}

export interface PreparingModel {
  rows: PreparingRow[];
  done: number;
  /** A prepare job started on its own (quietly, when the project opened) is part of the run. */
  onOpen: boolean;
}

const quietPrepare = (jobs: readonly JobEntry[], root: string) =>
  jobs.some(
    (j) =>
      j.pipeline === 'survey.prepare' &&
      j.quiet === true &&
      isActive(j) &&
      sameFolder(j.project, root),
  );

/** The card's content while it shows, else null. */
export function usePreparingCard(): PreparingModel | null {
  const project = useWorkspace((s) => s.project);
  const list = useJobs((s) => s.jobs);
  const states = useSurfaceStates();
  const preparing = [...states.values()].some((s) => s.kind === 'preparing');
  // a run: from the first date preparing to the card closing
  const [run, setRun] = useState({ shown: false, gen: 0, onOpen: false });
  const quietNow = project !== null && quietPrepare(list, project.root);
  if (preparing && (!run.shown || (quietNow && !run.onOpen)))
    setRun({ shown: true, gen: run.gen, onOpen: run.onOpen || quietNow });
  const seen = useSeenPreparing(states, `${project?.id ?? ''}:${String(run.gen)}`);
  useEffect(() => {
    if (preparing || !run.shown) return;
    const timer = setTimeout(() => {
      setRun((r) => ({ shown: false, gen: r.gen + 1, onOpen: false }));
    }, CLOSE_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [preparing, run.shown]);
  return useMemo(() => {
    if (!project || !(run.shown || preparing) || seen.size === 0) return null;
    const rows = project.manifest.captures
      .filter((c) => seen.has(c.id))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      .map((c) => ({ capture: c.id, label: formatDate(c.date), state: states.get(c.id) }));
    const done = rows.filter((r) => r.state?.kind === 'ready').length;
    return { rows, done, onOpen: run.onOpen || quietNow };
  }, [project, run, preparing, seen, states, quietNow]);
}

/** The card itself, given its content. */
export function PreparingCardView({ model }: { model: PreparingModel }) {
  const t = useT();
  return (
    <section
      className="prep-card"
      data-testid="preparing-card"
      role="status"
      aria-label={t('surface.preparing.title')}
    >
      <header className="prep-head">
        <span className="prep-title">{t('surface.preparing.title')}</span>
        <span className="prep-count">
          {t('surface.preparing.count', { done: model.done, total: model.rows.length })}
        </span>
      </header>
      <ul className="prep-rows">
        {model.rows.map((r) => {
          const pct =
            r.state?.kind === 'ready' ? 100 : r.state?.kind === 'preparing' ? r.state.pct : 0;
          return (
            <li
              key={r.capture}
              className="prep-row"
              data-testid="preparing-row"
              data-capture={r.capture}
              data-state={r.state?.kind}
            >
              <span className="prep-date">{r.label}</span>
              <span className="prep-status">
                {r.state?.kind === 'ready'
                  ? t('surface.state.ready')
                  : r.state?.kind === 'preparing'
                    ? t('surface.preparing.pct', { pct: r.state.pct })
                    : ''}
              </span>
              <span className="prep-bar" aria-hidden="true">
                <span className="prep-fill" style={{ inlineSize: `${String(pct)}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      {model.onOpen && <p className="prep-note">{t('surface.preparing.onOpen')}</p>}
    </section>
  );
}

/** The preparing card while any survey date prepares; gone 2 s after the last finishes. */
export function PreparingCard() {
  const model = usePreparingCard();
  return model ? <PreparingCardView model={model} /> : null;
}
