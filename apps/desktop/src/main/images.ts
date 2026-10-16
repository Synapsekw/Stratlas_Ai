import { orientationQuarters, readPhotoMeta, type ImageOps } from '@aio/project/builder';
import { nativeImage, type NativeImage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { turnNativeImage } from './rotateNative';

/**
 * Pixels the way the camera stored them, turned to match EXIF Orientation when the codec left
 * the tag unapplied. A decoded size that is already swapped against the EXIF frame is left
 * alone, so a codec that applies the tag is not turned twice. Mirrors are left for the Rotate
 * button: a turn would not match them.
 */
async function upright(src: string, img: NativeImage): Promise<NativeImage> {
  try {
    const file = await readFile(src);
    const head = file.subarray(0, 512 * 1024);
    const meta = readPhotoMeta(new Uint8Array(head.buffer, head.byteOffset, head.byteLength));
    const quarters = orientationQuarters(meta.orientation);
    if (quarters === 0) return img;
    const { width, height } = img.getSize();
    if (
      meta.width &&
      meta.height &&
      quarters % 2 === 1 &&
      width === meta.height &&
      height === meta.width
    ) {
      return img;
    }
    return turnNativeImage(img, quarters);
  } catch {
    return img;
  }
}

/**
 * Photo review copies and thumbnails, and the PNG of a picture drawing, through Electron's own
 * image codec (no ffmpeg needed).
 */
export const nativeImageOps: ImageOps = {
  async resizeJpeg(src, dst, maxPx) {
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error('The image could not be decoded.');
    const uprightImg = await upright(src, img);
    const { width, height } = uprightImg.getSize();
    const long = Math.max(width, height);
    const out =
      long > maxPx
        ? uprightImg.resize(
            width >= height
              ? { width: maxPx, quality: 'good' }
              : { height: maxPx, quality: 'good' },
          )
        : uprightImg;
    await writeFile(dst, out.toJPEG(85));
  },
  // a picture brought in as a drawing: PNG keeps line work sharp and a transparent background
  async toPng(src, dst, maxPx) {
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error('The picture could not be decoded.');
    const { width, height } = img.getSize();
    const long = Math.max(width, height);
    const out =
      long > maxPx
        ? img.resize(
            width >= height
              ? { width: maxPx, quality: 'best' }
              : { height: maxPx, quality: 'best' },
          )
        : img;
    await writeFile(dst, out.toPNG());
    return out.getSize();
  },
};
