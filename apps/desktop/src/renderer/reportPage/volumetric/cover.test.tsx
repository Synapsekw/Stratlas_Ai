// @vitest-environment jsdom
// Page A of the volumetric report (cover and summary) on a synthetic 14-pile, two-date yard with
// fictional pile names: the band and title block, the KPI tiles, "In short", the ranked table with
// its diverging bars, the method note, the footer, the orthophoto with its markers, and the
// "A, continued" page the page plan gives for the rows past the twelfth.
import { brand } from '@aio/brand';
import {
  formatVolumeM3,
  inShortSentence,
  methodNote,
  pagePlan,
  volumetricModel,
  type VolumetricInput,
  type VolumetricModel,
  type VolumetricPileInput,
} from '@aio/project/export';
import type { ReportViewsFrame } from '@aio/schema';
import { t } from '@aio/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_VIEWS, reportViews, type ResolvedText } from '../types/template';
import { CoverPage } from './cover';

const FRAME: ReportViewsFrame = {
  schema: 'aio.report-views/1',
  extent: [0, 0, 1000, 800],
  widthPx: 2000,
  heightPx: 1600,
  mPerPx: 0.5,
  views: [{ name: 'photo-c2', kind: 'photo', capture: 'c2', file: 'photo-c2.jpg' }],
  markers3d: {},
  fingerprint: 'f1',
};

const square = (e: number, n: number, h: number): [number, number][] => [
  [e - h, n - h],
  [e + h, n - h],
  [e + h, n + h],
  [e - h, n + h],
];

/** P01 to P14: P01 the largest on the latest date; P03 grows, the rest shrink. */
function piles(error: boolean): VolumetricPileInput[] {
  return Array.from({ length: 14 }, (_, i) => {
    const k = i + 1;
    const latest = 1000 * (15 - k);
    const previous = k === 3 ? latest - 900 : latest + 100 * k;
    const outline = square(60 * k, 400, 10);
    const date = (capture: string, volumeM3: number) => ({
      capture,
      volumeM3,
      densityTPerM3: 1.6,
      areaM2: 400,
      peakM: 4 + k / 10,
      plusMinusM3: error ? 10 : null,
      outline,
    });
    return {
      id: `m${String(k)}`,
      label: `P${String(k).padStart(2, '0')}`,
      material: { id: 'gravel', name: 'Gravel' },
      base: 'Lowest point on the outline',
      dates: [date('c1', previous), date('c2', latest)],
    };
  });
}

function input(over: Partial<VolumetricInput> = {}, error = true): VolumetricInput {
  return {
    captures: [
      { id: 'c1', label: 'Survey 1', date: '2026-09-03' },
      { id: 'c2', label: 'Survey 2', date: '2026-10-01' },
    ],
    piles: piles(error),
    project: {
      name: 'Demo yard',
      customer: 'Demo customer',
      site: 'The demo yard',
      crs: 'EPSG:32632',
    },
    method: { cellM: 0.25, gsdCm: 3, siteDensityTPerM3: null },
    frame: FRAME,
    ...over,
  };
}

const NONE: ResolvedText = { parts: {}, pileNotes: {} };
const views = reportViews(FRAME, (f) => `aio://project/report/views/volumetric/${f}`);

function render(model: VolumetricModel, text: ResolvedText = NONE, v = views, n = 0): Document {
  const plan = pagePlan(model);
  const page = plan[n];
  if (!page) throw new Error('no such page');
  const html = renderToStaticMarkup(
    <CoverPage model={model} text={text} views={v} page={page} total={plan.length} />,
  );
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

const text = (d: Document, sel: string) => d.querySelector(sel)?.textContent ?? '';

describe('page A, the cover and summary', () => {
  const model = volumetricModel(input());

  it('opens with the band: the lockup, the report type and the tagline', () => {
    const d = render(model);
    const band = d.querySelector('.vr-band');
    expect(band?.querySelector('img.vr-lockup')?.getAttribute('src')).toMatch(
      /^data:image\/svg\+xml/,
    );
    expect(text(d, '.vr-band-type')).toBe(t('vreport.title'));
    expect(text(d, '.vr-band-tagline')).toBe(brand.tagline);
    expect(d.querySelector('.vr-band + .vr-rule')).not.toBeNull();
  });

  it('names the title, the customer, the site, both dates and the pile count', () => {
    const d = render(model);
    expect(text(d, '.vr-title h1')).toBe('Stockpile volume report');
    expect(text(d, '.vr-for')).toBe('Prepared for Demo customer');
    const meta = text(d, '.vr-title-meta');
    expect(meta).toContain('The demo yard');
    expect(meta).toContain('Surveyed 1 October 2026');
    expect(meta).toContain('Compared with 3 September 2026');
    expect(meta).toContain('14 piles');
    const edited = render(model, {
      parts: { title: 'Quarterly stock', preparedFor: 'Someone else' },
      pileNotes: {},
    });
    expect(text(edited, '.vr-title h1')).toBe('Quarterly stock');
    expect(text(edited, '.vr-for')).toBe('Prepared for Someone else');
  });

  it('shows three KPI tiles, and two when the model has no survey error', () => {
    const d = render(model);
    const tiles = d.querySelectorAll('.vr-kpi');
    expect(tiles).toHaveLength(3);
    expect(text(d, '.vr-kpi-stock .vr-kpi-figure')).toBe(formatVolumeM3(model.kpis.stockM3));
    expect(text(d, '.vr-kpi-stock .vr-kpi-sub')).toContain(' t');
    expect(d.querySelector('.vr-kpi-change.is-down')).not.toBeNull();
    expect(text(d, '.vr-kpi-change .vr-kpi-label')).toBe('Change since 3 September 2026');
    expect(text(d, '.vr-kpi-change .vr-kpi-figure')).toBe(
      `−${formatVolumeM3(model.kpis.changeM3 ?? 0)}`,
    );
    expect(text(d, '.vr-kpi-error .vr-kpi-figure')).toContain('± 140 m³');
    const noError = render(volumetricModel(input({}, false)));
    expect(noError.querySelectorAll('.vr-kpi')).toHaveLength(2);
    expect(noError.querySelector('.vr-kpi-error')).toBeNull();
  });

  it('leaves the change out with one date', () => {
    const one = volumetricModel(
      input({ captures: [{ id: 'c2', label: 'Survey 2', date: '2026-10-01' }] }),
    );
    const d = render(one);
    expect(d.querySelector('.vr-kpi-change')).toBeNull();
    expect(text(d, '.vr-title-meta')).not.toContain('Compared with');
    expect(d.querySelectorAll('.vr-table thead th')).toHaveLength(4);
  });

  it('says it in short, the generated sentence unless the person wrote one, then the intro', () => {
    const d = render(model);
    expect(text(d, '.vr-short p')).toBe(inShortSentence(model, t));
    expect(d.querySelector('.vr-short img.vr-symbol')).not.toBeNull();
    expect(d.querySelector('.vr-intro')).toBeNull();
    const edited = render(model, {
      parts: { summary: 'Written by hand.', intro: 'A short intro.' },
      pileNotes: {},
    });
    expect(text(edited, '.vr-short p')).toBe('Written by hand.');
    expect(text(edited, '.vr-intro')).toBe('A short intro.');
  });

  it('ranks the first twelve piles with diverging change bars scaled to the largest change', () => {
    const d = render(model);
    const rows = [...d.querySelectorAll('.vr-table tbody tr')];
    expect(rows).toHaveLength(12);
    expect(rows[0]?.querySelector('.vr-num')?.textContent).toBe('01');
    expect(rows[0]?.textContent).toContain('P01');
    // P01: 14,000 latest, 14,100 previous
    expect(rows[0]?.textContent).toContain('14,100');
    expect(rows[0]?.textContent).toContain('14,000');
    expect(rows[0]?.textContent).toContain('22,400');
    const bar = (r: Element | undefined) => r?.querySelector<HTMLElement>('.vr-bar-fill');
    // the largest change is P14 (1,400 less), beyond these rows: P12 is 1,200 less
    expect(bar(rows[11])?.className).toContain('is-down');
    expect(bar(rows[11])?.style.width).toBe(`${String((1200 / 1400) * 50)}%`);
    // P03 grew by 900
    expect(bar(rows[2])?.className).toContain('is-up');
    expect(bar(rows[2])?.style.width).toBe(`${String((900 / 1400) * 50)}%`);
    expect(rows[2]?.querySelector('.vr-change')?.textContent).toBe('+900');
    expect(rows[11]?.querySelector('.vr-change')?.textContent).toBe('−1,200');
  });

  it('prints the method note and the footer with the page number', () => {
    const d = render(model);
    expect(text(d, '.vr-method')).toContain(methodNote(model, t));
    expect(text(d, '.vr-foot-by')).toBe(`Prepared with ${brand.productName} · Page 1`);
    expect(d.querySelector('.vr-foot img.vr-symbol')).not.toBeNull();
    const by = render(model, {
      parts: { preparedBy: 'Survey Co', method: 'By hand.' },
      pileNotes: {},
    });
    expect(text(by, '.vr-foot-by')).toBe(
      `Prepared by Survey Co with ${brand.productName} · Page 1`,
    );
    expect(text(by, '.vr-method')).toContain('By hand.');
  });

  it('shows the latest orthophoto with numbered markers placed through the frame', () => {
    const d = render(model);
    expect(d.querySelector('.vr-photo img')?.getAttribute('src')).toBe(
      'aio://project/report/views/volumetric/photo-c2.jpg',
    );
    const markers = [...d.querySelectorAll<HTMLElement>('.vr-marker')];
    expect(markers).toHaveLength(14);
    // P01 sits at E 60, N 400: px 120 of 2000, py 800 of 1600
    expect(markers[0]?.textContent).toBe('01');
    expect(markers[0]?.style.left).toBe('6%');
    expect(markers[0]?.style.top).toBe('50%');
    expect(d.querySelector('.vr-scale')).not.toBeNull();
    expect(d.querySelector('.vr-north')).not.toBeNull();
  });

  it('shows a placeholder without pictures', () => {
    const d = render(volumetricModel(input({ frame: null })), NONE, NO_VIEWS);
    expect(d.querySelector('.vr-photo img')).toBeNull();
    expect(text(d, '.vr-photo-none')).toBe(t('vreport.pictures.placeholder'));
  });

  it('continues the table on "A, continued" with the rest of the rows', () => {
    const plan = pagePlan(model);
    expect(plan[1]).toMatchObject({ page: 'cover', continued: true, from: 12, to: 14 });
    const d = render(model, NONE, views, 1);
    expect(text(d, '.vr-continued')).toBe('A, continued');
    expect(d.querySelector('.vr-title')).toBeNull();
    expect(d.querySelector('.vr-kpi')).toBeNull();
    const rows = [...d.querySelectorAll('.vr-table tbody tr')];
    expect(rows.map((r) => r.querySelector('.vr-num')?.textContent)).toEqual(['13', '14']);
    expect(text(d, '.vr-foot-by')).toContain('Page 2');
  });
});
