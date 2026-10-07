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
/** Queued writes kept apart; more are merged (fast bursts of commands). */
const MAX_STEPS = 20;

/** One write: the list after a command, and the commands it carries. */
interface Step {
  issues: Issue[];
  commands: EditCommand[];
}

/** Several steps as one write: the newest list with every command, in order. */
function merge(steps: readonly Step[]): Step {
  return {
    issues: steps[steps.length - 1]?.issues ?? [],
    commands: steps.flatMap((s) => s.commands).slice(-MAX_COMMANDS),
  };
}

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
 *
 * M9: each labelled editor command is written as its own step (the list as it stood after that
 * command), so the journal attributes every field to the command that changed it ("F01 severity
 * 1 to 3", then "F01 to reviewed") instead of one write with the last label. Changes without a
 * command join the step before them; past `MAX_STEPS` queued steps, the oldest are merged.
 */
export function createIssueSaver(opts: { write: WriteIssues; delayMs?: number }): IssueSaver {
  const delay = opts.delayMs ?? 600;
  let status: SaveState = { state: 'saved' };
  let queued: { projectId: string; steps: Step[] } | null = null;
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
      let steps = job.steps;
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step) break;
        let failed: string | null = null;
        try {
          const r = await (step.commands.length
            ? opts.write(job.projectId, step.issues, step.commands)
            : opts.write(job.projectId, step.issues));
          if (!r.ok) failed = r.error ?? 'Issues could not be saved';
        } catch (e) {
          failed = e instanceof Error ? e.message : String(e);
        }
        if (failed === null) {
          set({ state: 'saved', savedAt: Date.now() });
          continue;
        }
        set({ state: 'error', error: failed });
        // still try the newest list once, with every remaining command
        const rest = steps.slice(i + 1);
        const last = rest[rest.length - 1];
        if (!last) break;
        steps = [...steps.slice(0, i + 1), merge(rest)];
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
      const steps = queued?.projectId === projectId ? queued.steps : [];
      const last = steps[steps.length - 1];
      const cmd = command ? { ...command, ids: command.ids.slice(0, MAX_IDS) } : null;
      if (!cmd) {
        if (last) last.issues = issues;
        else steps.push({ issues, commands: [] });
      } else if (last?.commands.length === 0) {
        last.issues = issues;
        last.commands = [cmd];
      } else {
        steps.push({ issues, commands: [cmd] });
      }
      while (steps.length > MAX_STEPS) steps.splice(0, 2, merge(steps.slice(0, 2)));
      queued = { projectId, steps };
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
