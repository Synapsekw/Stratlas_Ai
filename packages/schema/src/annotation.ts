import { z } from 'zod';
import { AssetRef, Id, IsoTime, Vec2, Vec3, err, ok, type Result } from './common';
import type { SeverityModel } from './severity';

// 2D geometry in image pixels (review-copy grid for photos, frame pixels for video).
export const Box = z.object({
  type: z.literal('box'),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export const RotBox = z.object({
  type: z.literal('rotbox'),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  angleDeg: z.number(),
});
export const Polygon = z.object({ type: z.literal('polygon'), points: z.array(Vec2).min(3) });
export const Point2 = z.object({ type: z.literal('point'), x: z.number(), y: z.number() });
export const MaskRef = z.object({ type: z.literal('mask'), src: AssetRef });
export const ImageGeom = z.discriminatedUnion('type', [Box, RotBox, Polygon, Point2, MaskRef]);
export const FrameGeom = z.discriminatedUnion('type', [Box, Polygon]);

// 3D geometry in the project local frame (metres).
export const SurfacePoint = z.object({
  type: z.literal('spoint'),
  p: Vec3,
  n: Vec3,
  face: z.number().int().optional(),
});
export const SurfacePolyline = z.object({
  type: z.literal('spolyline'),
  points: z.array(Vec3).min(2),
});
export const SurfacePolygon = z.object({
  type: z.literal('spolygon'),
  points: z.array(Vec3).min(3),
});
export const SurfacePatch = z.object({
  type: z.literal('spatch'),
  src: AssetRef,
  center: Vec3.optional(),
});
export const MeshGeom = z.discriminatedUnion('type', [
  SurfacePoint,
  SurfacePolyline,
  SurfacePolygon,
  SurfacePatch,
]);

export const Point3 = z.object({ type: z.literal('point3'), p: Vec3 });
export const Box3 = z.object({ type: z.literal('box3'), min: Vec3, max: Vec3 });
export const Polygon3 = z.object({
  type: z.literal('polygon3'),
  points: z.array(Vec3).min(3),
  height: z.number().optional(),
});
export const PointSelection = z.object({
  type: z.literal('selection'),
  src: AssetRef,
  count: z.number().int().positive(),
});
export const CloudGeom = z.discriminatedUnion('type', [Point3, Box3, Polygon3, PointSelection]);

export const SphericalPolygon = z.object({
  type: z.literal('sphpolygon'),
  /** [yawDeg, pitchDeg] pairs. */
  points: z.array(Vec2).min(3),
});

export const VideoKeyframe = z.object({ t: z.number().nonnegative(), geom: FrameGeom });

export const Sighting = z.discriminatedUnion('on', [
  z.object({ on: z.literal('mesh'), layer: Id, geom: MeshGeom }),
  z.object({ on: z.literal('image'), layer: Id, photo: Id, geom: ImageGeom }),
  z.object({
    on: z.literal('video'),
    layer: Id,
    track: z
      .array(VideoKeyframe)
      .min(1)
      .superRefine((track, ctx) => {
        for (let i = 1; i < track.length; i++) {
          const prev = track[i - 1];
          const cur = track[i];
          if (prev && cur && cur.t <= prev.t) {
            ctx.addIssue({
              code: 'custom',
              message: 'Video track keyframes must be in time order',
              path: [i, 't'],
            });
          }
        }
      }),
    range: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
  }),
  z.object({ on: z.literal('pointcloud'), layer: Id, geom: CloudGeom }),
  z.object({ on: z.literal('map'), layer: Id, geojson: z.record(z.string(), z.unknown()) }),
  z.object({ on: z.literal('pano'), layer: Id, pano: Id, geom: SphericalPolygon }),
]);

export const Measurement = z.object({
  kind: z.enum(['distance', 'height', 'area', 'angle']),
  value: z.number(),
  unit: z.enum(['m', 'm2', 'deg']),
});

export const IssueStatus = z.enum(['draft', 'reviewed', 'approved', 'closed']);

export const Issue = z.object({
  id: Id,
  code: z.string().regex(/^[A-Z]{1,3}\d{2,4}$/, 'Issue code must look like F01 or D012'),
  classId: Id,
  severityModelId: Id,
  severity: z.union([z.number().int(), z.literal('uncertain')]),
  status: IssueStatus,
  title: z.string().min(1),
  note: z.string(),
  author: z.string().min(1),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  sightings: z.array(Sighting).min(1),
  measurements: z.array(Measurement).optional(),
  source: z.enum(['human', 'agent', 'import']),
});

export type ImageGeom = z.infer<typeof ImageGeom>;
export type FrameGeom = z.infer<typeof FrameGeom>;
export type MeshGeom = z.infer<typeof MeshGeom>;
export type CloudGeom = z.infer<typeof CloudGeom>;
export type Sighting = z.infer<typeof Sighting>;
export type IssueStatus = z.infer<typeof IssueStatus>;
export type Issue = z.infer<typeof Issue>;

/** Check an issue's severity against the severity model it names. */
export function validateIssueAgainstModel(issue: Issue, model: SeverityModel): Result<Issue> {
  if (issue.severity === 'uncertain') {
    return model.uncertain
      ? ok(issue)
      : err(`Issue ${issue.code}: severity uncertain is not in model "${model.name}"`);
  }
  const found = model.levels.some((l) => l.value === issue.severity);
  return found
    ? ok(issue)
    : err(`Issue ${issue.code}: severity ${issue.severity} is not in model "${model.name}"`);
}
