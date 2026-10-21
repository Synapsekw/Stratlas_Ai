import { z } from 'zod';
import { Box, Point2, Polygon } from './annotation';
import { Id, IsoTime, Sha256Hex, Vec2 } from './common';

/**
 * Thermal analysis (spec 2026-10-21): radiometric photos decoded to a temperature raster, readings
 * a person takes on them, and hot spots. Everything lives in the project's `thermal/` folder, which
 * older builds ignore. Objects are plain (not strict) so a later additive field passes older readers.
 */

export const THERMAL_SCHEMA = 'aio.thermal/1';
export const THERMAL_RASTER_SCHEMA = 'aio.thermalRaster/1';
export const THERMAL_CANDIDATES_SCHEMA = 'aio.thermalCandidates/1';

/** The oldest pipeline pack with `thermal.decode`. */
export const THERMAL_MIN_PACK = '0.21.0';

/** Which decoder read the photo. */
export const ThermalFamily = z.enum(['flir', 'dji-tsdk']);
export type ThermalFamily = z.infer<typeof ThermalFamily>;

/** How a photo decoded: `unverified` and `implausible` are decoded but not trusted. */
export const ThermalPhotoStatus = z.enum(['ok', 'unsupported', 'unverified', 'implausible']);
export type ThermalPhotoStatus = z.infer<typeof ThermalPhotoStatus>;

/** The scene settings a temperature is computed with. `reflectedC` null means the same as the air. */
export const ThermalSettings = z.object({
  emissivity: z.number().gt(0).max(1),
  distanceM: z.number().min(0),
  airC: z.number(),
  humidityPct: z.number().min(0).max(100),
  reflectedC: z.number().nullable(),
});
export type ThermalSettings = z.infer<typeof ThermalSettings>;

/** The key of a photo in `ThermalFile.photos`: `"<layerId>/<photoId>"`. */
export function thermalPhotoKey(layerId: string, photoId: string): string {
  return `${layerId}/${photoId}`;
}

// --------------------------------------------------------------------------- raster sidecars

/** `thermal/rasters/<layerId>/<photoId>.json`, beside the little-endian float32 degC `.f32`. */
export const ThermalRasterMeta = z.object({
  schema: z.literal(THERMAL_RASTER_SCHEMA),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  family: ThermalFamily,
  camera: z.string(),
  /** Camera constants the decoder read (Planck R1, R2, B, F, O and so on). */
  constants: z.record(z.string(), z.number()).optional(),
  /** The settings this raster was computed with. */
  settings: ThermalSettings,
  /** Names of the settings that were out of range and clamped. */
  clamped: z.array(z.string()),
  minC: z.number(),
  maxC: z.number(),
  medianC: z.number(),
  decoder: z.string(),
  /** Hash of the photo bytes and settings: a raster is stale when it no longer matches. */
  settingsKey: Sha256Hex,
});
export type ThermalRasterMeta = z.infer<typeof ThermalRasterMeta>;

/** `thermal/rasters/<layerId>/index.json`: the status of every photo of a layer. */
export const ThermalRasterIndex = z.object({
  schema: z.literal(THERMAL_RASTER_SCHEMA),
  photos: z.record(
    Id,
    z.object({
      status: ThermalPhotoStatus,
      reason: z.string().optional(),
    }),
  ),
});
export type ThermalRasterIndex = z.infer<typeof ThermalRasterIndex>;

// --------------------------------------------------------------------------- readings

export const ThermalLine = z.object({ type: z.literal('line'), points: z.array(Vec2).min(2) });
export const ThermalGeom = z.discriminatedUnion('type', [Point2, Box, Polygon, ThermalLine]);
export type ThermalGeom = z.infer<typeof ThermalGeom>;

/** A reading a person takes on a decoded photo (point, box, polygon or line). */
export const ThermalReading = z.object({
  id: Id,
  layer: Id,
  photo: Id,
  geom: ThermalGeom,
  stats: z.object({ maxC: z.number(), minC: z.number(), meanC: z.number() }),
  note: z.string().optional(),
});
export type ThermalReading = z.infer<typeof ThermalReading>;

// --------------------------------------------------------------------------- hot spots

/** One photo that shows a hot spot. `box` is in photo pixels. */
export const HotSpotSighting = z.object({
  layer: Id,
  photo: Id,
  box: Box,
  peakC: z.number(),
  meanC: z.number(),
});
export type HotSpotSighting = z.infer<typeof HotSpotSighting>;

/** What a hot spot is compared with: its surroundings, or a reading a person picked. */
export const ThermalReference = z
  .object({
    kind: z.enum(['surroundings', 'reading']),
    readingId: Id.optional(),
    valueC: z.number(),
  })
  .refine((r) => r.kind !== 'reading' || r.readingId !== undefined, {
    message: 'A reference to a reading needs its readingId.',
    path: ['readingId'],
  });
export type ThermalReference = z.infer<typeof ThermalReference>;

export const HotSpot = z
  .object({
    id: Id,
    /** The issue a confirmed hot spot became. */
    issueId: Id.optional(),
    state: z.enum(['proposed', 'confirmed', 'dismissed']),
    origin: z.enum(['detection', 'manual']),
    sightings: z.array(HotSpotSighting),
    reference: ThermalReference,
    peakC: z.number(),
    meanC: z.number(),
    deltaC: z.number(),
    severity: z.number().int().nullable(),
    /** The severity a person reviewed; it holds when settings or thresholds change. */
    reviewedSeverity: z.number().int().nullable().optional(),
    changedSinceReview: z.boolean().optional(),
    leaveOut: z.boolean().optional(),
    note: z.string().optional(),
  })
  .refine((h) => h.state !== 'confirmed' || h.issueId !== undefined, {
    message: 'A confirmed hot spot needs its issueId.',
    path: ['issueId'],
  });
export type HotSpot = z.infer<typeof HotSpot>;

// --------------------------------------------------------------------------- grading

export const ThermalGradingLevel = z.object({
  value: z.number().int(),
  minDeltaC: z.number(),
});

/**
 * Severity by temperature difference: a hot spot takes the highest level whose `minDeltaC` its
 * delta, rounded to 0.1 degC, reaches. `minDeltaC` ascends.
 */
export const ThermalGrading = z
  .object({ levels: z.array(ThermalGradingLevel).min(1) })
  .refine(
    (g) => g.levels.every((l, i) => i === 0 || l.minDeltaC > (g.levels[i - 1]?.minDeltaC ?? 0)),
    {
      message: 'minDeltaC must ascend from level to level.',
      path: ['levels'],
    },
  );
export type ThermalGrading = z.infer<typeof ThermalGrading>;

export const DEFAULT_GRADING: ThermalGrading = {
  levels: [
    { value: 1, minDeltaC: 4 },
    { value: 2, minDeltaC: 16 },
    { value: 3, minDeltaC: 40.1 },
  ],
};

// --------------------------------------------------------------------------- the project file

/** `thermal/thermal.json`. A missing `grading` means `DEFAULT_GRADING`. */
export const ThermalFile = z.object({
  schema: z.literal(THERMAL_SCHEMA),
  defaults: ThermalSettings.optional(),
  photos: z.record(z.string().min(1), z.object({ settings: ThermalSettings })),
  readings: z.array(ThermalReading),
  hotspots: z.array(HotSpot),
  grading: ThermalGrading.optional(),
  /** Offset and scale lining the thermal frame over the visible photo, per layer. */
  alignment: z
    .record(Id, z.object({ dx: z.number(), dy: z.number(), scale: z.number().positive() }))
    .optional(),
});
export type ThermalFile = z.infer<typeof ThermalFile>;

// --------------------------------------------------------------------------- detection output

/** One candidate hot spot found by `thermal.hotspots` (M3). */
export const ThermalCandidate = z.object({
  layer: Id,
  photo: Id,
  box: Box,
  peakC: z.number(),
  meanC: z.number(),
  referenceC: z.number(),
  deltaC: z.number(),
});
export type ThermalCandidate = z.infer<typeof ThermalCandidate>;

/** `thermal/candidates.json`, replaced by every detection run. */
export const ThermalCandidatesFile = z.object({
  schema: z.literal(THERMAL_CANDIDATES_SCHEMA),
  at: IsoTime.optional(),
  candidates: z.array(ThermalCandidate),
});
export type ThermalCandidatesFile = z.infer<typeof ThermalCandidatesFile>;

// --------------------------------------------------------------------------- job params

/** `thermal.decode`: decode the radiometric photos of a layer into rasters. */
export const ThermalDecodeParams = z.object({
  layerId: Id,
  /** The photos to decode; left out, the whole layer. Never empty (the job refuses it). */
  photos: z.array(Id).min(1).optional(),
  force: z.boolean().optional(),
});
export type ThermalDecodeParams = z.infer<typeof ThermalDecodeParams>;

/** `thermal.hotspots` (M3): find hot spots over decoded rasters. */
export const ThermalHotspotsParams = z.object({
  layerId: Id,
  photos: z.array(Id).optional(),
  rule: z.enum(['absolute', 'delta']),
  thresholdC: z.number(),
  minAreaPx: z.number().int().positive().optional(),
  maxPerPhoto: z.number().int().positive().optional(),
});
export type ThermalHotspotsParams = z.infer<typeof ThermalHotspotsParams>;
