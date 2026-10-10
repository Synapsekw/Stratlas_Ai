import { ONLINE_SATELLITE, type RasterPackInfo } from '@aio/schema';

/** The credit of the imagery bundled with the app (public domain; we credit it anyway). */
export const BUNDLED_CREDIT = 'Natural Earth II (public domain)';

/**
 * The credit of the online satellite imagery (Sentinel-2 cloudless 2016 by EOX, CC BY 4.0; ADR
 * 0007, amendment of 10 Oct 2026). The licence asks for it wherever the imagery is drawn; About
 * lists it whether or not the imagery is switched on.
 */
export const ONLINE_SATELLITE_CREDIT: string = ONLINE_SATELLITE.attribution;

/**
 * The credit lines the Globe shows for the packs in view: the bundled imagery first, then each
 * pack's attribution once, in the order given (decision 4: attribution shows wherever the data
 * does). Customer imagery is marked so nobody takes it for ours. With `onlineSatellite`, the
 * online imagery's credit comes right after the bundled one (it is drawn right above it).
 */
export function creditLines(
  packs: readonly Pick<RasterPackInfo, 'attribution' | 'customerLicence'>[],
  shown: { onlineSatellite?: boolean } = {},
): string[] {
  const out = [BUNDLED_CREDIT];
  if (shown.onlineSatellite) out.push(ONLINE_SATELLITE_CREDIT);
  for (const p of packs) {
    const line = p.customerLicence ? `${p.attribution} (customer licence)` : p.attribution;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}
