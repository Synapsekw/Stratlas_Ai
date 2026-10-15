import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface ExportFolderOptions {
  /** Replace a folder that is already there (it is kept if anything fails). */
  replace?: boolean;
  /** The file writer (tests inject failures). */
  writeFile?: (path: string, data: Uint8Array | string) => Promise<void>;
}

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Write a set of files as one folder, all or nothing: they are written into a hidden staging
 * folder beside `target`, which is renamed to `target` once every file is complete. On any
 * failure the staging folder is removed and an existing `target` is left as it was. File names
 * must be plain names (no folders).
 */
export async function writeExportFolder(
  target: string,
  files: Record<string, Uint8Array | string>,
  o: ExportFolderOptions = {},
): Promise<void> {
  for (const name of Object.keys(files))
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || basename(name) !== name)
      throw new Error(`"${name}" is not a plain file name for an export.`);
  if (!o.replace && (await exists(target)))
    throw new Error(`"${basename(target)}" already exists there.`);
  const tag = randomBytes(4).toString('hex');
  const parent = dirname(target);
  const staging = join(parent, `.${basename(target)}.partial-${tag}`);
  const write = o.writeFile ?? ((p: string, d: Uint8Array | string) => fsWriteFile(p, d));
  await mkdir(parent, { recursive: true });
  await mkdir(staging);
  try {
    for (const [name, data] of Object.entries(files)) await write(join(staging, name), data);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  if (!(await exists(target))) {
    try {
      await rename(staging, target);
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
    return;
  }
  // replacing: the old folder is moved aside first and only removed once the new one is in place
  const old = join(parent, `.${basename(target)}.old-${tag}`);
  try {
    await rename(target, old);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  try {
    await rename(staging, target);
  } catch (e) {
    await rename(old, target);
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  await rm(old, { recursive: true, force: true });
}
