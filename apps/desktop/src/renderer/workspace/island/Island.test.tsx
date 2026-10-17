// @vitest-environment jsdom
import { announced } from '@aio/ui';
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from '../__fixtures__/threeDates';
import { shell } from '../../shell';
import { timeline } from '../timeline';
import { useSplit } from '../SplitPanes';
import { Island, type IslandProps } from './Island';
import type { LiveItem } from './islandModel';
import type * as LiveModule from './useIslandLive';

// what is live comes from the stores in the app; here each test says what it is
let live: LiveItem[] = [];
vi.mock('./useIslandLive', async (importOriginal) => ({
  ...(await importOriginal<typeof LiveModule>()),
  useIslandLive: () => live,
}));

// Compare dates opens the split; here only that the island asks for it
const compareOpen = vi.fn();
let comparing = false;
vi.mock('../CompareControls', () => ({
  useCompareDates: () => ({
    available: true,
    twin: comparing,
    label: comparing ? 'Leave the comparison' : 'Compare dates',
    open: compareOpen,
  }),
  CompareButton: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // jsdom draws nothing (a stage module probes the canvas)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  live = [];
  comparing = false;
  localStorage.clear();
  timeline.setState({ byProject: {} });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  timeline.getState().attach('p3', captureIndex(threeDates));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The island with the stage's split, as the stage gives it. */
function WithSplit(props: Omit<IslandProps, 'split'>) {
  return <Island {...props} split={useSplit()} />;
}

// async: the split's pane list loads through a promise
const render = async (linked = false) => {
  root ??= createRoot(host);
  await act(async () => {
    root?.render(<WithSplit stage={null} mode="3d" tools="3d" linked={linked} />);
    await Promise.resolve();
  });
};
const island = () => host.querySelector<HTMLElement>('[role="toolbar"]');
const button = (name: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const tab = (name: string) =>
  [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name);
const near = () => {
  act(() => {
    island()?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
  });
};
const key = (k: string, target: Element | null = document.activeElement) => {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};
const openTools = () => {
  near();
  act(() => button('Tools')?.click());
};

describe('Island', () => {
  it('rests as the date pill in the survey colour, with no tiles', async () => {
    await render();
    const el = island();
    expect(el?.getAttribute('aria-label')).toBe('Stage tools');
    expect(el?.dataset.surface).toBe('dark');
    expect(el?.dataset.state).toBe('rest');
    const row = host.querySelector('[data-testid="date-row"]');
    expect(row?.textContent).toContain('6 Nov');
    expect(row?.querySelector('.isl-swatch')).not.toBeNull();
    expect(host.querySelector('.isl-tile')).toBeNull();
    expect(button('Previous survey')).toBeNull();
  });

  it('grows when the pointer is near: arrows, count, view and Tools', async () => {
    await render();
    near();
    expect(island()?.dataset.state).toBe('ready');
    expect(button('Previous survey')?.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowLeft');
    expect(button('Next survey')).not.toBeNull();
    expect(host.querySelector('[data-testid="date-bar-count"]')?.textContent).toBe('3 of 3');
    expect(button('Tools')?.textContent).toContain('3D');
    act(() => button('Previous survey')?.click());
    expect(timeline.getState().focus).toBe('oct');
  });

  it('opens the tools: the view switch and the group tabs', async () => {
    await render();
    openTools();
    expect(island()?.dataset.state).toBe('tools');
    for (const m of ['3D', 'Map', 'Split']) expect(button(m)).not.toBeNull();
    expect(button('3D')?.getAttribute('aria-pressed')).toBe('true');
    expect(tab('View')?.getAttribute('aria-selected')).toBe('true');
    expect(tab('Measure')).toBeDefined();
    expect(tab('Display')).toBeDefined();
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('View');
    expect(button('Whole site')).not.toBeNull();
  });

  it('previews a group on hover while the picked tab stays selected', async () => {
    await render();
    openTools();
    act(() => {
      tab('Display')?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('Display');
    expect(tab('View')?.getAttribute('aria-selected')).toBe('true');
    expect(tab('Display')?.getAttribute('aria-selected')).toBe('false');
  });

  it('moves between the tiles with the arrow keys', async () => {
    await render();
    openTools();
    const tiles = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"] button')];
    act(() => tiles[0]?.focus());
    key('ArrowRight');
    expect(document.activeElement).toBe(tiles[1]);
    key('ArrowLeft');
    expect(document.activeElement).toBe(tiles[0]);
  });

  it('closes on Esc and gives focus back to the island', async () => {
    await render();
    openTools();
    key('Escape');
    expect(island()?.dataset.state).toBe('rest');
    expect(document.activeElement).toBe(island());
  });

  it('opens the tools with T', async () => {
    await render();
    key('t', document.body);
    expect(island()?.dataset.state).toBe('tools');
  });

  it('keeps the date beside a live reading, and says the reading politely', async () => {
    live = [{ kind: 'tool', label: 'Distance', reading: '12.40 m' }];
    await render();
    const text = island()?.textContent ?? '';
    expect(text).toContain('6 Nov');
    expect(text).toContain('Distance');
    expect(text).toContain('12.40 m');
    expect(announced().polite).toContain('Distance 12.40 m');
  });

  it('shows the second live item as a bubble that swaps with the island', async () => {
    live = [
      { kind: 'tool', label: 'Distance', reading: '12.40 m' },
      { kind: 'playback', clip: 'Flight 3', progress: 0.4, telemetry: null },
    ];
    await render();
    const line = () => host.querySelector('.isl-live')?.textContent ?? '';
    expect(line()).toContain('Distance');
    const swap = button('Swap');
    expect(swap).not.toBeNull();
    act(() => swap?.click());
    expect(line()).toContain('Flight 3');
    expect(line()).not.toContain('Distance');
  });

  it('forgets a swap when the live pair changes', async () => {
    live = [
      { kind: 'tool', label: 'Distance', reading: '12.40 m' },
      { kind: 'playback', clip: 'Flight 3', progress: 0.4, telemetry: null },
    ];
    await render();
    act(() => button('Swap')?.click());
    live = [
      { kind: 'tool', label: 'Distance', reading: '12.40 m' },
      { kind: 'connection', state: 'offline' },
    ];
    await render();
    expect(host.querySelector('.isl-live')?.textContent).toContain('Distance');
  });

  it('marks reduced motion on the root', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await render();
    expect(island()?.dataset.motion).toBe('reduce');
  });

  it('rests as three dots in a project without survey dates', async () => {
    timeline.getState().attach('p3', null);
    await render();
    expect(host.querySelector('.isl-dots')).not.toBeNull();
    expect(host.querySelector('[data-testid="date-row"]')).toBeNull();
  });

  it('shows one date without arrows', async () => {
    const one = { ...threeDates, captures: threeDates.captures.slice(0, 1) };
    timeline.getState().attach('p3', captureIndex(one));
    await render();
    near();
    expect(host.querySelector('[data-testid="date-row"]')?.textContent).toContain('4 Sep');
    expect(button('Previous survey')).toBeNull();
  });

  it('opens the calendar from the date, with Compare the two dates', async () => {
    await render();
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="date-bar-open"]')?.click());
    expect(island()?.dataset.state).toBe('date');
    expect(host.querySelector('[data-testid="calendar"]')).not.toBeNull();
    key('Escape');
    expect(island()?.dataset.state).toBe('rest');
    expect(document.activeElement).toBe(island());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="date-bar-open"]')?.click());
    const compare = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Compare the two dates',
    );
    act(() => compare?.click());
    expect(compareOpen).toHaveBeenCalledWith(undefined);
    expect(island()?.dataset.state).toBe('rest');
  });

  it('outlines the island when the sidebar shows its live item', async () => {
    live = [{ kind: 'tool', label: 'Distance', reading: null }];
    await render(true);
    expect(island()?.hasAttribute('data-linked')).toBe(true);
  });

  it('follows the app setting Reduce motion', async () => {
    const settings = shell.getState().settings;
    shell.setState({ settings: { ...settings, motion: 'reduce' } });
    try {
      await render();
      expect(island()?.dataset.motion).toBe('reduce');
    } finally {
      shell.setState({ settings });
    }
  });

  it('gives Compare dates one owner: the View tile, not while comparing', async () => {
    await render();
    openTools();
    expect(host.querySelectorAll('[data-testid="compare-dates"]')).toHaveLength(1);
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="compare-dates"]')?.click());
    expect(compareOpen).toHaveBeenCalled();
    comparing = true;
    await render();
    openTools();
    expect(host.querySelector('[data-testid="compare-dates"]')).toBeNull();
  });

  it('hangs the bubble beside the capsule, outside its centring', async () => {
    live = [
      { kind: 'tool', label: 'Distance', reading: '12.40 m' },
      { kind: 'connection', state: 'offline' },
    ];
    await render();
    const swap = button('Swap');
    expect(swap?.parentElement?.classList.contains('isl-aside')).toBe(true);
    expect(
      island()
        ?.querySelector('.island')
        ?.contains(swap ?? null),
    ).toBe(false);
  });

  it('closes from its close button and gives focus back to the island', async () => {
    await render();
    openTools();
    act(() => button('Close')?.click());
    expect(island()?.dataset.state).toBe('rest');
    expect(document.activeElement).toBe(island());
  });

  it('opens the point cloud panel when the sidebar or the palette asks for it', async () => {
    const cloud = { kind: 'pointcloud', id: 'scan', name: 'Scan', visible: true } as const;
    const withCloud = {
      ...threeDates,
      layers: [
        ...threeDates.layers,
        { ...cloud, src: { path: 'c.copc.laz' }, format: 'copc' as const },
      ],
    };
    // the panel's placement watches its size
    const noop = () => undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = noop;
        unobserve = noop;
        disconnect = noop;
      },
    );
    workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: withCloud });
    shell.getState().setCloudPanel(false);
    await render();
    act(() => {
      shell.getState().openCloudPanel();
    });
    expect(document.querySelector('[data-testid="cloud-panel"]')).not.toBeNull();
    // closing the group's set closes the panel with it
    act(() =>
      document.querySelector<HTMLButtonElement>('.isl-full button[aria-label="Close"]')?.click(),
    );
    expect(shell.getState().cloudPanelOpen).toBe(false);
    expect(document.querySelector('[data-testid="cloud-panel"]')).toBeNull();
  });
});
