import type { CameraOrientation, LensModel, Quat, Vec3 } from '@aio/schema';
import { imageToRay, rayToImage } from './lens';
import { biasQuat, quatConj, quatRotate } from './orientation';

/**
 * Automatic orientation refine: line the video frame up with a render of the model by edges.
 *
 * The model is rendered from the logged pose with the current calibration; the video frame shows
 * the same scene from the true camera. A pure camera turn maps one image onto the other whatever
 * the depth of the scene, so the search runs over the turn `delta` (yaw, pitch, roll) that best
 * carries the render's edges onto the frame's edges: for each strong edge pixel of the render, the
 * ray through it is turned into the true camera and its image point looked up in the frame's
 * gradient field. The score rewards frame edges parallel to the render's edge there. Coarse to
 * fine: a wide yaw and pitch grid on heavily blurred gradients, then roll, then small steps.
 */

/** A grey image, row-major from the top-left, any value range. */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array | Uint8Array | Uint8ClampedArray;
}

export interface AutoAlignOptions {
  /** Yaw and pitch search half-range in degrees. Default 12. */
  rangeDeg?: number;
  /** Roll search half-range in degrees. Default 4. */
  rollRangeDeg?: number;
  /** Edge samples taken from the render. Default 2500. */
  samples?: number;
}

export interface AutoAlignResult {
  /** The turn to compose after the render's orientation (camera frame). */
  delta: CameraOrientation;
  /** Edge agreement at the start (no turn) and at the result, 0 to 1. */
  startScore: number;
  score: number;
  /** How far the best score stands out from the median of the coarse grid (1 = not at all). */
  contrast: number;
}

/** RGBA bytes to a grey image (Rec. 709 luma). */
export function grayFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  flipY = false,
): GrayImage {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = flipY ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const i = (sy * width + x) * 4;
      data[y * width + x] =
        0.2126 * (rgba[i] ?? 0) + 0.7152 * (rgba[i + 1] ?? 0) + 0.0722 * (rgba[i + 2] ?? 0);
    }
  }
  return { width, height, data };
}

/** Box blur, `passes` times (three passes approximate a Gaussian). */
function blur(src: Float32Array, w: number, h: number, r: number, passes = 3): Float32Array {
  if (r < 1) return src;
  let a: Float32Array = src;
  let b: Float32Array = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[y * w + Math.min(w - 1, Math.max(0, k))] ?? 0;
      for (let x = 0; x < w; x++) {
        b[y * w + x] = s / n;
        const add = Math.min(w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        s += (a[y * w + add] ?? 0) - (a[y * w + sub] ?? 0);
      }
    }
    [a, b] = [b, a];
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[Math.min(h - 1, Math.max(0, k)) * w + x] ?? 0;
      for (let y = 0; y < h; y++) {
        b[y * w + x] = s / n;
        const add = Math.min(h - 1, y + r + 1);
        const sub = Math.max(0, y - r);
        s += (a[add * w + x] ?? 0) - (a[sub * w + x] ?? 0);
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

interface Gradient {
  w: number;
  h: number;
  gx: Float32Array;
  gy: Float32Array;
  /** A typical gradient magnitude (soft threshold of the score). */
  scale: number;
}

function gradient(img: GrayImage, blurR: number): Gradient {
  const { width: w, height: h } = img;
  const src = img.data instanceof Float32Array ? img.data : Float32Array.from(img.data);
  const s = blur(src, w, h, blurR);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mags: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const at = (dx: number, dy: number) => s[(y + dy) * w + x + dx] ?? 0;
      const vx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
      const vy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
      gx[y * w + x] = vx;
      gy[y * w + x] = vy;
      if ((x + y) % 7 === 0) mags.push(Math.hypot(vx, vy));
    }
  }
  mags.sort((a, b) => a - b);
  const scale = Math.max(1e-6, mags[Math.floor(mags.length * 0.75)] ?? 1);
  return { w, h, gx, gy, scale };
}

interface EdgeSample {
  ray: Vec3;
  nx: number;
  ny: number;
  w: number;
}

/** The strongest edge pixels of the render, thinned to one per cell. */
function edgeSamples(g: Gradient, lens: LensModel, count: number): EdgeSample[] {
  const { w, h } = g;
  const cell = Math.max(2, Math.round(Math.sqrt((w * h) / (count * 1.5))));
  const picks: { x: number; y: number; m: number }[] = [];
  const margin = 3;
  for (let cy = margin; cy < h - margin; cy += cell) {
    for (let cx = margin; cx < w - margin; cx += cell) {
      let best = 0;
      let bx = -1;
      let by = -1;
      for (let y = cy; y < Math.min(h - margin, cy + cell); y++) {
        for (let x = cx; x < Math.min(w - margin, cx + cell); x++) {
          const m = Math.hypot(g.gx[y * w + x] ?? 0, g.gy[y * w + x] ?? 0);
          if (m > best) {
            best = m;
            bx = x;
            by = y;
          }
        }
      }
      if (bx >= 0) picks.push({ x: bx, y: by, m: best });
    }
  }
  picks.sort((a, b) => b.m - a.m);
  const keep = picks.slice(0, count).filter((p) => p.m > g.scale * 0.5);
  return keep.map((p) => {
    const gx = g.gx[p.y * w + p.x] ?? 0;
    const gy = g.gy[p.y * w + p.x] ?? 0;
    const m = Math.hypot(gx, gy) || 1;
    return {
      ray: imageToRay(lens, (p.x + 0.5) / w, (p.y + 0.5) / h),
      nx: gx / m,
      ny: gy / m,
      w: Math.min(1, m / (g.scale * 4)),
    };
  });
}

function sample(g: Gradient, x: number, y: number): [number, number] | null {
  if (!(x >= 1 && y >= 1 && x < g.w - 2 && y < g.h - 2)) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * g.w + x0;
  const lerp2 = (a: Float32Array) =>
    ((a[i] ?? 0) * (1 - fx) + (a[i + 1] ?? 0) * fx) * (1 - fy) +
    ((a[i + g.w] ?? 0) * (1 - fx) + (a[i + g.w + 1] ?? 0) * fx) * fy;
  return [lerp2(g.gx), lerp2(g.gy)];
}

/** Edge agreement of the render's samples carried into the frame by `delta`, 0 to 1. */
function scoreOf(
  samples: readonly EdgeSample[],
  frame: Gradient,
  lens: LensModel,
  delta: CameraOrientation,
): number {
  const inv: Quat = quatConj(biasQuat(delta));
  let s = 0;
  let wsum = 0;
  for (const e of samples) {
    wsum += e.w;
    const im = rayToImage(lens, quatRotate(inv, e.ray));
    if (!im) continue;
    const g = sample(frame, im[0] * frame.w - 0.5, im[1] * frame.h - 0.5);
    if (!g) continue;
    const m = Math.hypot(g[0], g[1]);
    if (m < 1e-9) continue;
    const along = Math.abs(g[0] * e.nx + g[1] * e.ny) / m;
    s += e.w * along * (m / (m + frame.scale));
  }
  return wsum > 0 ? s / wsum : 0;
}

/** Resample a grey image to `width` (area average when shrinking). */
export function resizeGray(img: GrayImage, width: number): GrayImage {
  if (img.width === width) return img;
  const height = Math.max(1, Math.round((img.height * width) / img.width));
  const out = new Float32Array(width * height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      let n = 0;
      const x0 = Math.floor(x * sx);
      const y0 = Math.floor(y * sy);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let yy = y0; yy < Math.min(img.height, y1); yy++)
        for (let xx = x0; xx < Math.min(img.width, x1); xx++) {
          s += img.data[yy * img.width + xx] ?? 0;
          n++;
        }
      out[y * width + x] = n ? s / n : 0;
    }
  }
  return { width, height, data: out };
}

/**
 * Find the camera turn that lines `frame` (the video) up with `render` (the model from the logged
 * pose and current calibration). Both images cover the full frame of `lens`; any size, best about
 * 480 px wide. Compose the result after the current orientation: `composeOrientation(current,
 * result.delta)`.
 */
export function autoAlign(
  render: GrayImage,
  frame: GrayImage,
  lens: LensModel,
  opts: AutoAlignOptions = {},
): AutoAlignResult {
  const range = opts.rangeDeg ?? 12;
  const rollRange = opts.rollRangeDeg ?? 4;
  const count = opts.samples ?? 2500;
  const width = Math.min(render.width, 480);
  const r = resizeGray(render, width);
  const f = resizeGray(frame, width);
  const px = lens.hfovDeg / width; // degrees per pixel, roughly

  const levels = [
    { blur: Math.max(2, Math.round(1.2 / px)), step: 1 },
    { blur: Math.max(1, Math.round(0.4 / px)), step: 0.25 },
    { blur: 1, step: 0.05 },
  ];
  let best: CameraOrientation = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  let bestScore = -1;
  let contrast = 1;
  let startScore = 0;

  levels.forEach((lv, li) => {
    const rg = gradient(r, Math.max(1, Math.round(lv.blur / 2)));
    const fg = gradient(f, lv.blur);
    const samples = edgeSamples(rg, lens, li === 0 ? Math.min(1200, count) : count);
    const score = (d: CameraOrientation) => scoreOf(samples, fg, lens, d);
    if (li === levels.length - 1) startScore = score({ yawDeg: 0, pitchDeg: 0, rollDeg: 0 });
    if (li === 0) {
      const all: number[] = [];
      for (let p = -range; p <= range + 1e-9; p += lv.step)
        for (let y = -range; y <= range + 1e-9; y += lv.step) {
          const d = { yawDeg: y, pitchDeg: p, rollDeg: 0 };
          const s = score(d);
          all.push(s);
          if (s > bestScore) {
            bestScore = s;
            best = d;
          }
        }
      for (let ro = -rollRange; ro <= rollRange + 1e-9; ro += lv.step) {
        const d = { ...best, rollDeg: ro };
        const s = score(d);
        if (s > bestScore) {
          bestScore = s;
          best = d;
        }
      }
      all.sort((a, b) => a - b);
      const median = all[Math.floor(all.length / 2)] ?? 0;
      contrast = median > 0 ? bestScore / median : 1;
      return;
    }
    // pattern search around the best so far
    bestScore = score(best);
    let step = lv.step * 4;
    while (step >= lv.step - 1e-9) {
      let moved = false;
      for (const axis of ['pitchDeg', 'yawDeg', 'rollDeg'] as const)
        for (const sgn of [-1, 1]) {
          const d = { ...best, [axis]: best[axis] + sgn * step };
          const s = score(d);
          if (s > bestScore) {
            bestScore = s;
            best = d;
            moved = true;
          }
        }
      if (!moved) step /= 2;
    }
  });
  return { delta: best, startScore, score: bestScore, contrast };
}
