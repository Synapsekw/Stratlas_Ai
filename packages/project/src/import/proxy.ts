import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Review proxies of drone recordings: web-playable H.264 MP4 (yuv420p, faststart, a keyframe
 * every second so seeking is instant), at most 1920 px wide, no audio. Originals stay where they
 * are; a project only carries its proxies.
 */
export type ProxyEncoder = 'h264_nvenc' | 'h264_qsv' | 'libx264';

/** Hardware encoders first; libx264 always works. */
export const PROXY_ENCODERS: readonly ProxyEncoder[] = ['h264_nvenc', 'h264_qsv', 'libx264'];

export interface Rate {
  num: number;
  den: number;
}

export interface ProxyOptions {
  /** One recording, or the chapters of one recording in order (joined without a gap). */
  inputs: readonly string[];
  out: string;
  encoder: ProxyEncoder;
  /** Source frame rate as ffprobe reports it ("30000/1001", "50/1") or a number. */
  srcFps: string | number;
  /** Largest output width in pixels; never upscales; height keeps the aspect (even). */
  width?: number;
  /** Rates above this are halved (50 to 25, 59.94 to 29.97); timing is kept, frames dropped. */
  maxFps?: number;
  /** Seconds between keyframes. */
  keyframeS?: number;
  /** CRF for libx264, CQ for NVENC, global_quality for QSV (lower is better). */
  quality?: number;
  /** Peak bitrate in kbit/s. */
  maxKbps?: number;
  /**
   * GPU decoding (`-hwaccel`): `cuda` (NVDEC), `auto`, or `none`. Defaults to `cuda` with NVENC,
   * `auto` with QSV and `none` with libx264. Codecs the GPU cannot decode (ProRes) fall back to
   * the CPU inside ffmpeg.
   */
  hwDecode?: 'cuda' | 'auto' | 'none';
}

export const PROXY_DEFAULTS = {
  width: 1920,
  maxFps: 30,
  keyframeS: 1,
  quality: 24,
  maxKbps: 8_000,
} as const;

/** "30000/1001", "25", 29.97 to a rational; throws on anything else. */
export function parseRate(r: string | number): Rate {
  if (typeof r === 'number') {
    if (!(r > 0)) throw new Error(`Bad frame rate ${String(r)}`);
    const ntsc = Math.round(r * 1.001);
    if (Math.abs(ntsc / 1.001 - r) < 0.005 && Math.abs(ntsc - r) > 0.005)
      return { num: ntsc * 1000, den: 1001 };
    return { num: Math.round(r * 1000), den: 1000 };
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+)\s*)?$/.exec(r);
  const num = Number(m?.[1]);
  const den = Number(m?.[2] ?? 1);
  if (!m || !(num > 0) || !(den > 0)) throw new Error(`Bad frame rate "${r}"`);
  if (!Number.isInteger(num)) return parseRate(num / den);
  return { num, den };
}

export const rateValue = (r: Rate) => r.num / r.den;
const rateText = (r: Rate) => (r.den === 1 ? String(r.num) : `${String(r.num)}/${String(r.den)}`);

/** Output rate: the source rate, halved while above `maxFps`. */
export function proxyRate(src: Rate, maxFps: number = PROXY_DEFAULTS.maxFps): Rate {
  let r = src;
  while (rateValue(r) > maxFps + 0.01) r = { num: r.num, den: r.den * 2 };
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function encoderArgs(e: ProxyEncoder, quality: number, maxKbps: number, gop: number): string[] {
  const q = String(quality);
  const g = String(gop);
  const rate = `-maxrate ${String(maxKbps)}k -bufsize ${String(maxKbps * 2)}k`;
  const words: Record<ProxyEncoder, string> = {
    h264_nvenc: `-c:v h264_nvenc -preset p5 -tune hq -profile:v high -rc vbr -cq ${q} -b:v 0 ${rate} -spatial-aq 1 -bf 2 -g ${g} -no-scenecut 1`,
    h264_qsv: `-c:v h264_qsv -preset medium -profile:v high -global_quality ${q} ${rate} -bf 2 -g ${g}`,
    libx264: `-c:v libx264 -preset faster -profile:v high -crf ${q} ${rate} -g ${g} -keyint_min ${g} -sc_threshold 0`,
  };
  return words[e].split(' ');
}

/** ffmpeg arguments (without the executable) for one proxy. Pure, so it is unit tested. */
export function proxyArgs(o: ProxyOptions): string[] {
  if (o.inputs.length === 0) throw new Error('A proxy needs at least one input.');
  const width = o.width ?? PROXY_DEFAULTS.width;
  const keyS = o.keyframeS ?? PROXY_DEFAULTS.keyframeS;
  const src = parseRate(o.srcFps);
  const out = proxyRate(src, o.maxFps ?? PROXY_DEFAULTS.maxFps);
  const gop = Math.max(1, Math.round(rateValue(out) * keyS));
  const hw =
    o.hwDecode ??
    (o.encoder === 'h264_nvenc' ? 'cuda' : o.encoder === 'h264_qsv' ? 'auto' : 'none');
  const decode = hw === 'none' ? [] : ['-hwaccel', hw];
  const inputs = o.inputs.flatMap((f) => [...decode, '-i', f]);
  const join =
    o.inputs.length > 1
      ? `${o.inputs.map((_, i) => `[${String(i)}:v:0]`).join('')}concat=n=${String(o.inputs.length)}:v=1:a=0,`
      : '[0:v:0]';
  const steps = [
    ...(rateValue(out) < rateValue(src) - 0.01 ? [`fps=${rateText(out)}`] : []),
    `scale='min(${String(width)},iw)':-2:flags=lanczos:out_range=tv`,
    'format=yuv420p',
  ];
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    `${join}${steps.join(',')}[v]`,
    '-map',
    '[v]',
    '-an',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    ...encoderArgs(
      o.encoder,
      o.quality ?? PROXY_DEFAULTS.quality,
      o.maxKbps ?? PROXY_DEFAULTS.maxKbps,
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

/** ffmpeg arguments for a JPEG poster at `atS` seconds, at most `maxW` wide. */
export function posterArgs(video: string, atS: number, out: string, maxW = 960): string[] {
  return [
    '-hide_banner',
    '-nostdin',
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
    `scale='min(${String(maxW)},iw)':-2`,
    '-q:v',
    '3',
    '-update',
    '1',
    out,
  ];
}

/** The first encoder that `ffmpeg -encoders` lists and that `works` confirms. */
export async function pickEncoder(
  encodersText: string,
  works: (e: ProxyEncoder) => Promise<boolean>,
): Promise<ProxyEncoder> {
  for (const e of PROXY_ENCODERS) {
    if (e === 'libx264') return e;
    if (!new RegExp(`\\s${e}\\s`).test(encodersText)) continue;
    if (await works(e)) return e;
  }
  return 'libx264';
}

export interface FfmpegBin {
  ffmpeg?: string;
  ffprobe?: string;
}

const ffmpegOf = (b?: FfmpegBin) => b?.ffmpeg ?? process.env.FFMPEG ?? 'ffmpeg';
const ffprobeOf = (b?: FfmpegBin) => b?.ffprobe ?? process.env.FFPROBE ?? 'ffprobe';

/** Hardware H.264 encoding if this machine really has it (a listed encoder can still fail). */
export async function detectProxyEncoder(bin?: FfmpegBin): Promise<ProxyEncoder> {
  const ff = ffmpegOf(bin);
  let text: string;
  try {
    text = (await run(ff, ['-hide_banner', '-encoders'], { windowsHide: true })).stdout;
  } catch {
    return 'libx264';
  }
  return pickEncoder(text, async (e) => {
    try {
      await run(
        ff,
        [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=1280x720:r=30:d=0.5',
          '-c:v',
          e,
          '-f',
          'null',
          '-',
        ],
        { timeout: 30_000, windowsHide: true },
      );
      return true;
    } catch {
      return false;
    }
  });
}

export interface ProbedVideo {
  width: number;
  height: number;
  durationS: number;
  rate: string;
  codec: string;
}

export async function probeProxySource(file: string, bin?: FfmpegBin): Promise<ProbedVideo> {
  const { stdout } = await run(
    ffprobeOf(bin),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,r_frame_rate:format=duration',
      '-of',
      'json',
      file,
    ],
    { maxBuffer: 1 << 20, windowsHide: true },
  );
  const j = JSON.parse(stdout) as {
    streams?: { codec_name?: string; width?: number; height?: number; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const s = j.streams?.[0];
  if (!s) throw new Error(`No video stream in ${file}`);
  return {
    codec: s.codec_name ?? 'unknown',
    width: s.width ?? 0,
    height: s.height ?? 0,
    durationS: Number(j.format?.duration ?? 0),
    rate: s.r_frame_rate ?? '0/1',
  };
}

export interface MakeProxyOptions extends Omit<ProxyOptions, 'out' | 'srcFps' | 'encoder'> {
  encoder?: ProxyEncoder;
  bin?: FfmpegBin;
}

/**
 * Encode a proxy to a temporary name next to `out`, then rename it into place, so a reader never
 * sees half a file. A failed attempt is retried on the CPU (libx264, no GPU decoding).
 */
export async function makeProxy(
  out: string,
  o: MakeProxyOptions,
): Promise<{ encoder: ProxyEncoder; seconds: number; source: ProbedVideo }> {
  const first = o.inputs[0];
  if (first === undefined) throw new Error('A proxy needs at least one input.');
  const source = await probeProxySource(first, o.bin);
  const encoder = o.encoder ?? (await detectProxyEncoder(o.bin));
  const tmp = `${out}.part`;
  const t0 = Date.now();
  const attempts: Pick<ProxyOptions, 'encoder' | 'hwDecode'>[] = [
    { encoder, ...(o.hwDecode ? { hwDecode: o.hwDecode } : {}) },
  ];
  if (encoder !== 'libx264' || (o.hwDecode ?? 'none') !== 'none')
    attempts.push({ encoder: 'libx264', hwDecode: 'none' });
  let last: unknown;
  for (const a of attempts) {
    try {
      await run(ffmpegOf(o.bin), proxyArgs({ ...o, ...a, out: tmp, srcFps: source.rate }), {
        maxBuffer: 1 << 24,
        windowsHide: true,
      });
      await rename(tmp, out);
      return { encoder: a.encoder, seconds: (Date.now() - t0) / 1000, source };
    } catch (e) {
      last = e;
      await rm(tmp, { force: true });
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** JPEG poster frame of a video (ffmpeg). */
export async function makePoster(
  video: string,
  atS: number,
  out: string,
  maxW = 960,
  bin?: FfmpegBin,
): Promise<void> {
  await run(ffmpegOf(bin), posterArgs(video, atS, out, maxW), {
    timeout: 120_000,
    windowsHide: true,
  });
}

/** Run `fn` over `items` with at most `limit` at a time; results keep the input order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
