import { layerRefs } from '@aio/project/builder';
import type { Layer } from '@aio/schema';
import { layerFiles } from '@aio/sync/blobs';
import { describe, expect, it } from 'vitest';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const lens = { model: 'pinhole' as const, hfovDeg: 70, aspect: 1.5 };
const LAYERS: Layer[] = [
  {
    kind: 'mesh',
    id: 'm',
    name: 'm',
    visible: true,
    src: { path: 'models/m.glb' },
    transform: IDENTITY,
  },
  {
    kind: 'pointcloud',
    id: 'pc',
    name: 'pc',
    visible: true,
    src: { path: 'clouds/pc.copc.laz' },
    format: 'copc',
  },
  {
    kind: 'raster',
    id: 'r',
    name: 'r',
    visible: true,
    src: { path: 'rasters/r/tiles.json' },
    role: 'ortho',
    format: 'kit-pyramid',
  },
  {
    kind: 'vector',
    id: 'v',
    name: 'v',
    visible: true,
    src: { path: 'vectors/v.geojson' },
    format: 'geojson',
  },
  {
    kind: 'video',
    id: 'c',
    name: 'c',
    visible: true,
    src: { path: 'video/c.mp4' },
    poster: { path: 'video/c.jpg' },
    flight: { src: { path: 'flights/c.json' }, startUtcMs: 0 },
    lens,
    offsetMs: 0,
  },
  {
    kind: 'walk',
    id: 'walk-w',
    name: 'w',
    visible: true,
    record: { path: 'walks/w/walk.json' },
    src: { path: 'walks/w/playback.mp4' },
    poster: { path: 'walks/w/poster.jpg' },
    durationS: 10,
  },
  {
    kind: 'photos',
    id: 'ph',
    name: 'ph',
    visible: true,
    items: [
      { id: 'a', src: { path: 'photos/a.jpg' } },
      { id: 'b', src: { hash: 'b'.repeat(64) } },
    ],
  },
  {
    kind: 'panoramas',
    id: 'pa',
    name: 'pa',
    visible: true,
    items: [{ id: 'x', src: { path: 'panos/x.jpg' }, pos: [0, 0, 0], headingDeg: 0 }],
  },
];

describe('layerRefs agrees with layerFiles (@aio/sync)', () => {
  for (const layer of LAYERS)
    it(`for a ${layer.kind} layer`, () => {
      const sync = layerFiles({ layers: [layer] })
        .filter((f) => f.sha256 === undefined)
        .map((f) => f.path)
        .sort();
      expect([...layerRefs(layer)].sort()).toEqual(sync);
    });
});
