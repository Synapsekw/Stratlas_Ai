import type { UpdateStatus } from '@aio/schema';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { newerThanThisBuild, parseJsonText } from '../newer';

/**
 * Rollback after an update (ADR 0003).
 *
 * Before an installer runs, the running version copies its own installed folder (Windows) or
 * app bundle (macOS) to `<userData>/updates/previous/<version>/`. That copy is a complete,
 * runnable app: whatever happens to the installed folder (power cut during the installer, a new
 * version that does not start), the previous version still starts from there, and it can put
 * itself back as the installed version.
 *
 * A journal (`updates/journal.json`) records the pending update until the new version's
 * renderer reports ready. A start that never got there counts as a failure; the next start
 * offers to return to the previous version.
 */

export const JOURNAL_SCHEMA = 'aio.update-journal/1';

const Journal = z.object({
  schema: z.literal(JOURNAL_SCHEMA),
  pending: z
    .object({
      from: z.string(),
      to: z.string(),
      startedAt: z.string(),
      /** Installed folder (Windows) or `.app` bundle (macOS) the update replaces. */
      appRoot: z.string(),
      /** Starts of `to` so far. */
      launches: z.number().int().nonnegative(),
      /** Starts of `to` that never reported ready, crashed twice or timed out. */
      failures: z.number().int().nonnegative(),
      /** The last start of `to` quit normally (so a quick close is not a failure). */
      cleanExit: z.boolean(),
      /** The person chose to keep `to` despite a failure: do not ask again. */
      declined: z.boolean(),
    })
    .optional(),
  previous: z
    .object({
      version: z.string(),
      dir: z.string(),
      /** Executable inside `dir`, relative. */
      exe: z.string(),
      /** Where it was installed, so the kept copy can put itself back there. */
      appRoot: z.string().optional(),
    })
    .optional(),
  rolledBack: z.object({ from: z.string(), to: z.string(), at: z.string() }).optional(),
});
export type Journal = z.infer<typeof Journal>;

/** The file operations used, so the Electron build can pass `original-fs` (asar stays a file). */
export interface RollbackFs {
  readFile(path: string, enc: 'utf8'): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, o: { recursive: true; force: true }): Promise<void>;
  mkdir(path: string, o: { recursive: true }): Promise<unknown>;
  cp(from: string, to: string, o: { recursive: true; verbatimSymlinks: true }): Promise<void>;
  stat(path: string): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
}

export interface RollbackDeps {
  /** `<userData>/updates`. */
  dir: string;
  current: string;
  /** Where this version is installed, or why it cannot be kept (development, Store, portable). */
  install: { appRoot: string; exe: string } | { unavailable: string };
  fs: RollbackFs;
  now?: () => Date;
  log?: (line: string) => void;
}

export type StartupDecision =
  | { kind: 'normal' }
  /** First starts of a new version: watch for ready. */
  | { kind: 'watch'; from: string; to: string }
  /** The last start of the new version failed: offer to return to `from`. */
  | { kind: 'offer'; from: string; to: string; failures: number }
  /** The installer did not finish; this (old) version is still installed. */
  | { kind: 'installAborted'; to: string };

/** Install location of the running app from its executable path. */
export function installOf(
  execPath: string,
  platform: string,
  o: { packaged: boolean; store: boolean; portable: boolean },
): RollbackDeps['install'] {
  if (!o.packaged)
    return { unavailable: 'Rollback works in the installed app, not in a development build.' };
  if (o.store) return { unavailable: 'The Microsoft Store manages versions of this copy.' };
  if (o.portable) return { unavailable: 'The portable app has no installed version to return to.' };
  if (platform === 'darwin') {
    const app = dirname(dirname(dirname(execPath)));
    if (!app.endsWith('.app')) return { unavailable: 'The app bundle was not found.' };
    if (app.startsWith('/Volumes/') || app.includes('/AppTranslocation/'))
      return { unavailable: 'Move the app to Applications first.' };
    return { appRoot: app, exe: join('Contents', 'MacOS', basename(execPath)) };
  }
  return { appRoot: dirname(execPath), exe: basename(execPath) };
}

/** The journal without one of its records. */
function without(j: Journal, key: 'pending' | 'previous'): Journal {
  const copy = { ...j };
  if (key === 'pending') delete copy.pending;
  else delete copy.previous;
  return copy;
}

/** True when this executable runs from a kept copy in `<updatesDir>/previous/`. */
export function isKeptCopy(execPath: string, updatesDir: string): boolean {
  const rel = relative(join(updatesDir, 'previous'), execPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function createRollback(d: RollbackDeps) {
  const journalPath = join(d.dir, 'journal.json');
  const previousRoot = join(d.dir, 'previous');
  const now = () => (d.now ?? (() => new Date()))().toISOString();
  const log = d.log ?? (() => undefined);

  async function exists(p: string) {
    try {
      await d.fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /** The update message when the journal on disk was saved by a newer build, else null. */
  async function newerJournal(): Promise<string | null> {
    let text: string;
    try {
      text = await d.fs.readFile(journalPath, 'utf8');
    } catch {
      return null;
    }
    return newerThanThisBuild(parseJsonText(text), 'aio.update-journal', 'updates/journal.json');
  }

  async function read(): Promise<Journal> {
    try {
      const raw: unknown = JSON.parse(await d.fs.readFile(journalPath, 'utf8'));
      // A newer build's journal is read as empty here and never written over (see write).
      if (newerThanThisBuild(raw, 'aio.update-journal', 'updates/journal.json'))
        return { schema: JOURNAL_SCHEMA };
      const parsed = Journal.safeParse(raw);
      if (parsed.success) return parsed.data;
      log('The update journal is not valid; starting a new one.');
    } catch {
      // no journal yet
    }
    return { schema: JOURNAL_SCHEMA };
  }

  /**
   * Write-then-rename, so a cut-off write never leaves half a journal. A journal saved by a newer
   * build is left as it is (UPGRADE-POLICY rule 3): the write is skipped and logged.
   */
  async function write(j: Journal): Promise<void> {
    const newer = await newerJournal();
    if (newer) {
      log(newer);
      return;
    }
    await d.fs.mkdir(d.dir, { recursive: true });
    const tmp = `${journalPath}.tmp`;
    await d.fs.writeFile(tmp, `${JSON.stringify(j, null, 2)}\n`);
    await d.fs.rename(tmp, journalPath);
  }

  async function removeKept(except?: string) {
    let names: string[];
    try {
      names = await d.fs.readdir(previousRoot);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === except) continue;
      await d.fs.rm(join(previousRoot, n), { recursive: true, force: true }).catch(() => {
        log(`Could not remove the kept copy ${n}; it is removed at a later start.`);
      });
    }
  }

  return {
    read,

    /**
     * Keep a runnable copy of this version and record the pending update to `to`. Call right
     * before the installer starts. Returns the kept executable.
     */
    async keepCurrent(to: string): Promise<{ exe: string; dir: string }> {
      if ('unavailable' in d.install) throw new Error(d.install.unavailable);
      const newer = await newerJournal();
      if (newer) throw new Error(newer);
      const { appRoot, exe } = d.install;
      const dir = join(previousRoot, d.current);
      if (!(await exists(join(dir, exe)))) {
        const staging = `${dir}.partial`;
        await d.fs.rm(staging, { recursive: true, force: true });
        await d.fs.mkdir(previousRoot, { recursive: true });
        await d.fs.cp(appRoot, staging, { recursive: true, verbatimSymlinks: true });
        // The rename makes the copy appear complete or not at all.
        await d.fs.rm(dir, { recursive: true, force: true });
        await d.fs.rename(staging, dir);
      }
      await write({
        schema: JOURNAL_SCHEMA,
        pending: {
          from: d.current,
          to,
          startedAt: now(),
          appRoot,
          launches: 0,
          failures: 0,
          cleanExit: true,
          declined: false,
        },
        previous: { version: d.current, dir, exe, appRoot },
      });
      // Only one previous version is kept.
      await removeKept(d.current);
      log(`Kept ${d.current} in ${dir} before installing ${to}.`);
      return { exe: join(dir, exe), dir };
    },

    /** Decide at startup, before any window: count this start and say what to do. */
    async startup(): Promise<StartupDecision> {
      // A newer build's journal names kept copies this build must not remove: change nothing.
      const newer = await newerJournal();
      if (newer) {
        log(newer);
        return { kind: 'normal' };
      }
      const j = await read();
      const p = j.pending;
      if (!p) {
        // A kept copy of the version that is installed again (after a rollback) is not needed;
        // neither is a leftover a busy file kept from being removed at an earlier start.
        if (j.previous?.version === d.current) {
          await write(without(j, 'previous'));
          await removeKept();
        } else {
          await removeKept(j.previous ? basename(j.previous.dir) : undefined);
        }
        return { kind: 'normal' };
      }
      if (p.to === d.current) {
        const failures = p.failures + (p.launches > 0 && !p.cleanExit ? 1 : 0);
        await write({
          ...j,
          pending: { ...p, launches: p.launches + 1, failures, cleanExit: false },
        });
        if (failures > 0 && !p.declined) return { kind: 'offer', from: p.from, to: p.to, failures };
        return { kind: 'watch', from: p.from, to: p.to };
      }
      const rest = without(j, 'pending');
      if (p.from === d.current) {
        log(`The update to ${p.to} did not finish; ${d.current} is still installed.`);
        await write(rest);
        return { kind: 'installAborted', to: p.to };
      }
      log(`Version ${d.current} runs instead of the pending ${p.to}; the update record is closed.`);
      await write(rest);
      return { kind: 'normal' };
    },

    /** The renderer is up: the new version started well. True when this ended a first start. */
    async markReady(): Promise<boolean> {
      const j = await read();
      if (j.pending?.to !== d.current) return false;
      await write(without(j, 'pending'));
      log(`Version ${d.current} started well after the update.`);
      return true;
    },

    /** The app quits normally: a start that ends before ready is not a failure. */
    async markCleanExit(): Promise<void> {
      const j = await read();
      if (j.pending?.to !== d.current) return;
      await write({ ...j, pending: { ...j.pending, cleanExit: true } });
    },

    /** This start failed (no ready in time, two renderer crashes). True when to offer rollback. */
    async markFailure(reason: string): Promise<boolean> {
      const j = await read();
      const p = j.pending;
      if (p?.to !== d.current) return false;
      log(`Version ${d.current} failed its first start: ${reason}.`);
      await write({ ...j, pending: { ...p, failures: p.failures + 1, cleanExit: true } });
      return !p.declined && j.previous !== undefined;
    },

    /** The person keeps the new version: stop asking for this update. */
    async decline(): Promise<void> {
      const j = await read();
      if (j.pending?.to !== d.current) return;
      await write({ ...j, pending: { ...j.pending, declined: true } });
    },

    async status(): Promise<UpdateStatus> {
      const j = await read();
      const prev = j.previous;
      const runnable =
        prev && prev.version !== d.current && (await exists(join(prev.dir, prev.exe)));
      return {
        current: d.current,
        ...(runnable ? { previous: { version: prev.version, dir: prev.dir } } : {}),
        ...(j.pending?.to === d.current
          ? { pending: { from: j.pending.from, to: j.pending.to, failures: j.pending.failures } }
          : {}),
        ...('unavailable' in d.install ? { rollbackUnavailable: d.install.unavailable } : {}),
        ...(j.rolledBack ? { rolledBack: j.rolledBack } : {}),
      };
    },

    /** The kept previous version's executable, when there is one to return to. */
    async previousExe(): Promise<{ version: string; exe: string } | null> {
      const prev = (await read()).previous;
      if (!prev || prev.version === d.current) return null;
      const exe = join(prev.dir, prev.exe);
      return (await exists(exe)) ? { version: prev.version, exe } : null;
    },

    /** Record a finished rollback from `from` to this kept version. */
    async recordRollback(from: string): Promise<void> {
      const j = await read();
      await write({ ...without(j, 'pending'), rolledBack: { from, to: d.current, at: now() } });
    },
  };
}

export type Rollback = ReturnType<typeof createRollback>;

/** Arguments the newer version passes to the kept copy. Stable across versions (ADR 0003). */
export const RESTORE_INTO = '--stratlas-restore-into=';
export const RESTORE_WAIT = '--stratlas-restore-wait=';
export const RESTORE_FROM = '--stratlas-restore-from=';

export function restoreArgs(
  argv: readonly string[],
): { into: string; waitPid: number | null; from: string | null } | null {
  const get = (prefix: string) => argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  const into = get(RESTORE_INTO);
  if (!into) return null;
  const pid = Number(get(RESTORE_WAIT));
  return {
    into,
    waitPid: Number.isInteger(pid) && pid > 0 ? pid : null,
    from: get(RESTORE_FROM) ?? null,
  };
}

export interface RestoreDeps {
  fs: RollbackFs;
  /** True while a process with this id runs. */
  alive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Put the kept copy `kept` back at `appRoot`. The copy goes to `<appRoot>.restoring` first, so
 * the installed folder is replaced by two renames: there is no moment where a cut-off copy sits
 * at `appRoot`. The broken version is moved to `<appRoot>.failed` and removed.
 */
export async function restoreInto(
  kept: string,
  appRoot: string,
  waitPid: number | null,
  r: RestoreDeps,
): Promise<void> {
  const log = r.log ?? (() => undefined);
  if (waitPid !== null) {
    for (let i = 0; i < 150 && r.alive(waitPid); i++) await r.sleep(200);
    if (r.alive(waitPid)) throw new Error('The newer version did not close.');
  }
  const staging = `${appRoot}.restoring`;
  const failed = `${appRoot}.failed`;
  await r.fs.rm(staging, { recursive: true, force: true });
  await r.fs.cp(kept, staging, { recursive: true, verbatimSymlinks: true });
  await r.fs.rm(failed, { recursive: true, force: true });
  let moved = false;
  let lastError: unknown = null;
  for (let i = 0; i < 20 && !moved; i++) {
    try {
      await r.fs.stat(appRoot);
    } catch {
      moved = true; // nothing installed there (an installer stopped half way)
      break;
    }
    try {
      await r.fs.rename(appRoot, failed);
      moved = true;
    } catch (e) {
      lastError = e;
      await r.sleep(500); // a virus scanner or Explorer may hold a file for a moment
    }
  }
  if (!moved) {
    await r.fs.rm(staging, { recursive: true, force: true });
    throw new Error(
      `The installed version is in use and could not be replaced: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  await r.fs.rename(staging, appRoot);
  await r.fs.rm(failed, { recursive: true, force: true }).catch(() => {
    log(`Could not remove ${failed}; delete it by hand.`);
  });
  log(`Restored ${kept} to ${appRoot}.`);
}
