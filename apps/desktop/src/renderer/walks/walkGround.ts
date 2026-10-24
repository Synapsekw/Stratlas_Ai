import { getActiveScene } from '@aio/engine';
import type { Layer } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { appBoundsDeps } from '../shell/appBounds';
import type { BoundsDeps } from '../shell/layerBounds';

/*
 * The ground a placed walk stands on (design "The track sits on the ground in 3D"): a walk has no
 * GPS height, and its pins' heights can disagree with what the 3D view draws (a walk placed on the
 * map before its pins took the 3D ground stored ground 0 while the ortho sits at the DSM's height).
 * So the 3D line, the Beam and the spot history track all ask one sampler: the DSM straight down first, then the ground
 * imagery (ortho, street map drape), then the top of the visible models and clouds; where nothing
 * is drawn the caller keeps the stored pin height (`fit.ts` groundAt). Only what the 3D view shows
 * counts (`raycastRay` skips hidden layers), so it is asked again when layers load, the date on
 * screen changes or a layer is switched on or off (`walkGround.resample`).
 */

/** Scene x/z to the ground's y there, null where nothing is drawn. */
export type GroundAt = (x: number, z: number) => number | null;
/** The height straight down onto one layer (the shell's `rayDown`), null off it. */
export type RayDown = BoundsDeps['rayDown'];

/** The ground is asked about every this many metres along a walk, heights between interpolated. */
export const DRAPE_STEP_M = 1;
/**
 * Answers are remembered per square cell this wide, metres: the drape's step, so the spot track
 * and the marker find most of their ground already asked by the line.
 */
export const GROUND_CELL_M = DRAPE_STEP_M;
/** Ground asks per frame while a long walk is draped (raycasts down a heavy model are not cheap). */
export const DRAPE_BUDGET = 300;

/** The layers the ground is read from, in order: DSMs; the ground imagery; models and clouds. */
export function groundTiers(layers: readonly Layer[]): string[][] {
  const dsm: string[] = [];
  const imagery: string[] = [];
  const models: string[] = [];
  for (const l of layers) {
    if (l.kind === 'raster') (l.role === 'dsm' ? dsm : imagery).push(l.id);
    else if (l.kind === 'basemap') imagery.push(l.id);
    else if (l.kind === 'mesh' || l.kind === 'pointcloud') models.push(l.id);
  }
  return [dsm, imagery, models];
}

/**
 * The ground over `layers` through `rayDown`: the first tier (`groundTiers`) with a hit answers,
 * with the highest of its hits (the top of the model, not a floor inside it). `live`, when it
 * answers, names the layers a ray can hit now; the others are not asked.
 */
export function layerGround(
  layers: readonly Layer[],
  rayDown: RayDown,
  live: () => ReadonlySet<string> | undefined = () => undefined,
): GroundAt {
  const tiers = groundTiers(layers);
  return (x, z) => {
    const can = live();
    for (const ids of tiers) {
      let top: number | null = null;
      for (const id of ids) {
        if (can && !can.has(id)) continue;
        const y = rayDown(x, z, id);
        if (y !== null && Number.isFinite(y) && (top === null || y > top)) top = y;
      }
      if (top !== null) return top;
    }
    return null;
  };
}

/** A ground that remembers its answer (a miss too) per `cellM` square cell, until `clear`. */
export function cachedGround(
  ground: GroundAt,
  cellM: number = GROUND_CELL_M,
): GroundAt & { clear(): void } {
  const known = new Map<string, number | null>();
  const g = (x: number, z: number) => {
    const key = `${Math.floor(x / cellM)},${Math.floor(z / cellM)}`;
    if (known.has(key)) return known.get(key) ?? null;
    const y = ground(x, z);
    known.set(key, y);
    return y;
  };
  return Object.assign(g, {
    clear: () => {
      known.clear();
    },
  });
}

type Pt = readonly [number, number, number];

/** The points of a run the ground is asked at: the first, about every `stepM` along it, the last. */
export function drapeStations(pts: readonly Pt[], stepM: number = DRAPE_STEP_M): number[] {
  const at: number[] = [];
  let run = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[i - 1];
    if (!p) continue;
    if (q) run += Math.hypot(p[0] - q[0], p[2] - q[2]);
    if (run >= stepM || i === pts.length - 1) {
      at.push(i);
      run = 0;
    }
  }
  return at;
}

/**
 * A run moved onto the ground: `heights[k]` is the ground at point `stations[k]` (null: keep that
 * point's stored height, its y), the points between interpolated, all lifted by `lift`.
 */
export function drapeRun(
  pts: readonly Pt[],
  stations: readonly number[],
  heights: readonly (number | null)[],
  lift: number,
): [number, number, number][] {
  const ys = stations.map((i, k) => heights[k] ?? pts[i]?.[1] ?? 0);
  const out: [number, number, number][] = [];
  let k = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p) continue;
    while (k < stations.length - 1 && (stations[k + 1] ?? Infinity) <= i) k++;
    const a = stations[k];
    const b = stations[k + 1];
    const ya = ys[k];
    const yb = ys[k + 1];
    let y = p[1];
    if (a !== undefined && ya !== undefined) {
      y = ya;
      if (b !== undefined && yb !== undefined && b > a && i > a)
        y = ya + ((yb - ya) * (i - a)) / (b - a);
    }
    out.push([p[0], y + lift, p[2]]);
  }
  return out;
}

/** `drapeRun` with the ground asked at once (short runs, tests). */
export function drapePoints(
  pts: readonly Pt[],
  ground: GroundAt,
  lift: number,
  stepM: number = DRAPE_STEP_M,
): [number, number, number][] {
  const stations = drapeStations(pts, stepM);
  return drapeRun(
    pts,
    stations,
    stations.map((i) => {
      const p = pts[i];
      return p ? ground(p[0], p[2]) : null;
    }),
    lift,
  );
}

/** Where the next frame comes from (`requestAnimationFrame` in the app). */
export interface FrameScheduler {
  request(cb: () => void): number;
  cancel(handle: number): void;
}
const animationFrames: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => {
    cancelAnimationFrame(h);
  },
};

/**
 * Drape `runs` onto `ground` (`drapePoints` of each), asking it at most `budget` times a frame:
 * the first batch now (a short walk is done at once), the rest on the next frames. `done` gets
 * the draped runs once, in order; the returned function cancels a drape not yet done.
 */
export function drapeRunsInFrames(
  runs: readonly (readonly Pt[])[],
  ground: GroundAt,
  lift: number,
  done: (runs: [number, number, number][][]) => void,
  opts: { budget?: number; scheduler?: FrameScheduler; stepM?: number } = {},
): () => void {
  const budget = Math.max(1, Math.floor(opts.budget ?? DRAPE_BUDGET));
  const frames = opts.scheduler ?? animationFrames;
  const stations = runs.map((r) => drapeStations(r, opts.stepM));
  const heights: (number | null)[][] = stations.map(() => []);
  let run = 0;
  let k = 0;
  let handle: number | null = null;
  let cancelled = false;
  const step = () => {
    handle = null;
    if (cancelled) return;
    let asked = 0;
    while (run < runs.length && asked < budget) {
      const at = stations[run] ?? [];
      if (k >= at.length) {
        run++;
        k = 0;
        continue;
      }
      const p = runs[run]?.[at[k] ?? -1];
      heights[run]?.push(p ? ground(p[0], p[2]) : null);
      k++;
      asked++;
    }
    // a run whose last station was just asked is complete: skip past it before deciding
    while (run < runs.length && k >= (stations[run]?.length ?? 0)) {
      run++;
      k = 0;
    }
    if (run < runs.length) {
      handle = frames.request(step);
      return;
    }
    done(runs.map((r, i) => drapeRun(r, stations[i] ?? [], heights[i] ?? [], lift)));
  };
  step();
  return () => {
    cancelled = true;
    if (handle !== null) frames.cancel(handle);
    handle = null;
  };
}

/** The shared walk ground: one remembered sampler, and a version that moves when it is asked again. */
export interface WalkGround {
  /** The sampler now: remembered answers until `resample`. */
  ground: GroundAt;
  /** Forget every answer (layers loaded, the date or a layer's visibility changed). */
  resample: () => void;
  /** `version` moves on every `resample`, so drapes and tracks are made again. */
  store: StoreApi<{ version: number }>;
}

/** A shared walk ground over `source` (null: no 3D view, nothing remembered, every ask null). */
export function createWalkGround(source: () => GroundAt | null): WalkGround {
  let cache: (GroundAt & { clear(): void }) | null = null;
  const store = createStore<{ version: number }>(() => ({ version: 0 }));
  return {
    ground: (x, z) => {
      if (!cache) {
        const g = source();
        if (!g) return null;
        cache = cachedGround(g);
      }
      return cache(x, z);
    },
    resample: () => {
      cache = null;
      store.setState((s) => ({ version: s.version + 1 }));
    },
    store,
  };
}

/** The ground the app's 3D view draws: the shell's `rayDown` over the open project's layers. */
export const walkGround = createWalkGround(() => {
  const scene = getActiveScene();
  if (!scene) return null;
  const deps = appBoundsDeps();
  return layerGround(
    deps.manifest.layers,
    (x, z, id) => deps.rayDown(x, z, id),
    () => getActiveScene()?.rayLayers?.(),
  );
});
