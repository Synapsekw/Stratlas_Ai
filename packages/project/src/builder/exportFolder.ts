import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { renameWhenFree, type RenameOptions } from '../import/rename';

export interface ExportFolderOptions {
  /** Replace a folder that is already there (it is kept if anything fails). */
  replace?: boolean;
  /** The file writer (tests inject failures). */
  writeFile?: (path: string, data: Uint8Array | string) => Promise<void>;
  /**
   * How the folders are moved into place: `renameWhenFree` (tried again while Windows holds a
   * file in them open) with these options; tests hand in their own rename and sleep.
   */
  rename?: RenameOptions;
}

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** Remove a folder, never throwing: what is left is a hidden leftover, not a broken export. */
async function sweep(p: string): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // a reader still holds it; the next export of this name sweeps nothing it needs
  }
}

/**
 * Write a set of files as one folder, all or nothing: they are written into a hidden staging
 * folder beside `target`, which is renamed to `target` once every file is complete (the rename is
 * tried again while another program holds a file open, as Windows refuses it then). On any
 * failure the staging folder is removed and an existing `target` is left as it was; a replaced
 * folder is moved aside first and removed once the new one is in place. File names must be plain
 * names (no folders).
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
  const move = (from: string, to: string) => renameWhenFree(from, to, o.rename);
  await mkdir(parent, { recursive: true });
  await mkdir(staging);
  try {
    for (const [name, data] of Object.entries(files)) await write(join(staging, name), data);
  } catch (e) {
    await sweep(staging);
    throw e;
  }
  if (!(await exists(target))) {
    try {
      await move(staging, target);
    } catch (e) {
      await sweep(staging);
      throw e;
    }
    return;
  }
  const old = join(parent, `.${basename(target)}.old-${tag}`);
  try {
    await move(target, old);
  } catch (e) {
    await sweep(staging);
    throw e;
  }
  try {
    await move(staging, target);
  } catch (e) {
    await move(old, target);
    await sweep(staging);
    throw e;
  }
  await sweep(old);
}
