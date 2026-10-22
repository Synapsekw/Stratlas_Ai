// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoreBadge } from './ScoreBadge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
});
const chip = () => host.querySelector('.tag');

describe('ScoreBadge', () => {
  it('shows a score over the bar with the accent tone', () => {
    act(() => {
      root.render(<ScoreBadge score={0.93} threshold={0.8} unscored={false} />);
    });
    expect(chip()?.textContent).toBe('0.93');
    expect(chip()?.classList.contains('acc')).toBe(true);
  });

  it('says a score under the bar is under threshold', () => {
    act(() => {
      root.render(<ScoreBadge score={0.62} threshold={0.8} unscored={false} />);
    });
    expect(chip()?.textContent).toBe('0.62 · under threshold');
    expect(chip()?.classList.contains('acc')).toBe(false);
  });

  it('shows no score in the warn tone with a tip that says why', () => {
    act(() => {
      root.render(<ScoreBadge score={undefined} threshold={0.8} unscored />);
    });
    expect(chip()?.textContent).toBe('No score');
    expect(chip()?.classList.contains('warn')).toBe(true);
    const focus = host.querySelector<HTMLElement>('.det-vlm-focus');
    act(() => {
      focus?.focus();
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.body.textContent).toContain('The model gave no clear yes or no for this box.');
  });
});
