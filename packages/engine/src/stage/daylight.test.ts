import { describe, expect, it } from 'vitest';
import { airMass, daylight, horizonRadiance, skyRadiance } from './daylight';
import { skyDirection } from './solar';

const at = (el: number, az = 180) => daylight(skyDirection(az, el), el);
const lum = (c: readonly number[]) =>
  0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);

describe('daylight', () => {
  it('leaves daylight imagery as photographed around midday', () => {
    const d = at(50);
    expect(d.night).toBe(0);
    expect(d.moon).toBe(false);
    expect(lum(d.groundLit)).toBeGreaterThan(0.85);
    expect(lum(d.groundLit)).toBeLessThan(1.15);
    // shadowed ground keeps sky light: darker, never black
    expect(lum(d.groundShade)).toBeGreaterThan(0.2);
    expect(lum(d.groundShade)).toBeLessThan(0.6);
    expect(d.exposure).toBeCloseTo(1, 1);
  });

  it('reddens and dims the sun toward the horizon', () => {
    const noon = at(60);
    const low = at(3);
    expect(low.lightIntensity).toBeLessThan(noon.lightIntensity);
    expect(low.lightColour[0]).toBe(1);
    expect(low.lightColour[2]).toBeLessThan(0.35);
    expect(noon.lightColour[2]).toBeGreaterThan(0.7);
  });

  it('falls back to a dim moon at night, not black', () => {
    const d = at(-30);
    expect(d.night).toBe(1);
    expect(d.moon).toBe(true);
    expect(d.lightIntensity).toBeGreaterThan(0);
    expect(lum(d.groundLit)).toBeGreaterThan(0.06);
    expect(lum(d.groundLit)).toBeLessThan(0.45);
    expect(d.exposure).toBeGreaterThan(1.5);
    expect(lum(d.nightSky)).toBeGreaterThan(0);
  });

  it('changes smoothly through dusk', () => {
    let prev = at(10);
    for (let el = 9; el >= -18; el--) {
      const d = at(el);
      expect(lum(d.groundLit)).toBeLessThanOrEqual(lum(prev.groundLit) * 1.25 + 0.02);
      expect(Math.abs(d.exposure - prev.exposure)).toBeLessThan(0.6);
      prev = d;
    }
  });
});

describe('sky model', () => {
  it('is bluer overhead than at the horizon at midday', () => {
    const sun = skyDirection(180, 60);
    const up = skyRadiance([0, 1, 0], sun);
    const hz = horizonRadiance(sun);
    expect(up[2] / up[0]).toBeGreaterThan(hz[2] / hz[0]);
  });
  it('has an air mass of 1 overhead and about 38 at the horizon', () => {
    expect(airMass(90)).toBeCloseTo(1, 2);
    expect(airMass(0)).toBeGreaterThan(30);
  });
});
