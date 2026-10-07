import type { AioBridge, EditCommand, Issue } from '@aio/schema';

export type SaveStateName = 'saved' | 'pending' | 'saving' | 'error';

export interface SaveState {
  state: SaveStateName;
  error?: string;
  /** Epoch ms of the last successful write. */
  savedAt?: number;
}

export type WriteIssues = (
  projectId: string,
  issues: Issue[],
  /** M9: the editor's labelled commands since the last write (readable history). */
  commands?: EditCommand[],
) => Promise<{ ok: boolean; error?: string | undefined }>;

/** The contract's limits on `commands` (`project:writeIssues`). */
const MAX_COMMANDS = 1000;
const MAX_IDS = 10_000;

export interface IssueSaver {
  readonly status: SaveState;
  /**
   * Queue the full issue list of a project for a debounced write. `command` (the editor's label
   * and the ids it touched) travels with the write, so the journal reads "F01 to reviewed".
   */
  schedule(projectId: string, issues: Issue[], command?: EditCommand): void;
  /** Write any queued change now. */
  flush(): Promise<void>;
  subscribe(listener: (s: SaveState) => void): () => void;
  /** Forget a queued write (project closed). */
  cancel(): void;
}

/**
 * Debounced writer for issues.json. Only the newest list is written; a change that arrives while a
 * write is running is written after it.
 */
export function createIssueSaver(opts: { write: WriteIssues; delayMs?: number }): IssueSaver {
  const delay = opts.delayMs ?? 600;
  let status: SaveState = { state: 'saved' };
  let queued: { projectId: string; issues: Issue[]; commands: EditCommand[] } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  const listeners = new Set<(s: SaveState) => void>();
  const hasQueued = () => queued !== null;

  const set = (s: SaveState) => {
    status = s;
    for (const l of listeners) l(s);
  };

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  };

  const run = async (): Promise<void> => {
    if (running) {
      await running;
      return;
    }
    const job = queued;
    if (!job) return;
    queued = null;
    set({ ...status, state: 'saving' });
    running = (async () => {
      try {
        const r = await (job.commands.length
          ? opts.write(job.projectId, job.issues, job.commands)
          : opts.write(job.projectId, job.issues));
        if (r.ok) set({ state: 'saved', savedAt: Date.now() });
        else set({ state: 'error', error: r.error ?? 'Issues could not be saved' });
      } catch (e) {
        set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    })();
    await running;
    running = null;
    if (hasQueued()) {
      set({ ...status, state: 'pending' });
      arm();
    }
  };

  return {
    get status() {
      return status;
    },
    schedule(projectId, issues, command) {
      const carried = queued?.projectId === projectId ? queued.commands : [];
      const commands = command
        ? [...carried, { ...command, ids: command.ids.slice(0, MAX_IDS) }].slice(-MAX_COMMANDS)
        : carried;
      queued = { projectId, issues, commands };
      if (running) return;
      if (status.state !== 'pending') set({ ...status, state: 'pending' });
      arm();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (running) await running;
      await run();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      queued = null;
      set({ state: 'saved' });
    },
  };
}

/** The renderer's IPC writer: `project:writeIssues` through `window.aio`. */
export const ipcWriteIssues: WriteIssues = async (projectId, issues, commands) => {
  const bridge = (globalThis as { aio?: AioBridge }).aio;
  if (!bridge) return { ok: false, error: 'Not running in the desktop app; issues are not saved' };
  return bridge.invoke('project:writeIssues', {
    projectId,
    issues,
    ...(commands?.length ? { commands } : {}),
  });
};
