// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: true, value: [] }) },
  useShell: () => null,
}));
import type { CompareState } from './compareStore';
import type { HeatGrid } from './engineProtocol';
import { mapHeat, type KitChange } from './heatScene';
import type { MeasureState } from './measureStore';

const cells = { x0: 10, y0: 20, cellM: 2, nx: 2, ny: 1 };
const site: HeatGrid = {
  item: 'site',
  ...cells,
  dz: new Float32Array([-1, 1]),
  z: new Float32Array(2),
};
const kitGrid = { ...cells, dz: new Float32Array([0.5, -0.5]) };
const compare = (siteHeat: HeatGrid | null, show2d = true) =>
  ({
    computed: {},
    heat: { show3d: true, show2d, contours: false, item: null },
    siteHeat,
  }) as unknown as Pick<CompareState, 'computed' | 'heat'> & { siteHeat: HeatGrid | null };
const measure = { focus: null, file: { measurements: [] } } as unknown as MeasureState;
const kit = (over: Partial<KitChange> = {}): KitChange => ({
  status: 'ready',
  surface: 'change',
  change: { from: 'e1', to: 'e2' },
  changeGrid: { from: 'e1', to: 'e2', grid: kitGrid },
  ...over,
});

describe('mapHeat', () => {
  it("draws the stockpile kit's Cut & fill difference on the map", () => {
    // a kit project's Cut & fill: no survey site heat, the kit's engine grid for its pair
    expect(mapHeat(compare(null), measure, kit())).toBe(kitGrid);
  });
  it('draws it even with the survey 2D heat switched off', () => {
    expect(mapHeat(compare(null, false), measure, kit())).toBe(kitGrid);
  });
  it('draws nothing of the kit off Cut & fill, without the kit or for a stale pair', () => {
    expect(mapHeat(compare(null), measure, kit({ surface: 'photo' }))).toBeNull();
    expect(mapHeat(compare(null), measure, kit({ status: 'none' }))).toBeNull();
    expect(mapHeat(compare(null), measure, kit({ change: { from: 'e2', to: 'e1' } }))).toBeNull();
  });
  it("keeps the survey project's whole-site heat map", () => {
    expect(mapHeat(compare(site), measure, kit({ status: 'none' }))).toBe(site);
    expect(mapHeat(compare(site, false), measure, kit({ status: 'none' }))).toBeNull();
  });
});
