// @vitest-environment jsdom
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AnnotateModule from '@aio/annotate';
import type * as ChangeModule from '../../../change';
import type * as StageToolsModule from '../../StageTools';
import type { JobRecord } from '@aio/schema';
import { roadStore } from '../../../road/store';
import { cardFocus } from '../../../issueCard/state';
import { jobs, shell } from '../../../shell';
import { annotateStage } from './annotateStage';
import { threeDates } from '../../__fixtures__/threeDates';
import { RightSidebar } from '../RightSidebar';
import { workbench } from '../workbenchStore';

// Where the benches sit in the sidebar: the front tab's body. The rest of the shell is stubbed.
vi.mock('../../compare', () => ({
  useCaptureIndex: () => ({ captures: [], layers: {} }),
}));
vi.mock('../../../shell/RightHeader', () => ({ RightHeader: () => null }));
vi.mock('../../../survey/TelecomTools', () => ({
  TelecomTools: () => null,
  useTelecomUnavailable: () => null,
}));
vi.mock('../../../agent/AgentHost', () => ({ AgentHost: () => <p>agent</p> }));
vi.mock('../../../issueCard/IssueCard', () => ({ IssueCard: () => <p>issue card</p> }));
vi.mock('../../SelectionCard', () => ({ SelectionCard: () => <p>selection</p> }));
vi.mock('../../../road/RoadPanel', () => ({ RoadPanel: () => <p>road panel</p> }));
vi.mock('../../../road/RoadSetup', () => ({ RoadSetupCard: () => null }));
vi.mock('../../../survey/volumes/InventoryPane', () => ({
  useSeriesRun: () => undefined,
  useInventoryModel: () => null,
  inventoryOrder: () => [],
  VolumesEmpty: () => <p data-testid="inventory">inventory</p>,
  InventoryPane: () => <p data-testid="inventory">inventory</p>,
}));
vi.mock('@aio/annotate', async (importOriginal) => ({
  ...(await importOriginal<typeof AnnotateModule>()),
  IssueRegister: () => <p>register</p>,
}));
vi.mock('../../../change', async (importOriginal) => ({
  ...(await importOriginal<typeof ChangeModule>()),
  ChangesTab: () => <p>changes</p>,
}));
// the 3D stage is not there: the panel tabs ask for it
vi.mock('../../StageTools', async (importOriginal) => ({
  ...(await importOriginal<typeof StageToolsModule>()),
  useEngineStage: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const runningJob: JobRecord = {
  id: 'j1',
  pipeline: 'photo.products',
  project: '/p3',
  status: 'running',
  progress: 0.4,
  params: {},
  steps: [{ name: 'mesh', title: 'Build the mesh', state: 'running' }],
  artifacts: [],
  createdAt: '2026-10-11T08:00:00.000Z',
  updatedAt: '2026-10-11T08:05:00.000Z',
};
let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<RightSidebar />);
  });
};
const front = () => host.querySelector('[role="tabpanel"]');
/** The open body of the section that shows an old tab id's bench. */
const body = (id: string) =>
  host.querySelector(`.wb-psec[data-body="${id}"][data-open="true"] .wb-psec-inner`);

beforeEach(() => {
  localStorage.clear();
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
  roadStore.setState(roadStore.getInitialState());
  workspace.getState().closeProject();
});

describe('the benches in the sidebar', () => {
  it('shows the Volumes bench in the fixed Volumes tab', () => {
    act(() => {
      volumetric.setState({ status: 'ready' });
    });
    render();
    act(() => {
      workbench.getState().show('volumes');
    });
    expect(front()?.querySelector('[data-testid="volumes-bench"]')).not.toBeNull();
    expect(front()?.querySelector('[data-testid="inventory"]')).not.toBeNull();
  });

  it('shows the Road bench, with Collapse all, in Project > Road', () => {
    render();
    act(() => {
      workbench.getState().open('road');
    });
    expect(front()?.getAttribute('data-front')).toBe('project');
    expect(body('road')?.querySelector('[data-testid="road-bench"]')).not.toBeNull();
    expect(body('road')?.querySelector('.wb-bench-head button')).not.toBeNull();
  });

  // (Video needs a project with flights, Environment and Cutaway the 3D stage, Clean up a cloud:
  // bench-scroll.spec.ts covers them in the app, on the layout itself)
  it('makes every bench the scroller of its section (the section body does not scroll)', () => {
    act(() => {
      jobs.setState({ jobs: [runningJob], logs: {} });
    });
    render();
    for (const id of ['display', 'annotate', 'jobs', 'measure', 'road'] as const) {
      act(() => {
        workbench.getState().open(id);
      });
      const benches = [...(body(id)?.children ?? [])].filter(
        (el) => !el.classList.contains('wb-bench-head'),
      );
      expect(
        benches.map((el) => el.classList.contains('wb-scroll')),
        id,
      ).toEqual([true]);
    }
    act(() => {
      jobs.setState({ jobs: [], logs: {} });
    });
  });

  it('a picked issue brings Selection forward through the sidebar, and the 3D tool stays on', () => {
    act(() => {
      shell.getState().setAnnotating(true);
    });
    render();
    act(() => {
      annotateStage.getState().setTool('point');
    });
    expect(front()?.getAttribute('data-front')).toBe('tools');
    expect(body('annotate')).not.toBeNull();
    // what picking an issue does: the card asks to come to the front (the sidebar's follow)
    act(() => {
      cardFocus.setState((s) => ({ seq: s.seq + 1, id: 'f01' }));
    });
    expect(front()?.getAttribute('data-front')).toBe('selection');
    expect(shell.getState().annotating).toBe(true);
    expect(annotateStage.getState().tool).toBe('point');
    expect(workbench.getState().tabs.find((t) => t.id === 'annotate')?.live).toBe(true);
    act(() => {
      shell.getState().setAnnotating(false);
      annotateStage.getState().setTool(null);
    });
  });

  it('shows Environment in Tools and Cutaway in Layers & display, open', () => {
    render();
    act(() => {
      workbench.getState().open('environment');
    });
    expect(front()?.getAttribute('data-front')).toBe('tools');
    const env = host.querySelector('[data-testid="panel-section-tools.environment"]');
    expect(env?.textContent).toContain('Environment');
    expect(env?.getAttribute('data-open')).toBe('true');
    act(() => {
      workbench.getState().open('cutaway');
    });
    expect(front()?.getAttribute('data-front')).toBe('layers');
    expect(
      host.querySelector('[data-testid="panel-section-layers.cutaway"]')?.getAttribute('data-open'),
    ).toBe('true');
  });
});
