/**
 * Places the agent's find_places and fly_to know besides the project's own (assets, issues,
 * media): the stockpiles of a volumetric survey and chainages on a road survey ("km 12.4",
 * "12+400"). Registered once at startup.
 */
import { registerPlaceSource, type Place } from '@aio/ai';
import type { RoadModel, Vec3 } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { pointAtKm } from './road/model';
import { roadStore } from './road/store';

/** Stockpiles, sized by their zone (local x, z) and height. */
export function pilePlaces(
  piles: readonly {
    id: string;
    name: string;
    material?: string | null | undefined;
    zoneRing: readonly (readonly number[])[];
    epochs: Record<string, { heightM: number }>;
  }[],
): Place[] {
  return piles.flatMap((p) => {
    if (p.zoneRing.length === 0) return [];
    const xs = p.zoneRing.map((q) => q[0] ?? 0);
    const zs = p.zoneRing.map((q) => q[1] ?? 0);
    const height = Math.max(1, ...Object.values(p.epochs).map((e) => e.heightM));
    const min: Vec3 = [Math.min(...xs), 0, Math.min(...zs)];
    const max: Vec3 = [Math.max(...xs), height, Math.max(...zs)];
    return [
      {
        id: `pile:${p.id}`,
        kind: 'pile' as const,
        name: p.name,
        ...(p.material ? { detail: p.material } : {}),
        aliases: [p.id],
        box: { min, max },
        p: [(min[0] + max[0]) / 2, height / 2, (min[2] + max[2]) / 2] as Vec3,
      },
    ];
  });
}

/** "km 12.4", "chainage 12.4", "ch 12+400", "12+400" to kilometres; null when it is none. */
export function chainageKm(query: string): number | null {
  const plus = /\b(\d+)\+(\d{1,3}(?:\.\d+)?)\b/.exec(query);
  if (plus) return Number(plus[1]) + Number(plus[2]) / 1000;
  const km =
    /\b(?:km|chainage|ch)\s*(\d+(?:\.\d+)?)/i.exec(query) ?? /(\d+(?:\.\d+)?)\s*km\b/i.exec(query);
  return km ? Number(km[1]) : null;
}

/** The centreline point at a chainage asked for, as a place. */
export function chainagePlace(road: RoadModel, query: string): Place[] {
  const km = chainageKm(query);
  if (km === null) return [];
  const p = pointAtKm(road, km);
  return [
    {
      id: `chainage:${km.toFixed(3)}`,
      kind: 'chainage',
      name: `km ${km.toFixed(3).replace(/\.?0+$/, '')}`,
      detail: 'road centreline',
      aliases: [
        `${String(Math.floor(km))}+${String(Math.round((km % 1) * 1000)).padStart(3, '0')}`,
      ],
      p,
      box: { min: [p[0] - 40, p[1], p[2] - 40], max: [p[0] + 40, p[1] + 5, p[2] + 40] },
    },
  ];
}

let registered = false;

export function registerAgentPlaces(): void {
  if (registered) return;
  registered = true;
  registerPlaceSource(() => pilePlaces(volumetric.getState().piles));
  registerPlaceSource((query) => {
    const road = roadStore.getState().road;
    return road && query ? chainagePlace(road, query) : [];
  });
}
