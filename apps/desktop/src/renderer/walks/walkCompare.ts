import type { WalkFit } from '@aio/geo';
import { shiftLocal, type DateShift } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { shell } from '../shell';
import type { Side } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import { walks } from './walks';

/*
 * SPIKE (walk compare): two walks in the two 360 panes of the split. One leads and plays; the
 * other follows it by place (its video sought to the moment nearest the lead's spot) or by time,
 * and with Link look both look at the same compass bearing, each turned by its own heading.
 */

export type CompareMode = 'place' | 'time';

export interface WalkCompareState {
  /** The walk each side shows while both panes show 360 video (null: the selected or next). */
  left: string | null;
  right: string | null;
  lead: Side;
  mode: CompareMode;
  linkLook: boolean;
  /** The pane whose look the other follows while linked: the last one dragged. */
  driver: Side;
  /** The following walk is far from the lead's spot (its pane and marker dim). */
  far: string | null;
  /**
   * Compare started (Compare with) and not ended: while only one 360 pane shows a walk of the
   * pair, the other walk still follows it unseen, so the map and the 3D view show both spots.
   */
  active: boolean;
}

export const walkCompare = createStore<WalkCompareState>()(() => ({
  active: false,
  left: null,
  right: null,
  lead: 'left',
  mode: 'place',
  linkLook: true,
  driver: 'left',
  far: null,
}));

export function useWalkCompare<T>(selector: (s: WalkCompareState) => T): T {
  return useStore(walkCompare, selector);
}

export const otherSide = (s: Side): Side => (s === 'left' ? 'right' : 'left');

/** Compare walk `lead` with walk `other`: both 360 panes in the split, `lead` on the left. */
export function startWalkCompare(lead: string, other: string): void {
  const project = workspace.getState().project;
  if (!project) return;
  walks.getState().select(lead);
  // both walks show on the map and in 3D, whichever date the date bar is on
  workspace.getState().setLayersVisible([lead, other], true);
  walkCompare.setState({
    active: true,
    left: lead,
    right: other,
    lead: 'left',
    driver: 'left',
    far: null,
  });
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  stagePrefs.getState().update(project.id, {
    split: {
      ...(saved ?? { left: 'walk360', right: 'walk360' }),
      left: 'walk360',
      right: 'walk360',
    },
  });
  if (sh.stageMode !== 'split') sh.setStageMode('split');
}

/** End the compare: the panes go back to the selected walk, the unseen follower stops. */
export function endWalkCompare(): void {
  walkCompare.setState({ active: false, left: null, right: null, far: null });
}

export function swapLead(): void {
  const s = walkCompare.getState();
  const lead = otherSide(s.lead);
  walkCompare.setState({ lead, driver: lead, far: null });
}

// ---------------------------------------------------------------- pairing by place

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

/** Spots within this much of the nearest count as as near: the one closest in time to before wins. */
const NEAR_TIE_M = 0.75;

/**
 * The moment of `track` nearest the scene spot `x`/`z`, and how far it is. A walk that passes
 * the spot twice keeps to the pass nearest `prevT` (no jumping between passes while playing).
 */
export function nearestOnTrack(
  track: readonly TrackPt[],
  x: number,
  z: number,
  prevT: number | null,
): { t: number; dist: number } | null {
  let best = Infinity;
  for (const p of track) best = Math.min(best, Math.hypot(p.x - x, p.z - z));
  if (!Number.isFinite(best)) return null;
  let pick: { t: number; dist: number } | null = null;
  for (const p of track) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d > best + NEAR_TIE_M) continue;
    if (
      !pick ||
      (prevT !== null ? Math.abs(p.t - prevT) < Math.abs(pick.t - prevT) : d < pick.dist)
    )
      pick = { t: p.t, dist: d };
  }
  return pick;
}

/** A following walk this far (metres) from the lead's spot dims and says so. */
export const FAR_M = 5;

/** The bit of a placed walk the pairing reads. */
interface Placed {
  fit: WalkFit;
  shift?: DateShift | null | undefined;
}

const spotOf = (w: Placed, t: number): [number, number] | null => {
  const a = w.fit.at(t);
  if (!a) return null;
  const p = shiftLocal([a.xz[0], 0, a.xz[1]], w.shift ?? null);
  return [p[0], p[2]];
};

/**
 * The follower's moment for the lead at `leadT`: by place the moment of `track` nearest the
 * lead's spot, by time the same second; and how far apart the two spots are (null when either
 * walk is not placed).
 */
export function pairFollower(
  lead: Placed | null,
  follow: Placed | null,
  track: readonly TrackPt[],
  leadT: number,
  mode: CompareMode,
  prevT: number | null,
): { t: number; dist: number | null } {
  const lp = lead ? spotOf(lead, leadT) : null;
  if (!lp) return { t: leadT, dist: null };
  if (mode === 'place') {
    const n = nearestOnTrack(track, lp[0], lp[1], prevT);
    if (n) return { t: n.t, dist: n.dist };
  }
  const fp = follow ? spotOf(follow, leadT) : null;
  return { t: leadT, dist: fp ? Math.hypot(fp[0] - lp[0], fp[1] - lp[1]) : null };
}

/** The follower `id` is `dist` from the lead's spot: far ones dim (pane and marker). */
export function markFar(id: string, dist: number | null): void {
  const far = dist !== null && dist > FAR_M ? id : null;
  const cur = walkCompare.getState().far;
  if (cur !== far && (far !== null || cur === id)) walkCompare.setState({ far });
}
