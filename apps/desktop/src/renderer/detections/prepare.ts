/**
 * Images for AI detection, made in the renderer from project files: a photo, or a video frame at
 * a time, scaled to at most SEND_MAX_PX on the long side and encoded as JPEG. What leaves the
 * machine is exactly this data URL. Also small frame thumbnails for the contact sheet.
 */
import { SEND_MAX_PX, sendSize } from '@aio/ai';
import type { Layer } from '@aio/schema';
import { assetUrl } from '@aio/workspace';
import type { DetectItem } from './convert';
import type { PreparedImage } from './runner';

const JPEG_QUALITY = 0.85;

function toJpeg(source: CanvasImageSource, width: number, height: number, maxPx: number): string {
  const [w, h] = sendSize(width, height, maxPx);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The image could not be drawn.');
  ctx.drawImage(source, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  // aio:// answers with CORS headers: the canvas stays readable.
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

/** A frame of a video at `t` seconds, drawn when the seek lands. */
export async function grabFrame(
  url: string,
  t: number,
  maxPx: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => {
        resolve();
      };
      v.onerror = () => {
        reject(new Error('The video could not be read.'));
      };
      v.src = url;
    });
    await new Promise<void>((resolve, reject) => {
      v.onseeked = () => {
        resolve();
      };
      v.onerror = () => {
        reject(new Error('The video could not be read at that time.'));
      };
      v.currentTime = Math.min(t, Math.max(0, v.duration - 0.05));
    });
    const width = v.videoWidth;
    const height = v.videoHeight;
    return { dataUrl: toJpeg(v, width, height, maxPx), width, height };
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

/** The image of one item as sent to the model, with its original size. */
export async function prepareItem(
  projectId: string,
  layers: readonly Layer[],
  item: DetectItem,
): Promise<PreparedImage> {
  const layer = layers.find((l) => l.id === item.layer);
  if (item.kind === 'photo') {
    const photo =
      layer?.kind === 'photos' ? layer.items.find((p) => p.id === item.photo) : undefined;
    if (!photo) throw new Error(`Photo ${item.photo} is not in layer ${item.layer}.`);
    const img = await loadImage(assetUrl(projectId, photo.src));
    return {
      dataUrl: toJpeg(img, img.naturalWidth, img.naturalHeight, SEND_MAX_PX),
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  }
  if (layer?.kind !== 'video') throw new Error(`Video ${item.layer} is not in this project.`);
  return grabFrame(assetUrl(projectId, layer.src), item.t, SEND_MAX_PX);
}

// ---- frame thumbnails for the contact sheet (one at a time, cached for the session) ----

export type FrameImage = Awaited<ReturnType<typeof grabFrame>>;

const frameThumbs = new Map<string, Promise<FrameImage>>();
let chain: Promise<unknown> = Promise.resolve();

/** A small frame (320 px) and the video's own frame size, one grab at a time, cached. */
export function frameImage(url: string, t: number): Promise<FrameImage> {
  const key = `${url}#${String(t)}`;
  let p = frameThumbs.get(key);
  if (!p) {
    p = chain.then(() => grabFrame(url, t, 320));
    chain = p.catch(() => undefined);
    frameThumbs.set(key, p);
  }
  return p;
}

export function frameThumb(url: string, t: number): Promise<string> {
  return frameImage(url, t).then((f) => f.dataUrl);
}
