import { z } from 'zod';
import { ModelFamily } from './assemblies';
import { Detail, EvidenceRegion, RunId } from './engineer';

/**
 * The `model.evidence` job: measures an asset locally and writes a bounded evidence pack under
 * `engineering/<run>/` (`evidence.json`, `aio.evidence/1`, plus `img/*.png`). Steps, each resumable
 * and atomic: crop, ground, axis, sections, members, renders, photos, pack.
 */

/** Default sampling and image limits per detail. */
export const EVIDENCE_LIMITS = {
  fast: { maxPoints: 300_000, maxImages: 12, maxPx: 1024 },
  standard: { maxPoints: 1_000_000, maxImages: 24, maxPx: 1568 },
  detailed: { maxPoints: 2_000_000, maxImages: 40, maxPx: 1568 },
} as const satisfies Record<Detail, { maxPoints: number; maxImages: number; maxPx: number }>;

export const EvidenceLimits = z
  .object({
    maxPoints: z.number().int().positive().max(10_000_000),
    maxImages: z.number().int().positive().max(64),
    maxPx: z.number().int().positive().max(4096),
  })
  .strict();

/** An 8-bit sRGB channel. */
const Channel = z.number().min(0).max(255);

/** A photo id: the sha1 of the original file, lower-case hex. */
const PhotoId = z.string().regex(/^[0-9a-f]{40}$/);

/** Params of `model.evidence`. `limits` defaults from `EVIDENCE_LIMITS[detail]`. */
export const ModelEvidenceParams = z
  .object({
    /** Run id; the job writes under `engineering/<run>/`. */
    run: RunId,
    /** 0..4 pointcloud layers. */
    clouds: z.array(z.object({ layer: z.string().min(1).max(128) }).strict()).max(4),
    /** 0..2 mesh layers (reference evidence). */
    meshes: z.array(z.object({ layer: z.string().min(1).max(128) }).strict()).max(2),
    /** 0..400 photo originals, project-relative or absolute. */
    photos: z.array(z.object({ path: z.string().min(1).max(1000) }).strict()).max(400),
    region: EvidenceRegion.optional(),
    detail: Detail,
    limits: EvidenceLimits.optional(),
  })
  .strict()
  .transform((p) => ({ ...p, limits: p.limits ?? { ...EVIDENCE_LIMITS[p.detail] } }));

export const SliceFit = z
  .object({
    y: z.number(),
    centre: z.tuple([z.number(), z.number()]),
    r: z.number().positive(),
    residualM: z.number().nonnegative(),
    support: z.number().int().nonnegative(),
    coverage: z.number().min(0).max(1),
    shape: z.enum(['circle', 'polygon', 'square']).default('circle'),
  })
  .strict();

export const MemberGroup = z
  .object({
    kind: z.enum(['flue', 'light-candidate', 'leg', 'antenna-candidate', 'platform']),
    items: z
      .array(
        z
          .object({
            centre: z.tuple([z.number(), z.number(), z.number()]),
            size: z.number().nonnegative(),
            support: z.number().int().nonnegative(),
            azimuthDeg: z.number().min(0).max(360).optional(),
          })
          .strict(),
      )
      .max(128),
    metrics: z
      .object({
        residualM: z.number().nonnegative().optional(),
        regularity: z.number().min(0).max(1).optional(),
      })
      .strict(),
  })
  .strict();

/** A photo in the inventory. `gpsCamera` is the camera position only, never a subject position. */
export const PhotoItem = z
  .object({
    id: PhotoId,
    original: z.string().min(1).max(1000),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    orientationApplied: z.boolean(),
    blur: z.number().nonnegative(),
    /** Id of the kept photo this one nearly duplicates. */
    dupOf: PhotoId.optional(),
    gpsCamera: z.tuple([z.number(), z.number(), z.number()]).optional(),
    review: z.string().max(200).optional(),
  })
  .strict();

export const EvidenceImage = z
  .object({
    id: z.string().regex(/^img-[a-z0-9-]{1,40}$/),
    file: z.string().max(200),
    kind: z.enum(['side', 'top', 'slice', 'crop', 'photo']),
    view: z.string().max(40),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    bytes: z.number().int().nonnegative(),
    sha1: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

/** `engineering/<run>/evidence.json`: the output of `model.evidence`. */
export const EvidencePack = z
  .object({
    schema: z.literal('aio.evidence/1'),
    run: RunId,
    crs: z
      .union([
        z.object({ epsg: z.number().int().min(1024).max(999999) }).strict(),
        z.object({ wkt: z.string().min(1).max(20_000) }).strict(),
      ])
      .nullable(),
    units: z.literal('m'),
    /** The region the job cropped to, or null when it kept the whole source. */
    crop: EvidenceRegion.nullable(),
    bounds: z
      .object({
        min: z.tuple([z.number(), z.number(), z.number()]),
        max: z.tuple([z.number(), z.number(), z.number()]),
      })
      .strict()
      .nullable(),
    samples: z
      .object({
        read: z.number().int().nonnegative(),
        kept: z.number().int().nonnegative(),
        ground: z.number().int().nonnegative(),
      })
      .strict(),
    axis: z
      .object({
        point: z.tuple([z.number(), z.number(), z.number()]),
        dir: z.tuple([z.number(), z.number(), z.number()]),
        tiltDeg: z.number().min(0).max(90),
      })
      .strict()
      .nullable(),
    base: z.tuple([z.number(), z.number(), z.number()]).nullable(),
    height: z.number().positive().nullable(),
    slices: z.array(SliceFit).max(256),
    taper: z
      .object({
        profile: z.array(z.object({ y: z.number(), r: z.number().positive() }).strict()).max(64),
        residualM: z.number().nonnegative(),
      })
      .strict()
      .nullable(),
    members: z.array(MemberGroup).max(16),
    familyHints: z
      .object({
        fillRatio: z.number().min(0).max(1),
        slenderness: z.number().nonnegative(),
        topFeatures: z.number().int().nonnegative(),
        suggested: ModelFamily,
      })
      .strict()
      .nullable(),
    colours: z
      .array(
        z
          .object({
            y0: z.number(),
            y1: z.number(),
            /** Mean sRGB colour of the band, 8-bit channels 0..255. */
            rgb: z.tuple([Channel, Channel, Channel]),
          })
          .strict(),
      )
      .max(64),
    photos: z.array(PhotoItem).max(400),
    images: z.array(EvidenceImage).max(64),
    reconstruction: z.enum(['not-needed', 'unavailable', 'used']),
    warnings: z.array(z.string().max(300)).max(50),
  })
  .strict();

export type EvidenceLimits = z.infer<typeof EvidenceLimits>;
/** The parsed params (limits filled in). */
export type ModelEvidenceParams = z.output<typeof ModelEvidenceParams>;
export type ModelEvidenceParamsInput = z.input<typeof ModelEvidenceParams>;
export type SliceFit = z.infer<typeof SliceFit>;
export type MemberGroup = z.infer<typeof MemberGroup>;
export type PhotoItem = z.infer<typeof PhotoItem>;
export type EvidenceImage = z.infer<typeof EvidenceImage>;
export type EvidencePack = z.infer<typeof EvidencePack>;
