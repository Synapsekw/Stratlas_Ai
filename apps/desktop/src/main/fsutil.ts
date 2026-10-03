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

/**
 * Write JSON atomically: write a temp file next to the target, then rename over it, so a crash
 * never leaves a half-written file. With `backup`, the previous version is kept as `<file>.bak`.
 */
export async function writeJsonAtomic(
  file: string,
  data: unknown,
  opts: { backup?: boolean } = {},
): Promise<void> {
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    if (opts.backup) {
      try {
        await copyFile(file, `${file}.bak`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
