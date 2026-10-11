import type { AssetIndex } from '@aio/ai';
import { setActiveScene, type SceneHandle } from '@aio/engine';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAssetWarm } from './assetWarm';

const manifest = (id: string, tags: string[]): ProjectManifest => ({
  schema: 'aio.project/1',
  id,
  name: `Tank farm ${id}`,
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'mesh',
      id: 'plant',
      name: 'Plant model',
      visible: true,
      src: { path: 'models/plant.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      tags: tags.map((tag) => ({ node: tag, tag })),
    },
  ],
  severityModels: [],
  classCatalogues: [],
});
const open = (id: string, tags = ['T-101', 'T-102']) => {
  workspace.getState().openProject({ id, root: `E:/projects/${id}`, manifest: manifest(id, tags) });
};

/** The 3D view as the engine publishes it: all the warm-up needs to know is that it is there. */
const scene = {} as SceneHandle;

/** A clock the test turns by hand: every tick is one second for every running timer. */
function clock() {
  const timers = new Map<number, () => void>();
  const periods: number[] = [];
  let next = 1;
  return {
    setInterval: (run: () => void, ms: number) => {
      periods.push(ms);
      timers.set(next, run);
      return next++;
    },
    clearInterval: (timer: number) => {
      timers.delete(timer);
    },
    tick: (times = 1) => {
      for (let i = 0; i < times; i++) for (const run of [...timers.values()]) run();
    },
    running: () => timers.size,
    periods,
  };
}

/** The asset index as it answers while the model loads: `loading` until the given try. */
function index(readyAt = Infinity) {
  let calls = 0;
  return {
    index: (): Pick<AssetIndex, 'status'> => ({ status: ++calls >= readyAt ? 'ready' : 'loading' }),
    calls: () => calls,
  };
}

let stop: (() => void) | undefined;
beforeEach(() => {
  setActiveScene(scene);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  setActiveScene(null);
  workspace.getState().closeProject();
});

describe('warming the asset bounds', () => {
  it('asks once a second until the bounds are known, then stops', () => {
    const c = clock();
    const i = index(3);
    stop = startAssetWarm({ ...c, index: i.index });
    expect(c.running()).toBe(0);
    open('a');
    expect(c.running()).toBe(1);
    expect(c.periods).toEqual([1000]);
    // nothing is asked before the first second is over
    expect(i.calls()).toBe(0);
    c.tick(2);
    expect(i.calls()).toBe(2);
    expect(c.running()).toBe(1);
    c.tick();
    expect(i.calls()).toBe(3);
    expect(c.running()).toBe(0);
    c.tick(5);
    expect(i.calls()).toBe(3);
  });

  it('warms a project that is already open when it starts', () => {
    open('a');
    const c = clock();
    const i = index(1);
    stop = startAssetWarm({ ...c, index: i.index });
    expect(c.running()).toBe(1);
    c.tick();
    expect(i.calls()).toBe(1);
    expect(c.running()).toBe(0);
  });

  it('stops when the project changes, and starts over for the next one', () => {
    const c = clock();
    const i = index();
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    c.tick(59);
    expect(i.calls()).toBe(59);
    open('b');
    // one timer, and it is the new project's: it has its own sixty tries
    expect(c.running()).toBe(1);
    c.tick(59);
    expect(i.calls()).toBe(118);
    expect(c.running()).toBe(1);
    workspace.getState().closeProject();
    expect(c.running()).toBe(0);
    c.tick(3);
    expect(i.calls()).toBe(118);
  });

  it('gives up after sixty tries', () => {
    const c = clock();
    const i = index();
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    c.tick(59);
    expect(c.running()).toBe(1);
    c.tick();
    expect(i.calls()).toBe(60);
    expect(c.running()).toBe(0);
    c.tick(10);
    expect(i.calls()).toBe(60);
  });

  it('leaves a project without tagged assets alone', () => {
    const c = clock();
    const i = index();
    stop = startAssetWarm({ ...c, index: i.index });
    open('a', []);
    expect(c.running()).toBe(0);
    c.tick(3);
    expect(i.calls()).toBe(0);
  });

  it('waits for the 3D view: there is nothing to measure without it', () => {
    setActiveScene(null);
    const c = clock();
    const i = index(2);
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    expect(c.running()).toBe(0);
    // the person opens Scene a while later: the model starts loading then
    setActiveScene(scene);
    expect(c.running()).toBe(1);
    c.tick(2);
    expect(i.calls()).toBe(2);
    expect(c.running()).toBe(0);
  });

  it('stops when the 3D view goes, and has sixty new tries when it is back', () => {
    const c = clock();
    const i = index();
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    c.tick(40);
    setActiveScene(null);
    expect(c.running()).toBe(0);
    setActiveScene(scene);
    expect(c.running()).toBe(1);
    c.tick(59);
    expect(c.running()).toBe(1);
    c.tick();
    expect(i.calls()).toBe(100);
    expect(c.running()).toBe(0);
  });

  it('does not ask again once the bounds of the project are known', () => {
    const c = clock();
    const i = index(1);
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    c.tick();
    expect(c.running()).toBe(0);
    // leaving Scene and coming back, and the manifest saved again with the same tags
    setActiveScene(null);
    setActiveScene(scene);
    workspace.getState().replaceManifest(manifest('a', ['T-101', 'T-102']));
    expect(c.running()).toBe(0);
    expect(i.calls()).toBe(1);
  });

  it('asks again when the assets of the project are tagged anew', () => {
    const c = clock();
    const i = index(1);
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    c.tick();
    expect(c.running()).toBe(0);
    workspace.getState().replaceManifest(manifest('a', ['T-101', 'T-102', 'T-103']));
    expect(c.running()).toBe(1);
    c.tick();
    expect(i.calls()).toBe(2);
    expect(c.running()).toBe(0);
  });

  it('ends quietly when the index cannot be read', () => {
    const c = clock();
    let calls = 0;
    stop = startAssetWarm({
      ...c,
      index: () => {
        calls += 1;
        throw new Error('No project is open.');
      },
    });
    open('a');
    expect(() => {
      c.tick(3);
    }).not.toThrow();
    expect(calls).toBe(1);
    expect(c.running()).toBe(0);
  });

  it('stops for good when asked to', () => {
    const c = clock();
    const i = index();
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    expect(c.running()).toBe(1);
    stop();
    expect(c.running()).toBe(0);
    open('b');
    setActiveScene(null);
    setActiveScene(scene);
    expect(c.running()).toBe(0);
    expect(i.calls()).toBe(0);
  });
});
