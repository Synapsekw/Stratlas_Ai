// Findings on a model (plan 2026-10-15-findings-on-model) is additive for files 0.11 reads:
// mesh and point-cloud sightings gain an optional `from`, the selection geometry an optional `lod`;
// 0.11's Issue drops what it does not know and keeps reading the issue.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const issue = {
  id: 'i1',
  code: 'F01',
  classId: 'crack',
  severityModelId: 'sev',
  severity: 2,
  status: 'draft',
  title: 'Crack',
  note: '',
  author: 'Demo',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  source: 'agent',
  sightings: [
    { on: 'image', layer: 'photos', photo: 'P1', geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 } },
    {
      on: 'mesh',
      layer: 'model',
      geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] },
      from: { sighting: 0 },
    },
    {
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'selection', src: { path: 'selections/i1-cloud.sel' }, count: 3, lod: 2 },
      from: { sighting: 0 },
    },
  ],
};

describe('findings on a model are additive', () => {
  it('0.11 reads an issue with placed areas', () => {
    expect(current.Issue.safeParse(issue).success).toBe(true);
    expect(v011.Issue.safeParse(issue).success).toBe(true);
  });
});
