/**
 * The memory pressure path. Every few seconds the live stage's graphics memory estimate and the
 * renderer's JavaScript heap are compared with the graphics tier's limits; over a limit, or when a
 * stage loses its WebGL context (GPU reset, out of memory), the app steps down one tier for the
 * session: the point budget shrinks and point-cloud nodes unload (eviction, not a crash), textures
 * loaded from then on are smaller, and a calm notice says so. three.js restores a lost context by
 * itself and re-uploads what the stage holds.
 *
 * `graphicsReport()` is the snapshot diagnostics read (tier, detection facts, memory now).
 */
import { getActiveStage, type EngineStage, type GpuEvent } from '@aio/engine';
import type { StoreApi } from 'zustand/vanilla';
import { GPU_TIERS, graphics, type GraphicsState, type PressureReason } from './graphics';

/** JavaScript heap use, of the heap limit, that counts as pressure. */
export const HEAP_PRESSURE = 0.85;
const INTERVAL_MS = 3000;
/** After a step down, eviction gets this long before the next one. */
const COOLDOWN_MS = 15_000;

export interface MemorySample {
  /** The live stage's estimate, bytes; null without a stage. */
  gpuBytes: number | null;
  /** performance.memory (Chromium): used and limit of the JavaScript heap, bytes. */
  heapUsed: number | null;
  heapLimit: number | null;
}

/** Whether a sample is over the limits of the tier in effect. */
export function overLimit(s: MemorySample, gpuCap: number): PressureReason | null {
  if (s.gpuBytes !== null && s.gpuBytes > gpuCap) return 'memory';
  if (s.heapUsed !== null && s.heapLimit && s.heapUsed > s.heapLimit * HEAP_PRESSURE)
    return 'memory';
  return null;
}

interface ChromeMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function heap(): { used: number; limit: number } | null {
  const m = (performance as Performance & { memory?: ChromeMemory }).memory;
  return m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
}

export function sample(stage: EngineStage | null): MemorySample {
  const h = heap();
  return { gpuBytes: estimate(stage), heapUsed: h?.used ?? null, heapLimit: h?.limit ?? null };
}

function estimate(stage: EngineStage | null): number | null {
  try {
    return stage && !stage.contextLost ? stage.memoryEstimate() : null;
  } catch {
    return null;
  }
}

export interface MemoryWatch {
  /** A stage's WebGL context event (wired to the engine's onGpuEvent). */
  onGpuEvent(e: GpuEvent): void;
  /** One check now (the timer calls it); returns the reason it stepped down, if it did. */
  check(now?: number): PressureReason | null;
  stop(): void;
}

export interface MemoryWatchOptions {
  store?: StoreApi<GraphicsState>;
  stage?: () => EngineStage | null;
  read?: (stage: EngineStage | null) => MemorySample;
  /** Start the timer (off in unit tests, which call check). */
  timer?: boolean;
}

export function createMemoryWatch(opts: MemoryWatchOptions = {}): MemoryWatch {
  const store = opts.store ?? graphics();
  const stageOf = opts.stage ?? getActiveStage;
  const read = opts.read ?? sample;
  let last = -Infinity;
  const check = (now = performance.now()): PressureReason | null => {
    if (now - last < COOLDOWN_MS) return null;
    const stage = stageOf();
    if (!stage) return null;
    const why = overLimit(read(stage), GPU_TIERS[store.getState().tier].gpuBytes);
    if (!why || !store.getState().relieve(why)) return null;
    last = now;
    return why;
  };
  const timer = opts.timer === false ? null : setInterval(() => check(), INTERVAL_MS);
  return {
    onGpuEvent(e) {
      if (e.type !== 'context-lost') return;
      // the context comes back by itself; what it held must fit a smaller budget this time
      store.getState().relieve('context-lost');
      last = performance.now();
    },
    check,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

let watch: MemoryWatch | null = null;

/** The app's memory watch, started once (bootstrap). */
export function memoryWatch(): MemoryWatch {
  watch ??= createMemoryWatch();
  return watch;
}

/** Graphics and memory facts for diagnostics (support bundles, the e2e tests). */
export interface GraphicsReport {
  renderer: string | null;
  maxTextureSize: number | null;
  systemMemory: number | null;
  gpuTier: string;
  detected: string;
  override: string | null;
  tier: string;
  limits: string[];
  pressure: number;
  pointCap: number;
  /** The tier's graphics memory limit and the live stage's estimate, bytes. */
  gpuCap: number;
  gpuBytes: number | null;
  heapUsed: number | null;
  heapLimit: number | null;
  /** Renderer process memory, bytes, where the preload reports it. */
  processPrivate: number | null;
  contextLost: boolean;
}

interface ProcessBridge {
  aio?: { processMemory?: () => Promise<{ residentSet: number; private: number } | null> };
}

export async function graphicsReport(): Promise<GraphicsReport> {
  const g = graphics().getState();
  const stage = getActiveStage();
  const s = sample(stage);
  const processPrivate = await (window as unknown as ProcessBridge).aio
    ?.processMemory?.()
    .then((m) => m?.private ?? null)
    .catch(() => null);
  return {
    renderer: g.facts.renderer,
    maxTextureSize: g.facts.maxTextureSize,
    systemMemory: g.facts.systemMemory,
    gpuTier: g.gpuTier,
    detected: g.detected,
    override: g.override,
    tier: g.tier,
    limits: [...g.limits],
    pressure: g.pressure,
    pointCap: g.pointCap,
    gpuCap: GPU_TIERS[g.tier].gpuBytes,
    gpuBytes: s.gpuBytes,
    heapUsed: s.heapUsed,
    heapLimit: s.heapLimit,
    processPrivate: processPrivate ?? null,
    contextLost: stage?.contextLost ?? false,
  };
}
