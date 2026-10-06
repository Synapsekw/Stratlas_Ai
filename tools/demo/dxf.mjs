// A small DXF (R12, ASCII) writer and reader for the M8 drawing fixtures: layers, blocks, LINE,
// CIRCLE, closed POLYLINE, TEXT, POINT and INSERT. R12 needs no handles or object tables, and
// every DXF reader takes it. Numbers are written with fixed rounding, lines end in LF, and
// nothing but the drawing goes in (no author, no file path, no save time).

/** `$INSUNITS` codes. */
export const INSUNITS = { in: 1, ft: 2, mm: 4, cm: 5, m: 6, 'us-ft': 21 };

const fmt = (v) => {
  const s = (Math.round(v * 1e4) / 1e4).toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

function pairs(out, list) {
  for (const [code, value] of list)
    out.push(String(code), typeof value === 'number' ? fmt(value) : value);
}

function entity(out, e) {
  const L = [8, e.layer];
  switch (e.type) {
    case 'LINE':
      pairs(out, [
        [0, 'LINE'],
        L,
        [10, e.a[0]],
        [20, e.a[1]],
        [30, 0],
        [11, e.b[0]],
        [21, e.b[1]],
        [31, 0],
      ]);
      break;
    case 'CIRCLE':
      pairs(out, [[0, 'CIRCLE'], L, [10, e.c[0]], [20, e.c[1]], [30, 0], [40, e.r]]);
      break;
    case 'POINT':
      pairs(out, [[0, 'POINT'], L, [10, e.at[0]], [20, e.at[1]], [30, 0]]);
      break;
    case 'TEXT':
      pairs(out, [[0, 'TEXT'], L, [10, e.at[0]], [20, e.at[1]], [30, 0], [40, e.h], [1, e.text]]);
      break;
    case 'INSERT':
      pairs(out, [
        [0, 'INSERT'],
        L,
        [2, e.block],
        [10, e.at[0]],
        [20, e.at[1]],
        [30, 0],
        [50, e.rotation ?? 0],
      ]);
      break;
    case 'POLYLINE':
      pairs(out, [
        [0, 'POLYLINE'],
        L,
        [66, '1'],
        [10, 0],
        [20, 0],
        [30, 0],
        [70, e.closed ? '1' : '0'],
      ]);
      for (const p of e.points) pairs(out, [[0, 'VERTEX'], L, [10, p[0]], [20, p[1]], [30, 0]]);
      pairs(out, [[0, 'SEQEND'], L]);
      break;
    default:
      throw new Error(`dxf: entity ${e.type}`);
  }
}

/**
 * The DXF text of a drawing. `units` names `$INSUNITS` (omit for a unitless drawing);
 * `layers` [{ name, colour }]; `blocks` { name: entities[] } (base point 0, 0).
 */
export function writeDxf({ units, layers, blocks = {}, entities }) {
  const out = [];
  const xs = [];
  const ys = [];
  for (const e of entities)
    for (const p of [e.a, e.b, e.c, e.at, ...(e.points ?? [])].filter(Boolean)) {
      xs.push(p[0] - (e.r ?? 0), p[0] + (e.r ?? 0));
      ys.push(p[1] - (e.r ?? 0), p[1] + (e.r ?? 0));
    }
  const head = [
    [9, '$ACADVER'],
    [1, 'AC1009'],
    [9, '$EXTMIN'],
    [10, Math.min(...xs)],
    [20, Math.min(...ys)],
    [30, 0],
    [9, '$EXTMAX'],
    [10, Math.max(...xs)],
    [20, Math.max(...ys)],
    [30, 0],
    [9, '$MEASUREMENT'],
    [70, units && units !== 'in' && units !== 'ft' && units !== 'us-ft' ? '1' : '0'],
  ];
  if (units) head.push([9, '$INSUNITS'], [70, String(INSUNITS[units])]);
  pairs(out, [[0, 'SECTION'], [2, 'HEADER'], ...head, [0, 'ENDSEC']]);
  pairs(out, [
    [0, 'SECTION'],
    [2, 'TABLES'],
    [0, 'TABLE'],
    [2, 'LTYPE'],
    [70, '1'],
  ]);
  pairs(out, [
    [0, 'LTYPE'],
    [2, 'CONTINUOUS'],
    [70, '0'],
    [3, 'Solid line'],
    [72, '65'],
    [73, '0'],
    [40, 0],
  ]);
  pairs(out, [
    [0, 'ENDTAB'],
    [0, 'TABLE'],
    [2, 'LAYER'],
    [70, String(layers.length)],
  ]);
  for (const l of layers)
    pairs(out, [
      [0, 'LAYER'],
      [2, l.name],
      [70, '0'],
      [62, String(l.colour ?? 7)],
      [6, 'CONTINUOUS'],
    ]);
  pairs(out, [
    [0, 'ENDTAB'],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'BLOCKS'],
  ]);
  for (const [name, list] of Object.entries(blocks)) {
    pairs(out, [
      [0, 'BLOCK'],
      [8, '0'],
      [2, name],
      [70, '0'],
      [10, 0],
      [20, 0],
      [30, 0],
      [3, name],
    ]);
    for (const e of list) entity(out, e);
    pairs(out, [
      [0, 'ENDBLK'],
      [8, '0'],
    ]);
  }
  pairs(out, [
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'ENTITIES'],
  ]);
  for (const e of entities) entity(out, e);
  pairs(out, [
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ]);
  return `${out.join('\n')}\n`;
}

/**
 * Read a DXF written by writeDxf (and simple R12 files like it): header variables, layer names,
 * blocks and entities. Throws with the line number on a malformed group.
 */
export function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const groups = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    if (code === '' && i === lines.length - 1) break;
    if (!/^-?\d+$/.test(code)) throw new Error(`DXF line ${i + 1}: "${code}" is not a group code`);
    groups.push([Number(code), lines[i + 1]]);
  }
  const doc = { header: {}, layers: [], blocks: {}, entities: [] };
  let section = null;
  let i = 0;
  let current = null;
  let target = null;
  let block = null;
  let poly = null;
  const val = (v) => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v);
  let ended = false;
  while (i < groups.length) {
    const [code, raw] = groups[i++];
    const v = raw.trim();
    if (code === 0 && v === 'EOF') {
      ended = true;
      break;
    }
    if (code === 0 && v === 'SECTION') {
      section = groups[i++][1].trim();
      continue;
    }
    if (code === 0 && v === 'ENDSEC') {
      section = null;
      continue;
    }
    if (section === 'HEADER') {
      if (code === 9) current = v;
      else if (current) {
        doc.header[current] = doc.header[current] ?? {};
        doc.header[current][code] = val(raw);
      }
      continue;
    }
    if (section === 'TABLES') {
      if (code === 0 && v === 'LAYER') current = 'LAYER';
      else if (code === 0) current = null;
      else if (current === 'LAYER' && code === 2) doc.layers.push(v);
      continue;
    }
    if (section === 'BLOCKS' || section === 'ENTITIES') {
      if (code === 0) {
        if (v === 'BLOCK') {
          target = [];
          block = { type: 'BLOCK' };
          current = block;
          continue;
        }
        if (v === 'ENDBLK') {
          doc.blocks[block.name] = target;
          target = null;
          current = { type: 'ENDBLK' };
          continue;
        }
        if (v === 'VERTEX') {
          current = { type: 'VERTEX' };
          poly.points.push(current);
          continue;
        }
        if (v === 'SEQEND') {
          poly.points = poly.points.map((p) => [p[10], p[20]]);
          poly = null;
          current = { type: 'SEQEND' };
          continue;
        }
        current = { type: v };
        if (v === 'POLYLINE') {
          poly = current;
          current.points = [];
        }
        (section === 'BLOCKS' ? target : doc.entities).push(current);
        continue;
      }
      if (!current) continue;
      if (current.type === 'BLOCK' && code === 2) current.name = v;
      else if (code === 8) current.layer = v;
      else if (code === 1) current.text = raw;
      else if (code === 2) current.block = v;
      else current[code] = val(raw);
    }
  }
  if (!ended) throw new Error('DXF: no EOF (the file is cut short)');
  return doc;
}
