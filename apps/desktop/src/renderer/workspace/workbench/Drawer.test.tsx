// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from '../__fixtures__/threeDates';
import { shell } from '../../shell';
import type { LiveItem } from '../island/islandModel';
import type * as LiveModule from '../island/useIslandLive';
import { Drawer } from './Drawer';
import { drawerStore } from './drawerStore';
import { RightSidebar } from './RightSidebar';
import { workbench } from './workbenchStore';

let live: LiveItem[] = [];
vi.mock('../island/useIslandLive', async (importOriginal) => ({
  ...(await importOriginal<typeof LiveModule>()),
  useIslandLive: () => live,
}));
vi.mock('../compare', () => ({ useCaptureIndex: () => ({ captures: [], layers: {} }) }));
vi.mock('../../shell/RightHeader', () => ({ RightHeader: () => null }));
vi.mock('./benches/MeasureBench', () => ({
  MeasureBench: () => (
    <button type="button" data-testid="bench-probe">
      measure bench
    </button>
  ),
}));
vi.mock('../../agent/AgentHost', () => ({ AgentHost: () => <p>agent</p> }));
vi.mock('../../issueCard/IssueCard', () => ({ IssueCard: () => <p>issue card</p> }));
vi.mock('../SelectionCard', () => ({ SelectionCard: () => <p>selection</p> }));
vi.mock('../../road/RoadPanel', () => ({ RoadPanel: () => <p>road</p> }));
vi.mock('../../road/RoadSetup', () => ({ RoadSetupCard: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

function Stage() {
  return (
    <>
      <div className="island-wrap" role="toolbar" tabIndex={0} aria-label="Stage tools">
        <div className="island">
          <span data-testid="island-line">12.4 m</span>
          <button type="button">Tools</button>
        </div>
      </div>
      <Drawer />
      <RightSidebar />
    </>
  );
}
const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<Stage />);
  });
};
const drawer = () => host.querySelector<HTMLElement>('[data-testid="wb-drawer"]');
const island = () => host.querySelector<HTMLElement>('.island-wrap');
const startTool = () => {
  act(() => {
    workbench.getState().toolStarted('measure');
  });
};
const stopTool = () => {
  act(() => {
    workbench.getState().toolStopped('measure');
  });
};

beforeEach(() => {
  live = [];
  localStorage.clear();
  drawerStore.getState().close();
  shell.getState().setRight(true);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  workbench.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.getState().setRight(false);
  // a test that played a clip stops it here, so a failed assertion cannot leak it
  workspace.setState({ playing: false });
  workspace.getState().closeProject();
  vi.useRealTimers();
});

describe('Drawer', () => {
  it('stays out of the way while nothing is live and the sidebar is open', () => {
    render();
    expect(drawer()).toBeNull();
    shell.getState().setRight(false);
    startTool();
    expect(drawer()).toBeNull();
  });

  it('slides in with the front bench when a tool starts and the sidebar is hidden', () => {
    render();
    act(() => {
      workbench.getState().open('measure');
    });
    startTool();
    expect(drawer()?.dataset.open).toBe('');
    expect(drawer()?.getAttribute('data-front')).toBe('measure');
    expect(drawer()?.textContent).toContain('measure bench');
  });

  it('keeps one live copy of the bench: the folded sidebar steps aside while it shows (I-R38)', () => {
    vi.useFakeTimers();
    render();
    act(() => {
      workbench.getState().open('measure');
    });
    // the folded sidebar holds it until the drawer takes over
    expect(host.querySelectorAll('[data-testid="bench-probe"]')).toHaveLength(1);
    startTool();
    expect(host.querySelectorAll('[data-testid="bench-probe"]')).toHaveLength(1);
    expect(drawer()?.querySelector('[data-testid="bench-probe"]')).not.toBeNull();
    stopTool();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // closed, the sidebar has its bench again
    expect(drawer()).toBeNull();
    expect(host.querySelectorAll('[data-testid="bench-probe"]')).toHaveLength(1);
  });

  it('does not open for a playing clip or a running job (I-R39)', () => {
    render();
    live = [
      { kind: 'playback', clip: 'Flight', progress: 0.2, telemetry: null },
      { kind: 'job', id: 'j1', label: 'Processing', progress: 0.1, more: 0 },
    ];
    act(() => {
      workspace.setState({ playing: true });
    });
    render();
    expect(drawer()).toBeNull();
    expect(drawerStore.getState().opened).toBeNull();
  });

  it('has no agent pane', () => {
    render();
    startTool();
    expect(drawer()).not.toBeNull();
    expect(drawer()?.textContent).not.toContain('agent');
    expect(drawer()?.querySelector('.agent')).toBeNull();
  });

  it('slides out when the live item ends', () => {
    vi.useFakeTimers();
    render();
    startTool();
    expect(drawer()?.dataset.open).toBe('');
    stopTool();
    expect(drawer()?.dataset.open).toBeUndefined();
    expect(drawer()?.hasAttribute('inert')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(drawer()).toBeNull();
  });

  it('opens on a click on the island, traps focus, and Esc returns focus to the island', async () => {
    render();
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="island-line"]')?.click();
    });
    expect(drawer()?.dataset.open).toBe('');
    expect(drawer()?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      // the trap gives focus back once React has removed the focused control
      await Promise.resolve();
    });
    expect(drawer()?.dataset.open).toBeUndefined();
    expect(document.activeElement).toBe(island());
  });

  it('closes on Esc anywhere when a live start opened it', () => {
    render();
    startTool();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(drawer()?.dataset.open).toBeUndefined();
  });

  it('leaves Esc to what took it first: a defaultPrevented Esc keeps a live drawer open', () => {
    render();
    startTool();
    act(() => {
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      esc.preventDefault();
      window.dispatchEvent(esc);
    });
    expect(drawer()?.dataset.open).toBe('');
  });

  it('closes when the sidebar comes back', () => {
    render();
    startTool();
    act(() => {
      shell.getState().setRight(false);
    });
    expect(drawer()?.dataset.open).toBeUndefined();
  });

  it('does not open on the island when the sidebar is showing', () => {
    shell.getState().setRight(false);
    render();
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="island-line"]')?.click();
    });
    expect(drawer()).toBeNull();
  });
});
