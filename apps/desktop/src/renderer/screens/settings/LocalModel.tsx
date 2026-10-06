/**
 * Settings, AI providers, Local model (AI-9, M8 C7). The person's own server (decision 1: nothing
 * bundled): Find models (discovery on this machine's default ports), a model list with badges,
 * Test (the capability probe), the tool list and time-out for small models, an optional server
 * key in the system vault, the Offline agent preset, and a short setup guide.
 */
import {
  DEFAULT_LOCAL_MODEL,
  isLoopbackUrl,
  isOfflineAgent,
  offlineRoutes,
  restoreRoutes,
  serverRoot,
} from '@aio/ai/routes';
import type { LocalModelInfo, LocalModelSettings } from '@aio/schema';
import { Icon, Switch, t } from '@aio/ui';
import { useState } from 'react';
import { bridge, shell, useCall, useShell } from '../../shell';
import {
  candidates,
  contextLabel,
  localRoutesTo,
  sizeLabel,
  withModel,
  withProbe,
} from './localModelView';
import './localModel.css';

/** Routes before the Offline agent preset, so turning it off goes back (this workstation only). */
const BEFORE_OFFLINE = 'stratlas.routesBeforeOffline';
const WAIT_MINUTES = [1, 2, 5, 10];

function readSaved(): string | null {
  try {
    return localStorage.getItem(BEFORE_OFFLINE);
  } catch {
    return null;
  }
}

function writeSaved(value: string): void {
  try {
    localStorage.setItem(BEFORE_OFFLINE, value);
  } catch {
    // the preset still works; turning it off then goes back to the defaults
  }
}

interface Found {
  address: string;
  server: { kind: 'ollama' | 'openai-compatible'; version?: string | undefined };
  models: LocalModelInfo[];
}

interface Probe {
  tools: boolean;
  vision: boolean;
  latencyMs: number;
}

export function LocalModel() {
  const stored = useShell((s) => s.settings.localModel);
  const routes = useShell((s) => s.settings.routes);
  const cfg: LocalModelSettings = stored ?? DEFAULT_LOCAL_MODEL;
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl);
  const [model, setModel] = useState(cfg.model);
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const [remoteAsk, setRemoteAsk] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const save = async (next: LocalModelSettings, extra: { routes?: typeof routes } = {}) => {
    const e = await shell.getState().updateSettings({ localModel: next, ...extra });
    setError(e ? t('localAi.saveError') : null);
    return e === null;
  };

  const find = async (allowRemote = false) => {
    const typed = baseUrl.trim();
    if (!isLoopbackUrl(typed) && !allowRemote) {
      setRemoteAsk(true);
      return;
    }
    setRemoteAsk(false);
    setFinding(true);
    setFindError(null);
    setFound(null);
    let first: string | null = null;
    for (const address of candidates(typed)) {
      const r = await bridge.call('ai:localModels', { baseUrl: address });
      if (r.ok && r.value.ok) {
        const server = r.value.server ?? { kind: 'openai-compatible' as const };
        setFound({ address, server, models: r.value.models });
        if (address !== typed) setBaseUrl(address);
        await save({ ...cfg, baseUrl: address, kind: server.kind });
        setFinding(false);
        return;
      }
      first ??= r.ok ? (r.value.ok ? null : r.value.error) : r.error;
    }
    setFindError(first);
    setFinding(false);
  };

  const choose = async (info: LocalModelInfo) => {
    setModel(info.id);
    setProbe(null);
    setProbeError(null);
    await save(withModel(cfg, info), { routes: localRoutesTo(routes, info.id) });
  };

  const test = async () => {
    setTesting(true);
    setProbe(null);
    setProbeError(null);
    const r = await bridge.call('ai:localProbe', { model: cfg.model, baseUrl: cfg.baseUrl });
    setTesting(false);
    if (!r.ok || !r.value.ok) {
      setProbeError(r.ok ? (r.value.ok ? null : r.value.error) : r.error);
      return;
    }
    const p = r.value;
    setProbe({ tools: p.tools, vision: p.vision, latencyMs: p.latencyMs });
    await save(withProbe(cfg, p));
  };

  const offline = cfg.enabled && isOfflineAgent(routes);
  const setOffline = async (on: boolean) => {
    if (on) {
      if (!isOfflineAgent(routes)) writeSaved(JSON.stringify(routes));
      await save({ ...cfg, enabled: true }, { routes: offlineRoutes(cfg.model) });
    } else {
      await shell.getState().updateSettings({ routes: restoreRoutes(readSaved()) });
    }
  };

  const yesNo = (v: boolean) => t(v ? 'localAi.yes' : 'localAi.no');

  return (
    <div className="sblock local-model" data-testid="local-model">
      <h2>
        {t('localAi.title')} <span className="sub">{t('localAi.sub')}</span>
      </h2>
      <div className="opt">
        <b>{t('localAi.use')}</b>
        <span>{t('localAi.useHint')}</span>
        <Switch
          checked={cfg.enabled}
          label={t('localAi.use')}
          onChange={(v) => void save({ ...cfg, enabled: v })}
        />
      </div>
      <div className="opt">
        <b>{t('localAi.offline')}</b>
        <span>
          {offline
            ? t(isLoopbackUrl(cfg.baseUrl) ? 'localAi.offlineOn' : 'localAi.offlineRemote', {
                model: cfg.model,
              })
            : t('localAi.offlineHint')}
        </span>
        <Switch
          checked={offline}
          label={t('localAi.offline')}
          onChange={(v) => void setOffline(v)}
        />
      </div>

      <div className="lm-row">
        <label>
          <span className="faint">{t('localAi.address')}</span>
          <input
            className="input mono"
            aria-label={t('localAi.addressLabel')}
            value={baseUrl}
            spellCheck={false}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setRemoteAsk(false);
            }}
            onBlur={() => {
              if (baseUrl.trim() !== cfg.baseUrl) void save({ ...cfg, baseUrl: baseUrl.trim() });
            }}
          />
        </label>
        <button
          type="button"
          className="btn sm"
          disabled={finding || !baseUrl.trim()}
          onClick={() => void find()}
        >
          <Icon name="search" size={14} />
          {finding ? t('localAi.finding') : t('localAi.find')}
        </button>
      </div>
      {remoteAsk && (
        <p className="notice warn lm-note" role="alert">
          <Icon name="warn" size={14} />
          <span>{t('localAi.remoteWarn', { address: serverRoot(baseUrl.trim()) })}</span>
          <button type="button" className="btn sm" onClick={() => void find(true)}>
            {t('localAi.remoteContinue')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setRemoteAsk(false);
            }}
          >
            {t('localAi.cancel')}
          </button>
        </p>
      )}
      {findError && (
        <p className="prov-err lm-note" role="alert">
          {findError}
        </p>
      )}
      {found && (
        <>
          <p className="faint lm-note" role="status">
            {t('localAi.found', {
              server:
                found.server.kind === 'ollama'
                  ? `${t('localAi.server.ollama')}${found.server.version ? ` ${found.server.version}` : ''}`
                  : t('localAi.server.openai'),
              address: serverRoot(found.address),
              count: found.models.length,
            })}
          </p>
          <ul className="lm-models" aria-label={t('localAi.models')}>
            {found.models.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="lm-model"
                  aria-pressed={m.id === cfg.model}
                  aria-label={t('localAi.choose', { model: m.id })}
                  onClick={() => void choose(m)}
                >
                  <span className="mono lm-id">{m.id}</span>
                  {m.tools && <span className="lm-badge">{t('localAi.badge.tools')}</span>}
                  {m.vision && <span className="lm-badge">{t('localAi.badge.vision')}</span>}
                  {m.contextTokens !== undefined && (
                    <span className="lm-badge">
                      {t('localAi.badge.context', { size: contextLabel(m.contextTokens) })}
                    </span>
                  )}
                  {m.sizeBytes !== undefined && (
                    <span className="lm-badge faint">{sizeLabel(m.sizeBytes)}</span>
                  )}
                  {m.id === cfg.model && <span className="lm-in">{t('localAi.chosen')}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="lm-row">
        <label>
          <span className="faint">{t('localAi.model')}</span>
          <input
            className="input mono"
            aria-label={t('localAi.modelLabel')}
            value={model}
            spellCheck={false}
            onChange={(e) => {
              setModel(e.target.value);
            }}
            onBlur={() => {
              const v = model.trim();
              if (v && v !== cfg.model) {
                void save(withModel(cfg, { id: v }), { routes: localRoutesTo(routes, v) });
              }
            }}
          />
        </label>
        <button
          type="button"
          className="btn sm"
          disabled={testing || !cfg.model}
          onClick={() => void test()}
        >
          {testing ? t('localAi.testing') : t('localAi.test')}
        </button>
      </div>
      {probe && (
        <p className="prov-ok lm-note" role="status" data-testid="local-probe">
          {t('localAi.tested', {
            tools: yesNo(probe.tools),
            vision: yesNo(probe.vision),
            seconds: (probe.latencyMs / 1000).toFixed(1),
          })}
        </p>
      )}
      {probe && !probe.tools && <p className="faint lm-note">{t('localAi.answerOnly')}</p>}
      {probeError && (
        <p className="prov-err lm-note" role="alert">
          {probeError}
        </p>
      )}

      <div className="opt">
        <b>{t('localAi.profile')}</b>
        <span>{t('localAi.profileHint')}</span>
        <select
          className="input"
          aria-label={t('localAi.profile')}
          value={cfg.toolProfile ?? 'full'}
          onChange={(e) =>
            void save({ ...cfg, toolProfile: e.target.value === 'compact' ? 'compact' : 'full' })
          }
        >
          <option value="full">{t('localAi.profile.full')}</option>
          <option value="compact">{t('localAi.profile.compact')}</option>
        </select>
      </div>
      <div className="opt">
        <b>{t('localAi.wait')}</b>
        <span>{t('localAi.waitHint')}</span>
        <select
          className="input"
          aria-label={t('localAi.wait')}
          value={String(Math.round((cfg.timeoutMs ?? 120_000) / 60_000))}
          onChange={(e) => void save({ ...cfg, timeoutMs: Number(e.target.value) * 60_000 })}
        >
          {WAIT_MINUTES.map((m) => (
            <option key={m} value={m}>
              {t('localAi.wait.option', { minutes: m })}
            </option>
          ))}
        </select>
      </div>
      <ServerKey />
      <details className="lm-guide">
        <summary>{t('localAi.guide.title')}</summary>
        <p>{t('localAi.guide.intro')}</p>
        <ul>
          <li>{t('localAi.guide.ollama')}</li>
          <li>{t('localAi.guide.lmstudio')}</li>
          <li>{t('localAi.guide.llamacpp')}</li>
        </ul>
        <p>{t('localAi.guide.then')}</p>
        <p>{t('localAi.guide.hardware')}</p>
        <p>{t('localAi.guide.licence')}</p>
      </details>
      {error && (
        <p className="prov-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The optional bearer key of the local server, in the system vault (account `local`). */
function ServerKey() {
  const [rev, setRev] = useState(0);
  const status = useCall('ai:hasKey', { provider: 'local' }, rev);
  const present = status?.ok === true && status.value.present;
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const k = key.trim();
    if (k.length < 8) {
      setError(t('localAi.keyShort'));
      return;
    }
    const r = await bridge.call('ai:setKey', { provider: 'local', key: k });
    if (!r.ok || !r.value.ok) {
      setError(r.ok ? t('localAi.keyFailed') : r.error);
      return;
    }
    setKey('');
    setError(null);
    setEditing(false);
    setRev((n) => n + 1);
  };
  return (
    <div className="opt">
      <b>{t('localAi.key')}</b>
      <span>{t('localAi.keyHint')}</span>
      {present && !editing ? (
        <span className="lm-key">
          <span className="state ok">
            <i />
            {t('localAi.keyStored')}
          </span>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setEditing(true);
            }}
          >
            {t('localAi.keyReplace')}
          </button>
        </span>
      ) : (
        <form
          className="lm-key"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('localAi.keyPlaceholder')}
            aria-label={t('localAi.keyLabel')}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setError(null);
            }}
          />
          <button type="submit" className="btn sm" disabled={!key.trim()}>
            {t('localAi.keySave')}
          </button>
        </form>
      )}
      {error && (
        <p className="prov-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
