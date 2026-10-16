import { HOUSE_SECTIONS, RUN_SECTIONS, SURVEY_SECTIONS } from '@aio/project/export';
import type {
  ReportSectionId,
  SurveyMeasurement,
  SurveySettings,
  SurveyTemplatesFile,
} from '@aio/schema';
import { surveySectionIds, surveyTemplateList } from '../reportPage/house/surveyData';

const DATA_SECTIONS: readonly ReportSectionId[] = [...SURVEY_SECTIONS, ...RUN_SECTIONS];

/**
 * The sections the Reports screen offers: every house section, but a survey or run section
 * (measurements, earthworks, stockpiles, landfill, haul road, hydrology) only when the project has
 * data for it, since the report prints nothing there otherwise. `withData` is null while the
 * project's survey files are still being read: no data section is offered until they are.
 */
export function offeredSections(withData: readonly ReportSectionId[] | null): ReportSectionId[] {
  return HOUSE_SECTIONS.filter((id) => !DATA_SECTIONS.includes(id) || withData?.includes(id));
}

/** The survey and run sections a project has data for, from what the survey panel reads too. */
export function sectionsWithData(read: {
  measurements: readonly SurveyMeasurement[];
  settings: SurveySettings;
  templates: SurveyTemplatesFile | null;
  haulRuns: number;
  hydroRuns: number;
}): ReportSectionId[] {
  return [
    ...surveySectionIds({
      measurements: [...read.measurements],
      settings: read.settings,
      templates: surveyTemplateList(read.templates, read.settings),
    }),
    ...(read.haulRuns > 0 ? (['haul'] as const) : []),
    ...(read.hydroRuns > 0 ? (['hydrology'] as const) : []),
  ];
}
