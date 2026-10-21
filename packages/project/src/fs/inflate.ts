import { constants as bufferConstants } from 'node:buffer';
import type { ZlibOptions } from 'node:zlib';

/** Generous caps for data that has no size of its own to check against. */
export const INFLATE_LIMITS = {
  /** A map pack's PMTiles directory or tile. */
  mapPack: 256 * 1024 * 1024,
  /** A gzipped coordinate system catalogue (the bundled one is under 3 MB). */
  catalogue: 64 * 1024 * 1024,
  /** One file of a kit's offline data (a model, a raster). */
  kitFile: 1024 * 1024 * 1024,
} as const;

/**
 * Run a synchronous zlib call with `maxOutputLength`, so a small hostile input cannot unpack into
 * gigabytes (a decompression bomb). Going over the cap throws a plain error naming `what`.
 */
export function inflateCapped(
  what: string,
  max: number,
  run: (options: ZlibOptions) => Buffer,
): Buffer {
  const cap = Math.max(1, Math.min(Math.floor(max), bufferConstants.MAX_LENGTH));
  try {
    return run({ maxOutputLength: cap });
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)
      throw new Error(`${what} unpacks to more than ${String(cap)} bytes, so it was not read.`, {
        cause: e,
      });
    throw e;
  }
}
