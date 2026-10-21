import { z } from 'zod';
import { Id, IsoTime } from './common';

/**
 * Local vision-model detectors (the Analytics pack). A detector is a folder
 * `detectors/<id>/detector.json` (`aio.vlm-detector/1`); the Analytics pack
 * (`aio.analytics-pack/1`) carries the model and the `llama-server` runtime the
 * `detect.vlm` job talks to on 127.0.0.1.
 */

export const ANALYTICS_PACK_SCHEMA = 'aio.analytics-pack/1';
export const ANALYTICS_PACK_PREFIX = 'analytics-pack';
export const VLM_DETECTOR_SCHEMA = 'aio.vlm-detector/1';
export const DETECTOR_FILE_EXTENSION = '.aiodet';
/** Total and free graphics memory a detector run needs, in MB. */
export const VLM_MIN_VRAM_MB = 8192;
export const VLM_MIN_FREE_VRAM_MB = 6656;
export const VLM_DEFAULT_THRESHOLD = 0.8;
export const VLM_DEFAULT_TILES = { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 } as const;
/** Where main records the running server, under the data root. */
export const VLM_SERVER_STATE = 'runtime/analytics-server.json';

/** Pass file name for a run: `vlm-<runId>.json` in `detections/`. */
export const vlmPassName = (runId: string): string =>
  `vlm-${runId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}.json`;

export const RejectReason = z.enum([
  'looks-like-but-is-not',
  'not-a-defect',
  'wrong-class',
  'box-wrong',
  'other',
]);
export type RejectReason = z.infer<typeof RejectReason>;

/** Where a detector comes from: the app, the project or the user's library. */
export const DetectorWhere = z.enum(['shipped', 'project', 'library']);
export type DetectorWhere = z.infer<typeof DetectorWhere>;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const SideMultiple28 = z
  .number()
  .int()
  .min(280)
  .max(2016)
  .refine((v) => v % 28 === 0, { message: 'Must be a multiple of 28.' });

/** Tiling of a photo for the model: `n` x `n` tiles, each sent at `sendW` x `sendH`. */
export const VlmTiles = z
  .object({
    n: z.number().int().min(1).max(4),
    overlap: z.number().min(0).max(0.5),
    sendW: SideMultiple28,
    sendH: SideMultiple28,
  })
  .strict();
export type VlmTiles = z.infer<typeof VlmTiles>;

/** A path inside the detector folder. */
const DetectorFile = z.string().regex(/^(samples|examples)\/[A-Za-z0-9._-]{1,100}$/);

export const VlmDetector = z
  .object({
    schema: z.literal(VLM_DETECTOR_SCHEMA),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
    name: z.string().min(1).max(80),
    version: z.number().int().min(1),
    classId: z.string().min(1).max(120),
    assetTypes: z.array(z.string()).min(1).max(10),
    looksLike: z.string().min(1).max(2000),
    ignore: z.string().max(2000),
    question: z.string().min(1).max(1000),
    tiles: VlmTiles,
    threshold: z.number().min(0).max(1),
    tunedOn: z.object({ model: z.string(), modelSha256: Sha256 }).strict(),
    author: z.string().max(120),
    createdAt: IsoTime,
    updatedAt: IsoTime,
    source: z.enum(['shipped', 'user', 'imported']),
    status: z.enum(['verified', 'experimental']),
    samples: z
      .array(z.object({ photo: z.string(), file: DetectorFile }).strict())
      .max(10)
      .optional(),
    examples: z
      .array(z.object({ file: DetectorFile, verdict: z.enum(['is', 'is-not']) }).strict())
      .max(20)
      .optional(),
  })
  .strict();
export type VlmDetector = z.infer<typeof VlmDetector>;

/** `manifest.json` at the root of the Analytics pack. */
export const AnalyticsPackManifest = z
  .object({
    schema: z.literal(ANALYTICS_PACK_SCHEMA),
    version: z.string().min(1),
    appRange: z.string().min(1).max(100),
    platform: z.string(),
    createdAt: z.string(),
    runtime: z
      .object({
        name: z.literal('llama.cpp'),
        release: z.string().min(1),
        executable: z.string().min(1),
      })
      .strict(),
    model: z
      .object({
        id: z.string().min(1),
        licence: z.string().min(1),
        gguf: z.string().min(1),
        mmproj: z.string().min(1),
        /** The gguf's. */
        sha256: Sha256,
      })
      .strict(),
    detectors: z.array(
      z
        .object({
          assetType: z.string(),
          id: z.string(),
          version: z.number().int().min(1),
          status: z.enum(['verified', 'experimental']),
        })
        .strict(),
    ),
    files: z.record(z.string(), z.object({ size: z.number().int().nonnegative(), sha256: Sha256 })),
  })
  .strict();
export type AnalyticsPackManifest = z.infer<typeof AnalyticsPackManifest>;

/** `detect.vlm` params. */
export const DetectVlmParams = z
  .object({
    run: z.string().regex(/^run-[a-z0-9-]{1,60}$/),
    layer: Id,
    photos: z.array(Id).min(1).max(5000),
    detectors: z
      .array(
        z
          .object({
            where: DetectorWhere,
            detector: VlmDetector,
            threshold: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    /** The server state file (`VLM_SERVER_STATE`), absolute. */
    serverFile: z
      .string()
      .min(1)
      .refine((p) => /^([A-Za-z]:[\\/]|\/|\\\\)/.test(p), { message: 'Must be an absolute path.' }),
    modelSha256: Sha256,
    model: z.string().min(1),
  })
  .strict();
export type DetectVlmParams = z.infer<typeof DetectVlmParams>;

/** What main writes to `VLM_SERVER_STATE` once the server answers. */
export const VlmServerState = z
  .object({
    url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/),
    pid: z.number().int().positive(),
    /** Random per launch; sent as a Bearer token. */
    apiKey: z.string().regex(/^[a-f0-9]{32}$/),
    modelSha256: Sha256,
    startedAt: IsoTime,
  })
  .strict();
export type VlmServerState = z.infer<typeof VlmServerState>;

export const HardwareCheck = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      gpu: z.string(),
      totalMb: z.number().int().nonnegative(),
      freeMb: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.string() }).strict(),
]);
export type HardwareCheck = z.infer<typeof HardwareCheck>;

const Box4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** One line of a detector's review ledger: a person's verdict on a candidate. */
export const LedgerEntry = z
  .object({
    detectorId: z.string(),
    detectorVersion: z.number().int().min(1),
    modelSha256: Sha256,
    score: z.number().nullable(),
    verdict: z.enum(['accepted', 'rejected', 'miss']),
    reason: RejectReason.optional(),
    note: z.string().max(200).optional(),
    /** `[x1, y1, x2, y2]` in source pixels. */
    box: Box4,
    corrected: Box4.optional(),
    photo: z.object({ project: z.string(), layer: z.string(), id: z.string() }).strict(),
    at: IsoTime,
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntry>;
