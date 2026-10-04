// Test fixtures for the exporters: a small project with every kind of sighting.
import { ProjectManifest, type Issue } from '@aio/schema';

export const ORIGIN: [number, number, number] = [245714, 3179542, 100];

export function sampleManifest(): ProjectManifest {
  return ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'site',
    name: 'Sample site',
    customer: 'ACME',
    site: 'Kuwait',
    crs: { epsg: 32639 },
    origin: ORIGIN,
    captures: [{ id: 'c1', label: 'Survey', date: '2026-01-02' }],
    layers: [
      {
        kind: 'mesh',
        id: 'model',
        name: 'Model',
        src: { path: 'models/model.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      {
        kind: 'photos',
        id: 'photos',
        name: 'Photos',
        items: [
          { id: 'p1', src: { path: 'photos/p1.jpg' } },
          { id: 'p2', src: { path: 'photos/p2.jpg' } },
          { id: 'p3', src: { path: 'photos/p3.jpg' } },
        ],
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Facade',
        levels: [
          { value: 1, label: 'Minor', color: '#fad34b', criteria: 'Monitor' },
          { value: 3, label: 'Severe', color: '#ee3f4b', criteria: 'Act' },
        ],
        uncertain: { label: 'Uncertain', color: '#b68ef8' },
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Facade classes',
        assetType: 'facade',
        classes: [
          { id: 'glazing', label: 'Glazing damage', color: '#ee3f4b', severityModel: 'sev' },
          { id: 'sealant', label: 'Sealant failure', color: '#ff7a2d', severityModel: 'sev' },
        ],
      },
    ],
  });
}

const base = {
  severityModelId: 'sev',
  status: 'approved' as const,
  note: '',
  author: 'Reviewer',
  createdAt: '2026-01-02T10:00:00Z',
  updatedAt: '2026-01-02T10:00:00Z',
  source: 'human' as const,
};

export function sampleIssues(): Issue[] {
  return [
    {
      ...base,
      id: 'i-glass',
      code: 'D002',
      classId: 'glazing',
      severity: 3,
      title: 'Cracked pane, "north" bay',
      note: 'Crack across the pane, 5–10 cm\nLocation: 74.4 m above datum, East side, Roof and crown.',
      sightings: [
        { on: 'mesh', layer: 'model', geom: { type: 'spoint', p: [10, 2, -20], n: [0, 0, 1] } },
        {
          on: 'image',
          layer: 'photos',
          photo: 'p1',
          geom: { type: 'box', x: 10, y: 20, w: 30, h: 40 },
        },
        {
          on: 'image',
          layer: 'photos',
          photo: 'p2',
          geom: { type: 'mask', src: { path: 'photos/masks/p2_mask.png' } },
        },
      ],
    },
    {
      ...base,
      id: 'i-seal',
      code: 'D001',
      classId: 'sealant',
      severity: 'uncertain',
      title: 'Sealant gap',
      sightings: [
        {
          on: 'image',
          layer: 'photos',
          photo: 'p1',
          geom: {
            type: 'polygon',
            points: [
              [50, 50],
              [60, 50],
              [60, 70],
            ],
          },
        },
        {
          on: 'mesh',
          layer: 'model',
          geom: {
            type: 'spolygon',
            points: [
              [0, 0, 0],
              [2, 0, 0],
              [2, 0, -2],
            ],
          },
        },
      ],
    },
    {
      ...base,
      id: 'i-map',
      code: 'D010',
      classId: 'glazing',
      severity: 1,
      title: 'Map only',
      note: 'Area: Bottom plate.',
      sightings: [
        {
          on: 'map',
          layer: 'ortho',
          geojson: { type: 'Point', coordinates: [48.0, 28.7] },
        },
      ],
    },
  ];
}
