import { formatDate, Icon, useFocusTrap, useT } from '@aio/ui';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { builder } from '../builder/state';
import { newSurveyDate } from '../change/SurveyDate';
import { timeline } from '../workspace/timeline';
import { updateCapture } from './dateFolders';
// the popover look is the date folder menu's (`.dmenu`)
import '../builder/builder.css';
import './surveyDates.css';

/** Whether the Add survey date popover is open; the command palette opens it too. */
export const addDateMenu: StoreApi<{ open: boolean; set(open: boolean): void }> = createStore(
  (setState) => ({
    open: false,
    set: (open: boolean) => {
      setState({ open });
    },
  }),
);

const WIDTH = 260;
const HEIGHT = 230;

/** Keep the popover inside the window (the clamp of the date menus). */
function place(x: number, y: number, height: number): { left: number; top: number } {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
}

/** `place()` as style values. */
function px(at: { left: number; top: number }): { left: string; top: string } {
  return { left: `${String(at.left)}px`, top: `${String(at.top)}px` };
}

/** Today in local time, as `YYYY-MM-DD`. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A real calendar day as `YYYY-MM-DD` (a date in the future is fine: a planned flight). */
function isDay(day: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/**
 * The Datasets header's Add survey date button and its popover: add an empty survey date on a day
 * (named, when the day is new), or import a flight folder as a new date. A day that already has a
 * date is focused and reported through `onNote`.
 */
export function AddSurveyDateButton({ onNote }: { onNote: (text: string) => void }) {
  const t = useT();
  const open = useStore(addDateMenu, (s) => s.open);
  const btn = useRef<HTMLButtonElement>(null);

  // nothing stays open behind a project switch or a read-only reload
  useEffect(
    () => () => {
      addDateMenu.getState().set(false);
    },
    [],
  );

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="eye"
        data-testid="add-survey-date"
        aria-label={t('tree.addDate')}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('tree.addDate.tip')}
        onClick={() => {
          addDateMenu.getState().set(!open);
        }}
      >
        <Icon name="calendar-plus" size={14} />
      </button>
      {open && <AddDatePopover anchor={btn} onNote={onNote} />}
    </>
  );
}

/** The popover, mounted while open: a fresh form each time, placed under the button. */
function AddDatePopover({
  anchor,
  onNote,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  onNote: (text: string) => void;
}) {
  const t = useT();
  const pop = useRef<HTMLDivElement>(null);
  const [day, setDay] = useState(today);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = (refocus: boolean) => {
    addDateMenu.getState().set(false);
    if (refocus) anchor.current?.focus();
  };

  // under the button, kept inside the window
  useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const r = anchor.current?.getBoundingClientRect();
    Object.assign(el.style, px(place(r ? r.left : 8, r ? r.bottom + 4 : 8, HEIGHT)));
  }, [anchor]);

  // a press outside the popover (and outside the button, which toggles it) closes it
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (pop.current?.contains(target) || anchor.current?.contains(target)) return;
      addDateMenu.getState().set(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
    };
  }, [anchor]);

  useFocusTrap(pop, true, {
    onEscape: () => {
      close(true);
    },
    returnTo: () => anchor.current,
  });

  const submit = () => {
    if (busy) return;
    if (!isDay(day)) {
      setError(t('tree.addDate.invalid'));
      return;
    }
    const label = name.trim();
    setBusy(true);
    setError(null);
    void (async () => {
      const r = await newSurveyDate(day);
      if ('error' in r) {
        setBusy(false);
        setError(r.error);
        return;
      }
      if (r.created && label) {
        const failed = await updateCapture(r.captureId, { label });
        if (failed) {
          setBusy(false);
          setError(failed);
          return;
        }
      }
      if (!r.created) onNote(t('tree.addDate.exists', { date: formatDate(day) }));
      timeline.getState().focusSurvey(r.captureId);
      close(true);
    })();
  };

  return createPortal(
    <div
      ref={pop}
      className="dmenu add-date"
      role="dialog"
      aria-label={t('tree.addDate')}
      style={{ width: WIDTH }}
      data-testid="add-date-menu"
    >
      <div className="dmenu-h faint">{t('tree.addDate')}</div>
      <form
        className="add-date-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="add-date-field">
          <span>{t('tree.addDate.date')}</span>
          <input
            className="input"
            type="date"
            value={day}
            required
            onChange={(e) => {
              setDay(e.target.value);
              setError(null);
            }}
          />
        </label>
        <label className="add-date-field">
          <span>{t('tree.addDate.name')}</span>
          <input
            className="input"
            type="text"
            value={name}
            placeholder={t('tree.addDate.namePlaceholder')}
            maxLength={120}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        {error && (
          <p className="notice danger small add-date-error" role="alert">
            {error}
          </p>
        )}
        <div className="add-date-actions">
          <button
            type="submit"
            className="btn primary sm"
            disabled={busy}
            data-testid="add-date-submit"
          >
            {t('tree.addDate.submit')}
          </button>
        </div>
      </form>
      <div className="dmenu-sep" role="separator" />
      <button
        type="button"
        className="dmenu-item add-date-folder"
        data-testid="add-date-folder"
        onClick={() => {
          close(false);
          void builder.getState().pickAndImportFolder();
        }}
      >
        <Icon name="folder" size={14} />
        <span>
          <span>{t('tree.addDate.folder')}</span>
          <span className="add-date-hint faint">{t('tree.addDate.folderHint')}</span>
        </span>
      </button>
    </div>,
    document.body,
  );
}
