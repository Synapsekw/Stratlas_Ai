/** Synthetic telecom geometry: a vertical antenna face (mesh or cloud) and a tower with a crown. */
import { ANTENNAS_SCHEMA, AntennasFile, ProjectManifest } from '@aio/schema';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { VENV_PYTHON, tinyManifest } from './fixtures';

/**
 * Write `points` (x, y, z per point, local frame with y up) as a one-chunk `aio.pngcloud/1` cloud:
 * `cloud/<name>.png` and `cloud/index.json`. The PNG carries nine planes of N bytes in its RGB
 * bytes (x, y, z as uint16 low and high bytes over the bounds, then r, g, b). `rgb` is one colour
 * for every point. Returns the point count.
 */
export async function packPngCloud(
  dir: string,
  name: string,
  points: ArrayLike<number>,
  rgb: readonly [number, number, number] = [180, 200, 210],
  spacing = 0.1,
): Promise<number> {
  const count = Math.floor(points.length / 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = points[3 * i + a] ?? 0;
      if (v < (min[a] ?? 0)) min[a] = v;
      if (v > (max[a] ?? 0)) max[a] = v;
    }
  }
  const stream = Buffer.alloc(9 * count);
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const lo = min[a] ?? 0;
      const span = (max[a] ?? 0) - lo;
      // a hair over half rounds up, so a grid point that lies on a half step keeps its quantum
      const t = span > 0 ? ((points[3 * i + a] ?? 0) - lo) / span : 0;
      const q = Math.min(65535, Math.round(t * 65535 + 1e-6));
      stream[2 * a * count + i] = q & 255;
      stream[(2 * a + 1) * count + i] = q >> 8;
    }
    stream[6 * count + i] = rgb[0];
    stream[7 * count + i] = rgb[1];
    stream[8 * count + i] = rgb[2];
  }
  const width = 256;
  const height = Math.ceil(stream.length / (width * 3));
  const pixels = Buffer.alloc(width * height * 3);
  stream.copy(pixels);
  await mkdir(join(dir, 'cloud'), { recursive: true });
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(join(dir, 'cloud', `${name}.png`));
  const bounds = { min, max };
  await writeFile(
    join(dir, 'cloud', 'index.json'),
    JSON.stringify({
      schema: 'aio.pngcloud/1',
      bounds,
      spacing,
      chunks: [{ file: `cloud/${name}.png`, points: count, bounds, lod: 0 }],
    }),
  );
  return count;
}

export async function writeTelecomFace(dir: string, kind: 'mesh' | 'cloud'): Promise<void> {
  const manifest = tinyManifest();
  if (kind === 'mesh') {
    const layer = manifest.layers[0];
    if (layer?.kind !== 'mesh') throw new Error('expected tiny mesh fixture');
    layer.name = 'Synthetic antenna face';
    // Turn the existing unit ground quad upright, 8 m square, from y=1 to y=9.
    layer.transform = [8, 0, 0, 0, 0, 0, 8, 0, 0, -8, 0, 0, -4, 1, 0, 1];
  } else {
    const side = 81;
    const points = new Float64Array(3 * side * side);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const i = y * side + x;
        points[3 * i] = -4 + (8 * x) / (side - 1);
        points[3 * i + 1] = 1 + (8 * y) / (side - 1);
      }
    }
    const count = await packPngCloud(dir, 'face', points);
    manifest.layers = [
      {
        id: 'face-cloud',
        name: 'Synthetic antenna face',
        kind: 'pointcloud',
        visible: true,
        format: 'png-packed',
        src: { path: 'cloud/index.json' },
        pointCount: count,
      },
    ];
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(manifest)));
}

/** One unit of the synth's truth (`_spec` in `antenna_synth.py`), in the local frame (y up). */
export interface TowerTruthUnit {
  name: string;
  kind: 'panel' | 'short' | 'dish' | 'other';
  centre: [number, number, number];
  azimuthDeg: number;
  downtiltDeg?: number;
  plumbDeg?: number;
  widthM: number;
  heightM: number;
  depthM: number;
}

/** What `antenna_synth.py` writes next to the cloud (`<out>.json`). */
export interface TowerTruth {
  units: TowerTruthUnit[];
}

const SYNTH = join(import.meta.dirname, '..', '..', '..', 'python', 'tests', 'antenna_synth.py');

/**
 * The tiny project with one cloud instead of its quad: the synthetic monopole of
 * `python/tests/antenna_synth.py` (seed 3, 1500 points per m2, a crown of panels, a dish and an
 * other unit about 26 to 29 m up) as the png-packed layer `tower-cloud`, in a local grid without
 * a place on the Earth (every azimuth reads project north). Returns the synth's truth.
 * `pointsPerM2` makes the cloud denser: at 2500 the detection finds the radio unit too, and a
 * flagged outline round it measures (at 1500 its faces are too thin for either).
 */
export async function writeTelecomTower(dir: string, pointsPerM2 = 1500): Promise<TowerTruth> {
  const tmp = await mkdtemp(join(tmpdir(), 'aio-tower-'));
  try {
    const out = join(tmp, 'tower.f32');
    await promisify(execFile)(VENV_PYTHON, [
      SYNTH,
      '--kind',
      'monopole',
      '--seed',
      '3',
      '--points-per-m2',
      String(pointsPerM2),
      '--out',
      out,
    ]);
    const raw = await readFile(out);
    const truth = JSON.parse(await readFile(`${out}.json`, 'utf8')) as TowerTruth;
    const xyz = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const count = await packPngCloud(dir, 'tower', xyz, [170, 178, 186], 0.03);
    const manifest = tinyManifest();
    manifest.crs = { wkt: 'LOCAL_CS["Site grid",UNIT["metre",1]]' };
    manifest.origin = [0, 0, 0];
    manifest.layers = [
      {
        id: 'tower-cloud',
        name: 'Tower cloud',
        kind: 'pointcloud',
        visible: true,
        format: 'png-packed',
        src: { path: 'cloud/index.json' },
        pointCount: count,
      },
    ];
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(manifest)));
    return truth;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * The tower fixture's inventory before any unit is found: a detection run on `tower-cloud` round
 * the axis at the origin (crown 25 to 30 m up, 3 m radius, project north) and no units, so a test
 * can flag a unit without running detection first. Writes `telecom/antennas.json`.
 */
export async function writeAntennaInventory(dir: string): Promise<void> {
  const file = AntennasFile.parse({
    schema: ANTENNAS_SCHEMA,
    run: {
      id: 'run-e2e-empty',
      at: '2026-10-22T09:00:00Z',
      params: { run: 'run-e2e-empty' },
      cloudLayer: 'tower-cloud',
      axis: { point: [0, 0, 0], dir: [0, 0, 1], source: 'auto' },
      crown: { floorZ: 25, topZ: 30, radiusM: 3 },
      north: 'project',
      warnings: [],
      counts: { panel: 0, short: 0, dish: 0, other: 0 },
    },
    units: [],
  });
  await mkdir(join(dir, 'telecom'), { recursive: true });
  await writeFile(join(dir, 'telecom', 'antennas.json'), JSON.stringify(file));
}
