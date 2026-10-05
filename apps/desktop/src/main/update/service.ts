import { brand } from '@aio/brand';
import type { IpcEvent, ReleaseNotes, Settings } from '@aio/schema';
import { app, dialog, session, shell, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import originalFs from 'original-fs';
import { createOnlineUpdater } from './online';
import {
  createRollback,
  installOf,
  isKeptCopy,
  RESTORE_FROM,
  RESTORE_INTO,
  RESTORE_WAIT,
  restoreInto,
  type RollbackFs,
  type StartupDecision,
} from './rollback';
import { probeWithPowerShell, verifyInstaller } from './verify';

/** A first start that has not drawn its first screen after this long counts as failed. */
export const READY_TIMEOUT_MS = 90_000;

const STORE_UPDATES = 'This copy comes from the Microsoft Store, which installs its updates.';

// Plain fs: Electron's patched fs treats app.asar as a folder, which would break the copy.
const fsp = originalFs.promises;
export const rawFs: RollbackFs = {
  readFile: (p, enc) => fsp.readFile(p, enc),
  writeFile: (p, data) => fsp.writeFile(p, data),
  rename: (a, b) => fsp.rename(a, b),
  rm: (p, o) => fsp.rm(p, o),
  mkdir: (p, o) => fsp.mkdir(p, o),
  cp: (a, b, o) => fsp.cp(a, b, o),
  stat: (p) => fsp.stat(p),
  readdir: (p) => fsp.readdir(p),
};

const fileExists = async (p: string) => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

export interface UpdateServiceDeps {
  settings: () => Settings;
  log: (level: 'info' | 'warn' | 'error', line: string) => void;
  progress: (p: IpcEvent<'update:progress'>) => void;
  notes: ReleaseNotes;
}

/** Start-menu entry that starts the kept previous version (Windows), so it stays one click away. */
function previousShortcut(version: string): string {
  return join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    `${brand.productName} ${version} (previous version).lnk`,
  );
}

/**
 * Updates and rollback (ADR 0003): install from a file, the optional online feed, the kept
 * previous version and the first-start watch.
 */
export function createUpdateService(d: UpdateServiceDeps) {
  const current = app.getVersion();
  const dir = join(app.getPath('userData'), 'updates');
  // undefined outside an MSIX package, despite the type
  const store = (process.windowsStore as boolean | undefined) === true;
  const kept = isKeptCopy(process.execPath, dir);
  const install = kept
    ? { unavailable: 'This is the kept copy of an earlier version.' }
    : installOf(process.execPath, process.platform, {
        packaged: app.isPackaged,
        store,
        portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
      });
  const rollback = createRollback({
    dir,
    current,
    install,
    fs: rawFs,
    log: (line) => {
      d.log('info', line);
    },
  });

  const verifyDeps = (expectedVersion?: string) => ({
    platform: process.platform,
    currentVersion: current,
    publisher: brand.company,
    signingIdentity: brand.signing?.windowsPublisher,
    expectedVersion,
    exists: fileExists,
    probe: probeWithPowerShell,
  });

  /** Keep this version, then hand over to the installer. */
  async function runInstaller(
    path: string,
    version: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if ('unavailable' in install) {
      d.log('warn', `Installing ${version} without a kept copy: ${install.unavailable}`);
    } else {
      try {
        const kept = await rollback.keepCurrent(version);
        if (process.platform === 'win32') {
          shell.writeShortcutLink(previousShortcut(current), 'create', {
            target: kept.exe,
            description: `${brand.productName} ${current}, kept when ${version} was installed`,
          });
        }
      } catch (e) {
        return {
          ok: false,
          error: `This version could not be kept for a rollback, so the update did not start: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    d.progress({ received: 0, total: 0, phase: 'install' });
    if (process.platform === 'darwin') {
      const error = await shell.openPath(path);
      return error ? { ok: false, error } : { ok: true };
    }
    try {
      // --updated: electron-builder's installer skips its pages and installs over this folder.
      const child = spawn(path, ['--updated'], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      return { ok: false, error: `The installer did not start: ${String(e)}` };
    }
    d.log('info', `Installing update ${version} from ${path}; quitting.`);
    setTimeout(() => {
      app.quit();
    }, 300);
    return { ok: true };
  }

  const online = createOnlineUpdater({
    settings: d.settings,
    currentVersion: current,
    platform: process.platform,
    arch: process.arch,
    // Its own session: the default session blocks every http(s) request (hardenSession).
    fetch: (url, init) => session.fromPartition('stratlas-updates').fetch(url, init),
    downloadsDir: join(dir, 'downloads'),
    verify: async (path, version) => {
      if (process.platform !== 'win32') return { ok: true }; // the feed's SHA-256; Gatekeeper on start
      const r = await verifyInstaller(path, verifyDeps(version));
      return r.ok ? { ok: true } : r;
    },
    install: runInstaller,
    onProgress: d.progress,
  });

  /** Hand over to the kept previous version, which replaces this one and starts. */
  async function startRollback(): Promise<{ ok: boolean; error?: string }> {
    if ('unavailable' in install) return { ok: false, error: install.unavailable };
    const prev = await rollback.previousExe();
    if (!prev) return { ok: false, error: 'There is no previous version kept on this computer.' };
    try {
      const child = spawn(
        prev.exe,
        [
          `${RESTORE_INTO}${install.appRoot}`,
          `${RESTORE_WAIT}${String(process.pid)}`,
          `${RESTORE_FROM}${current}`,
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
    } catch (e) {
      return { ok: false, error: `The previous version did not start: ${String(e)}` };
    }
    d.log('info', `Returning to ${prev.version}; quitting ${current}.`);
    setTimeout(() => {
      app.quit();
    }, 300);
    return { ok: true };
  }

  async function offer(from: string, to: string, why: string): Promise<boolean> {
    const r = await dialog.showMessageBox({
      type: 'warning',
      title: brand.productName,
      message: `${brand.productName} ${to} did not start correctly.`,
      detail: `${why}\n\nReturn to version ${from}? Your projects and settings stay as they are. You can install ${to} again later.`,
      buttons: [`Return to ${from}`, `Keep ${to}`],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r.response === 0) {
      const started = await startRollback();
      if (started.ok) return true;
      dialog.showErrorBox(
        brand.productName,
        started.error ?? 'The previous version did not start.',
      );
    }
    await rollback.decline();
    return false;
  }

  /**
   * Started from the kept copy (the "previous version" Start-menu entry): offer to put it back as
   * the installed version, for when the newer one does not start at all.
   */
  async function offerRestoreFromKept(): Promise<boolean> {
    const j = await rollback.read();
    const appRoot = j.previous?.version === current ? j.previous.appRoot : undefined;
    if (!appRoot) return false;
    const newer = j.pending?.from === current ? j.pending.to : null;
    const r = await dialog.showMessageBox({
      type: 'question',
      title: brand.productName,
      message: `This is ${brand.productName} ${current}, kept when ${newer ? `version ${newer}` : 'a newer version'} was installed.`,
      detail: `Make ${current} the installed version again? It replaces the version in ${appRoot}. Your projects and settings stay as they are.`,
      buttons: [`Make ${current} the installed version`, `Just run ${current}`],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r.response !== 0) return false;
    await runRestore({ into: appRoot, waitPid: null, from: newer }, (line) => {
      d.log('info', line);
    });
    return true;
  }

  let watching: { from: string; to: string } | null = null;
  let ready = false;
  let timer: NodeJS.Timeout | null = null;

  async function failed(reason: string): Promise<void> {
    if (!watching || ready) return;
    const w = watching;
    watching = null;
    if (timer) clearTimeout(timer);
    if (await rollback.markFailure(reason)) await offer(w.from, w.to, reason);
  }

  return {
    rollback,

    /** Before the first window: count this start; true when the app is handing over to a rollback. */
    async startup(): Promise<boolean> {
      if (kept) return offerRestoreFromKept();
      let decision: StartupDecision;
      try {
        decision = await rollback.startup();
      } catch (e) {
        d.log('warn', `The update journal could not be read: ${String(e)}`);
        return false;
      }
      if (decision.kind === 'installAborted' && process.platform === 'win32') {
        await originalFs.promises
          .rm(previousShortcut(current), { force: true })
          .catch(() => undefined);
      }
      if (decision.kind === 'offer') {
        const why =
          decision.failures > 1
            ? `It failed to start ${String(decision.failures)} times.`
            : 'The last start did not finish loading.';
        if (await offer(decision.from, decision.to, why)) return true;
      }
      if (decision.kind === 'watch' || decision.kind === 'offer') {
        watching = { from: decision.from, to: decision.to };
        timer = setTimeout(() => {
          void failed(`It did not finish loading within ${String(READY_TIMEOUT_MS / 1000)} s`);
        }, READY_TIMEOUT_MS);
      }
      return false;
    },

    /** Watch the main window during a first start: a renderer crash reloads once, twice fails. */
    watchWindow(win: BrowserWindow): void {
      let crashes = 0;
      win.webContents.on('render-process-gone', (_e, details) => {
        if (!watching || ready || details.reason === 'clean-exit') return;
        crashes++;
        if (crashes >= 2) void failed('Its window crashed twice');
        else win.webContents.reload();
      });
    },

    async rendererReady(): Promise<void> {
      if (ready) return;
      ready = true;
      if (timer) clearTimeout(timer);
      watching = null;
      if (await rollback.markReady()) {
        if (process.platform === 'win32') {
          const prev = await rollback.previousExe();
          if (prev)
            await originalFs.promises
              .rm(previousShortcut(prev.version), { force: true })
              .catch(() => undefined);
        }
        await originalFs.promises
          .rm(join(dir, 'downloads'), { recursive: true, force: true })
          .catch(() => undefined);
      }
    },

    beforeQuit: () => rollback.markCleanExit(),

    notes: () => d.notes,
    status: () => rollback.status(),
    startRollback,

    verifyFile: (path: string) =>
      store ? { ok: false as const, error: STORE_UPDATES } : verifyInstaller(path, verifyDeps()),

    async installFile(path: string): Promise<{ ok: boolean; error?: string }> {
      if (store) return { ok: false, error: STORE_UPDATES };
      const r = await verifyInstaller(path, verifyDeps());
      if (!r.ok) return { ok: false, error: r.error };
      return runInstaller(path, r.version);
    },

    check: () =>
      store ? Promise.resolve({ ok: false as const, error: STORE_UPDATES }) : online.check(),
    downloadAndInstall: () =>
      store ? Promise.resolve({ ok: false, error: STORE_UPDATES }) : online.downloadAndInstall(),
  };
}

/**
 * Restore mode: this process is the kept previous version, started by a newer one with
 * `--stratlas-restore-into`. Put this copy back as the installed version, start it, and exit.
 */
export async function runRestore(
  args: { into: string; waitPid: number | null; from: string | null },
  log: (line: string) => void,
): Promise<void> {
  const install = installOf(process.execPath, process.platform, {
    packaged: true,
    store: false,
    portable: false,
  });
  if ('unavailable' in install) {
    dialog.showErrorBox(brand.productName, install.unavailable);
    app.exit(1);
    return;
  }
  try {
    await restoreInto(install.appRoot, args.into, args.waitPid, {
      fs: rawFs,
      alive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    });
    const rollback = createRollback({
      dir: join(app.getPath('userData'), 'updates'),
      current: app.getVersion(),
      install,
      fs: rawFs,
      log,
    });
    if (args.from) await rollback.recordRollback(args.from);
    const exe = join(args.into, install.exe);
    app.releaseSingleInstanceLock();
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    app.exit(0);
  } catch (e) {
    dialog.showErrorBox(
      brand.productName,
      `Version ${app.getVersion()} could not be put back: ${e instanceof Error ? e.message : String(e)}\n\nThe kept copy is in ${install.appRoot}.`,
    );
    app.exit(1);
  }
}
