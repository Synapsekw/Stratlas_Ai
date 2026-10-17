import { Calendar, Popover, formatDate, useT, type CalendarDay } from '@aio/ui';
import { dateTags, type CaptureIndex } from '@aio/workspace';
import { useMemo, useRef, useState } from 'react';
import { timeline, useTimeline } from './timeline';

/** The project's survey dates as calendar days, each in its date colour. */
export function useCalendarDays(index: CaptureIndex | null): {
  days: CalendarDay[];
  colour: (id: string) => string | undefined;
} {
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  const days: CalendarDay[] = useMemo(
    () =>
      (index?.captures ?? []).map((c) => ({
        id: c.id,
        date: c.date,
        colour: tags[c.id]?.colour ?? 'var(--acc)',
        label: formatDate(c.date),
        count: index?.layers[c.id]?.length ?? 0,
      })),
    [index, tags],
  );
  return { days, colour: (id) => tags[id]?.colour };
}

/**
 * The focused survey date as a button that opens the calendar. `up` opens the calendar above the
 * button (the lane timeline sits at the bottom of the window), rendered on the page
 * body so a scrolling box around the button (the lane timeline's body) does not clip it.
 */
export function DatePicker({ up = false }: { up?: boolean }) {
  const t = useT();
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const { days, colour } = useCalendarDays(index);
  const current = index?.captures.find((c) => c.id === focus);
  if (!index || !focus || !current) return null;

  return (
    <span className="dpick">
      <button
        ref={opener}
        type="button"
        className="dbar-date"
        data-testid="date-bar-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('datebar.open', { date: formatDate(current.date) })}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        <span className="dtag" style={{ background: colour(focus) }} aria-hidden="true" />
        {formatDate(current.date)}
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        opener={opener}
        className={up ? 'dbar-pop up' : 'dbar-pop'}
        anchor={up ? 'above' : undefined}
      >
        <Calendar
          days={days}
          focusId={focus}
          onPick={(id) => {
            timeline.getState().focusSurvey(id);
            setOpen(false);
          }}
          onClose={() => {
            setOpen(false);
          }}
        />
      </Popover>
    </span>
  );
}
