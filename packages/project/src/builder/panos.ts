import { defaultUtcOffsetMin, gridConvergenceDeg } from '@aio/geo';
import {
  PANO_STITCH_MAX_BYTES,
  PanoStitchFile,
  panoFolder,
  type Layer,
  type PanoCov,
  type PanoQuality,
  type PanoRef,
  type PanoShape,
  type PanoStitchStatus,
  type ProjectManifest,
} from '@aio/schema';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { resolveHeights } from './altitude';
import { captureForDate, readManifestFile, uniqueId, updateManifestFile } from './create';
import type { PanoFrameMeta, PanoGrouping, PanoSphereGroup } from './panoGroups';
import { photoRef, type PhotoFrame } from './photos';
import type { ImageOps } from './raw';

/*
 * Drone panoramas in a project (data-conventions section 33): the import copies each sphere's
 * frames into `panoramas/<layerId>/<panoId>/frames/` and saves one `panoramas` layer whose spheres
 * are queued; `pano.stitch` writes the images and `stitch.json`; the app files the outcome here.
 */

export type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;

export interface KeyedGrouping {
  spheres: (PanoSphereGroup & { key: string })[];
  /** Without `lat` and `lon` (a 360 with no GPS) it imports unplaced. */
  ready: (PanoFrameMeta & { key: string })[];
}

/** Scan keys: `s1`, `s2` ... for spheres and wide panoramas, `r1`, `r2` ... for ready-made ones. */
export function keyGrouping(g: PanoGrouping): KeyedGrouping {
  return {
    spheres: g.spheres.map((s, i) => ({ ...s, key: `s${String(i + 1)}` })),
    ready: g.ready.map((r, i) => {
      const key = `r${String(i + 1)}`;
      const out = { ...r, key };
      if (r.lat !== undefined && r.lon !== undefined) return out;
      // half a position is no position: never place it at a made-up longitude or latitude
      delete out.lat;
      delete out.lon;
      return out;
    }),
  };
}

export interface PanoImportChoice {
  keys: readonly string[];
  layerName: string;
  /** Survey date `YYYY-MM-DD`; the layer is filed under it (created when the project has none). */
  date?: string;
  quality: PanoQuality;
}

export interface PanoImportDeps {
  images: Pick<ImageOps, 'resizeJpeg'>;
  /** Free bytes on the drive of `dir`. */
  freeBytes(dir: string): Promise<number>;
  onProgress?(done: number, total: number, file: string): void;
  signal?: AbortSignal;
}

export class PanoImportError extends Error {
  constructor(
    message: string,
    readonly code: 'space' | 'cancelled' | 'empty',
  ) {
    super(message);
    this.name = 'PanoImportError';
  }
}

/** Room left beyond the frames: the stitch's images and its staging. */
export const PANO_COPY_HEADROOM = 256 * 1024 * 1024;

export interface PanoImportResult {
  manifest: ProjectManifest;
  layerId: string;
  /** The sphere ids to stitch (ready-made panoramas need none). */
  stitch: string[];
  /** The scan's classification of each sphere to stitch (for `PanoStitchParams.shape`). */
  shapes: Record<string, PanoShape>;
}

const GB = 1024 ** 3;
const size = (n: number) =>
  n >= GB ? `${(n / GB).toFixed(1)} GB` : `${String(Math.round(n / 1024 ** 2))} MB`;

const NEEDS_EPSG = 'Drone panoramas need a project CRS given as an EPSG code.';

/** A ready-made 360 is placed on the site only with a full GPS position. */
const hasPlace = (r: { lat?: number; lon?: number }) =>
  r.lat !== undefined && r.lon !== undefined && Number.isFinite(r.lat) && Number.isFinite(r.lon);

const itemId = (n: number) => `p${String(n).padStart(2, '0')}`;

/** A file name not used yet in one folder (Windows compares names without case). */
function freeName(name: string, used: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let out = name;
  for (let k = 2; used.has(out.toLowerCase()); k++) out = `${stem}-${String(k)}${ext}`;
  used.add(out.toLowerCase());
  return out;
}

interface Where {
  /** Both or neither: without them the item is written unplaced (no `pos`). */
  lat?: number;
  lon?: number;
  absAlt?: number;
  relAlt?: number;
  takenAt?: string;
}

/**
 * A wide panorama's coverage before it is stitched (so a restitch keeps its shape): the yaw range of
 * its frames, clockwise from north (the arc left after dropping the widest gap), full height.
 * A sphere gets none until it is stitched; `applyStitchOutcome` overwrites this with the result.
 */
function provisionalCov(s: PanoSphereGroup): PanoCov | undefined {
  if (s.shape !== 'wide') return undefined;
  const yaws = s.frames
    .flatMap((f) => (f.gimbal ? [((f.gimbal.yaw % 360) + 360) % 360] : []))
    .sort((a, b) => a - b);
  const first = yaws[0];
  if (first === undefined) return undefined;
  let gap = first + 360 - (yaws[yaws.length - 1] ?? first);
  let left = first;
  for (let i = 1; i < yaws.length; i++) {
    const d = (yaws[i] ?? 0) - (yaws[i - 1] ?? 0);
    if (d > gap) {
      gap = d;
      left = yaws[i] ?? left;
    }
  }
  const span = 360 - gap;
  if (span <= 0) return undefined;
  const r = (v: number) => Math.round(v * 10) / 10;
  return { top: 90, bottom: 90, left: r(left), right: r(left + span) };
}

/**
 * A pano item: position like a photo's camera; centre column true north, so heading = -convergence.
 * Without a place (a 360 with no GPS) it has no `pos` and heading 0 until it is pinned on the site.
 */
function panoRef(
  id: string,
  layerId: string,
  n: number,
  w: Where,
  f: PhotoFrame,
  stitched: boolean,
  cov?: PanoCov,
): PanoRef {
  const path = `${panoFolder(layerId, id)}/pano.jpg`;
  const lat = w.lat !== undefined && Number.isFinite(w.lat) ? w.lat : undefined;
  const lon = w.lon !== undefined && Number.isFinite(w.lon) ? w.lon : undefined;
  const placed = lat !== undefined && lon !== undefined;
  const cam = photoRef(
    id,
    path,
    {
      ...(w.takenAt ? { takenAt: w.takenAt } : {}),
      ...(placed
        ? {
            dji: {
              lat,
              lon,
              ...(w.absAlt !== undefined ? { absAlt: w.absAlt } : {}),
              ...(w.relAlt !== undefined ? { relAlt: w.relAlt } : {}),
            },
          }
        : {}),
    },
    f,
  );
  return {
    id,
    src: { path },
    ...(cam.pos ? { pos: cam.pos } : {}),
    headingDeg: placed ? Math.round(-gridConvergenceDeg(lon, lat, f.epsg) * 1000) / 1000 : 0,
    name: `Pano ${String(n)}`,
    ...(cam.takenAt ? { capturedAt: cam.takenAt } : {}),
    ...(stitched ? { stitch: { status: 'queued' as const } } : {}),
    ...(cov ? { cov } : {}),
  };
}

export async function importPanoGroups(
  root: string,
  g: KeyedGrouping,
  choice: PanoImportChoice,
  deps: PanoImportDeps,
): Promise<PanoImportResult> {
  const atStart = await readManifestFile(root);
  const chosen = new Set(choice.keys);
  const spheres = g.spheres.filter((s) => chosen.has(s.key));
  const ready = g.ready.filter((r) => chosen.has(r.key));
  if (spheres.length + ready.length === 0)
    throw new PanoImportError('Choose at least one panorama to import.', 'empty');
  // A local grid has no EPSG code: spheres to stitch and 360s with a position need one to be
  // placed; a 360 with no GPS is placed by hand later, so it needs no coordinates.
  const epsg = 'epsg' in atStart.crs ? atStart.crs.epsg : null;
  if (epsg === null && (spheres.length > 0 || ready.some(hasPlace))) throw new Error(NEEDS_EPSG);
  const frame: PhotoFrame = {
    // unread on a local grid: only unplaced 360s get this far, and they have no position to convert
    epsg: epsg ?? 0,
    origin: atStart.origin,
    utcOffsetMin: epsg === null ? 0 : defaultUtcOffsetMin(atStart.origin, epsg),
    heights: resolveHeights(atStart).rule,
  };
  const total = spheres.reduce((n, s) => n + s.frames.length, 0) + ready.length;
  const bytes = spheres.reduce((n, s) => n + s.bytes, 0) + ready.reduce((n, r) => n + r.bytes, 0);
  const free = await deps.freeBytes(root);
  if (bytes + PANO_COPY_HEADROOM > free)
    throw new PanoImportError(
      `Importing these panoramas needs ${size(bytes + PANO_COPY_HEADROOM)} free, and ${size(free)} is free.`,
      'space',
    );
  // reserve the layer folder on disk (a non-recursive mkdir), so a concurrent import or an orphan
  // folder with the same id is never shared, written into or removed by our cleanup
  await mkdir(join(root, 'panoramas'), { recursive: true });
  const base = choice.date ? `panos-${choice.date}` : 'panos';
  const busy = new Set<string>();
  const reserve = async (): Promise<string> => {
    const id = uniqueId(base, (x) => busy.has(x) || atStart.layers.some((l) => l.id === x));
    try {
      await mkdir(join(root, 'panoramas', id));
      return id;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      busy.add(id);
      return reserve();
    }
  };
  const layerId = await reserve();
  const layerDir = join(root, 'panoramas', layerId);
  const items: PanoRef[] = [];
  const stitch: string[] = [];
  const shapes: Record<string, PanoShape> = {};
  let done = 0;
  const tick = (file: string) => {
    if (deps.signal?.aborted) throw new PanoImportError('The import was cancelled.', 'cancelled');
    deps.onProgress?.(++done, total, basename(file));
  };
  try {
    let n = 0;
    for (const s of spheres) {
      const id = itemId(++n);
      const dir = join(layerDir, id, 'frames');
      await mkdir(dir, { recursive: true });
      const used = new Set<string>();
      for (const f of s.frames) {
        if (deps.signal?.aborted)
          throw new PanoImportError('The import was cancelled.', 'cancelled');
        await copyFile(f.file, join(dir, freeName(basename(f.file), used)));
        tick(f.file);
      }
      items.push(
        panoRef(id, layerId, n, { ...s, takenAt: s.startedAt }, frame, true, provisionalCov(s)),
      );
      stitch.push(id);
      shapes[id] = s.shape;
    }
    for (const r of ready) {
      const id = itemId(++n);
      const dir = join(layerDir, id);
      await mkdir(dir, { recursive: true });
      await copyFile(r.file, join(dir, 'pano.jpg'));
      await deps.images.resizeJpeg(r.file, join(dir, 'thumb.jpg'), 512);
      tick(r.file);
      items.push(panoRef(id, layerId, n, r, frame, false));
    }
    if (deps.signal?.aborted) throw new PanoImportError('The import was cancelled.', 'cancelled');
    const layer: PanoLayer = {
      kind: 'panoramas',
      id: layerId,
      name: choice.layerName,
      visible: true,
      items,
    };
    const saved = await updateManifestFile(root, (fresh) => {
      if (fresh.layers.some((l) => l.id === layerId))
        throw new Error('Another import added the same layer meanwhile; import again.');
      let m = fresh;
      let capture: string | undefined;
      if (choice.date) {
        const c = captureForDate(m, choice.date);
        m = c.manifest;
        capture = c.captureId;
      }
      return { manifest: { ...m, layers: [...m.layers, capture ? { ...layer, capture } : layer] } };
    });
    return { manifest: saved.manifest, layerId, stitch, shapes };
  } catch (e) {
    // a locked file (antivirus, indexer) must not replace the real error
    await rm(layerDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    throw e;
  }
}

function mapItems(
  m: ProjectManifest,
  layerId: string,
  edit: (p: PanoRef) => PanoRef,
): ProjectManifest | null {
  const state = { changed: false };
  const layers = m.layers.map((l) => {
    if (l.kind !== 'panoramas' || l.id !== layerId) return l;
    const items = l.items.map((p) => {
      const next = edit(p);
      if (next !== p) state.changed = true;
      return next;
    });
    return { ...l, items };
  });
  return state.changed ? { ...m, layers } : null;
}

/** Record the started runs on items still queued without one (another outcome may have won). */
export function setPanoRuns(
  m: ProjectManifest,
  layerId: string,
  runs: Readonly<Record<string, string>>,
): ProjectManifest | null {
  return mapItems(m, layerId, (p) => {
    const run = runs[p.id];
    if (!run || p.stitch?.status !== 'queued' || p.stitch.run !== undefined) return p;
    return { ...p, stitch: { run, status: 'queued' } };
  });
}

export interface StitchOutcome {
  layer: string;
  pano: string;
  run: string;
  status: PanoStitchStatus;
  error?: string;
}

const FULL: PanoCov = { top: 90, bottom: 90 };

function covOf(r: PanoStitchFile): PanoCov {
  const c = r.coverage;
  if (r.shape === 'wide' && c.leftDeg !== undefined && c.rightDeg !== undefined)
    return { top: c.topDeg, bottom: c.bottomDeg, left: c.leftDeg, right: c.rightDeg };
  return FULL;
}

/**
 * The manifest with a stitch outcome filed into its item, or null when nothing changes: an
 * unknown item, an outcome of a run older than the item's (job ids sort by start time), or the
 * same state again. `done` needs the run's record (its coverage).
 */
export function applyStitchOutcome(
  m: ProjectManifest,
  o: StitchOutcome,
  record?: PanoStitchFile | null,
): ProjectManifest | null {
  return mapItems(m, o.layer, (p) => {
    if (p.id !== o.pano || !p.stitch) return p; // a ready-made panorama has no stitch
    const prev = p.stitch.run;
    if (prev !== undefined && o.run < prev) return p;
    if (o.status === 'done') {
      if (record?.run !== o.run) return p;
      const cov = covOf(record);
      if (
        p.stitch.status === 'done' &&
        p.stitch.run === o.run &&
        JSON.stringify(p.cov) === JSON.stringify(cov)
      )
        return p;
      return { ...p, stitch: { run: o.run, status: 'done' }, cov };
    }
    const stitch = {
      run: o.run,
      status: o.status,
      ...(o.error ? { error: o.error.slice(0, 400) } : {}),
    };
    if (JSON.stringify(p.stitch) === JSON.stringify(stitch)) return p;
    return { ...p, stitch };
  });
}

/** A sphere's `stitch.json`, or null when absent, too large or not readable as `aio.pano-stitch/1`. */
export async function readStitchRecord(
  root: string,
  layer: string,
  pano: string,
): Promise<PanoStitchFile | null> {
  const file = join(root, panoFolder(layer, pano), 'stitch.json');
  try {
    if ((await stat(file)).size > PANO_STITCH_MAX_BYTES) return null;
    const r = PanoStitchFile.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return r.success && r.data.layer === layer && r.data.pano === pano ? r.data : null;
  } catch {
    return null;
  }
}

/** File the stitches that finished without being filed (the app closed in between). */
export async function reconcilePanoStitches(
  root: string,
  m: ProjectManifest,
): Promise<ProjectManifest | null> {
  let next = m;
  let changed = false;
  for (const l of m.layers) {
    if (l.kind !== 'panoramas') continue;
    for (const p of l.items) {
      if (!p.stitch || p.stitch.status === 'done') continue;
      const r = await readStitchRecord(root, l.id, p.id);
      if (!r || (p.stitch.run !== undefined && r.run < p.stitch.run)) continue;
      const filed = applyStitchOutcome(
        next,
        { layer: l.id, pano: p.id, run: r.run, status: 'done' },
        r,
      );
      if (filed) {
        next = filed;
        changed = true;
      }
    }
  }
  return changed ? next : null;
}

const frameKey = (name: string, bytes: number) => `${name.toLowerCase()}|${String(bytes)}`;

/** Every frame already in the project's pano layers, by file name and size, to its layer's name. */
export async function knownPanoFrames(
  root: string,
  m: ProjectManifest,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const l of m.layers) {
    if (l.kind !== 'panoramas') continue;
    for (const p of l.items) {
      const dir = join(root, panoFolder(l.id, p.id), 'frames');
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const n of names) {
        const s = await stat(join(dir, n)).catch(() => null);
        if (s?.isFile()) out.set(frameKey(n, s.size), l.name);
      }
    }
  }
  return out;
}

/** Spheres whose frames, at least half of them, are in a pano layer already: key to layer name. */
export function markAlreadyImported(
  g: KeyedGrouping,
  known: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of g.spheres) {
    const hits = s.frames.flatMap((f) => {
      const layer = known.get(frameKey(basename(f.file), f.bytes));
      return layer === undefined ? [] : [layer];
    });
    if (hits.length * 2 >= s.frames.length && hits[0] !== undefined) out.set(s.key, hits[0]);
  }
  return out;
}
