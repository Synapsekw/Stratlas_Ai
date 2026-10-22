/** The small parts every list and detail of jobs shares: status, progress, times. */
import type { JobRecord } from '@aio/schema';
import { useEffect, useState } from 'react';
import { jobTitleFor } from './pipelines';

export const STATUS: Record<JobRecord['status'], { label: string; tone: string }> = {
  starting: { label: 'Starting', tone: 'run' },
  running: { label: 'Running', tone: 'run' },
  cancelling: { label: 'Stopping', tone: 'warn' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'idle' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
};

export const pct = (f: number) => `${String(Math.round(f * 100))}%`;

export function clock(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function duration(job: JobRecord, now: number): string {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const s = Math.max(0, Math.round((end - Date.parse(job.createdAt)) / 1000));
  if (s < 60) return `${String(s)} s`;
  const m = Math.floor(s / 60);
  return m < 60
    ? `${String(m)} min ${String(s % 60)} s`
    : `${String(Math.floor(m / 60))} h ${String(m % 60)} min`;
}

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [active]);
  return now;
}

export function StatusChip({ status }: { status: JobRecord['status'] }) {
  const s = STATUS[status];
  return (
    <span className={`job-state ${s.tone}`} data-status={status}>
      <i />
      {s.label}
    </span>
  );
}

export function Bar({ job }: { job: JobRecord }) {
  return (
    <span
      className={`job-bar ${STATUS[job.status].tone}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(job.progress * 100)}
      aria-label={`${jobTitleFor(job)} progress`}
    >
      <i style={{ width: pct(job.progress) }} />
    </span>
  );
}
