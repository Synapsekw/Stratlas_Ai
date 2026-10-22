import type { Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import { engineConfig, type StageQuality } from '../config';

/** What parking needs of a stage (`Stage`; a fake in tests). */
export interface Parkable {
  readonly projectId: string;
  readonly contextLost: boolean;
  readonly antialias: boolean;
  park(): void;
  resume(container: HTMLElement): void;
  setQuality(q: Partial<StageQuality>): void;
  dispose(): void;
}

interface Parked {
  stage: Parkable;
  store: StoreApi<Workspace>;
  /** Stops watching the workspace for the project to change. */
  off: () => void;
}

/**
 * The main 3D view's stage while another screen shows (Issues, Media, Reports, the globe, the
 * library). Leaving the Scene screen unmounts the view; building its stage again on the way back
 * relinked every shader program and redrew the light maps and the water: two long tasks of about
 * 280 ms and a first frame 300 to 400 ms after the click. One stage at most is kept, for the
 * project it shows: it goes when another project opens or the project closes.
 */
let parked: Parked | null = null;

/**
 * Keep `stage`, which showed `store`'s open project, for the next view of the same store. False
 * when there is nothing to keep it for (no project open): the caller disposes it.
 */
export function parkStage(stage: Parkable, store: StoreApi<Workspace>): boolean {
  const project = store.getState().project;
  if (!project) return false;
  if (project.id !== stage.projectId || stage.contextLost) return false;
  releaseParkedStage();
  stage.park();
  const off = store.subscribe((s) => {
    // another project, or none: the kept stage would show the wrong one
    if (s.project?.id !== project.id || s.project.root !== project.root) releaseParkedStage();
  });
  parked = { stage, store, off };
  return true;
}

/**
 * The stage kept for `store`, shown again in `container`; null when there is none to take (it
 * was for another store or project, its context was lost, or the graphics tier changed what its
 * renderer was made with): a new stage is built then.
 */
export function takeParkedStage(
  store: StoreApi<Workspace>,
  container: HTMLElement,
): Parkable | null {
  const p = parked;
  if (!p) return null;
  parked = null;
  p.off();
  const { stage } = p;
  const quality = engineConfig().quality;
  const usable =
    p.store === store &&
    store.getState().project?.id === stage.projectId &&
    !stage.contextLost &&
    stage.antialias === (quality.antialias !== false);
  if (!usable) {
    stage.dispose();
    return null;
  }
  stage.resume(container);
  // a graphics tier chosen meanwhile
  stage.setQuality(quality);
  return stage;
}

/** Dispose the kept stage, if any (memory pressure, a lost context, tests). */
export function releaseParkedStage(): void {
  const p = parked;
  if (!p) return;
  parked = null;
  p.off();
  p.stage.dispose();
}

/** True while a stage is kept. */
export function hasParkedStage(): boolean {
  return parked !== null;
}
