/**
 * Graphics quality presets (GPU tiers): point budget, eye-dome lighting, shadow map size and pixel
 * ratio, detected from the WebGL renderer string with an override in Settings.
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
  edl: boolean;
  hint: string;
}

export const GPU_TIERS: Record<GpuTier, TierPreset> = {
  low: {
    label: 'Low',
    pointBudget: 2_000_000,
    edl: false,
    shadowMapSize: 1024,
    maxPixelRatio: 1,
    hint: 'Integrated graphics: 2 M points, no eye-dome lighting',
  },
  medium: {
    label: 'Medium',
    pointBudget: 4_000_000,
    edl: true,
    shadowMapSize: 2048,
    maxPixelRatio: 1,
    hint: 'Entry graphics cards and laptops: 4 M points',
  },
  high: {
    label: 'High',
    pointBudget: 8_000_000,
    edl: true,
    shadowMapSize: 4096,
    maxPixelRatio: 1.5,
    hint: 'Mid-range graphics cards: 8 M points',
  },
  ultra: {
    label: 'Ultra',
    pointBudget: 16_000_000,
    edl: true,
    shadowMapSize: 4096,
    maxPixelRatio: 2,
    hint: 'Workstation graphics (RTX 4070 class and up): 16 M points',
  },
};

export const TIER_ORDER: readonly GpuTier[] = ['low', 'medium', 'high', 'ultra'];

const down = (t: GpuTier): GpuTier => TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(t) - 1)] ?? 'low';

/** The tier for a WebGL renderer string (ANGLE on Windows names the GPU). */
export function detectGpuTier(renderer: string | null | undefined): GpuTier {
  if (!renderer) return 'medium';
  const r = renderer;
  if (/swiftshader|llvmpipe|softpipe|basic render|software/i.test(r)) return 'low';
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
    if (/GTX|Quadro|NVIDIA/i.test(r)) return /MX\s*\d/i.test(r) ? 'low' : 'medium';
    // AMD Radeon RX 5000 .. 9000
    const rx = /RX\s*(\d)(\d)(\d{2})/i.exec(r);
    if (rx) {
      const series = Number(rx[1]);
      const model = Number(rx[2]);
      if (series >= 9) return model >= 7 ? 'ultra' : 'high';
      if (series === 7) return model >= 8 ? 'ultra' : model >= 7 ? 'high' : 'medium';
      if (series === 6) return model >= 8 ? 'high' : model >= 7 ? 'high' : 'medium';
      return 'medium';
    }
    if (/Radeon\s*Pro/i.test(r)) return 'high';
    if (/Radeon/i.test(r)) return 'low'; // integrated Radeon graphics
    if (/Intel/i.test(r)) return /Arc/i.test(r) ? 'medium' : 'low';
    const apple = /Apple\s*M(\d)\s*(Pro|Max|Ultra)?/i.exec(r);
    if (apple) return apple[2] ? 'high' : 'medium';
    return 'medium';
  };
  const t = tier();
  return laptop ? down(t) : t;
}

/** The unmasked WebGL renderer string, or null where WebGL or the extension is unavailable. */
export function readRendererString(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const s = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) as unknown;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
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

export interface GraphicsState {
  renderer: string | null;
  detected: GpuTier;
  override: GpuTier | null;
  /** The tier in effect: the override, else the detected one. */
  tier: GpuTier;
  /** Push the tier to the engine (now and for new stages) and, when the tier changed, to the clouds. */
  apply(): void;
  /** Choose a preset in Settings; null returns to the detected tier. */
  setOverride(t: GpuTier | null): void;
}

export interface GraphicsOptions {
  renderer: string | null;
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

export function createGraphics(opts: GraphicsOptions): StoreApi<GraphicsState> {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  const clouds = opts.clouds ?? pointcloudSettings;
  const saved = load(storage);
  const detected = detectGpuTier(opts.renderer);
  const persist = () => {
    try {
      storage?.setItem(KEY, JSON.stringify(saved));
    } catch {
      // blocked storage: the choice is not remembered
    }
  };
  return createStore<GraphicsState>()((set, get) => ({
    renderer: opts.renderer,
    detected,
    override: saved.override,
    tier: saved.override ?? detected,
    apply() {
      const { tier } = get();
      const p = GPU_TIERS[tier];
      const quality: StageQuality = {
        maxPixelRatio: p.maxPixelRatio,
        shadowMapSize: p.shadowMapSize,
      };
      configureEngine({ quality });
      getActiveStage()?.setQuality(quality);
      if (saved.applied !== tier) {
        // a new tier resets the budget and EDL; later changes in the cloud panel are kept
        clouds.getState().setBudget(p.pointBudget);
        clouds.getState().setEdl(p.edl);
        saved.applied = tier;
        persist();
      }
    },
    setOverride(t) {
      saved.override = t;
      persist();
      set({ override: t, tier: t ?? detected });
      get().apply();
    },
  }));
}

let app: StoreApi<GraphicsState> | null = null;

/** The app's graphics store, created (and detected) on first use. */
export function graphics(): StoreApi<GraphicsState> {
  app ??= createGraphics({ renderer: readRendererString() });
  return app;
}

export function useGraphics<T>(selector: (s: GraphicsState) => T): T {
  return useStore(graphics(), selector);
}
