// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultSurveySettings,
  MeasurementTool,
  type MeasurementFamily,
  type SurveyMeasurement,
} from '@aio/schema';
import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureStore } from '../measureStore';
import { qaStore } from '../qaStore';
import { QaSide } from '../Qa';
import { slotKinds, slotsFor, VertexTable, chartAgrees, type ChartKind } from './slots';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAMILY: Record<MeasurementTool, MeasurementFamily> = {
  elevation: 'point',
  'elevation-difference': 'point',
  'elevation-history': 'point',
  annotation: 'point',
  distance: 'line',
  grade: 'line',
  'vertex-table': 'line',
  'berm-check': 'line',
  section: 'line',
  azimuth: 'line',
  'antenna-tilt': 'line',
  clearance: 'line',
  area: 'polygon',
  volume: 'polygon',
  freehand: 'line',
};

const of = (tool: MeasurementTool): SurveyMeasurement => ({
  id: tool,
  family: FAMILY[tool],
  tool,
  label: tool,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 1],
    [10, 10, 2],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-20T00:00:00Z',
});

/** The spec's chart slot (W2): lines a profile, points elevation over time, volumes theirs. */
const SPEC: Record<MeasurementTool, ChartKind> = {
  distance: 'profile',
  grade: 'profile',
  'vertex-table': 'profile',
  'berm-check': 'profile',
  section: 'profile',
  elevation: 'elevation',
  'elevation-difference': 'elevation',
  annotation: 'elevation',
  'elevation-history': 'elevation',
  volume: 'volume',
  area: null,
  azimuth: null,
  'antenna-tilt': null,
  clearance: null,
  freehand: null,
};

/** The component a slot draws, by name. */
const drawn = (n: ReactNode): string | null => {
  if (!isValidElement(n)) return null;
  const type = (n as ReactElement).type;
  return typeof type === 'function' ? type.name : null;
};

describe('the card slots by tool', () => {
  it('each tool gets the chart from the spec table', () => {
    for (const tool of MeasurementTool.options) {
      expect([tool, slotKinds(tool).chart]).toEqual([tool, SPEC[tool]]);
      // the one chart rule (export, report) agrees with the slot table
      expect([tool, chartAgrees(tool)]).toEqual([tool, true]);
      const slots = slotsFor(of(tool), 'detail');
      const chart = drawn(slots.chart);
      if (SPEC[tool] === 'profile') expect(chart).toBe('LineProfile');
      else if (SPEC[tool] === 'elevation') expect(chart).toBe('ElevationOverTime');
      // a volume's chart is the over-time chart inside its detail
      else expect(chart).toBeNull();
    }
  });

  it('gives chips by type: surfaces on lines, dates on areas, none elsewhere', () => {
    expect(drawn(slotsFor(of('distance'), 'detail').chips)).toBe('LineChips');
    expect(drawn(slotsFor(of('area'), 'detail').chips)).toBe('AreaDates');
    for (const tool of ['elevation', 'azimuth', 'antenna-tilt', 'clearance', 'freehand'] as const)
      expect(slotsFor(of(tool), 'detail').chips).toBeUndefined();
  });

  it('puts the vertex table and the volume detail in the detail slot', () => {
    expect(drawn(slotsFor(of('vertex-table'), 'detail').detail)).toBe('VertexTable');
    expect(slotsFor(of('volume'), 'detail').detail).toBeDefined();
    expect(slotsFor(of('distance'), 'detail').detail).toBeUndefined();
  });

  it('gives the live card no chips, chart or detail', () => {
    for (const tool of MeasurementTool.options) expect(slotsFor(of(tool), 'live')).toEqual({});
  });
});

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  measureStore.setState({ settings: defaultSurveySettings() });
  qaStore.setState({ panel: null });
});

describe('the vertex table', () => {
  it('vertex table uses the formatter (imperial gives ft)', () => {
    const settings = defaultSurveySettings();
    measureStore.setState({
      settings: {
        ...settings,
        units: { ...settings.units, distance: 'ft' },
        angles: { angle: 'deg', bearing: 'deg', precision: 1 },
      },
    });
    act(() => {
      root = createRoot(host);
      root.render(<VertexTable m={of('vertex-table')} />);
    });
    const cells = [...host.querySelectorAll('tbody tr:first-child td')].map((c) => c.textContent);
    // 10 m east is 32.81 ft, due east is a bearing of 090.0°
    expect(cells[1]).toMatch(/^32\.8\d* ft$/);
    expect(cells[5]).toBe('090.0°');
  });
});

describe('Survey QA', () => {
  it('has no elevation history panel any more', () => {
    qaStore.setState({ panel: 'history' as never });
    act(() => {
      root = createRoot(host);
      root.render(<QaSide />);
    });
    expect(host.querySelector('[data-testid="elevation-history"]')).toBeNull();
    const src = readFileSync(join(import.meta.dirname, '..', 'Qa.tsx'), 'utf8');
    expect(src).not.toContain('ElevationHistory');
    expect(src).not.toMatch(/panel: 'history'/);
  });
});
