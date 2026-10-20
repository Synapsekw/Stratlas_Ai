// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: true, value: [] }) },
  useShell: () => null,
}));
vi.mock('@aio/workspace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useWorkspace: (sel: (s: unknown) => unknown) =>
    sel({ project: { manifest: { captures: [], layers: [] } } }),
}));
vi.mock('./qaHelpers', () => ({
  useFocusCapture: () => 'c1',
  editFrom: () => null,
  ringOf: () => [],
}));

import { CleanupPanel } from './Cleanup';
import { qaStore } from './qaStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  document.body.innerHTML = '';
});

describe('the cleanup panel', () => {
  it('cleanup says Fill gaps, never TIN or Thin-plate', () => {
    qaStore.setState({
      surfaces: [{ id: 's1', name: 'S1', capture: 'c1', source: { kind: 'dsm' } } as never],
      edits: {
        schema: 'aio.terrain-edits/1',
        edits: [{ id: 'e1', kind: 'cleanup', surface: 's1', on: true, method: 'tin' } as never],
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(<CleanupPanel />);
    });
    const text = document.body.textContent;
    expect(text).toContain('Fill gaps: straight');
    expect(text).toContain('Fill gaps: smooth');
    expect(text).not.toMatch(/TIN|Thin-plate/);
    expect(document.querySelector('[data-testid="cleanup-method"]')).not.toBeNull();
  });
});
