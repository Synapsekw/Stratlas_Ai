import type { JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  STALL_NOTICE_MS,
  detailLine,
  etaWords,
  formatDuration,
  liveStatus,
  showStuck,
  watchdogWords,
} from './liveStatus';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1',
    pipeline: 'photo.align',
    project: 'p',
    params: {},
    status: 'running',
    progress: 0.3,
    steps: [],
    artifacts: [],
    createdAt: iso(T0 - 60_000),
    updatedAt: iso(T0),
    ...over,
  };
}

const withActivity = (at: string, over: Partial<JobRecord> = {}): JobRecord =>
  job({ live: { lastActivityAt: at }, ...over });

describe('formatDuration', () => {
  it('writes seconds, minutes and hours', () => {
    expect(formatDuration(8_000)).toBe('8 s');
    expect(formatDuration(59_999)).toBe('59 s');
    expect(formatDuration(4 * 60_000 + 59_000)).toBe('4 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 min');
    expect(formatDuration(-5)).toBe('0 s');
    expect(formatDuration(Number.NaN)).toBe('0 s');
  });
});

describe('detailLine', () => {
  it('shows done of total, a bare count, or just the label', () => {
    expect(detailLine({ label: 'Matching photos', done: 4210, total: 12467, unit: 'pairs' })).toBe(
      'Matching photos: 4,210 of 12,467 pairs',
    );
    expect(detailLine({ label: 'Finding features', done: 212, unit: 'photos' })).toBe(
      'Finding features: 212 photos',
    );
    expect(detailLine({ label: 'Linking the matches' })).toBe('Linking the matches');
  });
});

describe('etaWords', () => {
  it('rounds minutes up and says less than a minute', () => {
    expect(etaWords(11.5 * 60)).toBe('about 12 min left');
    expect(etaWords(59)).toBe('less than a minute left');
  });
});

describe('liveStatus', () => {
  it('words the line, step time, estimate, job time and activity', () => {
    const j = job({
      startedAt: iso(T0 - 125_000),
      live: {
        detail: { label: 'Matching photos', done: 1, total: 2, unit: 'pairs' },
        stepStartedAt: iso(T0 - 30_000),
        lastActivityAt: iso(T0 - 8_000),
        etaSeconds: 600,
      },
    });
    expect(liveStatus(j, T0)).toEqual({
      line: 'Matching photos: 1 of 2 pairs',
      stepElapsed: '30 s',
      eta: 'about 10 min left',
      jobElapsed: '2 min',
      activity: 'Last activity 8 s ago',
      quietMs: 8_000,
    });
  });

  it('falls back to createdAt and updatedAt without live data', () => {
    const s = liveStatus(job(), T0 + 5_000);
    expect(s.line).toBeNull();
    expect(s.stepElapsed).toBeNull();
    expect(s.eta).toBeNull();
    expect(s.jobElapsed).toBe('1 min');
    expect(s.activity).toBe('Last activity 5 s ago');
  });

  it('never shows negative activity for a timestamp slightly in the future', () => {
    const j = withActivity(iso(T0 + 500));
    expect(liveStatus(j, T0).activity).toBe('Last activity 0 s ago');
    expect(showStuck(j, T0)).toBe(false);
  });

  it('treats an unparsable timestamp as now', () => {
    const j = withActivity('nonsense');
    expect(liveStatus(j, T0).activity).toBe('Last activity 0 s ago');
    expect(showStuck(j, T0 + 2 * STALL_NOTICE_MS)).toBe(false);
  });
});

describe('showStuck', () => {
  const j = withActivity(iso(T0));

  it('flips at 15 minutes', () => {
    expect(showStuck(j, T0 + STALL_NOTICE_MS - 1_000)).toBe(false);
    expect(showStuck(j, T0 + STALL_NOTICE_MS)).toBe(true);
  });

  it('waits another 15 minutes after Keep waiting', () => {
    const kept = T0 + STALL_NOTICE_MS;
    expect(showStuck(j, kept + STALL_NOTICE_MS - 1_000, kept)).toBe(false);
    expect(showStuck(j, kept + STALL_NOTICE_MS, kept)).toBe(true);
  });

  it('restarts the 15 minutes when new activity arrives after Keep waiting', () => {
    const kept = T0 + STALL_NOTICE_MS;
    const later = withActivity(iso(kept + 60_000));
    expect(showStuck(later, kept + 60_000 + STALL_NOTICE_MS - 1_000, kept)).toBe(false);
    expect(showStuck(later, kept + 60_000 + STALL_NOTICE_MS, kept)).toBe(true);
  });

  it('stays quiet while activity is fresh even if the engine log is silent', () => {
    const now = T0 + 6.4 * 60_000;
    expect(showStuck(withActivity(iso(now - 1_000)), now)).toBe(false);
  });

  it('is false without live data, when finished, and while cancelling', () => {
    expect(showStuck(job(), T0 + 10 * STALL_NOTICE_MS)).toBe(false);
    expect(showStuck(withActivity(iso(T0), { status: 'done' }), T0 + 2 * STALL_NOTICE_MS)).toBe(
      false,
    );
    expect(
      showStuck(withActivity(iso(T0), { status: 'cancelling' }), T0 + 2 * STALL_NOTICE_MS),
    ).toBe(false);
  });
});

describe('watchdogWords', () => {
  it('explains an odm-stalled failure', () => {
    const words =
      'The processing engine was stopped after 60 minutes with no activity. ' +
      'The work so far is kept; press Resume to try again.';
    expect(watchdogWords(job({ failure: { code: 'odm-stalled', data: { minutes: 60 } } }))).toBe(
      words,
    );
    expect(watchdogWords(job({ failure: { code: 'odm-stalled', data: {} } }))).toBe(words);
    expect(
      watchdogWords(job({ failure: { code: 'odm-stalled', data: { minutes: 90.0 } } })),
    ).toContain('after 90 minutes');
  });

  it('is null for other failures and none', () => {
    expect(watchdogWords(job({ failure: { code: 'other', data: {} } }))).toBeNull();
    expect(watchdogWords(job())).toBeNull();
  });
});
