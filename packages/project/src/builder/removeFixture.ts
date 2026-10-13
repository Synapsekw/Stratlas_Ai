import type { Layer } from '@aio/schema';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createProject, readManifestFile, writeManifestFile } from './create';
import type { PlanJob } from './removePlan';

/*
 * One project with every kind of dependent a removal must find (delete and start over, 13 Oct
 * 2026): a photos layer under date c1 with a finished run (two map layers by `outputs`, a 3D
 * tileset by `run`, a comparison into date c2 with its heat layer, a tileset `from` its DSM, a
 * prepared surface and a cleaned copy), a run that failed mid-commit (a `<run>-ortho` layer the run
 * does not list, a job folder), a run read from folders outside the project, two clips sharing a
 * flight file, two meshes sharing a model file, a detection pass, two issues, and date c3 that a
 * volume names. Survey dates: c1 12 Oct, c2 26 Oct, c3 2 Nov 2026.
 */

export const RUN_DONE = '20261012-0815';
export const RUN_FAILED = '20261012-0930';
export const RUN_FOLDERS = '20261013-0700';
export const OUTSIDE = 'C:/Survey photos/12 Oct';
export const FIXTURE_JOBS: PlanJob[] = [
  { id: 'job-done', pipeline: 'photo.products', status: 'done', params: { run: RUN_DONE } },
  { id: 'job-failed', pipeline: 'photo.align', status: 'failed', params: { run: RUN_FAILED } },
];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

type Raster = Extract<Layer, { kind: 'raster' }>;
const raster = (id: string, capture?: string, derived?: Raster['derived']): Raster => ({
  kind: 'raster',
  id,
  name: id,
  visible: true,
  src: { path: `rasters/${id}/tiles.json` },
  role: 'dsm',
  format: 'kit-pyramid',
  ...(capture ? { capture } : {}),
  ...(derived ? { derived } : {}),
});

export async function makeRemoveProject(): Promise<{ dir: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'aio-remove-'));
  const { root } = await createProject(dir, {
    name: 'Remove',
    type: 'inspection',
    epsg: 32639,
    origin: [500000, 3200000, 0],
    severityTemplate: null,
  });
  const put = async (rel: string, text = 'x') => {
    const f = join(root, ...rel.split('/'));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, text);
  };
  const json = (rel: string, v: unknown) => put(rel, JSON.stringify(v));
  const lens = { model: 'pinhole' as const, hfovDeg: 70, aspect: 1.5 };
  const clip = (id: string): Layer => ({
    kind: 'video',
    id,
    name: id,
    visible: true,
    src: { path: `video/${id}.mp4` },
    flight: { src: { path: 'flights/f1.json' }, startUtcMs: 0 },
    lens,
    offsetMs: 0,
  });
  const mesh = (id: string): Layer => ({
    kind: 'mesh',
    id,
    name: id,
    visible: true,
    src: { path: 'models/shared.glb' },
    transform: IDENTITY,
  });
  const m0 = await readManifestFile(root);
  await writeManifestFile(root, {
    ...m0,
    captures: [
      { id: 'c1', label: 'Survey', date: '2026-10-12' },
      { id: 'c2', label: 'Survey', date: '2026-10-26' },
      { id: 'c3', label: 'Survey', date: '2026-11-02' },
    ],
    layers: [
      ...m0.layers,
      {
        kind: 'photos',
        id: 'photos-a',
        name: 'Flight A',
        visible: true,
        capture: 'c1',
        items: [
          { id: 'p1', src: { path: 'photos/p1.jpg' } },
          { id: 'p2', src: { path: 'photos/p2.jpg' } },
        ],
      },
      raster(`${RUN_DONE}-ortho`, 'c1'),
      raster(`${RUN_DONE}-dsm`, 'c1'),
      raster(`${RUN_FAILED}-ortho`),
      raster('dsm-b', 'c2'),
      raster('chg-1-heat', 'c2', {
        kind: 'change',
        changeId: 'chg-1',
        from: 'c1',
        to: 'c2',
        source: [`${RUN_DONE}-dsm`, 'dsm-b'],
      }),
      raster('dsm-c', 'c3'),
      clip('clip-1'),
      clip('clip-2'),
      mesh('mesh-a'),
      mesh('mesh-b'),
    ],
  });
  for (const p of [
    'photos/p1.jpg',
    'photos/p2.jpg',
    'photos/thumbs/p1.jpg',
    'video/clip-1.mp4',
    'video/clip-2.mp4',
    'flights/f1.json',
    'models/shared.glb',
    `sources/${RUN_DONE}-ortho.json`,
    'jobs/job-done/job.log',
    'jobs/job-failed/job.log',
    'change/chg-1/stats.json',
  ])
    await put(p);
  for (const id of [
    `${RUN_DONE}-ortho`,
    `${RUN_DONE}-dsm`,
    `${RUN_FAILED}-ortho`,
    'dsm-b',
    'chg-1-heat',
    'dsm-c',
  ])
    await put(`rasters/${id}/tiles.json`, '{}');
  const run = (id: string, status: string, source: unknown, layers: string[], tilesets: string[]) =>
    json(`photogrammetry/${id}/run.json`, {
      schema: 'aio.photo-run/1',
      id,
      status,
      preset: 'standard',
      photos: { source, count: 2 },
      outputs: { layers, tilesets, files: [] },
    });
  await run(
    RUN_DONE,
    'done',
    { layer: 'photos-a' },
    [`${RUN_DONE}-ortho`, `${RUN_DONE}-dsm`],
    [`${RUN_DONE}-mesh`],
  );
  await run(RUN_FAILED, 'failed', { layer: 'photos-a' }, [], []);
  await run(RUN_FOLDERS, 'failed', { folders: [OUTSIDE] }, [], []);
  await json('change/chg-1.json', {
    id: 'chg-1',
    from: 'c1',
    to: 'c2',
    producer: 'change.raster',
    items: [{ id: 'i1', layerFrom: `${RUN_DONE}-dsm`, layerTo: 'dsm-b' }],
    layers: ['chg-1-heat'],
  });
  const ts = (id: string, extra: Record<string, string>) => ({
    id,
    name: id,
    kind: 'mesh',
    src: `tiles/${id}/tileset.json`,
    visible: true,
    ...extra,
  });
  await json('tilesets.json', {
    schema: 'aio.tilesets/1',
    entries: [
      ts(`${RUN_DONE}-mesh`, { run: RUN_DONE }),
      ts('dsm-tiles', { from: `${RUN_DONE}-dsm` }),
      ts('b-tiles', { from: 'dsm-b' }),
    ],
  });
  for (const id of [`${RUN_DONE}-mesh`, 'dsm-tiles', 'b-tiles'])
    await put(`tiles/${id}/tileset.json`, '{}');
  const surface = (id: string, source: unknown) =>
    json(`survey/surfaces/${id}/tiles.json`, { schema: 'aio.height-tiles/1', id, source });
  await surface('s-a', { kind: 'dsm', layer: `${RUN_DONE}-dsm` });
  await surface('s-a-clean', { kind: 'derived', of: 's-a', edits: [] });
  await surface('s-b', { kind: 'dsm', layer: 'dsm-b' });
  await json('detections/pass-1.json', {
    schema: 'aio.detections/1',
    layer: 'photos-a',
    detections: [],
  });
  await json('detections/pass-2.json', {
    schema: 'aio.detections/1',
    layer: 'other',
    detections: [],
  });
  await json('issues.json', {
    schema: 'aio.issues/1',
    issues: [
      { id: 'i-a', sightings: [{ on: 'image', layer: 'photos-a' }] },
      { id: 'i-b', sightings: [{ on: 'map', layer: 'dsm-b' }] },
    ],
  });
  await json('volumes.json', {
    schema: 'aio.volumes/1',
    piles: [],
    captures: [{ captureId: 'c3' }],
  });
  return { dir, root };
}
