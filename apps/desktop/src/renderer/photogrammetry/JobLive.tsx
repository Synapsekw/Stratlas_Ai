/**
 * The live line under a photo job's progress bar: what the engine is doing now, how long it has
 * taken, when it last did anything, and the "may be stuck" notice. Everything comes from the job
 * record and the clock, so a reopened panel says the same thing again.
 */
import type { JobRecord } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { isActive } from '../jobs';
import { STALL_NOTICE_MS, liveStatus, showStuck, watchdogWords } from './liveStatus';

export interface JobLiveProps {
  job: JobRecord;
  /** The clock, in milliseconds; the panel ticks it once a second while the job is active. */
  now: number;
  /** The run's headline, for a step that sends no count. */
  fallback: string | null;
  /** When the person pressed Keep waiting, this session. */
  keptWaitingAt?: number | undefined;
  /** Another action on the run is in progress: Cancel job waits, like the panel's own Cancel. */
  busy?: boolean;
  onCancel: () => void;
  onKeepWaiting: () => void;
}

export function JobLive({
  job,
  now,
  fallback,
  keptWaitingAt,
  busy = false,
  onCancel,
  onKeepWaiting,
}: JobLiveProps) {
  const t = useT();
  const stopped = watchdogWords(job);
  if (stopped) {
    return (
      <p className="notice danger small" data-testid="photo-job-stopped">
        <Icon name="warn" size={14} />
        {stopped}
      </p>
    );
  }
  if (!isActive(job)) return null;
  const s = liveStatus(job, now);
  const line = s.line ?? fallback;
  const parts = [
    s.stepElapsed === null ? null : t('photo.live.onStep', { time: s.stepElapsed }),
    s.eta,
    t('photo.live.inAll', { time: s.jobElapsed }),
    s.activity,
  ].filter((p): p is string => p !== null);
  return (
    <>
      <p className="ph-live small" data-testid="photo-job-live">
        {line && (
          <>
            <b>{line}</b>
            <span className="faint"> · </span>
          </>
        )}
        <span className="faint">{parts.join(' · ')}</span>
      </p>
      {showStuck(job, now, keptWaitingAt) && (
        <div className="notice small ph-stuck" role="alert" data-testid="photo-job-stuck">
          <Icon name="warn" size={14} />
          <span>{t('photo.live.stuck', { minutes: STALL_NOTICE_MS / 60_000 })}</span>
          <span className="ph-acts">
            <button
              type="button"
              className="btn sm"
              disabled={busy || job.status === 'cancelling'}
              onClick={onCancel}
            >
              {t('photo.live.cancel')}
            </button>
            <button type="button" className="btn sm ghost" onClick={onKeepWaiting}>
              {t('photo.live.keepWaiting')}
            </button>
          </span>
        </div>
      )}
    </>
  );
}
