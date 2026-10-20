/**
 * The filter box of the Datasets tree's Measurements group: which measurements a query matches.
 * Pure; the tree's rows are built from what it keeps (`buildMeasureItems`), so the tree only draws.
 */
import type { SurveyMeasurement, SurveyTemplate } from '@aio/schema';
import { TOOL_LABELS } from '@aio/survey';
import { entryOf } from './measureCatalogue';

/** The query's terms, lowercased; none for a blank query (no filter). */
export function filterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * A measurement's texts, lowercased: its label, its tool's names, its folder, its custom field
 * values, its template's name and the template's item names.
 */
function textsOf(m: SurveyMeasurement, byId: ReadonlyMap<string, SurveyTemplate>): string[] {
  const tpl = m.template ? byId.get(m.template) : undefined;
  return [
    m.label,
    TOOL_LABELS[m.tool],
    entryOf(m.tool)?.label,
    m.folder,
    ...Object.values(m.fields ?? {}).map(String),
    tpl?.name,
    ...(tpl?.items ?? []),
  ]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .map((x) => x.toLowerCase());
}

/**
 * The measurements a query matches, in their order. Phrase first: when the whole query (trimmed,
 * its spaces collapsed) is part of one single text of any measurement, only those phrase matches
 * are kept, so "Crew A" is the crew A and not every crew row with an "a" somewhere. With no
 * phrase match anywhere, every term must be part of some text (each its own), so "pad 12" finds
 * "Pad check 12". Case-insensitive; a term does not run across two texts. A blank query keeps all.
 */
export function matchingMeasurements(
  list: readonly SurveyMeasurement[],
  query: string,
  templates: readonly SurveyTemplate[],
): SurveyMeasurement[] {
  const terms = filterTerms(query);
  if (terms.length === 0) return [...list];
  const phrase = terms.join(' ');
  const byId = new Map(templates.map((x) => [x.id, x]));
  const texts = list.map((m) => textsOf(m, byId));
  const phrased = list.filter((_, i) => texts[i]?.some((x) => x.includes(phrase)) === true);
  if (phrased.length > 0) return phrased;
  return list.filter((_, i) =>
    terms.every((term) => texts[i]?.some((x) => x.includes(term)) === true),
  );
}
