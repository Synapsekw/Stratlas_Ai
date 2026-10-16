import { nativeImage, type NativeImage } from 'electron';
import { rotateBgra90 } from './rotateBgra';

/** Pixel size of a native image at scale 1, the size `createFromPath` decodes a file to. */
export function bitmapSize(img: NativeImage): { width: number; height: number; buffer: Buffer } {
  const { width, height } = img.getSize(1);
  const buffer = img.toBitmap({ scaleFactor: 1 });
  if (buffer.length !== width * height * 4) {
    throw new Error('The image bitmap size does not match.');
  }
  return { width, height, buffer };
}

/** `quarters` clockwise quarter turns of a native image. The result is scale 1. */
export function turnNativeImage(img: NativeImage, quarters: 0 | 1 | 2 | 3): NativeImage {
  let out = img;
  for (let i = 0; i < quarters; i++) {
    const { width, height, buffer } = bitmapSize(out);
    out = nativeImage.createFromBitmap(rotateBgra90(buffer, width, height), {
      width: height,
      height: width,
      scaleFactor: 1,
    });
  }
  return out;
}
