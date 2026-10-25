import type { ProjectGeo } from '@aio/geo';
import type { Georef, Layer, LayerPatch, Mat4, Placement } from '@aio/schema';
import type { Box } from '../shell/layerBounds';
import { formatDistance } from './alignTo';
import { patchOf, placedPatch } from './modelPlacement';

/** A cloud's low point: this percentile of its sampled heights, so stray low points are ignored. */
export const DROP_CLOUD_PERCENTILE = 0.02;
/** The DSM is sampled on a grid of this many points a side over the item's plan box. */
export const GROUND_GRID = 7;
/** The ground is this percentile of the DSM hits. */
export const GROUND_PERCENTILE = 0.1;
/** Fewer DSM hits than this: the project ground level (y = 0) is the ground. */
export const MIN_GROUND_HITS = 5;
/** An item closer than this to the ground stays where it is. */
export const MIN_DROP_M = 0.05;

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The `p` percentile (0..1) of the values, linear between neighbours; null of none. */
export function percentile(values: readonly number[], p: number): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const at = Math.min(1, Math.max(0, p)) * (v.length - 1);
  const lo = Math.floor(at);
  const hi = Math.min(v.length - 1, lo + 1);
  const a = v[lo] ?? 0;
  const b = v[hi] ?? a;
  return a + (b - a) * (at - lo);
}

/**
 * The ground under an item's plan box: the DSM sampled straight down on a `GROUND_GRID` square
 * grid spanning the box (edges included), its `GROUND_PERCENTILE` with at least `MIN_GROUND_HITS`
 * hits; else the project ground level, y = 0.
 */
export function groundUnder(
  box: Box,
  sample: (x: number, z: number) => number | null,
): { y: number; source: 'dsm' | 'project' } {
  const hits: number[] = [];
  const step = (k: 0 | 2, i: number) =>
    box.min[k] + ((box.max[k] - box.min[k]) * i) / (GROUND_GRID - 1);
  for (let i = 0; i < GROUND_GRID; i++)
    for (let j = 0; j < GROUND_GRID; j++) {
      const y = sample(step(0, i), step(2, j));
      if (y !== null && Number.isFinite(y)) hits.push(y);
    }
  const y = hits.length >= MIN_GROUND_HITS ? percentile(hits, GROUND_PERCENTILE) : null;
  return y === null ? { y: 0, source: 'project' } : { y, source: 'dsm' };
}

/**
 * What Drop to ground moves: a cloud or a walk by its height offset, a model by its transform. A
 * walk's `low` is 0 and the ground it is dropped onto the floor's median height over its ground
 * (`walkFloorShift`): the shift itself.
 */
export type DropItem =
  | {
      kind: 'pointcloud' | 'walk';
      layerId: string;
      name: string;
      low: number;
      heightOffsetM: number;
    }
  | {
      kind: 'mesh';
      layerId: string;
      name: string;
      low: number;
      transform: Mat4;
      georef?: Georef | undefined;
      placement?: Placement | undefined;
    };

/** One write of a drop and the write that takes it back. */
export interface DropStep {
  layerId: string;
  name: string;
  /** Metres moved up (negative: down). */
  shift: number;
  patch: LayerPatch;
  undo: LayerPatch;
}

/**
 * The write that puts an item's low point on `groundY`; null when it is within `MIN_DROP_M`. A
 * cloud's offset changes (0 clears it); a model moves by its transform and is saved as Place model
 * saves on Done (`placedPatch`), its Undo the placement it had (`patchOf`).
 */
export function planDrop(item: DropItem, groundY: number, project: ProjectGeo): DropStep | null {
  const shift = r3(groundY - item.low);
  if (!Number.isFinite(shift) || Math.abs(groundY - item.low) < MIN_DROP_M) return null;
  const head = { layerId: item.layerId, name: item.name, shift };
  if (item.kind !== 'mesh') {
    const cur = item.heightOffsetM;
    return {
      ...head,
      patch: { heightOffsetM: r3(cur + shift) || null },
      undo: { heightOffsetM: cur || null },
    };
  }
  const transform = [...item.transform] as Mat4;
  transform[13] = (transform[13] ?? 0) + shift;
  return {
    ...head,
    patch: placedPatch(item, transform, project),
    undo: patchOf({ transform: item.transform, georef: item.georef, placement: item.placement }),
  };
}

/** "31.2 m": one decimal, the distance only (from 1 km up as `formatDistance`). */
export function formatShift(m: number): string {
  const a = Math.abs(m);
  return a >= 1000 ? formatDistance(a) : `${a.toFixed(1)} m`;
}

/**
 * Whether a dataset can be dropped: `ok` for a COPC or png-packed cloud and a model, not change
 * results or drafts, and a placed walk; `kit` for a kit-packed cloud (it cannot take an offset);
 * `no` otherwise.
 */
export function droppable(l: Layer): 'ok' | 'kit' | 'no' {
  if (l.kind === 'walk') return l.place && l.place.quality !== 'unplaced' ? 'ok' : 'no';
  if (l.kind === 'pointcloud') {
    if (l.derived?.kind === 'change') return 'no';
    if (l.format === 'kit-packed') return 'kit';
    return l.format === 'copc' || l.format === 'png-packed' ? 'ok' : 'no';
  }
  if (l.kind === 'mesh') return l.derived?.kind === 'change' || l.derived?.draft ? 'no' : 'ok';
  return 'no';
}
