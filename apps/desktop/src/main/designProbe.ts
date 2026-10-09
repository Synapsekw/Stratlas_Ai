/**
 * A quick look at a design file before **Import design** (`survey:probeDesign`, M11 G6 gap): the
 * format (as `design.import` detects it), the units the file states (DXF `$INSUNITS`, LandXML
 * `Units`) and its source layer names (the names `design.import` takes in `layers`: DXF layers
 * with entities, LandXML surfaces, point groups and alignments, 12da models and tins, the CSV
 * file's name). Read as text, at most `MAX_BYTES`; a larger file answers what its head says and
 * `partial`. Nothing is written and nothing is parsed beyond names, so it stays cheap.
 */
import type { DesignFormat, DesignSourceUnits, IpcResponse } from '@aio/schema';
import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/** Read at most this much of a file (a larger one is probed from its head). */
export const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LAYERS = 1000;

const EXTENSIONS: Readonly<Record<string, DesignFormat>> = {
  '.xml': 'landxml',
  '.landxml': 'landxml',
  '.dxf': 'dxf',
  '.12da': '12da',
  '.csv': 'csv',
  '.txt': 'csv',
  '.pnezd': 'csv',
  '.ttm': 'ttm',
};

/** DXF `$INSUNITS` codes (as `aio_pipelines/design/dxf.py`). */
const INSUNITS: Readonly<Record<number, DesignSourceUnits>> = {
  1: 'in',
  2: 'ft',
  4: 'mm',
  5: 'cm',
  6: 'm',
  21: 'us-ft',
};

/** LandXML `linearUnit` (as `aio_pipelines/design/landxml.py`). */
const LINEAR_UNITS: Readonly<Record<string, DesignSourceUnits>> = {
  meter: 'm',
  metre: 'm',
  millimeter: 'mm',
  millimetre: 'mm',
  centimeter: 'cm',
  centimetre: 'cm',
  foot: 'ft',
  ussurveyfoot: 'us-ft',
  inch: 'in',
};

export interface DesignProbe {
  format: DesignFormat | null;
  units: DesignSourceUnits | null;
  layers: string[];
}

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** The format `design.import` would read the file as, from its head and extension. */
export function detectFormat(head: string, ext: string): DesignFormat | null {
  if (head.startsWith('AutoCAD Binary DXF')) return 'dxf';
  if (head.startsWith('AC10')) return null;
  const text = head.replace(BOM, '').trimStart();
  if (text.startsWith('<?xml') || head.includes('<LandXML')) return 'landxml';
  return EXTENSIONS[ext.toLowerCase()] ?? null;
}

function unique(names: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const n = raw.trim().slice(0, 200);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_LAYERS) break;
  }
  return out;
}

/** DXF: `$INSUNITS` from the header, and the layer (code 8) of every ENTITIES entity. */
export function probeDxf(text: string): Pick<DesignProbe, 'units' | 'layers'> {
  const lines = text.split(/\r?\n/);
  let units: DesignSourceUnits | null = null;
  const layers: string[] = [];
  let section = '';
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = (lines[i] ?? '').trim();
    const value = (lines[i + 1] ?? '').trim();
    if (code === '2' && (lines[i - 2] ?? '').trim() === '0' && lines[i - 1]?.trim() === 'SECTION')
      section = value;
    else if (code === '0' && value === 'ENDSEC') section = '';
    else if (section === 'HEADER' && code === '9' && value === '$INSUNITS') {
      const n = Number((lines[i + 3] ?? '').trim());
      units = INSUNITS[n] ?? null;
    } else if (section === 'ENTITIES' && code === '8') layers.push(value);
  }
  return { units, layers: unique(layers) };
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? (m[1] ?? '') : null;
};

/** LandXML: the linear unit, and the names of its surfaces, point groups and alignments. */
export function probeLandXml(text: string): Pick<DesignProbe, 'units' | 'layers'> {
  let units: DesignSourceUnits | null = null;
  const unitTag = /<(?:Metric|Imperial)\b[^>]*>/.exec(text);
  if (unitTag) {
    const u = (attr(unitTag[0], 'linearUnit') ?? '').replace(/\s/g, '').toLowerCase();
    units = LINEAR_UNITS[u] ?? null;
  }
  const layers: string[] = [];
  const re = /<(?:Surface|CgPoints|Alignment)\b[^>]*>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = attr(m[0], 'name');
    // unnamed ones get the reader's fallback names, which only the import knows
    if (name) layers.push(name);
  }
  return { units, layers: unique(layers) };
}

/** 12da: the `model "name"` blocks and the tins' names (12da states no units). */
export function probe12da(text: string): Pick<DesignProbe, 'units' | 'layers'> {
  const layers: string[] = [];
  const re = /^\s*(model|name)\s+("([^"]*)"|(\S+))/gim;
  let inTin = false;
  const tinRe = /^\s*(tin|trimesh)\b/i;
  for (const line of text.split(/\r?\n/)) {
    if (tinRe.test(line)) inTin = true;
    re.lastIndex = 0;
    const m = re.exec(line);
    if (!m) continue;
    const word = (m[1] ?? '').toLowerCase();
    const value = m[3] ?? m[4] ?? '';
    if (word === 'model') layers.push(value);
    else if (inTin) {
      layers.push(value);
      inTin = false;
    }
  }
  return { units: null, layers: unique(layers) };
}

/** Probe a design file's text (tests call this; `probeDesign` reads the file). */
export function probeText(text: string, path: string): DesignProbe {
  const format = detectFormat(text.slice(0, 512), extname(path));
  if (format === 'dxf') return { format, ...probeDxf(text) };
  if (format === 'landxml') return { format, ...probeLandXml(text) };
  if (format === '12da') return { format, ...probe12da(text) };
  if (format === 'csv') {
    const stem = basename(path, extname(path));
    return { format, units: null, layers: stem ? [stem] : [] };
  }
  return { format, units: null, layers: [] };
}

/** `survey:probeDesign`: read the file (its head when large) and probe it. */
export async function probeDesign(path: string): Promise<IpcResponse<'survey:probeDesign'>> {
  const ext = extname(path).toLowerCase();
  if (!(ext in EXTENSIONS) && ext !== '.dwg')
    return { ok: false, error: `"${basename(path)}" is not a design file this import reads.` };
  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) return { ok: false, error: `"${basename(path)}" is not a file.` };
    size = s.size;
  } catch (e) {
    return { ok: false, error: `Could not read "${basename(path)}": ${String(e)}` };
  }
  if (ext === '.dwg') return { ok: true, format: null, units: null, layers: [], partial: false };
  const n = Math.min(size, MAX_BYTES);
  const buf = Buffer.alloc(n);
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return { ok: false, error: `Could not open "${basename(path)}".` };
  try {
    let at = 0;
    while (at < n) {
      const { bytesRead } = await fh.read(buf, at, n - at, at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
  } finally {
    await fh.close();
  }
  const text = buf.toString(ext === '.ttm' ? 'latin1' : 'utf8');
  const p = probeText(text, path);
  return { ok: true, ...p, partial: size > MAX_BYTES };
}
