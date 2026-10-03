import { describe, expect, it } from 'vitest';
import { KIT_FRAME, composeFrame, invertFrame, rotateY } from './frames';
import { convertKitCloud, decodeKitCloud, encodeKitCloud } from './cloud';
import { parseKitDataJs } from './kitdata';

function packed(points: [number, number, number, number][]): Uint8Array {
  const n = points.length;
  const out = new Uint8Array(n * 7);
  const view = new DataView(out.buffer);
  points.forEach(([x, y, z, i], k) => {
    view.setInt16(k * 6, x, true);
    view.setInt16(k * 6 + 2, y, true);
    view.setInt16(k * 6 + 4, z, true);
    out[n * 6 + k] = i;
  });
  return out;
}

describe('kit-packed clouds', () => {
  it('rotates kit points (mm) into the local frame and keeps intensity', () => {
    const src = packed([
      [1000, 2000, -300, 7],
      [-1664, 9129, 120, 255],
    ]);
    const out = convertKitCloud(src, KIT_FRAME);
    const d = decodeKitCloud(out);
    expect(d.count).toBe(2);
    // x = z_kit, y = y_kit, z = -x_kit
    expect(Array.from(d.xyz)).toEqual([-300, 2000, -1000, 120, 9129, 1664]);
    expect(Array.from(d.intensity)).toEqual([7, 255]);
  });

  it('round-trips through a rotated frame within 1 mm', () => {
    const src = packed([
      [1234, -567, 890, 1],
      [-2000, 30, 4100, 2],
    ]);
    const f = composeFrame(rotateY(23), [0.5, 0, -0.25]);
    const back = decodeKitCloud(convertKitCloud(convertKitCloud(src, f), invertFrame(f)));
    const orig = decodeKitCloud(src);
    back.xyz.forEach((v, i) => {
      expect(Math.abs(v - (orig.xyz[i] ?? 0))).toBeLessThanOrEqual(1);
    });
  });

  it('encodes what it decodes', () => {
    const src = packed([[1, 2, 3, 4]]);
    expect(Array.from(encodeKitCloud(decodeKitCloud(src)))).toEqual(Array.from(src));
  });

  it('rejects a buffer that is not a whole number of 7-byte points', () => {
    expect(() => decodeKitCloud(new Uint8Array(8))).toThrow(/7 bytes/);
  });
});

describe('parseKitDataJs', () => {
  it('reads the JSON payload of a kit data/*.js file', () => {
    const js =
      'window.__tankData=window.__tankData||{};window.__tankData["cloud101.txt"]="AAEC";\n';
    expect(parseKitDataJs(js)).toEqual({ key: 'cloud101.txt', value: 'AAEC' });
    const js2 = 'window.__tankData=window.__tankData||{};window.__tankData["f.json"]={"a":[1,2]};';
    expect(parseKitDataJs(js2)).toEqual({ key: 'f.json', value: { a: [1, 2] } });
  });
});
