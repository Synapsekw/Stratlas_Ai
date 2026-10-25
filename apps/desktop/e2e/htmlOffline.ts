/**
 * Open an exported HTML file the way a customer would, offline: a hidden window in a fresh
 * partition (no cache, no cookies, nothing the app's own session holds) whose every request that
 * is not `file:`, `data:` or `blob:` is cancelled and recorded. The test then drives the page
 * through Playwright, reads what it tried to reach and prints it to PDF.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** What the offline window recorded, read from the main process. */
interface OfflineLog {
  requests: string[];
}

export interface OfflineWindow {
  page: Page;
  /** Requests the page attempted that were not `file:`, `data:` or `blob:` (all cancelled). */
  requests: () => Promise<string[]>;
  /** `printToPDF` of the window (A4, the page's CSS size), written to `file`. */
  printToPdf: (file: string) => Promise<void>;
  close: () => Promise<void>;
}

let opened = 0;

/**
 * Open `file` in a hidden window of a new offline partition. Its downloads are Playwright's (the
 * page's `download` event): Playwright takes the window's downloads over, so Electron's own
 * `will-download` item would only report them interrupted.
 */
export async function openOffline(app: ElectronApplication, file: string): Promise<OfflineWindow> {
  opened++;
  const key = `e2e-offline-${String(opened)}`;
  const partition = `${key}-${String(Date.now())}`;
  const pageEvent = app.waitForEvent('window', { timeout: 60_000 });
  await app.evaluate(
    ({ BrowserWindow, session }, { file, partition, key }) => {
      const logs = ((globalThis as { __aioOffline?: Record<string, OfflineLog> }).__aioOffline ??=
        {});
      const log: OfflineLog = { requests: [] };
      logs[key] = log;
      const ses = session.fromPartition(partition, { cache: false });
      ses.webRequest.onBeforeRequest((details, callback) => {
        const protocol = details.url.split(':')[0]?.toLowerCase() ?? '';
        if (['file', 'data', 'blob', 'devtools'].includes(protocol)) {
          callback({});
          return;
        }
        log.requests.push(details.url);
        callback({ cancel: true });
      });
      const w = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      const ids = ((globalThis as { __aioOfflineWin?: Record<string, number> }).__aioOfflineWin ??=
        {});
      ids[key] = w.id;
      void w.loadFile(file);
    },
    { file, partition, key },
  );
  const page = await pageEvent;
  await page.waitForLoadState('load');

  const read = () =>
    app.evaluate(
      (_e, k) =>
        (globalThis as { __aioOffline?: Record<string, OfflineLog> }).__aioOffline?.[k] ?? {
          requests: [],
        },
      key,
    );
  return {
    page,
    requests: async () => (await read()).requests,
    printToPdf: async (out) => {
      const base64 = await app.evaluate(async ({ BrowserWindow }, k) => {
        const id = (globalThis as { __aioOfflineWin?: Record<string, number> }).__aioOfflineWin?.[
          k
        ];
        const w = id === undefined ? null : BrowserWindow.fromId(id);
        if (!w) throw new Error('the offline window is gone');
        const pdf = await w.webContents.printToPDF({ preferCSSPageSize: true });
        return pdf.toString('base64');
      }, key);
      await writeFile(out, Buffer.from(base64, 'base64'));
    },
    close: async () => {
      await app.evaluate(({ BrowserWindow }, k) => {
        const id = (globalThis as { __aioOfflineWin?: Record<string, number> }).__aioOfflineWin?.[
          k
        ];
        if (id !== undefined) BrowserWindow.fromId(id)?.destroy();
      }, key);
    },
  };
}
