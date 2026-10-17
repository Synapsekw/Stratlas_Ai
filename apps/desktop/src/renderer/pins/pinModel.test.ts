import { ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { drawnPins, isPlaced, keyString, mediaItem, pinsAt } from './pinModel';

const m = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32633 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'ph',
      name: 'Photos',
      items: [
        { id: 'a', src: { path: 'photos/a.jpg' }, pin: { ground: [1, 0, 2], headingDeg: 30 } },
        { id: 'gps', src: { path: 'photos/gps.jpg' }, pos: [5, 5, 5] },
        { id: 'loose', src: { path: 'photos/loose.jpg' } },
      ],
    },
    {
      kind: 'panoramas',
      id: 'pa',
      name: 'Panoramas',
      items: [
        {
          id: 'x',
          src: { path: 'panos/x.jpg' },
          name: 'Pano 1',
          pos: [0, 2, 0],
          pin: { ground: [0, 0, 0], eyeM: 2 },
        },
        { id: 'y', src: { path: 'panos/y.jpg' }, pos: [9, 9, 9], headingDeg: 40 },
      ],
    },
    {
      kind: 'panoramas',
      id: 'hid',
      name: 'Hidden',
      visible: false,
      items: [{ id: 'z', src: { path: 'panos/z.jpg' }, pin: { ground: [3, 0, 3] } }],
    },
  ],
  severityModels: [],
  classCatalogues: [],
});

describe('pinModel', () => {
  it('keys media as kind, layer and item', () => {
    expect(keyString({ kind: 'pano', layerId: 'pa', itemId: 'x' })).toBe('pano:pa:x');
  });

  it('finds an item by its key and kind', () => {
    expect(mediaItem(m, { kind: 'photo', layerId: 'ph', itemId: 'a' })?.id).toBe('a');
    expect(mediaItem(m, { kind: 'pano', layerId: 'ph', itemId: 'a' })).toBeNull();
    expect(mediaItem(m, { kind: 'pano', layerId: 'pa', itemId: 'nope' })).toBeNull();
  });

  it('tells placed items by their position', () => {
    expect(isPlaced({ id: 'q', src: { path: 'q.jpg' }, pos: [0, 0, 0] })).toBe(true);
    expect(isPlaced({ id: 'q', src: { path: 'q.jpg' } })).toBe(false);
  });

  it('draws pinned items of shown layers only, skipping unpinned GPS items', () => {
    // the workspace's hidden set holds the layers saved hidden (`hid`) from the start
    const pins = drawnPins(m, new Set(['hid']));
    expect(pins.map((p) => p.key.itemId)).toEqual(['a', 'x']);
    const [a, x] = pins;
    expect(a).toMatchObject({ name: 'a.jpg', ground: [1, 0, 2], headingDeg: 30, linedUp: true });
    expect(a?.eye[1]).toBeCloseTo(1.6);
    // a 360 shows a heading only when the pin set it
    expect(x).toMatchObject({ name: 'Pano 1', eye: [0, 2, 0], linedUp: false });
    expect(x?.headingDeg).toBeUndefined();
    expect(drawnPins(m, new Set(['ph', 'hid'])).map((p) => p.key.itemId)).toEqual(['x']);
  });

  it('follows the shown layers as the plates do: a layer saved hidden and shown again draws', () => {
    expect(drawnPins(m, new Set()).map((p) => p.key.itemId)).toEqual(['a', 'x', 'z']);
  });

  it('picks the nearest pin within 14 px, null beyond', () => {
    const a = { kind: 'photo' as const, layerId: 'ph', itemId: 'a' };
    const b = { kind: 'pano' as const, layerId: 'pa', itemId: 'x' };
    const pts = [
      { key: a, x: 100, y: 100 },
      { key: b, x: 110, y: 100 },
    ];
    expect(pinsAt(pts, 108, 100)).toBe(b);
    expect(pinsAt(pts, 100, 113)).toBe(a);
    expect(pinsAt(pts, 100, 120)).toBeNull();
    expect(pinsAt(pts, 100, 120, 30)).toBe(a);
    expect(pinsAt([], 0, 0)).toBeNull();
  });
});
