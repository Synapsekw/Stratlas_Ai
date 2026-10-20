// @vitest-environment jsdom
import { JobRecord } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobLive } from './JobLive';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-20T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const record = (over: Record<string, unknown> = {}) =>
  JobRecord.parse({
    id: 'j1',
    pipeline: 'photo.align',
    project: 'C:/p',
    params: {},
    status: 'running',
    progress: 0.4,
    steps: [],
    artifacts: [],
    createdAt: ago(3_600_000),
    updatedAt: ago(8000),
    startedAt: ago(3_000_000),
    live: {
      detail: { label: 'Matching photos', done: 4210, total: 12467, unit: 'pairs' },
      stepStartedAt: ago(360_000),
      lastActivityAt: ago(8000),
      etaSeconds: 720,
    },
    ...over,
  });

const withActivity = (msAgo: number) =>
  record({
    live: {
      detail: { label: 'Matching photos', done: 4210, total: 12467, unit: 'pairs' },
      stepStartedAt: ago(3_600_000),
      lastActivityAt: ago(msAgo),
    },
  });

let host: HTMLDivElement;
let root: Root;
const onCancel = vi.fn();
const onKeepWaiting = vi.fn();

const show = (job: JobRecord, keptWaitingAt?: number) => {
  act(() => {
    root.render(
      <JobLive
        job={job}
        now={NOW}
        fallback="Working"
        keptWaitingAt={keptWaitingAt}
        onCancel={onCancel}
        onKeepWaiting={onKeepWaiting}
      />,
    );
  });
};
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  onCancel.mockReset();
  onKeepWaiting.mockReset();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('JobLive', () => {
  it('shows the count, the estimate and the activity, and no notice', () => {
    show(record());
    const text = q('photo-job-live')?.textContent ?? '';
    expect(text).toContain('Matching photos: 4,210 of 12,467 pairs');
    expect(text).toContain('6 min on this step');
    expect(text).toContain('about 12 min left');
    expect(text).toContain('Last activity 8 s ago');
    expect(text).toContain('in all');
    expect(q('photo-job-stuck')).toBeNull();
  });

  it('says a quiet stretch without a notice before 15 minutes', () => {
    show(withActivity(5 * 60_000));
    expect(q('photo-job-live')?.textContent).toContain('Last activity 5 min ago');
    expect(q('photo-job-stuck')).toBeNull();
  });

  it('shows the notice after 15 minutes, with both buttons', () => {
    show(withActivity(15 * 60_000));
    const n = q('photo-job-stuck');
    expect(n?.getAttribute('role')).toBe('alert');
    expect(n?.textContent).toContain('No progress for 15 minutes. The job may be stuck.');
    act(() => {
      button('Cancel job')?.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => {
      button('Keep waiting')?.click();
    });
    expect(onKeepWaiting).toHaveBeenCalledTimes(1);
  });

  it('hides the notice after Keep waiting', () => {
    show(withActivity(15 * 60_000), NOW);
    expect(q('photo-job-stuck')).toBeNull();
  });

  it('brings the notice back on a fresh mount of a quiet record', () => {
    show(withActivity(16 * 60_000));
    expect(q('photo-job-stuck')).not.toBeNull();
  });

  it('says what the watchdog did for a job it stopped', () => {
    show(
      record({
        status: 'failed',
        failure: { code: 'odm-stalled', data: { minutes: 60 } },
        error: 'raw',
      }),
    );
    expect(q('photo-job-live')).toBeNull();
    expect(q('photo-job-stopped')?.textContent).toContain(
      'The processing engine was stopped after 60 minutes with no activity.',
    );
  });

  it('never shows engine jargon', () => {
    show(withActivity(16 * 60_000));
    expect(host.textContent).not.toMatch(/opensfm|detect_features|reconstruct\b|SIFT/i);
  });
});
