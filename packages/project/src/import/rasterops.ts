import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

/** One image drawn onto a canvas: scaled to `w` x `h` (pixels) with its top-left at `x`, `y`. */
export interface CanvasLayer {
  file: string;
  /** Source pixel region to use (default: the whole image). */
  crop?: { x: number; y: number; w: number; h: number };
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ComposeOptions {
  width: number;
  height: number;
  /** `transparent` (default) or an opaque `#rrggbb`. */
  background?: string;
  /**
   * Colour stored under fully transparent pixels of a transparent canvas (default black). A
   * renderer that ignores alpha shows this colour there.
   */
  transparentRgb?: string;
  layers: readonly CanvasLayer[];
  out: string;
  /** WebP / JPEG quality 0..100 (default 85). */
  quality?: number;
}

/**
 * Compose images onto one canvas with ffmpeg (alpha kept): used to pad edge tiles to the full tile
 * size, to fill missing fine tiles from the coarse level, to merge 2 x 2 tiles into a coarser level
 * and to mosaic street map images. The format follows the output extension (webp, png or jpg).
 */
export async function composeImage(o: ComposeOptions): Promise<void> {
  const ext = extname(o.out).toLowerCase();
  const bg = o.background ?? 'transparent';
  const color =
    bg === 'transparent'
      ? `${(o.transparentRgb ?? '#000000').replace('#', '0x')}@0.0`
      : bg.replace('#', '0x');
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${o.width}x${o.height}:r=1,format=rgba`,
  ];
  for (const l of o.layers) args.push('-i', l.file);
  const f: string[] = ['[0:v]format=rgba[c0]'];
  o.layers.forEach((l, k) => {
    const i = k + 1;
    const crop = l.crop
      ? `crop=${Math.round(l.crop.w)}:${Math.round(l.crop.h)}:${Math.round(l.crop.x)}:${Math.round(l.crop.y)},`
      : '';
    f.push(
      `[${i}:v]format=rgba,${crop}scale=${Math.round(l.w)}:${Math.round(l.h)}:flags=lanczos[s${i}]`,
    );
    f.push(
      `[c${i - 1}][s${i}]overlay=x=${Math.round(l.x)}:y=${Math.round(l.y)}:format=auto:eof_action=repeat[c${i}]`,
    );
  });
  const last = `c${o.layers.length}`;
  const q = o.quality ?? 85;
  if (ext === '.webp') {
    f.push(`[${last}]format=yuva420p[out]`);
    args.push('-filter_complex', f.join(';'), '-map', '[out]', '-frames:v', '1');
    args.push('-c:v', 'libwebp', '-quality', String(q), '-pix_fmt', 'yuva420p');
  } else if (ext === '.png') {
    f.push(`[${last}]format=rgba[out]`);
    args.push('-filter_complex', f.join(';'), '-map', '[out]', '-frames:v', '1');
  } else if (ext === '.jpg' || ext === '.jpeg') {
    f.push(`[${last}]format=yuvj444p[out]`);
    const qv = Math.max(2, Math.round(2 + ((100 - q) / 100) * 10));
    args.push('-filter_complex', f.join(';'), '-map', '[out]', '-frames:v', '1');
    args.push('-q:v', String(qv));
  } else throw new Error(`composeImage: unsupported output ${o.out}`);
  args.push(o.out);
  await run(FFMPEG, args, { maxBuffer: 1 << 24 });
}

/**
 * Line art drawn white on transparent (the plant twin plot plans, which the viewer tinted with a
 * material colour) re-coloured to `rgb` and padded to `width` x `height`: line pixels take the
 * colour, fully transparent pixels become black, alpha is kept. Shown with alpha blending the
 * result matches the viewer; drawn opaque it reads as coloured lines on black.
 */
export async function tintLineArt(
  src: string,
  out: string,
  rgb: readonly [number, number, number],
  width?: number,
  height?: number,
): Promise<void> {
  const ext = extname(out).toLowerCase();
  const [r, g, b] = rgb;
  const pad = width && height ? `,pad=${width}:${height}:0:0:color=black@0.0` : '';
  const vf =
    `format=rgba${pad},geq=r='if(gt(alpha(X,Y),0),${r},0)':g='if(gt(alpha(X,Y),0),${g},0)':` +
    `b='if(gt(alpha(X,Y),0),${b},0)':a='alpha(X,Y)'`;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', vf, '-frames:v', '1'];
  if (ext === '.webp') args.push('-c:v', 'libwebp', '-quality', '90', '-pix_fmt', 'yuva420p');
  else if (ext !== '.png') throw new Error(`tintLineArt: unsupported output ${out}`);
  args.push(out);
  await run(FFMPEG, args, { maxBuffer: 1 << 24 });
}
