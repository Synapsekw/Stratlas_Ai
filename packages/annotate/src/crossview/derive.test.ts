import type { Layer, PoseSample, Quat, Sighting } from '@aio/schema';
import { DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { makeIssue, meshSighting, photoSighting } from '../testing';
import { createDeriver } from './derive';

const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const floor = new Mesh(new PlaneGeometry(100, 100), new MeshBasicMaterial({ side: DoubleSide }));
floor.rotation.x = -Math.PI / 2;
floor.userData.layerId = 'site';
floor.updateMatrixWorld(true);
const scene = { projectionReceivers: () => [floor] };

const layers: Layer[] = [
  {
    kind: 'photos',
    id: 'photos',
    name: 'Photos',
    visible: true,
    items: [
      {
        id: 'F01',
        src: { path: 'photos/F01.jpg' },
        pos: [3, 10, 4],
        q: down,
        lens: { model: 'pinhole', hfovDeg: 90, aspect: 4 / 3 },
      },
      { id: 'nopose', src: { path: 'photos/x.jpg' } },
    ],
  },
  {
    kind: 'video',
    id: 'f108',
    name: 'Flight',
    visible: true,
    src: { path: 'video/a.mp4' },
    flight: { src: { path: 'flights/a.json' }, startUtcMs: 0 },
    lens: { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 },
    offsetMs: 1000,
  },
];

const samples: PoseSample[] = [
  { t: 0, pos: [0, 10, 0], q: down },
  { t: 10_000, pos: [10, 10, 0], q: down },
];

function deriver() {
  return createDeriver({
    layers: () => layers,
    scene: () => scene,
    flight: (id) => (id === 'f108' ? samples : null),
    imageSize: (layer, photo) => (layer === 'photos' && photo === 'F01' ? [1200, 900] : null),
  });
}

describe('createDeriver', () => {
  it('back-projects a photo sighting through the photo pose', () => {
    const s: Sighting = {
      on: 'image',
      layer: 'photos',
      photo: 'F01',
      geom: { type: 'point', x: 600, y: 450 },
    };
    const out = deriver()(s, makeIssue({ sightings: [s] }));
    expect(out).toHaveLength(1);
    const pin = out[0];
    expect(pin?.on === 'mesh' && pin.layer).toBe('site');
    if (pin?.on !== 'mesh' || pin.geom.type !== 'spoint') throw new Error('expected a pin');
    expect(pin.geom.p[0]).toBeCloseTo(3);
    expect(pin.geom.p[2]).toBeCloseTo(4);
  });

  it('back-projects a video keyframe with the flight pose at layer offset + t', () => {
    const s: Sighting = {
      on: 'video',
      layer: 'f108',
      track: [{ t: 4, geom: { type: 'box', x: 630, y: 350, w: 20, h: 20 } }],
    };
    const out = deriver()(s, makeIssue({ sightings: [s] }));
    if (out[0]?.on !== 'mesh' || out[0].geom.type !== 'spoint') throw new Error('expected a pin');
    // flight time = 1000 ms offset + 4 s = 5 s, half way: x = 5.
    expect(out[0].geom.p[0]).toBeCloseTo(5, 5);
  });

  it('adds nothing when the issue already has a mesh sighting', () => {
    expect(
      deriver()(photoSighting, makeIssue({ sightings: [meshSighting, photoSighting] })),
    ).toEqual([]);
  });

  it('adds nothing without a pose, image size or scene', () => {
    const s: Sighting = {
      on: 'image',
      layer: 'photos',
      photo: 'nopose',
      geom: { type: 'point', x: 1, y: 1 },
    };
    expect(deriver()(s, makeIssue({ sightings: [s] }))).toEqual([]);
    const blind = createDeriver({
      layers: () => layers,
      scene: () => null,
      flight: () => samples,
      imageSize: () => [1200, 900],
    });
    const p: Sighting = {
      on: 'image',
      layer: 'photos',
      photo: 'F01',
      geom: { type: 'point', x: 1, y: 1 },
    };
    expect(blind(p, makeIssue({ sightings: [p] }))).toEqual([]);
  });
});
