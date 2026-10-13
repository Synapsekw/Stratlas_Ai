import type { RemovalPlan, RemoveTarget } from '@aio/schema';
import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../focus';
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
  const dlg = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    if (!busy) props.onCancel();
  };
  // Esc anywhere: the dialog is the only modal while it is open, and a button swap (Cancel to
  // Close) or a disabled button while busy leaves focus on the page
  useFocusTrap(dlg, true, {
    onEscape: cancel,
    escapeAnywhere: true,
    initial: () => cancelRef.current,
    ...(props.returnTo ? { returnTo: props.returnTo } : {}),
  });
  const text = plan ? removeText(props.targets, plan, t, { dateLabel: props.dateLabel }) : null;
  /** The plan could not be worked out: the error and Close, nothing to confirm. */
  const unplanned = !text && error !== null;
  const closeOnly = text?.refused != null || unplanned;
  // focus back on the button that is left when Close replaces Cancel or a Delete ends
  useEffect(() => {
    const root = dlg.current;
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
  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={dlg}
        className="dlg rm-dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-dialog-title"
        {...(text?.refused === null && text.note !== null
          ? { 'aria-describedby': 'remove-dialog-note' }
          : {})}
        data-testid="remove-dialog"
      >
        <div className="dlg-h">
          <Icon name="trash" size={16} />
          <h2 id="remove-dialog-title" data-testid="remove-dialog-title" dir="auto">
            {unplanned ? t('remove.refusedTitle') : (text?.title ?? t('remove.loading'))}
          </h2>
        </div>
        <div className="dlg-b">
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
        </div>
        <div className="dlg-f">
          <span className="grow" />
          {closeOnly ? (
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
          )}
        </div>
      </div>
    </div>
  );
}
