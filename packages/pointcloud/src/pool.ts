import type { CopcHierarchy, CopcPage, CopcSource } from './copc';
import type { DecodedChunk, DecodeRequest, WorkerRequest, WorkerResult } from './protocol';

type Job = DecodeRequest extends infer R
  ? R extends DecodeRequest
    ? Omit<R, 'id'>
    : never
  : never;
type AnyJob = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'id'>
    : never
  : never;

/** Something that decodes chunks; the real one is a pool of module workers. */
export interface Decoder {
  decode(job: Job): Promise<DecodedChunk>;
  /** COPC header and cube (workers only; test decoders may leave it out). */
  copcSource?(url: string): Promise<CopcSource>;
  /** One COPC hierarchy page. */
  copcPage?(url: string, page: CopcPage): Promise<CopcHierarchy>;
  dispose(): void;
}

/** A small pool of module workers; jobs go to the least busy worker. */
export function createWorkerPool(size = defaultSize()): Decoder {
  const workers: { w: Worker; busy: number }[] = [];
  const pending = new Map<
    number,
    { resolve: (r: WorkerResult) => void; reject: (e: Error) => void; slot: number }
  >();
  let next = 1;
  for (let i = 0; i < size; i++) {
    const w = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: `pointcloud-${i}`,
    });
    const slot = i;
    w.onmessage = (e: MessageEvent<WorkerResult>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      const entry = workers[slot];
      if (entry) entry.busy--;
      if ('error' in e.data) p.reject(new Error(e.data.error));
      else p.resolve(e.data);
    };
    w.onerror = (e) => {
      for (const [id, p] of pending) {
        if (p.slot !== slot) continue;
        pending.delete(id);
        p.reject(new Error(e.message || 'Point cloud decode worker failed'));
      }
      const entry = workers[slot];
      if (entry) entry.busy = 0;
    };
    workers.push({ w, busy: 0 });
  }
  const send = (job: AnyJob): Promise<WorkerResult> => {
    const id = next++;
    let slot = 0;
    workers.forEach((x, i) => {
      if (x.busy < (workers[slot]?.busy ?? Infinity)) slot = i;
    });
    const entry = workers[slot];
    if (!entry) return Promise.reject(new Error('The decode pool is disposed'));
    entry.busy++;
    return new Promise<WorkerResult>((resolve, reject) => {
      pending.set(id, { resolve, reject, slot });
      entry.w.postMessage({ ...job, id });
    });
  };
  return {
    async decode(job) {
      const r = await send(job);
      if (!('count' in r)) throw new Error('Unexpected decode result');
      return r;
    },
    async copcSource(url) {
      const r = await send({ kind: 'copc-source', url });
      if (!('source' in r)) throw new Error('Unexpected COPC header result');
      return r.source;
    },
    async copcPage(url, page) {
      const r = await send({ kind: 'copc-page', url, page });
      if (!('hierarchy' in r)) throw new Error('Unexpected COPC hierarchy result');
      return r.hierarchy;
    },
    dispose() {
      for (const x of workers) x.w.terminate();
      workers.length = 0;
      for (const p of pending.values()) p.reject(new Error('The decode pool is disposed'));
      pending.clear();
    },
  };
}

/** Half the logical cores, 2 to 8: LAZ decoding is CPU bound. */
export function defaultSize(
  cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2,
): number {
  return Math.max(2, Math.min(8, Math.floor(cores / 2)));
}
