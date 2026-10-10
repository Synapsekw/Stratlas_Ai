import { ONLINE_SATELLITE, type RasterPackInfo } from '@aio/schema';
import type { GlobeLayerPlan } from './layers';

/** The credit of the painted Natural Earth II raster (public domain; we credit it anyway). */
export const BUNDLED_CREDIT = 'Natural Earth II (public domain)';

/** The credit of the bundled land and border shapes (Natural Earth 1:50m, public domain). */
export const EARTH_SHAPES_CREDIT = 'Natural Earth (public domain)';

type Credited = Pick<RasterPackInfo, 'attribution' | 'customerLicence'>;

/**
 * The credit of the online satellite imagery (Sentinel-2 cloudless 2016 by EOX, CC BY 4.0; ADR
 * 0007, amendment of 10 Oct 2026). The licence asks for it wherever the imagery is drawn; About
 * lists it whether or not the imagery is switched on.
 */
export const ONLINE_SATELLITE_CREDIT: string = ONLINE_SATELLITE.attribution;

export interface CreditsShown {
  /** The online satellite imagery is drawn: its credit comes right after the bundled Earth's. */
  onlineSatellite?: boolean;
  /** What the Earth under the packs is drawn from (the Natural Earth II raster when left out). */
  base?: readonly string[];
}

/**
 * The credit lines the Globe shows for the packs in view: the bundled Earth first (`base`, the
 * Natural Earth II raster unless told otherwise), then each pack's attribution once, in the order
 * given (decision 4: attribution shows wherever the data does). Customer imagery is marked so
 * nobody takes it for ours. With `onlineSatellite`, the online imagery's credit comes right after
 * the bundled one (it is drawn right above it).
 */
export function creditLines(packs: readonly Credited[], shown: CreditsShown = {}): string[] {
  const out = [...new Set(shown.base ?? [BUNDLED_CREDIT])];
  if (shown.onlineSatellite) out.push(ONLINE_SATELLITE_CREDIT);
  for (const p of packs) {
    const line = p.customerLicence ? `${p.attribution} (customer licence)` : p.attribution;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * The credit lines of a layer plan: what the Earth is drawn from (the shapes, the street packs,
 * the old raster), then the imagery packs in it and the terrain packs in use.
 */
export function planCredits<P extends Credited>(
  plan: readonly GlobeLayerPlan<P>[],
  streetCredit: string,
  terrain: readonly Credited[] = [],
): string[] {
  const base: string[] = [];
  const packs: Credited[] = [];
  for (const layer of plan) {
    if (layer.kind === 'earth-shapes') base.push(EARTH_SHAPES_CREDIT);
    else if (layer.kind === 'street') base.push(streetCredit);
    else if (layer.kind === 'natural-earth') base.push(BUNDLED_CREDIT);
    else packs.push(layer.pack);
  }
  return creditLines([...packs, ...terrain], { base });
}
