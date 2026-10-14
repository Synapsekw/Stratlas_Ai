// @vitest-environment jsdom
import { defaultGlobeSettings, type BaseMapId, type RasterPackInfo } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { channel: string; payload: unknown }[] = [];
const openSettingsPage = vi.fn();
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string, payload: unknown) => {
      calls.push({ channel, payload });
      return Promise.resolve({ ok: true, value: { ok: true } });
    },
  },
  shell: { getState: () => ({ openSettingsPage }) },
  useShell: (selector: (s: { settings: object }) => unknown) => selector({ settings: {} }),
}));
vi.mock('../workspace/siteTiles', () => ({
  useRasterPacks: (selector: (s: object) => unknown) =>
    selector({
      prefs: { onlineSatellite: true },
      online: { source: 'esri-world-imagery', keys: { esri: false, mapbox: true } },
    }),
}));
vi.mock('../workspace/OnlineSatelliteNotice', () => ({ OnlineSatelliteNotice: () => null }));

import { GlobeMenu, type GlobeMenuProps } from './GlobeMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  calls.length = 0;
  openSettingsPage.mockClear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const pack = (id: string, label: string): RasterPackInfo =>
  ({ id, label, sizeBytes: 1000 }) as RasterPackInfo;

function mount(over: Partial<GlobeMenuProps> = {}, base: BaseMapId = 'streets') {
  const onSave = vi.fn();
  const props: GlobeMenuProps = {
    prefs: defaultGlobeSettings(),
    base,
    packsOn: false,
    tier: 'high',
    imagery: [pack('sat-1', 'Site flight')],
    terrain: [pack('dem-1', 'Surface model')],
    streetPacks: 1,
    streetCredit: '© OpenStreetMap contributors',
    onSave,
    ...over,
  };
  root = createRoot(host);
  act(() => root?.render(<GlobeMenu {...props} />));
  act(() => q('globe-map-button')?.click());
  return { onSave, props };
}

const terrainSelect = () =>
  [...host.querySelectorAll('label')]
    .find((l) => l.querySelector('span')?.textContent === 'Terrain')
    ?.querySelector('select');
const choose = (el: HTMLSelectElement | null | undefined, value: string) => {
  act(() => {
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('the Globe Map menu', () => {
  it('has the key of the pins in both tones', () => {
    mount();
    const key = host.querySelector('ul.globe-key');
    expect(key?.getAttribute('aria-label')).toBe('Site pins');
    expect(
      [...(key?.querySelectorAll('li') ?? [])].map((li) => [li.dataset.tone, li.textContent]),
    ).toEqual([
      ['clear', 'No open issues'],
      ['attention', 'Open issues'],
    ]);
  });

  it('says there is no street pack only on the Streets base with none installed', () => {
    const none = 'No street map pack is installed';
    mount({ streetPacks: 0 });
    expect(q('globe-map-menu')?.textContent).toContain(none);
    act(() => root?.unmount());
    mount({ streetPacks: 2 });
    expect(q('globe-map-menu')?.textContent).not.toContain(none);
    act(() => root?.unmount());
    mount({ streetPacks: 0 }, 'natural-earth');
    expect(q('globe-map-menu')?.textContent).not.toContain(none);
  });

  it('turns terrain off with a note on the Low graphics preset only', () => {
    mount({ tier: 'low' });
    expect(terrainSelect()?.disabled).toBe(true);
    expect(q('globe-map-menu')?.textContent).toContain('Terrain is off on the Low graphics');
    act(() => root?.unmount());
    mount({ tier: 'high' });
    expect(terrainSelect()?.disabled).toBe(false);
    expect(q('globe-map-menu')?.textContent).not.toContain('Low graphics preset');
  });

  it('lists the terrain packs, saves a pick and keeps a saved pack selected', () => {
    const { onSave, props } = mount({ prefs: { ...defaultGlobeSettings(), terrain: 'dem-1' } });
    const select = terrainSelect();
    expect([...(select?.options ?? [])].map((o) => o.textContent)).toEqual([
      'Best available',
      'Off (smooth Earth)',
      'Surface model',
    ]);
    expect(select?.value).toBe('dem-1');
    choose(select, 'off');
    expect(onSave).toHaveBeenLastCalledWith({ ...props.prefs, terrain: 'off' });
  });

  it('saves an imagery pack pick when the packs are on', () => {
    const { onSave, props } = mount({ packsOn: true });
    choose(q('map-pack') as HTMLSelectElement, 'sat-1');
    expect(onSave).toHaveBeenCalledWith({ ...props.prefs, imagery: 'sat-1' });
  });

  it('the packs switch saves the base with packs and a look 0.11 knows', () => {
    const { onSave, props } = mount();
    act(() => q('map-ontop-packs')?.querySelector<HTMLElement>('[role="switch"]')?.click());
    expect(onSave).toHaveBeenCalledWith({
      ...props.prefs,
      base: 'streets',
      packs: true,
      style: 'satellite',
    });
  });

  it('opens Settings, Map sources', () => {
    mount();
    act(() => q('map-sources-link')?.click());
    expect(openSettingsPage).toHaveBeenCalledWith('map-sources');
  });

  it('asks main to open the Mapbox feedback page', () => {
    mount({}, 'mapbox-dark');
    act(() => q('map-menu-improve')?.click());
    expect(calls).toContainEqual({
      channel: 'onlineTiles:openFeedback',
      payload: { provider: 'mapbox' },
    });
  });
});
