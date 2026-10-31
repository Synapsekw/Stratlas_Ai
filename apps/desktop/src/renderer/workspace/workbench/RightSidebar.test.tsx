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
import { panelBandOf, RIGHT_BANDS, rightSplitId } from './panelWidth';
import { readPanelPlace } from './tabsModel';
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
vi.mock('../../survey/MeasurementPanel', () => ({
  MeasurementPanel: () => <p>measurement card</p>,
}));
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
/** The sections the tab in front shows, by id. */
const sectionIds = () =>
  [...host.querySelectorAll<HTMLElement>('.wb-psec')].map((e) => e.dataset.section);
const sectionEl = (id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="panel-section-${id}"]`);
const clickTab = (id: string) => {
  act(() => {
    document.getElementById(`wb-tab-${id}`)?.click();
  });
};
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
  // the tab and its open sections outlive a project: each test starts where a new computer does
  const place = readPanelPlace(null, null);
  workbench.setState({ panel: place.tab, sections: place.open });
  agentPane.getState().setMode('normal');
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({ status: 'idle' });
  measureStore.setState({ file: { schema: 'aio.measurements/1', measurements: [] }, focus: null });
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
  it('shows model review in Tools > Engineering beside the stage', () => {
    render();
    act(() => {
      workbench.getState().open('review');
    });
    expect(workbench.getState().panel).toBe('tools');
    const section = sectionEl('tools.engineering');
    expect(section?.textContent).toContain('Engineering');
    expect(section?.getAttribute('data-open')).toBe('true');
    expect(host.querySelector('[data-front="review"]')?.textContent).toContain(
      'engineering review bench',
    );
    expect(host.querySelector('[data-front="review"] .wb-bench-head')).not.toBeNull();
    expect(host.querySelector('[data-testid="agent-host"]')?.getAttribute('data-task')).toBe(
      'build',
    );
  });
  it('shows Project > Volumes for a project with a volume measurement, without the stockpile kit', () => {
    render();
    clickTab('project');
    expect(sectionIds()).not.toContain('project.volumes');
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
    expect(sectionIds()).toContain('project.volumes');
  });

  it('renders the four fixed tabs in order, whatever the project holds', () => {
    const four = ['wb-tab-selection', 'wb-tab-tools', 'wb-tab-layers', 'wb-tab-project'];
    render();
    expect(tabIds()).toEqual(four);
    expect([...document.querySelectorAll('[role="tab"]')].map((e) => e.textContent)).toEqual([
      'Selection',
      'Tools',
      'Layers & display',
      'Project',
    ]);
    expect(document.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
      'Workbench',
    );
    expect(host.querySelector('[role="tabpanel"]')?.id).toBe('wb-panel-selection');
    act(() => {
      workbench.getState().open('measure');
    });
    expect(tabIds()).toEqual(four);
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('data-front')).toBe('tools');
    withVolumesAndDates();
    expect(tabIds()).toEqual(four);
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
    expect(note?.textContent).toContain('Measure');
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

  it('shows Volumes with piles, the digest and Changes with two dates, none where the project has neither', () => {
    render();
    clickTab('project');
    expect(sectionIds()).toEqual(['project.inThisProject', 'project.issues', 'project.jobs']);
    withVolumesAndDates();
    render();
    // with two dates the site digest leads the tab
    expect(sectionIds()).toEqual([
      'project.digest',
      'project.inThisProject',
      'project.volumes',
      'project.changes',
      'project.issues',
      'project.jobs',
    ]);
  });

  it('shows the Measure catalogue in Tools > Measure, with its bench head', () => {
    render();
    clickTab('tools');
    expect(workbench.getState().panel).toBe('tools');
    expect(workbench.getState().front).toBe('measure');
    const section = sectionEl('tools.measure');
    expect(section?.getAttribute('data-open')).toBe('true');
    expect(section?.querySelector('.wb-bench-head')).not.toBeNull();
    expect(section?.textContent).toContain('measure bench');
  });

  it("shows the tab's sections on a click, each body only while it is open", () => {
    render();
    expect(host.querySelector('[data-testid="selection-empty"]')).not.toBeNull();
    clickTab('project');
    expect(host.querySelector('[role="tabpanel"]')?.id).toBe('wb-panel-project');
    expect(document.getElementById('wb-tab-project')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-testid="issues-summary"]')).not.toBeNull();
    // a closed section keeps its header and mounts no body; a click on it opens it
    act(() => {
      sectionEl('project.issues')?.querySelector<HTMLButtonElement>('.wb-section-head')?.click();
    });
    expect(sectionEl('project.issues')?.getAttribute('data-open')).toBe('false');
    expect(host.querySelector('[data-testid="issues-summary"]')).toBeNull();
    act(() => {
      sectionEl('project.issues')?.querySelector<HTMLButtonElement>('.wb-section-head')?.click();
    });
    expect(host.querySelector('[data-testid="issues-summary"]')).not.toBeNull();
  });

  it("shows a picked measurement's card in Selection, and the hint once it is let go", () => {
    render();
    act(() => {
      measureStore.setState({ focus: 'line-1' });
    });
    const card = host.querySelector('[data-testid="selection-measurement"]');
    expect(card?.textContent).toBe('measurement card');
    expect(host.querySelector('[data-testid="selection-empty"]')).toBeNull();
    act(() => {
      measureStore.setState({ focus: null });
    });
    expect(host.querySelector('[data-testid="selection-measurement"]')).toBeNull();
    expect(host.querySelector('[data-testid="selection-empty"]')).not.toBeNull();
  });

  it('brings the workbench back from the maximised agent when a tab is clicked (D22)', () => {
    render();
    act(() => {
      agentPane.getState().setMode('max');
    });
    expect(host.querySelector('[role="tabpanel"]')?.closest('[hidden]')).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')?.closest('[hidden]')).toBeNull();
    clickTab('project');
    expect(agentPane.getState().mode).toBe('normal');
    expect(host.querySelector('[role="tabpanel"]')?.closest('[hidden]')).toBeNull();
  });

  it('keeps all four tabs on the row at 300 px, with no "More tabs"', () => {
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
    expect(tabIds()).toEqual([
      'wb-tab-selection',
      'wb-tab-tools',
      'wb-tab-layers',
      'wb-tab-project',
    ]);
    expect(host.querySelector('button[aria-label="More tabs"]')).toBeNull();
  });

  it("keeps the band's width across every tab; only Expand panel on Coverage widens it", () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('ws') ? new DOMRect(0, 0, 1000, 700) : new DOMRect();
    });
    const bandId = panelBandOf(window.innerWidth);
    const band = RIGHT_BANDS[bandId];
    const width = String(band.px);
    withVolumesAndDates();
    render();
    expect(handle()?.getAttribute('aria-valuenow')).toBe(width);
    for (const tab of ['tools', 'layers', 'project', 'selection']) {
      clickTab(tab);
      expect(handle()?.getAttribute('aria-valuenow'), tab).toBe(width);
    }
    act(() => {
      workbench.getState().show('volumes');
    });
    expect(handle()?.getAttribute('aria-valuenow')).toBe(width);
    // Coverage is a wide tool: its header offers Expand panel, which opens the band's widest
    act(() => {
      workbench.getState().open('rf');
    });
    expect(document.body.textContent).toContain('rf bench');
    expect(handle()?.getAttribute('aria-valuenow')).toBe(width);
    const expand = sectionEl('tools.coverage')?.querySelector<HTMLButtonElement>(
      '[data-testid="panel-expand"]',
    );
    expect(expand?.getAttribute('aria-label')).toBe('Expand panel');
    act(() => {
      expand?.click();
    });
    expect(ws()?.style.getPropertyValue('--split-min')).toBe(`${String(band.max)}px`);
    expect(handle()?.getAttribute('aria-valuenow')).toBe(String(band.max));
    act(() => {
      expand?.click();
    });
    expect(handle()?.getAttribute('aria-valuenow')).toBe(width);
    // the person's width was never overwritten
    expect(splitPrefs.getState().byId[rightSplitId(bandId)]?.size).toBeUndefined();
  });

  it('opens a volumetric project on Project > Volumes', () => {
    render();
    expect(workbench.getState().front).toBe('selection');
    act(() => {
      volumetric.setState({ status: 'ready' });
    });
    expect(workbench.getState().front).toBe('volumes');
    expect(workbench.getState().panel).toBe('project');
    expect(sectionEl('project.volumes')?.getAttribute('data-open')).toBe('true');
  });

  it('keeps a fresh project on Selection while its piles are read, and when it has none', () => {
    render();
    act(() => {
      volumetric.setState({ status: 'loading' });
    });
    expect(workbench.getState().panel).toBe('selection');
    act(() => {
      volumetric.setState({ status: 'none' });
    });
    expect(workbench.getState().panel).toBe('selection');
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

  it("links the island while the live tool's section is in front", () => {
    render();
    expect(linked).toBe(false);
    act(() => {
      live = [{ kind: 'tool', label: 'Distance', reading: null }];
      workbench.getState().toolStarted('measure');
    });
    expect(workbench.getState().panel).toBe('tools');
    expect(sectionEl('tools.measure')?.querySelector('.tab-live')).not.toBeNull();
    expect(linked).toBe(true);
    clickTab('project');
    expect(linked).toBe(false);
    clickTab('tools');
    expect(linked).toBe(true);
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

  it('shows the Point cloud sections only in a project with a cloud', () => {
    const cloud = {
      kind: 'pointcloud',
      id: 'scan',
      name: 'Scan',
      visible: true,
      src: { path: 'c.copc.laz' },
      format: 'copc',
    };
    render();
    clickTab('layers');
    expect(sectionIds()).not.toContain('layers.clouds');
    clickTab('tools');
    expect(sectionIds()).not.toContain('tools.pointcloud');
    act(() => {
      workspace.getState().openProject({
        id: 'pc',
        root: '/pc',
        manifest: { ...threeDates, layers: [...threeDates.layers, cloud] } as typeof threeDates,
      });
    });
    expect(sectionIds()).toContain('tools.pointcloud');
    act(() => {
      workbench.getState().open('clouds');
    });
    expect(workbench.getState().panel).toBe('layers');
    expect(sectionIds()).toContain('layers.clouds');
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
