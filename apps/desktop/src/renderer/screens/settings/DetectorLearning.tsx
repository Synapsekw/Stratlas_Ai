/**
 * Settings, Models and detection, Detector library: one detector's learning status under its
 * review stats (roadmap V2). Read only: the reviews so far against the 20 a suggestion needs,
 * then the ledger's suggested threshold beside the one in use. **Apply suggested threshold**
 * (`ledger:applyThreshold`) is the only way a suggestion is used: main works it out again and
 * keeps it on this computer, and the library is read again.
 */
import type { IpcResponse } from '@aio/schema';
import { t, Tip } from '@aio/ui';
import { useState, type ReactElement } from 'react';
import { bridge } from '../../shell';
import './detectorLearning.css';

type Stats = IpcResponse<'ledger:stats'>;

/** Scored reviews the ledger needs before it suggests a threshold (`ledger.ts` MIN_SCORED). */
export const REVIEWS_FOR_SUGGESTION = 20;

const same = (a: number, b: number) => a.toFixed(2) === b.toFixed(2);

export function DetectorLearning(p: {
  detectorId: string;
  stats: Stats;
  /** The threshold in use (an applied one in place of the detector's own). */
  threshold: number;
  /** After an apply, with the threshold now in use. */
  onApplied: (threshold: number) => Promise<void>;
}): ReactElement | null {
  const { stats: s } = p;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewed = s.accepted + s.rejected;
  if (reviewed + s.misses === 0) return null;

  const suggested = s.suggestedThreshold;
  const status =
    suggested !== null
      ? same(suggested, p.threshold)
        ? t('detect.learn.inUse', { value: suggested.toFixed(2) })
        : t('detect.learn.suggested', {
            value: suggested.toFixed(2),
            current: p.threshold.toFixed(2),
          })
      : reviewed < REVIEWS_FOR_SUGGESTION
        ? t('detect.learn.counting', { n: reviewed, need: REVIEWS_FOR_SUGGESTION })
        : t('detect.learn.noSuggestion');

  const apply = async () => {
    setBusy(true);
    setError(null);
    const r = await bridge.call('ledger:applyThreshold', { detectorId: p.detectorId });
    if (r.ok && r.value.ok) await p.onApplied(r.value.threshold);
    else setError(r.ok ? (r.value.ok ? null : r.value.error) : r.error);
    setBusy(false);
  };

  return (
    <div className="dlearn" data-testid={`dl-learn-${p.detectorId}`}>
      <Tip content={t('detect.learn.tip', { need: REVIEWS_FOR_SUGGESTION })}>
        <span className="dlearn-status" data-testid={`dl-learn-status-${p.detectorId}`}>
          {status}
        </span>
      </Tip>
      {suggested !== null && !same(suggested, p.threshold) && (
        <button
          type="button"
          className="btn sm"
          data-testid={`dl-learn-apply-${p.detectorId}`}
          disabled={busy}
          onClick={() => void apply()}
        >
          {t('detect.learn.apply')}
        </button>
      )}
      {error && (
        <span className="dlearn-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
