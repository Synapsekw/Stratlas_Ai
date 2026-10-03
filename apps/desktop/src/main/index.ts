import { brand } from '@aio/brand';
import { app, BrowserWindow, ipcMain, protocol, session, shell } from 'electron';
import { join } from 'node:path';
import { validated } from './ipc';
import { createAioHandler } from './protocol/handler';

/** Opened projects: id to root folder, the only folders aio://project/ may read. */
const projects = new Map<string, string>();

// aio:// serves project files, map packs and app assets with range requests (stream S1).
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
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' aio: data: blob:",
  "media-src 'self' aio: blob:",
  "connect-src 'self' aio: data: blob:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
].join('; ');

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
    },
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  // Never navigate away from the app or open windows inside it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => {
    e.preventDefault();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

void app.whenReady().then(() => {
  app.setAppUserModelId(brand.appId);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] },
    });
  });
  protocol.handle(
    'aio',
    createAioHandler({
      projectRoot: (id) => projects.get(id),
      packsDir: () => join(app.getPath('userData'), 'packs'),
    }),
  );

  ipcMain.handle('app:getInfo', (_e, req: unknown) =>
    validated('app:getInfo', () => ({
      name: brand.productName,
      version: app.getVersion(),
      platform: process.platform,
    }))(req),
  );

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
