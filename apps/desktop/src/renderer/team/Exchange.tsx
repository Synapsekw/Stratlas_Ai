import type { ExchangePreview } from '@aio/schema';
import { formatBytes, Icon, Switch, t, useT } from '@aio/ui';
import { useEffect, useState } from 'react';
import { bridge } from '../shell';
import { Modal } from './Modal';
import { kindGroups, passphraseProblem } from './model';
import { refreshTeamStatus } from './SyncStatus';
import { teamUi, useTeamUi } from './store';

const newJobId = () => `x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const close = () => {
  teamUi.getState().close();
};

/** Export changes (a patch) or changes and files (a bundle) to a `.aiosync`. */
export function ExchangeExportDialog({ projectId }: { projectId: string }) {
  useT();
  const status = useTeamUi((s) => s.status);
  const [kind, setKind] = useState<'patch' | 'bundle'>('patch');
  const [since, setSince] = useState<string>('');
  const [bySince, setBySince] = useState(false);
  const [encrypt, setEncrypt] = useState(false);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [plan, setPlan] = useState<{ ops: number; blobs: number; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const sinceIso = bySince && since ? new Date(`${since}T00:00:00`).toISOString() : undefined;

  useEffect(() => {
    let live = true;
    void bridge
      .call('exchange:plan', { projectId, kind, ...(sinceIso ? { since: sinceIso } : {}) })
      .then((r) => {
        if (!live) return;
        if (!r.ok) setError(r.error);
        else if (!r.value.ok) setError(r.value.error);
        else setPlan({ ops: r.value.ops, blobs: r.value.blobs, bytes: r.value.bytes });
      });
    return () => {
      live = false;
    };
  }, [projectId, kind, sinceIso]);

  const passError = passphraseProblem(encrypt, pass, again);
  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await bridge.call('exchange:export', {
      jobId: newJobId(),
      projectId,
      kind,
      ...(sinceIso ? { since: sinceIso } : {}),
      ...(encrypt ? { passphrase: pass } : {}),
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else if (r.value.path) {
      setDone(r.value.path);
      void refreshTeamStatus(projectId);
    }
  };

  return (
    <Modal
      id="exchange-export"
      icon="download"
      title={t('team.export.title')}
      {...(status?.name ? { sub: status.name } : {})}
      busy={busy}
      onClose={close}
      footer={
        <>
          <span className="grow faint small" data-testid="exchange-plan">
            {plan
              ? `${t('team.export.count', { count: plan.ops })}${kind === 'bundle' ? `, ${t('team.export.files', { count: plan.blobs })}` : ''} · ${formatBytes(plan.bytes)}`
              : '...'}
          </span>
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>
            {done ? t('team.close') : t('team.cancel')}
          </button>
          {!done && (
            <button
              type="button"
              className="btn primary"
              disabled={busy || plan === null || passError !== null}
              onClick={() => void start()}
              data-testid="exchange-export-go"
            >
              {t('team.export.go')}
            </button>
          )}
        </>
      }
    >
      <fieldset className="team-modes">
        <legend className="caps">{t('team.export.what')}</legend>
        {(['patch', 'bundle'] as const).map((k) => (
          <label key={k} className="team-mode">
            <input
              type="radio"
              name="exchange-kind"
              checked={kind === k}
              onChange={() => {
                setKind(k);
              }}
              data-testid={`exchange-kind-${k}`}
            />
            <span>
              <b>{t(k === 'patch' ? 'team.export.patch' : 'team.export.bundle')}</b>
              <small>{t(k === 'patch' ? 'team.export.patchHelp' : 'team.export.bundleHelp')}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="team-modes">
        <legend className="caps">{t('team.export.which')}</legend>
        <label className="team-mode">
          <input
            type="radio"
            name="exchange-since"
            checked={!bySince}
            onChange={() => {
              setBySince(false);
            }}
          />
          <span>
            <b>{t('team.export.all')}</b>
          </span>
        </label>
        <label className="team-mode">
          <input
            type="radio"
            name="exchange-since"
            checked={bySince}
            onChange={() => {
              setBySince(true);
            }}
          />
          <span>
            <b>{t('team.export.sinceDate')}</b>
          </span>
          {bySince && (
            <input
              className="input"
              type="date"
              aria-label={t('team.export.date')}
              value={since}
              onChange={(e) => {
                setSince(e.target.value);
              }}
            />
          )}
        </label>
      </fieldset>
      <section className="dlg-sec">
        <div className="pkg-row">
          <span>{t('team.export.encrypt')}</span>
          <Switch checked={encrypt} label={t('team.export.encrypt')} onChange={setEncrypt} />
        </div>
        {encrypt && (
          <>
            <div className="pkg-pass">
              <input
                className="input"
                type="password"
                placeholder={t('team.export.pass')}
                aria-label={t('team.export.pass')}
                value={pass}
                onChange={(e) => {
                  setPass(e.target.value);
                }}
              />
              <input
                className="input"
                type="password"
                placeholder={t('team.export.again')}
                aria-label={t('team.export.again')}
                value={again}
                onChange={(e) => {
                  setAgain(e.target.value);
                }}
              />
            </div>
            <p>{passError ?? t('team.export.passHelp')}</p>
          </>
        )}
      </section>
      {error && (
        <p className="notice danger" role="alert" data-testid="exchange-error">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
      {done && (
        <p className="notice" role="status" data-testid="exchange-done">
          <Icon name="check" size={14} />
          <span className="mono">{t('team.export.done', { path: done })}</span>
        </p>
      )}
    </Modal>
  );
}

type ImportPhase =
  | { kind: 'pick' }
  | { kind: 'locked'; path: string; error: string }
  | { kind: 'preview'; path: string; passphrase?: string; preview: ExchangePreview }
  | { kind: 'applied'; count: number };

/** Choose a `.aiosync`, preview what it would change, then apply it. */
export function ExchangeImportDialog({ projectId }: { projectId: string }) {
  useT();
  const [phase, setPhase] = useState<ImportPhase>({ kind: 'pick' });
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = async (path: string, passphrase?: string) => {
    setBusy(true);
    setError(null);
    const r = await bridge.call('exchange:preview', {
      projectId,
      path,
      ...(passphrase !== undefined ? { passphrase } : {}),
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (r.value.ok) {
      setPhase({
        kind: 'preview',
        path,
        ...(passphrase !== undefined ? { passphrase } : {}),
        preview: r.value.preview,
      });
    } else if (r.value.needsPassphrase) setPhase({ kind: 'locked', path, error: r.value.error });
    else setError(r.value.error);
  };

  const pick = async () => {
    const r = await bridge.call('dialog:openFile', {
      title: t('team.import.title'),
      filters: [{ name: t('team.share.exchange'), extensions: ['aiosync'] }],
    });
    if (r.ok && r.value.path) await preview(r.value.path);
  };

  const apply = async () => {
    if (phase.kind !== 'preview') return;
    setBusy(true);
    setError(null);
    const r = await bridge.call('exchange:import', {
      jobId: newJobId(),
      projectId,
      path: phase.path,
      ...(phase.passphrase !== undefined ? { passphrase: phase.passphrase } : {}),
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else {
      setPhase({ kind: 'applied', count: r.value.applied });
      void refreshTeamStatus(projectId);
    }
  };

  const p = phase.kind === 'preview' ? phase.preview : null;
  const blocked = p !== null && (p.signature !== 'valid' || p.alreadyApplied);

  return (
    <Modal
      id="exchange-import"
      icon="import"
      title={t('team.import.title')}
      busy={busy}
      onClose={close}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>
            {phase.kind === 'applied' ? t('team.close') : t('team.cancel')}
          </button>
          {phase.kind === 'pick' && (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void pick()}
              data-testid="exchange-pick"
            >
              {t('team.import.choose')}
            </button>
          )}
          {phase.kind === 'locked' && (
            <button
              type="button"
              className="btn primary"
              disabled={busy || pass.length === 0}
              onClick={() => void preview(phase.path, pass)}
              data-testid="exchange-unlock"
            >
              {t('team.import.unlock')}
            </button>
          )}
          {phase.kind === 'preview' && (
            <button
              type="button"
              className="btn primary"
              disabled={busy || blocked}
              onClick={() => void apply()}
              data-testid="exchange-apply"
            >
              {t('team.import.apply')}
            </button>
          )}
        </>
      }
    >
      {phase.kind === 'locked' && (
        <section className="dlg-sec">
          <p>{t('team.import.needPass')}</p>
          <input
            className="input"
            type="password"
            aria-label={t('team.export.pass')}
            data-testid="exchange-pass"
            value={pass}
            onChange={(e) => {
              setPass(e.target.value);
            }}
          />
          {phase.error && pass.length > 0 && <p className="faint small">{phase.error}</p>}
        </section>
      )}
      {p && (
        <section className="team-preview" data-testid="exchange-preview">
          <dl className="team-facts">
            <div>
              <dt>{t('team.import.from')}</dt>
              <dd dir="auto" data-testid="exchange-from">
                {p.sender.name}
                {p.sender.initials ? ` (${p.sender.initials})` : ''}
              </dd>
            </div>
            <div>
              <dt>{t('team.import.kinds')}</dt>
              <dd data-testid="exchange-new">{t('team.import.new', { count: p.newOps })}</dd>
            </div>
          </dl>
          <p
            className={`notice${p.signature === 'valid' ? '' : ' danger'}`}
            data-testid="exchange-signature"
          >
            <Icon name={p.signature === 'valid' ? 'shield' : 'warn'} size={14} />
            {t(`team.import.signature.${p.signature}`)}
          </p>
          {p.newOps > 0 && (
            <ul className="team-kinds">
              {kindGroups(p.byKind).map(([key, n]) => (
                <li key={key}>
                  <span>{t(key)}</span>
                  <b>{n}</b>
                </li>
              ))}
            </ul>
          )}
          {p.alreadyHave > 0 && (
            <p className="faint small">{t('team.import.have', { count: p.alreadyHave })}</p>
          )}
          {p.held.map((h) => (
            <p key={h.chain} className="notice">
              <Icon name="clock" size={14} />
              {t('team.import.held', { device: h.device.slice(0, 10), seq: h.upTo })}
            </p>
          ))}
          {p.expectedConflicts > 0 && (
            <p className="notice">
              <Icon name="warn" size={14} />
              {t('team.import.conflicts', { count: p.expectedConflicts })}
            </p>
          )}
          {p.blobs.count > 0 && (
            <p className="faint small">
              {t('team.import.files', {
                count: p.blobs.count,
                size: formatBytes(p.blobs.bytes),
                missing: p.blobs.missing,
              })}
            </p>
          )}
          {p.alreadyApplied && (
            <p className="notice" data-testid="exchange-already">
              <Icon name="check" size={14} />
              {t('team.import.already')}
            </p>
          )}
          {p.problems.map((m) => (
            <p key={m} className="faint small">
              {m}
            </p>
          ))}
        </section>
      )}
      {phase.kind === 'applied' && (
        <p className="notice" role="status" data-testid="exchange-applied">
          <Icon name="check" size={14} />
          {t('team.import.applied', { count: phase.count })}
        </p>
      )}
      {error && (
        <p className="notice danger" role="alert" data-testid="exchange-error">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
    </Modal>
  );
}
