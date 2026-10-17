/**
 * Sector grouping, eligibility and orphans (spec D3, D7, D9).
 *
 * - Grouping (D7): units whose true azimuths sit within 30 degrees of a neighbour (round the
 *   circle, so 359 and 1 meet) form one sector. The rule is the one in the modelling package's
 *   telecom assembler (`clusterBearings`), ported here rather than imported. Sectors are named
 *   S1, S2, ... in order of their mean bearing clockwise from north. Grouping only proposes: a
 *   person can regroup and rename, and it never changes the physics.
 * - Eligibility (D3): by default only accepted panels take part. Short units and draft units can be
 *   included by hand (a draft marks the run unreviewed); dishes and other units never take part.
 *   Units without an azimuth or a grid convergence (no CRS, D2) cannot take part.
 * - Orphans (D9): RF settings or sector members for a unit that detection removed, rejected or
 *   marked `notFoundInLatest`. They are flagged, never deleted; Remove and Reassign are explicit.
 *
 * `RfUnit` is the subset of the antenna-detection unit (`telecom/antennas.json`) that RF reads,
 * typed structurally so this package never imports the antenna-detection schema.
 */

import type { RfSector, RfSectorsFile } from '@aio/schema';
import { normalizeDeg360, trueAzimuthDeg } from './geometry';

/** Bearings further apart than this start a new sector. */
export const SECTOR_GAP_DEG = 30;

export type RfUnitKind = 'panel' | 'short' | 'dish' | 'other';
export type RfUnitStatus = 'draft' | 'accepted' | 'rejected';

export interface RfUnit {
  id: string;
  kind: RfUnitKind;
  status: RfUnitStatus;
  notFoundInLatest?: boolean | undefined;
  azimuthGridDeg?: { value: number } | undefined;
  /** True azimuth = grid azimuth + convergence; null without a CRS. */
  convergenceDeg: number | null;
  user?: { active?: boolean | undefined } | undefined;
}

export type EligibilityReason =
  | 'rejected'
  | 'not-found'
  | 'inactive'
  | 'dish'
  | 'other'
  | 'no-azimuth'
  | 'no-crs'
  | 'short'
  | 'draft';

export interface Eligibility {
  eligible: boolean;
  /** Why the unit does not take part, or null when it does. Codes; the UI owns the words. */
  reason: EligibilityReason | null;
  /** True when a person can include it by hand (short or draft units). */
  canInclude: boolean;
  /** True when it takes part with draft (unreviewed) geometry (D3). */
  unreviewed: boolean;
}

export interface EligibilityOptions {
  /** The person included this unit by hand. */
  included?: boolean;
  /** The RF active flag from `rf/sectors.json` (D5). */
  rfActive?: boolean;
}

function no(reason: EligibilityReason, canInclude = false): Eligibility {
  return { eligible: false, reason, canInclude, unreviewed: false };
}

export function unitEligibility(u: RfUnit, o: EligibilityOptions = {}): Eligibility {
  if (u.status === 'rejected') return no('rejected');
  if (u.notFoundInLatest) return no('not-found');
  if (o.rfActive === false || u.user?.active === false) return no('inactive');
  if (u.kind === 'dish' || u.kind === 'other') return no(u.kind);
  if (!u.azimuthGridDeg || !Number.isFinite(u.azimuthGridDeg.value)) return no('no-azimuth');
  if (u.convergenceDeg === null || !Number.isFinite(u.convergenceDeg)) return no('no-crs');
  const byHand = o.included === true;
  if (u.kind === 'short' && !byHand) return no('short', true);
  if (u.status === 'draft' && !byHand) return no('draft', true);
  return { eligible: true, reason: null, canInclude: true, unreviewed: u.status === 'draft' };
}

/** Mean of compass bearings on the circle, [0, 360). */
export function meanBearingDeg(azs: readonly number[]): number {
  let s = 0;
  let c = 0;
  for (const a of azs) {
    s += Math.sin((a * Math.PI) / 180);
    c += Math.cos((a * Math.PI) / 180);
  }
  const m = normalizeDeg360((Math.atan2(s, c) * 180) / Math.PI);
  // A mean a hair below 360 is north.
  return m > 360 - 1e-9 ? 0 : m;
}

export interface BearingItem {
  id: string;
  trueAzimuthDeg: number;
}

export interface ProposedSector extends RfSector {
  meanBearingDeg: number;
}

/**
 * Groups by bearing with single linkage round the circle: neighbours (in bearing order) at most
 * `gapDeg` apart share a sector. Sectors come back in order of their mean bearing from north.
 */
export function groupSectors(
  items: readonly BearingItem[],
  gapDeg = SECTOR_GAP_DEG,
): ProposedSector[] {
  if (!items.length) return [];
  const order = items
    .map((it) => ({ id: it.id, a: normalizeDeg360(it.trueAzimuthDeg) }))
    .sort((p, q) => p.a - q.a || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const n = order.length;
  const gapAfter = order.map((p, k) => normalizeDeg360((order[(k + 1) % n]?.a ?? p.a) - p.a));
  if (n === 1) gapAfter[0] = 360;
  let widest = 0;
  gapAfter.forEach((g, k) => {
    if (g > (gapAfter[widest] ?? 0)) widest = k;
  });
  const groups: (typeof order)[] = [];
  if ((gapAfter[widest] ?? 0) <= gapDeg) groups.push(order);
  else {
    // Start just after the widest gap so no group straddles it.
    for (let k = 1; k <= n; k++) {
      const at = (widest + k) % n;
      const p = order[at];
      if (!p) continue;
      const last = groups.at(-1);
      if (last && k > 1 && (gapAfter[(at - 1 + n) % n] ?? 360) <= gapDeg) last.push(p);
      else groups.push([p]);
    }
  }
  return groups
    .map((g) => ({ ids: g.map((p) => p.id), mean: meanBearingDeg(g.map((p) => p.a)) }))
    .sort((p, q) => p.mean - q.mean)
    .map((g, i) => ({
      id: `sec-s${String(i + 1)}`,
      name: `S${String(i + 1)}`,
      antennaIds: g.ids,
      meanBearingDeg: g.mean,
    }));
}

/** True azimuth of a unit, or null when it has no azimuth or no CRS. */
export function unitTrueAzimuthDeg(u: RfUnit): number | null {
  if (!u.azimuthGridDeg || u.convergenceDeg === null) return null;
  return trueAzimuthDeg(u.azimuthGridDeg.value, u.convergenceDeg);
}

/** The automatic proposal (D7): eligible units (plus any included by hand) grouped by bearing. */
export function proposeSectors(
  units: readonly RfUnit[],
  includedByHand: ReadonlySet<string> = new Set(),
  gapDeg = SECTOR_GAP_DEG,
): ProposedSector[] {
  const items: BearingItem[] = [];
  for (const u of units) {
    if (!unitEligibility(u, { included: includedByHand.has(u.id) }).eligible) continue;
    const az = unitTrueAzimuthDeg(u);
    if (az !== null) items.push({ id: u.id, trueAzimuthDeg: az });
  }
  return groupSectors(items, gapDeg);
}

export type OrphanReason = 'removed' | 'rejected' | 'not-found';

export interface Orphan {
  antennaId: string;
  reason: OrphanReason;
  /** The sector it still belongs to, if any. */
  sectorId: string | null;
}

type SectorsPart = Pick<RfSectorsFile, 'sectors' | 'antennas'>;

/** RF entries (settings or sector members) for units no longer found, in file order. */
export function findOrphans(file: SectorsPart, units: readonly RfUnit[]): Orphan[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const sectorOf = new Map<string, string>();
  for (const s of file.sectors) for (const id of s.antennaIds) sectorOf.set(id, s.id);
  const ids = [
    ...new Set([
      ...file.antennas.map((a) => a.antennaId),
      ...file.sectors.flatMap((s) => s.antennaIds),
    ]),
  ];
  const out: Orphan[] = [];
  for (const id of ids) {
    const u = byId.get(id);
    const reason: OrphanReason | null = !u
      ? 'removed'
      : u.status === 'rejected'
        ? 'rejected'
        : u.notFoundInLatest
          ? 'not-found'
          : null;
    if (reason) out.push({ antennaId: id, reason, sectorId: sectorOf.get(id) ?? null });
  }
  return out;
}

/**
 * Removes a unit's RF settings and sector membership (the person's Remove). A sector the removal
 * leaves empty is dropped with it.
 */
export function removeOrphan<T extends SectorsPart>(file: T, antennaId: string): T {
  return {
    ...file,
    antennas: file.antennas.filter((a) => a.antennaId !== antennaId),
    sectors: file.sectors
      .filter((s) => !(s.antennaIds.length === 1 && s.antennaIds[0] === antennaId))
      .map((s) => ({
        ...s,
        antennaIds: s.antennaIds.filter((id) => id !== antennaId),
      })),
  };
}

/**
 * Moves an orphan's RF settings and sector place to another unit (the person's Reassign). Refuses
 * when the target already has RF settings, so nothing is overwritten silently.
 */
export function reassignOrphan<T extends SectorsPart>(file: T, fromId: string, toId: string): T {
  if (fromId === toId) return file;
  if (file.antennas.some((a) => a.antennaId === toId))
    throw new Error(`${toId} already has RF settings; remove them first or pick another unit`);
  return {
    ...file,
    antennas: file.antennas.map((a) => (a.antennaId === fromId ? { ...a, antennaId: toId } : a)),
    sectors: file.sectors.map((s) => ({
      ...s,
      antennaIds: s.antennaIds.filter((id) => id !== toId).map((id) => (id === fromId ? toId : id)),
    })),
  };
}
