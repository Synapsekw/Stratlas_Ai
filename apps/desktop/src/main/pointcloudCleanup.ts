/**
 * Point cloud cleanup recipes (`edits/pointcloud/<layer>.json`, `aio.pccleanup/1`; spec
 * docs/plans/2026-10-15-pointcloud-cleanup-design.md):
 * - `pointcloud:readCleanup`: every valid recipe (a damaged or foreign file is skipped with a
 *   warning), and the record of one noise run when asked; packages read from the archive;
 * - `pointcloud:writeCleanup`: one layer's recipe, atomic with a `.bak`, a wrapped writer of the
 *   journal service (journal.ts); null removes it (kept as `.bak`). Noise working copies of the
 *   layer that neither the recipe nor `keep` names move to the project trash, on a reset or when
 *   the request carries `keep`, and never those of a job still running (`activeRuns`).
 * The pack gate for `pointcloud.clean` sits here too (as walks.ts and panos.ts do theirs).
 */
import {
  NoiseRun,
  PCCLEANUP_DIR,
  POINTCLOUD_CLEAN_FEATURE,
  POINTCLOUD_CLEAN_MIN_PACK,
  PointcloudCleanup,
  isSafeLayerId,
  noiseCopyPath,
  noiseRunPath,
  type IpcResponse,
} from '@aio/schema';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isChangedOnDisk,
  readJsonSeen,
  removeJsonSeen,
  renameRetrying,
  writeJsonSeen,
} from './fsutil';
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
  if (!isSafeLayerId(layerId)) return null;
  try {
    const r = NoiseRun.safeParse(await readJsonSeen(join(root, noiseRunPath(layerId, runId))));
    return r.success && r.data.runId === runId && r.data.path === noiseCopyPath(layerId, runId)
      ? r.data
      : null;
  } catch {
    return null;
  }
}

export async function writeCleanup(
  root: string,
  layerId: string,
  recipe: PointcloudCleanup | null,
  keep: readonly string[] | undefined,
  now: Date = new Date(),
  active: ReadonlySet<string> = new Set(),
): Promise<IpcResponse<'pointcloud:writeCleanup'>> {
  if (!isSafeLayerId(layerId))
    return { ok: false, error: `The layer id "${layerId}" cannot name a cleanup file.` };
  if (recipe && recipe.layerId !== layerId)
    return { ok: false, error: 'The cleanup belongs to another layer.' };
  if (recipe?.noise && recipe.noise.path !== noiseCopyPath(layerId, recipe.noise.runId))
    return { ok: false, error: 'The noise copy named by the cleanup is not the copy of its run.' };
  const dir = join(root, PCCLEANUP_DIR);
  const file = join(dir, `${layerId}.json`);
  try {
    await mkdir(dir, { recursive: true });
    if (recipe) {
      await writeJsonSeen(file, recipe, { backup: true, name: `${PCCLEANUP_DIR}/${layerId}.json` });
    } else {
      await removeJsonSeen(file, { name: `${PCCLEANUP_DIR}/${layerId}.json` });
    }
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The cleanup was not saved: ${why(e)}` };
  }
  // Noise working copies (and their records) nobody names any more go to the project trash, but
  // only on a reset or when the request carries `keep` (the save has finished), and never a run
  // whose job is still queued or running: its copy is not named by any recipe yet.
  if (recipe !== null && keep === undefined) return { ok: true, trashed: [] };
  const named = new Set([...(recipe?.noise ? [recipe.noise.path] : []), ...(keep ?? [])]);
  const prefix = `${layerId}.noise-`;
  const names = (await readdir(dir)).filter((n) => n.startsWith(prefix)).sort();
  const loose = names.filter((n) => {
    const copy = n.endsWith('.json') ? n.replace(/\.json$/, '.copc.laz') : n;
    const runId = copy.slice(prefix.length).replace(/\.copc\.laz$/, '');
    return !named.has(`${PCCLEANUP_DIR}/${copy}`) && !active.has(runId);
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
        await renameRetrying(join(dir, n), join(entry, PCCLEANUP_DIR, n));
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
  /** Ids of the jobs still starting, running or cancelling (a noise run id is its job id). */
  activeRuns?: () => ReadonlySet<string>;
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
          if (r.success && `${PCCLEANUP_DIR}/${r.data.layerId}.json` === name) recipes.push(r.data);
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
    return writeCleanup(
      root,
      layerId,
      recipe,
      keep,
      deps.now?.() ?? new Date(),
      deps.activeRuns?.() ?? new Set(),
    );
  });
}
