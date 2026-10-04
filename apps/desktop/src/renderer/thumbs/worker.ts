// Makes a small JPEG thumbnail of a project image off the renderer's main thread: fetch,
// decode (createImageBitmap), scale onto an OffscreenCanvas and encode.
import type { ThumbJob, ThumbReply } from './queue';

/** The parts of DedicatedWorkerGlobalScope used here (the webworker lib clashes with DOM). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<ThumbJob>) => void) | null;
  postMessage(message: ThumbReply, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

async function make(job: ThumbJob): Promise<ArrayBuffer> {
  const r = await fetch(job.url);
  if (!r.ok) throw new Error(`${job.url} answered ${String(r.status)}`);
  const full = await createImageBitmap(await r.blob());
  try {
    const k = Math.min(1, job.maxPx / Math.max(full.width, full.height));
    const w = Math.max(1, Math.round(full.width * k));
    const h = Math.max(1, Math.round(full.height * k));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('No 2D context in the thumbnail worker');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(full, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    return await blob.arrayBuffer();
  } finally {
    full.close();
  }
}

scope.onmessage = (e) => {
  const job = e.data;
  make(job).then(
    (data) => {
      scope.postMessage({ id: job.id, data }, [data]);
    },
    (err: unknown) => {
      scope.postMessage({ id: job.id, error: String(err) });
    },
  );
};
