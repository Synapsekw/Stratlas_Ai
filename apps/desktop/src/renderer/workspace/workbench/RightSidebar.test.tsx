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
import type * as ChangeModule from '../../change';
import { agentPane } from '../../agent/agentPaneStore';
import { measureStore } from '../../survey/measureStore';
import { RightSidebar, useSidebarSplit } from './RightSidebar';
import { useIslandLinked } from './view';
import { workbench } from './workbenchStore';
import { Drawer } from './Drawer';
import { drawerStore } from './drawerStore';

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
vi.mock('./benches/MeasureBench', () => ({ MeasureBench: () => <p>measure bench</p> }));
vi.mock('./benches/RfBench', () => ({ RfBench: () => <p>rf bench</p> }));
let trackReview = false;
let reviewOwners = 0;
let maxReviewOwners = 0;
vi.mock('./benches/ReviewBench', () => ({
  ReviewBench: () => {
    useEffect(() => {
      if (!trackReview) return;
      const shown = workspace.getState().isLayerVisible('review-base');
      reviewOwners++;
      maxReviewOwners = Math.max(maxReviewOwners, reviewOwners);
      workspace.getState().setLayerVisible('review-base', false);
      return () => {
        reviewOwners--;
        workspace.getState().setLayerVisible('review-base', shown);
      };
    }, []);
    return <p>engineering review bench</p>;
  },
}));
vi.mock('../../agent/AgentHost', () => ({
  AgentHost: ({ task }: { task?: string }) => (
    <p data-testid="agent-host" data-task={task}>
      agent
    </p>
  ),
}));
vi.mock('../../issueCard/IssueCard', () => ({ IssueCard: () => <p>issue card</p> }));
vi.mock('../SelectionCard', () => ({ SelectionCard: () => <p>selection</p> }));
vi.mock('../../road/RoadPanel', () => ({ RoadPanel: () => <p>road</p> }));
vi.mock('../../road/RoadSetup', () => ({ RoadSetupCard: () => null }));
vi.mock('../../survey/volumes/InventoryPane', () => ({
  useSeriesRun: () => undefined,
  useInventoryModel: () => null,
  inventoryOrder: () => [],
  VolumesEmpty: () => <p>volumes</p>,
  InventoryPane: () => <p>volumes</p>,
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
  trackReview = false;
  reviewOwners = 0;
  maxReviewOwners = 0;
  drawerStore.setState({ opened: null, present: false });
  localStorage.clear();
  splitPrefs.setState({ byId: {} });
  shell.getState().setRight(false);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  workbench.getState().reset();
  agentPane.getState().setMode('normal');
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({ status: 'idle' });
  measureStore.setState({ file: { schema: 'aio.measurements/1', measurements: [] } });
  workspace.getState().closeProject();
  vi.restoreAllMocks();
});

describe('RightSidebar', () => {
  it('gives a comparison one owner while moving through the drawer, including slide-out', () => {
    vi.useFakeTimers();
    trackReview = true;
    try {
      root = createRoot(host);
      act(() => {
        root?.render(
          <>
            <Scene />
            <Drawer />
          </>,
        );
      });
      act(() => {
        workbench.getState().open('review');
      });
      expect(reviewOwners).toBe(1);
      expect(workspace.getState().isLayerVisible('review-base')).toBe(false);
      act(() => {
        shell.getState().setRight(true);
        drawerStore.getState().open('click');
      });
      expect(reviewOwners).toBe(1);
      expect(maxReviewOwners).toBe(1);
      expect(workspace.getState().isLayerVisible('review-base')).toBe(false);
      act(() => {
        shell.getState().setRight(false);
      });
      expect(reviewOwners).toBe(1);
      expect(maxReviewOwners).toBe(1);
      expect(workspace.getState().isLayerVisible('review-base')).toBe(false);
      act(() => {
        vi.advanceTimersByTime(320);
      });
      expect(reviewOwners).toBe(1);
      expect(maxReviewOwners).toBe(1);
      expect(workspace.getState().isLayerVisible('review-base')).toBe(false);
      act(() => {
        workbench.getState().close('review');
      });
      expect(reviewOwners).toBe(0);
      expect(workspace.getState().isLayerVisible('review-base')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows model review inside its workbench tab beside the stage', () => {
    render();
    act(() => {
      workbench.getState().open('review');
    });
    expect(document.getElementById('wb-tab-review')?.textContent).toContain('Model review');
    expect(host.querySelector('[data-front="review"]')?.textContent).toContain(
      'engineering review bench',
    );
    expect(host.querySelector('[data-front="review"] .wb-bench-head')).not.toBeNull();
    expect(host.querySelector('[data-testid="agent-host"]')?.getAttribute('data-task')).toBe(
      'build',
    );
  });
  it('shows Volumes for a project with a volume measurement, without the stockpile kit', () => {
    render();
    expect(tabIds()).not.toContain('wb-tab-volumes');
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
    expect(volumetric.getState().status).toBe('idle');
    expect(tabIds()).toContain('wb-tab-volumes');
  });

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

  it('offers Show it for a tool tab waiting behind an issue edit, and brings it front (I-R52)', () => {
    render();
    expect(host.querySelector('[data-testid="wb-show-it"]')).toBeNull();
    act(() => {
      workbench.getState().open('measure');
      workbench.getState().show('selection');
      workbench.setState({ attention: 'measure', waiting: ['measure'] });
    });
    const note = host.querySelector<HTMLElement>('[data-testid="wb-show-it"]');
    expect(note?.textContent).toContain('Project');
    const button = [...(note?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Show it',
    );
    expect(button).toBeDefined();
    act(() => {
      button?.click();
    });
    expect(workbench.getState().front).toBe('measure');
    expect(workbench.getState().attention).toBeNull();
    expect(host.querySelector('[data-testid="wb-show-it"]')).toBeNull();
  });

  it('hides Volumes and Changes where the project has none', () => {
    render();
    expect(tabIds()).toEqual(['wb-tab-measure', 'wb-tab-selection', 'wb-tab-issues']);
  });

  it('labels the Measure bench tab Project, a fixed tab with its bench head and bench', () => {
    render();
    const tab = document.getElementById('wb-tab-measure');
    expect(tab?.textContent).toBe('Project');
    act(() => {
      tab?.click();
    });
    expect(workbench.getState().front).toBe('measure');
    const panel = host.querySelector('[role="tabpanel"]');
    expect(panel?.querySelector('.wb-bench-head')).not.toBeNull();
    expect(panel?.textContent).toContain('measure bench');
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

  it('brings the workbench back from the maximised agent when a tab is clicked (D22)', () => {
    render();
    act(() => {
      agentPane.getState().setMode('max');
    });
    expect(host.querySelector('[role="tabpanel"]')?.closest('[hidden]')).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')?.closest('[hidden]')).toBeNull();
    act(() => {
      document.getElementById('wb-tab-issues')?.click();
    });
    expect(agentPane.getState().mode).toBe('normal');
    expect(host.querySelector('[role="tabpanel"]')?.closest('[hidden]')).toBeNull();
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

  it('opens at least 470 px wide while the RF tab is in front, then returns', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('ws') ? new DOMRect(0, 0, 1000, 700) : new DOMRect();
    });
    render();
    expect(handle()?.getAttribute('aria-valuenow')).toBe('360');
    act(() => {
      workbench.getState().open('rf');
    });
    expect(document.body.textContent).toContain('rf bench');
    expect(ws()?.style.getPropertyValue('--split-min')).toBe('470px');
    expect(handle()?.getAttribute('aria-valuenow')).toBe('470');
    act(() => {
      workbench.getState().show('selection');
    });
    expect(handle()?.getAttribute('aria-valuenow')).toBe('360');
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

  it('opens the next volumetric project on Volumes too, straight from another', () => {
    act(() => {
      volumetric.setState({ status: 'ready' });
    });
    render();
    expect(workbench.getState().front).toBe('volumes');
    // another project opens; its volumes are ready without passing through idle
    act(() => {
      workspace.getState().openProject({ id: 'p4', root: '/p4', manifest: threeDates });
      workbench.getState().reset();
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
    expect(document.getElementById('wb-tab-measure')?.textContent).toContain('Project');
    expect(linked).toBe(true);
    act(() => {
      workbench.getState().show('issues');
    });
    expect(linked).toBe(false);
  });

  it('has a workbench heading above the bench, so the agent h3 follows an h2 (I-R45)', () => {
    render();
    const h2 = host.querySelector('aside.right h2');
    expect(h2?.textContent).toBe('Workbench');
    // it comes before the agent's heading in document order
    const h3 = host.querySelector('aside.right h3');
    if (h2 && h3) {
      expect(h2.compareDocumentPosition(h3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
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

  it('fills the Display tab with the Display bench', () => {
    // jsdom draws nothing (the street map probes a canvas)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render();
    act(() => {
      workbench.getState().open('display');
    });
    expect(host.querySelector('[data-testid="display-bench"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="wb-section-display-pins"]')).not.toBeNull();
  });

  it('shows the Point cloud tab and its Clean up tab only in a project with a cloud', () => {
    const cloud = {
      kind: 'pointcloud',
      id: 'scan',
      name: 'Scan',
      visible: true,
      src: { path: 'c.copc.laz' },
      format: 'copc',
    };
    render();
    act(() => {
      workbench.getState().open('clouds');
    });
    expect(tabIds()).not.toContain('wb-tab-clouds');
    act(() => {
      workspace.getState().openProject({
        id: 'pc',
        root: '/pc',
        manifest: { ...threeDates, layers: [...threeDates.layers, cloud] } as typeof threeDates,
      });
      workbench.getState().open('clouds');
    });
    expect(tabIds()).toContain('wb-tab-clouds');
    expect(host.querySelector('[data-testid="cloud-bench"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cloud-panel"]')).not.toBeNull();
  });

  it('opens the Point cloud tab when the panel is asked for, and unfolds the sidebar', () => {
    render();
    act(() => {
      shell.getState().setRight(true);
      shell.getState().setCloudPanel(true);
    });
    expect(shell.getState().rightCollapsed).toBe(false);
    expect(workbench.getState().front).toBe('clouds');
    act(() => {
      shell.getState().setCloudPanel(false);
    });
  });
});
