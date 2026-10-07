import { formatDate, Icon, Switch, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import type { ServerInfo } from '@aio/schema';
import { useEffect, useState } from 'react';
import { bridge, shell, useShell } from '../shell';
import { Members } from './Members';
import { Modal } from './Modal';
import { TeamConflicts } from './TeamConflicts';
import { refreshTeamStatus, syncNow } from './SyncStatus';
import { teamUi, useTeamUi } from './store';

type Mode = 'exchange' | 'hub' | 'server';

/**
 * The Team dialog: "Make this a team project" for a private project (exchange files or a shared
 * folder; the team server comes with T7), else the sharing status with Sync now, export and
 * import of exchange files, and Stop syncing.
 */
export function TeamDialog({ projectId }: { projectId: string }) {
  useT();
  const status = useTeamUi((s) => s.status);
  const shared = status !== null && status.mode !== 'off';
  return shared ? <TeamStatusView projectId={projectId} /> : <ShareForm projectId={projectId} />;
}

function ShareForm({ projectId, initial = 'exchange' }: { projectId: string; initial?: Mode }) {
  const projectName = useWorkspace((s) => s.project?.manifest.name ?? '');
  const status = useTeamUi((s) => s.status);
  const team = useShell((s) => s.settings.team);
  const [name, setName] = useState(status?.name ?? projectName);
  const [mode, setMode] = useState<Mode>(initial);
  const [hubPath, setHubPath] = useState('');
  // T7 (preview): the team servers enrolled on this computer (Settings, Data folder)
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [serverId, setServerId] = useState('');
  useEffect(() => {
    void bridge.call('server:list', {}).then((r) => {
      if (!r.ok) return;
      setServers(r.value.servers);
      setServerId((s) => s || (r.value.servers[0]?.id ?? ''));
    });
  }, []);
  const [autoSync, setAutoSync] = useState(team?.autoSync ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minutes = team?.intervalMin ?? 15;
  const close = () => {
    teamUi.getState().close();
  };

  const share = async () => {
    if (mode === 'hub' && !hubPath.trim()) {
      setError(t('team.share.needPath'));
      return;
    }
    setBusy(true);
    setError(null);
    if (mode === 'hub' && autoSync !== (team?.autoSync ?? false)) {
      await shell.getState().updateSettings({ team: { ...team, autoSync } });
    }
    const r = await bridge.call('team:share', {
      projectId,
      mode,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(mode === 'hub' ? { hubPath: hubPath.trim() } : {}),
      ...(mode === 'server' && serverId ? { serverId } : {}),
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else {
      teamUi.getState().setStatus(r.value.status);
      void refreshTeamStatus(projectId);
    }
  };

  return (
    <Modal
      id="team-share"
      icon="link"
      title={t('team.share.title')}
      sub={projectName}
      busy={busy}
      onClose={close}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>
            {t('team.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void share()}
            data-testid="share-go"
          >
            {t('team.share.go')}
          </button>
        </>
      }
    >
      <p className="team-intro">{t('team.share.intro')}</p>
      <label className="team-field">
        <span>{t('team.share.name')}</span>
        <input
          className="input"
          value={name}
          dir="auto"
          maxLength={200}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </label>
      <fieldset className="team-modes">
        <legend className="caps">{t('team.share.mode')}</legend>
        <ModeChoice
          value="exchange"
          checked={mode === 'exchange'}
          onPick={setMode}
          title={t('team.share.exchange')}
          help={t('team.share.exchangeHelp')}
        />
        <ModeChoice
          value="hub"
          checked={mode === 'hub'}
          onPick={setMode}
          title={t('team.share.hub')}
          help={t('team.share.hubHelp')}
        />
        {servers.length > 0 ? (
          <ModeChoice
            value="server"
            checked={mode === 'server'}
            onPick={setMode}
            title={t('team.share.server')}
            help={t('team.share.serverReady')}
          />
        ) : (
          <label className="team-mode off">
            <input type="radio" name="team-mode" disabled />
            <span>
              <b>{t('team.share.server')}</b>
              <small>{t('team.share.serverHelp')}</small>
            </span>
          </label>
        )}
      </fieldset>
      {mode === 'server' && (
        <label className="team-field">
          <span>{t('team.share.serverPick')}</span>
          <select
            className="input"
            value={serverId}
            data-testid="share-server"
            onChange={(e) => {
              setServerId(e.target.value);
            }}
          >
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {mode === 'hub' && (
        <section className="team-hub">
          <label className="team-field">
            <span>{t('team.share.hubPath')}</span>
            <span className="team-path">
              <input
                className="input mono"
                value={hubPath}
                placeholder="\\server\share\hub"
                data-testid="share-hub-path"
                onChange={(e) => {
                  setHubPath(e.target.value);
                }}
              />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void bridge
                    .call('dialog:openFolder', { title: t('team.share.hubPath') })
                    .then((r) => {
                      if (r.ok && r.value.path) setHubPath(r.value.path);
                    });
                }}
              >
                {t('team.share.choose')}
              </button>
            </span>
          </label>
          <div className="pkg-row">
            <span>{t('team.share.autoSync', { minutes })}</span>
            <Switch
              checked={autoSync}
              label={t('team.share.autoSync', { minutes })}
              onChange={setAutoSync}
            />
          </div>
        </section>
      )}
      {error && (
        <p className="notice danger" role="alert" data-testid="share-error">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
      <p className="team-join">
        {t('team.share.join')}{' '}
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            teamUi.getState().open('import');
          }}
        >
          <Icon name="import" size={14} />
          {t('team.status.import')}
        </button>
      </p>
    </Modal>
  );
}

function ModeChoice(props: {
  value: Mode;
  checked: boolean;
  onPick(m: Mode): void;
  title: string;
  help: string;
}) {
  return (
    <label className="team-mode">
      <input
        type="radio"
        name="team-mode"
        checked={props.checked}
        onChange={() => {
          props.onPick(props.value);
        }}
        data-testid={`share-mode-${props.value}`}
      />
      <span>
        <b>{props.title}</b>
        <small>{props.help}</small>
      </span>
    </label>
  );
}

function TeamStatusView({ projectId }: { projectId: string }) {
  const status = useTeamUi((s) => s.status);
  const syncing = useTeamUi((s) => s.syncing);
  const syncError = useTeamUi((s) => s.syncError);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useHub, setUseHub] = useState(false);
  if (!status) return null;
  if (useHub) return <ShareForm projectId={projectId} initial="hub" />;
  const close = () => {
    teamUi.getState().close();
  };
  const rows: [string, string, string?][] = [
    [t('team.status.mode'), t(`team.status.mode.${status.mode}`)],
    [
      t('team.status.lastSync'),
      status.lastSync ? formatDate(status.lastSync) : t('team.status.never'),
    ],
    [t('team.status.pending'), String(status.pending), 'team-pending'],
    [t('team.status.conflicts'), String(status.conflicts), 'team-conflicts'],
  ];
  if (status.mode === 'hub' && status.reachable !== undefined) {
    rows.push([
      t('team.status.folder'),
      t(status.reachable ? 'team.status.reachable' : 'team.status.unreachable'),
    ]);
  }
  return (
    <Modal
      id="team-status"
      icon="link"
      title={t('team.dialog.title')}
      {...(status.name ? { sub: status.name } : {})}
      busy={busy}
      onClose={close}
      footer={
        <>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void bridge.call('team:leave', { projectId }).then(async () => {
                await refreshTeamStatus(projectId);
                setBusy(false);
                close();
              });
            }}
            title={t('team.status.leaveHelp')}
          >
            {t('team.status.leave')}
          </button>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>
            {t('team.close')}
          </button>
        </>
      }
    >
      <dl className="team-facts">
        {rows.map(([k, v, id]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd {...(id ? { 'data-testid': id } : {})}>{v}</dd>
          </div>
        ))}
      </dl>
      {status.conflicts > 0 && (
        <p className="notice" data-testid="team-conflicts-note">
          <Icon name="warn" size={14} />
          {t('team.status.conflictsNote', { count: status.conflicts })}
        </p>
      )}
      {syncError && status.mode === 'hub' && (
        <p className="notice danger" role="alert" data-testid="sync-error">
          <Icon name="offline" size={14} />
          {syncError}
        </p>
      )}
      {note && (
        <p className="notice" role="status" data-testid="sync-note">
          <Icon name="check" size={14} />
          {note}
        </p>
      )}
      <div className="team-actions">
        {(status.mode === 'hub' || status.mode === 'server') && (
          <button
            type="button"
            className="btn primary"
            disabled={syncing}
            data-testid="sync-now"
            onClick={() => {
              setNote(null);
              void syncNow(projectId).then((r) => {
                if (r) setNote(t('team.status.synced', { pulled: r.pulled, pushed: r.pushed }));
              });
            }}
          >
            <Icon name="refresh" size={14} />
            {t('team.status.syncNow')}
          </button>
        )}
        <button
          type="button"
          className="btn"
          data-testid="exchange-export-open"
          onClick={() => {
            teamUi.getState().open('export');
          }}
        >
          <Icon name="download" size={14} />
          {t('team.status.export')}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="exchange-import-open"
          onClick={() => {
            teamUi.getState().open('import');
          }}
        >
          <Icon name="import" size={14} />
          {t('team.status.import')}
        </button>
        {status.mode === 'exchange' && (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setUseHub(true);
            }}
          >
            {t('team.status.useHub')}
          </button>
        )}
      </div>
      <TeamConflicts projectId={projectId} />
      <Members projectId={projectId} projectName={status.name ?? ''} />
    </Modal>
  );
}
