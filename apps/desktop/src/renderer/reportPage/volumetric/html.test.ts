// @vitest-environment jsdom
// The offline volumetric HTML file (spec section 4): one document with its own strict CSP naming
// the one script's hash, nothing it would have to fetch (fonts, pictures and the lockup as `data:`
// URIs), pages A to C for print and the interactive view D on screen, booting from the embedded
// data; the pictures step down to fit the 15 MB budget and the export refuses past it.
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

function files(): SurveyFiles {
  return {
    manifest: {
      name: 'Demo yard',
      customer: 'A customer',
      site: 'The demo yard',
      captures: CAPTURES,
      crs: { epsg: 32632 },
    } as unknown as ProjectManifest,
    measurements: Array.from({ length: PILES }, (_, i) => measurement(i)),
    surfaces: [{ id: 's2', capture: 'c2', cellM: 0.25, source: { kind: 'dsm' } }],
    settings: { materials: [sand] },
    kit: null,
  } as unknown as SurveyFiles;
}

function survey(): ReportSurveyData {
  const captureRefs = CAPTURES.map((c) => ({ id: c.id, label: c.label, date: c.date }));
  const stockpiles = stockpileInventory(
    Array.from({ length: PILES }, (_, i) => ({
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
      piles: Array.from({ length: PILES }, (_, i) => ({
        id: `m${String(i)}`,
        ref: `M${String(i + 1)}`,
        label: `P${String(i + 1)}`,
        folder: null,
        material: sand,
        base: 'Lowest point on the outline',
        carried: null,
        rows: CAPTURES.map((c, k) => ({
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

function reader(): SurveyReader {
  const store: Record<string, unknown> = {
    'report/volumetric.json': TEXT,
    'report/views/volumetric/frame.json': FRAME,
  };
  return {
    json: (path) => Promise.resolve(store[path] ?? null),
    text: () => Promise.resolve(null),
    bytes: () => Promise.resolve(null),
  };
}

/** A fake JPEG: its source and request in the payload, padded to `bytes(maxPx)`. */
function encoder(bytes: (req: PictureRequest) => number = () => 0) {
  return vi.fn<PictureEncoder>((src, req) => {
    const tag = Buffer.from(
      `${src}|${String(req.maxPx)}|${String(req.quality)}|${JSON.stringify(req.crop ?? null)}`,
    ).toString('base64url');
    return Promise.resolve(
      `data:image/jpeg;base64,${tag.replace(/[-_]/g, 'A')}${'A'.repeat(bytes(req))}`,
    );
  });
}

async function exportHtml(encode: PictureEncoder): Promise<string> {
  let state: Record<string, unknown> = {};
  const run: VolumetricRun = {
    kind: 'volumetric-html',
    read: reader(),
    files: files(),
    build: () => Promise.resolve(survey()),
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
    const pages = [...doc.querySelectorAll('.vr-print .vr-page')];
    expect(pages).toHaveLength(3);
    expect(pages[0]?.querySelector('img[data-vr-pic="photo:c2"]')?.getAttribute('src')).toMatch(
      /^data:image\/jpeg/,
    );
    expect(pages[2]?.querySelector('img[data-vr-pic="cutfill:c2"]')?.getAttribute('src')).toMatch(
      /^data:image\/jpeg/,
    );
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

  it('encodes photo and 3D at 0.80, maps at 0.88, crops at 600 px', async () => {
    const encode = encoder();
    await exportHtml(encode);
    const calls = encode.mock.calls.map(([src, req]) => ({ src, ...req }));
    const of = (file: string) => calls.filter((c) => c.src.endsWith(file) && !c.crop);
    expect(of('photo-c2.jpg')[0]).toMatchObject({ maxPx: 2000, quality: 0.8 });
    expect(of('3d-c2.jpg')[0]).toMatchObject({ maxPx: 2000, quality: 0.8 });
    expect(of('elevation-c2.jpg')[0]).toMatchObject({ maxPx: 2000, quality: 0.88 });
    expect(of('cutfill-c2-c1.jpg')[0]).toMatchObject({ maxPx: 2000, quality: 0.88 });
    const crops = calls.filter((c) => c.crop);
    expect(crops.length).toBeGreaterThan(0);
    for (const c of crops) expect(c).toMatchObject({ maxPx: 600, quality: 0.8 });
    // each picture is encoded once per size
    const keys = calls.map((c) => JSON.stringify(c));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('steps the pictures down to fit the budget', async () => {
    const big = Math.ceil(HTML_BUDGET_BYTES / 4);
    const encode = encoder((req) => (req.maxPx > 1600 ? big : 1000));
    const html = await exportHtml(encode);
    expect(new TextEncoder().encode(html).length).toBeLessThanOrEqual(HTML_BUDGET_BYTES);
    const sizes = new Set(encode.mock.calls.filter(([, r]) => !r.crop).map(([, r]) => r.maxPx));
    expect([...sizes].sort()).toEqual([1600, 2000]);
  });

  it('refuses when the smallest pictures still do not fit', async () => {
    const encode = encoder(() => Math.ceil(HTML_BUDGET_BYTES / 4));
    await expect(exportHtml(encode)).rejects.toThrow(t('vreport.error.budget', { limit: '15 MB' }));
    const sizes = new Set(encode.mock.calls.filter(([, r]) => !r.crop).map(([, r]) => r.maxPx));
    expect([...sizes].sort()).toEqual([1200, 1600, 2000]);
  });
});
