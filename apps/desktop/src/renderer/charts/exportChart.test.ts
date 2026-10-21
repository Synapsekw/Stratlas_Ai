// @vitest-environment jsdom
import type { SurveyUnits } from '@aio/schema';
import type { ChartSeries } from '@aio/survey';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartPng, sectionCsv, seriesCsv } from './exportChart';

const METRIC = {
  distance: 'm',
  area: 'm2',
  volume: 'm3',
  density: 't/m3',
  mass: 't',
  grade: 'percent',
} as SurveyUnits;
const FEET = { ...METRIC, distance: 'ft' } as unknown as SurveyUnits;
const PRECISION = {
  coordinate: 3,
  distance: 2,
  area: 2,
  volume: 2,
  grade: 1,
};

const CURRENT: ChartSeries = {
  key: 'cap-2',
  label: '05 Oct',
  kind: 'current',
  chainage: [0, 10, 20],
  z: [100, null, 102.5],
};
const DESIGN: ChartSeries = {
  key: 'd-1',
  label: 'Pad, final',
  kind: 'design',
  chainage: [0, 10, 20],
  z: [99, 99.5, 100],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../shell');
});

describe('seriesCsv', () => {
  it('has a unit in every header and nulls as empty cells', () => {
    const lines = seriesCsv([CURRENT, DESIGN], METRIC, PRECISION).trimEnd().split('\n');
    expect(lines[0]).toBe('Chainage (m),05 Oct (m),"Pad, final (m)"');
    expect(lines[1]).toBe('0.00,100.00,99.00');
    expect(lines[2]).toBe('10.00,,99.50');
    expect(lines[3]).toBe('20.00,102.50,100.00');
  });

  it('keeps a surface name that a spreadsheet would run as a formula as text', () => {
    const lines = seriesCsv([{ ...CURRENT, label: '=1+1' }], METRIC, PRECISION).split('\n');
    expect(lines[0]).toBe("Chainage (m),'=1+1 (m)");
    const section = sectionCsv(
      { chainage: [0], e: [-1], n: [-2] },
      [{ ...CURRENT, label: '@x' }],
      METRIC,
      PRECISION,
    ).split('\n');
    expect(section[0]).toContain(",'@x (m)");
    expect(section[1]?.startsWith("'")).toBe(false);
  });

  it('converts to feet', () => {
    const lines = seriesCsv([CURRENT], FEET, PRECISION).trimEnd().split('\n');
    expect(lines[0]).toBe('Chainage (ft),05 Oct (ft)');
    expect(lines[1]).toBe('0.00,328.08');
    expect(lines[3]).toBe('65.62,336.29');
  });

  it('joins series on chainage when their samples differ', () => {
    const other: ChartSeries = { ...DESIGN, chainage: [0, 15], z: [1, 2] };
    const rows = seriesCsv([CURRENT, other], METRIC, PRECISION).trimEnd().split('\n').slice(1);
    expect(rows).toEqual(['0.00,100.00,1.00', '10.00,,', '15.00,,2.00', '20.00,102.50,']);
  });
});

describe('sectionCsv', () => {
  const STATIONS = {
    chainage: [0, 10, 20],
    e: [551140.12345, 551150.5, 551160],
    n: [2331400, 2331400.25, 2331400.5],
  };

  it('keeps E and N of every station to 3 decimals, then the surfaces', () => {
    const lines = sectionCsv(STATIONS, [CURRENT, DESIGN], METRIC, PRECISION).trimEnd().split('\n');
    expect(lines[0]).toBe('Chainage (m),E (m),N (m),05 Oct (m),"Pad, final (m)"');
    expect(lines[1]).toBe('0.00,551140.123,2331400.000,100.00,99.00');
    expect(lines[2]).toBe('10.00,551150.500,2331400.250,,99.50');
  });

  it('writes E and N in the display length unit', () => {
    const lines = sectionCsv(STATIONS, [CURRENT], FEET, PRECISION).trimEnd().split('\n');
    expect(lines[0]).toBe('Chainage (ft),E (ft),N (ft),05 Oct (ft)');
    expect(lines[3]?.split(',')[1]).toBe((551160 / 0.3048).toFixed(3));
  });
});

/** Run chartPng on `inner` with `computed` as every element's computed style; answers the SVG text. */
async function draw(inner: string, computed: Record<string, string>) {
  document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">${inner}</svg>`;
  const svg = document.querySelector<SVGSVGElement>('svg');
  if (!svg) throw new Error('no svg');
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: (p: string) => computed[p] ?? '',
      }) as unknown as CSSStyleDeclaration,
  );
  let serialised = '';
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(v: string) {
      serialised = decodeURIComponent(v.slice(v.indexOf(',') + 1));
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', FakeImage);
  const ctx = { scale: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
    cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
  });
  const bytes = await chartPng(svg, 2);
  return { serialised, bytes, ctx };
}

describe('chartPng', () => {
  it('inlines var() colours before drawing', async () => {
    const { serialised, bytes, ctx } = await draw(
      '<g class="pc-grid"><line x1="0" x2="40" y1="5" y2="5" stroke="var(--chart-grid)"/></g>' +
        '<path d="M0 0L10 10" stroke="var(--chart-current)" fill="none"/>',
      { stroke: 'rgb(1, 2, 3)' },
    );
    expect(serialised).not.toContain('var(');
    expect(serialised).toContain('rgb(1, 2, 3)');
    expect(Array.from(bytes)).toEqual([137, 80, 78, 71]);
    expect(ctx.scale).toHaveBeenCalledWith(2, 2);
  });

  it('drops var() from an inline style and keeps its plain declarations', async () => {
    const { serialised } = await draw(
      '<rect width="5" height="5" style="fill: var(--x); stroke-linecap: round"/>',
      { stroke: 'rgb(4, 5, 6)' },
    );
    expect(serialised).not.toContain('var(');
    expect(serialised).toContain('stroke-linecap: round');
    expect(serialised).toContain('stroke:rgb(4, 5, 6)');
  });

  it('gives text a font stack that ends in a generic family', async () => {
    const mono = await draw('<text x="1" y="1">12</text>', { 'font-family': 'Plex Mono' });
    expect(mono.serialised).toContain('font-family:Plex Mono, ui-monospace, monospace');
    const sans = await draw('<text x="1" y="1">12</text>', { 'font-family': 'Inter' });
    expect(sans.serialised).toContain('font-family:Inter, sans-serif');
  });

  it('leaves the crosshair, readout and live region out but keeps pins', async () => {
    const { serialised } = await draw(
      '<g class="pc-pin" data-testid="section-chart-pin"></g>' +
        '<g class="pc-crosshair" data-testid="chart-crosshair"></g>' +
        '<g class="pc-readout"></g><g aria-live="polite"></g>',
      {},
    );
    expect(serialised).toContain('pc-pin');
    expect(serialised).not.toContain('crosshair');
    expect(serialised).not.toContain('pc-readout');
    expect(serialised).not.toContain('aria-live');
  });
});

describe('savePng', () => {
  it('saves through dialog:saveFile and answers the path', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: { path: 'C:/x/profile.png' } });
    vi.doMock('../shell', () => ({ bridge: { call } }));
    const mod = await import('./exportChart');
    const bytes = new Uint8Array([1, 2]);
    await expect(mod.savePng(bytes, 'profile.png')).resolves.toBe('C:/x/profile.png');
    expect(call).toHaveBeenCalledWith(
      'dialog:saveFile',
      expect.objectContaining({ defaultName: 'profile.png', data: bytes }),
    );
  });
});
