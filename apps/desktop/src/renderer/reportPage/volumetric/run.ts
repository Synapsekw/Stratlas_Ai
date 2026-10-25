// The volumetric customer report on the hidden house page (spec 2026-10-25): `only=volumetric-*`.
// The figures are the app's own: the survey data the house report builds (`buildSurveyData`, every
// date worked out as the Volumes view does), each date on its own outline and weighed at its
// material's density on that date (`densityOn`; the stockpile kit's site-wide density through
// `pileMaterial`), so the PDF, the HTML file and the editor's preview print the same numbers. The
// person's edits (`report/volumetric.json`) and pictures (`report/views/volumetric/frame.json`)
// are read here, never passed in: the exports pass no compared date, the editor passes its own.
//
// - `volumetric-model`: the model, JSON safe, for the editor (`window.__report.model`); nothing is
//   laid out, and a project without pictures still gets its model (the preview shows placeholders).
// - `volumetric-pdf`: the pages the text file turns on, one `.vr-page` per printed page, for main's
//   printToPDF (`window.__report.pages`).
// - `volumetric-html`: the offline file (`window.__report.html`), built from `prepareVolumetric`'s
//   result (`html.ts`: pages A to C for print, view D, everything inside the file).
import {
  volumetricModel,
  type VolumetricInput,
  type VolumetricModel,
  type VolumetricT,
} from '@aio/project/export';
import {
  ReportTextFile,
  ReportViewsFrame,
  reportTextPath,
  reportViewsDir,
  type ReportTextFile as ReportTextFileT,
  type ReportViewsFrame as ReportViewsFrameT,
} from '@aio/schema';
import { densityOn, pileSeries, surfaceOfCapture } from '@aio/survey';
import { t } from '@aio/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  generatedTexts,
  pileNotesOf,
  previewModel,
  resolveTexts,
} from '../../report/volumetric/editorModel';
import { captureDateOf } from '../../survey/volumes/surveyDates';
import type { ReportSurveyData, SurveyFiles, SurveyReader } from '../house/surveyData';
import { reportViews, volumetricTemplate, type ResolvedText, type ReportViews } from '../types';
import { browserEncoder, volumetricHtmlFile, type PictureEncoder } from './html';

export const VOLUMETRIC_KINDS = ['volumetric-pdf', 'volumetric-html', 'volumetric-model'] as const;
export type VolumetricKind = (typeof VOLUMETRIC_KINDS)[number];

export const isVolumetricKind = (only: string | null): only is VolumetricKind =>
  (VOLUMETRIC_KINDS as readonly (string | null)[]).includes(only);

/** What the run publishes on `window.__report` (main's `ReportPageState`). */
export interface VolumetricPublish {
  state?: 'loading' | 'ready' | 'error';
  phase?: string;
  done?: number;
  total?: number;
  count?: number;
  pages?: number;
  model?: VolumetricModel;
  html?: string;
}

export interface VolumetricRun {
  kind: VolumetricKind;
  /** The project's files (`aio://`): the text file and the pictures' frame are read through it. */
  read: SurveyReader;
  /** The survey files, or null when the project has none. */
  files: SurveyFiles | null;
  /** The survey data for these files (`buildSurveyData` with `need: 'report'`, `fillDates`). */
  build: (files: SurveyFiles) => Promise<ReportSurveyData>;
  /** `volumetric-model` only: the date the editor compares with (query `compare`). */
  compare: string | null;
  /** Settings, Report branding, company name: the generated "Prepared by". */
  companyName: string | null;
  /** The URL of a project file (`assetUrl`). */
  pictureUrl: (path: string) => string;
  /** Where the PDF's pages go (`#report`). */
  root: HTMLElement | null;
  set: (patch: VolumetricPublish) => void;
  /** Fonts loaded and pictures decoded before the page says it is ready to print. */
  settle?: (root: HTMLElement) => Promise<void>;
  /** `volumetric-html`: makes each picture a JPEG `data:` URI (default: the canvas). */
  encode?: PictureEncoder;
}

const words = t as VolumetricT;

// ---------------------------------------------------------------- input

/** A ring's area (shoelace), m². */
function ringArea(ring: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    if (p && q) a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * The model's input from the survey data: every volume measurement with its figures on each
 * date (a stale date has none), on that date's own outline, at its material's density on that date.
 * The footprint and survey error are the stored result's for that date, else the outline's area.
 */
export function volumetricInputOf(
  files: SurveyFiles,
  survey: ReportSurveyData,
  opts: { compareWith: string | null; frame: ReportViewsFrameT | null },
): VolumetricInput {
  const manifest = files.manifest;
  const captures = survey.captures;
  const dateOf = captureDateOf(captures);
  const byId = new Map(files.measurements.map((m) => [m.id, m]));
  const piles = survey.volumes.piles.map((p) => {
    const m = byId.get(p.id);
    // the figure's own result per date: the Volumes view's choice (`pileSeries`, the first item)
    const series = m ? pileSeries(m).series : [];
    return {
      id: p.id,
      label: p.label,
      material: p.material ? { id: p.material.id, name: p.material.name } : null,
      base: p.base,
      dates: p.rows.map((r) => {
        const outline = p.outlines[r.capture] ?? p.outline;
        const found = series.find((x) => x.toCapture === r.capture);
        const stored =
          found && !r.stale && (found.status === 'ok' || found.status === 'partial')
            ? found
            : undefined;
        const volumeM3 = r.stale ? null : r.valueM3;
        return {
          capture: r.capture,
          volumeM3,
          densityTPerM3: p.material ? densityOn(p.material, r.capture, dateOf) : null,
          areaM2: stored ? stored.areaM2 : outline.length >= 3 ? ringArea(outline) : null,
          // the engine's peak height above the base on that date (none when stale)
          peakM: volumeM3 !== null ? (p.peaks?.[r.capture] ?? null) : null,
          plusMinusM3: volumeM3 !== null ? (stored?.uncertainty?.plusMinusM3 ?? null) : null,
          outline,
        };
      }),
    };
  });
  const latest = [...captures].reverse().find((c) => surfaceOfCapture(files.surfaces, c.id));
  const surface = latest ? surfaceOfCapture(files.surfaces, latest.id) : null;
  return {
    captures,
    piles,
    compareWith: opts.compareWith,
    project: {
      name: manifest.name,
      customer: manifest.customer?.trim() ? manifest.customer.trim() : null,
      site: manifest.site?.trim() ? manifest.site.trim() : null,
      crs: survey.basis.crs,
    },
    method: {
      cellM: surface?.cellM ?? null,
      gsdCm: null,
      siteDensityTPerM3: files.kit?.densityTPerM3 ?? null,
    },
    frame: opts.frame,
  };
}

// ---------------------------------------------------------------- run

/** A project file parsed, or null when it is missing or invalid (warned). */
async function readParsed<T>(
  read: SurveyReader,
  path: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): Promise<T | null> {
  const raw = await read.json(path);
  if (raw === null || raw === undefined) return null;
  const r = schema.safeParse(raw);
  if (!r.success) console.warn(`Report: ${path} is invalid and left out`);
  return r.success ? r.data : null;
}

/** Everything a printed or offline report is made of: the model with the edits on it. */
export interface VolumetricPrepared {
  /** The model as printed: the resolved texts, pile notes and pages on it. */
  model: VolumetricModel;
  text: ResolvedText;
  views: ReportViews;
  frame: ReportViewsFrameT;
  file: ReportTextFileT | null;
  files: SurveyFiles;
  survey: ReportSurveyData;
}

/**
 * The offline HTML file (`only=volumetric-html`, `html.ts`): pages A to C for print, the
 * interactive view D, the pictures as `data:` URIs made by `encode` (the canvas by default).
 */
export const volumetricHtml = (
  prepared: VolumetricPrepared,
  encode: PictureEncoder = browserEncoder(),
): Promise<string> => volumetricHtmlFile(prepared, encode);

async function settleDefault(root: HTMLElement): Promise<void> {
  await Promise.all(
    ['400', '500', '600'].map((wt) => document.fonts.load(`${wt} 10pt "IBM Plex Sans"`)),
  );
  await document.fonts.ready;
  await Promise.all(
    [...root.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)),
  );
}

export async function runVolumetric(r: VolumetricRun): Promise<void> {
  const files = r.files;
  if (!files || !volumetricTemplate.offered({ manifest: files.manifest, survey: files }))
    throw new Error(t('vreport.error.notOffered'));
  const [file, frame] = await Promise.all([
    readParsed(r.read, reportTextPath('volumetric'), ReportTextFile),
    readParsed(r.read, `${reportViewsDir('volumetric')}/frame.json`, ReportViewsFrame),
  ]);
  const exporting = r.kind !== 'volumetric-model';
  if (exporting && !frame) throw new Error(t('vreport.error.noPictures'));
  r.set({ phase: 'Computing the survey volumes' });
  const survey = await r.build(files);
  // the editor names its compared date; the exports print the one the text file saved
  const compareWith = exporting ? (file?.compareWith ?? null) : r.compare;
  const model = volumetricModel(volumetricInputOf(files, survey, { compareWith, frame }));
  if (r.kind === 'volumetric-model') {
    r.set({ state: 'ready', phase: 'Ready', done: 1, total: 1, count: model.piles.length, model });
    return;
  }
  if (!frame) throw new Error(t('vreport.error.noPictures'));

  // the texts as the editor shows them: a `user` part as written, the rest from the figures
  const generated = generatedTexts(model, {
    title: t('vreport.field.title.default'),
    customer: files.manifest.customer,
    companyName: r.companyName,
    t: words,
  });
  const printed = previewModel(model, resolveTexts(file, generated), file);
  const text: ResolvedText = { parts: printed.text, pileNotes: pileNotesOf(file) };
  const dir = reportViewsDir('volumetric');
  const views = reportViews(frame, (name) => r.pictureUrl(`${dir}/${name}`));
  const prepared: VolumetricPrepared = { model: printed, text, views, frame, file, files, survey };
  if (printed.text.title) document.title = printed.text.title;

  if (r.kind === 'volumetric-html') {
    r.set({ phase: 'Writing the offline file' });
    const html = await volumetricHtml(prepared, r.encode);
    r.set({ state: 'ready', phase: 'Ready', count: model.piles.length, html });
    return;
  }

  const root = r.root;
  if (!root) throw new Error('Missing #report');
  r.set({ phase: 'Laying out pages' });
  const pages = volumetricTemplate.render(printed, text, views);
  root.innerHTML = pages.map((p) => renderToStaticMarkup(p.element)).join('');
  r.set({ phase: 'Preparing images' });
  await (r.settle ?? settleDefault)(root);
  r.set({
    state: 'ready',
    phase: 'Ready to print',
    done: pages.length,
    total: pages.length,
    count: model.piles.length,
    pages: pages.length,
  });
}
