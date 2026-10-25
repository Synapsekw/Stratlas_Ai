// @vitest-environment jsdom
// Page B of the volumetric report (pile cards) on a synthetic 19-pile, two-date yard with
// fictional pile names: the header with the stock and its change, the share-of-stock bar (the 8
// largest and the Others, summing to 100 %), a card for each of the 8 largest piles (before and
// after crops at one framing, the change chip, tonnes, footprint, peak height, the note), the
// compact list of the other 11 with a note mark, and the "B, continued" pages of the page plan.
import {
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
import { NO_VIEWS, reportViews, type ReportViews, type ResolvedText } from '../types/template';
import { cropHeightMm, PilesPage, volumetricPage } from './piles';

const FRAME: ReportViewsFrame = {
  schema: 'aio.report-views/1',
  extent: [0, 0, 1200, 800],
  widthPx: 2400,
  heightPx: 1600,
  mPerPx: 0.5,
  views: [
    { name: 'photo-c1', kind: 'photo', capture: 'c1', file: 'photo-c1.jpg' },
    { name: 'photo-c2', kind: 'photo', capture: 'c2', file: 'photo-c2.jpg' },
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

/** P01 to P{count}: P01 the largest; P03 grows, the rest shrink. */
function piles(count: number): VolumetricPileInput[] {
  return Array.from({ length: count }, (_, i) => {
    const k = i + 1;
    const latest = 1000 * (count + 1 - k);
    const previous = k === 3 ? latest - 900 : latest + 100 * k;
    const outline = square(50 * k, 400, 10);
    const date = (capture: string, volumeM3: number) => ({
      capture,
      volumeM3,
      densityTPerM3: 1.6,
      areaM2: 400 + k,
      peakM: 4 + k / 10,
      plusMinusM3: null,
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

function input(count = 19, over: Partial<VolumetricInput> = {}): VolumetricInput {
  return {
    captures: [
      { id: 'c1', label: 'Survey 1', date: '2026-09-03' },
      { id: 'c2', label: 'Survey 2', date: '2026-10-01' },
    ],
    piles: piles(count),
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
const withCrops = reportViews(
  FRAME,
  (f) => `aio://project/report/views/volumetric/${f}`,
  (pile, capture) => `aio://project/report/views/volumetric/crop-${pile}-${capture}.jpg`,
);

function pilesPages(model: VolumetricModel) {
  return pagePlan(model).filter((p) => p.page === 'piles');
}

function render(
  model: VolumetricModel,
  text: ResolvedText = NONE,
  v: ReportViews = views,
  n = 0,
): Document {
  const plan = pagePlan(model);
  const page = pilesPages(model)[n];
  if (!page) throw new Error('no such page');
  const html = renderToStaticMarkup(
    <PilesPage model={model} text={text} views={v} page={page} total={plan.length} />,
  );
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

const text = (el: ParentNode | null | undefined, sel: string) =>
  el?.querySelector(sel)?.textContent ?? '';

describe('page B, the pile cards', () => {
  const model = volumetricModel(input());

  it('registers itself as the piles page', () => {
    expect(volumetricPage.id).toBe('piles');
    expect(volumetricPage.component).toBe(PilesPage);
  });

  it('heads the page with the stock on the latest date, its tonnes and its change', () => {
    const d = render(model);
    expect(d.querySelector('.vr-band')).not.toBeNull();
    expect(text(d, '.vr-piles-head h1')).toBe('Stock inventory · 1 October 2026');
    expect(text(d, '.vr-piles-head .vr-piles-site')).toBe('The demo yard');
    expect(text(d, '.vr-piles-total')).toBe(
      `${model.kpis.stockM3.toLocaleString('en-US', { maximumFractionDigits: 0 })} m³`,
    );
    expect(text(d, '.vr-piles-tonnes')).toContain(' t');
    expect(d.querySelector('.vr-piles-change.is-down')).not.toBeNull();
    expect(text(d, '.vr-piles-change')).toMatch(/^−/);
  });

  it('splits the share-of-stock bar into the 8 largest and the Others, summing to 100 %', () => {
    const d = render(model);
    expect(text(d, '.vr-share h2')).toBe('Share of stock on hand');
    const segs = [...d.querySelectorAll<HTMLElement>('.vr-share-seg')];
    expect(segs).toHaveLength(9);
    const widths = segs.map((s) => Number.parseFloat(s.style.width));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
    expect(segs.at(-1)?.classList.contains('is-others')).toBe(true);
    // the first four in the dark teals carry white text, the rest ink
    expect(segs[0]?.classList.contains('is-dark')).toBe(true);
    expect(segs[3]?.classList.contains('is-dark')).toBe(true);
    expect(segs[4]?.classList.contains('is-dark')).toBe(false);
    // the largest is labelled; a sliver is not
    expect(segs[0]?.textContent).toContain('P01');
    const tiny = volumetricModel(input(40));
    const tinySegs = [...render(tiny).querySelectorAll('.vr-share-seg')];
    expect(tinySegs[7]?.textContent).toBe('');
  });

  it('gives the 8 largest piles a card each, the 11 others the compact list', () => {
    const d = render(model);
    const cards = [...d.querySelectorAll('.vr-card')];
    expect(cards).toHaveLength(8);
    expect(cards.map((c) => text(c, '.vr-card-name'))).toEqual(
      model.cards.map((id) => model.piles.find((p) => p.id === id)?.label),
    );
    const rows = [...d.querySelectorAll('.vr-smaller-row')];
    expect(rows).toHaveLength(11);
    expect(text(d, '.vr-smaller h2')).toBe('Smaller piles');
    expect(text(rows[0], '.vr-smaller-name')).toBe('P09');
  });

  it('shows the before and after crops at one framing, the previous date first', () => {
    const d = render(model);
    const card = d.querySelector('.vr-card');
    const crops = [...(card?.querySelectorAll('.vr-crop') ?? [])];
    expect(crops).toHaveLength(2);
    const imgs = crops.map((c) => c.querySelector('img')?.getAttribute('src'));
    expect(imgs).toEqual([
      'aio://project/report/views/volumetric/photo-c1.jpg',
      'aio://project/report/views/volumetric/photo-c2.jpg',
    ]);
    const styles = crops.map((c) => c.querySelector('img')?.getAttribute('style'));
    expect(styles[0]).toBe(styles[1]);
    const caps = crops.map((c) => text(c, 'figcaption'));
    expect(caps[0]).toMatch(/^3 Sep · [\d,]+ m³$/);
    expect(caps[1]).toMatch(/^1 Oct · [\d,]+ m³$/);
    expect(crops[1]?.classList.contains('is-latest')).toBe(true);
  });

  it('uses the separate crop JPEGs when the views have them', () => {
    const d = render(model, NONE, withCrops);
    const imgs = [...(d.querySelector('.vr-card')?.querySelectorAll('.vr-crop img') ?? [])];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      'aio://project/report/views/volumetric/crop-m1-c1.jpg',
      'aio://project/report/views/volumetric/crop-m1-c2.jpg',
    ]);
    expect(imgs[0]?.classList.contains('is-file')).toBe(true);
  });

  it('says to take the pictures without any', () => {
    const d = render(volumetricModel(input(19, { frame: null })), NONE, NO_VIEWS);
    const crop = d.querySelector('.vr-card .vr-crop');
    expect(crop?.classList.contains('is-empty')).toBe(true);
    expect(crop?.querySelector('img')).toBeNull();
  });

  it('puts the change chip, tonnes, footprint and peak height on each card', () => {
    const d = render(model);
    const cards = [...d.querySelectorAll('.vr-card')];
    const p1 = model.piles[0];
    const p3 = model.piles[2];
    expect(cards[0]?.querySelector('.vr-chip.is-down')).not.toBeNull();
    expect(text(cards[0], '.vr-chip')).toMatch(/^−100 m³ · −0\.[0-9] %$/);
    expect(cards[2]?.querySelector('.vr-chip.is-up')).not.toBeNull();
    expect(text(cards[2], '.vr-chip')).toMatch(/^\+900 m³/);
    const stats = [...(cards[0]?.querySelectorAll('.vr-stat') ?? [])];
    expect(stats.map((s) => text(s, '.vr-stat-label'))).toEqual([
      t('vreport.piles.tonnes'),
      t('vreport.piles.footprint'),
      t('vreport.piles.peak'),
    ]);
    expect(stats.map((s) => text(s, '.vr-stat-value'))).toEqual([
      (p1?.tonnes ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 }),
      String(Math.round(p1?.areaM2 ?? 0)),
      (p1?.peakM ?? 0).toFixed(1),
    ]);
    expect(p3).toBeDefined();
  });

  it('prints the note under the card when the person wrote one', () => {
    const plain = render(model);
    expect(plain.querySelector('.vr-card-note')).toBeNull();
    const noted = render(model, { parts: {}, pileNotes: { m2: 'Being loaded out.' } });
    const cards = [...noted.querySelectorAll('.vr-card')];
    expect(text(cards[1], '.vr-card-note')).toBe('Being loaded out.');
    expect(cards[0]?.querySelector('.vr-card-note')).toBeNull();
  });

  it('marks a compact row that has a note, and colours its change', () => {
    const d = render(model, { parts: {}, pileNotes: { m12: 'Topsoil.' } });
    const rows = [...d.querySelectorAll('.vr-smaller-row')];
    const row = rows.find((r) => text(r, '.vr-smaller-name') === 'P12');
    expect(row?.querySelector('.vr-note-mark')?.getAttribute('title')).toBe('Topsoil.');
    expect(rows.filter((r) => r.querySelector('.vr-note-mark'))).toHaveLength(1);
    expect(row?.querySelector('.vr-smaller-change.is-down')).not.toBeNull();
  });

  it('leaves out the previous crop and the chip with one date', () => {
    const one = volumetricModel(
      input(19, { captures: [{ id: 'c2', label: 'Survey 2', date: '2026-10-01' }] }),
    );
    const d = render(one);
    expect(d.querySelectorAll('.vr-card')[0]?.querySelectorAll('.vr-crop')).toHaveLength(1);
    expect(d.querySelector('.vr-chip')).toBeNull();
    expect(d.querySelector('.vr-piles-change')).toBeNull();
  });

  it('continues the compact list on "B, continued" pages per the page plan', () => {
    const big = volumetricModel(input(80));
    const pages = pilesPages(big);
    expect(pages).toHaveLength(3); // 72 compact rows: 24, then 40, then 8
    const first = render(big, NONE, views, 0);
    expect(first.querySelectorAll('.vr-smaller-row')).toHaveLength(24);
    const second = render(big, NONE, views, 1);
    expect(text(second, '.vr-continued')).toBe(t('vreport.page.pilesContinued'));
    expect(second.querySelector('.vr-card')).toBeNull();
    expect(second.querySelector('.vr-share')).toBeNull();
    expect(second.querySelectorAll('.vr-smaller-row')).toHaveLength(40);
    expect(text(second.querySelector('.vr-smaller-row'), '.vr-smaller-name')).toBe('P33');
    expect(render(big, NONE, views, 2).querySelectorAll('.vr-smaller-row')).toHaveLength(8);
    expect(second.querySelector('.vr-page')?.getAttribute('data-page')).toBe(
      String(pages[1]?.number),
    );
  });

  it('sizes the crops from the fixed counts so the page always fits', () => {
    // fewer compact rows and no notes leave taller crops; never under the floor
    expect(cropHeightMm({ cardRows: 4, compactRows: 24, notes: true })).toBeGreaterThanOrEqual(12);
    expect(cropHeightMm({ cardRows: 4, compactRows: 0, notes: false })).toBeGreaterThan(
      cropHeightMm({ cardRows: 4, compactRows: 24, notes: false }),
    );
    expect(cropHeightMm({ cardRows: 4, compactRows: 11, notes: true })).toBeLessThan(
      cropHeightMm({ cardRows: 4, compactRows: 11, notes: false }),
    );
    expect(cropHeightMm({ cardRows: 1, compactRows: 0, notes: false })).toBeLessThanOrEqual(41);
  });
});
