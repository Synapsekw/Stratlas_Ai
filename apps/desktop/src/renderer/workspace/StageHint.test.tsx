// @vitest-environment jsdom
import { emptyMeasurements, type SurveyMeasurement } from '@aio/schema';
import type { ChartSeries } from '@aio/survey';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkedHover, type HoverLine } from '../survey/linkedHover';
import { measureStore } from '../survey/measureStore';
import { pileView } from '../survey/pile/pileView';
import { StageHint } from './StageHint';
import { workbench } from './workbench/workbenchStore';

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
  useShell: () => null,
  shell: { getState: () => ({ rightCollapsed: false }) },
}));
vi.mock('../issueCard/state', () => ({ isIssueEditing: () => false }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const series = (key: string, label: string, date: string): ChartSeries => ({
  key,
  label,
  kind: key === 'jan' ? 'current' : 'earlier',
  date,
  chainage: [0, 100],
  z: [10, 9],
});
const LINE: HoverLine = {
  key: 'pile:02',
  polyline: [
    [0, 5],
    [40, 5],
  ],
  series: [series('dec', '31 Dec', '2020-12-31'), series('jan', '10 Jan', '2021-01-10')],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  linkedHover.setState({ lines: new Map(), hover: null, pin: null, fly: null });
  measureStore.setState({
    file: { ...emptyMeasurements(), measurements: [PILE] },
    focus: null,
    selected: [],
  });
  pileView.setState({ tab: 'profile', axis: new Map() });
  if (!workbench.getState().tabs.some((t) => t.id === 'volumes'))
    workbench.getState().open('volumes');
  workbench.getState().show('volumes');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(<StageHint />);
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const hint = () => host.querySelector<HTMLElement>('[data-testid="stage-hint"]');

describe('StageHint', () => {
  it('the hint follows the state in that order', () => {
    expect(hint()).toBeNull();

    // a pile open on its Profile: the line's handles, then Esc
    act(() => {
      measureStore.setState({ focus: '02', selected: ['02'] });
    });
    expect(hint()?.dataset.kind).toBe('pile');
    expect(hint()?.textContent).toBe(
      'Profile line · Drag A or B to move it · drag ↻ to turn it about the pileEsc clears the selection',
    );
    act(() => {
      pileView.getState().setTab('history');
    });
    expect(hint()?.textContent).toBe('Esc clears the selection');

    // the pointer on the line beats the open pile
    act(() => {
      linkedHover.getState().register(LINE);
      linkedHover.getState().setHover({ key: 'pile:02', chainageM: 64, source: '3d' });
    });
    expect(hint()?.dataset.kind).toBe('snapped');
    expect(hint()?.textContent).toBe(
      'Pointer on the line · snapped to 64.0 m10 Jan · 31 Dec · the chart follows on the right',
    );

    // the chart hovered: following, with its legend
    act(() => {
      linkedHover.getState().setHover({ key: 'pile:02', chainageM: 42.3, source: 'chart' });
    });
    expect(hint()?.dataset.kind).toBe('following');
    expect(hint()?.textContent).toBe(
      'Following the chart10 Jan surface · where 31 Dec was · A to here',
    );

    // a pin beats them all
    act(() => {
      linkedHover.getState().setPin({ key: 'pile:02', chainageM: 71, source: 'chart' });
    });
    expect(hint()?.dataset.kind).toBe('pinned');
    expect(hint()?.textContent).toBe('Esc clears the pin · double-click to fly there');

    // a pin on a line no longer registered says nothing; the hover's own line still does
    act(() => {
      linkedHover.getState().setPin({ key: 'measure:gone', chainageM: 1, source: 'chart' });
    });
    expect(hint()?.dataset.kind).toBe('following');

    // nothing open, nothing hovered: no hint
    act(() => {
      linkedHover.setState({ hover: null, pin: null });
      measureStore.setState({ focus: null, selected: [] });
    });
    expect(hint()).toBeNull();
  });

  it('the hint does not catch clicks', () => {
    act(() => {
      measureStore.setState({ focus: '02', selected: ['02'] });
    });
    expect(hint()?.style.pointerEvents).toBe('none');
    expect(hint()?.getAttribute('role')).toBe('status');
  });

  it('a pile open behind another tab gives no hint', () => {
    act(() => {
      measureStore.setState({ focus: '02', selected: ['02'] });
      workbench.getState().open('measure');
      workbench.getState().show('measure');
    });
    expect(hint()).toBeNull();
  });
});
