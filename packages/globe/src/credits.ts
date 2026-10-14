import { onlineSource, type OnlineSourceId, type RasterPackInfo } from '@aio/schema';
import type { GlobeLayerPlan } from './layers';

/** The credit of the painted Natural Earth II raster (public domain; we credit it anyway). */
export const BUNDLED_CREDIT = 'Natural Earth II (public domain)';

/** The credit of the bundled land and border shapes (Natural Earth 1:50m, public domain). */
export const EARTH_SHAPES_CREDIT = 'Natural Earth (public domain)';

type Credited = Pick<RasterPackInfo, 'attribution' | 'customerLicence'>;

/**
 * The credit of an online source (ADR 0007, amendments of 10 and 14 Oct 2026), from the catalog:
 * its terms ask for it wherever it is drawn.
 */
export function onlineCredit(id: OnlineSourceId): string {
  return onlineSource(id)?.attribution ?? '';
}

export interface CreditsShown {
  /** The online source drawn: its credit comes right after the bundled Earth's. */
  online?: OnlineSourceId | null;
  /** What the Earth under the packs is drawn from (the Natural Earth II raster when left out). */
  base?: readonly string[];
}

/**
 * The credit lines the Globe shows for the packs in view: the bundled Earth first (`base`, the
 * Natural Earth II raster unless told otherwise), then each pack's attribution once, in the order
 * given (decision 4: attribution shows wherever the data does). Customer imagery is marked so
 * nobody takes it for ours. With `online`, the online source's credit comes right after
 * the bundled one (it is drawn right above it).
 */
export function creditLines(packs: readonly Credited[], shown: CreditsShown = {}): string[] {
  const out = [...new Set(shown.base ?? [BUNDLED_CREDIT])];
  if (shown.online) out.push(onlineCredit(shown.online));
  for (const p of packs) {
    const line = p.customerLicence ? `${p.attribution} (customer licence)` : p.attribution;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * The credit lines of a layer plan: what the Earth is drawn from (the shapes, the street packs,
 * the old raster), the online source when the plan draws it, then the imagery packs
 * in it and the terrain packs in use.
 */
export function planCredits<P extends Credited>(
  plan: readonly GlobeLayerPlan<P, unknown>[],
  streetCredit: string,
  terrain: readonly Credited[] = [],
): string[] {
  const base: string[] = [];
  const packs: Credited[] = [];
  let online: OnlineSourceId | null = null;
  for (const layer of plan) {
    if (layer.kind === 'earth-shapes') base.push(EARTH_SHAPES_CREDIT);
    else if (layer.kind === 'street') base.push(streetCredit);
    else if (layer.kind === 'natural-earth') base.push(BUNDLED_CREDIT);
    else if (layer.kind === 'online') online = layer.source;
    else if (layer.kind === 'imagery-pack') packs.push(layer.pack);
    // a project raster is the project's own survey: no credit line
  }
  return creditLines([...packs, ...terrain], { base, online });
}
