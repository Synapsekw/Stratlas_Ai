// @vitest-environment jsdom
import type { RasterPackInfo } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graphics } from '../graphics';
import { shell } from '../shell';
import { threeDates } from './__fixtures__/threeDates';
import { siteLonLat } from './basemap';
import { MapViewMenu, SceneMapMenu } from './MapMenus';
import { onlineSatelliteSwitch } from './onlineSatellite';
import { rasterPacks } from './siteTiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
};

const [lon = 0, lat = 0] = siteLonLat(threeDates) ?? [];
const pack = (id: string, kind: 'imagery' | 'terrain' = 'imagery'): RasterPackInfo =>
  ({
    id,
    kind,
    label: id,
    bbox: [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1],
    minZoom: 0,
    maxZoom: 16,
    tileSize: 256,
    attribution: 'Test',
    licence: 'CC0-1.0',
    sizeBytes: 1,
  }) as RasterPackInfo;

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  host.className = 'stage';
  document.body.append(host);
  root = createRoot(host);
  workspace.setState({ project: { id: 'p', manifest: threeDates } } as never);
  rasterPacks.setState({
    imagery: [pack('site')],
    terrain: [pack('dem', 'terrain')],
    online: { source: 'esri-world-imagery', keys: { esri: false, mapbox: false } },
  });
  rasterPacks.getState().setForSession({ onlineSatellite: false, mapBase: null, sceneBase: null });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  onlineSatelliteSwitch.getState().cancel();
  graphics().getState().setOverride(null);
  delete (globalThis as { aio?: unknown }).aio;
});

describe('the Map view menu', () => {
  it('keeps its chip and pop ids and offers every source, Mapbox greyed without a key', () => {
    act(() => {
      root.render(<MapViewMenu />);
    });
    expect(q('basemap-button')?.textContent).toContain('Streets');
    act(() => q('basemap-button')?.click());
    expect(q('basemap-pop')).not.toBeNull();
    expect((q('map-tile-mapbox-streets') as HTMLButtonElement).disabled).toBe(true);
    expect((q('map-tile-esri-world-imagery') as HTMLButtonElement).disabled).toBe(false);
  });

  it('picking Esri the first time shows its notice in the menu; yes stores the choice', async () => {
    const invoke = vi.fn((channel: string, req: { enabled?: boolean; source?: string }) =>
      Promise.resolve(
        channel === 'onlineTiles:set'
          ? { ok: true, enabled: true, source: req.source ?? 'esri-world-imagery' }
          : null,
      ),
    );
    (globalThis as { aio?: unknown }).aio = { invoke, on: vi.fn() };
    act(() => {
      root.render(<MapViewMenu />);
    });
    act(() => q('basemap-button')?.click());
    act(() => q('map-tile-esri-world-imagery')?.click());
    const notice = q('online-satellite-notice');
    expect(notice?.getAttribute('data-provider')).toBe('esri');
    act(() => {
      notice?.querySelector('button')?.click();
    });
    await vi.waitFor(() => {
      expect(rasterPacks.getState().prefs.mapBase).toBe('esri-world-imagery');
    });
  });

  it('the packs switch turns imagery packs on; Map sources opens Settings there', () => {
    act(() => {
      root.render(<MapViewMenu />);
    });
    act(() => q('basemap-button')?.click());
    act(() => {
      q('map-ontop-packs')?.querySelector<HTMLElement>('[role="switch"]')?.click();
    });
    // the packs switch starts on (imagery packs on top is the default), so the click turns it off
    expect(rasterPacks.getState().prefs.satellite).toBe(false);
    act(() => q('map-sources-link')?.click());
    expect(shell.getState().settingsPage).toBe('map-sources');
  });

  it('a drawn Mapbox map offers Improve this map, which main opens', () => {
    const invoke = vi.fn(() => Promise.resolve({}));
    (globalThis as { aio?: unknown }).aio = { invoke, on: vi.fn() };
    rasterPacks.setState({
      online: { source: 'esri-world-imagery', keys: { esri: false, mapbox: true } },
    });
    rasterPacks
      .getState()
      .setForSession({ onlineSatellite: true, mapBase: 'mapbox-streets', satellite: false });
    act(() => {
      root.render(<MapViewMenu />);
    });
    act(() => q('basemap-button')?.click());
    act(() => q('map-menu-improve')?.click());
    expect(invoke).toHaveBeenCalledWith('onlineTiles:openFeedback', { provider: 'mapbox' });
  });
});

describe('the 3D scene menu', () => {
  it('has a chip of its own, with the ground rows as On top switches', () => {
    graphics().getState().setOverride('medium');
    act(() => {
      root.render(<SceneMapMenu />);
    });
    act(() => q('scene-map-button')?.click());
    expect(q('scene-map-pop')).not.toBeNull();
    expect(q('map-ontop-aroundImagery')).not.toBeNull();
    expect(q('map-ontop-aroundTerrain')).not.toBeNull();
    act(() => q('map-tile-streets')?.click());
    expect(rasterPacks.getState().prefs.sceneBase).toBe('streets');
  });

  it('below Medium a saved online base shows as the street map, credited to it', () => {
    graphics().getState().setOverride('low');
    rasterPacks.setState({
      online: { source: 'esri-world-imagery', keys: { esri: false, mapbox: true } },
    });
    rasterPacks.getState().setForSession({ onlineSatellite: true, sceneBase: 'mapbox-satellite' });
    act(() => {
      root.render(<SceneMapMenu />);
    });
    expect(q('map-chip-fallback')).not.toBeNull();
    act(() => q('scene-map-button')?.click());
    expect(q('map-tile-mapbox-satellite')?.getAttribute('data-state')).toBe('tier');
    expect(q('map-menu-credit')?.textContent).toContain('OpenStreetMap');
    expect(q('map-menu-credit')?.textContent).not.toMatch(/mapbox/i);
    expect(q('map-menu-wordmark')).toBeNull();
  });

  it('is not shown for a project that is not placed on the Earth', () => {
    workspace.setState({
      project: { id: 'p', manifest: { ...threeDates, crs: { wkt: 'LOCAL_CS["Grid"]' } } },
    } as never);
    act(() => {
      root.render(<SceneMapMenu />);
    });
    expect(q('scene-map-button')).toBeNull();
  });
});
