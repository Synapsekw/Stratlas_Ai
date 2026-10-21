/**
 * `builder:rereadPhotos` (photo position edit, 21 Oct 2026): re-read one photos layer's positions
 * and view directions from the photo files with the fixed XMP reader. The work is
 * `rereadPhotoLayer` (`@aio/project/builder`); main refuses packages, reads and writes
 * `orientation.json` (journalled with the manifest as one step, `journal.ts`) and says whether
 * processing gave the layer refined poses, which a re-read replaces.
 */
import { PHOTO_DIR, type IpcRequest, type IpcResponse } from '@aio/schema';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ORIENTATION_PATH, readOrientation, writeOrientation } from './orientation';
import { POSES_BACKUP } from './photogrammetry';
import type { ProjectRegistry } from './project';
import { PACKAGE_REFUSAL } from './removal';

/** The builder library loads on first use (a static import empties the main bundle). */
const lib = () => import('@aio/project/builder');

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** True when a run's poses backup (Use refined poses) names this layer. */
export async function refinedLayer(root: string, layerId: string): Promise<boolean> {
  let runs: string[];
  try {
    runs = (await readdir(join(root, PHOTO_DIR), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return false;
  }
  for (const run of runs) {
    try {
      const raw = JSON.parse(await readFile(join(root, PHOTO_DIR, run, POSES_BACKUP), 'utf8')) as {
        layer?: unknown;
      };
      if (raw.layer === layerId) return true;
    } catch {
      // no backup in this run, or one that cannot be read
    }
  }
  return false;
}

export async function builderRereadPhotos(
  req: IpcRequest<'builder:rereadPhotos'>,
  registry: Pick<ProjectRegistry, 'root' | 'package'>,
): Promise<IpcResponse<'builder:rereadPhotos'>> {
  if (registry.package(req.projectId)) return { ok: false, error: PACKAGE_REFUSAL };
  const root = registry.root(req.projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${req.projectId}" is not open. Open it, then try again.` };
  try {
    const r = await (
      await lib()
    ).rereadPhotoLayer(root, req.layerId, {
      ...(req.folder !== undefined ? { folder: req.folder } : {}),
      ...(req.dryRun ? { dryRun: true } : {}),
      orientation: {
        read: async () => {
          const o = await readOrientation(root);
          if (!o.ok) throw new Error(o.error);
          return o.file;
        },
        write: async (file) => {
          const w = await writeOrientation(root, file);
          if (!w.ok) throw new Error(w.error ?? 'The camera directions were not saved.');
        },
        remove: () => rm(join(root, ORIENTATION_PATH), { force: true }),
      },
    });
    if (!r.ok) return r;
    return { ...r, refined: await refinedLayer(root, req.layerId) };
  } catch (e) {
    return { ok: false, error: `Photo positions were not re-read: ${errorText(e)}` };
  }
}
