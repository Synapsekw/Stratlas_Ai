import { describe, expect, it } from 'vitest';
import { encodeBits, encodeDeltaI16, syntheticPile } from '../testing';
import {
  decodeBits,
  decodeDeltaI16,
  decodeDsm,
  decodePile,
  inflate,
  parseKitScript,
} from './kitdata';

describe('parseKitScript', () => {
  it('reads keyed kit scripts', () => {
    const r = parseKitScript(
      'window.VS_PILE=window.VS_PILE||{};window.VS_PILE["P07"]={"a":1};',
      'VS_PILE',
    );
    expect(r).toEqual({ key: 'P07', value: { a: 1 } });
  });

  it('reads plain kit scripts', () => {
    expect(parseKitScript('window.VS_VOL={"res":0.4};\n', 'VS_VOL')).toEqual({
      key: null,
      value: { res: 0.4 },
    });
  });

  it('names the script it expected', () => {
    expect(() => parseKitScript('var x=1;', 'VS_DSM')).toThrow(/VS_DSM/);
  });
});

describe('grid decoding', () => {
  it('undoes the row deltas of an int16 grid', async () => {
    const values = [5, 7, -3, 100, 0, 0, 2, 1];
    const g = decodeDeltaI16(await inflate(encodeDeltaI16(values, 4, 2)), 4, 2);
    expect([...g]).toEqual(values);
  });

  it('unpacks a bit mask, most significant bit first', async () => {
    const bits = [1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1];
    expect([...decodeBits(await inflate(encodeBits(bits)), bits.length)]).toEqual(bits);
  });
});

describe('decodePile', () => {
  it('decodes surfaces, masks and bases per survey', async () => {
    const s = syntheticPile();
    const p = await decodePile(s.text);
    expect(p).toMatchObject({ id: 'P01', w: 20, h: 10, res: 0.1, x0: 1000, y1: 2000, zoff: 50 });
    expect([...p.zone]).toEqual(s.mask);
    expect([...(p.ep.e2?.z ?? [])]).toEqual(s.z.e2);
    expect(p.ep.e1?.m).toBeUndefined();
    expect(p.ep.e2).toMatchObject({ low: 51, avg: 51.5, plane: [51, 0, 0] });
    expect([...(p.ep.e2?.m ?? [])]).toEqual(s.mask);
  });
});

describe('decodeDsm', () => {
  it('decodes a site DSM with its valid mask', async () => {
    const z = [100, 110, 120, 130, 140, 150];
    const text = `window.VS_DSM=window.VS_DSM||{};window.VS_DSM["e1"]=${JSON.stringify({
      res: 0.4,
      w: 3,
      h: 2,
      x0: 10,
      y1: 20,
      zoff: 50,
      z: encodeDeltaI16(z, 3, 2),
      valid: encodeBits([1, 1, 1, 0, 1, 1]),
    })};`;
    const d = await decodeDsm(text);
    expect(d).toMatchObject({ epoch: 'e1', res: 0.4, w: 3, h: 2, x0: 10, y1: 20, zoff: 50 });
    expect([...d.z]).toEqual(z);
    expect([...d.valid]).toEqual([1, 1, 1, 0, 1, 1]);
  });
});
