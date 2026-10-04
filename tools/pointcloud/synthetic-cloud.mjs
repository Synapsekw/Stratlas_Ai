// Writes a synthetic point cloud as CSV (X,Y,Z,Red,Green,Blue,Intensity,Classification) for the
// COPC test fixture: a 40 x 40 m ground grid (class 2) around E 500000, N 3200000 with a 10 m
// building block (class 6) and a few trees (class 5). Deterministic; no client data.
// Usage: node tools/pointcloud/synthetic-cloud.mjs <out.csv> [points]
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
const total = Number(process.argv[3] ?? 40000);
if (!out) throw new Error('usage: synthetic-cloud.mjs <out.csv> [points]');

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const rows = ['X,Y,Z,Red,Green,Blue,Intensity,Classification'];
const E0 = 500000;
const N0 = 3200000;
for (let i = 0; i < total; i++) {
  const r = rnd();
  let x, y, z, c, col;
  if (r < 0.6) {
    x = rnd() * 40;
    y = rnd() * 40;
    z = 0.05 * Math.sin(x) + 0.02 * rnd();
    c = 2;
    col = [120, 110, 90];
  } else if (r < 0.9) {
    // building: roof and walls of a 10 x 10 x 10 m block at (15..25, 15..25)
    const f = Math.floor(rnd() * 5);
    const a = rnd() * 10;
    const b = rnd() * 10;
    [x, y, z] = [
      [15 + a, 15 + b, 10],
      [15, 15 + a, b],
      [25, 15 + a, b],
      [15 + a, 15, b],
      [15 + a, 25, b],
    ][f];
    c = 6;
    col = [200, 60, 50];
  } else {
    const t = Math.floor(rnd() * 3);
    const [cx, cy] = [
      [5, 5],
      [35, 8],
      [8, 33],
    ][t];
    const h = rnd() * 6;
    const rad = (1 - h / 6) * 2 * Math.sqrt(rnd());
    const th = rnd() * Math.PI * 2;
    x = cx + rad * Math.cos(th);
    y = cy + rad * Math.sin(th);
    z = h;
    c = 5;
    col = [40, 140, 50];
  }
  const shade = 0.8 + 0.2 * rnd();
  const [R, G, B] = col.map((v) => Math.round(v * shade * 256));
  const I = Math.round(rnd() * 60000);
  rows.push(
    `${(E0 + x).toFixed(3)},${(N0 + y).toFixed(3)},${z.toFixed(3)},${R},${G},${B},${I},${c}`,
  );
}
writeFileSync(out, rows.join('\n') + '\n');
process.stdout.write(`${total} points -> ${out}\n`);
