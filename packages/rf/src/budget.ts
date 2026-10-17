/**
 * Downlink link budget (spec D13):
 *   RSRP = P_port - 10 log10(12 N_RB) - L_feeder + G_ant + A(phi, theta) - PL - margins
 * with A <= 0 the pattern term (written here as minus the pattern loss). RSRP is per resource
 * element and per port, so MIMO layers do not raise it. For an AAU, the gain and pattern are the
 * SSB or broadcast beam's, never the peak traffic beam's.
 *
 * Field names follow the `RfStudy` schema in `@aio/schema` (marginPreset, bodyLossDb,
 * edgeProbability, shadowSigmaDb, thresholds) without depending on it.
 */

import { nRb, type Tech } from './bands';
import { directionToAntennaFrame, trueAzimuthDeg, type Enu } from './geometry';
import { patternLossDb, type AntennaPattern } from './pattern';

export type MarginPreset = 'outdoor' | 'in-car' | 'indoor' | 'deep-indoor';

/** Penetration margin per preset, dB. */
export const PENETRATION_MARGIN_DB: Readonly<Record<MarginPreset, number>> = {
  outdoor: 0,
  'in-car': 7,
  indoor: 15,
  'deep-indoor': 20,
};

export interface MarginSettings {
  marginPreset: MarginPreset;
  bodyLossDb: number;
  /** Cell-edge probability for the log-normal fade margin, in (0, 1). */
  edgeProbability: number;
  /** Log-normal shadowing standard deviation, dB. */
  shadowSigmaDb: number;
}

export const DEFAULT_MARGINS: Readonly<MarginSettings> = {
  marginPreset: 'outdoor',
  bodyLossDb: 3,
  edgeProbability: 0.9,
  shadowSigmaDb: 8,
};

/** Class floors, dBm: a value at or above a floor is in that class. */
export interface RsrpThresholds {
  excellentDbm: number;
  goodDbm: number;
  fairDbm: number;
  poorDbm: number;
}

export const DEFAULT_RSRP_THRESHOLDS: Readonly<RsrpThresholds> = {
  excellentDbm: -80,
  goodDbm: -95,
  fairDbm: -105,
  poorDbm: -115,
};

export type RsrpClass = 'excellent' | 'good' | 'fair' | 'poor' | 'none';

export interface Carrier {
  tech: Tech;
  bandwidthMHz: number;
  /** NR subcarrier spacing, kHz; ignored for LTE. */
  scsKHz?: number;
}

export function dbmFromWatts(watts: number): number {
  if (!(watts > 0)) throw new Error('Power must be more than 0 W');
  return 10 * Math.log10(watts) + 30;
}

export function wattsFromDbm(dbm: number): number {
  return 10 ** ((dbm - 30) / 10);
}

/** Subcarriers across the carrier: 12 N_RB. */
export function subcarrierCount(c: Carrier): number {
  return 12 * nRb(c.tech, c.bandwidthMHz, c.scsKHz);
}

/** 10 log10(12 N_RB): from total port power to power per resource element, dB. */
export function perReOffsetDb(c: Carrier): number {
  return 10 * Math.log10(subcarrierCount(c));
}

/** Peak EIRP of one port over the whole carrier, dBm. */
export function eirpDbm(
  portPowerDbm: number,
  feederLossDb: number,
  antennaGainDbi: number,
): number {
  return portPowerDbm - feederLossDb + antennaGainDbi;
}

/**
 * Standard normal quantile (P. J. Acklam's rational approximation, relative error below 1.2e-9).
 * Python's `statistics.NormalDist().inv_cdf` agrees far inside the 0.01 dB golden tolerance.
 */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error('Probability must be strictly between 0 and 1');
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const [a0, a1, a2, a3, a4, a5] = a as [number, number, number, number, number, number];
  const [b0, b1, b2, b3, b4] = b as [number, number, number, number, number];
  const [c0, c1, c2, c3, c4, c5] = c as [number, number, number, number, number, number];
  const [d0, d1, d2, d3] = d as [number, number, number, number];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    );
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  );
}

/** Log-normal fade margin z(p) sigma, dB (90 % gives 1.28 sigma). */
export function fadeMarginDb(edgeProbability: number, shadowSigmaDb: number): number {
  if (shadowSigmaDb === 0) return 0;
  return inverseNormalCdf(edgeProbability) * shadowSigmaDb;
}

export interface MarginBreakdown {
  penetrationDb: number;
  bodyLossDb: number;
  fadeDb: number;
  totalDb: number;
}

export function margins(m: MarginSettings): MarginBreakdown {
  const penetrationDb = PENETRATION_MARGIN_DB[m.marginPreset];
  const fadeDb = fadeMarginDb(m.edgeProbability, m.shadowSigmaDb);
  return {
    penetrationDb,
    bodyLossDb: m.bodyLossDb,
    fadeDb,
    totalDb: penetrationDb + m.bodyLossDb + fadeDb,
  };
}

export interface LinkBudgetInput {
  /** Configured power per port, dBm. */
  portPowerDbm: number;
  /** 12 N_RB. */
  subcarriers: number;
  feederLossDb: number;
  /** Peak antenna (or SSB beam) gain, dBi. */
  antennaGainDbi: number;
  /** Pattern attenuation, dB, >= 0. */
  patternLossDb: number;
  pathLossDb: number;
  /** Total margin, dB. */
  marginDb: number;
}

/** RSRP per resource element, dBm. */
export function rsrpDbm(i: LinkBudgetInput): number {
  return (
    i.portPowerDbm -
    10 * Math.log10(i.subcarriers) -
    i.feederLossDb +
    i.antennaGainDbi -
    i.patternLossDb -
    i.pathLossDb -
    i.marginDb
  );
}

export function rsrpClass(rsrp: number, t: RsrpThresholds = DEFAULT_RSRP_THRESHOLDS): RsrpClass {
  if (rsrp >= t.excellentDbm) return 'excellent';
  if (rsrp >= t.goodDbm) return 'good';
  if (rsrp >= t.fairDbm) return 'fair';
  if (rsrp >= t.poorDbm) return 'poor';
  return 'none';
}

export interface PointInput {
  /** Offset from the antenna to the point in the project CRS (grid east, grid north, up), metres. */
  directionGrid: Enu;
  azimuthGridDeg: number;
  convergenceDeg: number | null;
  mechanicalDowntiltDeg: number;
  /** A parametric pattern carries the electrical tilt; a two-cut pattern holds it already. */
  pattern: AntennaPattern;
  portPowerDbm: number;
  carrier: Carrier;
  feederLossDb: number;
  antennaGainDbi: number;
  pathLossDb: number;
  margins: MarginSettings;
  thresholds?: RsrpThresholds;
}

export interface PointResult {
  trueAzimuthDeg: number;
  antennaAzimuthDeg: number;
  antennaDownElevationDeg: number;
  attenuationDb: number;
  perReOffsetDb: number;
  marginDb: number;
  rsrpDbm: number;
  rsrpClass: RsrpClass;
}

/** One point through geometry, pattern and budget; the reference path the golden vectors check. */
export function evaluatePoint(i: PointInput): PointResult {
  const a = directionToAntennaFrame(i.directionGrid, {
    azimuthGridDeg: i.azimuthGridDeg,
    convergenceDeg: i.convergenceDeg,
    mechanicalDowntiltDeg: i.mechanicalDowntiltDeg,
  });
  const attenuationDb = patternLossDb(i.pattern, a.azimuthDeg, a.downElevationDeg);
  const subcarriers = subcarrierCount(i.carrier);
  const marginDb = margins(i.margins).totalDb;
  const rsrp = rsrpDbm({
    portPowerDbm: i.portPowerDbm,
    subcarriers,
    feederLossDb: i.feederLossDb,
    antennaGainDbi: i.antennaGainDbi,
    patternLossDb: attenuationDb,
    pathLossDb: i.pathLossDb,
    marginDb,
  });
  return {
    trueAzimuthDeg: trueAzimuthDeg(i.azimuthGridDeg, i.convergenceDeg),
    antennaAzimuthDeg: a.azimuthDeg,
    antennaDownElevationDeg: a.downElevationDeg,
    attenuationDb,
    perReOffsetDb: 10 * Math.log10(subcarriers),
    marginDb,
    rsrpDbm: rsrp,
    rsrpClass: rsrpClass(rsrp, i.thresholds),
  };
}
