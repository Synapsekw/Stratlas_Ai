/**
 * Light from the sky for a sun position: a CPU port of the Preetham sky in three's `Sky` addon
 * (the dome the stage draws), and the sun, ambient, fog and exposure levels derived from it so
 * lights, fog and the ground imagery agree with the dome at every time of day.
 */

export type Rgb = [number, number, number];

/** Parameters of the sky (three's Sky uniforms). Hazy desert air by default. */
export interface SkyParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
}

export const DESERT_SKY: SkyParams = {
  turbidity: 4,
  rayleigh: 1.4,
  mieCoefficient: 0.006,
  mieDirectionalG: 0.8,
};

const TOTAL_RAYLEIGH: Rgb = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST: Rgb = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF = 1.6110731556870734;

function sunIntensityE(zenithCos: number): number {
  const z = Math.min(1, Math.max(-1, zenithCos));
  return 1000 * Math.max(0, 1 - Math.exp(-((CUTOFF - Math.acos(z)) / 1.5)));
}

/** Radiance of the dome toward unit `dir` (no clouds, no solar disc), as the Sky shader draws it. */
export function skyRadiance(
  dir: readonly number[],
  sun: readonly number[],
  p: SkyParams = DESERT_SKY,
): Rgb {
  const sunY = sun[1] ?? 0;
  const sunE = sunIntensityE(sunY);
  const betaR = TOTAL_RAYLEIGH.map((v) => v * p.rayleigh);
  const mieC = 0.2 * p.turbidity * 10e-18;
  const betaM = MIE_CONST.map((v) => 0.434 * mieC * v * p.mieCoefficient);
  const dy = Math.max(0, dir[1] ?? 0);
  const zen = Math.acos(dy);
  const inv = 1 / (Math.cos(zen) + 0.15 * Math.pow(93.885 - (zen * 180) / Math.PI, -1.253));
  const sR = 8.4e3 * inv;
  const sM = 1.25e3 * inv;
  const cosT = (dir[0] ?? 0) * (sun[0] ?? 0) + (dir[1] ?? 0) * sunY + (dir[2] ?? 0) * (sun[2] ?? 0);
  const rPhase = 0.05968310365946075 * (1 + Math.pow(cosT * 0.5 + 0.5, 2));
  const g = p.mieDirectionalG;
  const mPhase = (0.07957747154594767 * (1 - g * g)) / Math.pow(1 - 2 * g * cosT + g * g, 1.5);
  const horizonMix = Math.min(1, Math.max(0, Math.pow(1 - sunY, 5)));
  const out: Rgb = [0, 0, 0];
  const tint = [0, 0.0003, 0.00075];
  for (let i = 0; i < 3; i++) {
    const bR = betaR[i] ?? 0;
    const bM = betaM[i] ?? 0;
    const fex = Math.exp(-(bR * sR + bM * sM));
    const ratio = (bR * rPhase + bM * mPhase) / (bR + bM);
    let lin = Math.pow(sunE * ratio * (1 - fex), 1.5);
    lin *= 1 + (Math.pow(sunE * ratio * fex, 0.5) - 1) * horizonMix;
    out[i] = (lin + 0.1 * fex) * 0.04 + (tint[i] ?? 0);
  }
  return out;
}

/** Cosine-weighted mean radiance of the upper sky over a horizontal surface. */
export function skyIrradianceMean(sun: readonly number[], p: SkyParams = DESERT_SKY): Rgb {
  const acc: Rgb = [0, 0, 0];
  let wsum = 0;
  const rings = 6;
  const steps = 12;
  for (let r = 0; r < rings; r++) {
    const el = ((r + 0.5) / rings) * (Math.PI / 2);
    const w = Math.sin(el) * Math.cos(el);
    for (let s = 0; s < steps; s++) {
      const az = (s / steps) * Math.PI * 2;
      const d = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
      const l = skyRadiance(d, sun, p);
      for (let i = 0; i < 3; i++) acc[i] = (acc[i] ?? 0) + (l[i] ?? 0) * w;
      wsum += w;
    }
  }
  return acc.map((v) => v / wsum) as Rgb;
}

/** Mean radiance of the sky just above the horizon, all round: the haze colour for fog. */
export function horizonRadiance(sun: readonly number[], p: SkyParams = DESERT_SKY): Rgb {
  const acc: Rgb = [0, 0, 0];
  const steps = 16;
  const el = 0.035;
  for (let s = 0; s < steps; s++) {
    const az = (s / steps) * Math.PI * 2;
    const d = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
    const l = skyRadiance(d, sun, p);
    for (let i = 0; i < 3; i++) acc[i] = (acc[i] ?? 0) + (l[i] ?? 0) / steps;
  }
  return acc;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Relative air mass at an elevation (Kasten and Young), capped below the horizon. */
export function airMass(elevationDeg: number): number {
  const el = Math.max(elevationDeg, -1);
  return Math.min(
    40,
    1 / (Math.sin((Math.max(el, 0) * Math.PI) / 180) + 0.50572 * Math.pow(el + 6.07995, -1.6364)),
  );
}

/** Optical depths of the hazy atmosphere for red, green and blue. */
const TAU: Rgb = [0.09, 0.15, 0.3];

/**
 * Scale from the Sky shader's radiance to the stage's light units, where a sun of intensity
 * about pi lights a white surface white. Applied to the dome, the environment map and fog alike.
 */
export const SKY_GAIN = 0.12;
/** Sun intensity at the zenith; about pi so a white surface facing the sun reads white. */
export const SUN_ZENITH = 3.2;
/** Moonlight relative to the sun; enough to read the site at night. */
const MOON = 0.3;
const MOON_COLOUR: Rgb = [0.55, 0.68, 1];
/** Ambient floor (starlight, city glow): only noticeable once the sky has gone dark. */
const NIGHT_AMBIENT: Rgb = [0.03, 0.042, 0.07];

const lumOf = (c: readonly number[]) =>
  0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);

/** A colour's hue at luminance 1, desaturated toward white by `keep` (0 white, 1 full hue). */
function tintOf(c: readonly number[], keep: number): Rgb {
  const l = Math.max(lumOf(c), 1e-6);
  return [0, 1, 2].map((i) => 1 + ((c[i] ?? 0) / l - 1) * keep) as Rgb;
}

export interface Daylight {
  /** 0 in full day, 1 in full night. */
  night: number;
  /** Direct light colour (max channel 1) and intensity; the moon at night. */
  lightColour: Rgb;
  lightIntensity: number;
  /** The direct light comes from the moon (fixed direction) rather than the sun. */
  moon: boolean;
  /** Scale on the sky environment map (image-based light). */
  envIntensity: number;
  /** Hemisphere light filling in at night, when the sky map is nearly black. */
  hemiIntensity: number;
  hemiColour: Rgb;
  /** Linear fog / haze colour. */
  fog: Rgb;
  /** Renderer exposure: the eye adapts to dusk and night. */
  exposure: number;
  /** Factors for unlit ground imagery photographed in daylight: in sun and in shadow. */
  groundLit: Rgb;
  groundShade: Rgb;
  /** Added to the dome after sunset so the night sky is deep blue, not black. */
  nightSky: Rgb;
}

/**
 * Light levels for a sun direction (unit, local frame) and elevation. The environment map
 * carries the sky's own light; `envIntensity` keeps it in proportion to the direct sun.
 */
export function daylight(sun: readonly number[], elevationDeg: number, p = DESERT_SKY): Daylight {
  const el = elevationDeg;
  const night = smooth(-1, -10, el);
  const m = airMass(el);
  const t = TAU.map((tau) => Math.exp(-tau * m)) as Rgb;
  const tMax = Math.max(...t);
  const sunUp = smooth(-1.2, 2.5, el);
  const sunColour = t.map((v) => v / tMax) as Rgb;
  const sunIntensity = SUN_ZENITH * tMax * sunUp;
  // the moon takes over once the sun has set (its direction is fixed, see Environment)
  const moon = el < -1.2;
  const moonIntensity = MOON * smooth(-2, -10, el);
  const sinEl = Math.max(0, Math.sin((el * Math.PI) / 180));
  const MOON_COS = 0.7; // moon about 45 degrees up

  const sky = skyIrradianceMean(sun, p).map((v) => v * SKY_GAIN);
  // direct on a horizontal surface, as three lights it: intensity x cos / pi
  const direct = moon
    ? MOON_COLOUR.map((c) => (c * moonIntensity * MOON_COS) / Math.PI)
    : sunColour.map((c) => (c * sunIntensity * sinEl) / Math.PI);
  const ambient = sky.map((v, i) => v + (NIGHT_AMBIENT[i] ?? 0)) as Rgb;
  // eye adaptation: exposure rises as the light fades, up to about 1.6 stops at night
  const total = lumOf(direct) + lumOf(ambient);
  const REF = 0.92; // a clear midday ground, what the drone imagery was shot in
  const exposure = Math.min(3, Math.max(1, Math.pow(REF / Math.max(total, 1e-4), 0.5)));
  // ground imagery already holds daylight: scale its brightness, tint it gently
  const level = (c: readonly number[]) => Math.min(1.08, (lumOf(c) / REF) * exposure);
  const litTint = tintOf(
    direct.map((d, i) => d + (ambient[i] ?? 0)),
    0.35,
  );
  const shadeTint = tintOf(ambient, 0.25);
  const lit = level(direct.map((d, i) => d + (ambient[i] ?? 0)));
  const shade = Math.min(lit, level(ambient));
  const fog = horizonRadiance(sun, p).map(
    (v, i) => v * SKY_GAIN + (NIGHT_AMBIENT[i] ?? 0) * 0.15,
  ) as Rgb;
  return {
    night,
    lightColour: moon ? MOON_COLOUR : sunColour,
    lightIntensity: moon ? moonIntensity : sunIntensity,
    moon,
    envIntensity: 1,
    // three's hemisphere light: intensity x colour / pi; matches the ambient floor
    hemiIntensity: Math.PI,
    hemiColour: NIGHT_AMBIENT,
    fog,
    exposure,
    groundLit: litTint.map((v) => v * lit) as Rgb,
    groundShade: shadeTint.map((v) => v * shade) as Rgb,
    nightSky: [0.0016 * night, 0.0028 * night, 0.0065 * night],
  };
}
