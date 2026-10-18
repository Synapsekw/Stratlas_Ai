/**
 * Licence gate for imported detector models. Founder decision 2 (PRD BLD-10) relaxed on
 * 2026-10-18 for internal use: copyleft, non-commercial and unknown licences import with a warning
 * instead of being refused; a missing licence is still refused.
 *
 * `licenceProblem` is the refusal (only an empty licence). `licenceWarning` is the kind of second
 * look a licence deserves before the app is sold or handed out: none for permissive licences and
 * for `LicenseRef-...` (a commercial licence the person holds, an Ultralytics Enterprise licence
 * for example), else `copyleft`, `non-commercial` or `unknown`. The card's licence string is
 * never relabelled; the renderer shows it as written next to the warning.
 */
import type { LicenceWarning } from '@aio/schema';

/** Permissive SPDX ids: no warning. */
export const PERMISSIVE_LICENCES = [
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Zlib',
  'Unlicense',
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-3.0',
  'CDLA-Permissive-2.0',
  'BSL-1.0',
  'PSF-2.0',
] as const;

const permissive = new Set<string>(PERMISSIVE_LICENCES.map((l) => l.toLowerCase()));
const NON_COMMERCIAL = /^cc-by-nc/i;
/**
 * Share-alike (GPL family, MPL, EPL, EUPL, OSL, SSPL, CC-BY-SA), no-derivatives (CC-BY-ND) and the
 * use-restricted model licences (OpenRAIL, Llama, Gemma): all usable internally, all needing a
 * check before the app is sold or handed out, so one kind.
 */
const COPYLEFT = /^(a?gpl|lgpl|mpl|epl|eupl|osl|sspl|cc-by-sa|cc-by-nd|llama|gemma)|openrail/i;

/**
 * Severity, mildest first. Copyleft allows commercial use once its terms are met; non-commercial
 * forbids it; unknown cannot be judged at all. AND takes the strictest part, OR the mildest
 * alternative.
 */
const SEVERITY: readonly LicenceWarning[] = ['copyleft', 'non-commercial', 'unknown'];
const rank = (w: LicenceWarning | null) => (w === null ? -1 : SEVERITY.indexOf(w));

function idWarning(id: string): LicenceWarning | null {
  const bare = id.replace(/\+$/, '');
  if (permissive.has(bare.toLowerCase()) || /^LicenseRef-[A-Za-z0-9.-]+$/.test(bare)) return null;
  if (NON_COMMERCIAL.test(bare)) return 'non-commercial';
  if (COPYLEFT.test(bare)) return 'copyleft';
  return 'unknown';
}

const bareExpression = (expression: string) => expression.replace(/[()]/g, ' ').trim();

/** Why a model with this SPDX expression may not be imported (only a missing licence), or null. */
export function licenceProblem(expression: string): string | null {
  return bareExpression(expression)
    ? null
    : 'The model card gives no licence. Models without a licence cannot be imported.';
}

/** The kind of warning this SPDX expression deserves, or null for none. */
export function licenceWarning(expression: string): LicenceWarning | null {
  const expr = bareExpression(expression);
  if (!expr) return 'unknown';
  // OR binds looser than AND; WITH adds an exception to the id before it.
  const alternatives = expr.split(/\s+OR\s+/i).map((alt) =>
    alt
      .split(/\s+AND\s+/i)
      .map((part) => part.split(/\s+WITH\s+/i)[0]?.trim() ?? '')
      .filter(Boolean),
  );
  let mildest: LicenceWarning | null = 'unknown';
  for (const ids of alternatives) {
    let strictest: LicenceWarning | null = ids.length ? null : 'unknown';
    for (const w of ids.map(idWarning)) if (rank(w) > rank(strictest)) strictest = w;
    if (strictest === null) return null;
    if (rank(strictest) < rank(mildest)) mildest = strictest;
  }
  return mildest;
}
