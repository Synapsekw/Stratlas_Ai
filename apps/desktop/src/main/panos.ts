/*
 * Drone panoramas in main (P1): `panos:scan` groups a folder's frames into spheres, `panos:import`
 * copies the chosen ones into the project and starts one `pano.stitch` job per sphere, and each
 * job's outcome is filed into the manifest before the renderer hears of it (Review Focus 5). A
 * project open files the stitches that finished while the app was closed.
 */
import type * as Builder from '@aio/project/builder';
import type { ImageOps, KeyedGrouping, StitchOutcome } from '@aio/project/builder';
import {
  PANO_STITCH_FEATURE,
  PANO_STITCH_MIN_PACK,
  type IpcRequest,
  type IpcResponse,
  type JobEvent,
  type JobRecord,
  type PanoQuality,
  type PanoScan,
  type PanoShape,
  type PanoStitchFile,
  type ProjectManifest,
} from '@aio/schema';
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createImportRuns } from './importRuns';
import { compareVersions } from './jobs/pack';

/**
 * The builder library loads on first use: a static value import of it makes the main bundle come
 * out empty (rolldown, vite 8), as in builder.ts.
 */
const lib = () => import('@aio/project/builder');

/** What the processing tools must be for `pano.stitch` (Settings, Processing tools lists it). */
export const PANO_PACK_FEATURE = { label: PANO_STITCH_FEATURE, minVersion: PANO_STITCH_MIN_PACK };

/** Why `jobs:start` refuses `pano.stitch` on the installed pack, or null (as `walkPackRefusal`). */
export function panoPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'pano.stitch' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, PANO_STITCH_MIN_PACK) >= 0) return null;
  return `${PANO_STITCH_FEATURE} needs processing tools ${PANO_STITCH_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}

export interface PanoScanDeps {
  /** A small JPEG data URL of a frame for the preview, or undefined. */
  thumb(file: string): Promise<string | undefined>;
  onProgress?(done: number, total: number, file: string): void;
  limit?: number;
  /** A new scan id; every scan gets its own, a rescan of the same folder too. */
  newId?: () => string;
}

const JPEG = /\.jpe?g$/i;

/** The day most spheres start on, the earlier one on a tie. */
function dayOf(g: KeyedGrouping): string | null {
  const counts = new Map<string, number>();
  for (const s of g.spheres) {
    const d = s.startedAt.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [d, n] of [...counts].sort(([a], [b]) => a.localeCompare(b)))
    if (best === null || n > (counts.get(best) ?? 0)) best = d;
  return best;
}

/**
 * Read the JPEGs under `paths` and group them. Frame paths in the answer are absolute and
 * resolved (`withoutExcluded` in builder.ts compares Add data's files the same way).
 */
export async function scanPanoPaths(
  root: string,
  paths: readonly string[],
  deps: PanoScanDeps,
): Promise<{ scan: PanoScan; grouping: KeyedGrouping } | { error: string }> {
  const l = await lib();
  const limit = deps.limit ?? l.MAX_FOLDER_FILES;
  const ex = await l.expandImportPaths(paths, (ext) => ext === '.jpg' || ext === '.jpeg', limit);
  if (ex.tooMany !== null)
    return {
      error: `${basename(ex.tooMany)} holds more than ${String(limit)} files. Choose a smaller folder.`,
    };
  const jpegs = ex.files.filter((f) => JPEG.test(f)).map((f) => resolve(f));
  if (jpegs.length === 0) return { error: 'There are no JPEG files there.' };
  const metas = [];
  for (const [i, f] of jpegs.entries()) {
    metas.push(await l.readPanoFrameMeta(f));
    deps.onProgress?.(i + 1, jpegs.length, basename(f));
  }
  const raw = l.groupPanoFrames(metas);
  const grouping = l.keyGrouping(raw);
  // Review Focus 1: frames already in a pano layer of this project
  const already = l.markAlreadyImported(
    grouping,
    await l.knownPanoFrames(root, await l.readManifestFile(root)),
  );
  const spheres: PanoScan['spheres'] = [];
  for (const s of grouping.spheres) {
    // the preview shows a frame of the horizon row
    const face = [...s.frames].sort(
      (a, b) => Math.abs(a.gimbal?.pitch ?? 90) - Math.abs(b.gimbal?.pitch ?? 90),
    )[0];
    const thumb = face ? await deps.thumb(face.file) : undefined;
    const alreadyIn = already.get(s.key);
    spheres.push({
      key: s.key,
      shape: s.shape,
      files: s.frames.map((f) => f.file),
      frames: s.frames.length,
      bytes: s.bytes,
      startedAt: s.startedAt,
      lat: s.lat,
      lon: s.lon,
      ...(s.absAlt !== undefined ? { absAlt: s.absAlt } : {}),
      ...(s.relAlt !== undefined ? { relAlt: s.relAlt } : {}),
      incomplete: s.incomplete,
      ...(alreadyIn !== undefined ? { alreadyIn } : {}),
      ...(thumb ? { thumb } : {}),
    });
  }
  const ready: PanoScan['ready'] = [];
  for (const r of grouping.ready) {
    const thumb = await deps.thumb(r.file);
    ready.push({
      key: r.key,
      file: r.file,
      bytes: r.bytes,
      lat: r.lat,
      lon: r.lon,
      ...(r.absAlt !== undefined ? { absAlt: r.absAlt } : {}),
      ...(r.relAlt !== undefined ? { relAlt: r.relAlt } : {}),
      ...(r.takenAt ? { takenAt: r.takenAt } : {}),
      ...(thumb ? { thumb } : {}),
    });
  }
  const scan: PanoScan = {
    scanId: (deps.newId ?? randomUUID)(),
    spheres,
    ready,
    skipped: raw.skipped,
    files: jpegs.length,
    day: dayOf(grouping),
  };
  return { scan, grouping };
}

export type PanoScanCache = ReturnType<typeof panoScanCache>;

/** The scans main keeps for `panos:import` (newest `max`, any project). */
export function panoScanCache(max = 4) {
  const kept = new Map<string, { projectId: string; grouping: KeyedGrouping }>();
  return {
    put(projectId: string, scan: PanoScan, grouping: KeyedGrouping): void {
      kept.set(scan.scanId, { projectId, grouping });
      for (const id of [...kept.keys()].slice(0, Math.max(0, kept.size - max))) kept.delete(id);
    },
    get(scanId: string, projectId: string): KeyedGrouping | null {
      const k = kept.get(scanId);
      return k?.projectId === projectId ? k.grouping : null;
    },
    drop(scanId: string): void {
      kept.delete(scanId);
    },
  };
}

/** The copy of a running `panos:import`, per project (`panos:cancelImport` stops it). */
export const panoImports = createImportRuns();

export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

export interface StitchRequest {
  pipeline: 'pano.stitch';
  project: string;
  params: Record<string, unknown>;
}

export type StitchStart =
  { ok: true; job: { id: string } } | { ok: true; queued: true } | { ok: false; error: string };

export interface StitchStarter {
  /** Started now (`job`), waiting in the stitch queue (`queued`), or refused. */
  start(req: StitchRequest): Promise<StitchStart>;
}

/** One `pano.stitch` job per sphere; the first refusal (no pack, an old pack) stops the rest. */
export async function startPanoStitches(o: {
  root: string;
  layerId: string;
  panos: readonly string[];
  quality: PanoQuality;
  /** The scan's classification per sphere (`PanoStitchParams.shape`). */
  shapes?: Readonly<Record<string, PanoShape>>;
  jobs: StitchStarter;
  packVersion(): Promise<string | null>;
}): Promise<{ runs: Record<string, string>; queued: number; refused?: string }> {
  const runs: Record<string, string> = {};
  let queued = 0;
  if (o.panos.length === 0) return { runs, queued };
  const tooOld = panoPackRefusal('pano.stitch', await o.packVersion());
  if (tooOld) return { runs, queued, refused: tooOld };
  for (const pano of o.panos) {
    const shape = o.shapes?.[pano];
    const r = await o.jobs.start({
      pipeline: 'pano.stitch',
      project: o.root,
      params: { layer: o.layerId, pano, quality: o.quality, ...(shape ? { shape } : {}) },
    });
    if (!r.ok) return { runs, queued, refused: r.error };
    if ('job' in r) runs[pano] = r.job.id;
    else queued++;
  }
  return { runs, queued };
}

const rootKey = (root: string) =>
  process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
const sameFolder = (a: string, b: string) => rootKey(a) === rootKey(b);

/** A start request of a `pano.stitch` job, new or a resume of one (`jobs:start`). */
export type LaneRequest =
  { pipeline: string; project: string; params: Record<string, unknown> } | { resume: string };

/** Which sphere a lane request stitches (a resume names it through its job record). */
export interface LaneSphere {
  project: string;
  layer?: string;
  pano?: string;
}

interface Waiting extends LaneSphere {
  req: LaneRequest;
}

const LANE_ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'interrupted']);

/**
 * Drone panorama stitches run one at a time on this computer (one peaks at about 3.4 GB at 8K):
 * a start while one runs waits here, first in first out, and starts when the running one has
 * finished, failed or was cancelled. The queue lives in memory only: after a quit its spheres stay
 * queued with their Stitch action.
 */
export function stitchLane(deps: {
  /** The job runner's start (behind the `jobs:start` gates). */
  start(req: LaneRequest): Promise<{ ok: true; job: JobRecord } | { ok: false; error: string }>;
  /** A queued stitch got its job: its run is filed into the manifest (`fileLaneRun`). */
  started?(sphere: LaneSphere, job: JobRecord): void | Promise<void>;
  log?(line: string): void;
}) {
  const waiting: Waiting[] = [];
  let running: string | null = null;
  let starting = false;

  const same = (a: LaneSphere, b: LaneSphere) =>
    a.layer !== undefined &&
    a.layer === b.layer &&
    a.pano === b.pano &&
    sameFolder(a.project, b.project);

  async function launch(w: Waiting) {
    starting = true;
    try {
      const r = await deps.start(w.req);
      if (r.ok) {
        running = r.job.id;
        // a job that ended within its start: the lane moves on
        if (LANE_ENDED.has(r.job.status)) running = null;
      }
      return r;
    } finally {
      starting = false;
    }
  }

  async function next(): Promise<void> {
    while (running === null && !starting && waiting.length > 0) {
      const w = waiting.shift();
      if (!w) return;
      const r = await launch(w);
      if (!r.ok) {
        deps.log?.(`A queued panorama stitch in ${w.project} did not start: ${r.error}`);
        continue;
      }
      try {
        await deps.started?.(w, r.job);
      } catch (e) {
        deps.log?.(
          `The run of a queued panorama stitch was not filed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return {
    /** Start now when no stitch runs, else wait in line. */
    async start(
      req: LaneRequest,
      sphere: LaneSphere,
    ): Promise<
      { ok: true; job: JobRecord } | { ok: true; queued: true } | { ok: false; error: string }
    > {
      const w: Waiting = { ...sphere, req };
      if (running !== null || starting || waiting.length > 0) {
        // Stitch twice on a waiting sphere: it keeps its place
        if (!waiting.some((x) => same(x, w))) waiting.push(w);
        return { ok: true, queued: true };
      }
      return launch(w);
    },
    /** A job event: the running stitch ended, the next one starts. */
    settled(e: JobEvent): Promise<void> {
      if (e.type === 'update' && e.job.id === running && LANE_ENDED.has(e.job.status)) {
        running = null;
        return next();
      }
      return Promise.resolve();
    },
    /**
     * Leave out the waiting stitches of these layers of a project (of one sphere when `pano` is
     * given: the cancel of a waiting stitch); how many there were.
     */
    drop(project: string, layers: ReadonlySet<string>, pano?: string): number {
      const before = waiting.length;
      const kept = waiting.filter(
        (w) =>
          !(
            w.layer !== undefined &&
            layers.has(w.layer) &&
            (pano === undefined || w.pano === pano) &&
            sameFolder(w.project, project)
          ),
      );
      waiting.splice(0, waiting.length, ...kept);
      return before - kept.length;
    },
    /** The layers with a waiting stitch in a project. */
    waitingLayers(project: string): string[] {
      return waiting.flatMap((w) =>
        w.layer !== undefined && sameFolder(w.project, project) ? [w.layer] : [],
      );
    },
    /** Waiting stitches, oldest first (tests, diagnostics). */
    waiting(): readonly LaneRequest[] {
      return waiting.map((w) => w.req);
    },
    running(): string | null {
      return running;
    },
  };
}

export type StitchLane = ReturnType<typeof stitchLane>;

/** The sphere a `pano.stitch` request stitches, from its params or its job record (a resume). */
export function laneSphere(
  req: LaneRequest,
  job: (id: string) => Pick<JobRecord, 'pipeline' | 'project' | 'params'> | undefined,
): LaneSphere | null {
  const from =
    'resume' in req
      ? job(req.resume)
      : { pipeline: req.pipeline, project: req.project, params: req.params };
  if (from?.pipeline !== 'pano.stitch') return null;
  const { layer, pano } = from.params;
  return {
    project: from.project,
    ...(typeof layer === 'string' ? { layer } : {}),
    ...(typeof pano === 'string' ? { pano } : {}),
  };
}

/** A waiting stitch got its job: its run goes on the item still queued without one. */
export async function fileLaneRun(sphere: LaneSphere, job: JobRecord): Promise<void> {
  if (sphere.layer === undefined || sphere.pano === undefined) return;
  const { layer, pano } = sphere;
  const l = await lib();
  await l.updateManifestFile(sphere.project, (m) => ({
    manifest: l.setPanoRuns(m, layer, { [pano]: job.id }),
  }));
}

export const PANO_QUEUED =
  'This panorama waits for the stitch before it and starts when that one ends.';

export type PanoImportLib = Pick<
  typeof Builder,
  'importPanoGroups' | 'setPanoRuns' | 'updateManifestFile' | 'PanoImportError'
>;

export interface PanoImportAnswerDeps {
  root(projectId: string): string | undefined;
  scans: PanoScanCache;
  images: Pick<ImageOps, 'resizeJpeg'>;
  jobs: StitchStarter;
  packVersion: () => Promise<string | null>;
  progress: (done: number, total: number, file: string) => void;
  freeBytes?: (dir: string) => Promise<number>;
  lib?: () => Promise<PanoImportLib>;
}

export const PANO_IMPORT_BUSY = 'A panorama import is already running for this project.';
/** The projects (by folder) with a `panos:import` running: one at a time per project. */
const importing = new Set<string>();

/** `panos:import`: copy the chosen spheres, save the layer, start the stitches. */
export async function panoImportAnswer(
  req: IpcRequest<'panos:import'>,
  d: PanoImportAnswerDeps,
): Promise<IpcResponse<'panos:import'>> {
  const root = d.root(req.projectId);
  if (root === undefined) return { ok: false, error: `Project "${req.projectId}" is not open.` };
  const key = rootKey(root);
  if (importing.has(key)) return { ok: false, error: PANO_IMPORT_BUSY };
  const grouping = d.scans.get(req.scanId, req.projectId);
  if (!grouping)
    return {
      ok: false,
      error: 'This scan is no longer kept. Choose the folder again.',
      code: 'stale-scan',
    };
  const l = await (d.lib ?? lib)();
  // taken again after the await: another import may have begun meanwhile
  if (importing.has(key)) return { ok: false, error: PANO_IMPORT_BUSY };
  importing.add(key);
  const run = panoImports.begin(req.projectId);
  try {
    const r = await l.importPanoGroups(
      root,
      grouping,
      {
        keys: req.keys,
        layerName: req.layerName,
        quality: req.quality,
        ...(req.date !== undefined ? { date: req.date } : {}),
      },
      {
        images: d.images,
        freeBytes: d.freeBytes ?? freeBytes,
        signal: run.signal,
        onProgress: d.progress,
      },
    );
    d.scans.drop(req.scanId);
    const started = await startPanoStitches({
      root,
      layerId: r.layerId,
      panos: r.stitch,
      quality: req.quality,
      shapes: r.shapes,
      jobs: d.jobs,
      packVersion: d.packVersion,
    });
    const ran = Object.keys(started.runs).length;
    const going = ran + started.queued;
    const manifest = ran
      ? (
          await l.updateManifestFile(root, (m) => ({
            manifest: l.setPanoRuns(m, r.layerId, started.runs),
          }))
        ).manifest
      : r.manifest;
    return {
      ok: true,
      manifest,
      layerId: r.layerId,
      started: going,
      ...(started.refused ? { notStarted: started.refused } : {}),
    };
  } catch (e) {
    if (e instanceof l.PanoImportError && e.code !== 'empty')
      return { ok: false, error: e.message, code: e.code };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    run.end();
    importing.delete(key);
  }
}

const INTERRUPTED = 'The stitch stopped when the app closed. Stitch again.';

/** The item state a job's update files, or null (running jobs show live; other pipelines). */
export function stitchOutcome(job: JobRecord): StitchOutcome | null {
  if (job.pipeline !== 'pano.stitch') return null;
  const { layer, pano } = job.params;
  if (typeof layer !== 'string' || typeof pano !== 'string') return null;
  const at = { layer, pano, run: job.id };
  switch (job.status) {
    case 'done':
      return { ...at, status: 'done' };
    case 'failed':
      return { ...at, status: 'failed', error: job.error ?? 'The stitch failed.' };
    case 'interrupted':
      return { ...at, status: 'failed', error: INTERRUPTED };
    case 'cancelled':
      return { ...at, status: 'queued' };
    default:
      return null;
  }
}

export interface PanoFiler {
  files(e: JobEvent): boolean;
  file(e: JobEvent): Promise<void>;
}

export function panoStitchFiler(deps: {
  update(root: string, change: (m: ProjectManifest) => ProjectManifest | null): Promise<void>;
  readRecord(root: string, layer: string, pano: string): Promise<PanoStitchFile | null>;
  /** The outcome applied to a manifest (the builder's `applyStitchOutcome`). */
  apply?: (
    m: ProjectManifest,
    o: StitchOutcome,
    record: PanoStitchFile | null,
  ) => ProjectManifest | null;
  log?(line: string): void;
}): PanoFiler {
  const filed = new Map<string, string>();
  const outcomeOf = (e: JobEvent) => (e.type === 'update' ? stitchOutcome(e.job) : null);
  return {
    files(e) {
      const o = outcomeOf(e);
      return o !== null && filed.get(o.run) !== o.status;
    },
    async file(e) {
      const o = outcomeOf(e);
      if (!o || e.type !== 'update' || filed.get(o.run) === o.status) return;
      filed.set(o.run, o.status);
      try {
        const apply = deps.apply ?? (await lib()).applyStitchOutcome;
        const record =
          o.status === 'done' ? await deps.readRecord(e.job.project, o.layer, o.pano) : null;
        await deps.update(e.job.project, (m) => apply(m, o, record));
      } catch (err) {
        deps.log?.(
          `The stitch ${o.run} was not filed into the manifest: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },
  };
}

/**
 * File a finished stitch into the manifest, then forward the job event: the renderer reloads the
 * manifest on that event and must find the outcome in it (Review Focus 5). The event goes out
 * even when filing fails; the project open reconciles a done stitch again.
 */
export async function fileThenSend(filer: PanoFiler, e: JobEvent, send: () => void): Promise<void> {
  if (!filer.files(e)) {
    send();
    return;
  }
  try {
    await filer.file(e);
  } catch {
    // reconciled at the next open
  } finally {
    send();
  }
}

/** Main's filer: a read-change-save of the fresh manifest. */
export const panoFiler = panoStitchFiler({
  update: async (root, change) => {
    await (await lib()).updateManifestFile(root, (m) => ({ manifest: change(m) }));
  },
  readRecord: async (root, layer, pano) => (await lib()).readStitchRecord(root, layer, pano),
  log: (line) => {
    console.warn(line);
  },
});

type Loaded = { ok: true; value: ProjectManifest } | { ok: false; error: string };

/** At project open: file the stitches that finished without being filed. Never fails the open. */
export async function withPanoStitches(
  root: string,
  manifest: Loaded,
  log: (line: string) => void,
  reread: (root: string) => Promise<Loaded>,
): Promise<Loaded> {
  if (!manifest.ok) return manifest;
  if (!manifest.value.layers.some((l) => l.kind === 'panoramas')) return manifest;
  try {
    const l = await lib();
    const u = await l.updateManifestFile(root, async (m) => ({
      manifest: await l.reconcilePanoStitches(root, m),
    }));
    return u.saved ? await reread(root) : manifest;
  } catch (e) {
    log(`Finished panorama stitches were not filed: ${e instanceof Error ? e.message : String(e)}`);
    return manifest;
  }
}
