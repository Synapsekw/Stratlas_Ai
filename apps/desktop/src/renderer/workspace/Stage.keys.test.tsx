// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { shell } from '../shell';
import { Island } from './island/Island';
import type * as LiveModule from './island/useIslandLive';
import { useSplit } from './SplitPanes';
import { useStageKeys } from './stageKeys';
import { timeline } from './timeline';
import { timelinePref } from './timelinePref';

// nothing is live here: the keys are under test, not the live line
vi.mock('./island/useIslandLive', async (importOriginal) => ({
  ...(await importOriginal<typeof LiveModule>()),
  useIslandLive: () => [],
}));
vi.mock('./CompareControls', () => ({
  useCompareDates: () => ({ available: false, twin: false, label: '', open: vi.fn() }),
  CompareButton: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

/** Just enough of the 3D stage for M: the tool it is on. */
function fakeEngine() {
  const engine = {
    tool: 'select',
    section: { enabled: false, mode: 'vertical' },
    setTool: vi.fn((tool: string) => {
      engine.tool = tool;
    }),
    setSection: vi.fn(),
    setViewPreset: vi.fn(),
    requestRender: vi.fn(),
  };
  return engine;
}
let engine = fakeEngine();

/** The stage as far as its keys go: the island and the stage shortcuts. */
function StageKeys({ stage }: { stage: EngineStage }) {
  useStageKeys(stage);
  return <Island stage={stage} mode="3d" tools="3d" split={useSplit()} linked={false} />;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  localStorage.clear();
  timeline.setState({ byProject: {} });
  timelinePref.setState({ byProject: {} });
  shell.getState().setStageMode('3d');
  engine = fakeEngine();
  host = document.createElement('div');
  host.innerHTML = `
    <input aria-label="Search tools" />
    <div contenteditable="true" aria-label="Issue notes"></div>
    <textarea aria-label="Message the agent"></textarea>
    <div class="stage-root"></div>`;
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const render = async () => {
  const at = host.querySelector<HTMLElement>('.stage-root');
  if (!at) throw new Error('no stage');
  root = createRoot(at);
  await act(async () => {
    root?.render(<StageKeys stage={engine as unknown as EngineStage} />);
    await Promise.resolve();
  });
};
const island = () => host.querySelector<HTMLElement>('.island-wrap');
const key = (k: string, target: Element | null) => {
  act(() => {
    target?.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
  });
};

describe('stage keys', () => {
  it('T opens the tools', async () => {
    await render();
    expect(island()?.dataset.state).toBe('rest');
    key('t', document.body);
    expect(island()?.dataset.state).toBe('tools');
    key('t', document.body);
    expect(island()?.dataset.state).toBe('rest');
  });

  it('stage keys ignore typing targets', async () => {
    await render();
    const targets = [
      host.querySelector('input'),
      host.querySelector('[contenteditable]'),
      host.querySelector('textarea[aria-label="Message the agent"]'),
    ];
    for (const target of targets) {
      key('t', target);
      key('m', target);
    }
    expect(island()?.dataset.state).toBe('rest');
    expect(engine.setTool).not.toHaveBeenCalled();
  });

  it('M still starts Measure a distance', async () => {
    await render();
    key('m', document.body);
    expect(engine.setTool).toHaveBeenLastCalledWith('measure');
    key('m', document.body);
    expect(engine.setTool).toHaveBeenLastCalledWith('select');
  });

  it('the timeline toggles from View', async () => {
    await render();
    key('t', document.body);
    const tile = host.querySelector<HTMLButtonElement>('[data-testid="timeline-toggle"]');
    // a project with video starts with the timeline shown
    expect(tile?.getAttribute('aria-pressed')).toBe('true');
    expect(tile?.getAttribute('aria-label')).toBe('Hide the timeline');
    act(() => tile?.click());
    expect(timelinePref.getState().byProject.p3).toBe(false);
    const after = host.querySelector<HTMLButtonElement>('[data-testid="timeline-toggle"]');
    expect(after?.getAttribute('aria-pressed')).toBe('false');
    expect(after?.getAttribute('aria-label')).toBe('Show the timeline');
  });

  it('says once that T now opens the tools', async () => {
    await render();
    key('t', document.body);
    const notice = () => host.querySelector('[data-testid="t-notice"]');
    expect(notice()?.textContent).toBe('T now opens the tools; the timeline is in View');
    key('t', document.body);
    key('t', document.body);
    expect(notice()).toBeNull();
    // not again after a restart
    act(() => root?.unmount());
    await render();
    key('t', document.body);
    expect(notice()).toBeNull();
  });
});
