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
import { createPackageJobs, createPlanCache, packagePathFromArgv, ProjectPolicy } from './packages';
import { openProject, ProjectRegistry, writeProjectIssues } from './project';
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
const policy = new ProjectPolicy(registry);
// A `.aio` the app was started with (double-click); the renderer takes it once at start.
let pendingOpenPath: string | null = packagePathFromArgv(process.argv);
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
  // Cloud AI also needs the open package's permission (AI-2, default forbid).
  cloudAllowed: () => policy.cloudAllowed(settings.current().cloudAi),
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

  handle('project:open', async ({ path, passphrase }) => {
    const r = await openProject(path, registry, passphrase);
    if (r.ok) {
      policy.opened(r.id);
      // Packages opened by double-click or File > Open stay in the library.
      if (r.package) await library.add(r.package.file).catch(() => undefined);
    }
    return r;
  });
  handle('project:writeIssues', ({ projectId, issues }) =>
    writeProjectIssues(registry, projectId, issues),
  );

  const packageJobs = createPackageJobs({
    registry,
    cache: createPlanCache(),
    createdBy: `${brand.productName} ${app.getVersion()}`,
    progress: (event) => {
      const parsed = ipcEvents['package:progress'].safeParse(event);
      if (parsed.success) targetWindow()?.webContents.send('package:progress', parsed.data);
    },
    chooseTarget: async (defaultName) => {
      const win = targetWindow();
      const options = {
        title: 'Export project package',
        defaultPath: join(app.getPath('documents'), defaultName),
        filters: [{ name: 'Project package', extensions: ['aio'] }],
      };
      const r = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
  });
  handle('package:plan', (req) => packageJobs.plan(req));
  handle('package:export', (req) => packageJobs.export(req));
  handle('package:cancel', (req) => packageJobs.cancel(req));

  handle('app:takeOpenPath', () => {
    const path = pendingOpenPath;
    pendingOpenPath = null;
    return { path };
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

  handle('dialog:saveFile', (req) => {
    // Export limits of an open package (APP-5).
    const refused = policy.checkExport(req.defaultName);
    if (refused) return { path: null, error: refused };
    return saveFile(req, {
      downloadsDir: app.getPath('downloads'),
      choose: async (defaultPath) => {
        const win = targetWindow();
        const options = { defaultPath, ...(req.title ? { title: req.title } : {}) };
        const r = win
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options);
        return r.canceled || !r.filePath ? null : r.filePath;
      },
    });
  });
}

/** Hand a package path to the renderer (second launch, macOS open-file). */
function openPathInApp(path: string): void {
  const win = mainWindow;
  if (!win) {
    pendingOpenPath = path;
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
  const parsed = ipcEvents['app:openPath'].safeParse({ path });
  if (parsed.success) win.webContents.send('app:openPath', parsed.data);
}

// macOS delivers double-clicked documents as an event, before or after ready.
app.on('open-file', (e, path) => {
  e.preventDefault();
  if (app.isReady()) openPathInApp(path);
  else pendingOpenPath = path;
});

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
  app.on('second-instance', (_e, argv) => {
    const path = packagePathFromArgv(argv);
    if (path) {
      openPathInApp(path);
      return;
    }
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
        projectPackage: (id) => registry.package(id)?.archive,
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
