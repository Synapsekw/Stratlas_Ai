/** Decode worker: fetches and decodes point chunks off the main thread. */
import { handleDecode, type DecodeDeps, type DecodeRequest } from './protocol';

/** The parts of DedicatedWorkerGlobalScope used here (the webworker lib clashes with DOM). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
  return r.arrayBuffer();
}

const deps: DecodeDeps = {
  fetchBytes,
  async decodeImage(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
    const blob = await r.blob();
    const bmp = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    }).catch(() => {
      throw new Error(`${url} is not a readable PNG (${blob.type || 'unknown type'})`);
    });
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('2D canvas is not available in the decode worker');
    g.drawImage(bmp, 0, 0);
    bmp.close();
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    return { data, w: canvas.width, h: canvas.height };
  },
};

scope.onmessage = (e) => {
  void handleDecode(e.data, deps).then(({ result, transfer }) => {
    scope.postMessage(result, transfer);
  });
};
