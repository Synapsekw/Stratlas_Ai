/**
 * The live line under a photo job's progress bar: what the engine is doing now, how long it has
 * taken, when it last did anything, and the "may be stuck" notice. Everything comes from the job
 * record and the clock, so a reopened panel says the same thing again.
 */
import type { JobRecord } from '@aio/schema';
import { Icon } from '@aio/ui';
import { isActive } from '../jobs';
import { liveStatus, showStuck, watchdogWords } from './liveStatus';

export interface JobLiveProps {
  job: JobRecord;
  /** The clock, in milliseconds; the panel ticks it once a second while the job is active. */
  now: number;
  /** The run's headline, for a step that sends no count. */
  fallback: string | null;
  /** When the person pressed Keep waiting, this session. */
  keptWaitingAt?: number | undefined;
  onCancel: () => void;
  onKeepWaiting: () => void;
}

export function JobLive({
  job,
  now,
  fallback,
  keptWaitingAt,
  onCancel,
  onKeepWaiting,
}: JobLiveProps) {
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
    s.stepElapsed === null ? null : `${s.stepElapsed} on this step`,
    s.eta,
    `${s.jobElapsed} in all`,
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
          <span>No progress for 15 minutes. The job may be stuck.</span>
          <span className="ph-acts">
            <button type="button" className="btn sm" onClick={onCancel}>
              Cancel job
            </button>
            <button type="button" className="btn sm ghost" onClick={onKeepWaiting}>
              Keep waiting
            </button>
          </span>
        </div>
      )}
    </>
  );
}
