/**
 * Settings > AI providers > Outside apps (MCP) (intelligence review Wave 3, X1): the switch for
 * the local MCP server (off by default), its address and token, the setup to paste into Claude
 * Code or Claude Desktop, the apps connected now with Disconnect, a new token, and whether the
 * open project is served (outside apps are treated like cloud AI unless the person lets them
 * read this project). Main owns the server (`mcp:*`); this reads and changes it.
 */
import { brand } from '@aio/brand';
import type { AioBridge, McpStatus } from '@aio/schema';
import { Icon, Switch, t } from '@aio/ui';
import { useEffect, useState } from 'react';
import { bridge, useShell } from '../../shell';
import {
  ACCESS_KEY,
  accessServed,
  claudeCodeSetup,
  claudeDesktopSetup,
  mcpServerName,
} from './mcpView';
import './mcpServer.css';

/** The setup text with the token left out, while the token is hidden. */
const hideToken = (text: string, token: string | null) =>
  token ? text.split(token).join('...') : text;

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function CopyButton({ text, what }: { text: string; what: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm ghost"
      aria-label={t('mcp.copyLabel', { what })}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => {
              setDone(false);
            }, 1500);
          },
          () => undefined,
        );
      }}
    >
      {t(done ? 'mcp.copied' : 'mcp.copy')}
    </button>
  );
}

export function McpServerSettings() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  // cloud AI and offline-only decide whether the open project is served
  const cloud = useShell((s) => `${String(s.settings.cloudAi)}/${String(s.settings.offlineOnly)}`);

  useEffect(() => {
    let live = true;
    void bridge.call('mcp:status', {}).then((r) => {
      if (!live) return;
      if (r.ok) setStatus(r.value);
      else setError(r.error);
    });
    const aio = (globalThis as { aio?: AioBridge }).aio;
    const off = aio?.on('mcp:changed', (s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
      off?.();
    };
  }, [cloud]);

  const run = async (p: Promise<{ ok: true; value: McpStatus } | { ok: false; error: string }>) => {
    setBusy(true);
    setError(null);
    const r = await p;
    setBusy(false);
    if (r.ok) setStatus(r.value);
    else setError(r.error);
    return r.ok;
  };

  if (!status) return null;
  const name = mcpServerName(brand.productName);
  const live = status.running && status.url !== null && status.token !== null;
  const project = status.project;

  return (
    <div className="sblock mcp-server" data-testid="mcp-server">
      <h2>
        {t('mcp.title')} <span className="sub">{t('mcp.sub')}</span>
      </h2>
      <p className="faint mcp-note">{t('mcp.intro')}</p>
      <div className="opt" data-testid="mcp-switch">
        <b>{t('mcp.switch')}</b>
        <span>{status.running ? t('mcp.on', { count: status.tools }) : t('mcp.off')}</span>
        <Switch
          checked={status.enabled}
          label={t('mcp.switch')}
          disabled={busy}
          onChange={(v) => {
            setNotice(null);
            void run(bridge.call('mcp:setEnabled', { enabled: v }));
          }}
        />
      </div>
      {(status.error ?? error) && (
        <p className="notice warn mcp-note" role="status">
          <Icon name="warn" size={14} />
          <span>{status.error ?? error}</span>
        </p>
      )}
      {notice && (
        <p className="notice mcp-note" role="status">
          {notice}
        </p>
      )}

      {live && status.url && status.token && (
        <>
          <dl className="mcp-fields">
            <dt>{t('mcp.address')}</dt>
            <dd>
              <code className="mono" data-testid="mcp-url">
                {status.url}
              </code>
              <CopyButton text={status.url} what={t('mcp.address')} />
            </dd>
            <dt>{t('mcp.token')}</dt>
            <dd>
              <code className="mono" data-testid="mcp-token">
                {showToken ? status.token : t('mcp.tokenHidden')}
              </code>
              <button
                type="button"
                className="btn sm ghost"
                aria-pressed={showToken}
                onClick={() => {
                  setShowToken((v) => !v);
                }}
              >
                {t(showToken ? 'mcp.hide' : 'mcp.show')}
              </button>
              <CopyButton text={status.token} what={t('mcp.token')} />
              <button
                type="button"
                className="btn sm ghost"
                disabled={busy}
                onClick={() => {
                  void run(bridge.call('mcp:newToken', {})).then((ok) => {
                    if (ok) setNotice(t('mcp.newTokenDone'));
                  });
                }}
              >
                {t('mcp.newToken')}
              </button>
            </dd>
          </dl>

          <h3 className="mcp-h">{t('mcp.setup')}</h3>
          {(
            [
              ['mcp.setup.code', claudeCodeSetup(name, status.url, status.token)],
              ['mcp.setup.desktop', claudeDesktopSetup(name, status.url, status.token)],
            ] as const
          ).map(([key, text]) => (
            <div key={key} className="mcp-setup">
              <div className="mcp-setup-head">
                <span className="faint">{t(key)}</span>
                <CopyButton text={text} what={t(key)} />
              </div>
              <pre className="mono">{showToken ? text : hideToken(text, status.token)}</pre>
            </div>
          ))}

          <h3 className="mcp-h">{t('mcp.clients')}</h3>
          <ul className="mcp-list" aria-label={t('mcp.clients')} data-testid="mcp-clients">
            {status.clients.length === 0 && <li className="faint">{t('mcp.none')}</li>}
            {status.clients.map((c) => (
              <li key={c.id} className="mcp-client">
                <span className="mcp-dot" aria-hidden="true" />
                <div className="mcp-what">
                  <b>
                    {c.name}
                    {c.version ? ` ${c.version}` : ''}
                  </b>
                  <span className="faint">
                    {t('mcp.since', { time: time(c.connectedAt) })},{' '}
                    {t('mcp.calls', { count: c.calls })}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn sm ghost"
                  aria-label={t('mcp.disconnectLabel', { name: c.name })}
                  onClick={() => void run(bridge.call('mcp:disconnect', { clientId: c.id }))}
                >
                  {t('mcp.disconnect')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="mcp-h">{t('mcp.project')}</h3>
      {project ? (
        <>
          <div className="opt" data-testid="mcp-project">
            <b>{t('mcp.allow')}</b>
            <span>{project.name}</span>
            <Switch
              checked={project.allowed}
              label={t('mcp.allow')}
              disabled={busy || project.access === 'policy'}
              onChange={(v) =>
                void run(
                  bridge.call('mcp:setProjectAllowed', { projectId: project.id, allowed: v }),
                )
              }
            />
          </div>
          <p
            className={`mcp-note ${accessServed(project.access) ? 'faint' : 'notice warn'}`}
            data-testid="mcp-access"
            role="status"
          >
            {t(ACCESS_KEY[project.access])}
          </p>
        </>
      ) : (
        <p className="faint mcp-note">{t('mcp.noProject')}</p>
      )}
    </div>
  );
}
