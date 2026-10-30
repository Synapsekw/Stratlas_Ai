import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { Button, IconButton } from '../controls';
import { useT } from '../i18n';
import { Icon, type IconName } from '../icons/Icon';
import {
  dismissToast,
  registerHost,
  subscribeToasts,
  toastStamp,
  visibleToast,
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
 * hidden; Escape on a focused toast dismisses it.
 */
export function ToastHost({ placement }: ToastHostProps): ReactElement {
  useEffect(() => registerHost(placement), [placement]);
  useSyncExternalStore(subscribeToasts, toastStamp, toastStamp);
  const shown = visibleToast(placement);
  return (
    <div className="q-toasts" data-placement={placement} data-testid={`toast-host-${placement}`}>
      <div role="status" aria-live="polite" aria-atomic="true" className="q-toast-region">
        {shown && shown.tone !== 'error' && <ToastCard key={shown.id} toast={shown} />}
      </div>
      <div role="alert" aria-atomic="true" className="q-toast-region">
        {shown?.tone === 'error' && <ToastCard key={shown.id} toast={shown} />}
      </div>
    </div>
  );
}

function ToastCard({ toast: x }: { toast: Toast }): ReactElement {
  const t = useT();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const hidden = useDocumentHidden();
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
      data-testid={x.testId ?? 'toast'}
      onPointerEnter={() => {
        setHover(true);
      }}
      onPointerLeave={() => {
        setHover(false);
      }}
      onFocus={() => {
        setFocus(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocus(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      }}
    >
      <Icon name={x.icon ?? TONE_ICON[x.tone]} size={14} className="q-toast-icon" />
      <div className="q-toast-text">
        <span className="q-toast-msg" dir="auto">
          {x.message}
        </span>
        {x.detail !== undefined && (
          <span className="q-toast-detail" dir="auto">
            {x.detail}
          </span>
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
      <IconButton icon="x" label={t('dialog.close')} onClick={dismiss} />
    </div>
  );
}
