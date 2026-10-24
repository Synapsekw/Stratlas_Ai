import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANGLES,
  MeasurementTool,
  type ComparisonResult,
  type SitePoint,
} from '@aio/schema';
import {
  PRIMARY_KEY,
  SECONDARY_KEYS,
  allRows,
  formatAngle,
  formatBearingAs,
  formatRow,
  primaryRow,
  secondaryRows,
  type ReadoutRow,
} from './readout';

const E0 = 512_340;
const N0 = 2_710_250;
const pts: SitePoint[] = [
  [E0, N0, 100],
  [E0 + 100, N0, 110],
  [E0 + 100, N0 + 100, 105],
];
const fixture = (tool: MeasurementTool) => ({ tool, points: pts });

const units = { distance: 'm', area: 'm2', volume: 'm3', grade: 'percent' } as never;

describe('primary readout', () => {
  it('every tool has a primary key that allRows produces', () => {
    for (const tool of MeasurementTool.options) {
      const keys = allRows(fixture(tool)).map((r) => r.key);
      expect(keys, tool).toContain(PRIMARY_KEY[tool]);
    }
  });

  it('follows the table: slope length, net, elevation, plan area', () => {
    expect(PRIMARY_KEY.distance).toBe('slope-length');
    expect(PRIMARY_KEY.volume).toBe('net');
    expect(PRIMARY_KEY.elevation).toBe('z');
    expect(PRIMARY_KEY.area).toBe('area');
    expect(primaryRow(fixture('distance'))?.key).toBe('slope-length');
    expect(primaryRow(fixture('elevation'))?.key).toBe('z');
  });

  it('falls back to the first non-null row when the primary has no value', () => {
    // A volume with no result: net is null, so the next item with a value is the area.
    expect(primaryRow(fixture('volume'))?.key).toBe('area');
  });

  it('uses the template items when they leave the primary key out', () => {
    expect(primaryRow(fixture('distance'), {}, ['horizontal', 'grade'])?.key).toBe('horizontal');
    expect(primaryRow(fixture('distance'), {}, ['slope-length'])?.key).toBe('slope-length');
  });

  it('distance secondary line is horizontal, height, grade', () => {
    expect(SECONDARY_KEYS.distance).toEqual(['horizontal', 'height-change', 'grade']);
    expect(secondaryRows(fixture('distance')).map((r) => r.key)).toEqual([
      'horizontal',
      'height-change',
      'grade',
    ]);
    for (const tool of MeasurementTool.options)
      expect(SECONDARY_KEYS[tool].length, tool).toBeLessThanOrEqual(3);
  });
});

describe('the headline on a survey date', () => {
  const res = (to: string, net: number, extra: Partial<ComparisonResult> = {}) =>
    ({
      item: 'pile',
      status: 'ok',
      cutM3: 0,
      fillM3: net,
      netM3: net,
      totalM3: net,
      areaM2: 100,
      areaCutM2: 0,
      areaFillM2: 0,
      areaUnchangedM2: 0,
      uncoveredM2: 0,
      fromLabel: 'base',
      toLabel: to,
      toCapture: to,
      deadbandM: 0,
      usedDeadband: false,
      cellM: 0.5,
      engine: 'ts',
      fingerprint: 'sha256:x',
      computedAt: '2026-10-09T00:00:00Z',
      ...extra,
    }) satisfies ComparisonResult;
  const items = [
    {
      id: 'pile',
      from: { kind: 'smart' as const },
      to: { kind: 'current' as const },
      useDeadband: false,
    },
  ];
  const vol = (results: ComparisonResult[], series: ComparisonResult[] = []) => ({
    tool: 'volume' as const,
    points: pts,
    items,
    results,
    series,
  });
  const carried = { from: 'kit' as const, base: 'tin', pile: 'p', epoch: 'e2' };

  it('primaryText with a capture shows that date figure', () => {
    const m = vol([res('d2', 200)], [res('d1', 100)]);
    expect(primaryRow(m)?.value).toBe(200);
    expect(primaryRow(m, { capture: 'd1' })?.value).toBe(100);
    expect(primaryRow(m, { capture: 'd2' })?.value).toBe(200);
    expect(allRows(m, { capture: 'd1' }).find((r) => r.key === 'total')?.value).toBe(100);
  });

  it('a date without a figure says so and never shows another date figure', () => {
    const m = vol([res('d2', 200)]);
    const net = allRows(m, { capture: 'd9' }).find((r) => r.key === 'net');
    expect(net?.value).toBeNull();
    expect(net?.note).toBe('No figure for this date');
  });

  it('a carried headline says it is from an earlier version', () => {
    const m = vol([res('d2', 63_827, { carried })]);
    const r = primaryRow(m);
    expect(r?.key).toBe('net');
    expect(r?.value).toBe(63_827);
    expect(r?.note).toBe('From an earlier version');
    expect(r && formatRow(r, units, { volume: 1 } as never)).toMatch(
      / \(From an earlier version\)$/,
    );
    // the compact line does not repeat it
    expect(allRows(m).find((x) => x.key === 'cut')?.note).toBeUndefined();
  });

  it('a partial headline says so, with the reason when there is one', () => {
    expect(primaryRow(vol([res('d1', 5, { status: 'partial' })]))?.note).toBe(
      'Partly outside the survey',
    );
    expect(
      primaryRow(vol([res('d1', 5, { status: 'partial', reason: '23% outside the survey' })]))
        ?.note,
    ).toBe('Partly outside the survey: 23% outside the survey');
  });

  it('a refused headline shows the refusal, not a number', () => {
    const r = primaryRow(vol([res('d1', 0, { status: 'refused', reason: 'no overlap' })]));
    expect(r?.key).toBe('net');
    expect(r?.value).toBeNull();
    expect(r?.note).toBe('Not computed: no overlap');
    expect(primaryRow(vol([res('d1', 0, { status: 'refused' })]))?.note).toBe(
      'Not computed: the survey does not cover it',
    );
  });

  it('a stale headline still says stale', () => {
    expect(primaryRow(vol([res('d1', 5, { status: 'stale', carried })]))?.note).toBe(
      'Stale, recompute',
    );
  });
});

describe('angle formatting', () => {
  it('formats angles and bearings by the site angle settings', () => {
    expect(formatAngle(15.2, { angle: 'dms', bearing: 'dms', precision: 0 })).toBe('15°12\'00"');
    expect(formatAngle(15.2, { angle: 'deg', bearing: 'dms', precision: 1 })).toBe('15.2°');
    expect(formatBearingAs(45.5, { angle: 'deg', bearing: 'deg', precision: 2 })).toBe('045.50°');
    expect(formatBearingAs(359.996, { angle: 'deg', bearing: 'deg', precision: 2 })).toBe(
      '000.00°',
    );
    expect(formatBearingAs(45.5, DEFAULT_ANGLES)).toBe('045°30\'00"');
  });

  it('formatRow without angles keeps today output', () => {
    const rows = (key: string, value: number, kind: ReadoutRow['kind']): ReadoutRow => ({
      key,
      label: key,
      value,
      kind,
    });
    expect(formatRow(rows('azimuth', 15.2, 'angle'), units, 'standard' as never)).toBe('15.20°');
    expect(formatRow(rows('vertical-angle', 15.2, 'text'), units, 'standard' as never)).toBe(
      '15.20°',
    );
    expect(formatRow(rows('bearing', 45.5, 'bearing'), units, 'standard' as never)).toBe(
      '045°30\'00"',
    );
    expect(
      formatRow(rows('azimuth', 15.2, 'angle'), units, 'standard' as never, undefined, {
        angle: 'dms',
        bearing: 'dms',
        precision: 0,
      }),
    ).toBe('15°12\'00"');
  });
});
