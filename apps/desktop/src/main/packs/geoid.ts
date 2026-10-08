/**
 * Geoid packs (M11 stream G1, decision 5, data-conventions section 25): regional geoid grids
 * (GeoTIFF or GTX) in `<data>/packs/geoid/<id>.tif|.gtx` with `<id>.json` (`aio.geoid-pack/1`),
 * beside the global EGM96 and EGM2008 grids of the pipeline pack.
 *
 * - List: every `<id>.json` that parses as `GeoidPackMeta` with its grid file beside it, then the
 *   global grids found in the pipeline pack's folders (listed with their PROJ-data names).
 * - Import (**Import geoid grid**): a GeoTIFF or GTX the person names, with the licence and
 *   attribution they state (`imported: true`). Its extent is read from the file header; the file
 *   is copied, hashed and described. Nothing is downloaded.
 * - Remove: deletes a pack's grid and description (never a global grid).
 *
 * Pipeline jobs find the folder through `QUADRION_GEOID_DIRS` (`geoidJobEnv`), and run with
 * `PROJ_NETWORK=OFF`.
 */
import {
  GEOID_PACKS_DIR,
  GeoidPackId,
  GeoidPackMeta,
  type IpcRequest,
  type IpcResponse,
} from '@aio/schema';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Handle } from '../notYet';

export interface GeoidPacksIpcDeps {
  handle: Handle;
  /** The data folder (`Settings.dataRoot`); absent: no geoid packs in this build. */
  dataRoot?: () => string;
  /** Folders of the pipeline pack that may hold the global grids (its `share/proj`). */
  packGeoidDirs?: () => Promise<string[]>;
}

/** The global grids of the pipeline pack (NGA, public domain), by PROJ-data file name. */
export const GLOBAL_GEOIDS = [
  {
    id: 'egm96',
    name: 'EGM96',
    projFile: 'us_nga_egm96_15.tif',
    verticalEpsg: 5773,
  },
  {
    id: 'egm2008',
    name: 'EGM2008',
    projFile: 'us_nga_egm08_25.tif',
    verticalEpsg: 3855,
  },
] as const;

const GLOBAL_IDS: ReadonlySet<string> = new Set(GLOBAL_GEOIDS.map((g) => g.id));

export function geoidPackDir(dataRoot: string): string {
  return join(dataRoot, ...GEOID_PACKS_DIR.split('/'));
}

/** The environment a pipeline job needs for geoid packs: their folder, and PROJ offline. */
export function geoidJobEnv(dataRoot: string): Record<string, string> {
  return { QUADRION_GEOID_DIRS: geoidPackDir(dataRoot), PROJ_NETWORK: 'OFF' };
}

/** Where a pipeline pack (its folder) may keep the global grids: PROJ data beside its libraries. */
export function packGeoidDirsOf(packDir: string): string[] {
  const site = [
    join(packDir, 'Lib', 'site-packages'),
    join(packDir, 'lib', 'python3.13', 'site-packages'),
  ];
  return [
    join(packDir, 'share', 'proj'),
    ...site.flatMap((s) => [
      join(s, 'rasterio', 'proj_data'),
      join(s, 'pyproj', 'proj_dir', 'share', 'proj'),
    ]),
  ];
}

/** SHA-256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

// ---------------------------------------------------------------- grid headers

export type Bbox = [number, number, number, number];

/** The extent (west, south, east, north, degrees) of a GTX grid from its 40-byte header. */
export function gtxBbox(header: Uint8Array, fileBytes: number): Bbox {
  if (header.byteLength < 40) throw new Error('The GTX file is too short.');
  const v = new DataView(header.buffer, header.byteOffset, 40);
  const lat0 = v.getFloat64(0, false);
  let lon0 = v.getFloat64(8, false);
  const dlat = v.getFloat64(16, false);
  const dlon = v.getFloat64(24, false);
  const rows = v.getInt32(32, false);
  const cols = v.getInt32(36, false);
  const ok = [lat0, lon0, dlat, dlon].every(Number.isFinite) && dlat > 0 && dlon > 0;
  if (!ok || rows < 2 || cols < 2 || 40 + rows * cols * 4 !== fileBytes) {
    throw new Error('This is not a GTX geoid grid (its header does not match its size).');
  }
  if (lon0 > 180) lon0 -= 360;
  const east = Math.min(180, lon0 + dlon * (cols - 1));
  const north = Math.min(90, lat0 + dlat * (rows - 1));
  return [Math.max(-180, lon0), Math.max(-90, lat0), east, north];
}

/**
 * The extent of a classic (not Big) GeoTIFF in geographic degrees, from ImageWidth, ImageLength,
 * ModelPixelScale and ModelTiepoint (pixel-is-area corners). Grids that are not in degrees are
 * refused: a geoid grid is longitude and latitude.
 */
export function geotiffBbox(b: Uint8Array): Bbox {
  if (b.byteLength < 8) throw new Error('The file is too short to be a GeoTIFF.');
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) throw new Error('This is not a TIFF file.');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const magic = v.getUint16(2, le);
  if (magic === 43)
    throw new Error('BigTIFF geoid grids are not read; convert it to a classic GeoTIFF or GTX.');
  if (magic !== 42) throw new Error('This is not a TIFF file.');
  const ifd = v.getUint32(4, le);
  if (ifd + 2 > b.byteLength) throw new Error('The TIFF header points outside the file.');
  const count = v.getUint16(ifd, le);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > b.byteLength) break;
    const tag = v.getUint16(at, le);
    const type = v.getUint16(at + 2, le);
    const n = v.getUint32(at + 4, le);
    const size = type === 3 ? 2 : type === 4 ? 4 : type === 12 ? 8 : 0;
    if (!size || n > 64) continue;
    const off = n * size <= 4 ? at + 8 : v.getUint32(at + 8, le);
    if (off + n * size > b.byteLength) continue;
    const vals: number[] = [];
    for (let k = 0; k < n; k++) {
      const p = off + k * size;
      vals.push(
        type === 3 ? v.getUint16(p, le) : type === 4 ? v.getUint32(p, le) : v.getFloat64(p, le),
      );
    }
    tags.set(tag, vals);
  }
  const width = tags.get(256)?.[0];
  const height = tags.get(257)?.[0];
  const scale = tags.get(33550);
  const tie = tags.get(33922);
  if (!width || !height || !scale || !tie || scale.length < 2 || tie.length < 6) {
    throw new Error('The GeoTIFF has no pixel scale or tie point, so its extent is unknown.');
  }
  const [sx = 0, sy = 0] = scale;
  const [i = 0, j = 0, , x = 0, y = 0] = tie;
  const west = x - i * sx;
  const north = y + j * sy;
  const east = west + width * sx;
  const south = north - height * sy;
  const inDegrees =
    west >= -180.5 && east <= 360.5 && south >= -90.5 && north <= 90.5 && sx > 0 && sy > 0;
  if (!inDegrees) throw new Error('The GeoTIFF is not in longitude and latitude degrees.');
  const w = west > 180 ? west - 360 : west;
  const e = east > 180 ? east - 360 : east;
  const clamp = (a: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, a));
  return [clamp(w, -180, 180), clamp(south, -90, 90), clamp(e, -180, 180), clamp(north, -90, 90)];
}

// ---------------------------------------------------------------- list, import, remove

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** The packs in `<data>/packs/geoid/` with their grids, sorted by name. */
export async function listGeoidPacks(dataRoot: string): Promise<GeoidPackMeta[]> {
  const dir = geoidPackDir(dataRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: GeoidPackMeta[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = GeoidPackMeta.safeParse(JSON.parse(await readFile(join(dir, name), 'utf8')));
      if (!meta.success || `${meta.data.id}.json` !== name) {
        console.warn(`Geoid pack ${join(dir, name)} has invalid metadata; skipped.`);
        continue;
      }
      if (!(await exists(join(dir, meta.data.projFile)))) continue;
      out.push(meta.data);
    } catch {
      console.warn(`Geoid pack ${join(dir, name)} could not be read; skipped.`);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const globalCache = new Map<string, GeoidPackMeta>();

/** The global grids found in the pipeline pack's folders. */
export async function listGlobalGeoids(dirs: readonly string[]): Promise<GeoidPackMeta[]> {
  const out: GeoidPackMeta[] = [];
  for (const g of GLOBAL_GEOIDS) {
    for (const d of dirs) {
      const path = join(d, g.projFile);
      const s = await stat(path).catch(() => null);
      if (!s?.isFile()) continue;
      const key = `${path}|${String(s.size)}|${String(s.mtimeMs)}`;
      let meta = globalCache.get(key);
      if (!meta) {
        meta = {
          schema: 'aio.geoid-pack/1',
          id: g.id,
          name: g.name,
          bbox: [-180, -90, 180, 90],
          horizontalEpsg: 4326,
          verticalEpsg: g.verticalEpsg,
          projFile: g.projFile,
          licence: 'Public domain',
          attribution: 'NGA (US National Geospatial-Intelligence Agency), through PROJ-data.',
          provenance: 'Pipeline pack',
          sha256: await sha256File(path),
          bytes: s.size,
        };
        globalCache.set(key, meta);
      }
      out.push(meta);
      break;
    }
  }
  return out;
}

/** A file-name-safe pack id from a name, not taken yet in the folder. */
async function freeId(dir: string, name: string): Promise<string> {
  const base =
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 60)
      .replace(/[-._]+$/, '') || 'geoid';
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${String(n)}`;
    if (GLOBAL_IDS.has(id.toLowerCase())) continue;
    if (!(await exists(join(dir, `${id}.json`)))) return id;
  }
}

export async function importGeoidPack(
  dataRoot: string,
  req: IpcRequest<'geoidPacks:import'>,
  now = new Date(),
): Promise<IpcResponse<'geoidPacks:import'>> {
  const ext = extname(req.path).toLowerCase();
  if (!['.tif', '.tiff', '.gtx'].includes(ext)) {
    return { ok: false, error: 'A geoid grid is a GeoTIFF (.tif) or a GTX (.gtx) file.' };
  }
  let size: number;
  let bbox: Bbox;
  try {
    const s = await stat(req.path);
    if (!s.isFile()) return { ok: false, error: `${req.path} is not a file.` };
    size = s.size;
    const fh = await open(req.path, 'r');
    try {
      const head = new Uint8Array(Math.min(size, 1024 * 1024));
      await fh.read(head, 0, head.byteLength, 0);
      bbox = ext === '.gtx' ? gtxBbox(head, size) : geotiffBbox(head);
    } finally {
      await fh.close();
    }
  } catch (e) {
    return {
      ok: false,
      error: `The geoid grid could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const dir = geoidPackDir(dataRoot);
  try {
    await mkdir(dir, { recursive: true });
    const id = await freeId(dir, req.name);
    if (!GeoidPackId.safeParse(id).success)
      return { ok: false, error: 'The name gives no usable pack id.' };
    const gridName = `${id}${ext === '.gtx' ? '.gtx' : '.tif'}`;
    const tmp = join(dir, `.${gridName}.importing`);
    await copyFile(req.path, tmp);
    const sha256 = await sha256File(tmp);
    const meta: GeoidPackMeta = {
      schema: 'aio.geoid-pack/1',
      id,
      name: req.name,
      bbox,
      ...(req.verticalEpsg ? { verticalEpsg: req.verticalEpsg } : {}),
      projFile: gridName,
      licence: req.licence,
      attribution: req.attribution,
      provenance: `Imported from ${basename(req.path)} on ${now.toISOString().slice(0, 10)}.`,
      sha256,
      bytes: size,
      imported: true,
    };
    const parsed = GeoidPackMeta.safeParse(meta);
    if (!parsed.success) {
      await rm(tmp, { force: true });
      return {
        ok: false,
        error: `The geoid pack is invalid: ${parsed.error.issues[0]?.message ?? ''}`,
      };
    }
    await rename(tmp, join(dir, gridName));
    await writeFile(join(dir, `${id}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
    return { ok: true, pack: parsed.data };
  } catch (e) {
    return {
      ok: false,
      error: `The geoid grid was not imported: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function removeGeoidPack(
  dataRoot: string,
  id: string,
): Promise<IpcResponse<'geoidPacks:remove'>> {
  if (GLOBAL_IDS.has(id.toLowerCase())) {
    return { ok: false, error: 'The global geoid grids ship with the pipeline pack and stay.' };
  }
  const dir = geoidPackDir(dataRoot);
  const metaPath = join(dir, `${id}.json`);
  let projFile: string | null = null;
  try {
    const meta = GeoidPackMeta.safeParse(JSON.parse(await readFile(metaPath, 'utf8')));
    if (meta.success) projFile = meta.data.projFile;
  } catch {
    return { ok: false, error: `There is no geoid pack ${id}.` };
  }
  // only a file named after the pack (never a path out of the folder)
  const files = [projFile, `${id}.tif`, `${id}.gtx`].filter(
    (f): f is string => f !== null && basename(f) === f,
  );
  for (const f of files) await rm(join(dir, f), { force: true });
  await rm(metaPath, { force: true });
  return { ok: true };
}

export function registerGeoidPacksIpc({
  handle,
  dataRoot,
  packGeoidDirs,
}: GeoidPacksIpcDeps): void {
  const none = { ok: false as const, error: 'No data folder in this build.' };
  handle('geoidPacks:list', async () => {
    if (!dataRoot) return none;
    const [local, global] = await Promise.all([
      listGeoidPacks(dataRoot()),
      packGeoidDirs ? packGeoidDirs().then(listGlobalGeoids) : Promise.resolve([]),
    ]);
    return { ok: true, packs: [...global, ...local] };
  });
  handle('geoidPacks:import', (req) =>
    dataRoot ? importGeoidPack(dataRoot(), req) : Promise.resolve(none),
  );
  handle('geoidPacks:remove', ({ id }) =>
    dataRoot ? removeGeoidPack(dataRoot(), id) : Promise.resolve(none),
  );
}
