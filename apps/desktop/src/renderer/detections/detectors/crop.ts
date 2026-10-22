/**
 * The crop a reviewer judged a detector candidate on: the box plus a margin, cut from the photo the
 * review already shows (the same URL as the editor, so no new IPC), at most 512 px on its long side,
 * as base64 JPEG for `ledger:append`.
 */

export type Box4 = readonly [number, number, number, number];

/** The browser calls, injectable so tests need no canvas. */
export interface CropIo {
  load(url: string): Promise<{ width: number; height: number; source: unknown }>;
  render(
    source: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    w: number,
    h: number,
  ): Promise<string>;
}

const browser: CropIo = {
  load: (url) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      // aio:// answers with CORS headers: asked for anonymously, the canvas stays readable
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight, source: img });
      };
      img.onerror = () => {
        reject(new Error('The photo could not be loaded for the ledger.'));
      };
      img.src = url;
    }),
  render: (source, sx, sy, sw, sh, w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('No canvas for the ledger crop.'));
    ctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    return Promise.resolve(url.slice(url.indexOf(',') + 1));
  },
};

const MAX_PARALLEL = 2;
let active = 0;
const waiting: (() => void)[] = [];
/** Photos loaded while the queue is busy: candidates on one photo share one decode. */
let loaded = new Map<string, Promise<{ width: number; height: number; source: unknown }>>();

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((go) => waiting.push(go));
  else active++;
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else {
      active--;
      if (active === 0) loaded = new Map();
    }
  }
}

export interface CropOptions {
  io?: CropIo;
  /**
   * The pixel grid `box` is in (width, height), when it is not the photo's own: the box is scaled
   * to the photo's natural size.
   */
  grid?: readonly [number, number];
}

/**
 * `box` is `[x1, y1, x2, y2]` in the pixels of the photo at `photoUrl` (or of `grid`). At most two
 * crops run at once, so Accept all on many candidates does not decode them all together.
 */
export function cropJpeg(
  photoUrl: string,
  box: Box4,
  maxSide = 512,
  pad = 0.15,
  opts: CropOptions = {},
): Promise<string> {
  const io = opts.io ?? browser;
  return slot(async () => {
    let img = loaded.get(photoUrl);
    if (!img) {
      img = io.load(photoUrl);
      loaded.set(photoUrl, img);
      // a failed load is not kept for the next candidate
      img.catch(() => loaded.delete(photoUrl));
    }
    const photo = await img;
    const kx = opts.grid ? photo.width / opts.grid[0] : 1;
    const ky = opts.grid ? photo.height / opts.grid[1] : 1;
    const b = [box[0] * kx, box[1] * ky, box[2] * kx, box[3] * ky] as const;
    const px = (b[2] - b[0]) * pad;
    const py = (b[3] - b[1]) * pad;
    const x1 = Math.max(0, b[0] - px);
    const y1 = Math.max(0, b[1] - py);
    const x2 = Math.min(photo.width, b[2] + px);
    const y2 = Math.min(photo.height, b[3] + py);
    const sw = x2 - x1;
    const sh = y2 - y1;
    const k = Math.min(1, maxSide / Math.max(sw, sh));
    return io.render(photo.source, x1, y1, sw, sh, sw * k, sh * k);
  });
}
