import type { z } from 'zod';
import type { AssetTag as AssetTagSchema, ClassCatalogue, SeverityModel } from '@aio/schema';

type AssetTag = z.infer<typeof AssetTagSchema>;

/** The 12 area group nodes of the plant GLB with the labels of the original viewer. */
export const ALZOUR_GROUPS: readonly (readonly [node: string, label: string])[] = [
  ['Area_10_Jetty', '10 · Jetty & berths'],
  ['Area_20_LNG_Tanks', '20 · LNG tanks'],
  ['Area_30_HP_Process', '30 · HP LNG process'],
  ['Area_40_BOG', '40 · BOG handling'],
  ['Area_50_Sendout_Seawater', '50 · Send-out & sea water'],
  ['Area_60_Flare', '60 · Flare'],
  ['Area_70_Utilities', '70 · Utilities'],
  ['Area_80_Buildings', '80 · Buildings'],
  ['Pipe_Racks_Site', 'Site pipe racks'],
  ['Site_Infrastructure', 'Roads, fences & paving'],
  ['Site_Terrain', 'Terrain & sea'],
  ['Context_Indicative', 'Design vessels (indicative)'],
];

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(f);
      f = '';
    } else if (c === '\n') {
      row.push(f);
      rows.push(row);
      row = [];
      f = '';
    } else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}

/** One row of `KIPIC_AlZour_Asset_Register.csv`. */
export interface RegisterRow {
  node: string;
  tag: string;
  name: string;
  type: string;
  area: string;
  group: string;
  plantE: number | null;
  plantN: number | null;
  utmE: number | null;
  utmN: number | null;
  baseEl: number | null;
  heightM: number | null;
  topEl: number | null;
  heightSource: string;
  hasGeometry: boolean;
  sourceSheet: string;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

export function parseRegister(text: string): RegisterRow[] {
  const [head, ...rows] = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!head) return [];
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`Asset register has no "${name}" column`);
    return i;
  };
  const c = {
    node: col('node'),
    tag: col('tag'),
    name: col('name'),
    type: col('type'),
    area: col('area'),
    group: col('group'),
    plantE: col('plant_E'),
    plantN: col('plant_N'),
    utmE: col('utm39_E'),
    utmN: col('utm39_N'),
    baseEl: col('base_EL'),
    heightM: col('height_m'),
    topEl: col('top_EL'),
    heightSource: col('height_source'),
    hasGeometry: col('has_geometry'),
    sourceSheet: col('source_sheet'),
  };
  return rows
    .filter((r) => r.length > 1 && (r[c.node] ?? '') !== '')
    .map((r) => ({
      node: r[c.node] ?? '',
      tag: (r[c.tag] ?? '').trim(),
      name: (r[c.name] ?? '').trim(),
      type: r[c.type] ?? '',
      area: r[c.area] ?? '',
      group: r[c.group] ?? '',
      plantE: num(r[c.plantE]),
      plantN: num(r[c.plantN]),
      utmE: num(r[c.utmE]),
      utmN: num(r[c.utmN]),
      baseEl: num(r[c.baseEl]),
      heightM: num(r[c.heightM]),
      topEl: num(r[c.topEl]),
      heightSource: r[c.heightSource] ?? '',
      hasGeometry: (r[c.hasGeometry] ?? '').toLowerCase() === 'yes',
      sourceSheet: r[c.sourceSheet] ?? '',
    }));
}

/**
 * Mesh layer tags from the register: every tagged row whose node exists in the model, with the
 * area group label as `area` (the stage groups callouts by it).
 */
export function registerTags(rows: readonly RegisterRow[], nodes: ReadonlySet<string>): AssetTag[] {
  const label = new Map(ALZOUR_GROUPS);
  const out: AssetTag[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.tag || !nodes.has(r.node) || seen.has(r.node)) continue;
    seen.add(r.node);
    const area = label.get(r.group);
    out.push(area ? { node: r.node, tag: r.tag, area } : { node: r.node, tag: r.tag });
  }
  const order = new Map(ALZOUR_GROUPS.map(([, l], i) => [l, i]));
  return out.sort(
    (a, b) =>
      (order.get(a.area ?? '') ?? 99) - (order.get(b.area ?? '') ?? 99) ||
      a.tag.localeCompare(b.tag, 'en', { numeric: true }),
  );
}

/** Severity scale for plant inspection findings (5 most urgent), with the action each level asks for. */
export const PLANT_SEVERITY_MODEL: SeverityModel = {
  id: 'plant-inspection',
  name: 'Plant inspection',
  levels: [
    {
      value: 1,
      label: 'Observation',
      color: '#6fc3ff',
      criteria: 'Cosmetic or housekeeping item, no effect on integrity or operation.',
      action: 'Record',
    },
    {
      value: 2,
      label: 'Low',
      color: '#8fd14f',
      criteria:
        'Early deterioration (light surface rust, minor coating or insulation damage) with no loss of function.',
      action: 'Next planned maintenance',
    },
    {
      value: 3,
      label: 'Medium',
      color: '#fad34b',
      criteria:
        'Active deterioration that will affect integrity if left (coating breakdown, corrosion on supports, damaged cladding, missing fixings).',
      action: 'Repair within 6 months',
    },
    {
      value: 4,
      label: 'High',
      color: '#ff7a2d',
      criteria:
        'Defect that affects a containment, structural or safety function (section loss, deformation, failed insulation on cryogenic lines, leak signs).',
      action: 'Repair within 1 month',
    },
    {
      value: 5,
      label: 'Critical',
      color: '#ee3f4b',
      criteria:
        'Loss of containment, imminent structural failure or a direct risk to people (gas leak, vapour cloud, fire hazard, collapse risk).',
      action: 'Act now, notify operations',
    },
  ],
  uncertain: { label: 'To be confirmed', color: '#a78bfa' },
};

/** Issue classes for a drone survey of an LNG import terminal. */
export const PLANT_CATALOGUE: ClassCatalogue = {
  id: 'lng-terminal',
  name: 'LNG terminal',
  assetType: 'plant',
  classes: [
    { id: 'corrosion', label: 'Corrosion', color: '#c9824a', hotkey: 'r' },
    { id: 'coating-damage', label: 'Coating damage', color: '#fad34b', hotkey: 'c' },
    {
      id: 'insulation-damage',
      label: 'Insulation or cladding damage',
      color: '#6fc3ff',
      hotkey: 'i',
    },
    { id: 'leak', label: 'Leak, stain or frost spot', color: '#ee3f4b', hotkey: 'l' },
    { id: 'structural', label: 'Structural damage or deformation', color: '#ff7a2d', hotkey: 's' },
    { id: 'missing-part', label: 'Missing or loose component', color: '#f472b6', hotkey: 'm' },
    {
      id: 'civil',
      label: 'Civil works (concrete, paving, drainage)',
      color: '#a3a3a3',
      hotkey: 'v',
    },
    {
      id: 'marine',
      label: 'Marine structure (jetty, fenders, revetment)',
      color: '#22d3ee',
      hotkey: 'j',
    },
    { id: 'safety', label: 'Safety or access hazard', color: '#e11d48', hotkey: 'h' },
    { id: 'housekeeping', label: 'Housekeeping or obstruction', color: '#8fd14f', hotkey: 'k' },
  ].map((c) => ({ ...c, severityModel: PLANT_SEVERITY_MODEL.id })),
};
