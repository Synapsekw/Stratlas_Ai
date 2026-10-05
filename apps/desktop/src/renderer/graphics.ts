/**
 * Graphics quality presets (GPU tiers): point budget, eye-dome lighting, shadow map size and
 * softness, water detail and pixel ratio, plus the memory limits of each tier (most points, largest
 * texture, ortho tiles streamed, graphics memory before the app steps down). Detected from the
 * WebGL renderer string, the GPU's texture limit and the installed memory, with an override in
 * Settings. Under memory pressure (a lost WebGL context, or the estimate over the tier's limit) the
 * app drops one tier for the session (memoryWatch.ts).
 */
import { configureEngine, getActiveStage, type StageQuality } from '@aio/engine';
import { pointcloudSettings, type PointcloudSettings } from '@aio/pointcloud';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type GpuTier = 'low' | 'medium' | 'high' | 'ultra';

export interface TierPreset extends StageQuality {
  label: string;
  /** Global point budget across every cloud. */
  pointBudget: number;
  /** Most points the point cloud panel may choose on this tier (memory limit). */
  maxPointBudget: number;
  /** Largest texture edge a model or ortho keeps, pixels; larger images are scaled down. */
  maxTextureSize: number;
  /** Fine ortho tiles streamed around the view (a few more stay loaded). */
  rasterTiles: number;
  /** Estimated graphics memory one 3D view may use before the app steps down a tier, bytes. */
  gpuBytes: number;
  edl: boolean;
  hint: string;
}

const GB = 2 ** 30;

export const GPU_TIERS: Record<GpuTier, TierPreset> = {
  low: {
    label: 'Low',
    pointBudget: 2_000_000,
    maxPointBudget: 4_000_000,
    maxTextureSize: 4096,
    rasterTiles: 6,
    gpuBytes: 1 * GB,
    edl: false,
    shadowMapSize: 1024,
    shadowSoftness: 1,
    water: 'simple',
    waterFps: 0,
    maxPixelRatio: 1,
    antialias: false,
    hint: 'Integrated graphics: 2 M points, no eye-dome lighting, still water',
  },
  medium: {
    label: 'Medium',
    pointBudget: 4_000_000,
    maxPointBudget: 8_000_000,
    maxTextureSize: 8192,
    rasterTiles: 9,
    gpuBytes: 2 * GB,
    edl: true,
    shadowMapSize: 2048,
    shadowSoftness: 1.5,
    water: 'full',
    waterFps: 12,
    maxPixelRatio: 1,
    hint: 'Entry graphics cards and laptops: 4 M points',
  },
  high: {
    label: 'High',
    pointBudget: 8_000_000,
    maxPointBudget: 16_000_000,
    maxTextureSize: 16384,
    rasterTiles: 9,
    gpuBytes: 4 * GB,
    edl: true,
    shadowMapSize: 4096,
    shadowSoftness: 2,
    water: 'full',
    waterFps: 20,
    maxPixelRatio: 1.5,
    hint: 'Mid-range graphics cards: 8 M points',
  },
  ultra: {
    label: 'Ultra',
    pointBudget: 16_000_000,
    maxPointBudget: 16_000_000,
    maxTextureSize: 16384,
    rasterTiles: 9,
    gpuBytes: 8 * GB,
    edl: true,
    shadowMapSize: 4096,
    shadowSoftness: 2.5,
    water: 'full',
    waterFps: 30,
    maxPixelRatio: 2,
    hint: 'Workstation graphics (RTX 4070 class and up): 16 M points',
  },
};

export const TIER_ORDER: readonly GpuTier[] = ['low', 'medium', 'high', 'ultra'];

/** Points left when memory runs short on the Low tier already. */
export const PRESSURE_FLOOR_POINTS = 1_000_000;

const rank = (t: GpuTier) => TIER_ORDER.indexOf(t);
const down = (t: GpuTier, steps = 1): GpuTier => TIER_ORDER[Math.max(0, rank(t) - steps)] ?? 'low';

/** Software rasterisers: SwiftShader, llvmpipe, the Windows Basic Render Driver (WARP). */
const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|basic render|software/i;

/**
 * Graphics that share the system memory: software rasterisers, Intel UHD / Iris / integrated Arc,
 * AMD Radeon in Ryzen processors (Vega, 610M to 890M, "Radeon Graphics"), Qualcomm Adreno
 * (Windows on Arm), Arm Mali, PowerVR and the macOS virtual GPU. Apple M-series is unified memory
 * but tiered on its own.
 */
export function isIntegratedGpu(renderer: string | null | undefined): boolean {
  if (!renderer) return false;
  const r = renderer;
  if (SOFTWARE.test(r)) return true;
  if (/Adreno|Mali|PowerVR|Paravirtual/i.test(r)) return true;
  // discrete Arc cards carry a model number (A380, A770, B580); the integrated ones do not
  if (/Intel/i.test(r)) return !/Arc(?:\(TM\))?\s*[AB]\d{3}/i.test(r);
  if (/Radeon/i.test(r)) {
    if (/\bRX\b|Radeon\s*(?:\(TM\)\s*)?(?:Pro|VII|R9|HD)/i.test(r)) return false;
    return /Radeon(?:\(TM\))?\s*(?:Graphics|Vega\s*\d+|\d{3}M|R[2-7]\s*Graphics)/i.test(r);
  }
  return false;
}

/** The tier for a WebGL renderer string (ANGLE on Windows names the GPU). */
export function detectGpuTier(renderer: string | null | undefined): GpuTier {
  if (!renderer) return 'medium';
  const r = renderer;
  if (isIntegratedGpu(r)) return 'low';
  const laptop = /laptop|mobile|max-q/i.test(r);
  const tier = (): GpuTier => {
    // NVIDIA GeForce RTX 2060 .. 5090
    const rtx = /RTX\s*(\d{2})(\d{2})/i.exec(r);
    if (rtx && /geforce/i.test(r)) {
      const series = Number(rtx[1]);
      const model = Number(rtx[2]);
      if (model <= 50) return 'medium';
      if (series >= 40) return model >= 70 ? 'ultra' : 'high';
      if (series === 30) return model >= 80 ? 'ultra' : 'high';
      return 'high';
    }
    // NVIDIA workstation: RTX A2000 .. A6000, RTX 2000 .. 6000 Ada
    const pro = /RTX\s*(?:A|PRO\s*)?(\d)000/i.exec(r);
    if (pro) return Number(pro[1]) >= 5 ? 'ultra' : Number(pro[1]) >= 4 ? 'high' : 'medium';
    // entry GeForce (MX laptop chips, GT 1030 / 730) draw like integrated graphics
    if (/MX\s*\d|GeForce\s*GT\s*\d/i.test(r)) return 'low';
    if (/GTX|Quadro|NVIDIA/i.test(r)) return 'medium';
    // AMD Radeon RX 5000 .. 9000
    const rx = /RX\s*(\d)(\d)(\d{2})/i.exec(r);
    if (rx) {
      const series = Number(rx[1]);
      const model = Number(rx[2]);
      if (series >= 9) return model >= 7 ? 'ultra' : 'high';
      if (series === 7) return model >= 8 ? 'ultra' : model >= 7 ? 'high' : 'medium';
      if (series === 6) return model >= 7 ? 'high' : 'medium';
      return 'medium';
    }
    if (/Radeon\s*(?:\(TM\)\s*)?Pro/i.test(r)) return 'high';
    if (/Radeon/i.test(r)) return 'medium'; // discrete Radeon without an RX number (RX Vega, VII)
    if (/Intel/i.test(r)) return 'medium'; // discrete Arc
    const apple = /Apple\s*M(\d)\s*(Pro|Max|Ultra)?/i.exec(r);
    if (apple) return apple[2] ? 'high' : 'medium';
    return 'medium';
  };
  const t = tier();
  return laptop ? down(t) : t;
}

/** What detection reads from the system. */
export interface GpuFacts {
  /** Unmasked WebGL renderer string, or null where hidden. */
  renderer: string | null;
  /** WebGL MAX_TEXTURE_SIZE, or null when unknown. */
  maxTextureSize: number | null;
  /** Installed system memory, bytes, or null when unknown. */
  systemMemory: number | null;
}

/** Why the detected tier sits below what the GPU alone would get. */
export type TierLimit = 'memory' | 'texture';

/** 8 GB machines report 7.4 to 8 GiB (integrated graphics reserve some); 12 GiB leaves margin. */
const SMALL_MEMORY = 12 * GB;
const TINY_MEMORY = 6 * GB;

/**
 * The tier for this machine: the GPU's, capped at Medium with 8 GB of memory or less (Low with
 * integrated graphics or under 6 GB), and at Low where textures top out below 8192 px.
 */
export function detectTier(f: GpuFacts): { tier: GpuTier; gpu: GpuTier; limits: TierLimit[] } {
  const gpu = detectGpuTier(f.renderer);
  let tier = gpu;
  const limits: TierLimit[] = [];
  const cap = (t: GpuTier, why: TierLimit) => {
    if (rank(t) < rank(tier)) {
      tier = t;
      if (!limits.includes(why)) limits.push(why);
    }
  };
  if (f.systemMemory !== null && f.systemMemory > 0) {
    if (f.systemMemory <= TINY_MEMORY) cap('low', 'memory');
    else if (f.systemMemory <= SMALL_MEMORY)
      cap(isIntegratedGpu(f.renderer) ? 'low' : 'medium', 'memory');
  }
  if (f.maxTextureSize !== null && f.maxTextureSize > 0 && f.maxTextureSize < 8192)
    cap('low', 'texture');
  return { tier, gpu, limits };
}

interface SystemBridge {
  aio?: { systemMemory?: () => { total: number; free: number } | null };
}

/** Renderer string and texture limit from a throwaway WebGL2 context; memory from the preload. */
export function readGpuFacts(): GpuFacts {
  let renderer: string | null = null;
  let maxTextureSize: number | null = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const s = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) as unknown;
      renderer = typeof s === 'string' ? s : null;
      const m = gl.getParameter(gl.MAX_TEXTURE_SIZE) as unknown;
      maxTextureSize = typeof m === 'number' ? m : null;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // no WebGL: nothing known
  }
  return { renderer, maxTextureSize, systemMemory: installedMemory() };
}

function installedMemory(): number | null {
  try {
    const mem = (window as unknown as SystemBridge).aio?.systemMemory?.();
    return mem && mem.total > 0 ? mem.total : null;
  } catch {
    return null;
  }
}

/** The unmasked WebGL renderer string, or null where WebGL or the extension is unavailable. */
export function readRendererString(): string | null {
  return readGpuFacts().renderer;
}

const KEY = 'stratlas.graphics';

interface Saved {
  override: GpuTier | null;
  /** The tier whose budget and EDL were last applied to the point-cloud settings. */
  applied: GpuTier | null;
}

function load(storage: Storage | null): Saved {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? '{}') as Partial<Record<keyof Saved, unknown>>;
    const ok = (x: unknown): x is GpuTier => TIER_ORDER.includes(x as GpuTier);
    return {
      override: ok(v.override) ? v.override : null,
      applied: ok(v.applied) ? v.applied : null,
    };
  } catch {
    return { override: null, applied: null };
  }
}

/** Why the app stepped down for this session. */
export type PressureReason = 'context-lost' | 'memory';

export interface GraphicsState {
  renderer: string | null;
  /** Renderer string, texture limit and installed memory detection read. */
  facts: GpuFacts;
  /** The GPU's own tier, before the memory and texture limits. */
  gpuTier: GpuTier;
  /** What lowered `detected` below `gpuTier`. */
  limits: TierLimit[];
  detected: GpuTier;
  override: GpuTier | null;
  /** Tiers stepped down this session under memory pressure (0 normally). */
  pressure: number;
  /** The last reason for stepping down; cleared when the notice is dismissed. */
  pressureReason: PressureReason | null;
  /** The tier in effect: the override, else the detected one, stepped down under pressure. */
  tier: GpuTier;
  /** Most points the clouds may draw now (the tier's limit, lower under pressure). */
  pointCap: number;
  /** Push the tier to the engine (now and for new stages) and, when the tier changed, to the clouds. */
  apply(): void;
  /** Choose a preset in Settings; null returns to the detected tier. Clears any pressure. */
  setOverride(t: GpuTier | null): void;
  /**
   * Memory ran short: one tier down for the session (below Low, the point floor). False when
   * already at the floor.
   */
  relieve(reason: PressureReason): boolean;
  dismissPressure(): void;
}

export interface GraphicsOptions {
  renderer: string | null;
  maxTextureSize?: number | null;
  systemMemory?: number | null;
  storage?: Storage | null;
  clouds?: StoreApi<PointcloudSettings>;
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The tier and point cap `base` gives after `pressure` steps down. */
export function underPressure(
  base: GpuTier,
  pressure: number,
): { tier: GpuTier; pointCap: number } {
  const tier = down(base, pressure);
  if (pressure <= 0) return { tier, pointCap: GPU_TIERS[tier].maxPointBudget };
  // stepped down: the new tier's default budget is its limit; past Low, the floor
  const pointCap = pressure > rank(base) ? PRESSURE_FLOOR_POINTS : GPU_TIERS[tier].pointBudget;
  return { tier, pointCap };
}

export function createGraphics(opts: GraphicsOptions): StoreApi<GraphicsState> {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  const clouds = opts.clouds ?? pointcloudSettings;
  const saved = load(storage);
  const facts: GpuFacts = {
    renderer: opts.renderer,
    maxTextureSize: opts.maxTextureSize ?? null,
    systemMemory: opts.systemMemory ?? null,
  };
  const found = detectTier(facts);
  const detected = found.tier;
  const persist = () => {
    try {
      storage?.setItem(KEY, JSON.stringify(saved));
    } catch {
      // blocked storage: the choice is not remembered
    }
  };
  const resolve = (override: GpuTier | null, pressure: number) =>
    underPressure(override ?? detected, pressure);
  const start = resolve(saved.override, 0);
  return createStore<GraphicsState>()((set, get) => ({
    renderer: opts.renderer,
    facts,
    gpuTier: found.gpu,
    limits: found.limits,
    detected,
    override: saved.override,
    pressure: 0,
    pressureReason: null,
    tier: start.tier,
    pointCap: start.pointCap,
    apply() {
      const { tier, pointCap } = get();
      const p = GPU_TIERS[tier];
      const quality: StageQuality = {
        maxPixelRatio: p.maxPixelRatio,
        shadowMapSize: p.shadowMapSize,
        shadowSoftness: p.shadowSoftness,
        water: p.water,
        waterFps: p.waterFps,
        antialias: p.antialias !== false,
      };
      configureEngine({
        quality,
        memory: { maxTextureSize: p.maxTextureSize, rasterTiles: p.rasterTiles },
      });
      getActiveStage()?.setQuality(quality);
      if (saved.applied !== tier) {
        // a new tier resets the budget and EDL; later changes in the cloud panel are kept
        clouds.getState().setBudget(p.pointBudget);
        clouds.getState().setEdl(p.edl);
        saved.applied = tier;
        persist();
      }
      // the tier's memory limit holds whatever the cloud panel chose
      clouds.getState().setBudgetCap(pointCap);
    },
    setOverride(t) {
      saved.override = t;
      persist();
      set({ override: t, pressure: 0, pressureReason: null, ...resolve(t, 0) });
      get().apply();
    },
    relieve(reason) {
      const { override, pressure } = get();
      const base = override ?? detected;
      if (pressure > rank(base)) return false;
      const next = pressure + 1;
      set({ pressure: next, pressureReason: reason, ...resolve(override, next) });
      get().apply();
      return true;
    },
    dismissPressure() {
      set({ pressureReason: null });
    },
  }));
}

let app: StoreApi<GraphicsState> | null = null;

/** The app's graphics store, created (and detected) on first use. */
export function graphics(): StoreApi<GraphicsState> {
  if (!app) {
    const f = readGpuFacts();
    app = createGraphics({
      renderer: f.renderer,
      maxTextureSize: f.maxTextureSize,
      systemMemory: f.systemMemory,
    });
  }
  return app;
}

export function useGraphics<T>(selector: (s: GraphicsState) => T): T {
  return useStore(graphics(), selector);
}
