import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type ReactElement,
} from 'react';
import { Button, IconButton } from '../controls';
import { useT } from '../i18n';
import { Icon, type IconName } from '../icons/Icon';
import {
  dismissToast,
  registerHost,
  setToastHostHeld,
  subscribeToasts,
  toastStamp,
  visibleToast,
  waitingCount,
  type Toast,
  type ToastPlacement,
  type ToastTone,
} from './store';

const TONE_ICON: Readonly<Record<ToastTone, IconName>> = {
  info: 'bell',
  ok: 'check',
  warn: 'warn',
  error: 'warn',
};

export interface ToastHostProps {
  /** 'stage': the bottom-left slot of the 3D view; 'window': the window corner, off the stage. */
  placement: ToastPlacement;
  /**
   * Hold the toast back for now (the stage's bottom-left slot shows a newer hint): it waits in
   * the queue, its clock stopped, and shows in full when the host lets it go. The host stays
   * mounted, so toasts keep coming to it.
   */
  held?: boolean;
}

/**
 * Runs `onExpire` after `ms` of visible time. The clock stops while `paused` (the pointer or focus
 * is on the toast, or the window is hidden) and resumes with the time that was left; a new `key`
 * starts it again in full.
 */
function useExpiry(key: string, ms: number, paused: boolean, onExpire: () => void): void {
  const left = useRef(ms);
  const fire = useRef(onExpire);
  useEffect(() => {
    fire.current = onExpire;
  });
  useEffect(() => {
    left.current = ms;
  }, [key, ms]);
  useEffect(() => {
    if (ms <= 0 || paused || !key) return;
    const start = Date.now();
    const id = setTimeout(() => {
      fire.current();
    }, left.current);
    return () => {
      clearTimeout(id);
      left.current = Math.max(0, left.current - (Date.now() - start));
    };
  }, [key, ms, paused]);
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() =>
    typeof document === 'undefined' ? false : document.hidden,
  );
  useEffect(() => {
    const on = () => {
      setHidden(document.hidden);
    };
    document.addEventListener('visibilitychange', on);
    return () => {
      document.removeEventListener('visibilitychange', on);
    };
  }, []);
  return hidden;
}

/**
 * Where toasts show: one at a time, the newest first. Errors are read out at once (`role="alert"`),
 * the rest politely (`role="status"`). Both live regions stay mounted so a toast's arrival is
 * announced. The timer pauses while the toast is hovered or focused and while the window is
 * hidden; Escape on a focused toast dismisses it (or, on one without a close button, only leaves
 * it). A count says how many wait behind it. When a newer toast takes the place of the one that
 * had focus, focus moves to the newer card instead of falling to the page.
 */
export function ToastHost({ placement, held = false }: ToastHostProps): ReactElement {
  const t = useT();
  useEffect(() => registerHost(placement), [placement]);
  // held takes effect as the commit lands (a layout effect, before any paint or key): there is
  // no frame where a held toast counts as on screen and its keys act
  useLayoutEffect(() => {
    setToastHostHeld(placement, held);
    return () => {
      setToastHostHeld(placement, false);
    };
  }, [placement, held]);
  useSyncExternalStore(subscribeToasts, toastStamp, toastStamp);
  const shown = held ? undefined : visibleToast(placement);
  const waiting = held ? 0 : waitingCount(placement);
  const root = useRef<HTMLDivElement>(null);
  // focus was in a card that then left the screen (not moved away by the person)
  const hadFocus = useRef(false);
  const onFocus = () => {
    hadFocus.current = true;
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const from = e.target;
    const to = e.relatedTarget;
    if (to instanceof Node && root.current?.contains(to)) return;
    if (to !== null) {
      hadFocus.current = false;
      return;
    }
    // to nowhere: a click on the page, or the focused card was taken off; only the second keeps it
    setTimeout(() => {
      if (from.isConnected) hadFocus.current = false;
    }, 0);
  };
  const shownId = shown?.id;
  useLayoutEffect(() => {
    if (!hadFocus.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && root.current?.contains(active)) return;
    if (active && active !== document.body) {
      hadFocus.current = false;
      return;
    }
    const card = root.current?.querySelector<HTMLElement>('.q-toast');
    if (card) card.focus();
    else hadFocus.current = false;
  }, [shownId]);
  return (
    <div
      ref={root}
      className="q-toasts"
      data-placement={placement}
      data-testid={`toast-host-${placement}`}
      data-held={held ? '' : undefined}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div role="status" aria-live="polite" aria-atomic="true" className="q-toast-region">
        {shown && shown.tone !== 'error' && <ToastCard key={shown.id} toast={shown} />}
      </div>
      <div role="alert" aria-atomic="true" className="q-toast-region">
        {shown?.tone === 'error' && <ToastCard key={shown.id} toast={shown} />}
      </div>
      {waiting > 0 && (
        <div className="q-toast-waiting" data-testid={`toast-waiting-${placement}`}>
          {t('toast.waiting', { count: waiting })}
        </div>
      )}
    </div>
  );
}

function ToastCard({ toast: x }: { toast: Toast }): ReactElement {
  const t = useT();
  const [hover, setHover] = useState(false);
  // the version focus came in at: a replace (its action button gone, no blur) unpauses it
  const [focusedAt, setFocusedAt] = useState<number | null>(null);
  const focus = focusedAt === x.version;
  const hidden = useDocumentHidden();
  const Body = x.body;
  const dismiss = () => {
    dismissToast(x.id);
    x.onDismiss?.();
  };
  useExpiry(`${x.id}#${String(x.version)}`, x.ttlMs, hover || focus || hidden, () => {
    dismissToast(x.id);
  });
  return (
    <div
      className="q-toast"
      data-tone={x.tone}
      data-body={Body ? '' : undefined}
      tabIndex={-1}
      data-testid={x.testId ?? 'toast'}
      onPointerEnter={() => {
        setHover(true);
      }}
      onPointerLeave={() => {
        setHover(false);
      }}
      onFocus={() => {
        setFocusedAt(x.version);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocusedAt(null);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        // no close button: it stays (a running export, picks still picked); focus leaves it
        if (x.closable === false) {
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
          return;
        }
        dismiss();
      }}
    >
      <Icon name={x.icon ?? TONE_ICON[x.tone]} size={14} className="q-toast-icon" />
      <div className="q-toast-text">
        {x.message !== '' && (
          <span className="q-toast-msg" dir="auto">
            {x.message}
          </span>
        )}
        {x.detail !== undefined && (
          <span className="q-toast-detail" dir="auto">
            {x.detail}
          </span>
        )}
        {Body && (
          <div className="q-toast-body">
            <Body />
          </div>
        )}
      </div>
      {x.action && (
        <Button
          variant="quiet"
          data-testid={x.action.testId}
          onClick={() => {
            const run = x.action?.run;
            dismissToast(x.id);
            run?.();
          }}
        >
          {x.action.label}
        </Button>
      )}
      {x.closable !== false && (
        <IconButton
          icon="x"
          label={x.closeLabel ?? t('dialog.close')}
          data-testid={x.closeTestId}
          onClick={dismiss}
        />
      )}
    </div>
  );
}
