import {
  builtInProviders,
  createAgentRuntime,
  createProviderRegistry,
  createScriptedProvider,
} from '@aio/ai/main';
import { brand } from '@aio/brand';
import {
  ipcEvents,
  PACKAGE_EXTENSION,
  type IpcChannel,
  type IpcEvent,
  type Settings,
} from '@aio/schema';
import { Entry } from '@napi-rs/keyring';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
} from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { arch, release, userInfo } from 'node:os';
import { join } from 'node:path';
import licenses from 'virtual:licenses';
import { createAiProjectStore, readAiPolicy } from './aiProjects';
import { listConversations, loadConversation, saveConversation } from './conversations';
import { demoProjectPaths } from './demo';
import { createExportJobs } from './exports/jobs';
import { printReport } from './exports/reportWindow';
import { listReports } from './exports/reports';
import { runInUtility } from './exports/utility';
import {
  builderImport,
  builderTemplates,
  builderUpdateLayers,
  createBuilderProject,
  photoGps,
} from './builder';
import { builderPipelineJobs } from './builderJobs';
import { importLogo, removeLogo } from './branding';
import { putThumb } from './thumbs';
import { nativeImageOps } from './images';
import { validated, type Handler } from './ipc';
import { findPack, JobRunner, JobStore, openTarget, safeJobEvent } from './jobs';
import { createKeyVault } from './keys';
import { addToLibrary, createLibraryStore, listLibrary } from './library';
import { captureConsole, createLog, exportLogs } from './logs';
import { embeddedPacks, findEmbedded, listWithEmbedded } from './packs/embed';
import { httpSource } from './packs/extract';
import { createPackManager } from './packs/manager';
import { buildSource, findLatestBuild } from './packs/pmtiles';
import { createOnlineUpdater, type UpdaterLike } from './update/online';
import { probeWithPowerShell, verifyInstaller } from './update/verify';
import { OFFSCREEN_SWITCHES, offscreenOrigin, windowMode } from './windowMode';
import { buildMenu } from './menu';
import { popupAction } from './popup';
import {
  createPackageJobs,
  createPlanCache,
  exportFormatRefusal,
  packagePathFromArgv,
  packageReports,
  ProjectPolicy,
  stagePackageExport,
} from './packages';
import { openProject, ProjectRegistry, readManifest, writeProjectIssues } from './project';
import { readPackageVolumes, readVolumes, writeBoundaries } from './boundaries';
import { folderFiles, packageFiles, readDetectionPasses, writeDetectionPass } from './detections';
import { createMaskAssist, loadOnnxRuntime } from './maskAssist';
import { resolveInside } from './protocol/paths';
import { writeCentreline } from './centreline';
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
// Test and agent runs (isolated profiles) keep their windows off-screen; see windowMode.ts.
const winMode = windowMode(process.env);
if (winMode === 'offscreen') {
  for (const [name, value] of OFFSCREEN_SWITCHES) app.commandLine.appendSwitch(name, value);
}

/** Off-screen placement for every window when running under an isolated profile. */
function placement(width: number): { x?: number; y?: number; skipTaskbar?: boolean } {
  if (winMode !== 'offscreen') return {};
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  return { ...offscreenOrigin(displays, width), skipTaskbar: true };
}

/** Show a window without stealing focus when it lives off-screen. */
function reveal(win: BrowserWindow): void {
  if (winMode === 'offscreen') win.showInactive();
  else win.show();
}

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
/** The person's report logo (Settings, Report branding). */
const brandingDir = () => join(app.getPath('userData'), 'branding');
/** Thumbnails the renderer generated for project images without their own (Media). */
const thumbsDir = () => join(app.getPath('userData'), 'cache', 'thumbs');
const policy = new ProjectPolicy(registry);
// A `.aio` the app was started with (double-click); the renderer takes it once at start.
let pendingOpenPath: string | null = packagePathFromArgv(process.argv);
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

// The map pack download is one of only two network paths (the other is cloud AI), and runs
// only when the person starts it in Settings, Maps. Planet builds come from Protomaps (or the
// STRATLAS_PACK_SOURCE mirror) by HTTP ranges, so a cut-off download continues where it stopped.
const planetBuilds = buildSource(process.env);
// Map data is fetched in its own session: the default session blocks every http(s) request so
// the renderer stays offline by construction (hardenSession).
const mapFetch = (url: string, init?: RequestInit) =>
  session.fromPartition('stratlas-maps').fetch(url, init);
const packs = createPackManager({
  packsDir: () => join(settings.current().dataRoot, 'packs'),
  offlineOnly: () => settings.current().offlineOnly === true,
  emit: (job) => {
    broadcast('packs:job', job);
  },
  source: (url, identity) => httpSource(url, mapFetch, identity),
  buildBase: planetBuilds.base,
  latestBuild: (signal) => findLatestBuild(mapFetch, signal, planetBuilds),
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

const aiProjects = createAiProjectStore(join(app.getPath('userData'), 'ai-projects.json'));
/** Names of opened projects by id, for the usage list in Settings. */
const projectNames = new Map<string, string>();

/**
 * End-to-end tests drive the agent with a scripted model in place of the three cloud providers.
 * Only an isolated profile can ask for it, so a person's installation never runs it.
 */
const scripted =
  process.env.STRATLAS_AI_TEST_PROVIDER === '1' && Boolean(process.env.STRATLAS_USER_DATA);
const providers = createProviderRegistry(
  scripted
    ? (['anthropic', 'openai', 'google'] as const).map((id) => createScriptedProvider(id))
    : builtInProviders({
        // Keys not scoped to a workspace need the workspace ID (Settings, AI providers).
        anthropicWorkspaceId: () => settings.current().anthropicWorkspaceId,
      }),
);

const agent = createAgentRuntime(
  {
    getKey: (provider) => keys.getKey(provider),
    // Cloud AI also needs the open package's permission (AI-2, default forbid).
    cloudAllowed: () => policy.cloudAllowed(settings.current().cloudAi),
    routes: () => settings.current().routes,
    localModel: () => settings.current().localModel,
    policy: async (projectId) => {
      const root = registry.root(projectId);
      // Packages are guarded by cloudAllowed above; a folder project may also forbid in its manifest.
      return root === undefined ? 'allow' : readAiPolicy(root).catch(() => 'allow' as const);
    },
    recordUsage: (projectId, usage) => {
      const root = registry.root(projectId);
      if (root !== undefined)
        aiProjects.addUsage(root, projectNames.get(projectId) ?? projectId, usage);
    },
    emit: emitAiEvent,
  },
  { providers },
);

/** The folder of an open project, or a fixed message the panel can show. */
function openRoot(projectId: string): { root: string } | { error: string } {
  const root = registry.root(projectId);
  return root === undefined
    ? { error: `Project "${projectId}" is not open. Open it, then try again.` }
    : { root };
}

function emitExportProgress(event: IpcEvent<'export:progress'>): void {
  const parsed = ipcEvents['export:progress'].safeParse(event);
  if (parsed.success) targetWindow()?.webContents.send('export:progress', parsed.data);
}

/** Save dialog for exports, parented to the app window. */
async function chooseSavePath(
  defaultPath: string,
  filter: { name: string; extensions: string[] },
): Promise<string | null> {
  const win = targetWindow();
  const options = { defaultPath, filters: [filter], title: 'Export' };
  const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  return r.canceled || !r.filePath ? null : r.filePath;
}

const exportJobs = createExportJobs({
  projectRoot: (id) => registry.root(id),
  // Package export limits (APP-5): the header's allow-list, checked before the save dialog.
  refuse: (id, format) => exportFormatRefusal(registry.package(id)?.header, format),
  // A package is read in place: its manifest and issues are staged in a temp folder for the job.
  stage: async (id) => {
    const pkg = registry.package(id);
    return pkg ? stagePackageExport(pkg, app.getPath('temp')) : undefined;
  },
  projectName: async (root) => {
    const m = await readManifest(root);
    return m.ok ? m.value.name : 'project';
  },
  get downloadsDir() {
    return app.getPath('downloads');
  },
  chooseSavePath,
  runFile: runInUtility,
  printReport: async (args, progress, signal) =>
    printReport(args, progress, signal, {
      devUrl,
      devTools: dev,
      branding: (await settings.get()).reportBranding,
    }),
  emit: emitExportProgress,
});

const jobStore = new JobStore(join(app.getPath('userData'), 'jobs.json'));
const jobs = new JobRunner({
  store: jobStore,
  findPack: () => findPack({ dataRoot: settings.current().dataRoot, env: process.env }),
  emit: (event) => {
    const safe = safeJobEvent(event);
    if (!safe) {
      console.error(`Dropped an invalid jobs:event of type ${event.type}.`);
      return;
    }
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) win.webContents.send('jobs:event', safe);
  },
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

  // Report branding: the person's own logo, copied into userData (never into a project).
  handle('branding:setLogo', async ({ path }) => {
    const r = await importLogo(path, brandingDir());
    if (!r.ok) return r;
    const before = (await settings.get()).reportBranding;
    const next = await settings.set({ reportBranding: { ...before, logo: r.file } });
    if (before?.logo !== r.file) await removeLogo(brandingDir(), before?.logo);
    return { ok: true as const, settings: next };
  });
  handle('branding:clearLogo', async () => {
    const before = (await settings.get()).reportBranding;
    const rest = { ...before };
    delete rest.logo;
    const next = await settings.set({ reportBranding: rest });
    await removeLogo(brandingDir(), before?.logo);
    return next;
  });
  handle('thumbs:put', async ({ projectId, path, data }) => {
    const archive = registry.package(projectId)?.archive;
    const root = registry.root(projectId);
    const src = archive ? { archive } : root !== undefined ? { root } : null;
    return { ok: src ? await putThumb(src, path, data, thumbsDir()) : false };
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

  handle('project:open', async ({ path, passphrase }) => {
    const r = await openProject(path, registry, passphrase);
    if (r.ok) {
      policy.opened(r.id);
      projectNames.set(r.id, r.manifest.name);
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
    packs: { dir: () => join(settings.current().dataRoot, 'packs'), list: () => packs.list() },
    tempDir: () => app.getPath('temp'),
    dataRoot: () => settings.current().dataRoot,
    ...osUser(),
  });
  handle('package:plan', (req) => packageJobs.plan(req));
  handle('package:export', (req) => packageJobs.export(req));
  handle('package:extract', (req) => packageJobs.extract(req));
  handle('package:cancel', (req) => packageJobs.cancel(req));

  handle('app:takeOpenPath', () => {
    const path = pendingOpenPath;
    pendingOpenPath = null;
    return { path };
  });
  handle('project:readVolumes', ({ projectId }) => {
    const root = registry.root(projectId);
    if (root !== undefined) return readVolumes(root);
    const pkg = registry.package(projectId);
    if (pkg) return readPackageVolumes(pkg.archive);
    return { ok: false, error: `Project "${projectId}" is not open.` };
  });
  handle('project:writeBoundaries', ({ projectId, file }) => {
    if (registry.package(projectId))
      return {
        ok: false,
        error: 'This project is a read-only package. Boundaries cannot be changed.',
      };
    const root = registry.root(projectId);
    if (root === undefined) {
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then save again.` };
    }
    return writeBoundaries(root, file);
  });
  handle('project:writeCentreline', ({ projectId, coordinates }) => {
    if (registry.package(projectId))
      return {
        ok: false,
        error: 'This project is a read-only package. Nothing can be saved in it.',
      };
    const root = registry.root(projectId);
    if (root === undefined)
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then save again.` };
    return writeCentreline(root, coordinates);
  });

  // Detection review (BLD-5) and AI-assisted detection (BLD-6).
  handle('detections:read', async ({ projectId }) => {
    const pkg = registry.package(projectId);
    if (pkg) return readDetectionPasses(packageFiles(pkg.archive), pkg.manifest, true);
    const root = registry.root(projectId);
    if (root === undefined) return { ok: false, error: `Project "${projectId}" is not open.` };
    const manifest = await readManifest(root);
    if (!manifest.ok) return { ok: false, error: manifest.error };
    return readDetectionPasses(folderFiles(root), manifest.value, false);
  });
  handle('detections:write', ({ projectId, name, file }) => {
    if (registry.package(projectId))
      return {
        ok: false,
        error: 'This project is a read-only package. Detections are not saved into it.',
      };
    const root = registry.root(projectId);
    if (root === undefined) {
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then save again.` };
    }
    return writeDetectionPass(root, name, file);
  });
  const maskAssist = createMaskAssist({
    packDir: async () =>
      (await findPack({ dataRoot: settings.current().dataRoot, env: process.env })).pack?.dir ??
      null,
    loadRuntime: loadOnnxRuntime,
    decode: (path, maxSide) => {
      const img = nativeImage.createFromPath(path);
      if (img.isEmpty()) return Promise.reject(new Error(`Could not decode ${path}`));
      const { width, height } = img.getSize();
      const s = Math.min(1, maxSide / Math.max(width, height));
      const scaled =
        s < 1 ? img.resize({ width: Math.round(width * s), height: Math.round(height * s) }) : img;
      const size = scaled.getSize();
      // toBitmap is BGRA on every platform Electron supports here: swap to RGBA.
      const bgra = scaled.toBitmap();
      const rgba = new Uint8Array(bgra.length);
      for (let i = 0; i < bgra.length; i += 4) {
        rgba[i] = bgra[i + 2] ?? 0;
        rgba[i + 1] = bgra[i + 1] ?? 0;
        rgba[i + 2] = bgra[i] ?? 0;
        rgba[i + 3] = bgra[i + 3] ?? 255;
      }
      return Promise.resolve({
        width,
        height,
        scaledWidth: size.width,
        scaledHeight: size.height,
        rgba,
      });
    },
  });
  handle('detections:maskAssistStatus', () => maskAssist.status());
  handle('detections:maskAssist', async ({ projectId, path, box }) => {
    const root = registry.root(projectId);
    if (root === undefined)
      return { ok: false, error: 'Mask assist works on projects opened from a folder.' };
    const r = await resolveInside(root, path);
    if (!r.ok) return { ok: false, error: `The photo ${path} is not in this project.` };
    return maskAssist.segment(r.path, box);
  });
  handle('ai:detect', (req) => agent.detect(req));

  // Map packs carried by open packages join the list when this machine lacks that area.
  handle('packs:list', async () => {
    const installed = await packs.list();
    const open = registry.openPackages();
    return listWithEmbedded(installed, await embeddedPacks(installed, open));
  });
  handle('packs:jobs', () => packs.jobs());
  handle('packs:download', (region) => packs.download(region));
  handle('packs:cancel', ({ id }) => packs.cancel(id));
  handle('packs:resume', ({ id }) => packs.resume(id));
  handle('packs:dismiss', ({ id }) => packs.dismiss(id));
  handle('packs:remove', ({ id }) => packs.remove(id));
  handle('packs:import', ({ path, label }) => packs.importFile(path, label));

  // dialog:openFile (packages, installers, map pack files) is registered once, below.
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
  handle('ai:testConnection', (req) => agent.testConnection(req));
  handle('ai:send', (req) => agent.send(req));
  handle('ai:toolResult', (req) => {
    agent.toolResult(req);
    return { ok: true };
  });
  handle('ai:cancel', ({ runId }) => {
    agent.cancel(runId);
    return { ok: true };
  });
  handle('ai:status', (req) => agent.status(req));
  handle('ai:project', async ({ projectId }) => {
    const root = registry.root(projectId);
    if (root === undefined) return { alwaysAllow: false, policy: 'allow' as const, usage: [] };
    const [state, policy] = await Promise.all([aiProjects.get(root), readAiPolicy(root)]);
    return { ...state, policy };
  });
  handle('ai:setConsent', async ({ projectId, alwaysAllow }) => {
    const r = openRoot(projectId);
    if ('error' in r) return { ok: false, error: r.error };
    await aiProjects.setConsent(r.root, projectNames.get(projectId) ?? projectId, alwaysAllow);
    return { ok: true };
  });
  handle('ai:usage', async () => ({ projects: await aiProjects.list() }));
  handle('ai:listConversations', ({ projectId }) => {
    const r = openRoot(projectId);
    return 'error' in r
      ? { ok: false, conversations: [], error: r.error }
      : listConversations(r.root);
  });
  handle('ai:loadConversation', ({ projectId, id }) => {
    const r = openRoot(projectId);
    return 'error' in r ? { ok: false, error: r.error } : loadConversation(r.root, id);
  });
  handle('ai:saveConversation', ({ projectId, conversation }) => {
    const r = openRoot(projectId);
    if ('error' in r) return { ok: false, error: r.error };
    // Tracked so quitting waits for it: a waiting approval must survive the app closing.
    const write = saveConversation(r.root, conversation);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
    return write;
  });

  handle('jobs:list', () => jobs.list());
  handle('jobs:start', (req) => {
    // A package is read-only: pipelines write into a project folder only.
    if ('project' in req && req.project.toLowerCase().endsWith(PACKAGE_EXTENSION))
      return {
        ok: false,
        error: 'Pipelines run on a project folder. A .aio package is read-only.',
      };
    return jobs.start(req);
  });
  handle('jobs:cancel', ({ jobId }) => jobs.cancel(jobId));
  handle('jobs:log', async ({ jobId, tail }) => ({ lines: await jobs.log(jobId, tail) }));
  handle('jobs:open', async ({ jobId, what }) => {
    const job = jobs.get(jobId);
    if (!job) return { ok: false, error: `There is no job ${jobId}.` };
    const target = openTarget(job, what);
    if (!target) return { ok: false, error: 'This job has not written any output yet.' };
    if (target.action === 'reveal') {
      shell.showItemInFolder(target.path);
      return { ok: true };
    }
    const error = await shell.openPath(target.path);
    return error ? { ok: false, error } : { ok: true };
  });

  handle('dialog:openFolder', async ({ title }) => {
    const win = targetWindow();
    const options = { properties: ['openDirectory' as const], ...(title ? { title } : {}) };
    const r = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return { path: r.canceled ? null : (r.filePaths[0] ?? null) };
  });

  handle('export:run', (req) => exportJobs.run(req));
  handle('export:cancel', ({ jobId }) => ({ ok: exportJobs.cancel(jobId) }));
  handle('report:list', async ({ projectId }) => {
    const root = registry.root(projectId);
    if (root !== undefined) return { files: await listReports(root) };
    // a package lists the PDFs it carries; the viewer reads them in place
    const pkg = registry.package(projectId);
    return { files: pkg ? packageReports(pkg.archive) : [] };
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

  handle('dialog:openFiles', async ({ title, filters, multi }) => {
    const win = targetWindow();
    const options = {
      properties: ['openFile' as const, ...(multi === false ? [] : ['multiSelections' as const])],
      ...(title ? { title } : {}),
      ...(filters ? { filters } : {}),
    };
    const r = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return { paths: r.canceled ? [] : r.filePaths };
  });

  handle('builder:templates', async () =>
    builderTemplates((await settings.get()).dataRoot, await library.paths()),
  );
  handle('builder:createProject', async (req) =>
    createBuilderProject(req, (await settings.get()).dataRoot, await library.paths()),
  );
  handle('builder:photoGps', ({ path }) => photoGps(path));
  // A package is read-only: nothing is imported into it and no layer is re-aligned.
  const packageRefusal = (projectId: string) =>
    registry.package(projectId)
      ? {
          ok: false as const,
          error: 'This project is a read-only package. Nothing can be added or changed.',
        }
      : null;
  handle(
    'builder:import',
    (req) =>
      packageRefusal(req.projectId) ??
      builderImport(req, {
        registry,
        images: nativeImageOps,
        // point clouds convert in the pipeline pack as jobs (Jobs panel)
        jobs: builderPipelineJobs(jobs),
        emit: (e) => {
          const parsed = ipcEvents['builder:progress'].safeParse(e);
          if (parsed.success) targetWindow()?.webContents.send('builder:progress', parsed.data);
        },
      }),
  );
  handle(
    'builder:updateLayers',
    (req) => packageRefusal(req.projectId) ?? builderUpdateLayers(req, registry),
  );

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
    backgroundColor: chrome().background,
    autoHideMenuBar: true,
    show: false,
    ...placement(1100),
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
  win.once('ready-to-show', () => {
    reveal(win);
  });
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
    ...placement(1440),
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: chrome().overlay, symbolColor: chrome().symbols, height: 40 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      backgroundThrottling: winMode !== 'offscreen',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: dev,
    },
  });
  win.once('ready-to-show', () => {
    reveal(win);
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Release smoke check: the packaged app must load its UI and exit 0 (tools/release/smoke-packaged.mjs).
  if (process.env.STRATLAS_SMOKE === '1') {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        app.exit(0);
      }, 1500);
    });
    win.webContents.once('render-process-gone', () => {
      app.exit(2);
    });
  }
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
    const initial = await settings.get();
    nativeTheme.themeSource = initial.theme;
    nativeTheme.on('updated', () => {
      applyTheme(settings.current().theme);
    });
    await packs.restore().catch((e: unknown) => {
      console.warn('Map pack jobs could not be restored', e);
    });
    await jobStore.load();
    protocol.handle(
      'aio',
      createAioHandler({
        projectRoot: (id) => registry.root(id),
        projectPackage: (id) => registry.package(id)?.archive,
        packsDir: () => join(settings.current().dataRoot, 'packs'),
        thumbsDir,
        brandingDir,
        embeddedPack: (id) => findEmbedded(id, registry.openPackages()),
      }),
    );
    registerIpc();

    mainWindow = createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });
}

/** Conversation saves still being written; quitting waits for them (at most 3 s). */
const pendingWrites = new Set<Promise<unknown>>();

// Usage is written in batches and conversations on every change; finish both before exiting.
let usageFlushed = false;
app.on('before-quit', (e) => {
  if (usageFlushed) return;
  e.preventDefault();
  usageFlushed = true;
  const writes = Promise.allSettled([aiProjects.flush(), ...pendingWrites]);
  const limit = new Promise((resolve) => setTimeout(resolve, 3000));
  void Promise.race([writes, limit]).finally(() => {
    app.quit();
  });
});

// Running pipelines stop with the app; their jobs show as interrupted and resume later.
app.on('will-quit', () => {
  jobs.shutdownSync();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
