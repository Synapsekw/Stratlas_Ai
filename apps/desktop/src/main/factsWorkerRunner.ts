/**
 * Runs fact index jobs in a worker thread (`factsWorker.ts`, built as `factsWorker.js` beside the
 * main bundle). The worker starts on the first job and again after it exits; a job in flight when
 * it dies fails, and the service records that as the index's error (it is never run again on
 * main). A worker that cannot load (`new Worker` throws, it fails before it is online, or it exits
 * within `START_MS` of starting) is not tried again: its jobs and every later one run in process
 * through `fallback`, so the index still works, only on main's thread.
 */
import { Worker } from 'node:worker_threads';
import type { FactsJob, FactsJobResult, FactsRunner } from './facts';

/** A worker that fails within this long of starting is taken as unable to load. */
export const START_MS = 500;

type Reply =
  { id: number; ok: true; result: FactsJobResult } | { id: number; ok: false; error: string };

interface Pending {
  job: FactsJob;
  resolve: (r: FactsJobResult) => void;
  reject: (e: Error) => void;
}

export function createWorkerRunner(
  script: string,
  opts: {
    fallback?: FactsRunner;
    make?: (script: string) => Worker;
    log?: (line: string) => void;
    /** Test hook: the clock. */
    now?: () => number;
  } = {},
): FactsRunner & { stop(): Promise<void> } {
  const make = opts.make ?? ((s: string) => new Worker(s));
  const now = opts.now ?? Date.now;
  let worker: Worker | null = null;
  let broken = false;
  let next = 1;
  const pending = new Map<number, Pending>();

  /** Run the waiting jobs in process from now on: the worker cannot load here. */
  const fallBack = (why: string): boolean => {
    const fallback = opts.fallback;
    if (!fallback) return false;
    broken = true;
    opts.log?.(`Fact index worker could not start (${why}); building in process`);
    const jobs = [...pending.values()];
    pending.clear();
    for (const p of jobs) fallback(p.job).then(p.resolve, p.reject);
    return true;
  };

  /** A crash later on (a huge project) fails its job; it is never run again on main. */
  const failAll = (why: string) => {
    const jobs = [...pending.values()];
    pending.clear();
    for (const p of jobs) p.reject(new Error(why));
  };

  const start = (): Worker => {
    if (worker) return worker;
    const w = make(script);
    const startedAt = now();
    let online = false;
    const soon = () => now() - startedAt < START_MS;
    w.on('online', () => {
      online = true;
    });
    w.on('message', (m: Reply) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    });
    w.on('error', (e: Error) => {
      const why = `The fact index worker failed: ${e.message}`;
      // before it is online the module did not load
      if (!((!online || soon()) && fallBack(why))) failAll(why);
    });
    w.on('exit', (code) => {
      if (worker === w) worker = null;
      if (!pending.size) return;
      const why = `The fact index worker stopped (exit ${String(code)}).`;
      if (!(soon() && fallBack(why))) failAll(why);
    });
    // never keep the app alive for an idle worker
    w.unref();
    worker = w;
    return w;
  };

  const run = ((job) => {
    if (broken && opts.fallback) return opts.fallback(job);
    return new Promise<FactsJobResult>((resolve, reject) => {
      const id = next++;
      pending.set(id, { job, resolve, reject });
      try {
        start().postMessage({ id, job });
      } catch (e) {
        // new Worker threw at once (a missing file, no threads): the same as failing to load
        const why = e instanceof Error ? e.message : String(e);
        if (!fallBack(why)) failAll(why);
      }
    });
  }) as FactsRunner & { stop(): Promise<void> };
  run.stop = async () => {
    const w = worker;
    worker = null;
    if (w) await w.terminate();
  };
  return run;
}
