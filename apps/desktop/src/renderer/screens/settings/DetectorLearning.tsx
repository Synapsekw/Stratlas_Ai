/**
 * Settings, Models and detection, Detector library: one detector's learning from reviews, under
 * its review stats (roadmap V2).
 *
 * - A read-only status: an applied threshold in use, then the scored reviews still needed for a
 *   suggestion (main's count, `ledger:stats` `scored`) or the suggestion beside the threshold in
 *   use, and whether it came from every review because too few were from runs like the next one.
 * - **Apply suggested threshold** (`ledger:applyThreshold`: main works it out again) and **Use the
 *   detector's own threshold** (`ledger:resetThreshold`), shown whenever one is applied.
 * - **Learn from my reviews** (`ledger:setLearn`, on by default): off means no example crops in
 *   the detector's runs and no suggestion.
 */
import type { IpcResponse } from '@aio/schema';
import { t, Tip } from '@aio/ui';
import { useState, type ReactElement } from 'react';
import type { Res } from '../../bridge';
import { bridge } from '../../shell';
import './detectorLearning.css';

type Stats = IpcResponse<'ledger:stats'>;

/** Scored reviews the ledger needs before it suggests a threshold (`ledger.ts` MIN_SCORED). */
export const REVIEWS_FOR_SUGGESTION = 20;

const same = (a: number, b: number) => a.toFixed(2) === b.toFixed(2);

/** The status line: an applied threshold, then learning off, the count to go or the suggestion. */
export function learningStatus(s: Stats, threshold: number): string | null {
  const parts: string[] = [];
  if (s.applied !== null)
    parts.push(t('detect.learn.appliedInUse', { value: s.applied.toFixed(2) }));
  const reviewed = s.accepted + s.rejected + s.misses;
  if (!s.learn) parts.push(t('detect.learn.off'));
  else if (s.suggestedThreshold === null) {
    if (reviewed > 0)
      parts.push(
        t('detect.learn.counting', { count: Math.max(1, REVIEWS_FOR_SUGGESTION - s.scored) }),
      );
  } else {
    const value = s.suggestedThreshold.toFixed(2);
    const from = s.suggestedFrom === 'all' ? ` ${t('detect.learn.fromAll')}` : '';
    if (!same(s.suggestedThreshold, threshold))
      parts.push(t('detect.learn.suggested', { value, current: threshold.toFixed(2) }) + from);
    else if (s.applied === null) parts.push(t('detect.learn.inUse', { value }) + from);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The error of an `Ok`-shaped answer, null when it worked. */
function failure(r: Res<{ ok: boolean; error?: string | undefined }>): string | null {
  if (r.ok && r.value.ok) return null;
  return (r.ok ? r.value.error : r.error) ?? '';
}

export function DetectorLearning(p: {
  detectorId: string;
  stats: Stats;
  /** The threshold in use (an applied one in place of the detector's own). */
  threshold: number;
  /** After an apply, with the threshold now in use. */
  onApplied: (threshold: number) => Promise<void>;
  /** After the applied threshold was dropped. */
  onReset: () => Promise<void>;
  /** After the switch changed: the stats are read again. */
  onSwitched: () => Promise<void>;
}): ReactElement {
  const { stats: s, detectorId: id } = p;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = learningStatus(s, p.threshold);

  const act = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const e = await work();
    if (e !== null) setError(e);
    setBusy(false);
  };
  const apply = () =>
    act(async () => {
      const r = await bridge.call('ledger:applyThreshold', { detectorId: id });
      if (r.ok && r.value.ok) {
        await p.onApplied(r.value.threshold);
        return null;
      }
      return failure(r);
    });
  const reset = () =>
    act(async () => {
      const e = failure(await bridge.call('ledger:resetThreshold', { detectorId: id }));
      if (e === null) await p.onReset();
      return e;
    });
  const toggle = (on: boolean) =>
    act(async () => {
      const e = failure(await bridge.call('ledger:setLearn', { detectorId: id, on }));
      if (e === null) await p.onSwitched();
      return e;
    });

  const canApply =
    s.learn && s.suggestedThreshold !== null && !same(s.suggestedThreshold, p.threshold);
  return (
    <div className="dlearn" data-testid={`dl-learn-${id}`}>
      {status !== null && (
        <Tip content={t('detect.learn.tip', { need: REVIEWS_FOR_SUGGESTION })}>
          <span className="dlearn-status" data-testid={`dl-learn-status-${id}`}>
            {status}
          </span>
        </Tip>
      )}
      {canApply && (
        <button
          type="button"
          className="btn sm"
          data-testid={`dl-learn-apply-${id}`}
          disabled={busy}
          onClick={() => void apply()}
        >
          {t('detect.learn.apply')}
        </button>
      )}
      {s.applied !== null && (
        <button
          type="button"
          className="btn sm ghost"
          data-testid={`dl-learn-reset-${id}`}
          disabled={busy}
          onClick={() => void reset()}
        >
          {t('detect.learn.reset')}
        </button>
      )}
      <label className="dlearn-switch">
        <input
          type="checkbox"
          data-testid={`dl-learn-switch-${id}`}
          checked={s.learn}
          disabled={busy}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
        {t('detect.learn.switch')}
      </label>
      {error !== null && (
        <span className="dlearn-err" role="alert">
          {error === '' ? t('detect.preset.library.failed') : error}
        </span>
      )}
    </div>
  );
}
