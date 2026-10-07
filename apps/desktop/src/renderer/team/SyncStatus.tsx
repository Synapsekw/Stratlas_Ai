import { Icon, t, useT } from '@aio/ui';
import { issueSaver } from '@aio/annotate';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { mergeDiskIssues } from '../jobs';
import { bridge, useShell } from '../shell';
import { ExchangeExportDialog, ExchangeImportDialog } from './Exchange';
import { TeamDialog } from './Share';
import { agoMinutes, teamUi, useTeamUi } from './store';
import './team.css';

/** Ask main for the open project's sharing status. */
export async function refreshTeamStatus(projectId: string): Promise<void> {
  const r = await bridge.call('team:status', { projectId });
  if (workspace.getState().project?.id !== projectId) return;
  teamUi.getState().setStatus(r.ok && r.value.ok ? r.value.status : null);
}

/** Sync the open project through its shared folder now. */
export async function syncNow(
  projectId: string,
): Promise<{ pulled: number; pushed: number } | null> {
  const ui = teamUi.getState();
  ui.setSyncing(true);
  const r = await bridge.call('sync:now', { projectId });
  const error = !r.ok ? r.error : !r.value.ok ? r.value.error : null;
  teamUi.getState().setSyncing(false, error);
  await refreshTeamStatus(projectId);
  return r.ok && r.value.ok ? { pulled: r.value.pulled, pushed: r.value.pushed } : null;
}

/** Records changed on disk under the open project (a merge or an import): take the new issues. */
async function reloadIssues(root: string, projectId: string): Promise<void> {
  const r = await bridge.call('project:open', { path: root });
  const ws = workspace.getState();
  if (!r.ok || !r.value.ok || ws.project?.id !== projectId) return;
  const merged = mergeDiskIssues(ws.issues, r.value.issues);
  workspace.setState({ issues: merged.issues });
  if (merged.unsaved) issueSaver.schedule(projectId, merged.issues);
}

/**
 * The title bar chip of a folder project: Share when the project is private, else how it syncs
 * (exchange files, or a shared folder with its last sync, things to send and conflicts). It opens
 * the Team dialog, and owns the auto-sync after saves.
 */
export function SyncStatus() {
  useT();
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const pkg = useShell((s) => s.pkg);
  const team = useShell((s) => s.settings.team);
  const status = useTeamUi((s) => s.status);
  const syncing = useTeamUi((s) => s.syncing);
  const syncError = useTeamUi((s) => s.syncError);
  const dialog = useTeamUi((s) => s.dialog);
  const [now, setNow] = useState(() => Date.now());
  const projectId = pkg ? null : (project?.id ?? null);
  const root = project?.root ?? null;

  useEffect(() => {
    teamUi.getState().setStatus(null);
    teamUi.getState().setSyncing(false, null);
    if (projectId) void refreshTeamStatus(projectId);
  }, [projectId]);

  // the minutes since the last sync, and a status refresh now and then
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      if (projectId) void refreshTeamStatus(projectId);
    }, 30_000);
    return () => {
      clearInterval(id);
    };
  }, [projectId]);

  // a merge or import changed records of the open project: show them
  useEffect(() => {
    if (!projectId || !root) return;
    const offChanged = window.aio.on('journal:changed', (e) => {
      if (e.projectId === projectId && e.records.some((r) => r.rec === 'issue')) {
        void reloadIssues(root, projectId);
      }
    });
    const offProgress = window.aio.on('sync:progress', (e) => {
      if (e.projectId !== projectId) return;
      if (e.phase === 'done' || e.phase === 'offline') void refreshTeamStatus(projectId);
    });
    return () => {
      offChanged();
      offProgress();
    };
  }, [projectId, root]);

  // auto-sync: 10 s after the last saved change, when the person turned it on
  const autoHub = status?.mode === 'hub' && team?.autoSync === true;
  useEffect(() => {
    if (!autoHub || !projectId) return;
    const id = setTimeout(() => void syncNow(projectId), 10_000);
    return () => {
      clearTimeout(id);
    };
  }, [issues, autoHub, projectId]);

  if (!projectId) return null;
  const mode = status?.mode ?? 'off';
  const offline = mode === 'hub' && (status?.reachable === false || syncError !== null);
  const ago = agoMinutes(status?.lastSync, now);
  const label =
    mode === 'off'
      ? t('team.chip.share')
      : mode === 'exchange'
        ? t('team.chip.exchange')
        : syncing
          ? t('team.chip.syncing')
          : offline
            ? t('team.chip.offline')
            : ago === null
              ? t('team.chip.notYet')
              : ago === 0
                ? t('team.chip.justNow')
                : t('team.chip.syncedAgo', { count: ago });
  const tip =
    mode === 'off'
      ? t('team.chip.shareTip')
      : mode === 'exchange'
        ? t('team.chip.exchangeTip')
        : offline
          ? (syncError ?? t('team.chip.offlineTip'))
          : t('team.chip.hubTip');
  const state = mode === 'off' ? 'off' : syncing ? 'syncing' : offline ? 'offline' : 'ok';

  return (
    <>
      <button
        type="button"
        className={`chip-status team-chip ${state}`}
        title={tip}
        data-testid="sync-chip"
        data-mode={mode}
        data-state={state}
        onClick={() => {
          teamUi.getState().open('team');
        }}
      >
        <Icon
          name={mode === 'off' ? 'link' : offline ? 'offline' : mode === 'hub' ? 'refresh' : 'send'}
          size={14}
        />
        <span>{label}</span>
        {status && status.pending > 0 && (
          <span className="team-badge" data-testid="sync-pending">
            {t('team.chip.pending', { count: status.pending })}
          </span>
        )}
        {status && status.conflicts > 0 && (
          <span className="team-badge warn" data-testid="sync-conflicts">
            {t('team.chip.conflicts', { count: status.conflicts })}
          </span>
        )}
      </button>
      {dialog === 'team' && <TeamDialog projectId={projectId} />}
      {dialog === 'export' && <ExchangeExportDialog projectId={projectId} />}
      {dialog === 'import' && <ExchangeImportDialog projectId={projectId} />}
    </>
  );
}
