// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CutFillHint, HeatLegend } from './heatLegend';

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

  it('the hint asks for a pile click', () => {
    const el = render(<CutFillHint />);
    expect(el.textContent).toBe('Click a pile to see its change');
  });
});
