import type { ProxyEncoder, WalkTools } from '@aio/project/builder';
import type { ProjectManifest, WalkFile, WalkLayer } from '@aio/schema';
import { readMp4Tracks } from '@aio/video/telemetry';
import { open, stat } from 'node:fs/promises';

/*
 * 360 video in main (the front slice of Walks 360 part W1): the tools the raw import needs to
 * read and stitch a 360 camera's own files, and the list of walks of an open project or package.
 * ffmpeg is the external program the drone review copy already uses (found on the PATH).
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

let encoder: Promise<ProxyEncoder> | undefined;

/** Reading and stitching for the raw import (`ImportDeps.walk`); the poster step is added there. */
export const walkTools: WalkTools = {
  async tracks(file) {
    const fh = await open(file, 'r');
    try {
      const size = (await stat(file)).size;
      const r = await readMp4Tracks(async (offset, length) => {
        const b = new Uint8Array(length);
        const got = await fh.read(b, 0, length, offset);
        return b.subarray(0, got.bytesRead);
      }, size);
      return r.tracks;
    } finally {
      await fh.close();
    }
  },
  trailer: endsWithInsta360Mark,
  // asked again on every import: a person who installs ffmpeg and restarts is not told it is missing
  check: async () => (await lib()).checkFfmpeg(),
  async copy(out, o) {
    const l = await lib();
    encoder ??= l.detectProxyEncoder();
    return l.makeWalkCopy(out, { ...o, encoder: await encoder });
  },
};

/** The walks of a project folder (`walks:list`). */
export async function listProjectWalks(root: string): Promise<WalkFile[]> {
  return (await lib()).listWalks(root);
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
