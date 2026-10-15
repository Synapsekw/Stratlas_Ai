import type { Issue, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { hasPhotoShape, layerChoices } from './layers';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
  layers: [
    {
      kind: 'mesh',
      id: 'model-d1',
      name: 'Model 1 Mar',
      visible: false,
      capture: 'd1',
      src: { path: 'a.glb' },
      transform: I,
    },
    {
      kind: 'mesh',
      id: 'model-d2',
      name: 'Model 3 Sep',
      visible: true,
      capture: 'd2',
      src: { path: 'b.glb' },
      transform: I,
    },
    {
      kind: 'pointcloud',
      id: 'cloud-d2',
      name: 'Cloud 3 Sep',
      visible: false,
      capture: 'd2',
      src: { path: 'c.json' },
      format: 'png-packed',
    },
    { kind: 'photos', id: 'photos-d2', name: 'Photos', visible: true, capture: 'd2', items: [] },
  ],
} as unknown as Pick<ProjectManifest, 'layers'>;
const dates = { of: { 'model-d1': 'd1', 'model-d2': 'd2', 'cloud-d2': 'd2', 'photos-d2': 'd2' } };
const onPhoto = {
  sightings: [
    { on: 'image', layer: 'photos-d2', photo: 'P', geom: { type: 'box', x: 0, y: 0, w: 1, h: 1 } },
  ],
} as unknown as Issue;

describe('layer choices', () => {
  it('lists meshes and clouds, the photos date first', () => {
    expect(layerChoices(manifest, dates, [onPhoto]).map((c) => [c.id, c.kind, c.sameDate])).toEqual(
      [
        ['model-d2', 'mesh', true],
        ['cloud-d2', 'pointcloud', true],
        ['model-d1', 'mesh', false],
      ],
    );
    expect(layerChoices(manifest, null, [onPhoto]).map((c) => c.id)).toEqual([
      'model-d1',
      'model-d2',
      'cloud-d2',
    ]);
  });

  it('knows which issues have a photo or frame shape to place', () => {
    expect(hasPhotoShape(onPhoto)).toBe(true);
    const point = {
      sightings: [{ on: 'image', layer: 'p', photo: 'P', geom: { type: 'point', x: 0, y: 0 } }],
    } as unknown as Issue;
    expect(hasPhotoShape(point)).toBe(false);
    const pin = {
      sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
    } as unknown as Issue;
    expect(hasPhotoShape(pin)).toBe(false);
  });
});
