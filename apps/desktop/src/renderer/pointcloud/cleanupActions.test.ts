// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanupActionContext } from './cleanupActions';
import { cleanup } from './cleanupStore';

const view = vi.hoisted(() => {
  const v = {
    stageMode: 'map' as 'map' | '3d' | 'split',
    setStageMode: (m: 'map' | '3d' | 'split') => {
      v.stageMode = m;
    },
  };
  return v;
});

vi.mock('../shell', () => ({
  shell: {
    getState: () => ({
      pkg: null,
      stageMode: view.stageMode,
      setStageMode: view.setStageMode,
    }),
  },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge in tests' }) },
}));

describe('cleanup panel entry', () => {
  it('open the panel in the 3D view: from Map mode they switch to 3D first', () => {
    view.stageMode = 'map';
    const set = vi.spyOn(view, 'setStageMode');
    cleanupActionContext.openPanel('a', 'noise');
    expect(set).toHaveBeenCalledWith('3d');
    expect(view.stageMode).toBe('3d');
    expect(cleanup.store.getState()).toMatchObject({
      panelOpen: true,
      active: 'a',
      section: 'noise',
    });
    // already showing 3D, or split: the view stays as it is
    set.mockClear();
    view.stageMode = 'split';
    cleanupActionContext.openPanel('a');
    expect(set).not.toHaveBeenCalled();
    cleanup.closePanel();
  });
});
