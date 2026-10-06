import { brand } from '@aio/brand';
import { utilityProcess } from 'electron';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { utilityLog } from '../diagnostics/electron';
import type { ExportJob, ExportProgress, ExportResult } from './run';
import type { FromWorker, ToWorker } from './worker';

/**
 * Run one file export in its own utility process, so parsing thousands of issues and writing
 * masks never blocks main or the renderer. Cancelling asks the process to stop, then kills it.
 */
export function runInUtility(
  job: ExportJob,
  progress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(import.meta.dirname, 'exportWorker.js'), [], {
      serviceName: `${brand.productName} export`,
      stdio: 'pipe',
    });
    // The worker's console goes to utility.log (diagnostics).
    const log = utilityLog();
    child.stdout?.on('data', (b: Buffer) => log?.write('info', [b.toString('utf8').trimEnd()]));
    child.stderr?.on('data', (b: Buffer) => log?.write('error', [b.toString('utf8').trimEnd()]));
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
      child.kill();
    };
    const onAbort = () => {
      const msg: ToWorker = { type: 'cancel' };
      child.postMessage(msg);
      // A stuck job is killed; its partial file is removed here.
      setTimeout(() => {
        finish(() => {
          reject(new Error('Export cancelled.'));
        });
        void rm(`${job.outPath}.part`, { force: true });
      }, 2000);
    };
    signal.addEventListener('abort', onAbort);
    child.on('message', (m: FromWorker) => {
      if (m.type === 'progress') progress({ phase: m.phase, done: m.done, total: m.total });
      else if (m.type === 'done')
        finish(() => {
          resolve({ count: m.count, bytes: m.bytes });
        });
      else
        finish(() => {
          reject(new Error(m.message));
        });
    });
    child.on('exit', (code) => {
      finish(() => {
        reject(new Error(`The export process stopped unexpectedly (code ${String(code)}).`));
      });
    });
    child.once('spawn', () => {
      const run: ToWorker = { type: 'run', job };
      child.postMessage(run);
    });
  });
}
