import type { Issue, Layer, Quat, Sighting } from '@aio/schema';
import { Object3D, type Intersection, type Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { makeIssue } from '../testing';
import type { CameraSources } from './camera';
import {
  placeCandidates,
  placeOnLayer,
  selectionName,
  selectionSighting,
  type CloudPlaceOps,
  type PlaceScene,
} from './place';

const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const lens = { model: 'pinhole' as const, hfovDeg: 90, aspect: 4 / 3 };
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const photos: Layer = {
  kind: 'photos',
  id: 'photos',
  name: 'Photos',
  visible: true,
  items: [
    { id: 'F01', src: { path: 'p/F01.jpg' }, pos: [3, 10, 4], q: down, lens },
    { id: 'F02', src: { path: 'p/F02.jpg' }, pos: [3, 10, 4], q: down, lens },
    { id: 'nopose', src: { path: 'p/x.jpg' } },
  ],
};
const mesh: Layer = {
  kind: 'mesh',
  id: 'site',
  name: 'Site',
  visible: true,
  src: { path: 'm.glb' },
  transform: I,
};
const cloud: Layer = {
  kind: 'pointcloud',
  id: 'cloud',
  name: 'Cloud',
  visible: true,
  src: { path: 'c.json' },
  format: 'png-packed',
};
const src: CameraSources = {
  layers: () => [photos, mesh, cloud],
  flight: () => null,
  imageSize: () => [1200, 900],
};
// 1200 px across 20 m at 10 m: 60 px a metre; the image centre (600, 450) sees (3, 0, 4)
const box = (photo: string, x: number, y: number, w: number, h: number): Sighting => ({
  on: 'image',
  layer: 'photos',
  photo,
  geom: { type: 'box', x, y, w, h },
});

/** The ground y = 0 as the given layer; `hole` drops hits, `far` pushes hits 20 m deeper. */
function plane(
  layer: string,
  opts: {
    hole?: (p: Vector3) => boolean;
    far?: (p: Vector3) => boolean;
    cloud?: CloudPlaceOps;
  } = {},
): PlaceScene {
  return {
    raycastRay: (o, d, r): Intersection | null => {
      if (r?.layer !== layer || d.y >= 0) return null;
      const t = -o.y / d.y;
      const p = o.clone().addScaledVector(d, t);
      if (opts.hole?.(p)) return null;
      const extra = opts.far?.(p) ? 20 : 0;
      return {
        distance: t + extra,
        point: o.clone().addScaledVector(d, t + extra),
        object: new Object3D(),
      };
    },
    rayLayers: () => new Set([layer]),
    ...(opts.cloud ? { cloud: opts.cloud } : {}),
  };
}

const issueWith = (...sightings: Sighting[]): Issue => makeIssue({ sightings });

describe('placeOnLayer on a mesh', () => {
  it('lays the densified outline on the surface, marked with the photo it came from', async () => {
    const r = await placeOnLayer(
      issueWith(box('F01', 500, 400, 200, 100)),
      mesh,
      plane('site'),
      src,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.from).toBe(0);
    expect(r.hitRate).toBe(1);
    const s = r.sightings[0];
    if (s?.on !== 'mesh' || s.geom.type !== 'spolygon') throw new Error('expected an outline');
    expect(s).toMatchObject({ layer: 'site', from: { sighting: 0 } });
    expect(s.geom.points).toHaveLength(25 + 13 + 25 + 13);
    for (const p of s.geom.points) {
      expect(p[1]).toBeCloseTo(0, 6);
      expect(p[0]).toBeGreaterThan(3 - 100 / 60 - 1e-6);
      expect(p[0]).toBeLessThan(3 + 100 / 60 + 1e-6);
    }
  });

  it('drops misses but needs 60 % of the samples on the model', async () => {
    // x > 4 m is a hole: 180 of 480 outline pixels miss (hit rate 0.625)
    const hole = (p: Vector3) => p.x > 4;
    const ok = await placeOnLayer(
      issueWith(box('F01', 540, 420, 180, 60)),
      mesh,
      plane('site', { hole }),
      src,
    );
    expect(ok.ok && ok.hitRate).toBeGreaterThanOrEqual(0.6);
    expect(ok.ok && ok.hitRate).toBeLessThan(0.7);
    // x > 3.2 m: most of it misses
    const most = (p: Vector3) => p.x > 3.2;
    expect(
      await placeOnLayer(
        issueWith(box('F01', 540, 420, 180, 60)),
        mesh,
        plane('site', { hole: most }),
        src,
      ),
    ).toEqual({ ok: false, reason: 'missed' });
  });

  it('takes the shape with the best hit rate, then the larger one', async () => {
    const hole = (p: Vector3) => p.x > 4;
    const big = box('F01', 540, 420, 180, 60); // hit rate 0.625
    const small = box('F02', 570, 420, 60, 60); // all of it on the model
    const r = await placeOnLayer(issueWith(big, small), mesh, plane('site', { hole }), src);
    expect(r.ok && r.from).toBe(1);
    const larger = box('F02', 520, 400, 120, 100);
    const tie = await placeOnLayer(issueWith(small, larger), mesh, plane('site'), src);
    expect(tie.ok && tie.from).toBe(1);
  });

  it('says why it could not place', async () => {
    const point: Sighting = {
      on: 'image',
      layer: 'photos',
      photo: 'F01',
      geom: { type: 'point', x: 1, y: 1 },
    };
    expect(await placeOnLayer(issueWith(point), mesh, plane('site'), src)).toEqual({
      ok: false,
      reason: 'no-photo-shape',
    });
    expect(
      await placeOnLayer(issueWith(box('nopose', 0, 0, 10, 10)), mesh, plane('site'), src),
    ).toEqual({
      ok: false,
      reason: 'no-photo-shape',
    });
    expect(
      await placeOnLayer(issueWith(box('F01', 500, 400, 200, 100)), mesh, plane('other'), src),
    ).toEqual({
      ok: false,
      reason: 'layer-not-loaded',
    });
    expect(
      placeCandidates(issueWith(point, box('F01', 0, 0, 8, 8)), src).map((c) => c.index),
    ).toEqual([1]);
  });
});

describe('placeOnLayer on a point cloud', () => {
  const ops = (positions = new Float32Array([3, 0, 4, 3.1, 0, 4.1])) => {
    const release = vi.fn();
    const refineAround = vi.fn<CloudPlaceOps['refineAround']>(() =>
      Promise.resolve({ depth: 5, release }),
    );
    const pointsInPrism = vi.fn<CloudPlaceOps['pointsInPrism']>(() => positions);
    const cloudOps: CloudPlaceOps = { refineAround, pointsInPrism };
    return { cloudOps, release, refineAround, pointsInPrism };
  };

  it('builds the prism from the hits, rejects what was seen through a gap, and cuts the selection', async () => {
    const { cloudOps, release, refineAround, pointsInPrism } = ops();
    // beyond x = 4 m the rays pass a gap and hit 20 m deeper
    const far = (p: Vector3) => p.x > 4;
    const r = await placeOnLayer(
      issueWith(box('F01', 540, 420, 180, 60)),
      cloud,
      plane('cloud', { far, cloud: cloudOps }),
      src,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.hitRate).toBe(1);
    const s = r.sightings[0];
    if (s?.on !== 'pointcloud' || s.geom.type !== 'polygon3') throw new Error('expected a prism');
    expect(s.from).toEqual({ sighting: 0 });
    expect(s.geom.height).toBeCloseTo(0.1, 9); // flat ground: the minimum height
    for (const p of s.geom.points) {
      expect(p[1]).toBeCloseTo(0, 6);
      expect(p[0]).toBeLessThanOrEqual(4 + 1e-6);
    }
    expect(r.selection).toMatchObject({ count: 2, lod: 5 });
    expect(refineAround).toHaveBeenCalledTimes(1);
    expect(refineAround.mock.calls[0]?.[0].eye).toEqual([3, 10, 4]);
    expect(refineAround.mock.calls[0]?.[1]).toBe(3000);
    expect(pointsInPrism).toHaveBeenCalledTimes(1);
    const [prismLayer, prism] = pointsInPrism.mock.calls[0] ?? [];
    expect(prismLayer).toBe('cloud');
    expect(prism?.minY).toBeCloseTo(0, 6);
    expect(prism?.maxY).toBeCloseTo(0.1, 6);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('needs 60 % of the grid rays to hit, and always hands the detail back', async () => {
    const { cloudOps, release } = ops();
    const hole = (p: Vector3) => p.x > 2.9;
    expect(
      await placeOnLayer(
        issueWith(box('F01', 540, 420, 180, 60)),
        cloud,
        plane('cloud', { hole, cloud: cloudOps }),
        src,
      ),
    ).toEqual({ ok: false, reason: 'missed' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('leaves the selection out when no loaded point is inside', async () => {
    const { cloudOps } = ops(new Float32Array(0));
    const r = await placeOnLayer(
      issueWith(box('F01', 500, 400, 200, 100)),
      cloud,
      plane('cloud', { cloud: cloudOps }),
      src,
    );
    expect(r.ok && r.selection).toBeUndefined();
  });

  it('is not loaded without the cloud operations', async () => {
    expect(
      await placeOnLayer(issueWith(box('F01', 500, 400, 200, 100)), cloud, plane('cloud'), src),
    ).toEqual({
      ok: false,
      reason: 'layer-not-loaded',
    });
  });
});

describe('selection sightings', () => {
  it('names the file after the issue and layer, and writes count and lod', () => {
    expect(selectionName('3f2a-b', 'cloud d2')).toBe('3f2a-b-cloud-d2');
    expect(
      selectionSighting(
        'cloud',
        { path: 'selections/x.sel' },
        { positions: new Float32Array(6), count: 2, lod: 4 },
        0,
      ),
    ).toEqual({
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'selection', src: { path: 'selections/x.sel' }, count: 2, lod: 4 },
      from: { sighting: 0 },
    });
  });
});
