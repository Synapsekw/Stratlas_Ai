// The house-format project report page (BLD-8). Main loads it in an offscreen window, polls
// `window.__report` for progress, and prints it with printToPDF once `state` is `ready`.
import '../../zodJitless';
import '@aio/ui/fonts.css';
import './house.css';
import { brand } from '@aio/brand';
import {
  HOUSE_SECTIONS,
  houseReportModel,
  issueAction,
  measurementsCsv,
  narrativeFacts,
  processingSummary,
  resolveReportBranding,
  stockpileCsv,
  RUN_SECTIONS,
  SURVEY_SECTIONS,
  type AuditSummary,
  type HouseModel,
  type ProcessingSummary,
} from '@aio/project/export';
import {
  AccuracyReport,
  BoundaryEditsFile,
  currentNarrative,
  Issue,
  NarrativeFile,
  parseManifest,
  parseRoadModel,
  PHOTO_RUN_FILES,
  PhotoRun,
  photoRunDir,
  PhotoRunId,
  ReportContentsSettings,
  VolumesFile,
  type NarrativeSectionId,
  type Issue as IssueT,
  type ProjectManifest,
  type ReportSectionId,
} from '@aio/schema';
import { t } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { z } from 'zod';
import { longDate, templateNarrative } from '../../report/narrativeTemplate';
import { brandingFromQuery } from '../layout';
import { createSnapshotter, type Snapshotter } from '../snapshots';
import { locatorMap } from './charts';
import { issuePhotos } from './images';
import { Pager } from './pager';
import {
  backHtml,
  contentsHtml,
  coverHtml,
  disclaimerOf,
  frameHtml,
  issuePageHtml,
  kickerOf,
  layoutAppendices,
  layoutAudit,
  layoutProcessing,
  layoutRegister,
  layoutScope,
  layoutSite,
  layoutStatistics,
  layoutSummary,
  SECTION_LAYOUTS,
  sectionTitle,
  type ContentsEntry,
  type HouseContext,
  type IssueImages,
} from './sections';
import { layoutApprovals, parseSignOff } from '../../team/houseApprovals';
import { readSiteRuns, runSectionIds, type SiteRuns } from './runs';
import { buildSurveyData, readSurveyFiles, surveySectionIds, type SurveyFiles } from './surveyData';

interface PageState {
  state: 'loading' | 'ready' | 'error';
  phase: string;
  done: number;
  total: number;
  error?: string;
  count?: number;
  pages?: number;
  /** Seconds spent per phase, for the e2e timing report. */
  timings?: Record<string, number>;
  /** A survey CSV export (`only` = `measurements-csv` or `stockpile-csv`): the file's text. */
  csv?: string;
}

const w = window as unknown as { __report: PageState };
w.__report = { state: 'loading', phase: 'Reading the project', done: 0, total: 0 };
const set = (patch: Partial<PageState>) => {
  w.__report = { ...w.__report, ...patch };
};

async function json(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${String(r.status)}`);
  return (await r.json()) as unknown;
}

/** A project file, or null when it is missing or unreadable. */
async function optional(projectId: string, path: string): Promise<unknown> {
  try {
    const r = await fetch(assetUrl(projectId, { path }));
    return r.ok ? ((await r.json()) as unknown) : null;
  } catch {
    return null;
  }
}

function parsed<T>(schema: z.ZodType<T>, raw: unknown, what: string): T | null {
  if (raw === null) return null;
  const r = schema.safeParse(raw);
  if (!r.success) console.warn(`Report: ${what} is invalid and left out`, r.error.issues[0]);
  return r.success ? r.data : null;
}

const blobUrl = (b: Blob | null | undefined) => (b ? URL.createObjectURL(b) : undefined);
const two = (n: number) => String(n).padStart(2, '0');

/** Does the issue's severity level say what to do (else the report shows what it means)? */
function hasAction(m: ProjectManifest, issue: IssueT): boolean {
  if (issue.severity === 'uncertain') return false;
  const model = m.severityModels.find((s) => s.id === issue.severityModelId);
  return Boolean(model?.levels.find((l) => l.value === issue.severity)?.action);
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Name and capture time of the photo an issue page shows. */
function photoFacts(
  m: ProjectManifest,
  layer: string,
  photo: string,
): { name: string; at: string } {
  const l = m.layers.find((x) => x.id === layer);
  if (l?.kind !== 'photos') return { name: '', at: '' };
  const item = l.items.find((i) => i.id === photo);
  const path = item && 'path' in item.src ? item.src.path : '';
  const at = item?.takenAt ? `${longDate(item.takenAt)}, ${item.takenAt.slice(11, 16)}` : '';
  return { name: path.split('/').pop() ?? photo, at };
}

async function run(): Promise<void> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const lap = (name: string, since: number) => {
    timings[name] = Math.round((performance.now() - since) / 100) / 10;
  };
  const params = new URLSearchParams(location.search);
  const projectId = params.get('project');
  if (!projectId) throw new Error('No project given to the report.');
  const ids = params.get('ids');
  const pm = parseManifest(await json(assetUrl(projectId, { path: 'manifest.json' })));
  if (!pm.ok) throw new Error(pm.error);
  const manifest = pm.value;
  const file = z
    .object({ issues: z.array(Issue) })
    .parse(await json(assetUrl(projectId, { path: 'issues.json' })));
  const wanted = ids ? new Set(ids.split(',')) : null;
  const issues = wanted ? file.issues.filter((i) => wanted.has(i.id)) : file.issues;
  const [narrativeRaw, volumesRaw, editsRaw, roadRaw] = await Promise.all([
    optional(projectId, 'report/narrative.json'),
    optional(projectId, 'volumes.json'),
    optional(projectId, 'edits/boundaries.json'),
    optional(projectId, 'road.json'),
  ]);
  const narrative = parsed(NarrativeFile, narrativeRaw, 'report/narrative.json');
  const signoff = parseSignOff(params.get('signoff'));
  const road = roadRaw === null ? null : parseRoadModel(roadRaw);
  // Branding is the person's own (Settings, Report branding), never the project's client brand.
  const branding = resolveReportBranding(
    brandingFromQuery(params.get('branding')),
    brand.productName,
  );
  // M9: the audit head and change log main read from the journal (absent: no journal)
  let audit: AuditSummary | null;
  try {
    const raw = params.get('audit');
    audit = raw ? (JSON.parse(raw) as AuditSummary) : null;
  } catch {
    audit = null;
  }
  let contents: ReportContentsSettings | undefined;
  try {
    const raw = params.get('contents');
    contents = raw ? ReportContentsSettings.parse(JSON.parse(raw)) : undefined;
  } catch {
    contents = undefined;
  }
  // M10: the accuracy of the processing run main named (the latest finished one)
  let processing: ProcessingSummary | null = null;
  const runId = PhotoRunId.safeParse(params.get('processing'));
  if (runId.success) {
    const base = photoRunDir(runId.data);
    const [accRaw, runRaw] = await Promise.all([
      optional(projectId, `${base}/${PHOTO_RUN_FILES.accuracy}`),
      optional(projectId, `${base}/${PHOTO_RUN_FILES.run}`),
    ]);
    const acc = parsed(AccuracyReport, accRaw, PHOTO_RUN_FILES.accuracy);
    if (acc) processing = processingSummary(acc, parsed(PhotoRun, runRaw, 'run.json'), manifest);
  }
  // the run's accuracy report PDF: the processing section alone, behind its own cover
  const onlyParam = params.get('only');
  const only = onlyParam === 'processing';
  if (only) {
    if (!processing) throw new Error('This project has no processing run with an accuracy report.');
    contents = {
      sections: Object.fromEntries(HOUSE_SECTIONS.map((id) => [id, id === 'processing'])),
    };
  }
  // M11: the survey sections (and the survey report PDF and CSVs: the survey data alone)
  const surveyOnly = onlyParam === 'survey';
  const csvKind =
    onlyParam === 'measurements-csv' || onlyParam === 'stockpile-csv' ? onlyParam : null;
  const surfaceIds = (params.get('surfaces') ?? '').split(',').filter((x) => x !== '');
  const read = {
    json: (path: string) => optional(projectId, path),
    text: async (path: string) => {
      try {
        const r = await fetch(assetUrl(projectId, { path }));
        return r.ok ? await r.text() : null;
      } catch {
        return null;
      }
    },
    bytes: async (path: string) => {
      try {
        const r = await fetch(assetUrl(projectId, { path }));
        return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
      } catch {
        return null;
      }
    },
  };
  let surveyFiles: SurveyFiles | null = null;
  try {
    surveyFiles = await readSurveyFiles(read, manifest, surfaceIds);
  } catch (e) {
    console.warn('Report: the survey files are unreadable and left out', e);
  }
  if ((surveyOnly || csvKind) && !surveyFiles)
    throw new Error('This project has no saved survey measurements.');
  const progress = (phase: string) => (done: number, total: number) => {
    set({ phase, done, total });
  };
  if (csvKind && surveyFiles) {
    const data = await buildSurveyData(surveyFiles, read.bytes, {
      need: csvKind,
      progress: progress('Computing the survey volumes'),
    });
    const csv = csvKind === 'measurements-csv' ? measurementsCsv(data) : stockpileCsv(data);
    const count =
      csvKind === 'measurements-csv' ? data.measurements.length : data.stockpiles.rows.length;
    set({ state: 'ready', phase: 'Ready', done: count, total: count, count, csv });
    return;
  }
  // the haul-road and hydrology runs main named (newest first)
  const runIds = (k: string) => (params.get(k) ?? '').split(',').filter((x) => x !== '');
  let runs: SiteRuns | null = null;
  if (runIds('haul').length > 0 || runIds('hydro').length > 0) {
    try {
      runs = await readSiteRuns(read, manifest, { haul: runIds('haul'), hydro: runIds('hydro') });
    } catch (e) {
      console.warn('Report: the haul-road and hydrology runs are unreadable and left out', e);
    }
  }
  const surveySections = [
    ...(surveyFiles ? surveySectionIds(surveyFiles) : []),
    ...runSectionIds(runs),
  ];
  if (surveyOnly)
    contents = {
      sections: Object.fromEntries(
        HOUSE_SECTIONS.map((id) => [
          id,
          ([...SURVEY_SECTIONS, ...RUN_SECTIONS] as readonly ReportSectionId[]).includes(id),
        ]),
      ),
    };
  const h: HouseModel = houseReportModel({
    manifest,
    issues,
    branding,
    contents,
    volumes: parsed(VolumesFile, volumesRaw, 'volumes.json'),
    edits: parsed(BoundaryEditsFile, editsRaw, 'edits/boundaries.json'),
    road: road?.ok ? road.value : null,
    audit,
    processing,
    surveySections,
  });
  document.title = only
    ? `${h.base.title} accuracy report`
    : surveyOnly
      ? `${h.base.title} survey report`
      : `${h.base.title} report`;
  const template = templateNarrative(narrativeFacts(h), { todo: false });
  const text = Object.fromEntries(
    (['summary', 'method', 'findings'] as const).map((id: NarrativeSectionId) => [
      id,
      currentNarrative(narrative, id) ?? template[id],
    ]),
  ) as Record<NarrativeSectionId, string>;
  lap('read', t0);

  // The person's accent colour
  if (branding.accent) {
    const a = branding.accent;
    const style = document.createElement('style');
    style.textContent = `:root{--acc:${a};--acc-ink:color-mix(in srgb, ${a} 45%, #0b141a);--acc-soft:color-mix(in srgb, ${a} 12%, #ffffff);--acc-light:color-mix(in srgb, ${a} 55%, #ffffff)}`;
    document.head.appendChild(style);
  }

  const t1 = performance.now();
  set({ phase: 'Loading the 3D model', done: 0, total: h.issuePages.length });
  let snap: Snapshotter | null = null;
  try {
    // the accuracy and survey reports draw no 3D view
    if (!only && !surveyOnly)
      snap = await createSnapshotter(projectId, manifest, {
        width: 760,
        height: 560,
        quality: 0.78,
      });
  } catch (e) {
    console.warn('Report: no 3D views', e);
  }
  const fetchBlob = async (path: string): Promise<Blob | null> => {
    try {
      const r = await fetch(assetUrl(projectId, { path }));
      return r.ok ? await r.blob() : null;
    } catch {
      return null;
    }
  };
  const survey =
    surveyFiles && h.sections.some((id) => (SURVEY_SECTIONS as readonly string[]).includes(id))
      ? await buildSurveyData(surveyFiles, read.bytes, {
          need: 'report',
          progress: progress('Computing the survey volumes'),
        })
      : null;
  const overview: string[] = [];
  if (snap && h.sections.includes('site')) {
    for (const [az, el] of [
      [225, 28],
      [45, 28],
    ] as const) {
      const u = blobUrl(await snap.overview(az, el));
      if (u) overview.push(u);
    }
  }
  const thumbnail = blobUrl(await fetchBlob('thumbnail.jpg'));
  const ctx: HouseContext = {
    h,
    text,
    images: { overview, ...(thumbnail ? { thumbnail } : {}) },
    product: brand.productName,
    ...(only ? { only: { kicker: t('house.proc.cover') } } : {}),
    ...(surveyOnly ? { only: { kicker: t('house.survey.cover') } } : {}),
    survey,
    runs,
  };
  lap('model', t1);

  // Fonts first: the pages are measured as they are filled.
  await Promise.all(
    ['400', '500', '600'].map((wt) => document.fonts.load(`${wt} 10pt "IBM Plex Sans"`)),
  );
  await document.fonts.load('600 10pt "IBM Plex Sans Condensed"');
  await document.fonts.load('600 10pt "IBM Plex Mono"');

  const root = document.getElementById('report');
  if (!root) throw new Error('Missing #report');
  const frame = (section: string) => {
    const page = document.createElement('section');
    page.className = `pg ${section}`;
    page.dataset.section = section;
    if (section === 'cover' || section === 'back') {
      root.appendChild(page);
      return { page, body: page };
    }
    page.innerHTML = frameHtml(ctx);
    root.appendChild(page);
    const body = page.querySelector('.pg-b');
    if (!(body instanceof HTMLElement)) throw new Error('Missing page body');
    return { page, body };
  };
  const pager = new Pager({
    root,
    frame,
    overflows: (body) => body.scrollHeight > body.clientHeight + 1,
  });

  const t2 = performance.now();
  set({ phase: 'Laying out pages' });
  pager.fixed('cover', coverHtml(ctx));
  const contentsPage = h.sections.includes('contents') ? pager.fixed('contents', '') : null;
  const entries: ContentsEntry[] = [];
  let num = 0;
  const numbered = (id: ReportSectionId) => {
    num++;
    const n = two(num);
    entries.push({ label: sectionTitle(id), page: pager.pages.length + 1, num: n });
    return n;
  };
  let registerCells = new Map<string, HTMLElement>();
  const issuePageOf = new Map<string, number>();
  const byId = new Map(issues.map((i) => [i.id, i]));
  const planById = new Map(h.plan.map((p) => [p.id, p]));
  const rank = new Map<string, number>();
  [...h.base.bySeverity].reverse().forEach((s, i) => rank.set(s.color, i));

  for (const id of h.sections) {
    switch (id) {
      case 'contents':
        break;
      case 'summary': {
        const n = numbered(id);
        pager.start(id);
        layoutSummary(pager, ctx, n);
        break;
      }
      case 'scope': {
        const n = numbered(id);
        pager.start(id);
        layoutScope(pager, ctx, n);
        break;
      }
      case 'site': {
        const n = numbered(id);
        pager.start(id);
        layoutSite(pager, ctx, n);
        break;
      }
      case 'statistics': {
        const n = numbered(id);
        pager.start(id);
        layoutStatistics(pager, ctx, n);
        break;
      }
      case 'register': {
        const n = numbered(id);
        pager.start(id);
        registerCells = layoutRegister(pager, ctx, n);
        lap('front', t2);
        break;
      }
      case 'issues': {
        numbered(id);
        const t3 = performance.now();
        let done = 0;
        let photoMs = 0;
        let viewMs = 0;
        for (const row of h.issuePages) {
          const images: IssueImages = {};
          const a = performance.now();
          try {
            const p = await issuePhotos(fetchBlob, byId.get(row.id), row);
            const photo = blobUrl(p.photo);
            const closeup = blobUrl(p.closeup);
            if (photo) images.photo = photo;
            if (closeup) images.closeup = closeup;
          } catch (e) {
            console.warn(`Report: photo of ${row.code}`, e);
          }
          const b = performance.now();
          photoMs += b - a;
          const spot = row.position ? undefined : planById.get(row.id);
          if (spot) images.locator = locatorMap(h.plan, spot, rank, row.code);
          if (snap && row.position) {
            try {
              const view = blobUrl(await snap.shoot(row.position, row.normal, row.severityColor));
              if (view) images.view = view;
            } catch (e) {
              console.warn(`Report: 3D view of ${row.code}`, e);
            }
          }
          viewMs += performance.now() - b;
          const pf = row.photo ? photoFacts(manifest, row.photo.layer, row.photo.photo) : null;
          const issue = byId.get(row.id);
          pager.fixed(
            'issue',
            issuePageHtml(row, images, {
              photoName: pf?.name ?? '',
              captured: pf?.at ?? '',
              action: issue ? issueAction(manifest, issue) : '',
              actionIsCriteria: issue ? !hasAction(manifest, issue) : false,
              disclaimer: disclaimerOf(h),
            }),
          );
          issuePageOf.set(row.id, pager.pages.length);
          done++;
          if (done % 5 === 0 || done === h.issuePages.length) {
            set({ phase: 'Drawing issue pages', done, total: h.issuePages.length });
            await tick();
          }
        }
        timings.issuePhotos = Math.round(photoMs / 100) / 10;
        timings.issueViews = Math.round(viewMs / 100) / 10;
        lap('issues', t3);
        break;
      }
      case 'processing': {
        const n = numbered(id);
        pager.start(id);
        layoutProcessing(pager, ctx, n);
        break;
      }
      case 'audit': {
        const n = numbered(id);
        pager.start(id);
        layoutAudit(pager, ctx, n);
        break;
      }
      case 'approvals': {
        if (!signoff) break; // not shared: printed as in 0.8
        const n = numbered(id);
        pager.start(id);
        layoutApprovals(pager, `${n} · ${kickerOf(h)}`, signoff);
        break;
      }
      case 'appendices': {
        num++;
        const first = pager.pages.length + 1;
        entries.push({ label: sectionTitle(id), page: first, num: two(num) });
        layoutAppendices(pager, ctx, (title, letter) => {
          entries.push({ label: title, page: pager.start('appendix'), num: letter, sub: true });
        });
        break;
      }
      default: {
        // sections with a module of their own (sections.ts SECTION_LAYOUTS: the survey sections)
        const layout = SECTION_LAYOUTS[id];
        if (!layout) break;
        const n = numbered(id);
        pager.start(id);
        layout(pager, ctx, n);
      }
    }
  }
  snap?.dispose();
  pager.fixed('back', backHtml(ctx));

  // Page numbers, the contents and the register's page column.
  const pages = pager.pages;
  pages.forEach((page, i) => {
    const n = page.querySelector('.pg-n');
    if (n) n.textContent = String(i + 1);
  });
  for (const [id, cell] of registerCells) {
    const page = issuePageOf.get(id);
    if (page !== undefined) cell.textContent = String(page);
  }
  if (contentsPage) {
    const body = contentsPage.querySelector('.pg-b');
    if (body) body.innerHTML = contentsHtml(entries, kickerOf(h));
  }

  set({ phase: 'Preparing images' });
  await document.fonts.ready;
  await Promise.all(
    [...root.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)),
  );
  lap('total', t0);
  set({
    state: 'ready',
    phase: 'Ready to print',
    done: h.issuePages.length,
    total: h.issuePages.length,
    count: h.base.total,
    pages: pages.length,
    timings,
  });
}

run().catch((e: unknown) => {
  console.error(e);
  set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
});
