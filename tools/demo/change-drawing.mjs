// The fictional plot plan of the change demo site (later date): a DXF in metres on a plant grid
// (drawing X = 1000 + x east, drawing Y = 2000 - z north), with tank circles and tags, building and
// equipment outlines, the pipe centreline with valve blocks, height text and four control points.
// Also the error-path twins (no units, cut short) and a raster render of the plan.
import { encodePng } from './formats.mjs';
import { BOXES, PIPE, TANKS, boxOn } from './change-scene.mjs';
import { writeDxf } from './dxf.mjs';

export const GRID = { e: 1000, n: 2000 };
/** Local [x, z] to drawing [X, Y] (metres). */
export const toDrawing = (x, z) => [GRID.e + x, GRID.n - z];

export const PLAN_LAYERS = [
  { name: 'TANKS', colour: 1 },
  { name: 'BUILDINGS', colour: 3 },
  { name: 'EQUIPMENT', colour: 4 },
  { name: 'PIPES', colour: 5 },
  { name: 'TAGS', colour: 7 },
  { name: 'HEIGHTS', colour: 2 },
  { name: 'CONTROL', colour: 6 },
  { name: 'TITLE', colour: 7 },
];

/** Control points: drawing coordinates and the local point (y 0) they mark. */
export const CONTROL = [
  { id: 'CP1', local: [-40, 0, 40] },
  { id: 'CP2', local: [40, 0, 40] },
  { id: 'CP3', local: [40, 0, -40] },
  { id: 'CP4', local: [-40, 0, -40] },
].map((c) => ({ ...c, drawing: toDrawing(c.local[0], c.local[2]) }));

const VALVE = [
  { type: 'LINE', layer: '0', a: [-0.4, -0.3], b: [0.4, 0.3] },
  { type: 'LINE', layer: '0', a: [0.4, 0.3], b: [0.4, -0.3] },
  { type: 'LINE', layer: '0', a: [0.4, -0.3], b: [-0.4, 0.3] },
  { type: 'LINE', layer: '0', a: [-0.4, 0.3], b: [-0.4, -0.3] },
];
const NORTH = [
  { type: 'LINE', layer: '0', a: [0, -2], b: [0, 2] },
  { type: 'LINE', layer: '0', a: [0, 2], b: [-0.8, 0.6] },
  { type: 'LINE', layer: '0', a: [0, 2], b: [0.8, 0.6] },
  { type: 'TEXT', layer: '0', at: [-0.4, 2.4], h: 1, text: 'N' },
];

/** What the plan holds, with the parts a model builder should make from it. */
export function plotPlan() {
  const e = [];
  const parts = [];
  for (const t of TANKS) {
    const c = toDrawing(t.cx, t.cz);
    e.push({ type: 'CIRCLE', layer: 'TANKS', c, r: t.R });
    e.push({ type: 'TEXT', layer: 'TAGS', at: [c[0] - 1.5, c[1] + 0.5], h: 1, text: t.tag });
    e.push({
      type: 'TEXT',
      layer: 'HEIGHTS',
      at: [c[0] - 1.5, c[1] - 1.5],
      h: 0.8,
      text: `H=${t.H.toFixed(1)}`,
    });
    parts.push({
      kind: 'cylinder',
      tag: t.tag,
      layer: 'TANKS',
      base: [t.cx, 0, t.cz],
      radius: t.R,
      height: t.H,
    });
  }
  for (const b0 of BOXES) {
    const b = boxOn(b0, 'd2');
    if (!b) continue;
    const [hx, hz] = [b.size[0] / 2, b.size[2] / 2];
    const ring = [
      [b.c[0] - hx, b.c[2] - hz],
      [b.c[0] + hx, b.c[2] - hz],
      [b.c[0] + hx, b.c[2] + hz],
      [b.c[0] - hx, b.c[2] + hz],
    ];
    const layer = b.kind === 'building' || b.kind === 'shelter' ? 'BUILDINGS' : 'EQUIPMENT';
    e.push({
      type: 'POLYLINE',
      layer,
      closed: true,
      points: ring.map(([x, z]) => toDrawing(x, z)),
    });
    const c = toDrawing(b.c[0], b.c[2]);
    e.push({ type: 'TEXT', layer: 'TAGS', at: [c[0] - 1, c[1] + 0.2], h: 0.6, text: b.tag });
    e.push({
      type: 'TEXT',
      layer: 'HEIGHTS',
      at: [c[0] - 1, c[1] - 0.8],
      h: 0.5,
      text: `H=${b.size[1].toFixed(2)}`,
    });
    parts.push(
      layer === 'BUILDINGS'
        ? { kind: 'extrusion', tag: b.tag, layer, footprint: ring, baseY: 0, height: b.size[1] }
        : {
            kind: 'box',
            tag: b.tag,
            layer,
            centre: [b.c[0], b.size[1] / 2, b.c[2]],
            size: b.size,
            rotY: 0,
          },
    );
  }
  const a = toDrawing(PIPE.a[0], PIPE.a[2]);
  const b = toDrawing(PIPE.b[0], PIPE.b[2]);
  e.push({ type: 'LINE', layer: 'PIPES', a, b });
  e.push({
    type: 'TEXT',
    layer: 'TAGS',
    at: [a[0] + 2, a[1] + 0.6],
    h: 0.6,
    text: `${PIPE.tag} EL ${PIPE.a[1].toFixed(1)}`,
  });
  for (const x of [-4, 12])
    e.push({ type: 'INSERT', layer: 'PIPES', block: 'VALVE', at: toDrawing(x, PIPE.a[2]) });
  parts.push({
    kind: 'pipe',
    tag: PIPE.tag,
    layer: 'PIPES',
    from: PIPE.a,
    to: PIPE.b,
    radius: PIPE.r,
  });
  for (const c of CONTROL) {
    e.push({ type: 'POINT', layer: 'CONTROL', at: c.drawing });
    e.push({
      type: 'TEXT',
      layer: 'CONTROL',
      at: [c.drawing[0] + 0.5, c.drawing[1] + 0.5],
      h: 0.8,
      text: c.id,
    });
  }
  e.push({ type: 'INSERT', layer: 'TITLE', block: 'NORTH', at: toDrawing(44, -44) });
  e.push({
    type: 'TEXT',
    layer: 'TITLE',
    at: toDrawing(-44, 46),
    h: 1.2,
    text: 'Demo change site plot plan (fictional, synthetic demo data)',
  });
  return { entities: e, blocks: { VALVE, NORTH }, parts };
}

/** The plan DXF in metres with `$INSUNITS` 6. */
export function plotPlanDxf() {
  const p = plotPlan();
  return writeDxf({ units: 'm', layers: PLAN_LAYERS, blocks: p.blocks, entities: p.entities });
}

/** The same plan drawn in millimetres with no units in the file (import must ask for them). */
export function unitlessDxf() {
  const p = plotPlan();
  const k = 1000;
  const s = (pt) => pt && pt.map((v) => v * k);
  const scale = (e) => ({
    ...e,
    a: s(e.a),
    b: s(e.b),
    c: s(e.c),
    at: s(e.at),
    r: e.r && e.r * k,
    h: e.h && e.h * k,
    points: e.points && e.points.map(s),
  });
  const clean = (e) =>
    Object.fromEntries(Object.entries(scale(e)).filter(([, v]) => v !== undefined));
  return writeDxf({
    layers: PLAN_LAYERS,
    blocks: Object.fromEntries(Object.entries(p.blocks).map(([n, l]) => [n, l.map(clean)])),
    entities: p.entities.map(clean),
  });
}

/** A plan cut short in the middle of its entities, with a broken group code: refused cleanly. */
export function brokenDxf() {
  const text = plotPlanDxf();
  const at = text.indexOf('ENTITIES');
  const cut = text.indexOf('CIRCLE', at + 200);
  return `${text.slice(0, cut)}CIRCLE\n8\nTANKS\nten\n1012.5\n`;
}

/**
 * A raster render of the plan (lines, circles and outlines; no text): 8-bit grey PNG, white paper,
 * black ink. `px` metres per pixel; pixel (0, 0) is the top-left corner at drawing `origin`.
 */
export function planRaster(px = 0.125) {
  const { entities } = plotPlan();
  const origin = toDrawing(-48, -48);
  const size = Math.round(96 / px);
  const img = new Uint8Array(size * size).fill(255);
  const dot = (X, Y) => {
    const i = Math.floor((X - origin[0]) / px);
    const j = Math.floor((origin[1] - Y) / px);
    if (i >= 0 && j >= 0 && i < size && j < size) img[j * size + i] = 0;
  };
  const line = (a, b) => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (px / 2)) + 1;
    for (let k = 0; k <= n; k++)
      dot(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
  };
  for (const e of entities) {
    if (e.type === 'LINE') line(e.a, e.b);
    if (e.type === 'POLYLINE')
      e.points.forEach((p, k) => line(p, e.points[(k + 1) % e.points.length]));
    if (e.type === 'CIRCLE') {
      const n = Math.ceil((2 * Math.PI * e.r) / (px / 2));
      for (let k = 0; k < n; k++) {
        const t = (2 * Math.PI * k) / n;
        dot(e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t));
      }
    }
    if (e.type === 'POINT') {
      line([e.at[0] - 0.6, e.at[1]], [e.at[0] + 0.6, e.at[1]]);
      line([e.at[0], e.at[1] - 0.6], [e.at[0], e.at[1] + 0.6]);
    }
  }
  return {
    png: encodePng({ width: size, height: size, channels: 1, depth: 8, data: img }),
    width: size,
    height: size,
    px,
    origin,
  };
}
