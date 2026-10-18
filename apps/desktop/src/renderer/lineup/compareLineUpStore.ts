import type { LineUpMeasure } from '@aio/schema';
import { t } from '@aio/ui';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { refusalOf, type LineUpDeps } from './lineUpStore';
import { forgetMeasures, measureKey, recall, remember } from './lineUpWatch';

/**
 * The line-up status of the two dates Compare shows (design call 8). It always measures the pair
 * as it stands now, both dates' current corrections applied, and never trusts a saved line-up on
 * its own: saved line-ups only give the chip's details. One measurement at a time; each answer is
 * kept by `measureKey` (shared with the background check), so a pair comes back at once until
 * either date is lined up again.
 */

export type CompareLineUpStatus = 'idle' | 'measuring' | 'lined' | 'off' | 'cannot';

/** The turn and scale fit a measurement may carry (Task 5); read structurally until it lands. */
export interface LineUpFitLike {
  verdict?: string;
  rotationDeg?: number;
  scale?: number;
  /** The largest move the correction makes over the overlap, metres. */
  maxMoveM?: number;
  residualPx?: number;
}

type Fitted = LineUpMeasure & { fit?: LineUpFitLike };

export interface CompareLineUpState {
  /** The pair being shown (`measureKey`), or null while nothing is watched. */
  pair: string | null;
  status: CompareLineUpStatus;
  measure: LineUpMeasure | null;
  /** Why the dates cannot be lined up (`cannot`), else null. */
  reason: string | null;
  /** The two dates watched, left first. */
  left: string | null;
  right: string | null;
}

export interface CompareLineUp extends CompareLineUpState {
  /** Show the line-up of `left` and `right`: from the cache, else by measuring them. */
  watch(left: string, right: string): void;
  /** Stop watching: the measurement in flight is given up. */
  stop(): void;
}

export interface CompareLineUpDeps {
  measure: LineUpDeps['measure'];
  workspace: StoreApi<Workspace>;
}

/** The verdict that decides: the fit's when there is one. */
export function verdictOf(m: LineUpMeasure): string {
  return (m as Fitted).fit?.verdict ?? m.verdict;
}

/** How far apart the dates sit: the fit's largest move when there is one, else the shift. */
export function offBy(m: LineUpMeasure): number {
  return (m as Fitted).fit?.maxMoveM ?? m.totalM;
}

/** The fit a measurement carries, if any. */
export function fitOf(m: LineUpMeasure): LineUpFitLike | undefined {
  return (m as Fitted).fit;
}

/** The chip's status and reason for a measurement or a failed one. */
export function chipOf(r: LineUpMeasure | { error: string }): {
  status: 'lined' | 'off' | 'cannot';
  reason: string | null;
} {
  if ('error' in r) return { status: 'cannot', reason: t('lineUp.failed', { error: r.error }) };
  const verdict = verdictOf(r);
  if (verdict === 'ok') return { status: 'off', reason: null };
  if (verdict === 'aligned') return { status: 'lined', reason: null };
  if (verdict === 'range') return { status: 'cannot', reason: t('lineUp.refuse.range') };
  const refused = refusalOf({ ...r, verdict: verdict as LineUpMeasure['verdict'] });
  return { status: 'cannot', reason: refused ?? t('compare.lineUp.cannot') };
}

const IDLE: CompareLineUpState = {
  pair: null,
  status: 'idle',
  measure: null,
  reason: null,
  left: null,
  right: null,
};

export function createCompareLineUp(deps: CompareLineUpDeps): StoreApi<CompareLineUp> {
  // the measurement in flight, given up by the next watch or stop
  let flight: { key: string; ctl: AbortController } | null = null;
  const giveUp = () => {
    flight?.ctl.abort();
    flight = null;
  };

  const store = createStore<CompareLineUp>()((set, get) => ({
    ...IDLE,
    watch: (left, right) => {
      const manifest = deps.workspace.getState().project?.manifest;
      const known = (id: string) => manifest?.captures.some((c) => c.id === id) === true;
      if (!manifest || left === right || !known(left) || !known(right)) {
        giveUp();
        set({ ...IDLE, left, right });
        return;
      }
      const key = measureKey(manifest, left, right);
      const s = get();
      if (s.pair === key && s.status !== 'idle') return;
      giveUp();
      // the same pair measured the other way round answers too
      const kept = recall(key) ?? recall(measureKey(manifest, right, left));
      if (kept) {
        set({ pair: key, left, right, measure: kept, ...chipOf(kept) });
        return;
      }
      const ctl = new AbortController();
      const mine = { key, ctl };
      flight = mine;
      set({ pair: key, left, right, status: 'measuring', measure: null, reason: null });
      void (async () => {
        let r: LineUpMeasure | { error: string };
        try {
          r = await deps.measure(left, right, ctl.signal);
        } catch (e) {
          r = { error: e instanceof Error ? e.message : String(e) };
        }
        // another pair (or none) since: this answer is stale
        if (flight !== mine || ctl.signal.aborted) return;
        flight = null;
        if (!('error' in r)) remember(key, r);
        if (get().pair !== key) return;
        set({ measure: 'error' in r ? null : r, ...chipOf(r) });
      })();
    },
    stop: () => {
      giveUp();
      set({ ...IDLE });
    },
  }));

  deps.workspace.subscribe((s, prev) => {
    if (s.project?.id !== prev.project?.id) {
      // another project: its dates are other dates
      forgetMeasures();
      store.getState().stop();
      return;
    }
    // a date lined up (or its line-up undone or removed): measure the pair as it now stands
    const { left, right, status } = store.getState();
    if (s.project?.manifest !== prev.project?.manifest && left && right && status !== 'idle')
      store.getState().watch(left, right);
  });
  return store;
}

/**
 * The app's chip store, once the line-up session has made it (`lineUpSession.ts`), with the
 * workspace it measures: the chip shows nothing until it is set.
 */
export const compareLineUpApp = createStore<{
  store: StoreApi<CompareLineUp> | null;
  workspace: StoreApi<Workspace> | null;
}>()(() => ({ store: null, workspace: null }));
