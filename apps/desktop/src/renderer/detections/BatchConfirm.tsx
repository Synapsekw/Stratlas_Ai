import { useFocusTrap, useT } from '@aio/ui';
import { useRef } from 'react';
import type { BatchPlan } from './batch';

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
