import type { ClassCatalogue, Issue, SeverityModel, Sighting } from '@aio/schema';
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
