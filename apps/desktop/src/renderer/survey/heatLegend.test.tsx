// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSurveySettings, emptyMeasurements, type SurveyMeasurement } from '@aio/schema';
import { shell } from '../shell';
import { compareStore } from './compareStore';
import type { HeatGrid } from './engineProtocol';
import { CutFillHint, HeatLegend, ownHeatDrawn } from './heatLegend';
import { measureStore } from './measureStore';
import { pileLookState } from './pile/pileLookState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(el: React.ReactElement): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(el));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('the cut and fill heat legend', () => {
  it('the legend reads "Height change 10 Jan minus 31 Dec"', () => {
    const el = render(<HeatLegend from="2020-12-31" to="2021-01-10" thresholdM={0.1} rangeM={2} />);
    const legend = el.querySelector('[data-testid="cutfill-legend"]');
    expect(legend?.getAttribute('role')).toBe('group');
    expect(legend?.textContent).toContain('Height change');
    expect(legend?.textContent).toContain('10 Jan minus 31 Dec');
    expect(legend?.getAttribute('aria-label')).toBe('Height change 10 Jan minus 31 Dec');
  });

  it('the ramp reads −2.0 m cut, ±0.10 m ignored and +2.0 m fill with the Unicode minus', () => {
    const el = render(<HeatLegend from="2020-12-31" to="2021-01-10" thresholdM={0.1} rangeM={2} />);
    const ticks = [...el.querySelectorAll('.cf-legend-ticks > span')].map((s) => s.textContent);
    expect(ticks).toEqual(['−2.0 m cut', '±0.10 m ignored', '+2.0 m fill']);
  });

  it('without a threshold nothing is said to be ignored, and the range defaults to 2 m', () => {
    const el = render(<HeatLegend from="2020-12-31" to="2021-01-10" thresholdM={0} />);
    const ticks = [...el.querySelectorAll('.cf-legend-ticks > span')].map((s) => s.textContent);
    expect(ticks).toEqual(['−2.0 m cut', '', '+2.0 m fill']);
  });

  it('heights read in the project length unit', () => {
    const el = render(
      <HeatLegend
        from="2020-12-31"
        to="2021-01-10"
        thresholdM={0.3048}
        rangeM={0.6096}
        unit="ft"
      />,
    );
    const ticks = [...el.querySelectorAll('.cf-legend-ticks > span')].map((s) => s.textContent);
    expect(ticks).toEqual(['−2.0 ft cut', '±1.00 ft ignored', '+2.0 ft fill']);
  });

  it('without a unit given it takes the site units', () => {
    measureStore.setState({
      settings: {
        ...defaultSurveySettings(),
        units: { ...defaultSurveySettings().units, distance: 'us-ft' },
      },
    });
    try {
      const el = render(<HeatLegend from="2020-12-31" to="2021-01-10" thresholdM={0} />);
      expect(el.querySelector('.cf-legend-ticks')?.textContent).toContain('US ft cut');
    } finally {
      measureStore.setState({ settings: defaultSurveySettings() });
    }
  });

  describe("one pile's own heat map in focus", () => {
    const pile: SurveyMeasurement = {
      id: 'p1',
      family: 'polygon',
      tool: 'volume',
      label: 'North heap',
      scope: { kind: 'site' },
      points: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ],
      items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
      results: [],
      createdAt: '2026-11-18T00:00:00Z',
    };
    const grid: HeatGrid = {
      item: 'a',
      x0: 0,
      y0: 0,
      cellM: 1,
      nx: 1,
      ny: 1,
      dz: new Float32Array([1]),
      z: new Float32Array([1]),
    };
    const before = {
      mode: shell.getState().stageMode,
      compare: compareStore.getState(),
    };
    const focusPile = () => {
      measureStore.setState({
        file: { ...emptyMeasurements(), measurements: [pile] },
        selected: ['p1'],
        focus: 'p1',
      });
      compareStore.setState({
        computed: {
          p1: { ringKey: '', results: [], heat: [grid], shares: [], ms: 0, live: false },
        },
        heat: { show3d: true, show2d: true, contours: false, item: null },
        captures: [{ id: 'c2', label: '10 Jan 2021', date: '2021-01-10' }],
      });
    };
    afterEach(() => {
      measureStore.setState({ file: emptyMeasurements(), selected: [], focus: null });
      compareStore.setState({
        computed: before.compare.computed,
        heat: before.compare.heat,
        captures: before.compare.captures,
      });
      pileLookState.setState({ shown: null, hits: [] });
      shell.setState({ stageMode: before.mode });
    });
    const legend = () =>
      render(
        <HeatLegend from="2020-12-31" to="2021-01-10" thresholdM={0.1} rangeM={2} />,
      ).querySelector('[data-testid="cutfill-legend"]');

    it('on the Map the legend names the pile and the two sides of its own comparison', () => {
      focusPile();
      shell.setState({ stageMode: 'map' });
      const el = legend();
      expect(el?.textContent).toContain('North heap');
      expect(el?.textContent).toContain('Current survey');
      expect(el?.textContent).toContain('minus Toe surface');
      expect(el?.textContent).not.toContain('31 Dec');
      expect(el?.getAttribute('aria-label')).toContain('North heap');
      expect(el?.getAttribute('data-own')).toBe('p1');
      // the pile's heat map leaves nothing out: no ignored band
      const ticks = [...(el?.querySelectorAll('.cf-legend-ticks > span') ?? [])];
      expect(ticks.map((x) => x.textContent)).toEqual(['−2.0 m cut', '', '+2.0 m fill']);
    });

    it('in 3D the opened pile shows as its box and the site keeps its heat map: the pair', () => {
      focusPile();
      shell.setState({ stageMode: '3d' });
      pileLookState.setState({ shown: 'p1', hits: [] });
      const el = legend();
      expect(el?.textContent).toContain('10 Jan minus 31 Dec');
      expect(el?.textContent).not.toContain('North heap');
      expect(el?.hasAttribute('data-own')).toBe(false);
    });

    it('in 3D without the box (its heights still coming) the pile keeps its heat map', () => {
      focusPile();
      shell.setState({ stageMode: '3d' });
      expect(legend()?.textContent).toContain('North heap');
    });

    it('with the heat map switched off in a view, that view draws none of the pile', () => {
      const x = { own: true, mode: 'map', splitMap: true, show2d: true, show3d: true, boxed: true };
      expect(ownHeatDrawn({ ...x, mode: 'map' })).toBe(true);
      expect(ownHeatDrawn({ ...x, mode: 'map', show2d: false })).toBe(false);
      expect(ownHeatDrawn({ ...x, mode: '3d' })).toBe(false);
      expect(ownHeatDrawn({ ...x, mode: '3d', boxed: false })).toBe(true);
      expect(ownHeatDrawn({ ...x, mode: '3d', boxed: false, show3d: false })).toBe(false);
      // a Split: the Map pane draws the pile's, whatever the 3D pane shows
      expect(ownHeatDrawn({ ...x, mode: 'split' })).toBe(true);
      expect(ownHeatDrawn({ ...x, mode: 'split', splitMap: false })).toBe(false);
      expect(ownHeatDrawn({ ...x, own: false, mode: 'map' })).toBe(false);
    });
  });

  it('the hint asks for a pile click', () => {
    const el = render(<CutFillHint />);
    expect(el.textContent).toBe('Click a pile to see its change');
  });
});
