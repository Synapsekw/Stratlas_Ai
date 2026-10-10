// @vitest-environment jsdom
import type { ProjectManifest, RasterPackInfo } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graphics } from '../graphics';
import { shell } from '../shell';
import { BasemapPicker, GroundRows } from './BasemapPicker';
import { siteLonLat } from './basemap';
import { threeDates } from './__fixtures__/threeDates';
import { onlineNoticeSeen, onlineSatelliteSwitch } from './onlineSatellite';
import { rasterPacks } from './siteTiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no ResizeObserver: a stand-in that never fires.
const noop = () => undefined;
globalThis.ResizeObserver = class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
};

const manifest: ProjectManifest = threeDates;
const [lon = 0, lat = 0] = siteLonLat(manifest) ?? [];

const pack = (id: string, over: Partial<RasterPackInfo> = {}): RasterPackInfo =>
  ({
    id,
    kind: 'imagery',
    label: `Pack ${id}`,
    bbox: [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1],
    minZoom: 0,
    maxZoom: 14,
    tileSize: 256,
    attribution: 'Test',
    licence: 'CC0-1.0',
    sizeBytes: 1,
    ...over,
  }) as RasterPackInfo;

const DEFAULTS = {
  satellite: true,
  hillshade: true,
  streets: true,
  imageryPack: null,
  aroundTerrain: false,
  aroundImagery: false,
  onlineSatellite: false,
};

let host: HTMLDivElement;
let root: Root | undefined;
/** What main was asked through `onlineTiles:setSatellite`, in order. */
let switched: boolean[] = [];
const offlineOnly = (on: boolean) => {
  act(() => {
    shell.setState({ settings: { ...shell.getState().settings, offlineOnly: on } });
  });
};
beforeEach(() => {
  localStorage.clear();
  switched = [];
  // main, as far as the switch goes: it says yes and remembers nothing
  (globalThis as { aio?: unknown }).aio = {
    invoke: vi.fn((channel: string, req: { on?: boolean }) => {
      if (channel !== 'onlineTiles:setSatellite') return Promise.reject(new Error(channel));
      switched.push(req.on === true);
      return Promise.resolve({ ok: true, satellite: req.on === true });
    }),
  };
  onlineSatelliteSwitch.setState({ asking: false, error: null });
  shell.setState({ settings: { ...shell.getState().settings, offlineOnly: false } });
  rasterPacks.setState({ prefs: { ...DEFAULTS }, imagery: [], terrain: [] });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  delete (globalThis as { aio?: unknown }).aio;
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (what = <BasemapPicker />) => {
  root = createRoot(host);
  act(() => root?.render(what));
};
const open = () => {
  act(() => q('basemap-button')?.click());
};
const key = (k: string) => {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
  });
};
const prefs = () => rasterPacks.getState().prefs;

describe('the map type picker', () => {
  it('is a chip that names the map type and opens a labelled dialog', () => {
    rasterPacks.setState({ imagery: [pack('a')] });
    render();
    const chip = q('basemap-button');
    expect(chip?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip?.getAttribute('aria-expanded')).toBe('false');
    expect(chip?.getAttribute('aria-label')).toBe('Map type: Satellite');
    expect(chip?.textContent).toBe('Satellite');
    expect(q('basemap-pop')).toBeNull();
    open();
    expect(chip?.getAttribute('aria-expanded')).toBe('true');
    expect(q('basemap-pop')?.getAttribute('role')).toBe('dialog');
    expect(q('basemap-pop')?.getAttribute('aria-label')).toBe('Map type');
    const group = host.querySelector('[role="radiogroup"]');
    expect(group?.querySelectorAll('[role="radio"]')).toHaveLength(3);
    const title = group?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(title)?.textContent).toBe('Map type');
  });

  it('marks the map type in use and writes the choice the Settings checkboxes read', () => {
    rasterPacks.setState({ imagery: [pack('a')] });
    render();
    open();
    expect(q('basemap-satellite')?.getAttribute('aria-checked')).toBe('true');
    expect(q('basemap-streets')?.getAttribute('aria-checked')).toBe('false');
    act(() => q('basemap-streets')?.click());
    expect(prefs().satellite).toBe(false);
    expect(q('basemap-streets')?.getAttribute('aria-checked')).toBe('true');
    expect(q('basemap-button')?.textContent).toBe('Streets');
    act(() => q('basemap-imagery')?.click());
    expect(prefs()).toMatchObject({ satellite: true, streets: false });
    expect(q('basemap-button')?.textContent).toBe('Satellite only');
    act(() => q('basemap-satellite')?.click());
    expect(prefs()).toMatchObject({ satellite: true, streets: true });
    // remembered on this computer
    expect(JSON.parse(localStorage.getItem('stratlas.rasterPacks') ?? '{}')).toMatchObject({
      satellite: true,
      streets: true,
    });
  });

  it('follows a change made in Settings while it is open', () => {
    rasterPacks.setState({ imagery: [pack('a')] });
    render();
    open();
    act(() => {
      rasterPacks.getState().set({ satellite: false });
    });
    expect(q('basemap-streets')?.getAttribute('aria-checked')).toBe('true');
  });

  it('greys out Satellite with the reason and a way to Settings when no pack covers the site', () => {
    rasterPacks.setState({ imagery: [pack('far', { bbox: [10, 10, 11, 11] })] });
    render();
    expect(q('basemap-button')?.textContent).toBe('Streets');
    open();
    expect(q('basemap-streets')?.getAttribute('aria-checked')).toBe('true');
    expect((q('basemap-satellite') as HTMLButtonElement).disabled).toBe(true);
    expect((q('basemap-imagery') as HTMLButtonElement).disabled).toBe(true);
    expect((q('basemap-hillshade') as HTMLInputElement).disabled).toBe(true);
    expect(q('basemap-note')?.textContent).toContain(
      'No imagery or terrain pack covers this site.',
    );
    expect(q('basemap-pack')).toBeNull();
    act(() => q('basemap-open-packs')?.click());
    expect(shell.getState().screen).toBe('settings');
    expect(shell.getState().settingsFocus).toBe('raster-packs');
  });

  it('says which pack is missing when only one kind covers the site', () => {
    rasterPacks.setState({ imagery: [pack('a')] });
    render();
    open();
    expect(q('basemap-note')?.textContent).toContain('No terrain pack covers this site.');
    act(() => {
      rasterPacks.setState({ imagery: [], terrain: [pack('dem', { kind: 'terrain' })] });
    });
    expect(q('basemap-note')?.textContent).toContain('No imagery pack covers this site.');
    act(() => {
      rasterPacks.setState({ imagery: [pack('a')] });
    });
    expect(q('basemap-note')).toBeNull();
  });

  it('turns terrain shading on and off', () => {
    rasterPacks.setState({ terrain: [pack('dem', { kind: 'terrain' })] });
    render();
    open();
    const box = q('basemap-hillshade') as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
    act(() => {
      box.click();
    });
    expect(prefs().hillshade).toBe(false);
    expect((q('basemap-hillshade') as HTMLInputElement).checked).toBe(false);
  });

  it('offers the packs that cover the site when there are several', () => {
    rasterPacks.setState({
      imagery: [pack('coarse', { maxZoom: 8 }), pack('fine'), pack('far', { bbox: [1, 1, 2, 2] })],
    });
    render();
    open();
    const select = q('basemap-pack') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Best available',
      'Pack fine',
      'Pack coarse',
    ]);
    expect(select.value).toBe('');
    act(() => {
      select.value = 'fine';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(prefs().imageryPack).toBe('fine');
    act(() => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(prefs().imageryPack).toBeNull();
    // on Streets no imagery draws: the pack waits for Satellite
    act(() => q('basemap-streets')?.click());
    expect((q('basemap-pack') as HTMLSelectElement).disabled).toBe(true);
  });

  describe('Online satellite', () => {
    const box = () => q('basemap-online') as HTMLInputElement;
    const note = () => q('basemap-online-note')?.textContent;
    const tick = () => {
      act(() => {
        box().click();
      });
    };
    const button = (name: string) =>
      [...(q('online-satellite-notice')?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === name,
      );
    const settle = () => act(() => Promise.resolve());

    it('is a row under Terrain shading that says what it is, off to start with', () => {
      render();
      open();
      expect(box().checked).toBe(false);
      expect(box().disabled).toBe(false);
      expect(box().closest('label')?.textContent).toContain('Online satellite');
      expect(note()).toBe('Sentinel-2, 2016, about 10 m per pixel');
      expect(box().getAttribute('aria-describedby')).toBe(q('basemap-online-note')?.id);
      // after the terrain shading row
      const rows = [...host.querySelectorAll('.bm-toggle input')];
      expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
        'basemap-hillshade',
        'basemap-online',
      ]);
    });

    it('the first time shows the notice, and switches nothing on until the person says yes', async () => {
      render();
      open();
      tick();
      expect(q('online-satellite-notice')?.textContent).toContain("from EOX's servers");
      expect(box().checked).toBe(false);
      expect(switched).toEqual([]);
      // Cancel: still off, and the notice comes again next time
      act(() => button('Cancel')?.click());
      expect(q('online-satellite-notice')).toBeNull();
      expect(switched).toEqual([]);
      expect(onlineNoticeSeen()).toBe(false);

      tick();
      act(() => button('Switch on')?.click());
      await settle();
      expect(switched).toEqual([true]);
      expect(box().checked).toBe(true);
      expect(prefs().onlineSatellite).toBe(true);
      expect(q('online-satellite-notice')).toBeNull();
      expect(onlineNoticeSeen()).toBe(true);

      // off and on again: no notice any more
      tick();
      await settle();
      expect(switched).toEqual([true, false]);
      expect(box().checked).toBe(false);
      tick();
      await settle();
      expect(q('online-satellite-notice')).toBeNull();
      expect(switched).toEqual([true, false, true]);
    });

    it('closing the picker with the notice open switches nothing on', () => {
      render();
      open();
      tick();
      expect(onlineSatelliteSwitch.getState().asking).toBe(true);
      act(() => q('basemap-button')?.click());
      expect(onlineSatelliteSwitch.getState().asking).toBe(false);
      expect(switched).toEqual([]);
    });

    it('makes Satellite and Satellite only a choice where no pack covers the site', () => {
      rasterPacks.setState({ imagery: [pack('far', { bbox: [10, 10, 11, 11] })] });
      render();
      open();
      expect((q('basemap-satellite') as HTMLButtonElement).disabled).toBe(true);
      expect(q('basemap-note')?.textContent).toContain('No imagery or terrain pack covers this');
      act(() => {
        rasterPacks.getState().set({ onlineSatellite: true });
      });
      expect((q('basemap-satellite') as HTMLButtonElement).disabled).toBe(false);
      expect((q('basemap-imagery') as HTMLButtonElement).disabled).toBe(false);
      // Satellite was the remembered type: with imagery to draw, the map shows it
      expect(q('basemap-satellite')?.getAttribute('aria-checked')).toBe('true');
      expect(q('basemap-button')?.textContent).toBe('Satellite');
      // the imagery line is gone; only what is still missing is said
      expect(q('basemap-note')?.textContent).toContain('No terrain pack covers this site.');
      expect(q('basemap-note')?.textContent).not.toContain('imagery');
      expect(q('basemap-turn-on-online')).toBeNull();
      act(() => q('basemap-imagery')?.click());
      expect(q('basemap-button')?.textContent).toBe('Satellite only');
    });

    it('the reason line offers it as a second way out when it is off', async () => {
      localStorage.setItem('stratlas.onlineSatelliteNotice', '1');
      rasterPacks.setState({ terrain: [pack('dem', { kind: 'terrain' })] });
      render();
      open();
      expect(q('basemap-note')?.textContent).toBe(
        'No imagery pack covers this site. Offline maps or turn on Online satellite',
      );
      act(() => q('basemap-turn-on-online')?.click());
      await settle();
      expect(switched).toEqual([true]);
      expect(q('basemap-note')).toBeNull();
      expect(q('basemap-button')?.textContent).toBe('Satellite');
    });

    it('offline only: greyed with the reason, and no second way out', () => {
      offlineOnly(true);
      render();
      open();
      expect(box().disabled).toBe(true);
      expect(box().checked).toBe(false);
      expect(note()).toBe('Go online to use it');
      expect(q('basemap-note')?.textContent).toContain('No imagery or terrain pack covers this');
      expect(q('basemap-turn-on-online')).toBeNull();
    });

    it('offline only and already on: saved tiles only, and it can still be switched off', async () => {
      rasterPacks.getState().set({ onlineSatellite: true });
      offlineOnly(true);
      render();
      open();
      expect(box().checked).toBe(true);
      expect(box().disabled).toBe(false);
      expect(note()).toBe('Showing saved tiles only');
      expect((q('basemap-satellite') as HTMLButtonElement).disabled).toBe(false);
      tick();
      await settle();
      expect(switched).toEqual([false]);
      expect(box().checked).toBe(false);
      expect(box().disabled).toBe(true);
      expect(note()).toBe('Go online to use it');
    });

    it('says why when main does not switch it', async () => {
      localStorage.setItem('stratlas.onlineSatelliteNotice', '1');
      (globalThis as { aio?: unknown }).aio = {
        invoke: vi.fn(() => Promise.resolve({ ok: false, error: 'It was not saved.' })),
      };
      render();
      open();
      tick();
      await settle();
      expect(box().checked).toBe(false);
      expect(q('online-satellite-error')?.textContent).toBe('It was not saved.');
    });
  });

  it('works from the keyboard: arrows choose, Escape closes and focus returns to the chip', async () => {
    rasterPacks.setState({ imagery: [pack('a')] });
    render();
    const chip = q('basemap-button');
    chip?.focus();
    open();
    expect(document.activeElement).toBe(q('basemap-satellite'));
    key('ArrowRight');
    expect(prefs()).toMatchObject({ satellite: true, streets: false });
    expect(document.activeElement).toBe(q('basemap-imagery'));
    key('ArrowRight'); // wraps
    expect(prefs().satellite).toBe(false);
    expect(document.activeElement).toBe(q('basemap-streets'));
    key('ArrowLeft');
    expect(document.activeElement).toBe(q('basemap-imagery'));
    key('Home');
    expect(document.activeElement).toBe(q('basemap-streets'));
    key('End');
    expect(document.activeElement).toBe(q('basemap-imagery'));
    key('Escape');
    expect(q('basemap-pop')).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(chip);
  });

  it('arrows skip a map type that cannot be chosen', () => {
    render();
    open();
    expect(document.activeElement).toBe(q('basemap-streets'));
    key('ArrowRight');
    expect(prefs().satellite).toBe(false);
    expect(document.activeElement).toBe(q('basemap-streets'));
  });

  it('closes on a click outside', () => {
    render();
    open();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(q('basemap-pop')).toBeNull();
  });
});

describe('the ground around the site in 3D (Layers)', () => {
  const box = (id: string) => q(id) as HTMLInputElement;

  it('writes the same choices as Settings when packs cover the site', () => {
    graphics().setState({ tier: 'high' });
    rasterPacks.setState({ imagery: [pack('a')], terrain: [pack('dem', { kind: 'terrain' })] });
    render(<GroundRows />);
    expect(box('ground-aroundImagery').disabled).toBe(false);
    expect(box('ground-aroundImagery').checked).toBe(false);
    expect(q('ground-note')).toBeNull();
    act(() => {
      box('ground-aroundImagery').click();
    });
    expect(prefs().aroundImagery).toBe(true);
    act(() => {
      box('ground-aroundTerrain').click();
    });
    expect(prefs().aroundTerrain).toBe(true);
    expect(box('ground-aroundTerrain').checked).toBe(true);
  });

  it('greys the rows out with the reason when no pack covers the site', () => {
    graphics().setState({ tier: 'high' });
    rasterPacks.setState({ imagery: [pack('a')], prefs: { ...DEFAULTS, aroundTerrain: true } });
    render(<GroundRows />);
    expect(box('ground-aroundImagery').disabled).toBe(false);
    expect(box('ground-aroundTerrain').disabled).toBe(true);
    // chosen before, but nothing to draw it from
    expect(box('ground-aroundTerrain').checked).toBe(false);
    expect(q('ground-note')?.textContent).toContain('No terrain pack covers this site.');
    expect(q('basemap-open-packs')).not.toBeNull();
  });

  it('says so when the graphics preset does not offer it', () => {
    graphics().setState({ tier: 'low' });
    rasterPacks.setState({ imagery: [pack('a')], terrain: [pack('dem', { kind: 'terrain' })] });
    render(<GroundRows />);
    expect(box('ground-aroundImagery').disabled).toBe(true);
    expect(q('ground-note')?.textContent).toContain('need Medium graphics or higher');
    expect(q('basemap-open-packs')).toBeNull();
  });

  it('shows nothing for a project that is not placed on the Earth', () => {
    workspace.getState().openProject({
      id: 'local',
      root: '/local',
      manifest: { ...manifest, crs: { wkt: 'LOCAL_CS["Grid"]' } },
    });
    render(<GroundRows />);
    expect(host.textContent).toBe('');
  });
});
