import type { WalkFit } from '@aio/geo';
import { shiftLocal, type DateShift } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { shell } from '../shell';
import { wrapDeg } from '../workspace/spot/spotGeom';
import type { Side, SplitPref } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import { walks } from './walks';

/*
 * Two walks side by side in the two 360 panes of the split. One leads and plays; the other
 * follows it by place (the moment of its own walk nearest the lead's spot, the pass going the
 * same way preferred) or by time. With Link look both look at the same compass bearing, each
 * turned by its own walk's heading. Routes may part: nothing dims, the follower shows its
 * closest frame and says how far it is, and each scrubber shades the detours.
 */

export type CompareMode = 'place' | 'time';

/** What a project remembers of its compare for the session (not across restarts). */
interface Remembered {
  active: boolean;
  left: string | null;
  right: string | null;
  lead: Side;
  mode: CompareMode;
  linkLook: boolean;
  /** The split before the compare took both sides; Stop comparing puts it back. */
  restore: SplitPref | null;
}

export interface WalkCompareState extends Remembered {
  /** The project the compare belongs to (the open one). */
  projectId: string | null;
  /** The pane whose look the other follows while linked: the one under the pointer. */
  driver: Side;
  /** The walk seeked into one of its detours plays on its own until the routes rejoin. */
  solo: Side | null;
  /** The follower's play button asks the lead to play or pause (`seq` makes a repeat new). */
  leadPlay: { seq: number; play: boolean } | null;
  /** The follower was scrubbed outside a detour: the lead goes to `t` (`seq` makes a repeat new). */
  leadSeek: { seq: number; t: number } | null;
  /** Compare walk `left` (leading) with walk `right`. */
  begin(left: string, right: string): void;
  end(): void;
  swapLead(): void;
  /** `side` was seeked into a detour: it plays on its own. */
  goSolo(side: Side): void;
  /**
   * The solo walk of `side` is back where the routes meet. Still playing, it leads from here, so
   * the compare picks up where it is instead of jumping back.
   */
  rejoin(side: Side, playing: boolean): void;
  /** The lead plays: a solo walk follows again. */
  leadPlays(): void;
  requestLeadPlay(play: boolean): void;
  requestLeadSeek(t: number): void;
}

const DEFAULTS: Remembered = {
  active: false,
  left: null,
  right: null,
  lead: 'left',
  mode: 'place',
  linkLook: true,
  restore: null,
};

const remembered = (s: WalkCompareState): Remembered => ({
  active: s.active,
  left: s.left,
  right: s.right,
  lead: s.lead,
  mode: s.mode,
  linkLook: s.linkLook,
  restore: s.restore,
});

/** The workspace bit the compare reads: which project is open. */
type ProjectSource = Pick<StoreApi<{ project: { id: string } | null }>, 'getState' | 'subscribe'>;

export const otherSide = (s: Side): Side => (s === 'left' ? 'right' : 'left');

/** The compare store of the open project, remembered per project while the app runs. */
export function createWalkCompareStore(ws: ProjectSource): StoreApi<WalkCompareState> {
  const memory = new Map<string, Remembered>();
  const fresh = (projectId: string | null) => {
    const r = (projectId === null ? undefined : memory.get(projectId)) ?? DEFAULTS;
    return { ...r, projectId, driver: r.lead, solo: null, leadPlay: null, leadSeek: null };
  };
  const store = createStore<WalkCompareState>()((set, get) => ({
    ...fresh(ws.getState().project?.id ?? null),
    begin: (left, right) => {
      set({ active: true, left, right, lead: 'left', driver: 'left', solo: null });
    },
    end: () => {
      set({ active: false, left: null, right: null, solo: null, restore: null });
    },
    swapLead: () => {
      const lead = otherSide(get().lead);
      set({ lead, driver: lead, solo: null });
    },
    goSolo: (side) => {
      if (get().solo !== side) set({ solo: side });
    },
    rejoin: (side, playing) => {
      if (get().solo !== side) return;
      set(playing ? { solo: null, lead: side, driver: side } : { solo: null });
    },
    leadPlays: () => {
      if (get().solo !== null) set({ solo: null });
    },
    requestLeadPlay: (play) => {
      set({ leadPlay: { seq: (get().leadPlay?.seq ?? 0) + 1, play } });
    },
    requestLeadSeek: (t) => {
      set({ leadSeek: { seq: (get().leadSeek?.seq ?? 0) + 1, t } });
    },
  }));
  store.subscribe((s) => {
    if (s.projectId !== null) memory.set(s.projectId, remembered(s));
  });
  ws.subscribe((w) => {
    const id = w.project?.id ?? null;
    if (id !== store.getState().projectId) store.setState(fresh(id));
  });
  return store;
}

export const walkCompare = createWalkCompareStore(workspace);

export function useWalkCompare<T>(selector: (s: WalkCompareState) => T): T {
  return useStore(walkCompare, selector);
}

/** The walks a running compare shows on the map and in 3D, whatever their visibility. */
export function comparedWalks(s: Pick<WalkCompareState, 'active' | 'left' | 'right'>): string[] {
  return s.active && s.left !== null && s.right !== null ? [s.left, s.right] : [];
}

const bothWalks = (p: SplitPref | undefined) => p?.left === 'walk360' && p.right === 'walk360';

/**
 * Compare walk `lead` with walk `other`: both 360 panes in the split, `lead` on the left. Both
 * walks show on the map and in 3D for as long as the compare runs (`comparedWalks`), without
 * switching their layers on in the project.
 */
export function startWalkCompare(lead: string, other: string): void {
  const project = workspace.getState().project;
  if (!project) return;
  walks.getState().select(lead);
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  const restore = bothWalks(saved) ? walkCompare.getState().restore : (saved ?? null);
  walkCompare.getState().begin(lead, other);
  walkCompare.setState({ restore });
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  stagePrefs.getState().update(project.id, {
    split: {
      ...(saved ?? { left: 'walk360', right: 'walk360' }),
      left: 'walk360',
      right: 'walk360',
    },
  });
  if (sh.stageMode !== 'split') sh.setStageMode('split');
}

/** The two 360 panes show walks `left` and `right`: that is a running compare. */
export function ensureWalkCompare(left: string, right: string): void {
  const s = walkCompare.getState();
  if (s.active && s.left === left && s.right === right) return;
  walkCompare.setState({ active: true, left, right });
}

/** Stop comparing: the split goes back to what it showed before (else the map on the right). */
export function endWalkCompare(): void {
  const project = workspace.getState().project;
  const restore = walkCompare.getState().restore;
  walkCompare.getState().end();
  if (!project) return;
  const split = stagePrefs.getState().byProject[project.id]?.split;
  if (!bothWalks(split)) return;
  stagePrefs.getState().update(project.id, {
    split: restore && !bothWalks(restore) ? restore : { ...split, left: 'walk360', right: 'map' },
  });
}

// ---------------------------------------------------------------- the lead's clock

/** Where the lead is in its walk, for the follower to run against between time updates. */
export interface LeadClock {
  walk: string;
  t: number;
  /** `performance.now()` when `t` was read. */
  atMs: number;
  playing: boolean;
  rate: number;
}

export const leadClock = createStore<{ now: LeadClock | null }>()(() => ({ now: null }));

/** The lead's time now: the last reading run on at its rate while it plays. */
export function leadTimeAt(c: LeadClock, nowMs: number): number {
  return c.playing ? c.t + (Math.max(0, nowMs - c.atMs) / 1000) * c.rate : c.t;
}

// ---------------------------------------------------------------- tracks

export interface TrackPt {
  t: number;
  x: number;
  z: number;
}

/** A walk's spots in the scene (its date's shift applied) every `stepS` seconds. */
export function trackOf(
  fit: WalkFit,
  durationS: number,
  shift: DateShift | null,
  stepS = 0.25,
): TrackPt[] {
  const out: TrackPt[] = [];
  const end = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
  for (let i = 0; i * stepS <= end + 1e-9; i++) {
    const t = i * stepS;
    const a = fit.at(t);
    if (!a) continue;
    const p = shiftLocal([a.xz[0], 0, a.xz[1]], shift);
    out.push({ t, x: p[0], z: p[2] });
  }
  return out;
}

/** The spot of `track` at `t`, between its samples; null on an empty track. */
export function spotAt(track: readonly TrackPt[], t: number): [number, number] | null {
  const first = track[0];
  const last = track.at(-1);
  if (!first || !last) return null;
  if (t <= first.t) return [first.x, first.z];
  if (t >= last.t) return [last.x, last.z];
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((track[mid]?.t ?? 0) <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo] ?? first;
  const b = track[hi] ?? last;
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return [a.x + f * (b.x - a.x), a.z + f * (b.z - a.z)];
}

/** Half the span (seconds) over which a direction and a speed are read. */
const SPAN_S = 0.5;

/** The way the walk moves at `t` (a unit x/z vector); null while it stands still. */
export function dirAt(track: readonly TrackPt[], t: number): [number, number] | null {
  const a = spotAt(track, t - 2 * SPAN_S);
  const b = spotAt(track, t + 2 * SPAN_S);
  if (!a || !b) return null;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  return len < 0.2 ? null : [dx / len, dz / len];
}

/** Ground speed at `t`, metres a second (0 on an empty track). */
export function speedAt(track: readonly TrackPt[], t: number): number {
  const first = track[0]?.t ?? 0;
  const last = track.at(-1)?.t ?? 0;
  const t0 = Math.max(first, t - SPAN_S);
  const t1 = Math.min(last, t + SPAN_S);
  const a = spotAt(track, t0);
  const b = spotAt(track, t1);
  if (!a || !b || t1 <= t0) return 0;
  return Math.hypot(b[0] - a[0], b[1] - a[1]) / (t1 - t0);
}

// ---------------------------------------------------------------- pairing by place

/** Spots this much farther than the nearest still count as a pass by the spot. */
const PASS_M = 3;
/** A pass within this many seconds of the follower's last moment is the one it is on. */
const KEEP_S = 3;

/**
 * The moment of `track` nearest the scene spot `x`/`z`, and how far it is. A walk that passes the
 * spot more than once keeps to the pass it is on (within a few seconds of `prevT`: no jumping
 * between passes while playing), else takes the pass going the way `dir` goes, else the nearest.
 */
export function nearestOnTrack(
  track: readonly TrackPt[],
  x: number,
  z: number,
  opts: { prevT?: number | null; dir?: readonly [number, number] | null },
): { t: number; dist: number } | null {
  const d = track.map((p) => Math.hypot(p.x - x, p.z - z));
  const best = d.length ? Math.min(...d) : Infinity;
  if (!Number.isFinite(best)) return null;
  // the passes: runs of samples near the spot, each with its nearest sample
  const passes: { at: number; from: number; to: number }[] = [];
  for (let i = 0; i < d.length; i++) {
    if ((d[i] ?? Infinity) > best + PASS_M) continue;
    const cur = passes.at(-1);
    if (cur?.to === i - 1) {
      cur.to = i;
      if ((d[i] ?? Infinity) < (d[cur.at] ?? Infinity)) cur.at = i;
    } else passes.push({ at: i, from: i, to: i });
  }
  const tOf = (i: number) => track[i]?.t ?? 0;
  const nearest = (list: typeof passes) =>
    list.reduce((a, b) => ((d[b.at] ?? Infinity) < (d[a.at] ?? Infinity) ? b : a));
  const prevT = opts.prevT ?? null;
  const kept =
    prevT === null
      ? []
      : passes.filter((p) => prevT >= tOf(p.from) - KEEP_S && prevT <= tOf(p.to) + KEEP_S);
  const dir = opts.dir ?? null;
  const sameWay = dir
    ? passes.filter((p) => {
        const w = dirAt(track, tOf(p.at));
        return w !== null && w[0] * dir[0] + w[1] * dir[1] > 0;
      })
    : [];
  const pick = nearest(kept.length ? kept : sameWay.length ? sameWay : passes);
  return { t: tOf(pick.at), dist: d[pick.at] ?? best };
}

/**
 * The follower's moment for the lead at `leadT`: by place the moment of its track nearest the
 * lead's spot, by time the same second; and how far apart the two spots are (null when either
 * walk is not placed).
 */
export function pairFollower(
  lead: readonly TrackPt[],
  follow: readonly TrackPt[],
  leadT: number,
  mode: CompareMode,
  prevT: number | null,
): { t: number; dist: number | null } {
  const lp = spotAt(lead, leadT);
  if (!lp || follow.length === 0) return { t: leadT, dist: null };
  if (mode === 'place') {
    const n = nearestOnTrack(follow, lp[0], lp[1], { prevT, dir: dirAt(lead, leadT) });
    if (n) return n;
  }
  const fp = spotAt(follow, leadT);
  return { t: leadT, dist: fp ? Math.hypot(fp[0] - lp[0], fp[1] - lp[1]) : null };
}

// ---------------------------------------------------------------- detours

/** Two walks this far apart (metres) have parted: the chip turns amber, the scrubber shades. */
export const APART_M = 5;

export interface Band {
  fromT: number;
  toT: number;
}

/**
 * The stretches of `own` where `other` has no frame within `apartM` (a detour), in seconds. An
 * empty `other` (not placed) shades nothing.
 */
export function detourBands(
  own: readonly TrackPt[],
  other: readonly TrackPt[],
  apartM = APART_M,
): Band[] {
  if (other.length === 0) return [];
  // the other walk's frames in cells of `apartM`: a near frame is in the 3 x 3 cells around
  const cells = new Map<string, TrackPt[]>();
  const key = (i: number, j: number) => `${String(i)}:${String(j)}`;
  for (const p of other) {
    const k = key(Math.floor(p.x / apartM), Math.floor(p.z / apartM));
    const list = cells.get(k);
    if (list) list.push(p);
    else cells.set(k, [p]);
  }
  const near = (p: TrackPt) => {
    const ci = Math.floor(p.x / apartM);
    const cj = Math.floor(p.z / apartM);
    for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++)
        for (const q of cells.get(key(i, j)) ?? [])
          if (Math.hypot(q.x - p.x, q.z - p.z) <= apartM) return true;
    return false;
  };
  const out: Band[] = [];
  let open: Band | null = null;
  for (const p of own) {
    if (near(p)) {
      open = null;
      continue;
    }
    if (open) open.toT = p.t;
    else {
      open = { fromT: p.t, toT: p.t };
      out.push(open);
    }
  }
  return out;
}

export function inBand(bands: readonly Band[], t: number): boolean {
  return bands.some((b) => t >= b.fromT && t <= b.toT);
}

// ---------------------------------------------------------------- scrubbing the follower

/**
 * What scrubbing the follower to `followT` does. Inside one of its detour bands it plays on its
 * own there (`solo`); a solo walk dragged out while playing takes the lead (`rejoin`, no jump
 * back); otherwise both move together: the lead goes to the place nearest the follower's new
 * spot (by place, keeping to the pass it is on near `leadT`, the pass going the same way
 * preferred) or to the same second (by time, or while a walk is not placed).
 */
export function followerSeek(o: {
  followT: number;
  bands: readonly Band[];
  solo: boolean;
  playing: boolean;
  leadTrack: readonly TrackPt[];
  followTrack: readonly TrackPt[];
  mode: CompareMode;
  /** Where the lead is now. */
  leadT: number | null;
}): { kind: 'solo' } | { kind: 'rejoin' } | { kind: 'lead'; leadT: number } {
  if (inBand(o.bands, o.followT)) return { kind: 'solo' };
  if (o.solo && o.playing) return { kind: 'rejoin' };
  if (o.mode === 'place') {
    const spot = spotAt(o.followTrack, o.followT);
    const n = spot
      ? nearestOnTrack(o.leadTrack, spot[0], spot[1], {
          prevT: o.leadT,
          dir: dirAt(o.followTrack, o.followT),
        })
      : null;
    if (n) return { kind: 'lead', leadT: n.t };
  }
  return { kind: 'lead', leadT: o.followT };
}

/**
 * Send the lead of compare `store` to `t`: its pane seeks there, and the lead clock reads `t` at
 * once, so the follower's next tick pairs with where the lead is going instead of pulling the
 * follower back to where it was.
 */
export function moveLeadTo(
  store: StoreApi<WalkCompareState>,
  t: number,
  nowMs: number = performance.now(),
): void {
  const c = leadClock.getState().now;
  if (c) leadClock.setState({ now: { ...c, t, atMs: nowMs } });
  store.getState().requestLeadSeek(t);
}

// ---------------------------------------------------------------- a smooth follower

const MIN_RATE = 0.25;
const MAX_RATE = 4;
/** Below this the lead stands still: the follower holds its frame. */
const HOLD_RATE = 0.1;
/** Drift (seconds) the rate cannot catch up in good time: one seek instead. */
export const RESYNC_S = 1.5;
/** Rate added per second of drift. */
const GAIN = 0.5;
/** A paused follower this close to its moment stays (no seek for a frame's difference). */
const STILL_S = 0.04;

const clampRate = (r: number) => Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, r)) * 20) / 20;

/**
 * What the follower's video does this tick: play at `rate` (the lead's rate scaled by the two
 * walks' speeds, nudged to close a small drift), hold still, or seek once when the drift is too
 * large. A paused lead pauses the follower on the paired frame.
 */
export function followStep(o: {
  targetT: number;
  currentT: number;
  desiredRate: number;
  leadPlaying: boolean;
}): { play: boolean; rate: number | null; seekTo: number | null } {
  const drift = o.targetT - o.currentT;
  if (!o.leadPlaying)
    return { play: false, rate: null, seekTo: Math.abs(drift) > STILL_S ? o.targetT : null };
  if (Math.abs(drift) > RESYNC_S)
    return { play: true, rate: clampRate(o.desiredRate), seekTo: o.targetT };
  if (o.desiredRate < HOLD_RATE) return { play: false, rate: null, seekTo: null };
  return { play: true, rate: clampRate(o.desiredRate + drift * GAIN), seekTo: null };
}

/**
 * The rate the follower plays at to keep pace by place: the lead's rate times the lead's ground
 * speed over the follower's at the paired spot (0: the lead stands still).
 */
export function placeRate(leadRate: number, leadSpeed: number, followSpeed: number): number {
  if (leadSpeed < 0.15) return 0;
  if (followSpeed < 0.05) return MAX_RATE;
  return (leadRate * leadSpeed) / followSpeed;
}

// ---------------------------------------------------------------- link look

/** The compass bearing a pane looks at: its walk's heading bearing turned by the view's yaw. */
export function lookBearingDeg(headingBearingDeg: number, yawDeg: number): number {
  return wrapDeg(headingBearingDeg + yawDeg);
}

/** The yaw that makes a pane whose walk heads `headingBearingDeg` look at `lookDeg`. */
export function linkedYawDeg(lookDeg: number, headingBearingDeg: number): number {
  return wrapDeg(lookDeg - headingBearingDeg);
}
