import { ChangeSet, type DateShift, type ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { changeSetStale } from './stale';
import { SITE } from './testing';

const lined = (shift: DateShift | null): ProjectManifest => ({
  ...SITE,
  captures: SITE.captures.map((c) =>
    c.id === 'd2' && shift
      ? { ...c, lineUp: { ...shift, with: 'd1', at: '2026-10-10T00:00:00.000Z' } }
      : c,
  ),
});

const set = (lineUp?: { from?: DateShift; to?: DateShift }) =>
  ChangeSet.parse({
    schema: 'aio.change/1',
    id: 'd1-d2-issues',
    from: 'd1',
    to: 'd2',
    producer: 'issues',
    createdAt: '2026-10-06T08:00:00Z',
    items: [],
    ...(lineUp ? { lineUp } : {}),
  });

describe('a change set against the dates shifts now', () => {
  it('marks a set stale when one of its dates was lined up after it', () => {
    const now = lined({ eastM: 2, northM: -1 });
    expect(changeSetStale(set(), now)).toBe(true);
    expect(changeSetStale(set({ to: { eastM: 2, northM: 0 } }), now)).toBe(true);
    // lined up when computed, the line-up removed since
    expect(changeSetStale(set({ to: { eastM: 2, northM: -1 } }), lined(null))).toBe(true);
  });

  it('keeps a set computed after the line-up fresh', () => {
    const now = lined({ eastM: 2, northM: -1 });
    expect(changeSetStale(set({ to: { eastM: 2, northM: -1 } }), now)).toBe(false);
    expect(changeSetStale(set(), lined(null))).toBe(false);
    // within a millimetre
    expect(changeSetStale(set({ to: { eastM: 2.0004, northM: -1 } }), now)).toBe(false);
  });

  it('stale when only the turn changed', () => {
    const turn = { rotationDeg: 0.3, scale: 1, pivotE: 500100, pivotN: 3199900 };
    const base = lined({ eastM: 2, northM: -1 });
    const now: ProjectManifest = {
      ...base,
      origin: [500000, 3200000, 0],
      captures: base.captures.map((c) => (c.id === 'd2' ? { ...c, lineUpTurn: turn } : c)),
    };
    // computed with the same shift but no turn
    expect(changeSetStale(set({ to: { eastM: 2, northM: -1 } }), now)).toBe(true);
    // computed with this very turn: fresh
    const withTurn = (t: typeof turn) =>
      ChangeSet.parse({ ...set({ to: { eastM: 2, northM: -1 } }), lineUpTurn: { to: t } });
    expect(changeSetStale(withTurn(turn), now)).toBe(false);
    // computed with another turn: stale
    expect(changeSetStale(withTurn({ ...turn, rotationDeg: 0.2 }), now)).toBe(true);
    expect(changeSetStale(withTurn({ ...turn, scale: 1.001 }), now)).toBe(true);
    // the turn removed since
    expect(changeSetStale(withTurn(turn), base)).toBe(true);
  });
});
