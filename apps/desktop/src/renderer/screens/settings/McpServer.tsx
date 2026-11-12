/**
 * Settings > AI providers > Outside apps (MCP) (intelligence review Wave 3, X1): the switch for
 * the local MCP server (off by default), its address and token, the setup to paste into Claude
 * Code or Claude Desktop, the apps connected now with Disconnect, a new token or port, and
 * whether the open project is served (only once the person lets outside apps read it, never
 * while offline-only is on). Main owns the server (`mcp:*`); the token comes from main only when
 * the person presses Show or Copy (`mcp:revealToken`), never with the status.
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
  TOKEN_PLACEHOLDER,
} from './mcpView';
import './mcpServer.css';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The token, asked for when the person wants to see or copy it. */
async function revealToken(): Promise<string | null> {
  const r = await bridge.call('mcp:revealToken', {});
  return r.ok ? r.value.token : null;
}

function CopyButton({ text, what }: { text: () => Promise<string | null>; what: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm ghost"
      aria-label={t('mcp.copyLabel', { what })}
      onClick={() => {
        void text()
          .then((value) => (value === null ? undefined : navigator.clipboard.writeText(value)))
          .then(
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
  /** The token while shown; null while hidden. */
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // offline-only decides whether anything is served
  const offline = useShell((s) => s.settings.offlineOnly === true);

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
  }, [offline]);

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
  const url = status.running ? status.url : null;
  const project = status.project;
  const setups = (token: string) =>
    url
      ? ([
          ['mcp.setup.code', claudeCodeSetup(name, url, token)],
          ['mcp.setup.desktop', claudeDesktopSetup(name, url, token)],
        ] as const)
      : [];
  const rotated = () => {
    setShown(null);
  };

  return (
    <div className="sblock mcp-server" data-testid="mcp-server">
      <h2>
        {t('mcp.title')} <span className="sub">{t('mcp.sub')}</span>
      </h2>
      <p className="faint mcp-note">{t('mcp.intro')}</p>
      <div className="opt" data-testid="mcp-switch">
        <b>{t('mcp.switch')}</b>
        <span data-testid="mcp-state">
          {status.running ? t('mcp.on', { count: status.tools }) : t('mcp.off')}
        </span>
        <Switch
          checked={status.enabled}
          label={t('mcp.switch')}
          disabled={busy}
          onChange={(v) => {
            setNotice(null);
            rotated();
            void run(bridge.call('mcp:setEnabled', { enabled: v }));
          }}
        />
      </div>
      {status.enabled && status.offlineOnly && (
        <p className="notice warn mcp-note" role="status" data-testid="mcp-offline">
          <Icon name="warn" size={14} />
          <span>{t('mcp.offline')}</span>
        </p>
      )}
      {(status.error ?? error) && (
        <p className="notice warn mcp-note" role="status" data-testid="mcp-error">
          <Icon name="warn" size={14} />
          <span>{status.error ?? error}</span>
          {status.portInUse && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => {
                rotated();
                void run(bridge.call('mcp:newPort', {})).then((ok) => {
                  if (ok) setNotice(t('mcp.newPortDone'));
                });
              }}
            >
              {t('mcp.newPort')}
            </button>
          )}
        </p>
      )}
      {notice && (
        <p className="notice mcp-note" role="status">
          {notice}
        </p>
      )}

      {url && status.hasToken && (
        <>
          <dl className="mcp-fields">
            <dt>{t('mcp.address')}</dt>
            <dd>
              <code className="mono" data-testid="mcp-url">
                {url}
              </code>
              <CopyButton text={() => Promise.resolve(url)} what={t('mcp.address')} />
            </dd>
            <dt>{t('mcp.token')}</dt>
            <dd>
              <code className="mono" data-testid="mcp-token">
                {shown ?? t('mcp.tokenHidden')}
              </code>
              <button
                type="button"
                className="btn sm ghost"
                aria-pressed={shown !== null}
                onClick={() => {
                  if (shown !== null) setShown(null);
                  else void revealToken().then(setShown);
                }}
              >
                {t(shown !== null ? 'mcp.hide' : 'mcp.show')}
              </button>
              <CopyButton text={revealToken} what={t('mcp.token')} />
              <button
                type="button"
                className="btn sm ghost"
                disabled={busy}
                onClick={() => {
                  rotated();
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
          {setups(shown ?? TOKEN_PLACEHOLDER).map(([key, text], i) => (
            <div key={key} className="mcp-setup">
              <div className="mcp-setup-head">
                <span className="faint">{t(key)}</span>
                <CopyButton
                  text={async () => {
                    const token = await revealToken();
                    return token === null ? null : (setups(token)[i]?.[1] ?? null);
                  }}
                  what={t(key)}
                />
              </div>
              <pre className="mono">{text}</pre>
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
