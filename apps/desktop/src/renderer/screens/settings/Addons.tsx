/**
 * Settings, Models and detection, Add-ons: extra model packs downloaded on demand (addons.ts in
 * @aio/schema). One row per known add-on: its name, what it does, version, licence and size (the
 * archive's before a download, the space on disk after), then Download or Update in one click
 * (the licence and size are on the row first), Cancel while it runs, Remove with an inline
 * confirm. One Choose file for the section, for computers without internet. Modelled on the
 * Analytics pack section beside it (AnalyticsPack.tsx).
 */
import type { AddonStatus } from '@aio/schema';
import { Icon, Progress, t } from '@aio/ui';
import { useEffect, useState } from 'react';
import { addons, useAddons } from '../../addons';
import { useShell } from '../../shell';
import { addonFacts, addonName, addonOffer, addonProgressText, addonWhat } from './addonsView';
import './addons.css';

function Running({ testid }: { testid: string }) {
  const progress = useAddons((s) => s.running?.progress ?? null);
  const line = addonProgressText(progress);
  return (
    <div className="ap-progress" data-testid={`${testid}-progress`}>
      <div className="ap-progress-h">
        <span role="status">{line.text}</span>
        <button
          type="button"
          className="btn sm ghost"
          data-testid={`${testid}-cancel`}
          onClick={() => {
            addons.getState().cancel();
          }}
        >
          {t('detect.addons.cancel')}
        </button>
      </div>
      <Progress pct={line.pct} label={t('detect.addons.progress.label')} />
    </div>
  );
}

function Row({ status }: { status: AddonStatus }) {
  const running = useAddons((s) => s.running);
  const error = useAddons((s) => s.errors[status.id] ?? null);
  const note = useAddons((s) => (s.note?.id === status.id ? s.note : null));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = addonName(status);
  const facts = addonFacts(status);
  const offer = addonOffer(status);
  const mine = running !== null && running.id === status.id;
  const testid = `addon-${status.id}`;
  const remove = async () => {
    setBusy(true);
    await addons.getState().remove(status.id);
    setBusy(false);
    setConfirm(false);
  };
  return (
    <li className="opt-card addon-row" data-testid={testid}>
      <div className="oc-head">
        <div>
          <b>{name}</b>
          <span>{addonWhat(status.kind)}</span>
        </div>
        <span className="addon-acts">
          {offer && !mine && (
            <button
              type="button"
              className={offer.kind === 'download' ? 'btn sm primary' : 'btn sm'}
              data-testid={`${testid}-${offer.kind}`}
              disabled={running !== null || status.problem !== undefined}
              onClick={() => void addons.getState().install(status.id)}
            >
              <Icon name="download" size={14} />
              {offer.label}
            </button>
          )}
          {status.installed &&
            !mine &&
            (confirm ? (
              <>
                <button
                  type="button"
                  className="btn sm danger"
                  data-testid={`${testid}-remove-yes`}
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {t('detect.addons.removeConfirm', { name })}
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                  }}
                >
                  {t('detect.addons.keep')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn sm ghost"
                data-testid={`${testid}-remove`}
                disabled={running !== null}
                onClick={() => {
                  setConfirm(true);
                }}
              >
                {t('detect.addons.remove')}
              </button>
            ))}
        </span>
      </div>
      <p className="addon-facts" data-testid={`${testid}-facts`}>
        <span data-testid={`${testid}-state`}>
          {status.installed
            ? t('detect.addons.version', { version: status.installed.manifest.version })
            : t('detect.addons.notInstalled')}
        </span>
        {facts.licence && <span>{t('detect.addons.licence', { licence: facts.licence })}</span>}
        {status.installed && facts.size && (
          <span>{t('detect.addons.installedSize', { size: facts.size })}</span>
        )}
      </p>
      {mine && <Running testid={testid} />}
      {status.problem && (
        <p className="addon-problem" data-testid={`${testid}-problem`}>
          <Icon name="warn" size={14} />
          {status.problem}
        </p>
      )}
      {error && (
        <p className="prov-err" role="alert" data-testid={`${testid}-error`}>
          {error}
        </p>
      )}
      {note && (
        <div className="notice ok" role="status" data-testid={`${testid}-note`}>
          <Icon name="check" size={14} />
          <span>
            {t(note.kind === 'installed' ? 'detect.addons.installed' : 'detect.addons.removed', {
              name,
              version: note.version,
            })}
          </span>
        </div>
      )}
    </li>
  );
}

export function Addons() {
  const dataRoot = useShell((s) => s.settings.dataRoot);
  const list = useAddons((s) => s.list);
  const listError = useAddons((s) => s.listError);
  const running = useAddons((s) => s.running);
  const fileError = useAddons((s) => s.errors.file ?? null);
  // the data folder holds the add-ons: read again when it changes
  useEffect(() => {
    void addons.getState().load();
  }, [dataRoot]);
  const catalogueLine =
    list === null
      ? null
      : list.baseUrl === null
        ? t('detect.addons.noAddress')
        : list.catalogueError !== undefined
          ? t('detect.addons.catalogueError', { error: list.catalogueError })
          : null;
  return (
    <div className="sblock addons-section" data-testid="addons">
      <h2>{t('detect.addons.title')}</h2>
      <p className="help">{t('detect.addons.help')}</p>
      {catalogueLine && (
        <p className="addon-problem" data-testid="addons-catalogue">
          <Icon name="warn" size={14} />
          {catalogueLine}
        </p>
      )}
      {listError && (
        <p className="prov-err" role="alert" data-testid="addons-error">
          {listError}
        </p>
      )}
      {list && (
        <ul className="addon-list">
          {list.addons.map((a) => (
            <Row key={a.id} status={a} />
          ))}
        </ul>
      )}
      <div className="addon-file">
        <span className="help">{t('detect.addons.chooseHint')}</span>
        <button
          type="button"
          className="btn sm"
          data-testid="addons-choose"
          disabled={running !== null}
          onClick={() => void addons.getState().chooseFile()}
        >
          <Icon name="import" size={14} />
          {t('detect.addons.choose')}
        </button>
      </div>
      {running !== null && running.id === null && <Running testid="addons-file" />}
      {fileError && (
        <p className="prov-err" role="alert" data-testid="addons-file-error">
          {fileError}
        </p>
      )}
    </div>
  );
}
