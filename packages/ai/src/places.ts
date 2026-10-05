/**
 * Places the agent can find and fly to: tagged assets and their component groups, layers, issues,
 * photos, panoramas, clips, and whatever other packages add (stockpiles, road chainage), plus
 * coordinates in WGS84, the project CRS or the local frame. Names resolve fuzzily
 * (case-insensitive, by words and numbers: "tank 3" finds 20-T-0003); an unclear name fails with
 * the candidates, so the model can ask or pick one. Positions are in the local frame
 * (docs/architecture/data-conventions.md section 1: Y up, X east, Z south).
 */
import { siteLocation } from '@aio/engine';
import { fromWgs84, localToProject, projectToLocal, toWgs84 } from '@aio/geo';
import type { Issue, Quat, Vec3 } from '@aio/schema';
import { assetUrl } from '@aio/workspace';
import { Box3, Quaternion, Vector3, type Object3D } from 'three';
import { clipStartUtcMs } from './context';
import { parseFlight, type FlightFile } from './geometry';
import {
  clips,
  findIssue,
  iso,
  project,
  ToolError,
  type RendererToolContext,
  type VideoLayer,
} from './tool-kit';
import type { Target } from './tools';

export type PlaceKind =
  'asset' | 'group' | 'layer' | 'issue' | 'photo' | 'pano' | 'clip' | 'pile' | 'chainage';

export interface PlaceBox {
  min: Vec3;
  max: Vec3;
}

/** Where a camera stood: a photo, a panorama, a drone video frame ("drone eye"). */
export interface Eye {
  pos: Vec3;
  /** Camera orientation (three.js, looks along local -Z). */
  q?: Quat;
  /** Panoramas: the heading of the image centre, degrees clockwise from north. */
  headingDeg?: number;
}

export interface Place {
  /** `<kind>:<key>`, e.g. `asset:20-T-0003`, `issue:F05`, `photo:DJI_0661`. */
  id: string;
  kind: PlaceKind;
  name: string;
  /** Area, title, layer name or date. */
  detail?: string;
  /** The layer it belongs to. */
  layer?: string;
  /** Other names it answers to (node name, glTF name, issue title). */
  aliases?: string[];
  /** Mesh nodes it covers (assets, groups), measured in the live scene. */
  nodes?: string[];
  /** Centre, local frame. */
  p?: Vec3;
  box?: PlaceBox;
  eye?: Eye;
  /** Added to the match score: bare model nodes rank below tags and areas. */
  rank?: number;
  /** Issues: the photos it was seen on. */
  photos?: string[];
}

/** Other packages add places (stockpiles, road chainage) for a query; null lists them all. */
export type PlaceSource = (query: string | null, ctx: RendererToolContext) => Place[];

const sources = new Set<PlaceSource>();

/** Add a place source; returns a function that removes it. */
export function registerPlaceSource(source: PlaceSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

// Words --------------------------------------------------------------------------------------

/** Lower case words and numbers: "20-T-0003" is 20, t, 0003; "F05" is f, 05. */
export function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[a-z]+|\d+(?:\.\d+)?/g) ?? []
  );
}

const compact = (text: string) => words(text).join('');

const KIND_WORDS: Record<PlaceKind, readonly string[]> = {
  asset: ['asset', 'equipment', 'component', 'item', 'tag'],
  group: ['area', 'zone', 'group', 'section', 'unit'],
  layer: ['layer'],
  issue: ['issue', 'issues', 'finding', 'findings', 'defect', 'defects'],
  photo: ['photo', 'photos', 'picture', 'image', 'shot'],
  pano: ['panorama', 'panoramas', 'pano', 'panos', 'spherical'],
  clip: ['clip', 'clips', 'video', 'videos', 'footage'],
  pile: ['pile', 'piles', 'stockpile', 'stockpiles'],
  chainage: ['chainage', 'km'],
};

const STOP = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'at',
  'on',
  'in',
  'by',
  'for',
  'me',
  'my',
  'show',
  'go',
  'fly',
  'look',
  'view',
  'zoom',
  'please',
  'where',
  'is',
  'was',
  'what',
  'this',
  'that',
  'number',
  'no',
  'nr',
]);

function queryWords(query: string): { words: string[]; kinds: Set<PlaceKind> } {
  const kinds = new Set<PlaceKind>();
  const out: string[] = [];
  for (const w of words(query)) {
    if (STOP.has(w)) continue;
    const kind = (Object.keys(KIND_WORDS) as PlaceKind[]).find((k) => KIND_WORDS[k].includes(w));
    if (kind) {
      kinds.add(kind);
      continue;
    }
    out.push(w);
  }
  return { words: out, kinds };
}

const isNum = (w: string) => /^\d/.test(w);

/** How well one query word matches one word of a name (0 to 1). */
function wordMatch(q: string, w: string): number {
  if (q === w) return 1;
  if (isNum(q) && isNum(w)) return Number(q) === Number(w) ? 0.95 : 0;
  if (isNum(q) || isNum(w)) return 0;
  if (q.length >= 3 && w.length >= 3 && (w.startsWith(q) || q.startsWith(w))) return 0.8;
  // a type letter in a tag: "tank" for the T of 20-T-0003, "pump" for P
  if (q.length >= 3 && w.length <= 2 && q.startsWith(w)) return 0.6;
  return 0;
}

const best = (q: string, ws: readonly string[]) =>
  ws.reduce((m, w) => Math.max(m, wordMatch(q, w)), 0);

/** Relevance of a place for a query, 0 to 100. */
export function scorePlace(query: string, place: Place): number {
  const { words: qs, kinds } = queryWords(query);
  const kindBonus = kinds.has(place.kind) ? 5 : 0;
  const names = [place.name, ...(place.aliases ?? [])];
  const id = place.id.slice(place.id.indexOf(':') + 1);
  const qc = qs.join('');
  if (!qc) return kinds.has(place.kind) ? 30 : 0;
  const full = compact(query);
  if (names.some((n) => compact(n) === qc || compact(n) === full) || compact(id) === qc) return 100;
  const ownWords = words(place.name);
  const aliasWords = (place.aliases ?? []).flatMap(words);
  const detailWords = words(place.detail ?? '');
  let sum = 0;
  let numbersOk = true;
  let allInName = true;
  for (const q of qs) {
    // a word of the tag itself counts more than one of a longer name, which may cite other tags
    const own = best(q, ownWords);
    const n = Math.max(own, 0.85 * best(q, aliasWords));
    const d = best(q, detailWords);
    // the type letter of a tag, confirmed by its name or area: "tank" for the T of 20-T-0003
    // (LNG STORAGE TANK, in LNG tanks), not a package on the tank roof
    const typeCode =
      own > 0 && own < 0.8 && Math.max(best(q, aliasWords), best(q, detailWords)) >= 0.8;
    // the name counts most; the area or title confirms it
    sum += Math.min(1.2, Math.max(n, 0.6 * d) + (n > 0 && d > 0 ? 0.2 : 0) + (typeCode ? 0.15 : 0));
    if (isNum(q) && n === 0) numbersOk = false;
    if (n < 0.8) allInName = false;
  }
  if (sum === 0) return 0;
  const unmatched = ownWords.filter((w) => !qs.some((q) => wordMatch(q, w) > 0)).length;
  // "the jetty" means the jetty area, before a loading arm whose glTF name mentions the jetty
  const areaBonus = place.kind === 'group' && allInName ? 10 : 0;
  let score =
    (90 * sum) / qs.length -
    Math.min(12, 3 * unmatched) +
    kindBonus +
    areaBonus +
    (place.rank ?? 0);
  // numbers decide: "tank 3" is not tank 1
  if (!numbersOk) score *= 0.5;
  return Math.max(0, Math.min(99, score));
}

// Coordinates --------------------------------------------------------------------------------

export type ParsedCoordinate =
  | { kind: 'latlon'; lat: number; lon: number; h?: number }
  | { kind: 'en'; e: number; n: number; h?: number };

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const HEMI_LATLON = new RegExp(String.raw`${NUM}\s*°?\s*([NS])[\s,;]+${NUM}\s*°?\s*([EW])`, 'i');
const HEMI_LONLAT = new RegExp(String.raw`${NUM}\s*°?\s*([EW])[\s,;]+${NUM}\s*°?\s*([NS])`, 'i');
const PREFIXED_EN = /\bE\s*([\d\s]+(?:\.\d+)?)\s*,?\s*N\s*([\d\s]+(?:\.\d+)?)/i;
const PAIR =
  /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*(?:[,;\s]\s*(-?\d+(?:\.\d+)?))?\s*$/;

/**
 * A coordinate written as text: "29.07N 48.08E", "48.08E, 29.07N", "E 245 714 N 3 179 542",
 * "29.07, 48.08" (latitude first) or "245714, 3179542" (easting first). Null when it is none.
 */
export function parseCoordinate(text: string): ParsedCoordinate | null {
  const t = text.trim();
  let m = HEMI_LATLON.exec(t);
  if (m) {
    const lat = Number(m[1]) * (m[2]?.toUpperCase() === 'S' ? -1 : 1);
    const lon = Number(m[3]) * (m[4]?.toUpperCase() === 'W' ? -1 : 1);
    return { kind: 'latlon', lat, lon };
  }
  m = HEMI_LONLAT.exec(t);
  if (m) {
    const lon = Number(m[1]) * (m[2]?.toUpperCase() === 'W' ? -1 : 1);
    const lat = Number(m[3]) * (m[4]?.toUpperCase() === 'S' ? -1 : 1);
    return { kind: 'latlon', lat, lon };
  }
  m = PREFIXED_EN.exec(t);
  if (m?.[1] && m[2]) {
    return { kind: 'en', e: Number(m[1].replace(/\s/g, '')), n: Number(m[2].replace(/\s/g, '')) };
  }
  m = PAIR.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const h = m[3] === undefined ? undefined : Number(m[3]);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
      return h === undefined
        ? { kind: 'latlon', lat: a, lon: b }
        : { kind: 'latlon', lat: a, lon: b, h };
    }
    if (Math.abs(a) > 1000 && Math.abs(b) > 1000) {
      return h === undefined ? { kind: 'en', e: a, n: b } : { kind: 'en', e: a, n: b, h };
    }
  }
  return null;
}

function epsgOf(ctx: RendererToolContext): number | null {
  const crs = project(ctx).manifest.crs;
  return 'epsg' in crs ? crs.epsg : null;
}

/** Ground height (local y) under a local point: the first thing a ray from above hits. */
export function groundY(ctx: RendererToolContext, x: number, z: number): number {
  const scene = ctx.scene();
  if (!scene) return 0;
  const hit = scene.raycastRay(new Vector3(x, 20_000, z), new Vector3(0, -1, 0));
  return hit ? hit.point.y : 0;
}

/** A WGS84 or project CRS coordinate in the local frame; heights default to the ground. */
export function coordinateToLocal(ctx: RendererToolContext, c: ParsedCoordinate): Vec3 {
  const origin = project(ctx).manifest.origin;
  let e: number;
  let n: number;
  if (c.kind === 'latlon') {
    const epsg = epsgOf(ctx);
    if (epsg === null) {
      throw new ToolError(
        'This project has no geographic coordinate system, so latitude and longitude cannot be placed. Use find_places or easting and northing.',
      );
    }
    if (Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180) {
      throw new ToolError(`Latitude ${c.lat} and longitude ${c.lon} are out of range.`);
    }
    [e, n] = fromWgs84([c.lon, c.lat, 0], epsg);
  } else {
    e = c.e;
    n = c.n;
  }
  const local = projectToLocal([e, n, c.h ?? origin[2]], origin);
  if (c.h === undefined) local[1] = groundY(ctx, local[0], local[2]);
  return local;
}

/** A local point in every frame the person might use. */
export function describePoint(ctx: RendererToolContext, p: Vec3) {
  const m = project(ctx).manifest;
  const en = localToProject(p, m.origin);
  const epsg = epsgOf(ctx);
  let latlon: [number, number] | undefined;
  if (epsg !== null && siteLocation(m)) {
    const [lon, lat] = toWgs84(en, epsg);
    latlon = [round(lat, 6), round(lon, 6)];
  }
  return {
    local: p.map((v) => round(v, 1)) as Vec3,
    en: [round(en[0], 1), round(en[1], 1)] as [number, number],
    elevationM: round(en[2], 1),
    ...(latlon ? { latLon: latlon } : {}),
  };
}

export const round = (v: number, d: number) => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};

// The index ----------------------------------------------------------------------------------

/** Named objects of the mesh layers in the live scene, by name, with their layer. */
interface SceneNode {
  node: Object3D;
  layer: string;
}

function sceneNodes(ctx: RendererToolContext): Map<string, SceneNode> {
  const out = new Map<string, SceneNode>();
  const scene = ctx.scene();
  if (!scene) return out;
  const meshIds = new Set(
    project(ctx)
      .manifest.layers.filter((l) => l.kind === 'mesh')
      .map((l) => l.id),
  );
  for (const root of scene.scene.children) {
    const layer = root.userData.layerId as unknown;
    if (typeof layer !== 'string' || !meshIds.has(layer)) continue;
    root.traverse((o) => {
      if (o.name && !out.has(o.name)) out.set(o.name, { node: o, layer });
    });
  }
  return out;
}

/** A name a person would not search for: "Mesh_12", "Object.003", "layer:plant". */
const GENERIC =
  /^(?:layer:|mesh|object|node|group|scene|root|primitive|geometry|merged)[\s._-]*\d*$/i;

function boxOf(objects: readonly Object3D[]): PlaceBox | undefined {
  const box = new Box3();
  for (const o of objects) box.expandByObject(o);
  if (box.isEmpty()) return undefined;
  return { min: box.min.toArray(), max: box.max.toArray() };
}

export const boxCentre = (b: PlaceBox): Vec3 => [
  (b.min[0] + b.max[0]) / 2,
  (b.min[1] + b.max[1]) / 2,
  (b.min[2] + b.max[2]) / 2,
];

function boxOfPoints(points: readonly Vec3[]): PlaceBox | undefined {
  if (points.length === 0) return undefined;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] ?? Infinity, p[i] ?? 0);
      max[i] = Math.max(max[i] ?? -Infinity, p[i] ?? 0);
    }
  }
  return { min, max };
}

/** Every 3D point of an issue's sightings. */
export function issuePoints(issue: Issue): Vec3[] {
  const out: Vec3[] = [];
  for (const s of issue.sightings) {
    if (s.on === 'mesh') {
      const g = s.geom;
      if (g.type === 'spoint') out.push(g.p);
      else if (g.type === 'spolyline' || g.type === 'spolygon') out.push(...g.points);
      else if (g.center) out.push(g.center);
    } else if (s.on === 'pointcloud') {
      const g = s.geom;
      if (g.type === 'point3') out.push(g.p);
      else if (g.type === 'box3') out.push(g.min, g.max);
      else if (g.type === 'polygon3') out.push(...g.points);
    }
  }
  return out;
}

interface IndexOptions {
  /** Measure assets and groups in the scene (bounding boxes). Off for quick name searches. */
  measure?: boolean;
  /** Include untagged named nodes of the models. */
  untagged?: boolean;
  /** Measure mesh and point cloud layers too (can be slow the first time on large clouds). */
  measureLayers?: boolean;
}

/** Every place of the open project (positions where they are known without loading files). */
export function placeIndex(ctx: RendererToolContext, opts: IndexOptions = {}): Place[] {
  const m = project(ctx).manifest;
  const issues = ctx.workspace.getState().issues;
  const nodes = opts.measure || opts.untagged ? sceneNodes(ctx) : new Map<string, SceneNode>();
  const out: Place[] = [];
  const tagged = new Set<string>();
  const groups = new Map<string, { layer: string; nodes: string[] }>();

  for (const l of m.layers) {
    if (l.kind !== 'mesh') continue;
    for (const t of l.tags ?? []) {
      tagged.add(t.node);
      const found = nodes.get(t.node);
      const extras: unknown = found?.node.userData.name;
      const aliases = [
        t.node,
        ...(typeof extras === 'string' && extras !== t.node ? [extras] : []),
      ];
      const box = opts.measure && found ? boxOf([found.node]) : undefined;
      out.push({
        id: `asset:${t.tag}`,
        kind: 'asset',
        name: t.tag,
        ...(t.area ? { detail: t.area } : {}),
        layer: l.id,
        aliases: aliases.filter((a) => a !== t.tag),
        nodes: [t.node],
        ...(box ? { box, p: boxCentre(box) } : {}),
      });
      if (t.area) {
        const g = groups.get(t.area) ?? { layer: l.id, nodes: [] };
        g.nodes.push(t.node);
        groups.set(t.area, g);
      }
    }
  }
  for (const [area, g] of groups) {
    const objs = opts.measure
      ? g.nodes.flatMap((n) => {
          const f = nodes.get(n);
          return f ? [f.node] : [];
        })
      : [];
    const box = objs.length ? boxOf(objs) : undefined;
    // "10 · Jetty & berths" also answers to "Jetty & berths"
    const bare = area.replace(/^[\d\s.·:-]+/, '').trim();
    out.push({
      id: `group:${area}`,
      kind: 'group',
      name: area,
      detail: `${g.nodes.length} components`,
      layer: g.layer,
      ...(bare && bare !== area ? { aliases: [bare] } : {}),
      nodes: g.nodes,
      ...(box ? { box, p: boxCentre(box) } : {}),
    });
  }
  if (opts.untagged) {
    let n = 0;
    for (const [name, f] of nodes) {
      if (tagged.has(name) || GENERIC.test(name) || f.node.userData.aioNode !== true) continue;
      if (++n > 5000) break;
      const box = opts.measure ? boxOf([f.node]) : undefined;
      out.push({
        id: `asset:${name}`,
        kind: 'asset',
        name,
        layer: f.layer,
        detail: 'model node',
        nodes: [name],
        rank: -10,
        ...(box ? { box, p: boxCentre(box) } : {}),
      });
    }
  }

  const scene = ctx.scene();
  for (const l of m.layers) {
    const place: Place = {
      id: `layer:${l.id}`,
      kind: 'layer',
      name: l.name,
      detail: l.kind,
      aliases: [l.id],
    };
    let box: PlaceBox | undefined;
    if (l.kind === 'raster' && l.corners) {
      const { tl, tr, bl } = l.corners;
      const br: Vec3 = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]];
      box = boxOfPoints([tl, tr, bl, br]);
    } else if (l.kind === 'photos') {
      box = boxOfPoints(l.items.flatMap((i) => (i.pos ? [i.pos] : [])));
    } else if (l.kind === 'panoramas') {
      box = boxOfPoints(l.items.map((i) => i.pos));
    } else if (opts.measureLayers && scene && (l.kind === 'mesh' || l.kind === 'pointcloud')) {
      const roots = scene.scene.children.filter((o) => o.userData.layerId === l.id);
      box = roots.length ? boxOf(roots) : undefined;
    }
    if (box) {
      place.box = box;
      place.p = boxCentre(box);
    }
    out.push(place);

    if (l.kind === 'photos') {
      for (const i of l.items) {
        out.push({
          id: `photo:${i.id}`,
          kind: 'photo',
          name: i.id,
          detail: `${l.name}${i.takenAt ? `, ${i.takenAt}` : ''}`,
          layer: l.id,
          ...(i.pos ? { p: i.pos, eye: { pos: i.pos, ...(i.q ? { q: i.q } : {}) } } : {}),
        });
      }
    } else if (l.kind === 'panoramas') {
      for (const i of l.items) {
        out.push({
          id: `pano:${i.id}`,
          kind: 'pano',
          name: i.id,
          detail: l.name,
          layer: l.id,
          p: i.pos,
          eye: { pos: i.pos, headingDeg: i.headingDeg },
        });
      }
    } else if (l.kind === 'video') {
      const file = 'path' in l.src ? (l.src.path.split('/').pop() ?? '') : '';
      out.push({
        id: `clip:${l.id}`,
        kind: 'clip',
        name: l.name,
        detail: `starts ${iso(clipStartUtcMs(l))}`,
        layer: l.id,
        aliases: [l.id, ...(file ? [file.replace(/\.[^.]+$/, '')] : [])],
      });
    }
  }

  for (const i of issues) {
    const pts = issuePoints(i);
    const box = boxOfPoints(pts);
    const photos = [...new Set(i.sightings.flatMap((s) => (s.on === 'image' ? [s.photo] : [])))];
    const eye = pts.length ? undefined : photoEye(ctx, photos[0]);
    out.push({
      id: `issue:${i.code}`,
      kind: 'issue',
      name: i.code,
      detail: `${i.title}, severity ${String(i.severity)}, ${i.status}`,
      aliases: [i.id, i.title],
      ...(box ? { box, p: boxCentre(box) } : eye ? { p: eye.pos, eye } : {}),
      ...(photos.length ? { photos } : {}),
    });
  }

  for (const s of sources) {
    try {
      out.push(...s(null, ctx));
    } catch {
      // a broken source must not break the search
    }
  }
  return out;
}

function photoEye(ctx: RendererToolContext, id: string | undefined): Eye | undefined {
  if (!id) return undefined;
  for (const l of project(ctx).manifest.layers) {
    if (l.kind !== 'photos') continue;
    const i = l.items.find((x) => x.id === id);
    if (i?.pos) return { pos: i.pos, ...(i.q ? { q: i.q } : {}) };
  }
  return undefined;
}

export interface Match {
  place: Place;
  score: number;
}

/** Places for a query, best first. Sources that answer queries (chainage) are asked too. */
export function searchPlaces(
  ctx: RendererToolContext,
  query: string,
  opts: { kinds?: readonly PlaceKind[]; limit?: number; index?: Place[] } = {},
): Match[] {
  const index = opts.index ?? placeIndex(ctx, { untagged: true });
  const extra: Place[] = [];
  for (const s of sources) {
    try {
      extra.push(...s(query, ctx));
    } catch {
      // ignore a broken source
    }
  }
  const seen = new Set<string>();
  const out: Match[] = [];
  for (const place of [...extra, ...index]) {
    if (seen.has(place.id)) continue;
    seen.add(place.id);
    if (opts.kinds && !opts.kinds.includes(place.kind)) continue;
    const score = scorePlace(query, place);
    if (score >= 40) out.push({ place, score });
  }
  // places a source made for this very query (a chainage) win ties
  out.sort((a, b) => b.score - a.score);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Fill in the box of an asset or group from the live scene, when it is not known yet. */
export function measure(ctx: RendererToolContext, place: Place): Place {
  if (place.box) return place;
  if (place.kind === 'layer') {
    const id = place.id.slice('layer:'.length);
    const roots = ctx.scene()?.scene.children.filter((o) => o.userData.layerId === id) ?? [];
    const box = roots.length ? boxOf(roots) : undefined;
    return box ? { ...place, box, p: boxCentre(box) } : place;
  }
  if (!place.nodes?.length) return place;
  const nodes = sceneNodes(ctx);
  const objs = place.nodes.flatMap((n) => {
    const f = nodes.get(n);
    return f ? [f.node] : [];
  });
  const box = objs.length ? boxOf(objs) : undefined;
  return box ? { ...place, box, p: boxCentre(box) } : place;
}

const line = (m: Match) =>
  `${m.place.id} (${m.place.name}${m.place.detail ? `, ${m.place.detail}` : ''})`;

/** The one place a name means, or a ToolError that lists the candidates. */
export function resolveName(
  ctx: RendererToolContext,
  name: string,
  kinds?: readonly PlaceKind[],
): Place {
  const index = placeIndex(ctx, { untagged: true });
  // an id from find_places
  const byId = index.find((p) => p.id === name || p.id.toLowerCase() === name.toLowerCase());
  if (byId && (!kinds || kinds.includes(byId.kind))) return measure(ctx, byId);
  const found = searchPlaces(ctx, name, { index, ...(kinds ? { kinds } : {}) });
  const [top, second] = found;
  if (!top || top.score < 60) {
    const near = found.slice(0, 5).map(line).join('; ');
    throw new ToolError(
      `No place matches "${name}".${near ? ` Closest: ${near}.` : ''} Use find_places to search, or give a coordinate.`,
    );
  }
  if (top.score < 95 && second && top.score - second.score < 8) {
    const list = found
      .filter((m) => top.score - m.score < 15)
      .slice(0, 8)
      .map(line)
      .join('; ');
    throw new ToolError(
      `"${name}" matches several places: ${list}. Ask which one, or call again with one id.`,
    );
  }
  return measure(ctx, top.place);
}

// Targets ------------------------------------------------------------------------------------

/** A target resolved to something the camera can frame. */
export interface Resolved {
  label: string;
  place?: Place;
  /** Centre, local frame; null when the 3D view has to find it (an asset still loading). */
  p: Vec3 | null;
  box?: PlaceBox;
  eye?: Eye;
}

const flights = new WeakMap<VideoLayer, Promise<FlightFile | null>>();

function flightOf(ctx: RendererToolContext, l: VideoLayer): Promise<FlightFile | null> {
  let f = flights.get(l);
  if (!f) {
    f = ctx
      .fetchJson(assetUrl(project(ctx).id, l.flight.src))
      .then(parseFlight)
      .catch(() => null);
    flights.set(l, f);
  }
  return f;
}

/** The calibrated drone camera of a clip at project time `utcMs`. */
async function droneEye(ctx: RendererToolContext, l: VideoLayer, utcMs: number): Promise<Eye> {
  const flight = await flightOf(ctx, l);
  const samples = flight?.samples;
  if (!samples?.length) throw new ToolError(`The flight of clip ${l.name} could not be read.`);
  const t = utcMs - l.flight.startUtcMs;
  let i = 1;
  while (i < samples.length - 1 && (samples[i]?.t ?? 0) < t) i++;
  const a = samples[Math.max(0, i - 1)];
  const b = samples[i] ?? a;
  if (!a || !b) throw new ToolError(`The flight of clip ${l.name} has no poses.`);
  const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  const pos = new Vector3(...a.pos).lerp(new Vector3(...b.pos), k);
  const q = new Quaternion(...a.q).slerp(new Quaternion(...b.q), k);
  const off = l.positionOffsetM;
  if (off) pos.add(new Vector3(...off));
  const o = l.orientation;
  if (o) {
    const D = Math.PI / 180;
    const half = (d: number) => (d * D) / 2;
    const y = new Quaternion(0, Math.sin(half(o.yawDeg)), 0, Math.cos(half(o.yawDeg)));
    const x = new Quaternion(Math.sin(half(o.pitchDeg)), 0, 0, Math.cos(half(o.pitchDeg)));
    const z = new Quaternion(0, 0, Math.sin(half(o.rollDeg)), Math.cos(half(o.rollDeg)));
    q.multiply(y.multiply(x).multiply(z)).normalize();
  }
  return { pos: pos.toArray(), q: [q.x, q.y, q.z, q.w] };
}

/** "13:25" or "13:25:10" on the project day (site time), or an ISO time, to UTC ms. */
export function parseTimeOfDay(ctx: RendererToolContext, text: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const t = Date.parse(text);
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(utc|z)?$/i.exec(text.trim());
  if (!m) return null;
  const ws = ctx.workspace.getState();
  const loc = siteLocation(project(ctx).manifest);
  const offsetH = m[4] ? 0 : (loc?.utcOffsetHours ?? 0);
  const day = new Date(ws.nowMs);
  day.setUTCHours(0, 0, 0, 0);
  const t =
    day.getTime() +
    ((Number(m[1]) - offsetH) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) * 1000;
  return t;
}

async function clipTarget(
  ctx: RendererToolContext,
  t: Extract<Target, { kind: 'clip' }>,
): Promise<Resolved> {
  const all = clips(ctx);
  const ws = ctx.workspace.getState();
  let when: number | null = null;
  if (t.at !== undefined) {
    when = parseTimeOfDay(ctx, t.at);
    if (when === null) throw new ToolError(`Cannot read the time "${t.at}". Use HH:MM or ISO.`);
  }
  let layer: VideoLayer | undefined;
  if (t.id !== undefined) {
    const id = t.id;
    layer =
      all.find((c) => c.id === id || c.name === id) ??
      (() => {
        const p = resolveName(ctx, id, ['clip']);
        return all.find((c) => `clip:${c.id}` === p.id);
      })();
  }
  if (!layer) {
    const at = when ?? ws.nowMs;
    // the clip running at that time: its flight covers it and it started last before it (clips of
    // one flight share the pose file)
    let bestStart = -Infinity;
    for (const c of all) {
      const f = await flightOf(ctx, c);
      const last = f?.samples.at(-1)?.t ?? 0;
      const start = c.flight.startUtcMs;
      const clipStart = clipStartUtcMs(c);
      if (at < start || at > start + last) continue;
      const rank = clipStart <= at ? clipStart : -Infinity;
      if (!layer || rank > bestStart) {
        layer = c;
        bestStart = rank;
      }
    }
    layer ??= all.find((c) => c.id === ws.activeClip);
  }
  if (!layer) {
    throw new ToolError(
      when === null ? 'No clip is active. Name a clip.' : `No flight covers ${iso(when)}.`,
    );
  }
  const utc =
    when ??
    (t.atSeconds !== undefined
      ? clipStartUtcMs(layer) + t.atSeconds * 1000
      : ws.activeClip === layer.id
        ? ws.nowMs
        : clipStartUtcMs(layer));
  const eye = await droneEye(ctx, layer, utc);
  const place: Place = { id: `clip:${layer.id}`, kind: 'clip', name: layer.name, layer: layer.id };
  return { label: `${layer.name} at ${iso(utc).slice(11, 19)} UTC`, place, p: eye.pos, eye };
}

function fromPlace(p: Place): Resolved {
  return {
    label: p.name,
    place: p,
    p: p.p ?? null,
    ...(p.box ? { box: p.box } : {}),
    ...(p.eye ? { eye: p.eye } : {}),
  };
}

/** Resolve any target the tools accept. */
export async function resolveTarget(ctx: RendererToolContext, t: Target): Promise<Resolved> {
  switch (t.kind) {
    case 'point':
      return { label: t.p.map((v) => v.toFixed(1)).join(', '), p: t.p };
    case 'latlon': {
      const p = coordinateToLocal(ctx, {
        kind: 'latlon',
        lat: t.lat,
        lon: t.lon,
        ...(t.h !== undefined ? { h: t.h } : {}),
      });
      return { label: `${t.lat.toFixed(5)}, ${t.lon.toFixed(5)}`, p };
    }
    case 'en': {
      const p = coordinateToLocal(ctx, {
        kind: 'en',
        e: t.e,
        n: t.n,
        ...(t.h !== undefined ? { h: t.h } : {}),
      });
      return { label: `E ${t.e.toFixed(1)} N ${t.n.toFixed(1)}`, p };
    }
    case 'issue': {
      const issue = findIssueFuzzy(ctx, t.id);
      const place = placeIndex(ctx).find((p) => p.id === `issue:${issue.code}`);
      if (!place?.p) throw new ToolError(`Issue ${issue.code} has no location to fly to.`);
      return fromPlace(place);
    }
    case 'photo':
    case 'pano': {
      const place = resolveName(ctx, t.id.includes(':') ? t.id : `${t.kind}:${t.id}`, [t.kind]);
      return fromPlace(place);
    }
    case 'clip':
      return clipTarget(ctx, t);
    case 'asset':
    case 'place': {
      const name = t.kind === 'asset' ? t.id : t.name;
      const c = parseCoordinate(name);
      if (c) {
        return { label: name, p: coordinateToLocal(ctx, c) };
      }
      const place = resolveName(ctx, name, t.kind === 'asset' ? ['asset', 'group'] : undefined);
      if (place.kind === 'clip') return clipTarget(ctx, { kind: 'clip', id: place.id.slice(5) });
      // "the photo of F02": the first photo the issue was seen on
      const photo = place.photos?.[0];
      if (place.kind === 'issue' && photo && queryWords(name).kinds.has('photo')) {
        return fromPlace(resolveName(ctx, `photo:${photo}`, ['photo']));
      }
      return fromPlace(place);
    }
  }
}

/** An issue by id, code ("F05", "f5") or title. */
export function findIssueFuzzy(ctx: RendererToolContext, idOrCode: string): Issue {
  try {
    return findIssue(ctx, idOrCode);
  } catch {
    const issues = ctx.workspace.getState().issues;
    const code = compact(idOrCode.replace(/^issue[:\s]*/i, ''));
    const byCode =
      issues.find((i) => compact(i.code) === code) ??
      issues.find((i) => {
        const [a, b] = [words(i.code), words(code)];
        return a.length === b.length && a.every((w, k) => wordMatch(b[k] ?? '', w) >= 0.95);
      });
    if (byCode) return byCode;
    const place = resolveName(ctx, idOrCode, ['issue']);
    const hit = issues.find((i) => `issue:${i.code}` === place.id);
    if (!hit) throw new ToolError(`No issue "${idOrCode}" in this project.`);
    return hit;
  }
}

/** A local point for any target (measure, find near, draft location). */
export async function targetPoint(ctx: RendererToolContext, t: Target): Promise<Vec3> {
  const r = await resolveTarget(ctx, t);
  if (r.p) return r.p;
  if (r.box) return boxCentre(r.box);
  throw new ToolError(
    `${r.label} has no position yet. Open the 3D view and wait for the model to load, or give a coordinate.`,
  );
}
