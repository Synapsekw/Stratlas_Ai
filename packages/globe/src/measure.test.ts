import { describe, expect, it } from 'vitest';
import { formatArea, formatLength, geodesicDistance, pathLength, polygonArea } from './measure';

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
    expect(formatLength(1234.5)).toBe('1.23 km');
    expect(formatLength(850.2)).toBe('850 m');
    expect(formatArea(32_000)).toBe('3.20 ha');
    expect(formatArea(1_750_000)).toBe('1.75 km²');
  });
});
