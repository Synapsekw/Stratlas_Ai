// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeatGrid } from './engineProtocol';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: true, value: [] }) },
  useShell: () => null,
}));

import { HeatLegend, HeatmapStopsButton } from './HeatmapStops';
import { measureStore } from './measureStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
const render = (el: ReactElement) => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(el);
  });
};
const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  document.body.innerHTML = '';
});

const grid: HeatGrid = {
  item: 'i',
  x0: 0,
  y0: 0,
  cellM: 1,
  nx: 3,
  ny: 1,
  dz: new Float32Array([-0.5, 0, 0.5]),
  z: new Float32Array(3),
};

describe('the heat map legend', () => {
  it('legend shows values in the display unit', () => {
    const settings = measureStore.getState().settings;
    measureStore.setState({
      settings: { ...settings, units: { ...settings.units, distance: 'ft' } },
    });
    render(<HeatLegend style={settings.heatmap} grid={grid} />);
    const text = q('survey-heat-legend')?.textContent ?? '';
    expect(text).toContain('ft');
    expect(text).toContain('3.28');
    expect(q('survey-heat-histogram')?.children).toHaveLength(24);
  });

  it('stops editor opens from Edit colours', () => {
    render(<HeatmapStopsButton />);
    expect(q('survey-heat-stops')).toBeNull();
    const btn = q('survey-heat-colours');
    expect(btn?.textContent).toBe('Edit colours');
    act(() => {
      btn?.click();
    });
    expect(q('survey-heat-stops')).not.toBeNull();
  });
});
