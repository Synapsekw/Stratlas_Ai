// @vitest-environment jsdom
import { matchShortcut, splitPrefs } from '@aio/ui';
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from '../__fixtures__/threeDates';
import { shell, useShell } from '../../shell';
import type { LiveItem } from '../island/islandModel';
import type * as LiveModule from '../island/useIslandLive';
import type * as AnnotateModule from '@aio/annotate';
import type * as VolumetricModule from '@aio/volumetric';
import type * as ChangeModule from '../../change';
import { RightSidebar, useIslandLinked, useSidebarSplit } from './RightSidebar';
import { workbench } from './workbenchStore';

// what is live comes from the stores in the app; here each test says what it is
let live: LiveItem[] = [];
vi.mock('../island/useIslandLive', async (importOriginal) => ({
  ...(await importOriginal<typeof LiveModule>()),
  useIslandLive: () => live,
}));
// two dates with data offer Changes
let dated = false;
vi.mock('../compare', () => ({
  useCaptureIndex: () =>
    dated
      ? { captures: [{ id: 'a' }, { id: 'b' }], layers: { a: ['x'], b: ['y'] } }
      : { captures: [], layers: {} },
}));
// the shell under test, not what each tab shows
vi.mock('../../shell/RightHeader', () => ({ RightHeader: () => null }));
vi.mock('../../survey/TelecomTools', () => ({ TelecomTools: () => null }));
vi.mock('../../agent/AgentHost', () => ({ AgentHost: () => <p>agent</p> }));
vi.mock('../../issueCard/IssueCard', () => ({ IssueCard: () => <p>issue card</p> }));
vi.mock('../SelectionCard', () => ({ SelectionCard: () => <p>selection</p> }));
vi.mock('../../road/RoadPanel', () => ({ RoadPanel: () => <p>road</p> }));
vi.mock('../../road/RoadSetup', () => ({ RoadSetupCard: () => null }));
vi.mock('@aio/volumetric', async (importOriginal) => ({
  ...(await importOriginal<typeof VolumetricModule>()),
  VolumesPanel: () => <p>volumes</p>,
}));
vi.mock('@aio/annotate', async (importOriginal) => ({
  ...(await importOriginal<typeof AnnotateModule>()),
  IssueRegister: () => <p>register</p>,
}));
vi.mock('../../change', async (importOriginal) => ({
  ...(await importOriginal<typeof ChangeModule>()),
  ChangesTab: () => <p>changes</p>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

/** The sidebar on its split, as the Scene lays it out. */
function Scene() {
  const collapsed = useShell((s) => s.rightCollapsed);
  const { containerRef, separatorProps } = useSidebarSplit(collapsed, true);
  return (
    <section ref={containerRef} className="ws">
      <div {...separatorProps} />
      <RightSidebar />
    </section>
  );
}

let linked: boolean | undefined;
function LinkProbe() {
  const l = useIslandLinked();
  useEffect(() => {
    linked = l;
  });
  return null;
}

const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(
      <>
        <Scene />
        <LinkProbe />
      </>,
    );
  });
};
const tabIds = () => [...document.querySelectorAll('[role="tab"]')].map((e) => e.id);
const ws = () => host.querySelector<HTMLElement>('.ws');
const handle = () => host.querySelector<HTMLElement>('[role="separator"]');

/** Volumes and Changes both exist, as in a volumetric project with two survey dates. */
const withVolumesAndDates = () => {
  dated = true;
  act(() => {
    volumetric.setState({ status: 'ready' });
  });
};

beforeEach(() => {
  live = [];
  dated = false;
  linked = undefined;
  localStorage.clear();
  splitPrefs.setState({ byId: {} });
  shell.getState().setRight(false);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  workbench.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({ status: 'idle' });
  workspace.getState().closeProject();
  vi.restoreAllMocks();
});

describe('RightSidebar', () => {
  it('renders the tabs in model order, Changes keeping its test id', () => {
    withVolumesAndDates();
    render();
    act(() => {
      workbench.getState().open('measure');
    });
    expect(tabIds()).toEqual([
      'wb-tab-measure',
      'wb-tab-selection',
      'wb-tab-issues',
      'wb-tab-volumes',
      'wb-tab-changes',
    ]);
    expect(document.getElementById('wb-tab-changes')?.dataset.testid).toBe('tab-changes');
    expect(document.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
      'Workbench',
    );
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('data-front')).toBe('measure');
  });

  it('hides Volumes and Changes where the project has none', () => {
    render();
    expect(tabIds()).toEqual(['wb-tab-selection', 'wb-tab-issues']);
  });

  it('shows the front tab content and follows a click', () => {
    render();
    expect(host.textContent).toContain('selection');
    act(() => {
      document.getElementById('wb-tab-issues')?.click();
    });
    expect(workbench.getState().front).toBe('issues');
    expect(host.textContent).toContain('register');
  });

  it('moves the tabs that do not fit at 300 px into "More tabs"', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('tabs') ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('tab-wrap') ? 80 : 0;
    });
    withVolumesAndDates();
    render();
    act(() => {
      workbench.getState().open('measure');
      workbench.getState().show('selection');
    });
    // fixed tabs leave first, the later first; Selection is in front and stays
    expect(tabIds()).toEqual(['wb-tab-measure', 'wb-tab-selection']);
    const more = host.querySelector<HTMLButtonElement>('button[aria-label="More tabs"]');
    expect(more?.textContent).toContain('3');
    act(() => {
      more?.click();
    });
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute('aria-label')).toBe('More tabs');
    const items = [...(menu?.querySelectorAll('[role^="menuitem"]') ?? [])].map(
      (e) => e.textContent,
    );
    expect(items).toEqual(['Issues · 0', 'Volumes · 0', 'Changes']);
  });

  it('opens at least 470 px wide while Volumes is in front, then returns', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('ws') ? new DOMRect(0, 0, 1000, 700) : new DOMRect();
    });
    withVolumesAndDates();
    render();
    act(() => {
      workbench.getState().show('selection');
    });
    expect(ws()?.style.getPropertyValue('--split-min')).toBe('280px');
    expect(handle()?.getAttribute('aria-valuenow')).toBe('360');
    act(() => {
      workbench.getState().show('volumes');
    });
    expect(ws()?.style.getPropertyValue('--split-min')).toBe('470px');
    expect(handle()?.getAttribute('aria-valuenow')).toBe('470');
    act(() => {
      workbench.getState().show('issues');
    });
    expect(handle()?.getAttribute('aria-valuenow')).toBe('360');
    // the person's width was never overwritten
    expect(splitPrefs.getState().byId['scene.right']?.size).toBeUndefined();
  });

  it('stops a drag at 470 px while Volumes is in front, and folds only past the usual point', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('ws') ? new DOMRect(0, 0, 1000, 700) : new DOMRect();
    });
    const pointer = (type: string, clientX: number) => {
      act(() => {
        handle()?.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }),
        );
      });
    };
    // the panel is the end pane: its edge moving right makes it narrower
    const drag = (by: number) => {
      pointer('pointerdown', 530);
      pointer('pointermove', 530 + by);
      pointer('pointerup', 530 + by);
    };
    withVolumesAndDates();
    render();
    act(() => {
      workbench.getState().show('volumes');
    });
    // 470 less 100 is 370: held at 470, not folded (it once folded below 422)
    drag(100);
    expect(handle()?.getAttribute('aria-valuenow')).toBe('470');
    expect(shell.getState().rightCollapsed).toBe(false);
    drag(220); // 250: still above the usual fold point, 280 less 48
    expect(shell.getState().rightCollapsed).toBe(false);
    drag(240); // 230: past it
    expect(shell.getState().rightCollapsed).toBe(true);
  });

  it('opens a volumetric project on Volumes', () => {
    render();
    expect(workbench.getState().front).toBe('selection');
    act(() => {
      volumetric.setState({ status: 'ready' });
    });
    expect(workbench.getState().front).toBe('volumes');
  });

  it('links the island while the live tool tab is in front', () => {
    render();
    expect(linked).toBe(false);
    act(() => {
      live = [{ kind: 'tool', label: 'Distance', reading: null }];
      workbench.getState().toolStarted('measure');
    });
    expect(document.getElementById('wb-tab-measure')?.textContent).toContain('Measure');
    expect(linked).toBe(true);
    act(() => {
      workbench.getState().show('issues');
    });
    expect(linked).toBe(false);
  });

  it('still folds with Ctrl+Alt+B', () => {
    const onKey = (e: KeyboardEvent) => {
      if (matchShortcut('global', e) === 'global.rightPanel') shell.getState().toggleRight();
    };
    window.addEventListener('keydown', onKey);
    render();
    const aside = host.querySelector('aside.right');
    expect(aside?.hasAttribute('inert')).toBe(false);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true }),
      );
    });
    window.removeEventListener('keydown', onKey);
    expect(shell.getState().rightCollapsed).toBe(true);
    expect(aside?.hasAttribute('inert')).toBe(true);
  });
});
