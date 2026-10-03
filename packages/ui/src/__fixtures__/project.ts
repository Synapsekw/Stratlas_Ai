import type { Issue, ProjectManifest } from '@aio/schema';

/** Flight 1 starts at 2023-02-21 12:00:00 UTC. */
export const T0 = Date.UTC(2023, 1, 21, 12, 0, 0);

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const lens = { model: 'ftheta' as const, hfovDeg: 114, aspect: 1.7778 };

export function mockManifest(): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'alzour',
    name: 'Al-Zour LNG Terminal',
    customer: 'KIPIC',
    site: 'Al-Zour, Kuwait',
    crs: { epsg: 32639 },
    origin: [245000, 3179000, 100],
    captures: [{ id: 'c1', label: 'Survey 1', date: '2023-02-21' }],
    layers: [
      {
        kind: 'mesh',
        id: 'plant',
        name: 'Plant model',
        visible: true,
        src: { path: 'models/plant.glb' },
        transform: identity,
      },
      {
        kind: 'pointcloud',
        id: 'lidar',
        name: 'Site LiDAR',
        visible: false,
        src: { path: 'clouds/site.copc.laz' },
        format: 'copc',
        pointCount: 842_000_000,
      },
      {
        kind: 'raster',
        id: 'ortho',
        name: 'Orthomosaic 2023-02',
        visible: true,
        src: { path: 'rasters/ortho.jpg' },
        role: 'ortho',
        format: 'image',
      },
      {
        kind: 'basemap',
        id: 'osm',
        name: 'OSM streets',
        visible: true,
        pack: 'gcc',
        style: 'dark',
      },
      {
        kind: 'video',
        id: 'dji0665',
        name: 'DJI_0665 overview',
        visible: true,
        src: { path: 'video/dji0665.mp4' },
        flight: { src: { path: 'flights/dji0665.json' }, startUtcMs: T0 },
        lens,
        offsetMs: 0,
      },
      {
        kind: 'video',
        id: 'dji0789',
        name: 'DJI_0789 tanks pass',
        visible: true,
        src: { path: 'video/dji0789.mp4' },
        flight: { src: { path: 'flights/dji0789.json' }, startUtcMs: T0 + 3_600_000 },
        lens,
        offsetMs: 5_000,
        poster: { path: 'posters/dji0789.jpg' },
      },
      {
        kind: 'photos',
        id: 'findings',
        name: 'Finding photos',
        visible: true,
        items: [
          { id: 'p1', src: { path: 'photos/p1.jpg' }, takenAt: '2023-02-21T12:30:00Z' },
          { id: 'p2', src: { path: 'photos/p2.jpg' } },
        ],
      },
      {
        kind: 'panoramas',
        id: 'panos',
        name: 'Panoramas',
        visible: true,
        items: [{ id: 'pa1', src: { path: 'panoramas/1.jpg' }, pos: [0, 50, 0], headingDeg: 0 }],
      },
    ],
    severityModels: [
      {
        id: 'tank',
        name: 'Tank, rubber lining',
        levels: [
          { value: 1, label: 'Observation', color: '#9aa3ad', criteria: 'Note' },
          { value: 3, label: 'Medium', color: '#e3c44f', criteria: 'Blisters' },
          { value: 5, label: 'Critical', color: '#e0533f', criteria: 'Leak' },
        ],
        uncertain: { label: 'Uncertain', color: '#777777' },
      },
    ],
    classCatalogues: [],
  };
}

export function mockIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    code: 'F01',
    classId: 'crack',
    severityModelId: 'tank',
    severity: 5,
    status: 'approved',
    title: 'Crack in bottom plate',
    note: '',
    author: 'DR',
    createdAt: '2023-11-22T09:00:00Z',
    updatedAt: '2023-11-22T09:00:00Z',
    sightings: [
      {
        on: 'video',
        layer: 'dji0789',
        track: [{ t: 2_000, geom: { type: 'box', x: 1, y: 2, w: 30, h: 20 } }],
      },
    ],
    source: 'human',
    ...over,
  };
}
