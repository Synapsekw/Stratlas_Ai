// The volumetric report as one offline HTML file (spec section 4): the interactive view D on
// screen and pages A, B and C (the PDF's own markup) for "Save as PDF". Everything is inside the
// file: the fonts, the pictures and the marks as `data:` URIs, the CSS inline, the viewer as one
// inline script that the file's own CSP names by its SHA-256, and the viewer's data as JSON. The
// file asks for nothing: `default-src 'none'` refuses any request it might still try.
//
// Pictures are JPEG, photo and 3D at quality 0.80, the heat map and elevation at 0.88, at most
// 2000 px on the longest side; when the file would pass the 15 MB budget they are made again at
// 1600 and then 1200 px, and the export refuses past that. The pile cards' before and after crops
// are cut as their own 600 px JPEGs (one picture repeated per card would cost its bytes each time).
import { lockupSvg } from '@aio/brand';
import {
  formatReportDate,
  volumetricCsv,
  type PixelBox,
  type VolumetricModel,
} from '@aio/project/export';
import type { ReportView, ReportViewKind, ReportViewsFrame } from '@aio/schema';
import { t } from '@aio/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import cutFillCss from '../../survey/volumes/cutFill.css?text';
import { volumetricTemplate, type ReportViews } from '../types';
import { frameCutFill } from './change';
import changeCss from './change.css?text';
import { embeddedFontCss } from './fonts';
import pilesCss from './piles.css?text';
import type { VolumetricPrepared } from './run';
import viewerCss from './viewer/viewer.css?text';
import viewerScript from './viewer/viewer.ts?script';
import {
  VIEWER_STRING_KEYS,
  type ViewerData,
  type ViewerPicture,
  type ViewerPile,
  type ViewerStringKey,
} from './viewer/types';
import volumetricCss from './volumetric.css?text';

/** The file's size budget, bytes, and how the refusal names it. */
export const HTML_BUDGET_BYTES = 15_000_000;
const BUDGET_LABEL = '15 MB';
/** The pictures' longest side, tried in turn until the file fits. */
export const PICTURE_STEPS_PX = [2000, 1600, 1200] as const;
/** The pile cards' crops, px a side. */
export const CROP_PX = 600;
/** JPEG quality by picture kind. */
export const PICTURE_QUALITY: Record<ReportViewKind, number> = {
  photo: 0.8,
  '3d': 0.8,
  cutfill: 0.88,
  elevation: 0.88,
};

/** A part of the source picture, as fractions of its width and height (may run past its edges). */
export interface PictureCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PictureRequest {
  /** The longest side of the result, px (the source is never made larger). */
  maxPx: number;
  quality: number;
  /** Cut this part of the source first. */
  crop?: PictureCrop;
}

/** A picture (by URL) made into a JPEG `data:` URI. */
export type PictureEncoder = (src: string, req: PictureRequest) => Promise<string>;

/**
 * The report window's encoder: the picture loaded once (aio:// answers with CORS headers, so an
 * anonymous load keeps the canvas readable), drawn on a canvas on the paper colour, as JPEG.
 */
export function browserEncoder(): PictureEncoder {
  const loaded = new Map<string, Promise<HTMLImageElement>>();
  const load = (src: string) => {
    let p = loaded.get(src);
    if (!p) {
      p = new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          resolve(img);
        };
        img.onerror = () => {
          reject(new Error(`A report picture could not be loaded: ${src}`));
        };
        img.src = src;
      });
      loaded.set(src, p);
    }
    return p;
  };
  return async (src, req) => {
    const img = await load(src);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const c = req.crop ?? { left: 0, top: 0, width: 1, height: 1 };
    const sw = c.width * iw;
    const sh = c.height * ih;
    const k = Math.min(1, req.maxPx / Math.max(sw, sh, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * k));
    canvas.height = Math.max(1, Math.round(sh * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas for the report pictures.');
    ctx.fillStyle = '#fdfefe';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, c.left * iw, c.top * ih, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', req.quality);
  };
}

/** The legend swatches: the printed page's red, blue and grey. */
const LEGEND_COLOURS = { red: '#c9413a', blue: '#2f6fd0', grey: '#c3c8ce' } as const;

const SHELL_CSS = `html,body{margin:0;padding:0}
body{background:#f3f4f2}
.vr-print{display:none}
@media print{html,body{background:#fff}#vr-app{display:none!important}.vr-print{display:block}}`;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JSON that is safe inside a `<script>` element: no `<` can close it. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project';

/** A pile's crop box (frame pixels) as fractions of the picture. */
const cropOf = (box: PixelBox, frame: ReportViewsFrame): PictureCrop => ({
  left: box.x / frame.widthPx,
  top: box.y / frame.heightPx,
  width: box.size / frame.widthPx,
  height: box.size / frame.heightPx,
});

/** One picture the file needs: its source, kind and crop (none for a whole picture). */
interface Wanted {
  src: string;
  kind: ReportViewKind;
  crop: PictureCrop | null;
}

const TOKEN = (i: number) => `data:image/jpeg;base64,VRPIC${String(i)}END`;
const TOKEN_RE = /data:image\/jpeg;base64,VRPIC(\d+)END/g;

/** The view of a kind on a date (a `cutfill` one of `pair` when named). */
function findView(
  frame: ReportViewsFrame,
  kind: ReportViewKind,
  capture: string,
  pair?: string,
): ReportView | undefined {
  return frame.views.find(
    (v) => v.kind === kind && v.capture === capture && (pair === undefined || v.pair === pair),
  );
}

/**
 * The printed pages A to C with every picture as a token, and the pictures they asked for. The
 * tokens are swapped for the encoded pictures once their size is known.
 */
function printPages(prepared: VolumetricPrepared, want: (w: Wanted) => string): { markup: string } {
  const { model, frame, views } = prepared;
  const pageViews: ReportViews = {
    frame,
    picture: (kind, capture, pair) => {
      const src = findView(frame, kind, capture, pair) ? views.picture(kind, capture, pair) : null;
      return src ? want({ src, kind, crop: null }) : null;
    },
    crop: (pileId, capture) => {
      const pile = model.piles.find((p) => p.id === pileId);
      const src = views.picture('photo', capture);
      if (!pile?.crop || pile.crop.size <= 0 || !src) return null;
      return want({ src, kind: 'photo', crop: cropOf(pile.crop, frame) });
    },
  };
  const pages = volumetricTemplate.render(model, prepared.text, pageViews);
  return { markup: pages.map((p) => renderToStaticMarkup(p.element)).join('') };
}

/** The interactive view's data, its pictures as tokens. */
function viewerDataOf(prepared: VolumetricPrepared, want: (w: Wanted) => string): ViewerData {
  const { model, frame, views, survey } = prepared;
  const raw = t as (key: ViewerStringKey) => string;
  const strings = Object.fromEntries(VIEWER_STRING_KEYS.map((k) => [k, raw(k)])) as Record<
    ViewerStringKey,
    string
  >;
  const shown = model.shownDates;
  const shownIds = new Set(shown.map((c) => c.id));
  const latest = model.latest;
  const compared = model.compared;

  const pictures: ViewerPicture[] = [];
  const add = (kind: ReportViewKind, capture: string, pair?: string) => {
    if (!findView(frame, kind, capture, pair)) return;
    const src = views.picture(kind, capture, pair);
    if (src) pictures.push({ kind, capture, src: want({ src, kind, crop: null }) });
  };
  for (const c of shown) for (const kind of ['photo', 'elevation', '3d'] as const) add(kind, c.id);
  if (latest && compared) add('cutfill', latest.id, compared.id);

  const deadband = frameCutFill(frame).thresholdM.toFixed(2);
  const piles: ViewerPile[] = model.piles.map((p) => ({
    id: p.id,
    number: p.number,
    label: p.label,
    marker: p.marker,
    crop: p.crop,
    areaM2: p.areaM2,
    peakM: p.peakM,
    note: p.note,
    byDate: p.byDate
      .filter((d) => shownIds.has(d.capture))
      .map((d) => ({ capture: d.capture, m3: d.volumeM3, t: d.tonnes })),
  }));
  const place = model.project.site ?? model.project.name;
  const title = reportTitle(model);
  const subtitle = [
    t('vreport.band.piles', { count: model.kpis.piles }),
    latest ? t('vreport.band.surveyed', { date: formatReportDate(latest.date) }) : null,
    compared ? t('vreport.band.compared', { date: formatReportDate(compared.date) }) : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(' · ');
  return {
    strings,
    lockupSvg: lockupSvg({ on: 'dark' }),
    title: [place, title].filter(Boolean).join(' · '),
    subtitle,
    dates: shown.map((c) => ({ id: c.id, label: formatReportDate(c.date) })),
    from: compared?.id ?? null,
    to: latest?.id ?? shown.at(-1)?.id ?? '',
    frame: { widthPx: frame.widthPx, heightPx: frame.heightPx },
    pictures,
    legend: compared
      ? [
          { colour: LEGEND_COLOURS.red, label: t('vreport.key.red') },
          { colour: LEGEND_COLOURS.blue, label: t('vreport.key.blue') },
          { colour: LEGEND_COLOURS.grey, label: t('vreport.key.grey', { deadband }) },
        ]
      : [],
    csv: volumetricCsv(survey, compared?.id ?? null),
    csvName: `${slug(model.project.name)}-stockpile-inventory.csv`,
    piles,
  };
}

function documentOf(o: {
  title: string;
  csp: string;
  css: string;
  pages: string;
  data: string;
  script: string;
}): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(o.csp)}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(o.title)}</title>`,
    `<style>${o.css}</style>`,
    '</head>',
    '<body>',
    '<div id="vr-app"></div>',
    `<div class="vr-print">${o.pages}</div>`,
    `<script type="application/json" id="vr-data">${o.data}</script>`,
    `<script>${o.script}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The offline file for a prepared report. `encode` makes each picture a JPEG `data:` URI (the
 * report window draws it on a canvas); the same picture at the same size is encoded once.
 */
export async function volumetricHtmlFile(
  prepared: VolumetricPrepared,
  encode: PictureEncoder,
): Promise<string> {
  const wanted: Wanted[] = [];
  const keyOf = (w: Wanted) => JSON.stringify([w.src, w.kind, w.crop]);
  const index = new Map<string, number>();
  const want = (w: Wanted) => {
    const key = keyOf(w);
    let i = index.get(key);
    if (i === undefined) {
      i = wanted.length;
      wanted.push(w);
      index.set(key, i);
    }
    return TOKEN(i);
  };
  const { markup: pagesMarkup } = printPages(prepared, want);
  const viewer = viewerDataOf(prepared, want);
  const data = scriptJson(viewer);
  // a picture the view also shows is held once, in the data block: the page's <img> names it
  // (`data-vr-pic="kind:capture"`) and the viewer script gives it that source at boot
  const shared = new Map<string, string>();
  for (const p of viewer.pictures) {
    const i = /VRPIC(\d+)END$/.exec(p.src)?.[1];
    if (i !== undefined) shared.set(i, `${p.kind}:${p.capture}`);
  }
  const markup = pagesMarkup.replace(
    /src="data:image\/jpeg;base64,VRPIC(\d+)END"/g,
    (whole, i: string) => {
      const key = shared.get(i);
      return key ? `data-vr-pic="${escapeHtml(key)}"` : whole;
    },
  );

  const script = viewerScript.replace(/<\/(script)/gi, '<\\/$1');
  const hash = await sha256Base64(script);
  const csp = [
    "default-src 'none'",
    'img-src data: blob:',
    'font-src data:',
    "style-src 'unsafe-inline'",
    `script-src 'sha256-${hash}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const css = [
    embeddedFontCss(),
    volumetricCss,
    pilesCss,
    changeCss,
    cutFillCss,
    viewerCss,
    SHELL_CSS,
  ].join('\n');
  const title = documentTitle(prepared.model);

  const encoded = new Map<string, Promise<string>>();
  const picture = (w: Wanted, maxPx: number) => {
    const req: PictureRequest = w.crop
      ? { maxPx: CROP_PX, quality: PICTURE_QUALITY.photo, crop: w.crop }
      : { maxPx, quality: PICTURE_QUALITY[w.kind] };
    const key = JSON.stringify([w.src, req]);
    let p = encoded.get(key);
    if (!p) {
      p = encode(w.src, req);
      encoded.set(key, p);
    }
    return p;
  };

  for (const maxPx of PICTURE_STEPS_PX) {
    const uris = await Promise.all(wanted.map((w) => picture(w, maxPx)));
    const fill = (s: string) => s.replace(TOKEN_RE, (_m, i: string) => uris[Number(i)] ?? '');
    const html = documentOf({
      title,
      csp,
      css,
      pages: fill(markup),
      data: fill(data),
      script,
    });
    if (new TextEncoder().encode(html).length <= HTML_BUDGET_BYTES) return html;
  }
  throw new Error(t('vreport.error.budget', { limit: BUDGET_LABEL }));
}

/** The report title as printed: the person's, else the default. */
function reportTitle(model: VolumetricModel): string {
  const own = model.text.title?.trim() ?? '';
  return own.length > 0 ? own : t('vreport.field.title.default');
}

/** The file's `<title>`: the report title, and the site when there is one. */
function documentTitle(model: VolumetricModel): string {
  const title = reportTitle(model);
  const place = model.project.site ?? model.project.name;
  return place ? `${title} · ${place}` : title;
}
