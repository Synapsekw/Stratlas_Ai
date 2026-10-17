import { ProjectManifest, type Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { convertMediaManifest } from './convertMedia';

const pin = { ground: [1, 2, 0], eyeM: 1.6, headingDeg: 95 };
const lens = { model: 'pinhole', hfovDeg: 60, aspect: 2 };

function manifest(layers: unknown[]): ProjectManifest {
  return ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32633 },
    origin: [0, 0, 0],
    captures: [{ id: 'c1', label: 'Survey', date: '2026-10-01' }],
    layers,
    severityModels: [],
    classCatalogues: [],
  });
}
const photos = (items: unknown[]) => ({
  kind: 'photos',
  id: 'photos-1',
  name: 'Photos',
  capture: 'c1',
  items,
});
const photo = {
  id: 'ph',
  src: { path: 'photos/ph.jpg' },
  takenAt: '2026-10-01T09:00:00+02:00',
  pos: [1, 2, 1.6],
  q: [0, 0, 0, 1],
  lens,
  pin,
};
const layer = (m: ProjectManifest, id: string): Layer | undefined =>
  m.layers.find((l) => l.id === id);

describe('convertMediaManifest', () => {
  it('turns a photo into a 360 in a new panoramas layer of its date', () => {
    const r = convertMediaManifest(manifest([photos([photo])]), {
      layerId: 'photos-1',
      itemId: 'ph',
      to: 'pano',
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.layerId).toBe('panos-2026-10-01');
    expect(r.itemId).toBe('ph');
    const l = layer(r.manifest, 'panos-2026-10-01');
    if (l?.kind !== 'panoramas') throw new Error('kind');
    expect(l.capture).toBe('c1');
    expect(l.items).toEqual([
      {
        id: 'ph',
        src: { path: 'photos/ph.jpg' },
        pos: [1, 2, 1.6],
        pin,
        capturedAt: '2026-10-01T09:00:00+02:00',
        headingDeg: 0,
      },
    ]);
  });

  it('joins an existing panoramas layer of that capture and renames a clashing id', () => {
    const pano = { id: 'ph', src: { path: 'x.jpg' }, headingDeg: 0 };
    const r = convertMediaManifest(
      manifest([
        photos([photo]),
        { kind: 'panoramas', id: 'pn', name: 'Pn', capture: 'c1', items: [pano] },
      ]),
      { layerId: 'photos-1', itemId: 'ph', to: 'pano' },
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.layerId).toBe('pn');
    expect(r.itemId).toBe('ph-2');
    const l = layer(r.manifest, 'pn');
    if (l?.kind !== 'panoramas') throw new Error('kind');
    expect(l.items.map((p) => p.id)).toEqual(['ph', 'ph-2']);
  });

  it('removes a source layer left empty and keeps one with other photos', () => {
    const other = { id: 'o', src: { path: 'o.jpg' } };
    const gone = convertMediaManifest(manifest([photos([photo])]), {
      layerId: 'photos-1',
      itemId: 'ph',
      to: 'pano',
    });
    if ('error' in gone) throw new Error(gone.error);
    expect(layer(gone.manifest, 'photos-1')).toBeUndefined();
    const kept = convertMediaManifest(manifest([photos([photo, other])]), {
      layerId: 'photos-1',
      itemId: 'ph',
      to: 'pano',
    });
    if ('error' in kept) throw new Error(kept.error);
    const l = layer(kept.manifest, 'photos-1');
    expect(l?.kind === 'photos' && l.items.map((p) => p.id)).toEqual(['o']);
  });

  it('uses the photo layer capture when the photo has no time', () => {
    const bare = { ...photo, takenAt: undefined };
    const r = convertMediaManifest(manifest([photos([bare])]), {
      layerId: 'photos-1',
      itemId: 'ph',
      to: 'pano',
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.layerId).toBe('panos-2026-10-01');
    const l = layer(r.manifest, r.layerId);
    if (l?.kind !== 'panoramas') throw new Error('kind');
    expect(l.capture).toBe('c1');
    expect(l.items[0]).not.toHaveProperty('capturedAt');
  });

  it('turns a 360 back into a photo, and the round trip keeps pin and pos', () => {
    const there = convertMediaManifest(manifest([photos([photo])]), {
      layerId: 'photos-1',
      itemId: 'ph',
      to: 'pano',
    });
    if ('error' in there) throw new Error(there.error);
    const back = convertMediaManifest(there.manifest, {
      layerId: there.layerId,
      itemId: there.itemId,
      to: 'photo',
    });
    if ('error' in back) throw new Error(back.error);
    expect(back.layerId).toBe('photos-2026-10-01');
    expect(layer(back.manifest, there.layerId)).toBeUndefined();
    const l = layer(back.manifest, back.layerId);
    if (l?.kind !== 'photos') throw new Error('kind');
    expect(l.capture).toBe('c1');
    expect(l.items).toEqual([
      {
        id: 'ph',
        src: { path: 'photos/ph.jpg' },
        takenAt: '2026-10-01T09:00:00+02:00',
        pos: [1, 2, 1.6],
        pin,
      },
    ]);
  });

  it('refuses a stitched 360, a missing item and the wrong kind', () => {
    const stitched = {
      kind: 'panoramas',
      id: 'pn',
      name: 'Pn',
      items: [{ id: 'a', src: { path: 'a.jpg' }, headingDeg: 0, cov: { top: 90, bottom: -90 } }],
    };
    const m = manifest([photos([photo]), stitched]);
    expect(convertMediaManifest(m, { layerId: 'pn', itemId: 'a', to: 'photo' })).toEqual({
      error: 'stitched',
    });
    expect(convertMediaManifest(m, { layerId: 'pn', itemId: 'zz', to: 'photo' })).toEqual({
      error: 'missing',
    });
    expect(convertMediaManifest(m, { layerId: 'photos-1', itemId: 'ph', to: 'photo' })).toEqual({
      error: 'kind',
    });
  });
});
