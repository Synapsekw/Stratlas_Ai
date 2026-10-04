import {
  COUNTRIES,
  estimatePackBytes,
  packIdFor,
  PackCoverage,
  regionById,
  type Bbox,
} from '@aio/maps';
import type { MapPackInfo, PackJob } from '@aio/schema';
import { formatBytes, formatDate, Icon, t } from '@aio/ui';
import { useEffect, useMemo, useState } from 'react';
import { bridge, useShell } from '../../shell';

const ZOOMS: { z: number; hint: string }[] = [
  { z: 6, hint: 'country overview' },
  { z: 8, hint: 'cities and main roads' },
  { z: 10, hint: 'towns and roads' },
  { z: 12, hint: 'streets' },
  { z: 13, hint: 'streets and names' },
  { z: 14, hint: 'buildings' },
  { z: 15, hint: 'full detail' },
];

const SOURCE_LABEL: Record<NonNullable<MapPackInfo['source']>, string> = {
  download: 'Downloaded',
  import: 'Imported',
  'build-tool': 'Built',
  package: t('settings.maps.fromPackage'),
};

const STATE_LABEL: Record<PackJob['state'], string> = {
  running: 'Downloading',
  verifying: 'Verifying',
  done: 'Installed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

const fmtBox = (b: readonly number[]) => b.map((v) => v.toFixed(2)).join(', ');

function usePacks(dataRoot: string) {
  const [packs, setPacks] = useState<MapPackInfo[] | null>(null);
  const [jobs, setJobs] = useState<PackJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([bridge.call('packs:list', {}), bridge.call('packs:jobs', {})]).then(
      ([p, j]) => {
        if (!live) return;
        if (p.ok) setPacks(p.value);
        else setError(p.error);
        if (j.ok) setJobs(j.value);
      },
    );
    return () => {
      live = false;
    };
  }, [dataRoot, rev]);

  useEffect(
    () =>
      window.aio.on('packs:job', (job) => {
        setJobs((all) => [...all.filter((j) => j.id !== job.id), job]);
        if (job.state === 'done') setRev((n) => n + 1);
      }),
    [],
  );

  return {
    packs,
    jobs,
    error,
    setError,
    refresh: () => {
      setRev((n) => n + 1);
    },
  };
}

function JobRow({ job, onChange }: { job: PackJob; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (channel: 'packs:cancel' | 'packs:resume' | 'packs:dismiss') => {
    setBusy(true);
    const r = await bridge.call(channel, { id: job.id });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error ?? 'That did not work.');
    else {
      setError(null);
      onChange();
    }
  };
  const active = job.state === 'running' || job.state === 'verifying';
  const pct = Math.round(job.progress * 100);
  return (
    <div className="pack-job" data-state={job.state} data-testid="pack-job">
      <div className="pj-head">
        <Icon name={active ? 'download' : job.state === 'done' ? 'check' : 'warn'} size={14} />
        <b dir="auto">{job.label}</b>
        <span className="mono faint">
          z{job.maxZoom} · {fmtBox(job.bbox)}
        </span>
        <span className="pj-state">
          {STATE_LABEL[job.state]}
          {job.state === 'running' && ` ${String(pct)}%`}
          {job.bytes ? ` · ${formatBytes(job.bytes)}` : ''}
        </span>
        <span className="pj-acts">
          {active && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => void act('packs:cancel')}
            >
              Cancel
            </button>
          )}
          {(job.state === 'failed' || job.state === 'cancelled' || job.state === 'interrupted') && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => void act('packs:resume')}
            >
              {job.state === 'interrupted' ? t('settings.maps.resume') : t('settings.maps.again')}
            </button>
          )}
          {!active && (
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => void act('packs:dismiss')}
            >
              Dismiss
            </button>
          )}
        </span>
      </div>
      {active && (
        <div
          className="pj-bar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${job.label} download`}
        >
          <i style={{ width: `${String(job.state === 'verifying' ? 100 : pct)}%` }} />
        </div>
      )}
      {job.error && <p className="prov-err">{job.error}</p>}
      {job.state === 'interrupted' && (
        <p className="help">
          {t('settings.maps.interrupted', {
            size: formatBytes(job.bytes ?? 0),
            build: job.build ?? '',
          })}
        </p>
      )}
      {error && <p className="prov-err">{error}</p>}
    </div>
  );
}

function AddRegion({
  offlineOnly,
  draft,
  setDraft,
  drawing,
  setDrawing,
  onStarted,
}: {
  offlineOnly: boolean;
  draft: Bbox | null;
  setDraft: (b: Bbox | null) => void;
  drawing: boolean;
  setDrawing: (on: boolean) => void;
  onStarted: () => void;
}) {
  const [mode, setMode] = useState<'country' | 'draw'>('country');
  const [country, setCountry] = useState('');
  const [label, setLabel] = useState('');
  const [maxZoom, setMaxZoom] = useState(12);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const estimate = useMemo(
    () => (draft ? estimatePackBytes(draft, maxZoom) : null),
    [draft, maxZoom],
  );
  const gcc = COUNTRIES.filter((c) => c.group === 'gcc');
  const world = COUNTRIES.filter((c) => c.group === 'world');

  const pickCountry = (id: string) => {
    setCountry(id);
    const r = regionById(id);
    setDraft(r ? r.bbox : null);
    if (r) setLabel(r.label);
  };

  const start = async () => {
    if (!draft) return;
    const name = label.trim() || 'Custom region';
    setBusy(true);
    const r = await bridge.call('packs:download', {
      id: packIdFor(name, maxZoom),
      label: name,
      bbox: draft,
      maxZoom,
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error ?? 'The download did not start.');
    else {
      setError(null);
      setDrawing(false);
      onStarted();
    }
  };

  return (
    <div className="add-region" data-testid="add-region">
      <p className="notice online" role="note">
        <Icon name="globe" size={14} />
        <span>{t('settings.maps.online')}</span>
      </p>
      {offlineOnly && (
        <p className="notice warn">
          <Icon name="warn" size={14} />
          {t('settings.maps.offlineOnly')}
        </p>
      )}
      <div className="ar-grid">
        <span className="ar-l">Area</span>
        <div className="seg" role="group" aria-label="How to choose the area">
          <button
            type="button"
            aria-pressed={mode === 'country'}
            onClick={() => {
              setMode('country');
              setDrawing(false);
            }}
          >
            Country
          </button>
          <button
            type="button"
            aria-pressed={mode === 'draw'}
            onClick={() => {
              setMode('draw');
              setDrawing(true);
              if (!label || regionById(country)?.label === label) setLabel('Custom region');
            }}
          >
            Draw a box
          </button>
        </div>
        {mode === 'country' ? (
          <select
            className="input"
            aria-label="Country"
            value={country}
            onChange={(e) => {
              pickCountry(e.target.value);
            }}
          >
            <option value="">Choose a country</option>
            <optgroup label="GCC">
              {gcc.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="World">
              {world.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </optgroup>
          </select>
        ) : (
          <span className="help ar-draw">
            {drawing ? 'Drag on the map to draw the box.' : 'Box drawn. Drag again to replace it.'}
          </span>
        )}
        <span className="ar-l">Bounds</span>
        <span className="mono" data-testid="draft-bbox">
          {draft ? fmtBox(draft) : 'None yet'}
        </span>
        <span />
        <span className="ar-l">Name</span>
        <input
          className="input"
          aria-label="Pack name"
          value={label}
          maxLength={80}
          placeholder="Region name"
          onChange={(e) => {
            setLabel(e.target.value);
          }}
        />
        <span />
        <span className="ar-l">Detail</span>
        <select
          className="input"
          aria-label="Maximum zoom"
          value={maxZoom}
          onChange={(e) => {
            setMaxZoom(Number(e.target.value));
          }}
        >
          {ZOOMS.map(({ z, hint }) => (
            <option key={z} value={z}>
              Zoom {z}: {hint}
            </option>
          ))}
        </select>
        <span />
        <span className="ar-l">Size</span>
        <span data-testid="pack-estimate">
          {estimate ? (
            <>
              About <b className="hi">{formatBytes(estimate.bytes)}</b>{' '}
              <span className="faint">
                ({formatBytes(estimate.low)} to {formatBytes(estimate.high)},{' '}
                {estimate.tiles.toLocaleString('en')} tiles)
              </span>
            </>
          ) : (
            <span className="faint">Choose an area first</span>
          )}
        </span>
        <span />
      </div>
      {error && (
        <p className="prov-err" role="alert">
          {error}
        </p>
      )}
      <div className="ar-acts">
        <button
          type="button"
          className="btn primary"
          disabled={busy || offlineOnly || !draft}
          onClick={() => void start()}
        >
          <Icon name="download" size={14} />
          Download {draft && estimate ? `about ${formatBytes(estimate.bytes)}` : ''}
        </button>
      </div>
    </div>
  );
}

export function MapPacks() {
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const { packs, jobs, error, setError, refresh } = usePacks(dataRoot);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Bbox | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [focus, setFocus] = useState<Bbox | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const total = packs?.reduce((n, p) => n + p.sizeBytes, 0) ?? 0;

  const importPack = async () => {
    const pick = await bridge.call('dialog:openFile', {
      title: 'Import a map pack',
      filters: [{ name: 'Map pack', extensions: ['pmtiles'] }],
    });
    if (!pick.ok) {
      setError(pick.error);
      return;
    }
    if (!pick.value.path) return;
    setImporting(true);
    const r = await bridge.call('packs:import', { path: pick.value.path });
    setImporting(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else {
      setError(null);
      setHighlight(r.value.pack.id);
      setFocus(r.value.pack.bbox);
      refresh();
    }
  };

  const remove = async (id: string) => {
    const r = await bridge.call('packs:remove', { id });
    setConfirm(null);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error ?? 'The pack was not removed.');
    else {
      setError(null);
      refresh();
    }
  };

  return (
    <>
      <div className="sblock">
        <h2>
          Installed packs{' '}
          <span className="sub">
            {packs
              ? t('settings.maps.installed', { count: packs.length, size: formatBytes(total) })
              : ''}
          </span>
          <span className="acts">
            <button
              type="button"
              className="btn sm"
              disabled={importing}
              onClick={() => void importPack()}
            >
              <Icon name="import" size={14} />
              {importing ? 'Importing' : t('settings.maps.import')}
            </button>
            <button
              type="button"
              className="btn sm primary"
              aria-expanded={adding}
              onClick={() => {
                setAdding(!adding);
                if (adding) {
                  setDraft(null);
                  setDrawing(false);
                }
              }}
            >
              <Icon name="plus" size={14} />
              {t('settings.maps.add')}
            </button>
          </span>
        </h2>
        {error && (
          <p className="notice warn" role="alert">
            <Icon name="warn" size={14} />
            {error}
          </p>
        )}
        <div className={adding ? 'packs-top adding' : 'packs-top'}>
          <PackCoverage
            className="pack-map"
            packs={packs ?? []}
            highlight={highlight}
            draft={draft}
            drawing={adding && drawing}
            onDraw={(b) => {
              setDraft(b);
              setDrawing(false);
            }}
            focus={focus}
          />
          {adding && (
            <AddRegion
              offlineOnly={offlineOnly}
              draft={draft}
              setDraft={(b) => {
                setDraft(b);
                if (b) setFocus(b);
              }}
              drawing={drawing}
              setDrawing={setDrawing}
              onStarted={() => {
                setAdding(false);
                setDraft(null);
                refresh();
              }}
            />
          )}
        </div>
      </div>

      {jobs.length > 0 && (
        <div className="sblock">
          <h2>Downloads</h2>
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} onChange={refresh} />
          ))}
        </div>
      )}

      <div className="sblock">
        {packs === null && !error && <div className="skel-line" />}
        {packs?.length === 0 && (
          <p className="help">
            No map packs in{' '}
            <span className="mono">{dataRoot ? `${dataRoot}\\packs` : 'the data folder'}</span>.
            Maps show project rasters only until a pack is added: import a pack file or add a
            region.
          </p>
        )}
        {packs && packs.length > 0 && (
          <table className="tbl" data-testid="pack-table">
            <thead>
              <tr>
                <th>Region</th>
                <th>Size</th>
                <th>Max zoom</th>
                <th>Built</th>
                <th>Bounds</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {packs.map((p) => (
                <tr
                  key={p.id}
                  aria-selected={highlight === p.id}
                  onMouseEnter={() => {
                    setHighlight(p.id);
                  }}
                >
                  <td>
                    <div className="cell-h">
                      <Icon name="globe" size={14} className="faint" />
                      <b className="hi" dir="auto">
                        {p.label}
                      </b>
                      <span className="mono faint">{p.id}</span>
                      {p.source && <span className="tag">{SOURCE_LABEL[p.source]}</span>}
                    </div>
                  </td>
                  <td className="mono">{formatBytes(p.sizeBytes)}</td>
                  <td className="mono">z{p.maxZoom}</td>
                  <td className="nowrap">
                    {p.builtAt ? formatDate(p.builtAt) : 'Unknown'}
                    {p.build && <span className="mono faint"> · {p.build}</span>}
                  </td>
                  <td className="mono faint">{fmtBox(p.bbox)}</td>
                  <td className="nowrap pack-acts">
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => {
                        setHighlight(p.id);
                        setFocus([...p.bbox] as Bbox);
                      }}
                    >
                      Show
                    </button>
                    {p.source === 'package' ? null : confirm === p.id ? (
                      <>
                        <button
                          type="button"
                          className="btn sm danger"
                          onClick={() => void remove(p.id)}
                        >
                          Remove {p.label}
                        </button>
                        <button
                          type="button"
                          className="btn sm ghost"
                          onClick={() => {
                            setConfirm(null);
                          }}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => {
                          setConfirm(p.id);
                        }}
                      >
                        {t('settings.maps.remove')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
