import { emptyOrientation, type Issue, type ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { issuePoints, placeIndex } from './places';
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

describe('placeIndex with a lined-up date', () => {
  it('puts photos, their eyes and the issue eye where the date is drawn', () => {
    const ws = createWorkspace();
    const manifest = {
      schema: 'aio.project/1',
      id: 'p',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [
        {
          id: 'd1',
          label: 'd1',
          date: '2025-01-01',
          lineUp: { eastM: 2, northM: 1, with: 'd0', at: '2026-01-01T00:00:00Z' },
        },
      ],
      layers: [
        {
          kind: 'photos',
          id: 'ph',
          name: 'Flight',
          visible: true,
          capture: 'd1',
          items: [{ id: 'a', src: { path: 'a.jpg' }, pos: [10, 50, 20] }],
        },
      ],
      severityModels: [],
      classCatalogues: [],
    } as unknown as ProjectManifest;
    const issues = [
      {
        id: 'i1',
        code: 'D1',
        title: 't',
        severity: 1,
        status: 'open',
        sightings: [{ on: 'image', layer: 'ph', photo: 'a', geom: { type: 'point', x: 1, y: 1 } }],
      } as unknown as Issue,
    ] as Issue[];
    ws.getState().openProject({ id: 'p', root: 'C:/p', manifest }, issues);
    const ctx: RendererToolContext = {
      workspace: ws,
      window: 'scene3d',
      scene: () => null,
      fetchJson: () => Promise.resolve(null),
      captureFrame: () => Promise.resolve(null),
      now: () => new Date(0),
    };
    const places = placeIndex(ctx);
    expect(places.find((p) => p.id === 'photo:a')?.eye?.pos).toEqual([12, 50, 19]);
    expect(places.find((p) => p.id === 'layer:ph')?.p).toEqual([12, 50, 19]);
    expect(places.find((p) => p.id === 'issue:D1')?.eye?.pos).toEqual([12, 50, 19]);
  });
});

describe('issue points on a lined-up date', () => {
  it('places an issue pin where its date is drawn', () => {
    const issue = {
      id: 'i1',
      code: 'D1',
      title: 't',
      severity: 1,
      status: 'open',
      sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [10, 4, 20] } }],
    } as unknown as Issue;
    expect(issuePoints(issue)).toEqual([[10, 4, 20]]);
    expect(issuePoints(issue, () => ({ eastM: 2, northM: 1 }))).toEqual([[12, 4, 19]]);
  });
});
