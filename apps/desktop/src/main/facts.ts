/**
 * The project fact index service (intelligence review M1, `@aio/facts`).
 *
 * One SQLite file per folder project in `userData/fact-index/`, derived from the project's files
 * and journal and never the truth: it is never in the project folder, so it is never synced,
 * packed or journaled, and deleting it loses nothing (`facts:rebuild` deletes and builds again).
 *
 * - Build on open, in the background: `opened` schedules a build a moment after the open (the
 *   journal's open check goes first), one project at a time, never blocking the open.
 * - Update on change: `changed` (every `journal:changed`: journaled writes, outside edits, merges,
 *   sync) schedules a debounced update, which applies only the rows that differ from a fresh
 *   extract, so an updated index always equals a rebuilt one.
 * - Reading the folder, extracting and writing run in a worker thread (`factsWorker.ts`, through
 *   `sync`); main keeps a read connection per project for the queries (SQLite WAL: one writer,
 *   readers alongside).
 * - On start, index files whose folder is gone are pruned.
 * - Packages get no index (state `none`): they are read-only and the agent tools stay away.
 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  openFactIndex,
  pruneIndexes,
  removeIndex,
  syncFolder,
  type FactIndex,
  type FolderSync,
} from '@aio/facts';
import type {
  Fact,
  FactHistory,
  FactIndexStatus,
  FactQuery,
  FactsUnavailable,
  IpcChannel,
} from '@aio/schema';
import type { Handler } from './ipc';

/** A job for the worker (or the in-process runner in tests). */
export type FactsJob =
  { kind: 'sync'; root: string; file: string; fresh?: boolean } | { kind: 'prune'; dir: string };
export type FactsJobResult = FolderSync | { pruned: string[] };

/** Runs one job: in a worker thread in the app, in process in tests. */
export type FactsRunner = (job: FactsJob) => Promise<FactsJobResult>;

/** The in-process runner (tests, and the fallback when the worker cannot start). */
export const runInProcess: FactsRunner = async (job) =>
  job.kind === 'sync'
    ? syncFolder(job.root, job.file, job.fresh ? { fresh: true } : {})
    : { pruned: await pruneIndexes(job.dir) };

export interface FactServiceDeps {
  /** `userData/fact-index`. */
  dir: string;
  root(projectId: string): string | undefined;
  isPackage(projectId: string): boolean;
  /** `facts:changed` to the renderer. */
  emit?: (e: { projectId: string; status: FactIndexStatus }) => void;
  /** Where the builds run (default: in process). */
  run?: FactsRunner;
  /** Wait after an open before the first build (ms). */
  openDelayMs?: number;
  /** Debounce of updates after a change (ms). */
  changeDelayMs?: number;
  log?: (line: string) => void;
}

interface Tracked {
  root: string;
  /** Main's read connection, opened after the first build. */
  index: FactIndex | null;
  /** First build or rebuild running. */
  building: boolean;
  error?: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const EMPTY: FactIndexStatus = { state: 'none', counts: {}, links: 0 };

/** Why an index cannot answer, with the English text the log and older readers see. */
export interface Unavailable {
  error: string;
  reason: FactsUnavailable;
}

const UNAVAILABLE: Record<FactsUnavailable, string> = {
  'not-built': 'The fact index of this project is not built yet.',
  package: 'Packages have no fact index.',
  'not-open': 'The project is not open.',
};
const unavailable = (reason: FactsUnavailable): Unavailable => ({
  error: UNAVAILABLE[reason],
  reason,
});

/** The index file of a folder: a hash of its path, so renames of the project name do not matter. */
export const indexFileOf = (dir: string, root: string): string =>
  join(
    dir,
    `${createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 32)}.sqlite`,
  );

export function createFactService(deps: FactServiceDeps) {
  const runJob = deps.run ?? runInProcess;
  const openDelay = deps.openDelayMs ?? 2000;
  const changeDelay = deps.changeDelayMs ?? 1500;
  const projects = new Map<string, Tracked>();
  let closed = false;
  // read through a function: `closed` changes while a build awaits
  const isClosed = () => closed;
  // one build at a time across projects (light local load)
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  // first job of all: drop the index files of folders that are gone
  void serial(async () => {
    await mkdir(deps.dir, { recursive: true });
    const r = await runJob({ kind: 'prune', dir: deps.dir });
    if ('pruned' in r && r.pruned.length) {
      deps.log?.(`Fact index: removed ${r.pruned.length} index file(s) of folders that are gone`);
    }
  }).catch((e: unknown) => {
    deps.log?.(`Fact index prune failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  function statusOf(t: Tracked | undefined): FactIndexStatus {
    if (!t) return EMPTY;
    const base = t.index ? t.index.status() : EMPTY;
    if (t.building) return { ...base, state: 'building' };
    if (t.error) return { ...base, state: 'error', error: t.error.slice(0, 500) };
    return base;
  }

  const announce = (projectId: string) => {
    if (!closed) deps.emit?.({ projectId, status: statusOf(projects.get(projectId)) });
  };

  function track(projectId: string): Tracked | null {
    if (closed || deps.isPackage(projectId)) return null;
    const root = deps.root(projectId);
    if (!root) return null;
    const known = projects.get(projectId);
    if (known?.root === root) return known;
    if (known) {
      known.index?.close();
      if (known.timer) clearTimeout(known.timer);
    }
    const t: Tracked = { root, index: null, building: false, timer: null };
    projects.set(projectId, t);
    return t;
  }

  /** Bring the index up to date with the folder (a first build when there is none). */
  function run(projectId: string, fresh = false): Promise<void> {
    return serial(async () => {
      const t = projects.get(projectId);
      if (closed || !t) return;
      const first = fresh || !t.index;
      if (first) {
        t.building = true;
        announce(projectId);
      }
      const file = indexFileOf(deps.dir, t.root);
      try {
        await mkdir(deps.dir, { recursive: true });
        if (fresh) {
          t.index?.close();
          t.index = null;
        }
        const r = await runJob({ kind: 'sync', root: t.root, file, ...(fresh ? { fresh } : {}) });
        if (isClosed()) return;
        delete t.error;
        t.index ??= openFactIndex(file);
        if (
          'added' in r &&
          (r.added || r.changed || r.removed || r.linksAdded || r.linksRemoved || first)
        ) {
          deps.log?.(
            `Fact index ${projectId}: ${r.facts} facts, ${r.links} links (+${r.added} ~${r.changed} -${r.removed}); read ${r.ms.read} ms, extract ${r.ms.extract} ms, write ${r.ms.sync} ms`,
          );
        }
      } catch (e) {
        t.error = e instanceof Error ? e.message : String(e);
        deps.log?.(`Fact index ${projectId} failed: ${t.error}`);
      } finally {
        t.building = false;
      }
      announce(projectId);
    });
  }

  function schedule(projectId: string, ms: number) {
    const t = track(projectId);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = null;
      void run(projectId);
    }, ms);
  }

  const notReady = (projectId: string): Unavailable =>
    unavailable(
      deps.isPackage(projectId) ? 'package' : deps.root(projectId) ? 'not-built' : 'not-open',
    );

  const ready = (projectId: string): FactIndex | null => {
    const index = projects.get(projectId)?.index;
    return index && index.status().state !== 'none' ? index : null;
  };

  return {
    /** A project opened: build (or catch up) its index in the background. */
    opened(projectId: string) {
      schedule(projectId, openDelay);
    },
    /** Records of a project changed: update its index (debounced). */
    changed(projectId: string) {
      if (projects.has(projectId)) schedule(projectId, changeDelay);
    },
    status(projectId: string): FactIndexStatus {
      const t = projects.get(projectId);
      if (!t && track(projectId)) schedule(projectId, 0);
      return statusOf(t ?? projects.get(projectId));
    },
    query(projectId: string, q: FactQuery): { facts: Fact[]; total: number } | Unavailable {
      const index = ready(projectId);
      return index ? index.query(q) : notReady(projectId);
    },
    history(projectId: string, subject: string, limit?: number): FactHistory | Unavailable {
      const index = ready(projectId);
      return index ? index.historyOf(subject, limit) : notReady(projectId);
    },
    /** Delete the index and build it again from the files and journal. */
    async rebuild(
      projectId: string,
    ): Promise<
      { ok: true; status: FactIndexStatus } | { ok: false; error: string; reason: FactsUnavailable }
    > {
      const t = track(projectId);
      if (!t) return { ok: false, ...notReady(projectId) };
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      await run(projectId, true);
      return { ok: true, status: statusOf(t) };
    },
    /** A project folder was deleted or forgotten: drop its index. */
    async forget(root: string) {
      for (const [id, t] of projects) {
        if (resolve(t.root).toLowerCase() !== resolve(root).toLowerCase()) continue;
        if (t.timer) clearTimeout(t.timer);
        t.index?.close();
        projects.delete(id);
      }
      await serial(() => removeIndex(indexFileOf(deps.dir, root)));
    },
    /** Wait for the queued builds (tests and quit). */
    idle: () => serial(() => Promise.resolve()),
    /** Quit: no build starts after this, and the read connections close. */
    closeAll() {
      closed = true;
      for (const t of projects.values()) {
        if (t.timer) clearTimeout(t.timer);
        t.index?.close();
        t.index = null;
      }
      projects.clear();
    },
  };
}

export type FactService = ReturnType<typeof createFactService>;

type Handle = <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;

/** `facts:*` handlers. */
export function registerFactIpc(handle: Handle, facts: FactService): void {
  handle('facts:status', ({ projectId }) => ({ ok: true, status: facts.status(projectId) }));
  handle('facts:query', ({ projectId, query }) => {
    const r = facts.query(projectId, query);
    return 'reason' in r ? { ok: false, ...r } : { ok: true, ...r };
  });
  handle('facts:history', ({ projectId, subject, limit }) => {
    const r = facts.history(projectId, subject, limit);
    return 'reason' in r ? { ok: false, ...r } : { ok: true, history: r };
  });
  handle('facts:rebuild', ({ projectId }) => facts.rebuild(projectId));
}
