import { defaultUtcOffsetMin, isPositionEdited, withPositionOffset } from '@aio/geo';
import type {
  OrientationFile,
  PhotoCorrection,
  PhotoRef,
  ProjectManifest,
  Vec3,
} from '@aio/schema';
import { open, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { resolveHeights } from './altitude';
import { readManifestFile, slug, updateManifestFile } from './create';
import { readPhotoMeta, type PhotoMeta } from './exif';
import { photoRef, type PhotoFrame } from './photos';
import { findTwin, needsTwin, twinFix, type TwinCandidate } from './thermalTwin';

/*
 * Re-read photo positions (photo position edit, 21 Oct 2026): projects imported before the XMP
 * reader fix carry XT2 photos at a barometric height and without a view direction. This reads
 * each photo of one photos layer again from its file and rewrites the item's imported `pos` and
 * `q`; hand corrections keep the photo's corrected place, and thermal photos without DJI metadata
 * take their visual twin's place again. Running it twice changes nothing.
 */

/** The project's `orientation.json`, read and written by the caller (main owns the file). */
export interface RereadOrientation {
  read(): Promise<OrientationFile | null>;
  write(file: OrientationFile): Promise<void>;
  /** Remove the file (a failed save puts back "no file" when there was none before). */
  remove(): Promise<void>;
}

export interface RereadOptions {
  /** The folder of the original files, for photos whose review copy carries no metadata. */
  folder?: string;
  /** Answer the counts without writing anything. */
  dryRun?: boolean;
  orientation: RereadOrientation;
}

export type RereadResult =
  | {
      ok: true;
      manifest: ProjectManifest;
      reread: number;
      /** Photos moved by hand that kept their corrected place. */
      kept: number;
      /** Thermal photos placed at their visual twin. */
      twins: number;
      /** Photos whose file was not found (in the review copy or the folder). */
      notFound: number;
    }
  | { ok: false; needsFolder: true; missing: number };

/** Bytes of a photo's head read for its metadata (as the import reads). */
const HEAD_BYTES = 512 * 1024;
/** Files of the originals folder looked at, at most. */
const FOLDER_FILES_MAX = 50_000;
const JPEG = /\.jpe?g$/i;

type PhotosLayer = Extract<ProjectManifest['layers'][number], { kind: 'photos' }>;

/** What one photo's file says, and the file name its twin is found by. */
interface Found {
  meta: PhotoMeta;
  /** File name for the thermal twin rule (`X_0005_R.JPG`, or the id as such a name). */
  name: string;
}

async function readHead(file: string): Promise<Uint8Array | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const b = new Uint8Array(HEAD_BYTES);
      const r = await fh.read(b, 0, HEAD_BYTES, 0);
      return b.subarray(0, r.bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function metaOf(file: string): Promise<PhotoMeta | null> {
  const head = await readHead(file);
  if (!head) return null;
  try {
    return readPhotoMeta(head);
  } catch {
    return null;
  }
}

const hasGps = (m: PhotoMeta) =>
  (m.dji?.lat ?? m.gps?.lat) !== undefined && (m.dji?.lon ?? m.gps?.lon) !== undefined;

/** Both times to the second, when both are known; a missing one does not refuse. */
const sameTime = (item: PhotoRef, meta: PhotoMeta) =>
  item.takenAt === undefined ||
  meta.takenAt === undefined ||
  item.takenAt.slice(0, 19) === meta.takenAt.slice(0, 19);

/** Every JPEG under a folder by the slug of its name (as the import makes ids). */
async function folderIndex(folder: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  let n = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (n >= FOLDER_FILES_MAX) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && JPEG.test(e.name)) {
        n += 1;
        const key = slug(e.name.slice(0, -extname(e.name).length), 'photo');
        out.set(key, [...(out.get(key) ?? []), p]);
      }
    }
  };
  await walk(folder);
  return out;
}

/** The review copy's id as a file name the twin rule reads: `x-0005-r` to `x-0005_r.jpg`. */
const idName = (id: string) => `${id.replace(/-r$/i, '_r')}.jpg`;

/** The file of one photo: its review copy when it kept the metadata, else the originals folder. */
async function findSource(
  root: string,
  item: PhotoRef,
  folder: Map<string, string[]> | null,
): Promise<Found | null> {
  if ('path' in item.src) {
    const meta = await metaOf(join(root, item.src.path));
    if (meta && hasGps(meta)) return { meta, name: idName(item.id) };
  }
  if (!folder) return null;
  const suffix = /^(.*)-\d+$/.exec(item.id)?.[1];
  const files = [...(folder.get(item.id) ?? []), ...(suffix ? (folder.get(suffix) ?? []) : [])];
  for (const f of files) {
    const meta = await metaOf(f);
    if (meta && hasGps(meta) && sameTime(item, meta)) return { meta, name: basename(f) };
  }
  return null;
}

const round01mm = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const rounded = (v: Vec3): Vec3 => [round01mm(v[0]), round01mm(v[1]), round01mm(v[2])];

interface Plan {
  items: PhotoRef[];
  /** The layer's corrections after the re-read. */
  corrections: Record<string, PhotoCorrection>;
  changedCorrections: boolean;
  reread: number;
  kept: number;
  twins: number;
  notFound: number;
}

/** What the re-read does to one layer, from the files read for it. */
function plan(
  m: ProjectManifest,
  layer: PhotosLayer,
  found: ReadonlyMap<string, Found>,
  corrections: Readonly<Record<string, PhotoCorrection>>,
  frame: PhotoFrame,
): Plan {
  const out = new Map(Object.entries(corrections));
  let changedCorrections = false;
  const setCorrection = (id: string, c: PhotoCorrection | null) => {
    const cur = out.get(id);
    if (c === null) {
      if (cur === undefined) return;
      out.delete(id);
    } else {
      if (JSON.stringify(cur) === JSON.stringify(c)) return;
      out.set(id, c);
    }
    changedCorrections = true;
  };
  let reread = 0;
  let kept = 0;
  let notFound = 0;
  const thermals: { item: PhotoRef; name: string }[] = [];
  const items = layer.items.map((it) => {
    if (it.pin) return it;
    const f = found.get(it.id);
    if (!f) {
      notFound += 1;
      return it;
    }
    const src = 'path' in it.src ? it.src.path : '';
    const fresh = photoRef(it.id, src, f.meta, frame);
    if (!fresh.pos) {
      notFound += 1;
      return it;
    }
    reread += 1;
    const next: PhotoRef = { ...it, pos: fresh.pos };
    if (fresh.q) next.q = fresh.q;
    const c = corrections[it.id];
    if (needsTwin(f.name, f.meta)) thermals.push({ item: next, name: f.name });
    else if (c && isPositionEdited(c) && c.offsetM && it.pos) {
      // the corrected place stays where the person put it
      kept += 1;
      setCorrection(it.id, withPositionOffset(c, rounded(sub(add(it.pos, c.offsetM), fresh.pos))));
    }
    return next;
  });
  let twins = 0;
  if (thermals.length > 0) {
    const thermalIds = new Set(thermals.map((t) => t.item.id));
    const candidate = (p: PhotoRef): TwinCandidate => ({
      name: p.id,
      ...(p.takenAt !== undefined ? { takenAt: p.takenAt } : {}),
      ...(p.pos ? { pos: p.pos } : {}),
      ...(p.q ? { q: p.q } : {}),
      ...(thermalIds.has(p.id) ? { needsTwin: true } : {}),
    });
    const candidates = [
      ...items.filter((p) => !p.pin).map(candidate),
      ...m.layers.flatMap((l) =>
        l.kind === 'photos' && l.id !== layer.id
          ? l.items.filter((p) => !p.pin).map((p) => ({ ...candidate(p), needsTwin: false }))
          : [],
      ),
    ];
    for (const t of thermals) {
      const twin = findTwin(
        { name: t.name, ...(t.item.takenAt !== undefined ? { takenAt: t.item.takenAt } : {}) },
        candidates,
      );
      const fix = twin ? twinFix(t.item, twin) : null;
      const c = corrections[t.item.id];
      if (fix) {
        twins += 1;
        if (fix.q) t.item.q = fix.q;
        setCorrection(t.item.id, withPositionOffset(c, fix.offsetM));
      } else if (c && isPositionEdited(c) && c.offsetM) {
        // no twin now: a hand move is kept like any other
        const old = layer.items.find((p) => p.id === t.item.id)?.pos;
        if (old && t.item.pos) {
          kept += 1;
          setCorrection(
            t.item.id,
            withPositionOffset(c, rounded(sub(add(old, c.offsetM), t.item.pos))),
          );
        }
      }
    }
  }
  return {
    items,
    corrections: Object.fromEntries(out),
    changedCorrections,
    reread,
    kept,
    twins,
    notFound,
  };
}

function photosLayer(m: ProjectManifest, layerId: string): PhotosLayer {
  const l = m.layers.find((x) => x.id === layerId);
  if (l?.kind !== 'photos')
    throw new Error(`There is no photos layer "${layerId}" in this project.`);
  return l;
}

function frameOf(m: ProjectManifest): PhotoFrame {
  if (!('epsg' in m.crs))
    throw new Error('Re-reading photos needs a project CRS given as an EPSG code.');
  const epsg = m.crs.epsg;
  return {
    epsg,
    origin: m.origin,
    utcOffsetMin: defaultUtcOffsetMin(m.origin, epsg),
    heights: resolveHeights(m).rule,
  };
}

/** The orientation file with one layer's corrections replaced (none left: the layer goes). */
function withLayer(
  file: OrientationFile | null,
  layerId: string,
  corrections: Record<string, PhotoCorrection>,
): OrientationFile {
  const base: OrientationFile = file
    ? structuredClone(file)
    : { schema: 'aio.orientation/1', clips: {}, photos: {} };
  const photos = Object.fromEntries(Object.entries(base.photos).filter(([id]) => id !== layerId));
  if (Object.keys(corrections).length > 0) photos[layerId] = corrections;
  return { ...base, photos, updatedAt: new Date().toISOString() };
}

/**
 * Re-read the photos of one photos layer from their files (the review copy when it kept its
 * metadata, else the file of the same name and capture time under `folder`) with the project's
 * current height rule. Pinned photos are left alone; the lens and capture time are kept; a hand
 * correction's `offsetM` is re-anchored to the new `pos` so the corrected place does not move; a
 * thermal `_R` photo without DJI XMP takes its visual twin's place (an `offsetM`) and view
 * direction. When a photo's file is missing and no folder was given, answers `needsFolder` and
 * writes nothing. One manifest save and at most one orientation write, in the manifest's turn
 * (the orientation file is put back if the manifest save fails). Throws on a layer that is not a
 * photos layer.
 */
export async function rereadPhotoLayer(
  root: string,
  layerId: string,
  o: RereadOptions,
): Promise<RereadResult> {
  const start = await readManifestFile(root);
  const layer = photosLayer(start, layerId);
  const folder = o.folder === undefined ? null : await folderIndex(o.folder);
  const found = new Map<string, Found>();
  let missing = 0;
  for (const it of layer.items) {
    if (it.pin) continue;
    const f = await findSource(root, it, folder);
    if (f) found.set(it.id, f);
    else missing += 1;
  }
  if (missing > 0 && o.folder === undefined) return { ok: false, needsFolder: true, missing };
  const frame = frameOf(start);
  const counts = (p: Plan) => ({
    reread: p.reread,
    kept: p.kept,
    twins: p.twins,
    notFound: p.notFound,
  });
  if (o.dryRun) {
    const file = await o.orientation.read();
    const p = plan(start, layer, found, file?.photos[layerId] ?? {}, frame);
    return { ok: true, manifest: start, ...counts(p) };
  }
  const saved = await updateManifestFile(root, async (m) => {
    const target = photosLayer(m, layerId);
    const before = await o.orientation.read();
    const p = plan(m, target, found, before?.photos[layerId] ?? {}, frameOf(m));
    if (p.reread === 0) return { manifest: null, counts: counts(p) };
    if (p.changedCorrections) await o.orientation.write(withLayer(before, layerId, p.corrections));
    const next: ProjectManifest = {
      ...m,
      layers: m.layers.map((l) => (l.id === layerId ? { ...target, items: p.items } : l)),
    };
    return {
      manifest: next,
      counts: counts(p),
      ...(p.changedCorrections
        ? {
            afterFail: () =>
              before === null ? o.orientation.remove() : o.orientation.write(before),
          }
        : {}),
    };
  });
  return { ok: true, manifest: saved.manifest, ...saved.counts };
}
