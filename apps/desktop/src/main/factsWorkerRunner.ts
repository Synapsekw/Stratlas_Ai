/**
 * Runs fact index jobs in a worker thread (`factsWorker.ts`, built as `factsWorker.js` beside the
 * main bundle). The worker starts on the first job and again after it exits; a job in flight when
 * it dies fails, and the service records that as the index's error. A worker that cannot start at
 * all (it fails before its first answer) is not tried again: its jobs and every later one run in
 * process through `fallback`, so the index still works, only on main's thread.
 */
import { Worker } from 'node:worker_threads';
import type { FactsJob, FactsJobResult, FactsRunner } from './facts';

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
  } = {},
): FactsRunner & { stop(): Promise<void> } {
  const make = opts.make ?? ((s: string) => new Worker(s));
  let worker: Worker | null = null;
  /** The worker answered at least once: it can start. */
  let proven = false;
  let broken = false;
  let next = 1;
  const pending = new Map<number, Pending>();

  const giveUp = (why: string) => {
    const jobs = [...pending.values()];
    pending.clear();
    const fallback = opts.fallback;
    if (!proven && fallback) {
      broken = true;
      opts.log?.(`Fact index worker could not start (${why}); building in process`);
      for (const p of jobs) fallback(p.job).then(p.resolve, p.reject);
      return;
    }
    for (const p of jobs) p.reject(new Error(why));
  };

  const start = (): Worker => {
    if (worker) return worker;
    const w = make(script);
    w.on('message', (m: Reply) => {
      proven = true;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    });
    w.on('error', (e: Error) => {
      giveUp(`The fact index worker failed: ${e.message}`);
    });
    w.on('exit', (code) => {
      if (worker === w) worker = null;
      if (pending.size) giveUp(`The fact index worker stopped (exit ${String(code)}).`);
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
      start().postMessage({ id, job });
    });
  }) as FactsRunner & { stop(): Promise<void> };
  run.stop = async () => {
    const w = worker;
    worker = null;
    if (w) await w.terminate();
  };
  return run;
}
