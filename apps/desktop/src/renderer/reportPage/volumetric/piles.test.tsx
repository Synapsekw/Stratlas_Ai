// @vitest-environment jsdom
// Part B of the volumetric report on a synthetic five-pile yard with fictional pile names: the
// site overview page, then the pile pages with two cards each (2, 2 and 1), every pile with a
// card whether it has a volume or not, the person's notes, and the closing block on the report's
// last page when no change page follows.
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
import { volumetricTemplate } from '../types';
import { NO_VIEWS, reportViews, type ReportViews, type ResolvedText } from '../types/template';
import { PilesPage, volumetricPage } from './piles';

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

/** Heap 1 to Heap {count}: Heap 1 the largest; the last one has no volume. */
function piles(count: number): VolumetricPileInput[] {
  return Array.from({ length: count }, (_, i) => {
    const k = i + 1;
    const computed = k < count;
    const latest = computed ? 1000 * (count + 1 - k) : null;
    const date = (capture: string, volumeM3: number | null) => ({
      capture,
      volumeM3,
      densityTPerM3: null,
      areaM2: 400 + k,
      peakM: computed ? 4 + k / 10 : null,
      plusMinusM3: null,
      outline: square(200 * k, 400, 10),
    });
    return {
      id: `m${String(k)}`,
      label: `Heap ${String(k)}`,
      material: null,
      base: computed ? 'Lowest point' : '',
      dates: [date('c1', latest === null ? null : latest + 100), date('c2', latest)],
    };
  });
}

function input(count = 5, over: Partial<VolumetricInput> = {}): VolumetricInput {
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
const views = reportViews(FRAME, (f) => `aio://project/report/views/volumetric/${f}`);

function render(
  model: VolumetricModel,
  n: number,
  text: ResolvedText = NONE,
  v: ReportViews = views,
): Document {
  const plan = pagePlan(model);
  const page = plan.filter((p) => p.page === 'piles')[n];
  if (!page) throw new Error('no such page');
  const html = renderToStaticMarkup(
    <PilesPage model={model} text={text} views={v} page={page} total={plan.length} />,
  );
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

const text = (el: ParentNode | null | undefined, sel: string) =>
  el?.querySelector(sel)?.textContent ?? '';

describe('part B, the site overview and the pile pages', () => {
  const model = volumetricModel(input());

  it('registers itself as the piles page', () => {
    expect(volumetricPage.id).toBe('piles');
    expect(volumetricPage.component).toBe(PilesPage);
  });

  it('opens with the site overview: no cards on it', () => {
    const d = render(model, 0);
    expect(d.querySelector('.vr-page-piles .vr-ov')).not.toBeNull();
    expect(text(d, '.vr-ov-head h1')).toBe(t('vreport.overview.title'));
    expect(d.querySelectorAll('.vr-ov-fig')).toHaveLength(3);
    expect(d.querySelector('.vr-pile')).toBeNull();
    expect(d.querySelector('.vr-band')).not.toBeNull();
  });

  it('gives five piles three card pages of 2, 2 and 1, in report order', () => {
    const pages = pagePlan(model).filter((p) => p.page === 'piles');
    expect(pages.map((p) => p.part)).toEqual(['overview', 'cards', 'cards', 'cards']);
    const names = [1, 2, 3].map((n) =>
      [...render(model, n).querySelectorAll('.vr-pile .vr-pile-name')].map((h) => h.textContent),
    );
    expect(names).toEqual([['Heap 1', 'Heap 2'], ['Heap 3', 'Heap 4'], ['Heap 5']]);
    expect(render(model, 1).querySelector('.vr-ov')).toBeNull();
  });

  it('heads every card page with its title and the survey date', () => {
    const first = render(model, 1);
    expect(text(first, '.vr-pile-page-head h1')).toBe('Piles 1 to 2 of 5');
    expect(text(first, '.vr-pile-page-head span')).toBe('Surveyed 1 October 2026');
    expect(text(render(model, 2), '.vr-pile-page-head h1')).toBe('Piles 3 to 4 of 5');
    // a page with one card names that pile alone
    expect(text(render(model, 3), '.vr-pile-page-head h1')).toBe('Pile 5 of 5');
    expect(text(first, '.vr-foot-by')).toContain('Page 3');
  });

  it('gives the pile without a volume its card all the same', () => {
    const d = render(model, 3);
    const card = d.querySelector('.vr-pile');
    expect(card?.classList.contains('is-uncomputed')).toBe(true);
    expect(text(card, '.vr-pile-volume')).toBe(t('vreport.notComputed'));
    expect(card?.querySelectorAll('.vr-pile-pic')).toHaveLength(3);
  });

  it("prints the person's note on the pile's card, the saved one unless a newer text is given", () => {
    const noted = volumetricModel(input(5, { pileNotes: { m1: 'Saved note.' } }));
    expect(text(render(noted, 1), '[data-pile="m1"] .vr-pile-note')).toBe('Saved note.');
    const live = render(noted, 1, { parts: {}, pileNotes: { m1: 'Typed just now.' } });
    expect(text(live, '[data-pile="m1"] .vr-pile-note')).toBe('Typed just now.');
    expect(render(noted, 1).querySelector('[data-pile="m2"] .vr-pile-note')).toBeNull();
  });

  it('shows placeholders without pictures', () => {
    const bare = volumetricModel(input(5, { frame: null }));
    expect(render(bare, 0, NONE, NO_VIEWS).querySelectorAll('.vr-picture.is-empty')).toHaveLength(
      3,
    );
    expect(render(bare, 1, NONE, NO_VIEWS).querySelectorAll('.vr-pile-pic.is-empty')).toHaveLength(
      6,
    );
  });

  it('is left out, overview and cards together, when the person turned it off', () => {
    const off = volumetricModel(input(5, { pages: { piles: false } }));
    const pages = volumetricTemplate.render(off, NONE, views);
    expect(pages.some((p) => p.page === 'piles')).toBe(false);
    expect(
      volumetricTemplate.render(model, NONE, views).filter((p) => p.page === 'piles'),
    ).toHaveLength(4);
  });

  it('closes the report with the method note when a pile page is the last page', () => {
    // one date: no change page follows, so the last card page ends the report
    const one = volumetricModel(
      input(5, { captures: [{ id: 'c2', label: 'Survey 2', date: '2026-10-01' }] }),
    );
    const last = render(one, 3);
    expect(text(last, '.vr-last .vr-method h2')).toBe(t('vreport.method.title'));
    expect(text(last, '.vr-last .vr-method p')).toContain('EPSG:32632');
    expect(render(one, 2).querySelector('.vr-last')).toBeNull();
    // with a compared date the change page ends the report, so no pile page carries it
    expect(render(model, 3).querySelector('.vr-last')).toBeNull();
    expect(last.querySelector('.vr-foot .vr-method')).toBeNull();
  });

  it('closes on a page of its own after a last page of two cards', () => {
    // one date and an even number of piles: two cards fill their page, nothing is squeezed in
    const even = volumetricModel(
      input(4, { captures: [{ id: 'c2', label: 'Survey 2', date: '2026-10-01' }] }),
    );
    const long: ResolvedText = {
      parts: { closing: 'Closing remarks. '.repeat(40) },
      pileNotes: {},
    };
    const full = render(even, 2, long);
    expect(full.querySelectorAll('.vr-pile')).toHaveLength(2);
    expect(full.querySelector('.vr-last')).toBeNull();
    const closing = render(even, 3, long);
    expect(closing.querySelectorAll('.vr-pile')).toHaveLength(0);
    expect(closing.querySelector('.vr-pile-page-head')).toBeNull();
    expect(text(closing, '.vr-last .vr-closing p')).toContain('Closing remarks.');
    expect(text(closing, '.vr-last .vr-method h2')).toBe(t('vreport.method.title'));
    expect(pagePlan(even).filter((p) => p.page === 'piles')).toHaveLength(4);
  });
});
