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

/** Synthetic face geometry: s along the face, h up, d out of the face (all metres). */
function onFace(
  bearingDeg: number,
  picks: readonly (readonly [number, number, number])[],
  origin: SitePoint = [0, 0, 0],
): SitePoint[] {
  const r = (bearingDeg * Math.PI) / 180;
  const f = [Math.sin(r), Math.cos(r)] as const;
  const t = [Math.cos(r), -Math.sin(r)] as const;
  return picks.map(([s, h, d]) => [
    origin[0] + s * t[0] + d * f[0],
    origin[1] + s * t[1] + d * f[1],
    origin[2] + h,
  ]);
}

/** Horizontal part of (b - a) x (c - a), the facing the tool used before plan fitting. */
function legacyHorizontal([a, b, c]: readonly SitePoint[]): [number, number] {
  if (!a || !b || !c) throw new Error('three picks');
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [
    (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
    (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
  ];
}

/** Orders the picks so the legacy facing points out of the face, as a user's Flip would. */
function facing(points: SitePoint[], bearingDeg: number): SitePoint[] {
  const r = (bearingDeg * Math.PI) / 180;
  const [nx, ny] = legacyHorizontal(points);
  return nx * Math.sin(r) + ny * Math.cos(r) >= 0 ? points : flipFace(points);
}

const gap = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Three picks along a level top edge, each off by up to 2 mm in E, N and Z. */
function edgePicks(seed: number, origin: SitePoint = [0, 0, 0]): SitePoint[] {
  const next = rng(seed);
  const mm = () => (next() * 2 - 1) * 0.002;
  return onFace(
    170,
    [-0.45, 0, 0.45].map((s) => [s, 12, 0] as const),
    origin,
  ).map(([e, n, z]) => [e + mm(), n + mm(), z + mm()]);
}

/** Two bottom corners and one top point of an upright face, the classic triangle. */
const triangle = (origin: SitePoint = [0, 0, 0]) =>
  facing(
    onFace(
      170,
      [
        [-0.25, 10, 0],
        [0.25, 10, 0],
        [0.1, 11.4, 0],
      ],
      origin,
    ),
    170,
  );

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

describe('azimuth from picks along a face edge', () => {
  it('reads the face bearing from near-level picks with millimetre noise', () => {
    for (const seed of SEEDS) {
      const result = antennaAzimuth(facing(edgePicks(seed), 170));
      if (!result.ok) throw new Error(`seed ${seed}: ${result.message}`);
      expect(gap(result.bearingDeg, 170), `seed ${seed}`).toBeLessThan(0.3);
      const r = (result.bearingDeg * Math.PI) / 180;
      expect(result.direction[0]).toBeCloseTo(Math.sin(r), 12);
      expect(result.direction[1]).toBeCloseTo(Math.cos(r), 12);
      expect(result.direction[2]).toBe(0);
    }
  });

  it('keeps the bearing of classic triangle picks on an upright face', () => {
    const result = antennaAzimuth(triangle());
    const [nx, ny] = legacyHorizontal(triangle());
    const legacy = ((((Math.atan2(nx, ny) * 180) / Math.PI) % 360) + 360) % 360;
    expect(result.ok && gap(result.bearingDeg, legacy)).toBeLessThan(0.1);
    expect(result.ok && gap(result.bearingDeg, 170)).toBeLessThan(0.1);
  });

  it('turns the bearing by exactly 180 degrees on flip', () => {
    for (const points of [triangle(), ...SEEDS.map((s) => edgePicks(s))]) {
      const before = antennaAzimuth(points);
      const after = antennaAzimuth(flipFace(points));
      if (!before.ok || !after.ok) throw new Error('expected a bearing');
      expect(gap(after.bearingDeg, before.bearingDeg + 180)).toBeLessThan(1e-9);
    }
  });

  it('turns exactly collinear level picks on flip too', () => {
    const level: SitePoint[] = [
      [0, 0, 5],
      [1, 0, 5],
      [2, 0, 5],
    ];
    const a = antennaAzimuth(level);
    const b = antennaAzimuth(flipFace(level));
    expect(a).toMatchObject({ ok: true, bearingDeg: 180 });
    expect(b).toMatchObject({ ok: true, bearingDeg: 0 });
    // A sloped line on an upright face has the same plan trace (rejected before plan fitting).
    const sloped: SitePoint[] = [
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 2],
    ];
    expect(antennaAzimuth(sloped)).toMatchObject({ ok: true, bearingDeg: 180 });
    expect(antennaAzimuth(flipFace(sloped))).toMatchObject({ ok: true, bearingDeg: 0 });
    const nearly: SitePoint[] = [
      [0, 0, 0],
      [1, 0, 1],
      [2, 1e-9, 2],
    ];
    const n = antennaAzimuth(nearly);
    const f = antennaAzimuth(flipFace(nearly));
    if (!n.ok || !f.ok) throw new Error('expected a bearing');
    expect(gap(n.bearingDeg, 0) < 1e-6 || gap(n.bearingDeg, 180) < 1e-6).toBe(true);
    expect(gap(f.bearingDeg, n.bearingDeg + 180)).toBeLessThan(1e-9);
  });

  it('uses the face plane for picks that spread across a tilted face', () => {
    // 10 degree downtilt: the top leans back, and one top corner breaks plan symmetry.
    const back = Math.tan((10 * Math.PI) / 180);
    const points = facing(
      onFace(120, [
        [-0.25, 0, 0],
        [0.25, 0, 0],
        [0.25, 1.4, -1.4 * back],
      ]),
      120,
    );
    const result = antennaAzimuth(points);
    expect(result.ok && gap(result.bearingDeg, 120)).toBeLessThan(1e-9);
  });

  it('does not report a bearing for picks stacked vertically', () => {
    const next = rng(7);
    for (let i = 0; i < 20; i++) {
      const cm = () => (next() * 2 - 1) * 0.005;
      const points: SitePoint[] = [0, 1, 2].map((z) => [3 + cm(), 4 + cm(), z]);
      const result = antennaAzimuth(points);
      if (result.ok) expect(Number.isFinite(result.bearingDeg)).toBe(true);
      else expect(result.message).toMatch(/spread/i);
    }
  });

  it('gives the same bearings at large grid coordinates', () => {
    const far: SitePoint = [265000.37, 2680000.81, 40];
    for (const seed of SEEDS.slice(0, 10)) {
      const near = antennaAzimuth(edgePicks(seed));
      const there = antennaAzimuth(edgePicks(seed, far));
      if (!near.ok || !there.ok) throw new Error('expected a bearing');
      expect(gap(there.bearingDeg, near.bearingDeg)).toBeLessThan(1e-4);
    }
    const t = antennaAzimuth(triangle(far));
    expect(t.ok && gap(t.bearingDeg, 170)).toBeLessThan(1e-4);
    if (t.ok) expect(Math.hypot(t.center[0] - far[0], t.center[1] - far[1])).toBeLessThan(0.3);
  });
});

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
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 1],
      [0, 0, 2],
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
