import type { Layer, ProjectManifest } from '@aio/schema';

/** Three survey dates (sep, oct, nov 2024), a model and a clip on each, and one undated layer. */
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mesh = (id: string, capture?: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  capture,
  src: { path: `models/${id}.glb` },
  transform: I,
});
const video = (id: string, capture: string): Layer =>
  ({
    kind: 'video',
    id,
    name: id,
    visible: true,
    capture,
    src: { path: `video/${id}.mp4` },
    flight: { startUtcMs: 0 },
    offsetMs: 0,
  }) as unknown as Layer;

export const threeDates = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'sep', label: 'Sep', date: '2024-09-04' },
    { id: 'oct', label: 'Oct', date: '2024-10-02' },
    { id: 'nov', label: 'Nov', date: '2024-11-06' },
  ],
  layers: [
    mesh('model-sep', 'sep'),
    mesh('model-oct', 'oct'),
    mesh('model-nov', 'nov'),
    video('clip-sep', 'sep'),
    video('clip-oct', 'oct'),
    video('clip-nov', 'nov'),
    mesh('site'),
  ],
} as unknown as ProjectManifest;
