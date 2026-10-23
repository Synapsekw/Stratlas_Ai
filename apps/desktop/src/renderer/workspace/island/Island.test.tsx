// @vitest-environment jsdom
import { annotateUi } from '@aio/annotate';
import type { EngineStage } from '@aio/engine';
import { announced } from '@aio/ui';
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from '../__fixtures__/threeDates';
import { shell } from '../../shell';
import { PANEL_ID } from '../../shell/PanelHandle';
import { lineUpApp } from '../../lineup/lineUpStore';
import { measureStore } from '../../survey/measureStore';
import { timeline } from '../timeline';
import { useSplit } from '../SplitPanes';
import { drawerStore } from '../workbench/drawerStore';
import { workbench } from '../workbench/workbenchStore';
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

// the line-up step is the app's (lineup/lineUpSession.ts); here only that the island asks for it
const lineUp = vi.hoisted(() => ({
  openLineUpFor: vi.fn(() => Promise.resolve(null as string | null)),
  removeLineUp: vi.fn(),
}));
vi.mock('../../lineup/lineUpActions', () => lineUp);

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
  workbench.getState().reset();
  shell.setState({ rightCollapsed: false });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  timeline.getState().attach('p3', captureIndex(threeDates));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  // an island open with the sidebar folded opens the drawer (I-R40a): each test starts without it
  drawerStore.getState().close();
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
const render = async (linked = false, stage: EngineStage | null = null) => {
  root ??= createRoot(host);
  await act(async () => {
    root?.render(<WithSplit stage={stage} mode="3d" tools="3d" linked={linked} />);
    await Promise.resolve();
  });
};
const island = () => host.querySelector<HTMLElement>('[role="toolbar"]');
const button = (name: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const tab = (name: string) =>
  [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name);
const notch = () => host.querySelector<HTMLElement>('.island');
/** The pointer onto the notch (`buttons`: held down, as in a drag) or off it. */
const pointer = (to: 'enter' | 'leave', buttons = 0) => {
  act(() => {
    notch()?.dispatchEvent(new MouseEvent(`pointer${to}`, { buttons }));
  });
};
const wait = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const key = (k: string, target: Element | null = document.activeElement) => {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};
const openTools = () => {
  act(() => button('Tools')?.click());
};
const pressOutside = () => {
  act(() => {
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  });
};
/** Just enough of a 3D stage for the quick rows' tiles that need one. */
const fakeStage = () =>
  ({ section: { enabled: false }, setViewPreset: vi.fn() }) as unknown as EngineStage;
const front = () => workbench.getState().front;
const benchTab = (id: string) => workbench.getState().tabs.find((t) => t.id === id);

describe('Island', () => {
  it('rests as its line: the view switch, the date pill in the survey colour, the chevron', async () => {
    await render();
    const el = island();
    expect(el?.getAttribute('aria-label')).toBe('Stage tools');
    expect(el?.dataset.surface).toBe('dark');
    expect(el?.dataset.state).toBe('rest');
    const row = host.querySelector('[data-testid="date-row"]');
    expect(row?.textContent).toContain('6 Nov');
    expect(row?.querySelector('.isl-swatch')).not.toBeNull();
    expect(host.querySelector('.isl-tile')).toBeNull();
    expect(host.querySelector('[role="tab"]')).toBeNull();
    expect(button('Tools')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the view switch at rest, and switches the view from it', async () => {
    await render();
    const modes = host.querySelector('[role="group"][aria-label="Stage view"]');
    expect(modes?.closest('.isl-line')).not.toBeNull();
    expect(button('3D')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('Map')?.getAttribute('aria-pressed')).toBe('false');
    expect(button('Split')).not.toBeNull();
    act(() => button('Map')?.click());
    expect(shell.getState().stageMode).toBe('map');
    expect(island()?.dataset.state).toBe('rest');
    act(() => {
      shell.getState().setStageMode('3d');
    });
  });

  it('shows the date arrows and count at rest', async () => {
    await render();
    expect(button('Previous survey')?.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowLeft');
    expect(button('Next survey')).not.toBeNull();
    expect(host.querySelector('[data-testid="date-bar-count"]')?.textContent).toBe('3 of 3');
    act(() => button('Previous survey')?.click());
    expect(timeline.getState().focus).toBe('oct');
    expect(island()?.dataset.state).toBe('rest');
  });

  it('opens when the pointer rests on the notch, not when it passes over or drags across', async () => {
    await render();
    pointer('enter');
    wait(100);
    pointer('leave');
    wait(200);
    expect(island()?.dataset.state).toBe('rest');
    pointer('enter', 1);
    wait(300);
    expect(island()?.dataset.state).toBe('rest');
    pointer('leave');
    // a press on the line uses it as it is (a view, a date step): no opening after it
    pointer('enter');
    act(() => {
      button('Next survey')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    wait(200);
    expect(island()?.dataset.state).toBe('rest');
    pointer('leave');
    pointer('enter');
    wait(160);
    expect(island()?.dataset.state).toBe('tools');
    // opened by the pointer, focus stays where it was
    expect(document.activeElement?.getAttribute('role')).not.toBe('tab');
  });

  it('closes a while after the pointer leaves, unless it comes back', async () => {
    await render();
    pointer('enter');
    wait(160);
    pointer('leave');
    wait(150);
    pointer('enter');
    wait(400);
    expect(island()?.dataset.state).toBe('tools');
    pointer('leave');
    wait(310);
    expect(island()?.dataset.state).toBe('rest');
  });

  it('stays open after the pointer leaves while keyboard focus is in it', async () => {
    // jsdom has no keyboard modality: focus that lands by key is focus-visible, as in Chromium
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel) {
      return sel === ':focus-visible'
        ? this === document.activeElement
        : this.closest(sel) === this;
    });
    await render();
    key('t', document.body);
    expect(document.activeElement?.getAttribute('role')).toBe('tab');
    pointer('enter');
    pointer('leave');
    wait(400);
    expect(island()?.dataset.state).toBe('tools');
  });

  it('closes on Esc with the pointer on it, focus elsewhere', async () => {
    await render();
    pointer('enter');
    wait(160);
    key('Escape', document.body);
    expect(island()?.dataset.state).toBe('rest');
  });

  it('closes on a press outside', async () => {
    await render();
    openTools();
    pressOutside();
    expect(island()?.dataset.state).toBe('rest');
  });

  it('keeps the date bar test ids on the island date (I-R15)', async () => {
    await render();
    const bar = host.querySelector('[data-testid="date-bar"]');
    expect(bar?.closest('[data-testid="date-row"]')).not.toBeNull();
    expect(bar?.querySelector('[data-testid="date-bar-open"]')).not.toBeNull();
    expect(bar?.querySelector('[data-testid="date-bar-count"]')).not.toBeNull();
    expect(bar?.querySelector('[data-testid="date-bar-prev"]')).toBe(button('Previous survey'));
    expect(bar?.querySelector('[data-testid="date-bar-next"]')).toBe(button('Next survey'));
  });

  it('tells the stage how far down the open island reaches, and forgets it on close', async () => {
    await render();
    const stage = host;
    expect(stage.style.getPropertyValue('--isl-open-b')).toBe('');
    openTools();
    expect(stage.style.getPropertyValue('--isl-open-b')).toMatch(/px$/);
    key('Escape');
    expect(stage.style.getPropertyValue('--isl-open-b')).toBe('');
  });

  it('opens the tools from a click on the capsule itself', async () => {
    await render();
    act(() => host.querySelector<HTMLElement>('.island')?.click());
    expect(island()?.dataset.state).toBe('tools');
  });

  it('leaves its tools shut on a click the drawer took, the sidebar folded (I-R64)', async () => {
    await render();
    // the drawer opens on the same click, in the capture phase (Drawer.tsx)
    const take = () => {
      drawerStore.getState().open('click');
    };
    document.addEventListener('click', take, true);
    try {
      act(() => host.querySelector<HTMLElement>('.island')?.click());
      expect(drawerStore.getState().opened).toBe('click');
      expect(island()?.dataset.state).not.toBe('tools');
    } finally {
      document.removeEventListener('click', take, true);
      drawerStore.getState().close();
    }
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

  it('offers Volumes in a project with a volume measurement, without the stockpile kit', async () => {
    await render();
    openTools();
    expect(tab('Volumes')).toBeUndefined();
    act(() => {
      measureStore.setState({
        file: {
          schema: 'aio.measurements/1',
          measurements: [
            {
              id: 'sp1',
              family: 'polygon',
              tool: 'volume',
              label: 'Stockpile 1',
              scope: { kind: 'site' },
              points: [],
              items: [],
              results: [],
              createdAt: '2026-10-20T00:00:00Z',
            },
          ],
        },
      });
    });
    expect(tab('Volumes')).toBeDefined();
    measureStore.setState({ file: { schema: 'aio.measurements/1', measurements: [] } });
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

  it('mirrors the arrow keys right to left, as the tabs do', async () => {
    document.documentElement.dir = 'rtl';
    try {
      await render();
      openTools();
      const tiles = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"] button')];
      act(() => tiles[0]?.focus());
      // the next tile lies to the left
      key('ArrowLeft');
      expect(document.activeElement).toBe(tiles[1]);
      key('ArrowRight');
      expect(document.activeElement).toBe(tiles[0]);
    } finally {
      document.documentElement.dir = '';
    }
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

  it('leaves T to the video annotator and to a pending annotation', async () => {
    await render();
    const vwin = document.createElement('div');
    vwin.className = 'vwin';
    const inner = document.createElement('button');
    vwin.append(inner);
    document.body.append(vwin);
    key('t', inner);
    expect(island()?.dataset.state).toBe('rest');
    vwin.remove();
    annotateUi.setState({ pending: {} as never });
    key('t', document.body);
    expect(island()?.dataset.state).toBe('rest');
    annotateUi.setState({ pending: null });
  });

  it('keeps the one-time T notice for a T that opens the tools', async () => {
    await render();
    openTools();
    // this T closes the tools: the notice would vanish unseen
    key('t', document.body);
    expect(island()?.dataset.state).toBe('rest');
    key('t', document.body);
    expect(host.querySelector('[data-testid="t-notice"]')).not.toBeNull();
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

  it('says a playing clip once, not its telemetry on every tick', async () => {
    live = [
      { kind: 'playback', clip: 'Flight 3', progress: 0.1, telemetry: 'ALT 31 m · SPD 3.2 m/s' },
    ];
    await render();
    expect(island()?.textContent).toContain('ALT 31 m');
    expect(announced().polite.trim()).toBe('Flight 3');
    const said = announced();
    live = [
      { kind: 'playback', clip: 'Flight 3', progress: 0.2, telemetry: 'ALT 33 m · SPD 3.0 m/s' },
    ];
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(island()?.textContent).toContain('ALT 33 m');
    expect(announced()).toBe(said);
  });

  it('says a running job at coarse steps', async () => {
    live = [{ kind: 'job', id: 'j', label: 'Build the model', progress: 0.3, more: 0 }];
    await render();
    expect(announced().polite.trim()).toBe('Build the model 25%');
    const said = announced();
    live = [{ kind: 'job', id: 'j', label: 'Build the model', progress: 0.41, more: 0 }];
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(announced()).toBe(said);
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

  it('rests as the view switch alone in a project without survey dates', async () => {
    timeline.getState().attach('p3', null);
    await render();
    expect(host.querySelector('[data-testid="date-row"]')).toBeNull();
    expect(button('3D')).not.toBeNull();
    expect(button('Tools')).not.toBeNull();
  });

  it('shows one date without arrows', async () => {
    const one = { ...threeDates, captures: threeDates.captures.slice(0, 1) };
    timeline.getState().attach('p3', captureIndex(one));
    await render();
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

  it('takes Ask the agent to the agent, whatever its message box is called', async () => {
    shell.setState({ screen: 'scene', rightCollapsed: true });
    const panel = document.createElement('aside');
    panel.id = PANEL_ID.right;
    panel.innerHTML = '<div class="agent"><textarea aria-label="Agent"></textarea></div>';
    document.body.append(panel);
    try {
      await render();
      openTools();
      act(() => button('Ask the agent')?.click());
      expect(shell.getState().rightCollapsed).toBe(false);
      expect(document.activeElement).toBe(panel.querySelector('textarea'));
    } finally {
      panel.remove();
    }
  });

  it('closes from its close button and gives focus back to the island', async () => {
    await render();
    openTools();
    act(() => button('Close')?.click());
    expect(island()?.dataset.state).toBe('rest');
    expect(document.activeElement).toBe(island());
  });

  it('leaves the point cloud panel to the sidebar: asking for it opens no set here', async () => {
    const cloud = { kind: 'pointcloud', id: 'scan', name: 'Scan', visible: true } as const;
    const withCloud = {
      ...threeDates,
      layers: [
        ...threeDates.layers,
        { ...cloud, src: { path: 'c.copc.laz' }, format: 'copc' as const },
      ],
    };
    workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: withCloud });
    shell.getState().setCloudPanel(false);
    await render();
    act(() => {
      shell.getState().openCloudPanel();
    });
    // the Point cloud tab of the sidebar shows it (workbench/benchFollow.test.tsx)
    expect(document.querySelector('[data-testid="cloud-panel"]')).toBeNull();
    expect(document.querySelector('.isl-full')).toBeNull();
    // the island itself is untouched: still at rest,
    expect(island()?.dataset.state).toBe('rest');
    shell.getState().setCloudPanel(false);
  });
});

describe('Island: the groups open their workbench', () => {
  it('opens the Measure workbench from the Measure tab, and the island goes back to rest', async () => {
    await render();
    openTools();
    act(() => tab('Measure')?.click());
    expect(front()).toBe('measure');
    expect(island()?.dataset.state).toBe('rest');
    // opened again, the tools show the picked group
    openTools();
    expect(tab('Measure')?.getAttribute('aria-selected')).toBe('true');
  });

  it("opens the same workbench from the row's All tools tile", async () => {
    await render();
    openTools();
    act(() => {
      tab('Measure')?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    act(() => button('Measure: All tools')?.click());
    expect(front()).toBe('measure');
    expect(island()?.dataset.state).toBe('rest');
  });

  it("opens each group's own workbench: Display and Annotate", async () => {
    for (const [name, id] of [
      ['Display', 'display'],
      ['Annotate', 'annotate'],
    ] as const) {
      await render();
      openTools();
      act(() => tab(name)?.click());
      expect(front()).toBe(id);
      expect(island()?.dataset.state).toBe('rest');
    }
  });

  it('opens Environment as an unpinned panel tab from its caret tile', async () => {
    await render(false, fakeStage());
    openTools();
    act(() => button('Environment and time of day')?.click());
    expect(front()).toBe('environment');
    expect(benchTab('environment')).toMatchObject({ pinned: false, fixed: false });
    expect(island()?.dataset.state).toBe('rest');
  });

  it('opens Cutaway from See inside, with a clip active or not', async () => {
    for (const clip of [null, 'clip-nov']) {
      workbench.getState().reset();
      workspace.setState({ activeClip: clip });
      await render(false, fakeStage());
      openTools();
      act(() => button('See inside the asset: cut or transparent')?.click());
      expect(front()).toBe('cutaway');
      expect(island()?.dataset.state).toBe('rest');
    }
  });

  it('leaves a folded right panel folded: the workbench decides where it shows (I-R40)', async () => {
    shell.setState({ rightCollapsed: true });
    await render();
    openTools();
    act(() => tab('Display')?.click());
    expect(shell.getState().rightCollapsed).toBe(true);
    expect(front()).toBe('display');
  });

  it('opens the Jobs workbench from any group with no job running (I-R47)', async () => {
    await render();
    openTools();
    act(() => button('Show the jobs')?.click());
    expect(front()).toBe('jobs');
    expect(island()?.dataset.state).toBe('rest');
  });

  it('keeps the tools open on View, which has no workbench', async () => {
    await render();
    openTools();
    act(() => tab('Display')?.click());
    openTools();
    act(() => tab('View')?.click());
    expect(island()?.dataset.state).toBe('tools');
    expect(tab('View')?.getAttribute('aria-selected')).toBe('true');
    expect(front()).toBe('display');
  });

  it('has no full set of its own any more', async () => {
    await render(false, fakeStage());
    for (const name of ['View', 'Measure', 'Display', 'Annotate']) {
      openTools();
      act(() => tab(name)?.click());
      expect(document.querySelector('.isl-full')).toBeNull();
      key('Escape');
    }
  });

  it("calls Display's way to its workbench Layers (D5)", async () => {
    await render();
    openTools();
    act(() => {
      tab('Display')?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    act(() => button('Display: Layers')?.click());
    expect(front()).toBe('display');
  });

  it("brings the live item's tab to the front on a click on its reading (D10)", async () => {
    for (const [item, id] of [
      [{ kind: 'job', id: 'j', label: 'Build the model', progress: 0.3, more: 0 }, 'jobs'],
      [{ kind: 'playback', clip: 'Flight 3', progress: 0.1, telemetry: null }, 'video'],
      [{ kind: 'tool', label: 'Distance', reading: null }, 'measure'],
    ] as const) {
      workbench.getState().reset();
      live = [item];
      await render();
      act(() => host.querySelector<HTMLElement>('.isl-live')?.click());
      expect(front()).toBe(id);
      // the click did not open the tools as well
      expect(island()?.dataset.state).not.toBe('tools');
    }
  });

  it("brings the live item's tab to the front from the keyboard too (I-R44)", async () => {
    live = [{ kind: 'job', id: 'j', label: 'Build the model', progress: 0.3, more: 0 }];
    await render();
    const reading = host.querySelector<HTMLButtonElement>('button.isl-live-open');
    expect(reading?.getAttribute('aria-label')).toBe('Show Build the model 30% in the right panel');
    // a real button: Enter and Space click it, and it sits in the island's Tab order
    expect(reading?.tabIndex).toBe(0);
    act(() => reading?.click());
    expect(front()).toBe('jobs');
    expect(island()?.dataset.state).not.toBe('tools');
    // Space opens it too, and is not left to the app's play and pause
    workbench.getState().show('selection');
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      reading?.dispatchEvent(space);
    });
    expect(front()).toBe('jobs');
    expect(space.defaultPrevented).toBe(true);
    expect(island()?.dataset.state).not.toBe('tools');
  });

  it('keeps focus on the live reading when it lands there at rest (I-R44)', async () => {
    live = [{ kind: 'job', id: 'j', label: 'Build the model', progress: 0.3, more: 0 }];
    await render();
    const reading = host.querySelector<HTMLButtonElement>('button.isl-live-open');
    act(() => reading?.focus());
    // the line is not drawn again around it, so the button that has focus is still there
    expect(reading?.isConnected).toBe(true);
    expect(document.activeElement).toBe(reading);
  });

  it('keeps focus on the live reading at rest, the line not drawn again (I-R44)', async () => {
    live = [{ kind: 'job', id: 'j', label: 'Build the model', progress: 0.3, more: 0 }];
    await render();
    const after = document.createElement('button');
    document.body.append(after);
    act(() => {
      after.focus();
    });
    const reading = host.querySelector<HTMLButtonElement>('button.isl-live-open');
    act(() => {
      reading?.focus();
    });
    expect(island()?.dataset.state).toBe('rest');
    expect(document.activeElement).toBe(reading);
    after.remove();
  });

  it('leaves the connection state a plain reading: it has no tab', async () => {
    live = [{ kind: 'connection', state: 'offline' }];
    await render();
    expect(host.querySelector('.isl-live')).not.toBeNull();
    expect(host.querySelector('button.isl-live-open')).toBeNull();
  });

  it('still opens the tools on a click beside the live reading', async () => {
    live = [{ kind: 'job', id: 'j', label: 'Build the model', progress: 0.3, more: 0 }];
    await render();
    act(() => host.querySelector<HTMLElement>('.island')?.click());
    expect(island()?.dataset.state).toBe('tools');
    expect(front()).toBe('selection');
  });
});

describe('Island: kept open (pinned)', () => {
  const pin = () => button('Keep open');

  it('has Keep open and Close at the end of its line, open', async () => {
    await render();
    expect(pin()).toBeNull();
    openTools();
    const line = host.querySelector('.isl-line');
    expect(line?.contains(pin())).toBe(true);
    expect(line?.contains(button('Close'))).toBe(true);
    expect(line?.contains(button('3D'))).toBe(true);
    // the view switch is on the line only, not again in the tools
    expect(host.querySelectorAll('[role="group"][aria-label="Stage view"]')).toHaveLength(1);
    expect(pin()?.getAttribute('aria-pressed')).toBe('false');
    expect(island()?.hasAttribute('data-pinned')).toBe(false);
  });

  it('stays open through a press outside, Esc, the pointer leaving and a group pick', async () => {
    await render();
    openTools();
    act(() => pin()?.click());
    expect(pin()?.getAttribute('aria-pressed')).toBe('true');
    expect(island()?.hasAttribute('data-pinned')).toBe(true);
    pressOutside();
    expect(island()?.dataset.state).toBe('tools');
    key('Escape', host.querySelector('[role="tab"]'));
    expect(island()?.dataset.state).toBe('tools');
    pointer('enter');
    pointer('leave');
    wait(400);
    expect(island()?.dataset.state).toBe('tools');
    act(() => tab('Measure')?.click());
    expect(front()).toBe('measure');
    expect(island()?.dataset.state).toBe('tools');
    expect(tab('Measure')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('Measure');
    // a tile that opens its panel leaves it open too
    act(() => button('Measure: All tools')?.click());
    expect(island()?.dataset.state).toBe('tools');
    key('t', document.body);
    expect(island()?.dataset.state).toBe('tools');
  });

  it('is remembered on this computer: the next notch starts open', async () => {
    await render();
    openTools();
    act(() => pin()?.click());
    act(() => root?.unmount());
    root = undefined;
    await render();
    expect(island()?.dataset.state).toBe('tools');
    expect(pin()?.getAttribute('aria-pressed')).toBe('true');
    // started open, it takes no focus
    expect(host.contains(document.activeElement)).toBe(false);
  });

  it('returns from the calendar to its open tools', async () => {
    await render();
    openTools();
    act(() => pin()?.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="date-bar-open"]')?.click());
    expect(island()?.dataset.state).toBe('date');
    key('Escape');
    expect(island()?.dataset.state).toBe('tools');
  });

  it('unpinned again, closes as before: the pointer leaving, a pick', async () => {
    await render();
    openTools();
    act(() => pin()?.click());
    pointer('enter');
    act(() => pin()?.click());
    expect(pin()?.getAttribute('aria-pressed')).toBe('false');
    expect(island()?.dataset.state).toBe('tools');
    // (the pointer's: no keyboard focus left in it)
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    pointer('leave');
    wait(310);
    expect(island()?.dataset.state).toBe('rest');
    // forgotten too
    act(() => root?.unmount());
    root = undefined;
    await render();
    expect(island()?.dataset.state).toBe('rest');
  });

  it('Close rests it and stops keeping it open', async () => {
    await render();
    openTools();
    act(() => pin()?.click());
    act(() => button('Close')?.click());
    expect(island()?.dataset.state).toBe('rest');
    expect(island()?.hasAttribute('data-pinned')).toBe(false);
    expect(document.activeElement).toBe(island());
  });
});

describe('Island calendar: line-up', () => {
  const openCalendar = () => {
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="date-bar-open"]')?.click());
  };
  const calButton = (text: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  beforeEach(() => {
    lineUp.openLineUpFor.mockClear();
    lineUp.removeLineUp.mockClear();
    lineUpApp.setState({ store: {} as never });
  });
  afterEach(() => {
    lineUpApp.setState({ store: null });
  });

  it('offers Line up dates beside Compare the two dates, for the shown date', async () => {
    await render();
    openCalendar();
    expect(calButton('Compare the two dates')).toBeDefined();
    const line = calButton('Line up dates');
    expect(line).toBeDefined();
    act(() => line?.click());
    expect(lineUp.openLineUpFor).toHaveBeenCalledWith('nov');
    expect(island()?.dataset.state).toBe('rest');
    openCalendar();
    expect(calButton('Remove line-up')).toBeUndefined();
  });

  it('offers Remove line-up on a date that is lined up', async () => {
    const lined = {
      ...threeDates,
      captures: threeDates.captures.map((c) =>
        c.id === 'nov'
          ? { ...c, lineUp: { eastM: 1, northM: -2, with: 'oct', at: '2026-10-16T08:00:00Z' } }
          : c,
      ),
    };
    workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: lined });
    await render();
    openCalendar();
    act(() => calButton('Remove line-up')?.click());
    expect(lineUp.removeLineUp).toHaveBeenCalledWith('nov');
    expect(island()?.dataset.state).toBe('rest');
  });

  it('greys the line-up with its reason in a package and before the step is ready', async () => {
    const reasonOf = (b: HTMLButtonElement | undefined) =>
      document.getElementById(b?.getAttribute('aria-describedby') ?? '')?.textContent;
    lineUpApp.setState({ store: null });
    await render();
    openCalendar();
    let line = calButton('Line up dates');
    expect(line?.getAttribute('aria-disabled')).toBe('true');
    expect(reasonOf(line)).toBe('Line up dates is not ready yet.');
    act(() => line?.click());
    expect(lineUp.openLineUpFor).not.toHaveBeenCalled();
    key('Escape');
    lineUpApp.setState({ store: {} as never });
    shell.setState({ pkg: {} as never });
    try {
      openCalendar();
      line = calButton('Line up dates');
      expect(line?.getAttribute('aria-disabled')).toBe('true');
      expect(reasonOf(line)).toBe('This is a package: its files stay inside it.');
      act(() => line?.click());
      expect(lineUp.openLineUpFor).not.toHaveBeenCalled();
    } finally {
      shell.setState({ pkg: null });
    }
  });
});
