// @vitest-environment jsdom
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AnnotateModule from '@aio/annotate';
import type * as VolumetricModule from '@aio/volumetric';
import type * as ChangeModule from '../../../change';
import type * as StageToolsModule from '../../StageTools';
import { roadStore } from '../../../road/store';
import { threeDates } from '../../__fixtures__/threeDates';
import { RightSidebar } from '../RightSidebar';
import { workbench } from '../workbenchStore';

// Where the benches sit in the sidebar: the front tab's body. The rest of the shell is stubbed.
vi.mock('../../compare', () => ({
  useCaptureIndex: () => ({ captures: [], layers: {} }),
}));
vi.mock('../../../shell/RightHeader', () => ({ RightHeader: () => null }));
vi.mock('../../../survey/TelecomTools', () => ({ TelecomTools: () => null }));
vi.mock('../../../agent/AgentHost', () => ({ AgentHost: () => <p>agent</p> }));
vi.mock('../../../issueCard/IssueCard', () => ({ IssueCard: () => <p>issue card</p> }));
vi.mock('../../SelectionCard', () => ({ SelectionCard: () => <p>selection</p> }));
vi.mock('../../../road/RoadPanel', () => ({ RoadPanel: () => <p>road panel</p> }));
vi.mock('../../../road/RoadSetup', () => ({ RoadSetupCard: () => null }));
vi.mock('@aio/volumetric', async (importOriginal) => ({
  ...(await importOriginal<typeof VolumetricModule>()),
  VolumesPanel: () => <p data-testid="inventory">inventory</p>,
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
let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<RightSidebar />);
  });
};
const front = () => host.querySelector('[role="tabpanel"]');

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

  it('shows the Road bench, with Collapse all, in the Road tab', () => {
    render();
    act(() => {
      workbench.getState().open('road');
    });
    expect(front()?.getAttribute('data-front')).toBe('road');
    expect(front()?.querySelector('[data-testid="road-bench"]')).not.toBeNull();
    expect(front()?.querySelector('.wb-bench-head button')).not.toBeNull();
  });

  it('shows Environment and Cutaway as panel tabs', () => {
    render();
    act(() => {
      workbench.getState().open('environment');
    });
    expect(document.getElementById('wb-tab-environment')?.textContent).toContain('Environment');
    expect(front()?.getAttribute('data-front')).toBe('environment');
    act(() => {
      workbench.getState().open('cutaway');
    });
    expect(front()?.getAttribute('data-front')).toBe('cutaway');
    // an unpinned panel replaces the previous unpinned one
    expect(document.getElementById('wb-tab-environment')).toBeNull();
  });
});
