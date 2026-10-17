/**
 * What the imagery change specs check a run against: the change demo's `truth.json` (the changes
 * its orthos show, the lighting-only cloud shadow and tint that must not count) and the regions
 * of the run's `change/<pair>-raster.json`.
 */
import { expect } from './fixtures';

export type XZ = [number, number];
export interface RasterTruth {
  expected: { id: string; verdict: string; outlineLocal: XZ[] }[];
  clean: { id: string; outlineLocal: XZ[] }[];
  counts: { expected: number; large: number; clean: number };
}

export interface Item {
  verdict: string;
  at?: number[];
  bounds?: { min: number[]; max: number[] };
  areaM2?: number;
  volume?: { cutM3: number; fillM3: number };
}

/** The x and z extent of an outline, widened by `margin` metres. */
export function box(outline: XZ[], margin = 0) {
  const xs = outline.map((p) => p[0]);
  const zs = outline.map((p) => p[1]);
  return {
    x0: Math.min(...xs) - margin,
    x1: Math.max(...xs) + margin,
    z0: Math.min(...zs) - margin,
    z1: Math.max(...zs) + margin,
  };
}
export const inside = (at: number[] | undefined, b: ReturnType<typeof box>) =>
  at !== undefined &&
  (at[0] ?? NaN) >= b.x0 &&
  (at[0] ?? NaN) <= b.x1 &&
  (at[2] ?? NaN) >= b.z0 &&
  (at[2] ?? NaN) <= b.z1;

/** True when a region's bounds (x and z) meet the box. */
export const meets = (i: Item, b: ReturnType<typeof box>) =>
  i.bounds !== undefined &&
  (i.bounds.min[0] ?? NaN) <= b.x1 &&
  (i.bounds.max[0] ?? NaN) >= b.x0 &&
  (i.bounds.min[2] ?? NaN) <= b.z1 &&
  (i.bounds.max[2] ?? NaN) >= b.z0;

/** The regions of an imagery change run hold truth's changes and nothing from light, tint or noise. */
export function expectRegionsMatchTruth(items: Item[], rt: RasterTruth): void {
  // the large changes (the markers are smaller than the default smallest area)
  const large = rt.expected.filter((e) => {
    const b = box(e.outlineLocal);
    return (b.x1 - b.x0) * (b.z1 - b.z0) >= 2;
  });
  expect(large).toHaveLength(rt.counts.large);
  // each large change lies in a region (a region may hold two changes that touch)
  for (const e of large)
    expect(
      items.some((i) => meets(i, box(e.outlineLocal, 0.5))),
      e.id,
    ).toBe(true);
  for (const c of rt.clean)
    expect(
      items.some((i) => inside(i.at, box(c.outlineLocal))),
      c.id,
    ).toBe(false);
  // every region holds one of truth's changes: nothing from light, tint or noise
  for (const i of items)
    expect(
      rt.expected.some((e) => meets(i, box(e.outlineLocal, 0.5))),
      JSON.stringify(i.at),
    ).toBe(true);
}
