import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { fakeWarmRenderer } from './fakeWarmRenderer';
import { drawnObjects, ProgramWarmup } from './programWarmup';

const camera = new PerspectiveCamera();
const scene = new Scene();
const geometry = new BoxGeometry();
const mesh = (name: string) => new Mesh(geometry, new MeshBasicMaterial({ name }));

/** A warm-up on a fake renderer, with the poll timer and the clock in the test's hands. */
function make(parallel: boolean) {
  const fake = fakeWarmRenderer({ parallel });
  let timer: (() => void) | null = null;
  let now = 0;
  const warmup = new ProgramWarmup(fake.renderer, {
    timeoutMs: 1000,
    now: () => now,
    schedule: (cb) => {
      timer = cb;
      return cb;
    },
    cancel: () => {
      timer = null;
    },
  });
  return {
    fake,
    warmup,
    armed: () => timer !== null,
    /** The poll timer fires (after `ms` more on the clock). */
    tick: (ms = 16) => {
      now += ms;
      const cb = timer;
      timer = null;
      cb?.();
    },
  };
}

/** Whether a promise has resolved, once the microtasks queued so far have run. */
async function settled(p: Promise<void> | null): Promise<boolean> {
  let done = false;
  void p?.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('ProgramWarmup with KHR_parallel_shader_compile', () => {
  it('resolves when the compiler is done, and asks about the program only then', async () => {
    const { fake, warmup, tick } = make(true);
    const wait = warmup.compile(mesh('a'), camera, scene);
    expect(wait).not.toBeNull();
    expect(warmup.pending).toBe(1);
    // the view keeps drawing what it had: nothing holds its frames
    expect(warmup.holdsFrames).toBe(false);
    expect(fake.fences).toHaveLength(0);
    tick();
    tick();
    expect(await settled(wait)).toBe(false);
    // asking now would wait for the compiler: that is the freeze
    expect(fake.programs[0]?.asked).toBe(0);
    fake.finish();
    tick();
    expect(await settled(wait)).toBe(true);
    expect(fake.programs[0]?.asked).toBe(1);
    expect(warmup.pending).toBe(0);
  });

  it('answers null when every program exists already', async () => {
    const { fake, warmup, tick, armed } = make(true);
    const first = warmup.compile(mesh('a'), camera, scene);
    fake.finish();
    tick();
    expect(await settled(first)).toBe(true);
    expect(warmup.compile(mesh('a'), camera, scene)).toBeNull();
    expect(fake.programs).toHaveLength(1);
    expect(armed()).toBe(false);
  });

  it('answers null for a program that is linked at once (the driver had it cached)', () => {
    const fake = fakeWarmRenderer({ parallel: true, instant: true });
    const warmup = new ProgramWarmup(fake.renderer);
    expect(warmup.compile(mesh('a'), camera, scene)).toBeNull();
    // asked here, outside a frame
    expect(fake.programs[0]?.asked).toBe(1);
    expect(warmup.pending).toBe(0);
  });

  it('makes a second object wait for a program the first one started', async () => {
    const { fake, warmup, tick } = make(true);
    const a = warmup.compile(mesh('a'), camera, scene);
    const b = warmup.compile(mesh('a'), camera, scene);
    expect(fake.programs).toHaveLength(1);
    expect(b).not.toBeNull();
    tick();
    expect(await settled(b)).toBe(false);
    fake.finish();
    tick();
    expect(await settled(a)).toBe(true);
    expect(await settled(b)).toBe(true);
    expect(fake.programs[0]?.asked).toBe(1);
  });

  it('waits for every program of an object', async () => {
    const { fake, warmup, tick } = make(true);
    const group = new Group().add(mesh('a'), mesh('b'));
    const wait = warmup.compile(group, camera, scene);
    const [a, b] = fake.programs;
    if (!a || !b) throw new Error('two programs expected');
    a.ready = true;
    tick();
    expect(await settled(wait)).toBe(false);
    expect(a.asked).toBe(1);
    b.ready = true;
    tick();
    expect(await settled(wait)).toBe(true);
  });

  it('lets go of a program that is deleted while it compiles', async () => {
    const { fake, warmup, tick } = make(true);
    const wait = warmup.compile(mesh('a'), camera, scene);
    const p = fake.programs[0];
    if (!p) throw new Error('a program expected');
    // the object was removed and its material disposed
    fake.destroy(p);
    tick();
    expect(await settled(wait)).toBe(true);
    expect(p.asked).toBe(0);
    expect(warmup.pending).toBe(0);
  });

  it('gives up after the timeout and lets the object be drawn the old way', async () => {
    const { fake, warmup, tick, armed } = make(true);
    const wait = warmup.compile(mesh('a'), camera, scene);
    tick(500);
    expect(await settled(wait)).toBe(false);
    tick(600);
    expect(await settled(wait)).toBe(true);
    expect(fake.programs[0]?.asked).toBe(0);
    expect(armed()).toBe(false);
    // the next object is made ahead again
    expect(warmup.compile(mesh('b'), camera, scene)).not.toBeNull();
  });
});

describe('ProgramWarmup without the extension (a software renderer)', () => {
  it('holds the frames until a fence after the compile is reached, then asks', async () => {
    const { fake, warmup, tick } = make(false);
    const wait = warmup.compile(mesh('a'), camera, scene);
    expect(wait).not.toBeNull();
    expect(fake.fences).toHaveLength(1);
    // the commands leave for the graphics process at once
    expect(fake.flushes).toBe(1);
    expect(warmup.holdsFrames).toBe(true);
    tick();
    expect(await settled(wait)).toBe(false);
    expect(fake.programs[0]?.asked).toBe(0);
    fake.reach();
    tick();
    expect(await settled(wait)).toBe(true);
    expect(fake.programs[0]?.asked).toBe(1);
    expect(warmup.holdsFrames).toBe(false);
    expect(fake.fences[0]?.deleted).toBe(true);
  });

  it('places no second fence for a program that is already on its way', async () => {
    const { fake, warmup, tick } = make(false);
    const a = warmup.compile(mesh('a'), camera, scene);
    const b = warmup.compile(mesh('a'), camera, scene);
    expect(fake.fences).toHaveLength(1);
    fake.reach();
    tick();
    expect(await settled(a)).toBe(true);
    expect(await settled(b)).toBe(true);
    expect(warmup.compile(mesh('a'), camera, scene)).toBeNull();
    expect(warmup.holdsFrames).toBe(false);
  });

  it('keeps one fence for the programs made together and deletes it with the last', async () => {
    const { fake, warmup, tick } = make(false);
    const wait = warmup.compile(new Group().add(mesh('a'), mesh('b')), camera, scene);
    expect(fake.fences).toHaveLength(1);
    fake.reach();
    tick();
    expect(await settled(wait)).toBe(true);
    expect(fake.programs.map((p) => p.asked)).toEqual([1, 1]);
    expect(fake.fences[0]?.deleted).toBe(true);
  });

  it('stops trusting fences when one is never reached', async () => {
    const { fake, warmup, tick } = make(false);
    const wait = warmup.compile(mesh('a'), camera, scene);
    tick(1100);
    expect(await settled(wait)).toBe(true);
    // frames are drawn again, and nothing is held back a second time
    expect(warmup.holdsFrames).toBe(false);
    expect(fake.fences[0]?.deleted).toBe(true);
    expect(warmup.compile(mesh('b'), camera, scene)).toBeNull();
    expect(fake.fences).toHaveLength(1);
  });

  it('answers null when the context makes no fence', () => {
    const { fake, warmup } = make(false);
    fake.renderer.getContext().fenceSync = () => null;
    expect(warmup.compile(mesh('a'), camera, scene)).toBeNull();
    expect(warmup.holdsFrames).toBe(false);
  });
});

describe('ProgramWarmup when things go away', () => {
  for (const parallel of [true, false]) {
    const name = parallel ? 'with the extension' : 'with a fence';

    it(`resolves every wait when the context is lost (${name})`, async () => {
      const { fake, warmup, tick, armed } = make(parallel);
      const a = warmup.compile(mesh('a'), camera, scene);
      const b = warmup.compile(mesh('b'), camera, scene);
      fake.lost = true;
      warmup.contextLost();
      expect(await settled(a)).toBe(true);
      expect(await settled(b)).toBe(true);
      expect(warmup.pending).toBe(0);
      expect(warmup.holdsFrames).toBe(false);
      expect(armed()).toBe(false);
      // nothing is asked of a lost context
      expect(fake.programs.map((p) => p.asked)).toEqual([0, 0]);
      expect(fake.fences.every((f) => !f.deleted)).toBe(true);
      expect(warmup.compile(mesh('c'), camera, scene)).toBeNull();
      // restored: programs are made ahead again
      fake.lost = false;
      expect(warmup.compile(mesh('d'), camera, scene)).not.toBeNull();
      tick();
    });

    it(`notices a lost context on its own (${name})`, async () => {
      const { fake, warmup, tick } = make(parallel);
      const wait = warmup.compile(mesh('a'), camera, scene);
      fake.lost = true;
      tick();
      expect(await settled(wait)).toBe(true);
      expect(fake.programs[0]?.asked).toBe(0);
    });

    it(`resolves every wait on dispose and makes nothing afterwards (${name})`, async () => {
      const { fake, warmup, armed } = make(parallel);
      const wait = warmup.compile(mesh('a'), camera, scene);
      warmup.dispose();
      expect(await settled(wait)).toBe(true);
      expect(armed()).toBe(false);
      expect(fake.fences.every((f) => f.deleted)).toBe(true);
      expect(warmup.compile(mesh('b'), camera, scene)).toBeNull();
      expect(fake.programs).toHaveLength(1);
      warmup.dispose();
    });
  }

  it('answers null when compiling throws, and says so', () => {
    const { fake, warmup } = make(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fake.failNext();
    expect(warmup.compile(mesh('a'), camera, scene)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    expect(warmup.pending).toBe(0);
  });

  it('survives a program that throws when asked', async () => {
    const { fake, warmup, tick } = make(true);
    const wait = warmup.compile(mesh('a'), camera, scene);
    const p = fake.programs[0];
    if (!p) throw new Error('a program expected');
    p.getUniforms = () => {
      throw new Error('lost in between');
    };
    fake.finish();
    tick();
    expect(await settled(wait)).toBe(true);
  });

  it('does nothing on a renderer without the calls it needs (the test renderers)', () => {
    const bare = { render: () => undefined } as unknown as WebGLRenderer;
    const warmup = new ProgramWarmup(bare);
    expect(warmup.compile(mesh('a'), camera, scene)).toBeNull();
    expect(warmup.holdsFrames).toBe(false);
    warmup.poll();
    warmup.contextLost();
    warmup.dispose();
  });
});

describe('drawnObjects', () => {
  it('lists what the camera draws: visible, on its layers, under visible parents', () => {
    const root = new Scene();
    const shown = mesh('shown');
    const hidden = mesh('hidden');
    hidden.visible = false;
    const inHidden = mesh('in-hidden');
    const off = new Group().add(inHidden);
    off.visible = false;
    const picking = mesh('picking');
    picking.layers.set(5);
    const nested = mesh('nested');
    // a mesh the renderer skips because its material is switched off, with a child that is drawn
    const proxy = mesh('proxy');
    proxy.material.visible = false;
    proxy.add(mesh('under-proxy'));
    root.add(shown, hidden, off, picking, new Group().add(nested), proxy);
    const seen: string[] = [];
    drawnObjects(root, camera).traverse((o) => {
      const m = (o as Partial<Mesh>).material;
      if (m && !Array.isArray(m)) seen.push(m.name);
    });
    expect(seen).toEqual(['shown', 'nested', 'under-proxy']);
    // lights are taken from the scene itself
    const lights: unknown[] = [];
    drawnObjects(root, camera).traverseVisible((o) => lights.push(o));
    expect(lights).toEqual([]);
  });
});
