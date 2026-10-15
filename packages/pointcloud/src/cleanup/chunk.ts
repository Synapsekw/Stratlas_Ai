/**
 * A chunk's cleanup mask and class override (the selections only; the clip box and heights are
 * shader uniforms): 1 in `mask` for a point a hide or delete selection covers; `cls` the classes
 * after the class selections (null when there are none). Runs on the main thread for small chunks
 * and in the decode workers above WORKER_MIN_POINTS (protocol.ts `mask`).
 */
import type { PointcloudCleanup } from '@aio/schema';
import { applyRegions, compileCleanup, type CompiledCleanup, type RegionHit } from './evaluate';

type V3 = readonly [number, number, number];

export const WORKER_MIN_POINTS = 50_000;

export interface ChunkMaskInput {
  count: number;
  /** Quantised positions: local = quant.offset + quant.scale * u. */
  positions: ArrayLike<number>;
  quant: { offset: V3; scale: V3 };
  classes: Uint8Array | null;
}

export interface ChunkMask {
  mask: Uint8Array;
  cls: Uint8Array | null;
  classes: Record<number, number> | null;
}

export function chunkMask(c: CompiledCleanup, input: ChunkMaskInput): ChunkMask {
  const { count, positions, quant, classes } = input;
  const mask = new Uint8Array(count);
  if (c.regions.length === 0) return { mask, cls: null, classes: null };
  const cls = c.regions.some((g) => g.kind === 'class') ? new Uint8Array(count) : null;
  const hist: Record<number, number> = {};
  const [ox, oy, oz] = quant.offset;
  const [sx, sy, sz] = quant.scale;
  const hit: RegionHit = { cls: 0, hide: false, del: false };
  for (let i = 0; i < count; i++) {
    applyRegions(
      c,
      ox + sx * (positions[3 * i] ?? 0),
      oy + sy * (positions[3 * i + 1] ?? 0),
      oz + sz * (positions[3 * i + 2] ?? 0),
      classes?.[i] ?? 1,
      hit,
    );
    if (hit.hide || hit.del) mask[i] = 1;
    if (cls) {
      cls[i] = hit.cls;
      hist[hit.cls] = (hist[hit.cls] ?? 0) + 1;
    }
  }
  return { mask, cls, classes: cls ? hist : null };
}

/** Worker entry: the compiled matrices are made where they are used. */
export function chunkMaskFor(
  recipe: PointcloudCleanup,
  origin: V3,
  input: ChunkMaskInput,
): ChunkMask {
  return chunkMask(compileCleanup(recipe, { origin }), input);
}
