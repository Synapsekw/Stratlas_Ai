/**
 * The accuracy report as tables (G4): one row per control and check point, RMSE by role, camera
 * residuals and warnings. Honest by construction: every point is listed, checkpoints are measured
 * and never adjusted, and nothing is rounded to zero.
 */
import { CHECK_TARGET_GSD } from '@aio/project/export';
import type { AccuracyReport, GcpRole } from '@aio/schema';

export interface PointRow {
  id: string;
  role: GcpRole;
  dx: string;
  dy: string;
  dz: string;
  /** Horizontal residual, metres (for sorting and flags). */
  horizontalM: number;
  horizontal: string;
  reproj: string;
  marks: number;
  /** A point named by a warning (an outlier, too few marks). */
  flagged: boolean;
}

/** Centimetres with one decimal below a metre, metres above: "1.4 cm", "-0.8 cm", "1.02 m". */
export function formatResidual(m: number): string {
  if (!Number.isFinite(m)) return 'not known';
  const a = Math.abs(m);
  if (a >= 1) return `${m.toFixed(2)} m`;
  const cm = m * 100;
  // never "-0.0 cm": a residual that rounds to zero is shown unsigned
  const t = cm.toFixed(1);
  return `${t === '-0.0' ? '0.0' : t} cm`;
}

export function pointRows(r: AccuracyReport): PointRow[] {
  const flagged = new Set(r.warnings.map((w) => w.point).filter((p): p is string => !!p));
  return r.points
    .map((p) => {
      const h = Math.hypot(p.dxM, p.dyM);
      return {
        id: p.id,
        role: p.role,
        dx: formatResidual(p.dxM),
        dy: formatResidual(p.dyM),
        dz: formatResidual(p.dzM),
        horizontalM: h,
        horizontal: formatResidual(h),
        reproj: `${p.reprojPx.toFixed(2)} px`,
        marks: p.marks,
        flagged: flagged.has(p.id),
      };
    })
    .sort((a, b) =>
      a.role === b.role
        ? a.id.localeCompare(b.id, undefined, { numeric: true })
        : a.role === 'control'
          ? -1
          : 1,
    );
}

export interface RmseRow {
  role: GcpRole;
  label: string;
  n: number;
  horizontal: string;
  vertical: string;
  /** Against the plan's targets in ground sample distances, when the GSD is known. */
  verdict: 'within' | 'over' | null;
}

export function rmseRows(r: AccuracyReport): RmseRow[] {
  const out: RmseRow[] = [];
  const gsdM = r.gsdCm ? r.gsdCm / 100 : null;
  for (const role of ['control', 'check'] as const) {
    const x = r.rmse[role];
    if (!x) continue;
    const verdict =
      role === 'check' && gsdM
        ? x.horizontalM <= CHECK_TARGET_GSD.horizontal * gsdM &&
          x.verticalM <= CHECK_TARGET_GSD.vertical * gsdM
          ? 'within'
          : 'over'
        : null;
    out.push({
      role,
      label:
        role === 'control' ? 'Control points (in the adjustment)' : 'Checkpoints (measured only)',
      n: x.n,
      horizontal: formatResidual(x.horizontalM),
      vertical: formatResidual(x.verticalM),
      verdict,
    });
  }
  return out;
}

/** The line at the top of the report: what the accuracy rests on. */
export function headline(r: AccuracyReport): string {
  const check = r.rmse.check;
  const control = r.rmse.control;
  const imgs = `${String(r.images.registered)} of ${String(r.images.total)} photos aligned`;
  if (check && check.n > 0)
    return `Checkpoint RMSE ${formatResidual(check.horizontalM)} horizontal, ${formatResidual(check.verticalM)} vertical over ${String(check.n)} ${check.n === 1 ? 'point' : 'points'}; ${imgs}.`;
  if (control && control.n > 0)
    return `No checkpoints: the control RMSE (${formatResidual(control.horizontalM)} horizontal) shows how well the model fits its own control, not its accuracy; ${imgs}.`;
  return `GNSS only, no ground control: the absolute accuracy is that of the drone's GNSS; ${imgs}.`;
}
