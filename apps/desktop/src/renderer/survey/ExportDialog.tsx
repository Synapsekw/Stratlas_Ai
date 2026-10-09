/**
 * **Export survey data** (M11 G7, SRV-9, DSN-5): a surface, ortho, point cloud, contours,
 * measurements or sections as LandXML, DXF, 12da, GeoTIFF, LAZ, CSV, KMZ, SHP or GeoJSON, in the
 * site grid (calibrated when a calibration applies), WGS 84 or an EPSG code, in metres, feet or US
 * survey feet. The destination is asked for first (`dialog:savePath`, or a folder for one file per
 * measurement) and passed to `survey.export` as `out`, so nothing is written into the project. The
 * offered file name carries the export's suffix (`_site-grid_usft` and so on).
 */
import type { HeightTiles, IpcResponse } from '@aio/schema';
import { unitName } from '@aio/geo';
import { Icon, useFocusTrap } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge, useShell } from '../shell';
import { Tool } from '../workspace/StageTools';
import { loadDesigns, useDesigns } from './designsStore';
import {
  DETAIL,
  exportFileName,
  exportParams,
  exportProblem,
  FORMAT_LABELS,
  hasDetail,
  MATRIX,
  measurementIds,
  defaultUnits,
  siteSuffix,
  sourcesFor,
  WHAT_LABELS,
  type ExportChoice,
  type ExportCrs,
  type ExportFormat,
  type ExportUnits,
  type ExportWhat,
} from './exportHelpers';
import { useMeasure } from './measureStore';
import { useOverlays } from './overlaysStore';
import { waitForJob } from './sectionStore';
import './export.css';

const ui = createStore<{ open: boolean }>()(() => ({ open: false }));

export function openExportDialog(open: boolean): void {
  ui.setState({ open });
}

/** The entry in the Survey measurements popover (Site data). */
export function ExportTool({ onPicked }: { onPicked?: () => void } = {}) {
  const open = useStore(ui, (s) => s.open);
  const pkg = useShell((s) => s.pkg);
  // a package is read only: player mode never starts a pipeline
  if (pkg) return null;
  return (
    <Tool
      icon="download"
      label="Export survey data"
      testId="survey-export-open"
      pressed={open}
      onClick={() => {
        openExportDialog(!open);
        onPicked?.();
      }}
    />
  );
}

/** Mounted with the toolbar; shows the dialog while it is open. */
export function ExportDialogMount() {
  const open = useStore(ui, (s) => s.open);
  return open ? <ExportDialog /> : null;
}

type MeasureChoice = 'selected' | 'all' | `folder:${string}`;
type CrsKind = 'site' | 'wgs84' | 'epsg';

const WHATS: ExportWhat[] = ['surface', 'ortho', 'cloud', 'contours', 'measurements', 'section'];
const UNITS: ExportUnits[] = ['m', 'ft', 'us-ft'];

export function ExportDialog() {
  const project = useWorkspace((s) => s.project);
  const settings = useMeasure((s) => s.settings);
  const mfile = useMeasure((s) => s.file);
  const selected = useMeasure((s) => s.selected);
  const designsFile = useDesigns((s) => s.file);
  const overlaysFile = useOverlays((s) => s.file);
  const [surfaces, setSurfaces] = useState<HeightTiles[]>([]);
  const [what, setWhat] = useState<ExportWhat>('surface');
  const [format, setFormat] = useState<ExportFormat>('landxml');
  const [sourceKey, setSourceKey] = useState('');
  const [crsKind, setCrsKind] = useState<CrsKind>('site');
  const [epsg, setEpsg] = useState('');
  const [units, setUnits] = useState<ExportUnits>(() => defaultUnits(settings));
  const [detail, setDetail] = useState(1);
  const [pick, setPick] = useState<MeasureChoice>(selected.length ? 'selected' : 'all');
  const [surface, setSurface] = useState('');
  const [each, setEach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    openExportDialog(false);
  };
  useFocusTrap(ref, true, { onEscape: close });

  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!projectId) return;
    void bridge.call('survey:surfaces', { projectId }).then((r) => {
      if (r.ok && r.value.ok) setSurfaces(r.value.surfaces);
    });
    if (!designsFile) void loadDesigns(projectId);
  }, [projectId, designsFile]);

  const sources = useMemo(
    () =>
      sourcesFor(what, {
        surfaces,
        designs: designsFile,
        overlays: overlaysFile,
        manifest: project?.manifest ?? null,
      }),
    [what, surfaces, designsFile, overlaysFile, project],
  );
  const source = sources.find((s) => s.key === sourceKey) ?? sources[0] ?? null;
  const folders = useMemo(
    () =>
      [...new Set(mfile.measurements.map((m) => m.folder).filter((f): f is string => !!f))].sort(),
    [mfile],
  );
  const ids = useMemo(() => {
    if (what !== 'measurements' && what !== 'section') return [];
    const choice =
      pick === 'selected'
        ? { kind: 'selected' as const, ids: selected }
        : pick === 'all'
          ? { kind: 'all' as const }
          : { kind: 'folder' as const, folder: pick.slice('folder:'.length) };
    return measurementIds(mfile, choice, what === 'section');
  }, [what, pick, selected, mfile]);

  const crs: ExportCrs = crsKind === 'epsg' ? { epsg: Number.parseInt(epsg, 10) || 0 } : crsKind;
  const choice: ExportChoice = {
    what,
    format,
    crs,
    units,
    detail,
    source: what === 'measurements' || what === 'section' ? null : source,
    measurements: ids,
    surface: surface || null,
  };
  const problem = exportProblem(choice);
  const suffix = siteSuffix(settings, crs, units);
  const baseName =
    what === 'measurements' || what === 'section'
      ? pick.startsWith('folder:')
        ? pick.slice('folder:'.length)
        : WHAT_LABELS[what]
      : (source?.label ?? WHAT_LABELS[what]);
  const fileName = exportFileName(baseName, suffix, format);
  const perItem = (what === 'measurements' || what === 'section') && each;

  const pickWhat = (w: ExportWhat) => {
    setWhat(w);
    setSourceKey('');
    const f = MATRIX[w][0] ?? 'csv';
    pickFormat(f);
  };
  const pickFormat = (f: ExportFormat) => {
    setFormat(f);
    if (f === 'kml') {
      setCrsKind('wgs84');
      setUnits('m');
    } else if ((f === 'dxf' || f === 'landxml' || f === '12da') && crsKind === 'wgs84') {
      setCrsKind('site');
    }
  };

  const run = async () => {
    if (!project || problem) return;
    setNote(null);
    let out: string | null;
    if (perItem) {
      const r = await bridge.call('dialog:openFolder', { title: 'Folder for one file each' });
      out = r.ok ? r.value.path : null;
      if (!r.ok) {
        setNote({ text: r.error, error: true });
        return;
      }
    } else {
      const ext = fileName.slice(fileName.lastIndexOf('.') + 1);
      const r = await bridge.call('dialog:savePath', {
        defaultName: fileName,
        title: `Export ${WHAT_LABELS[what].toLowerCase()} as ${FORMAT_LABELS[format]}`,
        filters: [{ name: FORMAT_LABELS[format], extensions: [ext] }],
      });
      if (!r.ok) {
        setNote({ text: r.error, error: true });
        return;
      }
      if (r.value.error) {
        setNote({ text: r.value.error, error: true });
        return;
      }
      out = r.value.path;
    }
    if (!out) return;
    setBusy(true);
    setNote({ text: 'Exporting…', error: false });
    const r = await bridge.call('jobs:start', {
      pipeline: 'survey.export',
      project: project.root,
      params: exportParams(choice, out),
    });
    const fail = (text: string) => {
      setBusy(false);
      setNote({ text, error: true });
    };
    if (!r.ok) {
      fail(r.error);
      return;
    }
    const started: IpcResponse<'jobs:start'> = r.value;
    if (!started.ok) {
      fail(started.error);
      return;
    }
    const done = await waitForJob(started.job.id);
    if (!done.ok) {
      fail(done.error);
      return;
    }
    setBusy(false);
    setNote({ text: `Saved ${out}`, error: false });
  };

  return (
    <div
      ref={ref}
      className="sv-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sv-export-title"
      data-testid="survey-export-dialog"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="sv-dialog sv-export">
        <header className="sv-head" role="none">
          <h2 id="sv-export-title">Export survey data</h2>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <p className="small faint">
          For Civil 3D, Trimble Business Center, 12d and GIS. You choose where the file goes first;
          nothing is kept in the project.
        </p>
        <div className="sv-export-grid">
          <label className="sv-field">
            <span>Export</span>
            <select
              className="sv-input"
              value={what}
              data-testid="survey-export-what"
              onChange={(e) => {
                pickWhat(e.target.value as ExportWhat);
              }}
            >
              {WHATS.map((w) => (
                <option key={w} value={w}>
                  {WHAT_LABELS[w]}
                </option>
              ))}
            </select>
          </label>
          {what === 'measurements' || what === 'section' ? (
            <label className="sv-field">
              <span>{what === 'section' ? 'Along' : 'Which'}</span>
              <select
                className="sv-input"
                value={pick}
                data-testid="survey-export-measurements"
                onChange={(e) => {
                  setPick(e.target.value as MeasureChoice);
                }}
              >
                <option value="selected">Selected ({selected.length})</option>
                <option value="all">All {what === 'section' ? 'lines' : 'measurements'}</option>
                {folders.map((f) => (
                  <option key={f} value={`folder:${f}`}>
                    Folder: {f}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="sv-field">
              <span>From</span>
              <select
                className="sv-input"
                value={source?.key ?? ''}
                data-testid="survey-export-source"
                onChange={(e) => {
                  setSourceKey(e.target.value);
                }}
              >
                {sources.length === 0 && <option value="">Nothing to export yet</option>}
                {sources.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(what === 'measurements' || what === 'section') && (
            <label className="sv-field">
              <span>{what === 'section' ? 'Surface' : 'Terrain inside polygons'}</span>
              <select
                className="sv-input"
                value={surface}
                data-testid="survey-export-surface"
                onChange={(e) => {
                  setSurface(e.target.value);
                }}
              >
                <option value="">
                  {what === 'section' ? 'Current survey' : 'None (outlines only)'}
                </option>
                {surfaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="sv-field">
            <span>Format</span>
            <select
              className="sv-input"
              value={format}
              data-testid="survey-export-format"
              onChange={(e) => {
                pickFormat(e.target.value as ExportFormat);
              }}
            >
              {MATRIX[what].map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="sv-field">
            <span>Coordinates</span>
            <select
              className="sv-input"
              value={crsKind}
              data-testid="survey-export-crs"
              onChange={(e) => {
                setCrsKind(e.target.value as CrsKind);
              }}
            >
              <option value="site">Site grid{settings.calibration ? ' (calibrated)' : ''}</option>
              <option value="wgs84">WGS 84 (longitude, latitude)</option>
              <option value="epsg">EPSG code…</option>
            </select>
          </label>
          {crsKind === 'epsg' && (
            <label className="sv-field">
              <span>EPSG code</span>
              <input
                className="sv-input mono"
                inputMode="numeric"
                value={epsg}
                placeholder="32639"
                data-testid="survey-export-epsg"
                onChange={(e) => {
                  setEpsg(e.target.value.replace(/\D/g, '').slice(0, 6));
                }}
              />
            </label>
          )}
          <label className="sv-field">
            <span>Units</span>
            <select
              className="sv-input"
              value={units}
              data-testid="survey-export-units"
              onChange={(e) => {
                setUnits(e.target.value as ExportUnits);
              }}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {unitName(u)}
                </option>
              ))}
            </select>
          </label>
          {hasDetail(what, format) && (
            <label className="sv-field">
              <span>Level of detail</span>
              <select
                className="sv-input"
                value={String(detail)}
                data-testid="survey-export-detail"
                onChange={(e) => {
                  setDetail(Number(e.target.value));
                }}
              >
                {DETAIL.map((d) => (
                  <option key={d.id} value={String(d.share)}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {(what === 'measurements' || what === 'section') && (
          <label className="sv-check">
            <input
              type="checkbox"
              checked={each}
              data-testid="survey-export-each"
              onChange={(e) => {
                setEach(e.target.checked);
              }}
            />
            One file per {what === 'section' ? 'section' : 'measurement'} (choose a folder)
          </label>
        )}
        <p className="small faint">
          {perItem ? 'Each file is named ' : 'Offered as '}
          <code className="mono" data-testid="survey-export-name">
            {perItem
              ? `<label>${suffix}.${fileName.slice(fileName.lastIndexOf('.') + 1)}`
              : fileName}
          </code>
          . The file states its coordinate system, vertical datum, geoid, calibration and units.
        </p>
        {problem && !note && (
          <p className="small faint" data-testid="survey-export-problem">
            {problem}
          </p>
        )}
        {note && (
          <p
            className={note.error ? 'notice danger small' : 'small faint'}
            data-testid="survey-export-note"
            role="status"
          >
            {note.error && <Icon name="warn" size={14} />}
            {note.text}
          </p>
        )}
        <footer className="sv-foot" role="none">
          <span className="sv-grow" />
          <button type="button" className="btn sm ghost" onClick={close}>
            Close
          </button>
          <button
            type="button"
            className="btn sm primary"
            data-testid="survey-export-run"
            disabled={busy || problem !== null || !project}
            onClick={() => {
              void run();
            }}
          >
            <Icon name="download" size={12} /> Export…
          </button>
        </footer>
      </div>
    </div>
  );
}
