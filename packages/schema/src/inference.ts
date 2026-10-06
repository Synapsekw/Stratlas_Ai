import { z } from 'zod';
import { Id } from './common';

/**
 * Local ONNX detection (M8, BLD-10). onnxruntime-node ships inside the app and runs in an Electron
 * utility process; no detector model ships. A person imports `model.onnx` with its model card
 * `model.json` (`aio.detector/1`, data-conventions section 16): layout, input, classes and an SPDX
 * licence. Results are draft detection passes (`source: 'model'`) in the existing review.
 */

export const DETECTOR_SCHEMA = 'aio.detector/1' as const;

/** How the model's output tensors are laid out (post-processing per layout). */
export const DetectorLayout = z.enum(['yolo-v8', 'yolo-v5', 'detr', 'ssd', 'generic']);

/** A model id: the folder name under `models/detect/`. */
export const DetectorModelId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'A model id is lower case letters, digits, . _ and -.');

const Triple = z.tuple([z.number(), z.number(), z.number()]);

export const DetectorModelCard = z
  .object({
    schema: z.literal(DETECTOR_SCHEMA),
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(40),
    layout: DetectorLayout,
    input: z
      .object({
        width: z.number().int().min(16).max(8192),
        height: z.number().int().min(16).max(8192),
        /** Tensor layout; default `nchw`. */
        tensor: z.enum(['nchw', 'nhwc']).optional(),
        color: z.enum(['rgb', 'bgr']).optional(),
        /** Pixel values are divided by `scale` (default 255), then `(v - mean) / std`. */
        scale: z.number().positive().optional(),
        mean: Triple.optional(),
        std: Triple.optional(),
      })
      .strict(),
    classes: z.array(z.string().min(1).max(80)).min(1).max(1000),
    /** SPDX licence expression of the weights, e.g. `MIT`, `Apache-2.0`. */
    licence: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[A-Za-z0-9.+\-() ]+$/, 'The licence is an SPDX expression.'),
    /** Where the weights come from (paper, repository, "Stratlas test fixture"). */
    source: z.string().min(1).max(500),
    /** SHA-256 of `model.onnx`. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    description: z.string().max(2000).optional(),
    author: z.string().max(200).optional(),
    /** Default confidence threshold for this model. */
    minConfidence: z.number().min(0).max(1).optional(),
  })
  .strict();

/** The onnxruntime the app found: execution provider in use, or why it is not usable. */
export const InferenceRuntime = z.object({
  available: z.boolean(),
  /** `dml` DirectML (Windows), `coreml` (macOS) or `cpu`. */
  provider: z.enum(['dml', 'coreml', 'cpu']).optional(),
  version: z.string().optional(),
  /** Execution providers this onnxruntime build lists (`cpu`, `dml`, `coreml`, ...). */
  backends: z.array(z.string().min(1).max(40)).max(32).optional(),
  problem: z.string().optional(),
});

/** One installed detector (`inference:models`). */
export const DetectorModelInfo = z.object({
  id: DetectorModelId,
  card: DetectorModelCard,
  /** `user`: imported into userData `models/detect/`; `pack`: in the pipeline pack. */
  where: z.enum(['user', 'pack']),
  sizeBytes: z.number().int().nonnegative(),
});

/** A photo of a photos layer or a frame of a video layer (`t`, video seconds). */
export const InferenceItem = z.union([
  z.object({ layer: Id, photo: Id }).strict(),
  z.object({ layer: Id, t: z.number().nonnegative() }).strict(),
]);

/** Settings, Detection models. */
export const InferenceSettings = z
  .object({
    /** Folder of imported models; empty or absent: userData `models/detect/`. */
    modelsDir: z.string().max(1024).optional(),
    /** `auto`: DirectML or CoreML when available, else CPU. */
    provider: z.enum(['auto', 'cpu']).optional(),
    /** Memory cap of the inference process, MB. */
    memoryCapMb: z.number().int().min(256).max(65536).optional(),
  })
  .strict();

export type DetectorLayout = z.infer<typeof DetectorLayout>;
export type DetectorModelCard = z.infer<typeof DetectorModelCard>;
export type DetectorModelInfo = z.infer<typeof DetectorModelInfo>;
export type InferenceRuntime = z.infer<typeof InferenceRuntime>;
export type InferenceItem = z.infer<typeof InferenceItem>;
export type InferenceSettings = z.infer<typeof InferenceSettings>;
