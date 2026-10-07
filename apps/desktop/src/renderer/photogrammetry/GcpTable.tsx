/**
 * Ground control of a run (G4): import a CSV or TXT with a column mapping and an EPSG code, see
 * the points on the map before saving, then a table of points (role, accuracy, marks) and the
 * marker view. **Adjust** starts `photo.georef` once every control point has three confirmed marks.
 */
import { crsOption, searchCrs } from '@aio/geo';
import { LocationPicker } from '@aio/maps';
import type { GcpFile, GcpPoint, PhotoRun } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { bridge, useJobs } from '../shell';
import { isActive } from '../jobs';
import { startGeoref } from './actions';
import {
  COLUMN_LABELS,
  guessMapping,
  mapsDegrees,
  readTable,
  toGcpFile,
  type Column,
  type GcpTable,
} from './gcpCsv';
import { GcpMarker } from './GcpMarker';
import { adjustProblems, confirmedMarks, draftMarks, gcpLonLat, MIN_MARKS } from './marks';
import { jobsOfRun, photoUi } from './store';

export function GcpPanel({ run, data }: { run: string; data: PhotoRun | null }) {
  const project = useWorkspace((s) => s.project);
  const [gcp, setGcp] = useState<GcpFile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [importing, setImporting] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const allJobs = useJobs((s) => s.jobs);
  const georef = jobsOfRun(allJobs, project?.root ?? '', run).find(
    (j) => j.pipeline === 'photo.georef',
  );

  useEffect(() => {
    if (!project) return;
    let live = true;
    void bridge.call('photo:readGcp', { projectId: project.id, run }).then((r) => {
      if (!live) return;
      setLoaded(true);
      if (!r.ok) setError(r.error);
      else if (!r.value.ok) setError(r.value.error);
      else setGcp(r.value.gcp);
    });
    return () => {
      live = false;
    };
  }, [project, run]);

  if (!project) return null;

  /** Save the whole file (atomic, with a .bak in main); the panel shows what was saved. */
  const save = async (next: GcpFile): Promise<boolean> => {
    const r = await bridge.call('photo:writeGcp', { projectId: project.id, run, gcp: next });
    const err = !r.ok ? r.error : r.value.ok ? null : r.value.error;
    setError(err);
    if (!err) setGcp(next);
    return !err;
  };

  if (!loaded) return <p className="faint small">Reading ground control</p>;
  if (!data)
    return (
      <p className="small faint">Ground control can be imported once the alignment has started.</p>
    );
  if (importing || !gcp)
    return (
      <GcpImport
        projectEpsg={'epsg' in project.manifest.crs ? project.manifest.crs.epsg : 4326}
        replacing={gcp !== null}
        onCancel={
          gcp
            ? () => {
                setImporting(false);
              }
            : null
        }
        onSave={async (f) => {
          if (await save(f)) {
            setImporting(false);
            setNotice(
              `${String(f.points.length)} points imported from ${f.importedFrom ?? 'the file'}.`,
            );
          }
        }}
      />
    );

  const point = marking ? gcp.points.find((p) => p.id === marking) : undefined;
  if (point)
    return (
      <GcpMarker
        key={point.id}
        run={data}
        gcp={gcp}
        point={point}
        onSave={save}
        onBack={() => {
          setMarking(null);
        }}
        onPoint={(id) => {
          setMarking(id);
        }}
      />
    );

  const problems = adjustProblems(gcp);
  const update = (p: GcpPoint) =>
    void save({ ...gcp, points: gcp.points.map((q) => (q.id === p.id ? p : q)) });
  const adjusting = georef ? isActive(georef) : false;

  return (
    <div className="ph-gcp" data-testid="gcp-table">
      <div className="ph-gcp-h">
        <p className="small">
          {gcp.points.length} points from{' '}
          <span className="mono">{gcp.importedFrom ?? 'a file'}</span> in{' '}
          {crsOption('epsg' in gcp.crs ? gcp.crs.epsg : 0)?.name ?? 'their CRS'}. Checkpoints are
          measured, never used in the adjustment.
        </p>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            setImporting(true);
          }}
        >
          <Icon name="import" size={14} />
          Import again
        </button>
      </div>
      {notice && (
        <p className="notice ok small" role="status">
          <Icon name="check" size={14} />
          {notice}
        </p>
      )}
      <table className="ph-table">
        <caption className="sr-only">Ground control points</caption>
        <thead>
          <tr>
            <th scope="col">Point</th>
            <th scope="col">Role</th>
            <th scope="col">Accuracy</th>
            <th scope="col">Marks</th>
            <th scope="col">Use</th>
            <th scope="col">
              <span className="sr-only">Mark</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {gcp.points.map((p) => {
            const n = confirmedMarks(p).length;
            const drafts = draftMarks(p).length;
            return (
              <tr key={p.id} data-point={p.id} className={p.disabled ? 'off' : ''}>
                <th scope="row" className="mono">
                  {p.id}
                </th>
                <td>
                  <select
                    className="input sm"
                    value={p.role}
                    aria-label={`Role of ${p.id}`}
                    onChange={(e) => {
                      update({ ...p, role: e.target.value === 'check' ? 'check' : 'control' });
                    }}
                  >
                    <option value="control">Control</option>
                    <option value="check">Check</option>
                  </select>
                </td>
                <td className="mono small">
                  {(p.accuracy.horizontalM * 100).toFixed(1)} /{' '}
                  {(p.accuracy.verticalM * 100).toFixed(1)} cm
                </td>
                <td className={n >= MIN_MARKS ? 'ok' : ''} data-testid={`marks-${p.id}`}>
                  {n} confirmed{drafts ? `, ${String(drafts)} draft` : ''}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={!p.disabled}
                    aria-label={`Use ${p.id}`}
                    onChange={(e) => {
                      const next: GcpPoint = { ...p, disabled: true };
                      if (e.target.checked) delete next.disabled;
                      update(next);
                    }}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setMarking(p.id);
                    }}
                  >
                    Mark {p.id}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {problems.length > 0 && (
        <ul className="ph-warn small" aria-label="Before adjusting">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="notice danger small" role="alert">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
      <div className="ph-acts">
        <button
          type="button"
          className="btn primary"
          data-testid="gcp-adjust"
          disabled={problems.length > 0 || adjusting}
          onClick={() => {
            void startGeoref(project.root, run).then((err) => {
              setError(err);
              if (!err) photoUi.getState().setTab('progress');
            });
          }}
        >
          <Icon name="target" size={14} />
          {adjusting ? 'Adjusting' : 'Adjust'}
        </button>
      </div>
    </div>
  );
}

function GcpImport({
  projectEpsg,
  replacing,
  onCancel,
  onSave,
}: {
  projectEpsg: number;
  replacing: boolean;
  onCancel: (() => void) | null;
  onSave: (f: GcpFile) => Promise<void>;
}) {
  const [table, setTable] = useState<GcpTable | null>(null);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Column[]>([]);
  const [epsg, setEpsg] = useState(projectEpsg);
  const [crsQuery, setCrsQuery] = useState('');
  const [accH, setAccH] = useState('2');
  const [accV, setAccV] = useState('3');
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = async (file: File) => {
    try {
      const t = readTable(await file.text());
      setTable(t);
      setFileName(file.name);
      setMapping(guessMapping(t));
      if (t.odm?.epsg) setEpsg(t.odm.epsg);
      setReadError(null);
    } catch (e) {
      setReadError(e instanceof Error ? e.message : String(e));
      setTable(null);
    }
  };

  const result = useMemo(
    () =>
      table
        ? toGcpFile(table, mapping, {
            epsg,
            accuracy: {
              horizontalM: Math.max(0.001, Number(accH) / 100 || 0.02),
              verticalM: Math.max(0.001, Number(accV) / 100 || 0.03),
            },
            fileName,
            now: new Date(),
          })
        : null,
    [table, mapping, epsg, accH, accV, fileName],
  );
  const lonLats = useMemo(() => {
    const f = result?.file;
    if (!f) return [];
    const e = 'epsg' in f.crs ? f.crs.epsg : 4326;
    return f.points.map((p) => gcpLonLat(p, e)).filter((x): x is [number, number] => x !== null);
  }, [result]);
  const width = Math.max(0, ...(table?.rows.map((r) => r.length) ?? [0]));
  const degrees = mapsDegrees(mapping);

  return (
    <div className="ph-import" data-testid="gcp-import">
      <header role="none">
        <h3>{replacing ? 'Import ground control again' : 'Import ground control'}</h3>
        <p className="small faint">
          A CSV or TXT of point ids and coordinates (Pix4D and ODM lists too). Check the columns and
          the coordinate system: the points show on the map before anything is saved.
        </p>
      </header>
      <label className="b-field">
        <span>GCP file</span>
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          data-testid="gcp-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
          }}
        />
      </label>
      {readError && (
        <p className="notice danger small" role="alert">
          <Icon name="warn" size={14} />
          {readError}
        </p>
      )}
      {table && (
        <>
          <div className="ph-map-row">
            <div className="ph-preview">
              <table className="ph-table">
                <caption className="sr-only">Columns of {fileName}</caption>
                <thead>
                  <tr>
                    {Array.from({ length: width }, (_, i) => (
                      <th key={i} scope="col">
                        <select
                          className="input sm"
                          aria-label={`Column ${String(i + 1)}${table.header?.[i] ? ` (${table.header[i]})` : ''}`}
                          value={mapping[i] ?? 'skip'}
                          onChange={(e) => {
                            const next = [...mapping];
                            while (next.length < width) next.push('skip');
                            next[i] = e.target.value as Column;
                            setMapping(next);
                          }}
                        >
                          {(Object.keys(COLUMN_LABELS) as Column[]).map((c) => (
                            <option key={c} value={c}>
                              {COLUMN_LABELS[c]}
                            </option>
                          ))}
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.slice(0, 6).map((r, i) => (
                    <tr key={i}>
                      {Array.from({ length: width }, (_, k) => (
                        <td key={k} className="mono small">
                          {r[k] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {table.rows.length > 6 && (
                <p className="small faint">and {table.rows.length - 6} more rows</p>
              )}
            </div>
            <LocationPicker className="ph-map" points={lonLats} onPick={() => undefined} />
          </div>
          <div className="b-row">
            <div className="b-field">
              <span>Coordinate system of the file</span>
              {degrees ? (
                <p className="small">WGS 84 latitude and longitude (EPSG:4326)</p>
              ) : (
                <>
                  <input
                    className="input"
                    type="search"
                    value={crsQuery}
                    placeholder="Search zone, country or EPSG code"
                    aria-label="Search the GCP file's CRS"
                    onChange={(e) => {
                      setCrsQuery(e.target.value);
                    }}
                  />
                  <div className="b-list" role="listbox" aria-label="GCP file CRS">
                    {[
                      epsg,
                      ...searchCrs(crsQuery)
                        .map((c) => c.epsg)
                        .filter((c) => c !== epsg),
                    ].map((code) => (
                      <button
                        key={code}
                        type="button"
                        role="option"
                        aria-selected={code === epsg}
                        onClick={() => {
                          setEpsg(code);
                        }}
                      >
                        <span>{crsOption(code)?.name ?? `EPSG:${String(code)}`}</span>
                        <span className="mono">EPSG:{code}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="b-field">
              <span>Accuracy when the file has none (cm)</span>
              <div className="b-row">
                <label className="small">
                  Horizontal
                  <input
                    className="input"
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={accH}
                    onChange={(e) => {
                      setAccH(e.target.value);
                    }}
                  />
                </label>
                <label className="small">
                  Vertical
                  <input
                    className="input"
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={accV}
                    onChange={(e) => {
                      setAccV(e.target.value);
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
          {result?.warnings.map((w) => (
            <p key={w} className="notice warn small">
              <Icon name="warn" size={14} />
              {w}
            </p>
          ))}
          {result?.errors.slice(0, 8).map((w) => (
            <p key={w} className="notice danger small" role="alert">
              <Icon name="warn" size={14} />
              {w}
            </p>
          ))}
        </>
      )}
      <div className="ph-acts">
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          data-testid="gcp-save"
          disabled={!result?.file || busy}
          onClick={() => {
            const f = result?.file;
            if (!f) return;
            setBusy(true);
            void onSave(f).finally(() => {
              setBusy(false);
            });
          }}
        >
          <Icon name="check" size={14} />
          {result?.file ? `Save ${String(result.file.points.length)} points` : 'Save points'}
        </button>
      </div>
    </div>
  );
}
