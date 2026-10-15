import { meshAssemblies } from '@aio/modelling';
import type { EvidencePack, ProcModel } from '@aio/schema';
import type { GeneratedView } from './runStore';

/**
 * The draft model seen the way `model.evidence` renders a cloud (python `engineer/render.py`):
 * orthographic views named for the side the camera stands on (`north` sees the north face, east
 * on the left; `top` is a plan with north up), each scaled to fit with a 4 percent margin. Used
 * for the generated views of AI passes 2 and 3 and for the silhouette overlap check against the
 * pack's side renders. Everything here runs on this computer: no AI, no network.
 */

export type ViewName = 'north' | 'east' | 'south' | 'west' | 'top';
const VIEWS: readonly string[] = ['north', 'east', 'south', 'west', 'top'];
export const isViewName = (v: string): v is ViewName => VIEWS.includes(v);

const MARGIN = 0.04;
/** Mask resolution for the overlap (a coarse silhouette is what is compared). */
export const MASK_PX = 128;
/** Size of a generated view, as the pack's own renders. */
export const VIEW_PX = 768;

/** (u right, v down, near) of a local point for a view; larger `near` is closer. */
export function project(x: number, y: number, z: number, view: ViewName): [number, number, number] {
  switch (view) {
    case 'north':
      return [-x, -y, -z];
    case 'south':
      return [x, -y, z];
    case 'east':
      return [-z, -y, x];
    case 'west':
      return [z, -y, -x];
    case 'top':
      return [x, z, y];
  }
}

/** The draft's triangles in the local frame (x y z per corner, 9 numbers per triangle). */
export function draftTriangles(model: ProcModel): Float64Array {
  const r = meshAssemblies(model, { detail: 'fast', include: (a) => a.status !== 'rejected' });
  let n = 0;
  for (const c of r.components) for (const p of c.prims) n += p.indices.length;
  const out = new Float64Array(n * 3);
  let o = 0;
  for (const c of r.components)
    for (const p of c.prims)
      for (const i of p.indices) {
        out[o++] = (p.positions[i * 3] ?? 0) + c.anchor[0];
        out[o++] = (p.positions[i * 3 + 1] ?? 0) + c.anchor[1];
        out[o++] = (p.positions[i * 3 + 2] ?? 0) + c.anchor[2];
      }
  return out;
}

export interface Projected {
  /** u, v (pixels) and near per corner, 9 numbers per triangle. */
  tri: Float64Array;
  /** Near of each triangle's centroid, for drawing far first. */
  depth: Float64Array;
}

/** The triangles in a view, scaled to fit `px` square with the renders' margin. */
export function projectTriangles(tris: Float64Array, view: ViewName, px: number): Projected {
  const n = tris.length / 9;
  const uvn = new Float64Array(tris.length);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const [u, v, near] = project(tris[i] ?? 0, tris[i + 1] ?? 0, tris[i + 2] ?? 0, view);
    uvn[i] = u;
    uvn[i + 1] = v;
    uvn[i + 2] = near;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const ext = Math.max(u1 - u0, v1 - v0, 1e-9);
  const s = (px * (1 - 2 * MARGIN)) / ext;
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const depth = new Float64Array(n);
  for (let i = 0; i < uvn.length; i += 3) {
    uvn[i] = ((uvn[i] ?? 0) - cu) * s + px / 2;
    uvn[i + 1] = ((uvn[i + 1] ?? 0) - cv) * s + px / 2;
  }
  for (let t = 0; t < n; t++)
    depth[t] = ((uvn[t * 9 + 2] ?? 0) + (uvn[t * 9 + 5] ?? 0) + (uvn[t * 9 + 8] ?? 0)) / 3;
  return { tri: uvn, depth };
}

/** A filled silhouette of projected triangles: 1 where any triangle covers the pixel centre. */
export function triangleMask(p: Projected, px: number): Uint8Array {
  const mask = new Uint8Array(px * px);
  const t = p.tri;
  for (let i = 0; i + 8 < t.length; i += 9) {
    const ax = t[i] ?? 0;
    const ay = t[i + 1] ?? 0;
    const bx = t[i + 3] ?? 0;
    const by = t[i + 4] ?? 0;
    const cx = t[i + 6] ?? 0;
    const cy = t[i + 7] ?? 0;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(px - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(px - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5;
        const qy = y + 0.5;
        const w0 = (bx - qx) * (cy - qy) - (by - qy) * (cx - qx);
        const w1 = (cx - qx) * (ay - qy) - (cy - qy) * (ax - qx);
        const w2 = (ax - qx) * (by - qy) - (ay - qy) * (bx - qx);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))
          mask[y * px + x] = 1;
      }
  }
  return mask;
}

/**
 * The silhouette of a cloud render (RGBA, white background): a mask pixel is on when any image
 * pixel in its block is not background. The block size makes the sparse splats a solid shape.
 */
export function imageMask(rgba: Uint8ClampedArray, w: number, h: number, px: number): Uint8Array {
  const mask = new Uint8Array(px * px);
  for (let y = 0; y < h; y++) {
    const my = Math.min(px - 1, Math.floor((y * px) / h));
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      if ((rgba[k] ?? 255) < 245 || (rgba[k + 1] ?? 255) < 245 || (rgba[k + 2] ?? 255) < 245)
        mask[my * px + Math.min(px - 1, Math.floor((x * px) / w))] = 1;
    }
  }
  return mask;
}

/** Intersection over union of two masks of the same size (0 when both are empty). */
export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] === 1;
    const q = b[i] === 1;
    if (p && q) inter++;
    if (p || q) union++;
  }
  return union === 0 ? 0 : inter / union;
}

/** Decoded pixels of an evidence image (a data URL), as the renderer reads them. */
export type DecodeImage = (
  dataUrl: string,
) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>;

/**
 * Silhouette overlap per side and top render of the pack: the draft's filled outline against the
 * cloud's, each fitted to its own frame (as the renders are), rounded to 3 decimals.
 */
export async function silhouetteScores(
  model: ProcModel,
  evidence: EvidencePack,
  load: (imageId: string) => Promise<string>,
  decode: DecodeImage,
): Promise<Record<string, number>> {
  const tris = draftTriangles(model);
  const out: Record<string, number> = {};
  if (tris.length === 0) return out;
  for (const img of evidence.images) {
    if ((img.kind !== 'side' && img.kind !== 'top') || !isViewName(img.view)) continue;
    const pixels = await decode(await load(img.id));
    const cloud = imageMask(pixels.data, pixels.width, pixels.height, MASK_PX);
    const draft = triangleMask(projectTriangles(tris, img.view, MASK_PX), MASK_PX);
    out[img.view] = Math.round(iou(cloud, draft) * 1000) / 1000;
  }
  return out;
}

/** The world direction each view's camera sits towards (its `near` axis). */
const TOWARD: Record<ViewName, [number, number, number]> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  top: [0, 1, 0],
};

/** How squarely a world triangle faces the camera of a view: 0 edge on, 1 face on. */
export function facing(t: Float64Array, i: number, view: ViewName): number {
  const ux = (t[i + 3] ?? 0) - (t[i] ?? 0);
  const uy = (t[i + 4] ?? 0) - (t[i + 1] ?? 0);
  const uz = (t[i + 5] ?? 0) - (t[i + 2] ?? 0);
  const vx = (t[i + 6] ?? 0) - (t[i] ?? 0);
  const vy = (t[i + 7] ?? 0) - (t[i + 1] ?? 0);
  const vz = (t[i + 8] ?? 0) - (t[i + 2] ?? 0);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  const [dx, dy, dz] = TOWARD[view];
  return Math.abs(nx * dx + ny * dy + nz * dz) / len;
}

/** Draws a view (2D canvas calls), far triangles first; the host turns it into a PNG. */
export interface ViewCanvas {
  fillTriangle(a: [number, number], b: [number, number], c: [number, number], grey: number): void;
  toDataUrl(): string;
}

/**
 * Generated views of the draft for AI passes 2 and 3: the same orthographic views as the pack's
 * cloud renders, flat shaded grey on white, so the model compares what it drew with what was
 * measured. `canvas(px)` gives a fresh white canvas.
 */
export function renderDraftViews(
  model: ProcModel,
  views: readonly { id: string; view: string }[],
  canvas: (px: number) => ViewCanvas,
): GeneratedView[] {
  const tris = draftTriangles(model);
  const out: GeneratedView[] = [];
  for (const v of views) {
    if (!isViewName(v.view)) continue;
    const p = projectTriangles(tris, v.view, VIEW_PX);
    const order = [...p.depth.keys()].sort((a, b) => (p.depth[a] ?? 0) - (p.depth[b] ?? 0));
    const c = canvas(VIEW_PX);
    // flat shading: a face turned to the camera is light, one seen edge on dark
    for (const k of order) {
      const i = k * 9;
      const g = 60 + Math.round(150 * facing(tris, i, v.view));
      c.fillTriangle(
        [p.tri[i] ?? 0, p.tri[i + 1] ?? 0],
        [p.tri[i + 3] ?? 0, p.tri[i + 4] ?? 0],
        [p.tri[i + 6] ?? 0, p.tri[i + 7] ?? 0],
        g,
      );
    }
    const dataUrl = c.toDataUrl();
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    out.push({
      id: v.id,
      kind: 'generated',
      dataUrl,
      bytes: Math.floor((b64.length * 3) / 4),
      view: v.view,
    });
  }
  return out;
}

/** A 2D canvas for `renderDraftViews` (renderer only: needs the DOM). */
export function domViewCanvas(px: number): ViewCanvas {
  const el = document.createElement('canvas');
  el.width = px;
  el.height = px;
  const ctx = el.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, px, px);
  }
  return {
    fillTriangle(a, b, c, grey) {
      if (!ctx) return;
      ctx.fillStyle = `rgb(${String(grey)},${String(grey)},${String(grey)})`;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.closePath();
      ctx.fill();
    },
    toDataUrl: () => el.toDataURL('image/png'),
  };
}

/** Pixels of an image data URL (renderer only). */
export const domDecode: DecodeImage = async (dataUrl) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const el = document.createElement('canvas');
  el.width = img.naturalWidth;
  el.height = img.naturalHeight;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas to read the evidence image.');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, el.width, el.height);
  return { data: d.data, width: d.width, height: d.height };
};
