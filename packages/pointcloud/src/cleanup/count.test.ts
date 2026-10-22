import type { SceneHandle } from '@aio/engine';
import { BufferAttribute, BufferGeometry, Plane, Points, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createPointMaterial } from '../material';
import { collectDrawn } from './count';

const mocks = vi.hoisted(() => ({
  manager: undefined as { layers: Map<string, { loaded: unknown[] }> } | undefined,
}));
vi.mock('../adapter', () => ({ getCloudManager: () => mocks.manager }));

function chunk(xyz: number[], offsetX = 0, mask?: number[]) {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(xyz), 3));
  if (mask) geo.setAttribute('aMask', new BufferAttribute(new Uint8Array(mask), 1));
  const m = createPointMaterial({
    hasRgb: false,
    hasIntensity: false,
    hasClass: false,
    hasMask: mask !== undefined,
    baseSize: 1,
    tint: '#000',
  });
  const obj = new Points(geo, m);
  obj.position.x = offsetX;
  return { object: obj };
}

function handle(planes: Plane[] = []) {
  mocks.manager = {
    layers: new Map([
      [
        'a',
        {
          id: 'a',
          visible: true,
          loaded: [chunk([0, 0, 0, 1, 0, 0, 2, 0, 0]), chunk([0, 1, 0, 1, 1, 0], 10)],
        },
      ],
    ]),
  };
  return { clippingPlanes: planes } as unknown as SceneHandle;
}

describe('collectDrawn', () => {
  it('returns the accepted points of every chunk with the world matrix applied', () => {
    const h = handle();
    const out = collectDrawn(h, 'a', (x) => x !== 1);
    expect([...out]).toEqual([0, 0, 0, 2, 0, 0, 10, 1, 0, 11, 1, 0]);
  });

  it('stops at max points', () => {
    expect(collectDrawn(handle(), 'a', () => true, 4)).toHaveLength(12);
  });

  it('honours the clipping planes and unknown layers', () => {
    const planes = [new Plane(new Vector3(1, 0, 0), -0.5)]; // keep x >= 0.5
    expect(collectDrawn(handle(planes), 'a', () => true)).toHaveLength(3 * 4);
    expect(collectDrawn(handle(), 'nope', () => true)).toHaveLength(0);
  });

  it('skips masked points', () => {
    const h = handle();
    const layer = mocks.manager?.layers.get('a');
    if (!layer) throw new Error('no layer');
    layer.loaded = [chunk([0, 0, 0, 1, 0, 0], 0, [0, 1])];
    expect([...collectDrawn(h, 'a', () => true)]).toEqual([0, 0, 0]);
  });
});
