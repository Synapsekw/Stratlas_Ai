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

/** `box` is `[x1, y1, x2, y2]` in the pixels of the photo at `photoUrl`. */
export async function cropJpeg(
  photoUrl: string,
  box: Box4,
  maxSide = 512,
  pad = 0.15,
  io: CropIo = browser,
): Promise<string> {
  const img = await io.load(photoUrl);
  const px = (box[2] - box[0]) * pad;
  const py = (box[3] - box[1]) * pad;
  const x1 = Math.max(0, box[0] - px);
  const y1 = Math.max(0, box[1] - py);
  const x2 = Math.min(img.width, box[2] + px);
  const y2 = Math.min(img.height, box[3] + py);
  const sw = x2 - x1;
  const sh = y2 - y1;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  return io.render(img.source, x1, y1, sw, sh, sw * k, sh * k);
}
