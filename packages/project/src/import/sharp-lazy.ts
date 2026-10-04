import type SharpFactory from 'sharp';

let mod: typeof SharpFactory | undefined;

/**
 * sharp is a native, build-time dependency of the importers only. Load it on first use so that
 * nothing the desktop app imports at startup ever requires it (the packaged app does not ship it).
 */
export async function loadSharp(): Promise<typeof SharpFactory> {
  mod ??= (await import('sharp')).default;
  return mod;
}
