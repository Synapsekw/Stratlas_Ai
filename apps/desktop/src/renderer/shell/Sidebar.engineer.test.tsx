// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';

const { engineeringOf } = await import('./Sidebar');
const { engineerUi } = await import('../engineer/ui');

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const layers = [
  { kind: 'pointcloud', id: 'scan', name: 'Scan', visible: true, src: { path: 'c.laz' } },
  { kind: 'mesh', id: 'mesh', name: 'Mesh', visible: true, src: { path: 'm.glb' }, transform: I },
  { kind: 'photos', id: 'shots', name: 'Photos', visible: true, items: [] },
  {
    kind: 'vector',
    id: 'plan',
    name: 'Plan',
    visible: true,
    src: { path: 'p.geojson' },
    format: 'geojson',
  },
] as unknown as Layer[];

afterEach(() => {
  engineerUi.setState({ open: false, preselect: [] });
});

describe('Create engineering model... in the dataset menu', () => {
  it('is offered for one point cloud, model or photos row, not for a vector layer', () => {
    expect(engineeringOf(layers, ['scan'])).toBeTypeOf('function');
    expect(engineeringOf(layers, ['mesh'])).toBeTypeOf('function');
    expect(engineeringOf(layers, ['shots'])).toBeTypeOf('function');
    expect(engineeringOf(layers, ['plan'])).toBeUndefined();
    expect(engineeringOf(layers, ['scan', 'mesh'])).toBeUndefined();
  });

  it('opens the setup with that layer chosen and starts nothing', () => {
    engineeringOf(layers, ['scan'])?.();
    expect(engineerUi.getState()).toMatchObject({ open: true, preselect: ['scan'] });
  });
});
