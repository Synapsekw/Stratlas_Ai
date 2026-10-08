import { SiteMaterial } from '@aio/schema';

/**
 * Site materials (M11 G4, data-conventions section 27): `survey/settings.json` `materials`, each
 * with a name, an id, an optional code, a density (t/m3) and swell factors (loose and compacted
 * volume relative to bank). CSV import and export, so a site's list travels between projects and
 * spreadsheets. The CSV is UTF-8 with a header row:
 *
 *   id,name,code,density_t_per_m3,swell_loose,swell_compacted
 *
 * Import accepts a byte order mark, comma or semicolon separators, quoted fields, CRLF or LF, the
 * columns in any order (by header name), and empty optional cells. Each row is checked against the
 * `SiteMaterial` contract; bad rows are reported by line and left out, never guessed.
 */

export const MATERIAL_CSV_COLUMNS = [
  'id',
  'name',
  'code',
  'density_t_per_m3',
  'swell_loose',
  'swell_compacted',
] as const;

export const MAX_MATERIALS = 500;

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

function cell(v: string): string {
  return /[",;\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const num = (v: number | undefined) => (v === undefined ? '' : String(v));

/** The materials as CSV (comma separated, CRLF line ends, a header row). */
export function materialsToCsv(materials: readonly SiteMaterial[]): string {
  const lines = [MATERIAL_CSV_COLUMNS.join(',')];
  for (const m of materials)
    lines.push(
      [
        m.id,
        m.name,
        m.code ?? '',
        num(m.densityTPerM3),
        num(m.swell?.loose),
        num(m.swell?.compacted),
      ]
        .map(cell)
        .join(','),
    );
  return `${lines.join('\r\n')}\r\n`;
}

/** Split CSV text into rows of cells (RFC 4180 quoting) with the given separator. */
export function parseCsvRows(text: string, sep: ',' | ';'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  let i = 0;
  const s = text.replace(BOM, '');
  while (i < s.length) {
    const ch = s[i] ?? '';
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface MaterialsImport {
  materials: SiteMaterial[];
  /** One line per row left out, with its line number. */
  problems: string[];
}

const HEADER_ALIASES: Record<string, (typeof MATERIAL_CSV_COLUMNS)[number]> = {
  id: 'id',
  name: 'name',
  code: 'code',
  density: 'density_t_per_m3',
  density_t_per_m3: 'density_t_per_m3',
  'density (t/m3)': 'density_t_per_m3',
  swell_loose: 'swell_loose',
  loose: 'swell_loose',
  swell_compacted: 'swell_compacted',
  compacted: 'swell_compacted',
};

/** Read materials from CSV text (see the module comment). */
export function materialsFromCsv(text: string): MaterialsImport {
  const head = text.replace(BOM, '').split(/\r?\n/, 1)[0] ?? '';
  const sep: ',' | ';' =
    (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = parseCsvRows(text, sep);
  const problems: string[] = [];
  const header = (rows[0] ?? []).map((h) => HEADER_ALIASES[h.trim().toLowerCase()]);
  if (!header.includes('id') || !header.includes('name'))
    return { materials: [], problems: ['The first row must name the columns, with id and name.'] };
  const col = (r: string[], name: (typeof MATERIAL_CSV_COLUMNS)[number]) => {
    const k = header.indexOf(name);
    return k < 0 ? '' : (r[k] ?? '').trim();
  };
  const materials: SiteMaterial[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const numberOf = (name: (typeof MATERIAL_CSV_COLUMNS)[number]): number | undefined | null => {
      const v = col(r, name).replace(',', '.');
      if (v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const density = numberOf('density_t_per_m3');
    const loose = numberOf('swell_loose');
    const compacted = numberOf('swell_compacted');
    if (density === null || loose === null || compacted === null) {
      problems.push(`Line ${String(line)}: a number column holds text.`);
      return;
    }
    if ((loose === undefined) !== (compacted === undefined)) {
      problems.push(
        `Line ${String(line)}: give both swell factors (loose and compacted) or neither.`,
      );
      return;
    }
    const raw: Record<string, unknown> = { id: col(r, 'id'), name: col(r, 'name') };
    const code = col(r, 'code');
    if (code) raw.code = code;
    if (density !== undefined) raw.densityTPerM3 = density;
    if (loose !== undefined && compacted !== undefined) raw.swell = { loose, compacted };
    const parsed = SiteMaterial.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push(
        `Line ${String(line)}: ${issue ? `${issue.path.join('.') || 'row'} ${issue.message}` : 'not a material'}.`,
      );
      return;
    }
    if (seen.has(parsed.data.id)) {
      problems.push(`Line ${String(line)}: the id "${parsed.data.id}" is used twice.`);
      return;
    }
    if (materials.length >= MAX_MATERIALS) {
      problems.push(
        `Line ${String(line)}: a site holds at most ${String(MAX_MATERIALS)} materials.`,
      );
      return;
    }
    seen.add(parsed.data.id);
    materials.push(parsed.data);
  });
  return { materials, problems };
}

/**
 * Merge imported materials into a site's list: an imported id replaces the material with that id,
 * new ids are added at the end (up to the limit).
 */
export function mergeMaterials(
  site: readonly SiteMaterial[],
  incoming: readonly SiteMaterial[],
): SiteMaterial[] {
  const byId = new Map(incoming.map((m) => [m.id, m]));
  const out = site.map((m) => byId.get(m.id) ?? m);
  const have = new Set(site.map((m) => m.id));
  for (const m of incoming) if (!have.has(m.id) && out.length < MAX_MATERIALS) out.push(m);
  return out;
}

/** A file-name-safe material id from a name ("Crushed 20 mm" to "crushed-20-mm"). */
export function materialIdFrom(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'material';
  let id = /^[a-z0-9]/.test(base) ? base : `m-${base}`;
  for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
  return id;
}
