/**
 * The site's designs (`survey/designs.json`, `aio.designs/1`, data-conventions section 28; M11 G6).
 * `design.import` (the pipeline) adds designs; the app changes what a person may change: names and
 * folders, layer visibility, archived, vertical offset, clamp and station interval, and the active
 * alignment. What the import wrote (ids, files, hashes, units, CRS, counts) is never changed and a
 * design is never removed (its layers are archived). Written atomically with a `.bak`, through the
 * journal (`design.add`, `design.patch`, `design.archive`); a package's file is read in place and
 * never written.
 */
import {
  DESIGNS_DIR,
  DESIGNS_FILE,
  DesignsFile,
  emptyDesigns,
  type DesignsFile as DesignsFileT,
  type IpcResponse,
} from '@aio/schema';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk, newerThanThisBuild } from './newer';

const FAMILY = 'aio.designs';

/** Design fields the import wrote; a save that changes one is refused. */
const FIXED_DESIGN = [
  'id',
  'src',
  'sha256',
  'bytes',
  'format',
  'units',
  'crs',
  'calibrated',
  'importedAt',
  'importedBy',
] as const;
const FIXED_LAYER = ['id', 'kind', 'file', 'glb', 'counts'] as const;

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'the project folder is read only';
  return e instanceof Error ? e.message : String(e);
}

function invalid(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const first = e.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return `${DESIGNS_FILE} is invalid${where}: ${first?.message ?? 'unknown error'}`;
}

function parse(raw: unknown): IpcResponse<'survey:readDesigns'> {
  const newer = newerThanThisBuild(raw, FAMILY, DESIGNS_FILE);
  if (newer) return { ok: false, error: newer };
  const parsed = DesignsFile.safeParse(raw);
  return parsed.success
    ? { ok: true, file: parsed.data }
    : { ok: false, error: invalid(parsed.error) };
}

/** `survey/designs.json`; an empty list when the site has none. */
export async function readDesigns(root: string): Promise<IpcResponse<'survey:readDesigns'>> {
  let raw: unknown;
  try {
    raw = await readJsonSeen(join(root, ...DESIGNS_FILE.split('/')));
  } catch (e) {
    return { ok: false, error: `Could not read the designs: ${why(e)}` };
  }
  return raw === undefined ? { ok: true, file: emptyDesigns() } : parse(raw);
}

/** A package's designs, read from the archive in place. */
export async function readPackageDesigns(archive: {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}): Promise<IpcResponse<'survey:readDesigns'>> {
  if (!archive.entries.has(DESIGNS_FILE)) return { ok: true, file: emptyDesigns() };
  try {
    return parse(JSON.parse((await archive.read(DESIGNS_FILE)).toString('utf8')));
  } catch (e) {
    return { ok: false, error: `Could not read the designs: ${why(e)}` };
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Why a save may not go from `before` to `after`, or null when it may. */
export async function checkDesignsChange(
  root: string,
  before: DesignsFileT,
  after: DesignsFileT,
): Promise<string | null> {
  const old = new Map(before.designs.map((d) => [d.id, d]));
  const next = new Map(after.designs.map((d) => [d.id, d]));
  for (const d of before.designs)
    if (!next.has(d.id))
      return `The design "${d.name}" cannot be removed; archive its layers instead.`;
  for (const d of after.designs) {
    const prev = old.get(d.id);
    if (!prev) {
      // a design the import has not written: its folder and original must be there
      try {
        await access(join(root, ...DESIGNS_DIR.split('/'), d.id, d.src));
      } catch {
        return `The design "${d.name}" has no imported file in ${DESIGNS_DIR}/${d.id}/. Import designs with Import design.`;
      }
      continue;
    }
    const changed = FIXED_DESIGN.find((k) => !same(prev[k], d[k]));
    if (changed) return `The design "${prev.name}" keeps the ${changed} it was imported with.`;
    if (
      !same(
        prev.layers.map((l) => l.id),
        d.layers.map((l) => l.id),
      )
    )
      return `The layers of "${prev.name}" are the ones it was imported with; archive a layer instead of removing it.`;
    for (const [i, l] of d.layers.entries()) {
      const p = prev.layers[i];
      const k = p && FIXED_LAYER.find((key) => !same(p[key], l[key]));
      if (k) return `The layer "${p.name}" keeps the ${k} it was imported with.`;
    }
  }
  if (after.activeAlignment !== undefined) {
    const [designId, layerId, extra] = after.activeAlignment.split('/');
    const layer =
      extra === undefined
        ? next.get(designId ?? '')?.layers.find((l) => l.id === layerId)
        : undefined;
    if (layer?.kind !== 'alignment')
      return `The active alignment "${after.activeAlignment}" is not an alignment layer of this site.`;
    if (layer.archived)
      return `The alignment "${layer.name}" is archived; restore it to activate it.`;
  }
  return null;
}

/** Save `survey/designs.json` (atomic, `.bak`); the journal records the ops before this runs. */
export async function writeDesigns(
  root: string,
  file: DesignsFileT,
): Promise<IpcResponse<'survey:writeDesigns'>> {
  const path = join(root, ...DESIGNS_FILE.split('/'));
  const newer = await newerOnDisk(path, FAMILY, DESIGNS_FILE);
  if (newer) return { ok: false, error: newer };
  const current = await readDesigns(root);
  if (!current.ok) return current;
  const refused = await checkDesignsChange(root, current.file, file);
  if (refused) return { ok: false, error: refused };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonSeen(path, file, { backup: true, name: DESIGNS_FILE });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The designs were not saved: ${why(e)}` };
  }
}
