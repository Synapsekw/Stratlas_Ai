import type { ChangePairContext, RegisterRow } from '@aio/change';
import { t, Tip, type MessageKey } from '@aio/ui';
import { useState } from 'react';
import { useAskStatus } from '../inspect/askAi/custom';
import { labelRegion, labelUnavailable } from './labelChange';

/**
 * **Label with AI** in a picked change region's actions (the Changes panel's `itemTools` slot):
 * greyed with the reason when the dates lack an ortho or no AI can answer; says the outcome
 * beside it. The label itself shows on the row (`change-ai-label`).
 */
export function RegionLabelTool({
  row,
  projectId,
  context,
  dateLabel,
}: {
  row: RegisterRow;
  projectId: string;
  /** The pair context of the row's set. */
  context: ChangePairContext | null;
  dateLabel: (captureId: string) => string;
}) {
  const status = useAskStatus(projectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const item = row.item;
  if (item.kind !== 'region') return null;
  const why = labelUnavailable(item, context, status, context?.manifest.origin ?? null);
  const run = async () => {
    if (!context) return;
    setBusy(true);
    setError(null);
    try {
      setError(
        await labelRegion({
          row,
          ctx: context,
          dates: { from: dateLabel(context.from), to: dateLabel(context.to) },
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Tip content={t('change.aiLabel.tip')} placement="top">
        <button
          type="button"
          className="chg-btn"
          data-testid="change-ai-label-run"
          disabled={busy || why !== null}
          onClick={() => void run()}
        >
          {busy
            ? t('change.aiLabel.busy')
            : item.aiLabel
              ? t('change.aiLabel.again')
              : t('change.aiLabel.action')}
        </button>
      </Tip>
      {why && (
        <span className="chg-note" data-testid="change-ai-label-why">
          {why}
        </span>
      )}
      {error && (
        <span
          className="chg-note"
          style={{ color: 'var(--danger)' }}
          role="alert"
          data-testid="change-ai-label-error"
        >
          {error}
        </span>
      )}
      {!error && !busy && item.aiLabel?.what && (
        <span className="chg-note" data-testid="change-ai-label-what">
          {t(`change.aiLabel.kind.${item.aiLabel.kind}` as MessageKey)}: {item.aiLabel.what}
        </span>
      )}
    </>
  );
}
