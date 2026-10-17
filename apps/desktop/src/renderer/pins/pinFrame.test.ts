import { ProjectManifest, type Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { toDraw, toStore } from './pinFrame';

const m = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32633 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
});

describe('pinFrame', () => {
  it('round-trips a point through draw and store', () => {
    const p: Vec3 = [1.5, -2, 30];
    expect(toStore(toDraw(p, m, 'ph'), m, 'ph')).toEqual(p);
  });

  it('is the identity for any layer today', () => {
    expect(toDraw([1, 2, 3], m, 'any')).toEqual([1, 2, 3]);
    expect(toStore([1, 2, 3], m, 'other')).toEqual([1, 2, 3]);
  });
});
