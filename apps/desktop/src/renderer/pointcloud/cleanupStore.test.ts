// @vitest-environment jsdom
import { createCleanupRecipes } from '@aio/pointcloud';
import { emptyCleanup, noiseCopyPath, type Layer, type PointcloudCleanup } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { createCleanup, isCleanable } from './cleanupStore';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge in tests' }) },
}));

const cloud = (id: string, format: 'copc' | 'png-packed' = 'copc'): Layer => ({
  kind: 'pointcloud',
  id,
  name: id,
  visible: true,
  src: { path: `clouds/${id}` },
  format,
});

const noiseOf = (id: string) => ({
  path: noiseCopyPath('a', id),
  params: { outlier: { meanK: 8, multiplier: 2 } },
  marked: 1,
  total: 2,
  runId: id,
});

function setup(
  recipes: PointcloudCleanup[] = [],
  opts: { readOnly?: boolean; fail?: boolean } = {},
) {
  const writes: {
    projectId: string;
    layerId: string;
    recipe: PointcloudCleanup | null;
    keep?: string[];
  }[] = [];
  const call = vi.fn<(channel: string, req: unknown) => Promise<unknown>>((channel, req) => {
    if (channel === 'pointcloud:readCleanup')
      return Promise.resolve({
        ok: true,
        value: { ok: true, recipes, readOnly: opts.readOnly ?? false },
      });
    if (channel === 'pointcloud:writeCleanup') {
      writes.push(req as (typeof writes)[number]);
      return Promise.resolve(
        opts.fail
          ? { ok: true, value: { ok: false, error: 'disk full' } }
          : { ok: true, value: { ok: true, trashed: [] } },
      );
    }
    return Promise.resolve({ ok: false, error: `unexpected ${channel}` });
  });
  const live = createCleanupRecipes();
  const c = createCleanup({ call: call as never, recipes: live, now: () => 1 });
  return { c, live, writes, call };
}

describe('the cleanup store', () => {
  it('knows which layers can be cleaned up', () => {
    expect(isCleanable(cloud('a'))).toBe(true);
    expect(isCleanable(cloud('b', 'png-packed'))).toBe(false);
  });

  it('load sweeps recipes whose layer is gone', async () => {
    const s = setup([emptyCleanup('a'), emptyCleanup('gone'), emptyCleanup('png')]);
    await s.c.load('p', [cloud('a'), cloud('png', 'png-packed')]);
    expect(Object.keys(s.c.store.getState().layers)).toEqual(['a']);
    expect(s.live.getState().recipes.a).toEqual(emptyCleanup('a'));
    // the recipe of a deleted layer is removed; a png-packed cloud's is only ignored
    expect(s.writes[0]).toEqual({ projectId: 'p', layerId: 'gone', recipe: null });
  });

  it('load writes each loaded recipe once, unchanged, to sweep old noise copies', async () => {
    const noise = noiseOf('j1');
    const loaded = { ...emptyCleanup('a'), noise };
    const s = setup([loaded, emptyCleanup('b')]);
    await s.c.load('p', [cloud('a'), cloud('b')]);
    expect(s.writes).toEqual([
      { projectId: 'p', layerId: 'a', recipe: loaded, keep: [noise.path] },
      { projectId: 'p', layerId: 'b', recipe: emptyCleanup('b'), keep: [] },
    ]);
    expect(s.c.store.getState().layers.a?.past).toEqual([]);
  });

  it('close lets the same project id load again', async () => {
    const s = setup([emptyCleanup('a')]);
    await s.c.load('p', [cloud('a')]);
    s.c.close();
    await s.c.load('p', [cloud('a')]);
    expect(s.call.mock.calls.filter((c) => c[0] === 'pointcloud:readCleanup')).toHaveLength(2);
  });

  it('a rejecting bridge call is a failed write and rolls the step back', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    s.call.mockImplementation(() => Promise.reject(new Error('ipc gone')));
    expect(await s.c.commit('a', emptyCleanup('a'))).toBe(false);
    expect(s.c.recipeOf('a')).toBeNull();
    expect(s.c.store.getState().notice?.text).toContain('ipc gone');
  });

  it('keeps the copy on the write of undo and redo after a first noise run', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    const noise = noiseOf('j1');
    const r1 = { ...emptyCleanup('a'), noise };
    await s.c.commit('a', r1, { kind: 'noise', count: 1 });
    await s.c.undo('a');
    await s.c.redo('a');
    expect(s.writes.map((w) => w.recipe)).toEqual([r1, null, r1]);
    expect(s.writes.map((w) => w.keep)).toEqual([[noise.path], [noise.path], [noise.path]]);
  });

  it('keeps the copy on the Reset write, so Undo of Reset finds it', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    const noise = noiseOf('j1');
    const r1 = { ...emptyCleanup('a'), noise };
    await s.c.commit('a', r1);
    await s.c.reset('a');
    await s.c.undo('a');
    expect(s.writes[1]).toMatchObject({ recipe: null, keep: [noise.path] });
    expect(s.writes[2]).toMatchObject({ recipe: r1 });
  });

  it('loads the recipes once per project id', async () => {
    const s = setup([emptyCleanup('a')]);
    await s.c.load('p', [cloud('a')]);
    await s.c.load('p', [cloud('a')]);
    expect(s.call.mock.calls.filter((c) => c[0] === 'pointcloud:readCleanup')).toHaveLength(1);
    await s.c.load('q', [cloud('a')]);
    expect(s.call.mock.calls.filter((c) => c[0] === 'pointcloud:readCleanup')).toHaveLength(2);
  });

  it('commits a step, shows it live and writes it; undo and redo write back', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    const r1 = { ...emptyCleanup('a'), hiddenClasses: [7] };
    expect(await s.c.commit('a', r1, { kind: 'deleted' })).toBe(true);
    expect(s.live.getState().recipes.a).toEqual(r1);
    expect(s.c.store.getState().notice).toMatchObject({ undo: true, error: false, layerId: 'a' });
    expect(await s.c.undo('a')).toBe(true);
    expect(s.live.getState().recipes.a).toBeUndefined();
    expect(await s.c.redo('a')).toBe(true);
    expect(s.writes.map((w) => w.recipe)).toEqual([r1, null, r1]);
  });

  it('a step equal to the present recipe is no undo step and no write', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    const r1 = { ...emptyCleanup('a'), hiddenClasses: [7] };
    await s.c.commit('a', r1);
    expect(await s.c.commit('a', { ...r1 })).toBe(true);
    expect(s.writes).toHaveLength(1);
    expect(s.c.store.getState().layers.a?.past).toHaveLength(1);
  });

  it('sends keep only when the step changes the noise copy', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    const noise = {
      path: noiseCopyPath('a', 'j1'),
      params: { outlier: { meanK: 8, multiplier: 2 } },
      marked: 1,
      total: 2,
      runId: 'j1',
    };
    await s.c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [3] });
    await s.c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [3], noise });
    await s.c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [4], noise });
    expect(s.writes.map((w) => w.keep)).toEqual([undefined, [noise.path], undefined]);
    await s.c.undo('a');
    await s.c.undo('a');
    expect(s.writes[4]?.keep).toEqual([noise.path]);
  });

  it('keeps the step out when the write fails, and says why', async () => {
    const s = setup([], { fail: true });
    await s.c.load('p', [cloud('a')]);
    expect(await s.c.commit('a', emptyCleanup('a'))).toBe(false);
    expect(s.c.recipeOf('a')).toBeNull();
    expect(s.live.getState().recipes.a).toBeUndefined();
    expect(s.c.store.getState().notice).toMatchObject({ error: true });
    expect(s.c.store.getState().notice?.text).toContain('disk full');
  });

  it("writes one layer's steps in order", async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    let release: () => void = () => undefined;
    const order: string[] = [];
    s.call.mockImplementation((channel: string, req: unknown) => {
      if (channel !== 'pointcloud:writeCleanup') return Promise.resolve({ ok: false, error: 'x' });
      const r = (req as { recipe: PointcloudCleanup }).recipe;
      order.push(`start ${String(r.hiddenClasses[0])}`);
      const done = () => {
        order.push(`end ${String(r.hiddenClasses[0])}`);
        return { ok: true, value: { ok: true, trashed: [] } };
      };
      return r.hiddenClasses[0] === 1
        ? new Promise((res) => {
            release = () => {
              res(done());
            };
          })
        : Promise.resolve(done());
    });
    const a = s.c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [1] });
    const b = s.c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [2] });
    await Promise.resolve();
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('previews live without a step or a write', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    s.c.preview('a', { ...emptyCleanup('a'), hiddenClasses: [3] });
    expect(s.live.getState().recipes.a?.hiddenClasses).toEqual([3]);
    expect(s.c.recipeOf('a')).toBeNull();
    expect(s.writes).toEqual([]);
  });

  it('shows the hidden notice for a hide selection', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    await s.c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [9] }, { kind: 'hidden' });
    expect(s.c.store.getState().notice).toMatchObject({ undo: true, layerId: 'a' });
    expect(s.c.store.getState().notice?.text).toBe('Points hidden in the view.');
  });

  it('refuses steps in a read-only package', async () => {
    const s = setup([emptyCleanup('a')], { readOnly: true });
    await s.c.load('pkg', [cloud('a')]);
    expect(await s.c.commit('a', null)).toBe(false);
    expect(s.writes).toEqual([]);
  });

  it('opens the panel on a layer and a section', () => {
    const s = setup();
    s.c.openPanel('a', 'noise');
    expect(s.c.store.getState()).toMatchObject({ panelOpen: true, active: 'a', section: 'noise' });
    s.c.closePanel();
    expect(s.c.store.getState().panelOpen).toBe(false);
  });
});
