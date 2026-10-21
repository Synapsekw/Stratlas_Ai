/**
 * The `llama-server` the `detect.vlm` job talks to: started from the Analytics pack on 127.0.0.1
 * and a free port with a random API key per launch, and recorded in `<data folder>/runtime/
 * analytics-server.json` (`VLM_SERVER_STATE`) once `/health` answers. It runs only while a
 * detector run is running or waiting (founder, 21 Oct): `idle()` stops it at once, and it is
 * killed as the app quits (`stopSync`).
 */
import type { VlmServerState } from '@aio/schema';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { killTree } from '../odm/system';
import type { AnalyticsPack } from './pack';

/** How long the model may take to load before the start counts as failed. */
export const VLM_HEALTH_TIMEOUT_MS = 120_000;
/** Between two `/health` asks while the model loads. */
const HEALTH_EVERY_MS = 500;
/** One `/health` ask that hangs counts as not ready after this. */
const HEALTH_ASK_MS = 5_000;

export const VLM_PACK_IN_USE =
  'The Analytics pack is in use by a detector run. Wait for it to finish, then try again.';
const PACK_CHANGING = 'The Analytics pack is being changed. Try again when that has finished.';

/** What the server needs of its process. */
export interface ChildLike {
  pid?: number | undefined;
  kill(): void;
  on(event: 'exit', fn: (code: number | null) => void): unknown;
}

export interface ServerDeps {
  spawn: (exe: string, args: string[], env: Record<string, string>) => ChildLike;
  fetch: typeof fetch;
  freePort: () => Promise<number>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { clear(): void };
  /** `<dataRoot>/runtime/analytics-server.json`; null deletes it. */
  writeState: (s: VlmServerState | null) => Promise<void>;
  /** Kill the process and its children (`odm/system.ts`'s `killTree`). */
  killTree: (pid: number | undefined) => void;
  /** Delete the state file now (the app quits). */
  deleteStateSync: () => void;
  /** 32 hex characters, new for each launch. */
  randomKey?: () => string;
}

export type EnsureResult = { ok: true; state: VlmServerState } | { ok: false; error: string };

interface Live {
  child: ChildLike;
  dir: string;
  exited: boolean;
  code: number | null;
  state: VlmServerState | null;
}

/** A pack folder as compared here: absolute, and in one case on Windows. */
const folder = (p: string) =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export class VlmServer {
  private live: Live | null = null;
  private starting: { dir: string; done: Promise<EnsureResult> } | null = null;
  /** Pack folders being removed or replaced; `'*'` holds every pack. */
  private readonly holds = new Map<string, number>();
  private runs = 0;

  constructor(private readonly d: ServerDeps) {}

  /** Start the server from `pack`, or reuse the one running from it; waits for /health (120 s). */
  async ensure(pack: AnalyticsPack, gpuIndex: number | null): Promise<EnsureResult> {
    const dir = folder(pack.dir);
    if (this.holds.has(dir) || this.holds.has('*')) return { ok: false, error: PACK_CHANGING };
    if (this.starting) {
      const s = this.starting;
      const r = await s.done;
      if (s.dir === dir || !r.ok) return r;
    }
    const live = this.live;
    if (live?.state && !live.exited && live.dir === dir) {
      // a resume reads the file again: write it every time
      await this.d.writeState(live.state);
      return { ok: true, state: live.state };
    }
    // marked as starting before the first await, so a second ensure shares this start
    const done = (async () => {
      if (live) await this.stop();
      return this.launch(pack, gpuIndex);
    })();
    const s = { dir, done };
    this.starting = s;
    try {
      return await done;
    } finally {
      if (this.starting === s) this.starting = null;
    }
  }

  /** Whether the server runs (or is starting) from the pack in `dir`. */
  serves(packDir: string): boolean {
    const dir = folder(packDir);
    return (
      this.starting?.dir === dir ||
      (this.live !== null && !this.live.exited && this.live.dir === dir)
    );
  }

  /** A detector run started on the server. */
  busy(): void {
    this.runs += 1;
  }

  /** No detector run is running or waiting: stop now (not while a start is still loading). */
  idle(): void {
    if (this.starting) return;
    this.runs = 0;
    void this.stop();
  }

  async stop(): Promise<void> {
    const live = this.live;
    this.live = null;
    if (!live) return;
    if (!live.exited) this.d.killTree(live.child.pid);
    await this.d.writeState(null).catch(() => undefined);
  }

  /** The app quits: kill the tree and delete the state file before returning. */
  stopSync(): void {
    const live = this.live;
    this.live = null;
    this.starting = null;
    if (live && !live.exited) this.d.killTree(live.child.pid);
    try {
      this.d.deleteStateSync();
    } catch {
      // nothing to delete
    }
  }

  /**
   * Keep the server off a pack folder (or every pack when `dir` is left out) while it is removed
   * or replaced. Null when the server runs from it now; else the release.
   */
  hold(dir?: string): (() => void) | null {
    const key = dir === undefined ? '*' : folder(dir);
    const inUse =
      dir === undefined
        ? this.starting !== null || (this.live !== null && !this.live.exited)
        : this.serves(dir);
    if (inUse) return null;
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.holds.get(key) ?? 1) - 1;
      if (n <= 0) this.holds.delete(key);
      else this.holds.set(key, n);
    };
  }

  /** End to end tests: record a server that runs elsewhere (`QUADRION_VLM_SERVER_URL`). */
  async attach(url: string, modelSha256: string): Promise<VlmServerState> {
    const state: VlmServerState = {
      url: url.replace(/\/+$/, '').replace('//localhost:', '//127.0.0.1:'),
      pid: process.pid,
      apiKey: this.key(),
      modelSha256,
      startedAt: new Date(this.d.now()).toISOString(),
    };
    if (!LOOPBACK.test(state.url))
      throw new Error(`QUADRION_VLM_SERVER_URL must be http://127.0.0.1:<port>, not ${url}.`);
    await this.d.writeState(state);
    return state;
  }

  private key(): string {
    return this.d.randomKey?.() ?? randomBytes(16).toString('hex');
  }

  private async launch(pack: AnalyticsPack, gpuIndex: number | null): Promise<EnsureResult> {
    const port = await this.d.freePort();
    const apiKey = this.key();
    const url = `http://127.0.0.1:${port}`;
    const args = [
      '--model',
      pack.gguf,
      '--mmproj',
      pack.mmproj,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--ctx-size',
      '8192',
      '-ngl',
      '99',
      '--parallel',
      '1',
      '--no-ui',
      '--api-key',
      apiKey,
    ];
    const env: Record<string, string> =
      gpuIndex !== null ? { CUDA_VISIBLE_DEVICES: String(gpuIndex) } : {};
    let child: ChildLike;
    try {
      child = this.d.spawn(pack.server, args, env);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const live: Live = { child, dir: folder(pack.dir), exited: false, code: null, state: null };
    this.live = live;
    child.on('exit', (code) => {
      if (live.exited) return;
      live.exited = true;
      live.code = code;
      // a crash: the next ensure starts it again, and the job finds no stale file
      if (this.live === live) {
        this.live = null;
        if (live.state) void this.d.writeState(null).catch(() => undefined);
      }
    });

    const ready = await this.waitHealthy(url, apiKey, live);
    if (ready !== true) {
      if (!live.exited) this.d.killTree(child.pid);
      if (this.live === live) this.live = null;
      return { ok: false, error: ready };
    }
    const pid = child.pid;
    if (this.gone(live) || pid === undefined) return { ok: false, error: 'it stopped.' };
    const state: VlmServerState = {
      url,
      pid,
      apiKey,
      modelSha256: pack.manifest.model.sha256,
      startedAt: new Date(this.d.now()).toISOString(),
    };
    live.state = state;
    await this.d.writeState(state);
    return { ok: true, state };
  }

  /** The process ended, or another start or a stop took its place. */
  private gone(live: Live): boolean {
    return live.exited || this.live !== live;
  }

  /** True once `/health` answers 200; else why not, in words. */
  private async waitHealthy(url: string, apiKey: string, live: Live): Promise<true | string> {
    const until = this.d.now() + VLM_HEALTH_TIMEOUT_MS;
    for (;;) {
      if (live.exited) return `it stopped (exit code ${String(live.code)}) before it was ready.`;
      if (this.live !== live) return 'it was stopped before it was ready.';
      if (await this.askHealth(url, apiKey)) return true;
      if (this.d.now() >= until)
        return `it did not answer within ${String(VLM_HEALTH_TIMEOUT_MS / 1000)} s.`;
      await new Promise<void>((ok) => this.d.setTimer(ok, HEALTH_EVERY_MS));
    }
  }

  /** llama-server leaves /health open, but send the key in case a build asks for it. */
  private async askHealth(url: string, apiKey: string): Promise<boolean> {
    const ctl = new AbortController();
    const timer = this.d.setTimer(() => {
      ctl.abort();
    }, HEALTH_ASK_MS);
    try {
      const res = await this.d.fetch(`${url}/health`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctl.signal,
      });
      return res.ok;
    } catch {
      // not listening yet
      return false;
    } finally {
      timer.clear();
    }
  }
}

/** Production deps: the state file at `statePath()`, the process tree killed as ODM's is. */
export function nodeVlmServerDeps(statePath: () => string): ServerDeps {
  return {
    spawn: (exe, args, env) => {
      const c = nodeSpawn(exe, args, {
        cwd: dirname(exe),
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: 'ignore',
      });
      return {
        pid: c.pid,
        kill: () => c.kill(),
        on: (_event, fn) => {
          c.once('exit', (code) => {
            fn(code);
          });
          // a missing or blocked executable
          c.once('error', () => {
            fn(null);
          });
        },
      };
    },
    fetch: (input, init) => fetch(input, init),
    freePort: () =>
      new Promise((ok, fail) => {
        const s = createServer();
        s.once('error', fail);
        s.listen(0, '127.0.0.1', () => {
          const a = s.address();
          const port = typeof a === 'object' && a ? a.port : 0;
          s.close(() => {
            ok(port);
          });
        });
      }),
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return {
        clear: () => {
          clearTimeout(t);
        },
      };
    },
    writeState: async (s) => {
      const file = statePath();
      if (s === null) {
        await rm(file, { force: true });
        return;
      }
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${String(process.pid)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
    },
    killTree,
    deleteStateSync: () => {
      rmSync(statePath(), { force: true });
    },
  };
}
