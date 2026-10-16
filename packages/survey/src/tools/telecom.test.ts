import { describe, expect, it } from 'vitest';
import { MeasurementTool, MeasurementsFile, type SitePoint } from '@aio/schema';
import { measurementFrom } from '../templates/model';
import { measurementReadout } from './readout';
import { antennaAzimuth, antennaTilt, clearance, flipFace } from './telecom';

const north: SitePoint[] = [
  [0, 0, 0],
  [0, 0, 2],
  [2, 0, 0],
];

describe('telecom measurements in ENZ coordinates', () => {
  it.each([
    { points: north, bearing: 0 },
    {
      points: [
        [0, 0, 0],
        [0, 2, 0],
        [0, 0, 2],
      ] as SitePoint[],
      bearing: 90,
    },
    {
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 0, 2],
      ] as SitePoint[],
      bearing: 180,
    },
    {
      points: [
        [0, 0, 0],
        [0, 0, 2],
        [0, 2, 0],
      ] as SitePoint[],
      bearing: 270,
    },
  ])('computes clockwise azimuth $bearing from north', ({ points, bearing }) => {
    expect(antennaAzimuth(points)).toMatchObject({ ok: true, bearingDeg: bearing });
  });

  it('flips the facing direction using saved vertex order', () => {
    const m = measurementFrom('azimuth', {
      id: 'face',
      label: 'Face',
      points: flipFace(north),
      scope: { kind: 'site' },
      createdAt: '2026-10-16T00:00:00Z',
    });
    const reopened = MeasurementsFile.parse(
      JSON.parse(
        JSON.stringify({
          schema: 'aio.measurements/1',
          measurements: [m],
        }),
      ),
    ).measurements[0];
    expect(reopened && measurementReadout(reopened)[0]).toMatchObject({ value: 180 });
    expect(flipFace(flipFace(north))).toEqual(north);
  });

  it('projects a tilted face normal horizontally rather than using an edge bearing', () => {
    const result = antennaAzimuth([
      [0, 0, 0],
      [0, 0, 2],
      [2, -2, 1],
    ]);
    expect(result).toMatchObject({ ok: true, bearingDeg: 45 });
    if (result.ok) {
      expect(result.direction[0]).toBeCloseTo(Math.SQRT1_2, 12);
      expect(result.direction[1]).toBeCloseTo(Math.SQRT1_2, 12);
      expect(result.direction[2]).toBe(0);
    }
  });

  it.each([
    [
      [0, 0, 0],
      [0, 0, 0],
      [2, 0, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 2],
    ],
    [
      [0, 0, 0],
      [1, 0, 1],
      [2, 1e-9, 2],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
  ] as SitePoint[][])('rejects an indeterminate face with useful feedback (%j)', (...points) => {
    const result = antennaAzimuth(points);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(20);
  });

  it('preserves small relative dimensions at large project coordinates', () => {
    expect(
      antennaAzimuth(north.map(([e, n, z]) => [e + 500000, n + 7000000, z + 1000])),
    ).toMatchObject({ ok: true, bearingDeg: 0 });
  });

  it.each([
    {
      points: [
        [1, 2, 10],
        [1, 2, 20],
      ] as SitePoint[],
      angle: 0,
    },
    {
      points: [
        [0, 0, 0],
        [1, 0, 1],
      ] as SitePoint[],
      angle: 45,
    },
    {
      points: [
        [0, 0, 0],
        [3, 4, 0],
      ] as SitePoint[],
      angle: 90,
    },
  ])('computes unsigned inclination $angle from project vertical', ({ points, angle }) => {
    expect(antennaTilt(points)).toMatchObject({ ok: true, angleDeg: angle });
    expect(antennaTilt([...points].reverse())).toMatchObject({ ok: true, angleDeg: angle });
  });

  it('reports direct, horizontal and absolute vertical gap in either click order', () => {
    const points: SitePoint[] = [
      [500000, 7000000, 100],
      [500003, 7000000, 104],
    ];
    for (const pts of [points, [...points].reverse()]) {
      expect(clearance(pts)).toEqual({ ok: true, directM: 5, horizontalM: 3, verticalM: 4 });
      expect(measurementReadout({ tool: 'clearance', points: pts }).map((r) => r.value)).toEqual([
        5, 3, 4,
      ]);
    }
    expect(
      clearance([
        [0, 0, 10],
        [0, 0, 20],
      ]),
    ).toMatchObject({ directM: 10, horizontalM: 0, verticalM: 10 });
  });

  it('rejects coincident endpoints instead of reporting zero inclination or gap', () => {
    const pts: SitePoint[] = [
      [1, 2, 3],
      [1, 2, 3],
    ];
    expect(antennaTilt(pts).ok).toBe(false);
    expect(clearance(pts).ok).toBe(false);
    expect(measurementReadout({ tool: 'antenna-tilt', points: pts })[0]).toMatchObject({
      value: null,
    });
  });

  it('accepts all three new tool identifiers in the existing schema', () => {
    for (const tool of ['azimuth', 'antenna-tilt', 'clearance']) {
      expect(MeasurementTool.safeParse(tool).success).toBe(true);
    }
  });
});
