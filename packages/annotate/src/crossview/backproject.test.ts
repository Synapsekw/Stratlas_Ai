import { existsSync, readFileSync } from 'node:fs';
import type { LensModel, Quat, Vec3 } from '@aio/schema';
import {
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from 'three';
import { describe, expect, it } from 'vitest';
import { backProject, backProjectOutline, geomCenter, GROUND_LAYER } from './backproject';

const pinhole: LensModel = { model: 'pinhole', hfovDeg: 90, aspect: 16 / 9 };
const size: [number, number] = [1280, 720];
const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

function floor(layerId: string, y = 0) {
  const group = new Group();
  group.userData.layerId = layerId;
  const mesh = new Mesh(new PlaneGeometry(100, 100), new MeshBasicMaterial({ side: DoubleSide }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  group.add(mesh);
  group.updateMatrixWorld(true);
  return { mesh, handle: { projectionReceivers: () => [mesh] } };
}

describe('geomCenter', () => {
  it('finds the centre of each image geometry', () => {
    expect(geomCenter({ type: 'box', x: 10, y: 20, w: 30, h: 40 })).toEqual([25, 40]);
    expect(geomCenter({ type: 'rotbox', x: 0, y: 0, w: 10, h: 10, angleDeg: 30 })).toEqual([5, 5]);
    expect(geomCenter({ type: 'point', x: 3, y: 4 })).toEqual([3, 4]);
    expect(
      geomCenter({
        type: 'polygon',
        points: [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
      }),
    ).toEqual([2, 2]);
    expect(geomCenter({ type: 'mask', src: { path: 'm.png' } })).toBeNull();
  });
});

describe('backProject', () => {
  const pose = { pos: [0, 10, 0] as Vec3, q: down };

  it('hits the mesh under the camera and names its layer', () => {
    const { handle } = floor('tank', 2);
    const s = backProject(pose, pinhole, [640, 360], size, handle);
    expect(s?.on).toBe('mesh');
    expect(s?.layer).toBe('tank');
    if (s?.geom.type !== 'spoint') throw new Error('expected a surface point');
    expect(s.geom.p[1]).toBeCloseTo(2, 6);
    expect(s.geom.n[1]).toBeCloseTo(1, 6);
  });

  it('falls back to the ground plane y = 0', () => {
    const s = backProject(pose, pinhole, [1280, 360], size, { projectionReceivers: () => [] });
    expect(s?.layer).toBe(GROUND_LAYER);
    if (s?.geom.type !== 'spoint') throw new Error('expected a surface point');
    expect(s.geom.p[0]).toBeCloseTo(10, 6);
    expect(s.geom.p[1]).toBeCloseTo(0, 6);
  });

  it('returns null for a ray into the sky', () => {
    const up = { pos: [0, 10, 0] as Vec3, q: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quat };
    expect(
      backProject(up, pinhole, [640, 360], size, { projectionReceivers: () => [] }),
    ).toBeNull();
  });

  it('back-projects an outline into a surface polygon', () => {
    const { handle } = floor('tank');
    const s = backProjectOutline(
      pose,
      pinhole,
      [
        [540, 260],
        [740, 260],
        [740, 460],
        [540, 460],
      ],
      size,
      handle,
    );
    expect(s?.geom.type).toBe('spolygon');
  });
});

const POSE = 'E:/Dev/AIO Software/docs/design/assets/hcl/clip_f108_roof_pose.json';

describe.skipIf(!existsSync(POSE))('HCl flight 108 roof clip (real pose)', () => {
  it('the frame centre lands on the tank bottom, inside the shell', () => {
    const json = JSON.parse(readFileSync(POSE, 'utf8')) as {
      samples: { t: number; pos: Vec3; q: Quat }[];
    };
    const sample = json.samples[json.samples.length - 1];
    if (!sample) throw new Error('no samples');
    // Tank: shell radius 2 m, 8.04 m high, bottom plate at y = 0.
    const shell = new Mesh(
      new CylinderGeometry(2, 2, 8.04, 64, 1, true),
      new MeshBasicMaterial({ side: DoubleSide }),
    );
    shell.position.y = 4.02;
    const bottom = new Mesh(new CircleGeometry(2, 64), new MeshBasicMaterial({ side: DoubleSide }));
    bottom.rotation.x = -Math.PI / 2;
    for (const m of [shell, bottom]) {
      m.userData.layerId = 'tank';
      m.updateMatrixWorld(true);
    }
    const lens: LensModel = { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 };
    const s = backProject(sample, lens, [640, 360], size, {
      projectionReceivers: () => [shell, bottom],
    });
    if (s?.geom.type !== 'spoint') throw new Error('expected a surface point');
    const [x, y, z] = s.geom.p;
    expect(Math.hypot(x, z)).toBeLessThan(2.01);
    expect(y).toBeGreaterThanOrEqual(-0.01);
    expect(y).toBeLessThan(sample.pos[1]);
  });
});
