// @vitest-environment jsdom
import { emptyMeasurements, type SurveyMeasurement } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workbench } from '../workspace/workbench/workbenchStore';
import { linkedHover } from './linkedHover';
import { measureStore } from './measureStore';
import { attachStageEscape, escapeStage } from './stageEscape';

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
  useShell: () => null,
  shell: { getState: () => ({ rightCollapsed: false }) },
}));
vi.mock('../issueCard/state', () => ({ isIssueEditing: () => false }));

const PILE: SurveyMeasurement = {
  id: '02',
  family: 'polygon',
  tool: 'volume',
  label: 'Pile 02',
  scope: { kind: 'site' },
  points: [
    [0, 0, 5],
    [40, 0, 5],
    [40, 10, 5],
    [0, 10, 5],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-24T00:00:00Z',
};
const LINE = { key: 'pile:02', polyline: [], series: [] };

let detach: () => void;
beforeEach(() => {
  linkedHover.setState({
    lines: new Map([['pile:02', LINE]]),
    hover: null,
    pin: { key: 'pile:02', chainageM: 4, source: 'chart' },
    fly: null,
  });
  measureStore.setState({
    file: { ...emptyMeasurements(), measurements: [PILE] },
    focus: '02',
    selected: ['02'],
    draw: null,
    editing: null,
  });
  if (!workbench.getState().tabs.some((t) => t.id === 'volumes'))
    workbench.getState().open('volumes');
  workbench.getState().show('volumes');
  detach = attachStageEscape();
});
afterEach(() => {
  detach();
  document.body.innerHTML = '';
});

/** Esc pressed on `target` (the body by default); the event, to read whether it was taken. */
function esc(target: Element = document.body, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

describe('Esc on the stage', () => {
  it('clears the pin first, then lets go of the open pile, then does nothing', () => {
    expect(esc().defaultPrevented).toBe(true);
    expect(linkedHover.getState().pin).toBeNull();
    expect(measureStore.getState().focus).toBe('02');

    expect(esc().defaultPrevented).toBe(true);
    expect(measureStore.getState().focus).toBeNull();
    expect(measureStore.getState().selected).toEqual([]);

    expect(esc().defaultPrevented).toBe(false);
  });

  it('clears a pin from anywhere in the stage, the chart without focus', () => {
    const view = document.createElement('div');
    view.className = 'stage';
    document.body.append(view);
    expect(esc(view).defaultPrevented).toBe(true);
    expect(linkedHover.getState().pin).toBeNull();
  });

  it('a pin whose line has gone does not hold the Esc back from the pile', () => {
    linkedHover.setState({ lines: new Map() });
    expect(esc().defaultPrevented).toBe(true);
    expect(linkedHover.getState().pin).toBeNull();
    expect(measureStore.getState().focus).toBeNull();
  });

  it('leaves the Esc to whatever took it first', () => {
    // taken already (the chart with focus, the section window, a focus trap)
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    expect(linkedHover.getState().pin).not.toBeNull();

    // a field, a dialog, a menu
    const input = document.createElement('input');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inDialog = document.createElement('button');
    dialog.append(inDialog);
    document.body.append(input, dialog);
    expect(esc(input).defaultPrevented).toBe(false);
    expect(esc(inDialog).defaultPrevented).toBe(false);
    dialog.remove();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    expect(esc().defaultPrevented).toBe(false);
    menu.remove();

    // a measurement being drawn or edited
    measureStore.setState({ draw: {} as never });
    expect(esc().defaultPrevented).toBe(false);
    measureStore.setState({ draw: null, editing: {} as never });
    expect(esc().defaultPrevented).toBe(false);
    measureStore.setState({ editing: null });

    // a modifier
    expect(esc(document.body, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(linkedHover.getState().pin).not.toBeNull();
    expect(measureStore.getState().focus).toBe('02');
  });

  it('a pile open behind another tab is not let go', () => {
    linkedHover.setState({ pin: null });
    workbench.getState().open('measure');
    workbench.getState().show('measure');
    expect(esc().defaultPrevented).toBe(false);
    expect(measureStore.getState().focus).toBe('02');
  });

  it("escapeStage takes the panel's own way out after the pin", () => {
    const back = vi.fn(() => true);
    expect(escapeStage(back)).toBe(true);
    expect(back).not.toHaveBeenCalled();
    expect(escapeStage(back)).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
  });
});
