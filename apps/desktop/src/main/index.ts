import { createAgentRuntime } from '@aio/ai/main';
import { brand } from '@aio/brand';
import { ipcEvents, type IpcChannel, type IpcEvent, type Settings } from '@aio/schema';
import { Entry } from '@napi-rs/keyring';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
} from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { arch, release, userInfo } from 'node:os';
import { join } from 'node:path';
import licenses from 'virtual:licenses';
import { demoProjectPaths } from './demo';
import { validated, type Handler } from './ipc';
import { createKeyVault } from './keys';
import { addToLibrary, createLibraryStore, listLibrary } from './library';
import { captureConsole, createLog, exportLogs } from './logs';
import { createPackManager } from './packs/manager';
import { createExtract, findLatestBuild, resolvePmtiles } from './packs/pmtiles';
import { createOnlineUpdater, type UpdaterLike } from './update/online';
import { probeWithPowerShell, verifyInstaller } from './update/verify';
import { buildMenu } from './menu';
import { popupAction } from './popup';
import { openProject, ProjectRegistry, writeIssues } from './project';
import { createAioHandler } from './protocol/handler';
import { cspForUrl } from './protocol/legacy';
import { saveFile } from './saveFile';
import { createSettingsStore, defaultDataRoot, defaultSettings } from './settings';

// Tests and side-by-side dev runs can isolate their profile (and with it the single-instance lock).
const userDataOverride = process.env.STRATLAS_USER_DATA;
if (userDataOverride) app.setPath('userData', userDataOverride);

const dev = !app.isPackaged;

// Main-process log in <userData>/logs (Settings, About, Export logs).
const logsDir = join(app.getPath('userData'), 'logs');
const appLog = createLog(logsDir);
captureConsole(appLog);
const devUrl = process.env.ELECTRON_RENDERER_URL;

// aio:// serves project files and map packs with range requests.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const CSP = [
  "default-src 'self' aio:",
  // WebAssembly compile only (Meshopt GLB decoder), no JavaScript eval
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' aio: data: blob:",
  "media-src 'self' aio: blob:",
  "connect-src 'self' aio: data: blob:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
].join('; ');

const registry = new ProjectRegistry();
const settings = createSettingsStore(
  join(app.getPath('userData'), 'settings.json'),
  defaultSettings(
    defaultDataRoot({
      env: process.env,
      platform: process.platform,
      documents: app.getPath('documents'),
      exists: existsSync,
    }),
  ),
);
const library = createLibraryStore(join(app.getPath('userData'), 'library.json'));
// An isolated profile (tests, demos) gets its own vault service, so it never reads or writes the
// person's real API keys.
const keyService = process.env.STRATLAS_USER_DATA ? `${brand.appId}.isolated` : brand.appId;
const keys = createKeyVault(keyService, (service, account) => new Entry(service, account));

let mainWindow: BrowserWindow | null = null;

/** Window chrome colours per resolved theme (title bar overlay, first paint). */
const CHROME = {
  dark: { background: '#0f1318', overlay: '#11161c', symbols: '#c9d1dc' },
  light: { background: '#eef1f4', overlay: '#f3f5f7', symbols: '#2c333c' },
} as const;

const chrome = () => CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

/** Follow the theme setting in native UI (dialogs, menus, title bar buttons). */
function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme;
  const c = chrome();
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(c.background);
    if (process.platform === 'win32' && win === mainWindow) {
      win.setTitleBarOverlay({ color: c.overlay, symbolColor: c.symbols, height: 40 });
    }
  }
}

function broadcast<E extends 'packs:job'>(event: E, payload: IpcEvent<E>): void {
  const parsed = ipcEvents[event].safeParse(payload);
  if (!parsed.success) return;
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(event, parsed.data);
}

const pmtilesBin = resolvePmtiles({
  env: process.env,
  platform: process.platform,
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  exists: existsSync,
});

// The map pack download is one of only two network paths (the other is cloud AI), and runs
// only when the person starts it in Settings, Maps.
const packs = createPackManager({
  packsDir: () => join(settings.current().dataRoot, 'packs'),
  offlineOnly: () => settings.current().offlineOnly === true,
  emit: (job) => {
    broadcast('packs:job', job);
  },
  extract: pmtilesBin
    ? createExtract(pmtilesBin, (cmd, args) =>
        spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
      )
    : null,
  latestBuild: (signal) => findLatestBuild((url, init) => net.fetch(url, init), signal),
});

const updates = createOnlineUpdater({
  settings: () => settings.current(),
  currentVersion: app.getVersion(),
  load: async () => {
    // Loaded only when the person checks, so nothing update-related runs otherwise.
    const mod = (await import('electron-updater')) as unknown as {
      autoUpdater?: UpdaterLike;
      default?: { autoUpdater: UpdaterLike };
    };
    const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
    if (!updater) throw new Error('The updater is not available in this build.');
    return updater;
  },
});

const fileExists = async (p: string) => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

const verifyDeps = () => ({
  platform: process.platform,
  currentVersion: app.getVersion(),
  publisher: brand.company,
  exists: fileExists,
  probe: probeWithPowerShell,
});

function targetWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function emitAiEvent(event: IpcEvent<'ai:event'>): void {
  const parsed = ipcEvents['ai:event'].safeParse(event);
  if (!parsed.success) {
    console.error(`Dropped an invalid ai:event of type ${event.type}.`);
    return;
  }
  targetWindow()?.webContents.send('ai:event', parsed.data);
}

const agent = createAgentRuntime({
  getKey: (provider) => keys.getKey(provider),
  cloudAllowed: () => settings.current().cloudAi,
  routes: () => settings.current().routes,
  emit: emitAiEvent,
});

function handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  const run = validated(channel, handler);
  ipcMain.handle(channel, (_e, req: unknown) => run(req));
}

/** The OS account name, when the platform has one. */
function osUser(): { user?: string } {
  try {
    const name = userInfo().username.trim();
    return name ? { user: name } : {};
  } catch {
    return {};
  }
}

function registerIpc(): void {
  handle('app:getInfo', () => ({
    name: brand.productName,
    version: app.getVersion(),
    platform: process.platform,
    ...osUser(),
  }));

  handle('settings:get', () => settings.get());
  handle('settings:set', async (patch) => {
    const next = await settings.set(patch);
    if (patch.theme) applyTheme(next.theme);
    return next;
  });

  handle('library:list', async () => {
    const { dataRoot } = await settings.get();
    const demos = await demoProjectPaths({
      env: process.env,
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    return listLibrary({ dataRoot, extraPaths: [...(await library.paths()), ...demos], registry });
  });
  handle('library:add', ({ path }) => addToLibrary(path, library, registry));

  handle('project:open', ({ path }) => openProject(path, registry));
  handle('project:writeIssues', ({ projectId, issues }) => {
    const root = registry.root(projectId);
    if (root === undefined) {
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then save again.` };
    }
    return writeIssues(root, issues);
  });

  handle('packs:list', () => packs.list());
  handle('packs:jobs', () => packs.jobs());
  handle('packs:download', (region) => packs.download(region));
  handle('packs:cancel', ({ id }) => packs.cancel(id));
  handle('packs:resume', ({ id }) => packs.resume(id));
  handle('packs:dismiss', ({ id }) => packs.dismiss(id));
  handle('packs:remove', ({ id }) => packs.remove(id));
  handle('packs:import', ({ path, label }) => packs.importFile(path, label));

  handle('dialog:openFile', async ({ title, filters }) => {
    const win = targetWindow();
    const options = {
      properties: ['openFile' as const],
      ...(title ? { title } : {}),
      ...(filters ? { filters } : {}),
    };
    const r = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return { path: r.canceled ? null : (r.filePaths[0] ?? null) };
  });

  handle('app:about', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${release()}`,
    arch: arch(),
    dataRoot: settings.current().dataRoot,
    userData: app.getPath('userData'),
    logsDir,
    packaged: app.isPackaged,
    store: process.windowsStore,
  }));
  handle('app:licenses', () => licenses);
  handle('app:exportLogs', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const win = targetWindow();
    const options = {
      title: 'Export logs',
      defaultPath: join(app.getPath('downloads'), `${brand.productName}-logs-${day}.txt`),
      filters: [{ name: 'Text', extensions: ['txt'] }],
    };
    const r = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (r.canceled || !r.filePath) return { path: null };
    try {
      await appLog.flush();
      await exportLogs(logsDir, r.filePath, [
        `${brand.productName} ${app.getVersion()}${app.isPackaged ? '' : ' (development)'}`,
        `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}`,
        `Platform ${process.platform} ${release()} ${arch()}`,
        `Data folder ${settings.current().dataRoot}`,
        `Exported ${new Date().toISOString()}`,
      ]);
      return { path: r.filePath };
    } catch (e) {
      return { path: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
  handle('app:showFolder', async ({ which }) => {
    const dir =
      which === 'data'
        ? settings.current().dataRoot
        : which === 'logs'
          ? logsDir
          : app.getPath('userData');
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true };
  });

  const STORE_UPDATES = 'This copy comes from the Microsoft Store, which installs its updates.';
  handle('update:verifyFile', ({ path }) =>
    process.windowsStore
      ? { ok: false as const, error: STORE_UPDATES }
      : verifyInstaller(path, verifyDeps()),
  );
  handle('update:installFile', async ({ path }) => {
    if (process.windowsStore) return { ok: false, error: STORE_UPDATES };
    const r = await verifyInstaller(path, verifyDeps());
    if (!r.ok) return { ok: false, error: r.error };
    try {
      const child = spawn(path, [], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      return { ok: false, error: `The installer did not start: ${String(e)}` };
    }
    appLog.write('info', [`Installing update ${r.version} from ${path}; quitting.`]);
    setTimeout(() => {
      app.quit();
    }, 300);
    return { ok: true };
  });
  handle('update:check', () =>
    process.windowsStore ? { ok: false as const, error: STORE_UPDATES } : updates.check(),
  );
  handle('update:downloadAndInstall', () => updates.downloadAndInstall());

  handle('ai:setKey', ({ provider, key }) => keys.setKey(provider, key));
  handle('ai:hasKey', async ({ provider }) => ({ present: await keys.hasKey(provider) }));
  handle('ai:send', (req) => agent.send(req));
  handle('ai:toolResult', (req) => {
    agent.toolResult(req);
    return { ok: true };
  });
  handle('ai:cancel', ({ runId }) => {
    agent.cancel(runId);
    return { ok: true };
  });

  handle('dialog:openFolder', async ({ title }) => {
    const win = targetWindow();
    const options = { properties: ['openDirectory' as const], ...(title ? { title } : {}) };
    const r = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return { path: r.canceled ? null : (r.filePaths[0] ?? null) };
  });

  handle('dialog:saveFile', (req) =>
    saveFile(req, {
      downloadsDir: app.getPath('downloads'),
      choose: async (defaultPath) => {
        const win = targetWindow();
        const options = { defaultPath, ...(req.title ? { title: req.title } : {}) };
        const r = win
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options);
        return r.canceled || !r.filePath ? null : r.filePath;
      },
    }),
  );
}

/**
 * A plain window for a project file a legacy viewer opens in a new tab (its PDF report, a
 * photo). No preload, sandboxed, and it shows only aio:// content.
 */
function openViewerWindow(url: string, title: string): void {
  const parent = targetWindow();
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    title: `${title} - ${brand.productName}`,
    backgroundColor: chrome().background,
    autoHideMenuBar: true,
    ...(parent ? { parent } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: dev,
    },
  });
  win.removeMenu();
  win.on('page-title-updated', (e) => {
    e.preventDefault();
  });
  void win.loadURL(url);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: brand.productName,
    backgroundColor: chrome().background,
    show: false,
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: chrome().overlay, symbolColor: chrome().symbols, height: 40 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: dev,
    },
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

/** Offline by construction: the renderer may reach only the app, aio:// and the dev server. */
function isAllowedRendererUrl(url: string): boolean {
  if (devUrl && url.startsWith(new URL(devUrl).origin)) return true;
  const proto = url.slice(0, url.indexOf(':') + 1);
  return !['http:', 'https:', 'ws:', 'wss:', 'ftp:'].includes(proto);
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    const csp = cspForUrl(details.url, CSP);
    if (csp === null) {
      callback({});
      return;
    }
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererUrl(details.url) });
  });
  // Only plain-text clipboard writes (legacy viewers' "Copy coordinates"); everything else is off.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
}

app.on('web-contents-created', (_e, contents) => {
  // Never navigate away from the app, open windows inside it or attach webviews.
  contents.setWindowOpenHandler(({ url }) => {
    const action = popupAction(url, (id) => registry.root(id) !== undefined);
    if (action.kind === 'external') void shell.openExternal(action.url);
    else if (action.kind === 'viewer') openViewerWindow(action.url, action.title);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e) => {
    e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => {
    e.preventDefault();
  });
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId(brand.appId);
    Menu.setApplicationMenu(buildMenu(dev));
    hardenSession();
    const initial = await settings.get();
    nativeTheme.themeSource = initial.theme;
    nativeTheme.on('updated', () => {
      applyTheme(settings.current().theme);
    });
    await packs.restore().catch((e: unknown) => {
      console.warn('Map pack jobs could not be restored', e);
    });
    protocol.handle(
      'aio',
      createAioHandler({
        projectRoot: (id) => registry.root(id),
        packsDir: () => join(settings.current().dataRoot, 'packs'),
      }),
    );
    registerIpc();

    mainWindow = createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
