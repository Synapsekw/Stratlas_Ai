/**
 * The Map menu as data (plan 2026-10-14-satellite-providers): which base maps each view offers,
 * whether each can be picked and why not, the On top switches, what is actually drawn and the
 * credit line. One model for the Map view, the Globe and the 3D scene; `MapMenu.tsx` draws it and
 * each view's adapter reads and writes its own choices.
 */
import { BUNDLED_CREDIT } from '@aio/globe';
import {
  isOnlineBase,
  onlineSource,
  type BaseMapId,
  type MapKeysStatus,
  type OnlineSource,
} from '@aio/schema';
import type { MessageKey } from '@aio/ui';

export type MapMenuView = 'map' | 'globe' | 'scene';
export type TileState = 'available' | 'needs-key' | 'offline' | 'tier';
export type OnTopKey =
  'streets' | 'hillshade' | 'packs' | 'terrain' | 'aroundImagery' | 'aroundTerrain' | 'issues';
export type SwatchKind =
  | 'streets'
  | 'natural-earth'
  | 'imagery'
  | 'imagery-labels'
  | 'mapbox-streets'
  | 'outdoors'
  | 'light'
  | 'dark';
export type MenuSectionId = 'offline' | 'satellite' | 'mapbox';

export interface MenuTile {
  id: BaseMapId;
  label: MessageKey;
  state: TileState;
  /** Why it cannot be picked (the section note shows it in full). */
  reason: MessageKey | null;
  /** The short word on a greyed tile. */
  badge: MessageKey | null;
  selected: boolean;
  swatch: SwatchKind;
}

export interface MenuSection {
  id: MenuSectionId;
  title: MessageKey;
  tiles: MenuTile[];
  /** The reason the greyed tiles of this section share, in full. */
  note: MessageKey | null;
}

export interface OnTopRow {
  key: OnTopKey;
  label: MessageKey;
  on: boolean;
  disabled: boolean;
  reason: MessageKey | null;
}

export interface MapMenuPrefs {
  /** The base map the person chose for this view. */
  base: BaseMapId;
  onTop: Partial<Record<OnTopKey, boolean>>;
  /** The one imagery pack to draw, or null for the best available. */
  pack: string | null;
}

export interface MenuPacks {
  /** Imagery packs that cover the site (Map view, 3D scene) or are installed (Globe). */
  imagery: readonly { id: string; label: string }[];
  /** Terrain packs that cover the site. */
  terrain: number;
}

export interface MenuOnline {
  /** Online maps are switched on (main's `online.json`). */
  enabled: boolean;
  offlineOnly: boolean;
}

export interface MenuContext {
  /** The graphics preset offers imagery and terrain around the site (3D scene; Medium and up). */
  aroundOffered?: boolean;
  /** The graphics preset offers terrain on the Globe (not Low). */
  terrainOffered?: boolean;
  /** The street map's credit for the footer. */
  streetsCredit?: string;
}

export interface MapMenuModel {
  view: MapMenuView;
  sections: MenuSection[];
  onTop: OnTopRow[];
  packs: { id: string; label: string }[];
  pack: string | null;
  showPackPicker: boolean;
  chosen: BaseMapId;
  drawn: BaseMapId;
  /** The chosen map cannot be drawn: the chip notes "Offline map". */
  fallback: boolean;
  chip: MessageKey;
  chipSwatch: SwatchKind;
  credit: string;
}

export const STREETS_CREDIT = '© OpenStreetMap contributors';

export const BASE_LABEL: Record<BaseMapId, MessageKey> = {
  streets: 'mapMenu.tile.streets',
  'natural-earth': 'mapMenu.tile.naturalEarth',
  'esri-world-imagery': 'mapMenu.tile.esri',
  'mapbox-satellite': 'mapMenu.tile.mapboxSatellite',
  's2cloudless-2016': 'mapMenu.tile.sentinel',
  'mapbox-streets': 'mapMenu.tile.mapboxStreets',
  'mapbox-outdoors': 'mapMenu.tile.mapboxOutdoors',
  'mapbox-light': 'mapMenu.tile.mapboxLight',
  'mapbox-dark': 'mapMenu.tile.mapboxDark',
  'mapbox-satellite-streets': 'mapMenu.tile.mapboxSatelliteStreets',
};

const SWATCH: Record<BaseMapId, SwatchKind> = {
  streets: 'streets',
  'natural-earth': 'natural-earth',
  'esri-world-imagery': 'imagery',
  'mapbox-satellite': 'imagery',
  's2cloudless-2016': 'imagery',
  'mapbox-streets': 'mapbox-streets',
  'mapbox-outdoors': 'outdoors',
  'mapbox-light': 'light',
  'mapbox-dark': 'dark',
  'mapbox-satellite-streets': 'imagery-labels',
};

const REASON: Record<Exclude<TileState, 'available'>, MessageKey> = {
  'needs-key': 'mapMenu.reason.needsKey',
  offline: 'mapMenu.reason.offline',
  tier: 'mapMenu.reason.tier',
};

const BADGE: Record<Exclude<TileState, 'available'>, MessageKey> = {
  'needs-key': 'mapMenu.badge.needsKey',
  offline: 'mapMenu.badge.offline',
  tier: 'mapMenu.badge.tier',
};

/**
 * Whether a source can be picked. Online maps switched off do not grey anything: picking a
 * source then asks to switch them on (with the provider's notice).
 */
export function tileState(
  source: OnlineSource,
  online: MenuOnline,
  keys: MapKeysStatus,
): Exclude<TileState, 'tier'> {
  if (online.offlineOnly) return source.diskCache && online.enabled ? 'available' : 'offline';
  if (source.keyPolicy === 'required' && source.keyProvider && !keys[source.keyProvider])
    return 'needs-key';
  return 'available';
}

/**
 * What a view draws for the chosen base map. A source that cannot be drawn gives way: to the
 * saved Sentinel-2 tiles on an offline-only workstation with online maps on, otherwise to the
 * offline street map.
 */
export function drawnBase(
  chosen: BaseMapId,
  online: MenuOnline,
  keys: MapKeysStatus,
): { base: BaseMapId; fallback: boolean } {
  if (!isOnlineBase(chosen)) return { base: chosen, fallback: false };
  const source = onlineSource(chosen);
  if (source && online.enabled && tileState(source, online, keys) === 'available')
    return { base: chosen, fallback: false };
  if (online.enabled && online.offlineOnly) return { base: 's2cloudless-2016', fallback: true };
  return { base: 'streets', fallback: true };
}

const firstReason = (tiles: readonly MenuTile[]): MessageKey | null => {
  const order: Exclude<TileState, 'available'>[] = ['offline', 'tier', 'needs-key'];
  for (const s of order) if (tiles.some((t) => t.state === s)) return REASON[s];
  return null;
};

export function mapMenuModel(
  view: MapMenuView,
  prefs: MapMenuPrefs,
  sources: readonly OnlineSource[],
  packs: MenuPacks,
  online: MenuOnline,
  keys: MapKeysStatus,
  context: MenuContext = {},
): MapMenuModel {
  const aroundOffered = context.aroundOffered ?? true;
  const tile = (id: BaseMapId, state: TileState): MenuTile => ({
    id,
    label: BASE_LABEL[id],
    state,
    reason: state === 'available' ? null : REASON[state],
    badge: state === 'available' ? null : BADGE[state],
    selected: prefs.base === id,
    swatch: SWATCH[id],
  });
  const onlineTile = (s: OnlineSource): MenuTile =>
    tile(s.id, view === 'scene' && !aroundOffered ? 'tier' : tileState(s, online, keys));
  const offline: BaseMapId[] = view === 'globe' ? ['streets', 'natural-earth'] : ['streets'];
  const satellite = sources.filter((s) => s.group === 'satellite').map(onlineTile);
  const mapbox = sources.filter((s) => s.group === 'mapbox').map(onlineTile);
  const sections: MenuSection[] = [
    {
      id: 'offline',
      title: 'mapMenu.section.offline',
      tiles: offline.map((id) => tile(id, 'available')),
      note: null,
    },
    {
      id: 'satellite',
      title: 'mapMenu.section.satellite',
      tiles: satellite,
      note: firstReason(satellite),
    },
    { id: 'mapbox', title: 'mapMenu.section.mapbox', tiles: mapbox, note: firstReason(mapbox) },
  ];

  // below Medium the 3D scene draws nothing online: a saved online base shows as the street map
  const drawn =
    view === 'scene' && !aroundOffered && isOnlineBase(prefs.base)
      ? { base: 'streets' as BaseMapId, fallback: true }
      : drawnBase(prefs.base, online, keys);
  const drawnSource = isOnlineBase(drawn.base) ? onlineSource(drawn.base) : undefined;
  const hasImagery = packs.imagery.length > 0;
  const packsOn = hasImagery && (prefs.onTop.packs ?? false);
  const rowOf = (
    key: OnTopKey,
    label: MessageKey,
    reason: MessageKey | null,
    fallbackOn: boolean,
  ): OnTopRow => ({
    key,
    label,
    disabled: reason !== null,
    reason,
    on: reason === null && (prefs.onTop[key] ?? fallbackOn),
  });

  let onTop: OnTopRow[];
  if (view === 'map') {
    const labelsInBase = drawnSource?.labels ?? false;
    const imageryUnder = (drawnSource?.imagery ?? false) || packsOn;
    onTop = [
      rowOf(
        'streets',
        'mapMenu.onTop.streets',
        labelsInBase
          ? 'mapMenu.reason.labelsInBase'
          : imageryUnder
            ? null
            : 'mapMenu.reason.noImageryUnder',
        true,
      ),
      rowOf(
        'hillshade',
        'mapMenu.onTop.hillshade',
        packs.terrain > 0 ? null : 'mapMenu.reason.noTerrain',
        false,
      ),
      rowOf('packs', 'mapMenu.onTop.packs', hasImagery ? null : 'mapMenu.reason.noImagery', false),
    ];
  } else if (view === 'scene') {
    const tier: MessageKey | null = aroundOffered ? null : 'mapMenu.reason.tier';
    onTop = [
      rowOf(
        'aroundImagery',
        'mapMenu.onTop.aroundImagery',
        tier ?? (hasImagery ? null : 'mapMenu.reason.noImagery'),
        false,
      ),
      rowOf(
        'aroundTerrain',
        'mapMenu.onTop.aroundTerrain',
        tier ?? (packs.terrain > 0 ? null : 'mapMenu.reason.noTerrain'),
        false,
      ),
    ];
  } else {
    onTop = [
      rowOf('packs', 'mapMenu.onTop.packs', hasImagery ? null : 'mapMenu.reason.noImagery', false),
      rowOf(
        'terrain',
        'mapMenu.onTop.terrain',
        (context.terrainOffered ?? true) ? null : 'mapMenu.reason.lowTier',
        true,
      ),
      rowOf('issues', 'mapMenu.onTop.issues', null, true),
    ];
  }

  const credit = drawnSource
    ? drawnSource.attribution
    : drawn.base === 'natural-earth'
      ? BUNDLED_CREDIT
      : (context.streetsCredit ?? STREETS_CREDIT);

  return {
    view,
    sections,
    onTop,
    packs: packs.imagery.map((p) => ({ id: p.id, label: p.label })),
    pack: packs.imagery.some((p) => p.id === prefs.pack) ? prefs.pack : null,
    showPackPicker: view !== 'scene' && packsOn,
    chosen: prefs.base,
    drawn: drawn.base,
    fallback: drawn.fallback,
    chip: BASE_LABEL[prefs.base],
    chipSwatch: SWATCH[prefs.base],
    credit,
  };
}
