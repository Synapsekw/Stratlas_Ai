/**
 * Pixel size of a project photo from the first bytes of its file (JPEG, PNG or WebP header, read
 * with an HTTP Range request over aio://), so shapes in photo pixels can be drawn over a
 * thumbnail without decoding the photo. Cached for the session; a few reads at a time.
 */
import { imageSize } from '@aio/project/image';

const HEAD_BYTES = 256 * 1024;
const CONCURRENCY = 4;

const sizes = new Map<string, Promise<[number, number] | null>>();
let running = 0;
const queue: (() => void)[] = [];

function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const go = () => {
      running++;
      resolve(() => {
        running--;
        queue.shift()?.();
      });
    };
    if (running < CONCURRENCY) go();
    else queue.push(go);
  });
}

async function read(url: string, fetcher: typeof fetch): Promise<[number, number] | null> {
  const done = await slot();
  try {
    const r = await fetcher(url, { headers: { Range: `bytes=0-${String(HEAD_BYTES - 1)}` } });
    if (!r.ok) return null;
    const s = imageSize(new Uint8Array(await r.arrayBuffer()));
    return s ? [s.width, s.height] : null;
  } catch {
    return null;
  } finally {
    done();
  }
}

/** Width and height of the image at an aio:// URL, or null when its header cannot be read. */
export function photoSize(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<[number, number] | null> {
  let p = sizes.get(url);
  if (!p) {
    p = read(url, fetcher);
    sizes.set(url, p);
  }
  return p;
}

/** A size already known this session (no request). */
export function knownPhotoSize(url: string, size: [number, number]): void {
  if (!sizes.has(url)) sizes.set(url, Promise.resolve(size));
}
