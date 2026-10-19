import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
} from 'node:child_process';
import { access, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
import type { Readable } from 'node:stream';

/** What the ODM installer needs of the computer; the tests pass a fake. */
export interface OdmSystem {
  /** Run ODM's setup and answer its exit code. */
  runSetup(file: string, args: string[]): Promise<number>;
  /**
   * `run.bat --help` in an ODM folder: its exit code, everything it printed, and whether it was
   * stopped for taking longer than `SMOKE_TIMEOUT_MS` (absent counts as no).
   */
  runSmoke(dir: string): Promise<{ code: number; out: string; timedOut?: boolean }>;
  runUninstaller(file: string, args: string[]): Promise<number>;
  /**
   * `reg query` output, `''` when nothing is found: with `search`, every value below `key` whose
   * data holds it (`/s /f <search> /d`); without, all values of `key` itself.
   */
  regQuery(key: string, search?: string): Promise<string>;
  exists(p: string): Promise<boolean>;
  rm(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Size of a file, null when it is not there. */
  fileBytes(p: string): Promise<number | null>;
  freeBytes(dir: string): Promise<number>;
  sleep(ms: number): Promise<void>;
}

/**
 * The first `--help` of a fresh ODM takes about 26 s on a warm computer; on a new one Python
 * compiles every module and the virus scanner reads about 1 GB of new files, well past 2 minutes.
 */
export const SMOKE_TIMEOUT_MS = 600_000;

/** After the kill, how long a smoke test may take to close before its pipes are let go. */
const SMOKE_CLOSE_GRACE_MS = 10_000;
/** The end of the smoke test's output kept in memory. */
const SMOKE_OUT_CHARS = 64 * 1024;

/** What the smoke test needs of its process; the tests pass a fake. */
type SmokeChild = Pick<
  ChildProcessByStdio<null, Readable, Readable>,
  'pid' | 'stdout' | 'stderr' | 'once'
>;

function exitCode(child: Pick<ChildProcess, 'once'>): Promise<number> {
  return new Promise((ok, fail) => {
    child.once('error', fail);
    child.once('close', (code) => {
      ok(code ?? 1);
    });
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else process.kill(pid, 'SIGKILL');
}

/** Left out of ODM's environment: names compared in lower case, as Windows does. */
const SMOKE_ENV_DROP: ReadonlySet<string> = new Set([
  // cmd.exe must find `winrun.bat` in the current folder (C1 probe)
  'nodefaultcurrentdirectoryinexepath',
  // ODM runs its own Python, which must not load another one's standard library or packages
  'pythonhome',
  'pythonpath',
]);

/** ODM's own environment for its smoke test. */
export function odmSmokeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && !SMOKE_ENV_DROP.has(k.toLowerCase())) out[k] = v;
  out.ODM_NONINTERACTIVE = '1';
  return out;
}

export function nodeOdmSystem(
  env: Record<string, string | undefined>,
  opts: {
    smokeTimeoutMs?: number;
    closeGraceMs?: number;
    spawnSmoke?: (dir: string) => SmokeChild;
    killTree?: (pid: number | undefined) => void;
  } = {},
): OdmSystem {
  const smokeTimeoutMs = opts.smokeTimeoutMs ?? SMOKE_TIMEOUT_MS;
  const closeGraceMs = opts.closeGraceMs ?? SMOKE_CLOSE_GRACE_MS;
  const kill = opts.killTree ?? killTree;
  const spawnSmoke =
    opts.spawnSmoke ??
    ((dir: string): SmokeChild =>
      spawn('cmd.exe', ['/d', '/s', '/c', `""${win32.join(dir, 'run.bat')}" --help"`], {
        cwd: dir,
        env: odmSmokeEnv(env),
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
  const run = (file: string, args: string[]): Promise<number> => {
    const opts: SpawnOptions = { windowsHide: true, stdio: 'ignore' };
    // End to end tests stand a Node script in for ODM's setup, run by Electron as Node.
    if (env.QUADRION_E2E === '1' && file.endsWith('.mjs'))
      return exitCode(
        spawn(process.execPath, [file, ...args], {
          ...opts,
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        }),
      );
    return exitCode(spawn(file, args, opts));
  };

  return {
    runSetup: run,
    runUninstaller: run,
    runSmoke: (dir) =>
      new Promise((ok, fail) => {
        const child = spawnSmoke(dir);
        let out = '';
        const add = (c: Buffer | string) => {
          out += c.toString();
          if (out.length > SMOKE_OUT_CHARS) out = out.slice(-SMOKE_OUT_CHARS);
        };
        child.stdout.on('data', add);
        child.stderr.on('data', add);
        let timedOut = false;
        let settled = false;
        let grace: ReturnType<typeof setTimeout> | undefined;
        const settle = (then: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(grace);
          then();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill(child.pid);
          // a grandchild can hold the pipes open after the kill, and `close` waits for them
          grace = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            settle(() => {
              ok({ code: 1, out, timedOut: true });
            });
          }, closeGraceMs);
        }, smokeTimeoutMs);
        exitCode(child).then(
          (code) => {
            settle(() => {
              ok({ code, out, timedOut });
            });
          },
          (e: unknown) => {
            settle(() => {
              fail(e instanceof Error ? e : new Error(String(e)));
            });
          },
        );
      }),
    regQuery: (key, search) =>
      new Promise((ok, fail) => {
        execFile(
          'reg',
          search ? ['query', key, '/s', '/f', search, '/d'] : ['query', key],
          { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => {
            // exit 1: nothing found (or no such key)
            if (err && err.code !== 1) fail(new Error(err.message));
            else ok(err ? '' : stdout);
          },
        );
      }),
    exists: (p) =>
      access(p).then(
        () => true,
        () => false,
      ),
    rm: (p) => rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    rename: (from, to) => rename(from, to),
    fileBytes: (p) =>
      stat(p).then(
        (s) => (s.isFile() ? s.size : null),
        () => null,
      ),
    freeBytes: async (dir) => {
      // the nearest folder that exists; unknown counts as enough
      for (let p = dir; ;) {
        try {
          const s = await statfs(p);
          return s.bavail * s.bsize;
        } catch {
          const up = dirname(p);
          if (up === p) return Number.POSITIVE_INFINITY;
          p = up;
        }
      }
    },
    sleep: (ms) =>
      new Promise((ok) => {
        setTimeout(ok, ms);
      }),
  };
}
