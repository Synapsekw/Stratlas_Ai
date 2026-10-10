/**
 * Settings, Map packs: imagery and terrain packs (M10 G7, decision 4). Lists the installed packs
 * with their licence and attribution, imports the customer's GeoTIFF or COG (or a DEM) as a pack
 * through the pipeline pack, removes packs, and holds the display choices: the Satellite map, the
 * hillshade, and terrain and imagery around the site in 3D. Also the one online source (ADR 0007,
 * amendment of 10 Oct 2026): the Online satellite switch, off by default and not available on an
 * offline-only workstation, with its notice the first time and the cache of viewed tiles.
 */
import {
  ONLINE_SATELLITE,
  type OnlineTileCache,
  type RasterPackInfo,
  type TerrainDatum,
} from '@aio/schema';
import { formatBytes, formatDate, Icon, t } from '@aio/ui';
import { useEffect, useRef, useState } from 'react';
import { bridge, shell, useShell } from '../../shell';
import { listenForJobs, rasterPacks, useRasterPacks } from '../../workspace/siteTiles';

type Kind = 'imagery' | 'terrain';

const DATUMS: { value: TerrainDatum; label: string }[] = [
  { value: 'egm2008', label: 'EGM2008 (Copernicus GLO-30)' },
  { value: 'egm96', label: 'EGM96 (NASADEM, SRTM)' },
  { value: 'ellipsoid', label: 'WGS84 ellipsoid' },
];

interface Draft {
  kind: Kind;
  path: string;
  label: string;
  licence: string;
  attribution: string;
  customerLicence: boolean;
  verticalDatum: TerrainDatum;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function ImportForm({
  draft,
  setDraft,
  onDone,
}: {
  draft: Draft;
  setDraft: (d: Draft | null) => void;
  onDone: (message: string, jobId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = draft.label.trim() && draft.licence.trim() && draft.attribution.trim();

  const start = async () => {
    setBusy(true);
    const base = {
      path: draft.path,
      label: draft.label.trim(),
      licence: draft.licence.trim(),
      attribution: draft.attribution.trim(),
    };
    const r =
      draft.kind === 'imagery'
        ? await bridge.call('imageryPacks:import', {
            ...base,
            customerLicence: draft.customerLicence,
          })
        : await bridge.call('terrainPacks:import', {
            ...base,
            verticalDatum: draft.verticalDatum,
            customerLicence: draft.customerLicence,
          });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else {
      setDraft(null);
      onDone(t('g7.packs.building', { name: base.label }), r.value.jobId);
    }
  };

  const field = (key: 'label' | 'licence' | 'attribution', label: string, hint: string) => (
    <>
      <span className="ar-l">{label}</span>
      <input
        className="input"
        aria-label={label}
        value={draft[key]}
        maxLength={key === 'attribution' ? 500 : key === 'licence' ? 200 : 120}
        placeholder={hint}
        onChange={(e) => {
          setDraft({ ...draft, [key]: e.target.value });
        }}
      />
      <span />
    </>
  );

  return (
    <div className="add-region" data-testid="raster-import">
      <div className="ar-grid">
        <span className="ar-l">{t('g7.packs.file')}</span>
        <span className="mono">{fileName(draft.path)}</span>
        <span />
        {field('label', t('g7.packs.name'), t('g7.packs.nameHint'))}
        {field('licence', t('g7.packs.licence'), t('g7.packs.licenceHint'))}
        {field('attribution', t('g7.packs.attribution'), t('g7.packs.attributionHint'))}
        {draft.kind === 'terrain' && (
          <>
            <span className="ar-l">{t('g7.packs.datum')}</span>
            <select
              className="input"
              aria-label={t('g7.packs.datum')}
              value={draft.verticalDatum}
              onChange={(e) => {
                setDraft({ ...draft, verticalDatum: e.target.value as TerrainDatum });
              }}
            >
              {DATUMS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
            <span />
          </>
        )}
        <span className="ar-l" />
        <label className="ann-check">
          <input
            type="checkbox"
            checked={draft.customerLicence}
            onChange={(e) => {
              setDraft({ ...draft, customerLicence: e.target.checked });
            }}
          />
          {t('g7.packs.customer')}
        </label>
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
          className="btn ghost"
          onClick={() => {
            setDraft(null);
          }}
        >
          {t('g7.packs.cancel')}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !ready}
          onClick={() => void start()}
        >
          <Icon name="import" size={14} />
          {t('g7.packs.build')}
        </button>
      </div>
    </div>
  );
}

function PackRow({ pack, onRemoved }: { pack: RasterPackInfo; onRemoved: (e?: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const remove = async () => {
    const r =
      pack.kind === 'imagery'
        ? await bridge.call('imageryPacks:remove', { id: pack.id })
        : await bridge.call('terrainPacks:remove', { id: pack.id });
    setConfirm(false);
    if (!r.ok) onRemoved(r.error);
    else if (!r.value.ok) onRemoved(r.value.error);
    else onRemoved();
  };
  return (
    <tr data-testid={`raster-pack-${pack.id}`}>
      <td>
        <div className="cell-h">
          <Icon name={pack.kind === 'imagery' ? 'raster' : 'map'} size={14} className="faint" />
          <b className="hi" dir="auto">
            {pack.label}
          </b>
          <span className="mono faint">{pack.id}</span>
          {pack.customerLicence && <span className="tag">{t('g7.packs.customerTag')}</span>}
        </div>
        <div className="faint" dir="auto">
          {pack.attribution}
        </div>
      </td>
      <td dir="auto">{pack.licence}</td>
      <td className="mono">
        z{pack.minZoom} to z{pack.maxZoom}
        {pack.verticalDatum ? ` · ${pack.verticalDatum.toUpperCase()}` : ''}
      </td>
      <td className="mono">{formatBytes(pack.sizeBytes)}</td>
      <td className="nowrap">{formatDate(pack.builtAt)}</td>
      <td className="nowrap pack-acts">
        {confirm ? (
          <>
            <button type="button" className="btn sm danger" onClick={() => void remove()}>
              {t('g7.packs.removeConfirm', { name: pack.label })}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setConfirm(false);
              }}
            >
              {t('g7.packs.keep')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setConfirm(true);
            }}
          >
            {t('g7.packs.remove')}
          </button>
        )}
      </td>
    </tr>
  );
}

/** Whether the person has read what online satellite sends (shown the first time only). */
const NOTICE_KEY = 'stratlas.onlineSatelliteNotice';
function noticeSeen(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}
function markNoticeSeen(): void {
  try {
    localStorage.setItem(NOTICE_KEY, '1');
  } catch {
    // blocked storage: the notice shows again next time
  }
}

function Toggle({
  label,
  checked,
  disabled,
  describedBy,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  describedBy?: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="ann-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
      {label}
    </label>
  );
}

export function RasterPacks() {
  const imagery = useRasterPacks((s) => s.imagery);
  const terrain = useRasterPacks((s) => s.terrain);
  const prefs = useRasterPacks((s) => s.prefs);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);

  // Online satellite: main enforces the switch and owns the cache; this page asks it.
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const online = prefs.onlineSatellite;
  const [asking, setAsking] = useState(false);
  const [cache, setCache] = useState<OnlineTileCache | null>(null);

  useEffect(() => {
    listenForJobs();
    rasterPacks.getState().refresh();
  }, []);

  // "Offline maps" in the map type picker asks for this block: bring it into view, focus on
  // the first import button
  const block = useRef<HTMLDivElement>(null);
  const asked = useShell((s) => s.settingsFocus === 'raster-packs');
  useEffect(() => {
    if (!asked) return;
    block.current?.scrollIntoView({ block: 'start' });
    block.current?.querySelector<HTMLElement>('button')?.focus();
    shell.getState().clearSettingsFocus();
  }, [asked]);

  useEffect(() => {
    let live = true;
    void bridge.call('onlineTiles:status', {}).then((r) => {
      if (live && r.ok) setCache(r.value.cache);
    });
    return () => {
      live = false;
    };
  }, [online]);

  const setOnline = async (on: boolean) => {
    setAsking(false);
    const err = await rasterPacks.getState().setOnlineSatellite(on);
    if (err) setError(err);
    else if (on) markNoticeSeen();
  };
  const toggleOnline = (on: boolean) => {
    // the first time: say what is sent, and switch on only on the person's yes
    if (on && !noticeSeen()) setAsking(true);
    else void setOnline(on);
  };
  const clearCache = async () => {
    const r = await bridge.call('onlineTiles:clearCache', {});
    if (r.ok) setCache(r.value);
    else setError(r.error);
  };

  // the import's job: its end clears the note (the list refreshes), a failure shows why
  useEffect(() => {
    const aio = window.aio as typeof window.aio | undefined;
    if (!jobId || !aio) return;
    return aio.on('jobs:event', (e) => {
      if (e.type !== 'update' || e.job.id !== jobId) return;
      if (e.job.status === 'done') setNote(null);
      if (e.job.status === 'failed' || e.job.status === 'cancelled') {
        setNote(null);
        setError(e.job.error ?? t('g7.packs.failed'));
      }
    });
  }, [jobId]);

  const pick = async (kind: Kind) => {
    const r = await bridge.call('dialog:openFile', {
      title: kind === 'imagery' ? t('g7.packs.importImagery') : t('g7.packs.importTerrain'),
      filters: [{ name: 'GeoTIFF', extensions: ['tif', 'tiff'] }],
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.path) return;
    const stem = fileName(r.value.path).replace(/\.[^.]+$/, '');
    setError(null);
    setDraft({
      kind,
      path: r.value.path,
      label: stem,
      licence: '',
      attribution: '',
      // what the person imports is theirs (a bought image, a LiDAR DTM) until they untick it
      customerLicence: true,
      verticalDatum: 'egm2008',
    });
  };

  const all = [...imagery, ...terrain];

  return (
    <div className="sblock" data-testid="raster-packs" ref={block}>
      <h2>
        {t('g7.packs.title')}{' '}
        <span className="sub">
          {t('g7.packs.count', {
            count: all.length,
            size: formatBytes(all.reduce((n, p) => n + p.sizeBytes, 0)),
          })}
        </span>
        <span className="acts">
          <button type="button" className="btn sm" onClick={() => void pick('imagery')}>
            <Icon name="import" size={14} />
            {t('g7.packs.importImagery')}
          </button>
          <button type="button" className="btn sm" onClick={() => void pick('terrain')}>
            <Icon name="import" size={14} />
            {t('g7.packs.importTerrain')}
          </button>
        </span>
      </h2>
      <p className="help">{t('g7.packs.help')}</p>
      {error && (
        <p className="notice warn" role="alert">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
      {note && (
        <p className="notice" role="status">
          <Icon name="layers" size={14} />
          {note}
        </p>
      )}
      {draft && (
        <ImportForm
          draft={draft}
          setDraft={setDraft}
          onDone={(m, id) => {
            setNote(m);
            setJobId(id);
          }}
        />
      )}
      {all.length > 0 && (
        <table className="tbl" data-testid="raster-pack-table">
          <thead>
            <tr>
              <th>{t('g7.packs.colPack')}</th>
              <th>{t('g7.packs.licence')}</th>
              <th>{t('g7.packs.colZoom')}</th>
              <th>{t('g7.packs.colSize')}</th>
              <th>{t('g7.packs.colBuilt')}</th>
              <th aria-label={t('g7.packs.colActions')} />
            </tr>
          </thead>
          <tbody>
            {all.map((p) => (
              <PackRow
                key={`${p.kind}-${p.id}`}
                pack={p}
                onRemoved={(e) => {
                  setError(e ?? null);
                  rasterPacks.getState().refresh();
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      <div className="raster-prefs">
        <Toggle
          label={t('g7.packs.satellite')}
          checked={prefs.satellite}
          onChange={(on) => {
            rasterPacks.getState().set({ satellite: on });
          }}
        />
        <Toggle
          label={t('g7.packs.hillshade')}
          checked={prefs.hillshade}
          onChange={(on) => {
            rasterPacks.getState().set({ hillshade: on });
          }}
        />
        <Toggle
          label={t('g7.online.toggle')}
          checked={online}
          // offline-only: it cannot be switched on (it can still be switched off)
          disabled={offlineOnly && !online}
          describedBy="online-satellite-help"
          onChange={toggleOnline}
        />
        <Toggle
          label={t('g7.packs.aroundTerrain')}
          checked={prefs.aroundTerrain}
          onChange={(on) => {
            rasterPacks.getState().set({ aroundTerrain: on });
          }}
        />
        <Toggle
          label={t('g7.packs.aroundImagery')}
          checked={prefs.aroundImagery}
          onChange={(on) => {
            rasterPacks.getState().set({ aroundImagery: on });
          }}
        />
      </div>
      <div className="online-satellite" data-testid="online-satellite">
        {asking && (
          <div className="notice warn" role="alert" data-testid="online-satellite-notice">
            <Icon name="warn" size={14} />
            <span>{t('g7.online.notice')}</span>
            <button type="button" className="btn sm primary" onClick={() => void setOnline(true)}>
              {t('g7.online.confirm')}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setAsking(false);
              }}
            >
              {t('g7.online.cancel')}
            </button>
          </div>
        )}
        <p className="help" id="online-satellite-help">
          <b>{t('g7.online.toggle')}.</b>{' '}
          {t(
            offlineOnly
              ? online
                ? 'g7.online.offlineOnlyCached'
                : 'g7.online.offlineOnly'
              : 'g7.online.help',
          )}{' '}
          <span dir="ltr">
            {t('g7.online.credit', { attribution: ONLINE_SATELLITE.attribution })}
          </span>
        </p>
        <button
          type="button"
          className="btn sm ghost"
          data-testid="online-satellite-clear"
          disabled={!cache || cache.tiles === 0}
          onClick={() => void clearCache()}
        >
          {t('g7.online.clearCache', { size: formatBytes(cache?.bytes ?? 0) })}
        </button>
      </div>
    </div>
  );
}
