import { csvText, csvUntext, SiteMaterial } from '@aio/schema';

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

function cell(text: string): string {
  const v = csvText(text);
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
    return k < 0 ? '' : csvUntext((r[k] ?? '').trim());
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

// ------------------------------------------------- densities by survey date and colours (Stage C)

/** A capture's date as a number to order by (any monotonic clock), or null when it has none. */
export type CaptureDateOf = (capture: string) => number | null;

/** The history entries whose capture has a date, oldest first (undated ones are skipped). */
function datedHistory(m: SiteMaterial, dateOf: CaptureDateOf) {
  const out: { fromCapture: string; tPerM3: number; at: number }[] = [];
  for (const e of m.densityHistory ?? []) {
    const at = dateOf(e.fromCapture);
    if (at !== null && Number.isFinite(at)) out.push({ ...e, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A material's density on a survey date: the latest `densityHistory` entry from that date or
 * before; before the first entry, the first entry. Without a history, or for a capture with no
 * date, the material's `densityTPerM3` (null when it has none).
 */
export function densityOn(
  material: SiteMaterial,
  capture: string,
  dateOf: CaptureDateOf,
): number | null {
  const fallback = material.densityTPerM3 ?? null;
  const at = dateOf(capture);
  const history = datedHistory(material, dateOf);
  if (at === null || !Number.isFinite(at) || history.length === 0) return fallback;
  let found = history[0]?.tPerM3 ?? fallback;
  for (const e of history) if (e.at <= at) found = e.tPerM3;
  return found;
}

/**
 * A material with a density from `fromCapture` on (that date and every later one until the next
 * entry). The first edit of a material that had one density keeps it as the entry from
 * `earliestCapture`, so earlier dates keep their tonnes. An entry of the same date is replaced;
 * entries are sorted by date (undated last) and `densityTPerM3` is the newest entry's value.
 */
export function withDensityFrom(
  material: SiteMaterial,
  fromCapture: string,
  tPerM3: number,
  earliestCapture: string,
  dateOf: CaptureDateOf,
): SiteMaterial {
  let history = [...(material.densityHistory ?? [])];
  if (
    history.length === 0 &&
    material.densityTPerM3 !== undefined &&
    earliestCapture !== fromCapture
  )
    history.push({ fromCapture: earliestCapture, tPerM3: material.densityTPerM3 });
  history = history.filter((e) => e.fromCapture !== fromCapture);
  history.push({ fromCapture, tPerM3 });
  const key = (c: string) => dateOf(c) ?? Number.POSITIVE_INFINITY;
  history = history
    .map((e, i) => ({ e, i }))
    .sort((a, b) => key(a.e.fromCapture) - key(b.e.fromCapture) || a.i - b.i)
    .map(({ e }) => e);
  const dated = history.filter((e) => dateOf(e.fromCapture) !== null);
  const newest = dated.at(-1)?.tPerM3 ?? tPerM3;
  return { ...material, densityHistory: history, densityTPerM3: newest };
}

/**
 * The categorical palette a material without its own colour takes, by its place in the site's
 * list: eight design tokens (CSS custom property names, defined by the renderer's styles).
 */
export const MATERIAL_PALETTE: readonly string[] = [
  '--mat-1',
  '--mat-2',
  '--mat-3',
  '--mat-4',
  '--mat-5',
  '--mat-6',
  '--mat-7',
  '--mat-8',
];

/**
 * A material's colour as a CSS colour: its own `#rrggbb`, else `var(--mat-n)` for its place
 * `index` in the site's list (the palette repeats after eight).
 */
export function materialColour(m: SiteMaterial, index: number): string {
  if (m.colour) return m.colour;
  const n = MATERIAL_PALETTE.length;
  const k = ((Math.trunc(index) % n) + n) % n;
  return `var(${MATERIAL_PALETTE[k] ?? '--mat-1'})`;
}
