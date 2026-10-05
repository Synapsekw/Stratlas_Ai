import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';

/** Read and parse a JSON file; `undefined` when the file does not exist. Throws on bad JSON. */
export async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
}

/** Codes Windows gives a rename onto a file that another process has open at that moment. */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Rename `from` over `to`. Windows refuses to replace a file while any other process holds it
 * open, even only to read it (a search indexer, antivirus, a backup or sync client, a test reading
 * the settings), so there a refused rename is tried again for about 2.5 s before it fails.
 */
async function renameOver(from: string, to: string): Promise<void> {
  for (let wait = 10; ; wait *= 2) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !LOCKED.has(code) || wait > 1280) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

let writes = 0;

/**
 * Write JSON atomically: write a temp file next to the target, then rename over it, so a crash
 * never leaves a half-written file. With `backup`, the previous version is kept as `<file>.bak`.
 */
export async function writeJsonAtomic(
  file: string,
  data: unknown,
  opts: { backup?: boolean } = {},
): Promise<void> {
  // Unique per write: two writes of one file in the same millisecond keep their own temp file.
  writes += 1;
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.${String(writes)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    if (opts.backup) {
      try {
        await copyFile(file, `${file}.bak`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    await renameOver(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
