// Checks the PDAL transform of alzour-frame.mjs against its JavaScript reference on a few points.
// Usage: node tools/pointcloud/frame-check.mjs <pdal.exe> <work-dir>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pdalStages, toProject } from './alzour-frame.mjs';

const [pdal, work] = process.argv.slice(2);
if (!pdal || !work) throw new Error('usage: frame-check.mjs <pdal.exe> <work-dir>');
const pts = [
  [245714, 3179542, -20],
  [244800.5, 3178800.25, 10.125],
  [246900, 3179900, -5],
  [245200, 3179300, 40],
  [246300, 3179700, 0],
];
const inCsv = join(work, 'frame-in.csv');
const outCsv = join(work, 'frame-out.csv');
writeFileSync(inCsv, ['X,Y,Z', ...pts.map((p) => p.join(','))].join('\n') + '\n');
const pipeline = {
  pipeline: [
    { type: 'readers.text', filename: inCsv },
    ...pdalStages(),
    {
      type: 'writers.text',
      filename: outCsv,
      order: 'X,Y,Z',
      precision: 6,
      keep_unspecified: false,
    },
  ],
};
const pj = join(work, 'frame-check.json');
writeFileSync(pj, JSON.stringify(pipeline, null, 2));
execFileSync(pdal, ['pipeline', pj], { stdio: 'inherit' });
const rows = readFileSync(outCsv, 'utf8').trim().split('\n').slice(1);
let worst = 0;
rows.forEach((r, i) => {
  const got = r.split(',').map(Number);
  const p = pts[i] ?? [0, 0, 0];
  const want = toProject(p[0], p[1], p[2]);
  for (let a = 0; a < 3; a++) worst = Math.max(worst, Math.abs((got[a] ?? 0) - (want[a] ?? 0)));
  process.stdout.write(
    `${p.join(', ')} -> ${got.join(', ')} (reference ${want.map((v) => v.toFixed(6)).join(', ')})\n`,
  );
});
process.stdout.write(`worst difference ${worst.toExponential(2)} m\n`);
if (worst > 1e-5) process.exit(1);
