import type { DecodedChunk, DecodeRequest, DecodeResult } from './protocol';

type Job = Omit<DecodeRequest, 'id'>;

/** Something that decodes chunks; the real one is a pool of module workers. */
export interface Decoder {
  decode(job: Job): Promise<DecodedChunk>;
  dispose(): void;
}

/** A small pool of module workers; jobs go to the least busy worker. */
export function createWorkerPool(size = defaultSize()): Decoder {
  const workers: { w: Worker; busy: number }[] = [];
  const pending = new Map<
    number,
    { resolve: (c: DecodedChunk) => void; reject: (e: Error) => void; slot: number }
  >();
  let next = 1;
  for (let i = 0; i < size; i++) {
    const w = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: `pointcloud-${i}`,
    });
    const slot = i;
    w.onmessage = (e: MessageEvent<DecodeResult>) => {
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
  return {
    decode(job) {
      const id = next++;
      let slot = 0;
      workers.forEach((x, i) => {
        if (x.busy < (workers[slot]?.busy ?? Infinity)) slot = i;
      });
      const entry = workers[slot];
      if (!entry) return Promise.reject(new Error('The decode pool is disposed'));
      entry.busy++;
      return new Promise<DecodedChunk>((resolve, reject) => {
        pending.set(id, { resolve, reject, slot });
        entry.w.postMessage({ ...job, id });
      });
    },
    dispose() {
      for (const x of workers) x.w.terminate();
      workers.length = 0;
      for (const p of pending.values()) p.reject(new Error('The decode pool is disposed'));
      pending.clear();
    },
  };
}

function defaultSize(): number {
  const n = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(4, Math.floor(n / 2)));
}
