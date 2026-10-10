// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ stageMode: 'split' }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge' }) },
  useShell: () => undefined,
}));

const { useRoadKeys } = await import('./RoadTools');
const { roadStore, setFilter } = await import('./store');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Keys() {
  useRoadKeys(true);
  return null;
}

let root: Root | null = null;
let stageKeys: ((e: KeyboardEvent) => void) | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  if (stageKeys) window.removeEventListener('keydown', stageKeys);
  stageKeys = null;
  roadStore.setState(roadStore.getInitialState());
});

const press = (key: string) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
  });
};

describe('road keys', () => {
  it('take their keys before the stage, also after the defect list changed', () => {
    root = createRoot(document.body.appendChild(document.createElement('div')));
    act(() => {
      root?.render(<Keys />);
    });
    // the stage's own keys, added after the road's as Stage.tsx adds them: what each key press
    // looked like when it reached them (already taken by the road, or not)
    const taken: boolean[] = [];
    stageKeys = (e) => {
      taken.push(e.defaultPrevented);
    };
    window.addEventListener('keydown', stageKeys);

    press('p');
    expect(roadStore.getState().overlay).toBe('pci');
    expect(taken).toEqual([true]);

    // a filter gives the road a new list of defects
    act(() => {
      setFilter({ search: 'pothole' });
    });
    // M is the road's map measure in split view, not the stage's 3D measure
    press('m');
    expect(roadStore.getState().measure.mode).toBe('line');
    expect(taken).toEqual([true, true]);
  });
});
