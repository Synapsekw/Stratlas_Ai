// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '../../pointcloud/cleanupStore';
import { shell } from '../../shell';
import { threeDates } from '../__fixtures__/threeDates';
import { useBenchFollow } from './benchFollow';
import { workbench } from './workbenchStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

function Probe() {
  useBenchFollow();
  return null;
}

beforeEach(() => {
  shell.getState().setCloudPanel(false);
  shell.getState().setRight(true);
  cleanup.closePanel();
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  workbench.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<Probe />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

const front = () => workbench.getState().front;
const hasTab = (id: string) => workbench.getState().tabs.some((t) => t.id === id);

describe('useBenchFollow', () => {
  it('setCloudPanel(true) brings the clouds tab to the front and unfolds the sidebar', () => {
    act(() => {
      shell.getState().setCloudPanel(true);
    });
    expect(hasTab('clouds')).toBe(true);
    expect(front()).toBe('clouds');
    expect(shell.getState().rightCollapsed).toBe(false);
  });

  it('leaving the clouds tab clears the panel flag, so the next ask brings it back', () => {
    act(() => {
      shell.getState().setCloudPanel(true);
    });
    act(() => {
      workbench.getState().show('selection');
    });
    expect(shell.getState().cloudPanelOpen).toBe(false);
    act(() => {
      shell.getState().setCloudPanel(true);
    });
    expect(front()).toBe('clouds');
  });

  it('closing the clouds tab clears the flag', () => {
    act(() => {
      shell.getState().setCloudPanel(true);
    });
    act(() => {
      workbench.getState().close('clouds');
    });
    expect(shell.getState().cloudPanelOpen).toBe(false);
  });

  it('opening Clean up opens the cleanup tab, and closing the tab closes Clean up', () => {
    act(() => {
      cleanup.openPanel();
    });
    expect(hasTab('cleanup')).toBe(true);
    expect(front()).toBe('cleanup');
    act(() => {
      workbench.getState().close('cleanup');
    });
    expect(cleanup.store.getState().panelOpen).toBe(false);
  });

  it('closing Clean up from its panel closes the tab', () => {
    act(() => {
      cleanup.openPanel();
    });
    act(() => {
      cleanup.closePanel();
    });
    expect(hasTab('cleanup')).toBe(false);
    expect(front()).toBe('selection');
  });
});
