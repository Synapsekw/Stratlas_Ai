/**
 * Reading a run's grids off the main thread (integration review I1). `serveRunReader` is the
 * Worker side (`run.worker.ts`): it fetches the three GeoTIFFs and answers with `readRunGrids`,
 * moving the arrays across. `connectRunReader` is the renderer side. Both take any port, so the
 * round trip is tested without a Worker.
 */
import type { RfRun } from '@aio/schema';
import { readRunGrids, type CoverageGrids } from './runGrids';

export interface RunReadMessage {
  id: number;
  run: RfRun;
  /** The rsrp, best server and overlap GeoTIFFs, in that order. */
  urls: [string, string, string];
}

export type RunReadReply =
  { id: number; ok: true; grids: CoverageGrids } | { id: number; ok: false; error: string };

/** The slice of a Worker's global scope the reader uses. */
export interface RunReaderPort {
  postMessage(message: RunReadReply, transfer?: Transferable[]): void;
  onmessage: ((e: { data: RunReadMessage }) => void) | null;
}

/** A fetch answer, as far as the reader reads it. */
interface Fetched {
  ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The reader's message handler (the Worker's whole job). */
export function serveRunReader(port: RunReaderPort, get: (url: string) => Promise<Fetched>): void {
  port.onmessage = ({ data }) => {
    void (async () => {
      try {
        const files = await Promise.all(
          data.urls.map(async (u) => {
            const r = await get(u);
            return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
          }),
        );
        const [rsrp, bestServer, overlap] = files;
        if (!rsrp || !bestServer || !overlap) throw new Error('The run has no coverage grids.');
        const grids = readRunGrids(data.run, { rsrp, bestServer, overlap });
        port.postMessage({ id: data.id, ok: true, grids }, [
          grids.rsrp.buffer,
          grids.bestServer.buffer,
          grids.overlap.buffer,
        ]);
      } catch (e) {
        port.postMessage({
          id: data.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  };
}

/** The slice of a Worker the client uses. */
export interface RunClientPort {
  postMessage(message: RunReadMessage): void;
  onmessage: ((e: { data: RunReadReply }) => void) | null;
  onerror?: ((e: { message?: string }) => void) | null;
  terminate?(): void;
}

export interface RunReader {
  /** The run's grids as drawn, from its three GeoTIFF urls (rsrp, best server, overlap). */
  read(run: RfRun, urls: [string, string, string]): Promise<CoverageGrids>;
  dispose(): void;
}

export function connectRunReader(port: RunClientPort): RunReader {
  const pending = new Map<number, { ok: (g: CoverageGrids) => void; fail: (e: Error) => void }>();
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
    if (data.ok) p.ok(data.grids);
    else p.fail(new Error(data.error));
  };
  port.onerror = (e) => {
    failAll(new Error(e.message ?? 'The run reader stopped.'));
  };
  return {
    read(run, urls) {
      if (closed) return Promise.reject(new Error('The run reader is closed.'));
      const id = ++seq;
      return new Promise<CoverageGrids>((ok, fail) => {
        pending.set(id, { ok, fail });
        port.postMessage({ id, run, urls });
      });
    },
    dispose() {
      if (closed) return;
      closed = true;
      failAll(new Error('The run reader is closed.'));
      port.onmessage = null;
      port.terminate?.();
    },
  };
}

/** Start the module Worker. */
export function startRunWorker(): RunReader {
  const w = new Worker(new URL('./run.worker.ts', import.meta.url), {
    type: 'module',
    name: 'rf-run',
  });
  return connectRunReader(w as unknown as RunClientPort);
}
