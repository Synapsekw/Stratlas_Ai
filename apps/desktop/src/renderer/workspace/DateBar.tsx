import { Calendar, Icon, formatDate, useFocusTrap, useT, type CalendarDay } from '@aio/ui';
import { dateTags } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { timeline, useTimeline } from './timeline';

/** Keys typed into a field belong to the field: shortcuts must leave them alone. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** The survey date in focus, with arrows to step and a calendar to pick. Hidden without dates. */
export function DateBar() {
  const t = useT();
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  // The calendar focuses its own current day when it mounts, so the trap's first-focus step
  // finds focus already inside and leaves it there.
  useFocusTrap(pop, open, {
    onEscape: () => {
      setOpen(false);
    },
    returnTo: () => opener.current,
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!pop.current?.contains(e.target as Node) && !opener.current?.contains(e.target as Node))
        setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
    };
  }, [open]);

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

  if (!index || index.captures.length === 0 || !focus) return null;
  const at = index.captures.findIndex((c) => c.id === focus);
  const current = index.captures[at];
  const total = index.captures.length;
  const tag = tags[focus];

  return (
    <div className="dbar" role="toolbar" aria-label={t('datebar.label')} data-testid="date-bar">
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
      <button
        ref={opener}
        type="button"
        className="dbar-date"
        data-testid="date-bar-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('datebar.open', { date: current ? formatDate(current.date) : '' })}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        <span className="dtag" style={{ background: tag?.colour }} aria-hidden="true" />
        {current ? formatDate(current.date) : ''}
      </button>
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
      <span className="dbar-count" data-testid="date-bar-count">
        {t('datebar.count', { n: at + 1, total })}
      </span>
      {open && (
        <div ref={pop} className="dbar-pop">
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
        </div>
      )}
    </div>
  );
}
