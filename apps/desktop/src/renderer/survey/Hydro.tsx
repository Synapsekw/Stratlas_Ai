/**
 * Hydrology (M11 G10, PRD HYD-1 to HYD-3): the Hydrology button of the stage toolbar and its panel.
 * Pick a prepared surface, then **Flood to level**, **Runoff**, **Catchment** or **Direct rainfall**
 * (forms in `HydroForms.tsx`); each runs as a pipeline job and lands in `survey/hydro/<run>/`. The
 * newest run of the tab shows on the map (outline and depth, flow path, catchments and streams, a
 * rainfall depth frame with a time slider) with its numbers and downloads. Rainfall runs whose
 * model has not met its quality target say **Preview**.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import type { HydroPipeline, HydroRun } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useSyncExternalStore, useState } from 'react';
import { PopTool } from '../workspace/StageTools';
import { attachHydroMap } from './hydroMap';
import './hydro.css';
import { CatchmentForm, FloodForm, RainfallForm, RunoffForm } from './HydroForms';
import {
  cancelPick,
  hydro,
  loadHydro,
  prepareSurfaces,
  runFileUrl,
  selectedRun,
  setActiveSurface,
  useDraft,
  useHydro,
  watchHydroJobs,
  type HydroTab,
} from './hydroStore';

const TABS: { id: HydroTab; label: string; pipeline: HydroPipeline; mode?: string }[] = [
  { id: 'flood', label: 'Flood to level', pipeline: 'hydro.flood' },
  { id: 'runoff', label: 'Runoff', pipeline: 'hydro.flow', mode: 'runoff' },
  { id: 'catchment', label: 'Catchment', pipeline: 'hydro.flow', mode: 'catchment' },
  { id: 'rainfall', label: 'Direct rainfall', pipeline: 'hydro.rainfall' },
];

const nf = (d: number) =>
  new Intl.NumberFormat('en', { minimumFractionDigits: d, maximumFractionDigits: d });
const m = (v: number) => `${nf(2).format(v)} m`;
const m2 = (v: number) => `${nf(1).format(v)} m²`;
const m3 = (v: number) => `${nf(1).format(v)} m³`;
const pt = (p: readonly number[]) => `${nf(3).format(p[0] ?? 0)}, ${nf(3).format(p[1] ?? 0)}`;

/** The tab a run belongs to. */
export function tabOf(run: HydroRun): HydroTab {
  if (run.pipeline === 'hydro.flood') return 'flood';
  if (run.pipeline === 'hydro.rainfall') return 'rainfall';
  return run.results.mode === 'runoff' ? 'runoff' : 'catchment';
}

function useActiveMap(): MapController | null {
  return useSyncExternalStore(onActiveMap, getActiveMap, getActiveMap);
}

function Download({ run, file, label }: { run: HydroRun; file: string; label: string }) {
  const projectId = useHydro((s) => s.projectId);
  if (!projectId) return null;
  return (
    <a
      href={runFileUrl(projectId, run, file)}
      download={`${run.id}-${file.split('/').pop() ?? file}`}
    >
      {label}
    </a>
  );
}

function FloodResult({ run }: { run: Extract<HydroRun, { pipeline: 'hydro.flood' }> }) {
  const r = run.results;
  return (
    <>
      <p>
        Level {m(r.levelM)}: area <strong>{m2(r.areaM2)}</strong>, stored volume{' '}
        <strong>{m3(r.volumeM3)}</strong>, deepest {m(r.maxDepthM)}.
      </p>
      <div className="pop-row">
        {run.files.dxf && (
          <Download run={run} file={run.files.dxf} label="Download outline (DXF)" />
        )}
        {run.files.outline && (
          <Download run={run} file={run.files.outline} label="Outline (GeoJSON)" />
        )}
        {run.files.depth && <Download run={run} file={run.files.depth} label="Depth grid" />}
      </div>
    </>
  );
}

function FlowResult({ run }: { run: Extract<HydroRun, { pipeline: 'hydro.flow' }> }) {
  const r = run.results;
  return (
    <>
      {r.path && (
        <p>
          Flow path {m(r.path.lengthM)} long, falling {m(r.path.fallM)}, from {pt(r.path.start)} to{' '}
          {pt(r.path.end)}
          {r.path.leavesSurface ? ' where it leaves the surface.' : '.'}
        </p>
      )}
      {r.outlets?.map((o, i) => (
        <p key={`${String(i)}-${pt(o.pourPoint)}`} data-testid="hydro-outlet">
          Catchment {i + 1}: <strong>{m2(o.areaM2)}</strong>
          {o.contributingAreaM2 !== undefined &&
            ` (D-infinity contributing area ${m2(o.contributingAreaM2)})`}
          , pour point {pt(o.pourPoint)}.
        </p>
      ))}
      {r.streamLinks !== undefined && (
        <p>
          Streams from {m2(r.streamAreaM2 ?? 0)} upslope: {r.streamLinks} links,{' '}
          {m(r.streamLengthM ?? 0)}.
        </p>
      )}
      <div className="pop-row">
        {run.files.path && <Download run={run} file={run.files.path} label="Flow path (GeoJSON)" />}
        {run.files.catchments && (
          <Download run={run} file={run.files.catchments} label="Catchments (GeoJSON)" />
        )}
        {run.files.streams && (
          <Download run={run} file={run.files.streams} label="Streams (GeoJSON)" />
        )}
      </div>
    </>
  );
}

function RainfallResult({ run }: { run: Extract<HydroRun, { pipeline: 'hydro.rainfall' }> }) {
  const r = run.results;
  const frame = useHydro((s) => Math.min(s.frame, Math.max(0, r.frames.length - 1)));
  const f = r.frames[frame];
  return (
    <>
      {run.preview && (
        <p className="pop-note" data-testid="hydro-preview">
          Preview: this simplified model has not met its quality target yet.
        </p>
      )}
      {f && (
        <label className="pop-row">
          <span>
            {nf(0).format(f.tMin)} min, deepest {m(f.maxDepthM)}
          </span>
          <input
            type="range"
            min={0}
            max={r.frames.length - 1}
            value={frame}
            aria-label="Time"
            onChange={(e) => {
              hydro.setState({ frame: Number(e.target.value) });
            }}
          />
        </label>
      )}
      <p>
        Rain {m3(r.rainM3)}, soaked in {m3(r.infiltratedM3)}, ran off {m3(r.outflowM3)}, standing{' '}
        {m3(r.storedM3)}. Peak outflow {nf(3).format(r.peakOutflowM3s)} m³/s at{' '}
        {nf(0).format(r.peakAtMin)} min.
      </p>
      <div className="pop-row">
        {run.files.hydrograph && (
          <Download run={run} file={run.files.hydrograph} label="Hydrograph (CSV)" />
        )}
        {run.files.maxDepth && (
          <Download run={run} file={run.files.maxDepth} label="Maximum depth grid" />
        )}
      </div>
    </>
  );
}

function RunResult({ run }: { run: HydroRun }) {
  return (
    <section className="pop-form" aria-label="Result" data-testid="hydro-result">
      {run.pipeline === 'hydro.flood' && <FloodResult run={run} />}
      {run.pipeline === 'hydro.flow' && <FlowResult run={run} />}
      {run.pipeline === 'hydro.rainfall' && <RainfallResult run={run} />}
      {run.notes?.map((n) => (
        <p key={n} className="pop-note">
          {n}
        </p>
      ))}
    </section>
  );
}

export function HydroPanel({ map }: { map: boolean }) {
  const surfaces = useHydro((s) => s.surfaces);
  const runs = useHydro((s) => s.runs);
  const tab = useHydro((s) => s.tab);
  const pending = useHydro((s) => s.pending);
  const busy = useHydro((s) => s.busy);
  const error = useHydro((s) => s.error);
  const selected = useHydro(selectedRun);
  const readOnly = useAnnotateReadOnly();
  const [surfaceDraft, setSurface] = useDraft('surface', '');
  const [note, setNote] = useState<string | null>(null);
  const surface = surfaces.some((s) => s.id === surfaceDraft)
    ? surfaceDraft
    : (surfaces[0]?.id ?? '');
  useEffect(() => {
    setActiveSurface(surface || null);
  }, [surface]);
  const tabRuns = runs.filter((r) => tabOf(r) === tab);
  const props = { surface, map, readOnly };
  return (
    <div className="pop-form hydro-panel" data-testid="hydro-panel" aria-busy={busy}>
      <div className="pop-row">
        <strong>Hydrology</strong>
      </div>
      {surfaces.length === 0 && !busy && (
        <div className="pop-row">
          <span className="pop-note">No prepared surface yet. Prepare the survey DSMs first.</span>
          <button
            type="button"
            disabled={readOnly}
            onClick={() => {
              void prepareSurfaces().then((e) => {
                setNote(e ?? 'Preparing the surfaces. The tools open when the job is done.');
              });
            }}
          >
            Prepare surfaces
          </button>
        </div>
      )}
      {surfaces.length > 0 && (
        <>
          <label className="pop-row">
            <span>Surface</span>
            <select
              value={surface}
              aria-label="Surface"
              onChange={(e) => {
                setSurface(e.target.value);
              }}
            >
              {surfaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({nf(2).format(s.cellM)} m)
                </option>
              ))}
            </select>
          </label>
          <div className="seg ctx-tabs" role="tablist" aria-label="Hydrology">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  const first = runs.find((r) => tabOf(r) === t.id);
                  hydro.setState({ tab: t.id, selected: first?.id ?? null, frame: 0 });
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'flood' && <FloodForm {...props} />}
          {tab === 'runoff' && <RunoffForm {...props} />}
          {tab === 'catchment' && <CatchmentForm {...props} />}
          {tab === 'rainfall' && <RainfallForm {...props} />}
          {!map && (
            <p className="pop-note">Open the map view to pick points and see the results drawn.</p>
          )}
        </>
      )}
      {pending && (
        <p className="pop-note" role="status">
          Running. The result shows here when the job is done.
        </p>
      )}
      {(error ?? (surfaces.length ? null : note)) && (
        <p className="pop-note" role={error ? 'alert' : 'status'}>
          {error ?? note}
        </p>
      )}
      {selected && tabOf(selected) === tab && <RunResult run={selected} />}
      {tabRuns.length > 0 && (
        <label className="pop-row">
          <span>Run</span>
          <select
            value={selected && tabOf(selected) === tab ? selected.id : ''}
            aria-label="Run"
            onChange={(e) => {
              hydro.setState({ selected: e.target.value || null, frame: 0 });
            }}
          >
            <option value="">None shown</option>
            {tabRuns.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** Draws the shown run on the active map and takes picks; Escape ends a pick. */
function HydroMapLayer({
  map,
  projectId,
  epsg,
}: {
  map: MapController;
  projectId: string;
  epsg: number;
}) {
  useEffect(() => attachHydroMap(map, projectId, epsg), [map, projectId, epsg]);
  return null;
}

/** The Hydrology button of the stage toolbar. */
export function HydroTool() {
  const project = useWorkspace((s) => s.project);
  const projectId = project?.id ?? null;
  const epsg = project && 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : null;
  const open = useHydro((s) => s.open);
  const pick = useHydro((s) => s.pick);
  const map = useActiveMap();
  useEffect(() => {
    watchHydroJobs();
    void loadHydro(projectId);
  }, [projectId]);
  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelPick();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [pick]);
  return (
    <>
      <PopTool
        icon="target"
        label="Hydrology"
        disabled={!projectId}
        wide
        open={open}
        onOpenChange={(o) => {
          hydro.setState({ open: o });
          if (o && projectId) void loadHydro(projectId);
        }}
      >
        <HydroPanel map={map !== null && epsg !== null} />
      </PopTool>
      {map && projectId && epsg !== null && (
        <HydroMapLayer map={map} projectId={projectId} epsg={epsg} />
      )}
    </>
  );
}
