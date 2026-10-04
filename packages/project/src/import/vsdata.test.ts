import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeBits,
  decodeDeltaI16,
  parseVsDataJs,
  pileChange,
  pileVolume,
  type VsPileGrids,
} from './vsdata';

/** Encode like the kit's package.py: row-wise int16 deltas, zlib, base64. */
function encI16(a: readonly number[], w: number): string {
  const d = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) d[i] = (a[i] ?? 0) - (i % w === 0 ? 0 : (a[i - 1] ?? 0));
  return deflateSync(Buffer.from(d.buffer)).toString('base64');
}

/** Encode like numpy packbits (most significant bit first), zlib, base64. */
function encBits(bits: readonly number[]): string {
  const u = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) u[i >> 3] = (u[i >> 3] ?? 0) | (1 << (7 - (i & 7)));
  });
  return deflateSync(u).toString('base64');
}

describe('Volumetric Survey Kit data scripts', () => {
  it('reads a plain window assignment', () => {
    const r = parseVsDataJs(
      'window.VS_CONFIG={"maxNative": 5, "target": "offline"};\n',
      'VS_CONFIG',
    );
    expect(r).toEqual({ key: null, value: { maxNative: 5, target: 'offline' } });
  });

  it('reads a keyed window assignment', () => {
    const r = parseVsDataJs(
      'window.VS_PILE=window.VS_PILE||{};window.VS_PILE["P07"]={"id":"P07","res":0.1};',
      'VS_PILE',
    );
    expect(r).toEqual({ key: 'P07', value: { id: 'P07', res: 0.1 } });
  });

  it('reads a keyed string value', () => {
    const r = parseVsDataJs(
      'window.VS_TEX=window.VS_TEX||{};window.VS_TEX["e1"]="data:image/jpeg;base64,AAAA";',
      'VS_TEX',
    );
    expect(r).toEqual({ key: 'e1', value: 'data:image/jpeg;base64,AAAA' });
  });

  it('rejects a script for another variable', () => {
    expect(() => parseVsDataJs('window.VS_SITE={};', 'VS_VOL')).toThrow(/VS_VOL/);
  });
});

describe('grid decoding', () => {
  it('undoes the row-wise int16 deltas', () => {
    const z = [1000, 1010, 990, -5, 2000, 2001];
    expect([...decodeDeltaI16(encI16(z, 3), 3, 2)]).toEqual(z);
  });

  it('unpacks bits most significant first', () => {
    const bits = [1, 0, 0, 1, 1, 0, 1, 0, 1, 1];
    expect([...decodeBits(encBits(bits), bits.length)]).toEqual(bits);
  });
});

describe('pile volume (mirrors the kit viewer)', () => {
  // 3 x 2 cells of 0.1 m, zoff 50: surface heights in cm above zoff.
  const w = 3;
  const h = 2;
  const grids: VsPileGrids = {
    w,
    h,
    res: 0.1,
    zoff: 50,
    zone: Uint8Array.from([1, 1, 1, 1, 1, 0]),
    ep: {
      e1: {
        z: Int16Array.from([1200, 1100, 1000, 1000, 1000, 1000]),
        m: Uint8Array.from([1, 1, 1, 1, 0, 0]),
        tin: Int16Array.from([1000, 1000, 1000, 1100, 1000, 1000]),
        low: 60,
        avg: 60.5,
        plane: [60, 1, 0],
      },
      e2: {
        z: Int16Array.from([1100, 1100, 1300, 1005, 1000, 2000]),
        m: Uint8Array.from([1, 1, 1, 0, 0, 0]),
        tin: Int16Array.from([1000, 1000, 1000, 1000, 1000, 1000]),
        low: 60,
        avg: 60,
        plane: [60, 0, 0],
      },
    },
  };

  it('sums fill and cut over the masked cells against each base', () => {
    // e1 masked cells: z = 62, 61, 60, 60 m
    const low = pileVolume(grids, 'e1', 'low');
    expect(low?.fill).toBeCloseTo(0.03, 10);
    expect(low?.cut).toBe(0);
    expect(low?.heightM).toBeCloseTo(2, 10);
    const avg = pileVolume(grids, 'e1', 'avg');
    expect(avg?.fill).toBeCloseTo(0.02, 10); // (1.5 + 0.5) * 0.01
    expect(avg?.cut).toBeCloseTo(0.01, 10); // (0.5 + 0.5) * 0.01
    // tin base 60, 60, 60, 61: fill 2 + 1, cut 1
    const tin = pileVolume(grids, 'e1', 'tin');
    expect(tin?.fill).toBeCloseTo(0.03, 10);
    expect(tin?.cut).toBeCloseTo(0.01, 10);
    expect(tin?.areaM2).toBeCloseTo(0.04, 10);
    expect(tin?.topM).toBeCloseTo(62, 10);
  });

  it('evaluates the plane base at cell centres', () => {
    // plane 60 + 1 * x_m: cells (0,0) 60.05, (1,0) 60.15, (2,0) 60.25, (0,1) 60.05
    const v = pileVolume(grids, 'e1', 'plane');
    expect(v?.fill).toBeCloseTo((1.95 + 0.85) * 0.01, 10);
    expect(v?.cut).toBeCloseTo((0.25 + 0.05) * 0.01, 10);
  });

  it('measures change inside the zone with a deadband', () => {
    // zone cells: d = -1, 0, +3, +0.05 (dead), 0
    const c = pileChange(grids, 'e1', 'e2', 0.1);
    expect(c.fill).toBeCloseTo(0.03, 10);
    expect(c.cut).toBeCloseTo(0.01, 10);
    expect(c.net).toBeCloseTo(0.02, 10);
  });

  it('returns null for a date without a pile mask', () => {
    const g: VsPileGrids = { ...grids, ep: { e1: { z: Int16Array.from([0, 0, 0, 0, 0, 0]) } } };
    expect(pileVolume(g, 'e1', 'tin')).toBeNull();
  });
});
