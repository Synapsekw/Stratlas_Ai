import type { AuditSummary } from '@aio/project/export';
import type { ReportBrandingSettings, ReportContentsSettings } from '@aio/schema';
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
  /** Text printed at the foot of every page (issue register; the house report draws its own). */
  footer?: string;
  /** Pages laid out (house report). */
  pages?: number;
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
  /** Sections of the house report from Settings; absent for every section. */
  contents?: ReportContentsSettings | undefined;
  /** M9: the audit head and change log the house report prints (from the journal). */
  audit?: AuditSummary | null | undefined;
  /** House report: the sign-off block (JSON) for section `approvals` (M9 T3). */
  signoff?: string | undefined;
  /** M10: the processing run the house report's `processing` section and the accuracy report print. */
  processingRun?: string | null | undefined;
}

/**
 * Query of the report page: the project, the chosen issues, the person's branding and (house
 * report) the chosen sections.
 */
export function reportQuery(
  args: { projectId: string; issueIds?: string[] | undefined },
  branding: ReportBrandingSettings | undefined,
  contents?: ReportContentsSettings,
  audit?: AuditSummary | null,
): Record<string, string> {
  const query: Record<string, string> = { project: args.projectId };
  if (args.issueIds) query.ids = args.issueIds.join(',');
  if (branding && Object.keys(branding).length > 0) query.branding = JSON.stringify(branding);
  if (contents && Object.keys(contents).length > 0) query.contents = JSON.stringify(contents);
  if (audit) query.audit = JSON.stringify(audit);
  return query;
}

/** The page main loads for a report kind. */
export const REPORT_PAGES = { register: 'report.html', house: 'house.html' } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The branded issue register report, or the house-format report: an offscreen window lays the
 * report out from the project files (aio://), renders 3D snapshots and photo crops, then main
 * prints it with printToPDF. The house report draws its own page frames, headers and footers.
 */
export async function printReport(
  args: {
    projectId: string;
    outPath: string;
    issueIds?: string[] | undefined;
    /** `processing`: the house page with the processing section alone (`photo-report-pdf`). */
    kind?: 'register' | 'house' | 'processing';
  },
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
  const processing = args.kind === 'processing';
  const house = args.kind === 'house' || processing;
  const page = REPORT_PAGES[house ? 'house' : 'register'];
  const query = reportQuery(
    args,
    opts.branding,
    house ? opts.contents : undefined,
    args.kind === 'house' ? opts.audit : undefined,
  );
  if (args.kind === 'house' && opts.signoff) query.signoff = opts.signoff;
  if (house && opts.processingRun) query.processing = opts.processingRun;
  if (processing) query.only = 'processing';
  try {
    if (opts.devUrl) {
      const url = new URL(page, opts.devUrl.endsWith('/') ? opts.devUrl : `${opts.devUrl}/`);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      await win.loadURL(url.toString());
    } else {
      await win.loadFile(join(import.meta.dirname, `../renderer/${page}`), { query });
    }
    const deadline = Date.now() + (opts.timeoutMs ?? (house ? 90 : 15) * 60_000);
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
    progress({
      phase: state.pages ? `Printing ${String(state.pages)} pages` : 'Printing the PDF',
      done: state.total,
      total: state.total,
    });
    const pdf = await win.webContents.printToPDF(
      house
        ? {
            printBackground: true,
            preferCSSPageSize: true,
            pageSize: 'A4',
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            displayHeaderFooter: false,
          }
        : {
            printBackground: true,
            preferCSSPageSize: true,
            pageSize: 'A4',
            margins: { top: 0.5, bottom: 0.6, left: 0.5, right: 0.5 },
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: footerTemplate(state.footer ?? ''),
          },
    );
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
