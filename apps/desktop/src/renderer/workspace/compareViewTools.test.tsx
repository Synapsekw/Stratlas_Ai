// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPARE_VIEW_TOOLS, CompareViewControls } from './MapSwipe';
import type { SplitModel } from './SplitPanes';
import type { PaneKind } from './splitModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let stage: HTMLElement;
let panes: HTMLElement;
let bar: HTMLElement;

function Tool() {
  return <span data-testid="row-tool">tool</span>;
}

const split = (kind: PaneKind): SplitModel => ({
  options: [kind],
  sides: { left: kind, right: kind, leftCapture: 'd1', rightCapture: 'd2' },
  reports: [],
  index: null,
  dates: { captures: ['d1', 'd2'] },
  set: () => undefined,
});

describe('COMPARE_VIEW_TOOLS', () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver: the bar's stage view asks for one
    globalThis.ResizeObserver = class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
    };
    stage = document.body.appendChild(document.createElement('div'));
    stage.className = 'stage';
    bar = stage.appendChild(document.createElement('div'));
    panes = stage.appendChild(document.createElement('div'));
    panes.className = 'stage-panes';
    COMPARE_VIEW_TOOLS.push(Tool);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    stage.remove();
    COMPARE_VIEW_TOOLS.splice(COMPARE_VIEW_TOOLS.indexOf(Tool), 1);
  });

  const show = (s: SplitModel) => {
    root = createRoot(bar);
    act(() => root?.render(<CompareViewControls split={s} />));
  };

  it('ends the Side by side, Swipe and Blend row of two maps', () => {
    show(split('map'));
    const row = panes.querySelector('[data-testid="compare-view"]');
    expect(row?.lastElementChild?.getAttribute('data-testid')).toBe('row-tool');
    expect(panes.querySelectorAll('.compare-view')).toHaveLength(1);
  });

  it('has the row to itself with two 3D views', () => {
    show(split('3d'));
    expect(panes.querySelector('[data-testid="compare-view"]')).toBeNull();
    const row = panes.querySelector('[data-testid="compare-view-tools"]');
    expect(row?.querySelector('[data-testid="row-tool"]')).not.toBeNull();
  });
});
