/**
 * Whole-site cut and fill (M11 G4): any two surfaces compared over their overlap by the pipeline
 * (`survey.compare` in site mode, a job: the difference grid, its heat map pyramid and contours),
 * its totals and heat map, and draft cut and fill regions (Propeller's volume breakdown without a
 * model) that a person ticks and accepts as polygon measurements. A draft is only a suggestion:
 * the accepted measurement computes its own exact volumes.
 */
import { formatQuantity } from '@aio/geo';
import { ComparisonResult, type SurfaceRef, type SurveyMeasurement } from '@aio/schema';
import { deadbandFromStops, draftRegions, sideKey, sideOptions, TOOL_LABELS } from '@aio/survey';
import { Icon, useFocusTrap } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { authorName } from '../author';
import { bridge } from '../shell';
import {
  compareStore,
  engineClient,
  openCompareDialog,
  patchSite,
  setSite,
  useCompare,
  type SiteTiles,
} from './compareStore';
import { addMeasurement, measureStore, newMeasurementId, useMeasure } from './measureStore';

const MAX_SITE_CELLS = 1_000_000;

/** A new output folder for a whole-site job. */
function siteOut(): string {
  return `survey/compare/site-${Date.now().toString(36)}`;
}

async function readJson(projectId: string, path: string): Promise<unknown> {
  const r = await fetch(assetUrl(projectId, { path }));
  if (!r.ok) throw new Error(`${path} could not be read (${String(r.status)}).`);
  return (await r.json()) as unknown;
}

export function WholeSite() {
  const project = useWorkspace((s) => s.project);
  const settings = useMeasure((s) => s.settings);
  const readOnly = useMeasure((s) => s.readOnly);
  const surfaces = useCompare((s) => s.surfaces);
  const designs = useCompare((s) => s.designs);
  const captures = useCompare((s) => s.captures);
  const root = useCompare((s) => s.root);
  const site = useCompare((s) => s.site);
  const options = useMemo(
    () => sideOptions({ surfaces, captures, designs }).filter((o) => o.group !== 'Bases'),
    [surfaces, captures, designs],
  );
  const [from, setFrom] = useState<SurfaceRef>(site?.from ?? { kind: 'previous' });
  const [to, setTo] = useState<SurfaceRef>(site?.to ?? { kind: 'current' });
  const stopsDb = deadbandFromStops(settings.heatmap.stops);
  const [useDb, setUseDb] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    openCompareDialog(null);
  };
  useFocusTrap(ref, true, { onEscape: close });
  const units = settings.units;
  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision);
  const a = (x: number) => formatQuantity(x, 'area', units, settings.precision);
  const projectId = project?.id ?? null;

  const findRegions = async () => {
    const s = compareStore.getState().site;
    if (!s) return;
    const bounds = surfaces.map((x) => x.bounds);
    const span = bounds.length ? Math.max(...bounds.map((b) => (b[3] - b[0]) * (b[4] - b[1]))) : 0;
    const finest = Math.min(...surfaces.map((x) => x.cellM), 1);
    const cellM = Math.max(finest, Math.sqrt(span / MAX_SITE_CELLS));
    try {
      const r = await engineClient().site({ from: s.from, to: s.to, cellM }, 'whole-site');
      const g = r.grid;
      const drafts = g
        ? draftRegions(
            { dz: g.dz, nx: g.nx, ny: g.ny, x0: g.x0, y0: g.y0, cellM: g.cellM },
            {
              minDepthM: s.deadbandM ?? (stopsDb > 0 ? stopsDb : 0.1),
              minAreaM2: Math.max(4 * g.cellM * g.cellM, 4),
              max: 30,
            },
          )
        : [];
      patchSite({ drafts });
      setPicked(new Set());
    } catch (err) {
      patchSite({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  // follow the job; at its end read the result and the heat map index, then find the regions
  const job = site?.job ?? null;
  useEffect(() => {
    const aio = window.aio as typeof window.aio | undefined;
    if (!job || !aio || !projectId) return;
    return aio.on('jobs:event', (e) => {
      if (e.type !== 'update' || e.job.id !== job) return;
      patchSite({ progress: e.job.progress });
      if (e.job.status === 'failed' || e.job.status === 'cancelled') {
        patchSite({ job: null, error: e.job.error ?? 'The whole-site comparison stopped.' });
        return;
      }
      if (e.job.status !== 'done') return;
      void (async () => {
        const out = compareStore.getState().site?.out ?? '';
        try {
          const res = (await readJson(projectId, `${out}/result.json`)) as { result: unknown };
          const result = ComparisonResult.parse(res.result);
          let tiles: SiteTiles | null = null;
          try {
            tiles = (await readJson(projectId, `${out}/heat/tiles.json`)) as SiteTiles;
          } catch {
            // a refused comparison writes no heat map
          }
          patchSite({ job: null, result, tiles, progress: 1 });
          await findRegions();
        } catch (err) {
          patchSite({ job: null, error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, projectId]);

  const run = async () => {
    setError(null);
    if (!root) return;
    const out = siteOut();
    const deadbandM = useDb && stopsDb > 0 ? stopsDb : null;
    const r = await bridge.call('jobs:start', {
      pipeline: 'survey.compare',
      project: root,
      params: {
        site: { from, to, ...(deadbandM !== null ? { deadbandM } : {}) },
        out,
      },
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.ok) {
      setError(r.value.error);
      return;
    }
    setSite({
      job: r.value.job.id,
      progress: 0,
      out,
      from,
      to,
      deadbandM,
      result: null,
      tiles: null,
      drafts: [],
      error: null,
    });
  };

  const accept = () => {
    if (!site) return;
    const now = new Date().toISOString();
    const by = authorName();
    const surface = measureStore.getState().surface;
    const height = (e: number, n: number) => surface?.heightAt(e, n) ?? 0;
    let n = 0;
    for (const k of [...picked].sort((x, y) => x - y)) {
      const d = site.drafts[k];
      if (!d) continue;
      n++;
      const m: SurveyMeasurement = {
        id: newMeasurementId(),
        family: 'polygon',
        tool: 'volume',
        label: `${d.kind === 'cut' ? 'Cut' : 'Fill'} region ${String(k + 1)}`,
        folder: 'Whole-site regions',
        scope: { kind: 'site' },
        points: d.ring.map(([e, nn]) => [e, nn, height(e, nn)]),
        items: [
          {
            id: `c${String(k + 1)}`,
            label: 'Whole-site change',
            from: site.from,
            to: site.to,
            useDeadband: site.deadbandM !== null,
            ...(site.deadbandM !== null ? { deadbandM: site.deadbandM } : {}),
          },
        ],
        results: [],
        createdAt: now,
        ...(by ? { createdBy: by } : {}),
      };
      addMeasurement(m);
    }
    if (n > 0) {
      patchSite({ drafts: site.drafts.filter((_, k) => !picked.has(k)) });
      setPicked(new Set());
    }
  };

  const pick = (label: string, value: SurfaceRef, set: (r: SurfaceRef) => void) => (
    <label className="sv-field">
      <span>{label}</span>
      <select
        className="sv-input"
        value={sideKey(value)}
        data-testid={`survey-site-${label.toLowerCase()}`}
        onChange={(e) => {
          const o = options.find((x) => x.key === e.target.value);
          if (o) set(o.ref);
        }}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.note ? `${o.label} (${o.note})` : o.label}
          </option>
        ))}
      </select>
    </label>
  );

  const res = site?.result ?? null;
  return (
    <div
      ref={ref}
      className="sv-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sv-site-title"
      data-testid="survey-site"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="sv-dialog">
        <header className="sv-head" role="none">
          <h2 id="sv-site-title">Whole site cut and fill</h2>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <p className="small faint">
          Compares two surfaces over their overlap in a background job, then suggests cut and fill
          regions you can keep as measurements.
        </p>
        {surfaces.length === 0 && (
          <p className="notice warn small">Prepare the survey surfaces first (in a comparison).</p>
        )}
        <div className="sv-row sv-wrap">
          {pick('From', from, setFrom)}
          {pick('To', to, setTo)}
        </div>
        <label className="sv-check">
          <input
            type="checkbox"
            checked={useDb}
            disabled={stopsDb <= 0}
            onChange={(e) => {
              setUseDb(e.target.checked);
            }}
          />
          Use deadband in calculations (
          {formatQuantity(stopsDb, 'distance', units, settings.precision)} from the heat map stops)
        </label>
        <div className="sv-row">
          <button
            type="button"
            className="btn sm primary"
            disabled={readOnly || surfaces.length === 0 || job !== null}
            data-testid="survey-site-run"
            onClick={() => {
              void run();
            }}
          >
            {job ? `Comparing… ${String(Math.round((site?.progress ?? 0) * 100))}%` : 'Compare'}
          </button>
        </div>
        {(error ?? site?.error) && (
          <p className="notice danger small" role="alert">
            {error ?? site?.error}
          </p>
        )}
        {res && (
          <table className="sv-readout" data-testid="survey-site-result">
            <caption className="sr-only">Whole-site result</caption>
            <tbody>
              <tr>
                <th scope="row">Cut</th>
                <td className="mono">{v(res.cutM3)}</td>
                <td className="mono faint">{a(res.areaCutM2)}</td>
              </tr>
              <tr>
                <th scope="row">Fill</th>
                <td className="mono">{v(res.fillM3)}</td>
                <td className="mono faint">{a(res.areaFillM2)}</td>
              </tr>
              <tr>
                <th scope="row">Net</th>
                <td className="mono">{v(res.netM3)}</td>
                <td />
              </tr>
              <tr>
                <th scope="row">Total</th>
                <td className="mono">{v(res.totalM3)}</td>
                <td className="mono faint">{a(res.areaM2)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {res?.status === 'partial' && (
          <p className="notice warn small">Partly outside the survey: {res.reason}</p>
        )}
        {site && site.drafts.length > 0 && (
          <fieldset className="sv-sub" data-testid="survey-site-drafts">
            <legend>Suggested regions (drafts)</legend>
            <ul className="sv-items">
              {site.drafts.map((d, k) => (
                <li key={k}>
                  <label className="sv-check">
                    <input
                      type="checkbox"
                      checked={picked.has(k)}
                      data-testid="survey-site-draft"
                      onChange={() => {
                        const next = new Set(picked);
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        setPicked(next);
                      }}
                    />
                    {d.kind === 'cut' ? 'Cut' : 'Fill'} region {k + 1}: about {v(d.volumeM3)} over{' '}
                    {a(d.areaM2)}
                  </label>
                </li>
              ))}
            </ul>
            <div className="sv-row">
              <button
                type="button"
                className="btn sm"
                disabled={readOnly || picked.size === 0}
                data-testid="survey-site-accept"
                onClick={accept}
              >
                Keep {picked.size || ''} as {TOOL_LABELS.volume.toLowerCase()} measurements
              </button>
            </div>
          </fieldset>
        )}
        {site && res && site.drafts.length === 0 && !job && (
          <p className="small faint">No region changed by more than the deadband.</p>
        )}
      </div>
    </div>
  );
}
