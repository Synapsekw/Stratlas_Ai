/**
 * Auto-plan sector planning (C1). With no sectors yet it proposes by bearing. Otherwise it keeps
 * every sector the person made (ids, names, members) and only places units that are in none:
 * into the sector with the nearest bearing within `SECTOR_GAP_DEG`, else into a new sector.
 * Only accepted panels with a bearing take part; the rest come back as `leftOut`.
 */
import {
  meanBearingDeg,
  proposeSectors,
  SECTOR_GAP_DEG,
  unitEligibility,
  unitTrueAzimuthDeg,
  type RfUnit,
} from '@aio/rf';
import type { AntennaUnit, RfSector } from '@aio/schema';
import { rfUnit } from '../rfModel';

export interface LeftOut {
  unitId: string;
  reason: 'draft' | 'not-panel' | 'no-azimuth' | 'inactive' | 'rejected';
}

export interface SectorPlan {
  sectors: RfSector[];
  leftOut: LeftOut[];
  /** True when there were no sectors and the result is the bearing proposal. */
  regrouped: boolean;
}

function leftOutReason(u: RfUnit): LeftOut['reason'] | null {
  const e = unitEligibility(u);
  if (e.eligible) return null;
  switch (e.reason) {
    case 'draft':
      return 'draft';
    case 'rejected':
      return 'rejected';
    case 'inactive':
      return 'inactive';
    case 'short':
    case 'dish':
    case 'other':
      return 'not-panel';
    case 'no-azimuth':
    case 'no-crs':
      return 'no-azimuth';
    default:
      // not-found: detection dropped it, so it is not a candidate and not worth listing.
      return null;
  }
}

/** Smallest angle between two bearings, degrees in [0, 180]. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function planSectors(
  units: readonly AntennaUnit[],
  current: readonly RfSector[],
): SectorPlan {
  const rf = units.map(rfUnit);
  const leftOut: LeftOut[] = [];
  const eligible: { id: string; az: number }[] = [];
  for (const u of rf) {
    const reason = leftOutReason(u);
    if (reason) {
      leftOut.push({ unitId: u.id, reason });
      continue;
    }
    if (!unitEligibility(u).eligible) continue;
    const az = unitTrueAzimuthDeg(u);
    if (az !== null) eligible.push({ id: u.id, az });
  }

  if (current.length === 0) {
    const proposed = proposeSectors(rf.filter((u) => eligible.some((e) => e.id === u.id)));
    return {
      sectors: proposed.map((s) => ({ id: s.id, name: s.name, antennaIds: [...s.antennaIds] })),
      leftOut,
      regrouped: true,
    };
  }

  const azOf = new Map<string, number>();
  for (const u of rf) {
    const az = unitTrueAzimuthDeg(u);
    if (az !== null) azOf.set(u.id, az);
  }
  const sectors: RfSector[] = current.map((s) => ({ ...s, antennaIds: [...s.antennaIds] }));
  const bearingOf = (s: RfSector): number | null => {
    const azs = s.antennaIds.flatMap((id) => azOf.get(id) ?? []);
    return azs.length ? meanBearingDeg(azs) : null;
  };
  const placed = new Set(sectors.flatMap((s) => s.antennaIds));
  const nextFree = (): number => {
    const ids = new Set(sectors.map((s) => s.id));
    const names = new Set(sectors.map((s) => s.name));
    let n = 1;
    while (ids.has(`sec-s${String(n)}`) || names.has(`S${String(n)}`)) n++;
    return n;
  };

  for (const e of eligible) {
    if (placed.has(e.id)) continue;
    let best: RfSector | null = null;
    let bestD = Infinity;
    for (const s of sectors) {
      const b = bearingOf(s);
      if (b === null) continue;
      const d = angleBetween(b, e.az);
      if (d <= SECTOR_GAP_DEG && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    if (best) best.antennaIds.push(e.id);
    else {
      const n = nextFree();
      sectors.push({ id: `sec-s${String(n)}`, name: `S${String(n)}`, antennaIds: [e.id] });
    }
    placed.add(e.id);
  }
  return { sectors, leftOut, regrouped: false };
}
