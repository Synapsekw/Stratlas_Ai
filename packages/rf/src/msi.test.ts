import { describe, expect, it } from 'vitest';
import { DBD_TO_DBI, parseMsi, pickNearestPattern } from './msi';

/**
 * Asymmetric fixture. Horizontal cut as written in the file (angle increasing counter-clockwise):
 * attenuation is angle / 10 for 0..90 and 40 elsewhere, so only the file's +90 side (counter-clockwise,
 * the antenna's left) is quiet. Clockwise from boresight, that side is internal angle 270.
 * Vertical cut: 0 at the horizon, 90 below (down), 270 above (up); the file's 90 is 3 dB, 270 is 25 dB.
 */
function fixture(opts: { sep?: string; gain?: string; skipVertical?: boolean } = {}): string {
  const sep = opts.sep ?? ' ';
  const h = Array.from({ length: 360 }, (_, a) => `${a}${sep}${a <= 90 ? a / 10 : 40}`);
  const v = Array.from(
    { length: 360 },
    (_, a) => `${a}${sep}${a === 90 ? 3 : a === 270 ? 25 : 10}`,
  );
  return [
    'NAME Test Panel',
    'MAKE ExampleVendor',
    'FREQUENCY 2100',
    `GAIN ${opts.gain ?? '15.0 dBi'}`,
    'TILT ELECTRICAL',
    'COMMENT synthetic',
    'HORIZONTAL 360',
    ...h,
    ...(opts.skipVertical ? [] : ['VERTICAL 360', ...v]),
  ].join('\n');
}

describe('parseMsi', () => {
  it('reads the header and both cuts', () => {
    const p = parseMsi(fixture());
    expect(p.name).toBe('Test Panel');
    expect(p.make).toBe('ExampleVendor');
    expect(p.frequencyMhz).toBe(2100);
    expect(p.gainDbi).toBeCloseTo(15, 9);
    expect(p.horizontalDb).toHaveLength(360);
    expect(p.verticalDb).toHaveLength(360);
  });

  it('converts dBd to dBi (+2.15) and treats a bare gain as dBd', () => {
    expect(parseMsi(fixture({ gain: '12.85 dBd' })).gainDbi).toBeCloseTo(12.85 + DBD_TO_DBI, 9);
    expect(parseMsi(fixture({ gain: '12.85' })).gainDbi).toBeCloseTo(15, 9);
    expect(DBD_TO_DBI).toBe(2.15);
  });

  it('accepts commas, tabs and mixed separators', () => {
    const a = parseMsi(fixture());
    expect(parseMsi(fixture({ sep: ',' })).horizontalDb).toEqual(a.horizontalDb);
    expect(parseMsi(fixture({ sep: '\t' })).verticalDb).toEqual(a.verticalDb);
    expect(parseMsi(fixture({ sep: ', ' })).horizontalDb).toEqual(a.horizontalDb);
  });

  it('flips the horizontal cut to clockwise (a mirror bug fails here)', () => {
    const p = parseMsi(fixture());
    // file 90 (counter-clockwise) is internal 270 (clockwise): 9 dB
    expect(p.horizontalDb[270]).toBeCloseTo(9, 9);
    // file 270 (counter-clockwise) is internal 90: 40 dB
    expect(p.horizontalDb[90]).toBe(40);
    expect(p.horizontalDb[0]).toBe(0);
    expect(p.horizontalDb[359]).toBeCloseTo(0.1, 9); // file 1
  });

  it('keeps the vertical cut: 90 down, 270 up', () => {
    const p = parseMsi(fixture());
    expect(p.verticalDb[90]).toBe(3);
    expect(p.verticalDb[270]).toBe(25);
  });

  it('reads the tilt from a number', () => {
    expect(parseMsi(fixture().replace('TILT ELECTRICAL', 'TILT 6')).etiltDeg).toBe(6);
    expect(parseMsi(fixture().replace('TILT ELECTRICAL', 'ELECTRICAL_TILT 4.5')).etiltDeg).toBe(
      4.5,
    );
    expect(parseMsi(fixture()).etiltDeg).toBeUndefined();
  });

  it('refuses a file missing a cut, or with a short cut', () => {
    expect(() => parseMsi(fixture({ skipVertical: true }))).toThrow(/VERTICAL/);
    const short = fixture().split('\n').slice(0, 100).join('\n');
    expect(() => parseMsi(short)).toThrow(/HORIZONTAL|VERTICAL/);
    expect(() => parseMsi(fixture().replace('HORIZONTAL 360', 'HORIZONTAL 180'))).toThrow(/360/);
  });

  it('refuses a missing frequency or gain', () => {
    expect(() => parseMsi(fixture().replace('FREQUENCY 2100\n', ''))).toThrow(/FREQUENCY/);
    expect(() => parseMsi(fixture().replace(/GAIN .*\n/, ''))).toThrow(/GAIN/);
  });
});

describe('pickNearestPattern', () => {
  const refs = [
    { frequencyMhz: 1800, etiltDeg: 0 },
    { frequencyMhz: 1800, etiltDeg: 4 },
    { frequencyMhz: 1800, etiltDeg: 8 },
    { frequencyMhz: 2600, etiltDeg: 6 },
  ];
  it('snaps to the nearest e-tilt at the nearest frequency and says so', () => {
    const r = pickNearestPattern(refs, 1842, 5);
    expect(r?.ref).toEqual(refs[1]);
    expect(r?.etiltSnapped).toBe(true);
    expect(r?.etiltDeltaDeg).toBe(-1);
  });
  it('reports an exact match as not snapped', () => {
    const r = pickNearestPattern(refs, 1800, 8);
    expect(r?.ref).toEqual(refs[2]);
    expect(r?.etiltSnapped).toBe(false);
  });
  it('prefers the frequency before the tilt', () => {
    expect(pickNearestPattern(refs, 2500, 0)?.ref).toEqual(refs[3]);
  });
  it('returns undefined for an empty list', () => {
    expect(pickNearestPattern([], 1800, 0)).toBeUndefined();
  });
});
