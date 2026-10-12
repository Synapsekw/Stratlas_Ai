#!/usr/bin/env node
/* eslint-disable no-console -- script output */
// A project with panoramas on three survey dates (timeline T3), for trying Compare with and the
// Panoramas panes by hand. It is the same synthetic project the e2e specs use
// (apps/desktop/e2e/panoFixtures.ts, createPanoDateProject): keep the two in step.
//
//   projects/e2e-pano-dates/   three surveys (4 Sep, 2 Oct and 6 Nov 2024; captures sep, oct,
//                              nov), each with a model (quad-<id>) and a "Panoramas" layer
//                              (pano-<id>, panoramas p1 to p3 on the ground at x = the date's
//                              xs, z = 0, heading 0); every panorama is a 64 x 32 equirect PNG of
//                              one colour per date
//
//   node tools/demo/pano-dates-demo.mjs --data <data root>
//
// The data root is the folder that holds projects/ (Settings, Data folder). The
// script adds or replaces projects/e2e-pano-dates/ there and touches nothing else.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const PANO_DATE_PROJECT_ID = 'e2e-pano-dates';
export const PANO_DATE_PROJECT_NAME = 'E2E panorama dates';

/** The survey dates, oldest first, with the x of each panorama (as in panoFixtures.ts). */
export const PANO_DATES = [
  { id: 'sep', date: '2024-09-04', xs: [0, 10, 20], rgb: [200, 60, 60] },
  { id: 'oct', date: '2024-10-02', xs: [0, 10, 20], rgb: [60, 160, 60] },
  { id: 'nov', date: '2024-11-06', xs: [2, 11, 60], rgb: [60, 80, 200] },
];

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const repo = fileURLToPath(new URL('../..', import.meta.url));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A solid colour RGB PNG of `width` x `height` pixels. */
export function solidPng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A one-quad glTF binary (as tinyGlb in apps/desktop/e2e/fixtures.ts). */
function tinyGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const gltf = {
    asset: { version: '2.0', generator: 'aio pano dates demo' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'quad' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      {
        buffer: 0,
        byteOffset: positions.byteLength,
        byteLength: indices.byteLength,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [0, 0, -1],
        max: [1, 0, 0],
      },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const body = pad(bin, 0);
  const chunk = (data, type) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const chunks = Buffer.concat([chunk(json, 0x4e4f534a), chunk(body, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.length, 8);
  return Buffer.concat([header, chunks]);
}

/** The project schema from source, so the manifest is checked like the app checks it. */
async function schema() {
  const projectRequire = createRequire(join(repo, 'packages', 'project', 'package.json'));
  const { createJiti } = projectRequire('jiti');
  return createJiti(import.meta.url).import(join(repo, 'packages', 'schema', 'src', 'index.ts'));
}

/** Write (or replace) `projects/e2e-pano-dates/` in `dataRoot`; returns the project folder. */
export async function writePanoDatesProject(dataRoot) {
  const { ProjectManifest, SCHEMA_VERSION } = await schema();
  const dir = join(dataRoot, 'projects', PANO_DATE_PROJECT_ID);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'panoramas'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  for (const d of PANO_DATES) {
    const png = solidPng(64, 32, d.rgb);
    for (let i = 0; i < d.xs.length; i++)
      await writeFile(join(dir, 'panoramas', `${d.id}-p${String(i + 1)}.png`), png);
  }
  const input = {
    schema: SCHEMA_VERSION,
    id: PANO_DATE_PROJECT_ID,
    name: PANO_DATE_PROJECT_NAME,
    customer: 'E2E',
    site: 'Synthetic site, panoramas of 3 dates',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: PANO_DATES.map((d) => ({ id: d.id, label: d.date, date: d.date })),
    layers: PANO_DATES.flatMap((d) => [
      {
        kind: 'mesh',
        id: `quad-${d.id}`,
        name: `Quad ${d.date}`,
        capture: d.id,
        src: { path: 'models/quad.glb' },
        transform: IDENTITY,
      },
      {
        kind: 'panoramas',
        id: `pano-${d.id}`,
        name: 'Panoramas',
        capture: d.id,
        items: d.xs.map((x, i) => ({
          id: `p${String(i + 1)}`,
          src: { path: `panoramas/${d.id}-p${String(i + 1)}.png` },
          pos: [x, 0, 0],
          headingDeg: 0,
        })),
      },
    ]),
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  return dir;
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--data');
  const data = i >= 0 ? argv[i + 1] : undefined;
  if (!data) {
    console.error('Usage: node tools/demo/pano-dates-demo.mjs --data <data root>');
    process.exit(2);
  }
  const dir = await writePanoDatesProject(resolve(data));
  console.log(`Wrote ${dir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
