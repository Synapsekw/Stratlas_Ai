/**
 * Defence in depth for the end-to-end tests: an app started by a test (STRATLAS_E2E=1) never writes
 * into the founder's real client data.
 *
 * The e2e fixtures only ever launch the app on a temporary copy of a real project
 * (`e2e/realData.ts`). Should a test still reach the real folder (a spec opening it in place, a
 * path in a manifest leading out of the copy), every write under the real data root is refused
 * here: `writeJsonAtomic` and the rest of `fsutil`, the journal's appends, and, through a wrapper
 * around Node's `fs` installed at startup, any other write of the main process. A refusal throws
 * `RealDataWriteRefusedError`, is printed to stderr and is recorded in
 * `globalThis.__stratlasRealDataRefusals`, which the fixtures check when they close the app, so the
 * test fails even when the app's own code catches the error.
 *
 * The real data root is STRATLAS_REAL_DATA_ROOT, else `E:\Stratlas Data` (the founder's
 * workstation); on Windows that default stays protected, by name only, when the variable names
 * another folder. Copies hard-link large binaries to save time; a write in place to a file with
 * more than one link could change the real file through its other name, so under the guard those
 * are refused wherever they are. Atomic replacements (temp file, rename) only swap the copy's link and
 * stay allowed.
 *
 * Outside tests (no STRATLAS_E2E=1) the guard is off and costs nothing.
 */
// the module object itself (not a frozen namespace), so its functions can be wrapped
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** The founder's data root on the development workstation. */
export const DEFAULT_REAL_DATA_ROOT = 'E:\\Stratlas Data';

/** The real data root to protect, or null when the app was not started by a test. */
export function realDataRootFromEnv(env: Record<string, string | undefined>): string | null {
  if (env.STRATLAS_E2E !== '1') return null;
  const root = env.STRATLAS_REAL_DATA_ROOT;
  return resolve(root !== undefined && root !== '' ? root : DEFAULT_REAL_DATA_ROOT);
}

/** A write the guard refused. Nothing was written. */
export class RealDataWriteRefusedError extends Error {
  readonly code = 'real-data-write-refused' as const;
  readonly path: string;
  readonly op: string;
  constructor(op: string, path: string, why: string) {
    super(`E2E real-data guard: refused ${op} of ${path}: ${why}. Tests must run on a copy.`);
    this.name = 'RealDataWriteRefusedError';
    this.path = path;
    this.op = op;
  }
}

interface GuardGlobal {
  __stratlasRealDataRefusals?: string[];
  /** The check fsutil.ts calls before `writeJsonAtomic` (it imports only node: modules). */
  __stratlasAssertWritable?: (p: string, op: string) => void;
}

/** Every refusal of this process, for the e2e fixtures (`app.evaluate`) to fail the test on. */
export function realDataRefusals(): string[] {
  const g = globalThis as GuardGlobal;
  g.__stratlasRealDataRefusals ??= [];
  return g.__stratlasRealDataRefusals;
}

/** A protected root: its name, and its real path (links and short names resolved). */
interface Guarded {
  name: string;
  real: string;
}

let guardedRoot: string | null = null;
let guarded: Guarded[] = [];

/**
 * Turn the guard on for `root` and `also` (null: off). `installRealDataGuard` does this from the
 * env. `also` roots are compared by name only: the guard never touches them on disk.
 */
export function setRealDataRoot(root: string | null, also: readonly string[] = []): void {
  guardedRoot = root === null ? null : resolve(root);
  if (guardedRoot === null) {
    guarded = [];
    return;
  }
  const real = fs.existsSync(guardedRoot) ? fs.realpathSync.native(guardedRoot) : guardedRoot;
  guarded = [
    { name: guardedRoot, real },
    ...also.map((r) => ({ name: resolve(r), real: resolve(r) })),
  ];
}

/** The root the guard protects, or null when it is off. */
export function realDataRoot(): string | null {
  return guardedRoot;
}

const caseFold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Is `p` the folder `root` or inside it (by name, after resolving `.` and `..`)? */
export function isWithin(root: string, p: string): boolean {
  const r = caseFold(resolve(root));
  const q = caseFold(resolve(p));
  return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * `p` with links, junctions and short names resolved: the real path of its deepest existing
 * ancestor, plus the part that does not exist yet.
 */
function realPathOf(p: string): string {
  const rest: string[] = [];
  let head = resolve(p);
  for (;;) {
    try {
      return resolve(fs.realpathSync.native(head), ...rest);
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(p);
      rest.unshift(basename(head));
      head = up;
    }
  }
}

/** Is `p` under the real data root, by its name or by where its links lead? */
export function isUnderRealData(p: string, root: string | null = guardedRoot): boolean {
  if (root === null) return false;
  if (isWithin(root, p)) return true;
  const realRoot = fs.existsSync(root) ? fs.realpathSync.native(root) : root;
  const realP = realPathOf(p);
  return isWithin(realRoot, realP) || isWithin(root, realP);
}

/** The protected root `p` is under, by name first, then by where its links lead. */
function guardedUnder(p: string): string | undefined {
  const hit = (q: string) => guarded.find((g) => isWithin(g.name, q) || isWithin(g.real, q));
  return (hit(p) ?? hit(realPathOf(p)))?.name;
}

/** More than one name for the same bytes (a hard link): a write in place reaches them all. */
function multiplyLinked(p: string): boolean {
  try {
    const s = fs.statSync(p);
    return s.isFile() && s.nlink > 1;
  } catch {
    return false;
  }
}

/**
 * Refuse `op` on `p` when the guard is on and `p` is under the real data root, or, for a write in
 * place (`inPlace`), when `p` is a file with more than one hard link. No-op when the guard is off.
 */
export function assertWritable(p: string, op: string, opts: { inPlace?: boolean } = {}): void {
  if (guardedRoot === null) return;
  let why: string | null = null;
  const under = guardedUnder(p);
  if (under !== undefined) why = `it is under the real data root ${under}`;
  else if (opts.inPlace && multiplyLinked(p))
    why = 'it has more than one hard link and may share its bytes with the real data';
  if (why === null) return;
  const err = new RealDataWriteRefusedError(op, p, why);
  realDataRefusals().push(err.message);
  // loud on purpose: the test log must show it
  console.error(err.message);
  throw err;
}

// ---------------------------------------------------------------- the fs wrapper

/** A path argument as a string; null for a file descriptor or a FileHandle (checked at open). */
function pathArg(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (v instanceof URL) return v.protocol === 'file:' ? fileURLToPath(v) : null;
  return null;
}

const WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  fs.constants.O_APPEND;

/** Does an `open` flag write? (`r` and `rs` only read; the default is `r`.) */
function opensForWrite(flags: unknown): boolean {
  if (typeof flags === 'number') return (flags & WRITE_FLAGS) !== 0;
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return false;
}

interface Wrapped {
  /** Argument positions that are paths to check. */
  paths: number[];
  /** Positions written in place (also refused on a hard-linked file). */
  inPlace?: number[];
  /** Only check when this holds (e.g. `open` for writing). */
  when?: (args: unknown[]) => boolean;
}

const openForWrite = (args: unknown[]) => opensForWrite(args[1]);

/** Write operations of `fs` (callback and Sync forms) and `fs.promises`, by argument. */
const WRITERS: Record<string, Wrapped> = {
  writeFile: { paths: [0], inPlace: [0] },
  appendFile: { paths: [0], inPlace: [0] },
  truncate: { paths: [0], inPlace: [0] },
  open: { paths: [0], inPlace: [0], when: openForWrite },
  copyFile: { paths: [1], inPlace: [1] },
  cp: { paths: [1], inPlace: [1] },
  rename: { paths: [0, 1] },
  link: { paths: [0, 1] },
  symlink: { paths: [1] },
  mkdir: { paths: [0] },
  mkdtemp: { paths: [0] },
  rm: { paths: [0] },
  rmdir: { paths: [0] },
  unlink: { paths: [0] },
  utimes: { paths: [0], inPlace: [0] },
  lutimes: { paths: [0], inPlace: [0] },
  chmod: { paths: [0], inPlace: [0] },
  lchmod: { paths: [0], inPlace: [0] },
  chown: { paths: [0], inPlace: [0] },
  lchown: { paths: [0], inPlace: [0] },
};

function check(name: string, spec: Wrapped, args: unknown[]): void {
  if (guardedRoot === null || (spec.when && !spec.when(args))) return;
  for (const i of spec.paths) {
    const p = pathArg(args[i]);
    if (p !== null)
      assertWritable(p, `fs.${name}`, { inPlace: spec.inPlace?.includes(i) ?? false });
  }
}

type Fn = (...args: unknown[]) => unknown;
type Patchable = Record<string, unknown>;

/**
 * Wrap the write functions of `fs` and `fs.promises` with the guard (and `createWriteStream`).
 * Returns a function that puts the originals back.
 */
function wrapFs(): () => void {
  const restore: (() => void)[] = [];
  const swap = (target: Patchable, key: string, make: (orig: Fn) => Fn) => {
    const orig = target[key];
    if (typeof orig !== 'function') return;
    const wrapped = make(orig as Fn);
    const custom = (orig as unknown as Record<symbol, unknown>)[promisify.custom];
    if (custom !== undefined)
      (wrapped as unknown as Record<symbol, unknown>)[promisify.custom] = custom;
    target[key] = wrapped;
    restore.push(() => {
      target[key] = orig;
    });
  };
  const sync = fs as unknown as Patchable;
  const promises = fs.promises as unknown as Patchable;
  for (const [name, spec] of Object.entries(WRITERS)) {
    // callback form and Sync form: a refusal throws at the call
    for (const key of [name, `${name}Sync`]) {
      swap(
        sync,
        key,
        (orig) =>
          function (this: unknown, ...args: unknown[]) {
            check(name, spec, args);
            return orig.apply(this, args);
          },
      );
    }
    swap(
      promises,
      name,
      (orig) =>
        function (this: unknown, ...args: unknown[]) {
          try {
            check(name, spec, args);
          } catch (e) {
            return Promise.reject(e instanceof Error ? e : new Error(String(e)));
          }
          return orig.apply(this, args);
        },
    );
  }
  swap(
    sync,
    'createWriteStream',
    (orig) =>
      function (this: unknown, ...args: unknown[]) {
        const p = pathArg(args[0]);
        if (p !== null && guardedRoot !== null)
          assertWritable(p, 'fs.createWriteStream', { inPlace: true });
        return orig.apply(this, args);
      },
  );
  // ESM imports of node:fs and node:fs/promises see the wrappers too
  syncBuiltinESMExports();
  return () => {
    for (const r of restore.reverse()) r();
    syncBuiltinESMExports();
  };
}

let uninstall: (() => void) | null = null;

/**
 * Turn the guard on when the app was started by a test (STRATLAS_E2E=1): protect the real data
 * root and wrap Node's fs. Returns the root protected (null: off). Call first thing in main.
 */
export function installRealDataGuard(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const root = realDataRootFromEnv(env);
  if (root === null) return null;
  // a test pointing STRATLAS_REAL_DATA_ROOT elsewhere still never writes the founder's folder
  const founder = resolve(DEFAULT_REAL_DATA_ROOT);
  setRealDataRoot(root, process.platform === 'win32' && founder !== root ? [founder] : []);
  realDataRefusals();
  (globalThis as GuardGlobal).__stratlasAssertWritable = (p, op) => {
    assertWritable(p, op);
  };
  uninstall ??= wrapFs();
  return root;
}

/** Turn the guard off and put Node's fs back (unit tests). */
export function uninstallRealDataGuard(): void {
  uninstall?.();
  uninstall = null;
  setRealDataRoot(null);
  delete (globalThis as GuardGlobal).__stratlasAssertWritable;
}
