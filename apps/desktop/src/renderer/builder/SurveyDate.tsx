import type { ImportItem } from '@aio/schema';
import { useT } from '@aio/ui';
import { SurveyDateSelect } from '../change/SurveyDate';

/**
 * The import step's "Survey date" (M8 C1, BLD-3 "align survey dates"): the survey the layers just
 * imported belong to, in a project with two or more dates. Sets `capture` on them; "Not dated"
 * leaves the date to the layer names.
 */
export function ImportSurveyDate({ items }: { items: readonly ImportItem[] }) {
  const t = useT();
  const layerIds = [
    ...new Set(items.flatMap((i) => (i.status === 'imported' && i.layerId ? [i.layerId] : []))),
  ];
  return (
    <SurveyDateSelect
      layerIds={layerIds}
      label={t('change.surveyDate')}
      noneLabel={t('change.surveyDateNone')}
      testId="import-survey-date"
    />
  );
}
