/**
 * The survey date in the island: the pill ("13 Apr" in the survey's colour), with ‹ › and the
 * count while the island is open, and the calendar the pill opens (D7). In Split the date is the
 * last focused pane's (`focusedSide`), and the arrows step that pane.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { Calendar, formatDate, Icon, IconButton, Tip, useT, type IconName } from '@aio/ui';
import { useWorkspace, type CaptureIndex } from '@aio/workspace';
import { useId } from 'react';
import { useStore } from 'zustand';
import { openLineUpFor, removeLineUp } from '../../lineup/lineUpActions';
import { lineUpApp } from '../../lineup/lineUpStore';
import { useShell } from '../../shell';
import { toastHost } from '../../shell/actions/toastHost';
import { useCalendarDays } from '../DatePicker';
import { chooseCapture, type Side } from '../splitModel';
import { paneCapture, type SplitModel } from '../SplitPanes';
import { timeline } from '../timeline';

/** "13 Apr": the pill's date, its year in the pill's name. */
export const shortDate = (iso: string): string => formatDate(iso, { year: false });

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
 * The date bar's survey, or in Split the date of `side`, the pane the island follows
 * (`focusedSide` in splitModel.ts: the last focused pane drawn per date). Its arrows, the calendar
 * and Alt+Left / Alt+Right (Island.tsx) step that pane; the other side keeps its date.
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
      {/* the date control the specs know as the date bar (the island's own row is date-row) */}
      <span className="isl-date-bar" data-testid="date-bar">
        {steps && many && (
          <IconButton
            icon="chev-r"
            size="sm"
            className="isl-arrow prev"
            label={t('datebar.prev')}
            data-testid="date-bar-prev"
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
            data-testid="date-bar-next"
            shortcut="global.nextSurvey"
            disabled={at >= dates.order.length - 1}
            onClick={() => {
              dates.step(1);
            }}
          />
        )}
      </span>
    </span>
  );
}

/**
 * Line up dates and Remove line-up for the shown date, as its date menu has them
 * (shell/actions/dateActions.tsx): Line up with two dates or more, Remove on a date that is lined
 * up, each greyed with the menu's reason (a package, a reviewer who may only look, the step not up
 * yet) rather than left out. `false` where the item does not apply, else the reason or null.
 */
function useLineUp(captureId: string): {
  lineUp: string | null | false;
  remove: string | null | false;
} {
  const t = useT();
  const ready = useStore(lineUpApp, (s) => s.store !== null);
  const pkg = useShell((s) => s.pkg !== null);
  const lookOnly = useAnnotateReadOnly();
  const dates = useWorkspace((s) => s.project?.manifest.captures.length ?? 0);
  const lined = useWorkspace(
    (s) => s.project?.manifest.captures.find((c) => c.id === captureId)?.lineUp !== undefined,
  );
  // the date menu's order: editBlocked (package, then look-only), then the step not ready
  const blocked = pkg
    ? t('actions.reason.package')
    : lookOnly
      ? t('actions.reason.readOnly')
      : ready
        ? null
        : t('lineUp.menu.notReady');
  return { lineUp: dates > 1 && blocked, remove: lined && blocked };
}

/** A line-up item: greyed with its reason (in its tip and its description) when it is blocked. */
function LineUpItem({
  icon,
  label,
  reason,
  onRun,
}: {
  icon: IconName;
  label: string;
  reason: string | null;
  onRun: () => void;
}) {
  const id = useId();
  const item = (
    <button
      type="button"
      className="isl-compare"
      aria-disabled={reason ? true : undefined}
      aria-describedby={reason ? id : undefined}
      onClick={() => {
        if (!reason) onRun();
      }}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
  if (!reason) return item;
  return (
    <>
      <Tip content={reason}>{item}</Tip>
      <span id={id} className="sr-only">
        {reason}
      </span>
    </>
  );
}

/** The calendar inside the island: the month, the survey list, Compare and line up the dates. */
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
  const lineUp = useLineUp(dates.focus);
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
        {lineUp.lineUp !== false && (
          <LineUpItem
            icon="target"
            label={t('lineUp.action')}
            reason={lineUp.lineUp}
            onRun={() => {
              const captureId = dates.focus;
              onDone();
              // the step picks the date this one overlaps most; without one it says why
              void openLineUpFor(captureId).then((why) => {
                if (why) toastHost(t('lineUp.action')).note(why, true);
              });
            }}
          />
        )}
        {lineUp.remove !== false && (
          <LineUpItem
            icon="undo"
            label={t('lineUp.remove')}
            reason={lineUp.remove}
            onRun={() => {
              removeLineUp(dates.focus);
              onDone();
            }}
          />
        )}
      </div>
    </div>
  );
}
