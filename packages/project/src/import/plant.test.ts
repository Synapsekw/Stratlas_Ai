import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@aio/schema';
import { fitSimilarity2D } from './fit';
import { invertFrame, mapPoint, meshTransform, applyMat4 } from './frames';
import { cameraForward } from './flight';
import { mapQuat } from './frames';
import {
  djiLocalToUtcMs,
  plantCameraQuat,
  plantFrame,
  plantToScene,
  plantVideoToFlight,
} from './plant';

/** Plant grid to UTM 39N pairs from plant.glb node extras (20-T-0001 platforms and two more). */
const PAIRS = [
  { src: [1325.65, 531.69], dst: [245763.16, 3179611.74] },
  { src: [1293.61, 588.14], dst: [245750.13, 3179675.32] },
] as const;

const alpha = (17.9991 * Math.PI) / 180;
const toUtm = (e: number, n: number): [number, number] => [
  e * Math.cos(alpha) + n * Math.sin(alpha) + 244338.089,
  -e * Math.sin(alpha) + n * Math.cos(alpha) + 3179515.6899,
];

describe('plant frame to local frame', () => {
  const pts: [number, number][] = [
    [0, 0],
    [1300, 450],
    [2620, 1080],
    [-60, 20],
  ];
  const fit = fitSimilarity2D(pts.map(([e, n]) => ({ src: [e, n], dst: toUtm(e, n) })));
  const origin: Vec3 = [245714, 3179542, 100];
  const f = plantFrame(fit, origin);

  it('puts a plant point at its UTM position relative to the origin', () => {
    for (const p of PAIRS) {
      const local = mapPoint(f, plantToScene(p.src[0], p.src[1], 110));
      // E = origin E + x, N = origin N - z, H = origin H + y
      expect(origin[0] + local[0]).toBeCloseTo(p.dst[0], 1);
      expect(origin[1] - local[2]).toBeCloseTo(p.dst[1], 1);
      expect(origin[2] + local[1]).toBeCloseTo(110, 9);
    }
  });

  it('bakes the same map into the mesh transform and round-trips', () => {
    const s = plantToScene(1500, 460, 130);
    const a = applyMat4(meshTransform(f), s);
    const b = mapPoint(f, s);
    a.forEach((v, i) => {
      expect(v).toBeCloseTo(b[i] ?? NaN, 9);
    });
    const back = mapPoint(invertFrame(f), b);
    back.forEach((v, i) => {
      expect(v).toBeCloseTo(s[i] ?? NaN, 9);
    });
  });

  it('turns a camera at plant azimuth 90 to grid azimuth 108 (plant north is 18 deg east of grid north)', () => {
    const fwd = cameraForward(mapQuat(f, plantCameraQuat(90, 0)));
    const gridAz = (Math.atan2(fwd[0], -fwd[2]) * 180) / Math.PI;
    expect(gridAz).toBeCloseTo(107.9991, 3);
    const down = cameraForward(plantCameraQuat(0, -90));
    expect(down[1]).toBeCloseTo(-1, 9);
  });

  it('converts a clip track to an aio.flight/1 document', () => {
    const doc = plantVideoToFlight(
      {
        flight: 4,
        created: '2023-02-21T15:11:11.000000Z',
        dur: 1,
        hz: 10,
        track: [
          [1094.5, 456.24, 203.87, 87.95, -25.3, 0, 0],
          [1094.6, 456.24, 203.87, 87.95, -25.3, 0, 0],
        ],
      },
      f,
      djiLocalToUtcMs('2023-02-21T15:11:11.000000Z'),
      { model: 'pinhole', hfovDeg: 83, aspect: 1.7778 },
    );
    expect(doc.startUtcMs).toBe(Date.UTC(2023, 1, 21, 12, 11, 11));
    expect(doc.samples.map((s) => s.t)).toEqual([0, 100]);
    const fwd = cameraForward(doc.samples[0]?.q ?? [0, 0, 0, 1]);
    expect((Math.asin(fwd[1]) * 180) / Math.PI).toBeCloseTo(-25.3, 3);
  });
});
