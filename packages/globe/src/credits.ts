import type { RasterPackInfo } from '@aio/schema';

/** The credit of the imagery bundled with the app (public domain; we credit it anyway). */
export const BUNDLED_CREDIT = 'Natural Earth II (public domain)';

/**
 * The credit lines the Globe shows for the packs in view: the bundled imagery first, then each
 * pack's attribution once, in the order given (decision 4: attribution shows wherever the data
 * does). Customer imagery is marked so nobody takes it for ours.
 */
export function creditLines(
  packs: readonly Pick<RasterPackInfo, 'attribution' | 'customerLicence'>[],
): string[] {
  const out = [BUNDLED_CREDIT];
  for (const p of packs) {
    const line = p.customerLicence ? `${p.attribution} (customer licence)` : p.attribution;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}
