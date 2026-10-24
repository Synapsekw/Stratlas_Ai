/**
 * Survey surfaces prepared in the background (volumetrics redesign, spec section 2): when a
 * project opens, and whenever its manifest changes (a survey date added), a writable project whose
 * dated surveys lack a prepared surface starts one quiet `survey.prepare` job for all of them, the
 * way the line-up check starts its job (`lineup/lineUpWatch.ts`). The job is listed in Jobs with
 * its progress and Cancel; it is never selected or announced.
 *
 * Light on a computer the person is using: it waits a moment after the project opens, runs one job
 * at a time (none beside a prepare job already running on the project), and tries each date once
 * per open. A job the person cancels is not followed by another until the project is opened again.
 * Nothing starts with the setting off, for a read-only project or package, or without the
 * pipeline Python.
 *
 * A project imported from the old stockpile kit, whose dates have the kit's DSM grids but no DSM
 * raster or point cloud, gets those dates' surfaces made by the app itself (`kitSurface.ts`, no
 * Python needed), under the same setting and with the same once-per-open rule; its dates read as
 * preparing meanwhile.
 *
 * Whenever a `survey.prepare` job on the open project ends, however it was started, the prepared
 * surfaces are read again and published (`preparedSurfaces`), and the comparison and QA stores
 * are refreshed.
 */
import type { HeightTiles, JobRecord, SurveyPrepareParams } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import { isActive, sameFolder } from '../jobs';
import { prepareParams } from './compareStore';
import type { PreparedSurfaces } from './surfaceStates';

/** Whether to start the background preparation now. */
export function shouldAutoPrepare(x: {
  setting: boolean;
  writable: boolean;
  hasPython: boolean;
  cancelled: boolean;
  missing: number;
}): boolean {
  return x.setting && x.writable && x.hasPython && !x.cancelled && x.missing > 0;
}

/** Time to let a project finish opening before the job starts, ms. */
const SETTLE_MS = 3000;

export interface SurfacesWatchDeps {
  workspace: StoreApi<Workspace>;
  jobs: StoreApi<{ jobs: JobRecord[] }>;
  /** Where the open project's prepared surfaces are published. */
  prepared: StoreApi<PreparedSurfaces>;
  /** `Settings.autoPrepareSurfaces` (absent means on). */
  setting(): boolean;
  /** The open project may be written (not a package, not read-only). */
  writable(): boolean;
  /** The pipeline Python is installed. */
  hasPython(): boolean;
  /** Call `cb` when the pipeline Python turns up later; returns the stop. */
  onReady?: (cb: () => void) => () => void;
  /** `survey:surfaces` of the project, or null when it cannot be read. */
  readSurfaces(projectId: string): Promise<HeightTiles[] | null>;
  /** Start the job quietly (`jobs.startQuiet`). */
  start(req: {
    pipeline: 'survey.prepare';
    project: string;
    params: SurveyPrepareParams;
  }): Promise<{ jobId: string } | { error: string }>;
  /** Read the comparison and QA stores' surfaces again. */
  refresh(): Promise<void> | void;
  /** The dates of the project a kit DSM grid can make a surface for (`kitSurfaceDates`). */
  kitDates?: (projectId: string) => Promise<string[]>;
  /** Make the kit DSM surfaces of `dates` that lack one (`prepareKitSurfaces`). */
  prepareKit?: (
    projectId: string,
    surfaces: HeightTiles[],
    dates: readonly string[],
  ) => Promise<void>;
  /** Wait `ms` (tests pass one that does not). */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Start the background preparation; returns the stop. Called once at start. */
export function connectSurfacesWatch(deps: SurfacesWatchDeps): () => void {
  const wait = deps.wait ?? sleep;
  const state = { running: false, again: false, stopped: false };
  /** What is remembered for the open project, until it closes. */
  let open: {
    id: string;
    settled: boolean;
    cancelled: boolean;
    tried: Set<string>;
    ours: string | null;
    kitDates?: string[];
  } | null = null;

  const current = () => deps.workspace.getState().project;

  const publish = (projectId: string, surfaces: HeightTiles[] | null) => {
    if (surfaces) deps.prepared.setState({ projectId, surfaces });
  };

  const prepareRunning = (root: string) =>
    deps.jobs
      .getState()
      .jobs.some(
        (j) => j.pipeline === 'survey.prepare' && isActive(j) && sameFolder(j.project, root),
      );

  const check = async (): Promise<void> => {
    const project = current();
    if (state.stopped || !project || open?.id !== project.id) return;
    const mine = open;
    const still = () => !state.stopped && current()?.id === mine.id && open === mine;
    if (!mine.settled) {
      mine.settled = true;
      await wait(SETTLE_MS);
      if (!still()) return;
    }
    let surfaces = await deps.readSurfaces(mine.id);
    if (!still()) return;
    publish(mine.id, surfaces);
    if (deps.kitDates && mine.kitDates === undefined) {
      let dates: string[] = [];
      try {
        dates = await deps.kitDates(mine.id);
      } catch {
        // no kit dates
      }
      if (!still()) return;
      mine.kitDates = dates;
      deps.prepared.setState({ kitDates: dates });
    }
    const have = new Set((surfaces ?? []).flatMap((s) => (s.capture ? [s.capture] : [])));
    const kit = (mine.kitDates ?? []).filter((d) => !have.has(d) && !mine.tried.has(d));
    if (
      deps.prepareKit &&
      surfaces &&
      kit.length > 0 &&
      deps.setting() &&
      deps.writable() &&
      !mine.cancelled
    ) {
      for (const d of kit) mine.tried.add(d);
      deps.prepared.setState({ kitPreparing: kit });
      try {
        await deps.prepareKit(mine.id, surfaces, kit);
      } catch {
        // the dates stay without a surface
      } finally {
        deps.prepared.setState({ kitPreparing: [] });
      }
      if (!still()) return;
      await deps.refresh();
      surfaces = await deps.readSurfaces(mine.id);
      if (!still()) return;
      publish(mine.id, surfaces);
    }
    const now = current();
    if (!now || !surfaces || prepareRunning(now.root)) return;
    const dates = now.manifest.captures.map((c) => c.id).filter((d) => !mine.tried.has(d));
    const params = dates.length ? prepareParams(now.manifest, surfaces, dates) : null;
    const go = shouldAutoPrepare({
      setting: deps.setting(),
      writable: deps.writable(),
      hasPython: deps.hasPython(),
      cancelled: mine.cancelled,
      missing: params?.surfaces.length ?? 0,
    });
    if (!go || !params) return;
    for (const s of params.surfaces) if (s.capture) mine.tried.add(s.capture);
    let r: { jobId: string } | { error: string };
    try {
      r = await deps.start({ pipeline: 'survey.prepare', project: now.root, params });
    } catch (e) {
      r = { error: e instanceof Error ? e.message : String(e) };
    }
    if ('jobId' in r && open === mine) mine.ours = r.jobId;
  };

  // a change while a check runs asks for one more check after it
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

  const unWorkspace = deps.workspace.subscribe((s, prev) => {
    if (s.project?.id !== prev.project?.id) {
      open = s.project
        ? { id: s.project.id, settled: false, cancelled: false, tried: new Set(), ours: null }
        : null;
      if (!s.project)
        deps.prepared.setState({ projectId: null, surfaces: [], kitDates: [], kitPreparing: [] });
      else if (s.project.id !== prev.project?.id)
        deps.prepared.setState({ kitDates: [], kitPreparing: [] });
    }
    if (!s.project) return;
    if (s.project.id !== prev.project?.id || s.project.manifest !== prev.project.manifest)
      void run();
  });

  // a prepare job on the open project ended: read the surfaces again, then look for more to do
  const unJobs = deps.jobs.subscribe((s, prev) => {
    const project = current();
    if (!project || !open) return;
    const ended = s.jobs.filter((j) => {
      if (j.pipeline !== 'survey.prepare' || isActive(j) || !sameFolder(j.project, project.root))
        return false;
      const before = prev.jobs.find((p) => p.id === j.id);
      return before !== undefined && isActive(before);
    });
    if (ended.length === 0) return;
    for (const j of ended)
      if (j.id === open.ours && j.status === 'cancelled') open.cancelled = true;
    const mine = open;
    void (async () => {
      await deps.refresh();
      const surfaces = await deps.readSurfaces(mine.id);
      if (state.stopped || open !== mine) return;
      publish(mine.id, surfaces);
      void run();
    })();
  });

  const unReady = deps.onReady?.(() => {
    void run();
  });

  const first = current();
  if (first) {
    open = { id: first.id, settled: false, cancelled: false, tried: new Set(), ours: null };
    void run();
  }
  return () => {
    state.stopped = true;
    unReady?.();
    unWorkspace();
    unJobs();
  };
}
