import type { ProjectManifest } from '@aio/schema';
import { WALKS_DIR } from '@aio/schema';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWhenFree } from '../import/rename';
import { updateManifestFile } from './manifestFile';

/*
 * Removing a walk (the walk layer and placing, "The smaller points"): the layer leaves the
 * manifest at once and its folder `walks/<id>/` moves to `.trash/<stamp>-<id>/`, where it stays
 * seven days (swept when the project opens). `.trash/` never goes into a package.
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

/** `walks/<id>` of a record path `walks/<id>/walk.json`, or undefined for any other shape. */
function walkFolder(recordPath: string): string | undefined {
  const parts = recordPath.replaceAll('\\', '/').split('/');
  const [dir, id, file, ...rest] = parts;
  if (dir !== WALKS_DIR || !id || id.startsWith('.') || !file || rest.length > 0) return undefined;
  return `${WALKS_DIR}/${id}`;
}

/**
 * Take a walk layer out of the manifest and move its folder to `.trash/`. Refuses an unknown
 * layer and one that is not a walk. A folder that is already gone still removes the layer.
 */
export async function removeWalk(
  root: string,
  layerId: string,
  now: () => Date = () => new Date(),
): Promise<ProjectManifest> {
  const found: { folder?: string } = {};
  const r = await updateManifestFile(root, (m) => {
    const layer = m.layers.find((l) => l.id === layerId);
    if (!layer) throw new Error(`There is no layer "${layerId}" in this project.`);
    if (layer.kind !== 'walk') throw new Error(`"${layer.name}" is not a walk.`);
    const rec = layer.record;
    const where = 'path' in rec ? walkFolder(rec.path) : undefined;
    if (where !== undefined) found.folder = where;
    return { manifest: { ...m, layers: m.layers.filter((l) => l.id !== layerId) } };
  });
  const folder = found.folder;
  if (folder !== undefined) {
    const from = join(root, ...folder.split('/'));
    if (await exists(from)) {
      const id = folder.slice(WALKS_DIR.length + 1);
      const trash = join(root, TRASH_DIR);
      await mkdir(trash, { recursive: true });
      const stamp = stampOf(now());
      for (let n = 0; ; n++) {
        const to = join(trash, `${stamp}-${id}${n === 0 ? '' : `-${String(n + 1)}`}`);
        try {
          await renameWhenFree(from, to, { giveUp: () => exists(to) });
          break;
        } catch (e) {
          if (!(await exists(to)) || n >= 20) throw e;
        }
      }
    }
  }
  return r.manifest;
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
