// @vitest-environment jsdom
import { ONLINE_SOURCES } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapMenu, type MapMenuProps } from './MapMenu';
import { mapMenuModel } from './mapMenuModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
};

const model = (
  base: Parameters<typeof mapMenuModel>[1]['base'] = 'streets',
  keys = { esri: false, mapbox: false },
) =>
  mapMenuModel(
    'map',
    { base, onTop: { packs: true }, pack: null },
    ONLINE_SOURCES,
    { imagery: [{ id: 'site', label: 'Site imagery' }], terrain: 0 },
    { enabled: true, offlineOnly: false },
    keys,
  );

let host: HTMLDivElement;
let root: Root;
const handlers = () => ({
  onPick: vi.fn(),
  onToggle: vi.fn(),
  onPack: vi.fn(),
  onOpenSources: vi.fn(),
});
const render = (over: Partial<MapMenuProps> = {}) => {
  const h = handlers();
  act(() => {
    root.render(
      <MapMenu
        model={model()}
        testIds={{ chip: 'chip', pop: 'pop' }}
        className="test-anchor"
        place="free"
        {...h}
        {...over}
      />,
    );
  });
  return h;
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const open = () => {
  act(() => q('chip')?.click());
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('the Map menu', () => {
  it('shows the chosen map on the chip and opens the gallery as a dialog', () => {
    render();
    expect(q('chip')?.textContent).toContain('Streets');
    expect(q('chip')?.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(q('pop')?.getAttribute('role')).toBe('dialog');
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(9);
    expect(q('map-tile-streets')?.getAttribute('aria-checked')).toBe('true');
    // focus goes to the map in use
    expect(document.activeElement).toBe(q('map-tile-streets'));
  });

  it('greys a Mapbox style without a key, with the reason in words and a way to Map sources', () => {
    const h = render();
    open();
    const tile = q('map-tile-mapbox-streets') as HTMLButtonElement;
    expect(tile.disabled).toBe(true);
    expect(tile.textContent).toContain('Key');
    expect(q('map-menu-note-mapbox')?.textContent).toContain('Add a key in Map sources');
    expect(tile.getAttribute('aria-describedby')).toBe(q('map-menu-note-mapbox')?.id);
    act(() => q('map-menu-add-key-mapbox')?.click());
    expect(h.onOpenSources).toHaveBeenCalledOnce();
    expect(q('pop')).toBeNull();
  });

  it('picks with a click, and with the arrows over the tiles that can be picked', () => {
    const h = render();
    open();
    act(() => q('map-tile-esri-world-imagery')?.click());
    expect(h.onPick).toHaveBeenLastCalledWith('esri-world-imagery');
    q('map-tile-streets')?.focus();
    act(() => {
      q('map-tile-streets')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    // the next tile that can be picked: Esri (the Mapbox satellite needs a key)
    expect(h.onPick).toHaveBeenLastCalledWith('esri-world-imagery');
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    expect(h.onPick).toHaveBeenLastCalledWith('s2cloudless-2016');
  });

  it('has the On top switches with their reasons, the pack picker, the credit and Map sources', () => {
    const h = render();
    open();
    const shading = q('map-ontop-hillshade');
    expect(shading?.querySelector('[role="switch"]')?.hasAttribute('disabled')).toBe(true);
    expect(shading?.textContent).toContain('No terrain pack covers this site');
    act(() => {
      q('map-ontop-streets')?.querySelector<HTMLElement>('[role="switch"]')?.click();
    });
    expect(h.onToggle).toHaveBeenCalledWith('streets', false);
    const pick = q('map-pack') as HTMLSelectElement;
    act(() => {
      pick.value = 'site';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(h.onPack).toHaveBeenCalledWith('site');
    expect(q('map-menu-credit')?.textContent).toBe('© OpenStreetMap contributors');
    act(() => q('map-sources-link')?.click());
    expect(h.onOpenSources).toHaveBeenCalledOnce();
  });

  it('notes a fallback on the chip, and closes with Esc back to the chip', () => {
    render({ model: model('mapbox-dark') });
    expect(q('map-chip-fallback')?.textContent).toBe('Offline map');
    open();
    act(() => {
      q('pop')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(q('pop')).toBeNull();
    expect(document.activeElement).toBe(q('chip'));
  });

  it('shows what a view adds: the notice and its own block', () => {
    render({
      notice: <p data-testid="the-notice">ask</p>,
      extra: <p data-testid="the-extra">key</p>,
    });
    open();
    expect(q('the-notice')).not.toBeNull();
    expect(q('the-extra')).not.toBeNull();
  });

  it('credits a drawn Mapbox map with its wordmark and a way to improve the map', () => {
    const onImproveMap = vi.fn();
    render({
      model: model('mapbox-dark', { esri: false, mapbox: true }),
      onImproveMap,
    });
    open();
    expect(q('map-menu-wordmark')?.textContent).toBe('Mapbox');
    expect(q('map-menu-credit')?.textContent).toBe('© Mapbox © OpenStreetMap');
    act(() => q('map-menu-improve')?.click());
    expect(onImproveMap).toHaveBeenCalledOnce();
    // the renderer names no provider address
    expect(q('pop')?.innerHTML).not.toMatch(/https?:|mapbox\.com/);
  });

  it('offers no improve link without a drawn Mapbox map or without a handler', () => {
    render({ model: model('esri-world-imagery'), onImproveMap: vi.fn() });
    open();
    expect(q('map-menu-wordmark')).toBeNull();
    expect(q('map-menu-improve')).toBeNull();
    act(() => q('chip')?.click());
    render({ model: model('mapbox-dark', { esri: false, mapbox: true }) });
    open();
    expect(q('map-menu-wordmark')?.textContent).toBe('Mapbox');
    expect(q('map-menu-improve')).toBeNull();
  });
});
