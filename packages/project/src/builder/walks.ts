import {
  WALKS_DIR,
  WALK_SCHEMA,
  WalkFile,
  readVersioned,
  type WalkLayout,
  type WalkStream,
} from '@aio/schema';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { isLockedError, renameWhenFree, type RenameOptions } from '../import/rename';
import {
  WALK_DEFAULTS,
  ffmpegMissingMessage,
  type FfmpegCheck,
  type FrameSize,
} from '../import/stitch';
import { slug, uniqueId } from './create';
import {
  classifyWalkSource,
  insta360Name,
  isProxyName,
  proxyOwner,
  type WalkTrack,
} from './walkSource';

/*
 * 360 video in a project (the front slice of Walks 360 part W1): one folder per walk under
 * `walks/`, holding the equirectangular playback copy, a poster and `walk.json` (`aio.walk/1`).
 * The manifest is never touched, so builds that do not know the folder open the project as
 * before. Everything that needs ffmpeg or reads video files is injected (`WalkTools`).
 */

/** What the import asks the playback copy for. */
export interface WalkCopyRequest {
  input: string;
  layout: WalkLayout;
  /** Size of one video track of the source. */
  lens: FrameSize;
  srcFps: number;
  audio: boolean;
  durationS: number;
  onProgress?: (fraction: number) => void;
  /** Aborting stops the copy; `copy` then rejects and removes what it wrote. */
  signal?: AbortSignal;
}

/** Video reading and ffmpeg work for a walk import, injected by the app. */
export interface WalkTools {
  /** Every track of an MP4-like file; rejects when the file is not one. */
  tracks(file: string): Promise<WalkTrack[]>;
  /** Whether the file ends with the Insta360 trailer mark. */
  trailer?(file: string): Promise<boolean>;
  /** Is ffmpeg there, and can it stitch? */
  check(): Promise<FfmpegCheck>;
  /**
   * Write the equirectangular playback copy to `out`, a file in the import's own staging folder:
   * nothing reads it until the walk is moved into place, so it is written under its final name.
   */
  copy(
    out: string,
    o: WalkCopyRequest,
  ): Promise<FrameSize & { fps: number; encoder: string; filter?: string }>;
  /** JPEG poster of a video frame; optional. */
  poster?(video: string, atS: number, out: string): Promise<void>;
}

export interface WalkImportOptions {
  tools: WalkTools;
  /** 0 to 1 while the playback copy is written. */
  onProgress?: (fraction: number) => void;
  now?: () => Date;
  /** How the finished folder is moved into place (tests hand in a rename that fails). */
  move?: RenameOptions;
  /**
   * Cancel: aborting stops a running stitch, removes its staging folder and answers `skipped`
   * with the reason. A copy that was already finished is still moved into place or kept.
   */
  signal?: AbortSignal;
}

export type WalkImportResult =
  | { ok: true; walk: WalkFile; message: string }
  | { ok: false; status: 'skipped' | 'error'; message: string };

/** Codecs and sizes Chromium plays without help: such a stitched video is stored as it is. */
const DIRECT_CODECS = new Set(['avc1', 'avc3']);

/** A `walk.json` is a few hundred bytes; anything far larger is not one and is not read. */
export const WALK_JSON_MAX_BYTES = 256 * 1024;

/** Longest walk id before a `-2` is added, well inside the id limit of the contract. */
const ID_MAX = 80;
const NAME_MAX = 200;
const FILE_MAX = 260;

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
const px = (s: FrameSize) => `${String(s.width)} x ${String(s.height)}`;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

const OPEN_HINT = 'Open it under 360 video in the sidebar.';

/** What a walk's row says when the import was cancelled while it was made. */
export const WALK_CANCELLED =
  'The import was cancelled while this 360 video was made. Nothing of it was added.';
/**
 * The reason main aborts every running import with when the app quits (`importRuns.ts`). A quit
 * is not the person's Cancel: a playback copy that is finished is then kept for the next import
 * instead of being removed.
 */
export const QUIT_REASON = 'quit';
/** What a file's row says when the import was cancelled before its turn. */
export const CANCELLED_BEFORE = 'The import was cancelled before this file.';

/** Remove a staging folder; a file ffmpeg held a moment ago is tried a few times on Windows. */
const removeStaging = (staging: string) =>
  rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    () => undefined,
  );

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The id a walk of this file name asks for: lower-case, file-safe, short enough for a suffix. */
export function walkIdFor(stem: string): string {
  return slug(stem, 'walk').slice(0, ID_MAX).replace(/-+$/, '') || 'walk';
}

/** Staging folders of the imports running in this process, by resolved path. */
const live = new Set<string>();
const liveKey = (p: string) => resolve(p).toLowerCase();

/**
 * Move a finished staging folder to `walks/<id>/`, taking the first free id. The move itself
 * takes the id: when another import took it meanwhile the move fails because the folder exists,
 * and the next free id is tried with `walk.json` written for it. A move that is refused while the
 * target does not exist means another program holds a file of the folder open (antivirus, the
 * search indexer): it is tried again for about half a minute before it fails.
 */
async function place(
  walksDir: string,
  staging: string,
  base: string,
  describe: (id: string) => WalkFile,
  move: RenameOptions | undefined,
): Promise<WalkFile> {
  for (let attempt = 0; ; attempt++) {
    const taken = new Set((await readdir(walksDir)).map((n) => n.toLowerCase()));
    const walk = describe(uniqueId(base, (x) => taken.has(x)));
    await writeFile(join(staging, 'walk.json'), `${JSON.stringify(walk, null, 2)}\n`);
    const target = join(walksDir, walk.id);
    try {
      await renameWhenFree(staging, target, { ...move, giveUp: () => exists(target) });
      return walk;
    } catch (e) {
      if (!(await exists(target)) || attempt >= 20) throw e;
    }
  }
}

/** The walk a finished staging folder holds: its `walk.json` reads and the video is there. */
async function finishedIn(staging: string): Promise<WalkFile | null> {
  const file = join(staging, 'walk.json');
  try {
    if ((await stat(file)).size > WALK_JSON_MAX_BYTES) return null;
    const r = readVersioned(JSON.parse(await readFile(file, 'utf8')) as unknown, {
      family: 'aio.walk',
      schema: WalkFile,
    });
    return r.ok && (await exists(join(staging, 'playback.mp4'))) ? r.value : null;
  } catch {
    return null;
  }
}

/**
 * Clear what earlier imports left in `walks/`: a staging folder no running import of this process
 * owns. One that holds a finished walk (its move into place was refused, or the app stopped just
 * before it) is moved into place now and returned; any other is half a copy and is removed.
 * Failures are ignored: a folder that cannot be removed or moved now is tried at the next import.
 */
export async function sweepStaging(root: string, move?: RenameOptions): Promise<WalkFile[]> {
  const walksDir = join(root, WALKS_DIR);
  let names: string[];
  try {
    names = (await readdir(walksDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith('.staging-'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const adopted: WalkFile[] = [];
  for (const n of names) {
    const staging = join(walksDir, n);
    if (live.has(liveKey(staging))) continue;
    // cancelled: what is left is cleared or adopted by the next import
    if (move?.signal?.aborted) break;
    try {
      const done = await finishedIn(staging);
      if (!done) {
        await rm(staging, { recursive: true, force: true });
        continue;
      }
      const poster = await exists(join(staging, 'poster.jpg'));
      const under = (id: string): WalkFile => {
        const next: Record<string, unknown> = {
          ...done,
          id,
          video: { ...done.video, src: `${WALKS_DIR}/${id}/playback.mp4` },
        };
        if (poster) next.poster = `${WALKS_DIR}/${id}/poster.jpg`;
        else delete next.poster;
        return WalkFile.parse(next);
      };
      adopted.push(await place(walksDir, staging, done.id, under, move));
    } catch {
      // still held open, or gone meanwhile: the next import tries again
    }
  }
  return adopted;
}

/**
 * Bring one 360 video into the project. A camera file (`.insv`, `.lrv`) is stitched; a stitched
 * MP4 or MOV is stored as it is when Chromium plays it, else as a smaller playback copy.
 *
 * - Everything that can refuse the file is checked before the long work: the layout, ffmpeg, and
 *   that the walk's description can be saved. When ffmpeg is needed and missing, nothing is
 *   written at all.
 * - The walk is built in a staging folder of its own and moved into `walks/<id>/` last. A copy
 *   that fails leaves nothing behind. A copy that was finished but could not be moved (another
 *   program held it open for half a minute) is kept, and the next import of the file adds it
 *   without a new stitch.
 * - There is no list file to keep in step: the walks of a project are its `walks/` folders. The
 *   id is taken by the move itself, so two imports that finish close together both keep their
 *   walk.
 */
export async function importWalk(
  root: string,
  file: string,
  o: WalkImportOptions,
): Promise<WalkImportResult> {
  const name = basename(file);
  const stem = name.slice(0, name.length - extname(name).length);
  if (o.signal?.aborted) return { ok: false, status: 'skipped', message: CANCELLED_BEFORE };
  let tracks: WalkTrack[];
  try {
    tracks = await o.tools.tracks(file);
  } catch (e) {
    return { ok: false, status: 'error', message: `Could not read the video: ${text(e)}` };
  }
  const kind = classifyWalkSource({ name, tracks });
  if (!kind.ok) return { ok: false, status: 'skipped', message: kind.message };
  const first = kind.video[0];
  if (!first) return { ok: false, status: 'skipped', message: 'The file has no video track.' };

  const durationS = first.durationMs / 1000;
  const named = insta360Name(name);
  const streams: WalkStream[] = kind.video.map((t) => ({
    width: t.width,
    height: t.height,
    codec: t.codec,
    fps: r3(t.fps),
  }));
  const createdAt = (o.now?.() ?? new Date()).toISOString();
  let bytes: number;
  try {
    bytes = (await stat(file)).size;
  } catch (e) {
    return { ok: false, status: 'error', message: `Could not read the video: ${text(e)}` };
  }
  type Made = FrameSize & { fps: number; encoder?: string; filter?: string };
  const describe = (id: string, made: Made, extra: { poster: boolean; trailer?: boolean }) =>
    WalkFile.parse({
      schema: WALK_SCHEMA,
      id,
      name: stem.slice(0, NAME_MAX),
      createdAt,
      source: {
        file: name.slice(0, FILE_MAX),
        bytes,
        layout: kind.layout,
        ...(extra.trailer !== undefined ? { trailer: extra.trailer } : {}),
        ...(named ? { capturedAt: named.capturedAt } : {}),
        streams,
        ...(kind.lowRes ? { lowRes: true } : {}),
      },
      video: {
        src: `${WALKS_DIR}/${id}/playback.mp4`,
        width: made.width,
        height: made.height,
        durationS: r3(durationS),
        fps: r3(made.fps),
        audio: kind.audio,
      },
      ...(extra.poster ? { poster: `${WALKS_DIR}/${id}/poster.jpg` } : {}),
      ...(kind.layout !== 'equirect' && made.filter
        ? {
            stitch: {
              tool: 'ffmpeg',
              filter: made.filter,
              fovDeg: WALK_DEFAULTS.fovDeg,
              encoder: made.encoder ?? 'unknown',
            },
          }
        : {}),
    });

  // what would be saved is checked now, not after minutes of stitching
  const base = walkIdFor(stem);
  try {
    describe(base, { width: first.width, height: first.height, fps: first.fps }, { poster: false });
  } catch {
    return {
      ok: false,
      status: 'error',
      message:
        'The 360 video was not added: its length, frame rate or size could not be read well enough to save it.',
    };
  }

  // a playback copy an earlier import of this file finished but could not move into place
  // (with the import's signal: a kept folder that is still held open must not make a cancelled
  // import wait half a minute for it)
  const moving: RenameOptions = { ...o.move, ...(o.signal ? { signal: o.signal } : {}) };
  const again = (await sweepStaging(root, moving)).find(
    (w) => w.source.file === name.slice(0, FILE_MAX) && w.source.bytes === bytes,
  );
  if (again)
    return {
      ok: true,
      walk: again,
      message: `The playback copy an earlier import of this file had finished (${px(again.video)}) is now in the project; nothing was stitched again. ${OPEN_HINT}`,
    };

  // cancelled while the leftovers of earlier imports were cleared
  if (o.signal?.aborted) return { ok: false, status: 'skipped', message: WALK_CANCELLED };

  const direct =
    kind.layout === 'equirect' &&
    DIRECT_CODECS.has(first.codec) &&
    first.width <= WALK_DEFAULTS.width;
  if (!direct) {
    const missing = ffmpegMissingMessage(
      await o.tools.check(),
      kind.layout === 'equirect' ? 'copy' : 'stitch',
    );
    if (missing) return { ok: false, status: 'error', message: missing };
  }

  const walksDir = join(root, WALKS_DIR);
  await mkdir(walksDir, { recursive: true });
  const staging = join(walksDir, `.staging-${base}-${randomBytes(4).toString('hex')}`);
  live.add(liveKey(staging));
  /** The copy, the poster and `walk.json` are written: only the move into place is left. */
  let finished = false;
  try {
    await mkdir(staging);
    const video = join(staging, 'playback.mp4');
    let made: Made;
    if (direct) {
      await copyFile(file, video);
      if (o.signal?.aborted) throw new Error('Cancelled.');
      made = { width: first.width, height: first.height, fps: first.fps };
      o.onProgress?.(1);
    } else {
      made = await o.tools.copy(video, {
        input: file,
        layout: kind.layout,
        lens: { width: first.width, height: first.height },
        srcFps: first.fps,
        audio: kind.audio,
        durationS,
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
    }
    let poster = false;
    if (o.tools.poster) {
      try {
        await o.tools.poster(video, Math.min(1, durationS / 2), join(staging, 'poster.jpg'));
        poster = true;
      } catch {
        poster = false;
      }
    }
    const trailer = o.tools.trailer ? await o.tools.trailer(file).catch(() => false) : undefined;
    // cancelled while the copy or the poster was made: the walk is not added
    if (o.signal?.aborted) throw new Error('Cancelled.');
    const extra = { poster, ...(trailer !== undefined ? { trailer } : {}) };
    await writeFile(
      join(staging, 'walk.json'),
      `${JSON.stringify(describe(base, made, extra), null, 2)}\n`,
    );
    finished = true;
    const walk = await place(walksDir, staging, base, (id) => describe(id, made, extra), moving);

    const parts: string[] = [];
    if (kind.layout === 'insv-dual-stream')
      parts.push(
        `Stitched to ${px(made)} for playback from two lens streams of ${px(first)}; the original stays where it is.`,
      );
    else if (kind.layout === 'dual-fisheye')
      parts.push(`Stitched to ${px(made)} for playback; the original stays where it is.`);
    else if (direct) parts.push(`Stored as it is (${px(made)}).`);
    else
      parts.push(
        `Playback copy at ${px(made)} (H.264) from ${px(first)}; the original stays where it is.`,
      );
    if (kind.lowRes) {
      const beside = isProxyName(name)
        ? proxyOwner(name, await readdir(dirname(file)).catch(() => []))
        : null;
      parts.push(
        beside
          ? `This is the camera's low resolution copy. Import ${beside}, which lies beside it, for a sharper picture.`
          : "This is the camera's low resolution copy, so the picture is soft.",
      );
    }
    parts.push(OPEN_HINT);
    return { ok: true, walk, message: parts.join(' ') };
  } catch (e) {
    const cancelled = o.signal?.aborted === true && o.signal.reason !== QUIT_REASON;
    if (finished && !cancelled) {
      // the long work is done and only the last step failed: never thrown away. The next import
      // of the file finds the folder and adds it.
      const kept = 'It was kept. Import the file again and it is added without a new stitch.';
      const why =
        o.signal?.aborted === true
          ? 'the app was closed before it was moved into the project.'
          : isLockedError(e)
            ? 'it could not be moved into the project: another program (antivirus, a search indexer or a file sync) kept one of its files open.'
            : `it could not be added to the project (${text(e)}).`;
      return {
        ok: false,
        status: 'error',
        message: `The playback copy was made, but ${why} ${kept}`,
      };
    }
    // not finished, or the person cancelled (also while the finished folder waited to be moved):
    // nothing of it stays
    await removeStaging(staging);
    if (o.signal?.aborted) return { ok: false, status: 'skipped', message: WALK_CANCELLED };
    return { ok: false, status: 'error', message: `The 360 video was not added: ${text(e)}` };
  } finally {
    live.delete(liveKey(staging));
  }
}

/**
 * The walks of a project folder: every `walks/<id>/walk.json` that reads and names its own
 * folder, newest first. Staging folders, broken or oversized files and files of a newer version
 * are left out.
 */
export async function listWalks(root: string): Promise<WalkFile[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, WALKS_DIR), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: WalkFile[] = [];
  for (const n of names) {
    const file = join(root, WALKS_DIR, n, 'walk.json');
    const json = await stat(file)
      .then((s) => (s.size > WALK_JSON_MAX_BYTES ? null : readFile(file, 'utf8')))
      .catch(() => null);
    const walk = parseWalk(json, n);
    if (walk) out.push(walk);
  }
  return sortWalks(out);
}

/** A `walk.json` text as a walk of the folder `id`, or null when it is not one. */
export function parseWalk(json: string | null, id: string): WalkFile | null {
  if (json === null || json.length > WALK_JSON_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const r = readVersioned(raw, { family: 'aio.walk', schema: WalkFile });
  return r.ok && r.value.id === id ? r.value : null;
}

/** Newest first, then by name. */
export function sortWalks(walks: readonly WalkFile[]): WalkFile[] {
  return [...walks].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name),
  );
}
