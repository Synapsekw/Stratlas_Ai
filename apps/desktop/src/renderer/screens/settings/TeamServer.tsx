/**
 * Settings, Data, Team server (M9 T7, preview): connect this computer to the team's own server
 * with an invite code, after checking the server's certificate fingerprint; see each enrolled
 * server's status, and forget one. Nothing here talks to the network until the person clicks
 * Connect; offline only blocks it. The "Preview" label and the whole block follow one flag
 * (`HostingModel.server`).
 */
import type { ServerInfo } from '@aio/schema';
import { formatDate, Icon, t } from '@aio/ui';
import { useEffect, useState } from 'react';
import { bridge, useShell } from '../../shell';
import {
  addressProblem,
  groupFingerprint,
  normaliseAddress,
  previewLabelShown,
  ROLE_KEY,
  teamServerShown,
} from './teamServerView';
import './teamServer.css';

type Step = { kind: 'form' } | { kind: 'confirm'; url: string; fingerprint: string };

export function TeamServer() {
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const [servers, setServers] = useState<ServerInfo[] | null>(null);
  const [rev, setRev] = useState(0);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void bridge.call('server:list', {}).then((r) => {
      if (live) setServers(r.ok ? r.value.servers : []);
    });
    return () => {
      live = false;
    };
  }, [rev]);

  if (!teamServerShown()) return null;

  const problem = addressProblem(normaliseAddress(address));
  const canConnect = !busy && !offlineOnly && address.trim() !== '' && code.trim().length >= 6;

  const enrol = async (fingerprint?: string) => {
    const url = step.kind === 'confirm' ? step.url : normaliseAddress(address);
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await bridge.call('server:enrol', {
      url,
      code: code.trim(),
      ...(fingerprint ? { fingerprint } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (r.value.ok) {
      setStep({ kind: 'form' });
      setAddress('');
      setCode('');
      setNotice(t('teamServer.connected', { name: r.value.server.name }));
      setRev((n) => n + 1);
      return;
    }
    if (r.value.fingerprint && !fingerprint) {
      setStep({ kind: 'confirm', url, fingerprint: r.value.fingerprint });
      return;
    }
    setError(r.value.error);
  };

  const forget = async (s: ServerInfo) => {
    setError(null);
    const r = await bridge.call('server:forget', { id: s.id });
    if (!r.ok || !r.value.ok) {
      setError(r.ok ? (r.value.ok ? null : r.value.error) : r.error);
      return;
    }
    setNotice(t('teamServer.forgotten', { name: s.name }));
    setRev((n) => n + 1);
  };

  return (
    <div className="sblock team-server" data-testid="team-server">
      <h2>
        {t('teamServer.title')}
        {previewLabelShown() && <span className="ts-preview">{t('teamServer.preview')}</span>}
        <span className="sub">{t('teamServer.sub')}</span>
      </h2>
      <p className="faint ts-note">{t('teamServer.intro')}</p>

      <ul className="ts-list" aria-label={t('teamServer.list')}>
        {servers?.length === 0 && <li className="faint">{t('teamServer.none')}</li>}
        {servers?.map((s) => (
          <li key={s.id} className="ts-server">
            <span className="ts-dot" aria-hidden="true" />
            <div className="ts-what">
              <b>{s.name}</b> <span className="mono faint">{s.url}</span>
              <span className="ts-status" role="status">
                {s.version
                  ? t('teamServer.status', {
                      role: t(ROLE_KEY[s.role ?? 'viewer']),
                      version: s.version,
                    })
                  : t('teamServer.statusNoVersion', { role: t(ROLE_KEY[s.role ?? 'viewer']) })}{' '}
                {t('teamServer.since', { date: formatDate(s.enrolledAt) })}
              </span>
              <span className="mono faint ts-fp">
                {t('teamServer.fingerprintShort', {
                  fingerprint: groupFingerprint(s.fingerprint).slice(0, 19),
                })}
              </span>
            </div>
            <button
              type="button"
              className="btn sm ghost"
              aria-label={t('teamServer.forgetLabel', { name: s.name })}
              onClick={() => void forget(s)}
            >
              {t('teamServer.forget')}
            </button>
          </li>
        ))}
      </ul>

      <h3 className="ts-h">{t('teamServer.connect')}</h3>
      {offlineOnly && (
        <p className="notice warn ts-note" role="status">
          <Icon name="warn" size={14} />
          <span>{t('teamServer.offline')}</span>
        </p>
      )}
      {step.kind === 'form' ? (
        <form
          className="ts-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canConnect && !problem) void enrol();
          }}
        >
          <label>
            <span className="faint">{t('teamServer.address')}</span>
            <input
              className="input mono"
              aria-label={t('teamServer.addressLabel')}
              placeholder="https://team.example.com:8443"
              value={address}
              spellCheck={false}
              onChange={(e) => {
                setAddress(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label>
            <span className="faint">{t('teamServer.code')}</span>
            <input
              className="input mono"
              aria-label={t('teamServer.codeLabel')}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              value={code}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setCode(e.target.value);
                setError(null);
              }}
            />
          </label>
          <button type="submit" className="btn sm" disabled={!canConnect || problem !== null}>
            {busy ? t('teamServer.contacting') : t('teamServer.next')}
          </button>
        </form>
      ) : (
        <div className="ts-confirm" role="group" aria-label={t('teamServer.check')}>
          <b>{t('teamServer.check')}</b>
          <p className="faint">{t('teamServer.checkText')}</p>
          <p className="mono ts-fingerprint" aria-label={t('teamServer.fingerprint')}>
            {groupFingerprint(step.fingerprint)}
          </p>
          <div className="ts-actions">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => void enrol(step.fingerprint)}
            >
              {busy ? t('teamServer.contacting') : t('teamServer.trust')}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => {
                setStep({ kind: 'form' });
                setError(null);
              }}
            >
              {t('teamServer.cancel')}
            </button>
          </div>
        </div>
      )}
      {problem && address.trim() !== '' && (
        <p className="prov-err ts-note" role="alert">
          {t(problem)}
        </p>
      )}
      {error && (
        <p className="prov-err ts-note" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="faint ts-note" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
