import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Linked zoom and pan of two photos or video frames in Compare (founder, 13 Oct 2026): one view
 * for both sides. `s` is the scale (1: the picture fits its box), `x` and `y` shift the picture
 * centre in box widths and heights; the picture always covers its box.
 */
export interface ZoomView {
  s: number;
  x: number;
  y: number;
}
export const ZOOM = { min: 1, max: 8, step: 1.25 } as const;
export const FIT: ZoomView = { s: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampView(v: ZoomView): ZoomView {
  const s = clamp(v.s, ZOOM.min, ZOOM.max);
  const m = (s - 1) / 2;
  // `|| 0` turns -0 into 0, so a view back at fit equals FIT
  return { s, x: clamp(v.x, -m, m) || 0, y: clamp(v.y, -m, m) || 0 };
}

/** Zoom by `factor` about the box point (`px`, `py`), in box fractions from its centre. */
export function zoomAt(v: ZoomView, factor: number, px: number, py: number): ZoomView {
  const s = clamp(v.s * factor, ZOOM.min, ZOOM.max);
  const k = s / v.s;
  return clampView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
}

/** Pan by (`dx`, `dy`) box fractions. */
export function panBy(v: ZoomView, dx: number, dy: number): ZoomView {
  return clampView({ s: v.s, x: v.x + dx, y: v.y + dy });
}

/** The transform of the picture layer (transform origin at its centre). */
export function viewCss(v: ZoomView): string {
  return `translate(${String(v.x * 100)}%, ${String(v.y * 100)}%) scale(${String(v.s)})`;
}

export interface ZoomLinkState {
  view: ZoomView;
  set(v: ZoomView): void;
}
export function createZoomLink(): StoreApi<ZoomLinkState> {
  return createStore<ZoomLinkState>()((set) => ({
    view: FIT,
    set: (v) => {
      set({ view: clampView(v) });
    },
  }));
}
