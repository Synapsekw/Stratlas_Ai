import { describe, expect, it } from 'vitest';
import { DEFAULT_ANGLES, MeasurementTool, type SitePoint } from '@aio/schema';
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

describe('angle formatting', () => {
  it('formats angles and bearings by the site angle settings', () => {
    expect(formatAngle(15.2, { angle: 'dms', bearing: 'dms', precision: 0 })).toBe('15°12\'00"');
    expect(formatAngle(15.2, { angle: 'deg', bearing: 'dms', precision: 1 })).toBe('15.2°');
    expect(formatBearingAs(45.5, { angle: 'deg', bearing: 'deg', precision: 2 })).toBe('045.50°');
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
