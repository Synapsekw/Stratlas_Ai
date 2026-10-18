import type { AntennaUnit, AntennaValue } from '@aio/schema';
import { t } from '@aio/ui';

/** The chip tone of each review status, in the inventory and the card. */
export const TONE = { draft: 'warn', accepted: 'acc', rejected: 'off' } as const;

/** Grid azimuth to true azimuth, wrapped to 0..360. */
export function trueAzimuth(gridDeg: number, convergenceDeg: number): number {
  return (((gridDeg + convergenceDeg) % 360) + 360) % 360;
}

/** '123.4°', or '+3.0°' when signed. */
export function formatDeg(v: number, signed = false): string {
  return `${signed && v >= 0 ? '+' : ''}${v.toFixed(1)}°`;
}

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
