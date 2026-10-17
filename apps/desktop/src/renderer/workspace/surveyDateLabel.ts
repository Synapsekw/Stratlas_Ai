import { formatDate } from '@aio/ui';

/**
 * A survey's name in the date switches (the island's row and the Volumes set): the survey's own
 * label. A label that is just its date reads without the year, as `formatDate` writes it; any other
 * name stays whole, and the switch's CSS cuts one that is too long.
 */
export function surveyDateLabel(capture: { date: string; label: string }): string {
  return capture.label === formatDate(capture.date)
    ? formatDate(capture.date, { year: false })
    : capture.label;
}
