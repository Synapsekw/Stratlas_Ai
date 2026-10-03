import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { encodePng, type RawImage } from './png';

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

/** Where a line art raster gets its transparency from. */
export type LineArtBackground = 'alpha' | 'black' | 'white';

export interface LineArtOptions {
  /**
   * Colour for monochrome line art (white, grey or black lines), which would otherwise vanish on a
   * pale or dark ground. Coloured line art keeps its own colours.
   */
  tint?: readonly [number, number, number];
}

/** Share of pixels that must be see-through for an image to count as already carrying alpha. */
const ALPHA_SHARE = 0.005;
/** Largest channel spread (0..255) of a line pixel that still counts as grey. */
const GREY_SPREAD = 24;

/**
 * Background of a line art raster: its own alpha when enough pixels are see-through, else black
 * or white by the mean luminance of the border pixels (drawings are framed by their background).
 */
export function lineArtBackground(img: RawImage): LineArtBackground {
  const { width: w, height: h, channels: ch, data } = img;
  if (ch === 4) {
    let clear = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 255) < 250) clear++;
    if (clear / (w * h) > ALPHA_SHARE) return 'alpha';
  }
  let sum = 0;
  let n = 0;
  const add = (x: number, y: number) => {
    const o = (y * w + x) * ch;
    sum += ((data[o] ?? 0) + (data[o + 1] ?? 0) + (data[o + 2] ?? 0)) / 3;
    n++;
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    add(0, y);
    add(w - 1, y);
  }
  return n && sum / n > 127.5 ? 'white' : 'black';
}

/**
 * Line art with a transparent background, RGBA. The background (the image's own alpha, or a black
 * or white ground) becomes alpha 0 and line pixels keep their colour, un-mixed from the ground so
 * anti-aliased edges fade instead of keeping a dark or pale fringe. Monochrome line art takes
 * `tint`. Pixels under alpha 0 carry the line colour, so filtering never bleeds the old ground in.
 */
export function lineArtToAlpha(img: RawImage, opts: LineArtOptions = {}): RawImage {
  const { width: w, height: h, channels: ch, data } = img;
  const bg = lineArtBackground(img);
  const out = new Uint8Array(w * h * 4);
  let coloured = false;
  for (let p = 0; p < w * h; p++) {
    const i = p * ch;
    let r = data[i] ?? 0;
    let g = data[i + 1] ?? 0;
    let b = data[i + 2] ?? 0;
    let a: number;
    if (bg === 'alpha') a = ch === 4 ? (data[i + 3] ?? 255) : 255;
    else if (bg === 'black') {
      a = Math.max(r, g, b);
      if (a > 0) {
        r = Math.round((r * 255) / a);
        g = Math.round((g * 255) / a);
        b = Math.round((b * 255) / a);
      }
    } else {
      a = 255 - Math.min(r, g, b);
      if (a > 0) {
        r = Math.round(255 - ((255 - r) * 255) / a);
        g = Math.round(255 - ((255 - g) * 255) / a);
        b = Math.round(255 - ((255 - b) * 255) / a);
      }
    }
    if (a > 0 && Math.max(r, g, b) - Math.min(r, g, b) > GREY_SPREAD) coloured = true;
    const o = p * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  const tint = !coloured && opts.tint ? opts.tint : null;
  if (tint) {
    for (let o = 0; o < out.length; o += 4) out.set(tint, o);
  } else {
    // under alpha 0 the colour of the nearest line pixel on the row (else the last one seen)
    let last: [number, number, number] = [0, 0, 0];
    for (let o = 0; o < out.length; o += 4) {
      if ((out[o + 3] ?? 0) > 0) last = [out[o] ?? 0, out[o + 1] ?? 0, out[o + 2] ?? 0];
      else out.set(last, o);
    }
  }
  return { width: w, height: h, channels: 4, data: out };
}

/** Decode any image ffmpeg reads to 8-bit RGBA, padded (top-left anchored, transparent). */
export async function readRgba(
  src: string,
  width: number,
  height: number,
  padTo?: { width: number; height: number },
): Promise<RawImage> {
  const W = padTo?.width ?? width;
  const H = padTo?.height ?? height;
  const pad = W !== width || H !== height ? `,pad=${W}:${H}:0:0:color=black@0.0` : '';
  const args = ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `format=rgba${pad}`];
  args.push('-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-');
  const { stdout } = await run(FFMPEG, args, { encoding: 'buffer', maxBuffer: W * H * 4 + 1024 });
  if (stdout.length !== W * H * 4)
    throw new Error(`readRgba: ${src} decoded to ${stdout.length} bytes, expected ${W * H * 4}`);
  return { width: W, height: H, channels: 4, data: new Uint8Array(stdout) };
}

/**
 * Line art raster (plot plan tile or sheet) to a PNG with alpha, see {@link lineArtToAlpha},
 * optionally padded to `padTo` (top-left anchored) so edge tiles keep the full tile size.
 */
export async function writeLineArtPng(
  src: string,
  out: string,
  size: { width: number; height: number },
  opts: LineArtOptions & { padTo?: { width: number; height: number } } = {},
): Promise<void> {
  if (extname(out).toLowerCase() !== '.png') throw new Error(`writeLineArtPng: ${out} is not .png`);
  const img = await readRgba(src, size.width, size.height, opts.padTo);
  writeFileSync(out, encodePng(lineArtToAlpha(img, opts)));
}
