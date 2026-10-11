import type { AssetIndex } from '@aio/ai';
import { setActiveScene, type SceneHandle } from '@aio/engine';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAssetWarm } from './assetWarm';

const TANKS = ['T-101', 'T-102'];

/** A project with one model per list of tags. */
const manifest = (id: string, ...models: string[][]): ProjectManifest => ({
  schema: 'aio.project/1',
  id,
  name: `Tank farm ${id}`,
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: models.map((tags, i) => ({
    kind: 'mesh',
    id: `model-${String(i)}`,
    name: `Plant model ${String(i)}`,
    visible: true,
    src: { path: `models/plant-${String(i)}.glb` },
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    tags: tags.map((tag) => ({ node: tag, tag })),
  })),
  severityModels: [],
  classCatalogues: [],
});
const open = (id: string, ...models: string[][]) => {
  const m = manifest(id, ...(models.length > 0 ? models : [TANKS]));
  workspace.getState().openProject({ id, root: `E:/projects/${id}`, manifest: m });
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

/**
 * The asset index as it answers while the models load: `measured` says which tags have their
 * bounds at each try (the first is 1); `loading` while none has.
 */
function index(measured: (call: number) => readonly string[] = () => []) {
  let calls = 0;
  return {
    index: (): Pick<AssetIndex, 'status' | 'boxes'> => {
      const tags = measured(++calls);
      return {
        status: tags.length > 0 ? 'ready' : 'loading',
        boxes: tags.map((tag) => ({ tag, box: { min: [0, 0, 0], max: [1, 1, 1] } })),
      };
    },
    calls: () => calls,
  };
}
/** Every asset measured at once, from the given try on: one model that has loaded. */
const allAt =
  (first: number, tags: readonly string[] = TANKS) =>
  (call: number) =>
    call >= first ? tags : [];

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
    const i = index(allAt(3));
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
    const i = index(allAt(1));
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
    // nothing was measured, so the next time the 3D view mounts the minute starts again
    setActiveScene(null);
    setActiveScene(scene);
    expect(c.running()).toBe(1);
  });

  it('keeps asking while only some of the assets have their bounds', () => {
    const c = clock();
    // two models: the first is there at the second try, the other at the fifth
    const i = index((call) => (call >= 5 ? ['T-101', 'P-201'] : call >= 2 ? ['T-101'] : []));
    stop = startAssetWarm({ ...c, index: i.index });
    open('a', ['T-101'], ['P-201']);
    c.tick(4);
    // `ready` since the second try, with one asset of two
    expect(i.calls()).toBe(4);
    expect(c.running()).toBe(1);
    c.tick();
    expect(i.calls()).toBe(5);
    expect(c.running()).toBe(0);
    setActiveScene(null);
    setActiveScene(scene);
    expect(c.running()).toBe(0);
  });

  it('counts an asset tagged in two models once', () => {
    const c = clock();
    const i = index(allAt(1));
    stop = startAssetWarm({ ...c, index: i.index });
    // the same two tanks in the models of two survey dates: two boxes are all there is
    open('a', TANKS, TANKS);
    c.tick();
    expect(c.running()).toBe(0);
    setActiveScene(null);
    setActiveScene(scene);
    expect(c.running()).toBe(0);
  });

  it('ends after sixty tries for a tag that never gets its bounds, and does not start again', () => {
    const c = clock();
    // T-102 is tagged on a node that is in no model
    const i = index(allAt(1, ['T-101']));
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    c.tick(59);
    expect(c.running()).toBe(1);
    c.tick();
    expect(i.calls()).toBe(60);
    expect(c.running()).toBe(0);
    // the bounds there are were remembered: coming back to Scene does not run the minute again
    setActiveScene(null);
    setActiveScene(scene);
    expect(c.running()).toBe(0);
    workspace.getState().replaceManifest(manifest('a', TANKS));
    expect(c.running()).toBe(0);
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
    const i = index(allAt(2));
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
    const i = index(allAt(1));
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    c.tick();
    expect(c.running()).toBe(0);
    // leaving Scene and coming back, and the manifest saved again with the same tags
    setActiveScene(null);
    setActiveScene(scene);
    workspace.getState().replaceManifest(manifest('a', TANKS));
    expect(c.running()).toBe(0);
    expect(i.calls()).toBe(1);
  });

  it('asks again when the assets of the project are tagged anew', () => {
    const c = clock();
    const i = index(allAt(1, [...TANKS, 'T-103']));
    stop = startAssetWarm({ ...c, index: i.index });
    open('a');
    c.tick();
    expect(c.running()).toBe(0);
    workspace.getState().replaceManifest(manifest('a', [...TANKS, 'T-103']));
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
