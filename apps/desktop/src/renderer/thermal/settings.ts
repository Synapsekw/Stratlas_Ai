import { thermalPhotoKey, type ThermalFile, type ThermalSettings } from '@aio/schema';

/** What a photo needs of the layer item to find its default distance. */
export interface ThermalItem {
  /** Project-local position; `pos[1]` is the height. */
  pos?: readonly number[];
  /** The drone log: height above the take-off point. */
  dji?: { relAlt?: number };
}

export const FALLBACK_DISTANCE_M = 10;

/** The design defaults; the distance is the fallback when the photo's height is not known. */
export const DESIGN_DEFAULTS: ThermalSettings = {
  emissivity: 0.95,
  distanceM: FALLBACK_DISTANCE_M,
  airC: 25,
  humidityPct: 50,
  reflectedC: null,
};

/** The camera's height above the take-off point, when known and above it. */
function heightAbove(item: ThermalItem, takeoffH: number | null): number | null {
  const rel = item.dji?.relAlt;
  if (rel !== undefined && Number.isFinite(rel) && rel > 0) return rel;
  const h = item.pos?.[1];
  if (h === undefined || takeoffH === null) return null;
  return h - takeoffH > 0 ? h - takeoffH : null;
}

/**
 * The settings a photo is computed with: its own, else the file's defaults, else the design
 * defaults with the distance from the photo's height above take-off (10 m when unknown).
 */
export function effectiveSettings(
  file: ThermalFile | null,
  layerId: string,
  photoId: string,
  item: ThermalItem,
  takeoffH: number | null,
): ThermalSettings {
  const own = file?.photos[thermalPhotoKey(layerId, photoId)]?.settings;
  if (own) return own;
  if (file?.defaults) return file.defaults;
  return {
    ...DESIGN_DEFAULTS,
    distanceM: heightAbove(item, takeoffH) ?? FALLBACK_DISTANCE_M,
  };
}

/**
 * A copy of `file` with `patch` applied to the photos in `keys` (`"<layerId>/<photoId>"`); a photo
 * with no settings yet starts from the file's defaults, else the design defaults. Nothing else
 * (readings, hot spots, grading, other photos) changes.
 */
export function applySettings(
  file: ThermalFile,
  keys: readonly string[],
  patch: Partial<ThermalSettings>,
): ThermalFile {
  const photos = { ...file.photos };
  for (const key of keys) {
    const base = photos[key]?.settings ?? file.defaults ?? DESIGN_DEFAULTS;
    photos[key] = { ...photos[key], settings: { ...base, ...patch } };
  }
  return { ...file, photos };
}
