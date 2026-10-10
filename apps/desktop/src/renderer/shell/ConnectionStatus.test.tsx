// @vitest-environment jsdom
import type { IpcChannel, PackageInfo, Settings } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';
import type { Bridge, Res } from '../bridge';
import { createShellStore, DEFAULT_SETTINGS, type Shell } from '../store';
import { ConnectionStatus } from './ConnectionStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A main process that keeps the settings it is sent, as `settings:set` does. */
function fakeMain(initial: Partial<Settings> = {}) {
  let saved: Settings = { ...DEFAULT_SETTINGS, ...initial };
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const bridge: Bridge = {
    call: (channel, req) => {
      calls.push({ channel, req });
      if (channel !== 'settings:set')
        return Promise.resolve({ ok: false, error: `no ${channel}` } as Res<never>);
      saved = { ...saved, ...(req as Partial<Settings>) };
      return Promise.resolve({ ok: true, value: saved } as Res<never>);
    },
  };
  return { bridge, calls, saved: () => saved };
}

const pkg = (aiPolicy: 'forbid' | 'allow'): PackageInfo => ({
  file: 'D:\\site.aio',
  encrypted: false,
  sizeBytes: 1000,
  header: {
    schema: 'aio.package/1',
    projectId: 'site',
    createdAt: '2026-10-04T08:00:00Z',
    readOnly: true,
    aiPolicy,
    exports: [],
    excludedLayers: [],
  },
});

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string) => q(id)?.textContent;
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

function mount(settings: Partial<Settings> = {}, open: PackageInfo | null = null) {
  const main = fakeMain(settings);
  const store: StoreApi<Shell> = createShellStore(main.bridge, createWorkspace());
  store.setState({ settings: main.saved(), pkg: open });
  root = createRoot(host);
  act(() => root?.render(<ConnectionStatus store={store} />));
  return { ...main, store };
}

describe('the title bar connection pair', () => {
  const BOOL = [false, true];
  for (const offlineOnly of BOOL)
    for (const cloudAi of BOOL)
      for (const blocked of BOOL) {
        const name = `offline only ${String(offlineOnly)}, cloud AI ${String(cloudAi)}, package forbids ${String(blocked)}`;
        it(`never contradicts itself: ${name}`, () => {
          mount({ offlineOnly, cloudAi }, blocked ? pkg('forbid') : null);
          const mode = text('connection-chip');
          const cloud = q('cloud-chip');
          expect(mode).toBe(offlineOnly ? 'Offline only' : 'Online');
          expect(q('connection-chip')?.getAttribute('aria-label')).toBe(
            `Connection: ${String(mode)}`,
          );
          const live = cloudAi && !offlineOnly && !blocked;
          expect(cloud?.textContent).toBe(
            live ? 'Cloud AI' : cloudAi ? 'Cloud AI blocked' : 'Cloud AI off',
          );
          // the green dot only ever sits beside "Online"
          expect(cloud?.querySelector('.dot:not(.off)') !== null).toBe(live);
          expect(cloud?.getAttribute('data-state')).toBe(live ? 'on' : cloudAi ? 'blocked' : 'off');
          if (offlineOnly) expect(cloud?.getAttribute('title')).toContain('offline-only');
          else if (blocked)
            expect(cloud?.getAttribute('title')).toContain('This package does not allow cloud AI');
        });
      }

  it('a package that allows cloud AI leaves the pair as the switches say', () => {
    mount({ cloudAi: true }, pkg('allow'));
    expect(text('connection-chip')).toBe('Online');
    expect(text('cloud-chip')).toBe('Cloud AI');
  });

  it('opens a labelled menu from the chip, with a switch that says the mode', () => {
    mount({ offlineOnly: true });
    const chip = q('connection-chip');
    expect(chip?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip?.getAttribute('aria-expanded')).toBe('false');
    expect(q('connection-menu')).toBeNull();
    act(() => chip?.click());
    expect(chip?.getAttribute('aria-expanded')).toBe('true');
    const menu = q('connection-menu');
    expect(menu?.getAttribute('role')).toBe('dialog');
    expect(menu?.getAttribute('aria-label')).toBe('Connection');
    const sw = q('connection-switch');
    expect(sw?.getAttribute('role')).toBe('switch');
    expect(sw?.getAttribute('aria-label')).toBe('Online');
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(sw);
    expect(text('connection-text')).toContain('makes no network connections');
    expect(sw?.getAttribute('aria-describedby')).toBe(q('connection-text')?.id);
  });

  it('the switch goes online through settings, and the chips and the menu follow', async () => {
    const { calls, saved, store } = mount({ offlineOnly: true, cloudAi: true });
    act(() => q('connection-chip')?.click());
    expect(q('connection-maps')?.getAttribute('aria-disabled')).toBe('true');
    expect(text('connection-maps')).toContain('Go online first');
    expect(text('connection-cloud')).toContain('Blocked');

    act(() => q('connection-switch')?.click());
    await settle();
    expect(calls).toEqual([{ channel: 'settings:set', req: { offlineOnly: false } }]);
    expect(saved().offlineOnly).toBe(false);
    expect(store.getState().settings.offlineOnly).toBe(false);
    // the menu stays open on the new mode
    expect(q('connection-switch')?.getAttribute('aria-checked')).toBe('true');
    expect(text('connection-chip')).toBe('Online');
    expect(text('cloud-chip')).toBe('Cloud AI');
    expect(text('connection-text')).toContain('You can download maps');
    expect(q('connection-maps')?.getAttribute('aria-disabled')).toBe('false');
    expect(text('connection-cloud')).toContain('On');

    // and back: offline only again, cloud AI blocked again, its own switch untouched
    act(() => q('connection-switch')?.click());
    await settle();
    expect(calls[1]).toEqual({ channel: 'settings:set', req: { offlineOnly: true } });
    expect(saved()).toMatchObject({ offlineOnly: true, cloudAi: true });
    expect(text('connection-chip')).toBe('Offline only');
    expect(text('cloud-chip')).toBe('Cloud AI blocked');
  });

  it('says so when the setting could not be saved', async () => {
    const store = createShellStore(
      {
        call: () => Promise.resolve({ ok: false, error: 'disk full' } as Res<never>),
      },
      createWorkspace(),
    );
    root = createRoot(host);
    act(() => root?.render(<ConnectionStatus store={store} />));
    act(() => q('connection-chip')?.click());
    act(() => q('connection-switch')?.click());
    await settle();
    expect(q('connection-menu')?.querySelector('[role="alert"]')?.textContent).toContain(
      'disk full',
    );
  });

  it('Download maps opens Settings, Offline maps, and only when online', () => {
    const { store } = mount({ offlineOnly: true });
    act(() => q('connection-chip')?.click());
    act(() => q('connection-maps')?.click());
    expect(store.getState().screen).toBe('projects');
    expect(q('connection-menu')).not.toBeNull();

    act(() => {
      store.setState({ settings: { ...store.getState().settings, offlineOnly: false } });
    });
    expect(text('connection-maps')).toContain('Settings, Offline maps');
    act(() => q('connection-maps')?.click());
    expect(store.getState()).toMatchObject({ screen: 'settings', settingsPage: 'maps' });
    expect(q('connection-menu')).toBeNull();
  });

  it('the cloud AI chip and row open its setting, as the chip always did', () => {
    const { store, calls } = mount({ cloudAi: true });
    act(() => q('cloud-chip')?.click());
    expect(store.getState()).toMatchObject({ screen: 'settings', settingsPage: 'privacy' });
    store.getState().go('projects');
    act(() => q('connection-chip')?.click());
    act(() => q('connection-cloud')?.click());
    expect(store.getState()).toMatchObject({ screen: 'settings', settingsPage: 'privacy' });
    // neither changes a setting
    expect(calls).toEqual([]);
  });

  it('Escape closes the menu and returns focus to the chip; so does a press outside', async () => {
    mount();
    const chip = q('connection-chip');
    chip?.focus();
    act(() => chip?.click());
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(q('connection-menu')).toBeNull();
    await settle();
    expect(document.activeElement).toBe(chip);

    act(() => chip?.click());
    expect(q('connection-menu')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(q('connection-menu')).toBeNull();
  });

  it('hints at a missing network only in Online mode, from navigator.onLine alone', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const { store } = mount();
    act(() => q('connection-chip')?.click());
    expect(text('connection-no-network')).toContain('no network connection');
    // the chip still shows the mode: what the workstation may do, not what the cable does
    expect(text('connection-chip')).toBe('Online');

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(q('connection-no-network')).toBeNull();
    onLine.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(q('connection-no-network')).not.toBeNull();

    // offline only: there is nothing to connect to, so no hint
    act(() => {
      store.setState({ settings: { ...store.getState().settings, offlineOnly: true } });
    });
    expect(q('connection-no-network')).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
