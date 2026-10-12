// Writes the data of the opt-in M10 benchmark (apps/desktop/e2e/perf-m10-bench.spec.ts): a
// synthetic quadtree mesh tileset of about `--triangles` triangles on its leaves and a synthetic
// COPC point cloud of `--points` points, as a project folder the benchmark opens:
//
//   <out>/data/projects/m10-bench/tiles/bench-mesh/tileset.json   (and t/<level>/<x>_<y>.glb)
//   <out>/data/projects/m10-bench/clouds/bench.copc.laz
//   <out>/bench.json                                             (what was made, to skip a rerun)
//
// Usage: node tools/bench/m10-bench-data.mjs --out <dir> [--points 100e6] [--triangles 20e6]
//                                            [--pdal <pdal.exe>]
//
// The cloud is made in octree cells of at most 10 M points each (PDAL's writers.copc holds every
// point in memory, about 115 bytes a point), then merged byte for byte with
// tools/pointcloud/merge-copc.mjs. PDAL comes from --pdal, AIO_PDAL or E:\Dev\tools\pdal
// (tools/pointcloud/README.md). Synthetic only; runs only in a window the founder gives (heavy).
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** writers.copc slows down sharply above this many points in one run. */
export const MAX_CELL_POINTS = 10e6;
/** Quads per tile side at most (100 x 100 quads: 20 000 triangles a tile). */
export const MAX_QUADS = 100;
/** Edge of the benchmark site in metres, centred on the project origin. */
export const SITE_M = 1024;

/**
 * The shape of the benchmark data. The triangle target counts the leaves (what is drawn fully
 * refined, `REPLACE`); the point cells are 4^k octree cells (merge-copc needs whole cells), the
 * fewest with at most MAX_CELL_POINTS each.
 */
export function planBench({ points = 100e6, triangles = 20e6 } = {}) {
  let depth = 1;
  let quads = 0;
  for (; depth <= 10; depth++) {
    const leaves = 4 ** (depth - 1);
    quads = Math.ceil(Math.sqrt(triangles / (2 * leaves)));
    if (quads <= MAX_QUADS) break;
  }
  const leaves = 4 ** (depth - 1);
  const tiles = (4 ** depth - 1) / 3;
  let level = 0;
  while (points / 4 ** level > MAX_CELL_POINTS) level += 1;
  const cells = 4 ** level;
  return {
    depth,
    quads,
    tiles,
    leaves,
    leafTriangles: leaves * 2 * quads * quads,
    points,
    cellLevel: level,
    cells,
    pointsPerCell: Math.ceil(points / cells),
  };
}

function positive(name, text) {
  const v = Number(text);
  if (!Number.isFinite(v) || v <= 0)
    throw new Error(`--${name} must be a positive number, not "${text}"`);
  return v;
}

function args(argv) {
  const get = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const out = get('out');
  if (!out)
    throw new Error('usage: m10-bench-data.mjs --out <dir> [--points 100e6] [--triangles 20e6]');
  return {
    out,
    points: positive('points', get('points', '100e6')),
    triangles: positive('triangles', get('triangles', '20e6')),
    pdal: get('pdal') ?? process.env.AIO_PDAL ?? 'E:/Dev/tools/pdal/Library/bin/pdal.exe',
  };
}

const E0 = 500000;
const N0 = 3200000;
const Z0 = 0;

/** A deterministic terrain with some relief, heights well inside one octree cell. */
const ground = (x, y) => 4 + 3 * Math.sin(x / 37) * Math.cos(y / 53) + 0.5 * Math.sin(x / 5.3);

function pdalRun(pdal, name, stages, dir) {
  const file = join(dir, `${name}.pipeline.json`);
  writeFileSync(file, JSON.stringify({ pipeline: stages }, null, 2));
  const r = spawnSync(pdal, ['pipeline', file], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`PDAL failed on ${name}`);
}

/** Write `n` points over the square [x0, x0 + size) x [y0, y0 + size) as CSV, plus two anchors. */
async function writeCells(file, n, x0, y0, size, cell, seed) {
  let s = seed;
  // 32-bit LCG in integer arithmetic (a double product would lose the low bits)
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
  const out = createWriteStream(file);
  const write = (line) =>
    out.write(line) ? Promise.resolve() : new Promise((r) => out.once('drain', r));
  await write('X,Y,Z,Red,Green,Blue,Intensity,Classification\n');
  // anchors: the cell's minimum corner and minimum + (cell, 0, 0) make PDAL's cube the cell
  await write(`${(E0 + x0).toFixed(3)},${(N0 + y0).toFixed(3)},${Z0.toFixed(3)},0,0,0,0,7\n`);
  await write(
    `${(E0 + x0 + cell).toFixed(3)},${(N0 + y0).toFixed(3)},${Z0.toFixed(3)},0,0,0,0,7\n`,
  );
  let batch = '';
  for (let i = 0; i < n; i++) {
    const x = x0 + rnd() * size;
    const y = y0 + rnd() * size;
    const z = Z0 + ground(x, y) + 0.05 * rnd();
    const g = Math.round(30000 + 20000 * rnd());
    batch += `${(E0 + x).toFixed(3)},${(N0 + y).toFixed(3)},${z.toFixed(3)},${g},${g},${Math.round(g * 0.8)},${Math.round(rnd() * 60000)},2\n`;
    if (batch.length > 1 << 20) {
      await write(batch);
      batch = '';
    }
  }
  await write(batch);
  await new Promise((r) => out.end(r));
}

const copcWriter = (filename) => ({
  type: 'writers.copc',
  filename,
  a_srs: 'EPSG:32639',
  scale_x: 0.001,
  scale_y: 0.001,
  scale_z: 0.001,
  offset_x: E0,
  offset_y: N0,
  offset_z: Z0,
});

async function writeCloud(o, plan, project, work) {
  const { mergeCopc } = await import('../pointcloud/merge-copc.mjs');
  const n = 2 ** plan.cellLevel;
  const cell = SITE_M / n;
  const tiles = [];
  // the base: a thin sample over the whole site, its cube the whole octree
  const baseCsv = join(work, 'base.csv');
  const whole = plan.cellLevel === 0;
  await writeCells(
    baseCsv,
    whole ? plan.points : Math.min(2e6, plan.points / 50),
    0,
    0,
    SITE_M,
    SITE_M,
    7,
  );
  pdalRun(
    o.pdal,
    'base',
    [{ type: 'readers.text', filename: baseCsv }, copcWriter(join(work, 'base.copc.laz'))],
    work,
  );
  for (let y = 0; y < n && !whole; y++)
    for (let x = 0; x < n; x++) {
      const name = `cell-${String(x)}-${String(y)}`;
      const csv = join(work, `${name}.csv`);
      await writeCells(csv, plan.pointsPerCell, x * cell, y * cell, cell, cell, 11 + y * n + x);
      const copc = join(work, `${name}.copc.laz`);
      pdalRun(o.pdal, name, [{ type: 'readers.text', filename: csv }, copcWriter(copc)], work);
      rmSync(csv, { force: true });
      tiles.push({ file: copc, key: [plan.cellLevel, x, y, 0] });
    }
  mkdirSync(join(project, 'clouds'), { recursive: true });
  const out = join(project, 'clouds', 'bench.copc.laz');
  if (whole) {
    copyFileSync(join(work, 'base.copc.laz'), out);
    return out;
  }
  mergeCopc({
    base: join(work, 'base.copc.laz'),
    maxDepth: Math.max(0, plan.cellLevel - 1),
    tiles,
    out,
    log: (m) => process.stdout.write(`${m}\n`),
  });
  return out;
}

async function writeMesh(plan, project) {
  const here = new URL('.', import.meta.url);
  const { gridGlb } = await import(new URL('../../apps/desktop/e2e/gridGlb.ts', here).href);
  const { writeQuadtreeTileset } = await import(
    new URL('../../apps/desktop/e2e/quadtreeTileset.ts', here).href
  );
  const dir = join(project, 'tiles', 'bench-mesh');
  rmSync(dir, { recursive: true, force: true });
  return writeQuadtreeTileset(dir, {
    depth: plan.depth,
    glb: gridGlb(plan.quads),
    halfM: SITE_M / 2,
    triangles: 2 * plan.quads * plan.quads,
  });
}

async function main() {
  const o = args(process.argv.slice(2));
  const plan = planBench(o);
  const stamp = join(o.out, 'bench.json');
  const project = join(o.out, 'data', 'projects', 'm10-bench');
  const prior = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : {};
  mkdirSync(project, { recursive: true });
  const work = join(o.out, 'work');
  mkdirSync(work, { recursive: true });
  const done = { ...prior };
  if (
    prior.mesh?.triangles !== o.triangles ||
    !existsSync(join(project, 'tiles', 'bench-mesh', 'tileset.json'))
  ) {
    process.stdout.write(
      `mesh: depth ${String(plan.depth)}, ${String(plan.tiles)} tiles, ${String(plan.leafTriangles)} triangles on the leaves\n`,
    );
    done.mesh = { triangles: o.triangles, ...(await writeMesh(plan, project)) };
    writeFileSync(stamp, JSON.stringify(done, null, 2));
  }
  if (prior.cloud?.points !== o.points || !existsSync(join(project, 'clouds', 'bench.copc.laz'))) {
    if (!existsSync(o.pdal)) throw new Error(`No PDAL at ${o.pdal}: pass --pdal or set AIO_PDAL`);
    process.stdout.write(`cloud: ${String(plan.points)} points in ${String(plan.cells)} cells\n`);
    await writeCloud(o, plan, project, work);
    done.cloud = { points: o.points, cells: plan.cells };
    writeFileSync(stamp, JSON.stringify(done, null, 2));
  }
  rmSync(work, { recursive: true, force: true });
  process.stdout.write(`bench data in ${project}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
