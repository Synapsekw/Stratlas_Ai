/**
 * Synthetic equirectangular walk videos for tests: PNG frames drawn with the marker detector's
 * patches (`markerPhotoRgba`), one per second, encoded with the ffmpeg on the PATH. No camera
 * footage; tests skip when there is no ffmpeg.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePng, markerPhotoRgba, type MarkerPatch } from './markerDetector';

/** The ffmpeg on the PATH, or null when there is none. */
export const testFfmpeg: string | null = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return null;
  }
})();

const hasX264 = (ffmpeg: string) =>
  spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout.includes('libx264');

/**
 * An MP4 of `width` x `height` at `fps`, showing `seconds[i]` from second i to i + 1 (the patches
 * in video pixels; keep them on even pixels, the chroma is subsampled).
 */
export async function writeMarkerVideo(
  ffmpeg: string,
  out: string,
  width: number,
  height: number,
  seconds: readonly (readonly MarkerPatch[])[],
  fps = 5,
): Promise<void> {
  const dir = `${out}.frames`;
  await mkdir(dir, { recursive: true });
  for (const [i, patches] of seconds.entries())
    await writeFile(
      join(dir, `f${String(i).padStart(3, '0')}.png`),
      encodePng(width, height, markerPhotoRgba(width, height, patches)),
    );
  const codec = hasX264(ffmpeg)
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '4']
    : ['-c:v', 'mpeg4', '-q:v', '1'];
  const r = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      '1',
      '-i',
      join(dir, 'f%03d.png'),
      '-r',
      String(fps),
      ...codec,
      '-pix_fmt',
      'yuv420p',
      out,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`ffmpeg could not make ${out}: ${r.stderr}`);
}
