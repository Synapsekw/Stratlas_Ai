import { shiftLocal, type DateShift } from '@aio/schema';
import type { FrameProjection } from './geo';

/** A [lon, lat] (extra entries kept) moved by a date shift: to local, shifted, back. */
export function shiftLonLat<T extends readonly number[]>(
  pos: T,
  s: DateShift | null,
  proj: FrameProjection,
): T {
  if (!s) return pos;
  const lon = pos[0];
  const lat = pos[1];
  if (lon === undefined || lat === undefined) return pos;
  const [x, , z] = shiftLocal(proj.toLocal(lon, lat), s);
  const [lo, la] = proj.toLonLat([x, 0, z]);
  return [lo, la, ...pos.slice(2)] as unknown as T;
}

function isPosition(v: unknown[]): v is number[] {
  return v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
}

function shiftValue(v: unknown, s: DateShift, proj: FrameProjection): unknown {
  if (Array.isArray(v)) {
    return isPosition(v) ? shiftLonLat(v, s, proj) : v.map((x) => shiftValue(x, s, proj));
  }
  return v;
}

function shiftNode(g: unknown, s: DateShift, proj: FrameProjection): unknown {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return g;
  const o = g as Record<string, unknown>;
  const out: Record<string, unknown> = { ...o };
  if ('coordinates' in o) out.coordinates = shiftValue(o.coordinates, s, proj);
  if (o.geometry && typeof o.geometry === 'object') out.geometry = shiftNode(o.geometry, s, proj);
  if (Array.isArray(o.features)) out.features = o.features.map((f) => shiftNode(f, s, proj));
  if (Array.isArray(o.geometries)) out.geometries = o.geometries.map((f) => shiftNode(f, s, proj));
  return out;
}

/** A GeoJSON with every position moved by the date shift; properties are untouched. */
export function shiftedGeoJson(
  gj: GeoJSON.GeoJSON,
  s: DateShift,
  proj: FrameProjection,
): GeoJSON.GeoJSON {
  return shiftNode(gj, s, proj) as GeoJSON.GeoJSON;
}
