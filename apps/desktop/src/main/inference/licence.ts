/**
 * Licence gate for imported detector models (founder decision 2, PRD BLD-10): the weights'
 * SPDX licence must allow use in a commercial, closed-source app. Permissive licences pass, as
 * does `LicenseRef-...` for a commercial licence the person holds (an Ultralytics Enterprise
 * licence, for example). Copyleft, non-commercial and unknown licences are refused.
 */

/** Permissive SPDX ids accepted for model weights. */
export const ALLOWED_LICENCES = [
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

const allowed = new Set<string>(ALLOWED_LICENCES.map((l) => l.toLowerCase()));
const COPYLEFT =
  /^(a?gpl|lgpl|mpl|epl|eupl|osl|sspl|cc-by-(nc|sa|nd)|cc-by-nc|openrail|llama|gemma)/i;
const ULTRALYTICS =
  ' Weights trained with Ultralytics YOLO are AGPL-3.0 unless you hold an Ultralytics Enterprise licence (then set the card licence to LicenseRef-Ultralytics-Enterprise).';

function idProblem(id: string): string | null {
  const bare = id.replace(/\+$/, '');
  if (allowed.has(bare.toLowerCase()) || /^LicenseRef-[A-Za-z0-9.-]+$/.test(bare)) return null;
  if (COPYLEFT.test(bare))
    return `${id} is not allowed for detector models in this app (copyleft or non-commercial).${/gpl/i.test(bare) ? ULTRALYTICS : ''}`;
  return `${id} is not a licence this app accepts for detector models. Allowed: ${ALLOWED_LICENCES.join(', ')}, or LicenseRef-<name> for a commercial licence you hold.`;
}

/** Why a model with this SPDX expression may not be imported, or null. */
export function licenceProblem(expression: string): string | null {
  const expr = expression.replace(/[()]/g, ' ').trim();
  if (!expr) return 'The model card gives no licence. Models without a licence cannot be imported.';
  // OR binds looser than AND: one allowed alternative is enough, every part of it must pass.
  const alternatives = expr.split(/\s+OR\s+/i).map((alt) =>
    alt
      .split(/\s+AND\s+/i)
      .map((part) => part.split(/\s+WITH\s+/i)[0]?.trim() ?? '')
      .filter(Boolean),
  );
  let first: string | null = null;
  for (const ids of alternatives) {
    const problem = ids.map(idProblem).find((p) => p !== null) ?? null;
    if (!problem) return null;
    first ??= problem;
  }
  return first;
}
