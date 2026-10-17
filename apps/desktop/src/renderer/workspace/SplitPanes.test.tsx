// @vitest-environment jsdom
import { splitPrefs } from '@aio/ui';
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { Island } from './island/Island';
import { PaneHeader, SPLIT_ID, useSplit, useSplitDivider } from './SplitPanes';
import type { SplitPref } from './splitModel';
import { stagePrefs } from './stagePrefs';
import { timeline } from './timeline';

// the island's Compare dates and its compare tools are the stage's; not under test here
vi.mock('./CompareControls', () => ({
  useCompareDates: () => ({ available: true, twin: true, label: 'Leave', open: vi.fn() }),
  CompareButton: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

/** The stage in Split, as Stage.tsx lays it out: two panes with their headers, the divider. */
function SplitStage() {
  const split = useSplit();
  const { containerRef, handle } = useSplitDivider(true);
  return (
    <div className="stage" data-mode="split">
      <div ref={containerRef} className="stage-panes split" data-mode="split">
        <div className="pane" data-side="left" data-testid="left">
          <PaneHeader side="left" split={split} />
        </div>
        <div className="pane" data-side="right" data-testid="right">
          <PaneHeader side="right" split={split} />
        </div>
        {handle}
      </div>
      <Island stage={null} mode="split" tools="split" split={split} linked={false} />
    </div>
  );
}

const setSplit = (split: SplitPref) => {
  stagePrefs.getState().update('p', { split });
};

const render = async () => {
  root ??= createRoot(host);
  await act(async () => {
    root?.render(<SplitStage />);
    await Promise.resolve();
  });
};

const header = (side: 'left' | 'right') =>
  host.querySelector<HTMLElement>(`[data-testid="pane-chooser-${side}"]`);
const islandDay = () => host.querySelector('[data-testid="date-row"] .isl-day')?.textContent;
const focusPane = (side: 'left' | 'right') => {
  act(() => {
    host
      .querySelector(`[data-testid="${side}"]`)
      ?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
};
/** Alt+Arrow on the page; returns the event, to read whether the island took it. */
const altArrow = (key: 'ArrowLeft' | 'ArrowRight') => {
  const e = new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true });
  act(() => {
    document.body.dispatchEvent(e);
  });
  return e;
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  localStorage.clear();
  splitPrefs.setState({ byId: {} });
  timeline.setState({ byProject: {} });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p', root: '/p', manifest: threeDates });
  timeline.getState().attach('p', captureIndex(threeDates));
  setSplit({ left: '3d', right: '3d', leftCapture: 'oct', rightCapture: 'nov' });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
  vi.restoreAllMocks();
});

describe('the Split view', () => {
  it('gives each pane a header: its date, the view it shows and, on the right, the link', async () => {
    await render();
    for (const [side, date] of [
      ['left', '2 Oct 2024'],
      ['right', '6 Nov 2024'],
    ] as const) {
      const head = header(side);
      expect(head?.classList.contains('pane-head')).toBe(true);
      expect(head?.querySelector('[data-testid="pane-date"]')?.textContent).toBe(date);
      const select = head?.querySelector('select');
      expect(select?.selectedOptions[0]?.textContent).toBe('3D view');
    }
    expect(header('left')?.querySelector('[data-testid="compare-link"]')).toBeNull();
    const link = header('right')?.querySelector('[data-testid="compare-link"]');
    expect(link?.getAttribute('aria-pressed')).toBe('true');
    expect(link?.getAttribute('title')).toBeNull();
  });

  it('shows the focused pane date in the island, and the arrows step that pane', async () => {
    await render();
    focusPane('right');
    expect(islandDay()).toBe('6 Nov');
    focusPane('left');
    expect(islandDay()).toBe('2 Oct');
    // Alt+Left on the left pane: 4 Sep there, the right keeps 6 Nov
    const step = altArrow('ArrowLeft');
    expect(stagePrefs.getState().byProject.p?.split).toMatchObject({
      leftCapture: 'sep',
      rightCapture: 'nov',
    });
    expect(islandDay()).toBe('4 Sep');
    expect(header('left')?.querySelector('[data-testid="pane-date"]')?.textContent).toBe(
      '4 Sep 2024',
    );
    // and the date bar's own survey is not stepped: the island took the key, and App's Alt+Arrow
    // step runs only for a key no one took (App.tsx, !e.defaultPrevented)
    expect(step.defaultPrevented).toBe(true);
    expect(timeline.getState().focus).toBe('nov');
  });

  it('follows the other pane when the focused one shows no date', async () => {
    setSplit({ left: '3d', right: 'video', leftCapture: 'oct' });
    await render();
    focusPane('right');
    expect(islandDay()).toBe('2 Oct');
    expect(header('right')?.querySelector('[data-testid="pane-date"]')).toBeNull();
  });

  it('moves the divider with the arrow keys and keeps the share', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 }),
    );
    await render();
    const handle = host.querySelector<HTMLElement>('[role="separator"]');
    expect(handle?.getAttribute('aria-label')).toBe('Resize the two sides');
    expect(handle?.getAttribute('aria-orientation')).toBe('vertical');
    // the separator names the pane it sizes: the left one
    const controls = handle?.getAttribute('aria-controls') ?? '';
    expect(host.querySelector('[data-testid="left"]')?.id).toBe(controls);
    act(() => {
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(splitPrefs.getState().byId[SPLIT_ID]?.size).toBe(0.52);
    act(() => {
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    act(() => {
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(splitPrefs.getState().byId[SPLIT_ID]?.size).toBe(0.48);
    const panes = host.querySelector<HTMLElement>('.stage-panes');
    expect(panes?.style.getPropertyValue('--split-size')).toBe('48%');
  });
});
