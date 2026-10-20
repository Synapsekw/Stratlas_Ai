import { describe, expect, it } from 'vitest';
import {
  areaWords,
  geodesicDistance,
  globeReading,
  lengthWords,
  pathLength,
  polygonArea,
} from './measure';

const dms = (d: number, m: number, s: number) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600);

describe('the geodesic read-out (on the ellipsoid)', () => {
  it("matches Vincenty's test line (Flinders Peak to Buninyong) to the millimetre", () => {
    const d = geodesicDistance(
      dms(144, 25, 29.5244),
      dms(-37, 57, 3.7203),
      dms(143, 55, 35.3839),
      dms(-37, 39, 10.1561),
    );
    expect(d).toBeCloseTo(54972.271, 3);
    expect(geodesicDistance(10, 10, 10, 10)).toBe(0);
    expect(
      pathLength([
        [0, 0],
        [0, 1],
        [0, 2],
      ]),
    ).toBeCloseTo(geodesicDistance(0, 0, 0, 1) + geodesicDistance(0, 1, 0, 2), 6);
  });

  it('measures the area of a square kilometre and words the read-out', () => {
    const [lon, lat] = [53.5, 29.3];
    const dLat = 1000 / 110_850;
    const dLon = 1000 / (111_320 * Math.cos((lat * Math.PI) / 180));
    const sq: [number, number][] = [
      [lon, lat],
      [lon + dLon, lat],
      [lon + dLon, lat + dLat],
      [lon, lat + dLat],
    ];
    const side = geodesicDistance(lon, lat, lon + dLon, lat);
    const up = geodesicDistance(lon, lat, lon, lat + dLat);
    expect(polygonArea(sq) / (side * up)).toBeCloseTo(1, 3);
    expect(polygonArea(sq.slice(0, 2))).toBe(0);
  });

  it('words a length by size: metres below 1000 m, else kilometres', () => {
    const along = (m: number): [number, number][] => [
      [0, 0],
      [0, m / 110_574],
    ];
    expect(globeReading(along(5)).primary).toBe('5.00 m');
    expect(globeReading(along(850)).primary).toBe('850 m');
    expect(globeReading(along(1500)).primary).toBe('1.50 km');
    expect(globeReading(along(250_000)).primary).toBe('250 km');
    expect(globeReading(along(850)).secondary).toBe('');
  });

  it('words an area by size: m2 below 1 ha, ha below 1 km2, else km2', () => {
    const square = (side: number): [number, number][] => {
      const d = side / 110_574;
      return [
        [0, 0],
        [d, 0],
        [d, d],
        [0, d],
      ];
    };
    expect(globeReading(square(50)).secondary).toMatch(/^2\D?5\d\d m²$/);
    expect(globeReading(square(300)).secondary).toMatch(/^9\.\d\d ha$/);
    expect(globeReading(square(1000)).secondary).toMatch(/^1\.\d\d km²$/);
  });

  it('switches unit exactly at each boundary', () => {
    expect(lengthWords(999)).toBe('999 m');
    expect(lengthWords(1000)).toBe('1.00 km');
    expect(areaWords(9999)).toMatch(/^9\D?999 m²$/);
    expect(areaWords(10_000)).toBe('1.00 ha');
    expect(areaWords(999_999)).toBe('100.00 ha');
    expect(areaWords(1_000_000)).toBe('1.00 km²');
  });
});
