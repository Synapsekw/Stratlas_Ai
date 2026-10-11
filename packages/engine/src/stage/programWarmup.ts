import { Object3D, type Camera, type Material, type Scene, type WebGLRenderer } from 'three';

/**
 * Shader programs made ready before the frame that first draws them.
 *
 * three.js makes a material's program in the frame that first draws it, and the first use of a
 * program asks the driver several questions that must be answered at once (the compile logs, the
 * link status, the list of uniforms). Each answer waits for the graphics process:
 *
 * - on a graphics card, for the compiler: 80 to 170 ms for one program on Direct3D;
 * - on a software renderer (SwiftShader), for everything already sent to be drawn. Compiling is
 *   quick there (about 7 ms), but while frames are being drawn in software each question costs
 *   tens of milliseconds on a workstation and far more on two cores: 3.9 s for the frame of a
 *   tileset's first tile on a CI runner.
 *
 * Inside a frame that wait freezes the view and everything else on the window's thread.
 *
 * `compile` makes the programs without using them (`WebGLRenderer.compile`) and answers a promise
 * that resolves once drawing the object will not wait:
 *
 * - with `KHR_parallel_shader_compile` the driver compiles on its own threads and each program
 *   says when it is done (`isReady`); the view keeps drawing what it had meanwhile;
 * - without it the graphics process works in command order, so a fence placed after the compile
 *   commands is reached when it has caught up. The stage sends no frame until then
 *   (`holdsFrames`): a frame would only queue more work in front of the questions. The fence is
 *   polled, never waited on, so the window's thread stays free.
 *
 * Either way the questions are then asked here, at once and outside a frame, when their answers
 * are ready. The caller adds or shows the object when the promise resolves.
 *
 * Nothing here rejects or throws. On a lost context, a disposed stage, a program deleted while it
 * compiles, a wait that runs out, or a renderer that cannot say when a program is done, the
 * promise resolves (or `compile` answers null) and the object is drawn as before: made in its
 * first frame.
 */

/** A program as the warm-up sees it (three's `WebGLProgram`). */
export interface WarmProgram {
  /** The GL program; three sets it to undefined when the program is destroyed. */
  program: unknown;
  /** The first call asks the driver about the program (three's `onFirstUse`). */
  getUniforms(): unknown;
  /** Linked, with `KHR_parallel_shader_compile`; always true without it. */
  isReady?(): boolean;
}

/** The slice of the WebGL 2 context the fence needs. */
export interface WarmGl {
  readonly SYNC_GPU_COMMANDS_COMPLETE: number;
  readonly TIMEOUT_EXPIRED: number;
  isContextLost(): boolean;
  fenceSync(condition: number, flags: number): unknown;
  clientWaitSync(sync: never, flags: number, timeout: number): number;
  deleteSync(sync: never): void;
  flush(): void;
}

/** The slice of `WebGLRenderer` the warm-up needs (a fake in tests). */
export interface WarmRenderer {
  compile(object: Object3D, camera: Camera, scene: Scene): Set<Material>;
  info: { programs: WarmProgram[] | null };
  properties: { get(material: Material): { currentProgram?: WarmProgram | undefined } };
  extensions: { has(name: string): boolean };
  getContext(): WarmGl;
}

export interface WarmupOptions {
  /** How often the waits are looked at, ms. */
  pollMs?: number;
  /** A wait gives up after this long and lets its object be drawn the old way, ms. */
  timeoutMs?: number;
  now?: () => number;
  /** The poll timer (tests drive it by hand). */
  schedule?: (cb: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}

interface Fence {
  sync: unknown;
  /** Programs still waiting on this fence; it is deleted with the last one. */
  users: number;
  reached: boolean;
}

interface Wait {
  programs: Set<WarmProgram>;
  deadline: number;
  resolve: () => void;
}

const POLL_MS = 16;
/** Several times the longest wait seen (3.9 s on a two core software renderer). */
const TIMEOUT_MS = 15_000;

/** True when `r` has what the warm-up uses (test renderers and old three.js builds do not). */
function isWarmRenderer(r: unknown): r is WarmRenderer {
  const p = r as Partial<WarmRenderer> | null;
  return (
    typeof p?.compile === 'function' &&
    typeof p.getContext === 'function' &&
    typeof p.properties?.get === 'function' &&
    typeof p.extensions?.has === 'function' &&
    Array.isArray(p.info?.programs)
  );
}

/**
 * What `camera` draws under `root` now, as one object for `WebGLRenderer.compile`, which would
 * make programs for hidden objects as well. Its lights are not listed: `compile` takes those
 * from the scene.
 */
class Drawn extends Object3D {
  constructor(
    private readonly root: Object3D,
    private readonly camera: Camera,
  ) {
    super();
  }

  override traverse(callback: (object: Object3D) => unknown): void {
    const walk = (o: Object3D) => {
      if (!o.visible) return;
      const material = (o as { material?: Material | Material[] }).material;
      // a material switched off is skipped by the renderer as well (pick proxies)
      const off = material !== undefined && !Array.isArray(material) && !material.visible;
      if (!off && o.layers.test(this.camera.layers)) callback(o);
      for (const c of o.children) walk(c);
    };
    walk(this.root);
  }

  override traverseVisible(): void {
    /* nothing of its own */
  }
}

/** The objects `camera` draws under `root` now (visible, on its layers), for `compile`. */
export function drawnObjects(root: Object3D, camera: Camera): Object3D {
  return new Drawn(root, camera);
}

export class ProgramWarmup {
  /** Programs a `compile` here made that are not ready yet; null: the program says itself. */
  private readonly compiling = new Map<WarmProgram, Fence | null>();
  private readonly waits = new Set<Wait>();
  private readonly renderer: WarmRenderer | null;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void, ms: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private timer: unknown = null;
  private stopped = false;
  /** A fence was never reached: this context's fences are not trusted again. */
  private fenceFailed = false;

  constructor(renderer: WebGLRenderer | WarmRenderer, opts: WarmupOptions = {}) {
    this.renderer = isWarmRenderer(renderer) ? renderer : null;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.now = opts.now ?? (() => performance.now());
    this.schedule = opts.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancel =
      opts.cancel ??
      ((t) => {
        clearTimeout(t as ReturnType<typeof setTimeout>);
      });
  }

  /** Objects waiting for their programs. */
  get pending(): number {
    return this.waits.size;
  }

  /**
   * True while a fence is out: the graphics process is catching up and a frame sent now would
   * queue in front of the questions the new programs wait for. The stage draws nothing meanwhile.
   */
  get holdsFrames(): boolean {
    for (const fence of this.compiling.values()) if (fence && !fence.reached) return true;
    return false;
  }

  /**
   * Make the programs `object` will be drawn with in `scene` (its lights, shadows and clipping
   * planes as they are now). Answers null when drawing it would not wait: every program is in
   * use already, or this renderer cannot say when one is done.
   */
  compile(object: Object3D, camera: Camera, scene: Scene): Promise<void> | null {
    const r = this.renderer;
    if (this.stopped || !r) return null;
    const gl = r.getContext();
    if (gl.isContextLost()) return null;
    const parallel = r.extensions.has('KHR_parallel_shader_compile');
    if (!parallel && (this.fenceFailed || typeof gl.fenceSync !== 'function')) return null;
    const before = new Set(r.info.programs);
    let materials: Set<Material>;
    try {
      materials = r.compile(object, camera, scene);
    } catch (e) {
      // drawn the old way: its first frame makes the programs (and says what is wrong with them)
      console.warn('Shader programs not made ahead of the frame', e);
      return null;
    }
    const fresh = (r.info.programs ?? []).filter((p) => !before.has(p));
    if (fresh.length > 0) {
      const fence = parallel ? null : this.fence(gl, fresh.length);
      // no fence (the context is going): nothing says when the graphics process has caught up
      if (fence === undefined) return null;
      for (const p of fresh) this.compiling.set(p, fence);
    }
    const programs = new Set<WarmProgram>(fresh);
    for (const m of materials) {
      const p = r.properties.get(m).currentProgram;
      // a program another object's compile made is waited for as well
      if (p && this.compiling.has(p)) programs.add(p);
    }
    for (const p of programs) if (this.settle(p, gl)) programs.delete(p);
    if (programs.size === 0) return null;
    return new Promise<void>((resolve) => {
      this.waits.add({ programs, deadline: this.now() + this.timeoutMs, resolve });
      this.arm();
    });
  }

  /** Look at the waits now (the timer does). */
  poll(): void {
    const r = this.renderer;
    if (!r || this.waits.size === 0) return;
    const gl = r.getContext();
    if (gl.isContextLost()) {
      this.release(null);
      return;
    }
    const t = this.now();
    for (const p of [...this.compiling.keys()]) this.settle(p, gl);
    for (const w of [...this.waits]) {
      for (const p of w.programs) if (!this.compiling.has(p)) w.programs.delete(p);
      if (w.programs.size === 0) {
        this.waits.delete(w);
        w.resolve();
      } else if (t >= w.deadline) {
        for (const p of w.programs) if (this.compiling.get(p)) this.fenceFailed = true;
        this.waits.delete(w);
        w.resolve();
      }
    }
    // nobody waits any more (a wait ran out): what is left is not looked at again
    if (this.waits.size === 0) this.forget(gl);
    else this.arm();
  }

  /** The WebGL context is gone: nothing compiles and nothing is drawn until it is back. */
  contextLost(): void {
    this.release(null);
  }

  /** Resolve every wait and stop; `compile` answers null from now on. */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    const gl = this.renderer?.getContext() ?? null;
    this.release(gl && !gl.isContextLost() ? gl : null);
  }

  /** A fence after the commands sent so far; undefined when the context makes none. */
  private fence(gl: WarmGl, users: number): Fence | undefined {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return undefined;
    // the commands leave for the graphics process now, not with the next frame
    gl.flush();
    return { sync, users, reached: false };
  }

  /**
   * True when using `p` will not wait. The questions of its first use are asked here, now that
   * their answers are ready, and the program is no longer tracked.
   */
  private settle(p: WarmProgram, gl: WarmGl): boolean {
    const fence = this.compiling.get(p);
    if (fence === undefined) return true;
    const gone = p.program === undefined;
    if (!gone && fence) {
      // any status but "not yet" (reached, or the wait failed) ends the wait
      fence.reached ||= gl.clientWaitSync(fence.sync as never, 0, 0) !== gl.TIMEOUT_EXPIRED;
      if (!fence.reached) return false;
    } else if (!gone && p.isReady?.() === false) return false;
    this.compiling.delete(p);
    if (fence && --fence.users <= 0) gl.deleteSync(fence.sync as never);
    if (!gone)
      try {
        p.getUniforms();
      } catch {
        // asked again by the frame that first draws it
      }
    return true;
  }

  private forget(gl: WarmGl | null): void {
    if (gl)
      for (const fence of new Set(this.compiling.values()))
        if (fence) gl.deleteSync(fence.sync as never);
    this.compiling.clear();
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  private release(gl: WarmGl | null): void {
    const waits = [...this.waits];
    this.waits.clear();
    this.forget(gl);
    for (const w of waits) w.resolve();
  }

  private arm(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.poll();
    }, this.pollMs);
  }
}
