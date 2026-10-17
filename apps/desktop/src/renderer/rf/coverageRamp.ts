/**
 * The coverage colours (spec D23a, D26, mockup docs/design/rf-coverage): the RSRP ramp, the
 * best-server sector colours and the overlap colours, with a hatch per class so a class is never
 * told by colour alone. The map is always dark and the coverage sits on imagery, so these values
 * do not change with the theme (like `MAP_INK`); the legend draws its swatches from the same
 * values. `coverageRamp.test.ts` checks them against the legend surface in every mode.
 */
import { rsrpClass } from '@aio/rf';
import type { RfThresholds } from '@aio/schema';

export const RSRP_CLASSES = ['excellent', 'good', 'fair', 'poor', 'none'] as const;
export type RsrpClassKey = (typeof RSRP_CLASSES)[number];
/** The classes that are drawn ("no service" is transparent, D23a). */
export type ShownClass = Exclude<RsrpClassKey, 'none'>;

/** A colour as oklch (lightness 0 to 1, chroma, hue in degrees). */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** The RSRP ramp, strongest first (the mockup's map tint). */
export const RSRP_RAMP: Readonly<Record<ShownClass, Oklch>> = {
  excellent: { l: 0.7, c: 0.19, h: 150 },
  good: { l: 0.84, c: 0.18, h: 130 },
  fair: { l: 0.92, c: 0.17, h: 98 },
  poor: { l: 0.8, c: 0.15, h: 48 },
};

/** Best server: one colour per sector, in sector order (cycled past the end). */
export const SECTOR_RAMP: readonly Oklch[] = [
  { l: 0.72, c: 0.13, h: 250 },
  { l: 0.8, c: 0.14, h: 80 },
  { l: 0.72, c: 0.15, h: 320 },
  { l: 0.74, c: 0.14, h: 160 },
  { l: 0.7, c: 0.17, h: 25 },
  { l: 0.76, c: 0.12, h: 200 },
];

/** Overlap: two servers within the window, three or more. */
export const OVERLAP_RAMP: Readonly<Record<'two' | 'more', Oklch>> = {
  two: RSRP_RAMP.fair,
  more: RSRP_RAMP.poor,
};

/** A hatch drawn over a class (D26): none, lines one way or the other, both, or dots. */
export type Hatch = 'none' | 'rising' | 'falling' | 'cross' | 'dots';

export const CLASS_HATCH: Readonly<Record<ShownClass, Hatch>> = {
  excellent: 'none',
  good: 'rising',
  fair: 'falling',
  poor: 'cross',
};
const SECTOR_HATCH: readonly Hatch[] = ['rising', 'none', 'dots', 'falling', 'cross'];
export const sectorHatch = (i: number): Hatch => SECTOR_HATCH[i % SECTOR_HATCH.length] ?? 'none';
export const sectorColour = (i: number): Oklch =>
  SECTOR_RAMP[i % SECTOR_RAMP.length] ?? { l: 0.72, c: 0.13, h: 250 };
export const OVERLAP_HATCH: Readonly<Record<'two' | 'more', Hatch>> = {
  two: 'none',
  more: 'rising',
};

/** "Show from" (D23a): every class, fair and better, good and better. */
export type ShowFrom = 'all' | 'fair' | 'good';
export const SHOW_FROM: readonly ShowFrom[] = ['all', 'fair', 'good'];

/** Whether a class is drawn under a "Show from" choice. */
export function classShown(cls: RsrpClassKey, from: ShowFrom): boolean {
  if (cls === 'none') return false;
  if (from === 'good') return cls === 'excellent' || cls === 'good';
  if (from === 'fair') return cls !== 'poor';
  return true;
}

/** The class of an RSRP value (the job's `rsrp_classes`); null for no data. */
export function classOf(rsrp: number, t: RfThresholds): RsrpClassKey | null {
  return Number.isFinite(rsrp) ? rsrpClass(rsrp, t) : null;
}

export const css = (k: Oklch, alpha?: number): string =>
  alpha === undefined
    ? `oklch(${String(k.l)} ${String(k.c)} ${String(k.h)})`
    : `oklch(${String(k.l)} ${String(k.c)} ${String(k.h)} / ${String(alpha)})`;

/** sRGB bytes of an oklch colour, clamped to the gamut (the `oklchHex` maths of `@aio/maps`). */
export function rgb(k: Oklch): [number, number, number] {
  const a = k.c * Math.cos((k.h * Math.PI) / 180);
  const b = k.c * Math.sin((k.h * Math.PI) / 180);
  const l1 = (k.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (k.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (k.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
  const out = lin.map((x) => {
    const v = Math.min(1, Math.max(0, x));
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(s * 255);
  });
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0];
}

/** `#rrggbb` of an oklch colour (MapLibre and three.js do not parse oklch). */
export const hex = (k: Oklch): string =>
  `#${rgb(k)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;

/** The hatch line colour over a swatch: the same hue, much darker. */
export const hatchInk = (k: Oklch): Oklch => ({ l: Math.max(0, k.l - 0.42), c: k.c * 0.8, h: k.h });

/** A CSS background for a legend swatch: the colour with its hatch, as the map draws it. */
export function swatchBackground(k: Oklch, hatch: Hatch, on: boolean): string {
  const fill = css(k);
  if (!on || hatch === 'none') return fill;
  const ink = css(hatchInk(k));
  const line = (deg: number) =>
    `repeating-linear-gradient(${String(deg)}deg, ${ink} 0 1.5px, transparent 1.5px 5px)`;
  if (hatch === 'rising') return `${line(-45)}, ${fill}`;
  if (hatch === 'falling') return `${line(45)}, ${fill}`;
  if (hatch === 'cross') return `${line(45)}, ${line(-45)}, ${fill}`;
  return `radial-gradient(circle, ${ink} 1.2px, transparent 1.4px) 0 0 / 4px 4px, ${fill}`;
}
