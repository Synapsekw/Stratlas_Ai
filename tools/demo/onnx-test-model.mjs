#!/usr/bin/env node
/* eslint-disable no-console -- CLI output */
// The ONNX test detector of M8 (BLD-10 tests and the change demo): a "marker" detector built from
// plain operators, with no trained weights, so there is no licence or training-data question. It
// thresholds the seeded marker colour (magenta, MARKER_RGB), pools the mask into overlapping
// 64 px windows (stride 32), takes the tight box of the marker pixels in each window from pooled
// coordinate maps, keeps windows that are a local maximum of marker pixels, and writes a YOLOv8
// layout output [1, 4 + 1, 361] (cx, cy, w, h in input pixels, then the class score).
//
//   node tools/demo/onnx-test-model.mjs <dir>     writes model.onnx and model.json (the card)
//
// The protobuf is written by hand (no onnx package), byte for byte the same on every machine. A
// small reference evaluator (runOnnx) runs the graph in tests; onnxruntime runs it in the app.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prng } from './noise.mjs';

/** The marker colour painted by the demo and the fixtures (sRGB). */
export const MARKER_RGB = [224, 32, 224];
const SIZE = 640;
const WIN = 64;
const STRIDE = 32;
const GRID = (SIZE - WIN) / STRIDE + 1; // 19

// ------------------------------------------------------------------ protobuf writer

function varint(v) {
  const out = [];
  let n = BigInt(v);
  if (n < 0n) n += 1n << 64n;
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const vInt = (field, v) => Buffer.concat([key(field, 0), varint(v)]);
const vBytes = (field, b) => {
  const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  return Buffer.concat([key(field, 2), varint(buf.length), buf]);
};
const vMsg = (field, ...parts) => vBytes(field, Buffer.concat(parts));

const FLOAT = 1;
const INT64 = 7;

function tensor(name, dataType, dims, values) {
  const raw =
    dataType === INT64
      ? Buffer.concat(
          values.map((v) => {
            const b = Buffer.alloc(8);
            b.writeBigInt64LE(BigInt(v));
            return b;
          }),
        )
      : Buffer.from(new Float32Array(values).buffer);
  return Buffer.concat([
    ...dims.map((d) => vInt(1, d)),
    vInt(2, dataType),
    vBytes(8, name),
    vBytes(9, raw),
  ]);
}

function attr(name, v) {
  if (Array.isArray(v))
    return Buffer.concat([vBytes(1, name), vInt(20, 7), ...v.map((x) => vInt(8, x))]);
  return Buffer.concat([vBytes(1, name), vInt(20, 2), vInt(3, v)]);
}

function node(op, inputs, outputs, attrs = {}) {
  return Buffer.concat([
    ...inputs.map((i) => vBytes(1, i)),
    ...outputs.map((o) => vBytes(2, o)),
    vBytes(3, `${op.toLowerCase()}_${outputs[0]}`),
    vBytes(4, op),
    ...Object.entries(attrs).map(([k, v]) => vMsg(5, attr(k, v))),
  ]);
}

const valueInfo = (name, shape) =>
  Buffer.concat([
    vBytes(1, name),
    vMsg(2, vMsg(1, vInt(1, FLOAT), vMsg(2, ...shape.map((d) => vMsg(1, vInt(1, d)))))),
  ]);

const DOC =
  'Marker test detector: finds magenta survey markers by colour thresholds and pooling. ' +
  'Built from plain operators, no trained weights. Quadrion AI test fixture, synthetic data only.';

function model(graph, doc = DOC) {
  return Buffer.concat([
    vInt(1, 7), // ir_version
    vBytes(2, 'Quadrion AI test fixture'),
    vBytes(6, doc),
    vMsg(7, graph),
    vMsg(8, vBytes(1, ''), vInt(2, 13)),
    vMsg(14, vBytes(1, 'licence'), vBytes(2, 'MIT')),
    vMsg(14, vBytes(1, 'source'), vBytes(2, 'Quadrion AI test fixture')),
  ]);
}

/** The detector graph; `channels` 5 is the real layout, 3 the wrong-layout twin. */
function graph(channels) {
  const pool = { kernel_shape: [WIN, WIN], strides: [STRIDE, STRIDE] };
  const nodes = [
    node('Split', ['images'], ['r', 'g', 'b'], { axis: 1 }),
    node('Greater', ['r', 'hi'], ['r_hi']),
    node('Greater', ['b', 'hi'], ['b_hi']),
    node('Less', ['g', 'lo'], ['g_lo']),
    node('And', ['r_hi', 'b_hi'], ['rb']),
    node('And', ['rb', 'g_lo'], ['mk']),
    node('Cast', ['mk'], ['m'], { to: FLOAT }),
    node('Range', ['zero', 'size', 'one'], ['idx']),
    node('Reshape', ['idx', 'shape_x'], ['xs']),
    node('Reshape', ['idx', 'shape_y'], ['ys']),
    node('Add', ['xs', 'one'], ['xs1']),
    node('Sub', ['size', 'xs'], ['xsr']),
    node('Add', ['ys', 'one'], ['ys1']),
    node('Sub', ['size', 'ys'], ['ysr']),
    node('Mul', ['m', 'xs1'], ['mx2']),
    node('Mul', ['m', 'xsr'], ['mx1r']),
    node('Mul', ['m', 'ys1'], ['my2']),
    node('Mul', ['m', 'ysr'], ['my1r']),
    node('MaxPool', ['mx2'], ['px2'], pool),
    node('MaxPool', ['mx1r'], ['px1r'], pool),
    node('MaxPool', ['my2'], ['py2'], pool),
    node('MaxPool', ['my1r'], ['py1r'], pool),
    node('Sub', ['size', 'px1r'], ['x1']),
    node('Sub', ['size', 'py1r'], ['y1']),
    node('Sub', ['px2', 'x1'], ['wraw']),
    node('Sub', ['py2', 'y1'], ['hraw']),
    node('Relu', ['wraw'], ['w']),
    node('Relu', ['hraw'], ['h']),
    node('Add', ['x1', 'px2'], ['sx']),
    node('Add', ['y1', 'py2'], ['sy']),
    node('Mul', ['sx', 'half'], ['cx']),
    node('Mul', ['sy', 'half'], ['cy']),
    node('AveragePool', ['m'], ['frac'], pool),
    node('Mul', ['frac', 'area'], ['cnt']),
    node('MaxPool', ['frac'], ['fmax'], {
      kernel_shape: [3, 3],
      strides: [1, 1],
      pads: [1, 1, 1, 1],
    }),
    node('GreaterOrEqual', ['frac', 'fmax'], ['lm']),
    node('Greater', ['frac', 'zero'], ['nz']),
    node('And', ['lm', 'nz'], ['keepb']),
    node('Cast', ['keepb'], ['keep'], { to: FLOAT }),
    node('Div', ['cnt', 'minpx'], ['c1']),
    node('Min', ['c1', 'one'], ['c2']),
    node('Mul', ['c2', 'keep'], ['score']),
    node(
      'Concat',
      channels === 5 ? ['cx', 'cy', 'w', 'h', 'score'] : ['cx', 'cy', 'score'],
      ['det'],
      {
        axis: 1,
      },
    ),
    node('Reshape', ['det', 'shape_out'], ['output0']),
  ];
  const inits = [
    tensor('hi', FLOAT, [], [0.6]),
    tensor('lo', FLOAT, [], [0.35]),
    tensor('zero', FLOAT, [], [0]),
    tensor('one', FLOAT, [], [1]),
    tensor('half', FLOAT, [], [0.5]),
    tensor('size', FLOAT, [], [SIZE]),
    tensor('area', FLOAT, [], [WIN * WIN]),
    tensor('minpx', FLOAT, [], [24]),
    tensor('shape_x', INT64, [4], [1, 1, 1, SIZE]),
    tensor('shape_y', INT64, [4], [1, 1, SIZE, 1]),
    tensor('shape_out', INT64, [3], [1, channels, GRID * GRID]),
  ];
  return Buffer.concat([
    ...nodes.map((n) => vMsg(1, n)),
    vBytes(2, 'marker_detector'),
    ...inits.map((t) => vMsg(5, t)),
    vBytes(10, DOC),
    vMsg(11, valueInfo('images', [1, 3, SIZE, SIZE])),
    vMsg(12, valueInfo('output0', [1, channels, GRID * GRID])),
  ]);
}

/** Model card (`aio.detector/1`) of a model file. */
export function markerCard(onnx, name = 'Marker test detector') {
  return {
    schema: 'aio.detector/1',
    name,
    version: '1.0.0',
    layout: 'yolo-v8',
    input: { width: SIZE, height: SIZE, tensor: 'nchw', color: 'rgb', scale: 255 },
    classes: ['marker'],
    licence: 'MIT',
    source: 'Quadrion AI test fixture (built from plain operators, no trained weights)',
    sha256: createHash('sha256').update(onnx).digest('hex'),
    description:
      'Finds the magenta survey markers of the synthetic demo. For tests and the demo only; it detects nothing real.',
    author: 'Quadrion AI',
    // The score is marker pixels / 24 in a window. The demo's smallest marker (photos-d2 p02 M3)
    // has 12 at 640 px with a Lanczos resize and 11 with the app's bilinear one: 0.50 or 0.46.
    // 0.25 keeps it found whatever the resampler; the demo photos give no other detection.
    minConfidence: 0.25,
  };
}

/** The detector and its card (`doc` replaces the model's doc string, for checker tests). */
export function buildMarkerDetector({ doc } = {}) {
  const onnx = model(graph(5), doc);
  return { onnx, card: markerCard(onnx) };
}

/** Same graph, but the output has 3 channels: a `yolo-v8` card on it must be refused. */
export function buildWrongLayoutDetector() {
  const onnx = model(graph(3));
  return { onnx, card: markerCard(onnx, 'Marker test detector (wrong layout)') };
}

/** Not a model: the first bytes of one, then garbage. */
export function corruptOnnx() {
  const good = buildMarkerDetector().onnx;
  return Buffer.concat([good.subarray(0, 48), Buffer.alloc(64, 0xff)]);
}

// ------------------------------------------------------------------ protobuf reader

function readVarint(buf, p) {
  let v = 0n;
  let shift = 0n;
  for (;;) {
    if (p.i >= buf.length) throw new Error('onnx: truncated varint');
    const b = buf[p.i++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return v;
    shift += 7n;
    if (shift > 63n) throw new Error('onnx: varint too long');
  }
}

/** Fields of one message: { field: [{ wire, value }] } (value: bigint, Buffer or number). */
function fields(buf) {
  const out = {};
  const p = { i: 0 };
  while (p.i < buf.length) {
    const k = Number(readVarint(buf, p));
    const f = k >> 3;
    const wire = k & 7;
    let value;
    if (wire === 0) value = readVarint(buf, p);
    else if (wire === 2) {
      const len = Number(readVarint(buf, p));
      if (p.i + len > buf.length) throw new Error('onnx: truncated field');
      value = buf.subarray(p.i, p.i + len);
      p.i += len;
    } else if (wire === 5) {
      if (p.i + 4 > buf.length) throw new Error('onnx: truncated field');
      value = buf.readFloatLE(p.i);
      p.i += 4;
    } else if (wire === 1) {
      if (p.i + 8 > buf.length) throw new Error('onnx: truncated field');
      value = buf.readDoubleLE(p.i);
      p.i += 8;
    } else throw new Error(`onnx: wire type ${wire}`);
    if (f === 0) throw new Error('onnx: field 0');
    (out[f] ??= []).push({ wire, value });
  }
  return out;
}
const str = (f, n) => (f[n] ? f[n][0].value.toString('utf8') : '');
const strs = (f, n) => (f[n] ?? []).map((x) => x.value.toString('utf8'));
const num = (f, n, d = 0) => (f[n] ? Number(f[n][0].value) : d);

function decodeTensor(buf) {
  const f = fields(buf);
  const dims = (f[1] ?? []).map((x) => Number(x.value));
  const type = num(f, 2);
  const raw = f[9]?.[0]?.value ?? Buffer.alloc(0);
  const n = dims.reduce((a, b) => a * b, 1);
  let data;
  if (type === FLOAT) data = Float32Array.from({ length: n }, (_, i) => raw.readFloatLE(4 * i));
  else if (type === INT64)
    data = Float64Array.from({ length: n }, (_, i) => Number(raw.readBigInt64LE(8 * i)));
  else throw new Error(`onnx: tensor type ${type}`);
  return { name: str(f, 8), dims, data };
}

function decodeValueInfo(buf) {
  const f = fields(buf);
  const t = fields(fields(f[2][0].value)[1][0].value);
  const shape = (fields(t[2]?.[0]?.value ?? Buffer.alloc(0))[1] ?? []).map((d) =>
    num(fields(d.value), 1, -1),
  );
  return { name: str(f, 1), elemType: num(t, 1), shape };
}

/** Parse a model (the parts this fixture uses); throws on anything that is not one. */
export function decodeOnnx(buf) {
  const f = fields(buf);
  if (!f[7]) throw new Error('onnx: no graph');
  const g = fields(f[7][0].value);
  return {
    irVersion: num(f, 1),
    producer: str(f, 2),
    doc: str(f, 6),
    opset: (f[8] ?? []).map((o) => {
      const x = fields(o.value);
      return { domain: str(x, 1), version: num(x, 2) };
    }),
    metadata: Object.fromEntries(
      (f[14] ?? []).map((m) => {
        const x = fields(m.value);
        return [str(x, 1), str(x, 2)];
      }),
    ),
    graph: {
      name: str(g, 2),
      nodes: (g[1] ?? []).map((n) => {
        const x = fields(n.value);
        const attrs = {};
        for (const a of x[5] ?? []) {
          const y = fields(a.value);
          const type = num(y, 20);
          attrs[str(y, 1)] = type === 7 ? (y[8] ?? []).map((v) => Number(v.value)) : num(y, 3);
        }
        return {
          inputs: strs(x, 1),
          outputs: strs(x, 2),
          name: str(x, 3),
          opType: str(x, 4),
          attrs,
        };
      }),
      initializers: (g[5] ?? []).map((t) => decodeTensor(t.value)),
      inputs: (g[11] ?? []).map((v) => decodeValueInfo(v.value)),
      outputs: (g[12] ?? []).map((v) => decodeValueInfo(v.value)),
    },
  };
}

/**
 * Every readable string of an ONNX file's text fields (names, doc strings, producer, metadata),
 * without tensor payloads; for the client-data check. Unknown messages are walked as far as they
 * parse; a field that does not parse as a message counts as text when it is printable.
 */
export function onnxStrings(buf) {
  const out = [];
  const walk = (b, depth) => {
    let f;
    try {
      f = fields(b);
    } catch {
      return false;
    }
    for (const [n, list] of Object.entries(f))
      for (const { wire, value } of list) {
        if (wire !== 2) continue;
        if (Number(n) === 9 && depth > 0) continue; // TensorProto raw_data
        const text = value.toString('utf8');
        const printable = value.length > 0 && /^[\x20-\x7e\t\r\n]*$/.test(text);
        if (depth < 8 && value.length > 1 && !printable && walk(value, depth + 1)) continue;
        if (printable) out.push(text);
      }
    return true;
  };
  walk(buf, 0);
  return out;
}

// ------------------------------------------------------------------ reference evaluator (tests)

const size = (d) => d.reduce((a, b) => a * b, 1);
const strides = (d) => {
  const s = new Array(d.length).fill(1);
  for (let i = d.length - 2; i >= 0; i--) s[i] = s[i + 1] * d[i + 1];
  return s;
};

function broadcast(a, b, fn, Out = Float32Array) {
  const r = Math.max(a.dims.length, b.dims.length);
  const ad = [...new Array(r - a.dims.length).fill(1), ...a.dims];
  const bd = [...new Array(r - b.dims.length).fill(1), ...b.dims];
  const dims = ad.map((x, i) => Math.max(x, bd[i]));
  const as = strides(ad);
  const bs = strides(bd);
  const os = strides(dims);
  const n = size(dims);
  const data = new Out(n);
  for (let i = 0; i < n; i++) {
    let ai = 0;
    let bi = 0;
    let rem = i;
    for (let k = 0; k < r; k++) {
      const c = Math.floor(rem / os[k]);
      rem -= c * os[k];
      if (ad[k] > 1) ai += c * as[k];
      if (bd[k] > 1) bi += c * bs[k];
    }
    data[i] = fn(a.data[ai], b.data[bi]);
  }
  return { dims, data };
}

function pool(x, a, kind) {
  const [kh, kw] = a.kernel_shape;
  const [sh, sw] = a.strides ?? [1, 1];
  const [pt, pl, pb, pr] = a.pads ?? [0, 0, 0, 0];
  const [N, C, H, W] = x.dims;
  const oh = Math.floor((H + pt + pb - kh) / sh) + 1;
  const ow = Math.floor((W + pl + pr - kw) / sw) + 1;
  const data = new Float32Array(N * C * oh * ow);
  for (let nc = 0; nc < N * C; nc++)
    for (let oy = 0; oy < oh; oy++)
      for (let ox = 0; ox < ow; ox++) {
        let acc = kind === 'max' ? -Infinity : 0;
        let count = 0;
        for (let dy = 0; dy < kh; dy++)
          for (let dx = 0; dx < kw; dx++) {
            const y = oy * sh - pt + dy;
            const xx = ox * sw - pl + dx;
            if (y < 0 || xx < 0 || y >= H || xx >= W) continue;
            const v = x.data[nc * H * W + y * W + xx];
            if (kind === 'max') acc = v > acc ? v : acc;
            else acc += v;
            count++;
          }
        data[nc * oh * ow + oy * ow + ox] = kind === 'max' ? acc : Math.fround(acc / count);
      }
  return { dims: [N, C, oh, ow], data };
}

const f32 = (fn) => (a, b) => Math.fround(fn(a, b));
const OPS = {
  Add: (i) =>
    broadcast(
      i[0],
      i[1],
      f32((a, b) => a + b),
    ),
  Sub: (i) =>
    broadcast(
      i[0],
      i[1],
      f32((a, b) => a - b),
    ),
  Mul: (i) =>
    broadcast(
      i[0],
      i[1],
      f32((a, b) => a * b),
    ),
  Div: (i) =>
    broadcast(
      i[0],
      i[1],
      f32((a, b) => a / b),
    ),
  Min: (i) => broadcast(i[0], i[1], (a, b) => Math.min(a, b)),
  Greater: (i) => broadcast(i[0], i[1], (a, b) => (a > b ? 1 : 0), Uint8Array),
  GreaterOrEqual: (i) => broadcast(i[0], i[1], (a, b) => (a >= b ? 1 : 0), Uint8Array),
  Less: (i) => broadcast(i[0], i[1], (a, b) => (a < b ? 1 : 0), Uint8Array),
  And: (i) => broadcast(i[0], i[1], (a, b) => (a && b ? 1 : 0), Uint8Array),
  Relu: (i) => ({ dims: i[0].dims, data: i[0].data.map((v) => (v > 0 ? v : 0)) }),
  Cast: (i, a) => {
    if (a.to !== FLOAT) throw new Error(`Cast to ${a.to}`);
    return { dims: i[0].dims, data: Float32Array.from(i[0].data) };
  },
  Range: (i) => {
    const [s, l, d] = i.map((t) => t.data[0]);
    const n = Math.max(0, Math.ceil((l - s) / d));
    return { dims: [n], data: Float32Array.from({ length: n }, (_, k) => s + k * d) };
  },
  Reshape: (i) => {
    const dims = Array.from(i[1].data);
    if (size(dims) !== size(i[0].dims)) throw new Error('Reshape: size mismatch');
    return { dims, data: i[0].data };
  },
  Split: (i, a, nOut) => {
    const x = i[0];
    const axis = a.axis ?? 0;
    const part = x.dims[axis] / nOut;
    const outer = size(x.dims.slice(0, axis));
    const inner = size(x.dims.slice(axis + 1));
    return Array.from({ length: nOut }, (_, k) => {
      const dims = x.dims.slice();
      dims[axis] = part;
      const data = new Float32Array(size(dims));
      for (let o = 0; o < outer; o++)
        data.set(
          x.data.subarray(
            (o * x.dims[axis] + k * part) * inner,
            (o * x.dims[axis] + (k + 1) * part) * inner,
          ),
          o * part * inner,
        );
      return { dims, data };
    });
  },
  MaxPool: (i, a) => pool(i[0], a, 'max'),
  AveragePool: (i, a) => pool(i[0], a, 'avg'),
  Concat: (i, a) => {
    const axis = a.axis;
    const dims = i[0].dims.slice();
    dims[axis] = i.reduce((s, t) => s + t.dims[axis], 0);
    const outer = size(dims.slice(0, axis));
    const data = new Float32Array(size(dims));
    let o = 0;
    for (let k = 0; k < outer; k++)
      for (const t of i) {
        const chunk = size(t.dims.slice(axis));
        data.set(t.data.subarray(k * chunk, (k + 1) * chunk), o);
        o += chunk;
      }
    return { dims, data };
  },
};

/** Run a decoded model on `{ name: { dims, data } }` inputs (the operators this file uses). */
export function runOnnx(m, inputs) {
  const env = new Map(Object.entries(inputs));
  for (const t of m.graph.initializers) env.set(t.name, t);
  for (const n of m.graph.nodes) {
    const op = OPS[n.opType];
    if (!op) throw new Error(`runOnnx: no ${n.opType}`);
    const ins = n.inputs.map((x) => {
      if (!env.has(x)) throw new Error(`runOnnx: ${n.name} needs ${x}`);
      return env.get(x);
    });
    const r = op(ins, n.attrs, n.outputs.length);
    const outs = Array.isArray(r) ? r : [r];
    n.outputs.forEach((o, k) => env.set(o, outs[k]));
  }
  return Object.fromEntries(m.graph.outputs.map((o) => [o.name, env.get(o.name)]));
}

/**
 * YOLOv8 post-processing as a reader would do it: score threshold, then non-maximum suppression
 * (IoU 0.5). Boxes `[x0, y0, x1, y1]` in input pixels.
 */
export function postprocessYoloV8(out, { minConfidence = 0.5, iou = 0.5 } = {}) {
  const [, ch, n] = out.dims;
  const nc = ch - 4;
  const cand = [];
  for (let k = 0; k < n; k++) {
    let best = 0;
    let cls = 0;
    for (let c = 0; c < nc; c++) {
      const s = out.data[(4 + c) * n + k];
      if (s > best) {
        best = s;
        cls = c;
      }
    }
    if (best < minConfidence) continue;
    const [cx, cy, w, h] = [0, 1, 2, 3].map((c) => out.data[c * n + k]);
    cand.push({
      score: best,
      classIndex: cls,
      box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
    });
  }
  cand.sort((a, b) => b.score - a.score);
  const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const kept = [];
  for (const c of cand) {
    const clash = kept.some((k) => {
      const ix = Math.max(0, Math.min(k.box[2], c.box[2]) - Math.max(k.box[0], c.box[0]));
      const iy = Math.max(0, Math.min(k.box[3], c.box[3]) - Math.max(k.box[1], c.box[1]));
      const inter = ix * iy;
      return inter / (area(k.box) + area(c.box) - inter) > iou;
    });
    if (!clash) kept.push(c);
  }
  return kept;
}

// ------------------------------------------------------------------ fixture image

/**
 * A desert-coloured test image with square markers of MARKER_RGB at `markers` ({ x, y, size },
 * top-left pixel). Returns RGB and the exact boxes `[x, y, x + size, y + size]`.
 */
export function markerImage({ width, height, markers, seed = 1 }) {
  const rnd = prng(seed);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const k = 0.85 + 0.3 * rnd();
    rgb[3 * i] = Math.min(255, Math.round(205 * k));
    rgb[3 * i + 1] = Math.min(255, Math.round(178 * k));
    rgb[3 * i + 2] = Math.min(255, Math.round(136 * k));
  }
  for (const m of markers)
    for (let y = m.y; y < m.y + m.size; y++)
      for (let x = m.x; x < m.x + m.size; x++) rgb.set(MARKER_RGB, (y * width + x) * 3);
  return { rgb, boxes: markers.map((m) => [m.x, m.y, m.x + m.size, m.y + m.size]) };
}

async function cli() {
  const out = resolve(process.argv[2] ?? '.');
  await mkdir(out, { recursive: true });
  const { onnx, card } = buildMarkerDetector();
  await writeFile(join(out, 'model.onnx'), onnx);
  await writeFile(join(out, 'model.json'), `${JSON.stringify(card, null, 2)}\n`);
  console.log(
    `Marker test detector written to ${out} (${onnx.length} bytes, sha256 ${card.sha256}).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
