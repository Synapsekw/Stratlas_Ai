import { z } from 'zod';
import { Id, IsoTime, Vec3 } from './common';

/**
 * Change between two capture dates (M8, FUS-12): one register for every layer type. Each producer
 * (the in-app issue, detection and vector comparisons; the `change.*` pipelines) writes one file
 * per date pair, `<project>/change/<id>.json` (`aio.change/1`, data-conventions section 14). Items
 * carry stable ids chosen by the producer, so a person's review survives a recompute. Every item is
 * a proposal: nothing changes an issue until a person confirms it. The same file is written by
 * `python/src/aio_pipelines/change/changeset.py`.
 */

export const CHANGE_SCHEMA = 'aio.change/1' as const;
/** Folder of change sets inside a project. */
export const CHANGE_DIR = 'change';

/** A file-name-safe change set id: `<project>/change/<id>.json`. */
export const ChangeSetId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/, 'A change set id is a plain file name.');

export const ChangeKind = z.enum(['issue', 'detection', 'vector', 'region', 'component', 'frame']);

export const ChangeVerdict = z.enum([
  // issues and detections
  'new',
  'resolved',
  /** The later date did not look at the place: never reported as resolved. */
  'not-seen',
  'grown',
  'shrunk',
  'worsened',
  'improved',
  // vectors, regions and model parts
  'added',
  'removed',
  'moved',
  'reshaped',
  'attributes',
  'changed',
  // surface regions
  'cut',
  'fill',
  'unchanged',
]);

/** The verdicts each kind of item may carry. */
export const CHANGE_VERDICTS = {
  issue: ['new', 'resolved', 'not-seen', 'grown', 'shrunk', 'worsened', 'improved', 'unchanged'],
  detection: ['new', 'resolved', 'not-seen', 'grown', 'shrunk', 'unchanged'],
  vector: ['added', 'removed', 'moved', 'reshaped', 'attributes', 'unchanged'],
  region: ['added', 'removed', 'changed', 'cut', 'fill'],
  component: ['added', 'removed', 'moved', 'changed', 'unchanged'],
  frame: ['changed', 'unchanged'],
} as const satisfies Record<ChangeKind, readonly ChangeVerdict[]>;

/** A person's decision on one item. `issueId`: the issue made from (or linked to) the item. */
export const ChangeReview = z
  .object({
    status: z.enum(['open', 'confirmed', 'dismissed']),
    by: z.string().min(1),
    at: IsoTime,
    note: z.string().max(4000).optional(),
    issueId: Id.optional(),
  })
  .strict();

const LonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
/** A closed ring in lon/lat (WGS84); the last point may repeat the first. */
export const LonLatRing = z.array(LonLat).min(3);

/** A value on each date (sizes in `unit`, counts, severity levels). */
const FromTo = z.object({ from: z.number().optional(), to: z.number().optional() }).strict();

const itemBase = {
  /** Stable across recomputes of the same pair (producer-chosen, e.g. `issue:F01`). */
  id: z.string().min(1).max(200),
  /** Short text for the register ("Fence F-2 moved 3.1 m"). */
  label: z.string().max(300).optional(),
  /** Strength or confidence of the change, 0 to 1. */
  score: z.number().min(0).max(1).optional(),
  /** Where to fly to: project local frame, metres. */
  at: Vec3.optional(),
  /** Bounds in the project local frame. */
  bounds: z.object({ min: Vec3, max: Vec3 }).strict().optional(),
  /** How the two dates were matched, said in the panel (`mesh`, `pose`, `zone`, `property`...). */
  method: z.string().max(40).optional(),
  review: ChangeReview.optional(),
};

const IssueChange = z
  .object({
    kind: z.literal('issue'),
    ...itemBase,
    verdict: z.enum(CHANGE_VERDICTS.issue),
    /** Issue ids on the earlier and later date. */
    from: Id.optional(),
    to: Id.optional(),
    classId: Id.optional(),
    size: FromTo.extend({ unit: z.enum(['m', 'm2']) })
      .strict()
      .optional(),
    severity: FromTo.optional(),
  })
  .strict();

const DetectionChange = z
  .object({
    kind: z.literal('detection'),
    ...itemBase,
    verdict: z.enum(CHANGE_VERDICTS.detection),
    classId: z.string().min(1),
    zone: z.string().optional(),
    /** Detections per date (class and zone counts). */
    count: FromTo.optional(),
    /** Detection ids (pass file name and detection id, `review.json#a1`) on each date. */
    fromIds: z.array(z.string()).optional(),
    toIds: z.array(z.string()).optional(),
  })
  .strict();

const VectorChange = z
  .object({
    kind: z.literal('vector'),
    ...itemBase,
    verdict: z.enum(CHANGE_VERDICTS.vector),
    layerFrom: Id.optional(),
    layerTo: Id.optional(),
    featureFrom: z.union([z.string(), z.number()]).optional(),
    featureTo: z.union([z.string(), z.number()]).optional(),
    /** `moved`: distance of the feature, metres. */
    distanceM: z.number().nonnegative().optional(),
    /** `attributes`: the changed property keys. */
    keys: z.array(z.string()).optional(),
  })
  .strict();

const RegionChange = z
  .object({
    kind: z.literal('region'),
    ...itemBase,
    verdict: z.enum(CHANGE_VERDICTS.region),
    /** Outline in lon/lat (map) and/or the project local frame (3D). */
    outline: LonLatRing.optional(),
    outlineLocal: z.array(Vec3).min(3).optional(),
    areaM2: z.number().nonnegative().optional(),
    /** Surface change: cut, fill and net volume, cubic metres. */
    volume: z
      .object({
        cutM3: z.number().nonnegative(),
        fillM3: z.number().nonnegative(),
        netM3: z.number(),
      })
      .strict()
      .optional(),
    /** Cloud change: mean and largest distance of the region's points, metres. */
    distance: z.object({ meanM: z.number(), maxM: z.number() }).strict().optional(),
    /** The derived polygon layer and its feature for this region. */
    layer: Id.optional(),
    feature: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const ComponentChange = z
  .object({
    kind: z.literal('component'),
    ...itemBase,
    verdict: z.enum(CHANGE_VERDICTS.component),
    /** Part name with the survey key stripped (`P05`), and the node on each date. */
    part: z.string().min(1),
    nodeFrom: z.string().optional(),
    nodeTo: z.string().optional(),
    layerFrom: Id.optional(),
    layerTo: Id.optional(),
    /** `moved`: offset of the bounding-box centre, metres. */
    offsetM: Vec3.optional(),
    /** `changed`: deviation of the part's surface, metres. */
    deviation: z.object({ meanM: z.number(), maxM: z.number() }).strict().optional(),
  })
  .strict();

/** A video frame (`t`, video seconds) or a photo of a layer. */
export const FrameRef = z
  .object({ layer: Id, t: z.number().nonnegative().optional(), photo: Id.optional() })
  .strict()
  .refine((f) => (f.t === undefined) !== (f.photo === undefined), {
    message: 'A frame names a time or a photo, not both.',
  });

const FrameChange = z
  .object({
    kind: z.literal('frame'),
    ...itemBase,
    verdict: z.enum(CHANGE_VERDICTS.frame),
    a: FrameRef,
    b: FrameRef,
    /** Camera distance and view angle between the pair. */
    poseM: z.number().nonnegative().optional(),
    angleDeg: z.number().nonnegative().optional(),
    /** Draft detections written for the pair (`detections/change-frames-<run>.json` ids). */
    detections: z.array(z.string()).optional(),
  })
  .strict();

export const ChangeItem = z.discriminatedUnion('kind', [
  IssueChange,
  DetectionChange,
  VectorChange,
  RegionChange,
  ComponentChange,
  FrameChange,
]);

/** How well the two dates line up; a comparison refuses to run beyond its tolerance. */
export const ChangeRegistration = z
  .object({
    ok: z.boolean(),
    shiftPx: z.number().nonnegative().optional(),
    shiftM: z.number().nonnegative().optional(),
    tolerancePx: z.number().nonnegative().optional(),
    toleranceM: z.number().nonnegative().optional(),
    message: z.string().optional(),
  })
  .strict();

export const ChangeSet = z
  .object({
    schema: z.literal(CHANGE_SCHEMA),
    id: ChangeSetId,
    /** Capture ids of the earlier and later date. */
    from: Id,
    to: Id,
    /** `issues`, `detections`, `vectors` (in-app) or a pipeline name (`change.raster`). */
    producer: z.string().min(1).max(64),
    run: z
      .object({
        jobId: z.string().optional(),
        at: IsoTime.optional(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
    createdAt: IsoTime,
    items: z.array(ChangeItem),
    /** Derived layers written with this set. */
    layers: z.array(Id).default([]),
    /** Totals for the panel and the report (`items`, `new`, `fillM3`...). */
    stats: z.record(z.string(), z.number()).default({}),
    registration: ChangeRegistration.optional(),
    /** Share of the area both dates cover, 0 to 1. */
    coverage: z.number().min(0).max(1).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.from === s.to)
      ctx.addIssue({ code: 'custom', message: 'A change set compares two dates.', path: ['to'] });
    const seen = new Set<string>();
    s.items.forEach((item, i) => {
      if (seen.has(item.id))
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate item id "${item.id}"`,
          path: ['items', i, 'id'],
        });
      seen.add(item.id);
    });
  });

/** One line of `change:list`. */
export const ChangeSetSummary = z.object({
  id: ChangeSetId,
  from: Id,
  to: Id,
  producer: z.string(),
  createdAt: z.string(),
  items: z.number().int().nonnegative(),
  /** Items nobody reviewed yet. */
  open: z.number().int().nonnegative(),
});

/**
 * Thresholds of the change comparisons (founder decision, 6 Oct 2026). `ChangeThresholds.parse({})`
 * gives the defaults; Settings keeps the person's own values.
 */
export const ChangeThresholds = z
  .object({
    /** Point clouds: significant from 5 cm, "far" from 30 cm. */
    cloud: z
      .object({
        significantM: z.number().positive().max(10).default(0.05),
        farM: z.number().positive().max(100).default(0.3),
      })
      .strict()
      .prefault({}),
    /** Surfaces (DSM or gridded cloud): 10 cm depth and 1 m2 area at least. */
    surface: z
      .object({
        minDepthM: z.number().positive().max(100).default(0.1),
        minAreaM2: z.number().positive().max(1e6).default(1),
      })
      .strict()
      .prefault({}),
    /** Orthos: conservative by default (few false positives from light and season). */
    raster: z
      .object({ preset: z.enum(['conservative', 'balanced', 'sensitive']).default('conservative') })
      .strict()
      .prefault({}),
    /** An issue has grown when its area is up 20% or its severity one level. */
    grown: z
      .object({
        areaPct: z.number().positive().max(1000).default(20),
        severityLevels: z.number().int().min(1).max(10).default(1),
      })
      .strict()
      .prefault({}),
    /** The dates must line up within 2 px (rasters) or 5 cm (clouds, meshes). */
    registration: z
      .object({
        maxShiftPx: z.number().nonnegative().max(100).default(2),
        maxShiftM: z.number().nonnegative().max(10).default(0.05),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export const DEFAULT_CHANGE_THRESHOLDS = ChangeThresholds.parse({});

export type ChangeKind = z.infer<typeof ChangeKind>;
export type ChangeVerdict = z.infer<typeof ChangeVerdict>;
export type ChangeReview = z.infer<typeof ChangeReview>;
export type ChangeItem = z.infer<typeof ChangeItem>;
export type ChangeRegistration = z.infer<typeof ChangeRegistration>;
export type ChangeSet = z.infer<typeof ChangeSet>;
export type ChangeSetInput = z.input<typeof ChangeSet>;
export type ChangeSetSummary = z.infer<typeof ChangeSetSummary>;
export type ChangeThresholds = z.infer<typeof ChangeThresholds>;
export type FrameRef = z.infer<typeof FrameRef>;
export type LonLatRing = z.infer<typeof LonLatRing>;
