import type { LineUpMeasure, ProjectManifest } from '@aio/schema';
import { captureShift, shiftKey, type Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import type { Box } from '../shell/layerBounds';
import type { LineUpMemory } from './lineUpMemory';
import type { LineUpDeps, LineUpStore } from './lineUpStore';
import { pairsToMeasure } from './planLineUp';

/**
 * The measurements of pairs of dates, shared by the background check and the Compare dates chip
 * (`compareLineUp.ts`): by `measureKey`, so an answer holds until either date is lined up again.
 * Only answers are kept (a failed measurement is tried again), the newest `KEPT`.
 */
const measures = new Map<string, LineUpMeasure>();
const KEPT = 64;

/**
 * `"<a>|<b>|<shift of a>|<shift of b>"`: two dates in this order, each with its correction as it
 * stands now (`shiftKey`, turn included).
 */
export function measureKey(
  m: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>,
  a: string,
  b: string,
): string {
  return `${a}|${b}|${shiftKey(captureShift(m, a))}|${shiftKey(captureShift(m, b))}`;
}

/** Keep the measurement of the pair `key` names. */
export function remember(key: string, m: LineUpMeasure): void {
  measures.delete(key);
  measures.set(key, m);
  if (measures.size > KEPT) {
    const oldest = measures.keys().next().value;
    if (oldest !== undefined) measures.delete(oldest);
  }
}

/** The kept measurement of the pair `key` names, if any. */
export function recall(key: string): LineUpMeasure | undefined {
  return measures.get(key);
}

/** Forget every kept measurement (another project opened). */
export function forgetMeasures(): void {
  measures.clear();
}

export interface LineUpWatchDeps {
  store: StoreApi<LineUpStore>;
  workspace: StoreApi<Workspace>;
  /** Each layer's box in the local frame, as placed now. */
  extents(): Promise<Record<string, Box>>;
  measure: LineUpDeps['measure'];
  memory: LineUpMemory;
  /** The pipeline Python is installed: without it there is no check and no notice. */
  hasPython(): boolean;
  /** Call `cb` when the pipeline Python turns up later (the pack list loads); returns the stop. */
  onReady?: (cb: () => void) => () => void;
}

/**
 * The background check (Decision 8): when a project opens and whenever its manifest changes,
 * measure each pair of dates `pairsToMeasure` names, once per pair of layers, and offer the step
 * for a pair that needs lining up and was not answered "Not now". A failed measurement (an older
 * pipeline pack without `change.lineup`, a failed job) stays quiet and still counts as measured,
 * so it is not run again and again. One offer at a time: the rest wait until it is answered.
 */
export function watchLineUps(deps: LineUpWatchDeps): () => void {
  // a change while a check runs asks for one more check after it
  const state = { running: false, again: false, stopped: false };

  const more = (): boolean => state.again && !state.stopped;

  const run = async (): Promise<void> => {
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    try {
      do {
        state.again = false;
        await check();
      } while (more());
    } finally {
      state.running = false;
    }
  };

  const check = async (): Promise<void> => {
    const project = deps.workspace.getState().project;
    if (state.stopped || !project || !deps.hasPython() || deps.store.getState().offer) return;
    const projectId = project.id;
    const still = () => !state.stopped && deps.workspace.getState().project?.id === projectId;
    let extents: Record<string, Box>;
    try {
      extents = await deps.extents();
    } catch {
      return;
    }
    const manifest = deps.workspace.getState().project?.manifest;
    if (!still() || !manifest) return;
    for (const pair of pairsToMeasure(manifest, extents, deps.memory.measured(projectId))) {
      if (!still() || deps.store.getState().offer) return;
      const now = deps.workspace.getState().project?.manifest ?? manifest;
      const key = measureKey(now, pair.keep, pair.move);
      let m: Awaited<ReturnType<LineUpDeps['measure']>>;
      try {
        m = await deps.measure(pair.keep, pair.move);
      } catch (e) {
        m = { error: e instanceof Error ? e.message : String(e) };
      }
      if (!still()) return;
      if (!('error' in m)) remember(key, m);
      deps.memory.markMeasured(projectId, pair.key);
      if ('error' in m || m.verdict !== 'ok' || deps.memory.isNotNow(projectId, pair.key)) continue;
      deps.store.getState().offerFrom(m, pair.key);
    }
  };

  const unWorkspace = deps.workspace.subscribe((s, prev) => {
    if (!s.project) return;
    if (s.project.id !== prev.project?.id || s.project.manifest !== prev.project.manifest)
      void run();
  });
  // an answered offer lets the pairs still waiting come up
  const unStore = deps.store.subscribe((s, prev) => {
    if (prev.offer && !s.offer) void run();
  });
  const unReady = deps.onReady?.(() => {
    void run();
  });
  void run();
  return () => {
    state.stopped = true;
    unReady?.();
    unWorkspace();
    unStore();
  };
}
