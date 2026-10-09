/**
 * **Site settings** (M11 G1, GEO-1 to GEO-4, data-conventions section 25): how the site's
 * coordinates are shown and exported. The display CRS (searched in the EPSG catalogue), the
 * vertical datum and geoid, units, coordinate order, precision, and the site calibration: import a
 * controller job (JobXML) or 12d parameters, or **Compute from point pairs** typed or imported from
 * a CSV (`PairsEditor.tsx`), through `geo.calibration`, read the residual table beside the
 * controller's own, and **Apply** it (journaled in main).
 *
 * Readouts: `siteCursorText` formats a project-CRS position for the cursor. It reads the tables
 * PROJ wrote (`survey/geodesy/site-transform.json`, `@aio/geo` `createSiteTransform`), or uses
 * proj4js for a pure projection the catalogue checked; it never re-implements a datum. Without
 * `survey/settings.json` the cursor keeps its 0.10 text.
 */
import {
  createSiteTransform,
  DENSITY_UNITS,
  DISTANCE_UNITS,
  AREA_UNITS,
  VOLUME_UNITS,
  MASS_UNITS,
  GRADE_STYLES,
  formatCoordinate,
  formatQuantity,
  toWgs84,
  unitLabel,
  unitName,
  unitsForCrsUnit,
  isKnownCrs,
  proj4Projector,
  type SiteTransformer,
} from '@aio/geo';
import type {
  CalibrationPair,
  CrsCatalogueEntry,
  GeoidPackMeta,
  SiteCalibration,
  SurveySettings,
  SurveyUnits,
} from '@aio/schema';
import { Icon, useFocusTrap } from '@aio/ui';
import { assetUrl, useWorkspace, workspace, type OpenProject } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge } from '../shell';
import { rowsOfPairs } from './calibrationPairs';
import { CalibrationPairsEditor } from './PairsEditor';
import { refreshSiteTables, siteTablesStale, type SiteTablesHeader } from './siteTables';

// ---------------------------------------------------------------- the site's display state

interface SiteDisplay {
  projectId: string | null;
  settings: SurveySettings | null;
  /** True when `survey/settings.json` exists (otherwise the cursor keeps its 0.10 text). */
  exists: boolean;
  transformer: SiteTransformer | null;
  /** proj4js from the data CRS to the display CRS (a pure projection), when there are no tables. */
  projector: ((e: number, n: number) => [number, number]) | null;
  crsName: string;
  /** Why the readout shows project coordinates instead of site ones. */
  note: string | null;
  /** Why the readout tables no longer match the settings (they are written again), or null. */
  stale: string | null;
  open: boolean;
}

export const siteDisplay = createStore<SiteDisplay>()(() => ({
  projectId: null,
  settings: null,
  exists: false,
  transformer: null,
  projector: null,
  crsName: '',
  note: null,
  stale: null,
  open: false,
}));

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(url);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function catalogueEntry(code: number): Promise<CrsCatalogueEntry | null> {
  const r = await bridge.call('geodesy:searchCrs', { query: `EPSG:${String(code)}`, limit: 1 });
  return r.ok && r.value.ok ? (r.value.results[0] ?? null) : null;
}

/** Read the site's settings and readout tables (after opening a project or saving settings). */
export async function loadSiteDisplay(project: OpenProject | null): Promise<void> {
  if (!project) {
    siteDisplay.setState({
      projectId: null,
      settings: null,
      exists: false,
      transformer: null,
      stale: null,
    });
    return;
  }
  const r = await bridge.call('survey:readSettings', { projectId: project.id });
  if (!r.ok || !r.value.ok) {
    siteDisplay.setState({ projectId: project.id, settings: null, exists: false, stale: null });
    return;
  }
  const { settings, exists } = r.value;
  let transformer: SiteTransformer | null = null;
  let projector: SiteDisplay['projector'] = null;
  let note: string | null = null;
  const header = await fetchBytes(
    assetUrl(project.id, { path: 'survey/geodesy/site-transform.json' }),
  );
  let stale: string | null = null;
  if (header) {
    try {
      const json = JSON.parse(new TextDecoder().decode(header)) as SiteTablesHeader & {
        grid?: { file: string };
        geoidGrid?: { file: string };
      };
      // tables made before a calibration was applied (or the settings changed) are never used
      stale = exists ? siteTablesStale(json, settings, project.manifest.crs) : null;
      if (!stale) {
        const get = (f: string) =>
          fetchBytes(assetUrl(project.id, { path: `survey/geodesy/${f}` }));
        const grid = json.grid ? await get(json.grid.file) : null;
        const geoidGrid = json.geoidGrid ? await get(json.geoidGrid.file) : null;
        transformer = createSiteTransform(json, {
          ...(grid ? { grid } : {}),
          ...(geoidGrid ? { geoidGrid } : {}),
        });
      }
    } catch (e) {
      note = `The site tables could not be read: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const data = project.manifest.crs;
  const display = settings.crs ?? data;
  let crsName = 'Project CRS';
  if ('epsg' in display) {
    const entry = await catalogueEntry(display.epsg);
    crsName = entry ? `${entry.name} (EPSG ${String(entry.code)})` : `EPSG ${String(display.epsg)}`;
    const same = 'epsg' in data && data.epsg === display.epsg;
    if (!transformer && !same && 'epsg' in data && !settings.calibration && entry?.proj4) {
      const from = (await catalogueEntry(data.epsg))?.proj4;
      if (from) projector = proj4Projector(from, entry.proj4);
    }
    if (!transformer && !projector && !same) {
      note = stale
        ? `Site tables are out of date (${stale}): showing project coordinates until they are written again.`
        : 'Site tables are not prepared yet: showing project coordinates.';
    }
  }
  if (!transformer && settings.verticalDatum.kind !== 'project' && !note) {
    note = stale
      ? `Site tables are out of date (${stale}): heights are as stored until they are written again.`
      : 'Site tables are not prepared yet: heights are as stored.';
  }
  if (!transformer && stale && !note) {
    note = `Site tables are out of date (${stale}): showing project coordinates until they are written again.`;
  }
  siteDisplay.setState({
    projectId: project.id,
    settings,
    exists,
    transformer,
    projector,
    crsName,
    note,
    stale,
  });
}

export function useSiteDisplay<T>(selector: (s: SiteDisplay) => T): T {
  return useStore(siteDisplay, selector);
}

/** Load the display state whenever the open project changes. */
export function useSiteDisplayLoader(): void {
  const project = useWorkspace((s) => s.project);
  useEffect(() => {
    void loadSiteDisplay(project);
  }, [project]);
}

function heightName(s: SurveySettings): string {
  const v = s.verticalDatum;
  if (v.kind === 'geoid') return `orthometric, geoid ${v.geoid}`;
  if (v.kind === 'ellipsoidal') return 'ellipsoidal';
  if (v.kind === 'calibration') return 'site calibration';
  return 'project heights';
}

/**
 * The cursor text for a project-CRS position in the site's order, units and precision; null when
 * the site has no settings (the caller keeps its own text).
 */
export function siteCursorText(e: number, n: number, z: number): string | null {
  const s = siteDisplay.getState();
  if (!s.settings || !s.exists) return null;
  let ee = e;
  let nn = n;
  let zz: number | null = z;
  if (s.transformer) {
    const r = s.transformer.toSite(e, n, z);
    if (r) {
      ee = r.e;
      nn = r.n;
      zz = r.z;
    }
  } else if (s.projector) {
    [ee, nn] = s.projector(e, n);
  }
  const style = {
    order: s.settings.order,
    units: s.settings.units,
    precision: s.settings.precision,
  };
  return formatCoordinate(ee, nn, zz, {
    ...style,
    ...(s.settings.locale ? { locale: s.settings.locale } : {}),
  });
}

/** The readout's title line: the display CRS, the height system and the unit. */
export function siteCursorTitle(): string | null {
  const s = siteDisplay.getState();
  if (!s.settings || !s.exists) return null;
  return `${s.crsName} · ${heightName(s.settings)} · ${unitLabel(s.settings.units.distance)}`;
}

// ---------------------------------------------------------------- the dialog

const QUANTITY_UNITS = {
  distance: DISTANCE_UNITS,
  area: AREA_UNITS,
  volume: VOLUME_UNITS,
  density: DENSITY_UNITS,
  mass: MASS_UNITS,
  grade: GRADE_STYLES,
} as const;
const QUANTITY_LABEL: Record<keyof SurveyUnits, string> = {
  distance: 'Distance',
  area: 'Area',
  volume: 'Volume',
  density: 'Density',
  mass: 'Mass',
  grade: 'Grade',
};
const PRECISION_LABEL = {
  coordinate: 'Coordinates',
  distance: 'Distances',
  area: 'Areas',
  volume: 'Volumes',
  grade: 'Grades',
} as const;

function originLonLat(project: OpenProject): [number, number] | undefined {
  const crs = project.manifest.crs;
  if (!('epsg' in crs) || !isKnownCrs(crs.epsg)) return undefined;
  try {
    const [lon, lat] = toWgs84(project.manifest.origin, crs.epsg);
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : undefined;
  } catch {
    return undefined;
  }
}

function CrsPicker({
  value,
  near,
  onPick,
}: {
  value: string;
  near: [number, number] | undefined;
  onPick: (e: CrsCatalogueEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CrsCatalogueEntry[]>([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void bridge
        .call('geodesy:searchCrs', {
          query,
          ...(near ? { near } : {}),
          kinds: ['projected'],
          limit: 30,
        })
        .then((r) => {
          if (live && r.ok && r.value.ok) setResults(r.value.results);
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, near]);
  return (
    <div className="site-crs">
      <p className="help" data-testid="site-crs-current">
        {value}
      </p>
      <input
        className="input"
        placeholder="Search by name, place or EPSG code"
        aria-label="Search coordinate systems"
        data-testid="site-crs-search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
      />
      <ul className="site-crs-list" role="listbox" aria-label="Coordinate systems">
        {results.map((e) => (
          <li key={e.code}>
            <button
              type="button"
              className="btn ghost sm"
              role="option"
              aria-selected={false}
              data-testid={`site-crs-${String(e.code)}`}
              onClick={() => {
                onPick(e);
              }}
            >
              <span className="mono">EPSG {e.code}</span> {e.name}
              <span className="sub"> · {e.unit}</span>
              {e.deprecated && <span className="sub"> · deprecated</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResidualTable({ cal, units }: { cal: SiteCalibration; units: SurveyUnits }) {
  // a calibration computed from pairs has no controller residuals to show beside its own
  const controller = cal.pairs.some(
    (p) => p.controllerResidualH !== undefined || p.controllerResidualV !== undefined,
  );
  const mm = (v: number | undefined) =>
    v === undefined
      ? ''
      : formatQuantity(
          v,
          'distance',
          units.distance === 'm' ? 'mm' : units.distance,
          units.distance === 'm' ? 1 : 3,
        );
  return (
    <table className="site-residuals" data-testid="site-residuals">
      <thead>
        <tr>
          <th>Point</th>
          <th>H</th>
          <th>V</th>
          {controller && <th>Controller H</th>}
          {controller && <th>Controller V</th>}
          <th>Used</th>
        </tr>
      </thead>
      <tbody>
        {cal.pairs.map((p) => (
          <tr key={p.name}>
            <td>{p.name}</td>
            <td className="mono">{mm(p.residualH)}</td>
            <td className="mono">{mm(p.residualV)}</td>
            {controller && <td className="mono">{mm(p.controllerResidualH)}</td>}
            {controller && <td className="mono">{mm(p.controllerResidualV)}</td>}
            <td>{[p.useH ? 'H' : '', p.useV ? 'V' : ''].filter(Boolean).join(' + ') || 'no'}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>RMS</td>
          <td className="mono">{mm(cal.rmsH)}</td>
          <td className="mono">{mm(cal.rmsV)}</td>
          <td colSpan={controller ? 3 : 1} />
        </tr>
      </tfoot>
    </table>
  );
}

function SiteSettingsDialog({ project, onClose }: { project: OpenProject; onClose: () => void }) {
  const dlg = useRef<HTMLDivElement>(null);
  useFocusTrap(dlg, true);
  const [draft, setDraft] = useState<SurveySettings | null>(null);
  const [crsName, setCrsName] = useState(siteDisplay.getState().crsName);
  const [geoids, setGeoids] = useState<GeoidPackMeta[]>([]);
  const [cal, setCal] = useState<SiteCalibration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pairsOpen, setPairsOpen] = useState(false);
  const near = originLonLat(project);

  const readCalibration = async () => {
    const r = await bridge.call('geodesy:readCalibration', { projectId: project.id });
    if (r.ok && r.value.ok) setCal(r.value.calibration);
  };

  useEffect(() => {
    void bridge.call('survey:readSettings', { projectId: project.id }).then((r) => {
      if (!r.ok) setError(r.error);
      else if (!r.value.ok) setError(r.value.error);
      else setDraft(r.value.settings);
    });
    void bridge.call('geoidPacks:list', {}).then((r) => {
      if (r.ok && r.value.ok) setGeoids(r.value.packs);
    });
    void bridge.call('geodesy:readCalibration', { projectId: project.id }).then((r) => {
      if (r.ok && r.value.ok) setCal(r.value.calibration);
    });
  }, [project.id]);

  // the import job: its end reads the calibration back (a draft until Apply)
  useEffect(() => {
    const aio = window.aio as typeof window.aio | undefined;
    if (!jobId || !aio) return;
    return aio.on('jobs:event', (e) => {
      if (e.type !== 'update' || e.job.id !== jobId) return;
      if (e.job.status === 'done') {
        setNote('Calibration read. Check the residuals, then Apply.');
        setJobId(null);
        void readCalibration();
      }
      if (e.job.status === 'failed' || e.job.status === 'cancelled') {
        setNote(null);
        setJobId(null);
        setError(e.job.error ?? 'The calibration could not be read.');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (!draft) {
    return (
      <div className="dlg-scrim">
        <div className="dlg" role="dialog" aria-modal="true" aria-label="Site settings" ref={dlg}>
          <div className="dlg-b">{error ?? 'Reading the site settings…'}</div>
        </div>
      </div>
    );
  }

  const set = (patch: Partial<SurveySettings>) => {
    setDraft({ ...draft, ...patch });
  };
  // the readout tables follow the settings and the calibration: write them again after a change
  const rewriteTables = async (): Promise<boolean> => {
    if (!siteDisplay.getState().stale) return true;
    const err = await refreshSiteTables(project, () => {
      void loadSiteDisplay(project);
    });
    if (err) setError(`The site tables were not written again: ${err}`);
    return err === null;
  };
  const save = async () => {
    setError(null);
    const r = await bridge.call('survey:writeSettings', { projectId: project.id, settings: draft });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.ok) {
      setError(r.value.error);
      return;
    }
    await loadSiteDisplay(project);
    if (await rewriteTables()) onClose();
  };
  const importCalibration = async () => {
    setError(null);
    const pick = await bridge.call('dialog:openFile', {
      title: 'Import a site calibration: a controller job (JobXML) or 12d parameters',
      filters: [{ name: 'JobXML or 12d parameters', extensions: ['jxl', 'xml', 'txt'] }],
    });
    if (!pick.ok) {
      setError(pick.error);
      return;
    }
    if (!pick.value.path) return;
    const crs = draft.crs ?? project.manifest.crs;
    const r = await bridge.call('jobs:start', {
      pipeline: 'geo.calibration',
      project: project.root,
      params: { src: pick.value.path, crs },
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.ok) {
      setError(r.value.error);
      return;
    }
    setJobId(r.value.job.id);
    setNote('Reading the calibration…');
  };
  const computePairs = async (pairs: CalibrationPair[]) => {
    setError(null);
    const crs = draft.crs ?? project.manifest.crs;
    // WGS84 heights are taken to the site's geoid first, as a controller does
    const geoid = draft.verticalDatum.kind === 'geoid' ? draft.verticalDatum.geoid : undefined;
    const r = await bridge.call('jobs:start', {
      pipeline: 'geo.calibration',
      project: project.root,
      params: { pairs, crs, ...(geoid ? { geoid } : {}) },
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.ok) {
      setError(r.value.error);
      return;
    }
    setJobId(r.value.job.id);
    setNote('Computing the calibration from the point pairs…');
  };
  const apply = async (on: boolean) => {
    if (!cal) return;
    setError(null);
    const r = await bridge.call('geodesy:applyCalibration', {
      projectId: project.id,
      calibration: cal,
      apply: on,
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.ok) {
      setError(r.value.error);
      return;
    }
    await readCalibration();
    const s = await bridge.call('survey:readSettings', { projectId: project.id });
    if (s.ok && s.value.ok) setDraft(s.value.settings);
    await loadSiteDisplay(project);
    await rewriteTables();
    setNote(
      on
        ? 'Calibration applied. Results computed before show Stale until recomputed.'
        : 'Calibration removed.',
    );
  };

  const vd = draft.verticalDatum;
  const vdValue = vd.kind === 'geoid' ? `geoid:${vd.geoid}` : vd.kind;
  const applied = Boolean(cal?.appliedAt);

  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dlg}
        className="dlg wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-settings-title"
        data-testid="site-settings"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="dlg-h">
          <Icon name="globe" size={16} />
          <h2 id="site-settings-title">Site settings</h2>
          <span className="sub">How coordinates are shown and exported</span>
          <button type="button" className="btn ghost icon sm" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="dlg-b">
          {error && (
            <p className="notice danger" role="alert">
              <Icon name="warn" size={14} />
              {error}
            </p>
          )}
          {note && (
            <p className="notice" role="status" data-testid="site-note">
              {note}
            </p>
          )}
          <section className="dlg-sec">
            <h3 className="caps">Coordinate system</h3>
            <CrsPicker
              value={crsName}
              near={near}
              onPick={(e) => {
                setCrsName(`${e.name} (EPSG ${String(e.code)})`);
                // decision 12: a site's units follow its CRS's unit; change them below
                set({
                  crs: { epsg: e.code },
                  units: { ...unitsForCrsUnit(e.unit), grade: draft.units.grade },
                });
              }}
            />
            <label className="field">
              <span>Heights</span>
              <select
                className="input"
                data-testid="site-vertical"
                value={vdValue}
                onChange={(e) => {
                  const v = e.target.value;
                  set({
                    verticalDatum: v.startsWith('geoid:')
                      ? { kind: 'geoid', geoid: v.slice(6) }
                      : v === 'ellipsoidal'
                        ? { kind: 'ellipsoidal' }
                        : v === 'calibration'
                          ? { kind: 'calibration' }
                          : { kind: 'project' },
                  });
                }}
              >
                <option value="project">Project heights (as stored)</option>
                <option value="ellipsoidal">Ellipsoidal</option>
                {geoids.map((g) => (
                  <option key={g.id} value={`geoid:${g.id}`}>
                    {g.name} geoid
                  </option>
                ))}
                {vd.kind === 'geoid' && !geoids.some((g) => g.id === vd.geoid) && (
                  <option value={vdValue}>{vd.geoid} geoid (pack not installed)</option>
                )}
                <option value="calibration" disabled={!applied}>
                  Site calibration
                </option>
              </select>
            </label>
            <label className="field">
              <span>Distances</span>
              <select
                className="input"
                value={draft.distances}
                onChange={(e) => {
                  set({ distances: e.target.value === 'ground' ? 'ground' : 'grid' });
                }}
              >
                <option value="grid">Grid</option>
                <option value="ground">Ground</option>
              </select>
            </label>
          </section>

          <section className="dlg-sec">
            <h3 className="caps">Units and precision</h3>
            {(Object.keys(QUANTITY_UNITS) as (keyof SurveyUnits)[]).map((q) => (
              <label className="field" key={q}>
                <span>{QUANTITY_LABEL[q]}</span>
                <select
                  className="input"
                  data-testid={`site-unit-${q}`}
                  value={draft.units[q]}
                  onChange={(e) => {
                    set({ units: { ...draft.units, [q]: e.target.value } });
                  }}
                >
                  {QUANTITY_UNITS[q].map((u) => (
                    <option key={u} value={u}>
                      {unitName(u)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="field">
              <span>Order</span>
              <select
                className="input"
                data-testid="site-order"
                value={draft.order}
                onChange={(e) => {
                  set({ order: e.target.value === 'ENZ' ? 'ENZ' : 'NEZ' });
                }}
              >
                <option value="NEZ">North, East, Z</option>
                <option value="ENZ">East, North, Z</option>
              </select>
            </label>
            {(Object.keys(PRECISION_LABEL) as (keyof typeof PRECISION_LABEL)[]).map((q) => (
              <label className="field" key={q}>
                <span>{PRECISION_LABEL[q]} (decimals)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={6}
                  data-testid={`site-precision-${q}`}
                  value={draft.precision[q]}
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(6, Math.round(Number(e.target.value) || 0)));
                    set({ precision: { ...draft.precision, [q]: v } });
                  }}
                />
              </label>
            ))}
          </section>

          <section className="dlg-sec">
            <h3 className="caps">Site calibration</h3>
            {cal ? (
              <>
                <p className="help" data-testid="site-calibration-state">
                  {cal.name}: {applied ? 'applied' : 'draft, not applied'}
                </p>
                <ResidualTable cal={cal} units={draft.units} />
              </>
            ) : (
              <p className="help">No calibration. Import a controller job to see its residuals.</p>
            )}
            <div className="row">
              <button
                type="button"
                className="btn sm"
                data-testid="site-calibration-import"
                disabled={applied}
                title={
                  applied ? 'Remove the applied calibration before importing another.' : undefined
                }
                onClick={() => void importCalibration()}
              >
                Import calibration…
              </button>
              <button
                type="button"
                className="btn sm"
                data-testid="site-calibration-pairs"
                aria-expanded={pairsOpen}
                disabled={applied}
                title={
                  applied ? 'Remove the applied calibration before computing another.' : undefined
                }
                onClick={() => {
                  setPairsOpen(!pairsOpen);
                }}
              >
                Compute from point pairs…
              </button>
              {cal && !applied && (
                <button
                  type="button"
                  className="btn primary sm"
                  data-testid="site-calibration-apply"
                  onClick={() => void apply(true)}
                >
                  Apply
                </button>
              )}
              {cal && applied && (
                <button type="button" className="btn sm" onClick={() => void apply(false)}>
                  Remove calibration
                </button>
              )}
            </div>
            {pairsOpen && !applied && (
              <CalibrationPairsEditor
                initial={cal?.source.format === 'pairs' ? rowsOfPairs(cal.pairs) : null}
                busy={jobId !== null}
                onCompute={(pairs) => void computePairs(pairs)}
                onClose={() => {
                  setPairsOpen(false);
                }}
              />
            )}
          </section>
        </div>
        <div className="dlg-f">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="site-settings-save"
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** The small **Site settings** button the cursor readout carries, and its dialog. */
export function SiteSettingsButton() {
  const project = useWorkspace((s) => s.project);
  const open = useSiteDisplay((s) => s.open);
  useSiteDisplayLoader();
  if (!project) return null;
  return (
    <>
      <button
        type="button"
        className="btn ghost sm site-settings-btn"
        data-testid="site-settings-open"
        title="Site settings: coordinate system, heights, units and calibration"
        onClick={() => {
          siteDisplay.setState({ open: true });
        }}
      >
        <Icon name="globe" size={12} />
        Site settings
      </button>
      {open && (
        <SiteSettingsDialog
          project={project}
          onClose={() => {
            siteDisplay.setState({ open: false });
          }}
        />
      )}
    </>
  );
}

/** For tests and the agent: open the dialog for the current project. */
export function openSiteSettings(): void {
  if (workspace.getState().project) siteDisplay.setState({ open: true });
}
