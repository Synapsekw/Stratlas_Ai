import type { Issue, Layer, ProjectManifest, Vec3 } from '@aio/schema';

/**
 * Synthetic two-date site for the change tests (no client data): two surveys, a model and a
 * posed photo set per date, issues placed by mesh sightings. Photos look straight down from 50 m.
 */

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Looking down (-Y): -90 degrees about X. */
const DOWN = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number];

export const photosAt = (id: string, capture: string, xs: readonly number[]): Layer => ({
  kind: 'photos',
  id,
  name: `Photos ${id}`,
  visible: true,
  capture,
  items: xs.map((x, i) => ({
    id: `${id}-${String(i)}`,
    src: { path: `photos/${id}-${String(i)}.jpg` },
    pos: [x, 50, 0],
    q: DOWN,
    lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.5 },
  })),
});

export const model = (id: string, capture: string | undefined, name = 'Site model'): Layer => ({
  kind: 'mesh',
  id,
  name,
  visible: true,
  ...(capture ? { capture } : {}),
  src: { path: `models/${id}.glb` },
  transform: I,
});

export const SITE: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'synthetic-two-dates',
  name: 'Synthetic two-date site',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'd1', label: 'First survey', date: '2026-03-01' },
    { id: 'd2', label: 'Second survey', date: '2026-09-01' },
  ],
  layers: [
    model('model-d1', 'd1'),
    model('model-d2', 'd2'),
    photosAt('photos-d1', 'd1', [0, 20, 40]),
    photosAt('photos-d2', 'd2', [0, 20, 40]),
  ],
  severityModels: [
    {
      id: 'sev',
      name: 'Four levels',
      levels: [1, 2, 3, 4].map((v) => ({
        value: v,
        label: `Level ${String(v)}`,
        color: '#888888',
        criteria: '',
      })),
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Defects',
      assetType: 'site',
      classes: [
        { id: 'corrosion', label: 'Corrosion', color: '#aa5500', severityModel: 'sev' },
        { id: 'coating', label: 'Coating', color: '#5555aa', severityModel: 'sev' },
      ],
    },
  ],
};

export interface IssueSpec {
  code: string;
  layer: string;
  at: Vec3;
  classId?: string;
  severity?: number;
  areaM2?: number;
  capture?: string;
  createdAt?: string;
  track?: string;
}

export function issue(s: IssueSpec): Issue {
  const t = s.createdAt ?? '2026-09-02T10:00:00Z';
  return {
    id: `i-${s.code.toLowerCase()}`,
    code: s.code,
    classId: s.classId ?? 'corrosion',
    severityModelId: 'sev',
    severity: s.severity ?? 2,
    status: 'reviewed',
    title: s.code,
    note: '',
    author: 'tester',
    createdAt: t,
    updatedAt: t,
    sightings: [{ on: 'mesh', layer: s.layer, geom: { type: 'spoint', p: s.at, n: [0, 1, 0] } }],
    source: 'human',
    ...(s.areaM2 !== undefined
      ? { measurements: [{ kind: 'area' as const, value: s.areaM2, unit: 'm2' as const }] }
      : {}),
    ...(s.capture ? { capture: s.capture } : {}),
    ...(s.track ? { track: s.track } : {}),
  };
}
