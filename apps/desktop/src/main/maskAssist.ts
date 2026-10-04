/**
 * Mask assist (BLD-10, optional): a SAM-class model outlines the object in a box the reviewer
 * drew. No model ships with the app (licences): it is available only when the pipeline pack
 * carries one in `models/sam/` (`encoder.onnx`, `decoder.onnx`, optional `model.json` with a
 * `name`) and `onnxruntime-node` can be loaded. Everything else in the review works without it.
 *
 * The model is the usual SAM / MobileSAM ONNX export: the encoder takes a 1024 x 1024 normalised
 * RGB image (longest side scaled to 1024, padded right and bottom), the decoder takes the
 * embeddings, the box as two labelled points (2, 3), an empty mask input and the original size,
 * and returns mask logits at the original size with an IoU score per mask.
 */
import { maskToPolygon, type MaskAssistStatus } from '@aio/annotate/detections';
import type { Vec2 } from '@aio/schema';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SAM_SIZE = 1024;
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];

/** The part of onnxruntime this module uses (so tests can stand in for it). */
export interface OrtTensor {
  data: Float32Array | Uint8Array | ArrayLike<number>;
  dims: readonly number[];
}
export interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
export interface OrtLike {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
}

export interface SamModel {
  name: string;
  encoder: string;
  decoder: string;
}

/** An image scaled so its longest side is at most `maxSide`, as RGBA, with its original size. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Size of `rgba`. */
  scaledWidth: number;
  scaledHeight: number;
  rgba: Uint8Array;
}

export interface MaskAssistDeps {
  /** The pipeline pack folder, or null. */
  packDir(): Promise<string | null>;
  loadRuntime(): Promise<OrtLike | null>;
  decode(path: string, maxSide: number): Promise<DecodedImage>;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** The SAM model in a pipeline pack, if it carries one. */
export async function findSamModel(packDir: string | null): Promise<SamModel | null> {
  if (!packDir) return null;
  const dir = join(packDir, 'models', 'sam');
  const encoder = join(dir, 'encoder.onnx');
  const decoder = join(dir, 'decoder.onnx');
  if (!(await exists(encoder)) || !(await exists(decoder))) return null;
  let name = 'SAM';
  try {
    const meta = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8')) as { name?: unknown };
    if (typeof meta.name === 'string' && meta.name.trim()) name = meta.name.trim().slice(0, 80);
  } catch {
    // no model.json: keep the generic name
  }
  return { name, encoder, decoder };
}

/** onnxruntime-node when it is installed (it is not a dependency of the app by default). */
export async function loadOnnxRuntime(): Promise<OrtLike | null> {
  const spec = 'onnxruntime-node';
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as { default?: unknown } & Partial<OrtLike>;
    const ort = (mod.InferenceSession ? mod : mod.default) as Partial<OrtLike> | undefined;
    return ort?.InferenceSession && ort.Tensor ? (ort as OrtLike) : null;
  } catch {
    return null;
  }
}

/** CHW float tensor data of the padded, normalised 1024 x 1024 encoder input. */
export function encoderInput(img: DecodedImage): Float32Array {
  const plane = SAM_SIZE * SAM_SIZE;
  const out = new Float32Array(3 * plane);
  for (let c = 0; c < 3; c++) {
    const mean = MEAN[c] ?? 0;
    const std = STD[c] ?? 1;
    // padding is the normalised value of black
    out.fill(-mean / std, c * plane, (c + 1) * plane);
  }
  for (let y = 0; y < img.scaledHeight; y++) {
    for (let x = 0; x < img.scaledWidth; x++) {
      const i = (y * img.scaledWidth + x) * 4;
      const o = y * SAM_SIZE + x;
      for (let c = 0; c < 3; c++) {
        out[c * plane + o] = ((img.rgba[i + c] ?? 0) - (MEAN[c] ?? 0)) / (STD[c] ?? 1);
      }
    }
  }
  return out;
}

/** Index of the mask with the best predicted IoU. */
function bestMask(iou: OrtTensor | undefined, count: number): number {
  if (!iou) return 0;
  let best = 0;
  for (let i = 1; i < count; i++) if ((iou.data[i] ?? 0) > (iou.data[best] ?? 0)) best = i;
  return best;
}

export interface MaskAssist {
  status(): Promise<MaskAssistStatus>;
  /** Outline of the object in `box` ([x, y, w, h] in photo pixels) of the image at `path`. */
  segment(
    path: string,
    box: readonly [number, number, number, number],
  ): Promise<{ ok: true; points: Vec2[] } | { ok: false; error: string }>;
}

export function createMaskAssist(deps: MaskAssistDeps): MaskAssist {
  let sessions: { model: SamModel; encoder: OrtSession; decoder: OrtSession; ort: OrtLike } | null =
    null;
  /** The last image's embeddings: refining boxes on one photo encodes it once. */
  let cached: { path: string; image: DecodedImage; embeddings: OrtTensor } | null = null;

  async function load(): Promise<
    | { ok: true; s: NonNullable<typeof sessions> }
    | { ok: false; status: Extract<MaskAssistStatus, { available: false }> }
  > {
    const model = await findSamModel(await deps.packDir());
    if (!model) return { ok: false, status: { available: false, reason: 'no-model' } };
    if (sessions?.model.encoder === model.encoder) return { ok: true, s: sessions };
    const ort = await deps.loadRuntime();
    if (!ort) return { ok: false, status: { available: false, reason: 'no-runtime' } };
    try {
      const encoder = await ort.InferenceSession.create(model.encoder);
      const decoder = await ort.InferenceSession.create(model.decoder);
      sessions = { model, encoder, decoder, ort };
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
      const model = await findSamModel(await deps.packDir());
      if (!model) return { available: false, reason: 'no-model' };
      if (!(await deps.loadRuntime())) return { available: false, reason: 'no-runtime' };
      return { available: true, model: model.name };
    },
    async segment(path, box) {
      const l = await load();
      if (!l.ok) {
        const why =
          l.status.reason === 'no-model'
            ? 'No mask model is installed in the pipeline pack.'
            : l.status.reason === 'no-runtime'
              ? 'The ONNX runtime is not installed.'
              : `The mask model could not be loaded: ${l.status.detail ?? ''}`;
        return { ok: false, error: why };
      }
      const { ort, encoder, decoder } = l.s;
      try {
        if (cached?.path !== path) {
          const image = await deps.decode(path, SAM_SIZE);
          const input = new ort.Tensor('float32', encoderInput(image), [1, 3, SAM_SIZE, SAM_SIZE]);
          const out = await encoder.run({ [encoder.inputNames[0] ?? 'image']: input });
          const embeddings = out[encoder.outputNames[0] ?? 'image_embeddings'];
          if (!embeddings) return { ok: false, error: 'The mask model returned no embeddings.' };
          cached = { path, image, embeddings };
        }
        const { image, embeddings } = cached;
        const s = SAM_SIZE / Math.max(image.width, image.height);
        const [x, y, w, h] = box;
        const feeds: Record<string, OrtTensor> = {
          image_embeddings: embeddings,
          point_coords: new ort.Tensor(
            'float32',
            new Float32Array([x * s, y * s, (x + w) * s, (y + h) * s]),
            [1, 2, 2],
          ),
          point_labels: new ort.Tensor('float32', new Float32Array([2, 3]), [1, 2]),
          mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
          has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
          orig_im_size: new ort.Tensor(
            'float32',
            new Float32Array([image.height, image.width]),
            [2],
          ),
        };
        const res = await decoder.run(
          Object.fromEntries(
            decoder.inputNames.map((n) => [n, feeds[n] ?? feeds.image_embeddings]),
          ) as Record<string, OrtTensor>,
        );
        const masks = res.masks ?? res[decoder.outputNames[0] ?? 'masks'];
        if (masks?.dims.length !== 4)
          return { ok: false, error: 'The mask model returned no mask.' };
        const [, count = 1, mh = 0, mw = 0] = masks.dims;
        const pick = bestMask(
          res.iou_predictions ?? res[decoder.outputNames[1] ?? 'iou_predictions'],
          count,
        );
        const data = new Uint8Array(mw * mh);
        const off = pick * mw * mh;
        for (let i = 0; i < data.length; i++) data[i] = (masks.data[off + i] ?? 0) > 0 ? 1 : 0;
        const poly = maskToPolygon(
          { width: mw, height: mh, data },
          { width: image.width, height: image.height },
          Math.max(1, Math.round(Math.max(mw, mh) / 400)),
        );
        if (!poly) return { ok: false, error: 'The mask model found nothing inside the box.' };
        return { ok: true, points: poly.points };
      } catch (e) {
        return { ok: false, error: `Mask assist failed: ${String(e).slice(0, 300)}` };
      }
    },
  };
}
