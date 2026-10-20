/**
 * Words for the live progress of a photo job, and the rule for the "may be stuck" notice. Pure
 * functions of the job record and a clock, so a reloaded panel shows the same thing again.
 */
import type { JobLiveDetail, JobRecord } from '@aio/schema';
import { isActive } from '../jobs';

/** How long the job may show no activity before the panel says it may be stuck. */
export const STALL_NOTICE_MS = 15 * 60_000;

const num = (n: number): string => n.toLocaleString('en-GB');

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export function detailLine(d: JobLiveDetail): string {
  if (d.done === undefined) return d.label;
  const count = d.total === undefined ? num(d.done) : `${num(d.done)} of ${num(d.total)}`;
  return `${d.label}: ${count}${d.unit ? ` ${d.unit}` : ''}`;
}

export function etaWords(seconds: number): string {
  if (seconds < 60) return 'less than a minute left';
  return `about ${Math.ceil(seconds / 60)} min left`;
}

export interface LiveStatus {
  line: string | null;
  stepElapsed: string | null;
  eta: string | null;
  jobElapsed: string;
  /** Null unless the engine reported a parsable last-activity time: no invented proof of life. */
  activity: string | null;
  quietMs: number | null;
}

/** A timestamp as milliseconds, or null when absent or unparsable. */
function ms(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function liveStatus(job: JobRecord, now: number): LiveStatus {
  const live = job.live;
  const stepStart = ms(live?.stepStartedAt);
  const jobStart = ms(job.startedAt) ?? ms(job.createdAt) ?? now;
  const last = ms(live?.lastActivityAt);
  const quietMs = last === null ? null : Math.max(0, now - last);
  return {
    line: live?.detail ? detailLine(live.detail) : null,
    stepElapsed: stepStart === null ? null : formatDuration(now - stepStart),
    eta: live?.etaSeconds === undefined ? null : etaWords(live.etaSeconds),
    jobElapsed: formatDuration(now - jobStart),
    activity: quietMs === null ? null : `Last activity ${formatDuration(quietMs)} ago`,
    quietMs,
  };
}

/**
 * True when an active job has shown no activity for 15 minutes, counted from the later of its
 * last activity and the moment the person pressed Keep waiting. Needs a parsable activity time.
 */
export function showStuck(job: JobRecord, now: number, keptWaitingAt?: number): boolean {
  if (!isActive(job) || job.status === 'cancelling') return false;
  const last = ms(job.live?.lastActivityAt);
  if (last === null) return false;
  return now - Math.max(last, keptWaitingAt ?? 0) >= STALL_NOTICE_MS;
}

/** What the watchdog did, for a job it stopped; null for any other failure. */
export function watchdogWords(job: JobRecord): string | null {
  if (job.failure?.code !== 'odm-stalled') return null;
  const m = job.failure.data.minutes;
  const minutes = typeof m === 'number' && Number.isFinite(m) ? m : 60;
  return (
    `The processing engine was stopped after ${minutes} minutes with no activity. ` +
    'The work so far is kept; press Resume to try again.'
  );
}
