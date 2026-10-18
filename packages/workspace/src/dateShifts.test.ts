import type { DateShift, Layer, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import fixture from '../../schema/src/__fixtures__/date-shift/membership.json';
import { captureShift, dateShiftOf, hintOnlyLayers, layerDateShifts, shiftKey } from './dateShifts';

interface Case {
  name: string;
  manifest: ProjectManifest;
  expected: Record<string, DateShift>;
}
const cases = (fixture as unknown as { cases: Case[] }).cases;

const cloud = (id: string, name: string, extra: Partial<Layer> = {}): Layer =>
  ({
    kind: 'pointcloud',
    id,
    name,
    visible: true,
    src: { path: `clouds/${id}.copc.laz` },
    format: 'copc',
    ...extra,
  }) as Layer;

const manifest = (layers: Layer[]): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'demo',
  name: 'Demo',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [
    { id: 'd1', label: 'First', date: '2026-01-10' },
    {
      id: 'd2',
      label: 'Second',
      date: '2026-02-10',
      lineUp: { eastM: 2, northM: -1, with: 'd1', at: '2026-10-16T08:00:00Z' },
    },
  ],
  layers,
  severityModels: [],
  classCatalogues: [],
});

describe('layerDateShifts', () => {
  it('matches the shared membership fixture', () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases)
      expect({ name: c.name, got: layerDateShifts(c.manifest) }).toEqual({
        name: c.name,
        got: c.expected,
      });
  });

  it('a change result never takes a shift', () => {
    const m = manifest([
      cloud('a', 'Scan', { capture: 'd2' }),
      cloud('chg', 'Change', { capture: 'd2', derived: { kind: 'change', from: 'd1', to: 'd2' } }),
    ]);
    expect(Object.keys(layerDateShifts(m))).toEqual(['a']);
    expect(dateShiftOf(m, 'chg')).toBeNull();
  });

  it("a layer moved to another date takes that date's shift", () => {
    const b = cloud('b', 'Scan', { capture: 'd1' });
    const m = manifest([cloud('a', 'Scan', { capture: 'd2' }), b]);
    expect(dateShiftOf(m, 'a')).toEqual({ eastM: 2, northM: -1 });
    const moved = manifest([cloud('a', 'Scan', { capture: 'd1' }), b]);
    expect(dateShiftOf(moved, 'a')).toBeNull();
    expect(captureShift(moved, 'd2')).toEqual({ eastM: 2, northM: -1 });
    expect(captureShift(moved, 'd1')).toBeNull();
    expect(captureShift(moved, 'nope')).toBeNull();
  });

  it('is memoised on the manifest object', () => {
    const m = manifest([cloud('a', 'Scan', { capture: 'd2' })]);
    expect(layerDateShifts(m)).toBe(layerDateShifts(m));
  });
});

describe('hintOnlyLayers', () => {
  it('finds layers only the volume hints date', () => {
    const m = manifest([
      cloud('a', 'Scan', { capture: 'd2' }),
      cloud('b', 'Surface'),
      cloud('c', 'Other'),
    ]);
    const hints = { layers: { d2: ['b', 'a'], d1: ['c'] } };
    expect(hintOnlyLayers(m, hints, 'd2')).toEqual(['b']);
    expect(hintOnlyLayers(m, hints, 'd1')).toEqual(['c']);
    expect(hintOnlyLayers(m, {}, 'd2')).toEqual([]);
  });
});

describe('shiftKey', () => {
  it('keys a shift to the millimetre', () => {
    expect(shiftKey(null)).toBe('');
    expect(shiftKey({ eastM: 2, northM: -1 })).toBe('2,-1');
    expect(shiftKey({ eastM: 2.0004, northM: -1.2346 })).toBe('2,-1.235');
    expect(shiftKey({ eastM: 2.0004, northM: -1.2346 })).toBe(
      shiftKey({ eastM: 2, northM: -1.235 }),
    );
  });

  it('shiftKey differs by turn alone', () => {
    const turn = { rotationDeg: 0.25, scale: 1.0005, pivotE: 500010, pivotN: 3200020 };
    const mk = (rotationDeg: number) => ({
      eastM: 2,
      northM: -1,
      turn: { ...turn, rotationDeg, pivotX: 10, pivotZ: -20 },
    });
    expect(shiftKey(mk(0.25))).toBe('2,-1,r0.25,s1.0005,p500010,3200020');
    expect(shiftKey(mk(0.25))).not.toBe(shiftKey(mk(0.26)));
    expect(shiftKey(mk(0.25))).not.toBe(shiftKey({ eastM: 2, northM: -1 }));
    // an identity turn keeps today's key
    expect(shiftKey({ eastM: 2, northM: -1, turn: { ...mk(0).turn, scale: 1 } })).toBe('2,-1');
  });
});

describe('a turned line-up is read with the manifest origin', () => {
  it('places the pivot in the local frame', () => {
    const m = manifest([cloud('a', 'Scan', { capture: 'd2' })]);
    const lineUpTurn = { rotationDeg: 0.5, scale: 1.001, pivotE: 500100, pivotN: 3199900 };
    m.captures = m.captures.map((c) => (c.id === 'd2' ? { ...c, lineUpTurn } : c));
    const s = captureShift(m, 'd2');
    expect(s?.turn?.pivotX).toBe(100);
    expect(s?.turn?.pivotZ).toBe(100);
    expect(dateShiftOf(m, 'a')?.turn?.rotationDeg).toBe(0.5);
  });
});
