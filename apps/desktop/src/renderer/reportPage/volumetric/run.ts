// The volumetric customer report on the hidden house page (spec 2026-10-25): `only=volumetric-*`.
// The figures are the app's own: the survey data the house report builds (`buildSurveyData`, every
// date worked out as the Volumes view does), each date on its own outline and weighed at its
// material's density on that date (`densityOn`; the stockpile kit's site-wide density through
// `pileMaterial`), so the PDF, the HTML file and the editor's preview print the same numbers. The
// person's edits (`report/volumetric.json`) and pictures (`report/views/volumetric/frame.json`)
// are read here, never passed in: the exports pass no compared date, the editor passes its own.
// Every volume measurement is in the input, one never computed too (its outline and footprint on
// each date, no figure). The input also names the piles whose outlines substantially overlap on the
// latest date, and carries each pile's elevation profile (`pileProfiles.ts`), which the survey
// data samples against the date the model compares with.
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
  type VolumetricPileProfile,
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
import {
  densityOn,
  overlapShare,
  pileSeries,
  SAME_PILE_SHARE,
  surfaceOfCapture,
} from '@aio/survey';
import { t } from '@aio/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  generatedTexts,
  pileNotesOf,
  previewModel,
  resolveTexts,
} from '../../report/volumetric/editorModel';
import { captureDateOf } from '../../survey/volumes/surveyDates';
import { kitBaseName } from '../../survey/card/baseNames';
import {
  standardBaseName,
  type ReportSurveyData,
  type SurveyFiles,
  type SurveyReader,
} from '../house/surveyData';
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
 * A pile's base by the base picker's name, from its measurement's base spec (the first item's
 * `from`, as the Volumes view reads it); a figure carried over from the kit is named by the kit
 * base it was computed on.
 */
function baseOf(
  m: SurveyFiles['measurements'][number],
  series: ReturnType<typeof pileSeries>['series'],
): string {
  const carried = series.find((r) => r.carried)?.carried;
  if (carried) return kitBaseName(carried.base, t);
  const it = m.items[0];
  return it ? standardBaseName(it.from) : '';
}

/** Each pile's sampled profile by measurement id; a pile left out, or null, has none. */
export type PileProfiles = Readonly<Record<string, VolumetricPileProfile | null>>;

/**
 * The pairs of piles whose outlines substantially overlap on `capture`: the engine's test for
 * "the same pile drawn again" (`overlapShare` at `SAME_PILE_SHARE`, half or more of the smaller
 * outline; plan D3, no threshold of the report's own). Each pair once, in the piles' order.
 */
function overlapsOn(
  piles: readonly {
    id: string;
    dates: readonly { capture: string; outline: [number, number][] }[];
  }[],
  capture: string,
): { a: string; b: string }[] {
  const rings = piles.flatMap((p) => {
    const ring = p.dates.find((d) => d.capture === capture)?.outline ?? [];
    return ring.length >= 3 ? [{ id: p.id, ring }] : [];
  });
  const out: { a: string; b: string }[] = [];
  rings.forEach((x, i) => {
    for (const y of rings.slice(i + 1))
      if (overlapShare(x.ring, y.ring) >= SAME_PILE_SHARE) out.push({ a: x.id, b: y.id });
  });
  return out;
}

/**
 * The model's input from the survey data: every volume measurement with its figures on each
 * date (a stale date has none), on that date's own outline, at its material's density on that date.
 * The footprint and survey error are the stored result's for that date, else the outline's area.
 * A pile that was never computed is kept (plan D1): one entry per survey date with its outline and
 * footprint and no figure. `overlaps` is read on the newest date with a figure (the model's latest
 * date); `profiles` are the sampled profiles (`ReportSurveyData.pileProfiles`).
 */
export function volumetricInputOf(
  files: SurveyFiles,
  survey: ReportSurveyData,
  opts: { compareWith: string | null; frame: ReportViewsFrameT | null; profiles?: PileProfiles },
): VolumetricInput {
  const manifest = files.manifest;
  const captures = survey.captures;
  const dateOf = captureDateOf(captures);
  const byId = new Map(files.measurements.map((m) => [m.id, m]));
  const oldestFirst = [...captures].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const piles = survey.volumes.piles.map((p) => {
    const m = byId.get(p.id);
    // the figure's own result per date: the Volumes view's choice (`pileSeries`, the first item)
    const series = m ? pileSeries(m).series : [];
    // a pile the survey data has no rows for still stands on every survey date, without a figure
    const rows: readonly { capture: string; valueM3: number | null; stale: boolean }[] =
      p.rows.length > 0
        ? p.rows
        : oldestFirst.map((c) => ({ capture: c.id, valueM3: null, stale: false }));
    return {
      id: p.id,
      label: p.label,
      material: p.material ? { id: p.material.id, name: p.material.name } : null,
      base: m ? baseOf(m, series) : p.base,
      profile: opts.profiles?.[p.id] ?? null,
      dates: rows.map((r) => {
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
  // the model's latest date: the newest with a figure
  const figured = oldestFirst.findLast((c) =>
    piles.some((p) => p.dates.some((d) => d.capture === c.id && d.volumeM3 !== null)),
  );
  return {
    captures,
    piles,
    overlaps: figured ? overlapsOn(piles, figured.id) : [],
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
  let model = volumetricModel(volumetricInputOf(files, survey, { compareWith, frame }));
  // the profiles follow the model's own dates (the editor's "Compare with" changes them as it
  // changes the figures), so they are sampled once the model has named its pair
  if (survey.pileProfiles && model.latest) {
    r.set({ phase: 'Sampling the pile profiles' });
    try {
      const profiles = await survey.pileProfiles(model.latest.id, model.compared?.id ?? null);
      model = volumetricModel(volumetricInputOf(files, survey, { compareWith, frame, profiles }));
    } catch (e) {
      // a report without profiles prints their placeholders; it never fails for them
      console.warn('Report: the pile profiles could not be sampled and are left out', e);
    }
  }
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
