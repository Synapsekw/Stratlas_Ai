import {
  shiftEN,
  shiftLocal,
  type AntennaUnit,
  type AntennasFile,
  type ChangeItem,
  type ChangeSet,
  type DateShift,
  type Layer,
  type ProjectManifest,
  type Vec3,
} from '@aio/schema';
import { footprintOverlap, MIN_OVERLAP, type XZ } from './footprint';
import type { DateIndex } from './pairs';

/**
 * Tracks across survey dates (Wave 3 M2, vision audit 3.10): the same antenna, change region or
 * thermal hot spot seen on several dates, linked into one track with a trend per measured value.
 *
 * Derived at read time from the files that already hold each date (nothing is stored, so a track
 * is rebuilt the same way every time):
 *
 * - antennas: the per-date inventory copies `telecom/history/<captureId>.json` (pipeline pack
 *   0.35.0) and the live `telecom/antennas.json` for its own date, rejected units left out;
 * - change regions: the `region` items of each change set between a date and the date just
 *   before it, filed under the later date;
 * - hot spots: the review's hot spots (`thermal.hotspots` drafts and what they became) with a
 *   multi-view point (`vote.point`), rejected ones left out, filed under their layer's date.
 *
 * Linking, date by date oldest first: every track's latest sighting is a candidate for the next
 * date's observations. A pair links when the class is the same and the places agree: the same
 * antenna id (the re-run merge keeps ids across dates), or the positions within the larger of the
 * two observations' radii, or for regions outlines overlapping at least `MIN_OVERLAP`. Pairs are
 * taken best first (same id, then overlap, then distance, then ids), each at most once; an
 * observation left over starts a track. Radii scale with what each observation knows of its
 * resolution: an antenna `max(0.3 m, half its face)`, a hot spot `max(0.5 m, 10 x its ground
 * sample distance)` (camera distance x pixel angle), a region `max(1 m, 3 x the set's cell)`.
 * Positions are compared lined up (each date's shift applied). Trends are values, never verdicts.
 */

export type TrackKind = 'antenna' | 'region' | 'hotspot';

export type TrackMetric =
  | 'azimuthDeg'
  | 'downtiltDeg'
  | 'centreHeightM'
  | 'areaM2'
  | 'netM3'
  | 'maxDistM'
  | 'peakC'
  | 'deltaC';

export interface TrackSighting {
  capture: string;
  date: string;
  /** The unit id, change item id or detection id on that date. */
  ref: string;
  /** Lined up: antennas project E, N, Z; regions and hot spots the project local frame. */
  at: Vec3;
  /** Not reviewed yet (a draft unit or detection). */
  draft: boolean;
  /** The change set (regions) or detection pass (hot spots) it came from. */
  source?: string;
  /** Short name on that date (an antenna's `A3`). */
  name?: string;
  /** Hot spots: the photos layer and photo it was seen on. */
  layer?: string;
  photo?: string;
  values: Partial<Record<TrackMetric, number>>;
}

export interface TrackTrendPoint {
  capture: string;
  date: string;
  value: number;
}

export interface TrackTrend {
  metric: TrackMetric;
  points: TrackTrendPoint[];
  /** Last minus the one before (azimuths the shorter way round); null with one point. */
  lastChange: number | null;
  /** Last minus first, the same way. */
  totalChange: number | null;
}

export interface Track {
  /** `<kind>:<first capture>:<first ref>`: the same for the same files. */
  id: string;
  kind: TrackKind;
  /** Antenna kind, the change set producer, or the detection class. */
  class: string;
  /** Oldest first, one per date. */
  sightings: TrackSighting[];
  trends: TrackTrend[];
}

/** One thing seen on one date, before linking. */
export interface TrackObservation extends TrackSighting {
  class: string;
  radiusM: number;
  /** Ids that name the same thing on every date (antenna unit ids). */
  key?: string;
  /** Plan-view outline (local x, z), lined up. */
  outline?: XZ[];
}

const METRICS: Record<TrackKind, readonly TrackMetric[]> = {
  antenna: ['azimuthDeg', 'downtiltDeg', 'centreHeightM'],
  region: ['areaM2', 'netM3', 'maxDistM'],
  hotspot: ['peakC', 'deltaC'],
};

export const ANTENNA_MIN_RADIUS_M = 0.3;
export const HOTSPOT_MIN_RADIUS_M = 0.5;
export const HOTSPOT_GSD_FACTOR = 10;
export const REGION_MIN_RADIUS_M = 1;
export const REGION_CELL_FACTOR = 3;
export const HOTSPOT_CLASS = 'hot-spot';

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** a - b, for azimuths the shorter way round (-180 to 180). */
function diff(metric: TrackMetric, a: number, b: number): number {
  if (metric !== 'azimuthDeg') return a - b;
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

function trendsOf(kind: TrackKind, sightings: readonly TrackSighting[]): TrackTrend[] {
  const out: TrackTrend[] = [];
  for (const metric of METRICS[kind]) {
    const points = sightings.flatMap((s) => {
      const v = s.values[metric];
      return v === undefined || !Number.isFinite(v)
        ? []
        : [{ capture: s.capture, date: s.date, value: v }];
    });
    const last = points.at(-1);
    const first = points[0];
    if (!last || !first) continue;
    const before = points.at(-2);
    out.push({
      metric,
      points,
      lastChange: before ? diff(metric, last.value, before.value) : null,
      totalChange: points.length > 1 ? diff(metric, last.value, first.value) : null,
    });
  }
  return out;
}

/** Link observations of one kind into tracks (see the file comment). Deterministic. */
export function linkTracks(
  kind: TrackKind,
  observations: readonly TrackObservation[],
  captures: readonly { id: string; date: string }[],
): Track[] {
  const order = new Map(captures.map((c, i) => [c.id, i]));
  const byDate = new Map<number, TrackObservation[]>();
  for (const o of observations) {
    const i = order.get(o.capture);
    if (i === undefined) continue;
    byDate.set(i, [...(byDate.get(i) ?? []), o]);
  }
  interface Open {
    id: string;
    class: string;
    last: TrackObservation;
    sightings: TrackSighting[];
  }
  const open: Open[] = [];
  const sighting = (o: TrackObservation): TrackSighting => {
    const s: TrackSighting & Partial<TrackObservation> = { ...o };
    delete s.class;
    delete s.radiusM;
    delete s.key;
    delete s.outline;
    return s;
  };
  for (const i of [...byDate.keys()].sort((a, b) => a - b)) {
    const today = [...(byDate.get(i) ?? [])].sort((a, b) =>
      a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0,
    );
    const pairs: { t: Open; o: TrackObservation; rank: number; d: number }[] = [];
    for (const t of open)
      for (const o of today) {
        const sameKey = t.last.key !== undefined && t.last.key === o.key;
        if (!sameKey && t.class !== o.class) continue;
        const d = dist(t.last.at, o.at);
        const overlap =
          t.last.outline && o.outline ? footprintOverlap(t.last.outline, o.outline) : 0;
        if (sameKey) pairs.push({ t, o, rank: 0, d });
        else if (overlap >= MIN_OVERLAP) pairs.push({ t, o, rank: 1, d: 1 - overlap });
        else if (d <= Math.max(t.last.radiusM, o.radiusM)) pairs.push({ t, o, rank: 2, d });
      }
    pairs.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.d - b.d ||
        (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0) ||
        (a.o.ref < b.o.ref ? -1 : a.o.ref > b.o.ref ? 1 : 0),
    );
    const usedT = new Set<Open>();
    const usedO = new Set<TrackObservation>();
    for (const p of pairs) {
      if (usedT.has(p.t) || usedO.has(p.o)) continue;
      usedT.add(p.t);
      usedO.add(p.o);
      p.t.last = p.o;
      p.t.sightings.push(sighting(p.o));
    }
    for (const o of today)
      if (!usedO.has(o))
        open.push({
          id: `${kind}:${o.capture}:${o.ref}`,
          class: o.class,
          last: o,
          sightings: [sighting(o)],
        });
  }
  return open.map((t) => ({
    id: t.id,
    kind,
    class: t.class,
    sightings: t.sightings,
    trends: trendsOf(kind, t.sightings),
  }));
}

// --------------------------------------------------------------------------- antennas

function antennaRadius(u: AntennaUnit): number {
  const face = Math.min(u.box.extents[0], u.box.extents[1]);
  return Math.max(ANTENNA_MIN_RADIUS_M, Number.isFinite(face) ? face / 2 : 0);
}

/**
 * Antenna tracks from the per-date copies and the live inventory. Each file is filed under its
 * `run.captureId`; the live file wins for its own date. Files without a date are left out.
 */
export function antennaTracks(
  files: readonly AntennasFile[],
  live: AntennasFile | null,
  captures: readonly { id: string; date: string }[],
  shiftOf: (capture: string) => DateShift | null,
): Track[] {
  const byCapture = new Map<string, AntennasFile>();
  for (const f of files) if (f.run.captureId) byCapture.set(f.run.captureId, f);
  if (live?.run.captureId) byCapture.set(live.run.captureId, live);
  const dateOf = new Map(captures.map((c) => [c.id, c.date]));
  const obs: TrackObservation[] = [];
  for (const [capture, f] of byCapture) {
    const date = dateOf.get(capture);
    if (date === undefined) continue;
    const shift = shiftOf(capture);
    for (const u of f.units) {
      if (u.status === 'rejected') continue;
      const values: TrackSighting['values'] = {};
      if (u.azimuthGridDeg) values.azimuthDeg = u.azimuthGridDeg.value;
      if (u.downtiltDeg) values.downtiltDeg = u.downtiltDeg.value;
      values.centreHeightM = u.centreHeightM?.value ?? u.box.centre[2];
      obs.push({
        capture,
        date,
        ref: u.id,
        key: u.id,
        name: u.name,
        class: u.kind,
        at: shiftEN<Vec3>(u.box.centre, shift),
        radiusM: antennaRadius(u),
        draft: u.status === 'draft',
        values,
      });
    }
  }
  return linkTracks('antenna', obs, captures);
}

// --------------------------------------------------------------------------- change regions

type RegionItem = Extract<ChangeItem, { kind: 'region' }>;

function cellOf(set: ChangeSet): number | undefined {
  const p = set.run?.params ?? {};
  for (const k of ['cellM', 'spacingM', 'resolutionM']) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

function regionAt(r: RegionItem): Vec3 | null {
  if (r.at) return r.at;
  const b = r.bounds;
  if (b) return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const ring = r.outlineLocal;
  if (ring) {
    const sum = (k: 0 | 1 | 2) => ring.reduce((s, p) => s + p[k], 0) / ring.length;
    return [sum(0), sum(1), sum(2)];
  }
  return null;
}

/**
 * Change region tracks: the regions of each set from a date's predecessor to it, filed under the
 * later date, linked by outline overlap or centre distance within one producer.
 */
export function regionTracks(
  sets: readonly ChangeSet[],
  captures: readonly { id: string; date: string }[],
): Track[] {
  const obs: TrackObservation[] = [];
  captures.forEach((c, i) => {
    const before = captures[i - 1];
    if (!before) return;
    for (const set of sets) {
      if (set.from !== before.id || set.to !== c.id) continue;
      const cell = cellOf(set);
      const radiusM = Math.max(REGION_MIN_RADIUS_M, cell ? REGION_CELL_FACTOR * cell : 0);
      for (const item of set.items) {
        if (item.kind !== 'region' || item.review?.status === 'dismissed') continue;
        const at = regionAt(item);
        if (!at) continue;
        const values: TrackSighting['values'] = {};
        if (item.areaM2 !== undefined) values.areaM2 = item.areaM2;
        if (item.volume) values.netM3 = item.volume.netM3;
        if (item.distance) values.maxDistM = item.distance.maxM;
        obs.push({
          capture: c.id,
          date: c.date,
          ref: `${set.id}/${item.id}`,
          source: set.id,
          class: set.producer,
          at,
          radiusM,
          draft: item.review?.status !== 'confirmed',
          values,
          ...(item.outlineLocal ? { outline: item.outlineLocal.map((p): XZ => [p[0], p[2]]) } : {}),
        });
      }
    }
  });
  return linkTracks('region', obs, captures);
}

// --------------------------------------------------------------------------- hot spots

/** A hot spot as the review holds it (a `thermal-<layer>.json` draft or what it became). */
export interface HotspotDetection {
  id: string;
  /** The photos layer it was seen on; its date is the layer's. */
  layer: string;
  photo?: string;
  status: 'draft' | 'accepted' | 'rejected';
  fields?: readonly { key: string; value: number | string | null }[];
  /** The multi-view vote's point, project local frame of the layer's date. */
  point?: Vec3;
  /** Width in pixels of the grid the box is in, for the ground sample distance. */
  widthPx?: number;
  /** The pass file it came from. */
  pass?: string;
}

type PhotoItem = Extract<Layer, { kind: 'photos' }>['items'][number];

function fieldNumber(d: HotspotDetection, key: string): number | undefined {
  const f = d.fields?.find((x) => x.key === key);
  return typeof f?.value === 'number' ? f.value : undefined;
}

/** Metres per pixel at the point: the camera's distance times the angle one pixel spans. */
export function groundSampleM(photo: PhotoItem | undefined, point: Vec3, widthPx?: number): number {
  if (!photo?.pos || !photo.lens || !widthPx || widthPx <= 0) return 0;
  const hfov = (photo.lens.hfovDeg * Math.PI) / 180;
  if (photo.lens.model !== 'pinhole') return (dist(photo.pos, point) * hfov) / widthPx;
  return (dist(photo.pos, point) * 2 * Math.tan(hfov / 2)) / widthPx;
}

/** Hot spot tracks: hot spots placed in 3D (rejected ones left out), filed under their layer's date. */
export function hotspotTracks(
  manifest: Pick<ProjectManifest, 'layers'>,
  index: { captures: readonly { id: string; date: string }[] } & Pick<DateIndex, 'of'>,
  hotspots: readonly HotspotDetection[],
  shiftOf: (layerId: string) => DateShift | null,
): Track[] {
  const photos = new Map<string, PhotoItem>();
  for (const l of manifest.layers)
    if (l.kind === 'photos') for (const p of l.items) photos.set(`${l.id}/${p.id}`, p);
  const dateOf = new Map(index.captures.map((c) => [c.id, c.date]));
  const obs: TrackObservation[] = [];
  for (const d of hotspots) {
    if (d.status === 'rejected' || !d.point) continue;
    const capture = index.of[d.layer];
    const date = capture ? dateOf.get(capture) : undefined;
    if (!capture || date === undefined) continue;
    const photo = d.photo ? photos.get(`${d.layer}/${d.photo}`) : undefined;
    const gsd = groundSampleM(photo, d.point, d.widthPx);
    const values: TrackSighting['values'] = {};
    const peak = fieldNumber(d, 'peak_c');
    const delta = fieldNumber(d, 'delta_c');
    if (peak !== undefined) values.peakC = peak;
    if (delta !== undefined) values.deltaC = delta;
    obs.push({
      capture,
      date,
      ref: d.id,
      layer: d.layer,
      ...(d.photo ? { photo: d.photo } : {}),
      ...(d.pass ? { source: d.pass } : {}),
      class: HOTSPOT_CLASS,
      at: shiftLocal(d.point, shiftOf(d.layer)),
      radiusM: Math.max(HOTSPOT_MIN_RADIUS_M, HOTSPOT_GSD_FACTOR * gsd),
      draft: d.status === 'draft',
      values,
    });
  }
  return linkTracks('hotspot', obs, index.captures);
}

/** The track a sighting belongs to (a unit id, a `<set>/<item>` ref or a detection id). */
export function trackOf(tracks: readonly Track[], ref: string): Track | undefined {
  return tracks.find((t) => t.sightings.some((s) => s.ref === ref));
}

/** Tracks seen on two dates or more. */
export function acrossDates(tracks: readonly Track[]): Track[] {
  return tracks.filter((t) => t.sightings.length > 1);
}
