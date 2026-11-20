// @vitest-environment jsdom
// Page C of the volumetric report (what changed) on a synthetic 30-pile, two-date yard with
// fictional pile names: the header with the date pair and the Before / After / Change key, the
// before and after orthophotos on the same frame, the cut and fill picture with the app's legend,
// the plain-words key with the deadband and the pile markers, the change chart sorted from the
// largest drawdown with rows of real height, the "C, continued" page, the closing remarks and the
// method note on the last printed page only (none in the footer), and C left out with one date.
import {
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
import { volumetricTemplate } from '../types';
import { NO_VIEWS, reportViews, type ResolvedText } from '../types/template';
import { ChangePage, changeLayout, volumetricPage } from './change';
import { dateText, signed } from './chrome';

const FRAME: ReportViewsFrame = {
  schema: 'aio.report-views/1',
  extent: [0, 0, 1000, 800],
  widthPx: 2000,
  heightPx: 1600,
  mPerPx: 0.5,
  views: [
    { name: 'photo-c1', kind: 'photo', capture: 'c1', file: 'photo-c1.jpg' },
    { name: 'photo-c2', kind: 'photo', capture: 'c2', file: 'photo-c2.jpg' },
    { name: 'cutfill-c2', kind: 'cutfill', capture: 'c2', pair: 'c1', file: 'cutfill-c2-c1.jpg' },
  ],
  markers3d: {},
  fingerprint: 'f1',
};

const square = (e: number, n: number, h: number): [number, number][] => [
  [e - h, n - h],
  [e + h, n - h],
  [e + h, n + h],
  [e - h, n + h],
];

/** P01 to P30: odd piles shrink by 10 k m³, even piles grow by 5 k m³. */
function piles(count: number): VolumetricPileInput[] {
  return Array.from({ length: count }, (_, i) => {
    const k = i + 1;
    const latest = 1000 + 100 * k;
    const previous = k % 2 === 1 ? latest + 10 * k : latest - 5 * k;
    const outline = square(30 * k, 400, 10);
    const date = (capture: string, volumeM3: number) => ({
      capture,
      volumeM3,
      densityTPerM3: 1.6,
      areaM2: 400,
      peakM: 4,
      plusMinusM3: null,
      outline,
    });
    return {
      id: `m${String(k)}`,
      label: `P${String(k).padStart(2, '0')}`,
      material: null,
      base: 'Lowest point on the outline',
      dates: [date('c1', previous), date('c2', latest)],
    };
  });
}

function input(over: Partial<VolumetricInput> = {}, count = 30): VolumetricInput {
  return {
    captures: [
      { id: 'c1', label: 'Survey 1', date: '2026-09-03' },
      { id: 'c2', label: 'Survey 2', date: '2026-10-01' },
    ],
    piles: piles(count),
    project: { name: 'Demo yard', customer: null, site: 'The demo yard', crs: 'EPSG:32632' },
    method: { cellM: 0.25, gsdCm: 3, siteDensityTPerM3: null },
    frame: FRAME,
    ...over,
  };
}

const NONE: ResolvedText = { parts: {}, pileNotes: {} };
const url = (f: string) => `aio://project/report/views/volumetric/${f}`;
const views = reportViews(FRAME, url);

function changePages(model: VolumetricModel) {
  const plan = pagePlan(model);
  return { plan, pages: plan.filter((p) => p.page === 'change') };
}

function render(model: VolumetricModel, text: ResolvedText = NONE, v = views, n = 0): Document {
  const { plan, pages } = changePages(model);
  const page = pages[n];
  if (!page) throw new Error('no such page');
  const html = renderToStaticMarkup(
    <ChangePage model={model} text={text} views={v} page={page} total={plan.length} />,
  );
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

const text = (d: Document, sel: string) => d.querySelector(sel)?.textContent ?? '';

describe('page C, what changed', () => {
  const model = volumetricModel(input());

  it('registers itself as the change page', () => {
    expect(volumetricPage.id).toBe('change');
    expect(volumetricPage.component).toBe(ChangePage);
  });

  it('heads the page with the date pair, the site and the Before / After / Change key', () => {
    const d = render(model);
    expect(d.querySelector('.vr-band')).not.toBeNull();
    expect(text(d, '.vr-c-dates')).toBe(`${dateText('2026-09-03')} → ${dateText('2026-10-01')}`);
    expect(text(d, '.vr-c-head h1')).toBe(t('vreport.change.siteTitle', { site: 'The demo yard' }));
    const keys = [...d.querySelectorAll('.vr-c-keys > span')].map((k) => k.textContent);
    expect(keys).toEqual([
      t('vreport.change.keyBefore'),
      t('vreport.change.keyAfter'),
      t('vreport.piles.change'),
    ]);
  });

  it('shows the before and after orthophotos on the same frame, captioned with their dates', () => {
    const d = render(model);
    const imgs = [...d.querySelectorAll('.vr-c-pair .vr-picture img')].map((i) =>
      i.getAttribute('src'),
    );
    expect(imgs).toEqual([url('photo-c1.jpg'), url('photo-c2.jpg')]);
    const boxes = [...d.querySelectorAll('.vr-c-pair .vr-picture-inner')].map((b) =>
      b.getAttribute('style'),
    );
    expect(boxes[0]).toBe(boxes[1]);
    const caps = [...d.querySelectorAll('.vr-c-pair figcaption')].map((c) => c.textContent);
    expect(caps).toEqual([
      t('vreport.change.before', { date: dateText('2026-09-03') }),
      t('vreport.change.after', { date: dateText('2026-10-01') }),
    ]);
  });

  it('shows the cut and fill picture with the pile markers and the app legend', () => {
    const d = render(model);
    const heat = d.querySelector('.vr-c-heat .vr-picture');
    expect(heat?.querySelector('img')?.getAttribute('src')).toBe(url('cutfill-c2-c1.jpg'));
    expect(heat?.querySelectorAll('.vr-marker').length).toBeGreaterThan(0);
    const legend = d.querySelector('[data-testid="cutfill-legend"]');
    expect(legend).not.toBeNull();
    expect(legend?.textContent).toContain(t('cutfill.legendFill', { value: '2.0 m' }));
  });

  it('explains the colours in plain words with the deadband the pictures were taken with', () => {
    const d = render(model);
    expect(text(d, '.vr-c-heat h2')).toBe(t('vreport.change.heatTitle'));
    expect(text(d, '.vr-c-heat-dates')).toBe(
      t('vreport.change.heat', { from: dateText('2026-09-03'), to: dateText('2026-10-01') }),
    );
    expect(text(d, '.vr-c-heat-explain')).toBe(t('vreport.change.heatExplain'));
    expect(text(d, '.vr-c-key')).toContain(t('vreport.key.red'));
    expect(text(d, '.vr-c-key')).toContain(t('vreport.key.blue'));
    expect(text(d, '.vr-c-key')).toContain(t('vreport.key.grey', { deadband: '0.10' }));
    const framed = { ...FRAME, cutFill: { thresholdM: 0.25, rangeM: 3 } };
    const d2 = render(model, NONE, reportViews(framed, url));
    expect(text(d2, '.vr-c-key')).toContain(t('vreport.key.grey', { deadband: '0.25' }));
    expect(d2.querySelector('[data-testid="cutfill-legend"]')?.textContent).toContain(
      t('cutfill.legendFill', { value: '3.0 m' }),
    );
  });

  it('charts the change per pile from the largest drawdown, 24 bars on the first page', () => {
    const d = render(model);
    const rows = [...d.querySelectorAll('.vr-c-row')];
    expect(rows).toHaveLength(24);
    const ids = rows.map((r) => r.getAttribute('data-pile'));
    expect(ids).toEqual(model.changeOrder.slice(0, 24));
    // P29 lost the most (290 m³), so it comes first
    expect(text(d, '.vr-c-row .vr-c-name')).toContain('P29');
    const first = rows[0];
    expect(first?.querySelector('.vr-c-fill')?.classList.contains('is-down')).toBe(true);
    expect(first?.querySelector('.vr-c-fill')?.getAttribute('style')).toContain('width:50%');
    expect(first?.querySelector('.vr-c-value')?.textContent).toBe(signed(-290));
    expect(first?.querySelector('.vr-c-value')?.classList.contains('is-down')).toBe(true);
    const ups = rows.filter((r) => r.querySelector('.vr-c-fill.is-up'));
    expect(ups.length).toBeGreaterThan(0);
    expect(d.querySelector('.vr-c-axis')).not.toBeNull();
    expect(text(d, '.vr-c-piles h2')).toBe(t('vreport.change.chart'));
    const hints = [...d.querySelectorAll('.vr-c-axis-hint > span')].map((h) => h.textContent);
    expect(hints).toEqual([t('vreport.change.axisLess'), t('vreport.change.axisMore')]);
  });

  it('prints the method block once, on the last page only, and none in any footer', () => {
    const first = render(model, NONE, views, 0);
    const last = render(model, NONE, views, 1);
    expect(first.querySelector('.vr-method')).toBeNull();
    expect(text(last, '.vr-last .vr-method h2')).toBe(t('vreport.method.title'));
    expect(text(last, '.vr-last .vr-method p')).toBe(methodNote(model, t));
    for (const d of [first, last]) {
      expect(d.querySelector('.vr-foot .vr-method')).toBeNull();
      expect(d.querySelector('.vr-foot')?.textContent).not.toContain(t('vreport.method.title'));
      expect(d.querySelector('.vr-foot')?.textContent).not.toContain(t('vreport.change.heatNote'));
    }
    // the person's method text is the one printed
    const own = render(model, { parts: { method: 'By hand.' }, pileNotes: {} }, views, 1);
    expect(text(own, '.vr-last .vr-method p')).toBe('By hand.');
    // across the whole report: one method block
    const pages = volumetricTemplate.render(model, NONE, views);
    const html = pages.map((pg) => renderToStaticMarkup(pg.element)).join('');
    expect(html.split('class="vr-method"')).toHaveLength(2);
  });

  it('gives every bar a row of real height, by counts', () => {
    // a few piles: full rows and full pictures
    expect(changeLayout({ rows: 3, continued: false })).toEqual({
      pairH: 50,
      heatH: 78,
      rowH: 5.6,
    });
    // a full first page: the pictures give up height before the rows close up
    const full = changeLayout({ rows: 24, continued: false });
    expect(full.heatH).toBe(46);
    expect(full.pairH).toBe(34);
    expect(full.rowH).toBeGreaterThanOrEqual(3.6);
    expect(full.rowH).toBeLessThan(5.6);
    expect(changeLayout({ rows: 40, continued: true }).rowH).toBe(5.6);
    expect(changeLayout({ rows: 40, continued: true, lastMm: 60 }).rowH).toBeLessThan(5.6);
    const d = render(model);
    const row = d.querySelector<HTMLElement>('.vr-c-row');
    expect(row?.style.minHeight).toBe(`${String(full.rowH)}mm`);
    // the name and its number each have their own box, so neither is squeezed
    expect(row?.querySelector('.vr-c-name .vr-num')?.textContent).toBe('29');
    expect(row?.querySelector('.vr-c-name .vr-c-label')?.textContent).toBe('P29');
    const few = render(volumetricModel(input({}, 3)));
    expect(few.querySelector<HTMLElement>('.vr-c-row')?.style.minHeight).toBe('5.6mm');
  });

  it('continues the chart on "C, continued" with the rest of the piles', () => {
    const { pages } = changePages(model);
    expect(pages).toHaveLength(2);
    const d = render(model, NONE, views, 1);
    expect(text(d, '.vr-continued')).toBe(t('vreport.page.changeContinued'));
    expect(d.querySelectorAll('.vr-c-row')).toHaveLength(6);
    expect(d.querySelector('.vr-c-pair')).toBeNull();
  });

  it('prints the closing remarks only on the last printed page', () => {
    const closing: ResolvedText = { parts: { closing: 'Thank you.' }, pileNotes: {} };
    expect(text(render(model, closing, views, 0), '.vr-closing')).toBe('');
    expect(text(render(model, closing, views, 1), '.vr-closing')).toContain('Thank you.');
    expect(render(model, NONE, views, 1).querySelector('.vr-closing')).toBeNull();
  });

  it('shows placeholders without pictures', () => {
    const d = render(model, NONE, NO_VIEWS);
    expect(d.querySelectorAll('.vr-picture.is-empty')).toHaveLength(3);
  });

  it('is left out with one date', () => {
    const one = volumetricModel(
      input({ captures: [{ id: 'c2', label: 'Survey 2', date: '2026-10-01' }] }, 3),
    );
    const pages = volumetricTemplate.render(one, NONE, views);
    expect(pages.some((p) => p.page === 'change')).toBe(false);
    const two = volumetricTemplate.render(volumetricModel(input({}, 3)), NONE, views);
    expect(two.some((p) => p.page === 'change')).toBe(true);
  });
});
