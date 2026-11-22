// @vitest-environment jsdom
// One pile's card of the volumetric report, on a synthetic two-date yard with fictional pile
// names: a measured pile (volume, change badge, three pictures, the shared profile chart, six
// figures), a pile without a volume, a pile under zero, a pile past the pictures' cap, the
// placeholders without pictures, and the texts that must print whole.
import {
  volumetricModel,
  type VolumetricInput,
  type VolumetricModel,
  type VolumetricPileInput,
  type VolumetricPileProfile,
} from '@aio/project/export';
import { REPORT_VIEWS_MAX, type ReportViewsFrame } from '@aio/schema';
import { t } from '@aio/ui';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_VIEWS, reportViews, type ReportViews } from '../types/template';
import { CAPTION_LINE, CARD_H, chartHeightPx, PileCard } from './pileCard';

const square = (e: number, n: number, h: number): [number, number][] => [
  [e - h, n - h],
  [e + h, n - h],
  [e + h, n + h],
  [e - h, n + h],
];

const CHAINAGE = [0, 10, 20, 30, 40];
function profile(over: Partial<VolumetricPileProfile> = {}): VolumetricPileProfile {
  return {
    a: [80, 400],
    b: [120, 400],
    lengthM: 40,
    series: [
      {
        kind: 'current',
        capture: 'c2',
        date: '2026-10-01',
        chainage: CHAINAGE,
        z: [100, 104, 108, 103, 100],
      },
      {
        kind: 'earlier',
        capture: 'c1',
        date: '2026-09-03',
        chainage: CHAINAGE,
        z: [100, 105, 110, 104, 100],
      },
      { kind: 'base', chainage: CHAINAGE, z: [null, 100, 100, 100, null] },
    ],
    baseLevel: [100, 100.02],
    baseKind: 'own',
    ...over,
  };
}

function pile(
  k: number,
  volumes: [number | null, number | null],
  over: Partial<VolumetricPileInput> = {},
): VolumetricPileInput {
  const outline = square(100 * k, 400, 15);
  const date = (capture: string, volumeM3: number | null) => ({
    capture,
    volumeM3,
    densityTPerM3: volumeM3 === null ? null : 1.6,
    areaM2: 900,
    peakM: volumeM3 === null ? null : 8.4,
    plusMinusM3: null,
    outline,
  });
  return {
    id: `m${String(k)}`,
    label: `Heap ${String(k)}`,
    material: null,
    base: 'Lowest point',
    dates: [date('c1', volumes[0]), date('c2', volumes[1])],
    profile: profile(),
    ...over,
  };
}

const url = (f: string) => `aio://project/report/views/volumetric/${f}`;

/** The site pictures, and each given pile's own three pictures. */
function frame(pictured: readonly string[]): ReportViewsFrame {
  return {
    schema: 'aio.report-views/1',
    extent: [0, 0, 1200, 800],
    widthPx: 2400,
    heightPx: 1600,
    mPerPx: 0.5,
    views: [
      { name: 'photo-c1', kind: 'photo', capture: 'c1', file: 'photo-c1.jpg' },
      { name: 'photo-c2', kind: 'photo', capture: 'c2', file: 'photo-c2.jpg' },
      ...pictured.flatMap((id) => [
        {
          name: `${id}-photo-c2`,
          kind: 'pile-photo' as const,
          capture: 'c2',
          pile: id,
          extent: [60, 370, 140, 430] as [number, number, number, number],
          file: `pile-${id}-photo-2.jpg`,
        },
        {
          name: `${id}-photo-c1`,
          kind: 'pile-photo' as const,
          capture: 'c1',
          pile: id,
          extent: [60, 370, 140, 430] as [number, number, number, number],
          file: `pile-${id}-photo-1.jpg`,
        },
        {
          name: `${id}-3d`,
          kind: 'pile-3d' as const,
          capture: 'c2',
          pile: id,
          file: `pile-${id}-3d.jpg`,
        },
      ]),
    ],
    markers3d: {},
    fingerprint: 'f1',
  };
}

function input(piles: VolumetricPileInput[], over: Partial<VolumetricInput> = {}): VolumetricInput {
  return {
    captures: [
      { id: 'c1', label: 'Survey 1', date: '2026-09-03' },
      { id: 'c2', label: 'Survey 2', date: '2026-10-01' },
    ],
    piles,
    project: { name: 'Demo yard', customer: null, site: 'The demo yard', crs: 'EPSG:32632' },
    method: { cellM: 0.25, gsdCm: 3, siteDensityTPerM3: null },
    frame: null,
    ...over,
  };
}

function card(
  model: VolumetricModel,
  id: string,
  views: ReportViews,
  note: string | null = null,
): Element {
  const p = model.piles.find((x) => x.id === id);
  if (!p) throw new Error('no such pile');
  const html = renderToStaticMarkup(<PileCard model={model} pile={p} note={note} views={views} />);
  const el = new DOMParser()
    .parseFromString(`<body>${html}</body>`, 'text/html')
    .querySelector('.vr-pile');
  if (!el) throw new Error('no card');
  return el;
}

const text = (el: ParentNode, sel: string) => el.querySelector(sel)?.textContent ?? '';
const stat = (el: ParentNode, id: string) => text(el, `[data-stat="${id}"] dd`);

describe('a pile card, measured', () => {
  const model = volumetricModel(input([pile(1, [1200, 1000]), pile(2, [300, 400])]));
  const views = reportViews(frame(['m1', 'm2']), url);
  const el = card(model, 'm1', views);

  it('heads the card with the number, the name, the change badge, its date and the volume', () => {
    expect(text(el, '.vr-pile-head .vr-num')).toBe('1');
    expect(text(el, '.vr-pile-name')).toBe('Heap 1');
    expect(text(el, '.vr-pile-volume')).toBe('1,000 m³');
    const chip = el.querySelector('.vr-chip');
    expect(chip?.classList.contains('is-down')).toBe(true);
    expect(chip?.textContent).toContain('−200 m³');
    expect(chip?.textContent).toContain('−16.7 %');
    expect(text(el, '.vr-pile-since')).toBe(t('vreport.card.since', { date: '3 Sep 2026' }));
    expect(text(el, '.vr-pile-tonnes')).toBe('1,600 t');
    expect(el.querySelector('.vr-pile-flag')).toBeNull();
  });

  it('shows three pictures with their captions: the photo, the 3D view on the latest date, before', () => {
    const pics = [...el.querySelectorAll('.vr-pile-pic')];
    expect(pics.map((p) => p.getAttribute('data-pic'))).toEqual(['photo', '3d', 'before']);
    expect(pics.map((p) => p.querySelector('img')?.getAttribute('src'))).toEqual([
      url('pile-m1-photo-2.jpg'),
      url('pile-m1-3d.jpg'),
      url('pile-m1-photo-1.jpg'),
    ]);
    expect(pics.map((p) => p.querySelector('figcaption')?.textContent)).toEqual([
      t('vreport.card.photo', { date: '1 Oct 2026' }),
      t('vreport.card.3d', { date: '1 Oct 2026' }),
      t('vreport.card.before', { date: '3 Sep 2026' }),
    ]);
    expect(el.querySelector('.vr-pile-pic.is-empty')).toBeNull();
  });

  it('draws the outline and the A to B line over the photo from its extent, the outline alone before', () => {
    const [photo, view3d, before] = [...el.querySelectorAll('.vr-pile-pic')];
    const over = photo?.querySelector('svg.vr-pile-over');
    // the extent is 80 m by 60 m; the outline's first corner (85, 385) is 25 m in and 45 m down
    expect(over?.getAttribute('viewBox')).toBe('0 0 80.00 60.00');
    expect(over?.querySelector('.vr-pile-ring')?.getAttribute('points')).toMatch(/^25\.00,45\.00 /);
    const axis = over?.querySelector('.vr-pile-axis');
    expect([axis?.getAttribute('x1'), axis?.getAttribute('x2')]).toEqual(['20.00', '60.00']);
    expect(
      [...(over?.querySelectorAll('.vr-pile-end text') ?? [])].map((e) => e.textContent),
    ).toEqual(['A', 'B']);
    expect(view3d?.querySelector('svg')).toBeNull();
    expect(before?.querySelector('.vr-pile-ring')).not.toBeNull();
    expect(before?.querySelector('.vr-pile-axis')).toBeNull();
  });

  it("prints the profile with the app's own chart: three series, shaded against the base", () => {
    const svg = el.querySelector('.vr-pile-profile svg.pc-svg');
    expect(svg).not.toBeNull();
    const kinds = new Set(
      [...(svg?.querySelectorAll('polyline[data-series]') ?? [])].map((l) =>
        l.getAttribute('data-kind'),
      ),
    );
    expect([...kinds].sort()).toEqual(['base', 'current', 'earlier']);
    expect(svg?.querySelector('.pc-fill')).not.toBeNull();
    expect(el.querySelector('.pc[data-static]')).not.toBeNull();
    expect(text(el, '.vr-pile-profile-title')).toBe(t('vreport.card.profile'));
    expect([...el.querySelectorAll('.vr-pile-key-item')].map((k) => k.textContent)).toEqual([
      t('vreport.card.profile.surface', { date: '1 Oct 2026' }),
      t('vreport.card.profile.surface', { date: '3 Sep 2026' }),
      t('vreport.card.profile.base'),
    ]);
    // the chart is as wide as the card and its height is the card's budget
    expect(svg?.getAttribute('width')).toBe('688');
    expect(Number(svg?.getAttribute('height'))).toBe(
      chartHeightPx({ nameChars: 6, flags: 0, valueChars: 12, noteChars: 0 }),
    );
  });

  it('gives the six figures', () => {
    expect([...el.querySelectorAll('.vr-pile-stat dt')].map((d) => d.textContent)).toEqual([
      t('vreport.card.footprint'),
      t('vreport.card.base'),
      t('vreport.card.baseLevel'),
      t('vreport.card.peak'),
      t('vreport.card.density'),
      t('vreport.card.surveyed'),
    ]);
    expect(stat(el, 'footprint')).toBe('900 m²');
    expect(stat(el, 'base')).toBe('Lowest point');
    expect(stat(el, 'base-level')).toBe('100.00 m');
    expect(stat(el, 'peak')).toBe('8.4 m');
    expect(stat(el, 'density')).toBe('1.60 t/m³');
    expect(stat(el, 'surveyed')).toBe('1 Oct 2026');
  });

  it('gives a sloping base as a range and a boundary level as not set', () => {
    const sloped = volumetricModel(
      input([pile(1, [1200, 1000], { profile: profile({ baseLevel: [56, 58.04] }) })]),
    );
    expect(stat(card(sloped, 'm1', views), 'base-level')).toBe('56.0 to 58.0 m');
    const boundary = volumetricModel(
      input([pile(1, [1200, 1000], { profile: profile({ baseKind: 'boundary' }) })]),
    );
    const b = card(boundary, 'm1', views);
    expect(stat(b, 'base-level')).toBe(t('vreport.pile.baseNotSet'));
    expect(text(b, '.vr-pile-key-item.is-base')).toBe(t('vreport.card.profile.boundary'));
  });
});

describe('a pile card, the other states', () => {
  const piles = [pile(1, [1200, 1000]), pile(2, [93.1, -3.9]), pile(3, [null, null], { base: '' })];
  const model = volumetricModel(input(piles));
  const all = reportViews(frame(['m1', 'm2', 'm3']), url);

  it('prints "Not computed" for a pile without a volume, with its pictures and profile', () => {
    const el = card(model, 'm3', all);
    expect(el.classList.contains('is-uncomputed')).toBe(true);
    expect(text(el, '.vr-pile-volume')).toBe(t('vreport.notComputed'));
    expect(el.querySelector('.vr-chip')).toBeNull();
    expect(el.querySelectorAll('.vr-pile-pic img')).toHaveLength(3);
    expect(el.querySelector('svg.pc-svg')).not.toBeNull();
    expect(stat(el, 'footprint')).toBe('900 m²');
    expect(stat(el, 'base')).toBe(t('vreport.pile.baseNotSet'));
    expect(stat(el, 'peak')).toBe(t('vreport.notComputed'));
    expect(stat(el, 'density')).toBe(t('vreport.table.noTonnes'));
  });

  it('never prints a base level or a "Base" line for a pile whose base is not set', () => {
    // the profile stands such a pile on the default surface under its boundary (baseKind 'own')
    const el = card(model, 'm3', all);
    expect(stat(el, 'base')).toBe(t('vreport.pile.baseNotSet'));
    expect(stat(el, 'base-level')).toBe(t('vreport.pile.baseNotSet'));
    expect(text(el, '.vr-pile-key-item.is-base')).toBe(t('vreport.card.profile.boundary'));
    expect(el.querySelector('.vr-pile-key-item.is-base')?.getAttribute('data-base')).toBe(
      'boundary',
    );
  });

  it('prints a volume under zero as computed, with the note and a badge without a percentage', () => {
    const el = card(model, 'm2', all);
    expect(el.classList.contains('is-below-base')).toBe(true);
    expect(text(el, '.vr-pile-volume')).toBe('−3.9 m³');
    expect(text(el, '[data-flag="below-base"]')).toBe(t('vreport.pile.belowBase'));
    expect(text(el, '.vr-chip')).toBe('−97.0 m³');
    expect(el.querySelector('.vr-chip-pct')).toBeNull();
    // tonnes of a volume under zero mean nothing
    expect(el.querySelector('.vr-pile-tonnes')).toBeNull();
  });

  it('calls a pile new only when it held nothing before, never when it was under its base', () => {
    const m = volumetricModel(input([pile(1, [0, 25]), pile(2, [-40, 25])]));
    const v = reportViews(frame(['m1', 'm2']), url);
    expect(text(card(m, 'm1', v), '.vr-chip-pct')).toBe(t('vreport.change.new'));
    const was = card(m, 'm2', v);
    expect(text(was, '.vr-chip')).toBe('+65.0 m³');
    expect(was.querySelector('.vr-chip-pct')).toBeNull();
  });

  it('prints no tonnes for a pile at zero either', () => {
    const zero = volumetricModel(input([pile(1, [1200, 1000]), pile(2, [300, 0])]));
    const el = card(zero, 'm2', reportViews(frame(['m1', 'm2']), url));
    expect(text(el, '.vr-pile-volume')).toBe('0.0 m³');
    expect(el.querySelector('.vr-pile-tonnes')).toBeNull();
    expect(text(card(zero, 'm1', reportViews(frame(['m1', 'm2']), url)), '.vr-pile-tonnes')).toBe(
      '1,600 t',
    );
  });

  it('gives a pile past the cap the site photo for both photos and the "No 3D picture" line', () => {
    // the set is full: 170 piles of three pictures and the two site photos, the cap
    const others = Array.from({ length: 168 }, (_, k) => `x${String(k)}`);
    const taken = frame(['m1', 'm2', ...others]);
    expect(taken.views).toHaveLength(REPORT_VIEWS_MAX);
    const capped = reportViews(taken, url);
    const framed = volumetricModel(input(piles, { frame: taken }));
    const el = card(framed, 'm3', capped);
    expect(text(el, '[data-flag="no-3d"]')).toBe(t('vreport.card.no3d', { count: 170 }));
    const [photo, view3d, before] = [...el.querySelectorAll('.vr-pile-pic')];
    expect(photo?.querySelector('img.is-crop')?.getAttribute('src')).toBe(url('photo-c2.jpg'));
    expect(before?.querySelector('img.is-crop')?.getAttribute('src')).toBe(url('photo-c1.jpg'));
    // the outline is still drawn, over the ground the crop covers
    expect(photo?.querySelector('.vr-pile-ring')).not.toBeNull();
    expect(view3d?.classList.contains('is-empty')).toBe(true);
    // a pictured pile says nothing of the kind
    expect(card(model, 'm1', capped).querySelector('[data-flag="no-3d"]')).toBeNull();
  });

  it('never blames the cap for a pile that is missing from a set with room left', () => {
    // its pictures failed, or it was drawn after the pictures were taken
    const taken = frame(['m1', 'm2']);
    const el = card(volumetricModel(input(piles, { frame: taken })), 'm3', reportViews(taken, url));
    expect(el.querySelector('[data-flag="no-3d"]')).toBeNull();
    const [photo, view3d] = [...el.querySelectorAll('.vr-pile-pic')];
    expect(photo?.querySelector('img.is-crop')?.getAttribute('src')).toBe(url('photo-c2.jpg'));
    expect(view3d?.classList.contains('is-empty')).toBe(true);
  });

  it('leaves quiet placeholders of the same size without pictures or a profile', () => {
    const bare = volumetricModel(input([pile(1, [1200, 1000], { profile: null })]));
    const el = card(bare, 'm1', NO_VIEWS);
    const empty = [...el.querySelectorAll('.vr-pile-pic.is-empty')];
    expect(empty).toHaveLength(3);
    expect(empty.every((p) => p.textContent.includes(t('vreport.pictures.placeholder')))).toBe(
      true,
    );
    expect(el.querySelector('[data-flag="no-3d"]')).toBeNull();
    expect(el.querySelector('svg.pc-svg')).toBeNull();
    const none = el.querySelector<HTMLElement>('.vr-pile-profile-none');
    expect(none?.textContent).toBe(t('vreport.card.profile.none'));
    expect(none?.style.height).toBe(
      `${String(chartHeightPx({ nameChars: 6, flags: 0, valueChars: 12, noteChars: 0 }))}px`,
    );
  });

  it('leaves the before picture, the badge and the earlier line out with one date', () => {
    const one = volumetricModel(
      input([pile(1, [1200, 1000])], {
        captures: [{ id: 'c2', label: 'Survey 2', date: '2026-10-01' }],
      }),
    );
    const el = card(one, 'm1', all);
    expect(el.querySelectorAll('.vr-pile-pic')).toHaveLength(2);
    expect(el.querySelector('.vr-chip')).toBeNull();
  });

  it('prints a 280 character note and a long name whole, and takes their room off the chart', () => {
    const note = 'Material moved to the north bay. '.repeat(9).slice(0, 280);
    const long = volumetricModel(
      input([pile(1, [1200, 1000], { label: 'North bay crushed aggregate, zero to thirty two' })]),
    );
    const el = card(long, 'm1', all, note);
    expect(text(el, '.vr-pile-note')).toBe(note);
    expect(text(el, '.vr-pile-name')).toBe('North bay crushed aggregate, zero to thirty two');
    const plain = chartHeightPx({ nameChars: 6, flags: 0, valueChars: 12, noteChars: 0 });
    const tight = Number(el.querySelector('svg.pc-svg')?.getAttribute('height'));
    expect(tight).toBeLessThan(plain);
    expect(tight).toBe(chartHeightPx({ nameChars: 47, flags: 0, valueChars: 12, noteChars: 280 }));
  });
});

describe('the card budget', () => {
  it('keeps two cards on a page: the chart gives up what the extra lines take, within limits', () => {
    const px = (mm: number) => Math.round(mm / (25.4 / 96));
    const plain = chartHeightPx({ nameChars: 10, flags: 0, valueChars: 10, noteChars: 0 });
    // 118 mm less the fixed parts (83 mm)
    expect(CARD_H).toBe(118);
    expect(plain).toBe(px(118 - 83));
    expect(chartHeightPx({ nameChars: 10, flags: 1, valueChars: 10, noteChars: 0 })).toBe(
      px(118 - 83 - 4.2),
    );
    // never lower than 25 mm, however much there is to print
    expect(chartHeightPx({ nameChars: 200, flags: 2, valueChars: 80, noteChars: 280 })).toBe(
      px(25),
    );
  });
});

describe('the stylesheet of the pile pages', () => {
  const css = readFileSync(resolve(__dirname, 'piles.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    if (at < 0) throw new Error(`no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };

  it('never clips or clamps a text box', () => {
    for (const selector of [
      '.vr-page .vr-pile-note',
      '.vr-page-piles .vr-pile-name',
      '.vr-pile-stat dd',
      '.vr-pile-pic figcaption',
      '.vr-page .vr-pile-flag',
      '.vr-share-key',
    ]) {
      const body = rule(selector);
      expect(body, selector).not.toMatch(/overflow:\s*hidden|text-overflow|line-clamp|max-height/);
      expect(body, selector).not.toMatch(/white-space:\s*nowrap/);
      expect(body, selector).not.toMatch(/\n {2}height:/);
    }
    expect(css).not.toMatch(/text-overflow|line-clamp/);
  });
});

describe('the picture captions', () => {
  it('keeps every picture caption to one line', () => {
    const date = '30 Sep 2026'; // the longest date the cards print
    for (const key of ['vreport.card.photo', 'vreport.card.3d', 'vreport.card.before'] as const)
      expect(t(key, { date }).length, key).toBeLessThanOrEqual(CAPTION_LINE);
  });
});
