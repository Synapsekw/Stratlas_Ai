import type { Material, Object3D } from 'three';
import type { WarmGl, WarmProgram, WarmRenderer } from './programWarmup';

/**
 * A renderer for tests of the shader warm-up (no WebGL in jsdom): `compile` makes one program per
 * distinct material name and clipping plane count, as three.js makes one per cache key, and the
 * test says when the compiler is done (`finish`) or the graphics process has caught up (`reach`).
 */
export interface FakeProgram extends WarmProgram {
  key: string;
  /** How often the driver was asked about it (three asks on first use). */
  asked: number;
  ready: boolean;
}

export interface FakeWarm {
  renderer: WarmRenderer;
  programs: FakeProgram[];
  /** Fences made, and whether each was reached and deleted. */
  fences: { reached: boolean; deleted: boolean }[];
  flushes: number;
  /** The clipping plane counts `compile` saw, one per material compiled, in order. */
  compiled: string[];
  lost: boolean;
  /** With the parallel compile extension: the compiler is done with every program. */
  finish(): void;
  /** Without it: the graphics process has reached every fence. */
  reach(): void;
  /** The renderer deletes a program (its last material was disposed). */
  destroy(p: FakeProgram): void;
  /** Make `compile` throw once. */
  failNext(): void;
}

const keyOf = (m: Material): string =>
  `${m.name || m.type}/${String(m.clippingPlanes?.length ?? 0)}/${String(m.side)}`;

export function fakeWarmRenderer(opts: {
  /** The renderer has `KHR_parallel_shader_compile`. */
  parallel: boolean;
  /** With it: a new program is linked at once (the driver had it cached). */
  instant?: boolean;
}): FakeWarm {
  const programs: FakeProgram[] = [];
  const current = new Map<Material, FakeProgram>();
  let fail = false;
  const state: FakeWarm = {
    programs,
    fences: [],
    flushes: 0,
    compiled: [],
    lost: false,
    finish() {
      for (const p of programs) p.ready = true;
    },
    reach() {
      for (const f of state.fences) f.reached = true;
    },
    destroy(p) {
      p.program = undefined;
      programs.splice(programs.indexOf(p), 1);
    },
    failNext() {
      fail = true;
    },
    renderer: undefined as unknown as WarmRenderer,
  };
  const gl: WarmGl = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    TIMEOUT_EXPIRED: 0x911b,
    isContextLost: () => state.lost,
    fenceSync: () => {
      if (state.lost) return null;
      const f = { reached: false, deleted: false };
      state.fences.push(f);
      return f;
    },
    clientWaitSync: (sync) => ((sync as { reached: boolean }).reached ? 0x911a : 0x911b),
    deleteSync: (sync) => {
      (sync as { deleted: boolean }).deleted = true;
    },
    flush: () => {
      state.flushes += 1;
    },
  };
  state.renderer = {
    compile(object: Object3D) {
      if (fail) {
        fail = false;
        throw new Error('compile failed');
      }
      const seen = new Set<Material>();
      object.traverse((o) => {
        const mat = (o as { material?: Material | Material[] }).material;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) {
          seen.add(m);
          const key = keyOf(m);
          state.compiled.push(key);
          let p = programs.find((x) => x.key === key);
          if (!p) {
            const made: FakeProgram = {
              key,
              program: {},
              asked: 0,
              // without the extension a program cannot say; three answers true
              ready: !opts.parallel || opts.instant === true,
              getUniforms() {
                made.asked += 1;
                return {};
              },
              isReady: () => made.ready,
            };
            p = made;
            programs.push(p);
          }
          current.set(m, p);
        }
      });
      return seen;
    },
    info: { programs },
    properties: { get: (m) => ({ currentProgram: current.get(m) }) },
    extensions: { has: (name) => opts.parallel && name === 'KHR_parallel_shader_compile' },
    getContext: () => gl,
  };
  return state;
}
