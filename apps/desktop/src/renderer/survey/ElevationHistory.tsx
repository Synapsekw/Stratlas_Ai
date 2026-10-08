/**
 * Elevation history (M11 G8, PRD SRV-12): a point's height on every survey that has a prepared
 * surface, oldest first, as a small chart and a table. The heights are read from the prepared
 * height tiles with the survey engine's own sampler (`@aio/survey` `bilinear`), so they match
 * the comparisons; a survey with no data at the point shows a gap.
 */
import type { HeightTiles } from '@aio/schema';
import { bilinear, TileSurface } from '@aio/survey';
import { formatDate, Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { useMeasure } from './measureStore';
import { openQaPanel, surfaceOfCapture, useQa } from './qaStore';

export interface HistoryRow {
  capture: string;
  label: string;
  date: string;
  surface: string;
  height: number | null;
}

/** Bytes of a project file through the app's protocol, or null when it is missing. */
async function fetchBytes(projectId: string, path: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(`aio://project/${encodeURIComponent(projectId)}/${path}`);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** The height of one prepared surface at (E, N); null where it has no data. */
export async function heightAt(
  s: HeightTiles,
  e: number,
  n: number,
  fetchTile: (col: number, row: number) => Promise<Uint8Array | null>,
): Promise<number | null> {
  const g = new TileSurface(s.id, s, fetchTile);
  const z = (
    await bilinear(g, new Float64Array([e - s.originE]), new Float64Array([n - s.originN]), 0, 0)
  )[0];
  return z !== undefined && Number.isFinite(z) ? z : null;
}

export function ElevationHistory() {
  const project = useWorkspace((s) => s.project);
  const surfaces = useQa((s) => s.surfaces);
  const point = useMeasure((s) => {
    const m = s.file.measurements.find((x) => x.id === s.focus);
    return m?.family === 'point' ? m.points[0] : undefined;
  });
  const [e, setE] = useState('');
  const [n, setN] = useState('');
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const captures = useMemo(
    () => [...(project?.manifest.captures ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [project],
  );

  if (!project) return null;
  const pid = project.id;
  const E = Number(e);
  const N = Number(n);
  const valid = e.trim() !== '' && n.trim() !== '' && Number.isFinite(E) && Number.isFinite(N);

  const show = async () => {
    setBusy(true);
    const out: HistoryRow[] = [];
    for (const c of captures) {
      const s = surfaceOfCapture(surfaces, c.id);
      if (!s) continue;
      const height = await heightAt(s, E, N, (col, row) =>
        fetchBytes(pid, `survey/surfaces/${s.id}/0/${String(col)}_${String(row)}.bin`),
      );
      out.push({ capture: c.id, label: c.label, date: c.date, surface: s.id, height });
    }
    setRows(out);
    setBusy(false);
  };

  return (
    <section
      className="sv-card qa-card"
      aria-label="Elevation history"
      data-testid="elevation-history"
    >
      <div className="sv-head">
        <h2>Elevation history</h2>
        <button
          type="button"
          className="btn sm ghost"
          aria-label="Close"
          onClick={() => {
            openQaPanel(null);
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="sv-row">
        <input
          className="sv-input qa-grow"
          inputMode="decimal"
          placeholder="Easting"
          aria-label="Easting"
          value={e}
          data-testid="history-e"
          onChange={(ev) => {
            setE(ev.target.value);
          }}
        />
        <input
          className="sv-input qa-grow"
          inputMode="decimal"
          placeholder="Northing"
          aria-label="Northing"
          value={n}
          data-testid="history-n"
          onChange={(ev) => {
            setN(ev.target.value);
          }}
        />
      </div>
      <div className="sv-row sv-wrap">
        <button
          type="button"
          className="btn sm"
          disabled={!point}
          title={point ? undefined : 'Select a point measurement first'}
          onClick={() => {
            if (!point) return;
            setE(point[0].toFixed(3));
            setN(point[1].toFixed(3));
          }}
        >
          Use the selected point
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={!valid || busy}
          data-testid="history-show"
          onClick={() => {
            void show();
          }}
        >
          {busy ? 'Reading the surfaces' : 'Show the history'}
        </button>
      </div>
      {surfaces.length === 0 && (
        <p className="faint small">No survey has a prepared surface yet.</p>
      )}
      {rows && <HistoryChart rows={rows} />}
    </section>
  );
}

function HistoryChart({ rows }: { rows: HistoryRow[] }) {
  const have = rows.filter((r): r is HistoryRow & { height: number } => r.height !== null);
  if (have.length === 0)
    return <p className="faint small">No survey has a height at this point.</p>;
  const lo = Math.min(...have.map((r) => r.height));
  const hi = Math.max(...have.map((r) => r.height));
  const span = Math.max(hi - lo, 0.01);
  const w = 300;
  const h = 90;
  const x = (k: number) => (rows.length === 1 ? w / 2 : 12 + (k * (w - 24)) / (rows.length - 1));
  const y = (z: number) => 8 + (1 - (z - lo) / span) * (h - 16);
  const pts = rows
    .map((r, k) => (r.height === null ? null : `${x(k).toFixed(1)},${y(r.height).toFixed(1)}`))
    .filter((p): p is string => p !== null);
  return (
    <>
      <figure className="qa-hist" aria-label="Height on each survey" data-testid="history-chart">
        <svg
          viewBox={`0 0 ${String(w)} ${String(h)}`}
          role="img"
          aria-label="Height on each survey"
        >
          <polyline points={pts.join(' ')} className="qa-line" />
          {rows.map((r, k) =>
            r.height === null ? null : (
              <circle key={r.capture} cx={x(k)} cy={y(r.height)} r={3} className="qa-dot">
                <title>{`${r.label}: ${r.height.toFixed(3)} m`}</title>
              </circle>
            ),
          )}
        </svg>
      </figure>
      <table className="qa-table" data-testid="history-table">
        <thead>
          <tr>
            <th scope="col">Survey</th>
            <th scope="col">Height</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => {
            const prev = rows
              .slice(0, k)
              .reverse()
              .find((p) => p.height !== null);
            const d =
              r.height !== null && prev && prev.height !== null ? r.height - prev.height : null;
            return (
              <tr key={r.capture}>
                <td>
                  {r.label} <span className="faint">{formatDate(r.date)}</span>
                </td>
                <td className="mono">
                  {r.height === null ? 'no data' : `${r.height.toFixed(3)} m`}
                </td>
                <td className="mono">
                  {d === null ? '' : `${d >= 0 ? '+' : ''}${d.toFixed(3)} m`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
