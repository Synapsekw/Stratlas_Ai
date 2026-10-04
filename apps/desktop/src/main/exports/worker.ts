// Entry of the export utility process (Electron utilityProcess). One process per job: it gets
// `{ type: 'run', job }`, posts progress, then `done` or `error`. `{ type: 'cancel' }` aborts.
import { runExport, type ExportJob } from './run';

export type ToWorker = { type: 'run'; job: ExportJob } | { type: 'cancel' };
export type FromWorker =
  | { type: 'progress'; phase: string; done: number; total: number }
  | { type: 'done'; count: number; bytes: number }
  | { type: 'error'; message: string };

const port = process.parentPort;
const ac = new AbortController();
const post = (m: FromWorker) => {
  port.postMessage(m);
};

port.on('message', (e) => {
  const msg = e.data as ToWorker;
  if (msg.type === 'cancel') {
    ac.abort();
    return;
  }
  runExport(
    msg.job,
    (p) => {
      post({ type: 'progress', ...p });
    },
    ac.signal,
  ).then(
    (r) => {
      post({ type: 'done', ...r });
    },
    (err: unknown) => {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    },
  );
});
