import type { SurveyUnits, UnitsOverride } from '@aio/schema';

/**
 * A measurement's units: the site units with its own overrides on top. Formatting, conversion
 * and parsing are G1's (`@aio/geo` `formatQuantity`, `toSI`, `unitLabel`, `unitName`).
 */
export function effectiveUnits(site: SurveyUnits, override?: UnitsOverride): SurveyUnits {
  const out: SurveyUnits = { ...site };
  if (!override) return out;
  if (override.distance) out.distance = override.distance;
  if (override.area) out.area = override.area;
  if (override.volume) out.volume = override.volume;
  if (override.density) out.density = override.density;
  if (override.mass) out.mass = override.mass;
  if (override.grade) out.grade = override.grade;
  return out;
}
