/**
 * Electron wiring of the sync service: events to every window, the save dialog, the auto-sync
 * timer and the sync on focus. Kept apart from `index.ts` so unit tests never load Electron.
 */
import { brand } from '@aio/brand';
import { projectCacheKey } from '@aio/sync/blobs';
import { ipcEvents, type IpcEvent } from '@aio/schema';
import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import type { BlobService } from '../blobs';
import type { IdentityService } from '../identity';
import { devicePort } from '../identityPorts';
import type { JournalService } from '../journal';
import type { ProjectRegistry } from '../project';
import type { SettingsStore } from '../settings';
import { createTeamEngine, type TeamEngine, type TeamEngineDeps } from './engine';
import { createSyncService, safeJoin, type ServerTransport, type SyncService } from './service';
import { stat } from 'node:fs/promises';

/** How often the timer looks for a project whose sync interval has passed. */
const TICK_MS = 60_000;
/** Focus syncs at most this often. */
const FOCUS_GAP_MS = 60_000;

function broadcast<
  E extends 'sync:progress' | 'exchange:progress' | 'journal:changed' | 'sync:notice',
>(event: E, payload: IpcEvent<E>): void {
  const parsed = ipcEvents[event].safeParse(payload);
  if (!parsed.success) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, parsed.data);
  }
}

export function startSync(o: {
  registry: ProjectRegistry;
  settings: SettingsStore;
  journal: JournalService;
  identity: IdentityService;
  blobs: BlobService;
  /** T7: the HTTP transport of a server-mode project. */
  serverTransport?: (serverId: string, teamProjectId: string) => Promise<ServerTransport>;
  /** T3: issue statuses the approvals decide after a merge. */
  derivedStatuses?: TeamEngineDeps['derivedStatuses'];
}): { service: SyncService; engine: TeamEngine } {
  const userData = app.getPath('userData');
  const appStamp = { name: brand.productName, version: app.getVersion() };
  const device = devicePort(o.identity, appStamp);
  const engine = createTeamEngine({
    journal: o.journal,
    device,
    notice: (projectId, notices) => {
      broadcast('sync:notice', { projectId, notices });
    },
    changed: (projectId, records) => {
      broadcast('journal:changed', { projectId, records });
    },
    ...(o.derivedStatuses ? { derivedStatuses: o.derivedStatuses } : {}),
  });
  // History and the Audit trail mark the ops the merge engine holds in quarantine
  o.journal.setQuarantined(async (root) => {
    const q = await engine.quarantine(root);
    return new Set(q.ok ? q.entries.map((e) => e.op) : []);
  });
  const service = createSyncService({
    userData,
    projectRoot: (id) => o.registry.root(id),
    isPackage: (id) => o.registry.package(id) !== undefined,
    teamSettings: async () => (await o.settings.get()).team,
    device,
    journal: engine.journal,
    merge: engine.merge,
    store: o.journal.store,
    cacheKey: (root) => projectCacheKey(root),
    shareAsOwner: (projectId) => o.identity.shareAsOwner(projectId),
    ...(o.serverTransport ? { serverTransport: o.serverTransport } : {}),
    addGranted: (projectId, members) =>
      o.identity.addGranted(
        projectId,
        members.map((m) => ({
          actor: m.actor,
          name: m.name,
          initials: m.initials,
          role: m.role,
          devices: m.devices.filter((x) => !x.revoked).map((x) => ({ id: x.id, key: x.key })),
        })),
      ),
    blobs: {
      async file(projectId, sha256, rel) {
        const root = o.registry.root(projectId);
        const inProject = root ? safeJoin(root, rel) : null;
        if (inProject && (await stat(inProject).catch(() => null))?.isFile()) return inProject;
        const cached = o.blobs.store.path(sha256);
        return (await stat(cached).catch(() => null))?.isFile() ? cached : null;
      },
      changed(projectId) {
        o.blobs.invalidate(projectId);
        return Promise.resolve();
      },
    },
    app: appStamp,
    emit: broadcast,
    async saveDialog(defaultName) {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        title: 'Save exchange file',
        defaultPath: join(app.getPath('documents'), defaultName),
        filters: [{ name: 'Exchange file', extensions: ['aiosync'] }],
      };
      const r = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
  });

  const tick = async (force: boolean) => {
    for (const id of service.active) {
      if (await service.due(id, force).catch(() => false)) await service.syncNow(id);
    }
  };
  const timer = setInterval(() => void tick(false), TICK_MS);
  timer.unref();
  let lastFocus = 0;
  app.on('browser-window-focus', () => {
    if (Date.now() - lastFocus < FOCUS_GAP_MS) return;
    lastFocus = Date.now();
    void tick(true);
  });
  app.on('will-quit', () => {
    clearInterval(timer);
  });
  return { service, engine };
}
