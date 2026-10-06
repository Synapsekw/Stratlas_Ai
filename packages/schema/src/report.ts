import { z } from 'zod';
import { IsoTime } from './common';

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

/** The text the report prints for a part: its newest version, or null when none is saved. */
export function currentNarrative(
  file: NarrativeFile | null,
  id: NarrativeSectionId,
): string | null {
  const v = file?.parts[id]?.versions.at(-1);
  return v ? v.text : null;
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
  const versions = base.parts[id]?.versions ?? [];
  const last = versions.at(-1);
  if (last?.text === version.text && last.source === version.source) return base;
  const next = [...versions, version].slice(-NARRATIVE_MAX_VERSIONS);
  return { ...base, parts: { ...base.parts, [id]: { versions: next } } };
}

/** Is this section part of the report under these settings (default: yes). */
export function reportSectionOn(
  contents: ReportContentsSettings | undefined,
  id: ReportSectionId,
): boolean {
  return contents?.sections?.[id] ?? true;
}
