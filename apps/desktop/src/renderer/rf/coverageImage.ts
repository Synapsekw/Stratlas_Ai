/**
 * The picture of a coverage view (D18, D23a, D26): RGBA pixels the map's image source and the
 * scene's ground drape both show. "No service" and pixels no sector reaches are transparent; the
 * layer opacity is applied by the map and the scene, not baked in. With the hatch on, the picture
 * is drawn `scale` times larger so each class carries its own line or dot pattern.
 */
import { NO_SERVER } from '@aio/rf';
import type { CoverageGrids } from './coverageGrids';
import {
  CLASS_HATCH,
  OVERLAP_HATCH,
  OVERLAP_RAMP,
  RSRP_RAMP,
  classOf,
  classShown,
  hatchInk,
  rgb,
  sectorColour,
  sectorHatch,
  type Hatch,
  type Oklch,
  type ShowFrom,
} from './coverageRamp';
import type { RfView } from './rfStore';

export interface CoverageImageOptions {
  view: RfView;
  showFrom: ShowFrom;
  hatch: boolean;
}

export interface CoverageImage {
  width: number;
  height: number;
  /** Grid pixels per picture pixel, each way (1 without a hatch). */
  scale: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Largest side of a hatched picture, px (a canvas and a texture stay well inside their limits). */
export const MAX_HATCH_PX = 4096;
/** Hatch period, picture px. */
const PERIOD = 6;

/** How many picture pixels a grid pixel takes with the hatch on. */
export function hatchScale(width: number, height: number): number {
  return Math.max(1, Math.min(3, Math.floor(MAX_HATCH_PX / Math.max(width, height))));
}

/** Whether the hatch marks picture pixel (x, y). */
export function hatchAt(h: Hatch, x: number, y: number): boolean {
  if (h === 'none') return false;
  const up = (((x + y) % PERIOD) + PERIOD) % PERIOD < 2;
  const down = (((x - y) % PERIOD) + PERIOD) % PERIOD < 2;
  if (h === 'rising') return up;
  if (h === 'falling') return down;
  if (h === 'cross') return up || down;
  return x % PERIOD < 2 && y % PERIOD < 2;
}

interface Paint {
  fill: [number, number, number];
  ink: [number, number, number];
  hatch: Hatch;
}

const paintOf = (k: Oklch, hatch: Hatch): Paint => ({ fill: rgb(k), ink: rgb(hatchInk(k)), hatch });

/** What one grid pixel is painted with in a view, or null for transparent. */
function pixelPaint(
  g: CoverageGrids,
  i: number,
  o: CoverageImageOptions,
  cache: Map<string, Paint>,
): Paint | null {
  const cls = classOf(g.rsrp[i] ?? Number.NaN, g.thresholds);
  if (cls === null) return null;
  const get = (key: string, make: () => Paint) => {
    let p = cache.get(key);
    if (!p) {
      p = make();
      cache.set(key, p);
    }
    return p;
  };
  if (o.view === 'rsrp') {
    if (!classShown(cls, o.showFrom) || cls === 'none') return null;
    return get(cls, () => paintOf(RSRP_RAMP[cls], CLASS_HATCH[cls]));
  }
  if (o.view === 'bestServer') {
    // drawn where there is service (poor or better) and the chosen classes
    if (cls === 'none' || !classShown(cls, o.showFrom)) return null;
    const s = g.bestServer[i] ?? NO_SERVER;
    if (s === NO_SERVER) return null;
    return get(`s${String(s)}`, () => paintOf(sectorColour(s), sectorHatch(s)));
  }
  // overlap: only where the best server is fair or better (mockup), two or more servers
  if (cls === 'none' || cls === 'poor' || !classShown(cls, o.showFrom)) return null;
  const n = g.overlap[i] ?? 0;
  if (n < 2) return null;
  const k = n === 2 ? 'two' : 'more';
  return get(k, () => paintOf(OVERLAP_RAMP[k], OVERLAP_HATCH[k]));
}

/** The RGBA picture of one view of the grids. */
export function coverageImage(g: CoverageGrids, o: CoverageImageOptions): CoverageImage {
  const { width: w, height: h } = g.grid;
  const scale = o.hatch ? hatchScale(w, h) : 1;
  const W = w * scale;
  const H = h * scale;
  const data = new Uint8ClampedArray(new ArrayBuffer(W * H * 4));
  const cache = new Map<string, Paint>();
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const p = pixelPaint(g, row * w + col, o, cache);
      if (!p) continue;
      for (let dy = 0; dy < scale; dy++) {
        const y = row * scale + dy;
        for (let dx = 0; dx < scale; dx++) {
          const x = col * scale + dx;
          const c = o.hatch && hatchAt(p.hatch, x, y) ? p.ink : p.fill;
          const at = (y * W + x) * 4;
          data[at] = c[0];
          data[at + 1] = c[1];
          data[at + 2] = c[2];
          data[at + 3] = 255;
        }
      }
    }
  }
  return { width: W, height: H, scale, data };
}
