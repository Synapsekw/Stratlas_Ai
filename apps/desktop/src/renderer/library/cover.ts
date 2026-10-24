import type { LibraryEntry, ProjectPurpose } from '@aio/schema';

/** Longest side of a cover in pixels. */
export const COVER_MAX = 640;
/** The most a cover may weigh (the main process refuses more). */
export const COVER_BYTES = 512 * 1024;

export type BuiltinCoverId = 'contours' | 'grid' | 'ridge' | 'dots';
export const BUILTIN_COVERS: readonly BuiltinCoverId[] = ['contours', 'grid', 'ridge', 'dots'];

export type CoverChoice =
  | { kind: 'builtin'; id: BuiltinCoverId }
  /** `url`: an object URL of `data` for the preview. */
  | { kind: 'image'; data: Uint8Array<ArrayBuffer>; url: string }
  /** The wizard: no cover at all. */
  | { kind: 'none' }
  /** The dialog: back to the project's own picture. */
  | { kind: 'reset' };

export interface CoverPalette {
  bg: string;
  line: string;
  accent: string;
}

/** Scale a picture down so its longest side is at most `max`; a smaller one stays as it is. */
export function fitCover(w: number, h: number, max = COVER_MAX): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Hue and chroma per purpose, on the app's oklch scale (tokens.css). */
const TONE: Record<ProjectPurpose, { h: number; c: number }> = {
  survey: { h: 75, c: 1 }, // amber
  construction: { h: 250, c: 1 }, // blue
  'vertical-asset': { h: 195, c: 1 }, // teal
  'confined-space': { h: 300, c: 1 }, // violet
  'data-fusion': { h: 150, c: 1 }, // green
  road: { h: 240, c: 0.45 }, // slate
  telecom: { h: 20, c: 1 }, // coral
};
const NEUTRAL = { h: 250, c: 0.1 };

/** Kit exports carry no purpose; they colour like the project type they come from. */
const KIT_PURPOSE: Partial<Record<LibraryEntry['kind'], ProjectPurpose>> = {
  volumetric: 'survey',
  road: 'road',
  aik: 'vertical-asset',
  twin: 'data-fusion',
};

const ok = (l: number, c: number, h: number) =>
  `oklch(${String(l)} ${String(Math.round(c * 1000) / 1000)} ${String(h)})`;

/** The colours a built-in cover is drawn in: a dark ground tinted by the project type. */
export function coverPalette(
  p: ProjectPurpose | undefined,
  kind?: LibraryEntry['kind'],
): CoverPalette {
  const purpose = p ?? (kind ? KIT_PURPOSE[kind] : undefined);
  const { h, c } = purpose ? TONE[purpose] : NEUTRAL;
  return {
    bg: ok(0.19, 0.03 * c, h),
    line: ok(0.6, 0.075 * c, h),
    accent: ok(0.82, 0.135 * c, h),
  };
}

// ---------- drawing ----------

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A small seeded random source, so a cover draws the same every time. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Hill {
  x: number;
  y: number;
  r: number;
  a: number;
}
/** A height field over [0,1]^2 made of a few soft hills and a long swell. */
function terrain(hills: Hill[]) {
  return (x: number, y: number) => {
    let z = 0.12 * Math.sin(x * 5.1 + y * 2.3) + 0.08 * Math.cos(x * 2.2 - y * 6.7);
    for (const hill of hills) {
      const dx = x - hill.x;
      const dy = y - hill.y;
      z += hill.a * Math.exp(-(dx * dx + dy * dy) / (hill.r * hill.r));
    }
    return z;
  };
}

/** Topographic contours by marching squares, every fifth an index contour in the accent. */
function drawContours(g: Ctx, pal: CoverPalette, w: number, h: number) {
  const f = terrain([
    { x: 0.32, y: 0.42, r: 0.22, a: 1 },
    { x: 0.7, y: 0.62, r: 0.17, a: 0.75 },
    { x: 0.86, y: 0.18, r: 0.12, a: 0.4 },
  ]);
  const nx = 96;
  const ny = Math.round((nx * h) / w);
  const z: number[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) z.push(f(i / nx, (j / ny) * (h / w) * 1.6));
  const at = (i: number, j: number) => z[j * (nx + 1) + i] ?? 0;
  const cw = w / nx;
  const ch = h / ny;
  const levels = 22;
  for (let k = 1; k < levels; k++) {
    const iso = -0.25 + (k / levels) * 1.35;
    const index = k % 5 === 0;
    g.strokeStyle = index ? pal.accent : pal.line;
    g.globalAlpha = index ? 0.9 : 0.55;
    g.lineWidth = (index ? 1.6 : 1) * (w / 640);
    g.beginPath();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const d = at(i, j + 1);
        const pts: [number, number][] = [];
        const edge = (p: number, q: number, x0: number, y0: number, x1: number, y1: number) => {
          if (p < iso !== q < iso) {
            const t = (iso - p) / (q - p);
            pts.push([(x0 + (x1 - x0) * t) * cw, (y0 + (y1 - y0) * t) * ch]);
          }
        };
        edge(a, b, i, j, i + 1, j);
        edge(b, c, i + 1, j, i + 1, j + 1);
        edge(c, d, i + 1, j + 1, i, j + 1);
        edge(d, a, i, j + 1, i, j);
        for (let s = 0; s + 1 < pts.length; s += 2) {
          const p0 = pts[s];
          const p1 = pts[s + 1];
          if (!p0 || !p1) continue;
          g.moveTo(p0[0], p0[1]);
          g.lineTo(p1[0], p1[1]);
        }
      }
    }
    g.stroke();
  }
  // a spot height on the summit
  spotHeight(g, pal, 0.32 * w, 0.42 * (w / 1.6), w);
}

/** A survey point: a ring and a short leader line with a tick, like the stage callouts. */
function spotHeight(g: Ctx, pal: CoverPalette, x: number, y: number, w: number) {
  const k = w / 640;
  g.globalAlpha = 1;
  g.strokeStyle = pal.accent;
  g.fillStyle = pal.bg;
  g.lineWidth = 1.5 * k;
  g.beginPath();
  g.arc(x, y, 5 * k, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = pal.accent;
  g.beginPath();
  g.arc(x, y, 1.8 * k, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(x + 4 * k, y - 4 * k);
  g.lineTo(x + 26 * k, y - 26 * k);
  g.lineTo(x + 58 * k, y - 26 * k);
  g.stroke();
}

/** A plant grid with a serpentine flight plan over a survey boundary. */
function drawGrid(g: Ctx, pal: CoverPalette, w: number, h: number) {
  const k = w / 640;
  const step = 20 * k;
  g.strokeStyle = pal.line;
  g.lineWidth = 1 * k;
  for (let n = 0, x = 0; x <= w; n++, x += step) {
    g.globalAlpha = n % 4 === 0 ? 0.5 : 0.16;
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, h);
    g.stroke();
  }
  for (let n = 0, y = 0; y <= h; n++, y += step) {
    g.globalAlpha = n % 4 === 0 ? 0.5 : 0.16;
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(w, y + 0.5);
    g.stroke();
  }
  // survey boundary
  const poly: [number, number][] = [
    [0.18, 0.24],
    [0.62, 0.16],
    [0.84, 0.42],
    [0.74, 0.8],
    [0.3, 0.84],
    [0.12, 0.56],
  ];
  g.globalAlpha = 0.14;
  g.fillStyle = pal.accent;
  g.beginPath();
  poly.forEach(([x, y], i) => {
    if (i === 0) g.moveTo(x * w, y * h);
    else g.lineTo(x * w, y * h);
  });
  g.closePath();
  g.fill();
  g.globalAlpha = 0.9;
  g.strokeStyle = pal.line;
  g.lineWidth = 1.4 * k;
  g.stroke();
  // flight lines: a lawnmower pattern clipped to the boundary
  g.save();
  g.clip();
  g.strokeStyle = pal.accent;
  g.globalAlpha = 0.95;
  g.lineWidth = 1.4 * k;
  g.setLineDash([6 * k, 4 * k]);
  g.beginPath();
  const lanes = 9;
  for (let i = 0; i <= lanes; i++) {
    const x = (0.12 + (i / lanes) * 0.72) * w;
    const down = i % 2 === 0;
    g.moveTo(x, down ? 0.1 * h : 0.9 * h);
    g.lineTo(x, down ? 0.9 * h : 0.1 * h);
  }
  g.stroke();
  g.restore();
  g.setLineDash([]);
  // grid crosses at the major intersections
  g.globalAlpha = 0.8;
  g.strokeStyle = pal.line;
  g.lineWidth = 1 * k;
  for (let x = step * 4; x < w; x += step * 4)
    for (let y = step * 4; y < h; y += step * 4) {
      g.beginPath();
      g.moveTo(x - 4 * k, y + 0.5);
      g.lineTo(x + 4 * k, y + 0.5);
      g.moveTo(x + 0.5, y - 4 * k);
      g.lineTo(x + 0.5, y + 4 * k);
      g.stroke();
    }
  // home point
  spotHeight(g, pal, 0.3 * w, 0.84 * h, w);
}

/** Stacked terrain profiles, back to front, the nearest in the accent with its summit marked. */
function drawRidge(g: Ctx, pal: CoverPalette, w: number, h: number) {
  const k = w / 640;
  const rows = 11;
  const rnd = random(7);
  const phases = Array.from({ length: rows }, () => [rnd() * 6, rnd() * 6, rnd() * 6]);
  let peak: [number, number] = [0, h];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const base = h * (0.3 + t * 0.62);
    const amp = h * (0.035 + t * 0.07);
    const ph = phases[r] ?? [0, 0, 0];
    const y = (x: number) => {
      const u = x / w;
      const bump = Math.exp(-((u - 0.58) ** 2) / 0.03);
      return (
        base -
        amp *
          (0.45 * Math.sin(u * 7 + (ph[0] ?? 0)) +
            0.25 * Math.sin(u * 17 + (ph[1] ?? 0)) +
            0.12 * Math.sin(u * 41 + (ph[2] ?? 0)) +
            2.2 * bump * (0.3 + 0.7 * t))
      );
    };
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 4 * k) g.lineTo(x, y(x));
    g.lineTo(w, h);
    g.closePath();
    g.globalAlpha = 1;
    g.fillStyle = pal.bg;
    g.fill();
    const front = r === rows - 1;
    g.beginPath();
    for (let x = 0; x <= w; x += 4 * k) {
      const yy = y(x);
      if (x === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
      if (front && yy < peak[1]) peak = [x, yy];
    }
    g.strokeStyle = front ? pal.accent : pal.line;
    g.globalAlpha = front ? 1 : 0.25 + 0.6 * t;
    g.lineWidth = (front ? 1.8 : 1.1) * k;
    g.stroke();
  }
  spotHeight(g, pal, peak[0], peak[1], w);
}

/** A point cloud of terrain seen at a low angle; the high ground lights up in the accent. */
function drawDots(g: Ctx, pal: CoverPalette, w: number, h: number) {
  const k = w / 640;
  const f = terrain([
    { x: 0.42, y: 0.55, r: 0.2, a: 1 },
    { x: 0.75, y: 0.35, r: 0.14, a: 0.6 },
  ]);
  const rnd = random(11);
  const cols = 120;
  const rows = 64;
  for (let j = 0; j < rows; j++) {
    const v = j / (rows - 1); // 0 far, 1 near
    for (let i = 0; i < cols; i++) {
      const u = (i + rnd() * 0.8) / cols;
      const z = f(u, v);
      const spread = 0.55 + 0.75 * v;
      const x = w / 2 + (u - 0.5) * w * spread;
      const y = h * (0.22 + 0.74 * v ** 1.3) - z * h * 0.22;
      if (x < -4 || x > w + 4) continue;
      const high = z > 0.55;
      g.globalAlpha = high ? 1 : 0.35 + 0.55 * v;
      g.fillStyle = high ? pal.accent : pal.line;
      const r = (0.9 + 1.4 * v) * k;
      g.fillRect(x - r / 2, y - r / 2, r, r);
    }
  }
}

/** Draw a built-in cover at `w` x `h` (16:9 everywhere the app shows one). */
export function drawBuiltinCover(
  g: Ctx,
  id: BuiltinCoverId,
  pal: CoverPalette,
  w: number,
  h: number,
): void {
  g.save();
  g.globalAlpha = 1;
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, w, h);
  if (id === 'contours') drawContours(g, pal, w, h);
  else if (id === 'grid') drawGrid(g, pal, w, h);
  else if (id === 'ridge') drawRidge(g, pal, w, h);
  else drawDots(g, pal, w, h);
  g.restore();
}

// ---------- bytes ----------

async function canvasJpeg(c: OffscreenCanvas): Promise<Uint8Array<ArrayBuffer>> {
  let blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  if (blob.size > COVER_BYTES) blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return new Uint8Array(await blob.arrayBuffer());
}

function context(c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const g = c.getContext('2d');
  if (!g) throw new Error('No 2D canvas');
  return g;
}

/** A picture as a cover JPEG at most COVER_MAX across. Throws when it cannot be decoded. */
export async function imageToCoverJpeg(
  source: Blob | ImageBitmap,
): Promise<Uint8Array<ArrayBuffer>> {
  const own = source instanceof Blob;
  const bmp = own ? await createImageBitmap(source) : source;
  try {
    const { width, height } = fitCover(bmp.width, bmp.height);
    const c = new OffscreenCanvas(width, height);
    const g = context(c);
    g.fillStyle = coverPalette(undefined).bg; // under a transparent picture
    g.fillRect(0, 0, width, height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, width, height);
    return await canvasJpeg(c);
  } finally {
    if (own) bmp.close();
  }
}

export async function builtinCoverJpeg(
  id: BuiltinCoverId,
  palette: CoverPalette,
): Promise<Uint8Array<ArrayBuffer>> {
  const w = COVER_MAX;
  const h = Math.round((COVER_MAX * 9) / 16);
  const c = new OffscreenCanvas(w, h);
  drawBuiltinCover(context(c), id, palette, w, h);
  return canvasJpeg(c);
}

/** Bytes to send for a choice: null for 'reset', undefined for 'none'. */
export async function coverBytes(
  c: CoverChoice,
  palette: CoverPalette,
): Promise<Uint8Array<ArrayBuffer> | null | undefined> {
  if (c.kind === 'none') return undefined;
  if (c.kind === 'reset') return null;
  if (c.kind === 'image') return c.data;
  return builtinCoverJpeg(c.id, palette);
}
