/**
 * Auto-plan proposal: sectors (C1) plus one or more picks per antenna (AI, rules or a cell export),
 * shown in the review dialog and then written to `rf/sectors.json` by `applyToFile`.
 *
 * - `validateAiPick` checks an AI reply row against the catalogue and the band table; a row it
 *   cannot use falls back to the rules pick at low confidence and says why.
 * - Re-plan keeps every field group whose origin is `user` or `export` (C3): the equipment, the
 *   e-tilt, and each existing carrier. A missing origin counts as `user`. Kept carriers are
 *   written first, unchanged; new carriers must fit the final equipment (R11).
 * - Sectors are never regrouped here and units are never moved; a cell export may only rename a
 *   sector. Settings of units outside the plan (orphans, left-out units) are left untouched.
 */
import { bandOfName } from '@aio/rf';
import {
  originOf,
  type AntennaUnit,
  type RfAntennaSettings,
  type RfCarrier,
  type RfCatalogueEntry,
  type RfEquipment,
  type RfOrigin,
  type RfSector,
  type RfSectorsFile,
} from '@aio/schema';
import { AUTOPLAN_AAU, AUTOPLAN_PANEL } from '../rfDefaults';
import { bandwidthChoices, clampSettingsEtilt, withEquipment } from '../rfFields';
import { entryCoversBand } from './bandFit';
import { rulesPick } from './rules';
import { planSectors, type LeftOut } from './sectors';
import type { PlanPick } from './types';

/** One row of the AI reply, as the main-process IPC returns it (no geometry fields). */
export interface AiPickRaw {
  unitId: string;
  entryId: string;
  radioId?: string;
  band: string;
  tech: 'lte' | 'nr';
  bandwidthMhz: number;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

/** A sector a cell export renames (it never moves units). */
interface Rename {
  sectorId: string;
  name: string;
}

export interface ProposalRow {
  unitId: string;
  sectorId: string;
  /**
   * The carriers this plan newly writes, each with its final band, confidence and reason: at most
   * one from the AI or the rules, possibly several from a cell export. Empty when nothing is added.
   */
  picks: PlanPick[];
  /** Groups the person (or a cell export) set, which Re-plan keeps; `carriers` is per existing index. */
  kept: { equipment: boolean; etiltDeg: boolean; carriers: boolean[] };
  /** The pick whose equipment is written; absent when the current equipment stays. */
  equipment?: PlanPick;
  /** The e-tilt written (clamped to the final equipment), from a cell export; absent when none. */
  etilt?: { deg: number; origin: RfOrigin };
  /** Why the row differs from its picks, e.g. that the person's equipment was kept. */
  note?: string;
}

export interface Proposal {
  sectors: RfSector[];
  regrouped: boolean;
  rows: ProposalRow[];
  leftOut: LeftOut[];
  renames: Rename[];
  /** Cell export rows (indexes) that matched no antenna. */
  unmatchedRows: number[];
}

/** Why the AI row cannot be used, or null when it fits the catalogue and the band table. */
function aiPickProblem(
  raw: AiPickRaw,
  unit: AntennaUnit,
  catalogue: readonly RfCatalogueEntry[],
): string | null {
  if (raw.unitId !== unit.id) return `it names unit ${raw.unitId}`;
  const entry = catalogue.find((e) => e.id === raw.entryId);
  if (!entry) return `${raw.entryId} is not in the catalogue`;
  if (entry.kind === 'radio') return `${raw.entryId} is a radio, not an antenna or AAU`;
  const band = bandOfName(raw.band);
  if (!band) return `${raw.band} is not a known band`;
  if (raw.tech === 'nr' ? band.nrBand === null : band.lteBands.length === 0)
    return `${raw.band} has no ${raw.tech === 'nr' ? 'NR' : 'LTE'} layer`;
  if (!bandwidthChoices(raw.tech, raw.band).includes(raw.bandwidthMhz))
    return `${String(raw.bandwidthMhz)} MHz is not a ${raw.band} bandwidth`;
  if (!entryCoversBand(entry, raw.band)) return `${entry.id} cannot do ${raw.band}`;
  if (entry.kind === 'aau') {
    return raw.radioId === undefined ? null : `${entry.id} is an AAU and has its radio built in`;
  }
  if (raw.radioId === undefined) return null;
  const radio = catalogue.find((e) => e.id === raw.radioId);
  if (!radio) return `${raw.radioId} is not in the catalogue`;
  if (radio.kind !== 'radio') return `${raw.radioId} is not a radio`;
  if (!entryCoversBand(radio, raw.band)) return `${radio.id} cannot do ${raw.band}`;
  if (raw.bandwidthMhz > radio.maxBandwidthMhz)
    return `${radio.id} carries at most ${String(radio.maxBandwidthMhz)} MHz`;
  return null;
}

/** The AI row as a pick, or the rules pick at low confidence when the row cannot be used. */
export function validateAiPick(
  raw: AiPickRaw,
  unit: AntennaUnit,
  catalogue: readonly RfCatalogueEntry[],
): PlanPick {
  const problem = aiPickProblem(raw, unit, catalogue);
  if (problem !== null) {
    const rules = rulesPick(unit, catalogue);
    return {
      ...rules,
      confidence: 'low',
      reason: `AI pick not usable: ${problem}. ${rules.reason}`,
    };
  }
  const { band, tech, bandwidthMhz, radioId } = raw;
  const entry = catalogue.find((e) => e.id === raw.entryId);
  return {
    equipment:
      entry?.kind === 'aau'
        ? { kind: 'aau', aau: raw.entryId }
        : { kind: 'separate', antenna: raw.entryId, ...(radioId ? { radio: radioId } : {}) },
    carrier: { band, tech, bandwidthMhz, ...(radioId ? { radioUnit: radioId } : {}) },
    by: 'ai',
    confidence: raw.confidence,
    reason: raw.reason,
  };
}

const keeps = (o: RfOrigin | undefined): boolean => {
  const by = originOf(o);
  return by === 'user' || by === 'export';
};

const originFrom = (p: PlanPick): RfOrigin => ({ by: p.by, confidence: p.confidence });
const low = (p: PlanPick, reason: string = p.reason): PlanPick => ({
  ...p,
  confidence: 'low',
  reason,
});

/** One carrier per technology and band row: `B3` and `b3-n3` on LTE are the same carrier. */
const bandKey = (c: Pick<RfCarrier, 'tech' | 'band'>): string =>
  `${c.tech}:${bandOfName(c.band)?.id ?? c.band.toLowerCase()}`;

const findEntry = (catalogue: readonly RfCatalogueEntry[], id: string) =>
  catalogue.find((e) => e.id === id);

/**
 * True when the equipment (antenna or AAU, and the radio) can carry the band. An entry the
 * catalogue lacks cannot be checked, so it does not count against the band; no equipment does.
 */
function equipmentCovers(
  eq: RfEquipment | undefined,
  band: string,
  catalogue: readonly RfCatalogueEntry[],
): boolean {
  if (!eq || !bandOfName(band)) return false;
  const main = findEntry(catalogue, eq.kind === 'aau' ? eq.aau : eq.antenna);
  if (main && !entryCoversBand(main, band)) return false;
  if (eq.kind === 'separate' && eq.radio !== undefined) {
    const radio = findEntry(catalogue, eq.radio);
    if (radio && !entryCoversBand(radio, band)) return false;
  }
  return true;
}

/** The equipment's model names for a reason line. */
function describe(eq: RfEquipment | undefined, catalogue: readonly RfCatalogueEntry[]): string {
  if (!eq) return 'no equipment';
  const name = (id: string) => findEntry(catalogue, id)?.model ?? id;
  if (eq.kind === 'aau') return name(eq.aau);
  return eq.radio === undefined ? name(eq.antenna) : `${name(eq.antenna)} + ${name(eq.radio)}`;
}

/** The carrier made to fit the equipment: no radio or port on an AAU, else the unit's radio and ports. */
function fitCarrier(
  c: PlanPick['carrier'],
  eq: RfEquipment | undefined,
  catalogue: readonly RfCatalogueEntry[],
): PlanPick['carrier'] {
  const n = { ...c };
  if (eq?.kind === 'aau') {
    delete n.radioUnit;
    delete n.port;
  } else if (eq?.kind === 'separate') {
    if (eq.radio === undefined) delete n.radioUnit;
    else n.radioUnit = eq.radio;
    const ant = findEntry(catalogue, eq.antenna);
    if (n.port !== undefined && ant?.kind === 'antenna' && !ant.ports.some((p) => p.id === n.port))
      delete n.port;
  }
  return n;
}

/** A carrier the equipment can do when a pick's band does not fit: the rules' n78, else B3. */
function substituteCarrier(
  eq: RfEquipment | undefined,
  catalogue: readonly RfCatalogueEntry[],
): PlanPick['carrier'] | null {
  for (const r of [AUTOPLAN_AAU, AUTOPLAN_PANEL]) {
    if (equipmentCovers(eq, r.band, catalogue))
      return { tech: r.tech, band: r.band, bandwidthMhz: r.bandwidthMhz };
  }
  return null;
}

export const NO_CARRIER_FITS = 'No carrier fits this equipment, set the band by hand';

/** What the plan writes for one unit, resolved so the row shows exactly that (R11). */
function planRow(
  unitId: string,
  sectorId: string,
  s: RfAntennaSettings | undefined,
  given: readonly PlanPick[],
  catalogue: readonly RfCatalogueEntry[],
): ProposalRow {
  const kept: ProposalRow['kept'] = {
    equipment: s?.equipment !== undefined && keeps(s.origins?.equipment),
    etiltDeg: s?.etiltDeg !== undefined && keeps(s.origins?.etiltDeg),
    carriers: (s?.carriers ?? []).map((c) => keeps(c.origin)),
  };
  const keptCarriers = (s?.carriers ?? []).filter((_, k) => kept.carriers[k] === true);
  const notes: string[] = [];
  const [head, ...rest] = given;
  if (!head) throw new Error('planRow needs at least one pick');

  // A radio the catalogue lacks is left out, and the row says so (R11 h).
  let first = head;
  const eqIn = head.equipment;
  if (eqIn.kind === 'separate' && eqIn.radio !== undefined && !findEntry(catalogue, eqIn.radio)) {
    first = low(
      { ...head, equipment: { kind: 'separate', antenna: eqIn.antenna } },
      `Radio ${eqIn.radio} is not in the catalogue, so no radio is set. ${head.reason}`,
    );
  }

  // Equipment: the pick's, unless the person's kept carriers would not fit it (R11 d).
  let equipment: PlanPick | undefined;
  let finalEq = s?.equipment;
  if (!kept.equipment) {
    const misfit = keptCarriers.find((c) => !equipmentCovers(first.equipment, c.band, catalogue));
    if (misfit)
      notes.push(
        `Kept your equipment: your ${misfit.band} carrier doesn't fit ${describe(first.equipment, catalogue)}`,
      );
    else {
      equipment = first;
      finalEq = first.equipment;
    }
  }

  // Carriers: the AI and the rules add one only when no carrier is kept (b); an export adds each
  // band the kept carriers do not have yet, once (c).
  const present = new Set(keptCarriers.map(bandKey));
  let wanted: PlanPick[];
  if (head.by === 'export') {
    wanted = [first, ...rest].filter((p) => {
      const k = bandKey(p.carrier);
      if (present.has(k)) return false;
      present.add(k);
      return true;
    });
  } else wanted = keptCarriers.length > 0 ? [] : [first];

  // Each new carrier must fit the final equipment, else the equipment's own carrier (e, f).
  const picks: PlanPick[] = [];
  for (const p of wanted) {
    const band = p.carrier.band;
    if (equipmentCovers(finalEq, band, catalogue)) {
      const carrier = fitCarrier(p.carrier, finalEq, catalogue);
      picks.push(
        p.by === 'export' && !equipmentCovers(p.equipment, band, catalogue)
          ? low(
              { ...p, carrier },
              `${band} doesn't fit ${describe(p.equipment, catalogue)} from the export. ${p.reason}`,
            )
          : { ...p, carrier },
      );
      continue;
    }
    const sub = substituteCarrier(finalEq, catalogue);
    if (!sub) {
      if (!notes.includes(NO_CARRIER_FITS)) notes.push(NO_CARRIER_FITS);
      continue;
    }
    const why = `${band} doesn't fit ${describe(finalEq, catalogue)}`;
    if (present.has(bandKey(sub))) {
      notes.push(`${why}, and it already has ${sub.band}`);
      continue;
    }
    present.add(bandKey(sub));
    picks.push(
      low({ ...p, carrier: fitCarrier(sub, finalEq, catalogue) }, `${why}, so ${sub.band}`),
    );
  }

  const row: ProposalRow = { unitId, sectorId, picks, kept };
  if (notes.length > 0) {
    row.note = notes.join('. ');
    row.picks = picks.map((p) => low(p));
    if (equipment) equipment = low(equipment);
  }
  if (equipment) row.equipment = equipment;
  if (!kept.etiltDeg && first.etiltDeg !== undefined) {
    const origin = originFrom(equipment ?? first);
    row.etilt = { deg: first.etiltDeg, origin };
    // Show the tilt as it will be written: clamped into the final equipment's range.
    const deg = applyRow(s, row, catalogue).etiltDeg;
    if (deg !== undefined) row.etilt = { deg, origin };
  }
  return row;
}

export function buildProposal(i: {
  units: readonly AntennaUnit[];
  file: RfSectorsFile;
  catalogue: readonly RfCatalogueEntry[];
  picks: ReadonlyMap<string, PlanPick[]>;
  renames?: readonly Rename[];
  unmatchedRows?: readonly number[];
}): Proposal {
  const plan = planSectors(i.units, i.file.sectors, i.file.antennas);
  const out = new Set(plan.leftOut.map((l) => l.unitId));
  const rows: ProposalRow[] = [];
  for (const sector of plan.sectors) {
    for (const id of sector.antennaIds) {
      const unit = i.units.find((u) => u.id === id);
      if (!unit || out.has(id)) continue;
      const given = i.picks.get(id);
      const s = i.file.antennas.find((a) => a.antennaId === id);
      const picks = given && given.length > 0 ? given : [rulesPick(unit, i.catalogue)];
      rows.push(planRow(id, sector.id, s, picks, i.catalogue));
    }
  }
  const sectorIds = new Set(plan.sectors.map((s) => s.id));
  return {
    sectors: plan.sectors,
    regrouped: plan.regrouped,
    rows,
    leftOut: plan.leftOut,
    renames: (i.renames ?? []).filter((r) => sectorIds.has(r.sectorId)).map((r) => ({ ...r })),
    unmatchedRows: [...(i.unmatchedRows ?? [])],
  };
}

/** The first `c<n>` id not in use. */
function freeCarrierId(used: Set<string>): string {
  let n = 1;
  while (used.has(`c${String(n)}`)) n++;
  const id = `c${String(n)}`;
  used.add(id);
  return id;
}

/**
 * The settings with the equipment, through the one equipment rule (`withEquipment`). An AAU
 * strips the radio and port from every carrier, kept ones included, since it has both built in.
 */
function applyEquipment(
  s: RfAntennaSettings,
  eq: RfEquipment,
  catalogue: readonly RfCatalogueEntry[],
): RfAntennaSettings {
  const main = findEntry(catalogue, eq.kind === 'aau' ? eq.aau : eq.antenna);
  let next = main ? withEquipment(s, main, catalogue) : null;
  if (next && eq.kind === 'separate') {
    const radio = eq.radio === undefined ? undefined : findEntry(catalogue, eq.radio);
    if (radio) next = withEquipment(next, radio, catalogue);
    else if (next.equipment?.kind === 'separate')
      next = { ...next, equipment: { kind: 'separate', antenna: eq.antenna } };
  }
  // An entry the catalogue lacks is written as given; the tab flags it.
  return next ?? clampSettingsEtilt({ ...s, equipment: eq }, catalogue);
}

/** One unit's settings with its row written: kept carriers first, unchanged, then the row's picks. */
function applyRow(
  current: RfAntennaSettings | undefined,
  row: ProposalRow,
  catalogue: readonly RfCatalogueEntry[],
): RfAntennaSettings {
  const base: RfAntennaSettings = current
    ? structuredClone(current)
    : { antennaId: row.unitId, active: true, carriers: [] };
  const keptCarriers = base.carriers.filter((_, k) => row.kept.carriers[k] === true);
  const used = new Set(keptCarriers.map((c) => c.id));
  const carriers: RfCarrier[] = [
    ...keptCarriers,
    ...row.picks.map((p) => ({
      ...p.carrier,
      id: freeCarrierId(used),
      feederLossDb: 0,
      origin: originFrom(p),
    })),
  ];
  let next: RfAntennaSettings = { ...base, carriers };
  if (row.equipment) {
    next = applyEquipment(next, row.equipment.equipment, catalogue);
    next = { ...next, origins: { ...next.origins, equipment: originFrom(row.equipment) } };
  }
  if (row.etilt) {
    next = clampSettingsEtilt(
      {
        ...next,
        etiltDeg: row.etilt.deg,
        origins: { ...next.origins, etiltDeg: row.etilt.origin },
      },
      catalogue,
    );
  }
  return next;
}

/**
 * The sectors file with the proposal written: its sectors and renames, and per row the kept
 * carriers, the row's new carriers, its equipment and e-tilt, each with its origin. Pure; the
 * input is not changed.
 */
export function applyToFile(
  file: RfSectorsFile,
  p: Proposal,
  catalogue: readonly RfCatalogueEntry[],
): RfSectorsFile {
  const names = new Map(p.renames.map((r) => [r.sectorId, r.name]));
  const sectors = p.sectors.map((s) => ({
    id: s.id,
    name: names.get(s.id) ?? s.name,
    antennaIds: [...s.antennaIds],
  }));
  const antennas = file.antennas.map((a) => structuredClone(a));
  for (const row of p.rows) {
    const k = antennas.findIndex((a) => a.antennaId === row.unitId);
    const next = applyRow(k >= 0 ? antennas[k] : undefined, row, catalogue);
    if (k >= 0) antennas[k] = next;
    else antennas.push(next);
  }
  return { ...structuredClone(file), sectors, antennas };
}
