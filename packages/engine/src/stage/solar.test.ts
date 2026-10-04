import { describe, expect, it } from 'vitest';
import { skyDirection, solarPosition, utcOffsetHours } from './solar';

const KUWAIT_CITY = { lat: 29.3759, lon: 47.9774 };

describe('solarPosition', () => {
  it('matches the NREL SPA reference case (Golden, Colorado, 17 Oct 2003 12:30:30 MST)', () => {
    // Reda and Andreas, Solar Position Algorithm for Solar Radiation Applications (2008), table A5.1:
    // topocentric zenith 50.11162 deg, azimuth 194.34024 deg
    const p = solarPosition(Date.UTC(2003, 9, 17, 19, 30, 30), 39.742476, -105.1786);
    expect(p.azimuthDeg).toBeCloseTo(194.34, 1);
    expect(90 - p.elevationDeg).toBeCloseTo(50.11, 1);
  });

  it('puts the June solstice noon sun at 90 - (latitude - 23.44) over Kuwait City', () => {
    let best = { t: 0, el: -90, az: 0 };
    for (let min = 7 * 60; min < 11 * 60; min++) {
      const t = Date.UTC(2023, 5, 21) + min * 60_000;
      const p = solarPosition(t, KUWAIT_CITY.lat, KUWAIT_CITY.lon);
      if (p.elevationDeg > best.el) best = { t, el: p.elevationDeg, az: p.azimuthDeg };
    }
    expect(best.el).toBeGreaterThan(83.95);
    expect(best.el).toBeLessThan(84.15);
    // solar noon is about 08:50 UTC (11:50 Kuwait time)
    const noon = new Date(best.t);
    expect(noon.getUTCHours() * 60 + noon.getUTCMinutes()).toBeGreaterThanOrEqual(8 * 60 + 47);
    expect(noon.getUTCHours() * 60 + noon.getUTCMinutes()).toBeLessThanOrEqual(8 * 60 + 53);
  });

  it('rises due east at the March equinox', () => {
    let rise = null as { az: number; min: number } | null;
    for (let min = 0; min < 6 * 60 && !rise; min++) {
      const p = solarPosition(
        Date.UTC(2023, 2, 20) + min * 60_000,
        KUWAIT_CITY.lat,
        KUWAIT_CITY.lon,
      );
      if (p.elevationDeg > -0.833) rise = { az: p.azimuthDeg, min };
    }
    expect(rise).not.toBeNull();
    expect(rise?.az).toBeGreaterThan(88);
    expect(rise?.az).toBeLessThan(91);
    // solar noon 08:56 UTC (longitude 47.98 E, equation of time -7.6 min) less half a day of
    // 6 h 04 min (12 h plus refraction and the solar disc): 02:52 UTC, 05:52 Kuwait time
    expect(Math.abs((rise?.min ?? 0) - (2 * 60 + 52))).toBeLessThanOrEqual(2);
  });

  it('places the Al-Zour survey afternoon sun in the south-south-west', () => {
    // 21 Feb 2023 13:22 Kuwait time, the start of the first drone flight
    const p = solarPosition(Date.UTC(2023, 1, 21, 10, 22), 28.73, 48.38);
    // solar noon 09:00 UTC, so 82 minutes after noon at declination -10.7 deg: about 46 deg up
    expect(p.elevationDeg).toBeGreaterThan(45);
    expect(p.elevationDeg).toBeLessThan(47);
    expect(p.azimuthDeg).toBeGreaterThan(200);
    expect(p.azimuthDeg).toBeLessThan(225);
  });

  it('is below the horizon at midnight', () => {
    const p = solarPosition(Date.UTC(2023, 1, 21, 21, 0), KUWAIT_CITY.lat, KUWAIT_CITY.lon);
    expect(p.elevationDeg).toBeLessThan(-40);
  });
});

describe('skyDirection', () => {
  const close = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i] ?? 0, 6);
  };
  it('maps compass bearings to the local frame (x east, y up, z south)', () => {
    close(skyDirection(0, 0), [0, 0, -1]);
    close(skyDirection(90, 0), [1, 0, 0]);
    close(skyDirection(180, 0), [0, 0, 1]);
    close(skyDirection(0, 90), [0, 1, 0]);
  });
  it('turns true bearings into grid bearings with the convergence', () => {
    // grid north 2 deg east of true north: a true bearing of 2 deg is grid north
    close(skyDirection(2, 0, 2), [0, 0, -1]);
  });
});

describe('utcOffsetHours', () => {
  it('rounds the longitude to whole hours', () => {
    expect(utcOffsetHours(47.98)).toBe(3);
    expect(utcOffsetHours(55.9)).toBe(4);
    expect(utcOffsetHours(-105.2)).toBe(-7);
  });
});
