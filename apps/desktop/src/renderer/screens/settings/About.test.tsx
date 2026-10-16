// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridge } from '../../shell';
import { About } from './About';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(async () => {
  vi.spyOn(bridge, 'call').mockResolvedValue({ ok: false, error: 'not in this test' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<About />);
    await Promise.resolve();
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
});

describe('About', () => {
  it('shows the brand symbol of the title bar, not a motion through other shapes', () => {
    const mark = host.querySelector('.about-lockup .lockup-mark');
    expect(mark?.querySelector('.mark-tail')).not.toBeNull();
    expect(mark?.querySelectorAll('.mark-piece').length).toBeGreaterThan(0);
    expect(host.querySelector('.about-lockup [data-piece]')).toBeNull();
  });
});
