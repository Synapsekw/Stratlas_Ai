import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import { monthGrid, stepMonth, surveyMonths } from './calendarModel';

export interface CalendarDay {
  id: string;
  date: string;
  colour: string;
  label: string;
  count: number;
}

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

const ARROW_STEP: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

export function Calendar(props: {
  days: readonly CalendarDay[];
  focusId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { days, focusId, onPick, onClose } = props;
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const byDate = useMemo(() => {
    const m = new Map<string, CalendarDay[]>();
    for (const d of days) m.set(d.date, [...(m.get(d.date) ?? []), d]);
    return m;
  }, [days]);
  const months = useMemo(() => surveyMonths(days.map((d) => d.date)), [days]);
  const focusDate = days.find((d) => d.id === focusId)?.date ?? days.at(-1)?.date ?? '';
  const [month, setMonth] = useState(focusDate.slice(0, 7) || (months.at(-1) ?? ''));
  const [choice, setChoice] = useState<string | null>(null);
  const [y, m] = month.split('-').map(Number) as [number, number];

  const pickDate = (date: string) => {
    const on = byDate.get(date) ?? [];
    if (on.length === 1 && on[0]) onPick(on[0].id);
    else if (on.length > 1) setChoice(date);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = document.activeElement as HTMLElement | null;
    const date = el?.dataset.date;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      setMonth(stepMonth(months, month, e.key === 'PageUp' ? -1 : 1));
      return;
    }
    if (!date) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pickDate(date);
      return;
    }
    const delta = ARROW_STEP[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + delta);
    const iso = next.toISOString().slice(0, 10);
    if (iso.slice(0, 7) !== month) setMonth(iso.slice(0, 7));
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>(`[data-date="${iso}"]`)?.focus(),
    );
  };

  return (
    <div
      ref={root}
      className="cal"
      role="dialog"
      aria-label={t('calendar.label')}
      data-testid="calendar"
      onKeyDown={onKeyDown}
    >
      <div className="cal-head">
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="cal-prev"
          aria-label={t('calendar.prev')}
          onClick={() => {
            setMonth(stepMonth(months, month, -1));
          }}
        >
          <Icon name="back" size={14} />
        </button>
        <span className="cal-month" data-testid="cal-month" aria-live="polite">
          {MONTHS[m - 1]} {y}
        </span>
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="cal-next"
          aria-label={t('calendar.next')}
          onClick={() => {
            setMonth(stepMonth(months, month, 1));
          }}
        >
          <Icon name="fwd" size={14} />
        </button>
      </div>
      <div className="cal-grid" role="grid">
        <div className="cal-row cal-wd" role="row" aria-hidden="true">
          {t('calendar.weekdays')
            .split(' ')
            .map((w) => (
              <span key={w}>{w}</span>
            ))}
        </div>
        {monthGrid(month).map((row, r) => (
          <div className="cal-row" role="row" key={r}>
            {row.map((date, c) => {
              if (!date) return <span key={c} className="cal-cell" role="gridcell" />;
              const on = byDate.get(date) ?? [];
              const first = on[0];
              const day = Number(date.slice(8));
              if (!first)
                return (
                  <span key={c} className="cal-cell" role="gridcell">
                    {day}
                  </span>
                );
              const current = on.some((d) => d.id === focusId);
              return (
                <span key={c} role="gridcell" className="cal-cell">
                  <button
                    type="button"
                    className={`cal-day${current ? ' current' : ''}`}
                    data-testid={`cal-day-${date}`}
                    data-date={date}
                    style={{ background: first.colour }}
                    aria-label={t('calendar.day', {
                      date: first.label,
                      count: on.reduce((n, d) => n + d.count, 0),
                    })}
                    aria-current={current ? 'date' : undefined}
                    onClick={() => {
                      pickDate(date);
                    }}
                  >
                    {day}
                    {on.length > 1 && <span className="cal-multi">{on.length}</span>}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      {choice && (
        <div
          className="cal-choices"
          role="listbox"
          aria-label={t('calendar.pick', { date: choice })}
        >
          {(byDate.get(choice) ?? []).map((d) => (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={d.id === focusId}
              data-testid={`cal-choice-${d.id}`}
              onClick={() => {
                onPick(d.id);
              }}
            >
              <span className="dtag" style={{ background: d.colour }} aria-hidden="true" />{' '}
              {d.label} · {d.count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
