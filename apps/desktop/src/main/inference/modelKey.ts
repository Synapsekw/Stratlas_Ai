import { stat } from 'node:fs/promises';

/**
 * Which model files these are: path, size, modification time and file id of each. A session made
 * from other files (another model, or the same add-on folder after an install or removal) is
 * stale. A file that is not there counts as its own state, so it changes once it appears.
 */
export async function modelFilesKey(...paths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const p of paths) {
    const s = await stat(p).catch(() => null);
    parts.push(`${p}|${String(s?.size ?? -1)}|${String(s?.mtimeMs ?? -1)}|${String(s?.ino ?? -1)}`);
  }
  return parts.join('\n');
}
