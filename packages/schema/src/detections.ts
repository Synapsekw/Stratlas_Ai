import { z } from 'zod';
import { Id, IsoTime } from './common';

/**
 * Detections on photos, the input of the inspection pipeline (`inspection.run`): one file per
 * detection pass in `<project>/detections/*.json` (`aio.detections/1`). Whoever finds defects
 * writes them here: a person reviewing photos or contact sheets, an AI vision pass, a local ONNX
 * model. The pipeline places them on the model, groups them into issues and merges those into
 * issues.json. See docs/architecture/data-conventions.md section 11; the same rules are checked
 * in `python/src/aio_pipelines/inspection/detections.py`.
 */

export const DETECTIONS_SCHEMA = 'aio.detections/1' as const;

/** Who made a pass. AI and model detections become `agent` issues, the rest `import` issues. */
export const DetectionSource = z.enum(['human', 'ai', 'model', 'import']);

/**
 * Review state. `rejected` never counts; `draft` (an AI or model result nobody accepted yet)
 * counts only when the job is started with `includeDrafts`; absent means accepted.
 */
export const DetectionStatus = z.enum(['accepted', 'draft', 'rejected']);

/**
 * Pixel space of `bbox`:
 * - `preview`: pixels of the project's photo file (the review copy, the image sightings' grid);
 * - `source`: pixels of an original of `width` x `height`, scaled to the review copy;
 * - `normalized`: 0 to 1 of the photo;
 * - `sheet`: pixels of the contact sheet named in `sheet` (from the pipeline's last run,
 *   `inspection/contact/layout.json`); the photo is the one under the box centre.
 */
export const DetectionSpace = z.enum(['preview', 'source', 'normalized', 'sheet']);

/** `[x0, y0, x1, y1]`, top-left origin, x1 > x0 and y1 > y0. */
export const DetectionBox = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((b) => b[2] > b[0] && b[3] > b[1], { message: 'A box needs x1 > x0 and y1 > y0.' });

export const Detection = z
  .object({
    /** Stable id chosen by the producer; issues follow their detections by it across runs. */
    id: z.string().min(1).max(128).optional(),
    /** Photo id in the photos layer (`layer` of the file, else any photos layer). Not for `sheet`. */
    photo: Id.optional(),
    /** Class id of the project's class catalogue (a class label is accepted too). */
    class: z.string().min(1),
    /** A level of the class's severity model, or `uncertain` (never graded). Default 2 (kit). */
    severity: z.union([z.number().int(), z.literal('uncertain')]).optional(),
    confidence: z.number().min(0).max(1).optional(),
    note: z.string().optional(),
    /** Part of the asset (otherwise the model node the box lands on). */
    component: z.string().optional(),
    status: DetectionStatus.optional(),
    /** Overrides the file's `source` for this detection. */
    source: DetectionSource.optional(),
    bbox: DetectionBox,
    space: DetectionSpace.optional(),
    /** Original size for `space: 'source'`. */
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    /** Contact sheet name (`sheet-00`) for `space: 'sheet'`. */
    sheet: z.string().min(1).optional(),
  })
  .superRefine((d, ctx) => {
    const space = d.space ?? 'preview';
    if (space === 'sheet' && !d.sheet)
      ctx.addIssue({ code: 'custom', message: 'A sheet box names its sheet.', path: ['sheet'] });
    if (space !== 'sheet' && !d.photo)
      ctx.addIssue({ code: 'custom', message: 'A detection names its photo.', path: ['photo'] });
    if (space === 'normalized' && d.bbox.some((v) => v < 0 || v > 1))
      ctx.addIssue({ code: 'custom', message: 'Normalized boxes are 0 to 1.', path: ['bbox'] });
  });

export const DetectionsFile = z.object({
  schema: z.literal(DETECTIONS_SCHEMA),
  source: DetectionSource,
  /** Reviewer name, model file or provider and model. */
  producer: z.string().optional(),
  createdAt: IsoTime.optional(),
  /** Photos layer the `photo` ids belong to; default any photos layer of the project. */
  layer: Id.optional(),
  /** Photos this pass looked at (for "assessed" in the stats); default all of them. */
  assessed: z.union([z.literal('all'), z.array(Id)]).optional(),
  detections: z.array(Detection),
});

export type DetectionSource = z.infer<typeof DetectionSource>;
export type DetectionStatus = z.infer<typeof DetectionStatus>;
export type DetectionSpace = z.infer<typeof DetectionSpace>;
export type Detection = z.infer<typeof Detection>;
export type DetectionsFile = z.infer<typeof DetectionsFile>;
