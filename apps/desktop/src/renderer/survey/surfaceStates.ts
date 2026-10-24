/**
 * The state of each survey date's prepared surface (volumetrics redesign, spec section 2): ready,
 * preparing (with the running job's progress), missing (it has a DSM or a cloud to prepare from)
 * or none (it has neither). Every date chip, card and chart reads it through `useSurfaceStates`.
 *
 * The prepared surfaces of the open project are published by `surfacesWatch` into
 * `preparedSurfaces`, read again whenever a `survey.prepare` job ends.
 */
import type { HeightTiles, JobRecord, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { isActive, sameFolder } from '../jobs';
import { jobs, shell } from '../shell';

export type SurfaceState =
  { kind: 'ready' } | { kind: 'preparing'; pct: number } | { kind: 'missing' } | { kind: 'none' };

/** The prepared surfaces (`survey:surfaces`) of the open project. */
export interface PreparedSurfaces {
  projectId: string | null;
  surfaces: HeightTiles[];
  /** Dates a kit DSM grid can make a surface for (`kitSurface.ts`), and those being made now. */
  kitDates: string[];
  kitPreparing: string[];
}

export function createPreparedSurfaces(): StoreApi<PreparedSurfaces> {
  return createStore<PreparedSurfaces>()(() => ({
    projectId: null,
    surfaces: [],
    kitDates: [],
    kitPreparing: [],
  }));
}

/** The kit DSM dates of the open project, and those being converted now. */
export interface KitDates {
  dates: readonly string[];
  preparing: readonly string[];
}

export const preparedSurfaces = createPreparedSurfaces();

/** The dates a `survey.prepare` job's params cover: each surface's capture, else its layer's. */
function datesOf(job: JobRecord, layerDate: ReadonlyMap<string, string>): string[] {
  const list = job.params.surfaces;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const s of list as unknown[]) {
    if (typeof s !== 'object' || s === null) continue;
    const { capture, source } = s as { capture?: unknown; source?: { layer?: unknown } };
    if (typeof capture === 'string') out.push(capture);
    else if (typeof source?.layer === 'string') {
      const d = layerDate.get(source.layer);
      if (d) out.push(d);
    }
  }
  return out;
}

/**
 * Each survey date's surface state, by capture id. `running` may hold any jobs: only the
 * `survey.prepare` jobs still at work count. A date with a kit DSM grid (`kit`) can be prepared
 * too, and reads as preparing while the app converts it.
 */
export function surfaceStates(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  prepared: readonly HeightTiles[],
  running: readonly JobRecord[],
  kit?: KitDates,
): ReadonlyMap<string, SurfaceState> {
  const layerDate = new Map<string, string>();
  const hasSource = new Set<string>();
  for (const l of manifest.layers) {
    if (!l.capture) continue;
    layerDate.set(l.id, l.capture);
    if ((l.kind === 'raster' && l.role === 'dsm') || l.kind === 'pointcloud')
      hasSource.add(l.capture);
  }
  for (const d of kit?.dates ?? []) hasSource.add(d);
  const ready = new Set<string>();
  for (const p of prepared) {
    const d = p.capture ?? ('layer' in p.source ? layerDate.get(p.source.layer) : undefined);
    if (d) ready.add(d);
  }
  const preparing = new Map<string, number>();
  for (const j of running) {
    if (j.pipeline !== 'survey.prepare' || !isActive(j)) continue;
    const pct = Math.max(0, Math.min(100, Math.round(j.progress * 100)));
    for (const d of datesOf(j, layerDate)) preparing.set(d, pct);
  }
  for (const d of kit?.preparing ?? []) if (!preparing.has(d)) preparing.set(d, 0);
  const out = new Map<string, SurfaceState>();
  for (const c of manifest.captures) {
    const pct = preparing.get(c.id);
    if (ready.has(c.id)) out.set(c.id, { kind: 'ready' });
    else if (pct !== undefined) out.set(c.id, { kind: 'preparing', pct });
    else if (hasSource.has(c.id)) out.set(c.id, { kind: 'missing' });
    else out.set(c.id, { kind: 'none' });
  }
  return out;
}

const EMPTY_SURFACES: HeightTiles[] = [];
const EMPTY_DATES: string[] = [];
const EMPTY_STATES: ReadonlyMap<string, SurfaceState> = new Map();

const isPrepare = (j: JobRecord, root: string) =>
  j.pipeline === 'survey.prepare' && sameFolder(j.project, root);

/**
 * The `survey.prepare` jobs at work on the open project. Shallow-compared, so a tick of any other
 * job (an ODM run's progress) re-renders nothing; a prepare job's own tick does.
 */
function usePrepareJobs(): readonly JobRecord[] {
  const root = useStore(workspace, (s) => s.project?.root ?? null);
  return useStore(
    jobs,
    useShallow((s) =>
      root === null ? [] : s.jobs.filter((j) => isPrepare(j, root) && isActive(j)),
    ),
  );
}

/** The open project's surface state per survey date (empty with no project open). */
export function useSurfaceStates(): ReadonlyMap<string, SurfaceState> {
  const project = useStore(workspace, (s) => s.project);
  const running = usePrepareJobs();
  const mine = (s: PreparedSurfaces) => s.projectId !== null && s.projectId === project?.id;
  const prepared = useStore(preparedSurfaces, (s) => (mine(s) ? s.surfaces : EMPTY_SURFACES));
  const kitDates = useStore(preparedSurfaces, (s) => (mine(s) ? s.kitDates : EMPTY_DATES));
  const kitPreparing = useStore(preparedSurfaces, (s) => (mine(s) ? s.kitPreparing : EMPTY_DATES));
  return useMemo(
    () =>
      project
        ? surfaceStates(project.manifest, prepared, running, {
            dates: kitDates,
            preparing: kitPreparing,
          })
        : EMPTY_STATES,
    [project, running, prepared, kitDates, kitPreparing],
  );
}

/** A `survey.prepare` job is at work on the open project. */
export function usePrepareRunning(): boolean {
  const root = useStore(workspace, (s) => s.project?.root ?? null);
  return useStore(
    jobs,
    (s) => root !== null && s.jobs.some((j) => isPrepare(j, root) && isActive(j)),
  );
}

/**
 * Whether a date still missing its surface will be prepared without anyone asking: a prepare job
 * runs on the open project, or the background preparation (`surfacesWatch`) will start one (the
 * setting on, not a package, the pipeline Python installed, and no prepare job on the project
 * cancelled or failed). Otherwise the date reads "Not prepared yet".
 */
export function usePreparingSoon(): boolean {
  const root = useStore(workspace, (s) => s.project?.root ?? null);
  const auto = useStore(shell, (s) => s.settings.autoPrepareSurfaces !== false && s.pkg === null);
  return useStore(jobs, (s) => {
    if (root === null) return false;
    let stopped = false;
    for (const j of s.jobs) {
      if (!isPrepare(j, root)) continue;
      if (isActive(j)) return true;
      if (j.status === 'cancelled' || j.status === 'failed') stopped = true;
    }
    return auto && s.runtime?.found === true && !stopped;
  });
}
