/**
 * The survey date in the island: the pill ("13 Apr" in the survey's colour), with ‹ › and the
 * count while the island is open, and the calendar the pill opens (D7). In Split the date is the
 * last focused pane's, and the arrows step that pane.
 */
import { Calendar, formatDate, Icon, IconButton, useT } from '@aio/ui';
import type { CaptureIndex } from '@aio/workspace';
import { useCalendarDays } from '../DatePicker';
import { chooseCapture, type Side } from '../splitModel';
import { paneCapture, type SplitModel } from '../SplitPanes';
import { timeline } from '../timeline';

/** "13 Apr 2026" without its year. */
export const shortDate = (iso: string): string => formatDate(iso).replace(/ \d{4}$/, '');

/** The dates the island steps through, and which one it shows. */
export interface IslandDates {
  index: CaptureIndex;
  /** The ids the arrows step through, oldest first. */
  order: readonly string[];
  focus: string;
  pick: (id: string) => void;
  step: (dir: -1 | 1) => void;
}

/**
 * The date bar's survey, or in Split the date of the last focused pane when that pane is drawn
 * per date (its arrows step that pane; the other side keeps its date).
 */
export function islandDates(
  index: CaptureIndex | null,
  focus: string | null,
  split: SplitModel | null,
  side: Side,
): IslandDates | null {
  if (!index || index.captures.length === 0) return null;
  const pane = split ? paneCapture(split, side) : undefined;
  const dates = split?.dates;
  if (split && dates && pane) {
    const order = dates.captures;
    const pick = (id: string) => {
      split.set(chooseCapture(split.sides, side, id, dates));
    };
    return {
      index,
      order,
      focus: pane,
      pick,
      step: (dir) => {
        const next = order[order.indexOf(pane) + dir];
        if (next) pick(next);
      },
    };
  }
  const current = focus ?? index.captures.at(-1)?.id;
  if (!current) return null;
  return {
    index,
    order: index.captures.map((c) => c.id),
    focus: current,
    pick: (id) => {
      timeline.getState().focusSurvey(id);
    },
    step: (dir) => {
      timeline.getState().step(dir);
    },
  };
}

/** The date pill; open (`steps`), the arrows and "2 of 2" too. */
export function IslandDate({
  dates,
  steps,
  onOpen,
}: {
  dates: IslandDates;
  steps: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const { colour } = useCalendarDays(dates.index);
  const current = dates.index.captures.find((c) => c.id === dates.focus);
  const at = dates.order.indexOf(dates.focus);
  const many = dates.order.length > 1;
  if (!current) return null;
  return (
    <span className="isl-date" data-testid="date-row">
      {steps && many && (
        <IconButton
          icon="chev-r"
          size="sm"
          className="isl-arrow prev"
          label={t('datebar.prev')}
          shortcut="global.prevSurvey"
          disabled={at <= 0}
          onClick={() => {
            dates.step(-1);
          }}
        />
      )}
      <button
        type="button"
        className="isl-pill"
        data-testid="date-bar-open"
        aria-haspopup="dialog"
        aria-label={t('datebar.open', { date: formatDate(current.date) })}
        onClick={onOpen}
      >
        <span
          className="isl-swatch"
          style={{ background: colour(current.id) ?? 'var(--acc)' }}
          aria-hidden="true"
        />
        <span className="isl-day">{shortDate(current.date)}</span>
        {steps && many && (
          <span className="isl-count" data-testid="date-bar-count">
            {t('island.dateCount', { n: at + 1, total: dates.order.length })}
          </span>
        )}
      </button>
      {steps && many && (
        <IconButton
          icon="chev-r"
          size="sm"
          className="isl-arrow next"
          label={t('datebar.next')}
          shortcut="global.nextSurvey"
          disabled={at >= dates.order.length - 1}
          onClick={() => {
            dates.step(1);
          }}
        />
      )}
    </span>
  );
}

/** The calendar inside the island: the month, the survey list and Compare the two dates. */
export function IslandCalendar({
  dates,
  onDone,
  onCompare,
}: {
  dates: IslandDates;
  onDone: () => void;
  /** Absent when there is nothing to compare (one date, or comparing already). */
  onCompare: (() => void) | null;
}) {
  const t = useT();
  const { days, colour } = useCalendarDays(dates.index);
  const pick = (id: string) => {
    dates.pick(id);
    onDone();
  };
  return (
    <div className="isl-cal">
      <Calendar days={days} focusId={dates.focus} onPick={pick} onClose={onDone} />
      <div className="isl-cal-list">
        {days.map((d) => (
          <button
            key={d.id}
            type="button"
            aria-pressed={d.id === dates.focus}
            onClick={() => {
              pick(d.id);
            }}
          >
            <span className="isl-swatch" style={{ background: colour(d.id) }} aria-hidden="true" />
            <b>{d.label}</b>
            <span className="isl-faint">{d.count}</span>
          </button>
        ))}
        {onCompare && (
          <button
            type="button"
            className="isl-compare"
            onClick={() => {
              onCompare();
              onDone();
            }}
          >
            <Icon name="history" size={14} />
            {t('island.compareDates')}
          </button>
        )}
      </div>
    </div>
  );
}
