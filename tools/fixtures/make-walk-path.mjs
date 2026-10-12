#!/usr/bin/env node
/* eslint-disable no-console -- generator output */
// Synthetic walk fixtures for the walk layer and placing (data-conventions section 32):
//
//   node tools/fixtures/make-walk-path.mjs
//
// writes into packages/schema/src/__fixtures__/walk/:
//   raw-path.synthetic.json        aio.walkpath/1, every still registered, one reconstruction
//   raw-path.broken.json           the same walk, registration lost for t in [30, 38], the stills
//                                  after it a second reconstruction (segment 1, its own raw frame)
//   orientation.synthetic.json     aio.walkorient/1 header, 200 Hz, startOffsetS 0
//   orientation.synthetic.bin      its records, five float32 LE each: [t, qx, qy, qz, qw]
//
// The ground truth (an L-shaped walk, 40 m east then 30 m north at 1.2 m/s after 4 s standing,
// in a raw frame turned by 37 degrees about up, scaled by 0.23 and shifted by [3, -1, 7]) is in
// tools/fixtures/walk-truth.mjs, `GROUND_TRUTH`. Deterministic: no randomness, no clock, so a
// second run gives the same bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { GROUND_TRUTH, GROUND_TRUTH_SEGMENT_1, WALK } from './walk-truth.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = join(root, 'packages/schema/src/__fixtures__/walk');

const DEG = Math.PI / 180;
const round = (v, places = 6) => {
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

const legLength = ([dx, dz]) => Math.hypot(dx, dz);
const totalM = WALK.legs.reduce((s, l) => s + legLength(l), 0);
const endT = WALK.standS + totalM / WALK.speedMps;
/** When the walker reaches the corner between the two legs. */
const cornerT = WALK.standS + legLength(WALK.legs[0]) / WALK.speedMps;

/** Metres walked at time t. */
const walked = (t) => Math.min(Math.max(0, t - WALK.standS) * WALK.speedMps, totalM);

/** Camera position in the model frame at time t. */
function modelPos(t) {
  let left = walked(t);
  let x = 0;
  let z = 0;
  for (const leg of WALK.legs) {
    const len = legLength(leg);
    const f = Math.min(1, left / len);
    x += leg[0] * f;
    z += leg[1] * f;
    left -= len * f;
    if (left <= 0) break;
  }
  return [x, WALK.heightM, z];
}

/**
 * Camera yaw about up in the model frame, degrees: a three.js camera looks down -Z, so -90 looks
 * east (the first leg) and 0 north (the second). The turn at the corner takes one second.
 */
function modelYawDeg(t) {
  const f = Math.min(1, Math.max(0, (t - (cornerT - 0.5)) / 1));
  return -90 + 90 * f;
}

/** `scale * Ry(rotDeg) * p + shift`. */
function toRaw(p, truth) {
  const a = truth.rotDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    truth.scale * (c * p[0] + s * p[2]) + truth.shift[0],
    truth.scale * p[1] + truth.shift[1],
    truth.scale * (-s * p[0] + c * p[2]) + truth.shift[2],
  ];
}

/** `Ry(rotDeg) * Ry(yaw)` as a quaternion, x y z w. */
function rawQuat(t, truth) {
  const half = ((modelYawDeg(t) + truth.rotDeg) * DEG) / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

const stillCount = Math.floor(endT / WALK.stillEveryS) + 1;
const stillTimes = Array.from({ length: stillCount }, (_, k) => k * WALK.stillEveryS);
const lastT = stillTimes[stillTimes.length - 1];

function still(t, truth, segment) {
  const base = { n: Math.round(t * WALK.videoFps), t };
  const steps = round(walked(t) * WALK.stepsPerM, 3);
  if (!truth) return { ...base, steps };
  return {
    ...base,
    pos: toRaw(modelPos(t), truth).map((v) => round(v)),
    q: rawQuat(t, truth).map((v) => round(v, 8)),
    segment,
    steps,
  };
}

const rawPath = (stills) => ({
  schema: 'aio.walkpath/1',
  walk: 'synthetic',
  source: 'sfm',
  up: [0, 1, 0],
  stills,
  walking: { startT: WALK.standS, endT: lastT },
  kept: stills.filter((_, k) => k % 2 === 0).map((s) => s.n),
});

const synthetic = rawPath(stillTimes.map((t) => still(t, GROUND_TRUTH, 0)));
const broken = rawPath(
  stillTimes.map((t) => {
    if (t < WALK.gap[0]) return still(t, GROUND_TRUTH, 0);
    if (t <= WALK.gap[1]) return still(t, null);
    return still(t, GROUND_TRUTH_SEGMENT_1, 1);
  }),
);

const RECORD_BYTES = 20;
const count = Math.round(lastT * WALK.orientationHz) + 1;
const view = new DataView(new ArrayBuffer(count * RECORD_BYTES));
for (let i = 0; i < count; i++) {
  const t = i / WALK.orientationHz;
  const q = rawQuat(t, GROUND_TRUTH);
  [t, ...q].forEach((v, j) => {
    view.setFloat32(i * RECORD_BYTES + j * 4, v, true);
  });
}
const orientation = {
  schema: 'aio.walkorient/1',
  rateHz: WALK.orientationHz,
  count,
  convention: 'xyzw-camera-threejs',
  frame: 'raw',
  startOffsetS: 0,
  data: 'orientation.synthetic.bin',
  layout: 'f32le-t-xyzw',
};

mkdirSync(out, { recursive: true });
async function writeJson(name, value) {
  const file = join(out, name);
  const config = (await resolveConfig(file)) ?? {};
  writeFileSync(file, await format(JSON.stringify(value), { ...config, filepath: file }));
  console.log(`wrote ${name}`);
}
await writeJson('raw-path.synthetic.json', synthetic);
await writeJson('raw-path.broken.json', broken);
await writeJson('orientation.synthetic.json', orientation);
writeFileSync(join(out, orientation.data), new Uint8Array(view.buffer));
console.log(`wrote ${orientation.data} (${String(count)} records)`);
console.log(`ground truth (tools/fixtures/walk-truth.mjs): ${JSON.stringify(GROUND_TRUTH)}`);
