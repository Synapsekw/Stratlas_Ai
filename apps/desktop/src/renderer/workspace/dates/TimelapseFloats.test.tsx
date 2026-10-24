// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelapseBlendView, TimelapseTotalsView } from './TimelapseFloats';
import type { TimelapseDay } from './timelapse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A: TimelapseDay = {
  capture: 'a',
  t: Date.parse('2020-12-31'),
  label: '31 Dec 2020',
  short: '31 Dec',
  colour: 'var(--date-1)',
  volumeM3: 76199,
};
const B: TimelapseDay = { ...A, capture: 'b', label: '10 Jan 2021', short: '10 Jan' };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(node);
  });
  return host;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

describe('TimelapseBlendView', () => {
  const props = {
    passed: A,
    next: B,
    f: 0.55,
    between: 'crossfade' as const,
    kitSwipe: true,
    onBetween: vi.fn(),
  };

  it('names the two dates and the blend', () => {
    const el = render(<TimelapseBlendView {...props} />);
    expect(el.textContent).toContain('31 Dec and 10 Jan blend 55 %');
    expect(el.textContent).toContain('Between surveys');
  });

  it('Swipe is hidden without the kit', () => {
    const el = render(<TimelapseBlendView {...props} kitSwipe={false} />);
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Crossfade', 'Hold']);
  });

  it('offers Swipe with the kit and reports the choice', () => {
    const onBetween = vi.fn();
    const el = render(<TimelapseBlendView {...props} onBetween={onBetween} />);
    const buttons = [...el.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Crossfade', 'Swipe', 'Hold']);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      buttons[2]?.click();
    });
    expect(onBetween).toHaveBeenCalledWith('hold');
  });

  it('announces only a survey passed, never the blend percent of each frame', () => {
    const el = render(<TimelapseBlendView {...props} />);
    const live = el.querySelector('[role="status"]');
    expect(live?.textContent).toBe('31 Dec 2020 · last survey passed');
    const percent = [...el.querySelectorAll('span')].find((s) =>
      s.textContent.includes('blend 55 %'),
    );
    expect(percent?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(percent?.closest('[aria-live], [role="status"]')).toBeNull();
    act(() => {
      root?.render(<TimelapseBlendView {...props} f={0.7} />);
    });
    expect(el.querySelector('[role="status"]')).toBe(live);
    expect(live?.textContent).toBe('31 Dec 2020 · last survey passed');
    act(() => {
      root?.render(<TimelapseBlendView {...props} passed={B} next={null} f={0} />);
    });
    expect(el.querySelector('[role="status"]')?.textContent).toBe(
      '10 Jan 2021 · last survey passed',
    );
  });

  it('hold shows no blend', () => {
    const el = render(<TimelapseBlendView {...props} between="hold" />);
    expect(el.textContent).not.toContain('blend');
  });
});

describe('TimelapseTotalsView', () => {
  it('lists each survey in play with its total, never a value between them', () => {
    const el = render(
      <TimelapseTotalsView
        rows={[
          { capture: 'a', label: '31 Dec 2020', colour: 'red', volume: '76 199 m³' },
          { capture: 'b', label: '10 Jan 2021', colour: 'blue', volume: null },
        ]}
      />,
    );
    const rows = [...el.querySelectorAll('.tlx-row')].map((r) => r.textContent);
    expect(rows).toEqual(['31 Dec 202076 199 m³', '10 Jan 2021-']);
    expect(el.textContent).toContain('Figures change only at survey dates');
  });
});
