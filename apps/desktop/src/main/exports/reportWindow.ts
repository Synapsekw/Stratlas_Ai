import type { ReportBrandingSettings } from '@aio/schema';
import { BrowserWindow } from 'electron';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportProgress, ExportResult } from './run';

/** What the report page (renderer `report.html`) publishes on `window.__report`. */
export interface ReportPageState {
  state: 'loading' | 'ready' | 'error';
  phase: string;
  done: number;
  total: number;
  error?: string;
  /** Issues laid out. */
  count?: number;
  /** Text printed at the foot of every page. */
  footer?: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** printToPDF footer: the page's footer text on the left, page numbers on the right. */
export function footerTemplate(text: string): string {
  return `<div style="width:100%;margin:0 12mm;display:flex;justify-content:space-between;font-family:'IBM Plex Sans',sans-serif;font-size:7.5pt;color:#7a8594"><span>${escapeHtml(text)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}

export interface ReportWindowOptions {
  /** Dev server URL of the renderer, when running `electron-vite dev`. */
  devUrl: string | undefined;
  devTools: boolean;
  /** Give up after this long (ms). */
  timeoutMs?: number;
  /** The person's report branding from Settings; absent for a neutral report. */
  branding?: ReportBrandingSettings | undefined;
}

/** Query of the report page: the project, the chosen issues and the person's branding. */
export function reportQuery(
  args: { projectId: string; issueIds?: string[] | undefined },
  branding: ReportBrandingSettings | undefined,
): Record<string, string> {
  const query: Record<string, string> = { project: args.projectId };
  if (args.issueIds) query.ids = args.issueIds.join(',');
  if (branding && Object.keys(branding).length > 0) query.branding = JSON.stringify(branding);
  return query;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The branded issue register report: an offscreen window lays the report out from the project
 * files (aio://), renders 3D snapshots and photo crops, then main prints it with printToPDF.
 */
export async function printReport(
  args: { projectId: string; outPath: string; issueIds?: string[] | undefined },
  progress: (p: ExportProgress) => void,
  signal: AbortSignal,
  opts: ReportWindowOptions,
): Promise<ExportResult> {
  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: opts.devTools,
    },
  });
  const part = `${args.outPath}.part`;
  const cancelled = () => signal.aborted;
  const query = reportQuery(args, opts.branding);
  try {
    if (opts.devUrl) {
      const url = new URL(
        'report.html',
        opts.devUrl.endsWith('/') ? opts.devUrl : `${opts.devUrl}/`,
      );
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      await win.loadURL(url.toString());
    } else {
      await win.loadFile(join(import.meta.dirname, '../renderer/report.html'), { query });
    }
    const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
    let state: ReportPageState | null = null;
    for (;;) {
      if (signal.aborted) throw new Error('Export cancelled.');
      if (Date.now() > deadline) throw new Error('The report took too long to lay out.');
      const raw = (await win.webContents.executeJavaScript(
        'JSON.stringify(window.__report ?? null)',
      )) as string;
      state = JSON.parse(raw) as ReportPageState | null;
      if (state?.state === 'error')
        throw new Error(state.error ?? 'The report could not be laid out.');
      if (state) progress({ phase: state.phase, done: state.done, total: state.total });
      if (state?.state === 'ready') break;
      await sleep(250);
    }
    progress({ phase: 'Printing the PDF', done: state.total, total: state.total });
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
      margins: { top: 0.5, bottom: 0.6, left: 0.5, right: 0.5 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footerTemplate(state.footer ?? ''),
    });
    if (cancelled()) throw new Error('Export cancelled.');
    await writeFile(part, pdf);
    await rename(part, args.outPath);
    return { count: state.count ?? 0, bytes: (await stat(args.outPath)).size };
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  } finally {
    win.destroy();
  }
}
