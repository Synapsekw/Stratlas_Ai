import { z } from 'zod';
import { Id, IsoTime } from './common';
import { SurveyId } from './survey';

/**
 * Generated house-format reports (PRD BLD-7, BLD-8): the narrative text of a project, kept with
 * the project as `<project>/report/narrative.json` (`aio.narrative/1`), and the person's choice of
 * report sections (`Settings.reportContents`). See docs/architecture/data-conventions.md.
 */

export const NARRATIVE_SCHEMA = 'aio.narrative/1' as const;

/** The narrative parts of a report: executive summary, scope and method, findings. */
export const NarrativeSectionId = z.enum(['summary', 'method', 'findings']);
export const NARRATIVE_SECTIONS = NarrativeSectionId.options;

/** One saved text of a narrative part. The newest version is the one the report prints. */
export const NarrativeVersion = z
  .object({
    text: z.string().max(20_000),
    /** Drafted by AI, filled from the template (cloud AI off), or written by a person. */
    source: z.enum(['ai', 'template', 'user']),
    createdAt: IsoTime,
    author: z.string().max(200).optional(),
    /** AI drafts: route provider and model. */
    provider: z.string().max(64).optional(),
    model: z.string().max(128).optional(),
  })
  .strict();

/** Most versions kept per part; older ones are dropped when a new version is saved. */
export const NARRATIVE_MAX_VERSIONS = 50;

export const NarrativePart = z
  .object({ versions: z.array(NarrativeVersion).max(NARRATIVE_MAX_VERSIONS) })
  .strict();

export const NarrativeFile = z
  .object({
    schema: z.literal(NARRATIVE_SCHEMA),
    parts: z.partialRecord(NarrativeSectionId, NarrativePart),
  })
  .strict();

/** Sections of the house report after the cover, in print order. */
export const ReportSectionId = z.enum([
  'contents',
  'summary',
  'scope',
  'site',
  'statistics',
  'register',
  'issues',
  'appendices',
  // M9: the change log per issue and the head hash (T1); the sign-off block (T3)
  'audit',
  'approvals',
  // M10 (G4): photogrammetry accuracy (summary, GCP and checkpoint table, overlap map)
  'processing',
  // M11 (G9): survey measurements, earthworks to design, the stockpile inventory and landfill
  // airspace and compaction. Settings keep them in `reportSectionsExtra` (not read by 0.8 to 0.10)
  'measurements',
  'earthworks',
  'stockpiles',
  'landfill',
  // M11 (integration): haul-road compliance runs and hydrology runs, kept the same way
  'haul',
  'hydrology',
  // Volumetric parity: volume over time, kept in `reportSectionsExtra` the same way
  'volume-over-time',
]);
export const REPORT_SECTIONS = ReportSectionId.options;

/**
 * Which issues get a page of their own: every issue, all but the lowest severity level of each
 * model (the lowest are listed in the register only, as in the delivered facade reports), or none.
 */
export const IssuePagesRule = z.enum(['all', 'above-lowest', 'none']);

/** The person's choice of house report contents (Settings). Missing sections are included. */
export const ReportContentsSettings = z
  .object({
    sections: z.partialRecord(ReportSectionId, z.boolean()).optional(),
    issuePages: IssuePagesRule.optional(),
  })
  .strict();

export type NarrativeSectionId = z.infer<typeof NarrativeSectionId>;
export type NarrativeVersion = z.infer<typeof NarrativeVersion>;
export type NarrativePart = z.infer<typeof NarrativePart>;
export type NarrativeFile = z.infer<typeof NarrativeFile>;
export type ReportSectionId = z.infer<typeof ReportSectionId>;
export type IssuePagesRule = z.infer<typeof IssuePagesRule>;
export type ReportContentsSettings = z.infer<typeof ReportContentsSettings>;

/** An empty narrative file. */
export function emptyNarrative(): NarrativeFile {
  return { schema: NARRATIVE_SCHEMA, parts: {} };
}

/** The newest version of a part, or null when it has none. */
export function currentVersion(part: NarrativePart | undefined): NarrativeVersion | null {
  return part?.versions.at(-1) ?? null;
}

/**
 * Add a version to a part, newest last. Saving the same text and source again returns `part`
 * itself; the oldest versions beyond `NARRATIVE_MAX_VERSIONS` are dropped. Never mutates `part`.
 */
export function withVersion(
  part: NarrativePart | undefined,
  version: NarrativeVersion,
): NarrativePart {
  const versions = part?.versions ?? [];
  const last = versions.at(-1);
  if (part && last?.text === version.text && last.source === version.source) return part;
  return { versions: [...versions, version].slice(-NARRATIVE_MAX_VERSIONS) };
}

/** The text the report prints for a part: its newest version, or null when none is saved. */
export function currentNarrative(
  file: NarrativeFile | null,
  id: NarrativeSectionId,
): string | null {
  return currentVersion(file?.parts[id])?.text ?? null;
}

/**
 * Add a version to a part, newest last. Saving the same text and source again is a no-op; the
 * oldest versions beyond `NARRATIVE_MAX_VERSIONS` are dropped. Never mutates `file`.
 */
export function addNarrativeVersion(
  file: NarrativeFile | null,
  id: NarrativeSectionId,
  version: NarrativeVersion,
): NarrativeFile {
  const base = file ?? emptyNarrative();
  const part = base.parts[id];
  const next = withVersion(part, version);
  if (next === part) return base;
  return { ...base, parts: { ...base.parts, [id]: next } };
}

/** Is this section part of the report under these settings (default: yes). */
export function reportSectionOn(
  contents: ReportContentsSettings | undefined,
  id: ReportSectionId,
): boolean {
  return contents?.sections?.[id] ?? true;
}

/**
 * Customer reports (volumetric report, spec 2026-10-25): the person's edits of one report type,
 * `<project>/report/<report>.json` (`aio.report-text/1`). A sibling of `report/narrative.json`, not
 * part of it: `NarrativeFile` is strict over a fixed part enum, so older builds would refuse it
 * whole if it gained parts. Each text is a `NarrativePart`; a part whose newest version is
 * `template` follows the figures, a `user` one is kept as written, and a part with no versions is
 * generated.
 */
export const REPORT_TEXT_SCHEMA = 'aio.report-text/1' as const;

/** One customer report type per project type; later types add a value. */
export const ReportTypeId = z.enum(['volumetric']);

/** The editable texts of the volumetric report, in editor order. */
export const VolumetricTextId = z.enum([
  'title',
  'preparedFor',
  'preparedBy',
  'summary',
  'intro',
  'method',
  'closing',
]);

/** The printed pages of a customer report: A cover and summary, B pile cards, C what changed. */
export const ReportPageId = z.enum(['cover', 'piles', 'change']);

export const ReportTextFile = z.looseObject({
  schema: z.literal(REPORT_TEXT_SCHEMA),
  /** A `ReportTypeId`; kept open, so a later type never breaks a read. */
  report: z.string().min(1).max(40),
  parts: z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/), NarrativePart),
  /** A note per pile, by measurement id. */
  pileNotes: z.record(SurveyId, NarrativePart).optional(),
  /** Pages switched on or off; a missing page is on. */
  pages: z.partialRecord(ReportPageId, z.boolean()).optional(),
  /** The capture id of the date the report compares with. */
  compareWith: z.string().min(1).max(128).optional(),
});

/** `report/<report>.json`, relative to the project folder. */
export function reportTextPath(report: ReportTypeId): string {
  return `report/${report}.json`;
}

/**
 * The pictures of a customer report, taken from the app's own stage: JPEGs and their framing in
 * `<project>/report/views/<report>/frame.json` (`aio.report-views/1`). Top-down shots share one
 * frame: `px = (e - e0) / mPerPx`, `py = (n1 - n) / mPerPx`.
 */
export const REPORT_VIEWS_SCHEMA = 'aio.report-views/1' as const;

export const ReportViewKind = z.enum(['photo', 'elevation', 'cutfill', '3d']);

/** A picture's file name inside the views folder: lower case, digits and dashes, `.jpg`. */
export const ReportViewFileName = z.string().regex(/^[a-z0-9-]{1,80}\.jpg$/);

/** Most pictures one report keeps. */
export const REPORT_VIEWS_MAX = 64;

export const ReportView = z.looseObject({
  name: z.string().min(1).max(80),
  kind: ReportViewKind,
  /** The date shown (for `cutfill`, the later date of the pair). */
  capture: Id,
  /** `cutfill` only: the date it is compared with. */
  pair: Id.optional(),
  file: ReportViewFileName,
});

/** A pixel on a picture, (x, y) from the top left. */
const PixelPoint = z.tuple([z.number(), z.number()]);

export const ReportViewsFrame = z
  .looseObject({
    schema: z.literal(REPORT_VIEWS_SCHEMA),
    /** The top-down extent [e0, n0, e1, n1] in the project CRS. */
    extent: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    widthPx: z.number().int().positive().max(16_384),
    heightPx: z.number().int().positive().max(16_384),
    mPerPx: z.number().positive(),
    views: z.array(ReportView).max(REPORT_VIEWS_MAX),
    /** The 3D shot's projected pile centres: by capture, then by measurement id. */
    markers3d: z.record(Id, z.record(SurveyId, PixelPoint)),
    /** A fingerprint of the inputs the pictures were taken from, to tell when they are stale. */
    fingerprint: z.string().min(1).max(200),
  })
  .refine((f) => f.extent[2] > f.extent[0] && f.extent[3] > f.extent[1], {
    message: 'The extent must run from west-south to east-north',
    path: ['extent'],
  });

/** `report/views/<report>`, relative to the project folder. */
export function reportViewsDir(report: ReportTypeId): string {
  return `report/views/${report}`;
}

export type ReportTypeId = z.infer<typeof ReportTypeId>;
export type VolumetricTextId = z.infer<typeof VolumetricTextId>;
export type ReportPageId = z.infer<typeof ReportPageId>;
export type ReportTextFile = z.infer<typeof ReportTextFile>;
export type ReportViewKind = z.infer<typeof ReportViewKind>;
export type ReportView = z.infer<typeof ReportView>;
export type ReportViewsFrame = z.infer<typeof ReportViewsFrame>;
