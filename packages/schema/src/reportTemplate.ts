import { z } from 'zod';
import { IsoTime } from './common';
import { ReportSectionId } from './report';
import { SurveyId } from './survey';

/** `report/template.json`: which measurement figures go into the report, and in what order. */
export const REPORT_TEMPLATE_SCHEMA = 'aio.report-template/1' as const;
export const REPORT_TEMPLATE_FILE = 'report/template.json';

/**
 * One entry of the report template: a measurement with the parts of it to print, or a whole
 * report section. The file is new: absent on every older project, and older builds ignore it.
 */
export const TemplateEntry = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('measurement'),
    id: SurveyId,
    parts: z
      .array(z.enum(['value', 'chart', 'table']))
      .min(1)
      .max(3),
    addedAt: IsoTime,
  }),
  z.looseObject({ kind: z.literal('section'), section: ReportSectionId }),
]);

export const ReportTemplateFile = z.looseObject({
  schema: z.literal(REPORT_TEMPLATE_SCHEMA),
  entries: z.array(TemplateEntry).max(500),
});

export type TemplateEntry = z.infer<typeof TemplateEntry>;
export type ReportTemplateFile = z.infer<typeof ReportTemplateFile>;

export function emptyReportTemplate(): ReportTemplateFile {
  return { schema: REPORT_TEMPLATE_SCHEMA, entries: [] };
}
