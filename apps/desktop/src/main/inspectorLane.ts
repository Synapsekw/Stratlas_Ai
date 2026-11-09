import type { IpcRequest, IpcResponse, JobEvent, JobRecord } from '@aio/schema';
import { resolve } from 'node:path';

type StartRequest = IpcRequest<'jobs:start'>;

const ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const PIPELINE = 'flyability.import';

/** What became of a chamber that waited in the lane (sent to the window for the import card). */
export type LaneNotice =
  | { project: string; src: string; state: 'started'; jobId: string }
  | { project: string; src: string; state: 'dropped'; reason: 'cancelled' | 'closed' }
  | { project: string; src: string; state: 'failed'; error: string };

interface Waiting {
  req: StartRequest;
  project: string;
  src: string;
  /** The inspections it imports: their pre-made spaces are kept while it waits or runs. */
  inspections: string[];
}

const folderKey = (p: string) => {
  const r = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function inspectionsOf(params: Record<string, unknown>): string[] {
  const list = params.inspections;
  if (!Array.isArray(list)) return [];
  return list.flatMap((i) => {
    const id = (i as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? [id] : [];
  });
}

/**
 * Flyability Inspector imports run one at a time on this computer (9 Nov 2026): a mission folder
 * of four chambers is four heavy jobs (cloud conversion, ray casts), so the chambers after the
 * first wait here, first in first out, and each starts when the Inspector import before it has
 * ended, whoever started that one (a resume from the Jobs panel waits in the same line).
 *
 * A chamber of a project whose Inspector import was cancelled, or a project that was closed or
 * deleted, leaves the line (`dropped`); one that cannot start when its turn comes says why
 * (`failed`). After each of these, and whenever an Inspector import ends, the project's
 * pre-made chamber spaces that stayed empty are removed (`tidy`), except those of chambers still
 * waiting or running. The line lives in memory only: after a quit the app tidies the empty spaces
 * on start, and the chambers are imported again from Add data.
 */
export function inspectorLane(deps: {
  /** The job runner's start (behind the `jobs:start` gates). */
  start(req: StartRequest): Promise<IpcResponse<'jobs:start'>>;
  /** Whether an Inspector import runs now (one the lane did not start counts too). */
  busy(): Promise<boolean>;
  log?(line: string): void;
  /** A waiting chamber started, left the line or could not start. */
  notify?(n: LaneNotice): void;
  /** Remove the project's empty chamber spaces, except those of the inspections in `keep`. */
  tidy?(project: string, keep: ReadonlySet<string>): Promise<void>;
  /** The job a resume names (its project and params). */
  record?(id: string): Pick<JobRecord, 'project' | 'params'> | undefined;
}) {
  const waiting: Waiting[] = [];
  let running: (Waiting & { jobId: string }) | null = null;
  let starting = false;

  const entryOf = (req: StartRequest): Waiting => {
    const from =
      'resume' in req
        ? (deps.record?.(req.resume) ?? { project: '', params: {} })
        : { project: req.project, params: req.params };
    const src = from.params.src;
    return {
      req,
      project: from.project,
      src: typeof src === 'string' ? src : '',
      inspections: inspectionsOf(from.params),
    };
  };

  async function launch(w: Waiting): Promise<IpcResponse<'jobs:start'>> {
    const r = await deps.start(w.req);
    if (r.ok) running = ENDED.has(r.job.status) ? null : { ...w, jobId: r.job.id };
    return r;
  }

  async function tidy(project: string): Promise<void> {
    if (!deps.tidy || project === '') return;
    const key = folderKey(project);
    const keep = new Set<string>();
    for (const w of [...waiting, ...(running ? [running] : [])])
      if (folderKey(w.project) === key) for (const i of w.inspections) keep.add(i);
    try {
      await deps.tidy(project, keep);
    } catch (e) {
      deps.log?.(
        `Empty chamber spaces were not tidied: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function drop(project: string, reason: 'cancelled' | 'closed'): number {
    const key = folderKey(project);
    const gone = waiting.filter((w) => folderKey(w.project) === key);
    if (gone.length === 0) return 0;
    waiting.splice(0, waiting.length, ...waiting.filter((w) => folderKey(w.project) !== key));
    for (const w of gone)
      deps.notify?.({ project: w.project, src: w.src, state: 'dropped', reason });
    return gone.length;
  }

  async function next(): Promise<void> {
    if (starting) return;
    starting = true;
    try {
      while (running === null && waiting.length > 0) {
        if (await deps.busy()) return;
        const w = waiting.shift();
        if (!w) return;
        let r: IpcResponse<'jobs:start'>;
        try {
          r = await launch(w);
        } catch (e) {
          r = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (r.ok) {
          deps.notify?.({ project: w.project, src: w.src, state: 'started', jobId: r.job.id });
        } else {
          deps.log?.(`A waiting Flyability Inspector import did not start: ${r.error}`);
          deps.notify?.({ project: w.project, src: w.src, state: 'failed', error: r.error });
          await tidy(w.project);
        }
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
      const w = entryOf(req);
      if (running !== null || starting || waiting.length > 0) {
        waiting.push(w);
        return { ok: true, queued: true };
      }
      starting = true;
      try {
        if (await deps.busy()) {
          waiting.push(w);
          return { ok: true, queued: true };
        }
        return await launch(w);
      } finally {
        starting = false;
      }
    },
    /**
     * A job event: an Inspector import ended. A cancelled one takes its project's waiting
     * chambers out of the line; the empty spaces are tidied; the next waiting one starts.
     */
    async settled(e: JobEvent): Promise<void> {
      if (e.type !== 'update' || e.job.pipeline !== PIPELINE || !ENDED.has(e.job.status)) return;
      if (e.job.id === running?.jobId) running = null;
      if (e.job.status === 'cancelled') drop(e.job.project, 'cancelled');
      await tidy(e.job.project);
      await next();
    },
    /** The project was closed or deleted: its waiting chambers leave the line. */
    async cancelProject(project: string): Promise<number> {
      const n = drop(project, 'closed');
      await tidy(project);
      return n;
    },
    /** Waiting imports, oldest first (tests, the update gate). */
    waiting(): readonly StartRequest[] {
      return waiting.map((w) => w.req);
    },
    running(): string | null {
      return running?.jobId ?? null;
    },
  };
}

export type InspectorLane = ReturnType<typeof inspectorLane>;

/** A Jobs-panel start or resume of an Inspector import while another one runs. */
export const INSPECTOR_QUEUED =
  'This Inspector import waits for the one running and starts when that one ends.';

/**
 * On app start no job runs, so the empty chamber spaces of every project an Inspector import
 * ran in go (a quit while chambers waited leaves them behind). Each project once; a project that
 * is gone or unreadable is left alone.
 */
export async function tidyInspectorSpacesOnStart(
  records: readonly Pick<JobRecord, 'pipeline' | 'project'>[],
  tidy: (project: string) => Promise<void>,
): Promise<void> {
  const seen = new Set<string>();
  for (const r of records) {
    if (r.pipeline !== PIPELINE || seen.has(folderKey(r.project))) continue;
    seen.add(folderKey(r.project));
    await tidy(r.project).catch(() => undefined);
  }
}
