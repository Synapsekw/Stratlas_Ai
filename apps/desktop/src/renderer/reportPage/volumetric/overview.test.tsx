// @vitest-environment jsdom
// The site overview of the volumetric report on a synthetic two-date yard with fictional pile
// names: the stock and its change, the share bar with its key, the site photo, the elevation map
// and the 3D site view with a badge per pile, and badges that would collide spread apart.
import {
  volumetricModel,
  type VolumetricInput,
  type VolumetricPileInput,
} from '@aio/project/export';
import type { ReportViewsFrame } from '@aio/schema';
import { t } from '@aio/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_VIEWS, reportViews, type ReportViews } from '../types/template';
import { Overview } from './overview';

const square = (e: number, n: number, h: number): [number, number][] => [
  [e - h, n - h],
  [e + h, n - h],
  [e + h, n + h],
  [e - h, n + h],
];

/** Heap 1 to Heap {count}, 200 m apart along the yard; Heap 1 the largest. */
function piles(count: number, at: (k: number) => [number, number]): VolumetricPileInput[] {
  return Array.from({ length: count }, (_, i) => {
    const k = i + 1;
    const latest = 1000 * (count + 1 - k);
    const [e, n] = at(k);
    const date = (capture: string, volumeM3: number) => ({
      capture,
      volumeM3,
      densityTPerM3: null,
      areaM2: 400,
      peakM: 5,
      plusMinusM3: null,
      outline: square(e, n, 10),
    });
    return {
      id: `m${String(k)}`,
      label: `Heap ${String(k)}`,
      material: null,
      base: 'Lowest point',
      dates: [date('c1', latest + 100), date('c2', latest)],
    };
  });
}

function frame(over: Partial<ReportViewsFrame> = {}): ReportViewsFrame {
  return {
    schema: 'aio.report-views/1',
    extent: [0, 0, 1200, 800],
    widthPx: 2400,
    heightPx: 1600,
    mPerPx: 0.5,
    views: [
      { name: 'photo-c2', kind: 'photo', capture: 'c2', file: 'photo-c2.jpg' },
      { name: 'elevation-c2', kind: 'elevation', capture: 'c2', file: 'elevation-c2.jpg' },
      { name: '3d-c2', kind: '3d', capture: 'c2', file: '3d-c2.jpg' },
    ],
    // the 3D picture is 2400 by 1600: every pile along its middle
    markers3d: {
      c2: Object.fromEntries(
        Array.from({ length: 4 }, (_, i) => [`m${String(i + 1)}`, [400 + 500 * i, 800]]),
      ),
    },
    fingerprint: 'f1',
    ...over,
  };
}

function input(
  f: ReportViewsFrame | null,
  at: (k: number) => [number, number] = (k) => [200 * k, 400],
): VolumetricInput {
  return {
    captures: [
      { id: 'c1', label: 'Survey 1', date: '2026-09-03' },
      { id: 'c2', label: 'Survey 2', date: '2026-10-01' },
    ],
    piles: piles(4, at),
    project: { name: 'Demo yard', customer: null, site: 'The demo yard', crs: 'EPSG:32632' },
    method: { cellM: 0.25, gsdCm: 3, siteDensityTPerM3: null },
    frame: f,
  };
}

const url = (f: string) => `aio://project/report/views/volumetric/${f}`;

function render(i: VolumetricInput, views: ReportViews): Document {
  const html = renderToStaticMarkup(<Overview model={volumetricModel(i)} views={views} />);
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

const text = (el: ParentNode | null | undefined, sel: string) =>
  el?.querySelector(sel)?.textContent ?? '';

describe('the site overview', () => {
  const f = frame();
  const d = render(input(f), reportViews(f, url));

  it('heads the page with the site, the survey date, the stock and its change', () => {
    expect(text(d, '.vr-ov-head h1')).toBe(t('vreport.overview.title'));
    expect(text(d, '.vr-ov-site')).toContain('The demo yard');
    expect(text(d, '.vr-ov-site')).toContain('Surveyed 1 October 2026');
    expect(text(d, '.vr-ov-total')).toBe('10,000 m³');
    expect(d.querySelector('.vr-ov-change.is-down')?.textContent).toContain('−400 m³');
  });

  it('splits the share bar by pile and names every segment in the key under it', () => {
    const segs = [...d.querySelectorAll<HTMLElement>('.vr-share-seg')];
    expect(segs).toHaveLength(4);
    const widths = segs.map((s) => Number.parseFloat(s.style.width));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2);
    expect(widths[0]).toBeCloseTo(40, 2);
    const key = [...d.querySelectorAll('.vr-share-key li')].map((li) => li.textContent);
    expect(key).toEqual(['Heap 140.0 %', 'Heap 230.0 %', 'Heap 320.0 %', 'Heap 410.0 %']);
  });

  it('shows the site photo, the elevation map and the 3D view, each with its caption', () => {
    const figs = [...d.querySelectorAll('.vr-ov-fig')];
    expect(figs.map((g) => g.getAttribute('data-view'))).toEqual(['photo', 'elevation', '3d']);
    expect(figs.map((g) => g.querySelector('img')?.getAttribute('src'))).toEqual([
      url('photo-c2.jpg'),
      url('elevation-c2.jpg'),
      url('3d-c2.jpg'),
    ]);
    expect(figs.map((g) => g.querySelector('figcaption')?.textContent)).toEqual([
      t('vreport.overview.photo', { date: '1 October 2026' }),
      t('vreport.overview.elevation', { date: '1 October 2026' }),
      t('vreport.overview.3d', { date: '1 October 2026' }),
    ]);
  });

  it('puts a badge per pile on each of the three pictures', () => {
    for (const fig of d.querySelectorAll('.vr-ov-fig')) {
      const tags = [...fig.querySelectorAll('.vr-marker')].map((m) => m.textContent);
      expect(tags, fig.getAttribute('data-view') ?? '').toEqual(['1', '2', '3', '4']);
    }
    // far apart: no badge was moved, so no leader is drawn
    expect(d.querySelector('.vr-leaders')).toBeNull();
    // the 3D badges stand where the camera saw the piles: 400 of 2400 px across, half way down
    const first = d.querySelector<HTMLElement>('[data-view="3d"] .vr-marker');
    expect(first?.style.left).toBe('16.67%');
    expect(first?.style.top).toBe('50%');
  });

  it('spreads badges that would collide, with a leader back to each true place', () => {
    // Heap 1 and Heap 2 one metre apart: their badges would sit on top of each other
    const close = render(
      input(f, (k) => (k <= 2 ? [300 + k, 400] : [200 * k, 400])),
      reportViews(f, url),
    );
    const photo = close.querySelector('[data-view="photo"]');
    const moved = [...(photo?.querySelectorAll<HTMLElement>('.vr-marker.is-moved') ?? [])];
    expect(moved.map((m) => m.textContent)).toEqual(['1', '2']);
    expect(moved[0]?.style.left).not.toBe(moved[1]?.style.left);
    expect(photo?.querySelectorAll('.vr-leaders .vr-leader')).toHaveLength(2);
    expect(photo?.querySelectorAll('.vr-leaders .vr-leader-dot')).toHaveLength(2);
    expect(photo?.querySelectorAll('.vr-marker')).toHaveLength(4);
  });

  it('keeps the badges off the north chip and the scale bar', () => {
    // Heap 4 under the north chip (top right), Heap 3 on the scale bar (bottom left)
    const d2 = render(
      input(f, (k) => (k === 4 ? [1170, 780] : k === 3 ? [40, 20] : [200 * k, 400])),
      reportViews(f, url),
    );
    const photo = d2.querySelector('[data-view="photo"]');
    const moved = [...(photo?.querySelectorAll('.vr-marker.is-moved') ?? [])].map(
      (m) => m.textContent,
    );
    expect(moved.sort()).toEqual(['3', '4']);
    expect(photo?.querySelectorAll('.vr-leaders .vr-leader')).toHaveLength(2);
  });

  it('sets a yard taller than wide side by side with the 3D view under it', () => {
    const tall = frame({ extent: [0, 0, 800, 1200], widthPx: 1600, heightPx: 2400 });
    const dt = render(input(tall), reportViews(tall, url));
    expect(dt.querySelector('.vr-ov.is-tall .vr-ov-pair [data-view="elevation"]')).not.toBeNull();
    expect(dt.querySelector('.vr-ov-pair [data-view="3d"]')).toBeNull();
    expect(d.querySelector('.vr-ov.is-wide .vr-ov-pair [data-view="3d"]')).not.toBeNull();
  });

  it('leaves three placeholders of the same size without pictures', () => {
    const none = render(input(null), NO_VIEWS);
    const empty = [...none.querySelectorAll<HTMLElement>('.vr-picture.is-empty')];
    expect(empty).toHaveLength(3);
    expect(empty.every((e) => e.textContent === t('vreport.pictures.placeholder'))).toBe(true);
    expect(empty.every((e) => e.style.width !== '' && e.style.height !== '')).toBe(true);
  });
});
