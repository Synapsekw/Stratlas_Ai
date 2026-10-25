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
  /** Pages laid out (house report, volumetric PDF). */
  pages?: number;
  /** `only=measurements-csv | stockpile-csv`: the CSV text main writes. */
  csv?: string;
  /** `only=volumetric-html`: the whole offline HTML file main writes. */
  html?: string;
  /** `only=volumetric-model`: the volumetric model (`VolumetricModel`, `@aio/project`). */
  model?: unknown;
}

/**
 * What a report window makes: the issue register or the house report (PDF), the processing run's
 * accuracy report (the processing section alone), the survey report (the survey sections alone,
 * M11) or a survey CSV the house page computes with the survey engine (`measurements-csv`,
 * `stockpile-csv`; written as the page publishes it, never printed). The volumetric customer
 * report is laid out by the same house page: `volumetric-pdf` prints, `volumetric-html` writes the
 * page's `window.__report.html`, and `volumetric-model` hands `window.__report.model` to the
 * editor's preview (`reportModel`, never printed).
 */
export type ReportKind =
  | 'register'
  | 'house'
  | 'processing'
  | 'survey'
  | 'measurements-csv'
  | 'stockpile-csv'
  | 'volumetric-pdf'
  | 'volumetric-html'
  | 'volumetric-model';

const isCsv = (k: ReportKind | undefined) => k === 'measurements-csv' || k === 'stockpile-csv';
const isVolumetric = (k: ReportKind | undefined) =>
  k === 'volumetric-pdf' || k === 'volumetric-html' || k === 'volumetric-model';

/** How long a report window may take to lay out: 90 minutes for the house report, else 15. */
export function reportDeadlineMs(kind: ReportKind | undefined): number {
  const house = kind !== undefined && kind !== 'register' && !isVolumetric(kind);
  return (house ? 90 : 15) * 60_000;
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
  /** M11: the project's prepared surfaces (`survey/surfaces/<id>`) the survey sections compute on. */
  surveySurfaces?: readonly string[] | undefined;
  /** M11: the haul-road and hydrology runs (ids, newest first) the `haul` and `hydrology` sections print. */
  surveyRuns?: { haul: readonly string[]; hydro: readonly string[] } | undefined;
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

/**
 * The whole query of the report page for a kind. The volumetric kinds ask the house page for
 * `only=<kind>` with the branding (the band's logo), the prepared surfaces and, for the editor's
 * model, the compared date (`compare`, a capture id); the page reads the rest (edits, pictures)
 * from the project itself.
 */
export function pageQuery(
  args: {
    projectId: string;
    issueIds?: string[] | undefined;
    kind?: ReportKind | undefined;
    compareWith?: string | undefined;
  },
  opts: Omit<ReportWindowOptions, 'devUrl' | 'devTools' | 'timeoutMs'>,
): Record<string, string> {
  if (isVolumetric(args.kind)) {
    const query = reportQuery({ projectId: args.projectId }, opts.branding);
    query.only = args.kind ?? '';
    if (args.compareWith) query.compare = args.compareWith;
    if (opts.surveySurfaces?.length) query.surfaces = opts.surveySurfaces.join(',');
    return query;
  }
  const house = args.kind !== undefined && args.kind !== 'register';
  const query = reportQuery(
    args,
    opts.branding,
    house ? opts.contents : undefined,
    args.kind === 'house' ? opts.audit : undefined,
  );
  if (args.kind === 'house' && opts.signoff) query.signoff = opts.signoff;
  if (house && opts.processingRun) query.processing = opts.processingRun;
  if (args.kind === 'processing') query.only = 'processing';
  if (args.kind === 'survey' || isCsv(args.kind)) query.only = args.kind ?? '';
  if (house && opts.surveySurfaces?.length) query.surfaces = opts.surveySurfaces.join(',');
  if (house && opts.surveyRuns?.haul.length) query.haul = opts.surveyRuns.haul.join(',');
  if (house && opts.surveyRuns?.hydro.length) query.hydro = opts.surveyRuns.hydro.join(',');
  return query;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const newReportWindow = (devTools: boolean) =>
  new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      devTools,
    },
  });

/** Load the report page and wait until it publishes `ready` (or throws its error). */
async function layOut(
  win: BrowserWindow,
  page: string,
  query: Record<string, string>,
  deadlineMs: number,
  progress: (p: ExportProgress) => void,
  signal: AbortSignal,
  devUrl: string | undefined,
): Promise<ReportPageState> {
  if (devUrl) {
    const url = new URL(page, devUrl.endsWith('/') ? devUrl : `${devUrl}/`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    await win.loadURL(url.toString());
  } else {
    await win.loadFile(join(import.meta.dirname, `../renderer/${page}`), { query });
  }
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (signal.aborted) throw new Error('Export cancelled.');
    if (Date.now() > deadline) throw new Error('The report took too long to lay out.');
    const raw = (await win.webContents.executeJavaScript(
      'JSON.stringify(window.__report ?? null)',
    )) as string;
    const state = JSON.parse(raw) as ReportPageState | null;
    if (state?.state === 'error')
      throw new Error(state.error ?? 'The report could not be laid out.');
    if (state) progress({ phase: state.phase, done: state.done, total: state.total });
    if (state?.state === 'ready') return state;
    await sleep(250);
  }
}

/**
 * The volumetric report's model for the editor's preview (`report:volumetricModel`): the same
 * hidden house page as the export, with `only=volumetric-model`, so the preview, the PDF and the
 * HTML share one computation. Never prints.
 */
export async function reportModel(
  args: { projectId: string; compareWith?: string | undefined },
  signal: AbortSignal,
  opts: ReportWindowOptions,
): Promise<unknown> {
  const win = newReportWindow(opts.devTools);
  try {
    const kind = 'volumetric-model';
    await layOut(
      win,
      REPORT_PAGES.house,
      pageQuery({ ...args, kind }, opts),
      opts.timeoutMs ?? reportDeadlineMs(kind),
      () => undefined,
      signal,
      opts.devUrl,
    );
    const raw = (await win.webContents.executeJavaScript(
      'JSON.stringify(window.__report?.model ?? null)',
    )) as string;
    const model = JSON.parse(raw) as unknown;
    if (model === null) throw new Error('The report page made no model.');
    return model;
  } finally {
    win.destroy();
  }
}

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
    kind?: ReportKind;
  },
  progress: (p: ExportProgress) => void,
  signal: AbortSignal,
  opts: ReportWindowOptions,
): Promise<ExportResult> {
  if (args.kind === 'volumetric-model')
    throw new Error('The volumetric model is handed to the editor, not exported.');
  const win = newReportWindow(opts.devTools);
  const part = `${args.outPath}.part`;
  const cancelled = () => signal.aborted;
  const csv = isCsv(args.kind);
  const html = args.kind === 'volumetric-html';
  const house = args.kind !== undefined && args.kind !== 'register';
  const page = REPORT_PAGES[house ? 'house' : 'register'];
  try {
    const state = await layOut(
      win,
      page,
      pageQuery(args, opts),
      opts.timeoutMs ?? reportDeadlineMs(args.kind),
      progress,
      signal,
      opts.devUrl,
    );
    if (csv || html) {
      const text = (await win.webContents.executeJavaScript(
        html ? 'String(window.__report?.html ?? "")' : 'String(window.__report?.csv ?? "")',
      )) as string;
      if (cancelled()) throw new Error('Export cancelled.');
      if (html && text === '') throw new Error('The report page made no HTML file.');
      await writeFile(part, text, 'utf8');
      await rename(part, args.outPath);
      return { count: state.count ?? 0, bytes: (await stat(args.outPath)).size };
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
