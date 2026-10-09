import {
  IndustrySet,
  SurveyTemplatesFile,
  type SurveyTemplate,
  type IndustrySet as IndustrySetId,
} from '@aio/schema';
import construction from './construction.json' with { type: 'json' };
import landfill from './landfill.json' with { type: 'json' };
import mining from './mining.json' with { type: 'json' };

/**
 * The industry template sets (M11 G9, PRD SRV-14, data-conventions section 27): construction,
 * mining and quarry, and landfill, shipped as `SurveyTemplatesFile` JSON next to this file. A site
 * enables one or more in its settings (`templateSets`); the toolbar then shows their templates
 * (each is bookmarked) after the project's and the person's own. Comparison presets that name a
 * design use conventional layer names (`design/og`, `design/subgrade`, `design/pad`,
 * `cell-design/cell-base`, `cell-design/final-cap`); a project with other names picks its own
 * layers in the comparison, and until then the item says the design is missing.
 */
const FILES: Record<IndustrySetId, unknown> = { construction, mining, landfill };

const parsed = new Map<IndustrySetId, SurveyTemplate[]>();

/** The templates of one set, validated against the contract once. */
export function industrySet(set: IndustrySetId): SurveyTemplate[] {
  let list = parsed.get(set);
  if (!list) {
    list = SurveyTemplatesFile.parse(FILES[set]).templates;
    parsed.set(set, list);
  }
  return list;
}

/** The templates of the sets a site enables, in set order, each once. */
export function industryTemplates(sets: readonly IndustrySetId[] = []): SurveyTemplate[] {
  return IndustrySet.options.filter((s) => sets.includes(s)).flatMap((s) => industrySet(s));
}

/** Labels of the sets for pickers. */
export const INDUSTRY_SET_LABELS: Record<IndustrySetId, string> = {
  construction: 'Construction',
  mining: 'Mining and quarry',
  landfill: 'Landfill',
};
