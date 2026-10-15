/**
 * Point cloud cleanup recipes (`edits/pointcloud/<layer>.json`, `aio.pccleanup/1`; spec
 * docs/plans/2026-10-15-pointcloud-cleanup-design.md):
 * - `pointcloud:readCleanup`: every valid recipe (a damaged or foreign file is skipped with a
 *   warning), and the record of one noise run when asked; packages read from the archive;
 * - `pointcloud:writeCleanup`: one layer's recipe, atomic with a `.bak`, a wrapped writer of the
 *   journal service (journal.ts); null removes it (kept as `.bak`). Noise working copies of the
 *   layer that neither the recipe nor `keep` names move to the project trash.
 * The pack gate for `pointcloud.clean` sits here too (as walks.ts and panos.ts do theirs).
 */
import {
  NoiseRun,
  PCCLEANUP_DIR,
  POINTCLOUD_CLEAN_FEATURE,
  POINTCLOUD_CLEAN_MIN_PACK,
  PointcloudCleanup,
  noiseRunPath,
  type IpcResponse,
} from '@aio/schema';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { compareVersions } from './jobs/pack';
import type { Handle } from './notYet';

const lib = () => import('@aio/project/builder');

export const CLEAN_PACK_FEATURE = {
  label: POINTCLOUD_CLEAN_FEATURE,
  minVersion: POINTCLOUD_CLEAN_MIN_PACK,
};

/** Why `jobs:start` refuses `pointcloud.clean` on the installed pack, or null. */
export function cleanPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'pointcloud.clean' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, POINTCLOUD_CLEAN_MIN_PACK) >= 0) return null;
  return `${POINTCLOUD_CLEAN_FEATURE} needs processing tools ${POINTCLOUD_CLEAN_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}

/** A layer id that can name a file in edits/pointcloud. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const isRecipeName = (n: string) => n.endsWith('.json') && !n.includes('.noise-');
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function readCleanups(root: string): Promise<PointcloudCleanup[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, PCCLEANUP_DIR))).filter(isRecipeName).sort();
  } catch {
    return [];
  }
  const out: PointcloudCleanup[] = [];
  for (const name of names) {
    const stem = name.slice(0, -'.json'.length);
    try {
      const r = PointcloudCleanup.safeParse(await readJsonSeen(join(root, PCCLEANUP_DIR, name)));
      if (r.success && r.data.layerId === stem) out.push(r.data);
      else
        console.warn(`${PCCLEANUP_DIR}/${name} is not a cleanup recipe of layer ${stem}; skipped.`);
    } catch (e) {
      console.warn(`${PCCLEANUP_DIR}/${name} could not be read: ${why(e)}`);
    }
  }
  return out;
}

export async function readNoiseRun(
  root: string,
  layerId: string,
  runId: string,
): Promise<NoiseRun | null> {
  if (!SAFE_ID.test(layerId)) return null;
  try {
    const r = NoiseRun.safeParse(await readJsonSeen(join(root, noiseRunPath(layerId, runId))));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export async function writeCleanup(
  root: string,
  layerId: string,
  recipe: PointcloudCleanup | null,
  keep: readonly string[],
  now: Date = new Date(),
): Promise<IpcResponse<'pointcloud:writeCleanup'>> {
  if (!SAFE_ID.test(layerId) || layerId.includes('..'))
    return { ok: false, error: `The layer id "${layerId}" cannot name a cleanup file.` };
  if (recipe && recipe.layerId !== layerId)
    return { ok: false, error: 'The cleanup belongs to another layer.' };
  const dir = join(root, PCCLEANUP_DIR);
  const file = join(dir, `${layerId}.json`);
  try {
    await mkdir(dir, { recursive: true });
    if (recipe) {
      await writeJsonSeen(file, recipe, { backup: true, name: `${PCCLEANUP_DIR}/${layerId}.json` });
    } else {
      await rm(`${file}.bak`, { force: true });
      try {
        await rename(file, `${file}.bak`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The cleanup was not saved: ${why(e)}` };
  }
  // noise working copies (and their records) nobody names any more go to the project trash
  const named = new Set([...(recipe?.noise ? [recipe.noise.path] : []), ...keep]);
  const prefix = `${layerId}.noise-`;
  const names = (await readdir(dir)).filter((n) => n.startsWith(prefix)).sort();
  const loose = names.filter((n) => {
    const copy = n.endsWith('.json') ? n.replace(/\.json$/, '.copc.laz') : n;
    return !named.has(`${PCCLEANUP_DIR}/${copy}`);
  });
  const trashed: string[] = [];
  if (loose.length) {
    const { freeTrashEntry } = await lib();
    const slug = `pccleanup-${layerId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const entry = await freeTrashEntry(root, now, slug);
    await mkdir(join(entry, PCCLEANUP_DIR), { recursive: true });
    // the copy before its record, so the listing reads copy, record
    for (const n of loose.sort(
      (a, b) => Number(a.endsWith('.json')) - Number(b.endsWith('.json')) || a.localeCompare(b),
    )) {
      try {
        await rename(join(dir, n), join(entry, PCCLEANUP_DIR, n));
        trashed.push(`${PCCLEANUP_DIR}/${n}`);
      } catch (e) {
        console.warn(`${PCCLEANUP_DIR}/${n} stays: ${why(e)}`);
      }
    }
  }
  return { ok: true, trashed };
}

interface Deps {
  handle: Handle;
  projects: { root(id: string): string | undefined; package(id: string): unknown };
  projectPackage?: (
    id: string,
  ) => { entries: ReadonlyMap<string, unknown>; read(name: string): Promise<Buffer> } | undefined;
  now?: () => Date;
}

const NOT_OPEN = { ok: false as const, error: 'The project is not open.' };

export function registerPointcloudCleanupIpc(deps: Deps): void {
  const { handle, projects } = deps;

  handle('pointcloud:readCleanup', async ({ projectId, noiseRun }) => {
    if (projects.package(projectId)) {
      const archive = deps.projectPackage?.(projectId);
      const recipes: PointcloudCleanup[] = [];
      for (const name of [...(archive?.entries.keys() ?? [])].sort()) {
        if (!name.startsWith(`${PCCLEANUP_DIR}/`) || !isRecipeName(name)) continue;
        try {
          const r = PointcloudCleanup.safeParse(
            JSON.parse((await archive?.read(name))?.toString('utf8') ?? ''),
          );
          if (r.success) recipes.push(r.data);
        } catch {
          // a damaged member is skipped, as in a folder
        }
      }
      return { ok: true, recipes, readOnly: true };
    }
    const root = projects.root(projectId);
    if (root === undefined) return NOT_OPEN;
    const recipes = await readCleanups(root);
    if (!noiseRun) return { ok: true, recipes, readOnly: false };
    const noise = await readNoiseRun(root, noiseRun.layerId, noiseRun.runId);
    return { ok: true, recipes, noise, readOnly: false };
  });

  handle('pointcloud:writeCleanup', ({ projectId, layerId, recipe, keep }) => {
    if (projects.package(projectId))
      return Promise.resolve({
        ok: false as const,
        error: 'This project is a read-only package. Its cleanup cannot be changed.',
      });
    const root = projects.root(projectId);
    if (root === undefined) return Promise.resolve(NOT_OPEN);
    return writeCleanup(root, layerId, recipe, keep ?? [], deps.now?.() ?? new Date());
  });
}
