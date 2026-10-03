/** Small synthetic project for unit tests. No client data. */
import type { Issue, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';

export const T0 = Date.UTC(2023, 1, 21, 15, 11, 0);

export function fixtureManifest(): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'p1',
    name: 'Tank farm',
    customer: 'Acme',
    site: 'North',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [],
    layers: [
      {
        kind: 'mesh',
        id: 'm1',
        name: 'Plant mesh',
        visible: true,
        src: { path: 'models/plant.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        tags: [{ node: 'tank_0002', tag: '20-T-0002' }],
      },
      {
        kind: 'pointcloud',
        id: 'pc1',
        name: 'Cloud',
        visible: false,
        src: { path: 'clouds/c.bin' },
        format: 'kit-packed',
      },
      {
        kind: 'video',
        id: 'v1',
        name: 'DJI_0789',
        visible: true,
        src: { path: 'video/DJI_0789.mp4' },
        flight: { src: { path: 'flights/DJI_0789.json' }, startUtcMs: T0 },
        lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.7778 },
        offsetMs: 0,
      },
      {
        kind: 'video',
        id: 'v2',
        name: 'DJI_0790',
        visible: true,
        src: { path: 'video/DJI_0790.mp4' },
        flight: { src: { path: 'flights/DJI_0790.json' }, startUtcMs: T0 + 600_000 },
        lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.7778 },
        offsetMs: 0,
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Five levels',
        levels: [1, 2, 3, 4, 5].map((value) => ({
          value,
          label: `S${value}`,
          color: '#aabbcc',
          criteria: '',
        })),
        uncertain: { label: 'Uncertain', color: '#999999' },
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Tanks',
        assetType: 'tank',
        classes: [
          { id: 'corrosion', label: 'Corrosion', color: '#aa0000', severityModel: 'sev' },
          { id: 'coating', label: 'Coating damage', color: '#00aa00', severityModel: 'sev' },
        ],
      },
    ],
  };
}

export function fixtureIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    code: 'D01',
    classId: 'corrosion',
    severityModelId: 'sev',
    severity: 4,
    status: 'reviewed',
    title: 'Roof corrosion',
    note: 'Near the vent',
    author: 'DR',
    createdAt: '2023-02-22T10:00:00Z',
    updatedAt: '2023-02-22T10:00:00Z',
    sightings: [{ on: 'mesh', layer: 'm1', geom: { type: 'spoint', p: [0, 70, 0], n: [0, 1, 0] } }],
    source: 'human',
    ...over,
  };
}

export function fixtureWorkspace() {
  const ws = createWorkspace();
  ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, [
    fixtureIssue(),
    fixtureIssue({ id: 'i2', code: 'D02', severity: 2, status: 'draft', title: 'Paint' }),
    fixtureIssue({ id: 'i3', code: 'F01', classId: 'coating', severity: 5, status: 'closed' }),
  ]);
  return ws;
}
