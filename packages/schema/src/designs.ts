import { z } from 'zod';
import { IsoTime, Sha256Hex } from './common';
import { Crs } from './manifest';

/**
 * Design files of a survey site (M11 G6): imported LandXML, DXF, 12da, CSV (and TTM if decision 2
 * allows) kept byte for byte in `survey/designs/<id>/`, normalised into TIN surfaces (`aio.tin/1`),
 * linework (GeoJSON with Z), alignments (`aio.alignment/1`) and points. No layer kind is added: the
 * list is `survey/designs.json` (`aio.designs/1`), which 0.10 never reads (data-conventions
 * section 28).
 */

export const DESIGNS_FILE = 'survey/designs.json';
export const DESIGNS_DIR = 'survey/designs';

/** Limits (decision 4 of G6): above them an exact refusal. */
export const DESIGN_LIMITS = { maxTriangles: 2_000_000, maxFileBytes: 500 * 1024 * 1024 } as const;

/** A design or layer id: file-name safe, the folder name under `survey/designs/`. */
export const DesignId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'A design id is letters, digits, dot, dash or _.');

export const DesignFormat = z.enum(['landxml', 'dxf', '12da', 'csv', 'ttm']);

/** Lengths in the source file (`INSUNITS` or LandXML `Units`); stored values are always metres. */
export const DesignSourceUnits = z.enum(['m', 'mm', 'cm', 'ft', 'us-ft', 'in']);

export const DesignLayerKind = z.enum(['surface', 'linework', 'points', 'alignment']);

/** A file inside the design folder, relative to it. */
const DesignFile = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,199}$/, 'A design file name.');

export const DesignLayer = z.looseObject({
  id: DesignId,
  name: z.string().min(1).max(200),
  kind: DesignLayerKind,
  /** The normalised file: `<layer>.tin`, `<layer>.geojson`, `<layer>.alignment.json`, `<layer>.points.json`. */
  file: DesignFile,
  /** A display GLB for the site view (surfaces). */
  glb: DesignFile.optional(),
  /** Entity counts by type (`triangles`, `vertices`, `lines`, `points`, ...). */
  counts: z.record(z.string().max(40), z.number().int().nonnegative()),
  visible: z.boolean(),
  archived: z.boolean(),
  /** Vertical offset applied when the layer is used (subgrade, pavement depth), metres. */
  verticalOffsetM: z.number().min(-1000).max(1000),
  /** Linework draped on the terrain when shown. */
  clamp: z.boolean().optional(),
});

export const DesignEntry = z.looseObject({
  id: DesignId,
  name: z.string().min(1).max(200),
  folder: z.string().max(200).optional(),
  /** The original file, byte for byte, in `survey/designs/<id>/`. */
  src: DesignFile,
  sha256: Sha256Hex,
  bytes: z.number().int().nonnegative(),
  format: DesignFormat,
  units: DesignSourceUnits,
  /** The CRS the file's coordinates are in; absent when placed through the site calibration. */
  crs: Crs.optional(),
  calibrated: z.boolean(),
  importedAt: IsoTime,
  importedBy: z.string().max(200).optional(),
  layers: z.array(DesignLayer).max(1000),
});

/** `<project>/survey/designs.json` (`aio.designs/1`). Written by the app (`survey:writeDesigns`). */
export const DesignsFile = z
  .looseObject({
    schema: z.literal('aio.designs/1'),
    designs: z.array(DesignEntry).max(500),
    /** The alignment whose station and offset the cursor shows (`<design>/<layer>`). */
    activeAlignment: z.string().max(200).optional(),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const d of f.designs) {
      if (seen.has(d.id))
        ctx.addIssue({ code: 'custom', message: `Duplicate design "${d.id}"`, path: ['designs'] });
      seen.add(d.id);
    }
  });

export const emptyDesigns = (): DesignsFile => ({ schema: 'aio.designs/1', designs: [] });

/**
 * The JSON header of a `<layer>.tin` file (`aio.tin/1`). The file is: a little-endian uint32 header
 * length, the UTF-8 JSON header, padding to 8 bytes, `vertexCount * 3` float64 (E, N, Z in the
 * project CRS, metres, design offset not applied), then `triangleCount * 3` uint32 vertex indices.
 */
export const TinHeader = z.looseObject({
  schema: z.literal('aio.tin/1'),
  crs: Crs,
  /** Min E, min N, min Z, max E, max N, max Z. */
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
  vertexCount: z.number().int().nonnegative(),
  triangleCount: z.number().int().nonnegative().max(DESIGN_LIMITS.maxTriangles),
  /** Byte offsets from the file start. */
  verticesAt: z.number().int().nonnegative(),
  trianglesAt: z.number().int().nonnegative(),
  /** Breaklines and boundaries carried with the surface, as vertex index chains. */
  breaklines: z.number().int().nonnegative().optional(),
});

/** One horizontal element; points are (E, N) in the project CRS, metres. */
const Pt = z.tuple([z.number(), z.number()]);
export const AlignmentElement = z.discriminatedUnion('type', [
  z.object({ type: z.literal('line'), start: Pt, end: Pt, length: z.number().positive() }).strict(),
  z
    .object({
      type: z.literal('arc'),
      start: Pt,
      end: Pt,
      center: Pt,
      radius: z.number().positive(),
      /** `cw` or `ccw`, seen from above. */
      rot: z.enum(['cw', 'ccw']),
      length: z.number().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('spiral'),
      /** Clothoid only in M11. */
      spiral: z.literal('clothoid'),
      start: Pt,
      end: Pt,
      /** Radius at the start and end; `null` is infinite (the tangent end). */
      radiusStart: z.number().positive().nullable(),
      radiusEnd: z.number().positive().nullable(),
      rot: z.enum(['cw', 'ccw']),
      length: z.number().positive(),
      /** Bearing at the start, radians clockwise from grid north. */
      dirStart: z.number(),
    })
    .strict(),
]);

/** A station equation: at `back` on the incoming chainage, stations continue from `ahead`. */
export const StationEquation = z.object({ back: z.number(), ahead: z.number() }).strict();

/** `<layer>.alignment.json` (`aio.alignment/1`): a horizontal alignment (no vertical in M11). */
export const Alignment = z.looseObject({
  schema: z.literal('aio.alignment/1'),
  name: z.string().min(1).max(200),
  crs: Crs,
  startStation: z.number(),
  elements: z.array(AlignmentElement).min(1).max(10_000),
  equations: z.array(StationEquation).max(100),
  /** Station label interval, metres (**Edit station intervals**). */
  intervalM: z.number().positive().max(10_000).optional(),
});

export type DesignId = z.infer<typeof DesignId>;
export type DesignFormat = z.infer<typeof DesignFormat>;
export type DesignSourceUnits = z.infer<typeof DesignSourceUnits>;
export type DesignLayerKind = z.infer<typeof DesignLayerKind>;
export type DesignLayer = z.infer<typeof DesignLayer>;
export type DesignEntry = z.infer<typeof DesignEntry>;
export type DesignsFile = z.infer<typeof DesignsFile>;
export type TinHeader = z.infer<typeof TinHeader>;
export type AlignmentElement = z.infer<typeof AlignmentElement>;
export type StationEquation = z.infer<typeof StationEquation>;
export type Alignment = z.infer<typeof Alignment>;
