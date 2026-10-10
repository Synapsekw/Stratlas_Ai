/**
 * What each graphics preset buys the Globe, and its slow turn when left alone. Numbers only: the
 * view applies them to the CesiumJS scene (`view/setup.ts`, `view/controller.ts`).
 */
export type GlobeTierName = 'low' | 'medium' | 'high' | 'ultra';

export interface GlobeLook {
  /** Most device pixels per CSS pixel the scene and its tiles are drawn at. */
  maxPixelRatio: number;
  /**
   * The Globe's own light and air, one pass over the finished frame: soft shading of the whole
   * Earth, a haze along its limb, a thin glow around it and a sparse field of stars.
   */
  aura: boolean;
  msaa: number;
  /** CesiumJS screen-space error for the Earth's tiles: lower is sharper and loads more tiles. */
  screenSpaceError: number;
  /** The same while street tiles are drawn (their labels read best close to their own size). */
  streetScreenSpaceError: number;
  /** Earth tiles kept beyond the ones in view. */
  tileCache: number;
  /** The slow turn of the whole Earth when nobody touches it. */
  idleSpin: boolean;
}

export const GLOBE_LOOKS: Record<GlobeTierName, GlobeLook> = {
  low: {
    maxPixelRatio: 1,
    aura: false,
    msaa: 1,
    screenSpaceError: 3,
    streetScreenSpaceError: 2,
    tileCache: 50,
    idleSpin: false,
  },
  medium: {
    maxPixelRatio: 1.5,
    aura: true,
    msaa: 4,
    screenSpaceError: 2,
    streetScreenSpaceError: 1.25,
    tileCache: 100,
    idleSpin: true,
  },
  high: {
    maxPixelRatio: 2,
    aura: true,
    msaa: 4,
    screenSpaceError: 1.5,
    streetScreenSpaceError: 1.15,
    tileCache: 140,
    idleSpin: true,
  },
  ultra: {
    maxPixelRatio: 2,
    aura: true,
    msaa: 4,
    screenSpaceError: 1.5,
    streetScreenSpaceError: 1.15,
    tileCache: 180,
    idleSpin: true,
  },
};

/** Device pixels per CSS pixel the Globe draws at on this screen and preset (never below 1). */
export function globePixelRatio(devicePixelRatio: number, look: GlobeLook): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(1, Math.min(dpr, look.maxPixelRatio));
}

/** The whole Earth is in view from this height up, metres above the ellipsoid. */
export const WHOLE_EARTH_HEIGHT_M = 7_000_000;

/**
 * How much of the whole-Earth light shows at a camera height: all of it far out, none near the
 * ground, where the map keeps exactly its own colours.
 */
export function wholeEarthAmount(heightM: number): number {
  const t = (heightM - 900_000) / (5_500_000 - 900_000);
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

export interface IdleSpin {
  /** Nothing moves for this long after the last touch, milliseconds. */
  delayMs: number;
  /** The turn eases in and out over this long. */
  easeMs: number;
  /** After this long it comes to rest, so a Globe left open goes back to drawing nothing. */
  runMs: number;
  /** Degrees of longitude a second at full pace (eastwards: the Earth turns under the view). */
  degPerSecond: number;
}

export const IDLE_SPIN: IdleSpin = {
  delayMs: 6000,
  easeMs: 2500,
  runMs: 50_000,
  degPerSecond: 1.6,
};

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/**
 * The pace of the idle turn `sinceTouchMs` after the last touch, in degrees a second: nothing
 * during the delay, an eased start, a steady turn, an eased stop, then nothing again.
 */
export function idleSpinRate(sinceTouchMs: number, spin: IdleSpin = IDLE_SPIN): number {
  const t = sinceTouchMs - spin.delayMs;
  if (!(t > 0) || t >= spin.runMs) return 0;
  const ease = Math.min(spin.easeMs, spin.runMs / 2);
  const up = smooth(t / ease);
  const down = smooth((spin.runMs - t) / ease);
  return spin.degPerSecond * Math.min(up, down);
}

/** Whether the idle turn is still to come or under way (frames are asked for only while it is). */
export function idleSpinPending(sinceTouchMs: number, spin: IdleSpin = IDLE_SPIN): boolean {
  return sinceTouchMs < spin.delayMs + spin.runMs;
}
