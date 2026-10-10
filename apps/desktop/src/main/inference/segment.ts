/**
 * Promptable segmentation for **Suggest boundaries** (M11 G12, ADR 0011): a SAM-class model (the
 * pipeline pack's `models/sam/`: `encoder.onnx`, `decoder.onnx` and the `model.json` card) turns
 * one click on an ortho crop into an outline. The encoder runs once per crop and its embeddings
 * are kept, so a second click, a new buffer or a new vertex count answers in milliseconds.
 *
 * The model runs in the inference utility process through the `OrtLike` seam (the same runtime as
 * local detection and the Review mask assist); everything after the decoder (the region under the
 * click, holes, buffer, outline, vertex count) is plain code here and tested without a model.
 *
 * Crops are square, north up, `size` pixels a side, placed in the project CRS by the easting of
 * the left edge (`x0`), the northing of the top edge (`y1`) and the pixel size (`res`).
 */
import type { Vec2 } from '@aio/schema';
import { simplify, traceBoundary, type BinaryMask } from '@aio/annotate/detections';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OrtLike, OrtSession, OrtTensor } from '../maskAssist';
import { licenceProblem } from './licence';

/** The model's input side (SAM and its small variants). */
export const SAM_SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * How the encoder takes its image: `hwc-255` an H x W x 3 tensor of 0 to 255 values (the export
 * normalises inside, as the shipped MobileSAM export does); `nchw-imagenet` the 1 x 3 x 1024 x
 * 1024 ImageNet-normalised tensor of the usual SAM export (the default).
 */
export type SamInput = 'hwc-255' | 'nchw-imagenet';

/** The `model.json` card of a pack's segmentation model. */
export interface SamCard {
  name: string;
  version?: string;
  /** SPDX expression; the model licence gate must allow it. */
  licence: string;
  source?: string;
  input: SamInput;
}

export interface SamModel {
  card: SamCard;
  encoder: string;
  decoder: string;
}

export type ModelLookup =
  | { ok: true; model: SamModel }
  | { ok: false; reason: 'no-pack' | 'no-model' | 'licence'; detail?: string };

const isFile = (p: string) =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

/** The pack's segmentation model and its card, or why there is none to use. */
export async function findSegmentModel(packDir: string | null): Promise<ModelLookup> {
  if (!packDir) return { ok: false, reason: 'no-pack' };
  const dir = join(packDir, 'models', 'sam');
  const encoder = join(dir, 'encoder.onnx');
  const decoder = join(dir, 'decoder.onnx');
  if (!(await isFile(encoder)) || !(await isFile(decoder)))
    return { ok: false, reason: 'no-model' };
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    // no card: no licence, refused below
  }
  const str = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
  const licence = str(raw.licence ?? raw.license, 200) ?? '';
  const problem = licenceProblem(licence);
  if (problem) return { ok: false, reason: 'licence', detail: problem };
  const version = str(raw.version, 40);
  const source = str(raw.source, 300);
  const card: SamCard = {
    name: str(raw.name, 80) ?? 'SAM',
    licence,
    input: raw.input === 'hwc-255' ? 'hwc-255' : 'nchw-imagenet',
    ...(version ? { version } : {}),
    ...(source ? { source } : {}),
  };
  return { ok: true, model: { card, encoder, decoder } };
}

// ---------------------------------------------------------------- tensors

/** A square RGB image (row major, 3 bytes a pixel) scaled bilinearly to `to` pixels a side. */
export function resizeRgb(rgb: Uint8Array, size: number, to: number): Uint8Array {
  if (size === to) return rgb;
  const out = new Uint8Array(to * to * 3);
  const k = size / to;
  for (let y = 0; y < to; y++) {
    const fy = Math.min(Math.max((y + 0.5) * k - 0.5, 0), size - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, size - 1);
    const wy = fy - y0;
    for (let x = 0; x < to; x++) {
      const fx = Math.min(Math.max((x + 0.5) * k - 0.5, 0), size - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, size - 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const v =
          (rgb[(y0 * size + x0) * 3 + c] ?? 0) * (1 - wx) * (1 - wy) +
          (rgb[(y0 * size + x1) * 3 + c] ?? 0) * wx * (1 - wy) +
          (rgb[(y1 * size + x0) * 3 + c] ?? 0) * (1 - wx) * wy +
          (rgb[(y1 * size + x1) * 3 + c] ?? 0) * wx * wy;
        out[(y * to + x) * 3 + c] = Math.round(v);
      }
    }
  }
  return out;
}

/** The encoder's input for a SAM_SIZE square RGB image, in the card's layout. */
export function encoderTensor(
  input: SamInput,
  rgb: Uint8Array,
): { data: Float32Array; dims: number[] } {
  const plane = SAM_SIZE * SAM_SIZE;
  if (input === 'hwc-255') {
    const data = new Float32Array(plane * 3);
    for (let i = 0; i < data.length; i++) data[i] = rgb[i] ?? 0;
    return { data, dims: [SAM_SIZE, SAM_SIZE, 3] };
  }
  const data = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      data[c * plane + i] = ((rgb[i * 3 + c] ?? 0) / 255 - (MEAN[c] ?? 0)) / (STD[c] ?? 1);
    }
  }
  return { data, dims: [1, 3, SAM_SIZE, SAM_SIZE] };
}

/** A further click on the same crop: part of the object (`include`) or not part of it. */
export interface RefinePoint {
  at: Vec2;
  include: boolean;
}

/**
 * The standard SAM decoder feeds for a click on the object and any further clicks that add to or
 * take away from it (pixels of the SAM_SIZE image; labels 1 inside, 0 outside).
 */
export function decoderFeeds(
  ort: OrtLike,
  embeddings: OrtTensor,
  click: Vec2,
  refine: readonly RefinePoint[] = [],
): Record<string, OrtTensor> {
  const n = refine.length + 2;
  const coords = new Float32Array(n * 2);
  const labels = new Float32Array(n);
  coords.set(click, 0);
  labels[0] = 1;
  refine.forEach((r, i) => {
    coords.set(r.at, (i + 1) * 2);
    labels[i + 1] = r.include ? 1 : 0;
  });
  // SAM's padding point (label -1) for a prompt without a box
  labels[n - 1] = -1;
  return {
    image_embeddings: embeddings,
    point_coords: new ort.Tensor('float32', coords, [1, n, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, n]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
    orig_im_size: new ort.Tensor('float32', new Float32Array([SAM_SIZE, SAM_SIZE]), [2]),
  };
}

/**
 * The decoder's best mask (by its predicted IoU) as a binary mask at SAM_SIZE, with that score.
 * `masks` is `[1, K, H, W]` logits; a mask smaller than SAM_SIZE (a low-resolution output) is
 * scaled up by nearest neighbour.
 */
export function bestMask(
  masks: OrtTensor,
  scores: OrtTensor | undefined,
): { mask: BinaryMask; score: number } | null {
  if (masks.dims.length !== 4) return null;
  const [, count = 1, h = 0, w = 0] = masks.dims;
  if (!h || !w) return null;
  let pick = 0;
  if (scores) {
    for (let i = 1; i < count; i++) {
      if ((scores.data[i] ?? 0) > (scores.data[pick] ?? 0)) pick = i;
    }
  }
  const data = new Uint8Array(SAM_SIZE * SAM_SIZE);
  const off = pick * w * h;
  for (let y = 0; y < SAM_SIZE; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / SAM_SIZE));
    for (let x = 0; x < SAM_SIZE; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / SAM_SIZE));
      data[y * SAM_SIZE + x] = (masks.data[off + sy * w + sx] ?? 0) > 0 ? 1 : 0;
    }
  }
  const score = Math.min(1, Math.max(0, scores?.data[pick] ?? 0));
  return { mask: { width: SAM_SIZE, height: SAM_SIZE, data }, score };
}

// ---------------------------------------------------------------- mask clean-up

/**
 * The 4-connected region of the mask under `at`, or the region nearest to it when the click fell
 * just outside the mask (a click on a pile's edge). Empty when the mask is empty.
 */
export function regionAt(mask: BinaryMask, at: Vec2): BinaryMask {
  const { width: W, height: H, data } = mask;
  const out = new Uint8Array(W * H);
  const cx = Math.min(W - 1, Math.max(0, Math.round(at[0])));
  const cy = Math.min(H - 1, Math.max(0, Math.round(at[1])));
  let seed = data[cy * W + cx] ? cy * W + cx : -1;
  if (seed < 0) {
    let best = Infinity;
    for (let i = 0; i < W * H; i++) {
      if (!data[i]) continue;
      const x = i % W;
      const d = (x - cx) ** 2 + ((i - x) / W - cy) ** 2;
      if (d < best) {
        best = d;
        seed = i;
      }
    }
  }
  if (seed < 0) return { width: W, height: H, data: out };
  const stack = [seed];
  out[seed] = 1;
  while (stack.length) {
    const p = stack.pop() ?? 0;
    const x = p % W;
    const visit = (q: number) => {
      if (data[q] && !out[q]) {
        out[q] = 1;
        stack.push(q);
      }
    };
    if (x > 0) visit(p - 1);
    if (x < W - 1) visit(p + 1);
    if (p >= W) visit(p - W);
    if (p < W * (H - 1)) visit(p + W);
  }
  return { width: W, height: H, data: out };
}

/** The mask with its holes filled (outside is what the border reaches through empty cells). */
export function fillHoles(mask: BinaryMask): BinaryMask {
  const { width: W, height: H, data } = mask;
  const outside = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (q: number) => {
    if (!data[q] && !outside[q]) {
      outside[q] = 1;
      stack.push(q);
    }
  };
  for (let x = 0; x < W; x++) {
    push(x);
    push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    push(y * W);
    push(y * W + W - 1);
  }
  while (stack.length) {
    const p = stack.pop() ?? 0;
    const x = p % W;
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (p >= W) push(p - W);
    if (p < W * (H - 1)) push(p + W);
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = outside[i] ? 0 : 1;
  return { width: W, height: H, data: out };
}

/**
 * Distance in cells from every cell to the nearest cell where `target` is set (two-pass chamfer
 * 3-4, scaled to cells; within about 8% of the Euclidean distance).
 */
function chamfer(W: number, H: number, target: (i: number) => boolean): Float32Array {
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = target(i) ? 0 : 1e9;
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= W || y >= H ? 1e9 : (d[y * W + x] ?? 1e9);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      d[i] = Math.min(
        d[i] ?? 0,
        at(x - 1, y) + 3,
        at(x, y - 1) + 3,
        at(x - 1, y - 1) + 4,
        at(x + 1, y - 1) + 4,
      );
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      d[i] = Math.min(
        d[i] ?? 0,
        at(x + 1, y) + 3,
        at(x, y + 1) + 3,
        at(x + 1, y + 1) + 4,
        at(x - 1, y + 1) + 4,
      );
    }
  }
  for (let i = 0; i < W * H; i++) d[i] = (d[i] ?? 0) / 3;
  return d;
}

/** The mask grown (`cells` > 0) or shrunk (`cells` < 0) by a distance in cells. */
export function bufferMask(mask: BinaryMask, cells: number): BinaryMask {
  const { width: W, height: H, data } = mask;
  if (!cells) return mask;
  const out = new Uint8Array(W * H);
  if (cells > 0) {
    const d = chamfer(W, H, (i) => !!data[i]);
    for (let i = 0; i < W * H; i++) out[i] = (d[i] ?? Infinity) <= cells ? 1 : 0;
  } else {
    const d = chamfer(W, H, (i) => !data[i]);
    for (let i = 0; i < W * H; i++) out[i] = (d[i] ?? 0) > -cells ? 1 : 0;
  }
  return { width: W, height: H, data: out };
}

/** Whether any set cell lies on the mask's outer edge. */
export function touchesEdge(mask: BinaryMask): boolean {
  const { width: W, height: H, data } = mask;
  for (let x = 0; x < W; x++) if (data[x] || data[(H - 1) * W + x]) return true;
  for (let y = 0; y < H; y++) if (data[y * W] || data[y * W + W - 1]) return true;
  return false;
}

/** Twice the signed area of the triangle a b c. */
const area2 = (a: Vec2, b: Vec2, c: Vec2) =>
  Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));

/**
 * A closed ring reduced to `n` vertices by Visvalingam-Whyatt (the vertex whose triangle with its
 * neighbours is smallest goes first), which keeps the shape's corners.
 */
export function reduceRing(ring: readonly Vec2[], n: number): Vec2[] {
  const pts = [...ring];
  const keep = Math.max(3, Math.floor(n));
  while (pts.length > keep) {
    let worst = 0;
    let least = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      if (!a || !b || !c) continue;
      const v = area2(a, b, c);
      if (v < least) {
        least = v;
        worst = i;
      }
    }
    pts.splice(worst, 1);
  }
  return pts;
}

/** How far the default outline may cut a corner of the mask, cells of the model's grid. */
export const OUTLINE_TOLERANCE = 2;

/**
 * The outline of a mask as a closed ring of cell centres (without the closing point): traced,
 * then simplified within `OUTLINE_TOLERANCE` cells (the mask's pixel steps go, the shape stays),
 * then reduced to `vertices` when given. Null when the region is too small for three corners.
 */
export function maskRing(mask: BinaryMask, vertices?: number): Vec2[] | null {
  const traced = traceBoundary(mask);
  if (traced.length < 3) return null;
  const first = traced[0];
  if (!first) return null;
  // simplify works on an open polyline: close it, simplify, open it again
  const open = simplify([...traced, first], OUTLINE_TOLERANCE).slice(0, -1);
  const ring = vertices && open.length > vertices ? reduceRing(open, vertices) : open;
  return ring.length >= 3 ? ring.map(([x, y]) => [x + 0.5, y + 0.5] as Vec2) : null;
}

// ---------------------------------------------------------------- the segmenter

export interface SuggestCrop {
  key: string;
  size: number;
  x0: number;
  y1: number;
  res: number;
  rgb?: Uint8Array | undefined;
}

export interface SuggestRequest {
  click: Vec2;
  crop: SuggestCrop;
  /** Further clicks (project CRS) that add to or take away from the object. */
  refine?: readonly RefinePoint[] | undefined;
  bufferPx?: number | undefined;
  vertices?: number | undefined;
}

export type SuggestResult =
  | { ok: true; ring: Vec2[]; score: number; touchesEdge: boolean }
  | { ok: false; error: string; code?: 'stale' | 'unavailable' | 'nothing' };

export type SegmentStatus =
  | { available: true; model: string }
  | {
      available: false;
      reason: 'no-pack' | 'no-model' | 'no-runtime' | 'licence' | 'failed';
      detail?: string;
    };

export interface SegmenterDeps {
  /** The pipeline pack folder, or null. */
  packDir(): Promise<string | null>;
  loadRuntime(): Promise<OrtLike | null>;
}

export interface Segmenter {
  status(): Promise<SegmentStatus>;
  suggest(req: SuggestRequest): Promise<SuggestResult>;
}

const UNAVAILABLE: Record<Exclude<SegmentStatus, { available: true }>['reason'], string> = {
  'no-pack':
    'Suggest boundaries needs the pipeline pack. Add it on the Jobs page (Check the pipeline pack), then try again.',
  'no-model':
    'This pipeline pack has no boundary model. Update the pipeline pack to use Suggest boundaries.',
  'no-runtime': 'The ONNX runtime is not installed, so Suggest boundaries cannot run.',
  licence: 'The boundary model in the pipeline pack has a licence this app does not accept.',
  failed: 'The boundary model could not be loaded.',
};

/** What to tell a person when Suggest boundaries is not available. */
export function unavailableMessage(s: Exclude<SegmentStatus, { available: true }>): string {
  return s.detail && s.reason !== 'no-pack' && s.reason !== 'no-model'
    ? `${UNAVAILABLE[s.reason]} ${s.detail}`
    : UNAVAILABLE[s.reason];
}

const MAX_DECODED = 16;

export function createSegmenter(deps: SegmenterDeps): Segmenter {
  let sessions: {
    model: SamModel;
    ort: OrtLike;
    encoder: OrtSession;
    decoder: OrtSession;
  } | null = null;
  /** The last crop's embeddings and the masks of its clicks (by click cell). */
  let cached: {
    key: string;
    embeddings: OrtTensor;
    decoded: Map<string, { mask: BinaryMask; score: number }>;
  } | null = null;

  async function load(): Promise<
    | { ok: true; s: NonNullable<typeof sessions> }
    | { ok: false; status: Exclude<SegmentStatus, { available: true }> }
  > {
    const found = await findSegmentModel(await deps.packDir());
    if (!found.ok) {
      return {
        ok: false,
        status: {
          available: false,
          reason: found.reason,
          ...(found.detail ? { detail: found.detail } : {}),
        },
      };
    }
    const { model } = found;
    if (sessions?.model.encoder === model.encoder && sessions.model.decoder === model.decoder) {
      return { ok: true, s: sessions };
    }
    const ort = await deps.loadRuntime();
    if (!ort) return { ok: false, status: { available: false, reason: 'no-runtime' } };
    try {
      const encoder = await ort.InferenceSession.create(model.encoder);
      const decoder = await ort.InferenceSession.create(model.decoder);
      sessions = { model, ort, encoder, decoder };
      cached = null;
      return { ok: true, s: sessions };
    } catch (e) {
      return {
        ok: false,
        status: { available: false, reason: 'failed', detail: String(e).slice(0, 300) },
      };
    }
  }

  return {
    async status() {
      const found = await findSegmentModel(await deps.packDir());
      if (!found.ok) {
        return {
          available: false,
          reason: found.reason,
          ...(found.detail ? { detail: found.detail } : {}),
        };
      }
      if (!(await deps.loadRuntime())) return { available: false, reason: 'no-runtime' };
      const v = found.model.card.version;
      return {
        available: true,
        model: v ? `${found.model.card.name} ${v}` : found.model.card.name,
      };
    },

    async suggest({ click, crop, refine, bufferPx, vertices }) {
      const l = await load();
      if (!l.ok) return { ok: false, error: unavailableMessage(l.status), code: 'unavailable' };
      const { ort, encoder, decoder, model } = l.s;
      // the crop on the model's grid: a pixel there is `res * size / SAM_SIZE` on the ground
      const scale = SAM_SIZE / crop.size;
      const res = crop.res / scale;
      const at: Vec2 = [(click[0] - crop.x0) / res, (crop.y1 - click[1]) / res];
      if (at[0] < 0 || at[1] < 0 || at[0] >= SAM_SIZE || at[1] >= SAM_SIZE) {
        return { ok: false, error: 'The click is outside the ortho crop.', code: 'nothing' };
      }
      try {
        if (cached?.key !== crop.key) {
          if (!crop.rgb)
            return { ok: false, error: 'The ortho crop is no longer held.', code: 'stale' };
          if (crop.rgb.length !== crop.size * crop.size * 3) {
            return { ok: false, error: 'The ortho crop has the wrong size.', code: 'nothing' };
          }
          const { data, dims } = encoderTensor(
            model.card.input,
            resizeRgb(crop.rgb, crop.size, SAM_SIZE),
          );
          const out = await encoder.run({
            [encoder.inputNames[0] ?? 'image']: new ort.Tensor('float32', data, dims),
          });
          const embeddings = out[encoder.outputNames[0] ?? 'image_embeddings'];
          if (!embeddings)
            return {
              ok: false,
              error: 'The boundary model returned no embeddings.',
              code: 'nothing',
            };
          cached = { key: crop.key, embeddings, decoded: new Map() };
        }
        const more: RefinePoint[] = [];
        for (const r of refine ?? []) {
          const p: Vec2 = [(r.at[0] - crop.x0) / res, (crop.y1 - r.at[1]) / res];
          // a click outside the crop cannot steer the model
          if (p[0] >= 0 && p[1] >= 0 && p[0] < SAM_SIZE && p[1] < SAM_SIZE) {
            more.push({ at: p, include: r.include });
          }
        }
        const cell = [at, ...more.map((m) => m.at)]
          .map(
            (p, i) =>
              `${String(Math.round(p[0]))},${String(Math.round(p[1]))}${i && !more[i - 1]?.include ? '-' : ''}`,
          )
          .join(';');
        let hit = cached.decoded.get(cell);
        if (!hit) {
          const feeds = decoderFeeds(ort, cached.embeddings, at, more);
          const res2 = await decoder.run(
            Object.fromEntries(
              decoder.inputNames.map((n) => [n, feeds[n] ?? cached?.embeddings]),
            ) as Record<string, OrtTensor>,
          );
          const masks = res2.masks ?? res2[decoder.outputNames[0] ?? 'masks'];
          const scores = res2.iou_predictions ?? res2[decoder.outputNames[1] ?? 'iou_predictions'];
          const best = masks ? bestMask(masks, scores) : null;
          if (!best)
            return { ok: false, error: 'The boundary model returned no mask.', code: 'nothing' };
          hit = { mask: fillHoles(regionAt(best.mask, at)), score: best.score };
          if (cached.decoded.size >= MAX_DECODED) cached.decoded.clear();
          cached.decoded.set(cell, hit);
        }
        const grown = bufferMask(hit.mask, (bufferPx ?? 0) * scale);
        const ring = maskRing(grown, vertices);
        if (!ring)
          return {
            ok: false,
            error: 'Nothing to outline here. Click inside the object.',
            code: 'nothing',
          };
        return {
          ok: true,
          ring: ring.map(([x, y]) => [crop.x0 + x * res, crop.y1 - y * res] as Vec2),
          score: hit.score,
          touchesEdge: touchesEdge(grown),
        };
      } catch (e) {
        return {
          ok: false,
          error: `Suggest boundaries failed: ${String(e).slice(0, 300)}`,
          code: 'nothing',
        };
      }
    },
  };
}
