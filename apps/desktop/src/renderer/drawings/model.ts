import { applyMat4, fitSimilarity3D } from '@aio/geo';
import { unshiftLocal, type DateShift, type RasterCorners, type Vec3 } from '@aio/schema';
import type { SplitPref } from '../workspace/splitModel';

/**
 * Drawings from pictures and PDF pages (data-conventions section 15): the page choice, the size a
 * page is drawn at, the fit that places a drawing from point pairs and the split that shows it
 * side by side. Pure; the stores and the components call it.
 */

/** Most pages of one PDF brought in by one import. */
export const PAGE_CAP = 20;
/** Long side of a drawing's picture, pixels (the builder's `MAX_DRAWING_PX`). */
export const MAX_DRAWING_PX = 8192;

const PAGES_HELP = 'Type the pages to import, for example 1-3, 7.';

/**
 * The page field's first value: the first page. Every page becomes a drawing, and a drawing
 * cannot be removed again, so more pages are something a person types.
 */
export function defaultPages(): string {
  return '1';
}

/** The most a page may weigh as a PNG (the limit of `builder:addDrawingPage`). */
export const PAGE_BYTES = 64 * 1024 * 1024;
/** The scales a page is drawn at, one after the other, until its PNG fits. */
const SHRINK_STEPS = [1, 0.7, 0.5, 0.35];

/**
 * Draw a page so that it can be handed over: at full size, and when that PNG is heavier than
 * `cap` (a large sheet full of colour), again at 70, 50 and 35 percent. Throws, in words for the
 * import list, when it is still too heavy.
 */
export async function drawWithinCap<T extends { byteLength: number }>(
  draw: (shrink: number) => Promise<T>,
  cap = PAGE_BYTES,
): Promise<T> {
  for (const shrink of SHRINK_STEPS) {
    const png = await draw(shrink);
    if (png.byteLength <= cap) return png;
  }
  throw new Error(
    'This page is too detailed to bring in, even at a third of its size. Export it from its program as a smaller picture (PNG or JPEG), then add that.',
  );
}

/**
 * The pages a person typed ("1-3, 7"), in page order and once each, or what is wrong with the
 * text. `count` is the page count of the file.
 */
export function parsePages(
  text: string,
  count: number,
  cap = PAGE_CAP,
): { pages: number[] } | { error: string } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { error: PAGES_HELP };
  const pages = new Set<number>();
  for (const part of parts) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) return { error: PAGES_HELP };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    if (from < 1 || to > count) return { error: `This file has pages 1 to ${String(count)}.` };
    for (let n = from; n <= to; n++) pages.add(n);
  }
  if (pages.size > cap) {
    return {
      error: `At most ${String(cap)} pages in one import; ${String(pages.size)} are listed.`,
    };
  }
  return { pages: [...pages].sort((x, y) => x - y) };
}

/**
 * The pixel size a PDF page (in points, 72 to the inch) is drawn at, and the scale that gives it:
 * 220 dpi, at least 4096 and at most 8192 pixels on the long side so line work stays legible
 * (about 350 dpi for A4, 175 for A0), and never above 600 dpi for a very small page.
 */
export function pageSizePx(
  widthPt: number,
  heightPt: number,
): { scale: number; width: number; height: number } {
  const longPt = Math.max(widthPt, heightPt, 1);
  const wanted = Math.min(MAX_DRAWING_PX, Math.max(4096, (longPt / 72) * 220));
  const scale = Math.min(wanted / longPt, 600 / 72);
  return {
    scale,
    width: Math.max(1, Math.round(widthPt * scale)),
    height: Math.max(1, Math.round(heightPt * scale)),
  };
}

/** `width` x `height` scaled down to at most `max` on the long side; never scaled up. */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Width and height an SVG asks for, from its size attributes or its view box; null when silent. */
export function svgSize(text: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const num = (name: string) => {
    const v = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)(px)?\\s*["']`, 'i').exec(tag)?.[1];
    const n = v === undefined ? Number.NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const w = num('width');
  const h = num('height');
  if (w !== null && h !== null) return { width: w, height: h };
  const box = /\sviewBox\s*=\s*["']([^"']+)["']/i
    .exec(tag)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const bw = box?.[2];
  const bh = box?.[3];
  if (bw !== undefined && bh !== undefined && bw > 0 && bh > 0) return { width: bw, height: bh };
  return null;
}

/** One point pair of the place tool: a pixel of the drawing and where it really is. */
export interface PlacePair {
  /** Pixel of `plan.png`: x right, y down. */
  px: [number, number];
  /** The same spot in the local frame (x east, y up, z south). */
  local: Vec3;
  /** The spot has no height worth keeping (picked on the map, or typed without one). */
  horizontalOnly?: boolean;
}

export interface PlaceFit {
  corners: RasterCorners;
  metresPerPx: number;
  /** Turn of the sheet, degrees counter-clockwise seen from above (0: its top points north). */
  turnDeg: number;
  /** Distance of each pair from the fit, metres, and their root mean square. */
  residuals: number[];
  rms: number;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Where a drawing lies from two or more point pairs: the level similarity fit the model alignment
 * uses (turn about the vertical, one scale, shift), so a sheet is never sheared or mirrored. Its
 * base is the mean height of the pairs that have one, else the project base.
 *
 * `shift`: the date shift of a dated drawing. Its site points are picked where the date is drawn,
 * so they are taken less the shift and the corners come back in the raster's own frame (what is
 * saved; the engine adds the shift when it draws them).
 */
export function cornersFromPairs(
  picked: readonly PlacePair[],
  size: { width: number; height: number },
  shift: DateShift | null = null,
): PlaceFit | { error: string } {
  const pairs = shift ? picked.map((p) => ({ ...p, local: unshiftLocal(p.local, shift) })) : picked;
  if (pairs.length < 2) return { error: 'Give at least two point pairs.' };
  // The fit refuses drawing points that coincide; site points that do would give a sheet of no
  // size (scale 0). A millimetre apart on the site is one spot.
  const spread = Math.max(
    ...pairs.map((p) =>
      Math.hypot(p.local[0] - (pairs[0]?.local[0] ?? 0), p.local[2] - (pairs[0]?.local[2] ?? 0)),
    ),
  );
  if (!(spread > 1e-3)) {
    return { error: 'The site points are too close together. Give spots further apart.' };
  }
  try {
    const fit = fitSimilarity3D(
      pairs.map((p) => ({
        src: [p.px[0], 0, p.px[1]] as Vec3,
        dst: p.local,
        ...(p.horizontalOnly ? { horizontalOnly: true } : {}),
      })),
      'upright',
      { heightOffset: 0 },
    );
    const at = (x: number, y: number): Vec3 => {
      const p = applyMat4(fit.matrix, [x, 0, y]);
      return [r6(p[0]), r6(p[1]), r6(p[2])];
    };
    if (!(fit.scale > 1e-9) || !Number.isFinite(fit.scale)) {
      return { error: 'These pairs give the drawing no size. Give spots further apart.' };
    }
    return {
      corners: { tl: at(0, 0), tr: at(size.width, 0), bl: at(0, size.height) },
      metresPerPx: fit.scale,
      turnDeg: fit.yawDeg,
      residuals: fit.residuals,
      rms: fit.rms,
    };
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    // the fit speaks of a model; here the points are on a drawing
    return { error: text.replace('The model points', 'The drawing points') };
  }
}

/**
 * The split that shows a drawing side by side: the drawing on the right, and on the left the view
 * the person was in (`mode`), or what the left already shows when the split is open.
 */
export function sideBySide(
  pref: SplitPref,
  mode: '3d' | 'map' | 'split',
  layerId: string,
): SplitPref {
  const left = mode === 'split' ? (pref.left === 'raster' ? '3d' : pref.left) : mode;
  return { ...pref, left, right: 'raster', raster: layerId };
}
