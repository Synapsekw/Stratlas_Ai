import type { IpcRequest, IpcResponse, JobEvent, JobRecord } from '@aio/schema';

type StartRequest = IpcRequest<'jobs:start'>;

const ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const PIPELINE = 'flyability.import';

/**
 * Flyability Inspector imports run one at a time on this computer (9 Nov 2026): a mission folder
 * of four chambers is four heavy jobs (cloud conversion, ray casts), so the chambers after the
 * first wait here, first in first out, and each starts when the Inspector import before it has
 * ended, whoever started that one. The queue lives in memory only: after a quit the chambers that
 * had not started are imported again from Add data (their spaces are kept, so they go back in).
 */
export function inspectorLane(deps: {
  /** The job runner's start (behind the `jobs:start` gates). */
  start(req: StartRequest): Promise<IpcResponse<'jobs:start'>>;
  /** Whether an Inspector import runs now (one the lane did not start counts too). */
  busy(): Promise<boolean>;
  log?(line: string): void;
}) {
  const waiting: StartRequest[] = [];
  let running: string | null = null;
  let starting = false;

  async function launch(req: StartRequest): Promise<IpcResponse<'jobs:start'>> {
    const r = await deps.start(req);
    if (r.ok) running = ENDED.has(r.job.status) ? null : r.job.id;
    return r;
  }

  async function next(): Promise<void> {
    if (starting) return;
    starting = true;
    try {
      while (running === null && waiting.length > 0) {
        if (await deps.busy()) return;
        const req = waiting.shift();
        if (!req) return;
        let r: IpcResponse<'jobs:start'>;
        try {
          r = await launch(req);
        } catch (e) {
          r = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!r.ok) deps.log?.(`A waiting Flyability Inspector import did not start: ${r.error}`);
      }
    } finally {
      starting = false;
    }
  }

  return {
    /** Start now when no Inspector import runs, else wait in line. */
    async start(
      req: StartRequest,
    ): Promise<
      { ok: true; job: JobRecord } | { ok: true; queued: true } | { ok: false; error: string }
    > {
      if (running !== null || starting || waiting.length > 0) {
        waiting.push(req);
        return { ok: true, queued: true };
      }
      starting = true;
      try {
        if (await deps.busy()) {
          waiting.push(req);
          return { ok: true, queued: true };
        }
        return await launch(req);
      } finally {
        starting = false;
      }
    },
    /** A job event: an Inspector import ended, the next waiting one starts. */
    settled(e: JobEvent): Promise<void> {
      if (e.type !== 'update' || e.job.pipeline !== PIPELINE || !ENDED.has(e.job.status))
        return Promise.resolve();
      if (e.job.id === running) running = null;
      return next();
    },
    /** Waiting imports, oldest first (tests, the update gate). */
    waiting(): readonly StartRequest[] {
      return waiting;
    },
    running(): string | null {
      return running;
    },
  };
}

export type InspectorLane = ReturnType<typeof inspectorLane>;
