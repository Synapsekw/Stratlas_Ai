import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_VERDICTS,
  ChangeScope,
  ChangeSet,
  ChangeThresholds,
  LineUpFit,
  LineUpMeasure,
  DEFAULT_CHANGE_THRESHOLDS,
  inferChangeScope,
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

  it('a change set with a 1.5 degree recorded turn parses', () => {
    const turn = { rotationDeg: 1.5, scale: 1.015, pivotE: 500100, pivotN: 3199900 };
    const r = ChangeSet.safeParse({
      ...base(),
      lineUp: { to: { eastM: 2, northM: -1 } },
      lineUpTurn: { to: turn },
    });
    expect(r.success).toBe(true);
    expect(r.data?.lineUpTurn?.to).toEqual(turn);
    // beyond the stored envelope, and an unknown side, are refused
    const at = (to: object) => ChangeSet.safeParse({ ...base(), lineUpTurn: { to } }).success;
    expect(at({ ...turn, rotationDeg: 2.5 })).toBe(false);
    expect(at({ ...turn, scale: 1.03 })).toBe(false);
    expect(ChangeSet.safeParse({ ...base(), lineUpTurn: { mid: turn } }).success).toBe(false);
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

  it('LineUpFit parses a range verdict', () => {
    const fit: LineUpFit = {
      rotationDeg: 3.01,
      scale: 1.0002,
      pivotE: 500012.5,
      pivotN: 3200005,
      eastM: 0.01,
      northM: -0.02,
      maxMoveM: 5.1,
      residualPx: 0.3,
      inliers: 40,
      verdict: 'range',
    };
    expect(LineUpFit.parse(fit)).toEqual(fit);
    expect(LineUpFit.safeParse({ ...fit, verdict: 'maybe' }).success).toBe(false);
    // lineup.json never says range (older apps parse it strictly); the app adds the fit beside it
    const m = {
      keep: 'c1',
      move: 'c2',
      layerKeep: 'ortho-1',
      layerMove: 'ortho-2',
      source: 'ortho',
      eastM: 0.01,
      northM: -0.02,
      totalM: 5.1,
      cellM: 0.05,
      tolerancePx: 2,
      spreadPx: 0.3,
      tiles: 40,
      verdict: 'disagree',
    } as const;
    expect(LineUpMeasure.safeParse({ ...m, verdict: 'range' }).success).toBe(false);
    expect(LineUpMeasure.parse({ ...m, fit }).fit).toEqual(fit);
    expect(LineUpMeasure.parse(m).fit).toBeUndefined();
  });

  it('accepts every shared fixture (also read by the Python writer tests)', () => {
    const names = readdirSync(fixtures).filter((n) => n.endsWith('.json'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const r = ChangeSet.safeParse(fixture(name));
      expect(r.success, `${name}: ${r.error?.message ?? ''}`).toBe(true);
    }
  });

  it('a change set keeps its area scope', () => {
    const scope = { id: 'pad-a', name: 'Pad A' };
    expect(ChangeSet.parse({ ...base(), scope }).scope).toEqual(scope);
    expect(ChangeScope.safeParse({ id: 'pad a', name: 'x' }).success).toBe(false);
    expect(ChangeScope.safeParse({ id: 'pad-a', name: 'x'.repeat(121) }).success).toBe(false);
    const volumesMissing = { reason: 'Misaligned by 3 m', at: '2026-10-19T08:00:00Z' };
    expect(ChangeSet.parse({ ...base(), scope, volumesMissing }).volumesMissing).toEqual(
      volumesMissing,
    );
    expect(
      ChangeSet.safeParse({ ...base(), volumesMissing: { ...volumesMissing, reason: '' } }).success,
    ).toBe(false);
    // a reason code with its gap or the job's own words, worded by the app
    const coded = { reason: 'misaligned', shiftM: 2.01, at: '2026-10-19T08:00:00Z' };
    expect(ChangeSet.parse({ ...base(), volumesMissing: coded }).volumesMissing).toEqual(coded);
    const failed = { reason: 'failed', detail: 'Out of memory.', at: '2026-10-19T08:00:00Z' };
    expect(ChangeSet.parse({ ...base(), volumesMissing: failed }).volumesMissing).toEqual(failed);
  });

  it('finds the area of a scoped set an older build wrote back without its scope', () => {
    const stripped = (id: string, params?: Record<string, unknown>) =>
      ChangeSet.parse({
        ...base(),
        id,
        producer: 'change.raster',
        items: [],
        ...(params ? { run: { params } } : {}),
      });
    // the set id keeps the area id; the name comes from the polygon's label, else the id
    expect(inferChangeScope(stripped('c1-c2-raster-area-pad-a'))).toEqual({
      id: 'pad-a',
      name: 'pad-a',
    });
    expect(
      inferChangeScope(stripped('c1-c2-raster-area-pad-a'), (id) =>
        id === 'pad-a' ? '  Pad A ' : undefined,
      ),
    ).toEqual({ id: 'pad-a', name: 'Pad A' });
    // the params the set ran with (older builds keep `run`) give the stored name
    const params = { scope: { id: 'pad-a', name: 'Pad A (east)' } };
    expect(inferChangeScope(stripped('c1-c2-raster-area-pad-a', params))).toEqual(params.scope);
    // a whole-map set, and a set that has its scope, stay as they are
    expect(inferChangeScope(stripped('c1-c2-raster'))).toBeUndefined();
    const scope = { id: 'b', name: 'B' };
    expect(inferChangeScope({ ...stripped('c1-c2-raster-area-pad-a'), scope })).toEqual(scope);
    // a capture id that holds "-area-" is no area
    expect(
      inferChangeScope({ ...stripped('x-area-1-c2-raster'), from: 'x-area-1' }),
    ).toBeUndefined();
    // a long scoped id ends in a 12-character hash: the run's scope names it, else the hash
    const long = `${'c'.repeat(60)}-${'d'.repeat(60)}`;
    const hashed = `${`${long}-raster`.slice(0, 102)}-area-0123456789ab`;
    const set = { ...stripped(hashed), from: 'c'.repeat(60), to: 'd'.repeat(60) };
    expect(inferChangeScope(set)).toEqual({ id: '0123456789ab', name: '0123456789ab' });
    expect(inferChangeScope({ ...set, run: { params } })).toEqual(params.scope);
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
