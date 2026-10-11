// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({ useJobs: () => [], useShell: () => null }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: () => null,
  workspace: { getState: () => ({ project: null }) },
}));

import { ChipView, chipText } from './ProcessingChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="processing-chip"]');

describe('what the chip says', () => {
  it('reads each state in plain words', () => {
    expect(chipText({ kind: 'idle' })).toBe('Processing');
    expect(chipText({ kind: 'one', pct: 40 })).toBe('Processing 40%');
    expect(chipText({ kind: 'many', count: 3 })).toBe('Processing · 3 running');
    expect(chipText({ kind: 'attention', count: 1 })).toBe('1 needs attention');
    expect(chipText({ kind: 'attention', count: 2 })).toBe('2 need attention');
    expect(chipText({ kind: 'elsewhere', count: 1 })).toBe('Processing · 1 running elsewhere');
  });
});

describe('the chip', () => {
  it('is not there when hidden', () => {
    act(() => {
      root = createRoot(host);
      root.render(<ChipView state={{ kind: 'hidden' }} open={false} onToggle={() => undefined} />);
    });
    expect(chip()).toBeNull();
  });

  it('is a button that says whether the drawer is open, and toggles it', () => {
    const onToggle = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(<ChipView state={{ kind: 'one', pct: 40 }} open={false} onToggle={onToggle} />);
    });
    expect(chip()?.textContent).toBe('Processing 40%');
    expect(chip()?.getAttribute('aria-expanded')).toBe('false');
    expect(chip()?.getAttribute('aria-controls')).toBe('processing-drawer');
    expect(chip()?.dataset.state).toBe('one');
    act(() => chip()?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('carries a warning mark when something needs attention', () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <ChipView
          state={{ kind: 'attention', count: 1 }}
          open={false}
          onToggle={() => undefined}
        />,
      );
    });
    expect(chip()?.dataset.state).toBe('attention');
    expect(chip()?.querySelector('svg')).not.toBeNull();
  });
});
