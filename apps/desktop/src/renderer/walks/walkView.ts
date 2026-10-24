import type { XZ } from '@aio/geo';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/*
 * SPIKE (walk view cone, draped track, walk compare): where each open 360 pane is in its walk and
 * where it looks, keyed by walk layer, so two walks can play at once and the map and the 3D view
 * can draw a marker with a view cone for each. The pane writes its time on every tick and its look
 * once per animation frame while it is dragged or zoomed.
 */

export interface WalkViewNow {
  /** Seconds into the walk. */
  t: number;
  /** Compass bearing of the picture centre, degrees (null while the walk is not placed). */
  lookDeg: number | null;
  pitchDeg: number;
  /** The viewer's vertical field of view, degrees (what the pano camera takes). */
  fovDeg: number;
  /** The horizontal field of view the pane shows, degrees: the cone's width. */
  hfovDeg: number;
}

export const walkViews = createStore<Readonly<Record<string, WalkViewNow>>>()(() => ({}));

/** The 360 pane of walk `layerId` is at `v`. */
export function setWalkView(layerId: string, v: WalkViewNow): void {
  const prev = walkViews.getState()[layerId];
  if (
    prev?.t === v.t &&
    prev.lookDeg === v.lookDeg &&
    prev.pitchDeg === v.pitchDeg &&
    prev.fovDeg === v.fovDeg &&
    prev.hfovDeg === v.hfovDeg
  )
    return;
  walkViews.setState({ ...walkViews.getState(), [layerId]: v });
}

/** The pane of walk `layerId` closed or switched walk. */
export function clearWalkView(layerId: string): void {
  const s = walkViews.getState();
  if (!(layerId in s)) return;
  walkViews.setState(Object.fromEntries(Object.entries(s).filter(([k]) => k !== layerId)), true);
}

export function useWalkView(layerId: string | null): WalkViewNow | undefined {
  return useStore(walkViews, (s) => (layerId === null ? undefined : s[layerId]));
}

/** The horizontal field of view of a view `w` x `h` px at vertical field of view `fovDeg`. */
export function horizontalFov(fovDeg: number, w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return fovDeg;
  const v = (fovDeg * Math.PI) / 180;
  return Math.min(179, (2 * Math.atan(Math.tan(v / 2) * (w / h)) * 180) / Math.PI);
}

// ---------------------------------------------------------------- marker style (temporary)

/** The three marker designs the founder picks between (mock-up A Beam, B Compass, C Rays). */
export type WalkMarkerStyle = 'beam' | 'compass' | 'rays';
export const MARKER_STYLES: readonly WalkMarkerStyle[] = ['beam', 'compass', 'rays'];
/** TEMPORARY: the marker design, set by hand in DevTools or cycled with Ctrl+Alt+M. */
export const MARKER_STYLE_KEY = 'stratlas.walkMarkerStyle';

function readStyle(): WalkMarkerStyle {
  try {
    const v = globalThis.localStorage.getItem(MARKER_STYLE_KEY);
    return MARKER_STYLES.find((s) => s === v) ?? 'beam';
  } catch {
    return 'beam';
  }
}

export const walkMarkerStyle = createStore<{ style: WalkMarkerStyle }>()(() => ({
  style: readStyle(),
}));

export function setWalkMarkerStyle(style: WalkMarkerStyle): void {
  try {
    globalThis.localStorage.setItem(MARKER_STYLE_KEY, style);
  } catch {
    // the choice still holds for this run
  }
  walkMarkerStyle.setState({ style });
}

/** Ctrl+Alt+M steps to the next design (temporary, for judging the spike). */
export function cycleWalkMarkerStyle(): WalkMarkerStyle {
  const cur = walkMarkerStyle.getState().style;
  const next = MARKER_STYLES[(MARKER_STYLES.indexOf(cur) + 1) % MARKER_STYLES.length] ?? 'beam';
  setWalkMarkerStyle(next);
  return next;
}

if (typeof window !== 'undefined') {
  // another window (or DevTools) changed the key: pick it up
  window.addEventListener('storage', (e) => {
    if (e.key === MARKER_STYLE_KEY) walkMarkerStyle.setState({ style: readStyle() });
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        cycleWalkMarkerStyle();
      }
    },
    { capture: true },
  );
}

// ---------------------------------------------------------------- geometry (model x/z)

/** Metres on the ground of the marker's parts, per design (about the mock-up's size at zoom 18). */
export const MARKER_M = {
  beam: 14,
  compassRing: 4,
  compassFan: 7.5,
  rays: 14,
  /** The walk-direction tick, this far ahead of the spot. */
  tick: 2.5,
} as const;

/** Model heading (radians, as the walk fit's `headingRad`) of a compass bearing in degrees. */
export const headingFromBearingDeg = (deg: number): number => (-deg * Math.PI) / 180;

/** A model x/z point `dist` metres from `from` along model heading `headingRad`. */
export function along(from: XZ, headingRad: number, dist: number): XZ {
  return [from[0] - dist * Math.sin(headingRad), from[1] - dist * Math.cos(headingRad)];
}

/**
 * A fan (view cone) in model x/z: the apex, then `steps + 1` points on the arc from the left edge
 * to the right edge of a look along `lookHeadingRad`, `halfRad` either side, `radius` metres out.
 */
export function fanPoints(
  apex: XZ,
  lookHeadingRad: number,
  halfRad: number,
  radius: number,
  steps = 16,
): XZ[] {
  const out: XZ[] = [apex];
  for (let i = 0; i <= steps; i++) {
    // heading grows anticlockwise: the left edge of the look is the larger heading
    const h = lookHeadingRad + halfRad - (2 * halfRad * i) / steps;
    out.push(along(apex, h, radius));
  }
  return out;
}

/** A circle of `radius` metres about `c`, `steps` points (closed). */
export function ringPoints(c: XZ, radius: number, steps = 32): XZ[] {
  const out: XZ[] = [];
  for (let i = 0; i <= steps; i++) out.push(along(c, (2 * Math.PI * i) / steps, radius));
  return out;
}

/**
 * The rays design's arrowhead about `c`, turned to the look (model heading): nose, left wing,
 * notch, right wing (a slim dart about 5 m long, so its point reads at a glance).
 */
export function arrowPoints(c: XZ, lookHeadingRad: number): [XZ, XZ, XZ, XZ] {
  return [
    along(c, lookHeadingRad, 3.4),
    along(c, lookHeadingRad + 2.55, 2.2),
    along(c, lookHeadingRad + Math.PI, 0.9),
    along(c, lookHeadingRad - 2.55, 2.2),
  ];
}
