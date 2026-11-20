// @vitest-environment jsdom
// Page A of the volumetric report (cover and summary) on a synthetic 14-pile, two-date yard with
// fictional pile names: the band and title block, the KPI tiles, "In short", the ranked table with
// its diverging bars, the footer, the orthophoto with its markers, and the "A, continued" page
// the page plan gives for the rows past the twelfth; then a yard where some piles have no volume
// (every pile listed, "Not computed"), the overlap notice, and long texts printed whole.
import { brand } from '@aio/brand';
import {
  formatVolumeM3,
  inShortSentence,
  methodNote,
  pagePlan,
  volumetricModel as modelOf,
  volumetricModel,
  type VolumetricInput,
  type VolumetricModel,
  type VolumetricPileInput,
} from '@aio/project/export';
import type { ReportViewsFrame } from '@aio/schema';
import { t } from '@aio/ui';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_VIEWS, reportViews, type ResolvedText } from '../types/template';
import { CoverPage, leadHeightMm } from './cover';

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
    expect(text(d, '.vr-title h1')).toBe('Volumetric report');
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
    expect(d.querySelectorAll('.vr-table thead th')).toHaveLength(5);
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

  it("names each pile's base by its picker name in the table", () => {
    const own = piles(true).map((p, i) => (i === 0 ? { ...p, base: 'Previous survey' } : p));
    const d = render(volumetricModel(input({ piles: own })));
    const head = [...d.querySelectorAll('.vr-table thead th')].map((th) => th.textContent);
    expect(head[1]).toBe(t('vreport.table.base'));
    const rows = [...d.querySelectorAll('.vr-table tbody tr')];
    expect(rows[0]?.querySelector('.vr-col-base')?.textContent).toBe('Previous survey');
    expect(rows[1]?.querySelector('.vr-col-base')?.textContent).toBe('Lowest point on the outline');
  });

  it('prints the footer with the credit and the page number, and no method note on the cover', () => {
    const d = render(model);
    expect(text(d, '.vr-foot-by')).toBe(`Prepared with ${brand.productName} · Page 1`);
    expect(d.querySelector('.vr-foot img.vr-symbol')).not.toBeNull();
    const by = render(model, {
      parts: { preparedBy: 'Survey Co', method: 'By hand.' },
      pileNotes: {},
    });
    expect(text(by, '.vr-foot-by')).toBe(
      `Prepared by Survey Co with ${brand.productName} · Page 1`,
    );
    // the method note left the cover: it closes the report's last page (D12)
    expect(d.querySelector('.vr-method')).toBeNull();
    expect(by.querySelector('.vr-method')).toBeNull();
    expect(d.body.textContent).not.toContain(methodNote(model, t));
  });

  it('closes with the method note when the cover is the only page', () => {
    const alone = modelOf(
      input({ piles: piles(true).slice(0, 3), pages: { piles: false, change: false } }),
    );
    expect(pagePlan(alone)).toHaveLength(1);
    const d = render(alone);
    expect(text(d, '.vr-last .vr-method p')).toBe(methodNote(alone, t));
    expect(d.querySelector('.vr-foot .vr-method')).toBeNull();
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

  it('keeps badges apart: the pile name and its number never share a box', () => {
    const d = render(model);
    const cell = d.querySelector('.vr-table tbody td.vr-col-pile .vr-pile-cell');
    expect(cell?.querySelector('.vr-num')?.textContent).toBe('01');
    expect(cell?.querySelector('.vr-pile-name')?.textContent).toBe('P01');
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

/** Eight piles, three with a volume: Heap 1 to Heap 3; Heap 4 to Heap 8 were never computed. */
function mixed(): VolumetricPileInput[] {
  return Array.from({ length: 8 }, (_, i) => {
    const k = i + 1;
    const computed = k <= 3;
    const date = (capture: string, volumeM3: number | null) => ({
      capture,
      volumeM3,
      densityTPerM3: null,
      areaM2: 400,
      peakM: computed ? 5 : null,
      plusMinusM3: null,
      outline: square(100 * k, 400, 10),
    });
    return {
      id: `m${String(k)}`,
      label: `Heap ${String(k)}`,
      material: null,
      base: computed ? 'Lowest point' : '',
      dates: [
        date('c1', computed ? 1000 * (9 - k) + 50 : null),
        date('c2', computed ? 1000 * (9 - k) : null),
      ],
    };
  });
}

describe('page A, a pile at or under zero', () => {
  /** P01 to P14 with P13 at -3.9 m³ and P14 at 0 on the latest date. */
  const low = (): VolumetricPileInput[] =>
    piles(true).map((p, i) =>
      i < 12
        ? p
        : {
            ...p,
            dates: p.dates.map((d) =>
              d.capture === 'c2' ? { ...d, volumeM3: i === 12 ? -3.9 : 0 } : d,
            ),
          },
    );
  const model = volumetricModel(input({ piles: low() }));
  const d = render(model);
  // the two rank last, so their rows are on the "A, continued" page
  const pages = [d, render(model, NONE, views, 1)];
  const row = (id: string) => [
    ...(pages.map((x) => x.querySelector(`tr[data-pile="${id}"]`)).find((r) => r)?.children ?? []),
  ];

  it('prints no tonnes in its row, and the volume as computed', () => {
    // pile, base, previous, latest, tonnes, peak, change
    expect(row('m13')[3]?.textContent).toBe('−3.9');
    expect(row('m13')[4]?.textContent).toBe('');
    expect(row('m14')[3]?.textContent).toBe('0.0');
    expect(row('m14')[4]?.textContent).toBe('');
    expect(row('m1')[4]?.textContent).toBe('22,400');
  });

  it("keeps the site's tonnes the app's total, the negative pile in it", () => {
    const tonnes = model.piles.reduce((a, p) => a + (p.tonnes ?? 0), 0);
    expect(model.kpis.tonnes).toBeCloseTo(tonnes, 6);
    expect(tonnes).toBeCloseTo(model.kpis.stockM3 * 1.6, 6);
    expect(text(d, '.vr-kpi-stock .vr-kpi-sub')).toContain(
      `${Math.round(tonnes).toLocaleString('en-US')} t`,
    );
  });
});

describe('page A, piles without a volume', () => {
  const model = volumetricModel(input({ piles: mixed() }));
  const d = render(model);

  it('says how many piles there are and how many are measured', () => {
    expect(text(d, '.vr-title-meta')).toContain('8 piles, 3 measured');
    expect(text(d, '.vr-title-meta')).not.toContain('8 piles8');
  });

  it('lists every pile: five rows read "Not computed" across the figure columns', () => {
    const rows = [...d.querySelectorAll('.vr-table tbody tr')];
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.querySelector('.vr-pile-name')?.textContent)).toEqual(
      Array.from({ length: 8 }, (_, i) => `Heap ${String(i + 1)}`),
    );
    const none = rows.filter((r) => r.classList.contains('is-uncomputed'));
    expect(none).toHaveLength(5);
    for (const r of none) {
      const cell = r.querySelector('td.vr-col-none');
      expect(cell?.textContent).toBe(t('vreport.notComputed'));
      // previous, latest, peak and change: no pile has tonnes, so there is no tonnes column
      expect(cell?.getAttribute('colspan')).toBe('4');
      expect(r.querySelectorAll('td')).toHaveLength(3);
      expect(r.querySelector('.vr-col-base')?.textContent).toBe(t('vreport.pile.baseNotSet'));
    }
    expect(rows[0]?.querySelector('.vr-col-none')).toBeNull();
    expect(rows[0]?.textContent).toContain('8,000');
  });

  it('spans two columns with one date', () => {
    const one = volumetricModel(
      input({ piles: mixed(), captures: [{ id: 'c2', label: 'Survey 2', date: '2026-10-01' }] }),
    );
    expect(render(one).querySelector('td.vr-col-none')?.getAttribute('colspan')).toBe('2');
  });
});

describe('page A, the tonnes column', () => {
  const heads = (d: Document) =>
    [...d.querySelectorAll('.vr-table thead th')].map((th) => th.textContent);
  const cells = (d: Document, id: string) =>
    [...(d.querySelector(`tr[data-pile="${id}"]`)?.children ?? [])].map((c) => c.textContent);
  /** `mixed()` with a density on Heap 2 alone. */
  const oneWeighed = (): VolumetricPileInput[] =>
    mixed().map((p) =>
      p.id === 'm2' ? { ...p, dates: p.dates.map((d) => ({ ...d, densityTPerM3: 2 })) } : p,
    );

  it('is left out, header and cells, when no pile has tonnes', () => {
    const d = render(volumetricModel(input({ piles: mixed() })));
    expect(heads(d)).toEqual([
      t('vreport.table.pile'),
      t('vreport.table.base'),
      t('vreport.table.previous'),
      t('vreport.table.latest'),
      t('vreport.table.peak'),
      t('vreport.table.change'),
    ]);
    // pile, base, previous, latest, peak, change
    expect(cells(d, 'm1')).toEqual(['1Heap 1', 'Lowest point', '8,050', '8,000', '5.0', '−50.0']);
  });

  it('stays when at least one pile has tonnes, empty for the piles without', () => {
    const d = render(volumetricModel(input({ piles: oneWeighed() })));
    expect(heads(d)).toHaveLength(7);
    expect(heads(d)[4]).toBe(t('vreport.table.tonnes'));
    expect(cells(d, 'm1')[4]).toBe('');
    expect(cells(d, 'm2')[4]).toBe('14,000');
    expect(d.querySelector('td.vr-col-none')?.getAttribute('colspan')).toBe('5');
  });

  it('is decided by the whole report, so a continued page keeps the columns of the first', () => {
    // P01 to P14 with a density on P01 alone: the rows of the second page have no tonnes
    const own = piles(true).map((p, i) =>
      i === 0 ? p : { ...p, dates: p.dates.map((d) => ({ ...d, densityTPerM3: null })) },
    );
    const model = volumetricModel(input({ piles: own }));
    expect(heads(render(model, NONE, views, 1))).toEqual(heads(render(model)));
    expect(heads(render(model, NONE, views, 1))).toHaveLength(7);
  });

  it('is left out when the only pile with a density is at or under zero', () => {
    const own = mixed().map((p) =>
      p.id === 'm3'
        ? {
            ...p,
            dates: p.dates.map((d) => ({
              ...d,
              densityTPerM3: 2,
              volumeM3: d.capture === 'c2' ? 0 : d.volumeM3,
            })),
          }
        : p,
    );
    expect(heads(render(volumetricModel(input({ piles: own }))))).not.toContain(
      t('vreport.table.tonnes'),
    );
  });
});

describe('page A, the overlap notice', () => {
  it('is absent without overlaps', () => {
    expect(render(volumetricModel(input())).querySelector('.vr-notice')).toBeNull();
  });

  it('names both piles of one overlapping pair, under the table', () => {
    const model = volumetricModel(
      input({ piles: piles(true).slice(0, 4), overlaps: [{ a: 'm3', b: 'm1' }] }),
    );
    const d = render(model);
    const notice = d.querySelector('.vr-table + .vr-notice');
    expect(notice?.textContent).toBe(t('vreport.overlap.warning', { a: '01P01', b: '03P03' }));
    expect([...(notice?.querySelectorAll('.vr-num') ?? [])].map((n) => n.textContent)).toEqual([
      '01',
      '03',
    ]);
    expect(notice?.textContent).toContain('may count the same material twice');
  });

  it('lists several pairs in one sentence', () => {
    const model = volumetricModel(
      input({
        piles: piles(true).slice(0, 4),
        overlaps: [
          { a: 'm1', b: 'm2' },
          { a: 'm3', b: 'm4' },
        ],
      }),
    );
    const notice = render(model).querySelector('.vr-notice');
    const pair = (a: string, b: string) => t('vreport.overlap.pair', { a, b });
    expect(notice?.textContent).toBe(
      t('vreport.overlap.warningMany', {
        pairs: `${pair('01P01', '02P02')}; ${pair('03P03', '04P04')}`,
      }),
    );
  });

  it('stands on the page that ends the table', () => {
    const model = volumetricModel(input({ overlaps: [{ a: 'm1', b: 'm2' }] }));
    expect(render(model).querySelector('.vr-notice')).toBeNull();
    expect(render(model, NONE, views, 1).querySelector('.vr-notice')).not.toBeNull();
  });
});

describe('page A, long texts', () => {
  const model = volumetricModel(input());
  const long = 'Stock moved between the bays this month, and the north bay was cleared. '
    .repeat(9)
    .slice(0, 599)
    .concat('.');

  it('prints a 600 character summary whole', () => {
    expect(long).toHaveLength(600);
    const d = render(model, { parts: { summary: long, intro: long.slice(0, 300) }, pileNotes: {} });
    expect(text(d, '.vr-short p')).toBe(long);
    expect(text(d, '.vr-intro')).toBe(long.slice(0, 300).trim());
  });

  it('makes the room for it by counts: the photo row gives up height, never under its least', () => {
    const base = { introChars: 0, noticeChars: 0, rows: 12 };
    expect(leadHeightMm({ ...base, summaryChars: 120 })).toBe(80);
    const tight = leadHeightMm({ ...base, summaryChars: 600 });
    expect(tight).toBeLessThan(80);
    expect(tight).toBeGreaterThanOrEqual(46);
    expect(leadHeightMm({ ...base, summaryChars: 600, introChars: 600, noticeChars: 300 })).toBe(
      46,
    );
    // fewer rows leave the room without touching the photo
    expect(leadHeightMm({ ...base, rows: 3, summaryChars: 600 })).toBe(80);
    const d = render(model, { parts: { summary: long }, pileNotes: {} });
    expect(d.querySelector<HTMLElement>('.vr-lead')?.style.height).toBe(`${String(tight)}mm`);
    expect(d.querySelector<HTMLElement>('.vr-photo')?.style.height).toBe(`${String(tight)}mm`);
  });

  it('has no clip or clamp on a text box in the stylesheet', () => {
    const css = readFileSync(resolve(__dirname, 'volumetric.css'), 'utf8');
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      if (at < 0) throw new Error(`no rule for ${selector}`);
      return css.slice(at, css.indexOf('}', at));
    };
    for (const selector of [
      '.vr-short',
      '.vr-short p',
      '.vr-page .vr-intro',
      '.vr-page .vr-notice',
      '.vr-last p',
    ]) {
      const body = rule(selector);
      expect(body, selector).not.toMatch(/overflow:\s*hidden|text-overflow|line-clamp|max-height/);
      expect(body, selector).not.toMatch(/white-space:\s*nowrap/);
      expect(body, selector).not.toMatch(/\n {2}height:/);
    }
    expect(css).not.toMatch(/text-overflow|line-clamp/);
  });
});
