import { brand } from '@aio/brand';
import type { IpcResponse } from '@aio/schema';
import { Icon, Switch, t } from '@aio/ui';
import { useMemo, useState } from 'react';
import { bridge, shell, useCall, useShell } from '../../shell';

type Verified = IpcResponse<'update:verifyFile'>;

function UpdateFromFile() {
  const [file, setFile] = useState<string | null>(null);
  const [result, setResult] = useState<Verified | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    const pick = await bridge.call('dialog:openFile', {
      title: 'Choose the installer',
      filters: [{ name: 'Installer', extensions: ['exe'] }],
    });
    if (!pick.ok) {
      setError(pick.error);
      return;
    }
    if (!pick.value.path) return;
    setFile(pick.value.path);
    setResult(null);
    setError(null);
    setBusy(true);
    const r = await bridge.call('update:verifyFile', { path: pick.value.path });
    setBusy(false);
    if (r.ok) setResult(r.value);
    else setError(r.error);
  };

  const install = async () => {
    if (!file) return;
    setBusy(true);
    const r = await bridge.call('update:installFile', { path: file });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error ?? 'The installer did not start.');
  };

  return (
    <div className="opt-card">
      <div className="oc-head">
        <div>
          <b>{t('settings.about.installFromFile')}</b>
          <span>
            For offline workstations: pick the signed installer copied from a USB stick or a share.
            The app checks the signature and the version before it runs it.
          </span>
        </div>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void choose()}>
          <Icon name="import" size={14} />
          Choose installer
        </button>
      </div>
      {file && (
        <div className="path-row" data-testid="update-file">
          <Icon name="download" size={14} className="faint" />
          <span className="mono">{file}</span>
        </div>
      )}
      {busy && !result && <p className="help">Checking the signature and version.</p>}
      {result?.ok === false && (
        <p className="notice warn" role="alert" data-testid="update-verdict">
          <Icon name="warn" size={14} />
          {result.error}
        </p>
      )}
      {result?.ok && (
        <div className="notice ok" data-testid="update-verdict">
          <Icon name="check" size={14} />
          <span>
            Version <b>{result.version}</b> (installed {result.current}), signed by{' '}
            <span className="mono">{result.signer}</span>. The app closes while the installer runs.
          </span>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy}
            onClick={() => void install()}
          >
            Install and restart
          </button>
        </div>
      )}
      {error && <p className="prov-err">{error}</p>}
    </div>
  );
}

function OnlineCheck() {
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const enabled = useShell((s) => s.settings.updateCheck === true);
  const url = useShell((s) => s.settings.updateUrl ?? '');
  const [draft, setDraft] = useState<string | null>(null);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'result'; available: boolean; version?: string | undefined }
    | { kind: 'error'; error: string }
  >({ kind: 'idle' });

  const saveUrl = async () => {
    if (draft === null) return;
    const v = draft.trim();
    setDraft(null);
    if (v === url) return;
    if (v && !/^https?:\/\/\S+$/i.test(v)) {
      setState({ kind: 'error', error: 'The update address must start with https://.' });
      return;
    }
    const err = await shell.getState().updateSettings({ updateUrl: v });
    if (err) setState({ kind: 'error', error: err });
  };

  const check = async () => {
    setState({ kind: 'busy' });
    const r = await bridge.call('update:check', {});
    if (!r.ok) setState({ kind: 'error', error: r.error });
    else if (!r.value.ok) setState({ kind: 'error', error: r.value.error });
    else setState({ kind: 'result', available: r.value.available, version: r.value.version });
  };

  const install = async () => {
    setState({ kind: 'busy' });
    const r = await bridge.call('update:downloadAndInstall', {});
    if (!r.ok) setState({ kind: 'error', error: r.error });
    else if (!r.value.ok) setState({ kind: 'error', error: r.value.error ?? 'Download failed.' });
  };

  return (
    <div className="opt-card">
      <div className="oc-head">
        <div>
          <b>{t('settings.about.checkOnline')}</b>
          <span>
            {offlineOnly
              ? 'Off: this workstation is offline-only (Privacy and cloud).'
              : 'Off by default. When on, the Check now button asks the update address below; nothing is checked automatically.'}
          </span>
        </div>
        <Switch
          checked={enabled && !offlineOnly}
          disabled={offlineOnly}
          label={t('settings.about.checkOnline')}
          onChange={(v) => void shell.getState().updateSettings({ updateCheck: v })}
        />
      </div>
      {enabled && !offlineOnly && (
        <div className="oc-body">
          <label className="oc-field">
            <span>Update address</span>
            <input
              className="input mono"
              aria-label="Update address"
              placeholder="https://updates.example.com/stratlas/"
              value={draft ?? url}
              spellCheck={false}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              onBlur={() => void saveUrl()}
            />
          </label>
          <div className="oc-row">
            <button
              type="button"
              className="btn sm"
              disabled={!url || state.kind === 'busy'}
              onClick={() => void check()}
            >
              <Icon name="refresh" size={14} />
              Check now
            </button>
            {state.kind === 'busy' && <span className="faint">Checking</span>}
            {state.kind === 'result' &&
              (state.available ? (
                <>
                  <span>
                    Version <b className="hi">{state.version}</b> is available.
                  </span>
                  <button type="button" className="btn sm primary" onClick={() => void install()}>
                    Download and install
                  </button>
                </>
              ) : (
                <span className="faint">This is the newest version.</span>
              ))}
          </div>
          {state.kind === 'error' && <p className="prov-err">{state.error}</p>}
        </div>
      )}
    </div>
  );
}

function Licences() {
  const list = useCall('app:licenses', {});
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    if (!list?.ok) return [];
    const needle = q.trim().toLowerCase();
    return needle
      ? list.value.filter(
          (l) => l.name.toLowerCase().includes(needle) || l.license.toLowerCase().includes(needle),
        )
      : list.value;
  }, [list, q]);
  const byLicence = useMemo(() => {
    const m = new Map<string, number>();
    if (list?.ok) for (const l of list.value) m.set(l.license, (m.get(l.license) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);

  return (
    <div className="sblock">
      <h2>
        {t('settings.about.licences')}{' '}
        <span className="sub">
          {list?.ok
            ? `${String(list.value.length)} packages · ${byLicence
                .slice(0, 4)
                .map(([l, n]) => `${l} ${String(n)}`)
                .join(', ')}`
            : ''}
        </span>
        <span className="acts">
          <input
            className="input"
            aria-label="Filter licences"
            placeholder="Filter by package or licence"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
            }}
          />
        </span>
      </h2>
      <p className="help">
        Open-source packages shipped inside the app, listed from its dependency tree when it was
        built. Map data © OpenStreetMap contributors (ODbL), basemap by Protomaps.
      </p>
      {list && !list.ok && <p className="prov-err">{list.error}</p>}
      <div className="lic-scroll">
        <table className="tbl" data-testid="licences">
          <thead>
            <tr>
              <th>Package</th>
              <th>Version</th>
              <th>Licence</th>
              <th>Author</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.name}>
                <td className="hi">{l.name}</td>
                <td className="mono faint">{l.version}</td>
                <td className="mono">{l.license}</td>
                <td className="faint">{l.author ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function About() {
  const about = useCall('app:about', {});
  const [logs, setLogs] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const a = about?.ok ? about.value : null;

  const exportLogs = async () => {
    const r = await bridge.call('app:exportLogs', {});
    if (!r.ok) setLogError(r.error);
    else if (r.value.error) setLogError(r.value.error);
    else if (r.value.path) {
      setLogs(r.value.path);
      setLogError(null);
    }
  };
  const show = (which: 'data' | 'logs' | 'userData') =>
    void bridge.call('app:showFolder', { which });

  return (
    <>
      <div className="sblock">
        <div className="about-hero">
          <div>
            <b>
              {brand.productName} <span className="mono">{a?.version ?? ''}</span>
            </b>
            <span className="faint">
              {a
                ? `Electron ${a.electron} · Chromium ${a.chrome} · Node ${a.node} · ${a.platform} ${a.arch}${a.packaged ? '' : ' · development build'}`
                : ''}
            </span>
            <span className="faint">© {brand.company}</span>
          </div>
        </div>
      </div>
      <div className="sblock">
        <h2>Folders</h2>
        <div className="about-kv">
          <span>{t('settings.about.dataFolder')}</span>
          <span className="mono" data-testid="about-data">
            {a?.dataRoot ?? ''}
          </span>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              show('data');
            }}
          >
            Open
          </button>
          <span>App settings</span>
          <span className="mono">{a?.userData ?? ''}</span>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              show('userData');
            }}
          >
            Open
          </button>
          <span>{t('settings.about.logs')}</span>
          <span className="mono">{a?.logsDir ?? ''}</span>
          <span className="about-kv-acts">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                show('logs');
              }}
            >
              Open
            </button>
            <button type="button" className="btn sm" onClick={() => void exportLogs()}>
              {t('settings.about.exportLogs')}
            </button>
          </span>
        </div>
        {logs && (
          <p className="help" role="status">
            Logs saved to <span className="mono">{logs}</span>. Attach that file when you report a
            problem.
          </p>
        )}
        {logError && <p className="prov-err">{logError}</p>}
      </div>
      <div className="sblock">
        <h2>Updates</h2>
        <UpdateFromFile />
        <OnlineCheck />
      </div>
      <Licences />
    </>
  );
}
