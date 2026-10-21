/**
 * A yes-or-cancel question in the app's dialog look (`dlg`, as the empty-trash question): focus
 * starts on Cancel, Escape and a click outside cancel. Used where one action changes many things
 * at once (recomputing every earlier-version pile, clearing the report template).
 */
import { Icon, useFocusTrap, useT } from '@aio/ui';
import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  /** The words on the confirming button. */
  yes: string;
  busy?: boolean;
  /** A confirming button styled as removing something. */
  danger?: boolean;
  testId?: string;
  /**
   * Where focus goes when the dialog closes; undefined (or null) for the button that opened it.
   * Give a stable element when the confirmed action removes that button.
   */
  returnTo?: () => HTMLElement | null | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(p: ConfirmDialogProps) {
  const t = useT();
  const id = useId();
  const dlg = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    if (!p.busy) p.onCancel();
  };
  useFocusTrap(dlg, true, {
    onEscape: cancel,
    initial: () => keep.current,
    ...(p.returnTo ? { returnTo: p.returnTo } : {}),
  });
  const test = p.testId ?? 'confirm';
  return createPortal(
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={dlg}
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-text`}
        data-testid={test}
      >
        <div className="dlg-h">
          <h2 id={`${id}-title`}>{p.title}</h2>
        </div>
        <div className="dlg-b" id={`${id}-text`}>
          {p.children}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          <button
            ref={keep}
            type="button"
            className="btn ghost"
            onClick={cancel}
            disabled={p.busy}
            data-testid={`${test}-cancel`}
          >
            {t('remove.cancel')}
          </button>
          <button
            type="button"
            className={p.danger ? 'btn danger' : 'btn primary'}
            onClick={() => {
              if (!p.busy) p.onConfirm();
            }}
            disabled={p.busy}
            data-testid={`${test}-yes`}
          >
            {p.danger && <Icon name="trash" size={14} />}
            {p.yes}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
