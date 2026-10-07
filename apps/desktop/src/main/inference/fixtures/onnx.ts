/**
 * A minimal ONNX writer for test fixtures: enough of the protobuf wire format to write a graph of
 * plain operators with float or int64 initializers. Tests build their detector models with it at
 * run time, so no model file of unknown origin is ever checked in. Not used by the app.
 */

type Field = Uint8Array;

function varint(n: number | bigint): number[] {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const tag = (field: number, wire: number) => varint((field << 3) | wire);
const int = (field: number, n: number | bigint): Field =>
  Uint8Array.from([...tag(field, 0), ...varint(n)]);
const bytes = (field: number, data: Uint8Array): Field =>
  concat([Uint8Array.from([...tag(field, 2), ...varint(data.length)]), data]);
const str = (field: number, s: string): Field => bytes(field, new TextEncoder().encode(s));
const msg = (field: number, parts: readonly Field[]): Field => bytes(field, concat(parts));
const f32 = (field: number, v: number): Field => {
  const b = new Uint8Array(5 + 4);
  const head = tag(field, 5);
  b.set(head, 0);
  new DataView(b.buffer).setFloat32(head.length, v, true);
  return b.slice(0, head.length + 4);
};

/** ONNX TensorProto data types used here. */
const FLOAT = 1;
const INT64 = 7;

export interface Initializer {
  name: string;
  dims: readonly number[];
  float?: readonly number[];
  int64?: readonly number[];
}

export type AttrValue =
  | { f: number }
  | { i: number }
  | { ints: readonly number[] }
  | { floats: readonly number[] }
  | { s: string };

export interface OnnxNode {
  op: string;
  inputs: readonly string[];
  outputs: readonly string[];
  attrs?: Readonly<Record<string, AttrValue>>;
}

export interface OnnxValue {
  name: string;
  /** Dimension sizes; a string is a named (dynamic) dimension. */
  dims: readonly (number | string)[];
}

export interface OnnxGraph {
  name: string;
  nodes: readonly OnnxNode[];
  initializers: readonly Initializer[];
  inputs: readonly OnnxValue[];
  outputs: readonly OnnxValue[];
  opset?: number;
  producer?: string;
  doc?: string;
}

function tensor(init: Initializer): Field[] {
  const parts: Field[] = init.dims.map((d) => int(1, d));
  if (init.int64) {
    parts.push(int(2, INT64));
    const raw = new Uint8Array(init.int64.length * 8);
    const view = new DataView(raw.buffer);
    init.int64.forEach((v, i) => {
      view.setBigInt64(i * 8, BigInt(v), true);
    });
    parts.push(str(8, init.name), bytes(9, raw));
  } else {
    parts.push(int(2, FLOAT));
    const raw = new Uint8Array(new Float32Array(init.float ?? []).buffer);
    parts.push(str(8, init.name), bytes(9, raw));
  }
  return parts;
}

function attribute(name: string, v: AttrValue): Field[] {
  const parts: Field[] = [str(1, name)];
  if ('f' in v) parts.push(f32(2, v.f), int(20, 1));
  else if ('i' in v) parts.push(int(3, v.i), int(20, 2));
  else if ('s' in v) parts.push(str(4, v.s), int(20, 3));
  else if ('floats' in v) parts.push(...v.floats.map((x) => f32(7, x)), int(20, 6));
  else parts.push(...v.ints.map((x) => int(8, x)), int(20, 7));
  return parts;
}

function valueInfo(v: OnnxValue): Field[] {
  const dims = v.dims.map((d) => msg(1, [typeof d === 'number' ? int(1, d) : str(2, d)]));
  const tensorType = msg(1, [int(1, FLOAT), msg(2, dims)]);
  return [str(1, v.name), msg(2, [tensorType])];
}

/** The serialised ModelProto (IR version 8). */
export function writeOnnx(g: OnnxGraph): Uint8Array {
  const graph: Field[] = [
    ...g.nodes.map((n, i) =>
      msg(1, [
        ...n.inputs.map((x) => str(1, x)),
        ...n.outputs.map((x) => str(2, x)),
        str(3, `${n.op.toLowerCase()}_${i}`),
        str(4, n.op),
        ...Object.entries(n.attrs ?? {}).map(([k, v]) => msg(5, attribute(k, v))),
      ]),
    ),
    str(2, g.name),
    ...g.initializers.map((t) => msg(5, tensor(t))),
    ...g.inputs.map((v) => msg(11, valueInfo(v))),
    ...g.outputs.map((v) => msg(12, valueInfo(v))),
  ];
  return concat([
    int(1, 8),
    str(2, g.producer ?? 'quadrion-test-fixture'),
    str(3, '1'),
    ...(g.doc ? [str(6, g.doc)] : []),
    msg(7, graph),
    msg(8, [str(1, ''), int(2, g.opset ?? 13)]),
  ]);
}
