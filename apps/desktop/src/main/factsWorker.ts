/**
 * The fact index worker thread (M1): reads a project folder, extracts its facts and writes the
 * index file, off main's thread. One job at a time; main queues them (`facts.ts`).
 */
import { parentPort } from 'node:worker_threads';
import { runInProcess, type FactsJob } from './facts';

parentPort?.on('message', (msg: { id: number; job: FactsJob }) => {
  runInProcess(msg.job).then(
    (result) => parentPort?.postMessage({ id: msg.id, ok: true, result }),
    (e: unknown) =>
      parentPort?.postMessage({
        id: msg.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
  );
});
