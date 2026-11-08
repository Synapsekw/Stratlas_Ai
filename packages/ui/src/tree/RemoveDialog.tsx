import type { RemovalPlan, RemoveTarget } from '@aio/schema';
import { useEffect, useRef } from 'react';
import { Dialog } from '../Dialog';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import { removeText } from './removeText';

export interface RemoveDialogProps {
  targets: readonly RemoveTarget[];
  /** null while the plan is being worked out. */
  plan: RemovalPlan | null;
  busy: boolean;
  /** Why the last Delete did not go through. */
  error: string | null;
  dateLabel: (captureId: string) => string;
  onCancel: () => void;
  onConfirm: () => void;
  returnTo?: () => HTMLElement | null;
}

/**
 * The one confirm of every removal (delete and start over, spec "The confirm dialog"): what was
 * asked for, **Also removes**, **Keeps**, the space, the trash note; Cancel has focus first. A
 * refused plan shows its reason and only Close. Rendered by the app's removal host in a portal.
 */
export function RemoveDialog(props: RemoveDialogProps) {
  const { plan, busy, error } = props;
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    if (!busy) props.onCancel();
  };
  const text = plan ? removeText(props.targets, plan, t, { dateLabel: props.dateLabel }) : null;
  /** The plan could not be worked out: the error and Close, nothing to confirm. */
  const unplanned = !text && error !== null;
  const closeOnly = text?.refused != null || unplanned;
  // focus back on the button that is left when Close replaces Cancel or a Delete ends
  useEffect(() => {
    const root = cancelRef.current?.closest('[role="alertdialog"]');
    const active = document.activeElement;
    if (busy || !root) return;
    if (active === null || !root.contains(active) || active.matches(':disabled'))
      cancelRef.current?.focus();
  }, [closeOnly, busy]);
  const list = (label: string, lines: string[], id: string) =>
    lines.length > 0 && (
      <div data-testid={id}>
        <p className="rm-h">{label}</p>
        <ul className="rm-list">
          {lines.map((l, i) => (
            // two marked layers can share a name
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    );
  // Escape from the page closes it too (the Dialog's own rule): a button swap (Cancel to Close)
  // or a disabled button while busy can leave focus on the page
  return (
    <Dialog
      open
      role="alertdialog"
      className="rm-dlg"
      testId="remove-dialog"
      title={
        <span data-testid="remove-dialog-title" dir="auto">
          {unplanned ? t('remove.refusedTitle') : (text?.title ?? t('remove.loading'))}
        </span>
      }
      {...(text?.refused === null && text.note !== null
        ? { describedBy: 'remove-dialog-note' }
        : {})}
      hideClose
      initialFocus={cancelRef}
      {...(props.returnTo ? { returnFocus: props.returnTo } : {})}
      onClose={cancel}
      footer={
        closeOnly ? (
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={props.onCancel}
            data-testid="remove-dialog-close"
          >
            {t('remove.close')}
          </button>
        ) : (
          <>
            <button
              ref={cancelRef}
              type="button"
              className="btn ghost"
              onClick={cancel}
              disabled={busy}
              data-testid="remove-dialog-cancel"
            >
              {t('remove.cancel')}
            </button>
            {text && (
              <button
                type="button"
                className="btn danger"
                onClick={props.onConfirm}
                disabled={busy}
                data-testid="remove-dialog-confirm"
              >
                <Icon name="trash" size={14} />
                {busy ? t('remove.busy') : t('remove.confirm')}
              </button>
            )}
          </>
        )
      }
    >
      {text?.refused != null && (
        <p className="notice danger" role="alert" data-testid="remove-dialog-refused">
          <Icon name="warn" size={14} />
          <span>
            <b>{t('remove.refusedTitle')}</b> {text.refused}
          </span>
        </p>
      )}
      {text?.refused === null && (
        <>
          {list(t('remove.asked'), text.asked, 'remove-dialog-asked')}
          {list(t('remove.also'), text.also, 'remove-dialog-also')}
          {list(t('remove.keeps'), text.keeps, 'remove-dialog-keeps')}
          {text.space && (
            <p className="mono small" data-testid="remove-dialog-space">
              {text.space}
            </p>
          )}
          {text.note !== null && (
            <p id="remove-dialog-note" className="help">
              {text.note}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="notice danger" role="alert" data-testid="remove-dialog-error">
          <Icon name="warn" size={14} />
          <span>
            <b>{t('remove.failed')}</b> {error}
          </span>
        </p>
      )}
    </Dialog>
  );
}
