// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPanoPick, usePanoPick, type PanoPick } from './panoPickHook';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  setPanoPick(null);
});

describe('panoPickHook', () => {
  it('follows the armed callback and null when disarmed', () => {
    const seen: (PanoPick | null)[] = [];
    const Probe = () => {
      seen.push(usePanoPick());
      return null;
    };
    const root = createRoot(document.createElement('div'));
    act(() => {
      root.render(createElement(Probe));
    });
    expect(seen.at(-1)).toBeNull();
    const fn = vi.fn();
    act(() => {
      setPanoPick(fn);
    });
    expect(seen.at(-1)).toBe(fn);
    act(() => {
      setPanoPick(null);
    });
    expect(seen.at(-1)).toBeNull();
    act(() => {
      root.unmount();
    });
  });
});
