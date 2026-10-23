import { z } from 'zod';
import { ParamQuality, ValueBasis } from './assemblies';
import { IsoTime, Vec3 } from './common';
import { DetectionOrigin, DetectionRun } from './detections';

/**
 * Telecom antenna inventory (`aio.antennas/1`, `telecom/antennas.json`): the units the
 * `telecom.antennas` pipeline finds on a tower crown, measured from the point cloud. AI may relabel
 * a unit's kind (`kindBasis` 'ai') but never sets a number. Azimuth is grid, clockwise from north.
 */

export const ANTENNAS_SCHEMA = 'aio.antennas/1';
export const ANTENNAS_FILE = 'telecom/antennas.json';
/** Crops of each unit's best photo: `<dir>/<unitId>.jpg`. */
export const ANTENNA_CROPS_DIR = 'telecom/crops';
/** The first pipeline pack that has `telecom.antennas`. */
export const TELECOM_ANTENNAS_MIN_PACK = '0.14.0';
export const TELECOM_ANTENNAS_FEATURE = 'Antenna detection';
/** The first pipeline pack that has `telecom.flag` (and merges around person-owned units). */
export const TELECOM_FLAG_MIN_PACK = '0.24.0';
export const TELECOM_FLAG_FEATURE = 'Antenna flagging';
/** Most vertices of an outline a person draws (the engine's lasso limit). */
const FLAG_MAX_POLYGON_VERTICES = 256;
/** Shared with python through `__fixtures__/antennas-contract.json`. */
export const TOWER_HINT_NEEDED =
  'Could not tell which structure is the tower. Click the tower once in the 3D view and run again.';

const ANTENNA_ID = /^ant-[a-z0-9-]{1,60}$/;

export const AntennaKind = z.enum(['panel', 'short', 'dish', 'other']);
export type AntennaKind = z.infer<typeof AntennaKind>;
export const AntennaKindBasis = z.enum(['geometry', 'ai', 'user']);
export type AntennaKindBasis = z.infer<typeof AntennaKindBasis>;
/** Found by the detector, or flagged by a person who drew an outline round it. */
export const AntennaOrigin = z.enum(['detected', 'flagged']);
export type AntennaOrigin = z.infer<typeof AntennaOrigin>;
export const AntennaStatus = z.enum(['draft', 'accepted', 'rejected']);
export type AntennaStatus = z.infer<typeof AntennaStatus>;

/** What the AI may call a unit; a radio unit is "other" equipment in the inventory. */
export const AntennaAiLabel = z.enum(['panel', 'short-antenna', 'radio-unit', 'dish', 'other']);
export type AntennaAiLabel = z.infer<typeof AntennaAiLabel>;
export const AI_LABEL_KIND: Record<AntennaAiLabel, AntennaKind> = {
  panel: 'panel',
  'short-antenna': 'short',
  'radio-unit': 'other',
  dish: 'dish',
  other: 'other',
};

/** A measured number with how it is known; the quality basis must be the value's basis. */
export const AntennaValue = z
  .object({ value: z.number(), basis: ValueBasis, quality: ParamQuality })
  .strict()
  .refine((v) => v.quality.basis === v.basis, {
    message: 'The quality basis must be the value basis.',
    path: ['quality', 'basis'],
  });
export type AntennaValue = z.infer<typeof AntennaValue>;

/** A number a person typed: its quality basis is `user` too. */
const MeasuredValue = AntennaValue.refine((v) => v.basis !== 'user', {
  message: 'A measured value is not a user value.',
  path: ['basis'],
});

/** The measured values that typed ones replaced, kept for Reset to measured. */
export const AntennaMeasured = z
  .object({
    azimuthGridDeg: MeasuredValue.optional(),
    downtiltDeg: MeasuredValue.optional(),
    centreHeightM: MeasuredValue.optional(),
    widthM: MeasuredValue.optional(),
    heightM: MeasuredValue.optional(),
    depthM: MeasuredValue.optional(),
  })
  .strict();
export type AntennaMeasured = z.infer<typeof AntennaMeasured>;

/** Oriented box in project ENZ: centre, unit axes (across, up, outward) and extents (w, h, d). */
export const AntennaBox = z
  .object({
    centre: Vec3,
    axes: z.tuple([Vec3, Vec3, Vec3]),
    extents: Vec3,
  })
  .strict();
export type AntennaBox = z.infer<typeof AntennaBox>;

export const AntennaPhoto = z
  .object({
    layer: z.string().min(1).max(128),
    id: z.string().min(1).max(128),
    score: z.number().min(0).max(1),
  })
  .strict();
export type AntennaPhoto = z.infer<typeof AntennaPhoto>;

/** What a person types about a unit; a re-run never overwrites it. */
export const AntennaUserFields = z
  .object({
    model: z.string().max(120).optional(),
    weightKg: z.number().min(0).max(500).optional(),
    frequencies: z.string().max(200).optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type AntennaUserFields = z.infer<typeof AntennaUserFields>;

export const AntennaUnit = z
  .object({
    id: z.string().regex(ANTENNA_ID),
    name: z.string().min(1).max(40),
    kind: AntennaKind,
    kindBasis: AntennaKindBasis,
    /** Absent means detected. */
    origin: AntennaOrigin.optional(),
    ai: DetectionOrigin.extend({ reason: z.string().max(200).optional() }).optional(),
    status: AntennaStatus,
    notFoundInLatest: z.literal(true).optional(),
    box: AntennaBox,
    /** Total points on the unit's faces. */
    support: z.number().int().nonnegative(),
    azimuthGridDeg: AntennaValue.optional(),
    downtiltDeg: AntennaValue.optional(),
    plumbDeg: AntennaValue.optional(),
    elevationDeg: AntennaValue.optional(),
    diameterM: AntennaValue.optional(),
    /**
     * Box centre elevation, project vertical datum: one a person typed (basis `user`), or after
     * Reset to measured the measured box centre Z it went back to.
     */
    centreHeightM: AntennaValue.optional(),
    /** Required unless the unit was flagged and could not be measured. */
    widthM: AntennaValue.optional(),
    heightM: AntennaValue.optional(),
    depthM: AntennaValue.optional(),
    measured: AntennaMeasured.optional(),
    convergenceDeg: z.number().nullable(),
    photos: z.array(AntennaPhoto).max(3),
    /** Project-relative path of the crop. */
    crop: z.string().min(1).max(300).optional(),
    user: AntennaUserFields,
    runId: z.string().min(1).max(100),
    createdAt: IsoTime,
  })
  .strict()
  .superRefine((u, ctx) => {
    if (u.origin !== 'flagged')
      for (const k of ['widthM', 'heightM', 'depthM'] as const)
        if (u[k] === undefined)
          ctx.addIssue({ code: 'custom', message: `A ${u.kind} needs ${k}.`, path: [k] });
    // Units relabelled by AI or a person keep whatever the geometry measured; flagged ones may
    // have any kind and no values.
    if (u.kindBasis !== 'geometry' || u.origin === 'flagged') return;
    const need = (keys: readonly (keyof typeof u)[]) => {
      for (const k of keys)
        if (u[k] === undefined)
          ctx.addIssue({ code: 'custom', message: `A ${u.kind} needs ${k}.`, path: [k] });
    };
    if (u.kind === 'panel' || u.kind === 'short') need(['azimuthGridDeg', 'downtiltDeg']);
    else if (u.kind === 'dish') need(['azimuthGridDeg', 'elevationDeg', 'diameterM']);
    else
      for (const k of [
        'azimuthGridDeg',
        'downtiltDeg',
        'plumbDeg',
        'elevationDeg',
        'diameterM',
      ] as const)
        if (u[k] !== undefined)
          ctx.addIssue({ code: 'custom', message: `Other equipment has no ${k}.`, path: [k] });
  });
export type AntennaUnit = z.infer<typeof AntennaUnit>;

/** Job params of `telecom.antennas` (python `aio_pipelines/telecom`). */
export const TelecomAntennasParams = z
  .object({
    run: z.string().regex(/^run-[a-z0-9-]{1,60}$/),
    cloud: z
      .object({ layer: z.string().min(1).max(128) })
      .strict()
      .optional(),
    /** A click on the tower in the 3D view: local x and z where the view draws it (lined up). */
    towerHint: z.tuple([z.number(), z.number()]).optional(),
    floorFraction: z.number().min(0.3).max(0.95).optional(),
  })
  .strict();
export type TelecomAntennasParams = z.infer<typeof TelecomAntennasParams>;

/** Job params of `telecom.flag` (python `aio_pipelines/telecom`). */
export const TelecomFlagParams = z
  .object({
    unit: z.string().regex(ANTENNA_ID),
    /** Draw again for a unit that exists. */
    redraw: z.literal(true).optional(),
    cloud: z.object({ layer: z.string().min(1).max(128) }).strict(),
    selection: z
      .object({
        /** Outline in normalised device coordinates. */
        polygon: z
          .array(z.tuple([z.number().min(-100).max(100), z.number().min(-100).max(100)]))
          .min(3)
          .max(FLAG_MAX_POLYGON_VERTICES),
        /** Stage local (lined up, as drawn) to clip, column-major. */
        viewProj: z.array(z.number()).length(16),
        /** Stage local. */
        bounds: z.object({ min: Vec3, max: Vec3 }).strict(),
        anchor: Vec3,
      })
      .strict(),
  })
  .strict();
export type TelecomFlagParams = z.infer<typeof TelecomFlagParams>;

export const AntennaRun = z
  .object({
    id: z.string().min(1).max(100),
    at: IsoTime,
    params: TelecomAntennasParams,
    cloudLayer: z.string().min(1).max(128),
    /**
     * The survey date (manifest capture id) the cloud layer belongs to. Units are stored in that
     * date's own frame, without its line-up shift (like survey measurements), and drawn shifted by
     * the capture's `lineUp`. Absent when the cloud has no date, and in older files.
     */
    captureId: z.string().min(1).max(128).optional(),
    axis: z
      .object({ point: Vec3, dir: Vec3, source: z.enum(['evidence', 'auto', 'hint']) })
      .strict(),
    crown: z
      .object({ floorZ: z.number(), topZ: z.number(), radiusM: z.number().nonnegative() })
      .strict(),
    /**
     * Ground height at the tower base, project vertical datum (the crown step's estimate, with the
     * layer's `heightOffsetM` applied); for heights above ground. Absent in older files.
     */
    groundZ: z.number().optional(),
    north: z.enum(['grid', 'project']),
    warnings: z.array(z.string().max(300)),
    counts: z
      .object({
        panel: z.number().int().nonnegative(),
        short: z.number().int().nonnegative(),
        dish: z.number().int().nonnegative(),
        other: z.number().int().nonnegative(),
      })
      .strict(),
    ai: DetectionRun.optional(),
  })
  .strict();
export type AntennaRun = z.infer<typeof AntennaRun>;

export const AntennasFile = z
  .object({
    schema: z.literal(ANTENNAS_SCHEMA),
    run: AntennaRun,
    units: z.array(AntennaUnit).max(500),
  })
  .strict();
export type AntennasFile = z.infer<typeof AntennasFile>;
