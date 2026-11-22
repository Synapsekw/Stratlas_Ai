import type { AntennaValue } from '@aio/schema';
import { t } from '@aio/ui';

/** The chip tone of each review status, in the antenna list and its details. */
export const TONE = { draft: 'warn', accepted: 'acc', rejected: 'off' } as const;

/** Grid azimuth to true azimuth, wrapped to 0..360. */
export function trueAzimuth(gridDeg: number, convergenceDeg: number): number {
  return (((gridDeg + convergenceDeg) % 360) + 360) % 360;
}

/**
 * The one way telecom writes its numbers, in the antenna list, the 3D labels, the Sectors group and
 * Coverage: an angle to one decimal ('123.4°', '+3.0°' when signed), a height to one decimal
 * ('12.3 m') and a size to two ('1.25 m'). `withUnit: false` leaves the unit to a column heading
 * ("Alt m"). -0 reads as 0, and an unsigned 360.0 (an azimuth just under north) reads 0.0.
 */
export function formatAngle(deg: number, signed = false): string {
  const f = fixed(deg, 1);
  // an azimuth that rounds up to a full turn reads 0, as it does in every view
  const v = !signed && Number(f) === 360 ? fixed(0, 1) : f;
  return `${signed && !v.startsWith('-') ? '+' : ''}${v}°`;
}

/** A height (a unit's centre altitude, a sector's height above ground): one decimal, metres. */
export function formatHeight(m: number, withUnit = true): string {
  const v = fixed(m, 1);
  return withUnit ? `${v} m` : v;
}

/** A size (width, height, depth, diameter): two decimals, metres. */
export function formatSize(m: number, withUnit = true): string {
  const v = fixed(m, 2);
  return withUnit ? `${v} m` : v;
}

/** `toFixed` without a minus on a value that rounds to zero. */
function fixed(v: number, dp: number): string {
  const s = v.toFixed(dp);
  return Number(s) === 0 ? (0).toFixed(dp) : s;
}

/** The fit quality of a value, else its note, else its basis. */
export function qualityTip(v: AntennaValue): string {
  const q = v.quality;
  if (q.residualM !== undefined && q.support !== undefined && q.coverage !== undefined)
    return t('telecom.antennas.quality', {
      residual: (q.residualM * 1000).toFixed(1),
      support: q.support,
      coverage: Math.round(q.coverage * 100),
    });
  return q.note ?? t(`telecom.antennas.basis.${v.basis}`);
}
