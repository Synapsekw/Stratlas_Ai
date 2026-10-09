/**
 * The survey picker (M11 G8, PRD SRV-12): the project's surveys grouped by year and month, with
 * their QA status and whether a surface is prepared, on the timeline's date focus (picking one
 * focuses it, as the date bar does). Helper datasets (cleaned and DTM surfaces, which belong to no
 * survey, and surveys with nothing to show) stay behind **Show hidden**.
 */
import type { Capture } from '@aio/schema';
import { formatDate, Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { timeline, useTimeline } from '../workspace/timeline';
import { isHeld, openQaPanel, surfaceOfCapture, useQa } from './qaStore';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface SurveyGroup {
  year: string;
  months: { month: string; captures: Capture[] }[];
}

/** Captures newest first, grouped by year and month of their date. */
export function groupByMonth(captures: readonly Capture[]): SurveyGroup[] {
  const sorted = [...captures].sort(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
  const out: SurveyGroup[] = [];
  for (const c of sorted) {
    const m = /^(\d{4})-(\d{2})/.exec(c.date);
    const year = m?.[1] ?? 'Undated';
    const month = m ? (MONTHS[Number(m[2]) - 1] ?? '') : '';
    let g = out.at(-1);
    if (g?.year !== year) {
      g = { year, months: [] };
      out.push(g);
    }
    let mg = g.months.at(-1);
    if (mg?.month !== month) {
      mg = { month, captures: [] };
      g.months.push(mg);
    }
    mg.captures.push(c);
  }
  return out;
}

export function SurveyPicker() {
  const project = useWorkspace((s) => s.project);
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const qa = useQa((s) => s.qa);
  const surfaces = useQa((s) => s.surfaces);
  const [hidden, setHidden] = useState(false);
  const manifestCaptures = project?.manifest.captures;
  const captures = useMemo(
    () => index?.captures ?? manifestCaptures ?? [],
    [index, manifestCaptures],
  );
  // surveys with no layer of their own are helpers (nothing to show on their date)
  const empty = useMemo(
    () => new Set(captures.filter((c) => index && !index.layers[c.id]?.length).map((c) => c.id)),
    [captures, index],
  );
  const shown = hidden ? captures : captures.filter((c) => !empty.has(c.id));
  const groups = useMemo(() => groupByMonth(shown), [shown]);
  const helpers = surfaces.filter((s) => !s.capture);
  const hiddenCount = empty.size + helpers.length;

  if (!project) return null;
  return (
    <section className="sv-card qa-card" aria-label="Surveys" data-testid="survey-picker">
      <div className="sv-head">
        <h2>Surveys</h2>
        <button
          type="button"
          className="btn sm ghost"
          aria-label="Close"
          onClick={() => {
            openQaPanel(null);
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      {groups.length === 0 && <p className="faint small">This project has no survey dates.</p>}
      {groups.map((g) => (
        <div key={g.year} className="qa-year">
          <h3 className="pop-title">{g.year}</h3>
          {g.months.map((m) => (
            <div key={m.month} className="qa-month">
              {m.month && <span className="faint small">{m.month}</span>}
              <ul className="qa-edits">
                {m.captures.map((c) => {
                  const q = qa[c.id];
                  const prepared = surfaceOfCapture(surfaces, c.id) !== null;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="qa-survey"
                        aria-pressed={focus === c.id}
                        data-testid={`survey-pick-${c.id}`}
                        onClick={() => {
                          timeline.getState().focusSurvey(c.id);
                        }}
                      >
                        <span className="qa-grow">{c.label}</span>
                        <span className="faint small">{formatDate(c.date)}</span>
                        {prepared && <span className="qa-pill">surface</span>}
                        {q && (
                          <span className={`qa-pill qa-${q.status}`}>
                            {isHeld(q) ? 'on hold' : q.status}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ))}
      <label className="sv-check">
        <input
          type="checkbox"
          checked={hidden}
          data-testid="survey-show-hidden"
          onChange={(e) => {
            setHidden(e.target.checked);
          }}
        />
        Show hidden ({hiddenCount})
      </label>
      {hidden && helpers.length > 0 && (
        <ul className="qa-edits" aria-label="Helper surfaces" data-testid="survey-helpers">
          {helpers.map((s) => (
            <li key={s.id} className="sv-row small">
              <span className="qa-grow">{s.name}</span>
              <span className="faint">
                {s.source.kind === 'derived' ? `from ${s.source.of}` : s.source.kind}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
