import { z } from 'zod';
import { AssetRef, Id, IsoTime, Mat4, Quat, Vec3 } from './common';

export const LensModel = z.discriminatedUnion('model', [
  z.object({
    model: z.literal('pinhole'),
    hfovDeg: z.number().gt(0).lt(180),
    aspect: z.number().positive(),
  }),
  z.object({
    model: z.literal('ftheta'),
    hfovDeg: z.number().gt(0).lte(360),
    aspect: z.number().positive(),
    k: z.array(z.number()).optional(),
  }),
]);

/** One drone pose. `t` is milliseconds since flight start; position in the project local frame. */
export const PoseSample = z.object({
  t: z.number().nonnegative(),
  pos: Vec3,
  q: Quat,
  gimbal: z.object({ pitch: z.number(), yaw: z.number(), roll: z.number() }).optional(),
});

export const FlightRef = z.object({ src: AssetRef, startUtcMs: z.number().int() });

export const AssetTag = z.object({
  node: z.string(),
  tag: z.string(),
  area: z.string().optional(),
});

export const PhotoRef = z.object({
  id: Id,
  src: AssetRef,
  takenAt: IsoTime.optional(),
  pos: Vec3.optional(),
  q: Quat.optional(),
  lens: LensModel.optional(),
});

export const PanoRef = z.object({
  id: Id,
  src: AssetRef,
  pos: Vec3,
  headingDeg: z.number().default(0),
});

const base = { id: Id, name: z.string().min(1), visible: z.boolean().default(true) };

export const Layer = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mesh'),
    ...base,
    src: AssetRef,
    transform: Mat4,
    tags: z.array(AssetTag).optional(),
  }),
  z.object({
    kind: z.literal('pointcloud'),
    ...base,
    src: AssetRef,
    format: z.enum(['copc', 'potree2', 'kit-packed', 'png-packed']),
    pointCount: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('basemap'),
    ...base,
    pack: z.string().min(1),
    style: z.enum(['dark', 'light']),
  }),
  z.object({
    kind: z.literal('raster'),
    ...base,
    src: AssetRef,
    role: z.enum(['ortho', 'dsm', 'plan']),
    format: z.enum(['cog', 'pmtiles', 'kit-pyramid', 'image']),
    /** Model-frame corners for plain images: top-left, top-right, bottom-left. */
    corners: z.object({ tl: Vec3, tr: Vec3, bl: Vec3 }).optional(),
  }),
  z.object({
    kind: z.literal('video'),
    ...base,
    src: AssetRef,
    flight: FlightRef,
    lens: LensModel,
    offsetMs: z.number().default(0),
    poster: AssetRef.optional(),
  }),
  z.object({ kind: z.literal('photos'), ...base, items: z.array(PhotoRef) }),
  z.object({ kind: z.literal('panoramas'), ...base, items: z.array(PanoRef) }),
  z.object({
    kind: z.literal('legacy'),
    ...base,
    viewer: z.enum(['aik', 'volumetric', 'road', 'twin']),
    entry: AssetRef,
  }),
]);

export type LensModel = z.infer<typeof LensModel>;
export type PoseSample = z.infer<typeof PoseSample>;
export type FlightRef = z.infer<typeof FlightRef>;
export type PhotoRef = z.infer<typeof PhotoRef>;
export type PanoRef = z.infer<typeof PanoRef>;
export type Layer = z.infer<typeof Layer>;
export type LayerKind = Layer['kind'];
