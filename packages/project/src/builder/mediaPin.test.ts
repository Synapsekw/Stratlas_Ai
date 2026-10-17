import { photoQuatFromHeading } from '@aio/geo';
import type { Layer, PanoRef, PhotoRef } from '@aio/schema';
import { expect, it } from 'vitest';
import { applyMediaPin } from './mediaPin';

const photo = { id: 'a', src: { path: 'photos/a.jpg' } } as PhotoRef;
const gpsPhoto = {
  id: 'g',
  src: { path: 'photos/g.jpg' },
  pos: [5, 30, 5],
  q: [0.1, 0.2, 0.3, 0.927],
} as PhotoRef;
const src = { path: 'panos/p.jpg' };
const photos = (items: PhotoRef[]) =>
  ({ kind: 'photos', id: 'ph', name: 'Photos', visible: true, items }) as Layer;
const panos = (items: PanoRef[]) =>
  ({ kind: 'panoramas', id: 'pa', name: 'Panos', visible: true, items }) as Layer;
const meshLayer = { kind: 'mesh', id: 'm', name: 'Model', visible: true } as unknown as Layer;
function item(l: Layer, id: string): PhotoRef & PanoRef {
  if (l.kind !== 'photos' && l.kind !== 'panoramas') throw new Error('not a media layer');
  const it = (l.items as (PhotoRef & PanoRef)[]).find((i) => i.id === id);
  if (!it) throw new Error('missing item');
  return it;
}

it('pins an unplaced photo at ground plus eye height, without q when no heading', () => {
  const out = item(
    applyMediaPin(photos([photo]), { itemId: 'a', pin: { ground: [1, 2, 3], eyeM: 1.6 } }),
    'a',
  );
  expect(out.pos).toEqual([1, 3.6, 3]);
  expect(out.q).toBeUndefined();
  expect(out.pin?.gps).toBeUndefined();
});

it('a photo heading writes a level camera q', () => {
  const out = item(
    applyMediaPin(photos([photo]), {
      itemId: 'a',
      pin: { ground: [0, 0, 0], eyeM: 1.6, headingDeg: 90 },
    }),
    'a',
  );
  expect(out.q).toEqual(photoQuatFromHeading(90));
});

it('pinning a GPS photo keeps its GPS place in pin.gps, and Remove pin restores pos and q exactly', () => {
  const pinned = applyMediaPin(photos([gpsPhoto]), {
    itemId: 'g',
    pin: { ground: [9, 0, 9], eyeM: 1.6, headingDeg: 45 },
  });
  expect(item(pinned, 'g').pin?.gps).toEqual({ pos: [5, 30, 5], q: [0.1, 0.2, 0.3, 0.927] });
  const moved = applyMediaPin(pinned, { itemId: 'g', pin: { ground: [8, 0, 8], eyeM: 2 } });
  expect(item(moved, 'g').pin?.gps).toEqual({ pos: [5, 30, 5], q: [0.1, 0.2, 0.3, 0.927] });
  const removed = item(applyMediaPin(moved, { itemId: 'g', pin: null }), 'g');
  expect(removed.pos).toEqual([5, 30, 5]);
  expect(removed.q).toEqual([0.1, 0.2, 0.3, 0.927]);
  expect(removed.pin).toBeUndefined();
});

it('moving a GPS photo pin without a heading keeps the GPS aim', () => {
  const out = item(
    applyMediaPin(photos([gpsPhoto]), { itemId: 'g', pin: { ground: [1, 0, 1], eyeM: 1.6 } }),
    'g',
  );
  expect(out.q).toEqual([0.1, 0.2, 0.3, 0.927]);
});

it('Remove pin on an item without GPS leaves it unplaced', () => {
  const p = applyMediaPin(panos([{ id: 'p', src } as PanoRef]), {
    itemId: 'p',
    pin: { ground: [1, 0, 1], eyeM: 1.6, headingDeg: 95 },
  });
  expect(item(p, 'p').headingDeg).toBe(95);
  const back = item(applyMediaPin(p, { itemId: 'p', pin: null }), 'p');
  expect(back.pos).toBeUndefined();
  expect(back.pin).toBeUndefined();
  expect(back.headingDeg).toBe(95);
});

it('Remove pin on an unplaced photo takes pos and q away', () => {
  const p = applyMediaPin(photos([photo]), {
    itemId: 'a',
    pin: { ground: [1, 0, 1], eyeM: 1.6, headingDeg: 10 },
  });
  const back = item(applyMediaPin(p, { itemId: 'a', pin: null }), 'a');
  expect(back.pos).toBeUndefined();
  expect(back.q).toBeUndefined();
});

it('a 360 pin without heading keeps the stored headingDeg', () => {
  const out = item(
    applyMediaPin(panos([{ id: 'p', src, headingDeg: 12 }]), {
      itemId: 'p',
      pin: { ground: [0, 0, 0], eyeM: 1.6 },
    }),
    'p',
  );
  expect(out.headingDeg).toBe(12);
  expect(out.pos).toEqual([0, 1.6, 0]);
});

it('a gps value sent by the renderer is ignored (the writer owns it)', () => {
  const out = item(
    applyMediaPin(photos([photo]), {
      itemId: 'a',
      pin: { ground: [0, 0, 0], eyeM: 1.6, gps: { pos: [7, 7, 7] } },
    }),
    'a',
  );
  expect(out.pin?.gps).toBeUndefined();
});

it('refuses another layer kind and a missing item', () => {
  expect(() => applyMediaPin(meshLayer, { itemId: 'a', pin: null })).toThrow(/photos or panoramas/);
  expect(() => applyMediaPin(photos([photo]), { itemId: 'zz', pin: null })).toThrow(/zz/);
});
