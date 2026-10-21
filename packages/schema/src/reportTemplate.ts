import { z } from 'zod';
import { IsoTime } from './common';
import { SurveyId } from './survey';

/** `report/template.json`: which measurement figures go into the report, and in what order. */
export const REPORT_TEMPLATE_SCHEMA = 'aio.report-template/1' as const;
export const REPORT_TEMPLATE_FILE = 'report/template.json';

/** The parts of a measurement this build prints. A later build's part is kept, never printed. */
export const TEMPLATE_PARTS = ['value', 'chart', 'table'] as const;
export type TemplatePart = (typeof TEMPLATE_PARTS)[number];

/**
 * The family is open, so an addition does not make this build refuse the file (a refused file
 * stops every Add to report): a part is any short id (`TEMPLATE_PARTS` are printed), a section is
 * any short id (this build prints the ones it knows), and an entry of a kind this build does not
 * know is kept as it is and ignored. Every object is loose, so fields added later are written back.
 */
const PartId = z.string().min(1).max(40);

export const MeasurementTemplateEntry = z.looseObject({
  kind: z.literal('measurement'),
  id: SurveyId,
  parts: z.array(PartId).min(1).max(20),
  addedAt: IsoTime,
});

export const SectionTemplateEntry = z.looseObject({
  kind: z.literal('section'),
  /** A `ReportSectionId`, or a later build's section (ignored here). */
  section: z.string().min(1).max(80),
});

const KNOWN_KINDS: readonly string[] = ['measurement', 'section'];

/** An entry of a kind a later build added: kept and written back unchanged, never printed. */
export const OtherTemplateEntry = z.looseObject({
  kind: z
    .string()
    .min(1)
    .max(80)
    .refine((k) => !KNOWN_KINDS.includes(k), 'A measurement or section entry is not well formed.'),
});

/**
 * One entry of the report template: a measurement with the parts of it to print, a whole report
 * section, or an entry a later build added. The file is new: absent on every older project, and
 * older builds ignore it.
 */
export const TemplateEntry = z.union([
  MeasurementTemplateEntry,
  SectionTemplateEntry,
  OtherTemplateEntry,
]);

export const ReportTemplateFile = z.looseObject({
  schema: z.literal(REPORT_TEMPLATE_SCHEMA),
  entries: z.array(TemplateEntry).max(500),
});

export type MeasurementTemplateEntry = z.infer<typeof MeasurementTemplateEntry>;
export type SectionTemplateEntry = z.infer<typeof SectionTemplateEntry>;
export type TemplateEntry = z.infer<typeof TemplateEntry>;
export type ReportTemplateFile = z.infer<typeof ReportTemplateFile>;

/** A measurement entry (a parsed entry of kind `measurement` is always well formed). */
export const isMeasurementEntry = (e: TemplateEntry): e is MeasurementTemplateEntry =>
  e.kind === 'measurement';

/** A section entry (a parsed entry of kind `section` is always well formed). */
export const isSectionEntry = (e: TemplateEntry): e is SectionTemplateEntry => e.kind === 'section';

/** The parts of a measurement entry this build prints, in the entry's order. */
export const knownParts = (e: MeasurementTemplateEntry): TemplatePart[] =>
  e.parts.filter((p): p is TemplatePart => (TEMPLATE_PARTS as readonly string[]).includes(p));

export function emptyReportTemplate(): ReportTemplateFile {
  return { schema: REPORT_TEMPLATE_SCHEMA, entries: [] };
}
