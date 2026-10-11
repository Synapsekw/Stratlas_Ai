import { describe, expect, it } from 'vitest';
import { readMp4Tracks, readMp4VideoInfo } from './mp4';

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

/** One track: video (with its size and optional spherical boxes) or sound. */
function track(o: {
  handler: 'vide' | 'soun';
  width?: number;
  height?: number;
  codec?: string;
  frames?: number;
  delta?: number;
  timescale?: number;
  /** Spherical Video V1: the XML in a uuid box of the track. */
  sphericalXml?: string;
  /** Spherical Video V2: the projection box inside sv3d of the sample entry. */
  projection?: 'equi' | 'cbmp';
}) {
  const frames = o.frames ?? 30;
  const delta = o.delta ?? 1001;
  const timescale = o.timescale ?? 30000;
  const tkhd = full(
    'tkhd',
    new Uint8Array(4 * 18),
    u32((o.width ?? 0) << 16),
    u32((o.height ?? 0) << 16),
  );
  const mdhd = full('mdhd', u32(0), u32(0), u32(timescale), u32(frames * delta), u32(0));
  const hdlr = full('hdlr', u32(0), ascii(o.handler), new Uint8Array(12), ascii('H\0'));
  const sv3d = o.projection
    ? [box('sv3d', full('svhd', ascii('x\0')), box('proj', full('prhd'), full(o.projection)))]
    : [];
  const entry = box(
    o.codec ?? (o.handler === 'vide' ? 'hvc1' : 'mp4a'),
    new Uint8Array(o.handler === 'vide' ? 78 : 28),
    ...sv3d,
  );
  const stbl = box(
    'stbl',
    full('stsd', u32(1), entry),
    full('stts', u32(1), u32(frames), u32(delta)),
  );
  const mdia = box('mdia', mdhd, hdlr, box('minf', stbl));
  const uuid = o.sphericalXml
    ? [
        box(
          'uuid',
          new Uint8Array([
            0xff, 0xcc, 0x82, 0x63, 0xf8, 0x55, 0x4a, 0x93, 0x88, 0x14, 0x58, 0x7a, 0x02, 0x52,
            0x1f, 0xdd,
          ]),
          ascii(o.sphericalXml),
        ),
      ]
    : [];
  return box('trak', tkhd, mdia, ...uuid);
}

const file = (...traks: Uint8Array[]) =>
  cat(box('ftyp', ascii('isom'), u32(0)), box('mdat', new Uint8Array(32)), box('moov', ...traks));

describe('readMp4Tracks', () => {
  it('lists every track: two lens streams and the sound of a 360 camera file', async () => {
    const lens = { handler: 'vide' as const, width: 2880, height: 2880, frames: 60, delta: 1001 };
    const b = file(
      track({ ...lens, timescale: 60000 }),
      track({ ...lens, timescale: 60000 }),
      track({ handler: 'soun' }),
    );
    const r = await readMp4Tracks(reader(b), b.length);
    expect(r.tracks.map((t) => t.handler)).toEqual(['vide', 'vide', 'soun']);
    const [a, c] = r.tracks;
    expect(a).toMatchObject({ width: 2880, height: 2880, codec: 'hvc1', frameCount: 60 });
    expect(a?.fps).toBeCloseTo(59.94, 2);
    expect(a?.durationMs).toBeCloseTo(1001, 3);
    expect(c).toMatchObject({ width: 2880, height: 2880, spherical: null });
  });

  it('reads the Spherical Video V1 projection from the track uuid box', async () => {
    const xml =
      '<rdf:SphericalVideo><GSpherical:Spherical>true</GSpherical:Spherical>' +
      '<GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType></rdf:SphericalVideo>';
    const b = file(track({ handler: 'vide', width: 1920, height: 1080, sphericalXml: xml }));
    const r = await readMp4Tracks(reader(b), b.length);
    expect(r.tracks[0]?.spherical).toBe('equirectangular');
  });

  it('reads the Spherical Video V2 projection from the sample entry', async () => {
    const equi = file(track({ handler: 'vide', width: 3840, height: 1920, projection: 'equi' }));
    expect((await readMp4Tracks(reader(equi), equi.length)).tracks[0]?.spherical).toBe(
      'equirectangular',
    );
    const cube = file(track({ handler: 'vide', width: 3840, height: 1920, projection: 'cbmp' }));
    expect((await readMp4Tracks(reader(cube), cube.length)).tracks[0]?.spherical).toBe('other');
  });

  it('says so when the file is not an MP4', async () => {
    const b = ascii('this is not a movie file at all, just text');
    await expect(readMp4Tracks(reader(b), b.length)).rejects.toThrow(/Not an MP4/);
  });
});
