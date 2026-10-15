import { reportBrands } from '@aio/brand';
import type {
  Expanded,
  FfmpegBin,
  ImageOps,
  ImportDeps,
  PipelineJobs,
  ProxyEncoder,
  VideoTools,
} from '@aio/project/builder';
import { PROCMODEL_DIR, ProcModelId } from '@aio/schema';
import type { IpcEvent, IpcRequest, IpcResponse, ProjectManifest } from '@aio/schema';
import { readMp4VideoInfo, parseDjiSrt, srtTimingCheck, srtToFlight } from '@aio/video/telemetry';
import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createImportRuns } from './importRuns';
import { writeBytesAtomic } from './modelBuilder';
import { readOrientation } from './orientation';
import { readManifest, type ProjectRegistry } from './project';
import { stitchProgress, walkToolsFor } from './walks';

const run = promisify(execFile);

/**
 * The builder library loads on first use: it keeps start-up lean, and a static import of it
 * currently makes the main bundle come out empty (rolldown, vite 8).
 */
const lib = () => import('@aio/project/builder');

/** Manifests of the native projects in the data folder and the folders the person added. */
export async function libraryManifests(
  dataRoot: string,
  extraPaths: readonly string[],
): Promise<ProjectManifest[]> {
  const dirs: string[] = [];
  try {
    for (const e of await readdir(join(dataRoot, 'projects'), { withFileTypes: true }))
      if (e.isDirectory()) dirs.push(join(dataRoot, 'projects', e.name));
  } catch {
    // no projects folder yet
  }
  dirs.push(...extraPaths);
  const seen = new Set<string>();
  const out: ProjectManifest[] = [];
  for (const d of dirs) {
    const key = resolve(d).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const m = await readManifest(d);
    if (m.ok) out.push(m.value);
  }
  return out;
}

export async function builderTemplates(
  dataRoot: string,
  extraPaths: readonly string[],
): Promise<IpcResponse<'builder:templates'>> {
  return {
    severity: (await lib()).severityTemplates(await libraryManifests(dataRoot, extraPaths)),
    brands: [...reportBrands],
  };
}

export async function createBuilderProject(
  req: IpcRequest<'builder:createProject'>,
  dataRoot: string,
  extraPaths: readonly string[],
): Promise<IpcResponse<'builder:createProject'>> {
  if (!dataRoot)
    return { ok: false, error: 'Set a data folder in Settings first; new projects go there.' };
  try {
    const { severity } = await builderTemplates(dataRoot, extraPaths);
    const template =
      req.severityTemplate === null
        ? null
        : (severity.find((t) => t.id === req.severityTemplate) ?? null);
    if (req.severityTemplate !== null && !template)
      return { ok: false, error: `Severity template "${req.severityTemplate}" was not found.` };
    const r = await (await lib()).createProject(dataRoot, req, template);
    return { ok: true, path: r.root, manifest: r.manifest };
  } catch (e) {
    return { ok: false, error: `Could not create the project: ${errorText(e)}` };
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function photoGps(path: string): Promise<IpcResponse<'builder:photoGps'>> {
  try {
    const fh = await open(path, 'r');
    const b = new Uint8Array(512 * 1024);
    const { bytesRead } = await fh.read(b, 0, b.length, 0);
    await fh.close();
    const project = await lib();
    const meta = project.readPhotoMeta(b.subarray(0, bytesRead));
    const lat = meta.dji?.lat ?? meta.gps?.lat;
    const lon = meta.dji?.lon ?? meta.gps?.lon;
    if (lat === undefined || lon === undefined)
      return { ok: false, error: 'This photo has no GPS position. Pick a geotagged photo.' };
    // the origin is on the ground: the take-off point's absolute altitude when the photo logs its
    // height above take-off, else the camera's own altitude (data-conventions section 3a)
    const abs = meta.dji?.absAlt ?? meta.gps?.alt;
    const rel = meta.dji?.relAlt;
    const takeoff = abs !== undefined && rel !== undefined;
    const alt = takeoff ? Math.round((abs - rel) * 1000) / 1000 : abs;
    return {
      ok: true,
      lat,
      lon,
      ...(alt !== undefined
        ? { alt, altFrom: takeoff ? ('takeoff' as const) : ('photo' as const) }
        : {}),
      ...(meta.takenAt ? { takenAt: meta.takenAt } : {}),
      ...(project.isDronePhoto(meta) ? {} : { handheld: true }),
    };
  } catch (e) {
    return { ok: false, error: `Could not read the photo: ${errorText(e)}` };
  }
}

/** Video probing and SRT conversion for the raw import. */
export const videoTools: VideoTools = {
  async probe(file) {
    const fh = await open(file, 'r');
    try {
      const size = (await stat(file)).size;
      return await readMp4VideoInfo(async (offset, length) => {
        const b = new Uint8Array(length);
        const r = await fh.read(b, 0, length, offset);
        return b.subarray(0, r.bytesRead);
      }, size);
    } finally {
      await fh.close();
    }
  },
  flightFromSrt(text, o) {
    const frames = parseDjiSrt(text);
    const r = srtToFlight(frames, {
      epsg: o.epsg,
      origin: o.origin,
      utcOffsetMin: o.utcOffsetMin,
      aspect: o.aspect,
      name: o.name,
      heights: o.heights,
    });
    const timing = srtTimingCheck(frames, o.frameTimesMs);
    return {
      doc: r.doc,
      warnings: r.warnings,
      orientation: r.orientation,
      heightSource: r.heightSource,
      timing,
    };
  },
  srtAltitudes(text) {
    const frames = parseDjiSrt(text).filter(
      (f) => f.lat !== undefined && f.lon !== undefined && !(f.lat === 0 && f.lon === 0),
    );
    const home = frames.find((f) => f.home)?.home;
    return {
      readings: frames.map((f) => ({ lat: f.lat, lon: f.lon, abs: f.absAlt, rel: f.relAlt })),
      ...(home ? { home } : {}),
    };
  },
};

/** The folder limit as the messages print it ("20,000"); a test pins it to `MAX_FOLDER_FILES`. */
export const FOLDER_LIMIT_TEXT = '20,000';

export interface ExpandOptions {
  /** Which extensions an import takes; defaults to `isImportableExtension`. */
  known?: (ext: string) => boolean;
  /** Files per import; defaults to `MAX_FOLDER_FILES`. */
  limit?: number;
}

/** Folders in the paths of an import become the files they hold. */
export async function expandFor(
  paths: readonly string[],
  opts: ExpandOptions = {},
): Promise<Expanded> {
  const l = await lib();
  return l.expandImportPaths(paths, opts.known ?? l.isImportableExtension, opts.limit);
}

const tooManyError = (folder: string): string =>
  `${basename(folder)} holds more than ${FOLDER_LIMIT_TEXT} files. Import a smaller folder.`;

/** What the files of an import carry for camera heights (`builder:altitudePlan`). */
export async function builderAltitudePlan(
  req: IpcRequest<'builder:altitudePlan'>,
  registry: ProjectRegistry,
  opts: ExpandOptions = {},
): Promise<IpcResponse<'builder:altitudePlan'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${req.projectId}" is not open. Open it, then import.` };
  try {
    const ex = await expandFor(req.paths, opts);
    if (ex.tooMany !== null) return { ok: false, error: tooManyError(ex.tooMany) };
    const files = outsidePanoFolder(root, withoutExcluded(ex.files, req.exclude));
    const plan = await (await lib()).planRawAltitudes(root, files, { video: videoTools });
    return { ok: true, plan };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/**
 * The `.zpc` clouds an import would take with the day their LAS headers carry (the export day, not
 * the flight day): Add data asks for each cloud's survey day before `builder:import` (15 Oct 2026).
 */
export async function builderCloudDates(
  req: IpcRequest<'builder:cloudDates'>,
  registry: ProjectRegistry,
  opts: ExpandOptions = {},
): Promise<IpcResponse<'builder:cloudDates'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${req.projectId}" is not open. Open it, then import.` };
  try {
    const ex = await expandFor(req.paths, opts);
    if (ex.tooMany !== null) return { ok: false, error: tooManyError(ex.tooMany) };
    const files = outsidePanoFolder(root, withoutExcluded(ex.files, req.exclude));
    const { zpcHeaderDay } = await lib();
    const clouds = await Promise.all(
      files
        .filter((f) => extname(f).toLowerCase() === '.zpc')
        .map(async (path) => ({ path, name: basename(path), headerDay: await zpcHeaderDay(path) })),
    );
    return { ok: true, clouds };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/**
 * A JPEG poster frame through ffmpeg (`bin`, else the one on the PATH) when it is installed;
 * rejects otherwise.
 */
export async function ffmpegPoster(
  video: string,
  atS: number,
  out: string,
  bin?: FfmpegBin,
): Promise<void> {
  await run(
    bin?.ffmpeg ?? process.env.FFMPEG ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      atS.toFixed(3),
      '-i',
      video,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(960,iw)':-2",
      '-q:v',
      '3',
      out,
    ],
    { timeout: 60_000, windowsHide: true },
  );
}

/** The encoder each ffmpeg offers, asked once per program (`''` is the one on the PATH). */
const proxyEncoders = new Map<string, Promise<ProxyEncoder>>();

/**
 * A 1920 px H.264 review copy of a drone recording through ffmpeg (hardware encoding when the
 * machine has it); rejects when ffmpeg is missing, and the import then copies the original.
 */
export async function ffmpegProxy(src: string, out: string, bin?: FfmpegBin): Promise<void> {
  const l = await lib();
  const key = bin?.ffmpeg ?? '';
  let encoder = proxyEncoders.get(key);
  if (!encoder) {
    encoder = l.detectProxyEncoder(bin);
    proxyEncoders.set(key, encoder);
  }
  await l.makeProxy(out, { inputs: [src], encoder: await encoder, ...(bin ? { bin } : {}) });
}

/**
 * The ffmpeg work of an import (posters, drone review copies, 360 walks) with this ffmpeg; null
 * or undefined uses the one on the PATH.
 */
export function ffmpegImportTools(
  bin?: FfmpegBin | null,
): Pick<ImportDeps, 'poster' | 'proxy' | 'walk'> {
  const b = bin ?? undefined;
  const poster = (video: string, atS: number, out: string) => ffmpegPoster(video, atS, out, b);
  return {
    poster,
    proxy: (src, out) => ffmpegProxy(src, out, b),
    // 360 video: camera files are stitched into walks/<id>/ (walks.ts)
    walk: { ...walkToolsFor(b), poster },
  };
}

/** The imports that are running: cancelled by `builder:cancelImport`, and all when the app quits. */
export const importRuns = createImportRuns();

export interface BuilderImportDeps {
  registry: ProjectRegistry;
  images: ImageOps;
  jobs?: PipelineJobs;
  emit: (e: IpcEvent<'builder:progress'>) => void;
  /** Folder expansion overrides (tests). */
  known?: ExpandOptions['known'];
  limit?: ExpandOptions['limit'];
  /** The ffmpeg to use (the pipeline pack's, `findFfmpeg`), asked on each import; null: the PATH. */
  ffmpeg?: () => Promise<FfmpegBin | null>;
  /** The system folder dialog, for a Bentley block's photos folder (index.ts). */
  pickFolder?: (title: string) => Promise<string | null>;
}

/**
 * `files` without `exclude` (the frames Add data hands to the panorama import instead). Paths are
 * compared resolved, without case on Windows, as `panos:scan` reports them.
 */
export function withoutExcluded(
  files: readonly string[],
  exclude: readonly string[] | undefined,
): string[] {
  if (!exclude?.length) return files as string[];
  const key = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const out = new Set(exclude.map(key));
  return files.filter((f) => !out.has(key(f)));
}

/**
 * `files` without those under the project's own `panoramas/` folder: a sphere's raw frames never
 * become map items, whatever folder Add data is pointed at.
 */
export function outsidePanoFolder(root: string, files: readonly string[]): string[] {
  const fold = (p: string) =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  const dir = fold(join(root, 'panoramas')) + sep;
  return files.filter((f) => !fold(f).startsWith(dir));
}

export async function builderImport(
  req: IpcRequest<'builder:import'>,
  d: BuilderImportDeps,
): Promise<IpcResponse<'builder:import'>> {
  const root = d.registry.root(req.projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${req.projectId}" is not open. Open it, then import.` };
  const ex = await expandFor(req.paths, {
    ...(d.known ? { known: d.known } : {}),
    ...(d.limit !== undefined ? { limit: d.limit } : {}),
  });
  if (ex.tooMany !== null) return { ok: false, error: tooManyError(ex.tooMany) };
  // the sphere frames the panorama import takes instead
  const files = outsidePanoFolder(root, withoutExcluded(ex.files, req.exclude));
  if (files.length === 0 && ex.leftOut.length === 0) {
    // everything was left out (the sphere frames went to the panorama import): nothing to do
    if (ex.files.length > 0)
      return {
        ok: true,
        manifest: await (await lib()).readManifestFile(root),
        items: [],
        createdCaptures: [],
        files: [],
      };
    return { ok: false, error: 'The folder holds no files to import.' };
  }
  const run = importRuns.begin(req.projectId);
  try {
    const { importRawFiles, NO_PIPELINE } = await lib();
    const progress = stitchProgress((e) => {
      d.emit({ projectId: req.projectId, ...e });
    }, files.length);
    const r = await importRawFiles(root, files, {
      images: d.images,
      jobs: d.jobs ?? NO_PIPELINE,
      video: videoTools,
      // a lookup that fails leaves it to the PATH, as before
      ...ffmpegImportTools(await (d.ffmpeg?.().catch(() => null) ?? null)),
      ...(req.as360 ? { as360: true } : {}),
      onFileProgress: progress.part,
      signal: run.signal,
      ...(req.utcOffsetMin !== undefined ? { utcOffsetMin: req.utcOffsetMin } : {}),
      ...(req.altitude ? { altitude: req.altitude } : {}),
      ...(req.drawings ? { drawings: true } : {}),
      ...(d.pickFolder ? { pickFolder: d.pickFolder } : {}),
      // the survey day Add data chose for each cloud (pointcloud.to_copc surveyDate)
      ...(req.cloudDates ? { cloudDates: req.cloudDates } : {}),
      onProgress: progress.file,
    });
    return {
      ok: true,
      manifest: r.manifest,
      items: [
        ...r.items,
        ...ex.leftOut.map((o) => ({
          file: basename(o.folder),
          kind: 'unknown' as const,
          status: 'skipped' as const,
          message: `${o.count} files in ${basename(o.folder)} are not data this app imports (${o.exts.join(', ')}).`,
        })),
      ],
      ...(r.heights ? { heights: r.heights } : {}),
      createdCaptures: r.createdCaptures,
      files,
    };
  } catch (e) {
    return { ok: false, error: `Import failed: ${errorText(e)}` };
  } finally {
    run.end();
  }
}

/** One page of a staged drawing, drawn by the app window (PDF, WebP, SVG). */
export async function builderAddDrawingPage(
  req: IpcRequest<'builder:addDrawingPage'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:addDrawingPage'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${req.projectId}" is not open. Open it, then import.` };
  try {
    const r = await (
      await lib()
    ).addDrawingPage(root, {
      stem: req.stem,
      name: req.name,
      page: req.page,
      pages: req.pages,
      png: req.png,
    });
    return { ok: true, manifest: r.manifest, layerId: r.layerId };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/**
 * A `drawing.import` job started by hand (the Processing form, the model builder): refused when
 * a picture drawing has the folder the pipeline would file the DXF under. Null for every other
 * job, and when the DXF may come in.
 */
export async function drawingJobRefusal(req: IpcRequest<'jobs:start'>): Promise<string | null> {
  if (!('pipeline' in req) || req.pipeline !== 'drawing.import') return null;
  const src = (req.params as { src?: unknown }).src;
  if (typeof src !== 'string' || !src) return null;
  try {
    return await (await lib()).dxfClash(req.project, src);
  } catch {
    // a project that cannot be looked at: the job says what is wrong with it
    return null;
  }
}

/** The app window is done with a staged drawing: no more pages, and no copy left without one. */
export async function builderCloseDrawing(
  req: IpcRequest<'builder:closeDrawing'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:closeDrawing'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${req.projectId}" is not open. Open it, then import.` };
  try {
    const r = await (await lib()).closeDrawing(root, req.stem);
    return { ok: true, removed: r.removed };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/**
 * A placed model layer's georeference written to the model's sidecar
 * (`models/<id>.georeference.json`, as `engineer:accept` writes it), so Place model and Georeference
 * model leave the layer and the sidecar in agreement. Only built (not draft) layers of a model whose
 * `.procmodel.json` is in the project. The layer's record is the one that counts: the model file's
 * own `georef` is where the engineering run put it, used until the layer is placed.
 */
async function writeModelGeorefs(
  root: string,
  manifest: ProjectManifest,
  layerIds: readonly string[],
  log: (line: string) => void,
): Promise<void> {
  for (const l of manifest.layers) {
    if (l.kind !== 'mesh' || !layerIds.includes(l.id) || !l.georef) continue;
    if (l.derived?.kind !== 'model' || l.derived.draft === true) continue;
    const id = l.derived.source?.[0];
    if (id === undefined || !ProcModelId.safeParse(id).success) continue;
    const model = join(root, PROCMODEL_DIR, `${id}.procmodel.json`);
    if (
      !(await stat(model).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      continue;
    const rel = `${PROCMODEL_DIR}/${id}.georeference.json`;
    try {
      await writeBytesAtomic(
        join(root, PROCMODEL_DIR, `${id}.georeference.json`),
        new TextEncoder().encode(`${JSON.stringify(l.georef, null, 2)}\n`),
      );
    } catch (e) {
      log(`${rel} could not be written: ${errorText(e)}`);
    }
  }
}

export async function builderUpdateLayers(
  req: IpcRequest<'builder:updateLayers'>,
  registry: ProjectRegistry,
  /** The project log: one line for each walk file that could not be used. */
  log: (line: string) => void = () => undefined,
): Promise<IpcResponse<'builder:updateLayers'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return {
      ok: false,
      error: `Project "${req.projectId}" is not open. Open it, then save again.`,
    };
  try {
    const r = await (await lib()).updateLayers(root, req.layerIds, req.patch);
    for (const line of r.problems) log(line);
    if ('georef' in req.patch && req.patch.georef)
      await writeModelGeorefs(root, r.manifest, req.layerIds, log);
    return { ok: true, manifest: r.manifest, backup: r.backup };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Where each layer lies and what would stop a re-centre. Reads only. */
export async function builderLayerExtents(
  req: IpcRequest<'builder:layerExtents'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:layerExtents'>> {
  const root = registry.root(req.projectId);
  if (root === undefined) return { ok: false, error: `Project "${req.projectId}" is not open.` };
  try {
    const l = await lib();
    const m = await l.readManifestFile(root);
    const o = await readOrientation(root);
    const orientation = o.ok ? o.file : null;
    return {
      ok: true,
      extents: await l.layerExtents(root, m, orientation),
      recentre: { blockers: await l.recentreBlockers(root, m) },
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Move the project origin; the check and the save happen in one manifest turn. */
export async function builderRecentre(
  req: IpcRequest<'builder:recentre'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:recentre'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${req.projectId}" is not open. Open it, then try again.` };
  try {
    const r = await (await lib()).recentreProject(root, req.at);
    return { ok: true, manifest: r.manifest, backup: r.backup };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Rename a survey date or set its folder colour and icon: only `manifest.captures` changes. */
export async function builderUpdateCapture(
  req: IpcRequest<'builder:updateCapture'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:updateCapture'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return {
      ok: false,
      error: `Project "${req.projectId}" is not open. Open it, then save again.`,
    };
  try {
    const r = await (await lib()).updateCapture(root, req.captureId, req.patch);
    return { ok: true, manifest: r.manifest, backup: r.backup };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Replace the project's class catalogues (ANN-7): only `manifest.classCatalogues` changes. */
export async function builderUpdateClasses(
  req: IpcRequest<'builder:updateClasses'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:updateClasses'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return {
      ok: false,
      error: `Project "${req.projectId}" is not open. Open it, then save again.`,
    };
  try {
    const r = await (await lib()).updateClasses(root, req.catalogues);
    return { ok: true, manifest: r.manifest, backup: r.backup };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Remove a survey date that holds no datasets: only `manifest.captures` changes. */
export async function builderRemoveCapture(
  req: IpcRequest<'builder:removeCapture'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:removeCapture'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return {
      ok: false,
      error: `Project "${req.projectId}" is not open. Open it, then try again.`,
    };
  try {
    const r = await (await lib()).removeCapture(root, req.captureId);
    return { ok: true, manifest: r.manifest, backup: r.backup };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Find the survey date of a day or add it: only `manifest.captures` can change. */
export async function builderEnsureCapture(
  req: IpcRequest<'builder:ensureCapture'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:ensureCapture'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return {
      ok: false,
      error: `Project "${req.projectId}" is not open. Open it, then try again.`,
    };
  try {
    const r = await (await lib()).ensureCapture(root, req.date);
    return { ok: true, manifest: r.manifest, captureId: r.captureId, created: r.created };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
