// @vitest-environment jsdom
import type { GlobeSite } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteOutputs } from './SiteOutputs';
import { clearPyramids, useSiteOutputs } from './siteOutputsStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const index = (legend?: unknown) => ({
  schema: 'aio.tiles/1',
  corners: { tl: [0, 0, 0], tr: [10, 0, 0], bl: [0, 0, 10] },
  levels: [{ z: 0, tileSize: 256, cols: 1, rows: 1, pattern: '{z}/{x}/{y}.png' }],
  ...(legend === undefined ? {} : { legend }),
});
const SCORE_FROM_INDEX = {
  kind: 'score',
  unit: '',
  label: 'Change score of the run',
  stops: [
    [0.2, '#ffff00'],
    [1, '#ff0000'],
  ],
};

/** What each `tiles.json` answers: an index, or nothing (missing). */
let files: Record<string, unknown> = {};

const SITE: GlobeSite = {
  projectId: 'p1',
  name: 'Two surveys',
  lonLat: [10, 50],
  captures: [
    { id: 'c1', label: 'First', date: '2026-10-07' },
    { id: 'c2', label: 'Second', date: '2026-10-21' },
  ],
  issues: { open: 0, bySeverity: {} },
  tilesets: [],
  frame: { crs: { epsg: 32640 }, origin: [500000, 2700000, 0] },
  rasters: [
    // listed out of order on purpose: the section orders them
    { layerId: 'heat', name: 'Imagery change', role: 'plan', src: 'heat/tiles.json', change: true },
    { layerId: 'dsm2', name: 'DSM', role: 'dsm', src: 'dsm2/tiles.json', capture: 'c2' },
    { layerId: 'o2', name: 'Ortho late', role: 'ortho', src: 'o2/tiles.json', capture: 'c2' },
    { layerId: 'o1', name: 'Ortho early', role: 'ortho', src: 'o1/tiles.json', capture: 'c1' },
  ],
};

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  useSiteOutputs.setState({ shown: {} });
  clearPyramids();
  files = {
    'aio://project/p1/o1/tiles.json': index(),
    'aio://project/p1/o2/tiles.json': index(),
    'aio://project/p1/dsm2/tiles.json': index(),
    'aio://project/p1/heat/tiles.json': index(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url in files
          ? { ok: true, json: () => Promise.resolve(files[url]) }
          : { ok: false, json: () => Promise.resolve(null) },
      ),
    ),
  );
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(site: GlobeSite) {
  root = createRoot(host);
  await act(async () => {
    root?.render(<SiteOutputs site={site} />);
    await new Promise((done) => setTimeout(done, 0));
  });
}
const switches = () => [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
const nameOf = (el: Element) => {
  const ids = el.getAttribute('aria-labelledby')?.split(' ') ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
};
const byName = (name: string) => switches().find((s) => nameOf(s) === name);
const legend = () => host.querySelector<HTMLElement>('[data-testid="globe-legend"]');

describe('the On the Globe section of a site card', () => {
  it('is not there for a site without a frame or without rasters', async () => {
    const noFrame: GlobeSite = { ...SITE };
    delete noFrame.frame;
    await mount(noFrame);
    expect(host.innerHTML).toBe('');
    act(() => root?.unmount());
    const noRasters: GlobeSite = { ...SITE };
    delete noRasters.rasters;
    root = createRoot(host);
    await act(async () => {
      root?.render(<SiteOutputs site={noRasters} />);
      await Promise.resolve();
    });
    expect(host.innerHTML).toBe('');
  });

  it('lists the orthos by capture date, then the DSMs, then the heat maps, as switches', async () => {
    await mount(SITE);
    expect(host.querySelector('h3')?.textContent).toBe('On the Globe');
    expect(switches().map(nameOf)).toEqual([
      'Orthophoto 2026-10-07',
      'Orthophoto 2026-10-21',
      'Shaded surface 2026-10-21',
      'Imagery change',
    ]);
    // the latest ortho is on, nothing else
    expect(switches().map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(legend()).toBeNull();
  });

  it('says "Orthophoto" for an ortho without a known capture date', async () => {
    await mount({
      ...SITE,
      rasters: [{ layerId: 'o', name: 'Ortho', role: 'ortho', src: 'o1/tiles.json' }],
    });
    expect(switches().map(nameOf)).toEqual(['Orthophoto']);
  });

  it('tells repeating labels apart by the layer name, and leaves unique ones as they are', async () => {
    await mount({
      ...SITE,
      rasters: [
        { layerId: 'a', name: 'North block', role: 'ortho', src: 'o1/tiles.json', capture: 'c2' },
        { layerId: 'b', name: 'South block', role: 'ortho', src: 'o2/tiles.json', capture: 'c2' },
        { layerId: 'e', name: 'Ortho early', role: 'ortho', src: 'dsm2/tiles.json', capture: 'c1' },
      ],
    });
    expect(switches().map(nameOf)).toEqual([
      'Orthophoto 2026-10-07',
      'Orthophoto 2026-10-21 (North block)',
      'Orthophoto 2026-10-21 (South block)',
    ]);
  });

  it('turns a heat map on with a click and shows the legend of its index', async () => {
    files['aio://project/p1/heat/tiles.json'] = index(SCORE_FROM_INDEX);
    await mount(SITE);
    const heat = byName('Imagery change');
    act(() => heat?.click());
    expect(heat?.getAttribute('aria-checked')).toBe('true');
    expect(useSiteOutputs.getState().shown.p1).toEqual(['o2', 'heat']);
    expect(legend()?.textContent).toContain('Change score of the run');
    expect(legend()?.querySelector('.bar')?.getAttribute('style')).toContain('rgb(255, 255, 0)');
    expect(
      [...(legend()?.querySelectorAll('.ticks span') ?? [])].map((s) => s.textContent),
    ).toEqual(['20%', '100%']);
    act(() => heat?.click());
    expect(legend()).toBeNull();
  });

  it('falls back to the height legend for a surface heat map without one', async () => {
    await mount({
      ...SITE,
      rasters: [
        {
          layerId: 'heat',
          name: 'Surface change',
          role: 'plan',
          src: 'heat/tiles.json',
          change: true,
        },
      ],
    });
    expect(switches().map(nameOf)).toEqual(['Surface change']);
    act(() => byName('Surface change')?.click());
    expect(legend()?.textContent).toContain('Height change');
    expect(
      [...(legend()?.querySelectorAll('.ticks span') ?? [])].map((s) => s.textContent),
    ).toEqual(['-2 m', '0 m', '+2 m']);
  });

  it('names a heat map by the kind of its legend', async () => {
    files['aio://project/p1/heat/tiles.json'] = index({
      kind: 'metres',
      stops: [
        [-1, '#0000ff'],
        [1, '#ff0000'],
      ],
    });
    await mount({
      ...SITE,
      rasters: [
        { layerId: 'heat', name: 'Change', role: 'plan', src: 'heat/tiles.json', change: true },
      ],
    });
    expect(switches().map(nameOf)).toEqual(['Surface change']);
  });

  it('falls back to the score legend for an imagery heat map without one', async () => {
    await mount(SITE);
    act(() => byName('Imagery change')?.click());
    expect(legend()?.textContent).toContain('Change score');
  });

  it('disables the row of a map whose index cannot be read, and says so', async () => {
    delete files['aio://project/p1/dsm2/tiles.json'];
    await mount(SITE);
    const dsm = byName('Shaded surface 2026-10-21');
    expect(dsm?.disabled).toBe(true);
    expect(dsm?.getAttribute('aria-checked')).toBe('false');
    const note = document.getElementById(dsm?.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toBe('This map could not be read.');
    // the others stay usable
    expect(byName('Imagery change')?.disabled).toBe(false);
  });
});
