import type { Issue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { LATER, NOW, meshSighting } from '../testing';
import { findingPoint, moveFindingPoint } from './findingPoint';

const base: Issue = {
  id: 'i1',
  code: 'F01',
  classId: 'crack',
  severityModelId: 'tank',
  severity: 2,
  status: 'draft',
  title: 'Crack',
  note: '',
  author: 'import',
  createdAt: NOW,
  updatedAt: NOW,
  source: 'import',
  sightings: [{ on: 'pointcloud', layer: 'cloud-a', geom: { type: 'point3', p: [1, 2, 3] } }],
  external: {
    source: 'flyability',
    poi: 'poi-1',
    snapshots: ['s1'],
    wallDistanceM: 0.4,
    hitDistanceM: 0.9,
    locationCheck: 'disagrees',
  },
};

describe('findingPoint', () => {
  it('moving replaces the point and marks the check moved', () => {
    const moved = moveFindingPoint(base, 'cloud-b', [4, 5, 6], LATER);
    expect(findingPoint(moved)).toEqual({ layer: 'cloud-b', p: [4, 5, 6] });
    expect(moved.sightings).toHaveLength(1);
    expect(moved.external?.locationCheck).toBe('moved');
    expect(moved.updatedAt).toBe(LATER);
    expect(base.external?.locationCheck).toBe('disagrees');
  });

  it('an issue without a cloud point gains one', () => {
    const plain: Issue = { ...base, external: undefined, sightings: [meshSighting] };
    expect(findingPoint(plain)).toBeNull();
    const moved = moveFindingPoint(plain, 'cloud-a', [7, 8, 9], LATER);
    expect(moved.sightings).toHaveLength(2);
    expect(findingPoint(moved)).toEqual({ layer: 'cloud-a', p: [7, 8, 9] });
    expect(moved.external).toBeUndefined();
  });

  it('a moved imported issue counts as edited for the merge', () => {
    const moved = moveFindingPoint(base, 'cloud-a', [0, 0, 0], LATER);
    expect(moved.updatedAt).not.toBe(moved.createdAt);
  });
});
