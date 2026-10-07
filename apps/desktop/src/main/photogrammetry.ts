/**
 * Processing photos in the Builder (M10 stream G4): the hardware probe, the estimate, the runs of
 * a project (`photogrammetry/<run>/`, data-conventions section 21), ground control points
 * (`gcp.json`, atomic with a `.bak`, refused for packages), **Use refined poses** and cleaning a
 * run's work files. The processing itself runs as pipeline jobs (`photo.align`, `photo.georef`,
 * `photo.products`) through `jobs:start`; this module only reads what they write, and writes the
 * files a person edits.
 *
 * Photos are read, never written: the estimate reads the head of each photo (EXIF and the frame
 * size) and nothing else.
 */
import {
  AccuracyReport,
  GcpFile,
  HardwareProbe,
  LensModel,
  PHOTO_RUN_FILES,
  PhotoCamerasFile,
  PhotoRun,
  photoRunDir,
  type Layer,
  type Quat,
  type Vec3,
  type PhotoEstimate,
  type PhotoPreset,
  type PhotoProduct,
  type PhotoRunSummary,
  type PhotoSource,
  type ProjectManifest,
} from '@aio/schema';
import { open, readdir, readFile, realpath, stat, statfs } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isChangedOnDisk, readBytesSeen, writeJsonAtomic, writeJsonSeen } from './fsutil';
import { compareVersions } from './jobs/pack';
import type { Handle } from './notYet';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;

/**
 * The builder library loads on first use, as in builder.ts and modelBuilder.ts: a static import
 * of it makes the main bundle come out empty (rolldown, vite 8).
 */
const lib = () => import('@aio/project/builder');

/** The projects main has open: a folder (writable) or a package (read only). */
export interface PhotoProjects {
  root(id: string): string | undefined;
  package(id: string):
    | {
        manifest: ProjectManifest;
        archive: {
          entries: ReadonlyMap<string, unknown>;
          read(name: string): Promise<Buffer>;
        };
      }
    | undefined;
}

/** A GPU as the probe reports it. */
export interface ProbeGpu {
  name: string;
  vendor?: string;
  vramBytes?: number;
}

/** What the probe reads from this computer; Electron and the pack in production, fakes in tests. */
export interface PhotoSystem {
  platform: string;
  arch: string;
  cpu(): { model: string; cores: number; threads?: number };
  memoryBytes(): number;
  /** Free bytes on the drive of the data folder. */
  freeDiskBytes(): Promise<number>;
  gpus(): Promise<ProbeGpu[]>;
  /** The pipeline pack's version (`dev` for a development interpreter), null without a pack. */
  packVersion(): Promise<string | null>;
  /** Whether the pack's CUDA build is present and passes its self-test (decision 5: M10.1). */
  cuda?(): Promise<boolean>;
}

export interface PhotogrammetryIpcDeps {
  handle: Handle;
  projects?: PhotoProjects;
  system?: PhotoSystem;
  /** Move a folder to the recycle bin (Electron `shell.trashItem`). */
  trash?: (path: string) => Promise<void>;
  now?: () => Date;
}

const READ_ONLY = {
  ok: false as const,
  error: 'This project is a read-only package. Photos are not processed in a package.',
  code: 'read-only' as const,
};
const notOpen = (id: string) => ({ ok: false as const, error: `Project "${id}" is not open.` });
const NO_PROJECTS = { ok: false as const, error: 'No project registry in this build.' };

/** The first pack that processes photos (pack 0.4.0, M10). */
export const PHOTO_PACK = '0.4.0';

// ---------------------------------------------------------------- probe

/** Decision 8: photogrammetry on Windows x64 and macOS arm64 only. */
export function processingVerdict(
  platform: string,
  arch: string,
  packVersion: string | null,
): HardwareProbe['processing'] {
  const supported =
    (platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64');
  if (!supported) return 'unsupported-platform';
  if (packVersion === null) return 'no-pack';
  if (packVersion !== 'dev' && compareVersions(packVersion, PHOTO_PACK) < 0) return 'pack-too-old';
  return 'available';
}

const VENDORS: Readonly<Record<number, string>> = {
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x8086: 'Intel',
  0x106b: 'Apple',
  0x5143: 'Qualcomm',
};

/**
 * GPUs from Electron's `app.getGPUInfo('basic')` (`gpuDevice[]`): the device string where
 * Chromium gives one, else the vendor; software renderers (SwiftShader, Microsoft Basic Render)
 * are left out.
 */
export function gpusFromInfo(info: unknown): ProbeGpu[] {
  const devices = (info as { gpuDevice?: unknown } | null)?.gpuDevice;
  if (!Array.isArray(devices)) return [];
  const out: ProbeGpu[] = [];
  for (const d of devices as Record<string, unknown>[]) {
    const vendorId = typeof d.vendorId === 'number' ? d.vendorId : 0;
    const vendor = VENDORS[vendorId];
    const named = typeof d.deviceString === 'string' ? d.deviceString.trim() : '';
    if (/swiftshader|basic render|llvmpipe/i.test(named) || (!vendor && !named)) continue;
    const name = (named || `${vendor ?? 'Unknown'} GPU`).slice(0, 200);
    if (out.some((g) => g.name === name)) continue;
    out.push({ name, ...(vendor ? { vendor } : {}) });
  }
  return out.slice(0, 16);
}

async function readProbe(system: PhotoSystem): Promise<HardwareProbe> {
  const [freeDiskBytes, gpus, pack, cuda] = await Promise.all([
    system.freeDiskBytes().catch(() => 0),
    system.gpus().catch(() => []),
    system.packVersion().catch(() => null),
    system.cuda ? system.cuda().catch(() => false) : Promise.resolve(false),
  ]);
  const cpu = system.cpu();
  return HardwareProbe.parse({
    platform: system.platform,
    arch: system.arch,
    cpu: {
      model: cpu.model.slice(0, 200) || 'Unknown CPU',
      cores: Math.max(1, Math.round(cpu.cores)),
      ...(cpu.threads ? { threads: Math.max(1, Math.round(cpu.threads)) } : {}),
    },
    memoryBytes: Math.max(0, Math.round(system.memoryBytes())),
    freeDiskBytes: Math.max(0, Math.round(freeDiskBytes)),
    gpus,
    cuda,
    processing: processingVerdict(system.platform, system.arch, pack),
  });
}

/**
 * This computer through Node and Electron. `gpuInfo` is `app.getGPUInfo('basic')`; `dataRoot` the
 * data folder (free disk is measured on its drive); `packVersion` the pack `findPack` picks.
 */
export function nodePhotoSystem(o: {
  gpuInfo: () => Promise<unknown>;
  dataRoot: () => string;
  packVersion: () => Promise<string | null>;
}): PhotoSystem {
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: () => {
      const list = cpus();
      const model = list[0]?.model.trim() ?? '';
      // Node reports logical processors; physical cores are not exposed, so half on x64 (SMT)
      const threads = list.length || 1;
      const cores = process.arch === 'x64' && threads > 2 ? Math.ceil(threads / 2) : threads;
      return { model, cores, threads };
    },
    memoryBytes: () => totalmem(),
    freeDiskBytes: async () => {
      const s = await statfs(o.dataRoot());
      return s.bavail * s.bsize;
    },
    gpus: async () => gpusFromInfo(await o.gpuInfo()),
    packVersion: o.packVersion,
  };
}

// ---------------------------------------------------------------- memory cap

/** The photo jobs that size their heavy stages by `AIO_PHOTO_MEMORY_MB`. */
export const PHOTO_MEMORY_PIPELINES: ReadonlySet<string> = new Set([
  'photo.align',
  'photo.georef',
  'photo.products',
]);

/**
 * The memory the photo jobs may use, MB: 75 % of this computer's memory (at least 512 MB), one
 * value for alignment and products. There is no Settings field for it (Settings is pinned for
 * 0.9); `STRATLAS_PHOTO_MEMORY_MB` overrides it for tests.
 */
export function photoMemoryMb(
  totalBytes: number,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const override = Number(env.STRATLAS_PHOTO_MEMORY_MB);
  if (Number.isInteger(override) && override > 0) return override;
  return Math.max(512, Math.floor((totalBytes * 0.75) / MB));
}

/** Extra environment of a pipeline job: the memory cap for the photo jobs, nothing for others. */
export function photoJobEnv(
  pipeline: string,
  totalBytes: number,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return PHOTO_MEMORY_PIPELINES.has(pipeline)
    ? { AIO_PHOTO_MEMORY_MB: String(photoMemoryMb(totalBytes, env)) }
    : {};
}

// ---------------------------------------------------------------- estimate

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** What the estimate knows about the photos. */
export interface PhotoSet {
  count: number;
  /** Megapixels of a typical photo (the median of those read); 20 when unknown. */
  megapixels: number;
  /** Bytes of all photos (measured or extrapolated). */
  bytes: number;
  /** Camera groups: one per camera body, lens and frame size. */
  groups: { label: string; widthPx?: number; heightPx?: number; photos: number }[];
  /** True when only a sample of the photos was read. */
  sampled: boolean;
  /** Centre of the photos' GPS positions, when any had one. */
  centre?: { lat: number; lon: number };
  /** Photos without a GPS position (of those read). */
  noGps: number;
}

/**
 * The plan's reference times (500 photos of 20 MP on an 8-core CPU with 32 GB), in minutes,
 * replaced by G3's measurements when they land. High uses the CPU path unless the CUDA build
 * runs (decision 5).
 */
const REF = {
  pixels: 500 * 20,
  cores: 8,
  minutes: {
    fast: [30, 60],
    standard: [180, 360],
    high: [600, 1200],
    highCuda: [120, 240],
  },
} as const;
/** Share of the time spent aligning (the rest is products). */
const ALIGN_SHARE: Record<PhotoPreset, number> = { fast: 0.5, standard: 0.25, high: 0.2 };
/** Intermediates against the photos' own size (plan: 10 to 20 times at Standard). */
const DISK_FACTOR: Record<PhotoPreset, number> = { fast: 3, standard: 15, high: 25 };
/** Working memory of the heaviest stage for 20 MP photos, before the per-photo part. */
const MEMORY_BASE: Record<PhotoPreset, number> = { fast: 3 * GB, standard: 8 * GB, high: 14 * GB };
/** Products besides the dense core (cloud, DSM, DTM, ortho): their share of the products time. */
const EXTRA_SHARE: Partial<Record<PhotoProduct, number>> = { mesh: 0.2, tiles: 0.08 };

const round = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);
const gb = (b: number) => `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB`;

/**
 * Time, disk and memory a run would need on this computer (`photo:estimate`). A range, because
 * scene content and thermal throttling make one number dishonest; notes in plain words.
 */
export function estimateRun(
  photos: PhotoSet,
  preset: PhotoPreset,
  products: readonly PhotoProduct[],
  hw: Pick<HardwareProbe, 'cpu' | 'memoryBytes' | 'freeDiskBytes' | 'cuda'>,
): PhotoEstimate {
  const notes: string[] = [];
  const count = Math.max(0, photos.count);
  const mp = photos.megapixels > 0 ? photos.megapixels : 20;
  const cuda = preset === 'high' && hw.cuda;
  const [lo, hi] = cuda ? REF.minutes.highCuda : REF.minutes[preset];
  // time grows with the pixels to match and a little faster than linear with the photo count
  const scale = ((count * mp) / REF.pixels) * Math.pow(Math.max(count, 1) / 500, 0.15);
  // parallel stages scale with the cores, not perfectly
  const cores = Math.pow(REF.cores / Math.max(1, hw.cpu.cores), 0.8);
  const align = ALIGN_SHARE[preset];
  const extra = products.reduce((s, p) => s + (EXTRA_SHARE[p] ?? 0), 0);
  const productShare = products.length ? (1 - align) * (1 + extra) : 0;
  const share = align + productShare;
  const minutes: [number, number] =
    count === 0
      ? [0, 0]
      : [round(lo * scale * cores * share, 1), round(hi * scale * cores * share, 1)];

  const photoBytes = photos.bytes > 0 ? photos.bytes : count * mp * 0.4 * MB;
  const diskBytes = Math.round(photoBytes * DISK_FACTOR[preset] * (products.length ? 1 : 0.3));
  let memoryBytes = Math.round(MEMORY_BASE[preset] * (mp / 20) + count * 2 * MB);
  const ram = hw.memoryBytes;
  // the plan's laptop rule: Standard and High on 16 GB work at half size, in clusters
  const tight = ram > 0 && (memoryBytes > ram * 0.75 || (preset !== 'fast' && ram < 20 * GB));
  if (tight) {
    memoryBytes = Math.min(memoryBytes, Math.round(ram * 0.75));
    notes.push(
      preset === 'fast'
        ? `On ${gb(ram)} the photos are matched at a smaller size to stay within memory.`
        : `${preset === 'high' ? 'High' : 'Standard'} on ${gb(ram)}: images at half size and dense matching in clusters of about 40 photos, so it stays within memory.`,
    );
  }
  if (count === 0) notes.push('No photos found. Choose a folder of JPEG or TIFF photos.');
  if (hw.freeDiskBytes > 0 && diskBytes > hw.freeDiskBytes)
    notes.push(
      `Needs ${gb(diskBytes)} free on the data drive, has ${gb(hw.freeDiskBytes)}. Free some space or choose a smaller preset.`,
    );
  if (preset === 'high' && !cuda)
    notes.push('High runs on the CPU here: expect a long run. Standard suits most surveys.');
  if (photos.noGps > 0)
    notes.push(
      `${String(photos.noGps)} ${photos.noGps === 1 ? 'photo has' : 'photos have'} no GPS position; they are placed by matching only.`,
    );
  for (const g of photos.groups.slice(0, 8))
    notes.push(
      `Camera group: ${g.label}${g.widthPx && g.heightPx ? `, ${String(g.widthPx)} × ${String(g.heightPx)}` : ''} (${photos.sampled ? 'about ' : ''}${String(g.photos)} ${g.photos === 1 ? 'photo' : 'photos'}).`,
    );
  if (photos.groups.length > 1)
    notes.push(
      'Mixed cameras: each camera is calibrated on its own, which needs more overlap per camera.',
    );
  notes.push('Times are a range: scene content and a warm laptop can make a run slower.');
  return { minutes, diskBytes, memoryBytes, notes: notes.slice(0, 20) };
}

/** Photo files the pipelines read (JPEG and TIFF); DNG and video are not processed. */
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.tif', '.tiff']);
const MAX_FILES = 100_000;
const MAX_DEPTH = 4;
/** Photos read for the estimate (the head of each); more are extrapolated from this sample. */
const SAMPLE = 300;

/** Every photo under the folders (a few levels deep, hidden folders skipped), sorted. */
export async function listPhotoFiles(folders: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < MAX_DEPTH) await walk(p, depth + 1);
      else if (e.isFile() && PHOTO_EXT.has(extname(e.name).toLowerCase())) out.push(p);
      if (out.length >= MAX_FILES) return;
    }
  };
  for (const f of folders) await walk(f, 0);
  return out;
}

async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(b, 0, bytes, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

/** Read the photos' heads (a sample of at most 300) into what the estimate needs. */
export async function readPhotoSet(files: readonly string[]): Promise<PhotoSet> {
  const { readPhotoMeta } = await lib();
  const step = Math.max(1, files.length / SAMPLE);
  const sample: string[] = [];
  for (let i = 0; i < files.length && sample.length < SAMPLE; i += step) {
    const f = files[Math.floor(i)];
    if (f) sample.push(f);
  }
  const groups = new Map<string, PhotoSet['groups'][number]>();
  const mps: number[] = [];
  let bytes = 0;
  let noGps = 0;
  let lat = 0;
  let lon = 0;
  let withGps = 0;
  for (const f of sample) {
    try {
      bytes += (await stat(f)).size;
    } catch {
      continue;
    }
    let meta: ReturnType<typeof readPhotoMeta> = {};
    if (/\.jpe?g$/i.test(f)) {
      try {
        meta = readPhotoMeta(await readHead(f, 512 * 1024));
      } catch {
        meta = {};
      }
    }
    const camera = [meta.make, meta.model].filter(Boolean).join(' ').trim() || 'Unknown camera';
    const key = `${camera}|${String(meta.width ?? '')}x${String(meta.height ?? '')}`;
    const g = groups.get(key) ?? {
      label: camera,
      ...(meta.width ? { widthPx: meta.width } : {}),
      ...(meta.height ? { heightPx: meta.height } : {}),
      photos: 0,
    };
    g.photos += 1;
    groups.set(key, g);
    if (meta.width && meta.height) mps.push((meta.width * meta.height) / 1e6);
    const gps = meta.gps ?? (meta.dji?.lat !== undefined ? meta.dji : undefined);
    if (gps?.lat !== undefined && gps.lon !== undefined) {
      lat += gps.lat;
      lon += gps.lon;
      withGps++;
    } else noGps++;
  }
  const factor = sample.length ? files.length / sample.length : 0;
  const sampled = sample.length < files.length;
  return {
    count: files.length,
    megapixels: median(mps) || 20,
    bytes: Math.round(bytes * factor),
    groups: [...groups.values()]
      .map((g) => ({ ...g, photos: sampled ? Math.round(g.photos * factor) : g.photos }))
      .sort((a, b) => b.photos - a.photos),
    sampled,
    ...(withGps ? { centre: { lat: lat / withGps, lon: lon / withGps } } : {}),
    noGps: sampled ? Math.round(noGps * factor) : noGps,
  };
}

/** The UTM zone (WGS84) of a position, as an EPSG code. */
export function utmEpsg(lat: number, lon: number): number {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return (lat >= 0 ? 32600 : 32700) + zone;
}

// ---------------------------------------------------------------- runs

/** The products a run made or was asked for, in the contract's order. */
const PRODUCT_ORDER: readonly PhotoProduct[] = ['cloud', 'dsm', 'dtm', 'ortho', 'mesh', 'tiles'];
const STAGE_PRODUCT: Partial<Record<string, PhotoProduct>> = {
  cloud: 'cloud',
  dsm: 'dsm',
  dtm: 'dtm',
  ortho: 'ortho',
  mesh: 'mesh',
  tiles: 'tiles',
};

/** A run's line in the runs list. */
export function summariseRun(run: PhotoRun): PhotoRunSummary {
  const asked = (run.settings as { products?: unknown } | undefined)?.products;
  const products = new Set<PhotoProduct>();
  if (Array.isArray(asked))
    for (const p of asked)
      if (PRODUCT_ORDER.includes(p as PhotoProduct)) products.add(p as PhotoProduct);
  for (const s of run.stages) {
    const p = STAGE_PRODUCT[s.name];
    if (p && s.state === 'done') products.add(p);
  }
  return {
    id: run.id,
    createdAt: run.createdAt,
    status: run.status,
    preset: run.preset,
    photos: run.photos.count,
    products: PRODUCT_ORDER.filter((p) => products.has(p)),
    ...(run.accuracy ? { accuracy: run.accuracy } : {}),
  };
}

const parseJsonText = (text: string): unknown =>
  JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;

/** The first problem of a zod result, with the file it came from. */
function problem(rel: string, e: z.ZodError): string {
  const i = e.issues[0];
  return `${rel}: ${i ? `${i.path.join('.') || 'file'}: ${i.message}` : 'not valid'}`;
}

// ---------------------------------------------------------------- refined poses

/** The run's refined cameras (`aio.photo-cameras/1`, written by `photo.align` and `photo.georef`). */
export const REFINED_FILE = PHOTO_RUN_FILES.camerasSfm;
/** The poses a photos layer had before **Use refined poses**, in the run folder. */
export const POSES_BACKUP = 'cameras.json.bak';

/** A refined pose for one photo of the layer, in the project's local frame. */
export interface RefinedPose {
  pos: Vec3;
  q: Quat;
  lens?: LensModel;
}

export interface PoseMoves {
  cameras: number;
  medianMoveM: number;
  maxMoveM: number;
}

/** How far each camera of the layer moves to its refined position. */
export function poseMoves(
  items: readonly { id: string; pos?: readonly number[] | undefined }[],
  refined: ReadonlyMap<string, { pos: readonly number[] }>,
): PoseMoves {
  const moves: number[] = [];
  for (const it of items) {
    const r = refined.get(it.id);
    if (!r || !it.pos) continue;
    const [x = 0, y = 0, z = 0] = it.pos;
    const [a = 0, b = 0, c = 0] = r.pos;
    moves.push(Math.hypot(a - x, b - y, c - z));
  }
  return {
    cameras: moves.length,
    medianMoveM: median(moves),
    maxMoveM: moves.length ? Math.max(...moves) : 0,
  };
}

/**
 * Parse `cameras-sfm.json`. G2's first files carry no `schema` key (the format was registered at
 * the integration); such a file is read as `aio.photo-cameras/1`, any other schema is refused.
 */
export function parseCamerasFile(raw: unknown): PhotoCamerasFile | string {
  const withSchema =
    raw && typeof raw === 'object' && !Array.isArray(raw) && !('schema' in raw)
      ? { schema: 'aio.photo-cameras/1', ...raw }
      : raw;
  const r = PhotoCamerasFile.safeParse(withSchema);
  return r.success ? r.data : problem(REFINED_FILE, r.error);
}

const fileName = (p: string) => (p.split(/[\\/]/).pop() ?? p).toLowerCase();
const stem = (p: string) => fileName(p).replace(/\.[^.]*$/, '');

/**
 * Which photo of the layer each refined camera is. `photo.align` keys a photo by the layer's photo
 * id for a layer run, and by its path below the chosen folder (`DJI_0001.JPG`, or
 * `100MEDIA/DJI_0001.JPG` with several folders) for a folder run; a folder run's cameras land on
 * the layer's photos with the same file name (or the same name without extension), when that
 * name is unique on both sides.
 */
export function matchCameras(
  keys: readonly string[],
  items: readonly { id: string; src: { path: string } | { hash: string } }[],
): Map<string, string> {
  const ids = new Set(items.map((it) => it.id));
  const index = (name: (it: (typeof items)[number]) => string | null) => {
    const m = new Map<string, string | null>();
    for (const it of items) {
      const n = name(it);
      if (n) m.set(n, m.has(n) ? null : it.id);
    }
    return m;
  };
  const byName = index((it) => ('path' in it.src ? fileName(it.src.path) : null));
  const byStem = index((it) => ('path' in it.src ? stem(it.src.path) : stem(it.id)));
  const count = (f: (k: string) => string) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(f(k), (m.get(f(k)) ?? 0) + 1);
    return m;
  };
  const keyNames = count(fileName);
  const keyStems = count(stem);
  const out = new Map<string, string>();
  for (const k of keys) {
    const id = ids.has(k)
      ? k
      : ((keyNames.get(fileName(k)) === 1 ? byName.get(fileName(k)) : null) ??
        (keyStems.get(stem(k)) === 1 ? byStem.get(stem(k)) : null));
    if (id) out.set(k, id);
  }
  return out;
}

const sameCrs = (a: ProjectManifest['crs'], b: ProjectManifest['crs']) =>
  'epsg' in a && 'epsg' in b ? a.epsg === b.epsg : JSON.stringify(a) === JSON.stringify(b);

/**
 * The refined pose of each photo of the layer (by photo id), in the project's local frame: the
 * file's frame is measured from its own `origin`, so a project whose origin moved since gets the
 * difference added (x east, y up, z south).
 */
export function refinedPoses(
  file: PhotoCamerasFile,
  manifest: Pick<ProjectManifest, 'crs' | 'origin'>,
  items: readonly { id: string; src: { path: string } | { hash: string } }[],
): Map<string, RefinedPose> | string {
  if (!sameCrs(file.crs, manifest.crs)) {
    const name = (c: ProjectManifest['crs']) => ('epsg' in c ? `EPSG:${String(c.epsg)}` : 'WKT');
    return `The run's cameras are in ${name(file.crs)}, the project in ${name(manifest.crs)}. Align the photos again in the project's CRS.`;
  }
  const [de, dn, dh] = [
    file.origin[0] - manifest.origin[0],
    file.origin[1] - manifest.origin[1],
    file.origin[2] - manifest.origin[2],
  ];
  const match = matchCameras(
    file.cameras.map((c) => c.photo),
    items,
  );
  const out = new Map<string, RefinedPose>();
  for (const c of file.cameras) {
    const id = match.get(c.photo);
    if (!id) continue;
    const lens = LensModel.safeParse({
      model: c.lens.model,
      hfovDeg: c.lens.hfovDeg,
      aspect: c.lens.aspect,
    });
    out.set(id, {
      pos: [c.pos[0] + de, c.pos[1] + dh, c.pos[2] - dn],
      q: [c.q[0], c.q[1], c.q[2], c.q[3]],
      ...(lens.success ? { lens: lens.data } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- disk

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let list;
  try {
    list = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of list) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p);
    else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** A run folder of a folder project (the id is already file-name safe, `PhotoRunId`). */
const runPath = (root: string, run: string, rel = '') =>
  join(root, ...photoRunDir(run).split('/'), ...rel.split('/').filter(Boolean));

/** Run files of a folder or a package: the text of one, and the run folder names. */
function runSource(projects: PhotoProjects | undefined, projectId: string) {
  if (!projects) return null;
  const pkg = projects.package(projectId);
  if (pkg) {
    return {
      readOnly: true as const,
      manifest: () => Promise.resolve(pkg.manifest),
      runs: () => {
        const ids = new Set<string>();
        for (const n of pkg.archive.entries.keys()) {
          const m = /^photogrammetry\/([^/]+)\/run\.json$/.exec(n);
          if (m?.[1]) ids.add(m[1]);
        }
        return Promise.resolve([...ids]);
      },
      read: async (rel: string) =>
        pkg.archive.entries.has(rel) ? (await pkg.archive.read(rel)).toString('utf8') : null,
    };
  }
  const root = projects.root(projectId);
  if (root === undefined) return null;
  return {
    readOnly: false as const,
    root,
    manifest: async () => (await lib()).readManifestFile(root),
    runs: async () => {
      try {
        const list = await readdir(join(root, 'photogrammetry'), { withFileTypes: true });
        return list.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    // remembered, so a save of gcp.json compares with what the person saw first
    read: async (rel: string) =>
      (await readBytesSeen(join(root, ...rel.split('/'))).catch(() => null))?.toString('utf8') ??
      null,
  };
}

async function readRunFile(
  src: NonNullable<ReturnType<typeof runSource>>,
  run: string,
): Promise<{ ok: true; run: PhotoRun } | { ok: false; error: string }> {
  const rel = `${photoRunDir(run)}/${PHOTO_RUN_FILES.run}`;
  const text = await src.read(rel);
  if (text === null) return { ok: false, error: `There is no run "${run}" in this project.` };
  let json: unknown;
  try {
    json = parseJsonText(text);
  } catch {
    return { ok: false, error: `${rel} is not valid JSON.` };
  }
  const r = PhotoRun.safeParse(json);
  return r.success ? { ok: true, run: r.data } : { ok: false, error: problem(rel, r.error) };
}

/** Run states whose accuracy report is final (alignment, adjustment or products finished). */
const FINISHED: ReadonlySet<PhotoRun['status']> = new Set(['aligned', 'adjusted', 'done']);

/**
 * The project's latest finished run that has an accuracy report (the house report's `processing`
 * section and the `photo-report-pdf` export), or null.
 */
export async function latestAccuracyRun(
  projects: PhotoProjects | undefined,
  projectId: string,
): Promise<string | null> {
  const src = runSource(projects, projectId);
  if (!src) return null;
  const done: PhotoRun[] = [];
  for (const id of await src.runs()) {
    const r = await readRunFile(src, id).catch(() => null);
    if (r?.ok && FINISHED.has(r.run.status)) done.push(r.run);
  }
  done.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  for (const run of done) {
    const text = await src.read(`${photoRunDir(run.id)}/${PHOTO_RUN_FILES.accuracy}`);
    if (text === null) continue;
    try {
      if (AccuracyReport.safeParse(parseJsonText(text)).success) return run.id;
    } catch {
      // not JSON: the next run
    }
  }
  return null;
}

// ---------------------------------------------------------------- photos of a run

/** `photo:readPhoto` answers photos up to this size (a 100 MP TIFF is about 300 MB: refused). */
export const MAX_PHOTO_BYTES = 200 * MB;

const PHOTO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
} as const;
type PhotoMime = (typeof PHOTO_MIME)[keyof typeof PHOTO_MIME];

/** The photo's format from its first bytes; null when they are not JPEG, PNG or TIFF. */
export function sniffPhoto(head: Uint8Array): PhotoMime | null {
  const b = (i: number) => head[i] ?? -1;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (
    (b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2a && b(3) === 0) ||
    (b(0) === 0x4d && b(1) === 0x4d && b(2) === 0 && b(3) === 0x2a)
  )
    return 'image/tiff';
  return null;
}

/** G2's `sparse/photos.json` (`aio.photo-list/1`): the image root and each photo's name below it. */
const PhotoList = z.looseObject({
  imageRoot: z.string().min(1).max(4096),
  photos: z.record(z.string(), z.looseObject({ name: z.string().min(1).max(1024) })),
});

/** A relative path with no `..`, no drive, no leading slash and no NUL: else null. */
function safeRelative(p: string): string[] | null {
  if (!p || p.includes('\0') || /^[a-zA-Z]:/.test(p) || /^[\\/]/.test(p)) return null;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((s) => s === '..' || s === '.')) return null;
  return parts;
}

/** `path` with its symlinks resolved, when it is inside `root` (also resolved); else null. */
async function inside(root: string, path: string): Promise<string | null> {
  try {
    const [r, p] = await Promise.all([realpath(root), realpath(path)]);
    const rel = relative(r, p);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Where a photo of a run is on disk. The key is the photo's key in the run (`GcpMark.photo`):
 * the layer's photo id for a layer run, the path below the chosen folder for a folder run. It is
 * resolved through the run's `sparse/photos.json` when there is one, else from `run.json`'s
 * folders the way `photo.align` keys them; the result must be inside one of the folders the run
 * recorded (the project folder for a layer run), symlinks resolved.
 */
export async function resolveRunPhoto(
  root: string,
  run: PhotoRun,
  key: string,
  readText: (rel: string) => Promise<string | null>,
): Promise<string | null> {
  const parts = safeRelative(key);
  if (!parts) return null;
  const source = run.photos.source;
  if ('layer' in source) {
    const manifest = await (await lib()).readManifestFile(root).catch(() => null);
    const layer = manifest?.layers.find((l) => l.id === source.layer);
    const item = layer?.kind === 'photos' ? layer.items.find((it) => it.id === key) : undefined;
    if (!item) return null;
    const rel = 'path' in item.src ? item.src.path : `assets/sha256/${item.src.hash}`;
    const relParts = safeRelative(rel);
    return relParts ? inside(root, join(root, ...relParts)) : null;
  }
  const folders = source.folders.map((f) => (isAbsolute(f) ? f : resolve(root, f)));
  const candidates: string[] = [];
  const listText = await readText(`${photoRunDir(run.id)}/${PHOTO_RUN_FILES.sparse}photos.json`);
  if (listText !== null) {
    try {
      const list = PhotoList.safeParse(parseJsonText(listText));
      const name = list.success ? list.data.photos[key]?.name : undefined;
      const nameParts = name ? safeRelative(name) : null;
      if (list.success && nameParts) candidates.push(join(list.data.imageRoot, ...nameParts));
    } catch {
      // not JSON: from the folders below
    }
  }
  if (folders.length === 1 && folders[0]) candidates.push(join(folders[0], ...parts));
  else if (parts.length > 1) {
    // several folders: the key starts with the folder's name, or `<index>-<name>` for two alike
    const [head = '', ...rest] = parts;
    folders.forEach((f, i) => {
      const n = basename(f) || `folder${String(i)}`;
      if (head === n || head === `${String(i)}-${n}`) candidates.push(join(f, ...rest));
    });
  }
  for (const c of candidates)
    for (const f of folders) {
      const real = await inside(f, c);
      if (real) return real;
    }
  return null;
}

// ---------------------------------------------------------------- handlers

export function registerPhotogrammetryIpc({
  handle,
  projects,
  system,
  trash,
  now = () => new Date(),
}: PhotogrammetryIpcDeps): void {
  let probe: Promise<HardwareProbe> | null = null;
  /** The probe, read once per session; free disk is measured again on each call. */
  const currentProbe = async (): Promise<HardwareProbe | null> => {
    if (!system) return null;
    probe ??= readProbe(system);
    let p: HardwareProbe;
    try {
      p = await probe;
    } catch (e) {
      probe = null;
      throw e;
    }
    const free = await system.freeDiskBytes().catch(() => p.freeDiskBytes);
    return { ...p, freeDiskBytes: Math.max(0, Math.round(free)) };
  };

  handle('photo:probe', async () => {
    const p = await currentProbe();
    if (!p) return { ok: false, error: 'The hardware probe is not available in this build.' };
    return { ok: true, probe: p };
  });

  handle('photo:estimate', async ({ projectId, photos, preset, products }) => {
    const hw = await currentProbe();
    const files = await photoFiles(projectId, photos);
    if (!files.ok) return files;
    const set = await readPhotoSet(files.files);
    const estimate = estimateRun(
      set,
      preset,
      products,
      hw ?? { cpu: { model: '', cores: 8 }, memoryBytes: 0, freeDiskBytes: 0, cuda: false },
    );
    if (set.centre) {
      const epsg = utmEpsg(set.centre.lat, set.centre.lon);
      const zone = epsg % 100;
      const note = `The photos are in UTM zone ${String(zone)}${epsg < 32700 ? 'N' : 'S'} (EPSG:${String(epsg)}).`;
      estimate.notes = [note, ...(estimate.notes ?? [])].slice(0, 20);
    }
    return { ok: true, estimate };
  });

  /** The photo files of a source: a photos layer of the project, or folders read in place. */
  async function photoFiles(
    projectId: string | undefined,
    photos: PhotoSource,
  ): Promise<{ ok: true; files: string[] } | { ok: false; error: string; code?: 'read-only' }> {
    if ('folders' in photos) {
      const bad = photos.folders.find((f) => !isAbsolute(f));
      if (bad) return { ok: false, error: `Choose a whole folder path, not "${bad}".` };
      return { ok: true, files: await listPhotoFiles(photos.folders) };
    }
    if (projectId === undefined)
      return { ok: false, error: 'Open the project whose photos layer to process.' };
    if (!projects) return NO_PROJECTS;
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const manifest = await (await lib()).readManifestFile(root);
    const layer = manifest.layers.find((l) => l.id === photos.layer);
    if (layer?.kind !== 'photos')
      return { ok: false, error: `There is no photos layer "${photos.layer}" in this project.` };
    const files: string[] = [];
    for (const it of layer.items) {
      if (!('path' in it.src)) continue;
      const p = resolve(root, it.src.path);
      if (!relative(root, p).startsWith('..')) files.push(p);
    }
    return { ok: true, files };
  }

  handle('photo:runs', async ({ projectId }) => {
    const src = runSource(projects, projectId);
    if (!src) return projects ? notOpen(projectId) : NO_PROJECTS;
    const runs: PhotoRunSummary[] = [];
    for (const id of await src.runs()) {
      const r = await readRunFile(src, id);
      if (r.ok) runs.push(summariseRun(r.run));
      else console.warn(`photo:runs skipped ${r.error}`);
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { ok: true, runs };
  });

  handle('photo:readRun', async ({ projectId, run }) => {
    const src = runSource(projects, projectId);
    if (!src) return projects ? notOpen(projectId) : NO_PROJECTS;
    const r = await readRunFile(src, run);
    if (!r.ok) return r;
    const rel = `${photoRunDir(run)}/${PHOTO_RUN_FILES.accuracy}`;
    const text = await src.read(rel);
    let accuracy: AccuracyReport | null = null;
    if (text !== null) {
      try {
        const a = AccuracyReport.safeParse(parseJsonText(text));
        if (a.success) accuracy = a.data;
        else return { ok: false, error: problem(rel, a.error) };
      } catch {
        return { ok: false, error: `${rel} is not valid JSON.` };
      }
    }
    return { ok: true, run: r.run, accuracy };
  });

  handle('photo:readGcp', async ({ projectId, run }) => {
    const src = runSource(projects, projectId);
    if (!src) return projects ? notOpen(projectId) : NO_PROJECTS;
    const rel = `${photoRunDir(run)}/${PHOTO_RUN_FILES.gcp}`;
    const text = await src.read(rel);
    if (text === null) return { ok: true, gcp: null };
    let json: unknown;
    try {
      json = parseJsonText(text);
    } catch {
      return { ok: false, error: `${rel} is not valid JSON. Restore it from ${rel}.bak.` };
    }
    const r = GcpFile.safeParse(json);
    return r.success ? { ok: true, gcp: r.data } : { ok: false, error: problem(rel, r.error) };
  });

  handle('photo:writeGcp', async ({ projectId, run, gcp }) => {
    if (!projects) return NO_PROJECTS;
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    if (!(await exists(runPath(root, run))))
      return { ok: false, error: `There is no run "${run}" in this project.` };
    try {
      await writeJsonSeen(runPath(root, run, PHOTO_RUN_FILES.gcp), gcp, {
        backup: true,
        name: `${photoRunDir(run)}/${PHOTO_RUN_FILES.gcp}`,
      });
    } catch (e) {
      if (isChangedOnDisk(e)) return { ok: false, error: e.message };
      throw e;
    }
    return { ok: true };
  });

  handle('photo:applyPoses', async ({ projectId, run, layer, apply }) => {
    if (!projects) return NO_PROJECTS;
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const refinedRel = `${photoRunDir(run)}/${REFINED_FILE}`;
    let raw: unknown;
    try {
      raw = parseJsonText(await readFile(runPath(root, run, REFINED_FILE), 'utf8'));
    } catch {
      return {
        ok: false,
        error: `This run has no refined cameras yet (${refinedRel}). Align the photos first.`,
      };
    }
    const file = parseCamerasFile(raw);
    if (typeof file === 'string') return { ok: false, error: file };
    const { readManifestFile, writeManifestFile } = await lib();
    const manifest = await readManifestFile(root);
    const target = manifest.layers.find((l): l is PhotosLayer => l.id === layer);
    if (target?.kind !== 'photos')
      return { ok: false, error: `There is no photos layer "${layer}" in this project.` };
    const refined = refinedPoses(file, manifest, target.items);
    if (typeof refined === 'string') return { ok: false, error: refined };
    const moves = poseMoves(target.items, refined);
    if (moves.cameras === 0)
      return {
        ok: false,
        error: `None of the run's refined cameras belongs to the layer "${target.name}".`,
      };
    if (!apply) return { ok: true, ...moves, applied: false };

    // the poses before, kept in the run folder so the swap can be undone by hand
    await writeJsonAtomic(
      runPath(root, run, POSES_BACKUP),
      {
        layer: target.id,
        savedAt: now().toISOString(),
        cameras: target.items.map((it) => ({
          id: it.id,
          ...(it.pos ? { pos: it.pos } : {}),
          ...(it.q ? { q: it.q } : {}),
          ...(it.lens ? { lens: it.lens } : {}),
        })),
      },
      { backup: true },
    );
    const items = target.items.map((it) => {
      const r = refined.get(it.id);
      return r ? { ...it, pos: r.pos, q: r.q, ...(r.lens ? { lens: r.lens } : {}) } : it;
    });
    const next: ProjectManifest = {
      ...manifest,
      layers: manifest.layers.map((l) => (l.id === target.id ? { ...target, items } : l)),
    };
    await writeManifestFile(root, next);
    return { ok: true, ...moves, applied: true };
  });

  handle('photo:cleanWork', async ({ projectId, run }) => {
    if (!projects) return NO_PROJECTS;
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    if (!(await exists(runPath(root, run))))
      return { ok: false, error: `There is no run "${run}" in this project.` };
    const work = runPath(root, run, PHOTO_RUN_FILES.work);
    if (!(await exists(work))) return { ok: true, freedBytes: 0 };
    if (!trash) return { ok: false, error: 'The recycle bin is not available in this build.' };
    const freedBytes = await folderBytes(work);
    try {
      await trash(work);
    } catch (e) {
      return {
        ok: false,
        error: `The work files could not be moved to the recycle bin: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { ok: true, freedBytes };
  });

  /**
   * One photo of a run, read only, for the GCP marker when the run's photos are folders outside
   * the project (a layer run's photos are shown from the project through `aio://`).
   */
  handle('photo:readPhoto', async ({ projectId, run, photo }) => {
    if (!projects) return NO_PROJECTS;
    if (projects.package(projectId))
      return { ok: false, error: 'The photos of a package are shown from its photos layer.' };
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const src = runSource(projects, projectId);
    if (!src) return notOpen(projectId);
    const r = await readRunFile(src, run);
    if (!r.ok) return r;
    const refused = { ok: false as const, error: `The photo "${photo}" is not one of this run's.` };
    const path = await resolveRunPhoto(root, r.run, photo, src.read);
    if (!path || !(extname(path).toLowerCase() in PHOTO_MIME)) return refused;
    let size: number;
    try {
      const s = await stat(path);
      if (!s.isFile()) return refused;
      size = s.size;
    } catch {
      return { ok: false, error: `The photo "${photo}" cannot be found. Was its folder moved?` };
    }
    if (size > MAX_PHOTO_BYTES)
      return {
        ok: false,
        error: `The photo "${photo}" is larger than ${String(MAX_PHOTO_BYTES / MB)} MB.`,
      };
    const mime = sniffPhoto(await readHead(path, 8));
    if (!mime) return { ok: false, error: `The photo "${photo}" is not a JPEG, PNG or TIFF.` };
    const data = await readFile(path);
    return { ok: true, mime, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  });
}
