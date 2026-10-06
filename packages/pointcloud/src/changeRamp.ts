import { Color } from 'three';

/**
 * The change colour ramp (M8 cloud change): grey where nothing moved, warm where the later date is
 * further from the earlier one. Diverging scalars (signed distance) go blue below zero (lower,
 * inside) through grey to red above it (higher, outside); unsigned ones go grey, amber, red. One
 * table feeds the point shader (linear colours: the output pass converts to sRGB), the legend (CSS)
 * and the tests, so the legend always matches the cloud.
 */
export const CHANGE_STOPS = {
  /** Diverging: at -1, 0 and +1 of the symmetric range. */
  diverging: ['#3b6ed6', '#9ca3af', '#e2412b'],
  /** Sequential: at 0, 0.5 and 1 of the range. */
  sequential: ['#9ca3af', '#f5c542', '#e2412b'],
} as const;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const srgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

function mix3(stops: readonly string[], u: number): [number, number, number] {
  const [a, b, c] = stops.map(srgb) as [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  const t = clamp(u, 0, 1);
  const [p, q, f] = t <= 0.5 ? [a, b, t * 2] : [b, c, t * 2 - 1];
  return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f];
}

/**
 * Display colour (sRGB, 0 to 1 per channel) of a scalar `value` over a half range `range` (the
 * value that gets the full colour, metres).
 */
export function changeColour(
  value: number,
  range: number,
  diverging: boolean,
): [number, number, number] {
  const t = value / Math.max(range, 1e-6);
  return diverging
    ? mix3(CHANGE_STOPS.diverging, (clamp(t, -1, 1) + 1) / 2)
    : mix3(CHANGE_STOPS.sequential, Math.abs(t));
}

/** CSS gradient of the ramp, left to right, for the legend. */
export function changeGradient(diverging: boolean): string {
  const stops = diverging ? CHANGE_STOPS.diverging : CHANGE_STOPS.sequential;
  return `linear-gradient(to right, ${stops[0]} 0%, ${stops[1]} 50%, ${stops[2]} 100%)`;
}

const linear = (hex: string) => {
  const c = new Color(hex);
  return `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;
};

/** GLSL `vec3 changeRamp(float t, float diverging)` with `t` the value over the range. */
export const CHANGE_RAMP_GLSL = /* glsl */ `
vec3 changeRamp(float t, float diverging) {
  float u = diverging > 0.5 ? (clamp(t, -1.0, 1.0) + 1.0) * 0.5 : clamp(abs(t), 0.0, 1.0);
  vec3 a = diverging > 0.5 ? ${linear(CHANGE_STOPS.diverging[0])} : ${linear(CHANGE_STOPS.sequential[0])};
  vec3 b = diverging > 0.5 ? ${linear(CHANGE_STOPS.diverging[1])} : ${linear(CHANGE_STOPS.sequential[1])};
  vec3 c = diverging > 0.5 ? ${linear(CHANGE_STOPS.diverging[2])} : ${linear(CHANGE_STOPS.sequential[2])};
  return u <= 0.5 ? mix(a, b, u * 2.0) : mix(b, c, u * 2.0 - 1.0);
}
`;

/** True when a display colour reads as warm (red or amber), for checks and tests. */
export function isWarm([r, g, b]: readonly [number, number, number]): boolean {
  return r - b > 0.25 && r >= g;
}

/** True when a display colour reads as neutral grey. */
export function isNeutral([r, g, b]: readonly [number, number, number]): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) < 0.12;
}
