/**
 * Electron wiring of the sync service: events to every window, the save dialog, the auto-sync
 * timer and the sync on focus. Kept apart from `index.ts` so unit tests never load Electron.
 */
import { brand } from '@aio/brand';
import { ipcEvents, type IpcEvent } from '@aio/schema';
import { Entry } from '@napi-rs/keyring';
import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import type { ProjectRegistry } from '../project';
import type { SettingsStore } from '../settings';
import { INTERIM_DEVICE_ACCOUNT, interimDevice, interimEngine } from './interim';
import { createJournalStore } from './journalStore';
import { createSyncService, type SyncService } from './service';

/** How often the timer looks for a project whose sync interval has passed. */
const TICK_MS = 60_000;
/** Focus syncs at most this often. */
const FOCUS_GAP_MS = 60_000;

export function startSync(o: {
  registry: ProjectRegistry;
  settings: SettingsStore;
  keyService: string;
}): SyncService {
  const userData = app.getPath('userData');
  const appStamp = { name: brand.productName, version: app.getVersion() };
  const store = createJournalStore();
  // A test profile (STRATLAS_USER_DATA) keeps its device key in memory for the run: two test
  // instances on one machine are two devices, and nothing piles up in the OS vault.
  let testKey: string | null = null;
  const memoryEntry = {
    getPassword: () => testKey,
    setPassword: (v: string) => {
      testKey = v;
    },
  };
  const device = interimDevice({
    userData,
    vault: () =>
      process.env.STRATLAS_USER_DATA
        ? memoryEntry
        : new Entry(o.keyService, INTERIM_DEVICE_ACCOUNT),
    app: appStamp,
  });
  const engine = interimEngine({ store, device });
  const service = createSyncService({
    userData,
    projectRoot: (id) => o.registry.root(id),
    isPackage: (id) => o.registry.package(id) !== undefined,
    teamSettings: async () => (await o.settings.get()).team,
    device,
    journal: engine.journal,
    merge: engine.merge,
    store,
    app: appStamp,
    emit<E extends 'sync:progress' | 'exchange:progress' | 'journal:changed'>(
      event: E,
      payload: IpcEvent<E>,
    ) {
      const parsed = ipcEvents[event].safeParse(payload);
      if (!parsed.success) return;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(event, parsed.data);
      }
    },
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
  return service;
}
