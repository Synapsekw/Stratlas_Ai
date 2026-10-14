import type { FfmpegBin, ProxyEncoder, WalkTools } from '@aio/project/builder';
import {
  WALK_PROCESS_FEATURE,
  WALK_PROCESS_MIN_PACK,
  type ProjectManifest,
  type WalkFile,
  type WalkLayer,
  type WalkProcessSummary,
} from '@aio/schema';
import { readMp4Tracks } from '@aio/video/telemetry';
import { open, stat } from 'node:fs/promises';
import { compareVersions } from './jobs/pack';

/*
 * 360 video in main (the front slice of Walks 360 part W1): the tools the raw import needs to
 * read and stitch a 360 camera's own files, and the list of walks of an open project or package.
 * ffmpeg is the one the drone review copy uses: the pipeline pack's (`findFfmpeg`), else the PATH.
 */

/** The builder library loads on first use, as in `builder.ts`. */
const lib = () => import('@aio/project/builder');

/** The 32 characters an Insta360 file ends with (the end of its trailer). */
export const INSTA360_MARK = '8db42d694ccc418790edff439fe026bf';

/** Whether a file ends with the Insta360 trailer mark. Never throws. */
export async function endsWithInsta360Mark(file: string): Promise<boolean> {
  try {
    const size = (await stat(file)).size;
    if (size < INSTA360_MARK.length) return false;
    const fh = await open(file, 'r');
    try {
      const b = Buffer.alloc(INSTA360_MARK.length);
      await fh.read(b, 0, b.length, size - b.length);
      return b.toString('latin1') === INSTA360_MARK;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** The encoder each ffmpeg offers, asked once per program (`''` is the one on the PATH). */
const encoders = new Map<string, Promise<ProxyEncoder>>();

/**
 * Reading and stitching for the raw import (`ImportDeps.walk`) with this ffmpeg (undefined: the
 * one on the PATH); the poster step is added there.
 */
export function walkToolsFor(bin?: FfmpegBin): WalkTools {
  // the movie's creation time comes with its tracks: kept so the import does not read it twice
  const created = new Map<string, string | null>();
  const readMovie = async (file: string) => {
    const fh = await open(file, 'r');
    try {
      const size = (await stat(file)).size;
      const r = await readMp4Tracks(async (offset, length) => {
        const b = new Uint8Array(length);
        const got = await fh.read(b, 0, length, offset);
        return b.subarray(0, got.bytesRead);
      }, size);
      created.clear();
      created.set(file, r.createdAt ?? null);
      return r;
    } finally {
      await fh.close();
    }
  };
  return {
    async tracks(file) {
      return (await readMovie(file)).tracks;
    },
    async createdAt(file) {
      const known = created.get(file);
      return known !== undefined ? known : ((await readMovie(file)).createdAt ?? null);
    },
    trailer: endsWithInsta360Mark,
    // asked again on every import: a person who installs ffmpeg and restarts is not told it is missing
    check: async () => (await lib()).checkFfmpeg(bin),
    async copy(out, o) {
      const l = await lib();
      const key = bin?.ffmpeg ?? '';
      let encoder = encoders.get(key);
      if (!encoder) {
        encoder = l.detectProxyEncoder(bin);
        encoders.set(key, encoder);
      }
      return l.makeWalkCopy(out, { ...o, encoder: await encoder, ...(bin ? { bin } : {}) });
    },
  };
}

/** The walks of a project folder (`walks:list`). */
export async function listProjectWalks(root: string): Promise<WalkFile[]> {
  return (await lib()).listWalks(root);
}

/** The processed walks among `walks` of a project folder (`walks:list`, `processed`). */
export async function projectWalkProcessing(
  root: string,
  walks: readonly WalkFile[],
): Promise<Record<string, WalkProcessSummary>> {
  return (await lib()).readProcessSummaries(
    root,
    walks.map((w) => w.id),
  );
}

/** The processed walks among `walks` a package carries, read in place. */
export async function packageWalkProcessing(
  archive: { entries: ReadonlyMap<string, unknown>; read(name: string): Promise<Buffer> },
  walks: readonly WalkFile[],
): Promise<Record<string, WalkProcessSummary>> {
  return (await lib()).packageProcessSummaries(
    archive,
    walks.map((w) => w.id),
  );
}

/**
 * The `walks:list` answer: the walks, and `processed` for those the `walk.process` pipeline has
 * finished (left out when none is).
 */
export function walksListAnswer(
  walks: WalkFile[],
  processed: Record<string, WalkProcessSummary>,
): { walks: WalkFile[]; processed?: Record<string, WalkProcessSummary> } {
  return Object.keys(processed).length > 0 ? { walks, processed } : { walks };
}

/** The walks a package carries, read in place (`walks:list` for a package). */
export async function packageWalks(archive: {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}): Promise<WalkFile[]> {
  const { parseWalk, sortWalks, WALK_JSON_MAX_BYTES } = await lib();
  const out: WalkFile[] = [];
  for (const [name, entry] of archive.entries) {
    const id = /^walks\/([^/]+)\/walk\.json$/.exec(name)?.[1];
    if (!id || id.startsWith('.')) continue;
    // a walk.json is a few hundred bytes: a member far larger is not one, and is not unpacked
    const size = (entry as { size?: unknown } | null)?.size;
    if (typeof size === 'number' && size > WALK_JSON_MAX_BYTES) continue;
    const text = await archive
      .read(name)
      .then((b) => b.toString('utf8'))
      .catch(() => null);
    const walk = parseWalk(text, id);
    if (walk) out.push(walk);
  }
  return sortWalks(out);
}

/**
 * The walk layers a package's manifest lacks: its side-folder walks (made by a build before walks
 * were layers), as layers in memory only. A package is never written. The files each walk holds
 * are read from the archive's member names.
 */
export async function walkLayersInMemory(
  archive: { entries: ReadonlyMap<string, unknown>; read(name: string): Promise<Buffer> },
  manifest: ProjectManifest,
): Promise<WalkLayer[]> {
  const { missingWalkLayers, WALK_LAYER_MARK } = await lib();
  const has = (id: string, name: string) => archive.entries.has(`walks/${id}/${name}`);
  // a walk that has been a layer and has none now was removed: it is not brought back
  const walks = (await packageWalks(archive)).filter((w) => !has(w.id, WALK_LAYER_MARK));
  if (walks.length === 0) return [];
  return missingWalkLayers(walks, manifest, (id) => ({
    raw: has(id, 'raw-path.json'),
    orientation: has(id, 'orientation.json'),
    orientationData: has(id, 'orientation.bin'),
    points: has(id, 'sparse.ply'),
  }));
}

export interface ImportProgress {
  done: number;
  total: number;
  file: string;
  /** 0 to 1 inside the file being imported (a 360 stitch). */
  part?: number;
}

/**
 * Progress of an import with long files in it: `file` passes on the per-file count, `part`
 * reports a stitch in whole percent steps (each step once), on the count reached so far.
 */
export function stitchProgress(emit: (e: ImportProgress) => void, total: number) {
  let done = 0;
  let count = total;
  let last = '';
  return {
    file: (d: number, t: number, file: string): void => {
      done = d;
      count = t;
      last = '';
      emit({ done, total: count, file });
    },
    part: (file: string, fraction: number): void => {
      const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
      const key = `${file}:${String(pct)}`;
      if (key === last) return;
      last = key;
      emit({
        done,
        total: count,
        file: `${file}, playback copy ${String(pct)} %`,
        part: pct / 100,
      });
    },
  };
}

/** What the processing tools must be for `walk.process` (Settings, Processing tools lists it). */
export const WALK_PACK_FEATURE = { label: WALK_PROCESS_FEATURE, minVersion: WALK_PROCESS_MIN_PACK };

/**
 * Why `jobs:start` refuses a job on the installed pack, or null: `walk.process` needs pack 0.6.0
 * or later, and an older pack would fail it as an unknown pipeline. A development pack (`dev`)
 * and no pack (the job runner says so itself) pass.
 */
export function walkPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'walk.process' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, WALK_PROCESS_MIN_PACK) >= 0) return null;
  return `${WALK_PROCESS_FEATURE} needs processing tools ${WALK_PROCESS_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}
