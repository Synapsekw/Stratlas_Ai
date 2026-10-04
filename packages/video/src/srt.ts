import {
  cameraQuatFromGimbal,
  fromWgs84,
  gridConvergenceDeg,
  lensFromFocal35,
  projectHeight,
  summariseSources,
  takeoffAbsAltitude,
  type HeightRule,
  type HeightSource,
} from '@aio/geo';
import type { FlightHeights, LensModel, PoseSample, Vec3 } from '@aio/schema';

/**
 * DJI SRT telemetry: one subtitle per video frame (or per second on older aircraft). Parsed per
 * block, so the subtitle start time is the presentation time of that frame.
 */
export interface SrtFrame {
  /** FrameCnt / SrtCnt when present, else the subtitle number. */
  index: number;
  /** Subtitle start and end on the video clock, milliseconds. */
  startMs: number;
  endMs: number;
  /** Aircraft wall clock (local time, no zone) as `YYYY-MM-DDTHH:mm:ss.SSS`, when present. */
  clock?: string;
  lat?: number;
  lon?: number;
  /** Height above the take-off point (`rel_alt`, `BAROMETER`, `H`), metres. */
  relAlt?: number;
  /**
   * Absolute altitude the aircraft reports (`abs_alt`, `altitude`, else the third value of
   * `GPS(lon, lat, alt)`), metres: barometric offset to GNSS, nominally above mean sea level, often
   * tens of metres off; ellipsoidal on RTK aircraft. Only a project height through a datum offset.
   */
  absAlt?: number;
  /** Home (take-off) point of older aircraft (`HOME(lon, lat)`). */
  home?: { lat: number; lon: number };
  /** Gimbal angles in degrees: yaw from true north clockwise, pitch up positive, roll right down. */
  gimbal?: { yaw: number; pitch: number; roll: number };
  /** 35 mm equivalent focal length, mm. */
  focal35?: number;
}

const TIME = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;
const CLOCK =
  /(\d{4})[-./](\d{2})[-./](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,:](\d{1,3})\d*(?:[.,:]\d+)?)?/;

const ms = (h: string, m: string, s: string, f: string) =>
  ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f);

/** `key: number` pairs, tolerant of spaces around the colon ("[iso : 100]"). */
function keyValues(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(/([A-Za-z_]+)\s*:\s*([-+]?\d+(?:\.\d+)?)/g)) {
    const k = m[1]?.toLowerCase();
    if (k && !out.has(k)) out.set(k, Number(m[2]));
  }
  return out;
}

function parseBlock(lines: readonly string[], fallbackIndex: number): SrtFrame | null {
  const timeAt = lines.findIndex((l) => TIME.test(l));
  if (timeAt < 0) return null;
  const t = TIME.exec(lines[timeAt] ?? '');
  if (!t) return null;
  const [, h1 = '0', m1 = '0', s1 = '0', f1 = '0', h2 = '0', m2 = '0', s2 = '0', f2 = '0'] = t;
  const body = lines
    .slice(timeAt + 1)
    .join(' ')
    .replace(/<[^>]*>/g, ' ');
  const kv = keyValues(body);
  const frame: SrtFrame = {
    index: kv.get('framecnt') ?? kv.get('srtcnt') ?? fallbackIndex,
    startMs: ms(h1, m1, s1, f1),
    endMs: ms(h2, m2, s2, f2),
  };
  const c = CLOCK.exec(body);
  if (c) {
    const frac = (c[7] ?? '0').padEnd(3, '0');
    frame.clock = `${c[1] ?? ''}-${c[2] ?? ''}-${c[3] ?? ''}T${c[4] ?? ''}:${c[5] ?? ''}:${c[6] ?? ''}.${frac}`;
  }
  const lat = kv.get('latitude');
  const lon = kv.get('longitude') ?? kv.get('longtitude');
  if (lat !== undefined && lon !== undefined) {
    frame.lat = lat;
    frame.lon = lon;
  }
  const gps = /GPS\s*\(\s*([-+]?[\d.]+)\s*,\s*([-+]?[\d.]+)(?:\s*,\s*([-+]?[\d.]+))?/.exec(body);
  if (gps && frame.lat === undefined) {
    frame.lon = Number(gps[1]);
    frame.lat = Number(gps[2]);
  }
  const home = /HOME\s*\(\s*([-+]?[\d.]+)\s*,\s*([-+]?[\d.]+)/.exec(body);
  if (home) frame.home = { lon: Number(home[1]), lat: Number(home[2]) };
  const rel = kv.get('rel_alt') ?? kv.get('barometer') ?? kv.get('h');
  if (rel !== undefined) frame.relAlt = rel;
  const abs = kv.get('abs_alt') ?? kv.get('altitude') ?? (gps?.[3] ? Number(gps[3]) : undefined);
  if (abs !== undefined && Number.isFinite(abs)) frame.absAlt = abs;
  const gy = kv.get('gb_yaw');
  const gp = kv.get('gb_pitch');
  if (gy !== undefined && gp !== undefined)
    frame.gimbal = { yaw: gy, pitch: gp, roll: kv.get('gb_roll') ?? 0 };
  const focal = kv.get('focal_len');
  if (focal !== undefined) frame.focal35 = focal;
  return frame;
}

/** Parse a DJI SRT file. Throws when no block carries a position. */
export function parseDjiSrt(text: string): SrtFrame[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const blocks = clean.split(/\r?\n\s*\r?\n/);
  const frames: SrtFrame[] = [];
  for (const block of blocks) {
    const f = parseBlock(block.split(/\r?\n/), frames.length + 1);
    if (f) frames.push(f);
  }
  if (!frames.some((f) => f.lat !== undefined && f.lon !== undefined))
    throw new Error(
      'The SRT file has no position telemetry (latitude and longitude). Turn on video captions on the aircraft.',
    );
  return frames;
}

export { cameraQuatFromGimbal, lensFromFocal35 };

export interface SrtFlightOptions {
  /** Project CRS (projected, metres) and origin, for the local frame. */
  epsg: number;
  origin: Vec3;
  /** The aircraft clock's offset from UTC in minutes (Kuwait +180, UAE +240). */
  utcOffsetMin: number;
  /** Width / height of the video frame. */
  aspect: number;
  /**
   * The height rule (`@aio/geo` `projectHeight`, data-conventions section 3a): absolute altitude
   * plus the project's datum offset, or relative altitude plus the take-off height. When absent,
   * `altitude` and `takeoffHeight` make one with no datum offset.
   */
  heights?: HeightRule;
  /** Shorthand for `heights`: `rel` (default) prefers relative, `abs` absolute altitude. */
  altitude?: 'rel' | 'abs';
  /** Project height (H) of the take-off point for relative altitude; default the origin height. */
  takeoffHeight?: number;
  /** Camera pitch when the SRT has no gimbal angles; default -30 degrees. */
  defaultPitchDeg?: number;
  /** Lens to use instead of one derived from the focal length. */
  lens?: LensModel;
  name?: string;
}

export interface SrtFlight {
  doc: {
    schema: 'aio.flight/1';
    name?: string;
    startUtcMs: number;
    lens: LensModel;
    samples: PoseSample[];
    heights: FlightHeights;
  };
  /** `gimbal` when every frame had gimbal angles, `estimated` when heading follows the track. */
  orientation: 'gimbal' | 'estimated';
  /** The altitude the sample heights came from (`mixed`: some frames fell back). */
  heightSource: HeightSource | 'mixed';
  /** The take-off point's absolute altitude (median of absolute minus relative), or null. */
  takeoffAbsAlt: number | null;
  warnings: string[];
}

function clockToUtcMs(clock: string, offsetMin: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(clock);
  if (!m) throw new Error(`Unreadable SRT clock "${clock}"`);
  const n = m.slice(1).map(Number);
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0, f = 0] = n;
  return Date.UTC(y, mo - 1, d, h, mi, s, f) - offsetMin * 60_000;
}

/** Heading (deg, clockwise from grid north) of the horizontal track around each sample. */
function trackHeadings(pos: readonly Vec3[], t: readonly number[], windowMs = 1000): number[] {
  const out: number[] = [];
  let last = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < pos.length; i++) {
    const ti = t[i] ?? 0;
    while ((t[lo] ?? 0) < ti - windowMs) lo++;
    while (hi + 1 < pos.length && (t[hi + 1] ?? 0) <= ti + windowMs) hi++;
    const a = pos[lo] ?? [0, 0, 0];
    const b = pos[hi] ?? [0, 0, 0];
    const de = b[0] - a[0];
    const dn = -(b[2] - a[2]);
    if (Math.hypot(de, dn) > 0.3) last = (Math.atan2(de, dn) * 180) / Math.PI;
    out.push(last);
  }
  return out;
}

/**
 * Convert parsed SRT frames into an `aio.flight/1` document in the project local frame: one sample
 * per frame at its subtitle start time (frame accurate), positions from latitude and longitude,
 * heights from the relative or reported altitude, camera orientation from the gimbal angles
 * (true north corrected to grid north) or, without them, the track heading and a fixed pitch.
 */
export function srtToFlight(frames: readonly SrtFrame[], o: SrtFlightOptions): SrtFlight {
  const warnings: string[] = [];
  const usable = frames.filter(
    (f): f is SrtFrame & { lat: number; lon: number } =>
      f.lat !== undefined && f.lon !== undefined && !(f.lat === 0 && f.lon === 0),
  );
  const first = usable[0];
  if (!first) throw new Error('The SRT file has no GPS fixes.');
  if (usable.length < frames.length)
    warnings.push(
      `${String(frames.length - usable.length)} frames without a GPS fix were skipped.`,
    );
  const t0 = frames[0]?.startMs ?? 0;
  const clocked = frames.find((f) => f.clock !== undefined);
  let startUtcMs: number;
  if (clocked?.clock) {
    startUtcMs = clockToUtcMs(clocked.clock, o.utcOffsetMin) - (clocked.startMs - t0);
  } else {
    startUtcMs = 0;
    warnings.push(
      'The SRT file has no clock; the clip starts at time zero. Set its time in Align.',
    );
  }
  const rule: HeightRule = o.heights ?? {
    prefer: o.altitude === 'abs' ? 'absolute' : 'relative',
    absOffsetM: 0,
    takeoffH: o.takeoffHeight ?? o.origin[2],
  };
  const heights = usable.map((f) => projectHeight({ abs: f.absAlt, rel: f.relAlt }, rule));
  const heightSource = summariseSources(heights.map((h) => h.source)) ?? 'none';
  const count = (s: HeightSource) => heights.filter((h) => h.source === s).length;
  const other = rule.prefer === 'absolute' ? 'relative' : 'absolute';
  if (count(other))
    warnings.push(
      `${String(count(other))} of ${String(heights.length)} frames have no ${rule.prefer} altitude; their ${other} altitude is used.`,
    );
  if (count('none'))
    warnings.push(
      `${String(count('none'))} frames have no altitude; they are placed at the take-off height.`,
    );
  const pos: Vec3[] = usable.map((f, i) => {
    const p = fromWgs84([f.lon, f.lat, heights[i]?.h ?? rule.takeoffH], o.epsg);
    return [p[0] - o.origin[0], p[2] - o.origin[2], 0 - (p[1] - o.origin[1])];
  });
  const t = usable.map((f) => Math.round(f.startMs - t0));
  const conv = gridConvergenceDeg(first.lon, first.lat, o.epsg);
  const gimbal = usable.every((f) => f.gimbal !== undefined);
  const pitch = o.defaultPitchDeg ?? -30;
  const headings = gimbal ? [] : trackHeadings(pos, t);
  if (!gimbal)
    warnings.push(
      `No gimbal angles in the SRT: the camera heading follows the flight track and the pitch is set to ${String(pitch)} degrees. Calibrate the clip in Align.`,
    );
  const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  const samples: PoseSample[] = [];
  let lastT = -1;
  usable.forEach((f, i) => {
    const ti = t[i] ?? 0;
    if (ti <= lastT) return;
    lastT = ti;
    const q = f.gimbal
      ? cameraQuatFromGimbal(f.gimbal.yaw - conv, f.gimbal.pitch, f.gimbal.roll)
      : cameraQuatFromGimbal(headings[i] ?? 0, pitch, 0);
    const p = pos[i] ?? [0, 0, 0];
    samples.push({
      t: ti,
      pos: [r(p[0], 4), r(p[1], 4), r(p[2], 4)],
      q: [r(q[0], 7), r(q[1], 7), r(q[2], 7), r(q[3], 7)],
      ...(f.gimbal ? { gimbal: f.gimbal } : {}),
    });
  });
  const focal = usable.find((f) => f.focal35 !== undefined)?.focal35;
  let lens = o.lens;
  if (!lens) {
    if (focal !== undefined && focal > 0) lens = lensFromFocal35(focal, o.aspect);
    else {
      lens = lensFromFocal35(24, o.aspect);
      warnings.push('No focal length in the SRT; a 24 mm equivalent lens is assumed.');
    }
  }
  return {
    doc: {
      schema: 'aio.flight/1',
      ...(o.name ? { name: o.name } : {}),
      startUtcMs: Math.round(startUtcMs),
      lens,
      samples,
      heights: { source: heightSource, absOffsetM: rule.absOffsetM, takeoffH: rule.takeoffH },
    },
    orientation: gimbal ? 'gimbal' : 'estimated',
    heightSource,
    takeoffAbsAlt: takeoffAbsAltitude(usable.map((f) => ({ abs: f.absAlt, rel: f.relAlt }))),
    warnings,
  };
}

export interface SrtTiming {
  /** Median video frame duration, ms. */
  frameMs: number;
  /** Largest gap between a subtitle start and its frame time, ms. */
  maxErrorMs: number;
  withinOneFrame: boolean;
  srtFrames: number;
  videoFrames: number;
}

/** Compare SRT subtitle starts with the video's frame presentation times (ms), in order. */
export function srtTimingCheck(
  frames: readonly SrtFrame[],
  frameTimesMs: readonly number[],
): SrtTiming {
  const diffs = frameTimesMs
    .slice(1)
    .map((v, i) => v - (frameTimesMs[i] ?? 0))
    .sort((a, b) => a - b);
  const frameMs = diffs[Math.floor(diffs.length / 2)] ?? 0;
  const n = Math.min(frames.length, frameTimesMs.length);
  const t0 = frames[0]?.startMs ?? 0;
  const v0 = frameTimesMs[0] ?? 0;
  let maxErrorMs = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.abs((frames[i]?.startMs ?? 0) - t0 + v0 - (frameTimesMs[i] ?? 0));
    maxErrorMs = Math.max(maxErrorMs, e);
  }
  // A video that starts later than its first subtitle is shifted as a whole.
  maxErrorMs = Math.max(maxErrorMs, Math.abs(v0 - t0));
  return {
    frameMs,
    maxErrorMs,
    withinOneFrame: frameMs > 0 && maxErrorMs < frameMs,
    srtFrames: frames.length,
    videoFrames: frameTimesMs.length,
  };
}
