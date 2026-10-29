/**
 * The `llama-server` the `detect.vlm` job talks to: started from the Analytics pack on 127.0.0.1
 * and a free port with a random API key per launch, and recorded in `<data folder>/runtime/
 * analytics-server.json` (`VLM_SERVER_STATE`) once `/health` answers. It runs only while a
 * detector run is running or waiting (founder, 21 Oct): `idle()` stops it at once, and it is
 * killed as the app quits (`stopSync`). The key goes to llama-server in `LLAMA_API_KEY`, never on
 * its command line (other local users can read command lines). A server left behind by a crashed
 * app is found through its state file at the next start and killed (`sweep`). What the server
 * prints goes to `analytics-server.log` beside `main.log` (new at each launch), and its last
 * lines are kept so a start that fails can say why.
 */
import type { VlmServerState } from '@aio/schema';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { programPath, systemProgram } from '@aio/project/fs';
import { jobBaseEnv } from '../jobs/runner';
import { killTree } from '../odm/system';
import { localVlmModel } from './models';
import type { AnalyticsPack } from './pack';
import { presetText } from './text';

/** How long the model may take to load before the start counts as failed. */
export const VLM_HEALTH_TIMEOUT_MS = 120_000;
/** Between two `/health` asks while the model loads. */
const HEALTH_EVERY_MS = 500;
/** One `/health` ask that hangs counts as not ready after this. */
const HEALTH_ASK_MS = 5_000;

export const VLM_PACK_IN_USE =
  'The Analytics pack is in use by a detector run. Wait for it to finish, then try again.';
const PACK_CHANGING = 'The Analytics pack is being changed. Try again when that has finished.';

/** Lines of server output kept in memory, and how many (at most how long) a failed start shows. */
const OUTPUT_LINES = 20;
/** The most kept of one line, ended or not (the end is kept). */
const LINE_CHARS = 4096;
const REASON_LINES = 3;
const REASON_CHARS = 300;

/** The executable of llama-server, whatever folder it runs from. */
const LLAMA_SERVER_IMAGE = /^llama-server(\.exe)?$/i;

/** What the server needs of its process. */
export interface ChildLike {
  pid?: number | undefined;
  kill(): void;
  /** The process ended, its output read to the end. */
  on(event: 'exit', fn: (code: number | null) => void): unknown;
  /** It could not be started (`code` `ENOENT`: no such executable); no exit follows. */
  on(event: 'error', fn: (e: NodeJS.ErrnoException) => void): unknown;
  /** Some of what it wrote to stdout or stderr. */
  on(event: 'output', fn: (text: string) => void): unknown;
}

export interface ServerDeps {
  spawn: (exe: string, args: string[], env: Record<string, string>) => ChildLike;
  fetch: typeof fetch;
  freePort: () => Promise<number>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { clear(): void };
  /** `<dataRoot>/runtime/analytics-server.json` now; a launch keeps the path it started with. */
  statePath: () => string;
  /** Write the state file (owner only); null deletes it. */
  writeState: (file: string, s: VlmServerState | null) => Promise<void>;
  /** The state file's JSON, null when there is none. */
  readState: (file: string) => Promise<unknown>;
  /** The executable name of a running process (`llama-server.exe`), null when none runs. */
  processImage: (pid: number) => Promise<string | null>;
  /** Kill the process and its children (`odm/system.ts`'s `killTree`). */
  killTree: (pid: number | undefined) => void;
  /** Delete the state file now (the app quits). */
  deleteStateSync: (file: string) => void;
  /** 32 hex characters, new for each launch. */
  randomKey?: () => string;
}

export type EnsureResult = { ok: true; state: VlmServerState } | { ok: false; error: string };

interface Live {
  child: ChildLike;
  /** The state file this launch writes, fixed at launch. */
  file: string;
  dir: string;
  exited: boolean;
  code: number | null;
  /** It could not be started because the executable is not there. */
  noExe: boolean;
  state: VlmServerState | null;
  /** Its last lines of output, and the start of a line not yet ended. */
  lines: string[];
  partial: string;
}

/** A pack folder as compared here: absolute, and in one case on Windows. */
const folder = (p: string) =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export class VlmServer {
  private live: Live | null = null;
  /** The current or most recent launch, for `lastOutput`. */
  private latest: Live | null = null;
  private starting: { dir: string; done: Promise<EnsureResult> } | null = null;
  /** Pack folders being removed or replaced; `'*'` holds every pack. */
  private readonly holds = new Map<string, number>();
  /** Leases held by local asks, and whether `idle()` came while one was held. */
  private leases = 0;
  private stopWanted = false;
  /** The leftover check of `sweep`; every start waits for it. */
  private swept: Promise<void> = Promise.resolve();

  constructor(private readonly d: ServerDeps) {}

  /**
   * At app start: a state file left by an app that crashed or was killed names a llama-server
   * that may still hold the graphics memory. Kill it when that pid still runs llama-server (a
   * reused pid of another program is left alone), and delete the file either way.
   */
  sweep(): Promise<void> {
    this.swept = (async () => {
      const file = this.d.statePath();
      const raw = await this.d.readState(file).catch(() => null);
      if (raw === null || raw === undefined) return;
      const pid =
        typeof raw === 'object' && 'pid' in raw && typeof raw.pid === 'number' ? raw.pid : null;
      if (pid !== null && Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        const image = await this.d.processImage(pid).catch(() => null);
        if (image !== null && LLAMA_SERVER_IMAGE.test(basename(image))) {
          try {
            this.d.killTree(pid);
          } catch {
            // gone meanwhile
          }
        }
      }
      await this.d.writeState(file, null).catch(() => undefined);
    })();
    return this.swept;
  }

  /** Start the server from `pack`, or reuse the one running from it; waits for /health (120 s). */
  async ensure(pack: AnalyticsPack, gpuIndex: number | null): Promise<EnsureResult> {
    const dir = folder(pack.dir);
    if (this.holds.has(dir) || this.holds.has('*')) return { ok: false, error: PACK_CHANGING };
    await this.swept;
    // another start may have begun while this one waited: never two at once
    while (this.starting) {
      const s = this.starting;
      const r = await s.done;
      // the start that just ended is ours to reuse unless yet another one began meanwhile
      if (this.startingNow() === null && (s.dir === dir || !r.ok)) return r;
    }
    const live = this.live;
    if (live?.state && !live.exited && live.dir === dir) {
      // a resume reads the file again: write it every time
      await this.d.writeState(live.file, live.state);
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

  /** The last lines the current or most recent launch printed (up to 20). */
  lastOutput(): string[] {
    const l = this.latest;
    if (!l) return [];
    return l.partial ? [...l.lines, l.partial].slice(-OUTPUT_LINES) : [...l.lines];
  }

  /** Whether the server runs (or is starting) from the pack in `dir`. */
  serves(packDir: string): boolean {
    const dir = folder(packDir);
    return (
      this.starting?.dir === dir ||
      (this.live !== null && !this.live.exited && this.live.dir === dir)
    );
  }

  /** No detector run is running or waiting: stop now (not while a start is still loading). */
  idle(): void {
    if (this.starting) return;
    if (this.leases > 0) {
      this.stopWanted = true;
      return;
    }
    void this.stop();
  }

  /**
   * Keep the server running for a local ask. While a lease is held `idle()` only marks a stop as
   * wanted; the last release stops it then. Returns the release (safe to call twice).
   */
  lease(): () => void {
    this.leases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases -= 1;
      if (this.leases === 0 && this.stopWanted) {
        this.stopWanted = false;
        void this.stop();
      }
    };
  }

  async stop(): Promise<void> {
    const live = this.live;
    this.live = null;
    if (!live) return;
    if (!live.exited) this.d.killTree(live.child.pid);
    await this.d.writeState(live.file, null).catch(() => undefined);
  }

  /** The app quits: kill the tree and delete the state file before returning. */
  stopSync(): void {
    const live = this.live;
    this.live = null;
    this.starting = null;
    try {
      if (live && !live.exited) this.d.killTree(live.child.pid);
    } catch {
      // the quit goes on; the next start sweeps what is left
    }
    try {
      this.d.deleteStateSync(live?.file ?? this.d.statePath());
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
    await this.swept;
    await this.d.writeState(this.d.statePath(), state);
    return state;
  }

  private key(): string {
    return this.d.randomKey?.() ?? randomBytes(16).toString('hex');
  }

  private async launch(pack: AnalyticsPack, gpuIndex: number | null): Promise<EnsureResult> {
    const file = this.d.statePath();
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
      ...localVlmModel(pack.manifest.model.id).serverArgs,
    ];
    // in the environment, not on the command line: llama-server reads LLAMA_API_KEY
    const env: Record<string, string> = {
      LLAMA_API_KEY: apiKey,
      // nvidia-smi's index is in PCI bus order; CUDA counts fastest first unless told otherwise,
      // so on a machine with two different cards the index could name the other one
      ...(gpuIndex !== null
        ? { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: String(gpuIndex) }
        : {}),
    };
    let child: ChildLike;
    try {
      child = this.d.spawn(pack.server, args, env);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { ok: false, error: presetText('detect.preset.server.noExe') };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const live: Live = {
      child,
      file,
      dir: folder(pack.dir),
      exited: false,
      code: null,
      noExe: false,
      state: null,
      lines: [],
      partial: '',
    };
    this.live = live;
    this.latest = live;
    child.on('output', (text) => {
      // the end of each line kept, so a server that never ends one cannot fill the memory
      const parts = (live.partial + text).split(/\r?\n/).map((l) => l.slice(-LINE_CHARS));
      live.partial = parts.pop() ?? '';
      live.lines.push(...parts);
      if (live.lines.length > OUTPUT_LINES) live.lines.splice(0, live.lines.length - OUTPUT_LINES);
    });
    child.on('error', (e) => {
      if (live.exited) return;
      live.exited = true;
      live.noExe = e.code === 'ENOENT';
      if (this.live === live) this.live = null;
    });
    child.on('exit', (code) => {
      if (live.exited) return;
      live.exited = true;
      live.code = code;
      // a crash: the next ensure starts it again, and the job finds no stale file
      if (this.live === live) {
        this.live = null;
        if (live.state) void this.d.writeState(live.file, null).catch(() => undefined);
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
    await this.d.writeState(live.file, state);
    return { ok: true, state };
  }

  /** The start in progress, read afresh after an await. */
  private startingNow(): { dir: string; done: Promise<EnsureResult> } | null {
    return this.starting;
  }

  /** The process ended, or another start or a stop took its place. */
  private gone(live: Live): boolean {
    return live.exited || this.live !== live;
  }

  /** True once `/health` answers 200; else why not, in words. */
  private async waitHealthy(url: string, apiKey: string, live: Live): Promise<true | string> {
    const until = this.d.now() + VLM_HEALTH_TIMEOUT_MS;
    for (;;) {
      if (live.noExe) return presetText('detect.preset.server.noExe');
      if (live.exited) {
        return (
          lastWords(live) ?? `it stopped (exit code ${String(live.code)}) before it was ready.`
        );
      }
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

/** The last non-empty lines a launch printed, on one line of at most 300 characters; null for none. */
function lastWords(live: Live): string | null {
  const said = [...live.lines, live.partial]
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-REASON_LINES)
    .join(' | ');
  if (said === '') return null;
  return said.length > REASON_CHARS ? `...${said.slice(-(REASON_CHARS - 3))}` : said;
}

/** The executable of a running process (`tasklist` on Windows, `ps` elsewhere); null when none. */
export function processImage(pid: number): Promise<string | null> {
  const win = process.platform === 'win32';
  // by full path: a bare name would be looked up in the current folder and on the PATH first
  const file = win ? systemProgram('tasklist') : programPath('ps');
  const args = win
    ? ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH']
    : ['-p', String(pid), '-o', 'comm='];
  return new Promise((ok) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        ok(null);
        return;
      }
      ok(parseProcessImage(stdout, pid, win));
    });
  });
}

/** The image name in `tasklist /FO CSV /NH` (or `ps -o comm=`) output for `pid`, else null. */
export function parseProcessImage(stdout: string, pid: number, win: boolean): string | null {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!win) return line || null;
  // "llama-server.exe","1234","Console",...; "INFO: No tasks are running ..." when there is none
  const m = /^"([^"]+)","(\d+)"/.exec(line);
  return m?.[1] !== undefined && m[2] === String(pid) ? m[1] : null;
}

/**
 * Production deps: the state file at `statePath()`, the process tree killed as ODM's is, and what
 * the server prints written to `logFile` (`<logs>/analytics-server.log`), emptied at each launch.
 */
export function nodeVlmServerDeps(statePath: () => string, logFile: string): ServerDeps {
  return {
    spawn: (exe, args, env) => {
      const c = nodeSpawn(exe, args, {
        cwd: dirname(exe),
        // the job runtimes' environment (no app secrets or dev switches), plus the server's own
        env: { ...jobBaseEnv(process.env), ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const log = createWriteStream(logFile, { flags: 'w' });
      // a log that cannot be written never stops the server
      log.on('error', () => undefined);
      const child = Object.assign(new EventEmitter(), { pid: c.pid, kill: () => c.kill() });
      for (const stream of [c.stdout, c.stderr]) {
        // decoded across chunks, so a character split between two is not garbled
        stream.setEncoding('utf8');
        stream.on('data', (text: string) => {
          log.write(text);
          child.emit('output', text);
        });
      }
      // once both outputs are read to the end, so the last lines are in
      c.once('close', (code) => {
        log.end();
        child.emit('exit', code);
      });
      // a missing or blocked executable: no exit follows
      c.once('error', (e) => {
        log.end();
        if (child.listenerCount('error') > 0) child.emit('error', e);
      });
      return child;
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
    statePath,
    writeState: async (file, s) => {
      if (s === null) {
        await rm(file, { force: true });
        return;
      }
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${String(process.pid)}.tmp`;
      // it holds the key: owner only
      await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
    },
    readState: async (file) => {
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // a torn file: still a leftover to delete
        return {};
      }
    },
    processImage,
    killTree,
    deleteStateSync: (file) => {
      rmSync(file, { force: true });
    },
  };
}
