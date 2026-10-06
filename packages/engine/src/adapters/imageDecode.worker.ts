/**
 * Image decode worker: fetches an image and decodes it to an ImageBitmap (flipped for WebGL,
 * alpha not premultiplied), entirely off the main thread. Even createImageBitmap on the main
 * thread finishes each 2048 px tile with an 8 ms main-thread task, and a view change starts
 * several tiles at once. Images larger than `max` pixels on an edge are scaled down here too (the
 * graphics preset's texture limit), so the GPU never sees the full size.
 */
import { fitTextureSize } from './rasterMath';

interface DecodeImage {
  id: number;
  url: string;
  max?: number;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<DecodeImage>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

async function decode(url: string, max: number | undefined): Promise<ImageBitmap> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
  const bmp = await createImageBitmap(await r.blob(), {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
  });
  const fit = max ? fitTextureSize(bmp.width, bmp.height, max) : null;
  if (!fit) return bmp;
  const small = await createImageBitmap(bmp, {
    resizeWidth: fit[0],
    resizeHeight: fit[1],
    resizeQuality: 'high',
    premultiplyAlpha: 'none',
  });
  bmp.close();
  return small;
}

scope.onmessage = (e) => {
  const { id, url, max } = e.data;
  decode(url, max).then(
    (bitmap) => {
      scope.postMessage({ id, bitmap }, [bitmap]);
    },
    (err: unknown) => {
      scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }, []);
    },
  );
};
