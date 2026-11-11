import type { ChangePairContext, RegisterRow } from '@aio/change';
import { t, Tip, type MessageKey } from '@aio/ui';
import { useState } from 'react';
import { CloudConfirm } from '../inspect/askAi/CloudConfirm';
import { useAskStatus } from '../inspect/askAi/custom';
import {
  labelConfirmInfo,
  labelNeedsConfirm,
  labelRoute,
  labelRouteName,
  labelUnavailable,
  prepareLabel,
  sendLabel,
  type PreparedLabel,
} from './labelChange';

/**
 * **Label with AI** in a picked change region's actions (the Changes panel's `itemTools` slot):
 * greyed with the reason when the dates lack an ortho or no AI can answer; its tip names who
 * answers. A cloud label asks first with the cloud confirm (the two crops one click away), unless
 * the person chose not to be asked for the project. The label itself shows on the row
 * (`change-ai-label`).
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
  const [asking, setAsking] = useState<PreparedLabel | null>(null);
  const item = row.item;
  if (item.kind !== 'region') return null;
  const why = labelUnavailable(item, context, status, context?.manifest.origin ?? null);
  const where = labelRouteName(labelRoute(status));
  const send = async (p: PreparedLabel, confirmed: boolean) => {
    setBusy(true);
    try {
      setError(await sendLabel(p, { confirmed }));
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!context) return;
    setBusy(true);
    setError(null);
    let p: Awaited<ReturnType<typeof prepareLabel>>;
    try {
      p = await prepareLabel({
        row,
        ctx: context,
        dates: { from: dateLabel(context.from), to: dateLabel(context.to) },
      });
    } finally {
      setBusy(false);
    }
    if ('error' in p) setError(p.error);
    else if (labelNeedsConfirm(p)) setAsking(p);
    else await send(p, false);
  };
  const info = asking ? labelConfirmInfo(asking) : null;
  return (
    <>
      <Tip content={t('change.aiLabel.tip', { where: where ?? '' })} placement="top">
        <button
          type="button"
          className="chg-btn"
          data-testid="change-ai-label-run"
          data-route={where ?? undefined}
          disabled={busy || asking !== null || why !== null}
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
      {!error && !busy && !asking && item.aiLabel?.what && (
        <span className="chg-note" data-testid="change-ai-label-what">
          {t(`change.aiLabel.kind.${item.aiLabel.kind}` as MessageKey)}: {item.aiLabel.what}
        </span>
      )}
      {asking && info && context && (
        <div style={{ flexBasis: '100%' }}>
          <CloudConfirm
            projectId={projectId}
            layers={context.manifest.layers}
            confirm={info}
            images={info.images}
            line={(cost) => t('change.aiLabel.confirm', { provider: info.providerLabel, cost })}
            onSend={() => {
              setAsking(null);
              void send(asking, true);
            }}
            onCancel={() => {
              setAsking(null);
            }}
          />
        </div>
      )}
    </>
  );
}
