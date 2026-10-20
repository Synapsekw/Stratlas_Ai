// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: true, value: [] }) },
  useShell: () => null,
}));
import type { HeatGrid } from './engineProtocol';
import { heatHistogram } from './heatScene';

const grid = (dz: number[]): HeatGrid => ({
  item: 'i',
  x0: 0,
  y0: 0,
  cellM: 1,
  nx: dz.length,
  ny: 1,
  dz: new Float32Array(dz),
  z: new Float32Array(dz.length),
});
const stops = [
  { value: -1, color: '#b2182b' },
  { value: 1, color: '#2166ac' },
];

describe('heatHistogram', () => {
  it('bins sum to the cell count', () => {
    const h = heatHistogram(grid([-3, -0.5, 0, 0.2, 0.9, 5, NaN]), stops, 24);
    expect(h).toHaveLength(24);
    expect(h.reduce((a, b) => a + b, 0)).toBe(6);
  });
  it('puts values outside the stops in the end bins', () => {
    const h = heatHistogram(grid([-9, 9]), stops, 4);
    expect(h).toEqual([1, 0, 0, 1]);
  });
});
