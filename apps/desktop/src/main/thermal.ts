/**
 * Thermal analysis files in the main process: which photos of a layer are radiometric (a read of
 * the first 256 KB of each) and the project's `thermal/thermal.json`, read and written with the
 * same rules as the antenna inventory (`telecom.ts`): atomic with a `.bak`, refused for packages,
 * never over a file a newer version saved or one that changed on disk since it was read. The
 * decoding itself is the `thermal.decode` pipeline job; the pack gate is `thermalPack.ts`.
 */
import { thermalFamily, THERMAL_PROBE_BYTES } from '@aio/project';
import { ThermalFile, type IpcResponse } from '@aio/schema';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk } from './newer';
import type { Handle } from './notYet';
import { readManifest } from './project';
import { resolveInside } from './protocol/paths';
import { parseAs, readArchiveJson, why, type SurveyProjects } from './survey';

export { thermalPackRefusal } from './thermalPack';

export const THERMAL_FILE = 'thermal/thermal.json';
const READ_ONLY_THERMAL =
  'This project is a read-only package. Its thermal analysis cannot be changed.';

/** The first `bytes` of a file, or null when it cannot be read. */
async function headOf(path: string, bytes: number): Promise<Uint8Array | null> {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export async function probeThermal(
  projects: SurveyProjects,
  projectId: string,
  layerId: string,
): Promise<IpcResponse<'thermal:probe'>> {
  const root = projects.root(projectId);
  if (root === undefined) {
    return projects.package(projectId)
      ? {
          ok: false,
          error:
            'Thermal photos can only be analysed in a project folder, not in a read-only package.',
        }
      : { ok: false, error: `Project "${projectId}" is not open.` };
  }
  const m = await readManifest(root);
  if (!m.ok) return { ok: false, error: m.error };
  const layer = m.value.layers.find((l) => l.id === layerId);
  if (layer?.kind !== 'photos')
    return { ok: false, error: `There is no photo layer "${layerId}" in this project.` };
  const photos = [];
  for (const p of layer.items) {
    const found = 'path' in p.src ? await resolveInside(root, p.src.path) : null;
    const head = found?.ok ? await headOf(found.path, THERMAL_PROBE_BYTES) : null;
    const t = head ? thermalFamily(head) : null;
    photos.push({
      photoId: p.id,
      family: t?.family ?? null,
      make: t ? t.make : null,
      model: t ? t.model : null,
    });
  }
  return { ok: true, photos };
}

export async function readThermal(
  projects: SurveyProjects,
  projectId: string,
): Promise<IpcResponse<'thermal:read'>> {
  const root = projects.root(projectId);
  const pkg = root === undefined ? projects.package(projectId) : undefined;
  if (root === undefined && !pkg)
    return { ok: false, error: `Project "${projectId}" is not open.` };
  let raw: unknown;
  try {
    raw =
      root !== undefined
        ? await readJsonSeen(join(root, ...THERMAL_FILE.split('/')))
        : pkg && (await readArchiveJson(pkg.archive, THERMAL_FILE));
  } catch (e) {
    return { ok: false, error: `Could not read the thermal analysis: ${why(e)}` };
  }
  if (raw === undefined) return { ok: true, file: null };
  const r = parseAs(raw, ThermalFile, 'aio.thermal', THERMAL_FILE);
  return r.ok ? { ok: true, file: r.value } : r;
}

export async function writeThermal(
  projects: SurveyProjects,
  projectId: string,
  input: ThermalFile,
): Promise<IpcResponse<'thermal:write'>> {
  if (projects.package(projectId))
    return { ok: false, error: READ_ONLY_THERMAL, code: 'read-only' };
  const root = projects.root(projectId);
  if (root === undefined) return { ok: false, error: `Project "${projectId}" is not open.` };
  const parsed = ThermalFile.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
    return {
      ok: false,
      error: `The thermal analysis was not saved, it is invalid${where}: ${first?.message ?? 'unknown error'}`,
    };
  }
  const path = join(root, ...THERMAL_FILE.split('/'));
  const newer = await newerOnDisk(path, 'aio.thermal', THERMAL_FILE);
  if (newer) return { ok: false, error: newer };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonSeen(path, parsed.data, { backup: true, name: THERMAL_FILE });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The thermal analysis was not saved: ${why(e)}` };
  }
}

export function registerThermalIpc({
  handle,
  projects,
}: {
  handle: Handle;
  projects: SurveyProjects;
}): void {
  handle('thermal:probe', ({ projectId, layerId }) => probeThermal(projects, projectId, layerId));
  handle('thermal:read', ({ projectId }) => readThermal(projects, projectId));
  handle('thermal:write', ({ projectId, file }) => writeThermal(projects, projectId, file));
}
