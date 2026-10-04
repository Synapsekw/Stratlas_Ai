/**
 * Image decode worker: fetches an image and decodes it to an ImageBitmap (flipped for WebGL,
 * alpha not premultiplied), entirely off the main thread. Even createImageBitmap on the main
 * thread finishes each 2048 px tile with an 8 ms main-thread task, and a view change starts
 * several tiles at once.
 */
interface DecodeImage {
  id: number;
  url: string;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<DecodeImage>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

async function decode(url: string): Promise<ImageBitmap> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
  return createImageBitmap(await r.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
}

scope.onmessage = (e) => {
  const { id, url } = e.data;
  decode(url).then(
    (bitmap) => {
      scope.postMessage({ id, bitmap }, [bitmap]);
    },
    (err: unknown) => {
      scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }, []);
    },
  );
};
