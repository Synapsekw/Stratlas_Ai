import { emptyOrientation, type ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { placeIndex } from './places';
import type { RendererToolContext } from './tool-kit';

describe('placeIndex with moved photos', () => {
  it('puts photo sets, photos and their eyes where they are drawn', () => {
    const ws = createWorkspace();
    const manifest = {
      schema: 'aio.project/1',
      id: 'p',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [],
      layers: [
        {
          kind: 'photos',
          id: 'ph',
          name: 'Flight',
          visible: true,
          items: [{ id: 'a', src: { path: 'a.jpg' }, pos: [91000, 50, 2000] }],
        },
      ],
      severityModels: [],
      classCatalogues: [],
    } as unknown as ProjectManifest;
    ws.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    ws.getState().setOrientation({
      ...emptyOrientation(),
      photos: { ph: { a: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [-91000, 0, -2000] } } },
    });
    const ctx: RendererToolContext = {
      workspace: ws,
      window: 'scene3d',
      scene: () => null,
      fetchJson: () => Promise.resolve(null),
      captureFrame: () => Promise.resolve(null),
      now: () => new Date(0),
    };
    const places = placeIndex(ctx);
    expect(places.find((p) => p.id === 'layer:ph')?.p).toEqual([0, 50, 0]);
    expect(places.find((p) => p.id === 'photo:a')?.eye?.pos).toEqual([0, 50, 0]);
  });
});

describe('placeIndex with a 360 that is not placed', () => {
  it('gives it a place without p and eye, and keeps it out of the layer box', () => {
    const ws = createWorkspace();
    const manifest = {
      schema: 'aio.project/1',
      id: 'p',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [],
      layers: [
        {
          kind: 'panoramas',
          id: 'pn',
          name: 'N',
          visible: true,
          items: [
            { id: 'a', src: { path: 'a.jpg' }, pos: [10, 0, 0], headingDeg: 0 },
            { id: 'b', src: { path: 'b.jpg' }, headingDeg: 0 },
          ],
        },
      ],
      severityModels: [],
      classCatalogues: [],
    } as unknown as ProjectManifest;
    ws.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    const ctx: RendererToolContext = {
      workspace: ws,
      window: 'scene3d',
      scene: () => null,
      fetchJson: () => Promise.resolve(null),
      captureFrame: () => Promise.resolve(null),
      now: () => new Date(0),
    };
    const places = placeIndex(ctx);
    const b = places.find((p) => p.id === 'pano:b');
    expect(b).toBeDefined();
    expect(b?.p).toBeUndefined();
    expect(b?.eye).toBeUndefined();
    expect(places.find((p) => p.id === 'pano:a')?.p).toEqual([10, 0, 0]);
    expect(places.find((p) => p.id === 'layer:pn')?.p).toEqual([10, 0, 0]);
  });
});
