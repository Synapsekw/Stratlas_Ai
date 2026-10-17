/**
 * Antenna patterns (spec D11). Every function returns or takes dB relative to the peak gain:
 * `...GainDb` is <= 0, `...LossDb` (attenuation) is its negation, >= 0.
 *
 * Angles come from the antenna frame (geometry.ts): azimuth off boresight, positive clockwise;
 * down-elevation below the boresight plane, positive down.
 *
 * - Parametric: 3GPP TR 38.901 Table 7.3-1, with the electrical tilt shifting the vertical cut:
 *     A_H = -min(12 (phi / phi3dB)^2, Am)
 *     A_V = -min(12 ((theta - 90 - etilt) / theta3dB)^2, SLAv)   (theta zenith = 90 + down-elevation)
 *     A   = -min(-(A_H + A_V), Am)
 *   Am is the front-to-back value; Am = SLAv = 30 dB by default.
 * - Two-cut (MSI / Planet): summing method, loss = min(H(phi) + V(down), cap), cap = front-to-back.
 *   The file already holds its electrical tilt, so none is applied here.
 */

import { normalizeDeg180, normalizeDeg360 } from './geometry';

export const DEFAULT_AM_DB = 30;
export const DEFAULT_SLAV_DB = 30;
export const DEFAULT_H_BEAMWIDTH_DEG = 65;

export interface ParametricPattern {
  kind: 'parametric';
  hBeamwidthDeg: number;
  vBeamwidthDeg: number;
  /** Electrical downtilt, degrees, positive down. */
  eTiltDeg: number;
  /** Maximum attenuation (front-to-back), dB. Default 30. */
  amDb?: number;
  /** Vertical side-lobe limit, dB. Default 30. */
  slavDb?: number;
}

export interface TwoCutPattern {
  kind: 'two-cut';
  /**
   * 360 attenuations (dB, >= 0, relative to the gain) at whole degrees 0..359 clockwise from
   * boresight, seen from above.
   */
  horizontalDb: readonly number[];
  /** 360 attenuations at whole degrees 0..359 below boresight: 0 forward at the horizon, 90 straight down, 270 straight up. */
  verticalDb: readonly number[];
  /** Cap on the summed loss (front-to-back), dB. */
  capDb: number;
}

export type AntennaPattern = ParametricPattern | TwoCutPattern;

export interface PortBeam {
  hBeamwidthDeg: number;
  vBeamwidthDeg: number;
  frontToBackDb: number;
}

/** The generic pattern for a catalogue port (or an AAU's SSB beam) at an electrical tilt. */
export function parametricFromPort(port: PortBeam, eTiltDeg: number): ParametricPattern {
  return {
    kind: 'parametric',
    hBeamwidthDeg: port.hBeamwidthDeg,
    vBeamwidthDeg: port.vBeamwidthDeg,
    eTiltDeg,
    amDb: port.frontToBackDb,
  };
}

/** 38.901 A_H, dB (<= 0). */
export function horizontalCutDb(
  azimuthDeg: number,
  hBeamwidthDeg: number,
  amDb = DEFAULT_AM_DB,
): number {
  const phi = normalizeDeg180(azimuthDeg);
  return -Math.min(12 * (phi / hBeamwidthDeg) ** 2, amDb) + 0;
}

/** 38.901 A_V around the electrical tilt, dB (<= 0). */
export function verticalCutDb(
  downElevationDeg: number,
  vBeamwidthDeg: number,
  eTiltDeg: number,
  slavDb = DEFAULT_SLAV_DB,
): number {
  return -Math.min(12 * ((downElevationDeg - eTiltDeg) / vBeamwidthDeg) ** 2, slavDb) + 0;
}

/** A = -min(-(A_H + A_V), cap), dB (<= 0). */
export function combineCutsDb(aHDb: number, aVDb: number, capDb: number): number {
  return -Math.min(-(aHDb + aVDb), capDb) + 0;
}

/** Validated two-cut pattern. */
export function makeTwoCutPattern(
  horizontalDb: readonly number[],
  verticalDb: readonly number[],
  capDb: number,
): TwoCutPattern {
  for (const [name, cut] of [
    ['horizontal', horizontalDb],
    ['vertical', verticalDb],
  ] as const) {
    if (cut.length !== 360)
      throw new Error(`The ${name} cut needs 360 values, one per degree (got ${cut.length})`);
    if (!cut.every(Number.isFinite))
      throw new Error(`The ${name} cut has a value that is not finite`);
  }
  if (!(capDb >= 0)) throw new Error('The front-to-back cap must be zero or more');
  return { kind: 'two-cut', horizontalDb, verticalDb, capDb };
}

/** Linear interpolation in a 360-value cut, wrapping 359 to 0. */
function cutAt(cut: readonly number[], angleDeg: number): number {
  const a = normalizeDeg360(angleDeg);
  const i0 = Math.floor(a);
  const t = a - i0;
  const v0 = cut[i0 % 360] ?? Number.NaN;
  const v1 = cut[(i0 + 1) % 360] ?? Number.NaN;
  return v0 + (v1 - v0) * t;
}

/** Pattern gain relative to the peak, dB (<= 0). */
export function patternGainDb(
  p: AntennaPattern,
  azimuthDeg: number,
  downElevationDeg: number,
): number {
  if (p.kind === 'two-cut') {
    const loss = cutAt(p.horizontalDb, azimuthDeg) + cutAt(p.verticalDb, downElevationDeg);
    return -Math.min(loss, p.capDb) + 0;
  }
  if (!(p.hBeamwidthDeg > 0) || !(p.vBeamwidthDeg > 0))
    throw new Error('Beamwidths must be positive');
  const am = p.amDb ?? DEFAULT_AM_DB;
  const aH = horizontalCutDb(azimuthDeg, p.hBeamwidthDeg, am);
  const aV = verticalCutDb(
    downElevationDeg,
    p.vBeamwidthDeg,
    p.eTiltDeg,
    p.slavDb ?? DEFAULT_SLAV_DB,
  );
  return combineCutsDb(aH, aV, am);
}

/** Pattern attenuation relative to the peak, dB (>= 0). */
export function patternLossDb(
  p: AntennaPattern,
  azimuthDeg: number,
  downElevationDeg: number,
): number {
  return -patternGainDb(p, azimuthDeg, downElevationDeg) + 0;
}
