/**
 * The Globe's base map in `globe.json` (plan 2026-10-14-satellite-providers): `base` and `packs`
 * are new and optional; `style` is still written, so 0.11 opens the Globe in a look it knows.
 */
import { globeStyleOf, type GlobeStyle } from '@aio/globe';
import { isOnlineBase, type BaseMapId, type GlobeSettings, type OnlineSourceId } from '@aio/schema';

/**
 * The base map: the one chosen in the Map menu, or, never chosen, what 0.11's look showed (its
 * Satellite look drew the online satellite under the packs once online maps were on).
 */
export function globeBaseOf(
  prefs: GlobeSettings,
  online: { enabled: boolean; source: OnlineSourceId },
): BaseMapId {
  if (prefs.base) return prefs.base;
  const style = globeStyleOf(prefs);
  if (style === 'natural-earth') return 'natural-earth';
  if (style === 'satellite' && online.enabled) return online.source;
  return 'streets';
}

/** Imagery packs on top: as chosen, or as 0.11's look drew them (not on the street look). */
export function globePacksOf(prefs: GlobeSettings): boolean {
  return prefs.packs ?? globeStyleOf(prefs) !== 'street';
}

/** The look to draw and to write for 0.11: street, satellite (online or packs) or natural earth. */
export function globeStyleFor(base: BaseMapId, packs: boolean): GlobeStyle {
  if (base === 'natural-earth') return 'natural-earth';
  if (isOnlineBase(base)) return 'satellite';
  return packs ? 'satellite' : 'street';
}

export function globeDraw(
  drawn: BaseMapId,
  packs: boolean,
): { style: GlobeStyle; online: OnlineSourceId | null } {
  return { style: globeStyleFor(drawn, packs), online: isOnlineBase(drawn) ? drawn : null };
}

export function withBase(prefs: GlobeSettings, base: BaseMapId, packs: boolean): GlobeSettings {
  return { ...prefs, base, packs, style: globeStyleFor(base, packs) };
}
