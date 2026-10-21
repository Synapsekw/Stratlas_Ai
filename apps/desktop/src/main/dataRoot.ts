import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/**
 * Data folder policy. The renderer names a data folder only by handing back a path that main's own
 * folder dialog returned (`dialog:openFolder`), and main still checks it is a plain local folder:
 * a renderer that could set any path would make "Show data folder" (`shell.openPath`) run any file
 * or reach a share on another computer.
 */

/** Paths on another computer or in a device namespace: `\\server\share`, `\\?\`, `\\.\`, `//x`. */
function isUncOrDevice(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/**
 * Why `p` cannot be a data folder, or null when its shape is fine: an absolute path on a local
 * drive (a drive letter on Windows, `/` elsewhere), never a UNC share, a `\\?\` or `\\.\` device
 * path, or a path with a NUL.
 */
export function dataRootShapeError(p: string, platform: string = process.platform): string | null {
  if (!p || p.includes('\0')) return 'The data folder path is empty or not valid.';
  if (isUncOrDevice(p))
    return 'The data folder must be on a drive of this computer, not a network share.';
  if (platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(p))
      return 'The data folder must be a full path on a drive of this computer.';
    // drive-relative names and alternate data streams (`C:\x:stream`) are not folders
    if (p.includes(':', 2)) return 'The data folder path is not valid.';
  } else if (!isAbsolute(p)) {
    return 'The data folder must be a full path.';
  }
  return null;
}

/** Null when `p` is a local, existing folder; else why not. */
export async function dataRootError(
  p: string,
  platform: string = process.platform,
): Promise<string | null> {
  const shape = dataRootShapeError(p, platform);
  if (shape) return shape;
  try {
    const s = await stat(p);
    if (!s.isDirectory()) return 'The data folder is not a folder.';
  } catch {
    return 'The data folder does not exist.';
  }
  return null;
}

const key = (p: string, platform: string) => {
  const r = platform === 'win32' ? resolve(p).replace(/[\\/]+$/, '') : p.replace(/\/+$/, '');
  return platform === 'win32' ? r.toLowerCase() : r;
};

/**
 * The folders main's own folder dialog returned in this run. A data folder change from the
 * renderer must name one of them (or the folder already in use).
 */
export function createPickedFolders(platform: string = process.platform) {
  const picked = new Set<string>();
  return {
    remember(p: string): void {
      picked.add(key(p, platform));
    },
    has(p: string): boolean {
      return picked.has(key(p, platform));
    },
  };
}
export type PickedFolders = ReturnType<typeof createPickedFolders>;

/**
 * Check a data folder change from the renderer: unchanged is fine; a new folder must come from the
 * folder dialog and be a local, existing folder. Returns the error to show, or null.
 */
export async function checkDataRootChange(
  next: string,
  current: string,
  picked: PickedFolders,
  platform: string = process.platform,
): Promise<string | null> {
  if (next === current) return null;
  if (!picked.has(next)) return 'Choose the data folder with the folder picker.';
  return dataRootError(next, platform);
}
