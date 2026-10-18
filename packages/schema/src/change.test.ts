import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_VERDICTS,
  ChangeSet,
  ChangeThresholds,
  LineUpMeasure,
  DEFAULT_CHANGE_THRESHOLDS,
  type ChangeSetInput,
} from './index';

const fixtures = new URL('./__fixtures__/change/', import.meta.url);
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, fixtures), 'utf8')) as unknown;

const base = (): ChangeSetInput => ({
  schema: 'aio.change/1',
  id: 'c1-c2-vectors',
  from: 'c1',
  to: 'c2',
  producer: 'vectors',
  createdAt: '2026-10-06T08:00:00Z',
  items: [
    {
      kind: 'vector',
      id: 'vector:fence-2',
      verdict: 'moved',
      layerFrom: 'fence-c1',
      layerTo: 'fence-c2',
      featureFrom: 'F-2',
      featureTo: 'F-2',
      distanceM: 3.1,
    },
  ],
});

describe('change sets (aio.change/1)', () => {
  it('keeps the shifts a change set was computed with', () => {
    const lineUp = { from: { eastM: 1.2, northM: -0.5 }, to: { eastM: 0, northM: 0 } };
    const r = ChangeSet.safeParse({ ...base(), lineUp });
    expect(r.success && r.data.lineUp).toEqual(lineUp);
    expect(
      ChangeSet.safeParse({ ...base(), lineUp: { from: { eastM: 501, northM: 0 } } }).success,
    ).toBe(false);
    expect(ChangeSet.safeParse({ ...base(), lineUp: { extra: 1 } }).success).toBe(false);
  });

  it('keeps the turns a change set was computed with, beside lineUp', () => {
    const turn = { rotationDeg: 0.5, scale: 1.001, pivotE: 500100, pivotN: 3200200 };
    const lineUp = { from: { eastM: 0, northM: 0 }, to: { eastM: 2, northM: 0 } };
    const r = ChangeSet.safeParse({ ...base(), lineUp, lineUpTurn: { to: turn } });
    expect(r.success && r.data.lineUpTurn).toEqual({ to: turn });
    expect(r.success && r.data.lineUp).toEqual(lineUp);
    // lineUp itself stays strict: the turn never goes inside it
    const inside = { ...lineUp, to: { ...lineUp.to, rotationDeg: 0.5 } };
    expect(ChangeSet.safeParse({ ...base(), lineUp: inside }).success).toBe(false);
    // the turn's bounds: 1 degree and 1%
    const bad = [
      { ...turn, rotationDeg: 1.5 },
      { ...turn, scale: 1.02 },
    ];
    for (const t of bad)
      expect(ChangeSet.safeParse({ ...base(), lineUpTurn: { from: t } }).success).toBe(false);
    // a set written before turns has none
    expect(ChangeSet.parse(base()).lineUpTurn).toBeUndefined();
  });

  it('parses a line-up measurement', () => {
    const m: LineUpMeasure = {
      keep: 'c1',
      move: 'c2',
      layerKeep: 'ortho-1',
      layerMove: 'ortho-2',
      source: 'ortho',
      eastM: 2,
      northM: -0.2,
      totalM: 2.01,
      cellM: 0.05,
      tolerancePx: 2,
      spreadPx: 0.4,
      tiles: 12,
      verdict: 'ok',
    };
    expect(LineUpMeasure.parse(m)).toEqual(m);
    expect(LineUpMeasure.safeParse({ ...m, verdict: 'maybe' }).success).toBe(false);
  });

  it('accepts every shared fixture (also read by the Python writer tests)', () => {
    const names = readdirSync(fixtures).filter((n) => n.endsWith('.json'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const r = ChangeSet.safeParse(fixture(name));
      expect(r.success, `${name}: ${r.error?.message ?? ''}`).toBe(true);
    }
  });

  it('defaults layers and stats, and keeps reviews', () => {
    const s = ChangeSet.parse(base());
    expect(s.layers).toEqual([]);
    expect(s.stats).toEqual({});
    const issues = ChangeSet.parse(fixture('issues.json'));
    expect(issues.items[1]?.review).toMatchObject({ status: 'confirmed', by: 'reviewer' });
  });

  it('refuses a verdict that does not belong to the kind', () => {
    const s = base();
    expect(
      ChangeSet.safeParse({ ...s, items: [{ kind: 'issue', id: 'i', verdict: 'moved' }] }).success,
    ).toBe(false);
    expect(
      ChangeSet.safeParse({ ...s, items: [{ kind: 'region', id: 'r', verdict: 'fill' }] }).success,
    ).toBe(true);
    for (const verdicts of Object.values(CHANGE_VERDICTS))
      expect(verdicts.length).toBeGreaterThan(1);
  });

  it('refuses the same date twice, duplicate item ids and unsafe ids', () => {
    expect(ChangeSet.safeParse({ ...base(), to: 'c1' }).success).toBe(false);
    const item = base().items[0];
    expect(ChangeSet.safeParse({ ...base(), items: [item, item] }).success).toBe(false);
    expect(ChangeSet.safeParse({ ...base(), id: '../evil' }).success).toBe(false);
  });

  it('names a frame by a time or a photo, not both', () => {
    const frame = (a: object) => ({
      ...base(),
      items: [{ kind: 'frame', id: 'f', verdict: 'changed', a, b: { layer: 'clip-2', t: 4.5 } }],
    });
    expect(ChangeSet.safeParse(frame({ layer: 'clip-1', t: 4 })).success).toBe(true);
    expect(ChangeSet.safeParse(frame({ layer: 'photos', photo: 'p1' })).success).toBe(true);
    expect(ChangeSet.safeParse(frame({ layer: 'clip-1', t: 4, photo: 'p1' })).success).toBe(false);
  });
});

describe('change thresholds (founder defaults, 6 Oct 2026)', () => {
  it('fills the defaults', () => {
    expect(DEFAULT_CHANGE_THRESHOLDS).toEqual({
      cloud: { significantM: 0.05, farM: 0.3 },
      surface: { minDepthM: 0.1, minAreaM2: 1 },
      raster: { preset: 'conservative' },
      grown: { areaPct: 20, severityLevels: 1 },
      registration: { maxShiftPx: 2, maxShiftM: 0.05 },
    });
  });

  it('keeps a person value and fills the rest', () => {
    const t = ChangeThresholds.parse({ cloud: { farM: 0.5 } });
    expect(t.cloud).toEqual({ significantM: 0.05, farM: 0.5 });
    expect(t.surface.minAreaM2).toBe(1);
    expect(ChangeThresholds.safeParse({ cloud: { farM: -1 } }).success).toBe(false);
    expect(ChangeThresholds.safeParse({ bogus: 1 }).success).toBe(false);
  });
});
