/**
 * Auto-plan proposal: sectors (C1) plus one or more picks per antenna (AI, rules or a cell export),
 * shown in the review dialog and then written to `rf/sectors.json` by `applyToFile`.
 *
 * - `validateAiPick` checks an AI reply row against the catalogue and the band table; a row it
 *   cannot use falls back to the rules pick at low confidence and says why.
 * - Re-plan keeps every field group whose origin is `user` or `export` (C3): the equipment, the
 *   e-tilt, and each existing carrier by index. A missing origin counts as `user`.
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
  type RfOrigin,
  type RfSector,
  type RfSectorsFile,
} from '@aio/schema';
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
  /** One pick from the AI or the rules; a cell export may give several (one per carrier). */
  picks: PlanPick[];
  /** Groups the person (or a cell export) set, which Re-plan keeps; `carriers` is per existing index. */
  kept: { equipment: boolean; etiltDeg: boolean; carriers: boolean[] };
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

export function buildProposal(i: {
  units: readonly AntennaUnit[];
  file: RfSectorsFile;
  catalogue: readonly RfCatalogueEntry[];
  picks: ReadonlyMap<string, PlanPick[]>;
  renames?: readonly Rename[];
  unmatchedRows?: readonly number[];
}): Proposal {
  const plan = planSectors(i.units, i.file.sectors);
  const out = new Set(plan.leftOut.map((l) => l.unitId));
  const rows: ProposalRow[] = [];
  for (const sector of plan.sectors) {
    for (const id of sector.antennaIds) {
      const unit = i.units.find((u) => u.id === id);
      if (!unit || out.has(id)) continue;
      const given = i.picks.get(id);
      const s = i.file.antennas.find((a) => a.antennaId === id);
      rows.push({
        unitId: id,
        sectorId: sector.id,
        picks: given && given.length > 0 ? [...given] : [rulesPick(unit, i.catalogue)],
        kept: {
          equipment: s?.equipment !== undefined && keeps(s.origins?.equipment),
          etiltDeg: s?.etiltDeg !== undefined && keeps(s.origins?.etiltDeg),
          carriers: (s?.carriers ?? []).map((c) => keeps(c.origin)),
        },
      });
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

const originFrom = (p: PlanPick): RfOrigin => ({ by: p.by, confidence: p.confidence });

/** The first `c<n>` id not in use. */
function freeCarrierId(used: Set<string>, preferred: number): string {
  let n = preferred;
  if (used.has(`c${String(n)}`)) n = 1;
  while (used.has(`c${String(n)}`)) n++;
  const id = `c${String(n)}`;
  used.add(id);
  return id;
}

/** The settings with the pick's equipment, through the one equipment rule (`withEquipment`). */
function applyEquipment(
  s: RfAntennaSettings,
  eq: PlanPick['equipment'],
  catalogue: readonly RfCatalogueEntry[],
): RfAntennaSettings {
  const find = (id: string) => catalogue.find((e) => e.id === id);
  const main = find(eq.kind === 'aau' ? eq.aau : eq.antenna);
  let next = main ? withEquipment(s, main, catalogue) : null;
  if (next && eq.kind === 'separate') {
    const radio = eq.radio === undefined ? undefined : find(eq.radio);
    if (radio) next = withEquipment(next, radio, catalogue);
    else if (next.equipment?.kind === 'separate')
      next = { ...next, equipment: { kind: 'separate', antenna: eq.antenna } };
  }
  // An entry the catalogue lacks is written as given; the tab flags it.
  return next ?? clampSettingsEtilt({ ...s, equipment: eq }, catalogue);
}

/** A new carrier made to fit the final equipment: no radio or port on an AAU, the unit's radio. */
function fitCarrier(c: RfCarrier, s: RfAntennaSettings, catalogue: readonly RfCatalogueEntry[]) {
  const eq = s.equipment;
  const n = { ...c };
  if (eq?.kind === 'aau') {
    delete n.radioUnit;
    delete n.port;
  } else if (eq?.kind === 'separate') {
    if (eq.radio === undefined) delete n.radioUnit;
    else n.radioUnit = eq.radio;
    const ant = catalogue.find((e) => e.id === eq.antenna);
    if (n.port !== undefined && ant?.kind === 'antenna' && !ant.ports.some((p) => p.id === n.port))
      delete n.port;
  }
  return n;
}

function applyRow(
  current: RfAntennaSettings | undefined,
  row: ProposalRow,
  catalogue: readonly RfCatalogueEntry[],
): RfAntennaSettings {
  const base: RfAntennaSettings = current
    ? structuredClone(current)
    : { antennaId: row.unitId, active: true, carriers: [] };
  const existing = base.carriers;
  const used = new Set(existing.filter((_, k) => row.kept.carriers[k] === true).map((c) => c.id));
  const fresh = new Set<string>();
  const carriers: RfCarrier[] = [];
  for (let k = 0; k < Math.max(existing.length, row.picks.length); k++) {
    const old = existing[k];
    if (old && row.kept.carriers[k] === true) {
      carriers.push(old);
      continue;
    }
    const pick = row.picks[k];
    if (!pick) continue;
    const id = freeCarrierId(used, k + 1);
    fresh.add(id);
    carriers.push({ ...pick.carrier, id, feederLossDb: 0, origin: originFrom(pick) });
  }
  let next: RfAntennaSettings = { ...base, carriers };
  const first = row.picks[0];
  if (!row.kept.equipment && first) {
    next = applyEquipment(next, first.equipment, catalogue);
    next = { ...next, origins: { ...next.origins, equipment: originFrom(first) } };
  }
  if (!row.kept.etiltDeg && first?.etiltDeg !== undefined) {
    next = clampSettingsEtilt(
      {
        ...next,
        etiltDeg: first.etiltDeg,
        origins: { ...next.origins, etiltDeg: originFrom(first) },
      },
      catalogue,
    );
  }
  const fitted = next;
  return {
    ...fitted,
    carriers: fitted.carriers.map((c) => (fresh.has(c.id) ? fitCarrier(c, fitted, catalogue) : c)),
  };
}

/**
 * The sectors file with the proposal written: its sectors and renames, and per row the equipment
 * and carriers of every group not kept, each with its origin. Pure; the input is not changed.
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
