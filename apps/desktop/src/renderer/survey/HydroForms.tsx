/**
 * The four hydrology forms (M11 G10): **Flood to level** (a typed or picked level, connected to a
 * seed or every cell below), **Runoff** (a drop point), **Catchment** (outlets, or the main outlet,
 * and the stream threshold) and **Direct rainfall** (a rainfall CSV, Manning's n, infiltration,
 * the cell and the duration). Each starts its job through `hydroStore.ts`; points are typed as
 * "E, N" or picked on the map. Each run can be limited to a **Region**: an area or volume
 * measurement, picked from the list or drawn there and then; a surface above the tool's cell limit
 * asks for one before it runs.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { bridge } from '../shell';
import {
  hydro,
  isCellLimitError,
  regionNeed,
  startHydro,
  startPick,
  useDraft,
  useHydro,
  withRegion,
  type HydroJob,
  type PickKind,
  type Ring,
} from './hydroStore';
import { startTool, useMeasure } from './measureStore';

/** "551200.5, 2331349" to [E, N], or null. */
export function parsePoint(text: string): [number, number] | null {
  const parts = text
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 2 || parts.some((x) => !Number.isFinite(x))) return null;
  return [parts[0] ?? 0, parts[1] ?? 0];
}

/** Points, one "E, N" per line. */
export function parsePoints(text: string): [number, number][] | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const out: [number, number][] = [];
  for (const l of lines) {
    const p = parsePoint(l);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

const fmtPoint = (e: number, n: number) => `${e.toFixed(3)}, ${n.toFixed(3)}`;

/** Fill a field from a point picked on the map for `kind` (each pick is used once). */
function usePicked(kind: PickKind, apply: (e: number, n: number, z: number | null) => void) {
  const pickedAt = useHydro((s) => (s.picked?.kind === kind ? s.picked.at : 0));
  useEffect(() => {
    const p = hydro.getState().picked;
    if (!pickedAt || p?.kind !== kind) return;
    hydro.setState({ picked: null });
    apply(p.e, p.n, p.z);
    // apply changes every render; only a new pick matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedAt, kind]);
}

function PickButton({ kind, label, map }: { kind: PickKind; label: string; map: boolean }) {
  return (
    <button
      type="button"
      disabled={!map}
      title={map ? 'Click a point on the map' : 'Open the map view to pick a point'}
      onClick={() => {
        startPick(kind);
      }}
    >
      {label}
    </button>
  );
}

function Methods({
  method,
  setMethod,
  depressions,
  setDepressions,
}: {
  method: string;
  setMethod: (v: string) => void;
  depressions: string;
  setDepressions: (v: string) => void;
}) {
  return (
    <>
      <label className="pop-row">
        <span>Flow direction</span>
        <select
          value={method}
          onChange={(e) => {
            setMethod(e.target.value);
          }}
        >
          <option value="d8">D8</option>
          <option value="dinf">D-infinity</option>
        </select>
      </label>
      <label className="pop-row">
        <span>Depressions</span>
        <select
          value={depressions}
          onChange={(e) => {
            setDepressions(e.target.value);
          }}
        >
          <option value="breach">Breach</option>
          <option value="fill">Fill</option>
        </select>
      </label>
    </>
  );
}

interface FormProps {
  surface: string;
  map: boolean;
  readOnly: boolean;
}

/** The polygon measurements a region can come from (area and volume). */
function useRegionPolygons(): { id: string; label: string; ring: Ring }[] {
  const measurements = useMeasure((s) => s.file.measurements);
  return useMemo(
    () =>
      measurements
        .filter((m) => m.family === 'polygon' && m.points.length >= 3)
        .map((m) => ({
          id: m.id,
          label: m.label,
          ring: m.points.map((p): [number, number] => [p[0], p[1]]),
        })),
    [measurements],
  );
}

/** Polygons there were when **Draw a region** started: the first new one becomes the region. */
let drawingFrom: Set<string> | null = null;

/**
 * The run's region (shared by the four tools): a polygon measurement or the whole surface, and
 * why the run needs one (above the cell limit) or another one (it misses the surface).
 */
function useRegion(
  pipeline: HydroJob,
  surfaceId: string,
  cellM?: number,
): { ring: Ring | null; need: string | null; field: ReactNode } {
  const [id, setId] = useDraft('region', '');
  const polygons = useRegionPolygons();
  const surface = useHydro((s) => s.surfaces.find((x) => x.id === surfaceId));
  const refused = useHydro((s) => isCellLimitError(s.error));
  const readOnly = useMeasure((s) => s.readOnly);
  // a region drawn from here becomes the run's region once it is finished
  useEffect(() => {
    const from = drawingFrom;
    if (!from) return;
    const added = polygons.find((p) => !from.has(p.id));
    if (added) {
      drawingFrom = null;
      setId(added.id);
    }
    // setId is a new function each render; only the polygons matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygons]);
  const ring = polygons.find((p) => p.id === id)?.ring ?? null;
  const need = regionNeed(pipeline, surface, ring, cellM);
  const field = (
    <div className="hydro-region" data-testid="hydro-region">
      <label className="pop-row">
        <span>Region</span>
        <select
          value={ring ? id : ''}
          aria-label="Region"
          data-testid="hydro-region-pick"
          onChange={(e) => {
            setId(e.target.value);
          }}
        >
          <option value="">Whole surface</option>
          {polygons.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {!readOnly && (
          <button
            type="button"
            data-testid="hydro-region-draw"
            title="Draw an area in the view; it becomes the region when it is finished"
            onClick={() => {
              drawingFrom = new Set(polygons.map((p) => p.id));
              startTool('area');
              hydro.setState({ open: false });
            }}
          >
            Draw a region
          </button>
        )}
      </label>
      {(need !== null || (refused && !ring)) && (
        <p className="pop-note" role="status" data-testid="hydro-region-need">
          {need ?? 'This surface is above the cell limit of the tool. Pick or draw a region.'}
        </p>
      )}
    </div>
  );
  return { ring, need, field };
}

export function FloodForm({ surface, map, readOnly }: FormProps) {
  const [level, setLevel] = useDraft('flood.level', '');
  const [mode, setMode] = useDraft('flood.mode', 'connected');
  const [seed, setSeed] = useDraft('flood.seed', '');
  const [error, setError] = useState<string | null>(null);
  usePicked('level', (e, n, z) => {
    if (z !== null) setLevel(z.toFixed(3));
    else setError('The surface has no height at that point.');
    setSeed(fmtPoint(e, n));
  });
  usePicked('seed', (e, n) => {
    setSeed(fmtPoint(e, n));
  });
  const region = useRegion('hydro.flood', surface);
  const lv = Number(level);
  const seedPt = seed.trim() ? parsePoint(seed) : null;
  const valid =
    region.need === null &&
    level.trim() !== '' &&
    Number.isFinite(lv) &&
    (seed.trim() === '' || seedPt !== null);
  return (
    <form
      className="pop-form"
      aria-label="Flood to level"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!valid) return;
        const params: Record<string, unknown> = {
          surface,
          levelM: lv,
          mode: mode === 'all-below' ? 'all-below' : 'connected',
        };
        if (mode === 'connected' && seedPt) params.seed = seedPt;
        void startHydro('hydro.flood', withRegion(params, region.ring), 'flood').then(setError);
      }}
    >
      <label className="pop-row">
        <span>Water level (m)</span>
        <input
          type="number"
          step="any"
          value={level}
          aria-label="Water level (m)"
          onChange={(e) => {
            setLevel(e.target.value);
          }}
        />
        <PickButton kind="level" label="Pick on map" map={map} />
      </label>
      <label className="pop-row">
        <span>Water</span>
        <select
          value={mode}
          aria-label="Water"
          onChange={(e) => {
            setMode(e.target.value === 'all-below' ? 'all-below' : 'connected');
          }}
        >
          <option value="connected">Connected to a point</option>
          <option value="all-below">Every cell below the level</option>
        </select>
      </label>
      {mode === 'connected' && (
        <label className="pop-row">
          <span>Point in the water (E, N)</span>
          <input
            value={seed}
            placeholder="The lowest point"
            aria-label="Point in the water (E, N)"
            onChange={(e) => {
              setSeed(e.target.value);
            }}
          />
          <PickButton kind="seed" label="Pick" map={map} />
        </label>
      )}
      {region.field}
      <div className="pop-row">
        <button type="submit" disabled={readOnly || !valid}>
          Flood
        </button>
      </div>
      {error && (
        <p className="pop-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function RunoffForm({ surface, map, readOnly }: FormProps) {
  const [drop, setDrop] = useDraft('runoff.drop', '');
  const [method, setMethod] = useDraft('runoff.method', 'd8');
  const [depressions, setDepressions] = useDraft('runoff.depressions', 'breach');
  const [error, setError] = useState<string | null>(null);
  usePicked('drop', (e, n) => {
    setDrop(fmtPoint(e, n));
  });
  const region = useRegion('hydro.flow', surface);
  const pt = parsePoint(drop);
  return (
    <form
      className="pop-form"
      aria-label="Runoff"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!pt || region.need) return;
        void startHydro(
          'hydro.flow',
          withRegion({ surface, mode: 'runoff', drop: pt, method, depressions }, region.ring),
          'runoff',
        ).then(setError);
      }}
    >
      <label className="pop-row">
        <span>Drop point (E, N)</span>
        <input
          value={drop}
          aria-label="Drop point (E, N)"
          onChange={(e) => {
            setDrop(e.target.value);
          }}
        />
        <PickButton kind="drop" label="Pick on map" map={map} />
      </label>
      <Methods
        method={method}
        setMethod={setMethod}
        depressions={depressions}
        setDepressions={setDepressions}
      />
      {region.field}
      <div className="pop-row">
        <button type="submit" disabled={readOnly || !pt || region.need !== null}>
          Show flow path
        </button>
      </div>
      {error && (
        <p className="pop-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function CatchmentForm({ surface, map, readOnly }: FormProps) {
  const [outlets, setOutlets] = useDraft('catchment.outlets', '');
  const [method, setMethod] = useDraft('catchment.method', 'd8');
  const [depressions, setDepressions] = useDraft('catchment.depressions', 'breach');
  const [threshold, setThreshold] = useDraft('catchment.threshold', '');
  const [error, setError] = useState<string | null>(null);
  usePicked('outlet', (e, n) => {
    setOutlets((t) => (t.trim() ? `${t.trim()}\n` : '') + fmtPoint(e, n));
  });
  const region = useRegion('hydro.flow', surface);
  const pts = parsePoints(outlets);
  const th = Number(threshold);
  const thOk = threshold.trim() === '' || (Number.isFinite(th) && th > 0);
  const valid = region.need === null && pts !== null && pts.length <= 100 && thOk;
  return (
    <form
      className="pop-form"
      aria-label="Catchment"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!valid) return;
        const params: Record<string, unknown> = { surface, mode: 'catchment', method, depressions };
        if (pts.length) params.outlets = pts;
        if (threshold.trim()) params.streamAreaM2 = th;
        void startHydro('hydro.flow', withRegion(params, region.ring), 'catchment').then(setError);
      }}
    >
      <label className="pop-row">
        <span>Outlets (E, N per line)</span>
        <textarea
          rows={2}
          value={outlets}
          placeholder="Empty: where most water leaves the site"
          aria-label="Outlets (E, N per line)"
          onChange={(e) => {
            setOutlets(e.target.value);
          }}
        />
        <PickButton kind="outlet" label="Pick outlet" map={map} />
      </label>
      <Methods
        method={method}
        setMethod={setMethod}
        depressions={depressions}
        setDepressions={setDepressions}
      />
      <label className="pop-row">
        <span>Stream threshold (m²)</span>
        <input
          type="number"
          min={0}
          step="any"
          value={threshold}
          placeholder="1% of the area"
          aria-label="Stream threshold (m²)"
          onChange={(e) => {
            setThreshold(e.target.value);
          }}
        />
      </label>
      {region.field}
      <div className="pop-row">
        <button type="submit" disabled={readOnly || !valid}>
          Delineate
        </button>
      </div>
      {error && (
        <p className="pop-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function RainfallForm({ surface, readOnly }: FormProps) {
  const [csv, setCsv] = useDraft('rain.csv', '');
  const [n, setN] = useDraft('rain.n', '0.03');
  const [infil, setInfil] = useDraft('rain.infil', '0');
  const [cell, setCell] = useDraft('rain.cell', '1');
  const [duration, setDuration] = useDraft('rain.duration', '');
  const [error, setError] = useState<string | null>(null);
  const region = useRegion('hydro.rainfall', surface, Number(cell));
  const nv = Number(n);
  const iv = Number(infil);
  const dv = Number(duration);
  const valid =
    region.need === null &&
    csv !== '' &&
    Number.isFinite(nv) &&
    nv > 0 &&
    nv <= 1 &&
    Number.isFinite(iv) &&
    iv >= 0 &&
    iv <= 1000 &&
    (duration.trim() === '' || (Number.isFinite(dv) && dv > 0 && dv <= 10_080));
  return (
    <form
      className="pop-form"
      aria-label="Direct rainfall"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!valid) return;
        const params: Record<string, unknown> = {
          surface,
          hyetograph: csv,
          manningN: nv,
          infiltrationMmPerH: iv,
          cellM: Number(cell),
        };
        if (duration.trim()) params.durationMin = dv;
        void startHydro('hydro.rainfall', withRegion(params, region.ring), 'rainfall').then(
          setError,
        );
      }}
    >
      <div className="pop-row">
        <span>Rainfall (CSV: minutes, mm/h)</span>
        <span className="mono" title={csv}>
          {csv ? csv.split(/[\\/]/).pop() : 'None chosen'}
        </span>
        <button
          type="button"
          onClick={() => {
            void bridge
              .call('dialog:openFile', {
                title: 'Rainfall hyetograph',
                filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
              })
              .then((r) => {
                if (!r.ok) setError(r.error);
                else if (r.value.path) setCsv(r.value.path);
              });
          }}
        >
          Choose
        </button>
      </div>
      <label className="pop-row">
        <span>Manning&apos;s n</span>
        <input
          type="number"
          step="any"
          min={0}
          value={n}
          aria-label="Manning's n"
          onChange={(e) => {
            setN(e.target.value);
          }}
        />
      </label>
      <label className="pop-row">
        <span>Infiltration (mm/h)</span>
        <input
          type="number"
          step="any"
          min={0}
          value={infil}
          aria-label="Infiltration (mm/h)"
          onChange={(e) => {
            setInfil(e.target.value);
          }}
        />
      </label>
      <label className="pop-row">
        <span>Cell</span>
        <select
          value={cell}
          aria-label="Cell"
          onChange={(e) => {
            setCell(e.target.value);
          }}
        >
          <option value="2">2 m</option>
          <option value="1">1 m</option>
          <option value="0.5">0.5 m</option>
        </select>
      </label>
      <label className="pop-row">
        <span>Duration (min)</span>
        <input
          type="number"
          step="any"
          min={0}
          value={duration}
          placeholder="Until the rain stops"
          aria-label="Duration (min)"
          onChange={(e) => {
            setDuration(e.target.value);
          }}
        />
      </label>
      {region.field}
      <div className="pop-row">
        <button type="submit" disabled={readOnly || !valid}>
          Run rainfall
        </button>
      </div>
      {error && (
        <p className="pop-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
