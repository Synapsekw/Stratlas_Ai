// The photogrammetry accuracy of a processing run (M10), as the house report's `processing`
// section and the run's accuracy report PDF print it. Pure and renderer safe; wording lives in the
// report page (i18n). Honest by construction: every point is listed, checkpoints are measured and
// never adjusted, and nothing is rounded to zero here.
import type { AccuracyReport, GcpRole, PhotoRun, ProjectManifest } from '@aio/schema';

type RoleRmse = NonNullable<AccuracyReport['rmse']['check']>;

/** Plan targets for checkpoints, in ground sample distances: horizontal 1.5, vertical 2.5. */
export const CHECK_TARGET_GSD = { horizontal: 1.5, vertical: 2.5 } as const;

export interface ProcessingRmseRow {
  role: GcpRole;
  n: number;
  horizontalM: number;
  verticalM: number;
  /** Checkpoints against the targets when the GSD is known; null otherwise (control, no GSD). */
  verdict: 'within' | 'over' | null;
  /** The targets in metres, when the GSD is known (checkpoints only). */
  targetHorizontalM: number | null;
  targetVerticalM: number | null;
}

export interface ProcessingPointRow {
  id: string;
  role: GcpRole;
  dxM: number;
  dyM: number;
  dzM: number;
  horizontalM: number;
  reprojPx: number;
  marks: number;
  /** Named by a warning (an outlier, too few marks). */
  flagged: boolean;
  /** Constrained the adjustment (a control point not left out); null when the report predates it. */
  usedInAdjustment: boolean | null;
}

/** A photo's ground footprint for the overlap map: local x (east), z (south) and radius, metres. */
export interface Footprint {
  x: number;
  z: number;
  r: number;
}

export interface ProcessingSummary {
  run: string;
  /** When the report was written (ISO). */
  createdAt: string;
  preset: string | null;
  /** What the accuracy rests on: checkpoints, control only, or the drone's GNSS only. */
  basis: 'check' | 'control' | 'gnss';
  images: { total: number; registered: number };
  meanReprojPx: number;
  gsdCm: number | null;
  rmse: ProcessingRmseRow[];
  points: ProcessingPointRow[];
  cameraResiduals: AccuracyReport['cameraResiduals'] | null;
  warnings: string[];
  /** Photo footprints of the run's photos layer (empty for a folder run). */
  footprints: Footprint[];
}

/** Rows in the report's order: control points first, then checkpoints, by id (GCP2 before GCP10). */
function pointRows(r: AccuracyReport): ProcessingPointRow[] {
  const flagged = new Set(r.warnings.map((w) => w.point).filter((p): p is string => !!p));
  return r.points
    .map((p) => ({
      id: p.id,
      role: p.role,
      dxM: p.dxM,
      dyM: p.dyM,
      dzM: p.dzM,
      horizontalM: Math.hypot(p.dxM, p.dyM),
      reprojPx: p.reprojPx,
      marks: p.marks,
      flagged: flagged.has(p.id),
      usedInAdjustment: p.usedInAdjustment ?? null,
    }))
    .sort((a, b) =>
      a.role === b.role
        ? a.id.localeCompare(b.id, undefined, { numeric: true })
        : a.role === 'control'
          ? -1
          : 1,
    );
}

function rmseRows(r: AccuracyReport): ProcessingRmseRow[] {
  const gsdM = r.gsdCm ? r.gsdCm / 100 : null;
  const out: ProcessingRmseRow[] = [];
  for (const role of ['control', 'check'] as const) {
    const x: RoleRmse | undefined = r.rmse[role];
    if (!x) continue;
    const th = role === 'check' && gsdM ? CHECK_TARGET_GSD.horizontal * gsdM : null;
    const tv = role === 'check' && gsdM ? CHECK_TARGET_GSD.vertical * gsdM : null;
    out.push({
      role,
      n: x.n,
      horizontalM: x.horizontalM,
      verticalM: x.verticalM,
      verdict:
        th !== null && tv !== null
          ? x.horizontalM <= th && x.verticalM <= tv
            ? 'within'
            : 'over'
          : null,
      targetHorizontalM: th,
      targetVerticalM: tv,
    });
  }
  return out;
}

/** Footprints of the run's photos layer: each photo's ground circle from its height and lens. */
export function runFootprints(run: PhotoRun | null, manifest: ProjectManifest | null): Footprint[] {
  if (!run || !manifest || !('layer' in run.photos.source)) return [];
  const id = run.photos.source.layer;
  const layer = manifest.layers.find((l) => l.id === id);
  if (layer?.kind !== 'photos') return [];
  const out: Footprint[] = [];
  for (const it of layer.items) {
    if (!it.pos) continue;
    const hfov = it.lens?.hfovDeg ?? 70;
    out.push({
      x: it.pos[0],
      z: it.pos[2],
      r: Math.max(1, it.pos[1]) * Math.tan((Math.min(hfov, 170) * Math.PI) / 360),
    });
  }
  return out;
}

/** The accuracy of a run as the report prints it. */
export function processingSummary(
  report: AccuracyReport,
  run: PhotoRun | null = null,
  manifest: ProjectManifest | null = null,
): ProcessingSummary {
  const check = report.rmse.check;
  const control = report.rmse.control;
  return {
    run: report.run,
    createdAt: report.createdAt,
    preset: run?.preset ?? null,
    basis: check && check.n > 0 ? 'check' : control && control.n > 0 ? 'control' : 'gnss',
    images: { total: report.images.total, registered: report.images.registered },
    meanReprojPx: report.meanReprojPx,
    gsdCm: report.gsdCm ?? null,
    rmse: rmseRows(report),
    points: pointRows(report),
    cameraResiduals: report.cameraResiduals ?? null,
    warnings: report.warnings.map((w) => w.message),
    footprints: runFootprints(run, manifest),
  };
}
