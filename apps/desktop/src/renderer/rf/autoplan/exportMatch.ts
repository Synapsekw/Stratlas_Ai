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
import { msg, type PlanText } from './planText';
import { rulesPick } from './rules';
import { plannedUnits, type ActiveSettings } from './sectors';
import type { PlanPick } from './types';

export interface ExportMatch {
  picks: Map<string, PlanPick[]>;
  renames: { sectorId: string; name: string }[];
  /** 1-based file lines (the header is line 1) of rows that matched no unit. */
  unmatchedRows: number[];
  /** Units Auto-plan would plan (`plannedUnits`) that no row matched. */
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
  /** The RF settings, for the units switched off in RF (not planned, so never unmatched). */
  settings: ActiveSettings = [],
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
    if (height === null || tied.length === 1) return tied.reduce((a, b) => (b.d < a.d ? b : a)).u;
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
    let how: PlanText = msg('rf.autoplan.export.byName');
    if (!unit && sectorText !== '') {
      const sector = sectorByName.get(norm(sectorText));
      if (sector) {
        unit = byBearing(sector, az, height);
        confidence = 'medium';
        how = msg('rf.autoplan.export.bySector', { sector: sector.name });
      }
    }
    if (!unit) {
      out.unmatchedRows.push(line);
      return;
    }

    // a matched row may rename its sector (never move the unit)
    const own = sectorOfUnit.get(unit.id);
    const taken = new Set(out.renames.map((r) => norm(r.name)));
    if (
      own &&
      sectorText !== '' &&
      norm(own.name) !== norm(sectorText) &&
      !renamed.has(own.id) &&
      !sectorByName.has(norm(sectorText)) &&
      !taken.has(norm(sectorText))
    ) {
      renamed.add(own.id);
      out.renames.push({ sectorId: own.id, name: sectorText.slice(0, 120) });
    }

    // equipment from the model text, else the rules pick; each given text is checked on its own
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
    const reasons: PlanText[] = [how];
    const missing = [am !== '' && !antenna ? am : '', rm !== '' && !radio ? rm : ''].filter(
      (t) => t !== '',
    );
    if (missing.length > 0) {
      confidence = 'low';
      const texts = missing.map((t) => `'${t}'`).join(', ');
      reasons.push(
        msg(
          equipment ? 'rf.autoplan.export.modelMissing' : 'rf.autoplan.export.modelMissingRules',
          { texts },
        ),
      );
    }
    equipment ??= rules.equipment;

    // carrier: the row's band, else the rules' band, tech and bandwidth; row text that is
    // present but rejected lowers the confidence and is named in the reason
    const bandText = cell('band');
    const bandOk =
      bandText !== '' &&
      bandOfName(bandText) !== undefined &&
      /^[A-Za-z0-9-]{1,12}$/.test(bandText);
    if (bandText !== '' && !bandOk) {
      confidence = 'low';
      reasons.push(msg('rf.autoplan.export.badBand', { band: bandText }));
    }
    const techText = cell('tech').toLowerCase();
    const techRow: RfCarrier['tech'] | undefined =
      techText === 'lte' || techText === '4g'
        ? 'lte'
        : techText === 'nr' || techText === '5g'
          ? 'nr'
          : undefined;
    const bwText = cell('bandwidth');
    const bw = num(bwText);
    const bwOk = bw !== null && bw > 0 && bw <= 1000 ? bw : undefined;
    if (bwText !== '' && bwOk === undefined) {
      confidence = 'low';
      reasons.push(msg('rf.autoplan.export.badBandwidth', { text: bwText }));
    }
    const powerText = cell('power');
    const power = num(powerText);
    const powerOk = power !== null && power >= 0 && power <= 80 ? power : undefined;
    if (powerText !== '' && powerOk === undefined) {
      confidence = 'low';
      reasons.push(msg('rf.autoplan.export.badPower', { text: powerText }));
    }
    const etilt = num(cell('etilt'));
    const etiltOk = etilt !== null && etilt >= -20 && etilt <= 40 ? etilt : undefined;

    let carrier: PlanPick['carrier'];
    if (bandOk) {
      const tech: RfCarrier['tech'] = techRow ?? (/^n\d+$/i.test(bandText) ? 'nr' : 'lte');
      carrier = { tech, band: bandText, bandwidthMhz: bwOk ?? defaultBandwidth(tech, bandText) };
    } else {
      carrier = {
        ...rules.carrier,
        ...(bwOk === undefined ? {} : { bandwidthMhz: bwOk }),
      };
    }
    if (powerOk !== undefined) carrier.powerDbmPerPort = powerOk;
    if (equipment.kind === 'separate' && equipment.radio) carrier.radioUnit = equipment.radio;
    else delete carrier.radioUnit;

    const list = out.picks.get(unit.id) ?? [];
    list.push({
      equipment,
      carrier,
      ...(etiltOk === undefined ? {} : { etiltDeg: etiltOk }),
      by: 'export',
      confidence,
      reason: reasons,
    });
    out.picks.set(unit.id, list);
  });

  // only the units Auto-plan plans: a draft, a dish or a unit switched off needs no row
  const planned = plannedUnits(units, settings);
  out.unmatchedUnits = units
    .filter((u) => planned.has(u.id) && !out.picks.has(u.id))
    .map((u) => u.id);
  return out;
}
