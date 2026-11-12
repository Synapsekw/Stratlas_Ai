import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { colourSegmenterOnnx } from '../inference/fixtures/colourSegmenter';
import { markerDetectorOnnx } from '../inference/fixtures/markerDetector';
import { onnxExternalData } from './onnxExternal';

/** Protobuf by hand: a varint, a tag, a length-delimited field. */
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const field = (no: number, body: Buffer) =>
  Buffer.from([...varint(no * 8 + 2), ...varint(body.length), ...body]);
const intField = (no: number, value: number) => Buffer.from([...varint(no * 8), ...varint(value)]);
const text = (s: string) => Buffer.from(s, 'utf8');

/** A model whose graph has one initializer `tensor`, maybe inside a node attribute's subgraph. */
const model = (tensor: Buffer, inSubgraph = false) => {
  const graph = inSubgraph
    ? field(1, field(5, Buffer.concat([field(1, text('then')), field(6, field(5, tensor))])))
    : field(5, tensor);
  return Buffer.concat([intField(1, 8), field(7, graph)]);
};
const tensorWith = (...parts: Buffer[]) =>
  Buffer.concat([intField(1, 3), intField(2, 1), field(8, text('w')), ...parts]);

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-onnx-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const check = async (bytes: Uint8Array) => {
  const p = join(dir, 'm.onnx');
  await writeFile(p, bytes);
  return onnxExternalData(p);
};

describe('onnxExternalData', () => {
  it('passes the test models, whose weights are inside them', async () => {
    expect(await check(markerDetectorOnnx())).toBe('ok');
    expect(await check(colourSegmenterOnnx().encoder)).toBe('ok');
    expect(await check(colourSegmenterOnnx().decoder)).toBe('ok');
    expect(await check(model(tensorWith(field(9, Buffer.alloc(300_000, 1)))))).toBe('ok');
  });

  it('finds a tensor kept in another file, in the graph or in a subgraph', async () => {
    const located = tensorWith(intField(14, 1));
    expect(await check(model(located))).toBe('external');
    const listed = tensorWith(
      field(13, Buffer.concat([field(1, text('location')), field(2, text('w.bin'))])),
    );
    expect(await check(model(listed))).toBe('external');
    expect(await check(model(located, true))).toBe('external');
  });

  it('reads EXTERNAL past the int32 width, and in a function attribute default', async () => {
    expect(await check(model(tensorWith(intField(14, 2 ** 32 + 1))))).toBe('external');
    // ModelProto.functions (25) > FunctionProto.attribute_proto (11) > AttributeProto.t (5)
    const fn = field(
      25,
      field(11, Buffer.concat([field(1, text('w')), field(5, tensorWith(intField(14, 1)))])),
    );
    expect(await check(Buffer.concat([model(tensorWith()), fn]))).toBe('external');
  });

  it('answers not ONNX for bytes that are not a protobuf', async () => {
    expect(await check(Buffer.from('not a model at all'))).toBe('not-onnx');
    expect(await check(Buffer.from([0x3a, 0xff, 0xff, 0x01]))).toBe('not-onnx');
  });
});
