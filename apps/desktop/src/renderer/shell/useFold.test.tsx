// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFold, type Fold } from './useFold';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const seen: Fold[] = [];
/** The fold as the last render left it. */
const latest = (): Fold => {
  const f = seen.at(-1);
  if (!f) throw new Error('not rendered');
  return f;
};

function Probe({ folded }: { folded: boolean }) {
  const f = useFold(folded);
  useLayoutEffect(() => {
    seen.push(f);
  });
  return null;
}
const render = (folded: boolean) => {
  act(() => {
    root.render(<Probe folded={folded} />);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
});

describe('a panel that folds by transform', () => {
  it('keeps the layout open while it slides out, then snaps once', () => {
    render(false);
    render(true);
    expect(latest()).toMatchObject({ layoutFolded: false, phase: 'closing' });
    act(() => {
      latest().settle();
    });
    expect(latest()).toMatchObject({ layoutFolded: true, phase: null });
  });

  it('snaps the layout open at once, then slides in', () => {
    render(true);
    render(false);
    expect(latest()).toMatchObject({ layoutFolded: false, phase: 'opening' });
    act(() => {
      latest().settle();
    });
    expect(latest()).toMatchObject({ layoutFolded: false, phase: null });
  });

  it('settles on its own when the slide never reports its end', () => {
    render(false);
    render(true);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(latest()).toMatchObject({ layoutFolded: true, phase: null });
  });

  it('follows at once under reduced motion', () => {
    document.documentElement.dataset.motion = 'reduce';
    render(false);
    render(true);
    expect(latest()).toMatchObject({ layoutFolded: true, phase: null });
    render(false);
    expect(latest()).toMatchObject({ layoutFolded: false, phase: null });
  });

  it('does not slide a panel the person dragged into place', () => {
    render(false);
    act(() => {
      latest().snap(true);
    });
    render(true);
    expect(latest()).toMatchObject({ layoutFolded: true, phase: null });
  });
});
