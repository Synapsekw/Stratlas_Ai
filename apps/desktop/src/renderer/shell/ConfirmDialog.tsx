/**
 * A yes-or-cancel question on the shared `Dialog`: focus starts on Cancel, Escape and a click
 * outside cancel. Used where one action changes many things at once (recomputing every
 * earlier-version pile, clearing the report template).
 */
import { Dialog, Icon, useT } from '@aio/ui';
import { useId, useRef, type ReactNode } from 'react';

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
  const keep = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    if (!p.busy) p.onCancel();
  };
  const test = p.testId ?? 'confirm';
  return (
    <Dialog
      open
      role="alertdialog"
      title={p.title}
      describedBy={`${id}-text`}
      testId={test}
      hideClose
      initialFocus={keep}
      {...(p.returnTo ? { returnFocus: p.returnTo } : {})}
      onClose={cancel}
      footer={
        <>
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
        </>
      }
    >
      <div id={`${id}-text`}>{p.children}</div>
    </Dialog>
  );
}
