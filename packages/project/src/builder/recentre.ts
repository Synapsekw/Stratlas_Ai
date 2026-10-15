import { projectToLocal } from '@aio/geo';
import { unknownLayersOf, type Layer, type ProjectManifest, type Vec3 } from '@aio/schema';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateManifestFile } from './create';
import { drawingStemOf } from './drawingPlacement';

/**
 * Moving the project origin (data-conventions section 1). The COPC clouds are in the project CRS
 * and follow by themselves; models, photo places and pictures laid on the ground are in the
 * local frame and are shifted so they stay where they are. Anything else placed against the
 * origin (issues, flights, walks, drawings, survey files, runs, tilesets, procedural models in the
 * local frame, a job that has not finished) refuses the move.
 */
const SHIFTABLE_TOP = new Set([
  'manifest.json',
  'issues.json',
  'thumbnail.jpg',
  'models',
  'clouds',
  'photos',
  'rasters',
  'journal',
  '.trash',
  'report',
  'jobs',
]);

/** The point cloud import: its output is a COPC in the project CRS, whatever its status. */
const CLOUD_IMPORT = 'pointcloud.to_copc';

/**
 * Job folders stay in `jobs/<id>/` after they run. A finished job has committed what it made (and
 * that is checked where it landed); a point cloud import works in the project CRS. Any other job
 * (running, stopped, failed, or with no readable job.json) may still write against the origin.
 */
async function jobBlockers(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, 'jobs'), { withFileTypes: true });
  } catch {
    return []; // no jobs folder: no job ran here
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let ok = false;
    try {
      const j = JSON.parse(await readFile(join(root, 'jobs', e.name, 'job.json'), 'utf8')) as {
        pipeline?: unknown;
        status?: unknown;
      };
      ok = j.status === 'done' || j.pipeline === CLOUD_IMPORT;
    } catch {
      // unreadable or missing: it may be a job that has not finished
    }
    if (!ok) out.push(`a job that has not finished ("${e.name}")`);
  }
  return out;
}

const PROCMODEL_SUFFIX = '.procmodel.json';

/**
 * Procedural models (`models/<id>.procmodel.json`) whose parts are in the local frame: their mesh
 * layer is written with an identity transform, so a shift would be undone by the next build. Not
 * so for a model with assemblies or a georeference, or whose layer carries a georeference: its
 * geometry is in the model's own frame, a rebuild keeps the (shifted) layer transform and an accept
 * recomputes it from the georeference against the current origin. A file that cannot be read
 * refuses, as it may be either.
 */
async function procModelBlockers(root: string, m: ProjectManifest): Promise<string[]> {
  let files: string[];
  try {
    files = (await readdir(join(root, 'models'))).filter((f) => f.endsWith(PROCMODEL_SUFFIX));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const f of files.sort()) {
    const id = f.slice(0, -PROCMODEL_SUFFIX.length);
    const layerPlaced = m.layers.some(
      (l) =>
        l.kind === 'mesh' &&
        l.derived?.kind === 'model' &&
        l.derived.source?.includes(id) === true &&
        l.georef !== undefined,
    );
    let ownFrame = false;
    try {
      const json = JSON.parse(await readFile(join(root, 'models', f), 'utf8')) as {
        assemblies?: unknown;
        georef?: unknown;
      };
      ownFrame =
        (Array.isArray(json.assemblies) && json.assemblies.length > 0) || json.georef != null;
    } catch {
      // unreadable: it may hold parts in the local frame
    }
    if (!ownFrame && !layerPlaced) out.push(`the procedural model "${f}"`);
  }
  return out;
}

function shiftable(l: Layer): boolean {
  if (l.kind === 'mesh' || l.kind === 'photos' || l.kind === 'basemap') return true;
  if (l.kind === 'pointcloud') return l.format === 'copc';
  if (l.kind === 'raster') return l.format === 'image' && drawingStemOf(l) === null;
  return false;
}

/**
 * Why the project's origin cannot be moved: one reason per layer, issue count or file placed
 * against the origin that a re-centre would not shift. Empty when it can be moved.
 */
export async function recentreBlockers(root: string, m: ProjectManifest): Promise<string[]> {
  const out: string[] = [];
  for (const l of m.layers) if (!shiftable(l)) out.push(`the layer "${l.name}"`);
  // layers of a kind a newer build wrote are carried over unchanged, so they cannot be shifted
  try {
    const raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as unknown;
    for (const l of unknownLayersOf(raw)) out.push(`the layer "${l.name}"`);
  } catch {
    // the manifest itself is read (and its errors reported) by the save
  }
  try {
    const doc = JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as {
      issues?: unknown[];
    };
    const n = doc.issues?.length ?? 0;
    if (n > 0) out.push(`${String(n)} issue${n === 1 ? '' : 's'}`);
  } catch {
    // no issues file: nothing placed there
  }
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (SHIFTABLE_TOP.has(e.name) || e.name.startsWith('manifest.json')) continue;
    if (e.isDirectory()) {
      if ((await readdir(join(root, e.name))).length > 0) out.push(`files in "${e.name}"`);
    } else out.push(`"${e.name}"`);
  }
  out.push(...(await procModelBlockers(root, m)), ...(await jobBlockers(root)));
  return out;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const plus = (p: Vec3, d: Vec3): Vec3 => [r6(p[0] + d[0]), r6(p[1] + d[1]), r6(p[2] + d[2])];

/** The manifest with its origin at `at` (E, N; height kept) and local positions shifted. */
export function recentred(m: ProjectManifest, at: [number, number]): ProjectManifest {
  const origin: Vec3 = [Math.round(at[0]), Math.round(at[1]), m.origin[2]];
  // where the old origin lies in the new local frame: every local position moves by it
  const d = projectToLocal(m.origin, origin);
  const layers = m.layers.map((l): Layer => {
    if (l.kind === 'mesh') {
      const t = [...l.transform];
      t[12] = r6((t[12] ?? 0) + d[0]);
      t[13] = r6((t[13] ?? 0) + d[1]);
      t[14] = r6((t[14] ?? 0) + d[2]);
      return { ...l, transform: t };
    }
    if (l.kind === 'photos')
      return { ...l, items: l.items.map((p) => (p.pos ? { ...p, pos: plus(p.pos, d) } : p)) };
    if (l.kind === 'raster' && l.corners)
      return {
        ...l,
        corners: {
          tl: plus(l.corners.tl, d),
          tr: plus(l.corners.tr, d),
          bl: plus(l.corners.bl, d),
        },
      };
    return l;
  });
  return { ...m, origin, layers };
}

/**
 * Move the project origin to `at` (E, N) and shift every local position so nothing moves in the
 * CRS. Checked and saved in one manifest turn; refused (nothing written) when `recentreBlockers`
 * names anything.
 */
export async function recentreProject(
  root: string,
  at: [number, number],
): Promise<{ manifest: ProjectManifest; backup: string }> {
  const r = await updateManifestFile(root, async (m) => {
    const blockers = await recentreBlockers(root, m);
    if (blockers.length > 0)
      throw new Error(`Re-centring is not possible: this project holds ${blockers.join(', ')}.`);
    return { manifest: recentred(m, at) };
  });
  return { manifest: r.manifest, backup: r.backup };
}
