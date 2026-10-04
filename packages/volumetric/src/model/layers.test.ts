import type { Layer, VolumeCapture } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { pileNode, surveyLayers } from './layers';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const layers: Layer[] = [
  {
    kind: 'mesh',
    id: 'terrain-2021-01-10',
    name: 'Terrain 10 Jan 2021',
    visible: true,
    src: { path: 'a.glb' },
    transform: I,
    tags: [{ node: 'P01_e2', tag: 'P01' }],
  },
  {
    kind: 'mesh',
    id: 'terrain-2020-12-31',
    name: 'Terrain 31 Dec 2020',
    visible: false,
    src: { path: 'b.glb' },
    transform: I,
    tags: [{ node: 'P01_e1', tag: 'P01' }],
  },
  {
    kind: 'raster',
    id: 'ortho-2021-01-10',
    name: 'Ortho 10 Jan 2021',
    visible: true,
    src: { path: 'r/tiles.json' },
    role: 'ortho',
    format: 'kit-pyramid',
  },
  {
    kind: 'raster',
    id: 'ortho-2020-12-31',
    name: 'Ortho 31 Dec 2020',
    visible: false,
    src: { path: 'q/tiles.json' },
    role: 'ortho',
    format: 'kit-pyramid',
  },
];
const captures: VolumeCapture[] = [
  { epoch: 'e1', captureId: 's1', date: '2020-12-31', label: '31 Dec 2020' },
  { epoch: 'e2', captureId: 's2', date: '2021-01-10', label: '10 Jan 2021' },
];

describe('surveyLayers', () => {
  it('finds each survey terrain by its pile nodes and its ortho by date', () => {
    expect(surveyLayers(layers, captures)).toEqual({
      e1: { terrain: 'terrain-2020-12-31', layers: ['terrain-2020-12-31', 'ortho-2020-12-31'] },
      e2: { terrain: 'terrain-2021-01-10', layers: ['terrain-2021-01-10', 'ortho-2021-01-10'] },
    });
  });

  it('uses the layers named in volumes.json when given', () => {
    const named = captures.map((c) => ({
      ...c,
      layers: [c.epoch === 'e1' ? 'ortho-2020-12-31' : 'terrain-2021-01-10'],
    }));
    const r = surveyLayers(layers, named);
    expect(r.e1).toEqual({ terrain: null, layers: ['ortho-2020-12-31'] });
    expect(r.e2).toEqual({ terrain: 'terrain-2021-01-10', layers: ['terrain-2021-01-10'] });
  });
});

describe('pileNode', () => {
  it('names the GLB node of a pile on a survey', () => {
    expect(pileNode('P07', 'e2', { node: 'P07_e2' })).toBe('P07_e2');
    expect(pileNode('P07', 'e2', undefined)).toBe('P07_e2');
  });
});
