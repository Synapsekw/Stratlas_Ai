import { useFocusTrap, useT } from '@aio/ui';
import { useRef } from 'react';
import type { BatchPlan } from './batch';

/** Why a batch action or its undo was refused, shown even when no detection is current. */
export function BatchError({ message }: { message: string }) {
  return (
    <p className="det-banner" role="alert" data-testid="det-batch-error">
      {message}
    </p>
  );
}

/** The question before Accept all or Reject all acts on the list on screen. */
export function BatchConfirm({
  kind,
  plan,
  onConfirm,
  onCancel,
}: {
  kind: 'accept' | 'reject';
  plan: BatchPlan;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, { onEscape: onCancel });
  return (
    <div
      ref={ref}
      className="det-batch-confirm"
      role="alertdialog"
      aria-modal="true"
      data-testid="det-batch-confirm"
      onKeyDown={(e) => {
        // The review's shortcuts (Enter accepts, X rejects, ...) must not see these keys.
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
      }}
    >
      <p>
        {kind === 'accept'
          ? t('det.acceptAll.confirm', { count: plan.accept })
          : t('det.rejectAll.confirm', { count: plan.reject })}
      </p>
      {kind === 'accept' && plan.skip > 0 && (
        <p className="faint">{t('det.acceptAll.skip', { count: plan.skip })}</p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn ghost sm"
          data-testid="det-batch-cancel"
          onClick={onCancel}
        >
          {t('det.batch.cancel')}
        </button>
        <button
          type="button"
          className="btn primary sm"
          data-testid="det-batch-ok"
          autoFocus
          onClick={onConfirm}
        >
          {kind === 'accept' ? t('det.accept') : t('det.reject')}
        </button>
      </div>
    </div>
  );
}
