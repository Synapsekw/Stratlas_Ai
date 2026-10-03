import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';

export interface VideoInfo {
  codec: string;
  profile: string;
  width: number;
  height: number;
  durationS: number;
  fps: number;
}

/** Codecs Chromium (Electron) plays in an MP4 container without transcoding. */
export const CHROMIUM_CODECS = new Set(['h264', 'hevc', 'vp9', 'av1']);

export async function probeVideo(file: string): Promise<VideoInfo> {
  const { stdout } = await run(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,profile,width,height,r_frame_rate:format=duration',
      '-of',
      'json',
      file,
    ],
    { maxBuffer: 1 << 20 },
  );
  const j = JSON.parse(stdout) as {
    streams?: {
      codec_name?: string;
      profile?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }[];
    format?: { duration?: string };
  };
  const s = j.streams?.[0];
  if (!s) throw new Error(`No video stream in ${file}`);
  const [num, den] = (s.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    codec: s.codec_name ?? 'unknown',
    profile: s.profile ?? '',
    width: s.width ?? 0,
    height: s.height ?? 0,
    durationS: Number(j.format?.duration ?? 0),
    fps: den ? (num ?? 0) / den : 0,
  };
}

async function ffmpeg(args: string[]): Promise<void> {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 1 << 24,
  });
}

/** JPEG frame of a video at `atS` seconds, scaled to at most `maxW` pixels wide. */
export async function extractFrame(video: string, atS: number, out: string, maxW = 1280) {
  await ffmpeg([
    '-ss',
    atS.toFixed(3),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${maxW},iw)':-2`,
    '-q:v',
    '3',
    out,
  ]);
}

/** Re-encode an image as JPEG no larger than `maxPx` on its long side. */
export async function resizeImage(src: string, out: string, maxPx: number, quality = 3) {
  await ffmpeg([
    '-i',
    src,
    '-vf',
    `scale='if(gt(iw,ih),min(${maxPx},iw),-2)':'if(gt(iw,ih),-2,min(${maxPx},ih))'`,
    '-q:v',
    String(quality),
    out,
  ]);
}

/** Transcode to H.264 MP4 (only used when a source codec does not play in Chromium). */
export async function transcodeH264(src: string, out: string) {
  await ffmpeg([
    '-i',
    src,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    out,
  ]);
}
