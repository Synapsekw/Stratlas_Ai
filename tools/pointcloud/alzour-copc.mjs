// Converts the full-resolution Al-Zour cloud (842 M points) to one COPC file in the project frame.
//
// PDAL's writers.copc holds every point in memory (about 115 bytes a point with 20 threads), so
// the 842 M points are converted as 550 m octree cells (depth 2 of a 2200 m cube) and merged
// byte for byte (merge-copc.mjs). See README.md for the exact commands and timings.
//
// Usage:
//   node tools/pointcloud/alzour-copc.mjs --src <Production_2-Final.laz> --out <alzour.copc.laz>
//        --work <scratch dir> [--pdal <pdal.exe>] [--jobs 4] [--threads 20]
import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pdalStages } from './alzour-frame.mjs';
import { mergeCopc } from './merge-copc.mjs';

const run = promisify(execFile);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const src = arg('src');
const out = arg('out');
const work = arg('work');
const pdal = arg('pdal', process.env.PDAL ?? 'pdal');
const jobs = Number(arg('jobs', '4'));
const threads = Number(arg('threads', '20'));
if (!src || !out || !work) {
  throw new Error(
    'usage: alzour-copc.mjs --src <laz> --out <copc.laz> --work <dir> [--pdal <exe>]',
  );
}
mkdirSync(work, { recursive: true });

/** Octree cube in project CRS (UTM 39N E, N, plant EL), metres; data lies in its lowest z cells. */
const CUBE_MIN = [244770, 3178785, 70];
const CUBE = 2200;
const DEPTH = 2;
const CELL = CUBE / 2 ** DEPTH;
/** Cells with more points are split into four (see step 3). */
const SPLIT_ABOVE = Number(arg('split', '100000000'));
/** Shared by every file so the LAZ chunks can be merged: 1 mm, offset at the cube corner. */
const QUANT = {
  scale_x: 0.001,
  scale_y: 0.001,
  scale_z: 0.001,
  offset_x: 244770,
  offset_y: 3178785,
  offset_z: 0,
};

const log = (m) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);

async function pipeline(name, stages, stream) {
  const file = join(work, `${name}.json`);
  writeFileSync(file, JSON.stringify({ pipeline: stages }, null, 2));
  const t = Date.now();
  await run(pdal, ['pipeline', file, ...(stream ? ['--stream'] : [])], {
    maxBuffer: 64 << 20,
  });
  log(`${name}: ${((Date.now() - t) / 1000).toFixed(0)} s`);
}

/** Point count and bounds from a LAS 1.4 header (LAZ headers are not compressed). */
function lasHeader(file) {
  const fd = openSync(file, 'r');
  const h = Buffer.alloc(375);
  readSync(fd, h, 0, 375, 0);
  closeSync(fd);
  return {
    count: Number(h.readBigUInt64LE(247)) || h.readUInt32LE(107),
    min: [h.readDoubleLE(187), h.readDoubleLE(203), h.readDoubleLE(219)],
    max: [h.readDoubleLE(179), h.readDoubleLE(195), h.readDoubleLE(211)],
  };
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let it = queue.shift(); it; it = queue.shift()) await fn(it);
    }),
  );
}

/** Two class 7 points that make PDAL's cube exactly [min, min + size]. */
function anchors(name, min, size) {
  const file = join(work, `${name}-anchors.csv`);
  writeFileSync(
    file,
    `X,Y,Z,Classification\n${min[0]},${min[1]},${min[2]},7\n${min[0] + size},${min[1]},${min[2]},7\n`,
  );
  return file;
}

function copcWriter(filename) {
  return {
    type: 'writers.copc',
    filename,
    threads,
    a_srs: 'EPSG:32639',
    ...QUANT,
  };
}

const t0 = Date.now();
// 1. cells of the transformed cloud, streamed (low memory), several at a time
const cells = [];
for (let iy = 0; iy < 4; iy++)
  for (let ix = 0; ix < 4; ix++) {
    const x0 = CUBE_MIN[0] + ix * CELL;
    const y0 = CUBE_MIN[1] + iy * CELL;
    const z0 = CUBE_MIN[2];
    cells.push({ ix, iy, name: `cell-${ix}-${iy}`, min: [x0, y0, z0] });
  }
await pool(cells, jobs, async (c) => {
  const laz = join(work, `${c.name}.laz`);
  c.laz = laz;
  if (existsSync(laz)) return;
  const [x0, y0, z0] = c.min;
  // crop bounds are inclusive; the far faces sit 0.5 mm inside so a point lands in one cell only
  const b = `([${x0},${x0 + CELL - 0.0005}],[${y0},${y0 + CELL - 0.0005}],[${z0},${z0 + CELL - 0.0005}])`;
  await pipeline(
    c.name,
    [
      { type: 'readers.las', filename: src },
      ...pdalStages(),
      { type: 'filters.crop', bounds: b },
      {
        type: 'writers.las',
        filename: laz,
        compression: true,
        minor_version: 4,
        dataformat_id: 7,
        ...QUANT,
      },
    ],
    true,
  );
});
const filled = cells
  .map((c) => ({ ...c, head: lasHeader(c.laz) }))
  .filter((c) => {
    if (c.head.count > 0) return true;
    rmSync(c.laz);
    return false;
  });
const total = filled.reduce((s, c) => s + c.head.count, 0);
log(`${filled.length} cells hold ${total.toLocaleString('en')} points`);

// 2. a 1/50 sample of the whole cloud for the two top levels
const sampleLaz = join(work, 'sample.laz');
if (!existsSync(sampleLaz)) {
  await pipeline(
    'sample',
    [
      { type: 'readers.las', filename: src },
      ...pdalStages(),
      { type: 'filters.decimation', step: 50 },
      {
        type: 'writers.las',
        filename: sampleLaz,
        compression: true,
        minor_version: 4,
        dataformat_id: 7,
        ...QUANT,
      },
    ],
    true,
  );
}
const baseCopc = join(work, 'base.copc.laz');
if (!existsSync(baseCopc)) {
  await pipeline('base', [
    { type: 'readers.las', filename: sampleLaz, tag: 'pts' },
    { type: 'readers.text', filename: anchors('base', CUBE_MIN, CUBE), tag: 'anchors' },
    { type: 'filters.merge', inputs: ['pts', 'anchors'] },
    copcWriter(baseCopc),
  ]);
}

// 3. writers.copc slows down sharply above about 100 M points (single-threaded phases and paging
//    on 64 GB), so dense cells are split once more into four depth-3 cells (275 m)
const units = [];
const split = new Set();
for (const c of filled) {
  if (c.head.count <= SPLIT_ABOVE) {
    units.push({ name: c.name, laz: c.laz, min: c.min, size: CELL, key: [DEPTH, c.ix, c.iy, 0] });
    continue;
  }
  split.add(`${DEPTH}-${c.ix}-${c.iy}-0`);
  for (let b = 0; b < 2; b++)
    for (let a = 0; a < 2; a++) {
      const half = CELL / 2;
      const min = [c.min[0] + a * half, c.min[1] + b * half, c.min[2]];
      units.push({
        name: `${c.name}-${a}${b}`,
        laz: join(work, `${c.name}-${a}${b}.laz`),
        min,
        size: half,
        key: [DEPTH + 1, 2 * c.ix + a, 2 * c.iy + b, 0],
        from: c.laz,
      });
    }
}
await pool(
  units.filter((u) => u.from && !existsSync(u.laz)),
  jobs,
  async (u) => {
    const [x0, y0, z0] = u.min;
    const e = u.size - 0.0005;
    await pipeline(
      u.name,
      [
        { type: 'readers.las', filename: u.from },
        { type: 'filters.crop', bounds: `([${x0},${x0 + e}],[${y0},${y0 + e}],[${z0},${z0 + e}])` },
        {
          type: 'writers.las',
          filename: u.laz,
          compression: true,
          minor_version: 4,
          dataformat_id: 7,
          ...QUANT,
        },
      ],
      true,
    );
  },
);
const kept = units.filter((u) => lasHeader(u.laz).count > 0);
const unitTotal = kept.reduce((s, u) => s + lasHeader(u.laz).count, 0);
if (unitTotal !== total) throw new Error(`Splitting lost points: ${unitTotal} of ${total}`);

// 4. one COPC per cell, two at a time (writers.copc is multi-threaded and memory hungry)
await pool(kept, 2, async (u) => {
  u.copc = join(work, `${u.name}.copc.laz`);
  if (existsSync(u.copc)) return;
  await pipeline(`${u.name}-copc`, [
    { type: 'readers.las', filename: u.laz, tag: 'pts' },
    { type: 'readers.text', filename: anchors(u.name, u.min, u.size), tag: 'anchors' },
    { type: 'filters.merge', inputs: ['pts', 'anchors'] },
    copcWriter(u.copc),
  ]);
});

// 5. merge: the base brings depths 0 and 1 (and depth 2 over split cells), each cell the rest
const bounds = {
  min: [0, 1, 2].map((a) => Math.min(...filled.map((c) => c.head.min[a]))),
  max: [0, 1, 2].map((a) => Math.max(...filled.map((c) => c.head.max[a]))),
};
const r = mergeCopc({
  base: baseCopc,
  keepBase: (k) => k[0] < DEPTH || (k[0] === DEPTH && split.has(k.join('-'))),
  tiles: kept.map((u) => ({ file: u.copc, key: u.key })),
  out,
  bounds,
  log,
});
log(
  `${out}: ${r.nodes} nodes, ${r.points.toLocaleString('en')} points (${total.toLocaleString('en')} ` +
    `from the cells), ${(r.bytes / 2 ** 30).toFixed(2)} GiB in ${((Date.now() - t0) / 60000).toFixed(1)} min`,
);
