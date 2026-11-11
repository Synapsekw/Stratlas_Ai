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
 * - Packages get no index (state `none`): they are read-only and the agent tools stay away.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  extractFacts,
  openFactIndex,
  readProjectSources,
  type FactIndex,
  type ProjectSources,
} from '@aio/facts';
import type { Fact, FactHistory, FactIndexStatus, FactQuery, IpcChannel } from '@aio/schema';
import type { Handler } from './ipc';

export interface FactServiceDeps {
  /** `userData/fact-index`. */
  dir: string;
  root(projectId: string): string | undefined;
  isPackage(projectId: string): boolean;
  /** `facts:changed` to the renderer. */
  emit?: (e: { projectId: string; status: FactIndexStatus }) => void;
  /** Test hook: the sources reader. */
  read?: (root: string) => Promise<ProjectSources>;
  /** Wait after an open before the first build (ms). */
  openDelayMs?: number;
  /** Debounce of updates after a change (ms). */
  changeDelayMs?: number;
  log?: (line: string) => void;
}

interface Tracked {
  root: string;
  index: FactIndex | null;
  /** First build or rebuild running. */
  building: boolean;
  error?: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const EMPTY: FactIndexStatus = { state: 'none', counts: {}, links: 0 };

/** The index file of a folder: a hash of its path, so renames of the project name do not matter. */
export const indexFileOf = (dir: string, root: string): string =>
  join(
    dir,
    `${createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 32)}.sqlite`,
  );

export function createFactService(deps: FactServiceDeps) {
  const read = deps.read ?? readProjectSources;
  const openDelay = deps.openDelayMs ?? 2000;
  const changeDelay = deps.changeDelayMs ?? 1500;
  const projects = new Map<string, Tracked>();
  // one build at a time across projects (light local load)
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  function statusOf(t: Tracked | undefined): FactIndexStatus {
    if (!t) return EMPTY;
    if (t.building) {
      return { ...(t.index ? t.index.status() : EMPTY), state: 'building' };
    }
    if (t.error) {
      return {
        ...(t.index ? t.index.status() : EMPTY),
        state: 'error',
        error: t.error.slice(0, 500),
      };
    }
    return t.index ? t.index.status() : EMPTY;
  }

  const announce = (projectId: string) => {
    deps.emit?.({ projectId, status: statusOf(projects.get(projectId)) });
  };

  function track(projectId: string): Tracked | null {
    if (deps.isPackage(projectId)) return null;
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

  async function removeFiles(file: string) {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) await rm(f, { force: true });
  }

  async function openIndex(t: Tracked): Promise<FactIndex> {
    if (t.index) return t.index;
    await mkdir(deps.dir, { recursive: true });
    const file = indexFileOf(deps.dir, t.root);
    try {
      t.index = openFactIndex(file);
    } catch {
      // a damaged index is derived data: drop it and start again
      await removeFiles(file);
      t.index = openFactIndex(file);
    }
    return t.index;
  }

  /** Bring the index up to date with the folder (a first build when it is empty). */
  function run(projectId: string): Promise<void> {
    return serial(async () => {
      const t = projects.get(projectId);
      if (!t) return;
      const first = !t.index || t.index.status().state === 'none';
      if (first) {
        t.building = true;
        announce(projectId);
      }
      try {
        const index = await openIndex(t);
        const started = Date.now();
        const r = index.sync(extractFacts(await read(t.root)));
        delete t.error;
        if (r.added || r.changed || r.removed || r.linksAdded || r.linksRemoved || first) {
          deps.log?.(
            `Fact index ${projectId}: +${r.added} ~${r.changed} -${r.removed} facts, +${r.linksAdded} -${r.linksRemoved} links in ${Date.now() - started} ms`,
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

  const notReady = (projectId: string) =>
    deps.isPackage(projectId)
      ? 'Packages have no fact index.'
      : 'The fact index of this project is not built yet.';

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
    query(projectId: string, q: FactQuery): { facts: Fact[]; total: number } | { error: string } {
      const index = projects.get(projectId)?.index;
      if (!index || index.status().state === 'none') return { error: notReady(projectId) };
      return index.query(q);
    },
    history(projectId: string, subject: string, limit?: number): FactHistory | { error: string } {
      const index = projects.get(projectId)?.index;
      if (!index || index.status().state === 'none') return { error: notReady(projectId) };
      return index.historyOf(subject, limit);
    },
    /** Delete the index and build it again from the files and journal. */
    async rebuild(
      projectId: string,
    ): Promise<{ ok: true; status: FactIndexStatus } | { ok: false; error: string }> {
      const t = track(projectId);
      if (!t) return { ok: false, error: notReady(projectId) };
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      await serial(async () => {
        t.index?.close();
        t.index = null;
        await removeFiles(indexFileOf(deps.dir, t.root));
      });
      await run(projectId);
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
      await serial(() => removeFiles(indexFileOf(deps.dir, root)));
    },
    /** Wait for the queued builds (tests and quit). */
    idle: () => serial(() => Promise.resolve()),
    closeAll() {
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
    return 'error' in r ? { ok: false, error: r.error } : { ok: true, ...r };
  });
  handle('facts:history', ({ projectId, subject, limit }) => {
    const r = facts.history(projectId, subject, limit);
    return 'error' in r ? { ok: false, error: r.error } : { ok: true, history: r };
  });
  handle('facts:rebuild', ({ projectId }) => facts.rebuild(projectId));
}
