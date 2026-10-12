import type { Layer } from '@aio/schema';
import type { CaptureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import {
  findPano,
  followCandidates,
  followPano,
  groundDistance,
  pairPano,
  panoKey,
  panosOf,
  stepPano,
  type PanoAt,
} from './panoPair';

const key = (a: PanoAt | undefined) => (a ? panoKey(a) : undefined);

const pano = (id: string, x: number, z: number, y = 0) => ({
  id,
  src: { path: `p/${id}.jpg` },
  pos: [x, y, z] as [number, number, number],
  headingDeg: 0,
});
const layer = (id: string, items: ReturnType<typeof pano>[]) =>
  ({ kind: 'panoramas', id, name: id, items }) as unknown as Layer;
const layers = [
  layer('p-oct', [pano('a', 0, 0), pano('b', 10, 0), pano('c', 20, 0)]),
  layer('p-nov', [pano('d', 2, 0), pano('e', 11, 1), pano('f', 60, 0)]),
  layer('p-any', [pano('g', 100, 100)]),
];
const index = {
  captures: [{ id: 'oct' }, { id: 'nov' }],
  layers: { oct: ['p-oct'], nov: ['p-nov'] },
  of: { 'p-oct': 'oct', 'p-nov': 'nov' },
  epochs: {},
  slot: {},
} as unknown as CaptureIndex;

describe('panosOf', () => {
  it("lists the date's panoramas and the undated ones, in manifest order", () => {
    expect(panosOf(layers, index, 'nov').map(panoKey)).toEqual([
      'p-nov/d',
      'p-nov/e',
      'p-nov/f',
      'p-any/g',
    ]);
  });
  it('lists every panorama without a date or an index', () => {
    expect(panosOf(layers, null, undefined)).toHaveLength(7);
  });
});

describe('followCandidates', () => {
  const at = (layerId: string, id: string): PanoAt => {
    const found = panosOf(layers, null, undefined).find((a) => panoKey(a) === `${layerId}/${id}`);
    if (!found) throw new Error(`missing ${layerId}/${id}`);
    return found;
  };
  it('keeps the undated panoramas for a dated lead', () => {
    const list = panosOf(layers, index, 'nov');
    expect(followCandidates(list, at('p-oct', 'a'), index).map(panoKey)).toEqual([
      'p-nov/d',
      'p-nov/e',
      'p-nov/f',
      'p-any/g',
    ]);
  });
  it('never pairs an undated lead with an undated panorama, itself included', () => {
    const list = panosOf(layers, index, 'nov');
    expect(followCandidates(list, at('p-any', 'g'), index).map(panoKey)).toEqual([
      'p-nov/d',
      'p-nov/e',
      'p-nov/f',
    ]);
  });
  it('leaves nothing to pair when no panorama has a date', () => {
    const list = panosOf(layers, null, 'nov');
    expect(followCandidates(list, at('p-any', 'g'), null)).toEqual([]);
  });
});

describe('pairPano', () => {
  const nov = panosOf(layers, index, 'nov');
  it('picks the nearest on the ground, ignoring height', () => {
    const p = pairPano(pano('b', 10, 0, 30), nov);
    expect(key(p?.at)).toBe('p-nov/e');
    expect(p?.distanceM).toBeCloseTo(Math.hypot(1, 1));
    expect(p?.within).toBe(true);
  });
  it('marks a pair beyond the limit as not within', () => {
    const p = pairPano(pano('x', 40, 40), panosOf(layers, index, 'nov').slice(0, 3));
    expect(p?.within).toBe(false);
  });
  it('ties pick the first in list order', () => {
    const flat = [
      { layer: 'L', pano: pano('m', 0, 0) },
      { layer: 'L', pano: pano('n', 0, 0) },
    ];
    expect(pairPano(pano('a', 0, 0), flat)?.at.pano.id).toBe('m');
  });
  it('is null with no candidates', () => {
    expect(pairPano(pano('a', 0, 0), [])).toBeNull();
  });
});

describe('stepPano and findPano', () => {
  const oct = panosOf(layers, index, 'oct');
  it('wraps both ways', () => {
    expect(key(stepPano(oct, 'p-oct/a', -1))).toBe('p-any/g');
    expect(key(stepPano(oct, 'p-any/g', 1))).toBe('p-oct/a');
  });
  it('starts at the first for an unknown key', () => {
    expect(key(stepPano(oct, 'nope', 1))).toBe('p-oct/a');
    expect(findPano(oct, 'nope')).toBeUndefined();
  });
});

describe('followPano', () => {
  it('keeps the spot on a date change, whatever the distance', () => {
    expect(followPano(pano('c', 20, 0), panosOf(layers, index, 'nov'))?.pano.id).toBe('e');
  });
  it('takes the first without a previous panorama', () => {
    expect(followPano(undefined, panosOf(layers, index, 'nov'))?.pano.id).toBe('d');
  });
  it('measures metres in x and z', () => {
    expect(groundDistance([0, 5, 0], [3, -9, 4])).toBe(5);
  });
});
