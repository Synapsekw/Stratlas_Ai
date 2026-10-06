import { fromWgs84, isKnownCrs, toWgs84, type HeightRule, type HeightSource } from '@aio/geo';
import type {
  AltitudeChoice,
  AltitudePlan,
  Capture,
  FlightHeights,
  ImportHeights,
  ImportItem,
  Layer,
  LensModel,
  PhotoRef,
  ProjectManifest,
  Vec3,
} from '@aio/schema';
import { open, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { encodePng } from '../import/png';
import {
  altitudePlan,
  heightNote,
  importHeights,
  resolveHeights,
  type FileAltitudes,
} from './altitude';
import { slug, uniqueId, readManifestFile, writeManifestFile } from './create';
import { readPhotoMeta } from './exif';
import { objToGlb } from './obj';
import { photoAltitude, photoHeight, photoRef } from './photos';
import {
  decodeTiff,
  epsgFromPrj,
  parseWorldFile,
  rasterToRgba,
  readTiffHeader,
  tiffCorners,
} from './tiff';

/** Review copies of photos. The app uses Electron's image codec; tools may use ffmpeg. */
export interface ImageOps {
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
  start: () => Promise.reject(new Error('The pipeline pack is not installed.')),
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
  onProgress?: (done: number, total: number, file: string) => void;
}

export interface ImportResult {
  manifest: ProjectManifest;
  items: ImportItem[];
  backup: string;
  /** The height rule applied, when any file got a camera height. */
  heights?: ImportHeights;
}

const PHOTO = new Set(['.jpg', '.jpeg']);
const VIDEO = new Set(['.mp4', '.mov']);
const MESH = new Set(['.glb', '.obj']);
const RASTER = new Set(['.tif', '.tiff']);
const CLOUD = new Set(['.las', '.laz', '.e57', '.ply']);
/** DXF plot plans (M8): imported by the `drawing.import` pipeline into `drawings/`. */
const DRAWING = new Set(['.dxf']);
/** Codecs Chromium plays (sample entry fourcc). */
const PLAYABLE = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01']);
/** GeoTIFFs above this go to the pipeline pack (tiling), below it are drawn as one image. */
const RASTER_BYTES = 300 * 1024 * 1024;
const RASTER_PIXELS = 12_000 * 12_000;
const REVIEW_PX = 2560;
const THUMB_PX = 480;

const PIPELINE_MISSING =
  'Needs the pipeline pack to convert. Install it, then import this file again.';

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

function defaultUtcOffset(m: ProjectManifest): number {
  try {
    const [lon] = toWgs84(m.origin, epsgOf(m));
    return Math.round(lon / 15) * 60;
  } catch {
    return 0;
  }
}

function addCapture(m: ProjectManifest, date: string | undefined): void {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  if (m.captures.some((c) => c.date === date)) return;
  const c: Capture = {
    id: uniqueId(`capture-${date}`, (x) => m.captures.some((k) => k.id === x)),
    label: 'Survey',
    date,
  };
  m.captures = [...m.captures, c].sort((a, b) => a.date.localeCompare(b.date));
}

const layerIdTaken = (m: ProjectManifest) => (id: string) => m.layers.some((l) => l.id === id);

/**
 * Import raw files into a project package: photos (EXIF GPS, DJI gimbal, review copies), video
 * with its DJI SRT (to `aio.flight/1`), GLB and OBJ models, small GeoTIFF orthos and DSMs; point
 * clouds and large rasters become pipeline-pack jobs. The manifest is validated, backed up and
 * replaced once at the end. Each file reports its own outcome; one bad file never stops the rest.
 */
export async function importRawFiles(
  root: string,
  paths: readonly string[],
  deps: ImportDeps,
): Promise<ImportResult> {
  const m = structuredClone(await readManifestFile(root));
  const epsg = epsgOf(m);
  const utcOffsetMin = deps.utcOffsetMin ?? defaultUtcOffset(m);
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
  const total = paths.length;
  let done = 0;
  const tick = (file: string) => {
    done++;
    deps.onProgress?.(done, total, file);
  };

  const photosLayer = (): Extract<Layer, { kind: 'photos' }> => {
    let l = m.layers.find(
      (x): x is Extract<Layer, { kind: 'photos' }> => x.kind === 'photos' && x.id === 'photos',
    );
    if (!l) {
      l = {
        kind: 'photos',
        id: uniqueId('photos', layerIdTaken(m)),
        name: 'Photos',
        visible: true,
        items: [],
      };
      m.layers.push(l);
    }
    return l;
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
        message: 'Converting in the pipeline pack.',
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

  for (const file of paths) {
    const name = basename(file);
    const ext = extname(file).toLowerCase();
    try {
      if (consumed.has(file)) continue;
      if (PHOTO.has(ext)) {
        const meta = readPhotoMeta(await readHead(file, 512 * 1024));
        const layer = photosLayer();
        const id = uniqueId(slug(name.slice(0, -ext.length), 'photo'), (x) =>
          layer.items.some((p) => p.id === x),
        );
        const rel = `photos/${id}.jpg`;
        await mkdir(join(root, 'photos', 'thumbs'), { recursive: true });
        const long = Math.max(meta.width ?? 0, meta.height ?? 0);
        if (long > 0 && long <= REVIEW_PX) await copyFile(file, join(root, rel));
        else await deps.images.resizeJpeg(file, join(root, rel), REVIEW_PX);
        await deps.images.resizeJpeg(file, join(root, 'photos', 'thumbs', `${id}.jpg`), THUMB_PX);
        const frame = { epsg, origin: m.origin, utcOffsetMin, heights: heights.rule };
        const ref: PhotoRef = photoRef(id, rel, meta, frame);
        layer.items = [...layer.items, ref];
        addCapture(m, meta.takenAt?.slice(0, 10));
        const heightSource = ref.pos ? photoHeight(meta, frame).source : undefined;
        const message = [
          ...(ref.pos
            ? ref.q
              ? []
              : ['Placed by GPS; no gimbal angles, so the view direction is unknown.']
            : ['No GPS position: listed in Media, not placed in the scene.']),
          ...offRule(heightSource),
        ].join(' ');
        items.push({
          file: name,
          kind: 'photo',
          status: 'imported',
          layerId: layer.id,
          ...(message ? { message } : {}),
          ...(heightSource ? { heightSource } : {}),
        });
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
            addCapture(m, start.slice(0, 10));
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
        const head = readTiffHeader(await readHead(file, 64 * 1024));
        const role = head.samples === 1 && head.bits >= 16 ? 'dsm' : 'ortho';
        if (head.bigTiff || size > RASTER_BYTES || head.width * head.height > RASTER_PIXELS) {
          await job(file, 'raster', 'raster.tile', {
            role,
            out: `rasters/${slug(name.slice(0, -ext.length), 'raster')}`,
          });
        } else {
          const t = decodeTiff(new Uint8Array(await readFile(file)));
          const stem = file.slice(0, -ext.length);
          const tfw = (await sibling(file, '.tfw', [])) ?? (await sibling(file, '.tifw', []));
          const prj = await sibling(file, '.prj', []);
          const world = tfw ? parseWorldFile(await readFile(tfw, 'utf8')) : undefined;
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
        await job(file, 'drawing', 'drawing.import', {});
      } else if (ext === '.dwg') {
        items.push({
          file: name,
          kind: 'drawing',
          status: 'skipped',
          message: 'DWG is not supported. Save the drawing as DXF, then import it.',
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
                  : 'unknown';
      items.push({
        file: name,
        kind,
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      tick(name);
    }
  }
  const placed = items.filter((i) => i.status === 'imported' && i.heightSource);
  // a datum the person set at this import becomes the project's, so later imports agree
  if (heights.saveDatum && placed.some((i) => i.heightSource !== 'relative'))
    m.verticalDatum = heights.saveDatum;
  const summary = importHeights(heights, placed, datumDefined);
  const changed = items.some((i) => i.status === 'imported');
  const backup = changed ? await writeManifestFile(root, m) : '';
  return { manifest: m, items, backup, ...(summary ? { heights: summary } : {}) };
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
