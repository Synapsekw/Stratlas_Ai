// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_ACTIONS, cleanupActionContext, type CleanupTarget } from './cleanupActions';
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

const copc = {
  kind: 'pointcloud',
  id: 'a',
  name: 'a',
  visible: true,
  src: { path: 'x' },
  format: 'copc',
} as Layer;
const png = { ...copc, format: 'png-packed' } as Layer;
const ids = (t: CleanupTarget) => CLEANUP_ACTIONS.filter((a) => a.applies(t)).map((a) => a.id);

describe('cleanup action records', () => {
  it('are plain records with the shared action shape', () => {
    expect(CLEANUP_ACTIONS.map((a) => [a.id, a.label, a.multi])).toEqual([
      ['pointcloud.cleanup', 'cleanup.menu.open', false],
      ['pointcloud.removeNoise', 'cleanup.menu.noise', false],
      ['pointcloud.saveCleaned', 'cleanup.menu.save', false],
      ['pointcloud.resetCleanup', 'cleanup.menu.reset', false],
    ]);
  });

  it('apply to COPC clouds; editing ones not in a package; reset only with a recipe', () => {
    expect(ids({ layer: copc, readOnly: false, hasRecipe: true })).toHaveLength(4);
    expect(ids({ layer: copc, readOnly: false, hasRecipe: false })).not.toContain(
      'pointcloud.resetCleanup',
    );
    expect(ids({ layer: copc, readOnly: true, hasRecipe: true })).toEqual(['pointcloud.cleanup']);
    expect(ids({ layer: png, readOnly: false, hasRecipe: false })).toEqual([]);
  });

  it('open the panel at a section, or reset', async () => {
    const ctx = { openPanel: vi.fn(), reset: vi.fn(() => Promise.resolve(true)) };
    const t = { layer: copc, readOnly: false, hasRecipe: true };
    for (const a of CLEANUP_ACTIONS) await a.run(t, ctx);
    expect(ctx.openPanel.mock.calls).toEqual([['a'], ['a', 'noise'], ['a', 'save']]);
    expect(ctx.reset).toHaveBeenCalledWith('a');
  });

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
