// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoverageGrids } from './coverageGrids';
import { rfLayer } from './coverageDisplay';
import { clearCoverage, coverage } from './coverageStore';
import { resetRf, rfStore } from './rfStore';
import { StageCoverageLegend, useCoverageLegendShown } from './StageCoverageLegend';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function Probe() {
  const shown = useCoverageLegendShown();
  return (
    <div data-shown={shown ? 'yes' : 'no'}>
      <StageCoverageLegend />
    </div>
  );
}
const shown = () => host.querySelector('[data-shown]')?.getAttribute('data-shown');
const legend = () => host.querySelector('[data-testid="rf-legend"]');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  clearCoverage();
  resetRf();
  rfLayer.setState({ visible: true });
});

describe('the stage coverage legend', () => {
  it('shows while the layer is on and draws something, and not otherwise', () => {
    act(() => {
      root.render(<Probe />);
    });
    // nothing drawn yet
    expect(shown()).toBe('no');
    expect(legend()).toBeNull();
    act(() => {
      rfStore.setState({ dirty: true, view: 'rsrp' });
      coverage.setState({
        preview: { key: 'p1', source: 'preview', sectorIds: [] } as unknown as CoverageGrids,
      });
    });
    expect(shown()).toBe('yes');
    expect(legend()).not.toBeNull();
    for (const c of ['excellent', 'good', 'fair', 'poor', 'none'])
      expect(host.querySelector(`[data-testid="rf-legend-${c}"]`)).not.toBeNull();
    // the layer's eye off: no legend
    act(() => {
      rfLayer.setState({ visible: false });
    });
    expect(shown()).toBe('no');
    expect(legend()).toBeNull();
  });
});
