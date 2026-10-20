/**
 * Words for the live progress of a photo job, and the rule for the "may be stuck" notice. Pure
 * functions of the job record and a clock, so a reloaded panel shows the same thing again.
 */
import type { JobLiveDetail, JobRecord } from '@aio/schema';
import { getLocale, t, type MessageKey } from '@aio/ui';
import { isActive } from '../jobs';

/** How long the job may show no activity before the panel says it may be stuck. */
export const STALL_NOTICE_MS = 15 * 60_000;

/** British English for the English catalogue, like the rest of the app's dates and numbers. */
const num = (n: number): string => {
  const l = getLocale();
  return n.toLocaleString(l === 'en' ? 'en-GB' : l);
};

/** The pack's English step labels and units (python sfm_progress SUBSTEPS), as app strings. */
const STEP_KEYS: Record<string, MessageKey> = {
  'Getting the photos ready': 'photo.live.step.setup',
  'Finding features': 'photo.live.step.features',
  'Matching photos': 'photo.live.step.matching',
  'Linking the matches': 'photo.live.step.tracks',
  'Building the 3D model': 'photo.live.step.reconstruct',
  'Checking the model': 'photo.live.step.statistics',
  'Placing the model on the map': 'photo.live.step.geocoords',
  'Preparing the photos for the maps': 'photo.live.step.undistort',
};
const UNIT_KEYS: Record<string, MessageKey> = {
  photos: 'photo.live.unit.photos',
  pairs: 'photo.live.unit.pairs',
  'photos placed': 'photo.live.unit.photosPlaced',
};

/** An app string for a word the pack sends, or the word itself when the app does not know it. */
const word = (keys: Record<string, MessageKey>, text: string): string => {
  const key = Object.hasOwn(keys, text) ? keys[text] : undefined;
  return key ? t(key) : text;
};

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return t('photo.live.seconds', { s: 0 });
  const s = Math.floor(ms / 1000);
  if (s < 60) return t('photo.live.seconds', { s });
  const min = Math.floor(s / 60);
  if (min < 60) return t('photo.live.minutes', { min });
  return t('photo.live.hours', { h: Math.floor(min / 60), min: String(min % 60).padStart(2, '0') });
}

export function detailLine(d: JobLiveDetail): string {
  const label = word(STEP_KEYS, d.label);
  if (d.done === undefined) return label;
  const count =
    d.total === undefined
      ? num(d.done)
      : t('photo.live.countOf', { done: num(d.done), total: num(d.total) });
  const n = d.unit ? t('photo.live.countUnit', { n: count, unit: word(UNIT_KEYS, d.unit) }) : count;
  return t('photo.live.detail', { label, n });
}

export function etaWords(seconds: number): string {
  if (seconds < 60) return t('photo.live.etaSoon');
  return t('photo.live.eta', { min: Math.ceil(seconds / 60) });
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
    activity:
      quietMs === null ? null : t('photo.live.lastActivity', { time: formatDuration(quietMs) }),
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
  return t('photo.live.stopped', { minutes });
}
