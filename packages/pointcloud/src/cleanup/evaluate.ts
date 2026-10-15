/**
 * The cleanup recipe (`aio.pccleanup/1`) per point. Two uses: the viewer (local frame, compiled
 * with the project origin; Task 6 masks chunks with `applyRegions`, the shader does the box and
 * the heights) and the shared vectors, which pin it to the pipeline's numpy evaluator
 * (python/src/aio_pipelines/pointcloud_cleanup/evaluate.py). Pure: no three.js, worker safe.
 *
 * The caller passes the point's starting class: from the noise copy when the recipe has a noise
 * run, else the original.
 */
import type { PointcloudCleanup } from '@aio/schema';
import type { CleanupUniforms } from '../material';
import { boxInverseWorld, localToWorld, mul4, type M4 } from './frame';
import { pointInPolygon, ringOf, type Ring } from './polygon';

type V3 = readonly [number, number, number];

export type CleanupState = 'kept' | 'hidden' | 'classHidden' | 'deleted' | 'dropped';
/** One byte a point; a higher code wins (dropped > deleted > classHidden > hidden > kept). */
export const STATE = { kept: 0, hidden: 1, classHidden: 2, deleted: 3, dropped: 4 } as const;
export const STATE_NAMES: readonly CleanupState[] = [
  'kept',
  'hidden',
  'classHidden',
  'deleted',
  'dropped',
];

export interface CompiledRegion {
  /** Frame (world or local) to clip, column-major. */
  m: M4;
  ring: Ring;
  /** NDC bounding box of the ring: [minX, minY, maxX, maxY]. */
  bbox: [number, number, number, number];
  kind: 'hide' | 'delete' | 'class';
  value: number;
}

export interface CompiledBox {
  /** Centre: [E, N, H] in world, [x, y, z] in the local frame. */
  center: [number, number, number];
  cos: number;
  sin: number;
  size: readonly [number, number, number];
}

export interface CompiledCleanup {
  regions: CompiledRegion[];
  /** Frame to the unit box (the shader's uniform); null without a clip box. */
  boxInv: M4 | null;
  /**
   * The clip box for the per-point test, centre in the compiled frame. The test takes the
   * difference from the centre first, like the pipeline, so a point on a face stays on it.
   */
  box: CompiledBox | null;
  keepInside: boolean;
  /** Height range along the frame's up axis, bounds inclusive. */
  zMin: number;
  zMax: number;
  /** Index of the up coordinate: 2 in world (E, N, H), 1 in the local frame. */
  up: 1 | 2;
  /** 1 for each hidden class code. */
  hidden: Uint8Array;
}

/** Compile for world coordinates, or with `frame` for the viewer's local frame. */
export function compileCleanup(
  r: PointcloudCleanup,
  frame: { origin: V3 } | null = null,
): CompiledCleanup {
  const toWorld = frame ? localToWorld(frame.origin) : null;
  const regions = r.regions.map((g): CompiledRegion => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of g.polygon) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return {
      m: toWorld ? mul4(g.viewProj, toWorld) : Float64Array.from(g.viewProj),
      ring: ringOf(g.polygon),
      bbox: [minX, minY, maxX, maxY],
      kind: g.action.kind,
      value: g.action.kind === 'class' ? g.action.value : 0,
    };
  });
  const o = frame?.origin;
  const cb = r.clipBox;
  let boxInv: M4 | null = null;
  let box: CompiledBox | null = null;
  if (cb) {
    const [cx, cy, cz] = cb.center;
    // Local: the centre moved by the origin, then a pure axis swap (exact), so the shader's
    // matrix never carries UTM-sized numbers.
    boxInv = o
      ? mul4(
          boxInverseWorld({ ...cb, center: [cx - o[0], cy - o[1], cz - o[2]] }),
          localToWorld([0, 0, 0]),
        )
      : boxInverseWorld(cb);
    box = {
      center: o ? [cx - o[0], cz - o[2], o[1] - cy] : [cx, cy, cz],
      cos: Math.cos(cb.yaw),
      sin: Math.sin(cb.yaw),
      size: cb.size,
    };
  }
  const dz = o ? o[2] : 0;
  const hidden = new Uint8Array(256);
  for (const c of r.hiddenClasses) hidden[c] = 1;
  return {
    regions,
    boxInv,
    box,
    keepInside: r.clipBox?.keep !== 'outside',
    zMin: (r.height?.min ?? -Infinity) - dz,
    zMax: (r.height?.max ?? Infinity) - dz,
    up: frame ? 1 : 2,
    hidden,
  };
}

export interface RegionHit {
  cls: number;
  hide: boolean;
  del: boolean;
}

/**
 * Step 2 of the evaluation: the regions in order. Later ones win on class; hide and delete marks
 * accumulate, so a delete stays whatever comes after it.
 */
export function applyRegions(
  c: CompiledCleanup,
  x: number,
  y: number,
  z: number,
  cls: number,
  out: RegionHit,
): RegionHit {
  out.cls = cls;
  out.hide = false;
  out.del = false;
  for (const g of c.regions) {
    const m = g.m;
    const w = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0);
    if (!(w > 0)) continue;
    const nx = ((m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0)) / w;
    const ny = ((m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0)) / w;
    if (nx < g.bbox[0] || ny < g.bbox[1] || nx > g.bbox[2] || ny > g.bbox[3]) continue;
    if (!pointInPolygon(g.ring, nx, ny)) continue;
    if (g.kind === 'class') out.cls = g.value;
    else if (g.kind === 'hide') out.hide = true;
    else out.del = true;
  }
  return out;
}

const hit: RegionHit = { cls: 0, hide: false, del: false };

/** Steps 3 and 4: clip box and heights drop (faces and bounds inclusive), then hidden classes hide. */
export function evaluatePoint(
  c: CompiledCleanup,
  x: number,
  y: number,
  z: number,
  cls: number,
): { state: number; cls: number } {
  applyRegions(c, x, y, z, cls, hit);
  const h = c.up === 2 ? z : y;
  let dropped = h < c.zMin || h > c.zMax;
  const b = c.box;
  if (!dropped && b) {
    // offsets from the centre along east, north and up (local: x east, y up, z south)
    const local = c.up === 1;
    const de = x - b.center[0];
    const dn = local ? b.center[2] - z : y - b.center[1];
    const dh = local ? y - b.center[1] : z - b.center[2];
    const u = (b.cos * de + b.sin * dn) / b.size[0];
    const v = (-b.sin * de + b.cos * dn) / b.size[1];
    const w = dh / b.size[2];
    const inside = Math.abs(u) <= 0.5 && Math.abs(v) <= 0.5 && Math.abs(w) <= 0.5;
    dropped = inside !== c.keepInside;
  }
  const state = dropped
    ? STATE.dropped
    : hit.del
      ? STATE.deleted
      : c.hidden[hit.cls]
        ? STATE.classHidden
        : hit.hide
          ? STATE.hidden
          : STATE.kept;
  return { state, cls: hit.cls };
}

/** Every point of a flat xyz list (the vectors, tests). */
export function evaluateAll(
  c: CompiledCleanup,
  xyz: ArrayLike<number>,
  cls: ArrayLike<number>,
): { state: Uint8Array; cls: Uint8Array } {
  const n = cls.length;
  const state = new Uint8Array(n);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = evaluatePoint(
      c,
      xyz[3 * i] ?? 0,
      xyz[3 * i + 1] ?? 0,
      xyz[3 * i + 2] ?? 0,
      cls[i] ?? 0,
    );
    state[i] = e.state;
    out[i] = e.cls;
  }
  return { state, cls: out };
}

/** The shader's share (material.ts `applyCleanupUniforms`), for a recipe compiled in the local frame. */
export function cleanupUniformsOf(c: CompiledCleanup | null): CleanupUniforms {
  return {
    boxInv: c?.boxInv ? Array.from(c.boxInv) : null,
    keepInside: c?.keepInside ?? true,
    zMin: Math.max(c?.zMin ?? -Infinity, -1e30),
    zMax: Math.min(c?.zMax ?? Infinity, 1e30),
  };
}
