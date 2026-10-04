import { describe, expect, it } from 'vitest';
import { readMp4VideoInfo } from './mp4';

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const ascii = (s: string) => new TextEncoder().encode(s);
const box = (type: string, ...body: Uint8Array[]) => {
  const b = cat(...body);
  return cat(u32(b.length + 8), ascii(type), b);
};
const full = (type: string, ...body: Uint8Array[]) => box(type, u32(0), ...body);

/** A moov with one video track: 30000/1001 fps as stts runs, optional ctts and edit list. */
function movie(o: {
  frames: number;
  delta: number;
  timescale: number;
  ctts?: [number, number][];
  editMediaTime?: number;
  handler?: string;
}) {
  const tkhd = full('tkhd', new Uint8Array(4 * 18), u32(3840 << 16), u32(2160 << 16));
  const mdhd = full('mdhd', u32(0), u32(0), u32(o.timescale), u32(o.frames * o.delta), u32(0));
  const hdlr = full('hdlr', u32(0), ascii(o.handler ?? 'vide'), new Uint8Array(12), ascii('V\0'));
  const stsd = full('stsd', u32(1), box('avc1', new Uint8Array(78)));
  const stts = full('stts', u32(1), u32(o.frames), u32(o.delta));
  const ctts = o.ctts
    ? [full('ctts', u32(o.ctts.length), ...o.ctts.flatMap(([c, off]) => [u32(c), u32(off)]))]
    : [];
  const stbl = box('stbl', stsd, stts, ...ctts);
  const minf = box('minf', stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const edts =
    o.editMediaTime !== undefined
      ? [box('edts', full('elst', u32(1), u32(0), u32(o.editMediaTime), u32(0x10000)))]
      : [];
  const trak = box('trak', tkhd, ...edts, mdia);
  return cat(
    box('ftyp', ascii('isom'), u32(0)),
    box('mdat', new Uint8Array(64)),
    box('moov', trak),
  );
}

const reader = (b: Uint8Array) => (offset: number, length: number) =>
  Promise.resolve(b.subarray(offset, offset + length));

describe('readMp4VideoInfo', () => {
  it('reads size, codec, frame count and every frame time (moov after mdat)', async () => {
    const b = movie({ frames: 270, delta: 1001, timescale: 30000 });
    const info = await readMp4VideoInfo(reader(b), b.length);
    expect(info).toMatchObject({ width: 3840, height: 2160, codec: 'avc1', frameCount: 270 });
    expect(info.fps).toBeCloseTo(29.97, 2);
    expect(info.durationMs).toBeCloseTo(9009, 3);
    expect(info.frameTimesMs[1]).toBeCloseTo(33.3667, 3);
    expect(info.frameTimesMs[269]).toBeCloseTo(269 * 33.3667, 1);
  });

  it('puts frames in presentation order with composition offsets and the edit list', async () => {
    // I P B B: decode order times 0,1,2,3 (x1000); offsets reorder to 1,4,2,3 then shift by 1000
    const b = movie({
      frames: 4,
      delta: 1000,
      timescale: 30000,
      ctts: [
        [1, 1000],
        [1, 3000],
        [2, 0],
      ],
      editMediaTime: 1000,
    });
    const info = await readMp4VideoInfo(reader(b), b.length);
    expect(info.frameTimesMs.map((t) => Math.round(t * 30))).toEqual([0, 1000, 2000, 3000]);
  });

  it('says so when the file has no video track', async () => {
    const b = movie({ frames: 1, delta: 1, timescale: 1, handler: 'soun' });
    await expect(readMp4VideoInfo(reader(b), b.length)).rejects.toThrow(/no video track/i);
  });
});
