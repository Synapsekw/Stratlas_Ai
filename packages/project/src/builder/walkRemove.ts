import type { ProjectManifest } from '@aio/schema';
import { WALKS_DIR } from '@aio/schema';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWhenFree, type RenameOptions } from '../import/rename';
import { readManifestFile, updateManifestFile } from './manifestFile';
import { walkFolder } from './walkPaths';

/*
 * Removing a walk (the walk layer and placing, "The smaller points"): its folder `walks/<id>/`
 * moves to `.trash/<stamp>-<id>/`, where it stays seven days (swept when the project opens), and
 * then the layer leaves the manifest. The folder moves first: when the move is refused (a file
 * held open), the layer stays and nothing changed; when the save then fails, the folder moves
 * back. The other order lost the layer and left the folder, and the next open made the walk a
 * layer again. `.trash/` never goes into a package.
 */

export const TRASH_DIR = '.trash';
/** How long a removed walk's files are kept. */
export const TRASH_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `20261012T081530Z`: sorts by time and has no characters Windows refuses. */
const stampOf = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/;

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Injection points for tests. */
export interface RemoveWalkOptions {
  /** The rename of the folder (tests hand in one that fails). */
  rename?: RenameOptions['rename'];
}

/** The `walks/<id>` folder of walk layer `layerId`; throws for an unknown layer or not a walk. */
function walkFolderIn(m: ProjectManifest, layerId: string): string | null {
  const layer = m.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`There is no layer "${layerId}" in this project.`);
  if (layer.kind !== 'walk') throw new Error(`"${layer.name}" is not a walk.`);
  return 'path' in layer.record ? walkFolder(layer.record.path) : null;
}

/** Move `walks/<id>` to a free `.trash/<stamp>-<id>[-n]`; answers where it went. */
async function moveToTrash(
  root: string,
  folder: string,
  from: string,
  now: Date,
  o: RemoveWalkOptions,
): Promise<string> {
  const id = folder.slice(WALKS_DIR.length + 1);
  const trash = join(root, TRASH_DIR);
  await mkdir(trash, { recursive: true });
  const stamp = stampOf(now);
  for (let n = 0; ; n++) {
    const to = join(trash, `${stamp}-${id}${n === 0 ? '' : `-${String(n + 1)}`}`);
    try {
      await renameWhenFree(from, to, {
        giveUp: () => exists(to),
        ...(o.rename ? { rename: o.rename } : {}),
      });
      return to;
    } catch (e) {
      if (!(await exists(to)) || n >= 20) throw e;
    }
  }
}

/**
 * Move a walk's folder to `.trash/` and take its layer out of the manifest. Refuses an unknown
 * layer and one that is not a walk. A folder that is already gone still removes the layer. When
 * the folder cannot be moved, nothing changes; when the save fails, the folder is moved back.
 */
export async function removeWalk(
  root: string,
  layerId: string,
  now: () => Date = () => new Date(),
  o: RemoveWalkOptions = {},
): Promise<ProjectManifest> {
  const folder = walkFolderIn(await readManifestFile(root), layerId);
  const from = folder === null ? null : join(root, ...folder.split('/'));
  const moved =
    folder !== null && from !== null && (await exists(from))
      ? await moveToTrash(root, folder, from, now(), o)
      : null;
  try {
    const r = await updateManifestFile(root, (m) => {
      // read again in the turn: the layer is checked once more on what is saved
      walkFolderIn(m, layerId);
      return { manifest: { ...m, layers: m.layers.filter((l) => l.id !== layerId) } };
    });
    return r.manifest;
  } catch (e) {
    if (moved !== null && from !== null) {
      // best effort: when the way back is refused too, the files stay in .trash for seven days
      await renameWhenFree(moved, from, o.rename ? { rename: o.rename } : {}).catch(
        () => undefined,
      );
    }
    throw e;
  }
}

/** Delete what `.trash/` holds from more than seven days ago. Answers the names removed. */
export async function sweepTrash(
  root: string,
  now: () => Date = () => new Date(),
): Promise<string[]> {
  const trash = join(root, TRASH_DIR);
  let names: string[];
  try {
    names = await readdir(trash);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = STAMP.exec(name);
    if (!m) continue;
    const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
    const at = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, se ?? 0);
    if (now().getTime() - at <= TRASH_KEEP_DAYS * DAY_MS) continue;
    try {
      await rm(join(trash, name), { recursive: true, force: true, maxRetries: 3 });
      removed.push(name);
    } catch {
      // held open for now: the next open tries again
    }
  }
  return removed;
}
