import {
  WALKS_DIR,
  WALK_SCHEMA,
  WalkFile,
  readVersioned,
  type WalkLayout,
  type WalkStream,
} from '@aio/schema';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
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
}

/** Video reading and ffmpeg work for a walk import, injected by the app. */
export interface WalkTools {
  /** Every track of an MP4-like file; rejects when the file is not one. */
  tracks(file: string): Promise<WalkTrack[]>;
  /** Whether the file ends with the Insta360 trailer mark. */
  trailer?(file: string): Promise<boolean>;
  /** Is ffmpeg there, and can it stitch? */
  check(): Promise<FfmpegCheck>;
  /** Write the equirectangular playback copy to `out`. */
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
}

export type WalkImportResult =
  | { ok: true; walk: WalkFile; message: string }
  | { ok: false; status: 'skipped' | 'error'; message: string };

/** Codecs and sizes Chromium plays without help: such a stitched video is stored as it is. */
const DIRECT_CODECS = new Set(['avc1', 'avc3']);

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
const px = (s: FrameSize) => `${String(s.width)} x ${String(s.height)}`;

const OPEN_HINT = 'Open it under 360 video in the sidebar.';

/**
 * Bring one 360 video into the project. A camera file (`.insv`, `.lrv`) is stitched; a stitched
 * MP4 or MOV is stored as it is when Chromium plays it, else as a smaller playback copy. The
 * walk is built in a staging folder of its own and moved into `walks/<id>/` last, so a failure
 * leaves nothing behind; when ffmpeg is needed and missing, nothing is written at all.
 *
 * There is no list file to keep in step: the walks of a project are its `walks/` folders. The id
 * is taken by the move itself, which fails when the folder exists, and is then chosen again, so
 * two imports that finish close together both keep their walk.
 */
export async function importWalk(
  root: string,
  file: string,
  o: WalkImportOptions,
): Promise<WalkImportResult> {
  const name = basename(file);
  const stem = name.slice(0, name.length - extname(name).length);
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
  const base = slug(stem, 'walk');
  const staging = join(walksDir, `.staging-${base}-${randomBytes(4).toString('hex')}`);
  try {
    await mkdir(staging);
    const durationS = first.durationMs / 1000;
    const video = join(staging, 'playback.mp4');
    let made: FrameSize & { fps: number; encoder?: string; filter?: string };
    if (direct) {
      await copyFile(file, video);
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
    const named = insta360Name(name);
    const trailer = o.tools.trailer ? await o.tools.trailer(file).catch(() => false) : undefined;
    const streams: WalkStream[] = kind.video.map((t) => ({
      width: t.width,
      height: t.height,
      codec: t.codec,
      fps: Math.round(t.fps * 1000) / 1000,
    }));
    const createdAt = (o.now?.() ?? new Date()).toISOString();
    const bytes = (await stat(file)).size;
    const describe = (id: string) =>
      WalkFile.parse({
        schema: WALK_SCHEMA,
        id,
        name: stem,
        createdAt,
        source: {
          file: name,
          bytes,
          layout: kind.layout,
          ...(trailer !== undefined ? { trailer } : {}),
          ...(named ? { capturedAt: named.capturedAt } : {}),
          streams,
          ...(kind.lowRes ? { lowRes: true } : {}),
        },
        video: {
          src: `${WALKS_DIR}/${id}/playback.mp4`,
          width: made.width,
          height: made.height,
          durationS: Math.round(durationS * 1000) / 1000,
          fps: Math.round(made.fps * 1000) / 1000,
          audio: kind.audio,
        },
        ...(poster ? { poster: `${WALKS_DIR}/${id}/poster.jpg` } : {}),
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
    // take the first free id by moving the finished folder into place; when another import took
    // it meanwhile the move fails, and the next free id is tried with walk.json written for it
    let walk = describe(base);
    for (let attempt = 0; ; attempt++) {
      const taken = new Set((await readdir(walksDir)).map((n) => n.toLowerCase()));
      walk = describe(uniqueId(base, (x) => taken.has(x)));
      await writeFile(join(staging, 'walk.json'), `${JSON.stringify(walk, null, 2)}\n`);
      const target = join(walksDir, walk.id);
      try {
        await rename(staging, target);
        break;
      } catch (e) {
        const lost = await stat(target).then(
          () => true,
          () => false,
        );
        if (!lost || attempt >= 20) throw e;
      }
    }

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
    await rm(staging, { recursive: true, force: true });
    return { ok: false, status: 'error', message: `The 360 video was not added: ${text(e)}` };
  }
}

/**
 * The walks of a project folder: every `walks/<id>/walk.json` that reads and names its own
 * folder, newest first. Staging folders, broken files and files of a newer version are left out.
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
    const walk = parseWalk(
      await readFile(join(root, WALKS_DIR, n, 'walk.json'), 'utf8').catch(() => null),
      n,
    );
    if (walk) out.push(walk);
  }
  return sortWalks(out);
}

/** A `walk.json` text as a walk of the folder `id`, or null when it is not one. */
export function parseWalk(json: string | null, id: string): WalkFile | null {
  if (json === null) return null;
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
