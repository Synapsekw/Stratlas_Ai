import type { WalkLayout } from '@aio/schema';
import { execFile, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  detectProxyEncoder,
  encoderArgs,
  parseRate,
  proxyRate,
  rateText,
  rateValue,
  type FfmpegBin,
  type ProxyEncoder,
} from './proxy';

const run = promisify(execFile);

/**
 * Playback copies of 360 video: the two fisheye pictures of a 360 camera file stitched into one
 * equirectangular H.264 MP4 (ffmpeg `v360`), or a stitched video scaled down for playback. Like
 * the drone review copy (`proxy.ts`) it is yuv420p, faststart and has frequent keyframes; unlike
 * it, the sound is kept. ffmpeg is an external program found on the PATH.
 */
export const WALK_DEFAULTS = {
  /** Largest equirectangular width; the height is half of it. */
  width: 3840,
  maxFps: 30,
  /** Seconds between keyframes: scrubbing a walk lands within half a second. */
  keyframeS: 0.5,
  quality: 23,
  maxKbps: 16_000,
  /** Field of view of each lens in degrees (Insta360 X series; no per-lens calibration yet). */
  fovDeg: 195,
  audioKbps: 128,
} as const;

export interface FrameSize {
  width: number;
  height: number;
}

const down = (v: number, step: number) => Math.max(step, Math.floor(v / step) * step);

/**
 * Size of the playback copy. Two lens streams unwrap to twice the lens width, one frame with both
 * lenses to its own width; both are capped at `maxW`, never upscaled, and come out 2:1 with even
 * sides. A stitched video keeps its own shape.
 */
export function walkSize(
  layout: WalkLayout,
  width: number,
  height: number,
  maxW: number = WALK_DEFAULTS.width,
): FrameSize {
  if (layout === 'equirect') {
    const w = down(Math.min(maxW, width), 2);
    return { width: w, height: w === width ? down(height, 2) : down((w * height) / width, 2) };
  }
  const full = layout === 'insv-dual-stream' ? width * 2 : width;
  const w = down(Math.min(maxW, full), 4);
  return { width: w, height: w / 2 };
}

/** The projection step: two fisheye pictures side by side to one equirectangular frame. */
export function v360Filter(fovDeg: number, width: number, height: number): string {
  const fov = String(fovDeg);
  return `v360=input=dfisheye:output=e:ih_fov=${fov}:iv_fov=${fov}:w=${String(width)}:h=${String(height)}`;
}

interface CopyCommon {
  input: string;
  out: string;
  /** Source frame rate as ffprobe reports it ("60000/1001") or a number. */
  srcFps: string | number;
  encoder: ProxyEncoder;
  /** Keep the first sound track as stereo AAC. */
  audio: boolean;
  maxFps?: number;
  keyframeS?: number;
  quality?: number;
  maxKbps?: number;
  /** Stop after this many seconds of input (checks on real footage). */
  limitS?: number;
}

export interface StitchOptions extends CopyCommon {
  layout: Exclude<WalkLayout, 'equirect'>;
  /** Size of one video track of the source. */
  lens: FrameSize;
  fovDeg?: number;
  /** Largest output width. */
  width?: number;
}

function rates(o: CopyCommon) {
  const src = parseRate(o.srcFps);
  const out = proxyRate(src, o.maxFps ?? WALK_DEFAULTS.maxFps);
  const keyS = o.keyframeS ?? WALK_DEFAULTS.keyframeS;
  return {
    out,
    halve: rateValue(out) < rateValue(src) - 0.01,
    keyS,
    gop: Math.max(1, Math.round(rateValue(out) * keyS)),
  };
}

function finish(o: CopyCommon, graph: string, gop: number, keyS: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    ...(o.limitS !== undefined ? ['-t', String(o.limitS)] : []),
    '-i',
    o.input,
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    ...(o.audio
      ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', `${String(WALK_DEFAULTS.audioKbps)}k`, '-ac', '2']
      : ['-an']),
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    ...encoderArgs(
      o.encoder,
      o.quality ?? WALK_DEFAULTS.quality,
      o.maxKbps ?? WALK_DEFAULTS.maxKbps,
      gop,
    ),
    '-force_key_frames',
    `expr:gte(t,n_forced*${String(keyS)})`,
    '-pix_fmt',
    'yuv420p',
    '-color_range',
    'tv',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    o.out,
  ];
}

/**
 * ffmpeg arguments (without the executable) that stitch a 360 camera file into its playback
 * copy. Each lens stream is brought to the output rate first, so the costly steps run on half the
 * frames of a 59.94 fps clip. Pure, so it is unit tested.
 */
export function stitchArgs(o: StitchOptions): string[] {
  // callers outside TypeScript (tools) can still hand in a stitched layout
  const layout = o.layout as WalkLayout;
  if (layout === 'equirect') throw new Error('A stitched video needs no stitch.');
  const { out, halve, keyS, gop } = rates(o);
  const size = walkSize(layout, o.lens.width, o.lens.height, o.width ?? WALK_DEFAULTS.width);
  const fps = halve ? `fps=${rateText(out)}` : '';
  const v360 = v360Filter(o.fovDeg ?? WALK_DEFAULTS.fovDeg, size.width, size.height);
  const tail = `${v360},scale=out_range=tv,format=yuv420p[v]`;
  const graph =
    layout === 'insv-dual-stream'
      ? fps
        ? `[0:v:0]${fps}[l];[0:v:1]${fps}[r];[l][r]hstack=inputs=2,${tail}`
        : `[0:v:0][0:v:1]hstack=inputs=2,${tail}`
      : `[0:v:0]${fps ? `${fps},` : ''}${tail}`;
  return finish(o, graph, gop, keyS);
}

export interface EquirectCopyOptions extends CopyCommon {
  /** Output size (`walkSize('equirect', ...)`). */
  width: number;
  height: number;
}

/** ffmpeg arguments for the playback copy of a video that is already equirectangular. */
export function equirectCopyArgs(o: EquirectCopyOptions): string[] {
  const { out, halve, keyS, gop } = rates(o);
  const steps = [
    ...(halve ? [`fps=${rateText(out)}`] : []),
    `scale=${String(o.width)}:${String(o.height)}:flags=lanczos:out_range=tv`,
    'format=yuv420p',
  ];
  return finish(o, `[0:v:0]${steps.join(',')}[v]`, gop, keyS);
}

/** Whether `ffmpeg -filters` lists the `v360` filter. */
export function hasV360(filtersText: string): boolean {
  return /^\s*\S+\s+v360\s+/m.test(filtersText);
}

/** The latest output time in a chunk of `ffmpeg -progress` output, seconds; null when none. */
export function progressSeconds(chunk: string): number | null {
  let last: number | null = null;
  for (const m of chunk.matchAll(/^out_time_(?:us|ms)=(\d+)\s*$/gm)) last = Number(m[1]) / 1e6;
  return last;
}

const ffmpegOf = (b?: FfmpegBin) => b?.ffmpeg ?? process.env.FFMPEG ?? 'ffmpeg';

export type FfmpegCheck =
  | { ok: true; v360: boolean; version: string }
  | { ok: false; reason: 'missing' | 'failed'; detail?: string };

/** Is ffmpeg there, and can it stitch (the `v360` filter)? Never throws. */
export async function checkFfmpeg(bin?: FfmpegBin): Promise<FfmpegCheck> {
  const ff = ffmpegOf(bin);
  try {
    const opts = { maxBuffer: 1 << 22, windowsHide: true, timeout: 30_000 };
    const version = (await run(ff, ['-hide_banner', '-version'], opts)).stdout;
    const filters = (await run(ff, ['-hide_banner', '-filters'], opts)).stdout;
    return {
      ok: true,
      v360: hasV360(filters),
      version: /^ffmpeg version (\S+)/m.exec(version)?.[1] ?? 'unknown',
    };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

const INSTALL =
  'Install a full ffmpeg build (on Windows: winget install Gyan.FFmpeg), check that the command ffmpeg runs in a terminal (it has to be on the PATH), restart the app and import the file again. Nothing was added to the project.';

/**
 * What to tell the person when ffmpeg cannot do the job, or null when it can. `stitch` needs the
 * `v360` filter; `copy` (a video that is already stitched) only needs ffmpeg itself.
 */
export function ffmpegMissingMessage(
  check: FfmpegCheck,
  need: 'stitch' | 'copy' = 'stitch',
): string | null {
  const job =
    need === 'stitch'
      ? 'stitch the two lens pictures of a 360 camera file'
      : 'make a playback copy of this 360 video';
  if (!check.ok) {
    return check.reason === 'missing'
      ? `ffmpeg was not found, and the app needs it to ${job}. ${INSTALL}`
      : `ffmpeg could not be started (${check.detail ?? 'unknown error'}), and the app needs it to ${job}. ${INSTALL}`;
  }
  if (need === 'stitch' && !check.v360)
    return `The installed ffmpeg (version ${check.version}) has no v360 filter, which the app needs to ${job}. The filter is in ffmpeg 4.3 and later. ${INSTALL}`;
  return null;
}

export interface RunFfmpegOptions {
  bin?: FfmpegBin;
  /** Output time reached so far, seconds (from `-progress`). */
  onSeconds?: (s: number) => void;
  /** Aborting kills ffmpeg; the promise rejects. */
  signal?: AbortSignal;
}

/** Run ffmpeg with machine-readable progress on stdout. Rejects with ffmpeg's own last words. */
export function runFfmpeg(args: readonly string[], o: RunFfmpegOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new Error('Cancelled.'));
      return;
    }
    const child = spawn(ffmpegOf(o.bin), ['-progress', 'pipe:1', '-nostats', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      child.kill();
    };
    o.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const s = progressSeconds(chunk);
      if (s !== null) o.onSeconds?.(s);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err = (err + chunk).slice(-4000);
    });
    child.on('error', (e) => {
      o.signal?.removeEventListener('abort', abort);
      reject((e as { code?: unknown }).code === 'ENOENT' ? new Error('ffmpeg was not found.') : e);
    });
    child.on('close', (code) => {
      o.signal?.removeEventListener('abort', abort);
      if (cancelled) reject(new Error('Cancelled.'));
      else if (code === 0) resolve();
      else {
        const line = err.trim().split(/\r?\n/).filter(Boolean).at(-1);
        reject(new Error(line ?? `ffmpeg stopped with code ${String(code)}.`));
      }
    });
  });
}

export interface WalkCopyOptions {
  input: string;
  layout: WalkLayout;
  /** Size of one video track of the source. */
  lens: FrameSize;
  srcFps: string | number;
  audio: boolean;
  /** Length of the source in seconds, for the progress fraction. */
  durationS: number;
  encoder?: ProxyEncoder;
  bin?: FfmpegBin;
  /** 0 to 1 as the copy is written. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  limitS?: number;
  /** How ffmpeg is run (tests hand in a stand-in). */
  run?: (args: readonly string[], o?: RunFfmpegOptions) => Promise<void>;
}

export interface WalkCopy extends FrameSize {
  encoder: ProxyEncoder;
  fps: number;
  /** The projection filter used (absent for a stitched source). */
  filter?: string;
  seconds: number;
}

/**
 * Write the playback copy of a 360 video to `out`. A failed attempt with a hardware encoder is
 * retried on the CPU (libx264), as the drone review copy does. Decoding stays on the CPU: the
 * stitch filters need the frames in memory anyway.
 *
 * The copy is written under its final name, with no temporary file renamed at the end: the caller
 * gives a path nothing reads yet (the walk import's own staging folder, moved into place as a
 * whole), and a rename that Windows refuses while another program has the file open would throw
 * away minutes of work or run the whole stitch again. A failed attempt removes what it wrote.
 */
export async function makeWalkCopy(out: string, o: WalkCopyOptions): Promise<WalkCopy> {
  const encoder = o.encoder ?? (await detectProxyEncoder(o.bin));
  const size = walkSize(o.layout, o.lens.width, o.lens.height);
  const fps = rateValue(proxyRate(parseRate(o.srcFps), WALK_DEFAULTS.maxFps));
  const total = Math.max(
    0.001,
    o.limitS !== undefined ? Math.min(o.limitS, o.durationS) : o.durationS,
  );
  const run = o.run ?? runFfmpeg;
  const t0 = Date.now();
  const attempts: ProxyEncoder[] = encoder === 'libx264' ? ['libx264'] : [encoder, 'libx264'];
  let last: unknown;
  for (const enc of attempts) {
    const common = {
      input: o.input,
      out,
      srcFps: o.srcFps,
      encoder: enc,
      audio: o.audio,
      ...(o.limitS !== undefined ? { limitS: o.limitS } : {}),
    };
    const args =
      o.layout === 'equirect'
        ? equirectCopyArgs({ ...common, ...size })
        : stitchArgs({ ...common, layout: o.layout, lens: o.lens });
    try {
      await run(args, {
        ...(o.bin ? { bin: o.bin } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        onSeconds: (s) => o.onProgress?.(Math.max(0, Math.min(1, s / total))),
      });
      return {
        ...size,
        encoder: enc,
        fps,
        ...(o.layout === 'equirect'
          ? {}
          : { filter: v360Filter(WALK_DEFAULTS.fovDeg, size.width, size.height) }),
        seconds: (Date.now() - t0) / 1000,
      };
    } catch (e) {
      last = e;
      await rm(out, { force: true }).catch(() => undefined);
      if (o.signal?.aborted) break;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
