// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_ACTIONS, type CleanupTarget } from './cleanupActions';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
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
});
