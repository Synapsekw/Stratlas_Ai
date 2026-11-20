// @vitest-environment jsdom
// The offline volumetric HTML file (spec section 4): one document with its own strict CSP naming
// the one script's hash, nothing it would have to fetch (fonts, pictures and the lockup as `data:`
// URIs), pages A to C for print and the interactive view D on screen, booting from the embedded
// data; the pictures step down to fit the 15 MB budget (each pile's own pictures first) and the
// export refuses past it.
import { stockpileInventory, volumetricCsv } from '@aio/project/export';
import type {
  ProjectManifest,
  ReportTextFile,
  ReportViewsFrame,
  SiteMaterial,
  SurveyMeasurement,
} from '@aio/schema';
import { t } from '@aio/ui';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ReportSurveyData, SurveyFiles, SurveyReader } from '../house/surveyData';
import { HTML_BUDGET_BYTES, type PictureEncoder, type PictureRequest } from './html';
import { runVolumetric, type VolumetricRun } from './run';
import type { ViewerData } from './viewer/types';
import { bootViewer } from './viewer/viewer';

const square = (e: number, side = 10): [number, number][] => [
  [e, 0],
  [e + side, 0],
  [e + side, side],
  [e, side],
];

const CAPTURES = [
  { id: 'c1', label: 'Survey 1', date: '2026-09-03' },
  { id: 'c2', label: 'Survey 2', date: '2026-10-01' },
];

const sand: SiteMaterial = { id: 'sand', name: 'Sand', densityTPerM3: 1.6 };
const PILES = 3;

const measurement = (i: number): SurveyMeasurement => ({
  id: `m${String(i)}`,
  family: 'polygon',
  tool: 'volume',
  label: `P${String(i + 1)}`,
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [{ id: 'i1', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
  results: [],
  scope: { kind: 'site' },
  createdAt: '2026-10-16T00:00:00Z',
});

function files(n = PILES): SurveyFiles {
  return {
    manifest: {
      name: 'Demo yard',
      customer: 'A customer',
      site: 'The demo yard',
      captures: CAPTURES,
      crs: { epsg: 32632 },
    } as unknown as ProjectManifest,
    measurements: Array.from({ length: n }, (_, i) => measurement(i)),
    surfaces: [{ id: 's2', capture: 'c2', cellM: 0.25, source: { kind: 'dsm' } }],
    settings: { materials: [sand] },
    kit: null,
  } as unknown as SurveyFiles;
}

/** `n` piles; with `uncomputed` the last of them has no figure on any date. */
function survey(n = PILES, uncomputed = false): ReportSurveyData {
  const counted = uncomputed ? n - 1 : n;
  const captureRefs = CAPTURES.map((c) => ({ id: c.id, label: c.label, date: c.date }));
  const stockpiles = stockpileInventory(
    Array.from({ length: counted }, (_, i) => ({
      ref: `M${String(i + 1)}`,
      id: `m${String(i)}`,
      label: `P${String(i + 1)}`,
      material: sand,
      base: 'Lowest point on the outline',
      volumes: captureRefs.map((c, k) => ({
        capture: c,
        volumeM3: 100 * (i + 1) + k * 10,
        status: 'ok' as const,
        reason: '',
      })),
    })),
    captureRefs,
  );
  return {
    basis: { crs: 'EPSG:32632', units: { volume: 'm3', mass: 't', length: 'm', area: 'm2' } },
    captures: CAPTURES,
    stockpiles,
    volumes: {
      inventory: [],
      piles: Array.from({ length: n }, (_, i) => ({
        id: `m${String(i)}`,
        ref: `M${String(i + 1)}`,
        label: `P${String(i + 1)}`,
        folder: null,
        material: sand,
        base: 'Lowest point on the outline',
        carried: null,
        rows: (i < counted ? CAPTURES : []).map((c, k) => ({
          capture: c.id,
          date: c.date,
          label: c.label,
          valueM3: 100 * (i + 1) + k * 10,
          changeM3: null,
          tonnes: null,
          status: 'ok',
          stale: false,
          latest: k === 1,
        })),
        outline: square(20 * i, 12),
        outlines: { c1: square(20 * i, 10), c2: square(20 * i, 12) },
      })),
    },
  } as unknown as ReportSurveyData;
}

const FRAME: ReportViewsFrame = {
  schema: 'aio.report-views/1',
  extent: [0, 0, 100, 100],
  widthPx: 1000,
  heightPx: 1000,
  mPerPx: 0.1,
  views: [
    { name: 'photo-c1', kind: 'photo', capture: 'c1', file: 'photo-c1.jpg' },
    { name: 'photo-c2', kind: 'photo', capture: 'c2', file: 'photo-c2.jpg' },
    { name: 'elevation-c2', kind: 'elevation', capture: 'c2', file: 'elevation-c2.jpg' },
    { name: '3d-c2', kind: '3d', capture: 'c2', file: '3d-c2.jpg' },
    { name: 'cutfill-c2', kind: 'cutfill', capture: 'c2', pair: 'c1', file: 'cutfill-c2-c1.jpg' },
  ],
  markers3d: {},
  fingerprint: 'f',
};

/** The frame with each pile's own pictures: its photo on both dates and its 3D view. */
function pileFrame(n: number): ReportViewsFrame {
  return {
    ...FRAME,
    views: [
      ...FRAME.views,
      ...Array.from({ length: n }, (_, i) => {
        const k = String(i + 1);
        const pile = `m${String(i)}`;
        const extent: [number, number, number, number] = [20 * i - 4, -3, 20 * i + 16, 12];
        return [
          {
            name: `pile-${k}-photo-1`,
            kind: 'pile-photo' as const,
            capture: 'c1',
            pile,
            extent,
            file: `pile-${k}-photo-1.jpg`,
          },
          {
            name: `pile-${k}-photo-2`,
            kind: 'pile-photo' as const,
            capture: 'c2',
            pile,
            extent,
            file: `pile-${k}-photo-2.jpg`,
          },
          {
            name: `pile-${k}-3d`,
            kind: 'pile-3d' as const,
            capture: 'c2',
            pile,
            file: `pile-${k}-3d.jpg`,
          },
        ];
      }).flat(),
    ],
  };
}

const TEXT: ReportTextFile = {
  schema: 'aio.report-text/1',
  report: 'volumetric',
  parts: {
    summary: {
      versions: [{ text: 'Our own <words>.', source: 'user', createdAt: '2026-10-20T00:00:00Z' }],
    },
  },
  pileNotes: {},
};

function reader(frame: ReportViewsFrame): SurveyReader {
  const store: Record<string, unknown> = {
    'report/volumetric.json': TEXT,
    'report/views/volumetric/frame.json': frame,
  };
  return {
    json: (path) => Promise.resolve(store[path] ?? null),
    text: () => Promise.resolve(null),
    bytes: () => Promise.resolve(null),
  };
}

/** A fake JPEG: its source and request in the payload, padded to `bytes(req)`. */
function encoder(bytes: (req: PictureRequest) => number = () => 0) {
  return vi.fn<PictureEncoder>((src, req) => {
    const tag = Buffer.from(`${src}|${String(req.maxPx)}|${String(req.quality)}`).toString(
      'base64url',
    );
    return Promise.resolve(
      `data:image/jpeg;base64,${tag.replace(/[-_]/g, 'A')}${'A'.repeat(bytes(req))}`,
    );
  });
}

interface Fixture {
  /** How many piles (default 3). */
  piles?: number;
  /** The frame holds every pile's own pictures. */
  pilePictures?: boolean;
  /** The last pile has no figure on any date. */
  uncomputed?: boolean;
}

async function exportHtml(encode: PictureEncoder, fixture: Fixture = {}): Promise<string> {
  const n = fixture.piles ?? PILES;
  let state: Record<string, unknown> = {};
  const run: VolumetricRun = {
    kind: 'volumetric-html',
    read: reader(fixture.pilePictures ? pileFrame(n) : FRAME),
    files: files(n),
    build: () => Promise.resolve(survey(n, fixture.uncomputed)),
    compare: null,
    companyName: 'Our company',
    pictureUrl: (path) => `aio://p/${path}`,
    root: null,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    encode,
  };
  await runVolumetric(run);
  expect(state.state).toBe('ready');
  const html = state.html;
  if (typeof html !== 'string') throw new Error('no html published');
  return html;
}

/** A pile's own picture, by its file name. */
const isPile = (src: string) => /\/pile-\d+-/.test(src);

/** The sizes asked for, of the pile pictures or of the site pictures, ascending. */
function sizesOf(encode: ReturnType<typeof encoder>, pile: boolean): number[] {
  const sizes = new Set(
    encode.mock.calls.filter(([src]) => isPile(src) === pile).map(([, r]) => r.maxPx),
  );
  return [...sizes].sort((a, b) => a - b);
}

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

function viewerScript(html: string): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) throw new Error('no inline script');
  return m[1];
}

describe('the offline volumetric HTML file', () => {
  it('is a whole document with its own CSP naming the one script by hash', async () => {
    const html = await exportHtml(encoder());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    const doc = parse(html);
    expect(doc.querySelector('meta[charset]')?.getAttribute('charset')).toBe('utf-8');
    expect(doc.querySelector('meta[name="viewport"]')).not.toBeNull();
    const csp = doc
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content');
    const hash = createHash('sha256').update(viewerScript(html), 'utf8').digest('base64');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('img-src data: blob:');
    expect(csp).toContain('font-src data:');
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    // one executable script only; the data block is JSON
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts.filter((s) => !s.type).length).toBe(1);
    expect(doc.getElementById('vr-data')?.getAttribute('type')).toBe('application/json');
  });

  it('names no address it could fetch: pictures, fonts and marks are data: URIs', async () => {
    const html = await exportHtml(encoder());
    // an SVG namespace is a name, not a request (the lockup in the JSON escapes its quotes)
    const outsideXmlns = html.replace(
      /xmlns(:\w+)?=\\?["']http:\/\/www\.w3\.org\/[^"'\\]*\\?["']/g,
      '',
    );
    expect(outsideXmlns).not.toMatch(/https?:/i);
    expect(outsideXmlns).not.toMatch(/["'(=\s]\/\/[a-z0-9-]+\.[a-z]/i);
    const doc = parse(html);
    // the printed pages' shared pictures get their source from the data block at boot
    bootViewer(doc);
    const imgs = [...doc.querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) expect(img.getAttribute('src') ?? '').toMatch(/^data:/);
    // every url() in the stylesheet and in style attributes (the script's own come from the data)
    const styled = html.replace(/<script\b[\s\S]*?<\/script>/g, '');
    const urls = [...styled.matchAll(/url\(\s*['"]?([^'")\s]+)/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^data:/);
    const faces = [...html.matchAll(/@font-face\{[^}]*\}/g)].map((m) => m[0]);
    expect(faces.length).toBeGreaterThanOrEqual(3);
    for (const f of faces) expect(f).toMatch(/url\(data:font\/woff2;base64,/);
    expect(html).not.toContain('aio://');
  });

  it('holds each picture once: the pages take the shared ones from the data block', async () => {
    const html = await exportHtml(encoder());
    const uris = [...html.matchAll(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/g)].map((m) => m[0]);
    expect(uris.length).toBeGreaterThan(0);
    const counts = new Map<string, number>();
    for (const u of uris) counts.set(u, (counts.get(u) ?? 0) + 1);
    for (const [u, n] of counts) expect(n, u.slice(0, 60)).toBe(1);

    const doc = parse(html);
    const shared = [...doc.querySelectorAll<HTMLImageElement>('.vr-print img[data-vr-pic]')];
    // A's latest photo, C's before and after photos and the cut and fill map
    expect(shared.length).toBeGreaterThanOrEqual(4);
    for (const img of shared) expect(img.hasAttribute('src')).toBe(false);
    bootViewer(doc);
    const data = JSON.parse(doc.getElementById('vr-data')?.textContent ?? '') as ViewerData;
    for (const img of shared) {
      const [kind, capture] = (img.dataset.vrPic ?? '').split(':');
      const pic = data.pictures.find((p) => p.kind === kind && p.capture === capture);
      expect(pic).toBeDefined();
      expect(img.getAttribute('src')).toBe(pic?.src);
    }
    // the summary, the site overview, two pages of pile cards and the change page
    const pages = [...doc.querySelectorAll('.vr-print .vr-page')];
    expect(pages).toHaveLength(5);
    expect(pages[0]?.querySelector('img[data-vr-pic="photo:c2"]')?.getAttribute('src')).toMatch(
      /^data:image\/jpeg/,
    );
    expect(pages[4]?.querySelector('img[data-vr-pic="cutfill:c2"]')?.getAttribute('src')).toMatch(
      /^data:image\/jpeg/,
    );
  });

  it('holds each pile picture once, inside its card', async () => {
    const html = await exportHtml(encoder(), { pilePictures: true });
    const uris = [...html.matchAll(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/g)].map((m) => m[0]);
    const counts = new Map<string, number>();
    for (const u of uris) counts.set(u, (counts.get(u) ?? 0) + 1);
    for (const [u, n] of counts) expect(n, u.slice(0, 60)).toBe(1);
    const doc = parse(html);
    bootViewer(doc);
    const cards = [...doc.querySelectorAll('.vr-print .vr-pile')];
    expect(cards).toHaveLength(PILES);
    const seen = new Set<string>();
    for (const card of cards) {
      for (const kind of ['photo', '3d', 'before']) {
        const img = card.querySelector<HTMLImageElement>(`[data-pic="${kind}"] img`);
        // the pile's own picture, not the site photo shared with the view
        expect(img?.hasAttribute('data-vr-pic')).toBe(false);
        const src = img?.getAttribute('src') ?? '';
        expect(src).toMatch(/^data:image\/jpeg;base64,/);
        seen.add(src);
      }
      // the outline is drawn over the photo from the ground it covers
      expect(card.querySelector('[data-pic="photo"] svg.vr-pile-over')).not.toBeNull();
    }
    expect(seen.size).toBe(PILES * 3);
    // the view D keeps the site pictures only
    const data = JSON.parse(doc.getElementById('vr-data')?.textContent ?? '') as ViewerData;
    expect(data.pictures).toHaveLength(5);
  });

  it('a pile without pictures of its own is cut from the shared site photo', async () => {
    const html = await exportHtml(encoder());
    const doc = parse(html);
    const img = doc.querySelector<HTMLImageElement>('.vr-print .vr-pile [data-pic="photo"] img');
    expect(img?.dataset.vrPic).toBe('photo:c2');
    expect(doc.querySelector('.vr-print .vr-pile [data-pic="3d"] img')).toBeNull();
  });

  it('carries pages A to C for print, hidden on screen, and D for the screen only', async () => {
    const html = await exportHtml(encoder());
    const doc = parse(html);
    const print = doc.querySelector('.vr-print');
    expect(print).not.toBeNull();
    const pages = print?.querySelectorAll('.vr-page') ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/\.vr-print\s*\{\s*display:\s*none/);
    expect(html).toMatch(/@media print\s*\{[^@]*\.vr-print\s*\{\s*display:\s*block/);
    expect(html).toMatch(/@media print\s*\{\s*\.vr-d\s*\{\s*display:\s*none/);
    // the person's summary, escaped, inside the printed pages
    expect(print?.textContent).toContain('Our own <words>.');
    expect(doc.getElementById('vr-app')).not.toBeNull();
  });

  it('embeds the viewer data the view boots from', async () => {
    const html = await exportHtml(encoder());
    const doc = parse(html);
    const block = doc.getElementById('vr-data');
    expect(block?.textContent).not.toContain('<');
    const data = JSON.parse(block?.textContent ?? '') as ViewerData;
    expect(data.strings['vreport.viewer.select']).toBe(t('vreport.viewer.select'));
    expect(data.strings['vreport.viewer.select']).toContain('{pile}');
    expect(data.dates.map((d) => d.id)).toEqual(['c1', 'c2']);
    expect(data.from).toBe('c1');
    expect(data.to).toBe('c2');
    expect(data.frame).toEqual({ widthPx: 1000, heightPx: 1000 });
    expect(data.pictures.map((p) => `${p.kind}:${p.capture}`).sort()).toEqual(
      ['3d:c2', 'cutfill:c2', 'elevation:c2', 'photo:c1', 'photo:c2'].sort(),
    );
    for (const p of data.pictures) expect(p.src).toMatch(/^data:image\/jpeg;base64,/);
    expect(data.piles.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(data.piles[0]?.byDate).toEqual([
      { capture: 'c1', m3: 300, t: 480 },
      { capture: 'c2', m3: 310, t: 496 },
    ]);
    expect(data.csv).toBe(volumetricCsv(survey(), null));
    expect(data.csvName).toMatch(/\.csv$/);
    expect(data.lockupSvg).toMatch(/^<svg/);
    expect(data.title).toContain('The demo yard');
    expect(data.legend).toHaveLength(3);

    const handle = bootViewer(doc);
    expect(handle).not.toBeNull();
    expect(doc.querySelector('#vr-app .vr-d')).not.toBeNull();
    expect(doc.querySelectorAll('#vr-app button[aria-label]').length).toBeGreaterThan(0);
  });

  it('encodes photo and 3D at 0.80, maps at 0.88, pile pictures at 640 px', async () => {
    const encode = encoder();
    await exportHtml(encode, { pilePictures: true });
    const calls = encode.mock.calls.map(([src, req]) => ({ src, ...req }));
    const of = (file: string) => calls.filter((c) => c.src.endsWith(`/${file}`));
    expect(of('photo-c2.jpg')[0]).toMatchObject({ maxPx: 2000, quality: 0.8 });
    expect(of('3d-c2.jpg')[0]).toMatchObject({ maxPx: 2000, quality: 0.8 });
    expect(of('elevation-c2.jpg')[0]).toMatchObject({ maxPx: 2000, quality: 0.88 });
    expect(of('cutfill-c2-c1.jpg')[0]).toMatchObject({ maxPx: 2000, quality: 0.88 });
    const own = calls.filter((c) => isPile(c.src));
    expect(own).toHaveLength(PILES * 3);
    for (const c of own) expect(c).toMatchObject({ maxPx: 640, quality: 0.8 });
    // each picture is encoded once per size
    const keys = calls.map((c) => JSON.stringify(c));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('steps the pictures down to fit the budget', async () => {
    const big = Math.ceil(HTML_BUDGET_BYTES / 4);
    const encode = encoder((req) => (req.maxPx > 1600 ? big : 1000));
    const html = await exportHtml(encode);
    expect(new TextEncoder().encode(html).length).toBeLessThanOrEqual(HTML_BUDGET_BYTES);
    expect(sizesOf(encode, false)).toEqual([1600, 2000]);
  });

  it('with 60 piles steps the pile pictures down before the site pictures', async () => {
    // 180 pile pictures: too heavy at 640 px, light at 480 px
    const heavy = Math.ceil(HTML_BUDGET_BYTES / 100);
    const encode = encoder((req) => (req.maxPx === 640 ? heavy : 1000));
    const html = await exportHtml(encode, { piles: 60, pilePictures: true });
    expect(new TextEncoder().encode(html).length).toBeLessThanOrEqual(HTML_BUDGET_BYTES);
    expect(sizesOf(encode, true)).toEqual([480, 640]);
    expect(sizesOf(encode, false)).toEqual([2000]);
    expect(parse(html).querySelectorAll('.vr-print .vr-pile')).toHaveLength(60);
  });

  it('steps the site pictures down once the pile pictures are at their smallest', async () => {
    const big = Math.ceil(HTML_BUDGET_BYTES / 4);
    const encode = encoder((req) => (req.maxPx > 1600 ? big : 1000));
    await exportHtml(encode, { pilePictures: true });
    expect(sizesOf(encode, true)).toEqual([480, 640]);
    expect(sizesOf(encode, false)).toEqual([1600, 2000]);
  });

  it('refuses when the smallest pictures still do not fit', async () => {
    const encode = encoder(() => Math.ceil(HTML_BUDGET_BYTES / 4));
    await expect(exportHtml(encode)).rejects.toThrow(t('vreport.error.budget', { limit: '15 MB' }));
    expect(sizesOf(encode, false)).toEqual([1200, 1600, 2000]);
  });

  it('refuses a site of many piles whose smallest pile pictures still do not fit', async () => {
    const heavy = Math.ceil(HTML_BUDGET_BYTES / 100);
    const encode = encoder((req) => (req.maxPx <= 640 ? heavy : 1000));
    await expect(exportHtml(encode, { piles: 60, pilePictures: true })).rejects.toThrow(
      t('vreport.error.budget', { limit: '15 MB' }),
    );
    expect(sizesOf(encode, true)).toEqual([480, 640]);
    expect(sizesOf(encode, false)).toEqual([1200, 1600, 2000]);
  });

  it('lists a pile without a volume in the view, with null figures', async () => {
    const html = await exportHtml(encoder(), { piles: 4, uncomputed: true });
    const doc = parse(html);
    const data = JSON.parse(doc.getElementById('vr-data')?.textContent ?? '') as ViewerData;
    expect(data.piles.map((p) => p.id)).toEqual(['m2', 'm1', 'm0', 'm3']);
    const none = data.piles.find((p) => p.id === 'm3');
    expect(none?.byDate.length).toBeGreaterThan(0);
    for (const d of none?.byDate ?? []) expect(d).toMatchObject({ m3: null, t: null });
    expect(none?.peakM).toBeNull();
    expect(data.strings['vreport.notComputed']).toBe(t('vreport.notComputed'));
    expect(data.subtitle).toContain(t('vreport.band.pilesMeasured', { count: 4, measured: 3 }));

    bootViewer(doc);
    const row = doc.querySelector('#vr-app .vr-d-list-row[data-pile="m3"]');
    expect(row?.querySelector('.vr-d-row-amount')?.textContent).toBe(t('vreport.notComputed'));
    expect(row?.querySelector('.vr-d-row-change')?.textContent).toBe('');
    expect(doc.querySelector('#vr-app')?.textContent).not.toMatch(/NaN|Infinity|null|undefined/);
  });
});
