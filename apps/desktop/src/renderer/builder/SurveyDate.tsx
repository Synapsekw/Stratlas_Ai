import type { ImportItem } from '@aio/schema';
import { useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { SurveyDateSelect } from '../change/SurveyDate';
import { useBuilder } from './state';

/**
 * The import step's "Survey date" (M8 C1, BLD-3 "align survey dates", Timeline T2): the survey the
 * layers just imported belong to, with any number of dates in the project. Sets `capture` on them;
 * "Not dated" leaves the date to the layer names. The dates the import made are tidied up when the
 * layers leave them empty, and New survey date starts on the day of the first of them.
 */
export function ImportSurveyDate({ items }: { items: readonly ImportItem[] }) {
  const t = useT();
  const newDates = useBuilder((s) =>
    s.importResult?.items === items ? s.importResult.newDates : undefined,
  );
  const dateSource = useBuilder((s) =>
    s.importResult?.items === items ? s.importResult.dateSource : undefined,
  );
  const firstNew = newDates?.[0];
  // read once: the date may be tidied away later, its day is still the import's day
  const suggestedDay = useMemo(
    () =>
      firstNew
        ? workspace.getState().project?.manifest.captures.find((c) => c.id === firstNew)?.date
        : undefined,
    [firstNew],
  );
  const layerIds = [
    ...new Set(items.flatMap((i) => (i.status === 'imported' && i.layerId ? [i.layerId] : []))),
  ];
  return (
    <SurveyDateSelect
      layerIds={layerIds}
      label={t('change.surveyDate')}
      noneLabel={t('change.surveyDateNone')}
      testId="import-survey-date"
      createdHere={newDates ?? []}
      source={dateSource ?? null}
      {...(suggestedDay ? { suggestedDay } : {})}
    />
  );
}
