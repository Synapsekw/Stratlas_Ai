import type { Issue, SeverityModel, Vec3 } from '@aio/schema';
import { isPlacedArea } from '../model/placed';
import { pinPasses, type PinFilter } from './declutter';
import { centroid, severityColor } from './mesh';

/**
 * Findings placed on a model, as the overlay draws them (spec section 5): a mesh outline is a
 * surface ring, a cloud prism a ring at its base with a height. Pure, apart from the colours.
 */
export interface IssueArea {
  issueId: string;
  code: string;
  title: string;
  color: string;
  layer: string;
  kind: 'surface' | 'prism';
  ring: Vec3[];
  height: number;
  centre: Vec3;
}

/** The areas to draw: placed outlines and prisms on shown layers of issues the filter passes. */
export function issueAreas(
  issues: readonly Issue[],
  models: readonly SeverityModel[],
  selectedId: string | null,
  filter: PinFilter,
  hidden: Readonly<Record<string, true>>,
): IssueArea[] {
  const out: IssueArea[] = [];
  for (const i of issues) {
    if (i.id !== selectedId && !pinPasses(i.severity, filter)) continue;
    const color = severityColor(
      models.find((m) => m.id === i.severityModelId),
      i.severity,
    );
    for (const s of i.sightings) {
      if (!isPlacedArea(s) || hidden[s.layer]) continue;
      const base = { issueId: i.id, code: i.code, title: i.title, color, layer: s.layer };
      if (s.on === 'mesh' && s.geom.type === 'spolygon')
        out.push({
          ...base,
          kind: 'surface',
          ring: s.geom.points,
          height: 0,
          centre: centroid(s.geom.points),
        });
      else if (s.on === 'pointcloud' && s.geom.type === 'polygon3') {
        const height = s.geom.height ?? 0;
        const c = centroid(s.geom.points);
        out.push({
          ...base,
          kind: 'prism',
          ring: s.geom.points,
          height,
          centre: [c[0], c[1] + height / 2, c[2]],
        });
      }
    }
  }
  return out;
}

export interface AreaBuffers {
  /** Line segment end points, xyz. */
  lines: Float32Array;
  lineColors: Float32Array;
  /** Fill triangles, xyz. */
  fill: Float32Array;
  fillColors: Float32Array;
}

const lift = (p: Vec3, h: number): Vec3 => [p[0], p[1] + h, p[2]];

/** One draw for every area's lines and one for every fill; highlighted areas lighter. */
export function areaBuffers(
  areas: readonly IssueArea[],
  highlight: ReadonlySet<string>,
  rgb: (css: string) => [number, number, number],
): AreaBuffers {
  const lines: number[] = [];
  const lineColors: number[] = [];
  const fill: number[] = [];
  const fillColors: number[] = [];
  for (const a of areas) {
    const [r, g, b] = rgb(a.color);
    const k = highlight.has(a.issueId) ? 0.35 : 0;
    const lc = [r + (1 - r) * k, g + (1 - g) * k, b + (1 - b) * k];
    const fc = [r + (1 - r) * k * 0.5, g + (1 - g) * k * 0.5, b + (1 - b) * k * 0.5];
    const seg = (p: Vec3, q: Vec3) => {
      lines.push(...p, ...q);
      lineColors.push(...lc, ...lc);
    };
    const tri = (p: Vec3, q: Vec3, s: Vec3) => {
      fill.push(...p, ...q, ...s);
      fillColors.push(...fc, ...fc, ...fc);
    };
    const n = a.ring.length;
    const mid = centroid(a.ring);
    for (let i = 0; i < n; i++) {
      const p = a.ring[i];
      const q = a.ring[(i + 1) % n];
      if (!p || !q) continue;
      seg(p, q);
      tri(mid, p, q);
      if (a.kind === 'prism') {
        const pt = lift(p, a.height);
        const qt = lift(q, a.height);
        seg(pt, qt);
        seg(p, pt);
        tri(lift(mid, a.height), pt, qt);
        tri(p, q, qt);
        tri(p, qt, pt);
      }
    }
  }
  return {
    lines: Float32Array.from(lines),
    lineColors: Float32Array.from(lineColors),
    fill: Float32Array.from(fill),
    fillColors: Float32Array.from(fillColors),
  };
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** An area on the screen: its projected rings (base and top for a prism) and its centre. */
export interface AreaHit {
  issueId: string;
  rings: ScreenPoint[][];
  centre: ScreenPoint | null;
}

/** One entry per area, in order; rings with a point off screen are left out. */
export function screenAreas(
  areas: readonly IssueArea[],
  project: (p: Vec3) => ScreenPoint | null,
): AreaHit[] {
  return areas.map((a) => {
    const rings: ScreenPoint[][] = [];
    for (const h of a.kind === 'prism' ? [0, a.height] : [0]) {
      const pts = a.ring.map((p) => project(lift(p, h)));
      if (pts.length >= 3 && pts.every((p): p is ScreenPoint => p !== null)) rings.push(pts);
    }
    return { issueId: a.issueId, rings, centre: project(a.centre) };
  });
}

const inside = (ring: readonly ScreenPoint[], x: number, y: number) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
};

const area = (ring: readonly ScreenPoint[]) => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
};

/** The issue of the smallest area under a screen point, or null. */
export function hitArea(hits: readonly AreaHit[], x: number, y: number): string | null {
  let best: { id: string; size: number } | null = null;
  for (const h of hits)
    for (const r of h.rings) {
      if (!inside(r, x, y)) continue;
      const size = area(r);
      if (!best || size < best.size) best = { id: h.issueId, size };
    }
  return best?.id ?? null;
}
