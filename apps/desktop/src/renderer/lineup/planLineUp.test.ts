import type { Issue, SurveyMeasurement } from '@aio/schema';
import { t } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import type { Box } from '../shell/layerBounds';
import { formatMetres, movesWith, pairsToMeasure, planLineUp, shiftWords } from './planLineUp';
import { cloud, dsm, lineUpManifest, measureOf, ortho } from './testing';

const AT = '2026-10-17T10:00:00.000Z';

const issueOn = (id: string, layers: string[]) =>
  ({ id, sightings: layers.map((layer) => ({ on: 'pointcloud', layer })) }) as unknown as Issue;
const measurement = (id: string, scope: SurveyMeasurement['scope']) =>
  ({ id, scope }) as unknown as SurveyMeasurement;

const box = (minX: number, minZ: number, maxX: number, maxZ: number): Box => ({
  min: [minX, 0, minZ],
  max: [maxX, 10, maxZ],
});

describe('planLineUp', () => {
  it('moves the later date by the correction', () => {
    const plan = planLineUp(measureOf(), 'd1', lineUpManifest(), AT);
    expect(plan.moveId).toBe('d2');
    expect(plan.lineUp).toEqual({ eastM: -2, northM: 0, with: 'd1', spreadM: 0.02, at: AT });
    expect(plan.previous).toBeNull();
    expect(plan.totalM).toBe(2);
  });

  it('moves the other date when keep is swapped', () => {
    const plan = planLineUp(measureOf(), 'd2', lineUpManifest(), AT);
    expect(plan.moveId).toBe('d1');
    expect(plan.lineUp).toMatchObject({ eastM: 2, northM: 0, with: 'd2' });
  });

  it('plans an absolute shift when the kept date is already shifted', () => {
    const d1 = { eastM: 1, northM: 1, with: 'd2', at: AT };
    const old = { eastM: 0.25, northM: -0.5, with: 'd1', at: AT };
    const m = lineUpManifest({ lineUps: { d1, d2: old } });
    // measured between the dates as placed: d2 sits 0.75 m west and 1.5 m south of d1
    const plan = planLineUp(measureOf({ eastM: 0.75, northM: 1.5, totalM: 1.677 }), 'd1', m, AT);
    expect(plan.lineUp).toMatchObject({ eastM: 1, northM: 1, with: 'd1' });
    expect(plan.previous).toEqual(old);
  });

  it('counts what moves with a date', () => {
    const m = lineUpManifest({
      layers: [ortho('o1', 'd1'), ortho('o2', 'd2'), cloud('c2', 'd2'), ortho('base')],
    });
    const issues = [issueOn('i1', ['c2']), issueOn('i2', ['o1']), issueOn('i3', ['o2', 'c2'])];
    const measurements = [
      measurement('m1', { kind: 'survey', capture: 'd2' }),
      measurement('m2', { kind: 'site' }),
      measurement('m3', { kind: 'survey', capture: 'd1' }),
    ];
    expect(movesWith(m, 'd2', issues, measurements)).toEqual({ layers: 2, items: 3 });
    expect(movesWith(m, 'd1', issues, measurements)).toEqual({ layers: 1, items: 2 });
  });

  it('writes distances with two decimals and compass words', () => {
    expect(formatMetres(2.006)).toBe('2.01 m');
    expect(shiftWords(-2.01, 0, t)).toBe('2.01 m west, 0.00 m north (2.01 m in all)');
    expect(shiftWords(3, -4, t)).toBe('3.00 m east, 4.00 m south (5.00 m in all)');
  });

  it('pairs each date with the one it most overlaps', () => {
    const captures = [
      { id: 'd1', label: 'One', date: '2026-01-01' },
      { id: 'd2', label: 'Two', date: '2026-02-01' },
      { id: 'd3', label: 'Three', date: '2026-03-01' },
      { id: 'd4', label: 'Four', date: '2026-04-01' },
    ];
    const m = lineUpManifest({
      captures,
      layers: [
        ortho('o1', 'd1'),
        ortho('o2', 'd2'),
        dsm('s2', 'd2'),
        ortho('o3', 'd3'),
        // d4 has a DSM only: no ortho pair with the others, and no other date has a DSM alone
        dsm('s4', 'd4'),
      ],
    });
    const extents = {
      o1: box(0, 0, 100, 100),
      o2: box(10, 10, 110, 110),
      s2: box(10, 10, 110, 110),
      o3: box(60, 60, 160, 160),
      s4: box(0, 0, 100, 100),
    };
    const pairs = pairsToMeasure(m, extents, new Set());
    expect(pairs).toEqual([
      { keep: 'd1', move: 'd2', layerKeep: 'o1', layerMove: 'o2', key: 'o1|o2' },
      { keep: 'd2', move: 'd3', layerKeep: 'o2', layerMove: 'o3', key: 'o2|o3' },
    ]);
    expect(pairsToMeasure(m, extents, new Set(['o1|o2']))).toEqual([
      { keep: 'd2', move: 'd3', layerKeep: 'o2', layerMove: 'o3', key: 'o2|o3' },
    ]);
  });
});
