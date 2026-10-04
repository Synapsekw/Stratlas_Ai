import {
  classInfo,
  epsgOf,
  issueLocation,
  issueZone,
  severityInfo,
  sortByCode,
  type ExportContext,
} from './facts';

/** The issues CSV columns. Stable: new columns are only ever appended. */
export const CSV_COLUMNS = [
  'code',
  'id',
  'title',
  'class_id',
  'class',
  'severity',
  'severity_label',
  'severity_model',
  'status',
  'zone',
  'sightings',
  'datasets',
  'photos',
  'crs',
  'easting',
  'northing',
  'height',
  'lon',
  'lat',
  'author',
  'created_at',
  'updated_at',
  'source',
  'note',
] as const;

const BOM = String.fromCharCode(0xfeff);

const fixed = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(digits);

function cell(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 CSV (CRLF rows, UTF-8 with a byte order mark so spreadsheets read Arabic text). */
export function issuesCsv(ctx: ExportContext): string {
  const m = ctx.manifest;
  const epsg = epsgOf(m);
  const crs = 'epsg' in m.crs ? `EPSG:${String(m.crs.epsg)}` : 'WKT';
  const lines = [CSV_COLUMNS.join(',')];
  for (const issue of sortByCode(ctx.issues)) {
    const sev = severityInfo(m, issue);
    const loc = issueLocation(m, issue);
    const photos = [
      ...new Set(issue.sightings.flatMap((s) => (s.on === 'image' ? [s.photo] : []))),
    ];
    const datasets = [...new Set(issue.sightings.map((s) => s.on))];
    const row: Record<(typeof CSV_COLUMNS)[number], string> = {
      code: issue.code,
      id: issue.id,
      title: issue.title,
      class_id: issue.classId,
      class: classInfo(m, issue.classId).label,
      severity: String(issue.severity),
      severity_label: sev.label,
      severity_model: sev.model,
      status: issue.status,
      zone: issueZone(issue),
      sightings: String(issue.sightings.length),
      datasets: datasets.join(' '),
      photos: photos.join(' '),
      crs,
      easting: fixed(loc?.project[0], 3),
      northing: fixed(loc?.project[1], 3),
      height: fixed(loc?.project[2], 3),
      lon: epsg === null ? '' : fixed(loc?.wgs84?.[0], 8),
      lat: epsg === null ? '' : fixed(loc?.wgs84?.[1], 8),
      author: issue.author,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      source: issue.source,
      note: issue.note,
    };
    lines.push(CSV_COLUMNS.map((c) => cell(row[c])).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Parse RFC 4180 CSV (quoted fields, CRLF or LF rows, optional BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
