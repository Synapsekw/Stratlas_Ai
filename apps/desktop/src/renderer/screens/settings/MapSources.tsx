/**
 * Settings, Map sources (plan 2026-10-14-satellite-providers; ADR 0007, amendment of 14 Oct
 * 2026): the master switch "Online maps", one row per provider with its status, a key field,
 * Test and Remove and a short note on terms and price, and "Clear saved satellite tiles". Keys
 * go to main, which checks each with one tile before it keeps it in the OS credential store; the
 * page only ever learns whether a key is there.
 */
import { ONLINE_SOURCES, type MapKeysStatus, type OnlineTileCache } from '@aio/schema';
import { formatBytes, Switch, t } from '@aio/ui';
import { useEffect, useState } from 'react';
import { bridge, useShell } from '../../shell';
import { onlineSatelliteSwitch } from '../../workspace/onlineSatellite';
import { OnlineSatelliteNotice } from '../../workspace/OnlineSatelliteNotice';
import { rasterPacks, useRasterPacks } from '../../workspace/siteTiles';
import { mapSourceRows, masterSwitch, type SourceRow } from './mapSourcesView';

export function MapSources() {
  const enabled = useRasterPacks((s) => s.prefs.onlineSatellite);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  // read here, not from the raster store: this page lands in the same batch as Task 11
  const [keys, setKeys] = useState<MapKeysStatus>({ esri: false, mapbox: false });
  const [cache, setCache] = useState<OnlineTileCache | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadKeys = () => {
    void bridge.call('mapKeys:status', {}).then((r) => {
      if (r.ok) setKeys(r.value);
    });
  };
  useEffect(() => {
    rasterPacks.getState().refresh();
    loadKeys();
  }, []);
  useEffect(() => {
    let live = true;
    void bridge.call('onlineTiles:status', {}).then((r) => {
      if (live && r.ok) setCache(r.value.cache);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  const master = masterSwitch(enabled, offlineOnly);
  const clear = async () => {
    const r = await bridge.call('onlineTiles:clearCache', {});
    if (r.ok) setCache(r.value);
    else setError(r.error);
  };
  const credits = [...new Set(ONLINE_SOURCES.map((s) => s.attribution))];
  return (
    <div className="sblock map-sources" data-testid="map-sources">
      <div className="ms-master" data-testid="map-sources-master">
        <span className="ms-text">
          <b>{t('mapSources.master')}</b>
          <span className="help">{t(master.help)}</span>
        </span>
        <Switch
          label={t('mapSources.master')}
          checked={master.checked}
          disabled={master.disabled}
          onChange={(on) => {
            // the first time it asks first, with the notice of the workstation's source
            onlineSatelliteSwitch.getState().request(on);
          }}
        />
      </div>
      <OnlineSatelliteNotice />
      {mapSourceRows(keys).map((row) => (
        <ProviderRow key={row.provider} row={row} onChanged={loadKeys} />
      ))}
      <div className="ms-foot">
        <button
          type="button"
          className="btn sm ghost"
          data-testid="map-sources-clear"
          disabled={!cache || cache.tiles === 0}
          onClick={() => void clear()}
        >
          {t('mapSources.clear', { size: formatBytes(cache?.bytes ?? 0) })}
        </button>
        {error && (
          <p className="prov-err" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="help" dir="ltr" data-testid="map-sources-credits">
        {credits.map((c) => t('mapSources.credit', { attribution: c })).join(' ')}
      </p>
    </div>
  );
}

function ProviderRow({ row, onChanged }: { row: SourceRow; onChanged: () => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const provider = row.keyProvider;
  const run = async (what: 'set' | 'test' | 'clear') => {
    if (!provider) return;
    setBusy(true);
    setMsg(what === 'clear' ? null : { ok: true, text: t('mapSources.checking') });
    const r =
      what === 'set'
        ? await bridge.call('mapKeys:set', { provider, key: draft.trim() })
        : what === 'test'
          ? await bridge.call('mapKeys:test', { provider })
          : await bridge.call('mapKeys:clear', { provider });
    setBusy(false);
    const answer = r.ok ? r.value : { ok: false as const, error: r.error };
    if (!answer.ok) {
      setMsg({ ok: false, text: answer.error });
      return;
    }
    setMsg({
      ok: true,
      text: t(
        what === 'set'
          ? 'mapSources.saved'
          : what === 'test'
            ? 'mapSources.tested'
            : 'mapSources.removed',
      ),
    });
    if (what === 'set') setDraft('');
    onChanged();
    // the Map menus read the keys from the raster store
    rasterPacks.getState().refresh();
  };
  const name = t(row.name);
  const inputId = `map-key-${row.provider}`;
  return (
    <section className="ms-row" data-testid={`map-source-${row.provider}`} aria-label={name}>
      <div className="ms-head">
        <b>{name}</b>
        <span className="ms-status" data-testid={`map-source-status-${row.provider}`}>
          {t(row.status)}
        </span>
      </div>
      <p className="help">{t(row.terms)}</p>
      {provider && (
        <div className="ms-key">
          <label className="ms-label" htmlFor={inputId}>
            {t('mapSources.key', { provider: name })}
          </label>
          <input
            id={inputId}
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('mapSources.key.placeholder')}
            aria-describedby={`${inputId}-check`}
            value={draft}
            data-testid={inputId}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || draft.trim().length < 8}
            data-testid={`map-key-save-${row.provider}`}
            onClick={() => void run('set')}
          >
            {t('mapSources.save')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy || !row.hasKey}
            data-testid={`map-key-test-${row.provider}`}
            onClick={() => void run('test')}
          >
            {t('mapSources.test')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy || !row.hasKey}
            data-testid={`map-key-remove-${row.provider}`}
            onClick={() => void run('clear')}
          >
            {t('mapSources.remove')}
          </button>
        </div>
      )}
      {provider && (
        <p className="help" id={`${inputId}-check`}>
          {t('mapSources.key.check', { provider: name })}
        </p>
      )}
      {msg && (
        <p
          className={msg.ok ? 'help' : 'prov-err'}
          role="status"
          data-testid={`map-key-msg-${row.provider}`}
        >
          {msg.text}
        </p>
      )}
    </section>
  );
}
