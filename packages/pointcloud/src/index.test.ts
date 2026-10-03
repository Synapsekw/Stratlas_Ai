import { describe, expect, it } from 'vitest';
import { decodeKitPacked } from './index';

describe('decodeKitPacked', () => {
  it('decodes two points', () => {
    const buf = new ArrayBuffer(14);
    const v = new DataView(buf);
    v.setInt16(0, 1000, true);
    v.setInt16(2, -2000, true);
    v.setInt16(4, 500, true);
    v.setUint8(6, 200);
    v.setInt16(7, 0, true);
    v.setInt16(9, 0, true);
    v.setInt16(11, 1, true);
    v.setUint8(13, 7);
    const c = decodeKitPacked(buf);
    expect(c.count).toBe(2);
    expect(Array.from(c.positions.slice(0, 3))).toEqual([1, -2, 0.5]);
    expect(Array.from(c.intensity)).toEqual([200, 7]);
  });

  it('rejects a truncated buffer', () => {
    expect(() => decodeKitPacked(new ArrayBuffer(8))).toThrow('not a multiple of 7');
  });
});
