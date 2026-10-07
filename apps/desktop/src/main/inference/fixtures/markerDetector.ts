/**
 * The synthetic marker detector for tests (data-conventions section 16, plan "Synthetic test
 * data" item 4). It is built from plain operators with hand-set constants, no trained weights, so
 * there is no licence or training-data question: it finds magenta (`marker`) and cyan
 * (`cyan-marker`) patches and writes YOLOv8-style output `[1, 4 + classes, cells]`.
 *
 * How it works: a 1 x 1 convolution and a clip make one mask per colour. Average pooling over
 * windows of two cells (stride one cell) gives, per window, the mask's mass and its first and
 * second moments; the box is the mean plus or minus half of sqrt(12 var + 1) (exact for a filled
 * rectangle of whole pixels), the score is mass / (mass + 64). A window that sees the whole patch
 * scores highest; the partial views inside it are removed by NMS.
 *
 * Also: a wrong-layout variant (2-D output) and PNG photos with patches at known places.
 */
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { DetectorModelCard } from '@aio/schema';
import { writeOnnx, type OnnxNode } from './onnx';

export const MARKER_CLASSES = ['marker', 'cyan-marker'] as const;
export const MARKER_COLORS: Record<(typeof MARKER_CLASSES)[number], [number, number, number]> = {
  marker: [255, 0, 255],
  'cyan-marker': [0, 255, 255],
};

export interface MarkerModelOptions {
  /** Square input size; a multiple of `cell`. Default 320. */
  size?: number;
  /** Cell size (stride) in input pixels. Default 32. */
  cell?: number;
  /** Write a 2-D output instead of `[1, 6, cells]` (layout probe must refuse it). */
  wrongLayout?: boolean;
}

/** The ONNX bytes of the marker detector. */
export function markerDetectorOnnx(opts: MarkerModelOptions = {}): Uint8Array {
  const S = opts.size ?? 320;
  const C = opts.cell ?? 32;
  const K = 2 * C;
  const cells = (S / C) * (S / C);
  const nodes: OnnxNode[] = [
    { op: 'Conv', inputs: ['images', 'w', 'b'], outputs: ['z'] },
    { op: 'Clip', inputs: ['z', 'zero', 'one'], outputs: ['m'] },
    { op: 'ReduceSum', inputs: ['m', 'axis1'], outputs: ['a'], attrs: { keepdims: { i: 1 } } },
    { op: 'Mul', inputs: ['a', 'xs'], outputs: ['ax'] },
    { op: 'Mul', inputs: ['a', 'ys'], outputs: ['ay'] },
    { op: 'Mul', inputs: ['ax', 'xs'], outputs: ['axx'] },
    { op: 'Mul', inputs: ['ay', 'ys'], outputs: ['ayy'] },
    {
      op: 'Concat',
      inputs: ['a', 'ax', 'ay', 'axx', 'ayy', 'm'],
      outputs: ['st'],
      attrs: { axis: { i: 1 } },
    },
    {
      op: 'AveragePool',
      inputs: ['st'],
      outputs: ['p'],
      attrs: {
        kernel_shape: { ints: [K, K] },
        strides: { ints: [C, C] },
        pads: { ints: [0, 0, C, C] },
        count_include_pad: { i: 1 },
      },
    },
    {
      op: 'Split',
      inputs: ['p', 'splits'],
      outputs: ['p0', 'px', 'py', 'pxx', 'pyy', 'pc'],
      attrs: { axis: { i: 1 } },
    },
    { op: 'Add', inputs: ['p0', 'eps'], outputs: ['den'] },
    { op: 'Div', inputs: ['px', 'den'], outputs: ['mx'] },
    { op: 'Div', inputs: ['py', 'den'], outputs: ['my'] },
    { op: 'Div', inputs: ['pxx', 'den'], outputs: ['ex2'] },
    { op: 'Div', inputs: ['pyy', 'den'], outputs: ['ey2'] },
    { op: 'Mul', inputs: ['mx', 'mx'], outputs: ['mx2'] },
    { op: 'Mul', inputs: ['my', 'my'], outputs: ['my2'] },
    { op: 'Sub', inputs: ['ex2', 'mx2'], outputs: ['vx0'] },
    { op: 'Sub', inputs: ['ey2', 'my2'], outputs: ['vy0'] },
    { op: 'Relu', inputs: ['vx0'], outputs: ['vx'] },
    { op: 'Relu', inputs: ['vy0'], outputs: ['vy'] },
    { op: 'Mul', inputs: ['vx', 'twelve'], outputs: ['vx12'] },
    { op: 'Mul', inputs: ['vy', 'twelve'], outputs: ['vy12'] },
    { op: 'Add', inputs: ['vx12', 'one'], outputs: ['vx1'] },
    { op: 'Add', inputs: ['vy12', 'one'], outputs: ['vy1'] },
    { op: 'Sqrt', inputs: ['vx1'], outputs: ['bw'] },
    { op: 'Sqrt', inputs: ['vy1'], outputs: ['bh'] },
    { op: 'Mul', inputs: ['pc', 'area'], outputs: ['mass'] },
    { op: 'Add', inputs: ['mass', 'k0'], outputs: ['massk'] },
    { op: 'Div', inputs: ['mass', 'massk'], outputs: ['conf'] },
    {
      op: 'Concat',
      inputs: ['mx', 'my', 'bw', 'bh', 'conf'],
      outputs: ['grid'],
      attrs: { axis: { i: 1 } },
    },
    { op: 'Reshape', inputs: ['grid', 'shape'], outputs: ['output0'] },
  ];
  // magenta: R + B - 2G over 1.5; cyan: G + B - 2R over 1.5 (inputs are 0 to 1)
  const w = [8, -16, 8, -16, 8, 8];
  return writeOnnx({
    name: 'quadrion-marker-detector',
    doc: 'Quadrion AI test fixture: finds coloured marker patches with plain operators.',
    nodes,
    initializers: [
      { name: 'w', dims: [2, 3, 1, 1], float: w },
      { name: 'b', dims: [2], float: [-12, -12] },
      { name: 'zero', dims: [], float: [0] },
      { name: 'one', dims: [], float: [1] },
      { name: 'axis1', dims: [1], int64: [1] },
      { name: 'xs', dims: [1, 1, 1, S], float: Array.from({ length: S }, (_, i) => i + 0.5) },
      { name: 'ys', dims: [1, 1, S, 1], float: Array.from({ length: S }, (_, i) => i + 0.5) },
      { name: 'splits', dims: [6], int64: [1, 1, 1, 1, 1, 2] },
      { name: 'eps', dims: [], float: [1e-6] },
      { name: 'twelve', dims: [], float: [12] },
      { name: 'area', dims: [], float: [K * K] },
      { name: 'k0', dims: [], float: [64] },
      {
        name: 'shape',
        dims: opts.wrongLayout ? [2] : [3],
        int64: opts.wrongLayout ? [1, -1] : [1, 6, -1],
      },
    ],
    inputs: [{ name: 'images', dims: [1, 3, S, S] }],
    outputs: [{ name: 'output0', dims: opts.wrongLayout ? [1, 6 * cells] : [1, 6, cells] }],
  });
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The model card of a marker detector file. */
export function markerCard(
  onnx: Uint8Array,
  over: Partial<DetectorModelCard> = {},
  size = 320,
): DetectorModelCard {
  return {
    schema: 'aio.detector/1',
    name: 'Marker test detector',
    version: '1.0.0',
    layout: 'yolo-v8',
    input: { width: size, height: size, tensor: 'nchw', color: 'rgb', scale: 255 },
    classes: [...MARKER_CLASSES],
    licence: 'MIT',
    source: 'Quadrion AI test fixture',
    sha256: sha256(onnx),
    minConfidence: 0.5,
    ...over,
  };
}

export interface MarkerPatch {
  cls: (typeof MARKER_CLASSES)[number];
  /** `[x0, y0, x1, y1]` in photo pixels. */
  box: [number, number, number, number];
}

/** RGBA pixels of a photo: a soft grey-green gradient with the patches drawn on it. */
export function markerPhotoRgba(width: number, height: number, patches: readonly MarkerPatch[]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = 90 + Math.round((60 * x) / width);
      rgba[i + 1] = 110 + Math.round((50 * y) / height);
      rgba[i + 2] = 80;
      rgba[i + 3] = 255;
    }
  }
  for (const p of patches) {
    const [r, g, b] = MARKER_COLORS[p.cls];
    for (let y = p.box[1]; y < p.box[3]; y++) {
      for (let x = p.box[0]; x < p.box[2]; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
      }
    }
  }
  return rgba;
}

/** A PNG file (8-bit RGB) of RGBA pixels. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = row + 1 + x * 3;
      raw[o] = rgba[i] ?? 0;
      raw[o + 1] = rgba[i + 1] ?? 0;
      raw[o + 2] = rgba[i + 2] ?? 0;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
