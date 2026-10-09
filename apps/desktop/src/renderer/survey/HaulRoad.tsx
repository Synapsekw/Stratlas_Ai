/**
 * Haul-road compliance (M11 G11, PRD HRD-1): pick a prepared surface and a centreline (a design
 * alignment, a design polyline, or a line drawn with the measurement tools), the section interval
 * and the site's limits (the minimum berm height can come from the largest truck's wheel), run
 * `haul.analyse`, and read the results by station with pass or fail per check; the centreline is
 * coloured by pass or fail in the views and **Fly to** goes to a station. The limits travel with
 * each run (its params); the site's defaults live in `survey/settings.json` (`haul`). The report
 * section is G9's: it reads the same runs (`survey:readHaulRuns`).
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import type { EngineStage } from '@aio/engine';
import { getActiveMap, onActiveMap } from '@aio/maps';
import type { HaulCheck, HaulRun, HaulStation } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useShell } from '../shell';
import { PopTool } from '../workspace/StageTools';
import { loadDesigns, useDesigns } from './designsStore';
import {
  buildHaulParams,
  CHECK_LABELS,
  failedChecks,
  LIMIT_FIELDS,
  minBermHeight,
  newRunId,
  staleReason,
  stationCells,
  type CentrelinePick,
  type HaulLimitKey,
  type HaulSiteDefaults,
} from './haulRoadModel';
import { attachHaul3d, attachHaulMap } from './haulRoadScene';
import {
  flyToStation,
  loadHaul,
  prepareDsms,
  saveSiteDefaults,
  selectRun,
  setShown,
  startHaulRun,
  useHaul,
  watchHaulJobs,
} from './haulRoadStore';
import { frameOf } from './measureScene';
import { useMeasure } from './measureStore';
import './haulRoad.css';

interface CentrelineOption {
  value: string;
  label: string;
  pick: CentrelinePick;
}

/** Alignments and polylines of the designs, and the lines drawn with the measurement tools. */
function useCentrelines(): CentrelineOption[] {
  const designs = useDesigns((s) => s.file);
  const measurements = useMeasure((s) => s.file.measurements);
  return useMemo(() => {
    const out: CentrelineOption[] = [];
    for (const d of designs?.designs ?? [])
      for (const l of d.layers)
        if (!l.archived && (l.kind === 'alignment' || l.kind === 'linework'))
          out.push({
            value: `design:${d.id}/${l.id}`,
            label: `${d.name}: ${l.name} (${l.kind === 'alignment' ? 'alignment' : 'polyline'})`,
            pick: { kind: 'design', design: d.id, layer: l.id },
          });
    for (const m of measurements)
      if (m.family === 'line' && m.points.length >= 2)
        out.push({
          value: `drawn:${m.id}`,
          label: `${m.label || m.id} (drawn line)`,
          pick: { kind: 'drawn', points: m.points },
        });
    return out;
  }, [designs, measurements]);
}

const limitText = (d: HaulSiteDefaults): Record<HaulLimitKey, string> => {
  const out = {} as Record<HaulLimitKey, string>;
  for (const { key } of LIMIT_FIELDS) out[key] = d.limits[key]?.toString() ?? '';
  return out;
};

const CELL_CHECKS: { key: string; checks: HaulCheck[]; label: string }[] = [
  { key: 'width', checks: ['width'], label: 'Width (m)' },
  { key: 'grade', checks: ['grade'], label: 'Grade (%)' },
  { key: 'crossFall', checks: ['crossFall', 'superelevation'], label: 'Cross fall L / R (%)' },
  { key: 'bermLeft', checks: ['bermLeft'], label: 'Berm L (m)' },
  { key: 'bermRight', checks: ['bermRight'], label: 'Berm R (m)' },
];

function StationRow({ st }: { st: HaulStation }) {
  const cells = stationCells(st);
  const failed = failedChecks(st);
  const [error, setError] = useState<string | null>(null);
  return (
    <tr
      data-testid={`haul-station-${st.stationLabel}`}
      data-status={st.status}
      className={`haul-row is-${st.status}`}
    >
      <th scope="row">
        <button
          type="button"
          className="haul-fly"
          title="Fly to this station"
          aria-label={`Fly to ${st.stationLabel}`}
          onClick={() => {
            setError(flyToStation(st.e, st.n, st.z));
          }}
        >
          {st.stationLabel}
        </button>
        {error && <span role="alert">{error}</span>}
      </th>
      {CELL_CHECKS.map((c) => (
        <td
          key={c.key}
          data-check={c.key}
          className={c.checks.some((k) => st.checks[k] === 'fail') ? 'is-fail' : undefined}
        >
          {cells[c.key]}
        </td>
      ))}
      <td title={failed.join(', ')}>
        {st.status === 'pass' ? 'Pass' : st.status === 'fail' ? 'Fail' : 'No data'}
      </td>
    </tr>
  );
}

function RunResults({ run }: { run: HaulRun }) {
  const surfaces = useHaul((s) => s.surfaces);
  const shown = useHaul((s) => s.shown);
  const stale = staleReason(run, surfaces);
  const s = run.summary;
  return (
    <section className="haul-results" aria-label="Haul-road results" data-testid="haul-results">
      {stale && (
        <p className="pop-note" role="status" data-testid="haul-stale">
          Stale, recompute. {stale}
        </p>
      )}
      <p className="pop-note" data-testid="haul-summary">
        {run.centreline.name} on {run.surface.name}: {s.stations} stations, {s.pass} pass, {s.fail}{' '}
        fail
        {s.noData ? `, ${String(s.noData)} without data` : ''}.
      </p>
      {run.stretches.length > 0 && (
        <ul className="haul-stretches" aria-label="Failing stretches">
          {run.stretches.map((x) => (
            <li key={`${x.check}-${String(x.fromChainageM)}`}>
              {CHECK_LABELS[x.check]}:{' '}
              {x.fromStation === x.toStation ? x.fromStation : `${x.fromStation} to ${x.toStation}`}
            </li>
          ))}
        </ul>
      )}
      <label className="haul-check">
        <input
          type="checkbox"
          checked={shown}
          onChange={() => {
            setShown(!shown);
          }}
        />
        <span>Colour the centreline by pass or fail</span>
      </label>
      <div className="haul-table-wrap">
        <table className="haul-table" data-testid="haul-table">
          <thead>
            <tr>
              <th scope="col" title="Click a station to fly to it">
                Station
              </th>
              {CELL_CHECKS.map((c) => (
                <th key={c.key} scope="col">
                  {c.label}
                </th>
              ))}
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {run.stations.map((st) => (
              <StationRow key={`${st.stationLabel}-${String(st.chainageM)}`} st={st} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The run form; keyed by the site defaults, so it starts from them whenever they load. */
function HaulRoadForm({ defaults }: { defaults: HaulSiteDefaults }) {
  const surfaces = useHaul((s) => s.surfaces);
  const options = useCentrelines();
  const [surface, setSurface] = useState('');
  const [centreline, setCentreline] = useState('');
  const [interval, setIntervalText] = useState(String(defaults.intervalM));
  const [limits, setLimits] = useState(limitText(defaults));
  const [wheel, setWheel] = useState(defaults.wheelHeightM?.toString() ?? '');
  const [share, setShare] = useState(String(defaults.wheelShare * 100));
  const [note, setNote] = useState<string | null>(null);

  const surfaceId = surface !== '' ? surface : (surfaces?.at(-1)?.id ?? '');
  const pick = options.find((o) => o.value === centreline) ?? options[0];

  const start = () => {
    const built = buildHaulParams({
      surface: surfaceId,
      centreline: pick?.pick ?? null,
      intervalM: interval,
      limits,
      run: newRunId(),
    });
    if (!built.ok) {
      setNote(built.error);
      return;
    }
    setNote('Run started. Its results show below when the job is done.');
    void startHaulRun(built.params).then((e) => {
      if (e) setNote(e);
    });
  };
  const wheelBerm = () => {
    try {
      const h = minBermHeight(Number(wheel), Number(share) / 100);
      setLimits({ ...limits, minBermHeightM: String(h) });
      setNote(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  const saveDefaults = () => {
    const built = buildHaulParams({
      surface: 'x',
      centreline: { kind: 'design', design: 'x', layer: 'x' },
      intervalM: interval,
      limits,
    });
    if (!built.ok) {
      setNote(built.error);
      return;
    }
    const w = Number(wheel);
    const sh = Number(share) / 100;
    void saveSiteDefaults({
      intervalM: built.params.intervalM,
      limits: built.params.limits,
      ...(wheel.trim() && w > 0 ? { wheelHeightM: w } : {}),
      wheelShare: sh > 0 && sh <= 2 ? sh : defaults.wheelShare,
    }).then((e) => {
      setNote(e ?? 'Saved as the site defaults.');
    });
  };

  return (
    <>
      <label className="pop-row">
        <span>Surface</span>
        <select
          value={surfaceId}
          aria-label="Surface"
          onChange={(e) => {
            setSurface(e.target.value);
          }}
        >
          {(surfaces ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {surfaces?.length === 0 && (
        <div className="pop-row">
          <span className="pop-note">No prepared surface yet.</span>
          <button
            type="button"
            onClick={() => {
              setNote('Preparing the surfaces. They show here when the job is done.');
              void prepareDsms().then((e) => {
                if (e) setNote(e);
              });
            }}
          >
            Prepare the DSMs
          </button>
        </div>
      )}
      <label className="pop-row">
        <span>Centreline</span>
        <select
          value={pick?.value ?? ''}
          aria-label="Centreline"
          onChange={(e) => {
            setCentreline(e.target.value);
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {options.length === 0 && (
        <p className="pop-note">
          No centreline yet. Import a design alignment or polyline, or draw a line with the
          measurement tools.
        </p>
      )}
      <label className="pop-row">
        <span>Sections every (m)</span>
        <input
          type="number"
          min={0.5}
          step="any"
          value={interval}
          aria-label="Section interval in metres"
          onChange={(e) => {
            setIntervalText(e.target.value);
          }}
        />
      </label>
      <fieldset className="haul-limits">
        <legend>Limits</legend>
        {LIMIT_FIELDS.map((f) => (
          <label key={f.key} className="pop-row">
            <span>{f.label}</span>
            <input
              type="number"
              step="any"
              value={limits[f.key]}
              aria-label={f.label}
              placeholder="Not checked"
              onChange={(e) => {
                setLimits({ ...limits, [f.key]: e.target.value });
              }}
            />
          </label>
        ))}
        <div className="haul-wheel">
          <label>
            <span>Largest wheel height (m)</span>
            <input
              type="number"
              step="any"
              min={0}
              value={wheel}
              aria-label="Largest truck wheel height in metres"
              onChange={(e) => {
                setWheel(e.target.value);
              }}
            />
          </label>
          <label>
            <span>Share (%)</span>
            <input
              type="number"
              step="any"
              min={1}
              value={share}
              aria-label="Share of the wheel height in percent"
              onChange={(e) => {
                setShare(e.target.value);
              }}
            />
          </label>
          <button type="button" onClick={wheelBerm} disabled={!wheel.trim()}>
            Set berm height
          </button>
        </div>
      </fieldset>
      <div className="pop-row">
        <button type="button" onClick={start} disabled={!surfaceId || !pick}>
          Run analysis
        </button>
        <button type="button" onClick={saveDefaults}>
          Save as site defaults
        </button>
      </div>
      {note && (
        <p className="pop-note" role="status">
          {note}
        </p>
      )}
    </>
  );
}

export function HaulRoadPanel() {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const readOnly = useAnnotateReadOnly() || pkg !== null;
  const runs = useHaul((s) => s.runs);
  const defaults = useHaul((s) => s.defaults);
  const selected = useHaul((s) => s.selected);
  const loadError = useHaul((s) => s.error);
  const designsFor = useDesigns((s) => s.projectId);
  const projectId = project?.id ?? null;

  useEffect(() => {
    if (projectId && designsFor !== projectId) void loadDesigns(projectId);
  }, [projectId, designsFor]);

  const run = runs.find((r) => r.id === selected) ?? null;
  if (!project) return null;
  return (
    <div className="pop-form haul-panel" data-testid="haul-panel">
      <div className="pop-row">
        <strong>Haul-road compliance</strong>
      </div>
      {!readOnly && <HaulRoadForm key={JSON.stringify(defaults)} defaults={defaults} />}
      {loadError && (
        <p className="pop-note" role="alert">
          {loadError}
        </p>
      )}
      {runs.length > 0 && (
        <label className="pop-row">
          <span>Run</span>
          <select
            value={selected ?? ''}
            aria-label="Run"
            onChange={(e) => {
              void selectRun(e.target.value);
            }}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.computedAt.replace('T', ' ').replace(/:\d\dZ$/, '')}, {r.centreline.name},{' '}
                {r.summary.fail} failing
              </option>
            ))}
          </select>
        </label>
      )}
      {runs.length === 0 && <p className="pop-note">No haul-road runs yet.</p>}
      {run && <RunResults run={run} />}
    </div>
  );
}

function useActiveMap() {
  return useSyncExternalStore(onActiveMap, getActiveMap, getActiveMap);
}

/** The Haul road button of the stage toolbar, and the coloured centreline in the views. */
export function HaulRoadTool({ stage }: { stage: EngineStage | null }) {
  const project = useWorkspace((s) => s.project);
  const projectId = project?.id ?? null;
  const manifest = project?.manifest ?? null;
  const frame = useMemo(() => (manifest ? frameOf(manifest) : null), [manifest]);
  const map = useActiveMap();

  useEffect(() => {
    watchHaulJobs();
    void loadHaul(projectId);
  }, [projectId]);
  useEffect(() => {
    if (!stage || !frame) return;
    return attachHaul3d(stage, frame);
  }, [stage, frame]);
  useEffect(() => {
    if (!map || !frame) return;
    return attachHaulMap(map, frame);
  }, [map, frame]);

  return (
    <PopTool icon="road" label="Haul road" disabled={!project} wide>
      <HaulRoadPanel />
    </PopTool>
  );
}
