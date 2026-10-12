import {
  defaultUtcOffsetMin,
  fromWgs84,
  isKnownCrs,
  toWgs84,
  type HeightRule,
  type HeightSource,
} from '@aio/geo';
import type {
  AltitudeChoice,
  AltitudePlan,
  FlightHeights,
  ImportHeights,
  ImportItem,
  LensModel,
  PhotoRef,
  ProjectManifest,
  Vec3,
} from '@aio/schema';
import { open, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { encodePng } from '../import/png';
import {
  altitudePlan,
  heightNote,
  importHeights,
  resolveHeights,
  type FileAltitudes,
} from './altitude';
import { captureForDate, slug, uniqueId, readManifestFile, updateManifestFile } from './create';
import {
  dxfSource,
  importDrawingFile,
  isDrawingFile,
  type ClaimedStems,
  type DrawingImages,
} from './drawings';
import { readPhotoMeta } from './exif';
import { mergeImport } from './importMerge';
import { modelTextures } from './modelTextures';
import { readTiffHeaderFile } from './tiffFile';
import { objToGlb } from './obj';
import { photoAltitude, photoHeight, photoRef } from './photos';
import {
  decodeTiff,
  epsgFromPrj,
  parseWorldFile,
  rasterToRgba,
  tiffCorners,
  tiffGeoreferenced,
} from './tiff';
import { CANCELLED_BEFORE, importWalk, type WalkTools } from './walks';
import { NO_WALK_FILES, markWalkLayer, missingWalkLayers, walkLayerOf } from './walkLayers';
import { isWalkFile, proxyOwner } from './walkSource';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-03-03` as the app writes a day: `3 Mar 2026` (the same as the workspace's date tags). */
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-');
  return `${String(Number(d))} ${MONTHS[Number(m) - 1] ?? ''} ${y ?? ''}`;
}

/** Review copies of photos. The app uses Electron's image codec; tools may use ffmpeg. */
export interface ImageOps extends DrawingImages {
  /** Write `dst` as a JPEG no larger than `maxPx` on its long side. */
  resizeJpeg(src: string, dst: string, maxPx: number): Promise<void>;
}

/**
 * The pipeline pack (stream B1): heavy conversions run there as jobs over `jobs:start`. Until it
 * is installed, `available()` is false and those files report `needs-pipeline`.
 */
export interface PipelineJobs {
  available(): Promise<boolean>;
  start(method: string, params: Record<string, unknown>): Promise<{ jobId: string }>;
}

export const NO_PIPELINE: PipelineJobs = {
  available: () => Promise.resolve(false),
  start: () => Promise.reject(new Error('The processing tools are not installed.')),
};

/** Video probing and SRT conversion (from `@aio/video/telemetry`, injected by the app). */
export interface VideoTools {
  probe(file: string): Promise<{
    width: number;
    height: number;
    codec: string;
    durationMs: number;
    frameTimesMs: number[];
  }>;
  flightFromSrt(
    srt: string,
    o: {
      epsg: number;
      origin: Vec3;
      utcOffsetMin: number;
      aspect: number;
      name: string;
      frameTimesMs: number[];
      /** Height rule (data-conventions section 3a). */
      heights: HeightRule;
    },
  ): {
    doc: { startUtcMs: number; lens: LensModel; samples: unknown[]; heights: FlightHeights };
    warnings: string[];
    timing: { withinOneFrame: boolean; maxErrorMs: number; frameMs: number };
    orientation: 'gimbal' | 'estimated';
    heightSource: HeightSource | 'mixed';
  };
  /** Altitudes and positions of every SRT frame (and the home point when logged), for the plan. */
  srtAltitudes(srt: string): FileAltitudes;
}

export interface ImportDeps {
  images: ImageOps;
  jobs: PipelineJobs;
  video?: VideoTools;
  /** JPEG poster of a video frame (ffmpeg); optional. */
  poster?: (video: string, atS: number, out: string) => Promise<void>;
  /**
   * Review proxy of a recording (`makeProxy`: 1920 px H.264 MP4, a keyframe every second). When
   * given, clips are proxied instead of copied, so the project stays small and codecs Chromium
   * cannot play (ProRes) need no pipeline pack. Writes `out` only when it succeeds.
   */
  proxy?: (src: string, out: string) => Promise<void>;
  /** Clock offset of the cameras from UTC in minutes; default from the project longitude. */
  utcOffsetMin?: number;
  /** How camera heights are made (data-conventions section 3a); default `auto`. */
  altitude?: AltitudeChoice;
  /**
   * Add drawing: every picture becomes a drawing (a JPEG is not a photo, a georeferenced TIFF not
   * an ortho). Without it PDF, PNG, WebP, SVG and TIFF without a georeference do.
   */
  drawings?: boolean;
  onProgress?: (done: number, total: number, file: string) => void;
  /**
   * 360 video (`walks.ts`): reading and stitching a 360 camera's own files. Without it they
   * report that this build cannot import them.
   */
  walk?: WalkTools;
  /** "Add 360 video": MP4 and MOV files are taken as stitched 360 video, not as drone clips. */
  as360?: boolean;
  /** Progress inside one long file (a 360 stitch), 0 to 1. */
  onFileProgress?: (file: string, fraction: number) => void;
  /**
   * Cancel for the import as a whole: once aborted, a running 360 stitch is stopped and removed,
   * files whose turn had not come are reported as skipped, and what was already imported is
   * saved as usual. A file other than a 360 video that is in hand is finished first.
   */
  signal?: AbortSignal;
}

export interface ImportResult {
  manifest: ProjectManifest;
  items: ImportItem[];
  backup: string;
  /** The height rule applied, when any file got a camera height. */
  heights?: ImportHeights;
  /**
   * The survey dates this import added to the saved project (0 or 1 id): not a date another save
   * added meanwhile, nor one the day already had.
   */
  createdCaptures: string[];
}

const PHOTO = new Set(['.jpg', '.jpeg']);
const VIDEO = new Set(['.mp4', '.mov']);
const MESH = new Set(['.glb', '.obj']);
const RASTER = new Set(['.tif', '.tiff']);
const CLOUD = new Set(['.las', '.laz', '.e57', '.ply']);
/** DXF plot plans (M8): imported by the `drawing.import` pipeline into `drawings/`. */
const DRAWING = new Set(['.dxf']);
/** Designs (M11 G6): LandXML (`.xml` only when it is LandXML) and 12da, by `design.import`. */
const DESIGN = new Set(['.landxml', '.12da']);
/** OPF projects (M10): imported by the `opf.import` pipeline (photos, cloud, ortho, DSM). */
const OPF = new Set(['.opf']);
/** Also read or reported by the builder: telemetry, material files, LandXML, DWG, 360 camera files. */
const EXTRA = new Set(['.srt', '.mtl', '.xml', '.dwg', '.insv', '.lrv']);
/** Codecs Chromium plays (sample entry fourcc). */
const PLAYABLE = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01']);
/**
 * GeoTIFFs above either limit (and every BigTIFF) are refused: no pipeline tiles a large raster
 * yet. Below them the file is decoded in memory and drawn as one image.
 */
const RASTER_BYTES = 300 * 1024 * 1024;
const RASTER_PIXELS = 12_000 * 12_000;
const RASTER_TOO_LARGE =
  'This GeoTIFF is too large to import yet (over 300 MB, over 12,000 x 12,000 pixels, or a BigTIFF). Reduce or split it in other software, then import the parts.';
const REVIEW_PX = 2560;
const THUMB_PX = 480;

const PIPELINE_MISSING =
  'Needs the processing tools to convert. Install them in Settings, Processing tools, then import this file again.';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = new Uint8Array(bytes);
    const r = await fh.read(b, 0, bytes, 0);
    return b.subarray(0, r.bytesRead);
  } finally {
    await fh.close();
  }
}

/** A sibling file with another extension, any case (DJI writes .SRT next to .MP4). */
async function sibling(
  file: string,
  ext: string,
  given: readonly string[],
): Promise<string | null> {
  const stem = file.slice(0, -extname(file).length);
  const inList = given.find(
    (g) =>
      g.slice(0, -extname(g).length).toLowerCase() === stem.toLowerCase() &&
      extname(g).toLowerCase() === ext,
  );
  if (inList) return inList;
  for (const e of [ext, ext.toUpperCase()]) if (await exists(stem + e)) return stem + e;
  return null;
}

/** Project frame: local (x east, y up, z south) from project CRS (E, N, H). */
const toLocal = (m: ProjectManifest, p: Vec3): Vec3 => [
  p[0] - m.origin[0],
  p[2] - m.origin[2],
  0 - (p[1] - m.origin[1]),
];

function epsgOf(m: ProjectManifest): number {
  if (!('epsg' in m.crs)) throw new Error('Raw import needs a project CRS given as an EPSG code.');
  return m.crs.epsg;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The survey day of an import: the most frequent of the days its files carry, a tie to the
 * earlier day; null when no file carries one.
 */
export function importDay(days: readonly string[]): string | null {
  const count = new Map<string, number>();
  for (const d of days) count.set(d, (count.get(d) ?? 0) + 1);
  let best: string | null = null;
  for (const [d, n] of count) {
    const top = best === null ? 0 : (count.get(best) ?? 0);
    if (best === null || n > top || (n === top && d < best)) best = d;
  }
  return best;
}

/** Whether the builder takes a file of this extension (lower case, with the dot). */
export function isImportableExtension(ext: string): boolean {
  return (
    PHOTO.has(ext) ||
    VIDEO.has(ext) ||
    MESH.has(ext) ||
    RASTER.has(ext) ||
    CLOUD.has(ext) ||
    DRAWING.has(ext) ||
    DESIGN.has(ext) ||
    OPF.has(ext) ||
    EXTRA.has(ext) ||
    isDrawingFile(ext, false)
  );
}

const layerIdTaken = (m: ProjectManifest) => (id: string) => m.layers.some((l) => l.id === id);

/**
 * Import raw files into a project package: photos (EXIF GPS, DJI gimbal, review copies), video
 * with its DJI SRT (to `aio.flight/1`), GLB and OBJ models, small GeoTIFF orthos and DSMs (a
 * larger one is refused with a message); point clouds, drawings and designs become
 * pipeline-pack jobs. The manifest is validated, backed up and
 * replaced once at the end. Each file reports its own outcome; one bad file never stops the rest.
 *
 * The manifest is read at the start and the import works on its own copy, so nothing waits behind
 * minutes of copying. At the end, in one turn among the saves of the project
 * (`updateManifestFile`), the manifest is read again and only what this import added is put onto
 * it (`mergeImport`: its new layers and survey dates, its photos onto the Photos layer as it is
 * by then, a datum picked at the import). What was saved meanwhile stays: a survey date renamed,
 * a dataset moved to another date, the layer a conversion job filed when it ended first (the jobs
 * this import starts are not waited for). The manifest handed back is the one saved; when nothing
 * was filed, nothing is saved and it is the project as it is by then (as it was at the start
 * when it cannot be read at that moment: an import that saves nothing does not fail for it).
 *
 * What is left (docs/KNOWN-LIMITS.md, Builder): the processing tools write the manifest from
 * their own process and take no turn, so a job that is filing its results when this save is made
 * can replace it, or be replaced. For an OPF project and for maps from photos the filing takes
 * as long as their files take to move, and the job's write then replaces all this import added.
 */
export async function importRawFiles(
  root: string,
  paths: readonly string[],
  deps: ImportDeps,
): Promise<ImportResult> {
  // the manifest as it was read, left untouched: what `m` holds beyond it is what this import added
  const atStart = await readManifestFile(root);
  const m = structuredClone(atStart);
  const epsg = epsgOf(m);
  const utcOffsetMin = deps.utcOffsetMin ?? defaultUtcOffsetMin(m.origin, epsg);
  const heights = resolveHeights(m, deps.altitude);
  // absolute altitude is corrected by a datum: the project's, or one set at this import
  const datumDefined = m.verticalDatum !== undefined || heights.summary.from === 'datum';
  /** The item's height note when it did not use the rule's own altitude. */
  const offRule = (source: ImportItem['heightSource']) =>
    source && source !== heights.summary.source
      ? [heightNote(source, heights.rule, datumDefined)]
      : [];
  const items: ImportItem[] = [];
  const consumed = new Set<string>();
  const pipeline = await deps.jobs.available().catch(() => false);
  // drawings: the folder names this import gives out, and the pictures its models use
  const drawingStems: ClaimedStems = new Set();
  const textures = await modelTextures(paths);
  const total = paths.length;
  let done = 0;
  const tick = (file: string) => {
    done++;
    deps.onProgress?.(done, total, file);
  };

  /** The days the files of this import carry, and the layers it pushes (filed under the day). */
  const days: string[] = [];
  const created = new Set<string>();
  const newPhotos: PhotoRef[] = [];
  const photoRows: ImportItem[] = [];
  const photoLayers = () => m.layers.flatMap((l) => (l.kind === 'photos' ? [l] : []));
  /** Import a drawing and remember the layers it made. */
  const drawingIn = async (file: string): Promise<ImportItem> => {
    const known = new Set(m.layers.map((l) => l.id));
    const item = await importDrawingFile(root, m, file, deps.images, drawingStems);
    for (const l of m.layers) if (!known.has(l.id)) created.add(l.id);
    return item;
  };
  const addDay = (day: string | undefined) => {
    if (day && DAY.test(day)) days.push(day);
  };

  const job = async (
    file: string,
    kind: ImportItem['kind'],
    method: string,
    params: Record<string, unknown>,
  ) => {
    const name = basename(file);
    if (!pipeline) {
      items.push({ file: name, kind, status: 'needs-pipeline', message: PIPELINE_MISSING });
      return;
    }
    try {
      const { jobId } = await deps.jobs.start(method, {
        projectRoot: root,
        src: file,
        epsg,
        origin: m.origin,
        ...params,
      });
      items.push({
        file: name,
        kind,
        status: 'queued',
        jobId,
        message: 'Converting with the processing tools.',
      });
    } catch (e) {
      items.push({
        file: name,
        kind,
        status: 'error',
        message: String(e instanceof Error ? e.message : e),
      });
    }
  };

  /** 360 video is kept in `walks/`, beside the manifest: these items never change it. */
  const walkItems = new Set<ImportItem>();
  /**
   * The 360 videos to stitch, each with its row in `items` (in the order the files were given).
   * A stitch takes minutes and saves nothing in the manifest, so it runs after the manifest save:
   * the photos and models of the same drop are in the project before the first stitch begins.
   */
  const stitches: { file: string; item: ImportItem }[] = [];
  /** File a 360 video's row; true when it is stitched later (its progress tick comes then). */
  const walk = (file: string): boolean => {
    const name = basename(file);
    const item: ImportItem = { file: name, kind: 'video', status: 'skipped' };
    walkItems.add(item);
    items.push(item);
    const clip = proxyOwner(
      name,
      paths.filter((p) => p !== file && dirname(p) === dirname(file)).map((p) => basename(p)),
    );
    if (clip) {
      item.message = `The camera's low resolution copy of ${clip}, which is imported in full.`;
      return false;
    }
    if (!deps.walk) {
      item.status = 'error';
      item.message = '360 video import is not available in this build.';
      return false;
    }
    stitches.push({ file, item });
    return true;
  };
  /** The backup of the last save that listed a walk as a layer; '' when none did. */
  let walkBackup = '';
  const stitchWalks = async (tools: WalkTools) => {
    for (const { file, item } of stitches) {
      const name = basename(file);
      try {
        const r = await importWalk(root, file, {
          tools,
          onProgress: (f) => deps.onFileProgress?.(name, f),
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
        item.status = r.ok ? 'imported' : r.status;
        item.message = r.message;
        if (r.ok) {
          // the walk becomes a layer at once, in its own turn (the stitch took minutes)
          try {
            const filed = await updateManifestFile(root, (fresh) => {
              const added = missingWalkLayers([r.walk], fresh, () => NO_WALK_FILES);
              return {
                manifest:
                  added.length > 0 ? { ...fresh, layers: [...fresh.layers, ...added] } : null,
                id: added[0]?.id ?? walkLayerOf(fresh.layers, r.walk.id)?.id,
              };
            });
            if (filed.id !== undefined) {
              item.layerId = filed.id;
              // a layer now: never added again by the open-time migration once removed
              await markWalkLayer(root, r.walk.id);
            }
            if (filed.backup) walkBackup = filed.backup;
          } catch (e) {
            item.message = `${r.message} It could not be listed as a layer now (${e instanceof Error ? e.message : String(e)}); it is added when the project is next opened.`;
          }
        }
      } catch (e) {
        item.status = 'error';
        item.message = e instanceof Error ? e.message : String(e);
      } finally {
        tick(name);
      }
    }
  };
  /** The manifest as it is by now, read in the project's turn; `fallback` when it cannot be read. */
  const manifestNow = (fallback: ProjectManifest) =>
    updateManifestFile(root, () => ({ manifest: null })).then(
      (r) => r.manifest,
      () => fallback,
    );

  for (const file of paths) {
    const name = basename(file);
    const ext = extname(file).toLowerCase();
    let later = false;
    try {
      if (consumed.has(file)) continue;
      const is360 = isWalkFile(name) || (deps.as360 === true && VIDEO.has(ext));
      if (deps.signal?.aborted) {
        // cancelled: this file's turn had not come
        const item: ImportItem = {
          file: name,
          kind: is360 ? 'video' : 'unknown',
          status: 'skipped',
          message: CANCELLED_BEFORE,
        };
        if (is360) walkItems.add(item);
        items.push(item);
      } else if (is360) {
        later = walk(file);
      } else if (isDrawingFile(ext, deps.drawings === true) && textures.has(file)) {
        // picked with its model: part of the model, not a sheet to look at
        items.push({
          file: name,
          kind: 'unknown',
          status: 'skipped',
          message: `A texture of the model ${textures.modelOf(file) ?? ''}, read with it. Not added as a drawing.`,
        });
      } else if (isDrawingFile(ext, deps.drawings === true)) {
        items.push(await drawingIn(file));
      } else if (PHOTO.has(ext)) {
        const meta = readPhotoMeta(await readHead(file, 512 * 1024));
        const id = uniqueId(
          slug(name.slice(0, -ext.length), 'photo'),
          (x) =>
            newPhotos.some((p) => p.id === x) ||
            photoLayers().some((l) => l.items.some((p) => p.id === x)),
        );
        const rel = `photos/${id}.jpg`;
        await mkdir(join(root, 'photos', 'thumbs'), { recursive: true });
        const long = Math.max(meta.width ?? 0, meta.height ?? 0);
        if (long > 0 && long <= REVIEW_PX) await copyFile(file, join(root, rel));
        else await deps.images.resizeJpeg(file, join(root, rel), REVIEW_PX);
        await deps.images.resizeJpeg(file, join(root, 'photos', 'thumbs', `${id}.jpg`), THUMB_PX);
        const frame = { epsg, origin: m.origin, utcOffsetMin, heights: heights.rule };
        const ref: PhotoRef = photoRef(id, rel, meta, frame);
        newPhotos.push(ref);
        addDay(meta.takenAt?.slice(0, 10));
        const heightSource = ref.pos ? photoHeight(meta, frame).source : undefined;
        const message = [
          ...(ref.pos
            ? ref.q
              ? []
              : ['Placed by GPS; no gimbal angles, so the view direction is unknown.']
            : ['No GPS position: listed in Media, not placed in the scene.']),
          ...offRule(heightSource),
        ].join(' ');
        const row: ImportItem = {
          file: name,
          kind: 'photo',
          status: 'imported',
          layerId: 'photos',
          ...(message ? { message } : {}),
          ...(heightSource ? { heightSource } : {}),
        };
        photoRows.push(row);
        items.push(row);
      } else if (VIDEO.has(ext)) {
        const srt = await sibling(file, '.srt', paths);
        if (srt) consumed.add(srt);
        if (!srt) {
          items.push({
            file: name,
            kind: 'video',
            status: 'skipped',
            message:
              'No DJI SRT telemetry with the same name next to the video; a clip needs it to be placed.',
          });
        } else if (!deps.video) {
          items.push({
            file: name,
            kind: 'video',
            status: 'error',
            message: 'Video import is not available in this build.',
          });
        } else {
          const info = await deps.video.probe(file);
          if (!PLAYABLE.has(info.codec) && !deps.proxy) {
            await job(file, 'video', 'video.transcode', { srt });
          } else {
            const base = slug(name.slice(0, -ext.length), 'clip');
            const id = uniqueId(`clip-${base}`, layerIdTaken(m));
            const fileId = id.slice(5);
            const aspect = info.width / info.height;
            const r = deps.video.flightFromSrt(await readFile(srt, 'utf8'), {
              epsg,
              origin: m.origin,
              utcOffsetMin,
              aspect,
              name: name.slice(0, -ext.length),
              frameTimesMs: info.frameTimesMs,
              heights: heights.rule,
            });
            await mkdir(join(root, 'video'), { recursive: true });
            await mkdir(join(root, 'flights'), { recursive: true });
            let vrel = `video/${fileId}${ext}`;
            let proxyNote: string | undefined;
            let proxied = false;
            if (deps.proxy) {
              try {
                await deps.proxy(file, join(root, `video/${fileId}.mp4`));
                vrel = `video/${fileId}.mp4`;
                proxied = true;
                proxyNote = 'Review copy at 1920 px (H.264); the original stays where it is.';
              } catch (e) {
                if (!PLAYABLE.has(info.codec)) throw e;
                proxyNote = `No review copy (${e instanceof Error ? e.message : String(e)}); the original was copied.`;
              }
            }
            if (!proxied) await copyFile(file, join(root, vrel));
            const frel = `flights/${fileId}.json`;
            await writeFile(
              join(root, frel),
              `${JSON.stringify({ schema: 'aio.flight/1', name: name.slice(0, -ext.length), ...r.doc })}\n`,
            );
            let poster: string | undefined;
            if (deps.poster) {
              try {
                await mkdir(join(root, 'posters'), { recursive: true });
                poster = `posters/${fileId}.jpg`;
                await deps.poster(
                  join(root, vrel),
                  Math.min(1, info.durationMs / 2000),
                  join(root, poster),
                );
              } catch {
                poster = undefined;
              }
            }
            const start = new Date(r.doc.startUtcMs + utcOffsetMin * 60_000).toISOString();
            m.layers.push({
              kind: 'video',
              id,
              name: `${name.slice(0, -ext.length)} · ${start.slice(11, 16)}`,
              visible: true,
              src: { path: vrel },
              flight: { src: { path: frel }, startUtcMs: r.doc.startUtcMs },
              lens: r.doc.lens,
              offsetMs: 0,
              ...(poster ? { poster: { path: poster } } : {}),
            });
            created.add(id);
            addDay(start.slice(0, 10));
            const timing = r.timing.withinOneFrame
              ? `SRT matches the video frames within ${r.timing.maxErrorMs.toFixed(1)} ms (one frame is ${r.timing.frameMs.toFixed(1)} ms).`
              : `SRT is off the video frames by up to ${r.timing.maxErrorMs.toFixed(0)} ms; check the time offset in Align.`;
            items.push({
              file: name,
              kind: 'video',
              status: 'imported',
              layerId: id,
              message: [
                timing,
                ...r.warnings,
                ...offRule(r.heightSource),
                ...(proxyNote ? [proxyNote] : []),
              ].join(' '),
              heightSource: r.heightSource,
            });
          }
        }
      } else if (ext === '.srt') {
        const video = paths.find(
          (p) =>
            VIDEO.has(extname(p).toLowerCase()) &&
            p.slice(0, -extname(p).length).toLowerCase() === file.slice(0, -4).toLowerCase(),
        );
        if (!video)
          items.push({
            file: name,
            kind: 'telemetry',
            status: 'skipped',
            message: 'Telemetry without its video; drop the MP4 and the SRT together.',
          });
      } else if (MESH.has(ext)) {
        const base = slug(name.slice(0, -ext.length), 'model');
        const id = uniqueId(`mesh-${base}`, layerIdTaken(m));
        const rel = `models/${id.slice(5)}.glb`;
        await mkdir(join(root, 'models'), { recursive: true });
        let message: string | undefined;
        if (ext === '.glb') {
          const head = await readHead(file, 4);
          if (new TextDecoder().decode(head) !== 'glTF') throw new Error('Not a GLB file.');
          await copyFile(file, join(root, rel));
        } else {
          const text = await readFile(file, 'utf8');
          const mtlName = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
          const dir = dirname(file);
          const mtlPath = mtlName ? join(dir, mtlName) : null;
          const mtl = mtlPath && (await exists(mtlPath)) ? await readFile(mtlPath, 'utf8') : null;
          const textures = new Map<string, Uint8Array | null>();
          if (mtl)
            for (const t of mtl.matchAll(/^\s*map_Kd\s+(?:.*\s)?(\S+)\s*$/gm)) {
              const n = t[1] ?? '';
              const p = join(dir, n);
              textures.set(n, (await exists(p)) ? new Uint8Array(await readFile(p)) : null);
            }
          const r = objToGlb(text, mtl, (n) => textures.get(n) ?? null);
          await writeFile(join(root, rel), r.glb);
          message = [`${String(r.triangles)} triangles converted to GLB.`, ...r.warnings].join(' ');
        }
        created.add(id);
        m.layers.push({
          kind: 'mesh',
          id,
          name: name.slice(0, -ext.length),
          visible: true,
          src: { path: rel },
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        });
        items.push({
          file: name,
          kind: 'mesh',
          status: 'imported',
          layerId: id,
          message: [message, 'Place it with Align, Georeference model.'].filter(Boolean).join(' '),
        });
      } else if (RASTER.has(ext)) {
        const size = (await stat(file)).size;
        // read where the file keeps its directory: at the start, or after the image data
        const head = await readTiffHeaderFile(file);
        const role = head.samples === 1 && head.bits >= 16 ? 'dsm' : 'ortho';
        if (head.bigTiff || size > RASTER_BYTES || head.width * head.height > RASTER_PIXELS) {
          items.push({ file: name, kind: 'raster', status: 'error', message: RASTER_TOO_LARGE });
        } else {
          const t = decodeTiff(new Uint8Array(await readFile(file)));
          const stem = file.slice(0, -ext.length);
          const tfw = (await sibling(file, '.tfw', [])) ?? (await sibling(file, '.tifw', []));
          const prj = await sibling(file, '.prj', []);
          const world = tfw ? parseWorldFile(await readFile(tfw, 'utf8')) : undefined;
          // a scan with no position is a drawing, placed by hand
          if (!tiffGeoreferenced(t, world)) {
            items.push(await drawingIn(file));
            continue;
          }
          let src = t.geo.epsg ?? (prj ? epsgFromPrj(await readFile(prj, 'utf8')) : undefined);
          const warn: string[] = [];
          if (src === undefined || !isKnownCrs(src)) {
            warn.push(
              src === undefined
                ? 'No CRS in the file; the project CRS is assumed.'
                : `EPSG:${String(src)} is not bundled; the project CRS is assumed.`,
            );
            src = epsg;
          }
          const c = tiffCorners(t, world);
          const proj = (p: [number, number]): Vec3 => {
            const q =
              src === epsg
                ? ([p[0], p[1], m.origin[2]] as Vec3)
                : fromWgs84(toWgs84([p[0], p[1], m.origin[2]], src), epsg);
            const l = toLocal(m, q);
            const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
            return [r6(l[0]), 0, r6(l[2])];
          };
          const img = rasterToRgba(t, role);
          const base = slug(basename(stem), 'raster');
          const id = uniqueId(`raster-${base}`, layerIdTaken(m));
          const rel = `rasters/${id.slice(7)}.png`;
          await mkdir(join(root, 'rasters'), { recursive: true });
          await writeFile(
            join(root, rel),
            encodePng({ width: img.width, height: img.height, channels: 4, data: img.data }),
          );
          created.add(id);
          m.layers.push({
            kind: 'raster',
            id,
            name: basename(stem),
            visible: true,
            src: { path: rel },
            role,
            format: 'image',
            corners: { tl: proj(c.tl), tr: proj(c.tr), bl: proj(c.bl) },
          });
          const range = img.range
            ? ` Heights ${img.range[0].toFixed(1)} to ${img.range[1].toFixed(1)} m.`
            : '';
          items.push({
            file: name,
            kind: 'raster',
            status: 'imported',
            layerId: id,
            message: [
              `${role === 'dsm' ? 'DSM' : 'Ortho'} ${String(t.width)} x ${String(t.height)} px drawn as ${String(img.width)} x ${String(img.height)}.${range}`,
              ...warn,
            ].join(' '),
          });
        }
      } else if (CLOUD.has(ext)) {
        await job(file, 'pointcloud', 'pointcloud.toCopc', {
          out: `clouds/${slug(name.slice(0, -ext.length), 'cloud')}.copc.laz`,
        });
      } else if (DRAWING.has(ext)) {
        // a picture drawing of the same name keeps its folder: the DXF then comes in from a copy
        // under a free name (`dxfSource`)
        const dxf = await dxfSource(root, m, file, drawingStems, pipeline);
        await job(file, 'drawing', 'drawing.import', dxf.copy ? { src: dxf.src } : {});
        const started = items[items.length - 1];
        if (started?.status === 'queued') {
          if (dxf.note) started.message = `${started.message ?? ''} ${dxf.note}`.trim();
        } else if (dxf.copy) await rm(dxf.copy, { force: true }).catch(() => undefined);
      } else if (OPF.has(ext)) {
        await job(file, 'opf', 'opf.import', {});
      } else if (
        DESIGN.has(ext) ||
        (ext === '.xml' &&
          new TextDecoder().decode(await readHead(file, 4096)).includes('<LandXML'))
      ) {
        await job(file, 'design', 'design.import', {});
      } else if (ext === '.dwg') {
        items.push({
          file: name,
          kind: 'drawing',
          status: 'skipped',
          message:
            'DWG is not supported. Save the drawing as DXF or PDF, or as a PNG picture, then import that.',
        });
      } else {
        items.push({
          file: name,
          kind: 'unknown',
          status: 'skipped',
          message: 'Not a file type the builder imports.',
        });
      }
    } catch (e) {
      const kind: ImportItem['kind'] = PHOTO.has(ext)
        ? 'photo'
        : VIDEO.has(ext)
          ? 'video'
          : MESH.has(ext)
            ? 'mesh'
            : RASTER.has(ext)
              ? 'raster'
              : CLOUD.has(ext)
                ? 'pointcloud'
                : DRAWING.has(ext)
                  ? 'drawing'
                  : OPF.has(ext)
                    ? 'opf'
                    : DESIGN.has(ext) || ext === '.xml'
                      ? 'design'
                      : 'unknown';
      items.push({
        file: name,
        // a picture that was coming in as a drawing fails as one
        kind: isDrawingFile(ext, deps.drawings === true) ? 'drawing' : kind,
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (!later) tick(name);
    }
  }
  // one import is one survey date: the day most files carry; every layer it made is filed under it
  const day = importDay(days);
  /** The date this import added to its copy, if it added one. */
  let madeDate: string | undefined;
  let captureId: string | undefined;
  if (day !== null) {
    const c = captureForDate(m, day);
    m.captures = c.manifest.captures;
    captureId = c.captureId;
    if (c.created) madeDate = c.captureId;
    m.layers = m.layers.map((l) => (created.has(l.id) ? { ...l, capture: c.captureId } : l));
  }
  // its photos are a layer of their own, never added to an earlier flight's, so the import card
  // can re-date them alone: `photos-<day>`, `photos-<day>-2` ... or `photos`, `photos-2` undated
  if (newPhotos.length > 0) {
    const base = day === null ? 'photos' : `photos-${day}`;
    const id = uniqueId(base, layerIdTaken(m));
    const n = id === base ? '' : ` ${id.slice(base.length + 1)}`;
    m.layers.push({
      kind: 'photos',
      id,
      name: `Photos${n}${day === null ? '' : `, ${dayLabel(day)}`}`,
      visible: true,
      items: newPhotos,
      ...(captureId !== undefined ? { capture: captureId } : {}),
    });
    for (const r of photoRows) r.layerId = id;
  }
  const placed = items.filter((i) => i.status === 'imported' && i.heightSource);
  // a datum the person set at this import becomes the project's, so later imports agree
  if (heights.saveDatum && placed.some((i) => i.heightSource !== 'relative'))
    m.verticalDatum = heights.saveDatum;
  const summary = importHeights(heights, placed, datumDefined);
  // 360 video is filed beside the manifest (walks/) and listed as a layer by its own save after
  // its stitch, so it is not a change for the save below
  const changed = items.some((i) => i.status === 'imported' && !walkItems.has(i));
  if (!changed) {
    // Nothing was filed (only jobs, or only refusals), so nothing is saved. The manifest handed
    // back is the project as it is by now, read in its turn after the saves on their way. When
    // it cannot be read at this moment the import does not fail for it: the jobs are started
    // and their report must arrive, with the manifest as it was read at the start.
    if (deps.walk) await stitchWalks(deps.walk);
    const now = await manifestNow(atStart);
    return {
      manifest: now,
      items,
      backup: walkBackup,
      ...(summary ? { heights: summary } : {}),
      createdCaptures: [],
    };
  }
  // Only this takes the project's turn: read the manifest as it is now, put what this import
  // added onto it, save. The date it added is its own only when the project it saves onto had
  // none under that id (another save may have added the day's date meanwhile).
  const saved = await updateManifestFile(root, (fresh) => ({
    ...mergeImport(atStart, m, fresh),
    freshHad: fresh.captures.some((c) => c.id === madeDate),
  }));
  const createdCaptures =
    madeDate !== undefined &&
    !saved.freshHad &&
    saved.manifest.captures.some((c) => c.id === madeDate)
      ? [madeDate]
      : [];
  for (const i of items) {
    const id = i.layerId === undefined ? undefined : saved.renamed.get(i.layerId);
    if (id !== undefined) i.layerId = id;
  }
  // the save above is not held up by a stitch; the manifest handed back is read again after it
  let manifest = saved.manifest;
  if (deps.walk && stitches.length > 0) {
    await stitchWalks(deps.walk);
    manifest = await manifestNow(manifest);
  }
  return {
    manifest,
    items,
    backup: saved.backup || walkBackup,
    ...(summary ? { heights: summary } : {}),
    createdCaptures,
  };
}

/**
 * What the files of an import carry for camera heights (`builder:altitudePlan`): photos with GPS
 * (their XMP and EXIF altitudes) and videos with their SRT. Files it cannot read are left out;
 * the import reports them.
 */
export async function planRawAltitudes(
  root: string,
  paths: readonly string[],
  deps: { video?: VideoTools },
): Promise<AltitudePlan> {
  const m = await readManifestFile(root);
  const files: FileAltitudes[] = [];
  for (const file of paths) {
    const ext = extname(file).toLowerCase();
    try {
      if (PHOTO.has(ext)) {
        const meta = readPhotoMeta(await readHead(file, 512 * 1024));
        const lat = meta.dji?.lat ?? meta.gps?.lat;
        const lon = meta.dji?.lon ?? meta.gps?.lon;
        if (lat === undefined || lon === undefined) continue;
        files.push({ readings: [{ ...photoAltitude(meta), lat, lon }] });
      } else if (VIDEO.has(ext) && deps.video) {
        const srt = await sibling(file, '.srt', paths);
        if (srt) files.push(deps.video.srtAltitudes(await readFile(srt, 'utf8')));
      }
    } catch {
      // unreadable: the import itself reports it
    }
  }
  return altitudePlan(m, epsgOf(m), files);
}
