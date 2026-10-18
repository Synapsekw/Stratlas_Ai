import { z } from 'zod';
import { EvidenceRef, ParamQuality } from './assemblies';
import { Mat4, Sha256Hex, Vec3 } from './common';

/** Persistent source-derived identity; independent of array order, AI wording or fitted position. */
export const ObservationId = z.string().regex(/^obs-[a-z0-9-]{1,64}$/);
export const ObservationKind = z.enum([
  'panel',
  'rru',
  'equipment-box',
  'mounting-pipe',
  'platform',
  'beam',
  'cabinet',
  'canopy',
  'slab',
  'fence',
  'cable',
  'light',
  'climbing-steps',
]);
const Length = z.number().positive().max(1000);

/** A fitted component in x-east/y-up/z-south metres. Size is width, height, depth, never one scale. */
export const ComponentObservation = z
  .object({
    id: ObservationId,
    kind: ObservationKind,
    name: z.string().min(1).max(80).optional(),
    parent: ObservationId.optional(),
    centre: Vec3,
    /** Measured centreline for a pipe/beam/cable, or a platform outline, in the same local frame. */
    path: z.array(Vec3).min(2).max(256).optional(),
    /** Fitted roof faces in the same source frame, each ordered around its perimeter. */
    surfaces: z
      .array(z.tuple([Vec3, Vec3, Vec3, Vec3]))
      .min(1)
      .max(8)
      .optional(),
    size: z.tuple([Length, Length, Length]),
    /** Direction of the front normal, clockwise from grid north; not the bearing from the shaft. */
    azimuthDeg: z.number().min(0).lt(360),
    tiltDeg: z.number().min(-90).max(90),
    quality: z
      .object({
        centre: ParamQuality,
        width: ParamQuality,
        height: ParamQuality,
        depth: ParamQuality,
        azimuthDeg: ParamQuality,
        tiltDeg: ParamQuality,
      })
      .strict(),
    sources: z.array(EvidenceRef).min(1).max(32),
    notes: z.array(z.string().max(200)).max(8).optional(),
  })
  .strict();

/** Local measurements are only reusable in the source frame that produced them. */
export const MeasurementFrame = z
  .object({
    coordinates: z.literal('project-local'),
    /** Project CRS easting/northing/elevation origin, before per-cloud height offsets. */
    origin: Vec3,
    algorithm: z.string().min(1).max(80),
    signature: Sha256Hex,
    sources: z
      .array(
        z
          .object({
            layer: z.string().min(1).max(128),
            kind: z.enum(['cloud', 'mesh']),
            heightOffsetM: z.number(),
            transform: Mat4.optional(),
            contentHash: Sha256Hex.optional(),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();

export type ComponentObservation = z.infer<typeof ComponentObservation>;
export type MeasurementFrame = z.infer<typeof MeasurementFrame>;
export type ObservationKind = z.infer<typeof ObservationKind>;
