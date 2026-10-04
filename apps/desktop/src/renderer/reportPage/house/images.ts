// Images of an issue page: the source photo with the marked area (box, kit overlay or mask) and
// the close-up frame, and the close-up itself. Drawn at print size and kept as JPEG blobs.
import type { ReportRow } from '@aio/project/export';
import type { Issue } from '@aio/schema';
import { cropRect } from '../layout';

/** Source photo width in pixels (about 140 dpi over the page width). */
export const PHOTO_W = 1000;
export const CLOSE_W = 520;
export const CLOSE_H = 390;

export interface PhotoBlobs {
  photo?: Blob;
  closeup?: Blob;
}

export type Fetcher = (path: string) => Promise<Blob | null>;

/** The mask drawn on the issue's best photo, as a project path. */
export function maskOf(issue: Issue, layer: string, photo: string): string | null {
  for (const s of issue.sightings)
    if (s.on === 'image' && s.layer === layer && s.photo === photo && s.geom.type === 'mask')
      return 'path' in s.geom.src ? s.geom.src.path : null;
  return null;
}

/** The kit's coloured overlay beside a class mask (`x_mask.png` to `x_overlay.png`). */
export function overlayOf(mask: string): string | null {
  return /_mask\.png$/i.test(mask) ? mask.replace(/_mask\.png$/i, '_overlay.png') : null;
}

const toJpeg = (c: HTMLCanvasElement, q: number) =>
  new Promise<Blob | null>((r) => {
    c.toBlob(r, 'image/jpeg', q);
  });

async function bitmap(fetch: Fetcher, path: string): Promise<ImageBitmap | null> {
  const blob = await fetch(path);
  if (!blob) return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** A class mask (values above 0 marked) tinted in `color`, at the canvas size. */
function tinted(mask: ImageBitmap, w: number, h: number, color: string): HTMLCanvasElement | null {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(mask, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h);
  const r = parseInt(color.slice(1, 3), 16);
  const gr = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const on = (px[i] ?? 0) > 0 || (px[i + 1] ?? 0) > 0 || (px[i + 2] ?? 0) > 0;
    px[i] = r;
    px[i + 1] = gr;
    px[i + 2] = b;
    px[i + 3] = on ? 150 : 0;
  }
  g.putImageData(data, 0, 0);
  return c;
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  g.font = '600 18px "IBM Plex Sans", sans-serif';
  const w = g.measureText(text).width + 10;
  const top = Math.max(0, y - 24);
  g.fillStyle = color;
  g.fillRect(x, top, w, 22);
  g.fillStyle = '#111111';
  g.fillText(text, x + 5, top + 16);
}

/** The source photo with the marked area and the close-up of an issue, or nothing without one. */
export async function issuePhotos(
  fetch: Fetcher,
  issue: Issue | undefined,
  row: ReportRow,
): Promise<PhotoBlobs> {
  const pick = row.photo;
  if (!pick?.src) return {};
  const img = await bitmap(fetch, pick.src);
  if (!img) return {};
  try {
    const color = /^#[0-9a-f]{6}$/i.test(row.severityColor) ? row.severityColor : '#ff7a2d';
    const W = Math.min(PHOTO_W, img.width);
    const H = Math.round((W * img.height) / img.width);
    const k = W / img.width;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    if (!g) return {};
    g.drawImage(img, 0, 0, W, H);

    // the marked area: the kit's coloured overlay, else the class mask tinted
    const mask = issue ? maskOf(issue, pick.layer, pick.photo) : null;
    if (mask) {
      const kit = overlayOf(mask);
      const over = kit ? await bitmap(fetch, kit) : null;
      if (over) {
        // see-through, so the defect under the colour stays visible
        g.globalAlpha = 0.42;
        g.drawImage(over, 0, 0, W, H);
        g.globalAlpha = 1;
        over.close();
      } else {
        const m = await bitmap(fetch, mask);
        if (m) {
          const tint = tinted(m, W, H, color);
          if (tint) g.drawImage(tint, 0, 0);
          m.close();
        }
      }
    }

    const box = pick.box;
    const out: PhotoBlobs = {};
    if (box) {
      const [bx, by, bw, bh] = box;
      g.lineWidth = 3;
      g.strokeStyle = color;
      if (bw > 0 && bh > 0) g.strokeRect(bx * k, by * k, bw * k, bh * k);
      else {
        g.beginPath();
        g.arc(bx * k, by * k, 16, 0, Math.PI * 2);
        g.stroke();
      }
      label(g, row.code, bx * k, by * k, color);
      // the close-up frame
      const crop = cropRect(box, img.width, img.height);
      if (crop.w < img.width * 0.95) {
        g.setLineDash([10, 6]);
        g.lineWidth = 2;
        g.strokeStyle = '#ffffff';
        g.strokeRect(crop.x * k, crop.y * k, crop.w * k, crop.h * k);
        g.setLineDash([]);
        const cc = document.createElement('canvas');
        cc.width = CLOSE_W;
        cc.height = CLOSE_H;
        const cg = cc.getContext('2d');
        if (cg) {
          cg.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, CLOSE_W, CLOSE_H);
          const ck = CLOSE_W / crop.w;
          cg.lineWidth = 3;
          cg.strokeStyle = color;
          if (bw > 0 && bh > 0)
            cg.strokeRect((bx - crop.x) * ck, (by - crop.y) * ck, bw * ck, bh * ck);
          else {
            cg.beginPath();
            cg.arc((bx - crop.x) * ck, (by - crop.y) * ck, 16, 0, Math.PI * 2);
            cg.stroke();
          }
          label(
            cg,
            row.code,
            Math.max(0, (bx - crop.x) * ck),
            Math.max(24, (by - crop.y) * ck),
            color,
          );
          const blob = await toJpeg(cc, 0.8);
          if (blob) out.closeup = blob;
        }
      }
    }
    const blob = await toJpeg(c, 0.72);
    if (blob) out.photo = blob;
    return out;
  } finally {
    img.close();
  }
}
