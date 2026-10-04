import { reportBrands } from '@aio/brand';
import type { ImageOps, PipelineJobs, ProxyEncoder, VideoTools } from '@aio/project/builder';
import type { IpcEvent, IpcRequest, IpcResponse, ProjectManifest } from '@aio/schema';
import { readMp4VideoInfo, parseDjiSrt, srtTimingCheck, srtToFlight } from '@aio/video/telemetry';
import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readManifest, type ProjectRegistry } from './project';

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
    const meta = (await lib()).readPhotoMeta(b.subarray(0, bytesRead));
    const lat = meta.dji?.lat ?? meta.gps?.lat;
    const lon = meta.dji?.lon ?? meta.gps?.lon;
    if (lat === undefined || lon === undefined)
      return { ok: false, error: 'This photo has no GPS position. Pick a geotagged photo.' };
    const alt = meta.dji?.absAlt ?? meta.gps?.alt;
    return {
      ok: true,
      lat,
      lon,
      ...(alt !== undefined ? { alt } : {}),
      ...(meta.takenAt ? { takenAt: meta.takenAt } : {}),
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
    });
    const timing = srtTimingCheck(frames, o.frameTimesMs);
    return { doc: r.doc, warnings: r.warnings, orientation: r.orientation, timing };
  },
};

/** A JPEG poster frame through ffmpeg when it is installed; rejects otherwise. */
export async function ffmpegPoster(video: string, atS: number, out: string): Promise<void> {
  await run(
    process.env.FFMPEG ?? 'ffmpeg',
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

let proxyEncoder: Promise<ProxyEncoder> | undefined;

/**
 * A 1920 px H.264 review copy of a drone recording through ffmpeg (hardware encoding when the
 * machine has it); rejects when ffmpeg is missing, and the import then copies the original.
 */
export async function ffmpegProxy(src: string, out: string): Promise<void> {
  const l = await lib();
  proxyEncoder ??= l.detectProxyEncoder();
  await l.makeProxy(out, { inputs: [src], encoder: await proxyEncoder });
}

export interface BuilderImportDeps {
  registry: ProjectRegistry;
  images: ImageOps;
  jobs?: PipelineJobs;
  emit: (e: IpcEvent<'builder:progress'>) => void;
}

export async function builderImport(
  req: IpcRequest<'builder:import'>,
  d: BuilderImportDeps,
): Promise<IpcResponse<'builder:import'>> {
  const root = d.registry.root(req.projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${req.projectId}" is not open. Open it, then import.` };
  try {
    const { importRawFiles, NO_PIPELINE } = await lib();
    const r = await importRawFiles(root, req.paths, {
      images: d.images,
      jobs: d.jobs ?? NO_PIPELINE,
      video: videoTools,
      poster: ffmpegPoster,
      proxy: ffmpegProxy,
      ...(req.utcOffsetMin !== undefined ? { utcOffsetMin: req.utcOffsetMin } : {}),
      onProgress: (done, total, file) => {
        d.emit({ projectId: req.projectId, done, total, file });
      },
    });
    return { ok: true, manifest: r.manifest, items: r.items };
  } catch (e) {
    return { ok: false, error: `Import failed: ${errorText(e)}` };
  }
}

export async function builderUpdateLayers(
  req: IpcRequest<'builder:updateLayers'>,
  registry: ProjectRegistry,
): Promise<IpcResponse<'builder:updateLayers'>> {
  const root = registry.root(req.projectId);
  if (root === undefined)
    return {
      ok: false,
      error: `Project "${req.projectId}" is not open. Open it, then save again.`,
    };
  try {
    const r = await (await lib()).updateLayers(root, req.layerIds, req.patch);
    return { ok: true, manifest: r.manifest, backup: r.backup };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
