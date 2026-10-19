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

/** Whether a term is in the texts: anywhere, or for a one-character term at a word's start. */
function hasTerm(texts: string, term: string): boolean {
  if (term.length > 1) return texts.includes(term);
  // "a" alone would match nearly every measurement ("Distance"): "Crew A" means the crew A
  for (let i = texts.indexOf(term); i !== -1; i = texts.indexOf(term, i + 1))
    if (i === 0 || !/[\p{L}\p{N}]/u.test(texts.charAt(i - 1))) return true;
  return false;
}

/**
 * Whether a measurement matches the query: every term, case-insensitive, is part of one of its
 * texts (its label, its tool's name, its folder, a custom field's value, its template's name or
 * one of the template's item names); a one-character term only at the start of a word. A term
 * does not run across two texts. A blank query matches every measurement.
 */
export function measureMatcher(
  query: string,
  templates: readonly SurveyTemplate[],
): (m: SurveyMeasurement) => boolean {
  const terms = filterTerms(query);
  if (terms.length === 0) return () => true;
  const byId = new Map(templates.map((x) => [x.id, x]));
  return (m) => {
    const tpl = m.template ? byId.get(m.template) : undefined;
    const texts = [
      m.label,
      TOOL_LABELS[m.tool],
      entryOf(m.tool)?.label,
      m.folder,
      ...Object.values(m.fields ?? {}).map(String),
      tpl?.name,
      ...(tpl?.items ?? []),
    ]
      .filter((x): x is string => typeof x === 'string' && x !== '')
      .join('\n')
      .toLowerCase();
    return terms.every((term) => hasTerm(texts, term));
  };
}
