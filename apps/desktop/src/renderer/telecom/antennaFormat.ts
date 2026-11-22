import type { AntennaUnit, AntennaValue } from '@aio/schema';
import { t } from '@aio/ui';

/** The chip tone of each review status, in the inventory and the card. */
export const TONE = { draft: 'warn', accepted: 'acc', rejected: 'off' } as const;

/** Grid azimuth to true azimuth, wrapped to 0..360. */
export function trueAzimuth(gridDeg: number, convergenceDeg: number): number {
  return (((gridDeg + convergenceDeg) % 360) + 360) % 360;
}

/**
 * The one way telecom writes its numbers, in the antenna list, the 3D labels, the Sectors group and
 * Coverage: an angle to one decimal ('123.4°', '+3.0°' when signed), a height to one decimal
 * ('12.3 m') and a size to two ('1.25 m'). `withUnit: false` leaves the unit to a column heading
 * ("Alt m"). -0 reads as 0.
 */
export function formatAngle(deg: number, signed = false): string {
  const v = fixed(deg, 1);
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

/** '123.4°', or '+3.0°' when signed: `formatAngle` under its older name. */
export const formatDeg = formatAngle;

/**
 * The azimuth as text: true first and grid second when the project has a CRS, else "Project
 * north". Null when the unit has no azimuth (other equipment).
 */
export function azimuthLines(
  unit: AntennaUnit,
): { primary: string; secondary: string | null } | null {
  const grid = unit.azimuthGridDeg;
  if (!grid) return null;
  if (unit.convergenceDeg === null)
    return {
      primary: t('telecom.antennas.north.project', { deg: formatDeg(grid.value) }),
      secondary: null,
    };
  return {
    primary: t('telecom.antennas.north.true', {
      deg: formatDeg(trueAzimuth(grid.value, unit.convergenceDeg)),
    }),
    secondary: t('telecom.antennas.north.grid', { deg: formatDeg(grid.value) }),
  };
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
