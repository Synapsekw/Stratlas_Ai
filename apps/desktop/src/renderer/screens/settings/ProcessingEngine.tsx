/**
 * Settings, Processing tools, Processing engine: ODM (OpenDroneMap), the program that turns
 * drone photos into maps and models (ADR 0012). What it is and its licence, whether it is
 * installed, a download and install with progress and cancel, the question about another ODM it
 * would replace, the graphics card switch, and remove.
 *
 * Other screens get here with `openProcessingEngine()` (renderer/odm.ts).
 */
import { formatBytes, Icon, t, type IconName } from '@aio/ui';
import { useEffect, useRef, useState } from 'react';
import { odm, useOdm } from '../../odm';
import { resumeAfterTools, useProcessingTools } from '../../processingTools';
import { shell, useShell } from '../../shell';
import { processingEngineView } from './processingEngineView';
import './processingEngine.css';

const LICENCE_URL = 'https://github.com/OpenDroneMap/ODM/blob/master/LICENSE';
const SITE_URL = 'https://opendronemap.org/odm/';

const STATE_ICON: Record<'ok' | 'warn' | 'plain', IconName | null> = {
  ok: 'check',
  warn: 'warn',
  plain: null,
};

export function ProcessingEngine() {
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const status = useOdm((s) => s.status);
  const progress = useOdm((s) => s.progress);
  const installing = useOdm((s) => s.installing);
  const error = useOdm((s) => s.error);
  const askReplace = useOdm((s) => s.askReplace);
  const resume = useProcessingTools((s) => s.resume);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLElement>(null);
  const view = processingEngineView(status, progress, installing);
  const has = (a: (typeof view.actions)[number]) => view.actions.includes(a);

  // the data folder holds the install record: read again when it changes
  useEffect(() => {
    void odm.getState().load();
  }, [dataRoot]);

  // asked for by openProcessingEngine(): bring the card into view and focus its first button
  const asked = useShell((s) => s.settingsFocus === 'processing-engine');
  useEffect(() => {
    if (!asked) return;
    card.current?.scrollIntoView({ block: 'start' });
    card.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    shell.getState().clearSettingsFocus();
  }, [asked]);

  const installed = status?.state === 'installed' || status?.state === 'update-available';
  const icon = STATE_ICON[view.tone];
  const remove = async () => {
    setBusy(true);
    await odm.getState().remove();
    setBusy(false);
    setConfirm(false);
  };

  return (
    <section
      ref={card}
      className="opt-card processing-engine"
      data-testid="engine"
      aria-labelledby="engine-title"
    >
      <div className="oc-head">
        <div>
          <h2 id="engine-title" className="pe-title">
            {t('engine.title')}
          </h2>
          <span
            className={`pe-state ${view.tone}`}
            data-testid="engine-state"
            data-state={view.state}
          >
            {icon && <Icon name={icon} size={14} />}
            {t(view.title)}
          </span>
        </div>
        <span className="pe-acts">
          {has('cancel') && (
            <button
              type="button"
              className="btn sm ghost"
              data-testid="engine-cancel"
              onClick={() => void odm.getState().cancel()}
            >
              {t('engine.cancel')}
            </button>
          )}
          {has('install') && (
            <button
              type="button"
              className="btn sm primary"
              data-testid="engine-install"
              onClick={() => void odm.getState().install()}
            >
              <Icon name="download" size={14} />
              {t('engine.install')}
            </button>
          )}
          {has('update') && (
            <button
              type="button"
              className="btn sm primary"
              data-testid="engine-update"
              onClick={() => void odm.getState().install()}
            >
              {t('engine.update')}
            </button>
          )}
          {has('reinstall') && (
            <button
              type="button"
              className="btn sm"
              data-testid="engine-reinstall"
              onClick={() => void odm.getState().install()}
            >
              {t('engine.reinstall')}
            </button>
          )}
          {has('remove') &&
            (confirm ? (
              <>
                <button
                  type="button"
                  className="btn sm danger"
                  data-testid="engine-remove-confirm"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {t('engine.remove.confirm')}
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  data-testid="engine-remove-keep"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                  }}
                >
                  {t('engine.remove.keep')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn sm ghost"
                data-testid="engine-remove"
                onClick={() => {
                  setConfirm(true);
                }}
              >
                {t('engine.remove')}
              </button>
            ))}
        </span>
      </div>

      <p className="help pe-about" data-testid="engine-about">
        {t('engine.about')}{' '}
        <a href={LICENCE_URL} target="_blank" rel="noreferrer">
          {t('engine.licence')}
        </a>
        {', '}
        <a href={SITE_URL} target="_blank" rel="noreferrer">
          {t('engine.site')}
        </a>
        .
        {status && !installed && (
          <>
            {' '}
            {t('engine.size', {
              download: formatBytes(status.pinned.downloadBytes),
              installed: formatBytes(status.pinned.installedBytes),
            })}
          </>
        )}
      </p>

      {view.detail && view.state !== 'not-installed' && (
        <p className="help pe-detail" data-testid="engine-detail">
          {view.detail}
        </p>
      )}

      {status?.version !== undefined && status.dir !== undefined && (
        <p className="mono pe-version" data-testid="engine-version" title={status.dir}>
          {t('engine.version', { version: status.version, dir: status.dir })}
        </p>
      )}

      {status?.dev && <p className="help">{t('engine.dev')}</p>}

      {status && (
        <div className="pe-gpu" data-testid="engine-hardware-row">
          <div className="pe-gpu-t">
            <span id="engine-gpu-l" data-testid="engine-hardware">
              {view.hardware}
            </span>
            <span className="faint">{t('engine.gpu.help')}</span>
          </div>
          <button
            type="button"
            role="switch"
            className="switch"
            data-testid="engine-gpu"
            aria-checked={view.gpuOn}
            aria-label={t('engine.gpu.switch')}
            aria-describedby="engine-gpu-l"
            disabled={view.gpuDisabled || !installed}
            onClick={() => void odm.getState().setGpu(!view.gpuOn)}
          />
        </div>
      )}

      {status?.mayAskAdmin && !installed && !installing && (
        <p className="help" data-testid="engine-admin">
          {t('engine.admin')}
        </p>
      )}

      {view.progress && (
        <div className="pe-progress" data-testid="engine-progress">
          <span role="status">{view.progress.label}</span>
          <div
            className={`toast-bar${view.progress.pct === null ? ' busy' : ''}`}
            role="progressbar"
            aria-label={t('engine.progress.install')}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(view.progress.pct === null ? {} : { 'aria-valuenow': view.progress.pct })}
          >
            <i style={{ width: `${String(view.progress.pct ?? 30)}%` }} />
          </div>
        </div>
      )}

      {askReplace && (
        <div className="notice warn" role="alert" data-testid="engine-replace">
          <Icon name="warn" size={14} />
          <span>{t('engine.other', { dir: status?.other?.dir ?? '' })}</span>
          <span className="pe-acts">
            <button
              type="button"
              className="btn sm ghost"
              data-testid="engine-replace-no"
              onClick={() => {
                odm.getState().keep();
              }}
            >
              {t('engine.remove.keep')}
            </button>
            <button
              type="button"
              className="btn sm primary"
              data-testid="engine-replace-yes"
              onClick={() => void odm.getState().install(true)}
            >
              {t('engine.other.yes')}
            </button>
          </span>
        </div>
      )}

      {error && (
        <p className="prov-err" role="alert" data-testid="engine-error">
          {error}
        </p>
      )}

      {status?.state === 'installed' && resume === 'create-maps' && (
        <div className="pe-back">
          <button
            type="button"
            className="btn sm primary"
            data-testid="engine-back"
            onClick={resumeAfterTools}
          >
            {t('engine.back')}
          </button>
        </div>
      )}
    </section>
  );
}
