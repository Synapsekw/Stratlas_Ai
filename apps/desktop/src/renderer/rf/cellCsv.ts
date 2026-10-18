/**
 * The cell export CSV (spec D6): one row per antenna, matched to the detected units by name (or
 * id), reviewed, then applied to the RF working copy. The format is ours (documented in the guide):
 *
 *   antenna, sector, tech, band, bandwidth_mhz, power_dbm, etilt_deg, antenna_model, radio_model
 *
 * Only `antenna` is required; an empty cell leaves that setting as it is. Header names ignore case,
 * spaces and underscores, and a few common spellings are accepted (`name`, `bw`, `e_tilt` ...).
 * `antenna_model` and `radio_model` match a catalogue entry by id, model, or vendor and model; an AAU
 * goes in `radio_model`. Pure: no store, no bridge.
 */
import { bandOfName, getEntry } from '@aio/rf';
import { clampSettingsEtilt, defaultBandwidth, withEquipment } from './rfFields';
import type {
  AntennaUnit,
  RfAntennaSettings,
  RfCarrier,
  RfCatalogueEntry,
  RfOrigin,
  RfSectorsFile,
} from '@aio/schema';

export type CellField =
  | 'antenna'
  | 'sector'
  | 'tech'
  | 'band'
  | 'bandwidth'
  | 'power'
  | 'etilt'
  | 'antennaModel'
  | 'radioModel';

const ALIASES: Readonly<Record<CellField, readonly string[]>> = {
  antenna: ['antenna', 'antennaname', 'antennaid', 'name', 'id', 'unit'],
  sector: ['sector', 'sectorname', 'cell'],
  tech: ['tech', 'technology', 'rat'],
  band: ['band'],
  bandwidth: ['bandwidthmhz', 'bandwidth', 'bw'],
  power: ['powerdbm', 'power', 'powerdbmperport'],
  etilt: ['etiltdeg', 'etilt', 'electricaltilt'],
  antennaModel: ['antennamodel', 'antennatype'],
  radioModel: ['radiomodel', 'radio', 'rru', 'aau', 'radiounit'],
};

/** Why a row or one of its cells cannot be used; the review table shows the words. */
export type CellProblem =
  | 'no-unit'
  | 'duplicate'
  | 'band-unknown'
  | 'bandwidth'
  | 'power'
  | 'etilt'
  | 'antenna-model'
  | 'radio-model'
  | 'tech';

export interface CellRow {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  /** The antenna cell as written. */
  ref: string;
  /** The matched unit, or null. */
  unitId: string | null;
  unitName: string | null;
  sector?: string;
  tech?: 'lte' | 'nr';
  band?: string;
  bandwidthMhz?: number;
  powerDbm?: number;
  etiltDeg?: number;
  /** Matched catalogue antenna id. */
  antennaEntry?: string;
  /** Matched catalogue radio or AAU id. */
  radioEntry?: string;
  problems: CellProblem[];
}

export type ParseResult =
  { ok: true; rows: CellRow[] } | { ok: false; error: 'empty' | 'no-antenna-column' };

/** Split CSV text into records (quotes, doubled quotes, CRLF, a comma or semicolon separator). */
export function splitCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out.filter((r) => r.some((x) => x.trim() !== ''));
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s_\-.]/g, '');

function columnsOf(header: readonly string[]): Partial<Record<CellField, number>> {
  const cols: Partial<Record<CellField, number>> = {};
  header.forEach((h, i) => {
    const key = norm(h);
    for (const [field, names] of Object.entries(ALIASES) as [CellField, readonly string[]][]) {
      if (cols[field] === undefined && names.includes(key)) cols[field] = i;
    }
  });
  return cols;
}

/** A catalogue entry by id, model, or vendor and model (case and spacing ignored). */
export function findEntry(
  catalogue: readonly RfCatalogueEntry[],
  text: string,
  kinds: readonly RfCatalogueEntry['kind'][],
): RfCatalogueEntry | undefined {
  const key = norm(text);
  if (key === '') return undefined;
  return catalogue.find(
    (e) =>
      kinds.includes(e.kind) &&
      (norm(e.id) === key || norm(e.model) === key || norm(`${e.vendor} ${e.model}`) === key),
  );
}

const num = (s: string): number | null => {
  const v = Number(s.trim().replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(v) ? v : null;
};

/** Read the file and match every row to a unit and the catalogue. */
export function parseCellCsv(
  text: string,
  units: readonly Pick<AntennaUnit, 'id' | 'name'>[],
  catalogue: readonly RfCatalogueEntry[],
): ParseResult {
  const records = splitCsv(text);
  const header = records[0];
  if (!header) return { ok: false, error: 'empty' };
  const cols = columnsOf(header);
  if (cols.antenna === undefined) return { ok: false, error: 'no-antenna-column' };
  const byId = new Map(units.map((u) => [u.id, u]));
  const byName = new Map(units.map((u) => [norm(u.name), u]));
  const seen = new Set<string>();
  const rows = records.slice(1).map((rec, i): CellRow => {
    const cell = (f: CellField): string => {
      const c = cols[f];
      return c === undefined ? '' : (rec[c] ?? '').trim();
    };
    const ref = cell('antenna');
    const unit = byId.get(ref) ?? byName.get(norm(ref));
    const problems: CellProblem[] = [];
    if (!unit) problems.push('no-unit');
    else if (seen.has(unit.id)) problems.push('duplicate');
    if (unit) seen.add(unit.id);
    const row: CellRow = {
      line: i + 2,
      ref,
      unitId: unit?.id ?? null,
      unitName: unit?.name ?? null,
      problems,
    };
    const sector = cell('sector');
    if (sector) row.sector = sector.slice(0, 120);
    const band = cell('band');
    if (band) {
      const b = bandOfName(band);
      if (b && /^[A-Za-z0-9-]{1,12}$/.test(band)) row.band = band;
      else problems.push('band-unknown');
    }
    const tech = cell('tech').toLowerCase();
    if (tech === 'lte' || tech === '4g') row.tech = 'lte';
    else if (tech === 'nr' || tech === '5g') row.tech = 'nr';
    else if (tech !== '') problems.push('tech');
    else if (row.band) row.tech = /^n\d+$/i.test(row.band) ? 'nr' : 'lte';
    const bw = cell('bandwidth');
    if (bw) {
      const v = num(bw);
      if (v !== null && v > 0 && v <= 1000) row.bandwidthMhz = v;
      else problems.push('bandwidth');
    }
    const power = cell('power');
    if (power) {
      const v = num(power);
      if (v !== null && v >= 0 && v <= 80) row.powerDbm = v;
      else problems.push('power');
    }
    const etilt = cell('etilt');
    if (etilt) {
      const v = num(etilt);
      if (v !== null && v >= -20 && v <= 40) row.etiltDeg = v;
      else problems.push('etilt');
    }
    const am = cell('antennaModel');
    if (am) {
      const e = findEntry(catalogue, am, ['antenna']);
      if (e) row.antennaEntry = e.id;
      else problems.push('antenna-model');
    }
    const rm = cell('radioModel');
    if (rm) {
      const e = findEntry(catalogue, rm, ['radio', 'aau']);
      if (e) row.radioEntry = e.id;
      else problems.push('radio-model');
    }
    return row;
  });
  return { ok: true, rows };
}

/** A row that can be applied: it matched a unit (cell problems only leave those cells out). */
export const applicable = (r: CellRow): boolean =>
  r.unitId !== null && !r.problems.includes('duplicate');

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'imported';

/** Apply the reviewed rows to the working copy (values have basis user, as typed values do). */
export function applyCellRows(
  file: RfSectorsFile,
  rows: readonly CellRow[],
  catalogue: readonly RfCatalogueEntry[],
): RfSectorsFile {
  let sectors = file.sectors.map((s) => ({ ...s, antennaIds: [...s.antennaIds] }));
  const antennas = file.antennas.map((a) => ({ ...a }));
  for (const r of rows) {
    const id = r.unitId;
    if (!id || !applicable(r)) continue;
    let s: RfAntennaSettings = antennas.find((a) => a.antennaId === id) ?? {
      antennaId: id,
      active: true,
      carriers: [],
    };
    if (r.etiltDeg !== undefined) s = { ...s, etiltDeg: r.etiltDeg };
    const exportOrigin: RfOrigin = { by: 'export', confidence: 'high' };
    const first = s.carriers[0];
    if (r.band !== undefined || first) {
      const tech = r.tech ?? first?.tech ?? 'lte';
      const base: RfCarrier = first ?? {
        id: 'c1',
        tech,
        band: r.band ?? '',
        bandwidthMhz: r.bandwidthMhz ?? defaultBandwidth(tech, r.band),
        feederLossDb: 0,
      };
      const next: RfCarrier = {
        ...base,
        ...(r.band === undefined ? {} : { band: r.band, tech: r.tech ?? base.tech }),
        ...(r.bandwidthMhz === undefined ? {} : { bandwidthMhz: r.bandwidthMhz }),
        ...(r.powerDbm === undefined ? {} : { powerDbmPerPort: r.powerDbm }),
      };
      if (r.band !== undefined && r.band !== base.band) delete next.scsKhz;
      if (next.band !== '') {
        s = { ...s, carriers: [{ ...next, origin: exportOrigin }, ...s.carriers.slice(1)] };
      }
    }
    // equipment by the tab's own rule (rfFields.withEquipment): an AAU first, else the antenna
    // and then its radio; a radio without an antenna is left out
    const radio = r.radioEntry === undefined ? undefined : getEntry(catalogue, r.radioEntry);
    const antenna = r.antennaEntry === undefined ? undefined : getEntry(catalogue, r.antennaEntry);
    if (radio?.kind === 'aau') s = withEquipment(s, radio, catalogue) ?? s;
    else {
      if (antenna?.kind === 'antenna') s = withEquipment(s, antenna, catalogue) ?? s;
      if (radio?.kind === 'radio') s = withEquipment(s, radio, catalogue) ?? s;
    }
    // a typed or imported e-tilt always lies in the range the tab shows
    s = clampSettingsEtilt(s, catalogue);
    const marks = {
      ...(r.etiltDeg === undefined ? {} : { etiltDeg: exportOrigin }),
      ...(radio === undefined && antenna === undefined ? {} : { equipment: exportOrigin }),
    };
    if (Object.keys(marks).length > 0) s = { ...s, origins: { ...s.origins, ...marks } };
    const at = antennas.findIndex((a) => a.antennaId === id);
    if (at < 0) antennas.push(s);
    else antennas[at] = s;
    if (r.sector !== undefined) {
      const want = r.sector.trim().toLowerCase();
      let target = sectors.find((x) => x.name.trim().toLowerCase() === want);
      if (!target) {
        const ids = new Set(sectors.map((x) => x.id));
        let sid = `sec-${slug(r.sector)}`;
        for (let n = 2; ids.has(sid); n++) sid = `sec-${slug(r.sector)}-${String(n)}`;
        target = { id: sid, name: r.sector.trim(), antennaIds: [] };
        sectors = [...sectors, target];
      }
      const tid = target.id;
      sectors = sectors.map((x) => ({
        ...x,
        antennaIds:
          x.id === tid
            ? [...x.antennaIds.filter((a) => a !== id), id]
            : x.antennaIds.filter((a) => a !== id),
      }));
    }
  }
  return { ...file, sectors, antennas };
}
