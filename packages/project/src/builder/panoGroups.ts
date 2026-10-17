import type { PanoShape, PanoSkipReason } from '@aio/schema';

/**
 * Grouping drone frames into sphere panoramas (spec section 2, "Grouping frames into spheres"):
 * by how a sphere is flown, the drone hovering in one spot while the gimbal sweeps, never by file
 * names or folders. Pure; the reader is `panoScan.ts`.
 */
export interface PanoFrameMeta {
  /** Absolute path. */
  file: string;
  bytes: number;
  /** Local capture time `YYYY-MM-DDTHH:mm:ss`. */
  takenAt?: string;
  lat?: number;
  lon?: number;
  absAlt?: number;
  relAlt?: number;
  gimbal?: { yaw: number; pitch: number; roll: number };
  width?: number;
  height?: number;
  /** XMP `GPano:ProjectionType` is equirectangular. */
  gpano?: boolean;
  /** An unstitched Insta360 still (`.insp`): two fisheye circles, not an equirect (`fisheye.ts`). */
  dualFisheye?: boolean;
  unreadable?: boolean;
}

/** The grouping thresholds. Every value is tuned by P0 (spec, "P0 findings (13 Oct 2026)"). */
export const PANO_GROUPING = {
  /** A hovering drone stays this close to its cluster's median position (P0: spread <= 1.14 m). */
  maxHorizontalM: 5,
  /** ... and this close in altitude (P0: <= 1.79 m). */
  maxVerticalM: 3,
  /** Longest gap between frames of one sphere (P0: <= 10 s inside, >= 34 s between spheres). */
  maxGapS: 30,
  minFrames: 8,
  /** Yaw coverage of a full sphere. */
  minYawSpanDeg: 270,
  /** Yaw coverage of a wide panorama (P0: real ones cover 193 degrees). */
  minWideYawSpanDeg: 150,
  minPitchRows: 2,
  /** Pitches closer than this are one row. */
  pitchRowToleranceDeg: 8,
  /** Frames a row needs (the lone nadir frame is not a row). */
  minRowFrames: 2,
  /** A sphere with fewer frames than this share of the median sphere is "incomplete". */
  incompleteFraction: 0.85,
  /** 2:1 within this is a ready-made equirect. */
  equirectAspectTolerance: 0.02,
  /** Frames steeper than this are nadir shots: their yaw says nothing about coverage. */
  nadirPitchDeg: -85,
} as const;
export type PanoGroupingThresholds = { readonly [K in keyof typeof PANO_GROUPING]: number };

export interface PanoSphereGroup {
  shape: PanoShape;
  /** In capture order. */
  frames: PanoFrameMeta[];
  lat: number;
  lon: number;
  absAlt?: number;
  relAlt?: number;
  /** Local capture time of the first frame. */
  startedAt: string;
  incomplete: boolean;
  bytes: number;
}

export interface PanoGrouping {
  spheres: PanoSphereGroup[];
  ready: PanoFrameMeta[];
  skipped: { file: string; reason: PanoSkipReason }[];
}

const EARTH_R = 6_371_008.8;
const RAD = Math.PI / 180;

/** Horizontal distance in metres (equirectangular approximation, fine over a few km). */
export function horizontalM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dN = (b.lat - a.lat) * RAD * EARTH_R;
  const dE = (b.lon - a.lon) * RAD * EARTH_R * Math.cos(((a.lat + b.lat) / 2) * RAD);
  return Math.hypot(dN, dE);
}

/** Seconds of a local capture time (the zone is the same for every frame of a card). */
function seconds(takenAt: string): number {
  return Date.parse(`${takenAt}Z`) / 1000;
}

/** Degrees of yaw the frames cover: 360 minus the widest gap between neighbouring yaws. */
export function yawSpanDeg(yaws: readonly number[]): number {
  if (yaws.length === 0) return 0;
  const s = yaws.map((y) => ((y % 360) + 360) % 360).sort((a, b) => a - b);
  let gap = 360 - ((s[s.length - 1] ?? 0) - (s[0] ?? 0));
  for (let i = 1; i < s.length; i++) gap = Math.max(gap, (s[i] ?? 0) - (s[i - 1] ?? 0));
  return 360 - gap;
}

/** Rows of pitch: runs of sorted pitches no more than `tolDeg` apart, of at least `minFrames`. */
export function pitchRows(pitches: readonly number[], tolDeg: number, minFrames: number): number {
  const s = [...pitches].sort((a, b) => a - b);
  let rows = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    run = i > 0 && (s[i] ?? 0) - (s[i - 1] ?? 0) <= tolDeg ? run + 1 : 1;
    if (run === minFrames) rows++;
  }
  return rows;
}

export function isReadyMadePano(
  f: PanoFrameMeta,
  t: PanoGroupingThresholds = PANO_GROUPING,
): boolean {
  if (f.gpano) return true;
  if (!f.width || !f.height) return false;
  return Math.abs(f.width / f.height - 2) < t.equirectAspectTolerance;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

const altOf = (f: PanoFrameMeta): number | undefined => f.absAlt ?? f.relAlt;

/** Why a cluster is not a panorama, or its shape. */
function classify(
  c: readonly PanoFrameMeta[],
  t: PanoGroupingThresholds,
): PanoShape | PanoSkipReason {
  if (c.length < t.minFrames) return 'few-frames';
  const g = c.flatMap((f) => (f.gimbal ? [f.gimbal] : []));
  if (
    pitchRows(
      g.map((x) => x.pitch),
      t.pitchRowToleranceDeg,
      t.minRowFrames,
    ) < t.minPitchRows
  )
    return 'one-pitch-row';
  const span = yawSpanDeg(g.filter((x) => x.pitch > t.nadirPitchDeg).map((x) => x.yaw));
  if (span >= t.minYawSpanDeg) return 'sphere';
  if (span >= t.minWideYawSpanDeg) return 'wide';
  return 'narrow-yaw';
}

/**
 * Frames of one hover share one image size. A file of another size (a stitched output dumped
 * beside its frames carries the same position, time and gimbal angles) is not a frame.
 */
function splitByImageSize(c: readonly PanoFrameMeta[]): {
  same: PanoFrameMeta[];
  odd: PanoFrameMeta[];
} {
  const counts = new Map<string, number>();
  const key = (f: PanoFrameMeta) =>
    f.width !== undefined && f.height !== undefined ? `${String(f.width)}x${String(f.height)}` : '';
  for (const f of c) if (key(f)) counts.set(key(f), (counts.get(key(f)) ?? 0) + 1);
  let major = '';
  let best = 0;
  for (const [k, n] of counts)
    if (n > best) {
      major = k;
      best = n;
    }
  const same: PanoFrameMeta[] = [];
  const odd: PanoFrameMeta[] = [];
  for (const f of c) (key(f) && key(f) !== major ? odd : same).push(f);
  return { same, odd };
}

/**
 * A ready-made 360 keeps its place only when it has both `lat` and `lon`: without GPS (a ground 360
 * camera, a phone) or with half a position it imports unplaced, to be pinned on the site.
 */
function placedOrNot(f: PanoFrameMeta): PanoFrameMeta {
  if (f.lat !== undefined && f.lon !== undefined) return f;
  const out = { ...f };
  delete out.lat;
  delete out.lon;
  return out;
}

export function groupPanoFrames(
  frames: readonly PanoFrameMeta[],
  t: PanoGroupingThresholds = PANO_GROUPING,
): PanoGrouping {
  const skipped: PanoGrouping['skipped'] = [];
  const ready: PanoFrameMeta[] = [];
  const usable: { f: PanoFrameMeta; s: number; i: number }[] = [];
  frames.forEach((f, i) => {
    if (f.unreadable) skipped.push({ file: f.file, reason: 'unreadable' });
    else if (f.dualFisheye) skipped.push({ file: f.file, reason: 'dual-fisheye' });
    else if (isReadyMadePano(f, t)) ready.push(placedOrNot(f));
    else if (
      f.takenAt === undefined ||
      f.lat === undefined ||
      f.lon === undefined ||
      Number.isNaN(seconds(f.takenAt))
    )
      skipped.push({ file: f.file, reason: 'no-position' });
    else if (!f.gimbal) skipped.push({ file: f.file, reason: 'no-gimbal' });
    else usable.push({ f, s: seconds(f.takenAt), i });
  });
  // by capture time (file numbers wrap: 0975 is followed by 0001), stable on ties
  usable.sort((a, b) => a.s - b.s || a.i - b.i);

  interface Entry {
    f: PanoFrameMeta;
    s: number;
  }
  const medianPos = (c: readonly Entry[]) => ({
    lat: median(c.map((e) => e.f.lat ?? 0)),
    lon: median(c.map((e) => e.f.lon ?? 0)),
  });
  const medianAlt = (c: readonly Entry[]): number | undefined => {
    const alts = c.flatMap((e) => {
      const a = altOf(e.f);
      return a === undefined ? [] : [a];
    });
    return alts.length ? median(alts) : undefined;
  };
  const altApart = (x: number | undefined, y: number | undefined) =>
    x !== undefined && y !== undefined && Math.abs(x - y) > t.maxVerticalM;

  let clusters: Entry[][] = [];
  let cur: Entry[] = [];
  let lastS = -Infinity;
  for (const e of usable) {
    if (cur.length > 0) {
      const far =
        e.s - lastS > t.maxGapS ||
        horizontalM(medianPos(cur), { lat: e.f.lat ?? 0, lon: e.f.lon ?? 0 }) > t.maxHorizontalM ||
        altApart(altOf(e.f), medianAlt(cur));
      if (far) {
        clusters.push(cur);
        cur = [];
      }
    }
    cur.push(e);
    lastS = e.s;
  }
  if (cur.length) clusters.push(cur);

  // One stray frame (a GPS or barometer jump) between two clusters of the same hover joins them,
  // so a sphere is never split in two by a single outlier.
  const sameHover = (x: readonly Entry[], y: readonly Entry[]): boolean => {
    const last = x[x.length - 1];
    const first = y[0];
    if (!last || !first || first.s - last.s > t.maxGapS) return false;
    return (
      horizontalM(medianPos(x), medianPos(y)) <= t.maxHorizontalM &&
      !altApart(medianAlt(x), medianAlt(y))
    );
  };
  const joined: Entry[][] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i] ?? [];
    const prev = joined[joined.length - 1];
    const next = clusters[i + 1];
    const lastP = prev?.[prev.length - 1];
    const firstN = next?.[0];
    if (
      c.length === 1 &&
      prev &&
      next &&
      lastP &&
      firstN &&
      c[0] &&
      c[0].s - lastP.s <= t.maxGapS &&
      firstN.s - c[0].s <= t.maxGapS &&
      sameHover(prev, next)
    ) {
      joined[joined.length - 1] = [...prev, ...c, ...next];
      i++;
    } else joined.push(c);
  }
  clusters = joined;

  const accepted: { shape: PanoShape; frames: PanoFrameMeta[] }[] = [];
  for (const entries of clusters) {
    const { same: c, odd } = splitByImageSize(entries.map((e) => e.f));
    for (const f of odd) skipped.push({ file: f.file, reason: 'different-size' });
    const k = classify(c, t);
    if (k === 'sphere' || k === 'wide') accepted.push({ shape: k, frames: c });
    else for (const f of c) skipped.push({ file: f.file, reason: k });
  }
  // spheres are judged against spheres, wide panoramas against wide panoramas
  const typicalOf = (shape: PanoShape): number => {
    const n = accepted.filter((a) => a.shape === shape).map((a) => a.frames.length);
    return n.length ? median(n) : 0;
  };
  const typical = { sphere: typicalOf('sphere'), wide: typicalOf('wide') };
  const spheres = accepted.map(({ shape, frames: fs }): PanoSphereGroup => {
    const abs = fs.flatMap((f) => (f.absAlt === undefined ? [] : [f.absAlt]));
    const rel = fs.flatMap((f) => (f.relAlt === undefined ? [] : [f.relAlt]));
    return {
      shape,
      frames: fs,
      lat: median(fs.map((f) => f.lat ?? 0)),
      lon: median(fs.map((f) => f.lon ?? 0)),
      ...(abs.length ? { absAlt: median(abs) } : {}),
      ...(rel.length ? { relAlt: median(rel) } : {}),
      startedAt: fs[0]?.takenAt ?? '',
      incomplete: fs.length < t.incompleteFraction * typical[shape],
      bytes: fs.reduce((n, f) => n + f.bytes, 0),
    };
  });
  return { spheres, ready, skipped };
}
