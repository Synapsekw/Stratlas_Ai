/**
 * Does an ONNX model keep tensors outside its own file (ONNX "external data")? Such a model makes
 * onnxruntime open other files by the names the model gives (`location`, relative to the model),
 * which an add-on must never do: every byte it runs is listed and checked in its addon.json.
 *
 * The check walks the protobuf by its field numbers (onnx.proto3), reading only message headers
 * and skipping every payload it does not descend into, so a 1 GB model costs a few thousand small
 * reads and is never held in memory. A tensor is external when its `data_location` (field 14) is
 * EXTERNAL (1) or it has any `external_data` entry (field 13). Tensors sit in a graph's
 * initializers (5) and sparse initializers (15), and in node attributes (`t` 5, `tensors` 10,
 * `sparse_tensor` 22, `sparse_tensors` 23), whose subgraphs (`g` 6, `graphs` 11) are walked too;
 * the model's functions (25) hold nodes (7) as well. A file that is not a readable protobuf is
 * answered as not ONNX.
 */
import { open, type FileHandle } from 'node:fs/promises';

type Kind = 'model' | 'graph' | 'node' | 'attribute' | 'function' | 'tensor' | 'sparse';

/** For each message, the length-delimited fields that hold messages worth walking. */
const CHILDREN: Record<Exclude<Kind, 'tensor'>, Record<number, Kind>> = {
  model: { 7: 'graph', 25: 'function' },
  graph: { 1: 'node', 5: 'tensor', 15: 'sparse' },
  node: { 5: 'attribute' },
  attribute: { 5: 'tensor', 6: 'graph', 10: 'tensor', 11: 'graph', 22: 'sparse', 23: 'sparse' },
  // FunctionProto: its nodes (7) and its attribute defaults (attribute_proto, 11)
  function: { 7: 'node', 11: 'attribute' },
  sparse: { 1: 'tensor', 2: 'tensor' },
};
const MAX_DEPTH = 64;
const WINDOW = 64 * 1024;

class NotOnnx extends Error {}

/** Byte reads at any offset of a file, through a small window. */
class Reader {
  private buf = Buffer.alloc(0);
  private at = 0;
  constructor(
    private readonly fh: FileHandle,
    readonly size: number,
  ) {}

  async byte(pos: number): Promise<number> {
    if (pos < this.at || pos >= this.at + this.buf.length) {
      if (pos >= this.size) throw new NotOnnx('past the end');
      const b = Buffer.alloc(Math.min(WINDOW, this.size - pos));
      const { bytesRead } = await this.fh.read(b, 0, b.length, pos);
      this.buf = b.subarray(0, bytesRead);
      this.at = pos;
      if (bytesRead === 0) throw new NotOnnx('past the end');
    }
    return this.buf[pos - this.at] ?? 0;
  }

  /**
   * A varint at `pos`: its value (exact up to 2^53), the position after it, and its low 32 bits
   * exactly (from the first five bytes, in integer maths), which is what an int32 enum reads.
   */
  async varint(pos: number): Promise<[number, number, number]> {
    let value = 0;
    let scale = 1;
    let low = 0;
    for (let i = 0; i < 10; i++) {
      const b = await this.byte(pos + i);
      value += (b & 0x7f) * scale;
      scale *= 128;
      if (i < 5) low = (low | ((b & 0x7f) << (7 * i))) >>> 0;
      if ((b & 0x80) === 0) return [value, pos + i + 1, low];
    }
    throw new NotOnnx('a varint longer than 10 bytes');
  }
}

/** True when some tensor in `[start, end)` (a message of `kind`) is external. */
async function walk(
  r: Reader,
  kind: Kind,
  start: number,
  end: number,
  depth: number,
  seen: { graph: boolean },
): Promise<boolean> {
  if (depth > MAX_DEPTH) throw new NotOnnx('nested too deep');
  for (let pos = start; pos < end;) {
    const [tag, afterTag] = await r.varint(pos);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) throw new NotOnnx('field 0');
    switch (wire) {
      case 0: {
        const [, next, low32] = await r.varint(afterTag);
        // an enum is an int32 on the wire: whatever is padded above bit 31, a low 1 is EXTERNAL
        if (kind === 'tensor' && field === 14 && low32 === 1) return true;
        pos = next;
        break;
      }
      case 1:
        pos = afterTag + 8;
        break;
      case 5:
        pos = afterTag + 4;
        break;
      case 2: {
        const [length, body] = await r.varint(afterTag);
        const bodyEnd = body + length;
        if (bodyEnd > end) throw new NotOnnx('a field runs past its message');
        if (kind === 'tensor') {
          if (field === 13) return true;
        } else {
          const child = CHILDREN[kind][field];
          if (child === 'graph' && kind === 'model') seen.graph = true;
          if (child && (await walk(r, child, body, bodyEnd, depth + 1, seen))) return true;
        }
        pos = bodyEnd;
        break;
      }
      default:
        throw new NotOnnx(`wire type ${String(wire)}`);
    }
    if (pos > end) throw new NotOnnx('a field runs past its message');
  }
  return false;
}

/** `external` when the model names tensors in other files, `ok`, or `not-onnx`. */
export async function onnxExternalData(path: string): Promise<'external' | 'ok' | 'not-onnx'> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const r = new Reader(fh, size);
    const seen = { graph: false };
    if (await walk(r, 'model', 0, size, 0, seen)) return 'external';
    // a model is a graph: no graph is not an ONNX model
    return seen.graph ? 'ok' : 'not-onnx';
  } catch (e) {
    if (e instanceof NotOnnx) return 'not-onnx';
    throw e;
  } finally {
    await fh.close();
  }
}
