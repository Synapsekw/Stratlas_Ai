/**
 * Settings, Processing tools, Analytics pack: the local detector model and its server. What it is
 * in a sentence, whether this computer's graphics card can run it (with **Check again**), the
 * version installed and where, **Install or update from file** (checked and unpacked by main, with
 * progress and cancel), a one-click offer when a newer pack file is found on this computer, the
 * pack folders that cannot be used and why, and Remove with an inline confirm. Nothing is
 * downloaded. Modelled on the processing tools section beside it (ProcessingTools.tsx).
 */
import type { HardwareCheck } from '@aio/schema';
import { Icon, t, Tip } from '@aio/ui';
import { useEffect, useState, type CSSProperties } from 'react';
import { analyticsPack, useAnalyticsPack } from '../../analyticsPack';
import { useShell } from '../../shell';
import { progressText } from './packProgress';
import './analyticsPack.css';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** A path in a cell that ellipsises: the whole of it in a tip. */
function Path({ path, testid }: { path: string; testid?: string }) {
  return (
    <Tip content={path}>
      <span className="mono ap-path" tabIndex={0} data-testid={testid}>
        {path}
      </span>
    </Tip>
  );
}

/** "NVIDIA GeForce RTX 5070 Ti · 16 GB · 13.2 GB free", or why detectors cannot run here. */
function Hardware({ hardware, checking }: { hardware: HardwareCheck | null; checking: boolean }) {
  if (!hardware || checking) {
    return (
      <span className="ap-hw faint" role="status" data-testid="ap-hw">
        {t('detect.preset.settings.hw.checking')}
      </span>
    );
  }
  if (hardware.ok) {
    return (
      <span className="ap-hw ok" data-testid="ap-hw">
        <Icon name="check" size={14} />
        {t('detect.preset.settings.hw.ok', {
          gpu: hardware.gpu,
          total: Math.round(hardware.totalMb / 1024),
          free: (hardware.freeMb / 1024).toFixed(1),
        })}
      </span>
    );
  }
  return (
    <span className="ap-hw warn" data-testid="ap-hw">
      <Icon name="warn" size={14} />
      {hardware.reason}
    </span>
  );
}

function Installed({
  version,
  dir,
  disabled,
}: {
  version: string;
  dir: string;
  disabled: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    await analyticsPack.getState().remove(version);
    setBusy(false);
    setConfirm(false);
  };
  return (
    <>
      <span>{t('detect.preset.settings.version')}</span>
      <span className="mono" data-testid="ap-version">
        {version}
      </span>
      <span className="about-kv-acts">
        {confirm ? (
          <>
            <button
              type="button"
              className="btn sm danger"
              data-testid="ap-remove-yes"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t('detect.preset.settings.removeConfirm', { version })}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => {
                setConfirm(false);
              }}
            >
              {t('detect.preset.settings.keep')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn sm ghost"
            data-testid="ap-remove"
            disabled={disabled}
            onClick={() => {
              setConfirm(true);
            }}
          >
            {t('detect.preset.settings.remove')}
          </button>
        )}
      </span>
      <span>{t('detect.preset.settings.location')}</span>
      <Path path={dir} />
      <span />
    </>
  );
}

function Install() {
  const offer = useAnalyticsPack((s) => s.offer);
  const installing = useAnalyticsPack((s) => s.installing);
  const progress = useAnalyticsPack((s) => s.progress);
  const replace = useAnalyticsPack((s) => s.replace);
  const error = useAnalyticsPack((s) => s.error);
  const note = useAnalyticsPack((s) => s.note);
  const ap = analyticsPack.getState();
  const running = progressText(progress, t('detect.preset.settings.progress'));
  return (
    <div className="opt-card" data-testid="ap-install-card">
      <div className="oc-head">
        <div>
          <b>{t('detect.preset.settings.install')}</b>
          <span>{t('detect.preset.settings.installHint')}</span>
        </div>
        <button
          type="button"
          className="btn sm"
          data-testid="ap-choose"
          disabled={installing}
          onClick={() => void ap.choose()}
        >
          <Icon name="import" size={14} />
          {t('detect.preset.settings.choose')}
        </button>
      </div>
      {offer && !installing && !replace && (
        <div className="notice ok" data-testid="ap-offer">
          <Icon name="download" size={14} />
          <span className="ap-offer">
            <b>{t('detect.preset.settings.offerTitle')}</b>
            <Tip content={offer.path}>
              <span className="mono" tabIndex={0}>
                {fileName(offer.path)}
              </span>
            </Tip>
          </span>
          <button
            type="button"
            className="btn sm primary"
            data-testid="ap-install"
            onClick={() => void ap.install(offer.path)}
          >
            {t('detect.preset.settings.offer', { version: offer.version })}
          </button>
        </div>
      )}
      {installing && (
        <div className="ap-progress" data-testid="ap-progress">
          <div className="ap-progress-h">
            <span role="status">{running.text}</span>
            <button
              type="button"
              className="btn sm ghost"
              data-testid="ap-cancel"
              onClick={() => {
                ap.cancel();
              }}
            >
              {t('detect.preset.settings.cancel')}
            </button>
          </div>
          <div
            className={`toast-bar${running.pct === null ? ' busy' : ''}`}
            role="progressbar"
            aria-label={t('detect.preset.settings.progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(running.pct === null ? {} : { 'aria-valuenow': running.pct })}
          >
            <i style={{ '--p': (running.pct ?? 100) / 100 } as CSSProperties} />
          </div>
        </div>
      )}
      {replace && (
        <div className="notice warn" role="alert" data-testid="ap-replace">
          <Icon name="warn" size={14} />
          <span>
            <b>{t('detect.preset.settings.replace.title', { version: replace.version })}</b>{' '}
            {t('detect.preset.settings.replace.text')}
          </span>
          <span className="ap-acts">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                ap.keepInstalled();
              }}
            >
              {t('detect.preset.settings.replace.no')}
            </button>
            <button
              type="button"
              className="btn sm primary"
              data-testid="ap-replace-yes"
              onClick={() => void ap.install(replace.path, true)}
            >
              {t('detect.preset.settings.replace.yes', { version: replace.version })}
            </button>
          </span>
        </div>
      )}
      {error && (
        <p className="prov-err" role="alert" data-testid="ap-error">
          {error}
        </p>
      )}
      {note && (
        <div className="notice ok" role="status" data-testid="ap-note">
          <Icon name="check" size={14} />
          <span>
            {t(
              note.kind === 'installed'
                ? 'detect.preset.settings.installed'
                : 'detect.preset.settings.removed',
              { version: note.version },
            )}
          </span>
        </div>
      )}
    </div>
  );
}

export function AnalyticsPack() {
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const status = useAnalyticsPack((s) => s.status);
  const hardware = useAnalyticsPack((s) => s.hardware);
  const checking = useAnalyticsPack((s) => s.checking);
  const installing = useAnalyticsPack((s) => s.installing);
  // the data folder holds the packs: read again when it changes
  useEffect(() => {
    void analyticsPack.getState().load();
  }, [dataRoot]);
  const refused = hardware?.ok === false ? hardware : null;
  // nothing to install on a Mac: the hardware line says so
  const mac = refused?.code === 'mac';
  return (
    <div className="sblock ap-section" data-testid="analytics-pack">
      <h2>{t('detect.preset.settings.title')}</h2>
      <p className="help">{t('detect.preset.settings.help')}</p>
      <div className="about-kv ap-info">
        <span>{t('detect.preset.settings.card')}</span>
        <Hardware hardware={hardware} checking={checking} />
        <span>
          {refused && !mac && !checking && (
            <button
              type="button"
              className="btn sm ghost"
              data-testid="ap-hw-recheck"
              onClick={() => void analyticsPack.getState().checkHardware()}
            >
              {t('detect.preset.settings.hw.recheck')}
            </button>
          )}
        </span>
        {!mac &&
          (status?.installed ? (
            <Installed
              key={status.installed.version}
              version={status.installed.version}
              dir={status.installed.dir}
              disabled={installing}
            />
          ) : (
            <>
              <span>{t('detect.preset.settings.version')}</span>
              <span className="mono" data-testid="ap-version">
                {status ? t('detect.preset.settings.none') : ''}
              </span>
              <span />
            </>
          ))}
      </div>
      {!mac && status && status.unusable.length > 0 && (
        <ul className="ap-unusable" data-testid="ap-unusable">
          {status.unusable.map((u) => (
            <li key={u.version}>{u.reason}</li>
          ))}
        </ul>
      )}
      {!mac && <Install />}
      <p className="help ap-licence">{t('detect.preset.settings.licence')}</p>
    </div>
  );
}
