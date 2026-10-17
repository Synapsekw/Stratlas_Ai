import type {
  ClassCatalogue,
  Issue,
  Layer,
  ProjectManifest,
  SeverityModel,
  Sighting,
} from '@aio/schema';
import type { IssueContext } from './model/ops';

/** Shared fixtures for unit tests (not exported from the package). */
export const NOW = '2026-10-03T10:00:00.000Z';
export const LATER = '2026-10-03T11:00:00.000Z';

export const tankModel: SeverityModel = {
  id: 'tank-1-5',
  name: 'Tank, rubber lining',
  levels: [
    { value: 1, label: 'Observation', color: '#8a94a6', criteria: 'No action' },
    { value: 2, label: 'Low', color: '#5b9bd5', criteria: 'Note' },
    { value: 3, label: 'Medium', color: '#e8c547', criteria: 'Monitor' },
    { value: 4, label: 'High', color: '#f08a3e', criteria: 'Plan repair' },
    { value: 5, label: 'Critical', color: '#e5484d', criteria: 'Repair now' },
  ],
  uncertain: { label: 'Uncertain', color: '#b68ef8' },
};

export const strictModel: SeverityModel = {
  id: 'road-3',
  name: 'Road distress',
  levels: [
    { value: 1, label: 'Low', color: '#5b9bd5', criteria: 'L' },
    { value: 2, label: 'Medium', color: '#e8c547', criteria: 'M' },
    { value: 3, label: 'High', color: '#e5484d', criteria: 'H' },
  ],
};

export const catalogue: ClassCatalogue = {
  id: 'tank',
  name: 'Tank defects',
  assetType: 'tank',
  classes: [
    { id: 'crack', label: 'Crack', color: '#e5484d', hotkey: 'c', severityModel: 'tank-1-5' },
    {
      id: 'blister',
      label: 'Coating blister',
      color: '#e8c547',
      hotkey: 'b',
      severityModel: 'tank-1-5',
    },
    { id: 'pothole', label: 'Pothole', color: '#5b9bd5', hotkey: 'p', severityModel: 'road-3' },
  ],
};

export const ctx: IssueContext = { models: [tankModel, strictModel], catalogues: [catalogue] };

export const meshSighting: Sighting = {
  on: 'mesh',
  layer: 'tank',
  geom: { type: 'spoint', p: [1, 2, 3], n: [0, 1, 0] },
};

export const photoSighting: Sighting = {
  on: 'image',
  layer: 'photos',
  photo: 'F01',
  geom: { type: 'box', x: 10, y: 20, w: 30, h: 40 },
};

export const videoSighting: Sighting = {
  on: 'video',
  layer: 'f108',
  track: [{ t: 1, geom: { type: 'box', x: 0, y: 0, w: 10, h: 10 } }],
};

export function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    code: 'F01',
    classId: 'crack',
    severityModelId: 'tank-1-5',
    severity: 5,
    status: 'draft',
    title: 'Crack in bottom plate',
    note: '',
    author: 'DR',
    createdAt: NOW,
    updatedAt: NOW,
    sightings: [meshSighting],
    source: 'human',
    ...over,
  };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const datedMesh = (id: string, capture: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: IDENTITY,
  capture,
});

/**
 * Two survey dates, d2 lined up 2 m east: `model-d2`, `cloud-d2`, `ortho-d2` and `photos-d2`
 * take the shift, `model-d1` does not.
 */
export const linedUp: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'demo',
  name: 'Demo',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [
    { id: 'd1', label: 'First', date: '2026-01-10' },
    {
      id: 'd2',
      label: 'Second',
      date: '2026-02-10',
      lineUp: { eastM: 2, northM: 0, with: 'd1', at: '2026-10-16T08:00:00Z' },
    },
  ],
  layers: [
    datedMesh('model-d1', 'd1'),
    datedMesh('model-d2', 'd2'),
    {
      kind: 'pointcloud',
      id: 'cloud-d2',
      name: 'Cloud',
      visible: true,
      src: { path: 'clouds/c.copc.laz' },
      format: 'copc',
      capture: 'd2',
    },
    {
      kind: 'raster',
      id: 'ortho-d2',
      name: 'Ortho',
      visible: true,
      src: { path: 'rasters/o.tif' },
      role: 'ortho',
      format: 'cog',
      capture: 'd2',
    },
  ],
  severityModels: [tankModel],
  classCatalogues: [catalogue],
};
