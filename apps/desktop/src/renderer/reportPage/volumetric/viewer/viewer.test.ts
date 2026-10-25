// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEWER_STRING_KEYS, type ViewerData, type ViewerStringKey } from './types';
import { bootViewer, fillSharedPictures, formatAmount } from './viewer';

const strings = Object.fromEntries(VIEWER_STRING_KEYS.map((k) => [k, k])) as Record<
  ViewerStringKey,
  string
>;
Object.assign(strings, {
  'vreport.viewer.select': 'Select {pile}',
  'vreport.viewer.sortBy': 'Sort by {column}',
  'vreport.viewer.list.volume': 'Volume',
  'vreport.viewer.list.change': 'Change',
  'vreport.viewer.view.photo': 'Photo',
  'vreport.viewer.view.cutFill': 'Cut & fill',
  'vreport.viewer.view.elevation': 'Elevation',
  'vreport.viewer.view.3d': '3D',
  'vreport.viewer.units.m3': 'm³',
  'vreport.viewer.units.t': 'Tonnes',
  'vreport.viewer.savePdf': 'Save as PDF',
  'vreport.viewer.csv': 'Download CSV',
  'vreport.viewer.map': 'Site picture, {view}, {date}',
  'vreport.kpi.change': 'Change since {date}',
  'vreport.piles.before': 'Before, {date}',
  'vreport.piles.after': 'After, {date}',
  'vreport.piles.less': '{volume} less',
  'vreport.piles.more': '{volume} more',
});

function data(): ViewerData {
  return {
    strings,
    lockupSvg: '<svg data-testid="lockup"></svg>',
    title: 'North yard · stockpile report',
    subtitle: '2 piles · surveys 1 and 2 September 2026',
    dates: [
      { id: 'c1', label: '1 September 2026' },
      { id: 'c2', label: '2 September 2026' },
    ],
    from: 'c1',
    to: 'c2',
    frame: { widthPx: 1000, heightPx: 500 },
    pictures: [
      { kind: 'photo', capture: 'c1', src: 'data:image/jpeg;base64,P1' },
      { kind: 'photo', capture: 'c2', src: 'data:image/jpeg;base64,P2' },
      { kind: 'elevation', capture: 'c2', src: 'data:image/jpeg;base64,E2' },
      { kind: 'cutfill', capture: 'c2', src: 'data:image/jpeg;base64,CF' },
      { kind: '3d', capture: 'c2', src: 'data:image/jpeg;base64,D2' },
    ],
    legend: [
      { colour: '#c33', label: 'Red: lower' },
      { colour: '#36c', label: 'Blue: higher' },
    ],
    csv: 'pile,m3\nA,1\n',
    csvName: 'stockpiles.csv',
    piles: [
      {
        id: 'a',
        number: 1,
        label: 'Sand',
        marker: [100, 50],
        crop: { x: 50, y: 0, size: 100 },
        areaM2: 400,
        peakM: 5.5,
        note: 'Wet',
        byDate: [
          { capture: 'c1', m3: 1000, t: 1600 },
          { capture: 'c2', m3: 2000, t: 3200 },
        ],
      },
      {
        id: 'b',
        number: 2,
        label: 'Gravel',
        marker: [500, 250],
        crop: { x: 450, y: 200, size: 100 },
        areaM2: 300,
        peakM: 4,
        note: null,
        byDate: [
          { capture: 'c1', m3: 3000, t: null },
          { capture: 'c2', m3: 1500, t: null },
        ],
      },
    ],
  };
}

function mount(d: ViewerData = data()) {
  document.body.innerHTML = `<div id="vr-app"></div><script type="application/json" id="vr-data">${JSON.stringify(d).replace(/</g, '\\u003c')}</script>`;
  const handle = bootViewer(document);
  if (!handle) throw new Error('did not boot');
  return handle;
}

const q = (sel: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const button = (name: string) => {
  const b = [...document.querySelectorAll('button')].find(
    (x) => (x.getAttribute('aria-label') ?? x.textContent.trim()) === name,
  );
  if (!b) throw new Error(`no button ${name}`);
  return b;
};
const mapImg = () => q('.vr-d-map img') as HTMLImageElement;

describe('volumetric interactive viewer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null without a data block', () => {
    document.body.innerHTML = '<div id="vr-app"></div>';
    expect(bootViewer(document)).toBeNull();
  });

  it('gives the printed pages their shared pictures from the data block', () => {
    const block = document.createElement('div');
    block.innerHTML =
      '<img data-vr-pic="photo:c1" alt=""><img data-vr-pic="cutfill:c2" alt=""><img data-vr-pic="3d:c1" alt="">';
    document.body.append(block);
    fillSharedPictures(document, data());
    const imgs = [...block.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      'data:image/jpeg;base64,P1',
      'data:image/jpeg;base64,CF',
      null,
    ]);
  });

  it('boots from the data block with the band, the latest date and the photo', () => {
    mount();
    expect(q('.vr-d-band h1').textContent).toBe('North yard · stockpile report');
    expect(q('[data-testid="lockup"]')).toBeTruthy();
    expect(mapImg().getAttribute('src')).toBe('data:image/jpeg;base64,P2');
    expect(button('2 September 2026').getAttribute('aria-pressed')).toBe('true');
    expect(button('Photo').getAttribute('aria-pressed')).toBe('true');
    expect(mapImg().alt).toBe('Site picture, Photo, 2 September 2026');
  });

  it('date, view and unit toggles swap the picture and the figures', () => {
    mount();
    // Site total on the latest date: 2000 + 1500.
    expect(q('.vr-d-kpi-total .vr-d-kpi-value').textContent).toBe('3,500 m³');
    expect(q('.vr-d-kpi-change .vr-d-kpi-value').textContent).toBe('500 m³ less');
    button('1 September 2026').click();
    expect(mapImg().getAttribute('src')).toBe('data:image/jpeg;base64,P1');
    expect(button('1 September 2026').getAttribute('aria-pressed')).toBe('true');
    expect(button('2 September 2026').getAttribute('aria-pressed')).toBe('false');
    expect(q('.vr-d-kpi-total .vr-d-kpi-value').textContent).toBe('4,000 m³');
    button('2 September 2026').click();
    button('Elevation').click();
    expect(mapImg().getAttribute('src')).toBe('data:image/jpeg;base64,E2');
    button('Cut & fill').click();
    expect(mapImg().getAttribute('src')).toBe('data:image/jpeg;base64,CF');
    expect(q('.vr-d-legend').hidden).toBe(false);
    button('3D').click();
    expect(mapImg().getAttribute('src')).toBe('data:image/jpeg;base64,D2');
    expect(q('.vr-d-legend').hidden).toBe(true);
    expect(q('.vr-d-markers').hidden).toBe(true);
    button('Tonnes').click();
    // Only pile a has tonnes.
    expect(q('.vr-d-kpi-total .vr-d-kpi-value').textContent).toBe('3,200 t');
  });

  it('shows the placeholder when a date has no picture of the view', () => {
    mount();
    button('1 September 2026').click();
    button('Elevation').click();
    expect(document.querySelector('.vr-d-map img')).toBeNull();
    expect(q('.vr-d-map-empty').textContent).toBe('vreport.pictures.placeholder');
  });

  it('places the markers as named buttons and selecting one fills the card', () => {
    mount();
    const marker = button('Select Gravel');
    expect(marker.closest('.vr-d-markers')).toBeTruthy();
    expect(marker.style.left).toBe('50%');
    expect(marker.style.top).toBe('50%');
    marker.click();
    expect(marker.getAttribute('aria-pressed')).toBe('true');
    expect(q('.vr-d-card h2').textContent).toContain('Gravel');
    expect(q('.vr-d-card .vr-d-chip').textContent).toBe('1,500 m³ less');
    const crops = document.querySelectorAll<HTMLElement>('.vr-d-crop-img');
    expect(crops).toHaveLength(2);
    const [before, after] = [...crops];
    expect(before?.style.backgroundImage).toContain('P1');
    expect(after?.style.backgroundImage).toContain('P2');
    // 1000 x 500 frame, 100 px box at (450, 200): size 1000 % x 500 %, position 450/900, 200/400.
    expect(after?.style.backgroundSize).toBe('1000% 500%');
    expect(after?.style.backgroundPosition).toBe('50% 50%');
    expect(q('.vr-d-card').textContent).toContain('Before, 1 September 2026');
    expect(q('.vr-d-card').textContent).toContain('After, 2 September 2026');
  });

  it('a list row selects the pile, and the list sorts by volume and change', () => {
    mount();
    const rows = () =>
      [...document.querySelectorAll<HTMLButtonElement>('.vr-d-list-row')].map(
        (r) => r.dataset.pile,
      );
    expect(rows()).toEqual(['a', 'b']);
    const sand = q('.vr-d-list-row[data-pile="a"]');
    sand.click();
    expect(sand.getAttribute('aria-pressed')).toBe('true');
    expect(q('.vr-d-card h2').textContent).toContain('Sand');
    expect(q('.vr-d-card').textContent).toContain('Wet');
    button('Sort by Change').click();
    // Largest drawdown first: b (-1500), then a (+1000).
    expect(rows()).toEqual(['b', 'a']);
    expect(button('Sort by Change').getAttribute('aria-pressed')).toBe('true');
    button('Sort by Volume').click();
    expect(rows()).toEqual(['a', 'b']);
  });

  it('Download CSV clicks an a[download] with a Blob of the embedded CSV', async () => {
    mount();
    let blob: Blob | null = null;
    const create = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:x';
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    button('Download CSV').click();
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('stockpiles.csv');
    expect(clicked[0]?.href).toBe('blob:x');
    expect(blob).not.toBeNull();
    expect(await (blob as unknown as Blob).text()).toBe('pile,m3\nA,1\n');
  });

  it('Save as PDF calls window.print', () => {
    mount();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    window.print = print;
    button('Save as PDF').click();
    expect(print).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('every control is a real button and toggles carry aria-pressed', () => {
    mount();
    for (const el of document.querySelectorAll('.vr-d-seg button')) {
      expect(el.tagName).toBe('BUTTON');
      expect(el.getAttribute('type')).toBe('button');
      expect(['true', 'false']).toContain(el.getAttribute('aria-pressed'));
    }
    expect(document.querySelectorAll('.vr-d-markers button')).toHaveLength(2);
  });

  it('keeps focus on a toggle across a re-render', () => {
    mount();
    const b = button('Elevation');
    b.focus();
    b.click();
    expect(document.activeElement).toBe(b);
  });
});

describe('formatAmount', () => {
  it('groups thousands, one decimal under 100, no sign', () => {
    expect(formatAmount(12345.6, 'm3')).toBe('12,346 m³');
    expect(formatAmount(-42.25, 't')).toBe('42.3 t');
  });
});
