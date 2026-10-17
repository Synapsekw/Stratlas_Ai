import { fromWgs84, isKnownCrs, localToProject, toWgs84 } from '@aio/geo';
import {
  isZeroShift,
  shiftEN,
  shiftLocal,
  type DateShift,
  type ImageGeom,
  type Issue,
  type IssueClass,
  type ProjectManifest,
  type SeverityModel,
  type Sighting,
  type Vec3,
} from '@aio/schema';

/**
 * The date shift of a layer, or null when it does not move (line up dates). `@aio/project` does
 * not resolve shifts itself: callers pass `dateShiftOf` of the manifest (`@aio/workspace`).
 */
export type ShiftOf = (layerId: string) => DateShift | null;

/** What every exporter reads: the project and the issues to write. */
export interface ExportContext {
  manifest: ProjectManifest;
  issues: readonly Issue[];
  /**
   * The layers' date shifts. Issue exports write the lined-up frame, where the app draws a
   * sighting (data-conventions section 38); without it the stored positions go out as they are.
   */
  shiftOf?: ShiftOf | undefined;
}

/**
 * No em or en dashes in text we write (CONTRIBUTING). Number ranges become "to", other dashes a
 * comma.
 */
export function noDashes(text: string): string {
  return text.replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2').replace(/\s*[–—]\s*/g, ', ');
}

/** Natural order of issue codes: D2 before D10. */
export function compareCodes(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function sortByCode<T extends { code: string }>(items: readonly T[]): T[] {
  return [...items].sort((x, y) => compareCodes(x.code, y.code));
}

export function severityModelOf(m: ProjectManifest, issue: Issue): SeverityModel | undefined {
  return m.severityModels.find((s) => s.id === issue.severityModelId);
}

/** Label and colour of an issue's severity in its model. */
export function severityInfo(
  m: ProjectManifest,
  issue: Issue,
): { label: string; color: string; model: string } {
  const model = severityModelOf(m, issue);
  if (issue.severity === 'uncertain') {
    return {
      label: model?.uncertain?.label ?? 'Uncertain',
      color: model?.uncertain?.color ?? '#b68ef8',
      model: model?.name ?? issue.severityModelId,
    };
  }
  const level = model?.levels.find((l) => l.value === issue.severity);
  return {
    label: level?.label ?? String(issue.severity),
    color: level?.color ?? '#8a94a6',
    model: model?.name ?? issue.severityModelId,
  };
}

/** Every class of every catalogue, first occurrence of an id wins. */
export function allClasses(m: ProjectManifest): IssueClass[] {
  const seen = new Map<string, IssueClass>();
  for (const c of m.classCatalogues)
    for (const k of c.classes) if (!seen.has(k.id)) seen.set(k.id, k);
  return [...seen.values()];
}

export function classInfo(m: ProjectManifest, classId: string): { label: string; color: string } {
  const k = allClasses(m).find((c) => c.id === classId);
  return { label: k?.label ?? classId, color: k?.color ?? '#8a94a6' };
}

/**
 * The zone an issue lies in, read from its note: the kit "Location: ..., <zone>." line, the
 * "Area: <zone>." line, a "Zone <zone>." line, or the road chainage kilometre.
 */
export function issueZone(issue: Issue): string {
  // kit: "Location: <h> m above datum, <side> side, <zone>." (the zone may hold commas)
  const sided = /Location:[^,\n]*,[^,\n]*\bside,\s*([^\n]+?)\.?\s*$/m.exec(issue.note);
  if (sided?.[1]) return sided[1].trim();
  const loc = /Location:[^\n]*?,\s*([^,\n]+?)\.?\s*$/m.exec(issue.note);
  if (loc?.[1]) return loc[1].trim();
  const area = /Area:\s*([^.\n]+)/.exec(issue.note);
  if (area?.[1]) return area[1].trim();
  const zone = /(?:^|\n)Zone\s+([^.\n]+)/.exec(issue.note);
  if (zone?.[1]) return zone[1].trim();
  const km = /\bkm (\d+)(?:\.\d+)?/.exec(`${issue.title} ${issue.note}`);
  if (km?.[1]) return `km ${km[1]}`;
  return 'Not zoned';
}

const mean = (pts: readonly Vec3[]): Vec3 | null => {
  if (pts.length === 0) return null;
  const s = pts.reduce<Vec3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  return [s[0] / pts.length, s[1] / pts.length, s[2] / pts.length];
};

/**
 * The issue's 3D position in the local frame, from its first mesh or point-cloud sighting, where
 * it is drawn: with its layer's date shift (`shiftOf`) when one is given.
 */
export function issuePosition(issue: Issue, shiftOf?: ShiftOf): Vec3 | null {
  const at = (p: Vec3 | null, layer: string): Vec3 | null =>
    p && shiftOf ? shiftLocal(p, shiftOf(layer)) : p;
  for (const s of issue.sightings) {
    if (s.on === 'mesh') {
      const g = s.geom;
      if (g.type === 'spoint') return at(g.p, s.layer);
      if (g.type === 'spatch') {
        if (g.center) return at(g.center, s.layer);
        continue;
      }
      return at(mean(g.points), s.layer);
    }
    if (s.on === 'pointcloud') {
      const g = s.geom;
      if (g.type === 'point3') return at(g.p, s.layer);
      if (g.type === 'box3')
        return at(
          [(g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, (g.min[2] + g.max[2]) / 2],
          s.layer,
        );
      if (g.type === 'polygon3') return at(mean(g.points), s.layer);
    }
  }
  return null;
}

/** A GeoJSON's [lon, lat, ...] positions moved by a shift in the project CRS (`bbox` dropped). */
function movedGeoJson(v: unknown, s: DateShift, epsg: number): unknown {
  if (!Array.isArray(v)) {
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = { ...o };
    delete out.bbox;
    for (const k of ['coordinates', 'geometry', 'features', 'geometries'] as const)
      if (k in o) out[k] = movedGeoJson(o[k], s, epsg);
    return out;
  }
  const arr: unknown[] = v;
  const [lon, lat] = arr;
  if (typeof lon !== 'number' || typeof lat !== 'number')
    return arr.map((x) => movedGeoJson(x, s, epsg));
  const [e, n] = shiftEN(fromWgs84([lon, lat, 0], epsg), s);
  const [lo, la] = toWgs84([e, n, 0], epsg);
  return [lo, la, ...arr.slice(2)];
}

/**
 * A sighting where it is drawn: its 3D geometry (local frame) or map geometry (WGS84, through the
 * project CRS) moved by its layer's date shift. Image and pano sightings stay as they are.
 */
export function drawnSighting(
  s: Sighting,
  shiftOf: ShiftOf | undefined,
  epsg: number | null,
): Sighting {
  const shift = shiftOf?.(s.layer) ?? null;
  if (!shift || isZeroShift(shift)) return s;
  const mv = (p: Vec3): Vec3 => shiftLocal(p, shift);
  if (s.on === 'mesh') {
    const g = s.geom;
    switch (g.type) {
      case 'spoint':
        return { ...s, geom: { ...g, p: mv(g.p) } };
      case 'spolyline':
      case 'spolygon':
        return { ...s, geom: { ...g, points: g.points.map(mv) } };
      case 'spatch':
        return g.center ? { ...s, geom: { ...g, center: mv(g.center) } } : s;
    }
  }
  if (s.on === 'pointcloud') {
    const g = s.geom;
    switch (g.type) {
      case 'point3':
        return { ...s, geom: { ...g, p: mv(g.p) } };
      case 'box3':
        return { ...s, geom: { ...g, min: mv(g.min), max: mv(g.max) } };
      case 'polygon3':
        return { ...s, geom: { ...g, points: g.points.map(mv) } };
      case 'selection':
        return s;
    }
  }
  if (s.on === 'map' && epsg !== null)
    return { ...s, geojson: movedGeoJson(s.geojson, shift, epsg) as Record<string, unknown> };
  return s;
}

/** All [lon, lat] positions in a GeoJSON geometry. */
export function geoJsonPositions(g: unknown): [number, number][] {
  const out: [number, number][] = [];
  const walk = (v: unknown) => {
    if (!Array.isArray(v)) return;
    if (v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
      out.push([v[0], v[1]]);
      return;
    }
    for (const x of v) walk(x);
  };
  if (typeof g === 'object' && g !== null) walk((g as { coordinates?: unknown }).coordinates);
  return out;
}

export function epsgOf(m: ProjectManifest): number | null {
  return 'epsg' in m.crs && isKnownCrs(m.crs.epsg) ? m.crs.epsg : null;
}

export interface IssueLocation {
  /** E, N, H in the project CRS; H is null when only a map position is known. */
  project: [number, number, number | null];
  /** lon, lat, H (WGS84); null when the project CRS is not in the bundled registry. */
  wgs84: [number, number, number | null] | null;
}

/**
 * Where an issue is: its 3D position, else the centre of its map geometry; where it is drawn
 * (its layer's date shift) when `shiftOf` is given.
 */
export function issueLocation(
  m: ProjectManifest,
  issue: Issue,
  shiftOf?: ShiftOf,
): IssueLocation | null {
  const epsg = epsgOf(m);
  const p = issuePosition(issue, shiftOf);
  if (p) {
    const [e, n, h] = localToProject(p, m.origin);
    const ll = epsg === null ? null : toWgs84([e, n, h], epsg);
    return { project: [e, n, h], wgs84: ll ? [ll[0], ll[1], h] : null };
  }
  for (const s of issue.sightings) {
    if (s.on !== 'map') continue;
    const pts = geoJsonPositions(s.geojson);
    if (pts.length === 0) continue;
    const lon = pts.reduce((a, q) => a + q[0], 0) / pts.length;
    const lat = pts.reduce((a, q) => a + q[1], 0) / pts.length;
    if (epsg === null) return null;
    const shift = shiftOf?.(s.layer) ?? null;
    const [e, n] = shiftEN(fromWgs84([lon, lat, 0], epsg), shift);
    if (!shift || isZeroShift(shift)) return { project: [e, n, null], wgs84: [lon, lat, null] };
    const [lo, la] = toWgs84([e, n, 0], epsg);
    return { project: [e, n, null], wgs84: [lo, la, null] };
  }
  return null;
}

/** Axis-aligned pixel box [x, y, w, h] of an image geometry, or null for masks. */
export function imageBox(g: ImageGeom): [number, number, number, number] | null {
  switch (g.type) {
    case 'box':
      return [g.x, g.y, g.w, g.h];
    case 'rotbox': {
      const pts = rotboxCorners(g.x, g.y, g.w, g.h, g.angleDeg);
      return boundsOf(pts);
    }
    case 'polygon':
      return boundsOf(g.points);
    case 'point':
      return [g.x, g.y, 0, 0];
    case 'mask':
      return null;
  }
}

/** Corners of a rotated box given by its centre, size and angle. */
export function rotboxCorners(
  cx: number,
  cy: number,
  w: number,
  h: number,
  angleDeg: number,
): [number, number][] {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x = 0, y = 0]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

export function boundsOf(pts: readonly (readonly number[])[]): [number, number, number, number] {
  const xs = pts.map((p) => p[0] ?? 0);
  const ys = pts.map((p) => p[1] ?? 0);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
}

export interface PhotoPick {
  layer: string;
  photo: string;
  /** Project-relative path of the review copy. */
  src: string | null;
  /** Marked region [x, y, w, h] in review-copy pixels; null when only a mask marks it. */
  box: [number, number, number, number] | null;
}

/** Path of a photo of a photos layer. */
export function photoSrc(m: ProjectManifest, layer: string, photo: string): string | null {
  const l = m.layers.find((x) => x.id === layer);
  if (l?.kind !== 'photos') return null;
  const item = l.items.find((i) => i.id === photo);
  return item && 'path' in item.src ? item.src.path : null;
}

/**
 * The photo that shows an issue best: the largest marked region (a closer, clearer view), else
 * the first photo it is marked on.
 */
export function bestPhoto(m: ProjectManifest, issue: Issue): PhotoPick | null {
  let best: PhotoPick | null = null;
  let bestArea = -1;
  for (const s of issue.sightings) {
    if (s.on !== 'image') continue;
    const box = imageBox(s.geom);
    const area = box ? Math.max(1, box[2] * box[3]) : 0;
    if (area > bestArea) {
      bestArea = area;
      best = { layer: s.layer, photo: s.photo, src: photoSrc(m, s.layer, s.photo), box };
    }
  }
  return best;
}

/** Shoelace area of a polygon in pixels. */
export function polygonArea(pts: readonly (readonly number[])[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] ?? [];
    const q = pts[(i + 1) % pts.length] ?? [];
    a += (p[0] ?? 0) * (q[1] ?? 0) - (q[0] ?? 0) * (p[1] ?? 0);
  }
  return Math.abs(a) / 2;
}
