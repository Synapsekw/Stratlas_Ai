/**
 * The renderer side of the RF preview Worker (`preview.worker.ts`, `@aio/rf` `servePreview`):
 * path-loss grids are worked out once in the Worker and kept there by key, so a setting change
 * sends only settings. Messages run in order, so a grid asked for before a preview is ready for
 * it. `connectPreview` takes any port, so the round trip is tested without a Worker.
 */
import type {
  PreviewGrid,
  PreviewMessage,
  PreviewOutput,
  PreviewReply,
  PreviewRequest,
} from '@aio/rf';
import type { PathLossJob } from './previewInput';

/** The slice of a Worker the client uses. */
export interface PreviewClientPort {
  postMessage(message: PreviewMessage, transfer?: Transferable[]): void;
  onmessage: ((e: { data: PreviewReply }) => void) | null;
  onerror?: ((e: { message?: string }) => void) | null;
  terminate?(): void;
}

export interface PreviewResult {
  output: PreviewOutput;
  elapsedMs: number;
}

export interface PreviewClient {
  /**
   * Work these path-loss grids out (once per key) on `grid` within `radiusM` of each antenna, and
   * drop the grids an earlier plan asked for that this one no longer uses (a height step or a
   * moved grid makes new keys; the Worker would otherwise keep every old grid).
   */
  pathLoss(grid: PreviewGrid, radiusM: number, jobs: readonly PathLossJob[]): void;
  preview(request: PreviewRequest): Promise<PreviewResult>;
  dispose(): void;
}

export function connectPreview(port: PreviewClientPort): PreviewClient {
  const asked = new Set<string>();
  const pending = new Map<number, { ok: (r: PreviewResult) => void; fail: (e: Error) => void }>();
  let seq = 0;
  let closed = false;
  const failAll = (e: Error) => {
    for (const p of pending.values()) p.fail(e);
    pending.clear();
  };
  port.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.ok) p.ok({ output: data.output, elapsedMs: data.elapsedMs });
    else p.fail(new Error(data.error));
  };
  port.onerror = (e) => {
    failAll(new Error(e.message ?? 'The preview stopped.'));
    // a dead Worker forgets its grids: ask again in a new one
    asked.clear();
  };
  return {
    pathLoss(grid, radiusM, jobs) {
      if (closed) return;
      const wanted = new Set(jobs.map((j) => j.key));
      for (const key of [...asked]) {
        if (wanted.has(key)) continue;
        asked.delete(key);
        port.postMessage({ type: 'path-loss:drop', key });
      }
      for (const j of jobs) {
        if (asked.has(j.key)) continue;
        asked.add(j.key);
        port.postMessage({
          type: 'path-loss:compute',
          key: j.key,
          grid,
          antenna: j.antenna,
          setup: j.setup,
          radiusM,
        });
      }
    },
    preview(request) {
      if (closed) return Promise.reject(new Error('The preview is closed.'));
      const id = ++seq;
      return new Promise<PreviewResult>((ok, fail) => {
        pending.set(id, { ok, fail });
        port.postMessage({ type: 'preview', id, input: request });
      });
    },
    dispose() {
      if (closed) return;
      closed = true;
      failAll(new Error('The preview is closed.'));
      port.onmessage = null;
      port.terminate?.();
    },
  };
}

/** Start the module Worker. */
export function startPreviewWorker(): PreviewClient {
  const w = new Worker(new URL('./preview.worker.ts', import.meta.url), {
    type: 'module',
    name: 'rf-preview',
  });
  return connectPreview(w as unknown as PreviewClientPort);
}
