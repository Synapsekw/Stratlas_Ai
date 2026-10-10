import { utmToLonLat } from '@aio/maps';
import type { Issue, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { roadStore, setFilter, setRoad, startRoadSync } from './store';

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
  // one store for the app: the next test starts as a newly started app does
  roadStore.setState(roadStore.getInitialState());
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

  // The road builder's end reads the open project again twice (the job, then the journal), and a
  // sync merge or a saved layer once: each time the project is a new object with the same id.
  it('keeps the view when the open project is read again', async () => {
    const ws = createWorkspace();
    let loads = 0;
    stop = startRoadSync(ws, () => {
      loads += 1;
      return Promise.resolve(road);
    });
    ws.getState().openProject({ id: 'rr', root: 'x', manifest }, [issue]);
    await expect.poll(() => roadStore.getState().status).toBe('ready');
    const first = roadStore.getState().road;
    setRoad({ overlay: 'pci', closeup: false, sort: 'chainage', opacity: 0.4 });
    setFilter({ search: 'pothole' });

    // every state on the way: the road must stay on screen (its ruler, its keys, its overlay)
    const seen = new Set<string>();
    const off = roadStore.subscribe((s) => {
      seen.add(`${s.status}, ${s.road ? 'road' : 'no road'}, overlay ${s.overlay}`);
    });
    // a manifest read again (journal:changed, a saved layer), then the project opened again
    // (the job's end), before the first of the two has loaded
    ws.getState().replaceManifest({ ...manifest });
    ws.getState().openProject({ id: 'rr', root: 'x', manifest: { ...manifest } }, [issue]);
    await expect.poll(() => loads).toBe(3);
    await expect.poll(() => roadStore.getState().road).not.toBe(first);
    off();

    expect([...seen]).toEqual(['ready, road, overlay pci']);
    expect(roadStore.getState()).toMatchObject({
      status: 'ready',
      overlay: 'pci',
      closeup: false,
      sort: 'chainage',
      opacity: 0.4,
      filter: { search: 'pothole' },
    });
    expect(roadStore.getState().rows).toHaveLength(1);
  });

  it('starts afresh for another project, and after the project was closed', async () => {
    const ws = createWorkspace();
    stop = startRoadSync(ws, () => Promise.resolve(road));
    ws.getState().openProject({ id: 'rr', root: 'x', manifest }, []);
    await expect.poll(() => roadStore.getState().status).toBe('ready');
    setRoad({ overlay: 'pci' });
    ws.getState().openProject({ id: 'other', root: 'y', manifest: { ...manifest, id: 'other' } });
    expect(roadStore.getState()).toMatchObject({
      projectId: 'other',
      status: 'loading',
      overlay: 'none',
      road: null,
    });
    await expect.poll(() => roadStore.getState().status).toBe('ready');
    setRoad({ overlay: 'density' });
    ws.getState().closeProject();
    ws.getState().openProject({ id: 'other', root: 'y', manifest: { ...manifest, id: 'other' } });
    expect(roadStore.getState().overlay).toBe('none');
  });

  it('keeps a centreline being drawn while the project is read again, until the road is built', async () => {
    const ws = createWorkspace();
    let built: unknown = null;
    stop = startRoadSync(ws, () => Promise.resolve(built));
    const setup = { ...manifest, layers: [], type: 'road' } as ProjectManifest;
    ws.getState().openProject({ id: 'new-road', root: 'x', manifest: setup });
    await expect.poll(() => roadStore.getState().status).toBe('setup');
    const draw = { on: true, vertices: [[47.9, 29.3]] as [number, number][] };
    setRoad({ draw });
    // the ortho was imported: the manifest comes again, still without road.json
    ws.getState().replaceManifest({ ...setup });
    await new Promise((r) => setTimeout(r, 0));
    expect(roadStore.getState()).toMatchObject({ status: 'setup', draw });
    // the road builder ran
    built = road;
    ws.getState().openProject({ id: 'new-road', root: 'x', manifest: { ...setup } });
    await expect.poll(() => roadStore.getState().status).toBe('ready');
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
