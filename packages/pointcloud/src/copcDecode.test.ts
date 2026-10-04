import { describe, expect, it } from 'vitest';
import { decodeLasRecords, type LasLayout } from './copcDecode';

interface Pt {
  e: number;
  n: number;
  h: number;
  i?: number;
  c?: number;
  rgb?: [number, number, number];
}

/** LAS 1.4 point records (formats 6 and 7) with scale 0.001 and the given offsets. */
function records(pdrf: 6 | 7, pts: Pt[], offset: [number, number, number]): Uint8Array {
  const len = pdrf === 7 ? 36 : 30;
  const buf = new ArrayBuffer(len * pts.length);
  const v = new DataView(buf);
  pts.forEach((p, k) => {
    const o = k * len;
    v.setInt32(o, Math.round((p.e - offset[0]) / 0.001), true);
    v.setInt32(o + 4, Math.round((p.n - offset[1]) / 0.001), true);
    v.setInt32(o + 8, Math.round((p.h - offset[2]) / 0.001), true);
    v.setUint16(o + 12, p.i ?? 0, true);
    v.setUint8(o + 16, p.c ?? 0);
    if (pdrf === 7) {
      v.setUint16(o + 30, p.rgb?.[0] ?? 0, true);
      v.setUint16(o + 32, p.rgb?.[1] ?? 0, true);
      v.setUint16(o + 34, p.rgb?.[2] ?? 0, true);
    }
  });
  return new Uint8Array(buf);
}

const layout = (pdrf: number, len: number): LasLayout => ({
  pointDataRecordFormat: pdrf,
  pointDataRecordLength: len,
  scale: [0.001, 0.001, 0.001],
  offset: [245000, 3179000, 0],
});

// origin E 245714, N 3179542, H 100; node box in the local frame
const origin = [245714, 3179542, 100] as const;
const box = { min: [-10, -20, -10] as const, max: [10, 0, 10] as const };

describe('decodeLasRecords', () => {
  it('maps CRS coordinates to the local frame, quantised to uint16 over the node box', () => {
    const pts: Pt[] = [
      { e: 245714, n: 3179542, h: 100 }, // origin: local (0, 0, 0)
      { e: 245704, n: 3179552, h: 80 }, // local (-10, -20, -10): the box minimum
      { e: 245720.5, n: 3179539, h: 95.25 }, // local (6.5, -4.75, 3)
    ];
    const d = decodeLasRecords(
      records(6, pts, [245000, 3179000, 0]),
      layout(6, 30),
      3,
      origin,
      box,
    );
    expect(d.count).toBe(3);
    const step = d.quant.scale;
    const at = (k: number, a: number) =>
      (d.quant.offset[a] ?? 0) + (step[a] ?? 0) * (d.position[3 * k + a] ?? 0);
    const want = [
      [0, 0, 0],
      [-10, -20, -10],
      [6.5, -4.75, 3],
    ];
    want.forEach((w, k) => {
      w.forEach((x, a) => {
        expect(at(k, a)).toBeCloseTo(x, 3);
      });
    });
    expect(d.bounds.min).toEqual([-10, -20, -10]);
    expect(d.bounds.max[0]).toBeCloseTo(6.5, 6);
  });

  it('keeps intensity and classification, and counts the classes', () => {
    const pts: Pt[] = [
      { e: 245714, n: 3179542, h: 100, i: 65280, c: 2 },
      { e: 245714, n: 3179542, h: 100, i: 256, c: 2 },
      { e: 245714, n: 3179542, h: 100, i: 0, c: 6 },
    ];
    const d = decodeLasRecords(
      records(6, pts, [245000, 3179000, 0]),
      layout(6, 30),
      3,
      origin,
      box,
    );
    expect(d.rgb).toBeUndefined();
    expect([...(d.intensity ?? [])]).toEqual([255, 1, 0]); // 16-bit intensity scaled to 8 bits
    expect([...(d.classification ?? [])]).toEqual([2, 2, 6]);
    expect(d.classes).toEqual({ 2: 2, 6: 1 });
  });

  it('reads 16-bit RGB as 8-bit, and 8-bit RGB as is', () => {
    const p16: Pt[] = [{ e: 245714, n: 3179542, h: 100, rgb: [65535, 32768, 256] }];
    const d16 = decodeLasRecords(
      records(7, p16, [245000, 3179000, 0]),
      layout(7, 36),
      1,
      origin,
      box,
    );
    expect([...(d16.rgb ?? [])]).toEqual([255, 128, 1]);
    const p8: Pt[] = [{ e: 245714, n: 3179542, h: 100, rgb: [200, 100, 3] }];
    const d8 = decodeLasRecords(
      records(7, p8, [245000, 3179000, 0]),
      layout(7, 36),
      1,
      origin,
      box,
    );
    expect([...(d8.rgb ?? [])]).toEqual([200, 100, 3]);
  });

  it('refuses point formats it cannot read', () => {
    expect(() => decodeLasRecords(new Uint8Array(20), layout(0, 20), 1, origin, box)).toThrow(
      /point format 0/,
    );
  });
});
