/**
 * MP4 / MOV video track timing from the `moov` box, without decoding anything: frame size, codec
 * and the presentation time of every frame (stts + ctts + edit list). Used to check that DJI SRT
 * telemetry lines up with the video frame by frame.
 */

/** Read `length` bytes at `offset` (a file handle in Node, a Blob slice in a browser). */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

export interface Mp4VideoInfo {
  width: number;
  height: number;
  /** Sample entry fourcc: avc1, hvc1, hev1, apch (ProRes) ... */
  codec: string;
  timescale: number;
  durationMs: number;
  frameCount: number;
  /** Mean frame rate. */
  fps: number;
  /** Presentation time of every frame in display order, ms from the first frame. */
  frameTimesMs: number[];
}

interface Box {
  type: string;
  /** Offset of the payload and its size. */
  start: number;
  size: number;
}

const MOOV_LIMIT = 256 * 1024 * 1024;

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);
}

/** Child boxes of a payload held in memory. */
function children(b: Uint8Array, start = 0, end = b.length): Box[] {
  const v = view(b);
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = v.getUint32(o);
    const type = fourcc(b, o + 4);
    let head = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(o + 8));
      head = 16;
    } else if (size === 0) size = end - o;
    if (size < head || o + size > end) break;
    out.push({ type, start: o + head, size: size - head });
    o += size;
  }
  return out;
}

const find = (b: Uint8Array, parent: Box | null, type: string): Box | undefined =>
  children(b, parent?.start ?? 0, parent ? parent.start + parent.size : b.length).find(
    (c) => c.type === type,
  );

const path = (b: Uint8Array, from: Box, ...types: string[]): Box | undefined => {
  let cur: Box | undefined = from;
  for (const t of types) {
    if (!cur) return undefined;
    cur = find(b, cur, t);
  }
  return cur;
};

/** Locate and load the `moov` box by walking the top-level boxes. */
async function loadMoov(read: ReadAt, fileSize: number): Promise<Uint8Array> {
  let o = 0;
  while (o + 8 <= fileSize) {
    const head = await read(o, 16);
    const v = view(head);
    let size = v.getUint32(0);
    const type = fourcc(head, 4);
    let hl = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(8));
      hl = 16;
    } else if (size === 0) size = fileSize - o;
    if (size < hl) break;
    if (type === 'moov') {
      if (size > MOOV_LIMIT) throw new Error('The video index (moov) is too large to read.');
      return (await read(o + hl, size - hl)).slice();
    }
    o += size;
  }
  throw new Error('Not an MP4 or MOV file: no movie index (moov) found.');
}

/** Read the first video track's size, codec and frame times. */
export async function readMp4VideoInfo(read: ReadAt, fileSize: number): Promise<Mp4VideoInfo> {
  const moov = await loadMoov(read, fileSize);
  const v = view(moov);
  for (const trak of children(moov).filter((c) => c.type === 'trak')) {
    const hdlr = path(moov, trak, 'mdia', 'hdlr');
    if (!hdlr || fourcc(moov, hdlr.start + 8) !== 'vide') continue;
    const mdhd = path(moov, trak, 'mdia', 'mdhd');
    const stbl = path(moov, trak, 'mdia', 'minf', 'stbl');
    const tkhd = find(moov, trak, 'tkhd');
    if (!mdhd || !stbl || !tkhd) continue;
    const mv = moov[mdhd.start] ?? 0;
    const timescale = v.getUint32(mdhd.start + (mv === 1 ? 20 : 12));
    const tv = moov[tkhd.start] ?? 0;
    const whAt = tkhd.start + (tv === 1 ? 88 : 76);
    const width = Math.round(v.getUint32(whAt) / 65536);
    const height = Math.round(v.getUint32(whAt + 4) / 65536);
    const stsd = find(moov, stbl, 'stsd');
    const codec = stsd ? fourcc(moov, stsd.start + 12) : 'unknown';

    const decode: number[] = [];
    const stts = find(moov, stbl, 'stts');
    if (stts) {
      const n = v.getUint32(stts.start + 4);
      let t = 0;
      for (let i = 0; i < n; i++) {
        const count = v.getUint32(stts.start + 8 + i * 8);
        const delta = v.getUint32(stts.start + 12 + i * 8);
        for (let k = 0; k < count; k++) {
          decode.push(t);
          t += delta;
        }
      }
    }
    const ctts = find(moov, stbl, 'ctts');
    const offsets: number[] = [];
    if (ctts) {
      const signed = (moov[ctts.start] ?? 0) === 1;
      const n = v.getUint32(ctts.start + 4);
      for (let i = 0; i < n; i++) {
        const count = v.getUint32(ctts.start + 8 + i * 8);
        const at = ctts.start + 12 + i * 8;
        const off = signed ? v.getInt32(at) : v.getUint32(at);
        for (let k = 0; k < count; k++) offsets.push(off);
      }
    }
    let mediaStart = 0;
    const elst = path(moov, trak, 'edts', 'elst');
    if (elst && v.getUint32(elst.start + 4) > 0) {
      const ev = moov[elst.start] ?? 0;
      mediaStart = ev === 1 ? Number(v.getBigInt64(elst.start + 16)) : v.getInt32(elst.start + 12);
      if (mediaStart < 0) mediaStart = 0;
    }
    const pts = decode.map((d, i) => d + (offsets[i] ?? 0) - mediaStart).sort((a, b) => a - b);
    const first = pts[0] ?? 0;
    const frameTimesMs = pts.map((p) => ((p - first) * 1000) / timescale);
    const total = decode.length
      ? (decode.at(-1) ?? 0) + ((decode.at(-1) ?? 0) - (decode.at(-2) ?? 0) || 0)
      : 0;
    const durationMs = (total * 1000) / timescale;
    return {
      width,
      height,
      codec,
      timescale,
      durationMs,
      frameCount: decode.length,
      fps: durationMs > 0 ? (decode.length * 1000) / durationMs : 0,
      frameTimesMs,
    };
  }
  throw new Error('The file has no video track.');
}
