import type { XZ } from '@aio/geo';
import { hasTurn, type DateShift } from '@aio/schema';
import { useCallback, useRef } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/*
 * Where each open 360 pane is in its walk and where it looks, keyed by walk layer, so two walks can
 * play at once (compare) and the map, the drawings and the 3D view draw the Beam marker of each
 * (design "The marker shows where you look"): a dot in the walk's date colour, a soft fan along
 * the look as wide as the pane's horizontal field of view, and a tick for the way the walk moves.
 * A pane publishes through `walkViewPublisher`, at most once an animation frame.
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

/** Ask for `cb` before the next paint (`requestAnimationFrame`); a test steps its own. */
export interface FrameClock {
  request(cb: () => void): number;
  cancel(id: number): void;
}

const rafClock: FrameClock = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => {
    cancelAnimationFrame(id);
  },
};

/**
 * Publish the views of walk `layerId` at most once a frame (a drag moves the look on every pointer
 * move): the last view asked for in a frame is the one written. `stop` drops a waiting write and
 * clears the walk (the pane closed or switched walk).
 */
export function walkViewPublisher(
  layerId: string,
  clock: FrameClock = rafClock,
): { publish(v: WalkViewNow): void; stop(): void } {
  let pending: WalkViewNow | null = null;
  let frame: number | null = null;
  return {
    publish: (v) => {
      pending = v;
      if (frame !== null) return;
      frame = clock.request(() => {
        frame = null;
        const next = pending;
        pending = null;
        if (next) setWalkView(layerId, next);
      });
    },
    stop: () => {
      if (frame !== null) clock.cancel(frame);
      frame = null;
      pending = null;
      clearWalkView(layerId);
    },
  };
}

export function useWalkView(layerId: string | null): WalkViewNow | undefined {
  return useStore(walkViews, (s) => (layerId === null ? undefined : s[layerId]));
}

/**
 * The views of the walks in `ids` (a stable object while none of theirs changes): a drawing
 * renders again for the walks it shows only, never for another walk's tick.
 */
export function useWalkViewsAmong(ids: ReadonlySet<string>): Readonly<Record<string, WalkViewNow>> {
  const last = useRef<Readonly<Record<string, WalkViewNow>>>({});
  const select = useCallback(
    (s: Readonly<Record<string, WalkViewNow>>) => {
      const next = viewsAmong(s, ids);
      const prev = last.current;
      const keys = Object.keys(next);
      if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]))
        return prev;
      last.current = next;
      return next;
    },
    [ids],
  );
  return useStore(walkViews, select);
}

/** The views of the walks in `ids` only. */
export function viewsAmong(
  s: Readonly<Record<string, WalkViewNow>>,
  ids: ReadonlySet<string>,
): Readonly<Record<string, WalkViewNow>> {
  return Object.fromEntries(Object.entries(s).filter(([k]) => ids.has(k)));
}

/** The horizontal field of view of a view `w` x `h` px at vertical field of view `fovDeg`. */
export function horizontalFov(fovDeg: number, w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return fovDeg;
  const v = (fovDeg * Math.PI) / 180;
  return Math.min(179, (2 * Math.atan(Math.tan(v / 2) * (w / h)) * 180) / Math.PI);
}

// ---------------------------------------------------------------- geometry (model x/z)

/** The Beam's parts on screen (map, drawings), px: the same size at every zoom. */
export const BEAM_PX = {
  /** How far the fan reaches from the spot. */
  reach: 64,
  dot: 6,
  /** The light ring round the dot. */
  ring: 2,
  /** The walk-direction tick, this far ahead of the spot, and its radius. */
  tick: 13,
  tickR: 2.25,
} as const;

/** The Beam's parts in the 3D view, metres on the ground (about its map size at zoom 18). */
export const BEAM_M = {
  reach: 14,
  dot: 0.45,
  tick: 2.5,
  /** The stem up from the spot, its dot on top: it reads from any side. */
  stem: 1.8,
} as const;

/** The fan's fade along its reach (offset 0..1, opacity): strong at the spot, gone at the rim. */
export const BEAM_FADE: readonly (readonly [number, number])[] = [
  [0, 0.6],
  [0.25, 0.38],
  [0.55, 0.16],
  [0.8, 0.05],
  [1, 0],
];

/** Half the fan's angle, radians, for a horizontal field of view in degrees (5 to 170 wide). */
export function beamHalfRad(hfovDeg: number): number {
  const w = Number.isFinite(hfovDeg) ? Math.min(170, Math.max(5, hfovDeg)) : 90;
  return (w * Math.PI) / 360;
}

const n3 = (v: number): string => String(Math.round(v * 1000) / 1000 || 0);

/**
 * The fan as an SVG path in screen px: the apex at 0,0, the centre line along +x (rotate it to the
 * look), the edges `halfRad` either side, `reach` px out.
 */
export function beamFanPath(reach: number, halfRad: number): string {
  const x = reach * Math.cos(halfRad);
  const y = reach * Math.sin(halfRad);
  const large = 2 * halfRad > Math.PI ? 1 : 0;
  const r = n3(reach);
  return `M0 0L${n3(x)} ${n3(-y)}A${r} ${r} 0 ${String(large)} 1 ${n3(x)} ${n3(y)}Z`;
}

/** Model heading (radians, as the walk fit's `headingRad`) of a compass bearing in degrees. */
export const headingFromBearingDeg = (deg: number): number => (-deg * Math.PI) / 180;

/**
 * A model heading (radians) of a walk as its lined-up date draws it: a turn of the date turns every
 * direction by its rotation (as `shiftLocal` turns points; the scale and the move leave directions
 * alone). The same heading without a turn.
 */
export function shiftHeadingRad(headingRad: number, shift: DateShift | null | undefined): number {
  const turn = shift?.turn;
  return turn && hasTurn(turn) ? headingRad + (turn.rotationDeg * Math.PI) / 180 : headingRad;
}

/** A compass bearing (degrees, 0 to 360) of a walk as its lined-up date draws it. */
export function shiftBearingDeg(deg: number, shift: DateShift | null | undefined): number {
  const turn = shift?.turn;
  if (!turn || !hasTurn(turn)) return deg;
  const d = deg - turn.rotationDeg;
  return ((d % 360) + 360) % 360;
}

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
