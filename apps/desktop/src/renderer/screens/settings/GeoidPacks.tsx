/**
 * Settings, Map packs: **Geoid packs** (M11, decision 5, data-conventions section 25). Lists the
 * geoid grids heights can be shown on (the global EGM96 and EGM2008 of the pipeline pack, and the
 * regional packs in the data folder's `packs/geoid/`) with their region, vertical datum, licence
 * and attribution; **Import geoid grid** copies a GeoTIFF or GTX the person names, with the licence
 * and attribution they state; **Remove** deletes a regional pack. Site settings' **Heights** lists
 * what is here. Nothing is downloaded.
 */
import type { GeoidPackMeta } from '@aio/schema';
import { formatBytes, Icon } from '@aio/ui';
import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../../shell';
import {
  geoidImportRequest,
  isGlobalGeoid,
  regionText,
  verticalText,
  type GeoidDraft,
} from './geoidPacksView';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function ImportForm({
  draft,
  setDraft,
  onDone,
}: {
  draft: GeoidDraft;
  setDraft: (d: GeoidDraft | null) => void;
  onDone: (pack: GeoidPackMeta) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = geoidImportRequest(draft);

  const start = async () => {
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await bridge.call('geoidPacks:import', checked.request);
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else {
      setDraft(null);
      onDone(r.value.pack);
    }
  };

  const field = (
    key: 'name' | 'licence' | 'attribution' | 'verticalEpsg',
    label: string,
    hint: string,
    max: number,
  ) => (
    <>
      <span className="ar-l">{label}</span>
      <input
        className="input"
        aria-label={label}
        data-testid={`geoid-import-${key}`}
        value={draft[key]}
        maxLength={max}
        placeholder={hint}
        onChange={(e) => {
          setDraft({ ...draft, [key]: e.target.value });
        }}
      />
      <span />
    </>
  );

  return (
    <div className="add-region" data-testid="geoid-import">
      <div className="ar-grid">
        <span className="ar-l">File</span>
        <span className="mono">{fileName(draft.path)}</span>
        <span />
        {field('name', 'Name', 'For example: Qatar geoid 2025', 200)}
        {field('licence', 'Licence', 'The licence the grid is under', 200)}
        {field('attribution', 'Attribution', 'What the licence asks to be credited', 1000)}
        {field('verticalEpsg', 'Vertical datum (EPSG)', 'Optional, for example 5711', 12)}
      </div>
      <p className="help">
        You state the licence and the attribution; they show here and with the heights that use this
        grid.
      </p>
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
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="geoid-import-save"
          disabled={busy || !checked.ok}
          title={checked.ok ? undefined : checked.error}
          onClick={() => void start()}
        >
          <Icon name="import" size={14} />
          Import
        </button>
      </div>
    </div>
  );
}

function PackRow({ pack, onRemoved }: { pack: GeoidPackMeta; onRemoved: (e?: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const global = isGlobalGeoid(pack);
  const remove = async () => {
    const r = await bridge.call('geoidPacks:remove', { id: pack.id });
    setConfirm(false);
    if (!r.ok) onRemoved(r.error);
    else if (!r.value.ok) onRemoved(r.value.error);
    else onRemoved();
  };
  return (
    <tr data-testid={`geoid-pack-${pack.id}`}>
      <td>
        <div className="cell-h">
          <Icon name="globe" size={14} className="faint" />
          <b className="hi" dir="auto">
            {pack.name}
          </b>
          <span className="mono faint">{pack.id}</span>
          {global && <span className="tag">Pipeline pack</span>}
          {pack.imported && <span className="tag">Imported</span>}
        </div>
        <div className="faint" dir="auto">
          {pack.attribution || 'No attribution stated'}
        </div>
      </td>
      <td>{regionText(pack.bbox)}</td>
      <td className="mono">{verticalText(pack)}</td>
      <td dir="auto">{pack.licence}</td>
      <td className="mono">{formatBytes(pack.bytes)}</td>
      <td className="nowrap pack-acts">
        {global ? null : confirm ? (
          <>
            <button
              type="button"
              className="btn sm danger"
              data-testid={`geoid-remove-confirm-${pack.id}`}
              onClick={() => void remove()}
            >
              Remove {pack.name}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setConfirm(false);
              }}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn sm ghost"
            data-testid={`geoid-remove-${pack.id}`}
            onClick={() => {
              setConfirm(true);
            }}
          >
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

export function GeoidPacks() {
  const [packs, setPacks] = useState<GeoidPackMeta[] | null>(null);
  const [draft, setDraft] = useState<GeoidDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void bridge.call('geoidPacks:list', {}).then((r) => {
      if (!r.ok) setError(r.error);
      else if (!r.value.ok) setError(r.value.error);
      else setPacks(r.value.packs);
    });
  }, []);
  useEffect(refresh, [refresh]);

  const pick = async () => {
    const r = await bridge.call('dialog:openFile', {
      title: 'Import a geoid grid (GeoTIFF or GTX)',
      filters: [{ name: 'Geoid grid', extensions: ['tif', 'tiff', 'gtx'] }],
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.path) return;
    setError(null);
    setNote(null);
    setDraft({
      path: r.value.path,
      name: fileName(r.value.path).replace(/\.[^.]+$/, ''),
      licence: '',
      attribution: '',
      verticalEpsg: '',
    });
  };

  const list = packs ?? [];
  return (
    <div className="sblock" data-testid="geoid-packs">
      <h2>
        Geoid packs{' '}
        <span className="sub">
          {list.length === 1 ? '1 grid' : `${String(list.length)} grids`},{' '}
          {formatBytes(list.reduce((n, p) => n + p.bytes, 0))}
        </span>
        <span className="acts">
          <button
            type="button"
            className="btn sm"
            data-testid="geoid-import-open"
            onClick={() => void pick()}
          >
            <Icon name="import" size={14} />
            Import geoid grid
          </button>
        </span>
      </h2>
      <p className="help">
        Orthometric heights on a site come from a geoid grid. EGM96 and EGM2008 come with the
        pipeline pack; a regional grid (GeoTIFF or GTX, in longitude and latitude) is imported here,
        and Site settings, Heights then offers it. Nothing is downloaded.
      </p>
      {error && (
        <p className="notice warn" role="alert">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
      {note && (
        <p className="notice" role="status" data-testid="geoid-note">
          {note}
        </p>
      )}
      {draft && (
        <ImportForm
          draft={draft}
          setDraft={setDraft}
          onDone={(p) => {
            setNote(`${p.name} is imported. Site settings, Heights now offers it.`);
            refresh();
          }}
        />
      )}
      {packs !== null && list.length === 0 && (
        <p className="help" data-testid="geoid-none">
          No geoid grid here yet: heights show as stored or on the ellipsoid.
        </p>
      )}
      {list.length > 0 && (
        <table className="tbl" data-testid="geoid-pack-table">
          <thead>
            <tr>
              <th>Geoid</th>
              <th>Region</th>
              <th>Vertical datum</th>
              <th>Licence</th>
              <th>Size</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <PackRow
                key={p.id}
                pack={p}
                onRemoved={(e) => {
                  setError(e ?? null);
                  if (!e) setNote(`${p.name} is removed.`);
                  refresh();
                }}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
