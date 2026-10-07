/**
 * Imagery and terrain packs (M10 stream G7, decision 4): raster PMTiles with `aio.raster-pack/1`
 * metadata in `<data>/packs/imagery/` and `<data>/packs/terrain/` (data-conventions section 23),
 * folders the street-map pack manager (`manager.ts`) and older builds never scan.
 *
 * - List: every `<id>.json` that parses as `RasterPackMeta` of the folder's kind and has its
 *   `<id>.pmtiles` beside it. A half-built pack (`.<id>.pmtiles.building`) is not listed.
 * - Import: starts a `packs.imagery` or `packs.terrain` job in the pipeline pack, writing into the
 *   folder (`dest`); its job folder is `<data>/packs/.jobs`. Customer imagery is marked
 *   `customerLicence` (decision 12).
 * - Remove: deletes both files.
 * - `aio://packs/imagery/<id>.pmtiles` and `aio://packs/terrain/<id>.pmtiles` serve the archives
 *   to MapLibre, the site view and the Globe (`rasterPackFile`, used by the protocol handler).
 */
import {
  RASTER_PACK_DIRS,
  RasterPackId,
  RasterPackMeta,
  type IpcRequest,
  type IpcResponse,
  type RasterPackInfo,
  type RasterPackKind,
} from '@aio/schema';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Handle } from '../notYet';

export interface RasterPacksIpcDeps {
  handle: Handle;
  /** The data folder (`Settings.dataRoot`). */
  dataRoot: () => string;
  /** `jobs:start` of the job runner. */
  startJob: (req: IpcRequest<'jobs:start'>) => Promise<IpcResponse<'jobs:start'>>;
}

const PIPELINE = { imagery: 'packs.imagery', terrain: 'packs.terrain' } as const;
const ARRIVED = new Set(['download', 'import', 'build-tool', 'package']);

export function rasterPackDir(dataRoot: string, kind: RasterPackKind): string {
  return join(dataRoot, ...RASTER_PACK_DIRS[kind].split('/'));
}

/**
 * The archive for `aio://packs/<kind>/<id>.pmtiles` path segments (after `packs`), or null when
 * the segments are not a raster pack name. `packsDir` is `<data>/packs`.
 */
export function rasterPackFile(packsDir: string, segments: readonly string[]): string | null {
  if (segments.length !== 2) return null;
  const [kind, name] = segments;
  if (kind !== 'imagery' && kind !== 'terrain') return null;
  const m = /^([a-z0-9-]+)\.pmtiles$/.exec(name ?? '');
  if (!m?.[1] || !RasterPackId.safeParse(m[1]).success) return null;
  return join(packsDir, kind, `${m[1]}.pmtiles`);
}

/** The packs of one kind, sorted by label. Broken metadata is skipped (and logged). */
export async function listRasterPacks(
  dataRoot: string,
  kind: RasterPackKind,
): Promise<RasterPackInfo[]> {
  const dir = rasterPackDir(dataRoot, kind);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: RasterPackInfo[] = [];
  for (const name of names) {
    const m = /^([a-z0-9-]+)\.json$/.exec(name);
    if (!m?.[1]) continue;
    const id = m[1];
    try {
      const meta = RasterPackMeta.safeParse(JSON.parse(await readFile(join(dir, name), 'utf8')));
      if (!meta.success || meta.data.id !== id || meta.data.kind !== kind) {
        console.warn(`Raster pack ${join(dir, name)} has invalid metadata; skipped.`);
        continue;
      }
      const size = (await stat(join(dir, `${id}.pmtiles`))).size;
      const fields = meta.data;
      const arrived = (meta.data as Record<string, unknown>).source;
      out.push({
        id: fields.id,
        kind: fields.kind,
        label: fields.label,
        bbox: fields.bbox,
        minZoom: fields.minZoom,
        maxZoom: fields.maxZoom,
        tileSize: fields.tileSize,
        format: fields.format,
        ...(fields.encoding ? { encoding: fields.encoding } : {}),
        ...(fields.verticalDatum ? { verticalDatum: fields.verticalDatum } : {}),
        licence: fields.licence,
        attribution: fields.attribution,
        ...(fields.provenance !== undefined ? { provenance: fields.provenance } : {}),
        customerLicence: fields.customerLicence,
        builtAt: fields.builtAt,
        sizeBytes: size,
        source:
          typeof arrived === 'string' && ARRIVED.has(arrived)
            ? (arrived as NonNullable<RasterPackInfo['source']>)
            : fields.customerLicence
              ? 'import'
              : 'build-tool',
      });
    } catch {
      // the archive is missing (half copied or removed): not a pack
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** A free pack id from a label: `site-imagery`, then `site-imagery-2` and so on. */
export function packIdFor(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pack';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const id = `${base}-${String(i)}`;
    if (!taken.has(id)) return id;
  }
}

async function takenIds(dir: string): Promise<Set<string>> {
  try {
    const names = await readdir(dir);
    return new Set(names.map((n) => n.replace(/\.(json|pmtiles)$/, '')));
  } catch {
    return new Set();
  }
}

export function registerRasterPacksIpc({ handle, dataRoot, startJob }: RasterPacksIpcDeps): void {
  const list = async (kind: RasterPackKind) => ({
    ok: true as const,
    packs: await listRasterPacks(dataRoot(), kind),
  });

  const start = async (
    kind: RasterPackKind,
    req: IpcRequest<'imageryPacks:import'> | IpcRequest<'terrainPacks:import'>,
  ): Promise<IpcResponse<'imageryPacks:import'>> => {
    const dest = rasterPackDir(dataRoot(), kind);
    const work = join(dataRoot(), 'packs', '.jobs');
    try {
      await mkdir(dest, { recursive: true });
      await mkdir(work, { recursive: true });
    } catch (e) {
      return { ok: false, error: `Cannot write to ${dest}: ${String(e)}` };
    }
    const taken = await takenIds(dest);
    if (req.id !== undefined && taken.has(req.id))
      return { ok: false, error: `There is already a pack "${req.id}". Remove it first.` };
    const id = req.id ?? packIdFor(req.label, taken);
    const params: Record<string, unknown> = {
      src: [req.path],
      dest,
      id,
      label: req.label,
      licence: req.licence,
      attribution: req.attribution,
      ...(req.provenance ? { provenance: req.provenance } : {}),
      ...('customerLicence' in req ? { customerLicence: req.customerLicence } : {}),
      ...('verticalDatum' in req ? { verticalDatum: req.verticalDatum } : {}),
    };
    const r = await startJob({ pipeline: PIPELINE[kind], project: work, params });
    return r.ok ? { ok: true, jobId: r.job.id } : { ok: false, error: r.error };
  };

  const remove = async (
    kind: RasterPackKind,
    id: string,
  ): Promise<IpcResponse<'imageryPacks:remove'>> => {
    const dir = rasterPackDir(dataRoot(), kind);
    const files = [join(dir, `${id}.json`), join(dir, `${id}.pmtiles`)];
    const exists = await Promise.all(
      files.map((f) =>
        stat(f).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (!exists.some(Boolean)) return { ok: false, error: `There is no ${kind} pack "${id}".` };
    try {
      // metadata first: a pack whose archive could not be deleted (open elsewhere) is no longer listed
      for (const f of files) await rm(f, { force: true });
    } catch (e) {
      return { ok: false, error: `Could not remove the pack: ${String(e)}` };
    }
    return { ok: true };
  };

  handle('imageryPacks:list', () => list('imagery'));
  handle('imageryPacks:import', (req) => start('imagery', req));
  handle('imageryPacks:remove', ({ id }) => remove('imagery', id));
  handle('terrainPacks:list', () => list('terrain'));
  handle('terrainPacks:import', (req) => start('terrain', req));
  handle('terrainPacks:remove', ({ id }) => remove('terrain', id));
}
