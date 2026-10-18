/**
 * One frame of a video file as RGBA pixels, decoded with ffmpeg in main (local detection on walk
 * frames). ffmpeg seeks to `t`, scales the frame to the size asked for with area averaging, and
 * writes raw RGBA to its stdout. It runs with an argument list (no shell) and a timeout; a non-zero
 * exit, a timeout or a short picture is an error carrying ffmpeg's last words. The run's stop
 * signal kills a running decode at once.
 */
import { spawn } from 'node:child_process';
import type { RgbaImage } from './tile';

/** How long one frame decode may take before ffmpeg is stopped. */
export const FRAME_TIMEOUT_MS = 60_000;
/** The stderr kept for an error message (its end, where ffmpeg says what went wrong). */
const STDERR_KEEP = 4000;

/** A frame decoder: the frame of `file` at `t` seconds, scaled to exactly `width` x `height`. */
export type FrameDecoder = (
  file: string,
  t: number,
  width: number,
  height: number,
) => Promise<RgbaImage>;

/**
 * Decoder threads for one frame. ffmpeg's default (one frame thread per core, up to 16) reads and
 * decodes that many frames past t before the first one comes out, so a single 3840 x 1920 frame
 * costs about 3x the CPU (0.39 s against 0.17 s on the playback copy's settings) for no gain in
 * wall time, and much more when the CPU is busy. Two threads give the same picture, byte for byte.
 */
export const FRAME_THREADS = 2;

/** The ffmpeg arguments that decode one frame at `t` to raw RGBA of `width` x `height`. */
export function frameArgs(file: string, t: number, width: number, height: number): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    // before -i: options of the decoder
    '-threads',
    String(FRAME_THREADS),
    // before -i: a fast seek to the key frame, then decoding up to t
    '-ss',
    Math.max(0, t).toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-an',
    '-vf',
    `scale=${String(width)}:${String(height)}:flags=area`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    'pipe:1',
  ];
}

/** The height of a frame scaled to `width` with the source's aspect ratio (at least 1). */
export function scaledHeight(width: number, source: { width: number; height: number }): number {
  return Math.max(1, Math.round((width * source.height) / source.width));
}

const lastLine = (s: string) => s.split(/\r?\n/).filter(Boolean).at(-1) ?? '';

interface Ran {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** The run stopped (`signal`) and the child was killed. */
  aborted: boolean;
}

/** ffmpeg with `args`, killed on the timeout or as soon as `signal` aborts. */
export function runFfmpeg(
  ffmpeg: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { shell: false, windowsHide: true, stdio: 'pipe' });
    const out: Buffer[] = [];
    let err = '';
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => {
      err = (err + b.toString('utf8')).slice(-STDERR_KEEP);
    });
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', (code) => {
      done();
      resolve({ code, stdout: Buffer.concat(out), stderr: err.trim(), timedOut, aborted });
    });
  });
}

/** How long `ffmpeg -version` may take when a run checks that ffmpeg starts. */
const CHECK_TIMEOUT_MS = 15_000;

/**
 * Null when `ffmpeg` starts and answers `-version`, else why walk frames cannot be read: a run
 * checks this once before its first frame instead of skipping every frame.
 */
export async function ffmpegProblem(ffmpeg: string): Promise<string | null> {
  const hint = 'Install the pipeline pack, or put ffmpeg on the PATH.';
  try {
    const r = await runFfmpeg(ffmpeg, ['-hide_banner', '-version'], CHECK_TIMEOUT_MS);
    if (r.code === 0) return null;
    const why = r.timedOut
      ? `no answer in ${String(CHECK_TIMEOUT_MS / 1000)} s`
      : `exit ${String(r.code)}${r.stderr ? `, ${lastLine(r.stderr)}` : ''}`;
    return `Walk frames are read with ffmpeg, and it did not run (${ffmpeg}): ${why}. ${hint}`;
  } catch (e) {
    return `Walk frames are read with ffmpeg, and it could not be started (${ffmpeg}): ${e instanceof Error ? e.message : String(e)}. ${hint}`;
  }
}

/** The frame of `file` at `t` seconds as RGBA of exactly `width` x `height`. */
export async function decodeFrame(opts: {
  ffmpeg: string;
  file: string;
  t: number;
  width: number;
  height: number;
  timeoutMs?: number;
  /** The run's stop: ffmpeg is killed at once and the decode fails as stopped. */
  signal?: AbortSignal;
}): Promise<RgbaImage> {
  const { width, height } = opts;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error(`A frame cannot be decoded at ${String(width)} x ${String(height)}.`);
  const timeout = opts.timeoutMs ?? FRAME_TIMEOUT_MS;
  const at = `${opts.t.toFixed(3)} s`;
  const stopped = () => new Error(`The frame decode at ${at} was stopped.`);
  if (opts.signal?.aborted) throw stopped();
  let r: Ran;
  try {
    r = await runFfmpeg(
      opts.ffmpeg,
      frameArgs(opts.file, opts.t, width, height),
      timeout,
      opts.signal,
    );
  } catch (e) {
    throw new Error(
      `ffmpeg could not be started (${opts.ffmpeg}): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  if (r.aborted) throw stopped();
  if (r.timedOut)
    throw new Error(`ffmpeg took longer than ${String(timeout / 1000)} s for the frame at ${at}.`);
  if (r.code !== 0)
    throw new Error(
      `ffmpeg could not decode the frame at ${at} (exit ${String(r.code)}): ${lastLine(r.stderr) || 'no message'}`,
    );
  const want = width * height * 4;
  if (r.stdout.length < want)
    throw new Error(
      r.stdout.length === 0
        ? `The video has no frame at ${at}.`
        : `ffmpeg gave ${String(r.stdout.length)} bytes for the frame at ${at}, not ${String(want)}.`,
    );
  return { width, height, rgba: new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, want) };
}

/** The picture size of the first video stream in ffmpeg's description of an input, or null. */
export function parseVideoSize(stderr: string): { width: number; height: number } | null {
  for (const line of stderr.split(/\r?\n/)) {
    if (!/Stream #\d+:\d+.*: Video: /.test(line)) continue;
    const m = /[\s,](\d{2,5})x(\d{2,5})(?=[\s,[]|$)/.exec(line.slice(line.indexOf(': Video: ')));
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  return null;
}

/** The picture size of a video file, as ffmpeg reads it. */
export async function videoSize(
  ffmpeg: string,
  file: string,
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<{ width: number; height: number }> {
  // with no output ffmpeg describes the input and exits with 1: the description is what we need
  const r = await runFfmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-i', file], timeoutMs);
  const size = parseVideoSize(r.stderr);
  if (!size) throw new Error(`ffmpeg found no video picture in ${file}: ${lastLine(r.stderr)}`);
  return size;
}
