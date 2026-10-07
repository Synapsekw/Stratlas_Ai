import { brand } from '@aio/brand';
import type { IpcChannel, IpcRequest, IpcResponse } from '@aio/schema';
import { app, BrowserWindow, crashReporter, dialog } from 'electron';
import { arch, cpus, release, totalmem, type as osType } from 'node:os';
import { basename, join } from 'node:path';
import type { Handler } from '../ipc';
import { createLog, type AppLog, type Level } from '../logs';
import { collectBundle, writeBundle, type BundleSources } from './bundle';
import type { CrashStore } from './crash';

export interface ProcessLogs {
  main: AppLog;
  /** Console messages of the app's windows. */
  renderer: AppLog;
  /** Output of export utility processes. */
  utility: AppLog;
}

let utility: AppLog | undefined;

/** The utility-process log, once `createProcessLogs` ran (exports/utility.ts pipes into it). */
export function utilityLog(): AppLog | undefined {
  return utility;
}

/** `main.log`, `renderer.log` and `utility.log` in `<userData>/logs`, each rotated at 2 MB. */
export function createProcessLogs(dir: string): ProcessLogs {
  const logs = {
    main: createLog(dir, { name: 'main' }),
    renderer: createLog(dir, { name: 'renderer' }),
    utility: createLog(dir, { name: 'utility' }),
  };
  utility = logs.utility;
  return logs;
}

/** Native crash dumps (minidumps) stay on this computer: nothing is ever uploaded. */
export function startCrashReporter(): void {
  try {
    crashReporter.start({ uploadToServer: false, productName: brand.productName });
  } catch (e) {
    console.warn('The crash reporter did not start', e);
  }
}

/** The last lines of the main and renderer logs, in time order. */
function lastLines(logs: ProcessLogs): string[] {
  return [
    ...logs.main.recent(60).map((l) => `[main] ${l}`),
    ...logs.renderer.recent(60).map((l) => `[renderer] ${l}`),
  ]
    .sort((a, b) => a.slice(a.indexOf(']') + 2).localeCompare(b.slice(b.indexOf(']') + 2)))
    .slice(-80);
}

const CONSOLE_LEVEL: Record<string, Level | undefined> = {
  info: 'info',
  warning: 'warn',
  error: 'error',
};

/** Reasons that mean a process crashed, rather than was ended on purpose. */
const CRASHED = new Set(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure']);

/** Reload a crashed main window at most once in this many milliseconds (no crash loops). */
const RELOAD_EVERY_MS = 30_000;

export interface CrashHandlerOptions {
  crash: CrashStore;
  logs: ProcessLogs;
  mainWindow: () => BrowserWindow | null;
  /** Release smoke runs exit on a renderer crash instead of reloading. */
  smoke: boolean;
}

/**
 * Crash handling for every process: main exceptions and rejections, renderer and child process
 * crashes (GPU, utility), and window console output into `renderer.log`. Each crash writes a
 * local report (diagnostics/crash.ts); a crashed main window is reloaded and shows the notice.
 */
export function installCrashHandlers(o: CrashHandlerOptions): void {
  const { crash, logs } = o;
  let rejections = 0;

  process.on('uncaughtException', (err) => {
    logs.main.writeSync('error', ['Uncaught exception in main', err]);
    crash.write({
      process: 'main',
      reason: 'uncaught-exception',
      details: err.stack ?? String(err),
      lastLines: lastLines(logs),
    });
  });
  process.on('unhandledRejection', (reason) => {
    logs.main.write('error', ['Unhandled promise rejection in main', reason]);
    // A rejection is a bug, not a crash: the first few of a run get a report.
    if (++rejections > 3) return;
    crash.write({
      process: 'main',
      reason: 'unhandled-rejection',
      details: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
      lastLines: lastLines(logs),
    });
  });

  let lastReload = 0;
  app.on('render-process-gone', (_e, contents, details) => {
    if (details.reason === 'clean-exit') return;
    const win = BrowserWindow.fromWebContents(contents);
    const isMain = win !== null && win === o.mainWindow();
    logs.main.writeSync('error', [
      `The ${isMain ? 'main' : 'viewer'} window stopped: ${details.reason} (exit code ${String(details.exitCode)})`,
    ]);
    crash.write(
      {
        process: 'renderer',
        reason: details.reason,
        exitCode: details.exitCode,
        details: isMain ? 'The main window stopped.' : 'A viewer window stopped.',
        lastLines: lastLines(logs),
      },
      isMain ? 'window' : undefined,
    );
    if (!isMain || o.smoke || contents.isDestroyed()) return;
    const now = Date.now();
    if (now - lastReload < RELOAD_EVERY_MS) return;
    lastReload = now;
    contents.reload();
  });

  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    const name = details.serviceName ?? details.name ?? details.type;
    const line = `${details.type} process ${name} ended: ${details.reason} (exit code ${String(details.exitCode)})`;
    if (!CRASHED.has(details.reason)) {
      logs.main.write('info', [line]);
      return;
    }
    logs.main.writeSync('error', [line]);
    crash.write({
      process: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      details: name,
      lastLines: lastLines(logs),
    });
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('console-message', (event) => {
      const level = CONSOLE_LEVEL[event.level];
      if (!level) return;
      const where =
        level === 'info' || !event.sourceId
          ? ''
          : ` (${basename(event.sourceId)}:${String(event.lineNumber)})`;
      logs.renderer.write(level, [`${event.message.slice(0, 4000)}${where}`]);
    });
  });

  app.on('will-quit', () => {
    crash.end();
  });
}

export interface DiagnosticsIpcOptions {
  handle: <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;
  crash: CrashStore;
  logs: ProcessLogs;
  logsDir: string;
  targetWindow: () => BrowserWindow | null;
  sources: Omit<BundleSources, 'logsDir' | 'crash' | 'system' | 'crashDumpsDir' | 'projects'> & {
    projects: (current?: string) => ReturnType<BundleSources['projects']>;
  };
}

async function systemInfo(): Promise<Record<string, unknown>> {
  const gpu = await Promise.race([
    app.getGPUInfo('basic').catch((e: unknown) => ({ error: String(e) })),
    new Promise((resolve) =>
      setTimeout(() => {
        resolve({ error: 'GPU information timed out.' });
      }, 3000),
    ),
  ]);
  return {
    app: {
      name: brand.productName,
      version: app.getVersion(),
      packaged: app.isPackaged,
      store: process.windowsStore,
      locale: app.getLocale(),
    },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    os: {
      type: osType(),
      platform: process.platform,
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      memoryGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    },
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    gpu,
  };
}

/** `app:exportDiagnostics`, `app:crashNotice` and `app:dismissCrashNotice`. */
export function registerDiagnosticsIpc(o: DiagnosticsIpcOptions): void {
  const exportDiagnostics = async (
    req: IpcRequest<'app:exportDiagnostics'>,
  ): Promise<IpcResponse<'app:exportDiagnostics'>> => {
    const day = new Date().toISOString().slice(0, 10);
    const win = o.targetWindow();
    const options = {
      title: req.problem ? 'Save the problem report' : 'Export diagnostics',
      defaultPath: join(
        app.getPath('downloads'),
        `${brand.executableName}-${req.problem ? 'problem' : 'diagnostics'}-${day}.zip`,
      ),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    };
    const r = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (r.canceled || !r.filePath) return { path: null };
    try {
      o.logs.main.write('info', [
        req.problem ? 'Saving a problem report.' : 'Exporting diagnostics.',
      ]);
      await Promise.all([o.logs.main.flush(), o.logs.renderer.flush(), o.logs.utility.flush()]);
      let crashDumpsDir: string | undefined;
      try {
        crashDumpsDir = app.getPath('crashDumps');
      } catch {
        crashDumpsDir = undefined;
      }
      const files = await collectBundle(
        {
          ...o.sources,
          projects: () => o.sources.projects(req.openProject),
          logsDir: o.logsDir,
          crash: o.crash,
          system: systemInfo,
          ...(crashDumpsDir ? { crashDumpsDir } : {}),
        },
        {
          ...(req.problem ? { problem: req.problem } : {}),
          ...(req.graphics ? { graphics: req.graphics } : {}),
        },
      );
      await writeBundle(r.filePath, files);
      return { path: r.filePath };
    } catch (e) {
      return { path: null, error: e instanceof Error ? e.message : String(e) };
    }
  };

  o.handle('app:exportDiagnostics', exportDiagnostics);
  o.handle('app:crashNotice', () => ({ notice: o.crash.notice() }));
  o.handle('app:dismissCrashNotice', () => {
    o.crash.dismiss();
    return { ok: true };
  });
}
