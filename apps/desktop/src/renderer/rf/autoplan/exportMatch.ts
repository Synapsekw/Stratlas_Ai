/**
 * Forgiving match of an operator cell export to the detected antennas (Auto-plan). Each row becomes
 * one plan pick (one carrier). A row finds its unit by exact name or id (high), else by its sector
 * name plus the nearest bearing, with height breaking a tie (medium). A matched row may rename its
 * sector, but never moves a unit. Pure: no store, no bridge.
 */
import { bandOfName, unitTrueAzimuthDeg } from '@aio/rf';
import type { AntennaUnit, RfCarrier, RfCatalogueEntry, RfEquipment, RfSector } from '@aio/schema';
import { columnsOf, findEntry, norm, num, splitCsv, type CellField } from '../cellCsv';
import { defaultBandwidth } from '../rfFields';
import { rfUnit } from '../rfModel';
import { rulesPick } from './rules';
import type { PlanPick } from './types';

export interface ExportMatch {
  picks: Map<string, PlanPick[]>;
  renames: { sectorId: string; name: string }[];
  /** 1-based file lines (the header is line 1) of rows that matched no unit. */
  unmatchedRows: number[];
  unmatchedUnits: string[];
}

/** Bearings closer than this are a tie, so height decides. */
const TIE_DEG = 1;

const angleBetween = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

export function matchCellExport(
  text: string,
  units: readonly AntennaUnit[],
  sectors: readonly RfSector[],
  catalogue: readonly RfCatalogueEntry[],
): ExportMatch | { error: 'empty' | 'no-antenna-column' } {
  const records = splitCsv(text);
  const header = records[0];
  if (!header) return { error: 'empty' };
  const cols = columnsOf(header);
  if (cols.antenna === undefined) return { error: 'no-antenna-column' };

  const byId = new Map(units.map((u) => [u.id, u]));
  const byName = new Map(units.map((u) => [norm(u.name), u]));
  const sectorByName = new Map(sectors.map((s) => [norm(s.name), s]));
  const sectorOfUnit = new Map(sectors.flatMap((s) => s.antennaIds.map((id) => [id, s] as const)));
  const trueAz = (u: AntennaUnit): number | null => unitTrueAzimuthDeg(rfUnit(u));
  const heightOf = (u: AntennaUnit): number | null => {
    const h: Partial<Pick<AntennaUnit, 'heightM'>> = u;
    const v = h.heightM?.value;
    return v !== undefined && Number.isFinite(v) ? v : null;
  };

  const out: ExportMatch = {
    picks: new Map(),
    renames: [],
    unmatchedRows: [],
    unmatchedUnits: [],
  };
  const renamed = new Set<string>();

  const byBearing = (
    sector: RfSector,
    az: number | null,
    height: number | null,
  ): AntennaUnit | undefined => {
    if (az === null) return undefined;
    const cands = sector.antennaIds
      .map((id) => byId.get(id))
      .flatMap((u) => {
        const a = u ? trueAz(u) : null;
        return u && a !== null ? [{ u, d: angleBetween(a, az) }] : [];
      });
    if (cands.length === 0) return undefined;
    const best = Math.min(...cands.map((c) => c.d));
    const tied = cands.filter((c) => c.d - best <= TIE_DEG);
    if (height === null || tied.length === 1) return tied[0]?.u;
    const dh = (u: AntennaUnit): number => {
      const h = heightOf(u);
      return h === null ? Infinity : Math.abs(h - height);
    };
    return tied.reduce((a, b) => (dh(b.u) < dh(a.u) ? b : a)).u;
  };

  records.slice(1).forEach((rec, i) => {
    const line = i + 2;
    const cell = (f: CellField): string => {
      const c = cols[f];
      return c === undefined ? '' : (rec[c] ?? '').trim();
    };
    const ref = cell('antenna');
    const sectorText = cell('sector');
    const az = num(cell('azimuth'));
    const height = num(cell('height'));

    let unit = ref === '' ? undefined : (byId.get(ref) ?? byName.get(norm(ref)));
    let confidence: PlanPick['confidence'] = 'high';
    let how = 'matched by antenna name';
    if (!unit && sectorText !== '') {
      const sector = sectorByName.get(norm(sectorText));
      if (sector) {
        unit = byBearing(sector, az, height);
        confidence = 'medium';
        how = `matched by sector ${sector.name} and bearing`;
      }
    }
    if (!unit) {
      out.unmatchedRows.push(line);
      return;
    }

    // a matched row may rename its sector (never move the unit)
    const own = sectorOfUnit.get(unit.id);
    if (
      own &&
      sectorText !== '' &&
      norm(own.name) !== norm(sectorText) &&
      !renamed.has(own.id) &&
      !sectorByName.has(norm(sectorText))
    ) {
      renamed.add(own.id);
      out.renames.push({ sectorId: own.id, name: sectorText.slice(0, 120) });
    }

    // equipment from the model text, else the rules pick
    const rules = rulesPick(unit, catalogue);
    const am = cell('antennaModel');
    const rm = cell('radioModel');
    const antenna = am === '' ? undefined : findEntry(catalogue, am, ['antenna']);
    const radio = rm === '' ? undefined : findEntry(catalogue, rm, ['radio', 'aau']);
    let equipment: RfEquipment | undefined;
    if (radio?.kind === 'aau') equipment = { kind: 'aau', aau: radio.id };
    else if (antenna)
      equipment = {
        kind: 'separate',
        antenna: antenna.id,
        ...(radio?.kind === 'radio' ? { radio: radio.id } : {}),
      };
    const reasons = [how];
    if (!equipment) {
      equipment = rules.equipment;
      if (am !== '' || rm !== '') {
        confidence = 'low';
        reasons.push('model text not found in the catalogue, equipment from the rules');
      }
    }

    // carrier: the row's band, else the rules' band, tech and bandwidth
    const bandText = cell('band');
    const bandOk =
      bandText !== '' &&
      bandOfName(bandText) !== undefined &&
      /^[A-Za-z0-9-]{1,12}$/.test(bandText);
    const techText = cell('tech').toLowerCase();
    const techRow: RfCarrier['tech'] | undefined =
      techText === 'lte' || techText === '4g'
        ? 'lte'
        : techText === 'nr' || techText === '5g'
          ? 'nr'
          : undefined;
    const bw = num(cell('bandwidth'));
    const bwOk = bw !== null && bw > 0 && bw <= 1000 ? bw : undefined;
    const power = num(cell('power'));
    const powerOk = power !== null && power >= 0 && power <= 80 ? power : undefined;

    let carrier: PlanPick['carrier'];
    if (bandOk) {
      const tech: RfCarrier['tech'] = techRow ?? (/^n\d+$/i.test(bandText) ? 'nr' : 'lte');
      carrier = { tech, band: bandText, bandwidthMhz: bwOk ?? defaultBandwidth(tech, bandText) };
    } else {
      carrier = {
        ...rules.carrier,
        ...(techRow ? { tech: techRow } : {}),
        ...(bwOk === undefined ? {} : { bandwidthMhz: bwOk }),
      };
    }
    if (powerOk !== undefined) carrier.powerDbmPerPort = powerOk;
    if (equipment.kind === 'separate' && equipment.radio) carrier.radioUnit = equipment.radio;
    else delete carrier.radioUnit;

    const list = out.picks.get(unit.id) ?? [];
    list.push({ equipment, carrier, by: 'export', confidence, reason: reasons.join('; ') });
    out.picks.set(unit.id, list);
  });

  out.unmatchedUnits = units.filter((u) => !out.picks.has(u.id)).map((u) => u.id);
  return out;
}
