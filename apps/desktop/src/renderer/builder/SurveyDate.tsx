import type { ImportItem } from '@aio/schema';
import { useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { SurveyDateSelect } from '../change/SurveyDate';
import { useBuilder } from './state';

/**
 * The import step's "Survey date" (M8 C1, BLD-3 "align survey dates", Timeline T2): the survey the
 * layers just imported belong to, with any number of dates in the project. Sets `capture` on them;
 * "Not dated" leaves the date to the layer names. Only the layers the import made are re-dated: a
 * layer that was there before (a date's photos layer a second flight added to) keeps its date, so
 * earlier flights never move. The dates the import made are tidied up when the layers leave them
 * empty, and New survey date starts on the import's day.
 */
export function ImportSurveyDate({ items }: { items: readonly ImportItem[] }) {
  const t = useT();
  const newDates = useBuilder((s) =>
    s.importResult?.items === items ? s.importResult.newDates : undefined,
  );
  const priorLayers = useBuilder((s) =>
    s.importResult?.items === items ? s.importResult.priorLayers : undefined,
  );
  const dateSource = useBuilder((s) =>
    s.importResult?.items === items ? s.importResult.dateSource : undefined,
  );
  const imported = [
    ...new Set(items.flatMap((i) => (i.status === 'imported' && i.layerId ? [i.layerId] : []))),
  ];
  const prior = new Set(priorLayers ?? []);
  const layerIds = imported.filter((id) => !prior.has(id));
  const firstNew = newDates?.[0];
  // read once: the date may be tidied away or the layers re-dated later, the import's day stays.
  // The first date the import made, else the date its layers were filed under (a day that had one)
  const suggestedDay = useMemo(() => {
    const manifest = workspace.getState().project?.manifest;
    if (!manifest) return undefined;
    const dateOf = (id: string | undefined) =>
      id ? manifest.captures.find((c) => c.id === id)?.date : undefined;
    if (firstNew) return dateOf(firstNew);
    const ids = new Set(imported);
    return dateOf(manifest.layers.find((l) => ids.has(l.id) && l.capture)?.capture);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per import
  }, [items, firstNew]);
  if (layerIds.length === 0) return null;
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
