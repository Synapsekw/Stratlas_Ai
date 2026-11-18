/**
 * The app's volume figures against reference figures, for the real-data stockpile spec ("the
 * figures are right": each pile within 5 %, each site total within 1 %).
 *
 * Ours is the "Volume over time" CSV the Volumes header exports (`volumeSeriesCsv`): a row per
 * pile and survey date. The reference is a CSV a person writes, with the header
 * `pile,date,volume_m3`: the pile's name as the app lists it, the survey date as YYYY-MM-DD and
 * the volume in cubic metres; a row whose pile is `TOTAL` is the site total of that date. Names
 * match whatever their case and spacing. A pile or date that only one side has is listed, never
 * failed. Pure: no file, no app (`src/e2eVolumeReference.test.ts`).
 */

/** How far a pile's figure may be from its reference, in % of the reference. */
export const PILE_TOLERANCE_PCT = 5;
/** How far a date's site total may be from its reference, in % of the reference. */
export const TOTAL_TOLERANCE_PCT = 1;
/** The pile name of a site total row in the reference. */
export const TOTAL = 'TOTAL';

const BOM = String.fromCharCode(0xfeff);

/** A CSV's records (quoted cells, doubled quotes, LF or CRLF, a leading BOM); no blank lines. */
export function parseCsv(text: string): string[][] {
  const s = text.startsWith(BOM) ? text.slice(1) : text;
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c.trim() !== '')) out.push(row);
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (s.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') endRow();
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) endRow();
  return out;
}

/** One pile on one survey date, as the app's CSV has it. */
export interface SeriesRow {
  pile: string;
  /** YYYY-MM-DD. */
  date: string;
  /** In the CSV's volume unit; null when the date has no figure (Status says why). */
  volume: number | null;
  status: string;
  /** The figure is carried from an earlier version, not worked out by this one. */
  carried: boolean;
}

/** The app's "Volume over time" CSV: its volume unit and its rows. */
export function parseSeriesCsv(text: string): { unit: string; rows: SeriesRow[] } {
  const records = parseCsv(text);
  const head = records[0];
  if (!head) throw new Error('The volume over time CSV is empty');
  const col = (test: (name: string) => boolean) => head.findIndex((h) => test(h.trim()));
  const at = {
    pile: col((h) => h === 'Measurement'),
    date: col((h) => h === 'Date'),
    volume: col((h) => h.startsWith('Volume (')),
    status: col((h) => h === 'Status'),
    carried: col((h) => h === 'From an earlier version'),
  };
  const lacking = Object.entries(at)
    .filter(([, i]) => i < 0)
    .map(([k]) => k);
  if (at.pile !== 0 || lacking.length > 0)
    throw new Error(
      `Not the volume over time CSV: its header starts "${head.slice(0, 3).join(',')}" (Measurement, Date, Volume, Status and From an earlier version are expected; missing: ${lacking.join(', ') || 'none'})`,
    );
  const unit = /\(([^)]*)\)/.exec(head[at.volume] ?? '')?.[1] ?? '';
  const rows = records.slice(1).map((r): SeriesRow => {
    const v = (r[at.volume] ?? '').trim();
    return {
      pile: r[at.pile] ?? '',
      date: (r[at.date] ?? '').trim(),
      volume: v === '' || !Number.isFinite(Number(v)) ? null : Number(v),
      status: (r[at.status] ?? '').trim(),
      carried: (r[at.carried] ?? '').trim().toLowerCase() === 'yes',
    };
  });
  return { unit, rows };
}

/** A date's site total: the sum of the piles with a figure on it. */
export interface SiteTotal {
  date: string;
  volume: number;
  /** How many piles the sum holds. */
  piles: number;
}

/** Float noise never reaches a sum. */
const tidy = (v: number) => Math.round(v * 1e6) / 1e6;

/** The site total of each date that has a figure, in date order. */
export function siteTotals(rows: readonly SeriesRow[]): SiteTotal[] {
  const by = new Map<string, SiteTotal>();
  for (const r of rows) {
    if (r.volume === null) continue;
    const t = by.get(r.date) ?? { date: r.date, volume: 0, piles: 0 };
    t.volume = tidy(t.volume + r.volume);
    t.piles += 1;
    by.set(r.date, t);
  }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** One row of the reference file. */
export interface ReferenceRow {
  /** The pile's name, or `TOTAL`. */
  pile: string;
  date: string;
  /** Cubic metres. */
  volume: number;
  total: boolean;
}

/** Names match whatever their case and spacing. */
const norm = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The reference file (`pile,date,volume_m3`). Throws, naming the line, on another header, a date
 * that is not YYYY-MM-DD, a volume that is no number or a pile and date given twice.
 */
export function parseReference(text: string): ReferenceRow[] {
  const records = parseCsv(text);
  const head = (records[0] ?? []).map((h) => h.trim().toLowerCase());
  if (head[0] !== 'pile' || head[1] !== 'date' || head[2] !== 'volume_m3')
    throw new Error(
      `The reference file must start with the header pile,date,volume_m3 (it starts "${head.join(',')}")`,
    );
  const seen = new Set<string>();
  return records.slice(1).map((r, i) => {
    const line = i + 2;
    const name = (r[0] ?? '').trim();
    const date = (r[1] ?? '').trim();
    const raw = (r[2] ?? '').trim();
    const volume = Number(raw);
    if (name === '') throw new Error(`Reference line ${String(line)}: no pile name`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error(`Reference line ${String(line)}: the date "${date}" is not YYYY-MM-DD`);
    if (raw === '' || !Number.isFinite(volume))
      throw new Error(`Reference line ${String(line)}: the volume "${raw}" is not a number`);
    const total = norm(name) === norm(TOTAL);
    const key = `${norm(name)}|${date}`;
    if (seen.has(key))
      throw new Error(`Reference line ${String(line)}: ${name} on ${date} is given twice`);
    seen.add(key);
    return { pile: total ? TOTAL : name, date, volume, total };
  });
}

/** One compared figure. */
export interface ComparedRow {
  /** The pile's name as the app has it, or `TOTAL`. */
  pile: string;
  date: string;
  ours: number;
  reference: number;
  /** (ours - reference) / reference, in %; infinite against a reference of zero. */
  diffPct: number;
  limitPct: number;
  ok: boolean;
}

export interface Comparison {
  /** The figures both sides have, in the reference's order. */
  rows: ComparedRow[];
  /** What the reference names and the app has no figure for, with why. */
  missingInOurs: { pile: string; date: string; why: string }[];
  /** The app's piles and totals the reference does not name. */
  missingInReference: { pile: string; date: string }[];
  /** Names several of the app's piles share: none of them is compared. */
  duplicates: string[];
  /** Every compared figure is within its limit. */
  ok: boolean;
}

/**
 * Compare the app's rows with the reference: each pile within `pilePct` of its reference, each
 * site total (the sum of the app's piles with a figure on the date) within `totalPct`.
 */
export function compareVolumes(
  ours: readonly SeriesRow[],
  reference: readonly ReferenceRow[],
  limits: { pilePct?: number; totalPct?: number } = {},
): Comparison {
  const pilePct = limits.pilePct ?? PILE_TOLERANCE_PCT;
  const totalPct = limits.totalPct ?? TOTAL_TOLERANCE_PCT;
  const byKey = new Map<string, SeriesRow>();
  const names = new Map<string, string>();
  const dates = new Set<string>();
  const shared = new Set<string>();
  for (const r of ours) {
    const n = norm(r.pile);
    const key = `${n}|${r.date}`;
    if (byKey.has(key)) shared.add(n);
    else byKey.set(key, r);
    if (!names.has(n)) names.set(n, r.pile);
    dates.add(r.date);
  }
  const totals = new Map(siteTotals(ours).map((t) => [t.date, t]));

  const rows: ComparedRow[] = [];
  const missingInOurs: Comparison['missingInOurs'] = [];
  const named = new Set<string>();
  const compare = (pile: string, date: string, mine: number, ref: number, limitPct: number) => {
    const diffPct =
      ref === 0
        ? mine === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : ((mine - ref) / Math.abs(ref)) * 100;
    rows.push({
      pile,
      date,
      ours: mine,
      reference: ref,
      diffPct,
      limitPct,
      ok: Math.abs(diffPct) <= limitPct,
    });
  };
  for (const ref of reference) {
    const n = ref.total ? norm(TOTAL) : norm(ref.pile);
    named.add(`${n}|${ref.date}`);
    const lacks = (why: string) => {
      missingInOurs.push({ pile: ref.pile, date: ref.date, why });
    };
    if (ref.total) {
      const t = totals.get(ref.date);
      if (t) compare(TOTAL, ref.date, t.volume, ref.volume, totalPct);
      else lacks(dates.has(ref.date) ? 'no pile has a figure on this date' : 'no such date');
      continue;
    }
    if (shared.has(n)) lacks('several piles of this name');
    else if (!names.has(n)) lacks('no pile of this name');
    else {
      const mine = byKey.get(`${n}|${ref.date}`);
      if (!mine) lacks('no such date');
      else if (mine.volume === null) lacks(`no figure: ${mine.status || 'no status'}`);
      else compare(mine.pile, ref.date, mine.volume, ref.volume, pilePct);
    }
  }
  const missingInReference = [
    ...ours
      .filter((r) => !named.has(`${norm(r.pile)}|${r.date}`))
      .map((r) => ({ pile: r.pile, date: r.date })),
    ...[...totals.values()]
      .filter((t) => !named.has(`${norm(TOTAL)}|${t.date}`))
      .map((t) => ({ pile: TOTAL, date: t.date })),
  ];
  return {
    rows,
    missingInOurs,
    missingInReference,
    duplicates: [...shared].map((n) => names.get(n) ?? n),
    ok: rows.every((r) => r.ok),
  };
}

const signed = (pct: number): string =>
  Number.isFinite(pct) ? `${pct < 0 ? '-' : '+'}${Math.abs(pct).toFixed(2)}` : '+inf';

/** The comparison as a table a person reads in a test log, then what only one side has. */
export function formatComparison(c: Comparison): string {
  const head = ['pile', 'date', 'ours m3', 'reference m3', 'diff %', 'limit %', 'result'];
  const body = c.rows.map((r) => [
    r.pile,
    r.date,
    r.ours.toFixed(1),
    r.reference.toFixed(1),
    signed(r.diffPct),
    String(r.limitPct),
    r.ok ? 'ok' : 'FAIL',
  ]);
  const width = head.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  // names and dates to the left, figures to the right; the last column is never padded
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) =>
        i === cells.length - 1
          ? cell
          : i < 2
            ? cell.padEnd(width[i] ?? 0)
            : cell.padStart(width[i] ?? 0),
      )
      .join('  ');
  const out = [line(head), ...body.map(line)];
  const failed = c.rows.filter((r) => !r.ok).length;
  out.push(
    '',
    c.rows.length === 0
      ? 'No figure could be compared: no pile and date of the reference has a figure in the app.'
      : failed === 0
        ? `All ${String(c.rows.length)} compared figures within their limits.`
        : `${String(failed)} of ${String(c.rows.length)} compared figures outside its limit.`,
  );
  if (c.duplicates.length > 0)
    out.push(
      '',
      'Several piles share a name (not compared):',
      ...c.duplicates.map((n) => `  ${n}`),
    );
  if (c.missingInOurs.length > 0)
    out.push(
      '',
      'In the reference, not in the app:',
      ...c.missingInOurs.map((m) => `  ${m.pile} ${m.date} (${m.why})`),
    );
  if (c.missingInReference.length > 0)
    out.push(
      '',
      'In the app, not in the reference:',
      ...c.missingInReference.map((m) => `  ${m.pile} ${m.date}`),
    );
  return out.join('\n');
}
