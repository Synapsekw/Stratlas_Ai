// @vitest-environment jsdom
import type { ClipBoxLocal, EngineStage, PointSelection, StageTool } from '@aio/engine';
import { STATE, compileCleanup, createCleanupRecipes, evaluatePoint } from '@aio/pointcloud';
import { emptyCleanup, type ClipBox, type Layer } from '@aio/schema';
import type * as Ws from '@aio/workspace';
import { Matrix4, PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { boxToLocal, worldViewProj } from './cleanupFrame';
import { applyPending, cleanupKey, mountCleanupScene, selectionTest } from './cleanupScene';
import { createCleanup } from './cleanupStore';

const h = vi.hoisted(() => ({
  boxes: [] as {
    opts: { box: unknown; onChange(b: unknown, done: boolean): void };
    set: unknown[];
  }[],
  selects: [] as { opts: { onSelect(s: unknown): void; onCancel(): void } }[],
}));

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge in tests' }) },
}));
vi.mock('@aio/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Ws>();
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      getState: () => ({
        ...actual.workspace.getState(),
        project: { manifest: { origin: [500000, 3200000, 5] } },
      }),
    },
  };
});
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ClipBoxTool: class {
    set: unknown[] = [];
    constructor(
      _stage: unknown,
      readonly opts: { box: unknown; onChange(b: unknown, done: boolean): void },
    ) {
      h.boxes.push(this);
    }
    setBox(b: unknown) {
      this.set.push(b);
    }
    attach() {
      return () => undefined;
    }
    handleScreen() {
      return null;
    }
  },
  PointSelectTool: class {
    constructor(
      _stage: unknown,
      readonly opts: { onSelect(s: unknown): void; onCancel(): void },
    ) {
      h.selects.push(this);
    }
    setShape() {
      // the shape is not under test here
    }
    attach() {
      return () => undefined;
    }
  },
}));

const ORIGIN = [500000, 3200000, 5] as const;

const cloud = {
  kind: 'pointcloud',
  id: 'a',
  name: 'a',
  visible: true,
  src: { path: 'clouds/a.copc.laz' },
  format: 'copc',
} as Layer;
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function store() {
  const call = vi.fn((channel: string) =>
    Promise.resolve(
      channel === 'pointcloud:readCleanup'
        ? { ok: true, value: { ok: true, recipes: [], readOnly: false } }
        : { ok: true, value: { ok: true, trashed: [] } },
    ),
  );
  const c = createCleanup({ call: call as never, recipes: createCleanupRecipes(), now: () => 1 });
  await c.load('p', [cloud]);
  c.setActive('a');
  return c;
}

function fakeStage(tool: StageTool) {
  const listeners = new Set<() => void>();
  const stage = {
    tool,
    setTool(t: StageTool) {
      stage.tool = t;
      for (const l of listeners) l();
    },
    onStateChange(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return stage;
}

describe('the selection tools', () => {
  it('tests points against the drawn outline through the view of the time', () => {
    const inside = selectionTest(ID, [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ]);
    expect(inside(0, 0, 0)).toBe(true);
    expect(inside(0.9, 0, 0)).toBe(false);
    // behind the camera (w <= 0) is never selected
    const behind = selectionTest(
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0],
      [
        [-9, -9],
        [9, -9],
        [9, 9],
      ],
    );
    expect(behind(0, 0, 1)).toBe(false);
  });

  it('a region drawn in the local frame of a far origin selects the same points in world', () => {
    const cam = new PerspectiveCamera(50, 1.5, 0.1, 5000);
    cam.position.set(30, 40, 60);
    cam.lookAt(10, 0, -20);
    cam.updateMatrixWorld();
    const local = new Matrix4()
      .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      .toArray();
    const polygon: [number, number][] = [
      [-0.3, -0.4],
      [0.35, -0.2],
      [0.1, 0.45],
      [-0.25, 0.2],
    ];
    const inLocal = selectionTest(local, polygon);
    const world = compileCleanup({
      ...emptyCleanup('a'),
      regions: [
        {
          id: 'r',
          shape: 'lasso',
          viewProj: worldViewProj(local, ORIGIN),
          polygon,
          action: { kind: 'hide' },
        },
      ],
    });
    let hits = 0;
    let misses = 0;
    for (let i = 0; i < 40; i++)
      for (let j = 0; j < 40; j++) {
        const x = -40 + 2.25 * i;
        const y = (i * 7 + j * 3) % 11;
        const z = -80 + 2.5 * j;
        const sel = inLocal(x, y, z);
        const e = evaluatePoint(world, ORIGIN[0] + x, ORIGIN[1] - z, ORIGIN[2] + y, 2);
        expect(e.state === STATE.hidden).toBe(sel);
        if (sel) hits++;
        else misses++;
      }
    expect(hits).toBeGreaterThan(20);
    expect(misses).toBeGreaterThan(20);
  });

  it('turns the pending selection into one step with its notice', async () => {
    const c = await store();
    c.setPending({
      layerId: 'a',
      shape: 'lasso',
      polygon: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      viewProj: ID,
      count: 12,
    });
    expect(await applyPending(c, { kind: 'class', value: 6 }, () => 'r1')).toBe(true);
    expect(c.recipeOf('a')?.regions).toEqual([
      {
        id: 'r1',
        shape: 'lasso',
        viewProj: ID,
        polygon: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        action: { kind: 'class', value: 6 },
      },
    ]);
    expect(c.store.getState().pending).toBeNull();
    expect(c.store.getState().notice?.text).toBe('Class set to Building.');
  });

  it('refuses a 201st selection and says to save a cleaned copy', async () => {
    const c = await store();
    const regions = Array.from({ length: 200 }, (_, i) => ({
      id: `r${String(i)}`,
      shape: 'box' as const,
      viewProj: ID,
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ] as [number, number][],
      action: { kind: 'hide' as const },
    }));
    await c.commit('a', { ...emptyCleanup('a'), regions });
    c.setPending({
      layerId: 'a',
      shape: 'box',
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      viewProj: ID,
      count: 1,
    });
    expect(await applyPending(c, { kind: 'delete' })).toBe(false);
    expect(c.store.getState().notice).toMatchObject({ error: true });
    expect(c.recipeOf('a')?.regions).toHaveLength(200);
  });

  it('undoes and redoes with the keyboard while the panel or a tool is active', async () => {
    const c = await store();
    await c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [2] });
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(cleanupKey(key({ key: 'z', ctrlKey: true }), c, false)).toBe(false); // panel closed, no tool
    c.openPanel('a');
    expect(cleanupKey(key({ key: 'z', ctrlKey: true }), c, false)).toBe(true);
    await vi.waitFor(() => {
      expect(c.recipeOf('a')).toBeNull();
    });
    expect(cleanupKey(key({ key: 'Z', ctrlKey: true, shiftKey: true }), c, false)).toBe(true);
    await vi.waitFor(() => {
      expect(c.recipeOf('a')?.hiddenClasses).toEqual([2]);
    });
  });
});

describe('the stage tools on the active layer', () => {
  const clipBox: ClipBox = {
    // 0.3 - 5 + 5 is not 0.3 in floats: the world round trip alone would make a step
    center: [500012.37, 3200034.11, 0.3],
    size: [4, 6, 8],
    yaw: 0.3,
    keep: 'outside',
  };

  it('drives the clip box in the local frame; a release without change adds no step', async () => {
    h.boxes.length = 0;
    const c = await store();
    await c.commit('a', { ...emptyCleanup('a'), clipBox });
    const before = c.store.getState().layers.a;
    const stage = fakeStage('clipbox');
    const off = mountCleanupScene(stage as unknown as EngineStage, c);
    const tool = h.boxes[0];
    expect(tool?.opts.box).toEqual(boxToLocal(clipBox, ORIGIN));
    tool?.opts.onChange(tool.opts.box, true);
    await Promise.resolve();
    expect(c.store.getState().layers.a).toBe(before); // no undo step

    const moved = { ...(tool?.opts.box as ClipBoxLocal), yaw: 0.5 };
    tool?.opts.onChange(moved, false);
    expect(c.recipeOf('a')?.clipBox).toEqual(clipBox); // a drag only previews
    tool?.opts.onChange(moved, true);
    await vi.waitFor(() => {
      expect(c.recipeOf('a')?.clipBox?.yaw).toBe(0.5);
    });
    expect(c.recipeOf('a')?.clipBox?.keep).toBe('outside');

    // undo moves the gizmo back
    await c.undo('a');
    expect(tool?.set.at(-1)).toEqual(boxToLocal(clipBox, ORIGIN));
    off();
    expect(stage.tool).toBe('select');
  });

  it('stores a drawn selection with its view as world to clip', async () => {
    h.selects.length = 0;
    const c = await store();
    const stage = fakeStage('pcselect');
    const off = mountCleanupScene(stage as unknown as EngineStage, c);
    const local = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];
    const sel: PointSelection = {
      shape: 'box',
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      viewProj: local,
    };
    h.selects[0]?.opts.onSelect(sel);
    expect(c.store.getState().pending).toEqual({
      layerId: 'a',
      shape: 'box',
      polygon: sel.polygon,
      viewProj: worldViewProj(local, ORIGIN),
      count: 0,
    });
    h.selects[0]?.opts.onCancel();
    expect(c.store.getState().pending).toBeNull();
    expect(stage.tool).toBe('select');
    off();
  });
});
