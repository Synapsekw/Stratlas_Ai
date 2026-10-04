import { createAgentRuntime } from '@aio/ai/main';
import { brand } from '@aio/brand';
import { ipcEvents, type IpcChannel, type IpcEvent } from '@aio/schema';
import { Entry } from '@napi-rs/keyring';
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { validated, type Handler } from './ipc';
import { createKeyVault } from './keys';
import { addToLibrary, createLibraryStore, listLibrary, listPacks } from './library';
import { buildMenu } from './menu';
import { popupAction } from './popup';
import { writeBoundaries } from './boundaries';
import { openProject, ProjectRegistry, writeIssues } from './project';
import { createAioHandler } from './protocol/handler';
import { cspForUrl } from './protocol/legacy';
import { saveFile } from './saveFile';
import { createSettingsStore, defaultDataRoot, defaultSettings } from './settings';

// Tests and side-by-side dev runs can isolate their profile (and with it the single-instance lock).
const userDataOverride = process.env.STRATLAS_USER_DATA;
if (userDataOverride) app.setPath('userData', userDataOverride);

const dev = !app.isPackaged;
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
  handle('settings:set', (patch) => settings.set(patch));

  handle('library:list', async () => {
    const { dataRoot } = await settings.get();
    return listLibrary({ dataRoot, extraPaths: await library.paths(), registry });
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
  handle('project:writeBoundaries', ({ projectId, file }) => {
    const root = registry.root(projectId);
    if (root === undefined) {
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then save again.` };
    }
    return writeBoundaries(root, file);
  });

  handle('packs:list', async () => listPacks(join((await settings.get()).dataRoot, 'packs')));

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
    backgroundColor: '#0f1318',
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
    backgroundColor: '#0f1318',
    show: false,
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: '#11161c', symbolColor: '#c9d1dc', height: 40 } }
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
    await settings.get();
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
