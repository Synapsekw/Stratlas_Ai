import type { ImageOps } from '@aio/project/builder';
import { nativeImage } from 'electron';
import { writeFile } from 'node:fs/promises';

/** Photo review copies and thumbnails through Electron's own image codec (no ffmpeg needed). */
export const nativeImageOps: ImageOps = {
  async resizeJpeg(src, dst, maxPx) {
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error('The image could not be decoded.');
    const { width, height } = img.getSize();
    const long = Math.max(width, height);
    const out =
      long > maxPx
        ? img.resize(
            width >= height
              ? { width: maxPx, quality: 'good' }
              : { height: maxPx, quality: 'good' },
          )
        : img;
    await writeFile(dst, out.toJPEG(85));
  },
};
