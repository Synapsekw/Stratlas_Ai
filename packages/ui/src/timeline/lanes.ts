import type { ClipBar, IssueMark, PhotoMark, TimelineModel } from './model';

/** One day in ms. */
export const DAY_MS = 86_400_000;
/** Dates shown on each side of the focused one before the rest fold away. */
export const LANE_RADIUS = 2;

export interface LaneCapture {
  id: string;
  label: string;
  /** YYYY-MM-DD */
  date: string;
}

/** The parts of the capture index the lanes read (`CaptureIndex` fits). */
export interface LaneIndex {
  /** Oldest first. */
  captures: readonly LaneCapture[];
  /** Capture id by dated layer id. */
  of: Readonly<Record<string, string>>;
}

/** A clip on its lane: times of day are site time, ms after the lane's local midnight. */
export interface LaneClip extends ClipBar {
  startTod: number;
  /** May pass 24:00 for a flight that crosses midnight. */
  endTod: number;
  /** Sub-row inside the lane, 0 first. */
  row: number;
  keysTod?: number[];
}

export interface LaneIssue extends IssueMark {
  tod: number;
}

export interface LanePhoto extends PhotoMark {
  tod: number;
}

export interface Lane {
  captureId: string;
  date: string;
  label: string;
  /** By start time of day. */
  clips: LaneClip[];
  /** Sub-rows the clips need (0 for a date without video). */
  rows: number;
  issues: LaneIssue[];
  photos: LanePhoto[];
}

export interface LaneFolds {
  earlier: number;
  later: number;
}

export interface LaneExpand {
  earlier: boolean;
  later: boolean;
}

export interface LaneModel {
  /** Every date, oldest first. */
  lanes: Lane[];
  /** The focused date and its neighbours, plus any expanded fold. */
  visible: Lane[];
  /** The focused capture id (the latest date when the given focus is unknown). */
  focus: string | null;
  folds: LaneFolds;
  /** Time of day span to draw. */
  range: [number, number];
  offsetMin: number;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Site time of day of a UTC time, ms after local midnight. */
export function todOf(utcMs: number, offsetMin: number): number {
  return mod(utcMs + offsetMin * 60_000, DAY_MS);
}

/** Site day (YYYY-MM-DD) of a UTC time. */
export function siteDayOf(utcMs: number, offsetMin: number): string {
  return new Date(utcMs + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** UTC time of the local midnight that starts `date` at the site. */
export function siteMidnightUtc(date: string, offsetMin: number): number {
  return Date.parse(`${date}T00:00:00Z`) - offsetMin * 60_000;
}

function nearestCapture(captures: readonly LaneCapture[], day: string): string | undefined {
  const target = Date.parse(`${day}T00:00:00Z`);
  let best: LaneCapture | undefined;
  let gap = Infinity;
  for (const c of captures) {
    const d = Math.abs(Date.parse(`${c.date}T00:00:00Z`) - target);
    if (d < gap) {
      best = c;
      gap = d;
    }
  }
  return best?.id;
}

/** The layer's own capture, else the capture on the item's site day, else the nearest one. */
function laneIdFor(
  index: LaneIndex,
  layerId: string | undefined,
  utcMs: number,
  offsetMin: number,
): string | undefined {
  const own = layerId === undefined ? undefined : index.of[layerId];
  if (own !== undefined && index.captures.some((c) => c.id === own)) return own;
  return nearestCapture(index.captures, siteDayOf(utcMs, offsetMin));
}

/** Gives each clip (sorted by start) the first sub-row free at its start; returns the row count. */
function packRows(clips: LaneClip[]): number {
  const ends: number[] = [];
  for (const c of clips) {
    let row = ends.findIndex((e) => e <= c.startTod);
    if (row < 0) {
      row = ends.length;
      ends.push(c.endTod);
    } else ends[row] = c.endTod;
    c.row = row;
  }
  return ends.length;
}

/**
 * Time of day of a UTC time on a lane: inside one of its clips it runs on from the clip start (so
 * past 24:00 for a flight that crossed midnight), else the plain site time of day.
 */
export function laneTodOf(lane: Pick<Lane, 'clips'>, utcMs: number, offsetMin: number): number {
  const c = lane.clips.find((x) => utcMs >= x.startMs && utcMs <= x.endMs);
  return c ? c.startTod + (utcMs - c.startMs) : todOf(utcMs, offsetMin);
}

/** The lane's clip at a time of day, with the media time and UTC time there, or nothing. */
export function ghostAt(
  lane: Pick<Lane, 'clips'>,
  tod: number,
): { clip: LaneClip; mediaMs: number; utcMs: number } | undefined {
  const clip = lane.clips.find((c) => tod >= c.startTod && tod < c.endTod);
  if (!clip) return undefined;
  const mediaMs = tod - clip.startTod;
  return { clip, mediaMs, utcMs: clip.startMs + mediaMs };
}

/** UTC time of a time of day on a lane: through its clip there, else from the lane's midnight. */
export function utcAt(lane: Pick<Lane, 'clips' | 'date'>, tod: number, offsetMin: number): number {
  return ghostAt(lane, tod)?.utcMs ?? siteMidnightUtc(lane.date, offsetMin) + tod;
}

/** The lane's clip at a time of day. */
export function laneClipAt(lane: Pick<Lane, 'clips'>, tod: number): LaneClip | undefined {
  return ghostAt(lane, tod)?.clip;
}

/** The clip after (1) or before (-1) the active one in this lane; first or last when it is elsewhere. */
export function laneNeighbour(
  lane: Pick<Lane, 'clips'>,
  activeId: string | null,
  dir: 1 | -1,
): LaneClip | undefined {
  const i = lane.clips.findIndex((c) => c.layerId === activeId);
  if (i < 0) return dir === 1 ? lane.clips[0] : lane.clips[lane.clips.length - 1];
  return lane.clips[i + dir];
}

/** Which lanes show: the focus and LANE_RADIUS on each side, or everything on an expanded side. */
export function laneWindow(
  count: number,
  focusIdx: number,
  expand: LaneExpand,
): { from: number; to: number; folds: LaneFolds } {
  if (count === 0) return { from: 0, to: -1, folds: { earlier: 0, later: 0 } };
  const f = Math.min(Math.max(focusIdx, 0), count - 1);
  const from = expand.earlier ? 0 : Math.max(0, f - LANE_RADIUS);
  const to = expand.later ? count - 1 : Math.min(count - 1, f + LANE_RADIUS);
  return { from, to, folds: { earlier: from, later: count - 1 - to } };
}

function fitRange(lanes: readonly Lane[]): [number, number] {
  const times = lanes.flatMap((l) => [
    ...l.clips.flatMap((c) => [c.startTod, c.endTod]),
    ...l.photos.map((p) => p.tod),
    ...l.issues.map((i) => i.tod),
  ]);
  if (times.length === 0) return [0, DAY_MS];
  let a = Math.min(...times);
  let b = Math.max(...times);
  if (b - a < 60_000) {
    const mid = (a + b) / 2;
    a = mid - 30_000;
    b = mid + 30_000;
  }
  const pad = (b - a) * 0.02;
  return [a - pad, b + pad];
}

/**
 * One lane per survey date on a shared site time-of-day axis, from the timeline model (UTC) and the
 * capture index. `offsetMin` is the site clock offset; `expand` opens the folded dates.
 */
export function buildLaneModel(
  model: TimelineModel,
  index: LaneIndex,
  focus: string | null,
  offsetMin: number,
  expand: LaneExpand = { earlier: false, later: false },
): LaneModel {
  const lanes: Lane[] = index.captures.map((c) => ({
    captureId: c.id,
    date: c.date,
    label: c.label,
    clips: [],
    rows: 0,
    issues: [],
    photos: [],
  }));
  const byId = new Map(lanes.map((l) => [l.captureId, l]));
  const laneOf = (id: string | undefined) => (id === undefined ? undefined : byId.get(id));
  const clipLane = new Map<string, Lane>();

  for (const c of model.clips) {
    const lane = laneOf(laneIdFor(index, c.layerId, c.startMs, offsetMin));
    if (!lane) continue;
    const startTod = todOf(c.startMs, offsetMin);
    lane.clips.push({
      ...c,
      startTod,
      endTod: startTod + (c.endMs - c.startMs),
      row: 0,
      ...(c.keys ? { keysTod: c.keys.map((k) => startTod + (k - c.startMs)) } : {}),
    });
    clipLane.set(c.layerId, lane);
  }
  for (const lane of lanes) {
    lane.clips.sort((a, b) => a.startTod - b.startTod || a.layerId.localeCompare(b.layerId));
    lane.rows = packRows(lane.clips);
  }
  for (const p of model.photos) {
    const lane = laneOf(laneIdFor(index, p.layerId, p.tMs, offsetMin));
    if (lane) lane.photos.push({ ...p, tod: laneTodOf(lane, p.tMs, offsetMin) });
  }
  for (const m of model.issues) {
    const seenIn = model.clips.find((c) => m.tMs >= c.startMs && m.tMs <= c.endMs);
    const lane =
      (seenIn && clipLane.get(seenIn.layerId)) ??
      laneOf(laneIdFor(index, undefined, m.tMs, offsetMin));
    if (lane) lane.issues.push({ ...m, tod: laneTodOf(lane, m.tMs, offsetMin) });
  }

  const known = focus !== null && byId.has(focus);
  const focusIdx = known ? lanes.findIndex((l) => l.captureId === focus) : lanes.length - 1;
  const { from, to, folds } = laneWindow(lanes.length, focusIdx, expand);
  const visible = lanes.slice(from, to + 1);
  return {
    lanes,
    visible,
    focus: lanes[focusIdx]?.captureId ?? null,
    folds,
    range: fitRange(visible),
    offsetMin,
  };
}
