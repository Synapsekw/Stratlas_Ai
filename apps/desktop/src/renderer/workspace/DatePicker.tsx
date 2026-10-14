import { Calendar, Icon, Popover, formatDate, useT, type CalendarDay } from '@aio/ui';
import { dateTags } from '@aio/workspace';
import { useMemo, useRef, useState } from 'react';
import { timeline, useTimeline } from './timeline';

/**
 * The focused survey date as a button that opens the calendar. `up` opens the calendar above the
 * button (the timeline and the date row sit at the bottom of the window).
 */
export function DatePicker({ up = false }: { up?: boolean }) {
  const t = useT();
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
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
        <span className="dtag" style={{ background: tags[focus]?.colour }} aria-hidden="true" />
        {formatDate(current.date)}
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        opener={opener}
        className={up ? 'dbar-pop up' : 'dbar-pop'}
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

/** Previous date, the date picker, next date (arrows only with more than one date). */
export function DateSteps({ up = false }: { up?: boolean }) {
  const t = useT();
  const total = useTimeline((s) => s.index?.captures.length ?? 0);
  return (
    <>
      {total > 1 && (
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="date-bar-prev"
          aria-label={t('datebar.prev')}
          onClick={() => {
            timeline.getState().step(-1);
          }}
        >
          <Icon name="back" size={14} />
        </button>
      )}
      <DatePicker up={up} />
      {total > 1 && (
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="date-bar-next"
          aria-label={t('datebar.next')}
          onClick={() => {
            timeline.getState().step(1);
          }}
        >
          <Icon name="fwd" size={14} />
        </button>
      )}
    </>
  );
}
