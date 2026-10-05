import type { ImageGeom, Issue } from '@aio/schema';
import { loadSharp } from './sharp-lazy';

/**
 * Photo orientation: which way up a project photo's pixels are stored, and how to turn them
 * (with every image sighting drawn on them) when they are not the way the camera saw them.
 *
 * Why: some delivered kits carry thumbnails made from the raw sensor pixels without applying the
 * EXIF Orientation tag. The Flyability Elios 3 writes Orientation 3 (turn 180 degrees) on every
 * photo, so the HCl kit's 480 px thumbnails are upside down while its 1280 px copies are right.
 * The photo pose (`q`, image +Y up) describes the camera, so the pixels have to follow it.
 */

/** Clockwise quarter turns. */
export type QuarterTurns = 0 | 1 | 2 | 3;

export const quarterTurns = (n: number): QuarterTurns => (((n % 4) + 4) % 4) as QuarterTurns;

/** Size of a `w` x `h` image after `t` clockwise quarter turns. */
export function turnedSize(w: number, h: number, t: QuarterTurns): [number, number] {
  return t % 2 === 1 ? [h, w] : [w, h];
}

/**
 * A point in continuous pixel coordinates (0..w, 0..h, y down) of a `w` x `h` image, after the
 * image is turned `t` quarter turns clockwise.
 */
export function turnPoint(
  x: number,
  y: number,
  t: QuarterTurns,
  w: number,
  h: number,
): [number, number] {
  switch (t) {
    case 0:
      return [x, y];
    case 1:
      return [h - y, x];
    case 2:
      return [w - x, h - y];
    case 3:
      return [y, w - x];
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function normaliseDeg(a: number): number {
  let r = a % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r;
}

/**
 * An image sighting's shape after its photo is turned `t` quarter turns clockwise and then scaled
 * to `newW` x `newH` (defaults: the turned size, no scaling). Masks are files and come back as
 * they are; turn the mask image itself with {@link turnImage}.
 */
export function turnImageGeom(
  g: ImageGeom,
  t: QuarterTurns,
  w: number,
  h: number,
  newW?: number,
  newH?: number,
): ImageGeom {
  const [tw, th] = turnedSize(w, h, t);
  const sx = (newW ?? tw) / tw;
  const sy = (newH ?? th) / th;
  const at = (x: number, y: number): [number, number] => {
    const [u, v] = turnPoint(x, y, t, w, h);
    return [round3(u * sx), round3(v * sy)];
  };
  switch (g.type) {
    case 'point': {
      const [x, y] = at(g.x, g.y);
      return { ...g, x, y };
    }
    case 'polygon':
      return { ...g, points: g.points.map(([x, y]) => at(x, y)) };
    case 'box': {
      const [ax, ay] = at(g.x, g.y);
      const [bx, by] = at(g.x + g.w, g.y + g.h);
      return {
        ...g,
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        w: round3(Math.abs(bx - ax)),
        h: round3(Math.abs(by - ay)),
      };
    }
    case 'rotbox': {
      // x, y, w, h is the box before its rotation about the centre (annotate `cornersOf`)
      const [cx, cy] = at(g.x + g.w / 2, g.y + g.h / 2);
      const bw = round3(g.w * (t % 2 === 1 ? sy : sx));
      const bh = round3(g.h * (t % 2 === 1 ? sx : sy));
      return {
        ...g,
        x: round3(cx - bw / 2),
        y: round3(cy - bh / 2),
        w: bw,
        h: bh,
        angleDeg: normaliseDeg(g.angleDeg + 90 * t),
      };
    }
    case 'mask':
      return g;
  }
}

/** A turned photo: its turn and its pixel size before the turn. */
export interface PhotoTurn {
  turn: QuarterTurns;
  width: number;
  height: number;
  /** Pixel size after the turn when it is also rescaled (defaults to the turned size). */
  newWidth?: number;
  newHeight?: number;
}

/** What {@link turnIssueSightings} changed. */
export interface SightingChange {
  issue: string;
  code: string;
  photo: string;
  before: ImageGeom;
  after: ImageGeom;
}

/**
 * Issues with every image sighting on a turned photo (of `layer`) turned with it. Returns new
 * issue objects for the issues that changed (others are returned as they are) and the changes.
 * Mask sightings are listed with `before === after`; the caller turns the mask files.
 */
export function turnIssueSightings(
  issues: readonly Issue[],
  layer: string,
  turns: ReadonlyMap<string, PhotoTurn>,
): { issues: Issue[]; changes: SightingChange[] } {
  const changes: SightingChange[] = [];
  const out = issues.map((issue) => {
    const sightings = issue.sightings.map((s) => {
      if (s.on !== 'image' || s.layer !== layer) return s;
      const t = turns.get(s.photo);
      if (!t || (t.turn === 0 && t.newWidth === undefined)) return s;
      const geom = turnImageGeom(s.geom, t.turn, t.width, t.height, t.newWidth, t.newHeight);
      changes.push({
        issue: issue.id,
        code: issue.code,
        photo: s.photo,
        before: s.geom,
        after: geom,
      });
      return { ...s, geom };
    });
    return sightings.some((s, i) => s !== issue.sightings[i]) ? { ...issue, sightings } : issue;
  });
  return { issues: out, changes };
}

// ---- pixels ------------------------------------------------------------------------------------

/** Encoded image (JPEG for JPEG input, else PNG) turned `t` quarter turns clockwise; no metadata. */
export async function turnImage(src: string | Buffer, t: QuarterTurns): Promise<Buffer> {
  const sharp = await loadSharp();
  const img = sharp(src);
  const meta = await img.metadata();
  const turned = img.rotate(90 * t);
  return meta.format === 'jpeg'
    ? turned.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer()
    : turned.png().toBuffer();
}

const PROBE_W = 64;

/**
 * Grey 64 px probe of an image for {@link matchTurn}. `autoOrient` applies the EXIF Orientation
 * tag first (how a camera original is meant to be seen).
 */
export async function orientationProbe(
  src: string | Buffer,
  autoOrient = false,
): Promise<{ data: Float32Array; width: number; height: number }> {
  const sharp = await loadSharp();
  let img = sharp(src, { failOn: 'none' });
  // rotate() with no angle applies the EXIF Orientation; without it the stored pixels are read
  if (autoOrient) img = img.rotate();
  const { data, info } = await img
    .resize({ width: PROBE_W })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = new Float32Array(info.width * info.height);
  for (let i = 0; i < px.length; i++) px[i] = data[i * info.channels] ?? 0;
  return { data: px, width: info.width, height: info.height };
}

/** Normalised cross-correlation of two equal-length signals. */
export function ncc(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] ?? 0;
    mb += b[i] ?? 0;
  }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** A probe turned `t` quarter turns clockwise. */
export function turnProbe(
  p: { data: Float32Array; width: number; height: number },
  t: QuarterTurns,
): { data: Float32Array; width: number; height: number } {
  const [w, h] = turnedSize(p.width, p.height, t);
  const out = new Float32Array(w * h);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      // pixel centres: turn the centre point, then floor
      const [u, v] = turnPoint(x + 0.5, y + 0.5, t, p.width, p.height);
      out[Math.floor(v) * w + Math.floor(u)] = p.data[y * p.width + x] ?? 0;
    }
  return { data: out, width: w, height: h };
}

/** How well each turn of `img` matches `ref`. */
export interface TurnMatch {
  /** The turn that makes `img` look like `ref`. */
  turn: QuarterTurns;
  /** Its correlation (1 is identical). */
  score: number;
  /** The best correlation of any other turn. */
  runnerUp: number;
}

/**
 * Which clockwise quarter turn of `img` matches `ref` (both probes, any resolution). Turns that
 * change the aspect ratio are tried only when the shapes allow it.
 */
export function matchTurn(
  img: { data: Float32Array; width: number; height: number },
  ref: { data: Float32Array; width: number; height: number },
): TurnMatch {
  const scores: { turn: QuarterTurns; score: number }[] = [];
  const refAspect = ref.width / ref.height;
  for (const t of [0, 1, 2, 3] as const) {
    const [w, h] = turnedSize(img.width, img.height, t);
    if (Math.abs(w / h - refAspect) > 0.12 * refAspect) continue;
    const turned = turnProbe(img, t);
    scores.push({ turn: t, score: ncc(resample(turned, ref.width, ref.height), ref.data) });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0] ?? { turn: 0 as QuarterTurns, score: 0 };
  return { turn: best.turn, score: best.score, runnerUp: scores[1]?.score ?? -1 };
}

/**
 * Confident: a near copy and clearly better than any other turn. A plain picture (a bare wall)
 * looks much the same either way up, so a practically exact copy needs a smaller lead.
 */
export const confidentMatch = (m: TurnMatch) =>
  m.score >= 0.8 &&
  (m.score - m.runnerUp >= 0.15 || (m.score >= 0.98 && m.score - m.runnerUp >= 0.02));

function resample(
  p: { data: Float32Array; width: number; height: number },
  w: number,
  h: number,
): Float32Array {
  if (p.width === w && p.height === h) return p.data;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(p.width - 1, Math.floor(((x + 0.5) * p.width) / w));
      const sy = Math.min(p.height - 1, Math.floor(((y + 0.5) * p.height) / h));
      out[y * w + x] = p.data[sy * p.width + sx] ?? 0;
    }
  return out;
}

/**
 * The turn a kit's thumbnails need, from the photos the kit carries both as a full copy and as a
 * thumbnail: the turn that makes each thumbnail match its full copy, when (nearly) all pairs agree.
 * `null` when there are no confident pairs or they disagree.
 */
export async function kitThumbTurn(
  pairs: readonly { full: string; thumb: string }[],
): Promise<{ turn: QuarterTurns; pairs: number; agree: number } | null> {
  const votes = new Map<QuarterTurns, number>();
  let n = 0;
  for (const p of pairs) {
    const m = matchTurn(await orientationProbe(p.thumb), await orientationProbe(p.full, true));
    if (!confidentMatch(m)) continue;
    n++;
    votes.set(m.turn, (votes.get(m.turn) ?? 0) + 1);
  }
  if (n === 0) return null;
  const [turn, agree] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  if (agree < Math.max(1, Math.ceil(0.9 * n))) return null;
  return { turn: turn, pairs: n, agree };
}
