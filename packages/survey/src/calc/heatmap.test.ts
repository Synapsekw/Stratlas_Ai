import { describe, expect, it } from 'vitest';
import {
  colourGrid,
  contourSegments,
  deadbandFromStops,
  DEFAULT_STOPS,
  heatRamp,
  stopsProblem,
} from './heatmap';

describe('heat map stops and the deadband', () => {
  it('the default stops (-1, -0.1, 0.1, 1) give a 0.1 m deadband', () => {
    expect(DEFAULT_STOPS.map((s) => s.value)).toEqual([-1, -0.1, 0.1, 1]);
    expect(deadbandFromStops(DEFAULT_STOPS)).toBe(0.1);
  });

  it('the deadband is the narrower inner band, and 0 when the stops do not straddle zero', () => {
    const s = (vs: number[]) => vs.map((value) => ({ value, color: '#000000' }));
    expect(deadbandFromStops(s([-2, -0.25, 0.05, 2]))).toBe(0.05);
    expect(deadbandFromStops(s([0.2, 1]))).toBe(0);
    expect(deadbandFromStops(s([-1, 0, 1]))).toBe(0);
  });

  it('refuses unusable stops', () => {
    expect(stopsProblem(DEFAULT_STOPS)).toBeNull();
    expect(stopsProblem([{ value: 1, color: '#000000' }])).toMatch(/two stops/);
    expect(
      stopsProblem([
        { value: 1, color: '#000000' },
        { value: 1, color: '#ffffff' },
      ]),
    ).toMatch(/same value/);
  });

  it('colours: clear in the deadband, clamped outside, smooth or stepped, inverted', () => {
    const smooth = heatRamp({ stops: [...DEFAULT_STOPS], stepped: false }, 255);
    expect(smooth.colorOf(0.05)).toBeNull();
    expect(smooth.colorOf(Number.NaN)).toBeNull();
    expect(smooth.colorOf(5)).toEqual([0x21, 0x66, 0xac, 255]);
    expect(smooth.colorOf(-5)).toEqual([0xb2, 0x18, 0x2b, 255]);
    const t = (0.55 - 0.1) / (1 - 0.1);
    expect(smooth.colorOf(0.55)).toEqual([
      Math.round(0x92 + (0x21 - 0x92) * t),
      Math.round(0xc5 + (0x66 - 0xc5) * t),
      Math.round(0xde + (0xac - 0xde) * t),
      255,
    ]);
    const stepped = heatRamp({ stops: [...DEFAULT_STOPS], stepped: true }, 255);
    expect(stepped.colorOf(0.55)).toEqual([0x92, 0xc5, 0xde, 255]);
    expect(stepped.colorOf(-0.55)).toEqual([0xf4, 0xa5, 0x82, 255]);
    const inv = heatRamp({ stops: [...DEFAULT_STOPS], stepped: true, inverted: true }, 255);
    expect(inv.colorOf(5)).toEqual([0xb2, 0x18, 0x2b, 255]);
    expect(inv.legend[0]?.color).toBe('#2166ac');
  });

  it('a grid is coloured north up', () => {
    const ramp = heatRamp({ stops: [...DEFAULT_STOPS], stepped: true }, 200);
    // row 0 (south) fill, row 1 (north) no data
    const px = colourGrid([2, 2, Number.NaN, Number.NaN], 2, 2, ramp);
    expect([...px.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...px.slice(8, 12)]).toEqual([0x21, 0x66, 0xac, 200]);
  });

  it('contours of a plane are straight lines at the interval', () => {
    // dz = x (columns 0 to 4), interval 1: levels 1, 2, 3, 4 (0 left out)
    const nx = 5;
    const ny = 3;
    const dz = Array.from({ length: nx * ny }, (_, k) => k % nx);
    const c = contourSegments(dz, nx, ny, 1);
    expect(c.map((x) => x.level)).toEqual([1, 2, 3, 4]);
    for (const { level, segments } of c)
      for (const [x0, , x1] of segments) {
        expect(x0).toBeCloseTo(level, 12);
        expect(x1).toBeCloseTo(level, 12);
      }
  });
});
