import type {
  PortLike,
  VolumeOp,
  VolumeOps,
  WorkerInit,
  WorkerReply,
  WorkerRequest,
} from './protocol';

/** The volume computations, answered off the UI thread. */
export type VolumeService = VolumeOps & { dispose(): void };

/** Talk to a volume worker (or any port served by `serveVolumes`). */
export function connectVolumeService(
  port: PortLike & { close?(): void; terminate?(): void },
  init: WorkerInit,
): VolumeService {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  let closed = false;
  port.onmessage = (ev: MessageEvent) => {
    const r = ev.data as WorkerReply;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.value);
    else p.reject(new Error(r.error));
  };
  port.postMessage({ kind: 'init', init } satisfies WorkerRequest);
  const call =
    (op: VolumeOp) =>
    (...args: unknown[]): Promise<unknown> => {
      if (closed) return Promise.reject(new Error('The volume worker has stopped'));
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ kind: 'call', id, op, args } satisfies WorkerRequest);
      });
    };
  const ops: Record<VolumeOp, unknown> = {
    recompute: call('recompute'),
    scene: call('scene'),
    edit: call('edit'),
    section: call('section'),
    pileSection: call('pileSection'),
    changeRaster: call('changeRaster'),
    reliefRaster: call('reliefRaster'),
    grid: call('grid'),
    heights: call('heights'),
  };
  return {
    ...(ops as VolumeOps),
    dispose() {
      closed = true;
      for (const p of pending.values()) p.reject(new Error('The volume worker has stopped'));
      pending.clear();
      port.onmessage = null;
      port.terminate?.();
      port.close?.();
    },
  };
}

/** Start the module worker bundled with this package. */
export function startVolumeWorker(init: WorkerInit): VolumeService {
  const w = new Worker(new URL('./volumes.worker.ts', import.meta.url), {
    type: 'module',
    name: 'volumes',
  });
  return connectVolumeService(w, init);
}
