/**
 * The RF store's pure side: height above ground, who takes part in a run, why a run is refused.
 * No bridge and no state, so it runs in a unit test. It mirrors the job (`inputs.py` `resolve`
 * and `exclusion`) so the tab says before a start what the job would say after it.
 *
 * Reasons are codes; the UI (T9) owns the words.
 */
import {
  findOrphans,
  getEntry,
  proposeSectors,
  unitEligibility,
  type EligibilityReason,
  type Orphan,
  type ProposedSector,
  type RfUnit,
} from '@aio/rf';
import {
  compareVersions,
  RF_COVERAGE_MIN_PACK,
  type AntennasFile,
  type AntennaUnit,
  type PipelinePackStatus,
  type RfAntennaSettings,
  type RfCatalogueEntry,
  type RfSectorsFile,
} from '@aio/schema';
import { resolveCarrier, type DefaultWarning, type ResolvedCarrier } from './rfDefaults';

// ---------------------------------------------------------------- height

/** How the height above ground is known: measured from the detected tower base, estimated from the DSM, or typed. */
export type HeightBasis = 'measured' | 'estimated' | 'user';

export interface UnitHeight {
  /** Metres above the tower-base ground; null when it cannot be worked out. */
  heightM: number | null;
  basis: HeightBasis | null;
  /** Ground height (project vertical datum) used, when there is one. */
  groundZ: number | null;
  /** Why heightM is null or not usable. */
  issue: 'no-ground' | 'not-above-ground' | null;
}

/**
 * The job's DSM ground at a tower base (project CRS, vertical datum of the DSM); null when no DSM
 * covers it. Python (`ground_from_dsm`) is the source of truth: the first project DSM (COG) that
 * covers the point, the `DSM_GROUND_PERCENTILE` (5th) percentile of its values within
 * `DSM_GROUND_RADIUS_M` (30 m) of the base (both exported by `@aio/rf`). Never terrain, and never
 * the DSM at the single point (that is the tower top, a height near 0).
 */
export type DsmGroundAt = (east: number, north: number) => number | null;

/**
 * Height above ground (D4): the person's value wins (basis user); else the box centre minus the
 * detected tower-base ground, `run.groundZ` (measured); else the DSM ground near the base
 * (estimated, the job's DSM ground); else unknown. A height of 0 or less is not usable (the job leaves the unit out).
 */
export function unitHeight(
  unit: Pick<AntennaUnit, 'box'>,
  groundZ: number | undefined,
  overrideM: number | undefined,
  dsmGroundAt: DsmGroundAt | null,
): UnitHeight {
  const [east, north, z] = unit.box.centre;
  const checked = (h: number, basis: HeightBasis, ground: number | null): UnitHeight =>
    h > 0
      ? { heightM: h, basis, groundZ: ground, issue: null }
      : { heightM: null, basis, groundZ: ground, issue: 'not-above-ground' };
  if (overrideM !== undefined) return checked(overrideM, 'user', groundZ ?? null);
  if (groundZ !== undefined) return checked(z - groundZ, 'measured', groundZ);
  const ground = dsmGroundAt?.(east, north) ?? null;
  if (ground !== null && Number.isFinite(ground)) return checked(z - ground, 'estimated', ground);
  return { heightM: null, basis: null, groundZ: null, issue: 'no-ground' };
}

// ---------------------------------------------------------------- units

export type ExclusionCode =
  | EligibilityReason
  | 'removed'
  | 'not-in-sector'
  | 'no-settings'
  | 'no-equipment'
  | 'no-equipment-entry'
  | 'no-carrier'
  | 'no-height'
  | 'not-above-ground';

export interface RfUnitRow {
  id: string;
  name: string;
  kind: AntennaUnit['kind'];
  status: AntennaUnit['status'];
  sectorId: string | null;
  settings: RfAntennaSettings | null;
  height: UnitHeight;
  /** Whether the person may include it by hand (short or draft). */
  canInclude: boolean;
  /** Why the unit does not take part in a run; null when it does. */
  excluded: ExclusionCode | null;
  /** Takes part with draft (unreviewed) geometry. */
  unreviewed: boolean;
  /** Carriers that can be computed, with the defaults the job applies. */
  carriers: ResolvedCarrier[];
  /** Defaults applied or carriers left out, in code form. */
  warnings: DefaultWarning[];
}

export interface DeriveInput {
  antennas: AntennasFile | null;
  sectors: RfSectorsFile;
  catalogue: readonly RfCatalogueEntry[];
  includeUnreviewed: boolean;
  dsmGroundAt: DsmGroundAt | null;
}

function rfUnit(u: AntennaUnit): RfUnit {
  return {
    id: u.id,
    kind: u.kind,
    status: u.status,
    notFoundInLatest: u.notFoundInLatest,
    azimuthGridDeg: u.azimuthGridDeg,
    convergenceDeg: u.convergenceDeg,
    user: u.user,
  };
}

/**
 * A unit a person put in a sector counts as included by hand for a short unit (like the job); a
 * draft needs the run to include unreviewed units.
 */
export function includedByHand(
  u: Pick<AntennaUnit, 'kind' | 'status'>,
  inSector: boolean,
  includeUnreviewed: boolean,
): boolean {
  return (u.kind !== 'short' || inSector) && (u.status !== 'draft' || includeUnreviewed);
}

export function deriveRows(i: DeriveInput): RfUnitRow[] {
  if (!i.antennas) return [];
  const groundZ = i.antennas.run.groundZ;
  const sectorOf = new Map<string, string>();
  for (const s of i.sectors.sectors) for (const id of s.antennaIds) sectorOf.set(id, s.id);
  const settingsOf = new Map(i.sectors.antennas.map((a) => [a.antennaId, a]));
  return i.antennas.units.map((u): RfUnitRow => {
    const sectorId = sectorOf.get(u.id) ?? null;
    const settings = settingsOf.get(u.id) ?? null;
    const el = unitEligibility(rfUnit(u), {
      included: includedByHand(u, sectorId !== null, i.includeUnreviewed),
      rfActive: settings?.active ?? true,
    });
    const height = unitHeight(u, groundZ, settings?.heightOverrideM, i.dsmGroundAt);
    const carriers: ResolvedCarrier[] = [];
    const warnings: DefaultWarning[] = [];
    if (settings?.equipment)
      for (const c of settings.carriers) {
        const r = resolveCarrier(settings, c, i.catalogue);
        warnings.push(...r.warnings);
        if (r.carrier) carriers.push(r.carrier);
      }
    // The job's order (`exclusion`, then height, then equipment, then carriers).
    let excluded: ExclusionCode | null = el.reason;
    if (!excluded && sectorId === null) excluded = 'not-in-sector';
    else if (!excluded && !settings) excluded = 'no-settings';
    else if (!excluded && height.issue === 'no-ground') excluded = 'no-height';
    else if (!excluded && height.issue === 'not-above-ground') excluded = 'not-above-ground';
    else if (!excluded && !settings?.equipment) excluded = 'no-equipment';
    else if (!excluded && settings && entryMissing(settings, i.catalogue))
      excluded = 'no-equipment-entry';
    else if (!excluded && carriers.length === 0) excluded = 'no-carrier';
    return {
      id: u.id,
      name: u.name,
      kind: u.kind,
      status: u.status,
      sectorId,
      settings,
      height,
      canInclude: el.canInclude,
      excluded,
      unreviewed: el.unreviewed,
      carriers,
      warnings,
    };
  });
}

function entryMissing(s: RfAntennaSettings, catalogue: readonly RfCatalogueEntry[]): boolean {
  const eq = s.equipment;
  if (!eq) return false;
  const e = getEntry(catalogue, eq.kind === 'aau' ? eq.aau : eq.antenna);
  return e?.kind !== (eq.kind === 'aau' ? 'aau' : 'antenna');
}

// ---------------------------------------------------------------- run check

export type RefusalCode =
  | 'read-only'
  | 'running'
  | 'pack-missing'
  | 'pack-too-old'
  | 'pack-unknown'
  | 'no-antennas'
  | 'no-sectors'
  | 'no-crs'
  | 'no-accepted-panels'
  | 'no-band'
  | 'no-height'
  | 'no-equipment';

export interface RunCheck {
  /** Empty when a run can start. */
  refusals: RefusalCode[];
  /** Units that would take part. */
  participants: string[];
  /** Sector members left out, with the code of why. */
  excluded: { antennaId: string; reason: ExclusionCode }[];
  /** A draft unit takes part, so the run is marked unreviewed (D3). */
  unreviewed: boolean;
}

/**
 * Pack check (R9). Not asked yet, or an installed pack with no version, is `pack-unknown`: the
 * tab must not start a run it cannot vouch for. A pack from the environment (`dev`) is trusted.
 * Main checks the minimum again at `jobs:start` (`rfPack.ts`).
 */
export function packRefusal(
  status: Pick<PipelinePackStatus, 'state' | 'version'> | null,
): 'pack-missing' | 'pack-too-old' | 'pack-unknown' | null {
  if (!status) return 'pack-unknown';
  if (status.state === 'dev') return null;
  if (status.state === 'missing' || status.state === 'incompatible') return 'pack-missing';
  if (status.state === 'too-old') return 'pack-too-old';
  if (status.version === undefined) return 'pack-unknown';
  return compareVersions(status.version, RF_COVERAGE_MIN_PACK) < 0 ? 'pack-too-old' : null;
}

export function checkRun(
  rows: readonly RfUnitRow[],
  i: {
    /** Every antenna id listed in a sector, including ones the inventory no longer has. */
    sectorMembers: readonly string[];
    hasAntennas: boolean;
    readOnly: boolean;
    running: boolean;
    pack: Pick<PipelinePackStatus, 'state' | 'version'> | null;
  },
): RunCheck {
  const known = new Set(rows.map((r) => r.id));
  const members = rows.filter((r) => r.sectorId !== null);
  const participants = members.filter((r) => r.excluded === null);
  // Orphan members count as candidates, like the job (they stop an "all without CRS" refusal).
  const gone = i.sectorMembers.filter((id) => !known.has(id));
  const excluded: { antennaId: string; reason: ExclusionCode }[] = [
    ...members.flatMap((r) =>
      r.excluded === null ? [] : [{ antennaId: r.id, reason: r.excluded }],
    ),
    ...gone.map((antennaId) => ({ antennaId, reason: 'removed' as const })),
  ];
  const refusals: RefusalCode[] = [];
  if (i.readOnly) refusals.push('read-only');
  if (i.running) refusals.push('running');
  const pack = packRefusal(i.pack);
  if (pack) refusals.push(pack);
  if (!i.hasAntennas) refusals.push('no-antennas');
  else if (members.length + gone.length === 0) refusals.push('no-sectors');
  else if (participants.length === 0) {
    // The job's own order: every candidate without a CRS is the CRS message, else what is left.
    const reasons = new Set(excluded.map((e) => e.reason));
    if (reasons.size === 1 && reasons.has('no-crs')) refusals.push('no-crs');
    else if (reasons.has('no-height') || reasons.has('not-above-ground'))
      refusals.push('no-height');
    else if (reasons.has('no-equipment') || reasons.has('no-equipment-entry'))
      refusals.push('no-equipment');
    else if (reasons.has('no-carrier') || reasons.has('no-settings')) refusals.push('no-band');
    else refusals.push('no-accepted-panels');
  }
  return {
    refusals,
    participants: participants.map((r) => r.id),
    excluded,
    unreviewed: participants.some((r) => r.unreviewed),
  };
}

// ---------------------------------------------------------------- proposal and orphans

/**
 * The automatic proposal (D7): accepted panels grouped by bearing, plus draft panels when the run
 * includes unreviewed units. Short units are never proposed; a person adds them by hand.
 */
export function proposalFor(
  antennas: AntennasFile | null,
  includeUnreviewed: boolean,
): ProposedSector[] {
  if (!antennas) return [];
  const byHand = new Set(
    antennas.units
      .filter((u) => u.kind === 'panel' && u.status === 'draft' && includeUnreviewed)
      .map((u) => u.id),
  );
  return proposeSectors(antennas.units.map(rfUnit), byHand);
}

export function orphansFor(antennas: AntennasFile | null, sectors: RfSectorsFile): Orphan[] {
  // Without an inventory every entry would look removed; the inventory itself is the problem then.
  if (!antennas) return [];
  return findOrphans(sectors, antennas.units.map(rfUnit));
}
