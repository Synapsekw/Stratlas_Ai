import { utmToLonLat } from '@aio/maps';
import type { Issue, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { roadStore, startRoadSync } from './store';

const manifest = {
  schema: 'aio.project/1',
  id: 'rr',
  name: 'Road',
  crs: { epsg: 32638 },
  origin: [789217, 3252895, 0],
  captures: [],
  layers: [
    {
      kind: 'legacy',
      id: 'review',
      name: 'Road review',
      visible: true,
      viewer: 'road',
      entry: { path: 'legacy/r.html' },
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

const road = {
  schema: 'aio.road/1',
  name: 'Road',
  centreline: {
    points: [
      [-500, 0, 0],
      [500, 0, 0],
    ],
    chainageKm: [0, 1],
    lengthKm: 1,
  },
  pci: {
    standard: 'ASTM D6433',
    severities: ['Low', 'Medium', 'High'],
    headline: 'medium',
    network: { low: 90, medium: 80, high: 70 },
    ratings: [{ min: 0, label: 'Failed', color: '#6d6d6d' }],
    grid: { cellM: 15, origin: [0, 0, 0] },
    sections: [],
    units: [],
  },
  density: { gridOrigin: [0, 0, 0], sizes: {} },
};

// the origin itself, so chainage 0.5 km
const issue = {
  id: 'i1',
  code: 'D0001',
  classId: 'potholes',
  severityModelId: 'sev',
  severity: 1,
  status: 'reviewed',
  title: 'Pothole',
  note: '',
  author: 't',
  createdAt: '2024-04-02T00:00:00+03:00',
  updatedAt: '2024-04-02T00:00:00+03:00',
  sightings: [{ on: 'map', layer: 'ortho', geojson: { type: 'Point', coordinates: [0, 0] } }],
  source: 'import',
} as Issue;

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe('road sync', () => {
  it('loads road.json for a road survey and lists its defects with chainage', async () => {
    const ws = createWorkspace();
    const urls: string[] = [];
    stop = startRoadSync(ws, (url) => {
      urls.push(url);
      return Promise.resolve(road);
    });
    const lonLat = utmToLonLat(789217, 3252895, 38, false);
    ws.getState().openProject({ id: 'rr', root: 'x', manifest }, [
      {
        ...issue,
        sightings: [{ on: 'map', layer: 'o', geojson: { type: 'Point', coordinates: lonLat } }],
      },
    ]);
    await expect.poll(() => roadStore.getState().status).toBe('ready');
    expect(urls).toEqual(['aio://project/rr/road.json']);
    const rows = roadStore.getState().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.km).toBeCloseTo(0.5, 1);
  });

  it('stays out of the way for other projects', () => {
    const ws = createWorkspace();
    stop = startRoadSync(ws, () => Promise.reject(new Error('not called')));
    ws.getState().openProject({ id: 'p', root: 'x', manifest: { ...manifest, layers: [] } });
    expect(roadStore.getState().status).toBe('none');
  });

  it('a road survey without road.json waits in setup for the road builder', async () => {
    const ws = createWorkspace();
    stop = startRoadSync(ws, () => Promise.resolve(null));
    ws.getState().openProject({
      id: 'new-road',
      root: 'x',
      manifest: { ...manifest, layers: [], type: 'road' },
    });
    await expect.poll(() => roadStore.getState().status).toBe('setup');
    expect(roadStore.getState().road).toBeNull();
    expect(roadStore.getState().draw).toEqual({ on: false, vertices: [] });
  });

  it('reports a broken road model', async () => {
    const ws = createWorkspace();
    stop = startRoadSync(ws, () => Promise.resolve({ schema: 'aio.road/1' }));
    ws.getState().openProject({ id: 'rr', root: 'x', manifest });
    await expect.poll(() => roadStore.getState().status).toBe('error');
    expect(roadStore.getState().error).toMatch(/Road model is invalid/);
  });
});
