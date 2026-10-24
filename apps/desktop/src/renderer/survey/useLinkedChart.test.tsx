// @vitest-environment jsdom
import type { ChartSeries } from '@aio/survey';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { linkedHover } from './linkedHover';
import { useLinkedChart, type LinkedChartProps } from './useLinkedChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const series = (key: string): ChartSeries => ({
  key,
  label: key,
  kind: 'current',
  chainage: [0, 10],
  z: [1, 2],
});
const A = series('a');
const B = series('b');

let root: Root | undefined;
let got: LinkedChartProps | null = null;
function Probe(p: { k: string; line: [number, number][]; s: ChartSeries[] }) {
  const props = useLinkedChart(p.k, p.line, p.s);
  useEffect(() => {
    got = props;
  });
  return null;
}
const draw = (k: string, line: [number, number][], s: ChartSeries[]) => {
  act(() => {
    root ??= createRoot(document.createElement('div'));
    root.render(<Probe k={k} line={line} s={s} />);
  });
};

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  linkedHover.setState({ hover: null, pin: null, fly: null });
});

describe('a chart joined to the linked hover', () => {
  it('keeps the pin when its series change, re-registering the new line', () => {
    const line: [number, number][] = [
      [0, 0],
      [10, 0],
    ];
    draw('measure:m', line, [A]);
    act(() => got?.onPinAt(4));
    expect(got?.pinnedAt).toBe(4);
    // a new render with equal values registers nothing new
    const first = linkedHover.getState().lines.get('measure:m');
    draw('measure:m', [...line], [A]);
    expect(linkedHover.getState().lines.get('measure:m')).toBe(first);
    // another date shown: a new line, the pin stays
    draw('measure:m', line, [A, B]);
    expect(linkedHover.getState().lines.get('measure:m')?.series).toEqual([A, B]);
    expect(linkedHover.getState().pin?.chainageM).toBe(4);
  });

  it('leaving the chart clears only its own hover; a double-click flies', () => {
    draw(
      'section',
      [
        [0, 0],
        [5, 5],
      ],
      [A],
    );
    act(() => {
      linkedHover.getState().setHover({ key: 'measure:x', chainageM: 1, source: '3d' });
    });
    expect(got?.hoverAt).toBeNull();
    act(() => got?.onHover(null));
    expect(linkedHover.getState().hover?.key).toBe('measure:x');
    act(() => got?.onHover(2));
    expect(got?.hoverAt).toBe(2);
    act(() => got?.onFly(3));
    expect(linkedHover.getState().fly).toMatchObject({ key: 'section', chainageM: 3 });
  });

  it('registers nothing without a line or a series', () => {
    draw('measure:none', [[0, 0]], [A]);
    expect(linkedHover.getState().lines.has('measure:none')).toBe(false);
  });
});
