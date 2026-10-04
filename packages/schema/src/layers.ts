import { z } from 'zod';
import { AssetRef, HexColor, Id, IsoTime, Mat4, Quat, Vec3 } from './common';

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

/**
 * Orientation bias of a video clip's camera against its flight log, in degrees, applied in the
 * camera frame after the logged orientation: `q = qLog * Ry(yaw) * Rx(pitch) * Rz(roll)` (three.js
 * camera axes: +X image right, +Y image up, looking down -Z). Positive pitch tilts the view up,
 * positive yaw turns it left, positive roll turns the camera counterclockwise about its view axis.
 * It soaks up gimbal and IMU errors of the log (calibrated against the model, BLD-3).
 */
export const CameraOrientation = z.object({
  yawDeg: z.number().min(-180).max(180),
  pitchDeg: z.number().min(-90).max(90),
  rollDeg: z.number().min(-180).max(180),
});

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

const Opacity = z.number().min(0).max(1);

/**
 * How a `vector` layer draws on the map (and draped on the 3D ground): any of line, fill,
 * circle and label, optionally coloured by a numeric feature property with step stops.
 */
export const VectorStyle = z.object({
  line: z
    .object({
      color: HexColor,
      width: z.number().positive().default(1.5),
      opacity: Opacity.optional(),
      dash: z.array(z.number().nonnegative()).optional(),
    })
    .optional(),
  fill: z.object({ color: HexColor, opacity: Opacity.default(0.3) }).optional(),
  circle: z.object({ color: HexColor, radius: z.number().positive().default(4) }).optional(),
  /** A feature property shown as text at points (and along lines). */
  label: z.object({ field: z.string().min(1), size: z.number().positive().optional() }).optional(),
  /** Step colour ramp: the colour of the last stop at or below the value of `field`. */
  colorBy: z
    .object({
      field: z.string().min(1),
      stops: z
        .array(z.tuple([z.number(), HexColor]))
        .min(1)
        .refine((s) => s.every((x, i) => i === 0 || x[0] > (s[i - 1]?.[0] ?? -Infinity)), {
          message: 'Colour stops must be in ascending order',
        }),
    })
    .optional(),
  minZoom: z.number().min(0).max(24).optional(),
});

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
    /** Camera orientation bias against the flight log (calibration); none means zero. */
    orientation: CameraOrientation.optional(),
    /**
     * Camera position correction against the flight log, metres in the local frame (x east, y up,
     * z south), added to every logged position of the clip (calibration). Soaks up a wrong
     * altitude datum (barometric height from a take-off point that is not plant grade) and GPS
     * bias; none means zero.
     */
    positionOffsetM: Vec3.optional(),
    poster: AssetRef.optional(),
  }),
  z.object({ kind: z.literal('photos'), ...base, items: z.array(PhotoRef) }),
  z.object({ kind: z.literal('panoramas'), ...base, items: z.array(PanoRef) }),
  z.object({
    kind: z.literal('vector'),
    ...base,
    /** A GeoJSON FeatureCollection in lon/lat (WGS84). */
    src: AssetRef,
    format: z.literal('geojson'),
    style: VectorStyle.optional(),
  }),
  z.object({
    kind: z.literal('legacy'),
    ...base,
    viewer: z.enum(['aik', 'volumetric', 'road', 'twin']),
    entry: AssetRef,
  }),
]);

export type LensModel = z.infer<typeof LensModel>;
export type CameraOrientation = z.infer<typeof CameraOrientation>;
export type PoseSample = z.infer<typeof PoseSample>;
export type FlightRef = z.infer<typeof FlightRef>;
export type PhotoRef = z.infer<typeof PhotoRef>;
export type PanoRef = z.infer<typeof PanoRef>;
export type VectorStyle = z.infer<typeof VectorStyle>;
export type Layer = z.infer<typeof Layer>;
export type LayerKind = Layer['kind'];
