/**
 * The accuracy report view (G4): what the accuracy rests on, RMSE by role against the plan's
 * targets, every point's residuals, camera residuals to GNSS, warnings and an overlap map drawn
 * from the photo footprints. **Save as CSV** writes the residuals table for the survey file.
 */
import type { AccuracyReport, PhotoRun } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { bridge } from '../shell';
import { formatResidual, headline, pointRows, rmseRows } from './report';

/** The residuals as CSV (metres), every point, in the report's order. */
export function reportCsv(r: AccuracyReport): string {
  const rows = [
    'point,role,dx_m,dy_m,dz_m,horizontal_m,reprojection_px,marks',
    ...r.points.map((p) =>
      [
        p.id,
        p.role,
        p.dxM.toFixed(4),
        p.dyM.toFixed(4),
        p.dzM.toFixed(4),
        Math.hypot(p.dxM, p.dyM).toFixed(4),
        p.reprojPx.toFixed(3),
        String(p.marks),
      ].join(','),
    ),
  ];
  return `${rows.join('\n')}\n`;
}

export function AccuracyReportView({
  run,
  report,
}: {
  run: PhotoRun | null;
  report: AccuracyReport | null;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  if (!report)
    return (
      <p className="small faint" data-testid="accuracy-empty">
        The accuracy report appears when the alignment has finished.
      </p>
    );
  const rows = pointRows(report);
  const rmse = rmseRows(report);
  return (
    <div className="ph-report" data-testid="accuracy-report">
      <p className="ph-headline" data-testid="accuracy-headline">
        {headline(report)}
      </p>
      <p className="small faint">
        Mean reprojection error {report.meanReprojPx.toFixed(2)} px
        {report.gsdCm ? ` · ground sample distance ${report.gsdCm.toFixed(1)} cm` : ''}. Checkpoints
        are measured only; they never enter the adjustment.
      </p>
      {rmse.length > 0 && (
        <table className="ph-table" data-testid="accuracy-rmse">
          <caption className="sr-only">RMSE by role</caption>
          <thead>
            <tr>
              <th scope="col">Points</th>
              <th scope="col">n</th>
              <th scope="col">RMSE horizontal</th>
              <th scope="col">RMSE vertical</th>
              <th scope="col">Target</th>
            </tr>
          </thead>
          <tbody>
            {rmse.map((r) => (
              <tr key={r.role} data-role={r.role}>
                <th scope="row">{r.label}</th>
                <td>{r.n}</td>
                <td className="mono">{r.horizontal}</td>
                <td className="mono">{r.vertical}</td>
                <td>
                  {r.verdict === 'within'
                    ? 'Within'
                    : r.verdict === 'over'
                      ? 'Over the target'
                      : 'No target'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.warnings.length > 0 && (
        <ul className="ph-warn small" aria-label="Warnings" data-testid="accuracy-warnings">
          {report.warnings.map((w, i) => (
            <li key={`${w.code}-${String(i)}`}>
              <Icon name="warn" size={12} /> {w.message}
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <table className="ph-table" data-testid="accuracy-points">
          <caption className="sr-only">Residuals per point</caption>
          <thead>
            <tr>
              <th scope="col">Point</th>
              <th scope="col">Role</th>
              <th scope="col">dx</th>
              <th scope="col">dy</th>
              <th scope="col">dz</th>
              <th scope="col">Horizontal</th>
              <th scope="col">Reprojection</th>
              <th scope="col">Marks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.flagged ? 'flag' : ''} data-point={r.id}>
                <th scope="row" className="mono">
                  {r.flagged && <Icon name="warn" size={12} />} {r.id}
                </th>
                <td>{r.role === 'check' ? 'Check' : 'Control'}</td>
                <td className="mono">{r.dx}</td>
                <td className="mono">{r.dy}</td>
                <td className="mono">{r.dz}</td>
                <td className="mono">{r.horizontal}</td>
                <td className="mono">{r.reproj}</td>
                <td>{r.marks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.cameraResiduals && (
        <p className="small">
          Camera positions against their GNSS: median{' '}
          {formatResidual(report.cameraResiduals.medianM)}, largest{' '}
          {formatResidual(report.cameraResiduals.maxM)}; RMSE{' '}
          {formatResidual(report.cameraResiduals.rmseHorizontalM)} horizontal,{' '}
          {formatResidual(report.cameraResiduals.rmseVerticalM)} vertical.
        </p>
      )}
      {run && <OverlapMap run={run} />}
      <div className="ph-acts">
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            void bridge
              .call('dialog:saveFile', {
                defaultName: `accuracy-${report.run}.csv`,
                data: reportCsv(report),
                title: 'Save the residuals as CSV',
              })
              .then((r) => {
                setSaved(r.ok && r.value.path ? `Saved to ${r.value.path}` : r.ok ? null : r.error);
              });
          }}
        >
          <Icon name="download" size={14} />
          Save as CSV
        </button>
        {saved && (
          <span className="small faint" role="status">
            {saved}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Where the photos overlap: each photo's ground footprint (from its height and lens) drawn faintly,
 * so the colour deepens where more photos see the ground. Thin areas at the edges are normal.
 */
function OverlapMap({ run }: { run: PhotoRun }) {
  const project = useWorkspace((s) => s.project);
  const shapes = useMemo(() => {
    if (!project || !('layer' in run.photos.source)) return null;
    const id = run.photos.source.layer;
    const layer = project.manifest.layers.find((l) => l.id === id);
    if (layer?.kind !== 'photos') return null;
    const feet: { x: number; z: number; r: number }[] = [];
    for (const it of layer.items) {
      if (!it.pos) continue;
      const hfov = it.lens?.hfovDeg ?? 70;
      const r = Math.max(1, it.pos[1]) * Math.tan((hfov * Math.PI) / 360);
      feet.push({ x: it.pos[0], z: it.pos[2], r });
    }
    if (!feet.length) return null;
    const minX = Math.min(...feet.map((f) => f.x - f.r));
    const maxX = Math.max(...feet.map((f) => f.x + f.r));
    const minZ = Math.min(...feet.map((f) => f.z - f.r));
    const maxZ = Math.max(...feet.map((f) => f.z + f.r));
    return { feet, box: [minX, minZ, maxX - minX, maxZ - minZ] as const };
  }, [project, run]);
  if (!shapes) return null;
  const [x, z, w, h] = shapes.box;
  return (
    <figure className="ph-overlap">
      <svg
        viewBox={`${String(x)} ${String(z)} ${String(w)} ${String(h)}`}
        role="img"
        aria-label={`Overlap map: footprints of ${String(shapes.feet.length)} photos`}
        data-testid="overlap-map"
      >
        {shapes.feet.map((f, i) => (
          <circle key={i} cx={f.x} cy={f.z} r={f.r} />
        ))}
      </svg>
      <figcaption className="small faint">
        Overlap: darker where more photos see the ground (north up).
      </figcaption>
    </figure>
  );
}
