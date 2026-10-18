/**
 * One frame of a video file as RGBA pixels, decoded with ffmpeg in main (local detection on walk
 * frames). ffmpeg seeks to `t`, scales the frame to the size asked for with area averaging, and
 * writes raw RGBA to its stdout. It runs with an argument list (no shell) and a timeout; a non-zero
 * exit, a timeout or a short picture is an error carrying ffmpeg's last words.
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

/** The ffmpeg arguments that decode one frame at `t` to raw RGBA of `width` x `height`. */
export function frameArgs(file: string, t: number, width: number, height: number): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
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

interface Ran {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

function runFfmpeg(ffmpeg: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { shell: false, windowsHide: true, stdio: 'pipe' });
    const out: Buffer[] = [];
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => {
      err = (err + b.toString('utf8')).slice(-STDERR_KEEP);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err.trim(), timedOut });
    });
  });
}

const lastLine = (s: string) => s.split(/\r?\n/).filter(Boolean).at(-1) ?? '';

/** The frame of `file` at `t` seconds as RGBA of exactly `width` x `height`. */
export async function decodeFrame(opts: {
  ffmpeg: string;
  file: string;
  t: number;
  width: number;
  height: number;
  timeoutMs?: number;
}): Promise<RgbaImage> {
  const { width, height } = opts;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error(`A frame cannot be decoded at ${String(width)} x ${String(height)}.`);
  const timeout = opts.timeoutMs ?? FRAME_TIMEOUT_MS;
  let r: Ran;
  try {
    r = await runFfmpeg(opts.ffmpeg, frameArgs(opts.file, opts.t, width, height), timeout);
  } catch (e) {
    throw new Error(
      `ffmpeg could not be started (${opts.ffmpeg}): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const at = `${opts.t.toFixed(3)} s`;
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
