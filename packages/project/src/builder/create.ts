import {
  parseManifest,
  type LayerPatch,
  type NewProjectRequest,
  type ProjectManifest,
  type SeverityTemplate,
} from '@aio/schema';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newProjectManifest } from './templates';

/** Folders of a native project package (data-conventions section 2). */
export const PACKAGE_DIRS = [
  'models',
  'video',
  'posters',
  'flights',
  'clouds',
  'rasters',
  'photos/thumbs',
  'panoramas',
  'report',
];

/** Lower-case, file-safe id. */
export function slug(s: string, fallback = 'item'): string {
  const v = s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return v || fallback;
}

/** `base`, or `base-2`, `base-3` ... the first one `taken` does not hold. */
export function uniqueId(base: string, taken: (id: string) => boolean): string {
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${String(n)}`;
  return id;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readManifestFile(root: string): Promise<ProjectManifest> {
  const file = join(root, 'manifest.json');
  const r = parseManifest(JSON.parse(await readFile(file, 'utf8')) as unknown);
  if (!r.ok) throw new Error(`${file}: ${r.error}`);
  return r.value;
}

/**
 * Validate with `parseManifest`, keep the previous file as `manifest.json.bak`, then replace
 * `manifest.json` atomically. Returns the backup path ('' for a new project).
 */
export async function writeManifestFile(root: string, manifest: ProjectManifest): Promise<string> {
  const parsed = parseManifest(manifest);
  if (!parsed.ok) throw new Error(parsed.error);
  const file = join(root, 'manifest.json');
  let backup = '';
  if (await exists(file)) {
    backup = `${file}.bak`;
    await copyFile(file, backup);
  }
  const tmp = `${file}.partial`;
  await writeFile(tmp, `${JSON.stringify(parsed.value, null, 2)}\n`);
  await rename(tmp, file);
  return backup;
}

/** Create `<dataRoot>/projects/<id>/` for a new project; never reuses an existing folder. */
export async function createProject(
  dataRoot: string,
  req: NewProjectRequest,
  template: SeverityTemplate | null = null,
): Promise<{ root: string; manifest: ProjectManifest }> {
  const projects = join(dataRoot, 'projects');
  await mkdir(projects, { recursive: true });
  const base = slug(req.name, 'project');
  let chosen = base;
  for (let n = 2; await exists(join(projects, chosen)); n++) chosen = `${base}-${String(n)}`;
  const root = join(projects, chosen);
  await mkdir(root);
  for (const d of PACKAGE_DIRS) await mkdir(join(root, d), { recursive: true });
  const manifest = newProjectManifest(chosen, req, template);
  await writeManifestFile(root, manifest);
  await writeFile(
    join(root, 'issues.json'),
    `${JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2)}\n`,
  );
  return { root, manifest };
}

/**
 * Apply an alignment to layers and save: a `transform` to mesh layers (georeference), `offsetMs`
 * and `lens` to video layers (calibration). Backs up and validates the manifest first.
 */
export async function updateLayers(
  root: string,
  layerIds: readonly string[],
  patch: LayerPatch,
): Promise<{ manifest: ProjectManifest; backup: string }> {
  const m = await readManifestFile(root);
  const want = new Set(layerIds);
  for (const id of want)
    if (!m.layers.some((l) => l.id === id))
      throw new Error(`Layer "${id}" is not in this project.`);
  const layers = m.layers.map((l) => {
    if (!want.has(l.id)) return l;
    if ('transform' in patch) {
      if (l.kind !== 'mesh')
        throw new Error(`"${l.name}" is not a model; only models take a transform.`);
      return { ...l, transform: [...patch.transform] };
    }
    if (l.kind !== 'video')
      throw new Error(`"${l.name}" is not a video; time offset and lens belong to video layers.`);
    return {
      ...l,
      ...(patch.offsetMs !== undefined ? { offsetMs: Math.round(patch.offsetMs) } : {}),
      ...(patch.lens ? { lens: patch.lens } : {}),
    };
  });
  const manifest: ProjectManifest = { ...m, layers };
  const backup = await writeManifestFile(root, manifest);
  return { manifest, backup };
}
