/**
 * Path-loss models (spec D14, D17): 3GPP TR 38.901 UMa, UMi street canyon and RMa with the LOS
 * probability averaged into an expected path loss, Okumura-Hata and COST-231 Hata for the low
 * bands, and free space for a line-of-sight sanity check. Flat ground: heights are above the
 * tower-base ground and distances horizontal (d2D) unless named d3D.
 *
 * The golden vectors (`fixtures/golden/propagation.json`, from the independent
 * `gen_propagation.py`) hold the exact conventions; the short version:
 *
 * - d2D is clamped to at least 10 m in every model (the 38.901 lower bound), so the antenna's own
 *   pixel is finite. Beyond the validated distances the formulas are extrapolated, with a warning.
 * - 38.901, Table 7.4.1-1, with c = 3.0e8 as the TR says. The UMa and UMi breakpoint uses the
 *   effective heights h' = h - hE with hE = 1 m. That is exact for UMi. For UMa the TR draws hE = 1 m
 *   with probability 1 / (1 + C(d2D, hUT)) and C = 0 below a 13 m UE, so 1 m is exact at the default
 *   1.5 m UE and a deliberate simplification above 13 m. LOS probability from Table 7.4.2-1.
 *   A UE below the scenario's range (UMa and UMi 1.5 m, RMa 1 m) is clamped up to it with a
 *   `ue-height` warning; it is never refused, since the study allows a 0.5 m UE.
 * - Expected path loss = P_LOS PL_LOS + (1 - P_LOS) PL_NLOS, combined in dB (the planning
 *   convention; the spec says "averaged into an expected path loss" and names no domain).
 * - Okumura-Hata and COST-231 Hata are floored at free space over d3D: the empirical fits fall below
 *   free space near the mast, well inside their 1 km lower validity. COST-231 has no open-area
 *   form, so `open` applies the Okumura-Hata open-area correction (a documented extension).
 * - Free space is 20 log10(4 pi d3D f / c) with the exact speed of light.
 *
 * Refusals (out-of-range frequency, or a height with no effective height) throw
 * `PathLossRefusalError` carrying the range, so the UI can say why (D14).
 */

import type { PropagationModel, RfEnvironment } from '@aio/schema';

export type PropagationModelId = PropagationModel;
export type Environment38901 = RfEnvironment;
/** Okumura-Hata and COST-231 area classes. `urban` is the medium or small city. */
export type HataArea = 'urban-large' | 'urban' | 'suburban' | 'open';

/** Speed of light as TR 38.901 uses it (note 1 of Table 7.4.1-1). */
export const SPEED_OF_LIGHT_38901 = 3.0e8;
export const SPEED_OF_LIGHT = 299_792_458;
/** Every model clamps the horizontal distance to at least this (the 38.901 lower bound). */
export const MIN_DISTANCE_2D_M = 10;
/** Effective environment height hE for the UMa and UMi breakpoint, metres. */
export const EFFECTIVE_ENV_HEIGHT_M = 1;
/**
 * Lower end of each 38.901 scenario's UE height range (Table 7.4.1-1: UMa and UMi 1.5 to 22.5 m,
 * RMa 1 to 10 m). A lower UE (the study allows 0.5 m) is clamped up to it, with a warning, and never
 * refused: below 1 m UMa and UMi have no effective height at all.
 */
export const TR38901_MIN_UE_HEIGHT_M: Readonly<Record<Environment38901, number>> = {
  uma: 1.5,
  umi: 1.5,
  rma: 1,
};
export const TR38901_MAX_UE_HEIGHT_M: Readonly<Record<Environment38901, number>> = {
  uma: 22.5,
  umi: 22.5,
  rma: 10,
};
/** RMa defaults from Table 7.4.1-1: average building height and street width, metres. */
export const RMA_BUILDING_HEIGHT_M = 5;
export const RMA_STREET_WIDTH_M = 20;

export const HATA_RANGE_MHZ = [150, 1500] as const;
export const COST231_RANGE_MHZ = [1500, 2000] as const;
export const TR38901_RANGE_MHZ: Readonly<Record<Environment38901, readonly [number, number]>> = {
  uma: [500, 100_000],
  umi: [500, 100_000],
  rma: [500, 30_000],
};

/** Hata area when the study names only the 38.901 environment. */
export const HATA_AREA_OF_ENVIRONMENT: Readonly<Record<Environment38901, HataArea>> = {
  uma: 'urban',
  umi: 'urban',
  rma: 'open',
};

const MODEL_LABEL: Readonly<Record<PropagationModelId, string>> = {
  tr38901: '3GPP TR 38.901',
  'okumura-hata': 'Okumura-Hata',
  'cost231-hata': 'COST-231 Hata',
  'free-space': 'Free space',
};

export interface PathLossRefusal {
  code: 'frequency' | 'height';
  model: PropagationModelId;
  /** The model's frequency range for a `frequency` refusal, MHz, inclusive. */
  rangeMHz: [number, number] | null;
  message: string;
}

export class PathLossRefusalError extends Error {
  readonly refusal: PathLossRefusal;
  constructor(refusal: PathLossRefusal) {
    super(refusal.message);
    this.name = 'PathLossRefusalError';
    this.refusal = refusal;
  }
}

export interface PathLossWarning {
  code: 'distance-far' | 'distance-near' | 'bs-height' | 'ue-height';
  message: string;
}

export interface PathLossSetup {
  model: PropagationModelId;
  environment: Environment38901;
  /** Carrier centre frequency, MHz. */
  frequencyMHz: number;
  /** Antenna height above ground, metres. */
  hBsM: number;
  /** UE height above ground, metres. */
  hUtM: number;
  /** Hata area; default from the environment (HATA_AREA_OF_ENVIRONMENT). */
  hataArea?: HataArea;
}

export interface Tr38901Result {
  losDb: number;
  /** max(PL_LOS, PL'_NLOS). */
  nlosDb: number;
  pLos: number;
  /** P_LOS PL_LOS + (1 - P_LOS) PL_NLOS, dB domain. */
  expectedDb: number;
  /** d'BP (UMa, UMi, effective heights) or dBP (RMa, actual heights), metres. */
  breakpointM: number;
  /** The UE height the formulas used: hUT clamped up to TR38901_MIN_UE_HEIGHT_M. */
  hUtUsedM: number;
}

const log10 = Math.log10;

function refuseFrequency(
  model: PropagationModelId,
  f: number,
  range: readonly [number, number],
): PathLossRefusal {
  const [lo, hi] = range;
  return {
    code: 'frequency',
    model,
    rangeMHz: [lo, hi],
    message: `${MODEL_LABEL[model]} covers ${String(lo)} to ${String(hi)} MHz; ${String(f)} MHz is outside it. Pick another model for this band.`,
  };
}

/** Why a setup cannot be computed, or null. Distances never refuse (see pathLossWarnings). */
export function pathLossRefusal(s: PathLossSetup): PathLossRefusal | null {
  const f = s.frequencyMHz;
  if (!(f > 0) || !Number.isFinite(f))
    return {
      code: 'frequency',
      model: s.model,
      rangeMHz: null,
      message: 'The frequency must be more than 0 MHz.',
    };
  if (s.model === 'okumura-hata' && !(f >= HATA_RANGE_MHZ[0] && f <= HATA_RANGE_MHZ[1]))
    return refuseFrequency(s.model, f, HATA_RANGE_MHZ);
  if (s.model === 'cost231-hata' && !(f >= COST231_RANGE_MHZ[0] && f <= COST231_RANGE_MHZ[1]))
    return refuseFrequency(s.model, f, COST231_RANGE_MHZ);
  if (s.model === 'tr38901') {
    const r = TR38901_RANGE_MHZ[s.environment];
    if (!(f >= r[0] && f <= r[1])) return refuseFrequency(s.model, f, r);
  }
  if (!(s.hBsM > 0) || !(s.hUtM > 0) || !Number.isFinite(s.hBsM) || !Number.isFinite(s.hUtM))
    return {
      code: 'height',
      model: s.model,
      rangeMHz: null,
      message: 'Antenna and UE heights must be above the ground.',
    };
  if (s.model === 'tr38901' && s.environment !== 'rma' && s.hBsM <= EFFECTIVE_ENV_HEIGHT_M)
    return {
      code: 'height',
      model: s.model,
      rangeMHz: null,
      message: `${MODEL_LABEL[s.model]} ${s.environment.toUpperCase()} needs the antenna above ${String(EFFECTIVE_ENV_HEIGHT_M)} m.`,
    };
  return null;
}

/** Validated-range notes for a study out to `maxDistanceM`; these never stop a run. */
export function pathLossWarnings(s: PathLossSetup, maxDistanceM: number): PathLossWarning[] {
  const out: PathLossWarning[] = [];
  const name = MODEL_LABEL[s.model];
  const between = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
  if (s.model === 'tr38901') {
    if (maxDistanceM > 5000)
      out.push({
        code: 'distance-far',
        message: `${name} is validated to 5 km; beyond it the result is extrapolated.`,
      });
    if (s.environment === 'rma' && !between(s.hBsM, 10, 150))
      out.push({
        code: 'bs-height',
        message: `${name} RMa is validated for antennas 10 to 150 m high.`,
      });
    const lo = TR38901_MIN_UE_HEIGHT_M[s.environment];
    const hi = TR38901_MAX_UE_HEIGHT_M[s.environment];
    if (s.hUtM < lo)
      out.push({
        code: 'ue-height',
        message: `UE height below the model range, ${String(lo)} m used`,
      });
    else if (s.hUtM > hi)
      out.push({
        code: 'ue-height',
        message: `${name} is validated for UE heights ${String(lo)} to ${String(hi)} m.`,
      });
  } else if (s.model === 'okumura-hata' || s.model === 'cost231-hata') {
    out.push({
      code: 'distance-near',
      message: `${name} is validated from 1 km; nearer the mast it is floored at free space.`,
    });
    if (maxDistanceM > 20_000)
      out.push({
        code: 'distance-far',
        message: `${name} is validated to 20 km; beyond it the result is extrapolated.`,
      });
    if (!between(s.hBsM, 30, 200))
      out.push({
        code: 'bs-height',
        message: `${name} is validated for antennas 30 to 200 m high.`,
      });
    if (!between(s.hUtM, 1, 10))
      out.push({ code: 'ue-height', message: `${name} is validated for UE heights 1 to 10 m.` });
  }
  return out;
}

function d3(d2: number, hBs: number, hUt: number): number {
  return Math.sqrt(d2 * d2 + (hBs - hUt) * (hBs - hUt));
}

/** Free-space path loss over a 3D distance, dB. */
export function freeSpacePathLossDb(frequencyMHz: number, d3DM: number): number {
  return 20 * log10((4 * Math.PI * d3DM * frequencyMHz * 1e6) / SPEED_OF_LIGHT);
}

/** TR 38.901 Table 7.4.2-1, on d2D (clamped to 10 m). */
export function losProbability38901(env: Environment38901, d2DM: number, hUtM: number): number {
  const d = Math.max(d2DM, MIN_DISTANCE_2D_M);
  if (env === 'rma') return d <= 10 ? 1 : Math.exp(-(d - 10) / 1000);
  if (d <= 18) return 1;
  const k = env === 'uma' ? 63 : 36;
  const p = 18 / d + Math.exp(-d / k) * (1 - 18 / d);
  if (env === 'umi' || hUtM <= 13) return p;
  const cPrime = ((hUtM - 13) / 10) ** 1.5;
  return p * (1 + cPrime * 1.25 * (d / 100) ** 3 * Math.exp(-d / 150));
}

function mix(
  los: number,
  nlosPrime: number,
  pLos: number,
  breakpointM: number,
  hUtUsedM: number,
): Tr38901Result {
  const nlos = Math.max(los, nlosPrime);
  return {
    losDb: los,
    nlosDb: nlos,
    pLos,
    expectedDb: pLos * los + (1 - pLos) * nlos,
    breakpointM,
    hUtUsedM,
  };
}

/** TR 38.901 UMa. hUT is clamped up to the scenario's lower bound. */
export function uma38901(
  frequencyMHz: number,
  d2DM: number,
  hBsM: number,
  hUtInM: number,
): Tr38901Result {
  const hUtM = Math.max(hUtInM, TR38901_MIN_UE_HEIGHT_M.uma);
  const fc = frequencyMHz / 1000;
  const d2 = Math.max(d2DM, MIN_DISTANCE_2D_M);
  const dd = d3(d2, hBsM, hUtM);
  const bp =
    (4 * (hBsM - EFFECTIVE_ENV_HEIGHT_M) * (hUtM - EFFECTIVE_ENV_HEIGHT_M) * frequencyMHz * 1e6) /
    SPEED_OF_LIGHT_38901;
  const los =
    d2 <= bp
      ? 28 + 22 * log10(dd) + 20 * log10(fc)
      : 28 + 40 * log10(dd) + 20 * log10(fc) - 9 * log10(bp * bp + (hBsM - hUtM) ** 2);
  const nlosPrime = 13.54 + 39.08 * log10(dd) + 20 * log10(fc) - 0.6 * (hUtM - 1.5);
  return mix(los, nlosPrime, losProbability38901('uma', d2, hUtM), bp, hUtM);
}

/** TR 38.901 UMi street canyon. hUT is clamped up to the scenario's lower bound. */
export function umi38901(
  frequencyMHz: number,
  d2DM: number,
  hBsM: number,
  hUtInM: number,
): Tr38901Result {
  const hUtM = Math.max(hUtInM, TR38901_MIN_UE_HEIGHT_M.umi);
  const fc = frequencyMHz / 1000;
  const d2 = Math.max(d2DM, MIN_DISTANCE_2D_M);
  const dd = d3(d2, hBsM, hUtM);
  const bp =
    (4 * (hBsM - EFFECTIVE_ENV_HEIGHT_M) * (hUtM - EFFECTIVE_ENV_HEIGHT_M) * frequencyMHz * 1e6) /
    SPEED_OF_LIGHT_38901;
  const los =
    d2 <= bp
      ? 32.4 + 21 * log10(dd) + 20 * log10(fc)
      : 32.4 + 40 * log10(dd) + 20 * log10(fc) - 9.5 * log10(bp * bp + (hBsM - hUtM) ** 2);
  const nlosPrime = 35.3 * log10(dd) + 22.4 + 21.3 * log10(fc) - 0.3 * (hUtM - 1.5);
  return mix(los, nlosPrime, losProbability38901('umi', d2, hUtM), bp, hUtM);
}

/** TR 38.901 RMa, with h = 5 m and W = 20 m. hUT is clamped up to the scenario's lower bound. */
export function rma38901(
  frequencyMHz: number,
  d2DM: number,
  hBsM: number,
  hUtInM: number,
): Tr38901Result {
  const hUtM = Math.max(hUtInM, TR38901_MIN_UE_HEIGHT_M.rma);
  const fc = frequencyMHz / 1000;
  const h = RMA_BUILDING_HEIGHT_M;
  const w = RMA_STREET_WIDTH_M;
  const d2 = Math.max(d2DM, MIN_DISTANCE_2D_M);
  const dd = d3(d2, hBsM, hUtM);
  const bp = (2 * Math.PI * hBsM * hUtM * frequencyMHz * 1e6) / SPEED_OF_LIGHT_38901;
  const a = Math.min(0.03 * h ** 1.72, 10);
  const b = Math.min(0.044 * h ** 1.72, 14.77);
  const c = 0.002 * log10(h);
  const pl1 = (d: number) => 20 * log10((40 * Math.PI * d * fc) / 3) + a * log10(d) - b + c * d;
  const los = d2 <= bp ? pl1(dd) : pl1(bp) + 40 * log10(dd / bp);
  const nlosPrime =
    161.04 -
    7.1 * log10(w) +
    7.5 * log10(h) -
    (24.37 - 3.7 * (h / hBsM) ** 2) * log10(hBsM) +
    (43.42 - 3.1 * log10(hBsM)) * (log10(dd) - 3) +
    20 * log10(fc) -
    (3.2 * log10(11.75 * hUtM) ** 2 - 4.97);
  return mix(los, nlosPrime, losProbability38901('rma', d2, hUtM), bp, hUtM);
}

function aHm(f: number, hm: number, area: HataArea): number {
  if (area === 'urban-large')
    return f < 300 ? 8.29 * log10(1.54 * hm) ** 2 - 1.1 : 3.2 * log10(11.75 * hm) ** 2 - 4.97;
  return (1.1 * log10(f) - 0.7) * hm - (1.56 * log10(f) - 0.8);
}

/** Unchecked Hata-family kernel: callers validate the setup once (pathLossRefusal). */
function hataKernel(
  model: 'okumura-hata' | 'cost231-hata',
  f: number,
  d2DM: number,
  hb: number,
  hm: number,
  area: HataArea,
): number {
  const d2 = Math.max(d2DM, MIN_DISTANCE_2D_M);
  const slope = (44.9 - 6.55 * log10(hb)) * log10(d2 / 1000);
  let pl =
    model === 'okumura-hata'
      ? 69.55 + 26.16 * log10(f) - 13.82 * log10(hb) - aHm(f, hm, area) + slope
      : 46.3 +
        33.9 * log10(f) -
        13.82 * log10(hb) -
        aHm(f, hm, area) +
        slope +
        (area === 'urban-large' ? 3 : 0);
  if (area === 'suburban' && model === 'okumura-hata') pl -= 2 * log10(f / 28) ** 2 + 5.4;
  else if (area === 'open') pl += -4.78 * log10(f) ** 2 + 18.33 * log10(f) - 40.94;
  return Math.max(pl, freeSpacePathLossDb(f, d3(d2, hb, hm)));
}

function checkedHata(
  model: 'okumura-hata' | 'cost231-hata',
  f: number,
  d2DM: number,
  hb: number,
  hm: number,
  area: HataArea,
): number {
  const refusal = pathLossRefusal({
    model,
    environment: 'uma',
    frequencyMHz: f,
    hBsM: hb,
    hUtM: hm,
  });
  if (refusal) throw new PathLossRefusalError(refusal);
  return hataKernel(model, f, d2DM, hb, hm, area);
}

/** Okumura-Hata, MHz and metres; refuses outside 150 to 1500 MHz. */
export function okumuraHataDb(
  frequencyMHz: number,
  d2DM: number,
  hBsM: number,
  hUtM: number,
  area: HataArea,
): number {
  return checkedHata('okumura-hata', frequencyMHz, d2DM, hBsM, hUtM, area);
}

/** COST-231 Hata, MHz and metres; refuses outside 1500 to 2000 MHz. */
export function cost231HataDb(
  frequencyMHz: number,
  d2DM: number,
  hBsM: number,
  hUtM: number,
  area: HataArea,
): number {
  return checkedHata('cost231-hata', frequencyMHz, d2DM, hBsM, hUtM, area);
}

/**
 * A path-loss function of d2D for one setup, validated once (throws PathLossRefusalError). The
 * preview and the grid builder call it per pixel.
 */
export function makePathLoss(s: PathLossSetup): (d2DM: number) => number {
  const refusal = pathLossRefusal(s);
  if (refusal) throw new PathLossRefusalError(refusal);
  const { frequencyMHz: f, hBsM: hb, hUtM: hm } = s;
  const area = s.hataArea ?? HATA_AREA_OF_ENVIRONMENT[s.environment];
  switch (s.model) {
    case 'tr38901': {
      const fn = s.environment === 'uma' ? uma38901 : s.environment === 'umi' ? umi38901 : rma38901;
      return (d) => fn(f, d, hb, hm).expectedDb;
    }
    case 'okumura-hata':
      return (d) => hataKernel('okumura-hata', f, d, hb, hm, area);
    case 'cost231-hata':
      return (d) => hataKernel('cost231-hata', f, d, hb, hm, area);
    case 'free-space':
      return (d) => freeSpacePathLossDb(f, d3(Math.max(d, MIN_DISTANCE_2D_M), hb, hm));
  }
}

/** Path loss at one horizontal distance, dB. Throws PathLossRefusalError. */
export function pathLossDb(s: PathLossSetup, d2DM: number): number {
  return makePathLoss(s)(d2DM);
}
