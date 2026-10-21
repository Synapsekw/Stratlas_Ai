import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TSDK_MODELS, thermalFamily } from './probe';

const bytes = (...parts: (number[] | string | Uint8Array)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...p);
  }
  return Uint8Array.from(out);
};
const segment = (marker: number, payload: Uint8Array): Uint8Array =>
  bytes([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], payload);
const SOI = [0xff, 0xd8];
const SOS = [0xff, 0xda, 0, 2];

/** An Exif APP1 payload (little endian) whose IFD0 holds Make and Model. */
function exif(make: string | null, model: string | null): Uint8Array {
  const entries: [number, string][] = [];
  if (make !== null) entries.push([0x010f, make]);
  if (model !== null) entries.push([0x0110, model]);
  const ifdLen = 2 + entries.length * 12 + 4;
  let dataAt = 8 + ifdLen;
  const ifd: number[] = [entries.length & 0xff, 0];
  const data: number[] = [];
  for (const [tag, text] of entries) {
    const t = text
      .split('')
      .map((c) => c.charCodeAt(0))
      .concat(0);
    ifd.push(tag & 0xff, tag >> 8, 2, 0, t.length & 0xff, 0, 0, 0);
    if (t.length <= 4) ifd.push(...t, ...new Array<number>(4 - t.length).fill(0));
    else {
      ifd.push(dataAt & 0xff, dataAt >> 8, 0, 0);
      data.push(...t);
      dataAt += t.length;
    }
  }
  ifd.push(0, 0, 0, 0);
  return bytes('Exif\0\0', 'II', [42, 0, 8, 0, 0, 0], ifd, data);
}
const xmp = (model: string): Uint8Array =>
  bytes(
    'http://ns.adobe.com/xap/1.0/\0',
    `<x:xmpmeta><rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" drone-dji:Model="${model}"/></x:xmpmeta>`,
  );
const flirApp1 = (): Uint8Array => bytes('FLIR\0', [1, 0, 0], 'FFF\0');

describe('thermalFamily', () => {
  it('reads FLIR from an APP1 headed FLIR and takes make and model from Exif', () => {
    const head = bytes(
      SOI,
      segment(0xe1, exif('FLIR', 'FLIR Vue Pro R')),
      segment(0xe1, flirApp1()),
      SOS,
    );
    expect(thermalFamily(head)).toEqual({ family: 'flir', make: 'FLIR', model: 'FLIR Vue Pro R' });
  });

  it('reads FLIR without Exif', () => {
    expect(thermalFamily(bytes(SOI, segment(0xe1, flirApp1()), SOS))).toEqual({
      family: 'flir',
      make: 'FLIR',
      model: '',
    });
  });

  it('gives null for a plain JPEG with Exif only', () => {
    expect(thermalFamily(bytes(SOI, segment(0xe1, exif('Canon', 'EOS R5')), SOS))).toBeNull();
    expect(thermalFamily(bytes(SOI, SOS))).toBeNull();
    expect(thermalFamily(bytes([1, 2, 3, 4]))).toBeNull();
    expect(thermalFamily(new Uint8Array())).toBeNull();
  });

  it('reads DJI from thermal APP3 segments and the XMP model', () => {
    const head = bytes(
      SOI,
      segment(0xe1, exif('DJI', 'ZH20T')),
      segment(0xe1, xmp('m30t')),
      segment(0xe3, bytes('DJI-thermal-block')),
      SOS,
    );
    expect(thermalFamily(head)).toEqual({ family: 'dji-tsdk', make: 'DJI', model: 'M30T' });
  });

  it('falls back to the Exif model when there is no XMP', () => {
    const head = bytes(SOI, segment(0xe1, exif('DJI', 'ZH20T')), segment(0xe3, bytes('x')), SOS);
    expect(thermalFamily(head)).toEqual({ family: 'dji-tsdk', make: 'DJI', model: 'ZH20T' });
  });

  it('gives null for a DJI photo without APP3 or with an unlisted model', () => {
    expect(thermalFamily(bytes(SOI, segment(0xe1, xmp('M30T')), SOS))).toBeNull();
    expect(
      thermalFamily(bytes(SOI, segment(0xe1, xmp('FC3582')), segment(0xe3, bytes('x')), SOS)),
    ).toBeNull();
  });

  // follow-up: add cases on the xt2Thermal and xt2Visual helpers once feat/photo-position-edit lands.
});

describe('TSDK_MODELS', () => {
  it('equals the list in the Python decoder', () => {
    const py = readFileSync(
      new URL('../../../../python/src/aio_pipelines/thermal/dji_tsdk.py', import.meta.url),
      'utf8',
    );
    const block = /TSDK_MODELS[^=]*=\s*frozenset\(\s*\{([^}]*)\}/.exec(py);
    expect(block).not.toBeNull();
    const names = [...(block?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...TSDK_MODELS].sort()).toEqual([...names].sort());
  });
});
