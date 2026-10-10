/**
 * The street map on the Globe: the colours of the app's street style, and its tiles drawn from
 * the installed street packs (`@aio/maps`). `@aio/globe` knows neither MapLibre nor the packs; it
 * takes the colours as a palette and the tiles as a `GlobeTileSource`.
 */
import {
  GLOBE_LOOKS,
  STREET_GLOBE_PALETTE,
  globePixelRatio,
  type GlobePalette,
  type GlobeStyle,
  type GlobeTileSource,
  type GlobeTierName,
} from '@aio/globe';
import { STREET, createStreetTiles } from '@aio/maps';
import type { MapPackInfo } from '@aio/schema';
import { useEffect, useState } from 'react';

/** The Globe's colours: water, land, borders and backdrop exactly as the street style has them. */
export const GLOBE_PALETTE: GlobePalette = {
  ...STREET_GLOBE_PALETTE,
  space: STREET.background,
  water: STREET.water,
  land: STREET.earth,
  border: STREET.boundary,
};

/**
 * The street tiles for the Globe: one hidden map that draws them, made when the look shows the
 * street map and a street pack is installed, and removed with the Globe.
 */
export function useStreetTiles(
  packs: readonly MapPackInfo[] | null,
  style: GlobeStyle,
  tier: GlobeTierName,
): GlobeTileSource | null {
  const [source, setSource] = useState<GlobeTileSource | null>(null);
  const wanted = style !== 'natural-earth' && packs !== null && packs.length > 0;
  useEffect(() => {
    if (!wanted) return;
    // read after the tiles are made: the Globe may have closed by then
    const state: { live: boolean; made: GlobeTileSource | null } = { live: true, made: null };
    const pixelRatio = globePixelRatio(window.devicePixelRatio, GLOBE_LOOKS[tier]);
    void createStreetTiles(packs, { pixelRatio }).then((tiles) => {
      if (!state.live) {
        tiles?.dispose();
        return;
      }
      state.made = tiles;
      setSource(tiles);
    });
    return () => {
      state.live = false;
      setSource(null);
      state.made?.dispose?.();
    };
  }, [wanted, packs, tier]);
  return wanted ? source : null;
}
