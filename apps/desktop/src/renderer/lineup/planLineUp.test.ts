import {
  captureLineUpShift,
  shiftEN,
  type Capture,
  type DateShift,
  type Issue,
  type LineUpFit,
  type SurveyMeasurement,
} from '@aio/schema';
import { t } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import type { Box } from '../shell/layerBounds';
import {
  formatMetres,
  lineUpTip,
  movesWith,
  pairsToMeasure,
  planLineUp,
  shiftWords,
  turnWords,
  type LineUpPlan,
} from './planLineUp';
import { cloud, dsm, fitOf, lineUpManifest, measureOf, ortho } from './testing';

const AT = '2026-10-17T10:00:00.000Z';

const issueOn = (id: string, layers: string[]) =>
  ({ id, sightings: layers.map((layer) => ({ on: 'pointcloud', layer })) }) as unknown as Issue;
const measurement = (id: string, scope: SurveyMeasurement['scope']) =>
  ({ id, scope }) as unknown as SurveyMeasurement;

const box = (minX: number, minZ: number, maxX: number, maxZ: number): Box => ({
  min: [minX, 0, minZ],
  max: [maxX, 10, maxZ],
});

const ORIGIN = [500000, 4000000, 10] as const;

/** The correction a fit describes, as the helpers apply it. */
const correctionOf = (f: LineUpFit): DateShift => ({
  eastM: f.eastM,
  northM: f.northM,
  turn: {
    rotationDeg: f.rotationDeg,
    scale: f.scale,
    pivotE: f.pivotE,
    pivotN: f.pivotN,
    pivotX: f.pivotE - ORIGIN[0],
    pivotZ: ORIGIN[1] - f.pivotN,
  },
});

/** What the plan saves, read back as the app reads a capture. */
const savedShift = (plan: LineUpPlan): DateShift | null =>
  captureLineUpShift(
    {
      id: plan.moveId,
      label: plan.moveId,
      lineUp: plan.lineUp,
      ...(plan.lineUpTurn ? { lineUpTurn: plan.lineUpTurn } : {}),
    } as Capture,
    [...ORIGIN],
  );

/** Points spread over a few hundred metres of site, project CRS. */
const POINTS: [number, number][] = [
  [500000, 4000000],
  [500050, 3999975],
  [500310, 3999820],
  [499870, 4000240],
];

const expectSameMove = (got: DateShift | null, want: (p: [number, number]) => number[]) => {
  for (const p of POINTS) {
    const a = shiftEN(p, got);
    const b = want(p);
    expect(Math.abs(a[0] - (b[0] ?? 0))).toBeLessThan(1e-6);
    expect(Math.abs(a[1] - (b[1] ?? 0))).toBeLessThan(1e-6);
  }
};

describe('planLineUp with a turn', () => {
  const oldTurn = { rotationDeg: 0.4, scale: 0.999, pivotE: 500020, pivotN: 3999990 };
  const old = { eastM: 0.5, northM: -0.25, with: 'd1', at: AT };

  it('composes a turn onto an existing one', () => {
    const man = lineUpManifest({ lineUps: { d2: old }, turns: { d2: oldTurn } });
    const fit = fitOf();
    const plan = planLineUp(measureOf({ fit }), 'd1', man, AT);
    expect(plan.moveId).toBe('d2');
    expect(plan.previous).toEqual(old);
    expect(plan.previousTurn).toEqual(oldTurn);
    expect(plan.lineUpTurn).not.toBeNull();
    expect(plan.lineUpTurn?.rotationDeg).toBeCloseTo(0.65, 9);
    expect(plan.lineUpTurn?.scale).toBeCloseTo(0.999 * 1.0035, 9);
    // saved about the newer pivot
    expect(plan.lineUpTurn).toMatchObject({ pivotE: fit.pivotE, pivotN: fit.pivotN });
    const now = captureLineUpShift(
      { id: 'd2', label: 'd2', lineUp: old, lineUpTurn: oldTurn } as Capture,
      [...ORIGIN],
    );
    // applying the saved line-up is applying the old one, then the correction
    expectSameMove(savedShift(plan), (p) => shiftEN(shiftEN(p, now), correctionOf(fit)));
    expect(plan.totalM).toBe(2.4);
    expect(plan.inRange).toBe(true);
  });

  it('keeping the other date saves the inverse', () => {
    const fit = fitOf();
    const plan = planLineUp(measureOf({ fit }), 'd2', lineUpManifest(), AT);
    expect(plan.moveId).toBe('d1');
    expect(plan.previousTurn).toBeNull();
    expect(plan.lineUpTurn?.rotationDeg).toBeCloseTo(-0.25, 9);
    expect(plan.lineUpTurn?.scale).toBeCloseTo(1 / 1.0035, 9);
    // the correction after the saved line-up puts every point back
    expectSameMove(savedShift(plan), (p) => shiftEN(p, correctionOf(fit), -1));
    expect(plan.inRange).toBe(true);
  });

  it('lining up an aligned pair adds nothing', () => {
    const none = fitOf({ rotationDeg: 0, scale: 1, eastM: 0, northM: 0, maxMoveM: 0 });
    const man = lineUpManifest({ lineUps: { d2: old }, turns: { d2: oldTurn } });
    const plan = planLineUp(measureOf({ eastM: 0, northM: 0, fit: none }), 'd1', man, AT);
    expect(plan.lineUp.eastM).toBeCloseTo(old.eastM, 6);
    expect(plan.lineUp.northM).toBeCloseTo(old.northM, 6);
    expect(plan.lineUpTurn?.rotationDeg).toBeCloseTo(oldTurn.rotationDeg, 9);
    expect(plan.lineUpTurn?.scale).toBeCloseTo(oldTurn.scale, 9);
    expect(plan.lineUpTurn).toMatchObject({ pivotE: oldTurn.pivotE, pivotN: oldTurn.pivotN });
    // and onto a plain date: still no turn
    const plain = planLineUp(
      measureOf({ eastM: 0, northM: 0, fit: none }),
      'd1',
      lineUpManifest(),
      AT,
    );
    expect(plain.lineUpTurn).toBeNull();
    expect(plain.lineUp).toMatchObject({ eastM: 0, northM: 0 });
  });

  it('undoes an earlier turn to a plain shift', () => {
    const man = lineUpManifest({ lineUps: { d2: old }, turns: { d2: oldTurn } });
    const back = fitOf({ rotationDeg: -0.4, scale: 1 / 0.999, pivotE: 500020, pivotN: 3999990 });
    expect(planLineUp(measureOf({ fit: back }), 'd1', man, AT).lineUpTurn).toBeNull();
  });

  it('cannot save a composed turn beyond the stored bounds or a move beyond 500 m', () => {
    const big = { rotationDeg: 1.5, scale: 1, pivotE: 500020, pivotN: 3999990 };
    const man = lineUpManifest({ lineUps: { d2: old }, turns: { d2: big } });
    expect(planLineUp(measureOf({ fit: fitOf({ rotationDeg: 0.8 }) }), 'd1', man, AT).inRange).toBe(
      false,
    );
    expect(planLineUp(measureOf({ fit: fitOf({ rotationDeg: 0.4 }) }), 'd1', man, AT).inRange).toBe(
      true,
    );
    const scaled = lineUpManifest({
      lineUps: { d2: old },
      turns: { d2: { ...big, rotationDeg: 0, scale: 1.015 } },
    });
    expect(planLineUp(measureOf({ fit: fitOf({ scale: 1.008 }) }), 'd1', scaled, AT).inRange).toBe(
      false,
    );
    const far = planLineUp(
      measureOf({ fit: fitOf({ maxMoveM: 501 }) }),
      'd1',
      lineUpManifest(),
      AT,
    );
    expect(far.totalM).toBe(501);
    expect(far.inRange).toBe(false);
  });

  it('the folder tip shows the turn', () => {
    const lined = { eastM: 2.01, northM: 0, with: 'd1', at: AT };
    const turned = lineUpManifest({
      lineUps: { d2: lined },
      turns: { d2: { rotationDeg: 0.11, scale: 0.9982, pivotE: 500050, pivotN: 3999975 } },
    });
    expect(lineUpTip(turned, 'd2', t)).toBe(
      'Lined up with Survey 2 March 2026 (2.01 m, turned 0.11°, scaled -0.18%)',
    );
    // a plain shift reads as before
    expect(lineUpTip(lineUpManifest({ lineUps: { d2: lined } }), 'd2', t)).toBe(
      'Lined up with Survey 2 March 2026 (2.01 m)',
    );
    expect(lineUpTip(turned, 'd1', t)).toBeNull();
  });

  it('says the turn in degrees and a signed percent', () => {
    expect(turnWords({ rotationDeg: 0.25, scale: 1.0035 }, t)).toBe('turned 0.25°, scaled +0.35%');
    expect(turnWords({ rotationDeg: -0.004, scale: 0.99999 }, t)).toBe(
      'turned 0.00°, scaled +0.00%',
    );
    expect(turnWords({ rotationDeg: -1, scale: 0.99 }, t)).toBe('turned -1.00°, scaled -1.00%');
  });
});

describe('planLineUp', () => {
  it('moves the later date by the correction', () => {
    const plan = planLineUp(measureOf(), 'd1', lineUpManifest(), AT);
    expect(plan.moveId).toBe('d2');
    expect(plan.lineUp).toEqual({ eastM: -2, northM: 0, with: 'd1', spreadM: 0.02, at: AT });
    expect(plan.lineUpTurn).toBeNull();
    expect(plan.previous).toBeNull();
    expect(plan.previousTurn).toBeNull();
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

  it('says whether the shift stays within 500 m', () => {
    const at = (eastM: number) =>
      lineUpManifest({ lineUps: { d2: { eastM, northM: 0, with: 'd1', at: AT } } });
    const plan = (eastM: number) => planLineUp(measureOf({ eastM: 2 }), 'd1', at(eastM), AT);
    expect(plan(498).inRange).toBe(true);
    expect(plan(498).lineUp.eastM).toBe(500);
    expect(plan(499).inRange).toBe(false);
    expect(planLineUp(measureOf({ eastM: Number.NaN }), 'd1', at(0), AT).inRange).toBe(false);
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
    // a date lined up since: its pairs are new to the memory (spec call 11)
    const moved = lineUpManifest({
      captures,
      layers: m.layers,
      lineUps: { d2: { eastM: 1.25, northM: -0.5, with: 'd1', at: AT } },
    });
    expect(pairsToMeasure(moved, extents, new Set(['o1|o2'])).map((p) => p.key)).toEqual([
      'o1|o2@1.25,-0.5',
      'o2@1.25,-0.5|o3',
    ]);
  });
});
